# Agent Note: Split build:src and build:test, with build running both concurrently

Status: implemented

English | [中文](2026-10-11-build-src-test-split.zh.md)

## Problem

`pnpm run build` runs the native addon, the package-library build (Host `tsc -b tsconfig.host.json` → Host tsdown → Desktop bundle → Client `tsc -b tsconfig.client.json` → Client tsdown), and the Web build serially. Besides referencing package projects, the Host and Client aggregates each carry a `noEmit` root program covering tests, scripts, benchmarks, and website. These two root programs emit no files and feed no later artifact step, yet sit on the serial critical path: timed alone, the Host root program takes 68.5 s and the Client root program 36.0 s, while the serial package-library build takes 247.3–251.4 s.

Development iterations need only artifacts; test and script type checks are needed before work is declared complete. The only way to skip the two root programs is the CI-oriented `pnpm run build --artifacts-only`, which has no local development command name and no counterpart that runs only those two checks. Meanwhile, `pnpm run build` must stay complete and detect every type error.

## Decision

### Commands

Each command does only its own job.

| Command | Responsibility | Steps | Scheduling | Client build record |
|---|---|---|---|---|
| `pnpm run build:src` | Produces every artifact of `build`; package projects are fully type-checked as usual, the two aggregate root programs are not checked | native → host-src → host-bundle → desktop-bundle → client-src → client-bundle → web | One linear chain | Deleted at start, written after every step passes |
| `pnpm run build:test` | Type-checks only the two aggregate root programs | host-test, client-test | Both steps concurrent, no prerequisite steps | Neither read nor written |
| `pnpm run build` | Every step of `build:src` and `build:test` | The dependency graph below | Concurrent through the run-gates scheduler | Deleted at start, written after every step passes |

`build:test` neither detects, rebuilds, nor validates `build:src` outputs; when prerequisite outputs are missing or stale, the compiler's own diagnostics (for example TS6305 and TS2307) report it, and no command adds prerequisite checks, guards, or fallbacks. `build:src` produces the same artifacts and record as `build` and replaces `--artifacts-only`; that flag and the `libraries` mode of `compile-referenced-projects.ts` are removed, and the Python executable builder uses `--build-src`. `build:official` remains `tsx scripts/build.ts --profile official` and runs the complete `build`.

### Steps and dependencies

| Step | Command | `needs` in `build` |
|---|---|---|
| native | `pnpm run build:native-system` | — |
| host-src | `node --max-old-space-size=4096 <tsc> -b <references of tsconfig.host.json>` | native |
| host-bundle | `tsdown --config-loader native --env.DSH_BUILD_FACE host` (runs Typert) | host-src |
| desktop-bundle | `pnpm --filter @deepseek-ai/dsh-desktop run bundle` | host-bundle |
| client-src | `<tsc> -b <references of tsconfig.client.json>` | desktop-bundle |
| client-bundle | `tsdown --config-loader native --env.DSH_BUILD_FACE client` | client-src |
| web | `pnpm run build:web` | client-bundle |
| host-test | `node --max-old-space-size=4096 <tsc> -p tsconfig.host.json` | host-src |
| client-test | `<tsc> -p tsconfig.client.json` | client-src |

```text
native → host-src ─┬─ host-test ─────────────────────────────────────────────┐
                   └─ host-bundle → desktop-bundle → client-src ─┬─ client-test ┤ → record
                                                                 └─ client-bundle → web ┘
```

- client-src must follow host-bundle: Client packages import `@deepseek-ai/dsh-*/remote`, whose types `lib/typert.remote-client.d.ts` only Typert inside Host tsdown writes. host-test reads no Typert output; clean serial builds have always finished the Host aggregate check before Host tsdown.
- The src chain keeps the two non-data edges native → host-src and desktop-bundle → client-src; only the two test steps attach to the chain in parallel.
- [`compile-referenced-projects.ts`](../../../../scripts/compile-referenced-projects.ts) owns the package-library step list `libraryBuildSteps`, the references argument construction `referencedProjectsCompilerArgs` (relative paths keep the command below Windows' command-line limit), and the aggregate-check arguments `aggregateCheckArgs`. The vendor release rehearsal (`host-libraries`) and CI benchmarks (`--noCheck`) run the same step list serially.
- The test steps use project mode (`tsc -p`): it reads the declarations that references already emitted and compiles no reference, writing incremental state to the aggregates' existing `tsconfig.{host,client}.tsbuildinfo`. `build` and `build:test` run the same command, so their diagnostics are identical.

### Scheduling, failure, and output

- [`scripts/build.ts`](../../../../scripts/build.ts) owns the step table and the three scopes and executes them through `runAggregate` from [`scripts/run-gates.ts`](../../../../scripts/run-gates.ts): each step is a gate with `needs`, and shell-free spawning, per-step buffered output, fail-fast process-tree termination, Windows `taskkill`, and host signal forwarding come from the run-gates implementation. `build:src` is `tsx scripts/build.ts --scope src`, `build:test` is `--scope test`, and `build` omits `--scope` and runs both as one graph; `--profile` applies only to artifact scopes, and combining it with `--scope test` fails argument parsing.
- The concurrency limit is `DSH_GATE_CONCURRENCY`, defaulting to the available CPU count; the dependency graph is at most 3 wide (client-test and client-bundle can start while host-test is still running). Master serial reference lanes set `DSH_GATE_CONCURRENCY=1`, so `build` runs serially in topological order there, consistent with the [serial reference decision](2026-07-21-serial-cross-platform-ci-reference.md) and without workflow edits.
- By default (locally), every dependent of a failed step is recorded as skipped, while running steps and steps unrelated to the failure run to completion; the executed set depends only on step outcomes, so one run reports every independent type error. With `DSH_GATE_FAIL_FAST=1` (set in every building PR lane), the first failure terminates the process trees of the other running steps and records every unfinished step as skipped.
- A failed step prints `== FAILED <step> ==`, its command, the exit reason, and the step's complete buffered output, and the final summary lists failed and skipped steps; a passing step prints only its PASS line, and `DSH_GATE_VERBOSE=1` prints all output. The exit code is 1 when any step failed or was skipped, and the client build record is not written. Every step inherits the public Client environment selected by `clientBuildProcessEnvironment`.
- In CI, `build` itself is one gate of an outer run-gates aggregate; outer fail-fast termination propagates to the inner scheduler. `check:node-compat` and `check:ci:lint:contracts-ready` already nest the same way.

### Callers

| Caller | Command | Aggregate root-program checks |
|---|---|---|
| `build`, `build:official`, `Makefile` `build`, `scripts/publish-npm-baseline.ts`, `apps/desktop/scripts/package-target.ts`, `scripts/dev-bundle-registry.ts`, `release-publish.yml`, `sandbox.yml`, and the non-PR branches of `e2e.yml` and `release.yml` | `build` / `build:official` | Yes |
| `test:web`, `test:web:refresh`, `test:web:perf`, `test:web:stress`, `apps/desktop` `test:updates:local`, `test:bench` / `build:bench` | `build`; `build:bench` runs `build:native-system`, `build:lib`, and the benchmark tsdown | Yes |
| `typecheck` (run by the pre-push hook) | `build:lib:host` (Host `tsc -b tsconfig.host.json`, Host bundle, Desktop bundle) and Client `tsc -b tsconfig.client.json` | Yes |
| `dev:web` ([`scripts/dev-web.ts`](../../../../scripts/dev-web.ts)), `dev:desktop` (`apps/desktop/scripts/dev.ts`) | `build:src` | None before launch; after `dev:web` launches, its `tsc -b tsconfig.client.json --watch` keeps checking the Client aggregate root program |
| Prerequisite step of `lint`, `lint:fix`, `doc-typecheck`, and the CI Typert contracts gate | Host package compilation and the Host bundle (`compile-referenced-projects.ts host-libraries`), without the Desktop bundle | None |
| CI node 24 / snapshots and artifacts (`check:ci:consumers`), windows node 24 / build & observational (`check:ci:windows-blocking`) | `build` | Yes, the two required lanes |
| CI node-compat 22.19 | `build:src` (through run-gates) | None |
| CI python runtime | `build-exe-for-python-sdk.ts --build-src` | None |
| PR rehearsals in `e2e.yml` and `release.yml` | `pnpm run build:src --profile official` | None |
| `build-preview-cloudflare.yml` | `pnpm run build:src` | None |
| CI node 24 / benchmarks | `run-ci-bench.ts` (`tsc -b --noCheck`) | None |
| PR rehearsal in `release-vendor.yml` | `compile-referenced-projects.ts host-libraries` | None |
| Non-PR branch of `release-vendor.yml`, `release-vendor-publish.yml` | `build:lib:host` | Host aggregate root program only |

`lint`, `lint:fix`, `doc-typecheck`, and the Typert contracts gate read only Typert outputs and package declarations: both aggregates are `noEmit`, oxlint builds its own programs, `doc-typecheck` references only package projects, and no consumer of `host-libraries` reads `apps/desktop/lib`. Their prerequisite step therefore saves about 68 s of Host aggregate checking and about 4.4 s of Desktop bundling on every run.

The consumers lane's HMR Web test starts `dev:web` and therefore uses `build:src` inside that lane; the same lane's `build` gate still runs both aggregate checks. CI does not call `build:test` separately: the two required lanes already get the same checks through `build`. The [PR artifact build decision](2026-10-05-pr-artifact-typechecks.md) keeps its required complete builds, benchmark `--noCheck`, job and worker ceilings, serial node-compat Vitest, coverage weights, and pnpm packing checks; its PR artifact build is `build:src`.

### Measurements

Prototype conditions: a shared 256 vCPU Linux host (load average 23–70), Node v24.18.0, TypeScript 6.0.3, React type packages hoisted to the root, without the Typert changes of [the lossless speed-ups note](2026-10-11-lossless-build-speedups.md); scope is the package-library build (excluding native and web). Every round starts from `pnpm run clean`, running once each in the order serial, concurrent, `build:lib`, `build:lib`, concurrent, serial; `/usr/bin/time -v` times each step, and summed process-tree RSS is sampled every 250 ms. The prototype runs the aggregate checks as `tsc -b tsconfig.{host,client}.json` once references are up to date, when build mode builds only the aggregate root program.

| Mode | Wall (s) | CPU user+sys (s) | Process-tree RSS peak (GiB) |
|---|---|---|---|
| Serial `pnpm run build:lib` | 247.3 / 251.4 | 370.8 / 385.1 | 5.90 / 5.99 |
| Each step run separately in sequence | 269.1 / 241.1 | 377.1 / 370.4 | 5.93 / 5.70 |
| Concurrent by dependency graph | 178.0 / 166.2 | 397.4 / 386.8 | 7.99 / 8.01 |

Median wall falls from 249.4 s to 172.1 s (−77.3 s, −31%); CPU grows by about 14 s (+3.7%) because the Host aggregate check's user time rises from 98–100 s to 111–124 s under contention; the RSS peak grows by 2.1 GiB where the Host aggregate check (3.95 GiB) overlaps Host tsdown (5.65 GiB). The concurrent critical path is host-src → host-bundle → desktop-bundle → client-src → client-test; host-test finishes 32.5–33.1 s before the end and client-bundle about 21 s before. Per-step wall (two serial / two concurrent): host-src 73.8, 61.3 / 70.3, 62.6; host-test 68.5, 64.0 / 75.1, 70.5; host-bundle 23.1, 20.5 / 22.1, 21.0; desktop-bundle 4.5, 4.0 / 4.4, 4.4; client-src 50.4, 46.3 / 46.3, 44.1; client-test 36.0, 33.5 / 34.9, 34.1; client-bundle 12.9, 11.5 / 13.6, 12.6.

Round 1 final measurements: one sample per scenario, each from clean, in a 64-core cgroup (load average 29–87); the baseline is master.

| Scenario | master | This branch | CPU user+sys (master → branch) | Process-tree RSS peak (master → branch) |
|---|---|---|---|---|
| Complete build `pnpm run build` | 318.2 s | 170.1 s (−46.5%) | 425.5 → 373.4 s | 6.13 → 7.55 GiB |
| Artifact build: master `build --artifacts-only`, branch `build:src` | 178.9 s | 152.5 s (−14.8%) | Not measured | Not measured |
| Development iteration: master `build`, branch `build:src` | 318.2 s | 152.5 s (−52%) | Not measured | Not measured |
| `pnpm run build:test` (after `build:src`) | — | 67.9 s | Not measured | Not measured |
| `pnpm run build:test` immediate rerun | — | 19.4 s | Not measured | Not measured |
| `DSH_GATE_CONCURRENCY=1 pnpm run build` | — | Round 2 pending | Round 2 pending | Round 2 pending |
| Prerequisite step of `lint` and the others: master `build:lib:host`, branch `host-libraries` | Round 2 pending | Round 2 pending | Round 2 pending | Round 2 pending |

Step walls of this branch's `build`: native 1.7, host-src 66.5, host-bundle 11.4, desktop-bundle 3.4, client-src 45.6, client-bundle 9.0, web 9.4, host-test 65.3, client-test 34.8 s. From these values the critical path is native → host-src → host-bundle → desktop-bundle → client-src → client-test, 163.4 s in total; host-test ends at 133.5 s and is off the critical path. master's serial segments: native 2.5, Host package compilation 66.7, Host aggregate check 66.1, Host tsdown 22.5, Desktop bundle 3.3, Client package compilation 55.6, Client aggregate check 68.2, Client tsdown 13.9, web 9.7 s, 308.5 s in total. The difference also includes the changes of [the lossless speed-ups note](2026-10-11-lossless-build-speedups.md): the shorter Host tsdown, Client package compilation, Client tsdown, and Client aggregate check come from that note, while moving the Host aggregate check off the critical path comes from this note's concurrent scheduling. Within `build:test`'s 67.9 s, the Host and Client aggregate checks run concurrently, taking 65.2 s and 33.9 s.

### Completeness and lossless evidence

`build` runs the same set of compiler programs as the serial build: host-src and client-src compile every package project of both faces, and host-test and client-test check both aggregate root programs with the same commands as `build:test`. Across the prototype's six rounds, the 11,580 files of `{packages,apps,vendor,native}/**/lib/**` (excluding `*.tsbuildinfo`) are byte-identical between serial and concurrent runs, and after every round `tsc -b --dry tsconfig.host.json tsconfig.client.json` reports no out-of-date project. tsbuildinfo writers are host-src (292), client-src (76, exactly the client-only projects), and one per aggregate check; client-src rewrites no tsbuildinfo or declaration that host-test reads, so the graph has no write race. The fixture tests `checks only the aggregate program in project mode` and `reports missing package declarations without compiling references` show that `tsc -b --dry` treats the tsbuildinfo written by `tsc -p` as up to date and that project mode compiles no reference. In this implementation, the concurrent `build` and `DSH_GATE_CONCURRENCY=1 pnpm run build` produce byte-identical `lib/` (11,584 files), `apps/web/dist` (156 files), and client build record; afterwards `tsc -b --dry` reports all 372 projects of both aggregates up to date, with none to build.

| Error | `build:src` | `build:test` | `build` | `typecheck` | Required CI lanes |
|---|---|---|---|---|---|
| Package source type error | host-src / client-src | Not reported (reads existing declarations) | host-src / client-src | Reported | Reported |
| Type error only in an aggregate root program's tests, scripts, benchmarks, or website | Not reported | host-test / client-test | host-test / client-test | Reported | consumers, windows-build |
| Package tsconfig configuration error | host-src / client-src | Not reported (`tsc -p` does not validate referenced projects' tsconfig options or syntax) | host-src / client-src | Reported | Reported |
| Typert analysis error | host-bundle | Not reported | host-bundle | Reported (through the Host bundle) | Reported |
| Missing prerequisite output | — | Compiler diagnostic (TS6305, TS2307) | — | — | — |

Negative controls: after a type error (TS2322) is added to `scripts/pnpm-invocation.spec.ts`, which only the Host aggregate root program contains, `build:src` exits 0; `build:test` exits 1 with the Host aggregate check failing and the Client aggregate check passing; `build` exits 1 with 8 of 9 steps passing and 1 failing, and writes no client build record. In a scratch fixture whose referenced project's tsconfig has an invalid `target`, a JSON syntax error, or an unknown compiler option, `tsc -p` exits 0, while `tsc -b` reports TS6046, TS5092 with TS1012, and TS5023 respectively and exits 1; when the referenced project lacks `composite`, both report TS6306.

### Intentional trade-offs (not lossless)

- **Some commands skip the aggregate checks:** `build:src`, the launch builds of `dev:web` and `dev:desktop`, and the prerequisite steps of `lint`, `lint:fix`, `doc-typecheck`, and the Typert contracts gate do not type-check the two aggregate root programs, and these prerequisite steps do not produce `apps/desktop/lib`. `build`, `build:test`, `typecheck` (pre-push hook), and the two required CI lanes own completeness; `dev:web` and `dev:desktop` do not refuse to launch because of test type errors.
- **`build:test` does not check freshness:** When sources change after `build:src`, `build:test` checks against stale declarations, including Typert Remote declarations; rerun `build:src` first. The complete `build` is unaffected.
- **Concurrent `build` raises the memory peak:** This branch's complete `build` peaks at 7.55 GiB of process-tree RSS against 6.13 GiB for the master serial build (+1.42 GiB, one sample each); CPU meanwhile falls from 425.5 s to 373.4 s because [the lossless speed-ups note](2026-10-11-lossless-build-speedups.md) removes more work than concurrent contention adds. In the prototype (without the Typert changes), concurrent scheduling alone raises the RSS peak by about 2.1 GiB (5.9 → 8.0 GiB) and CPU by about 3.7%. `DSH_GATE_CONCURRENCY` bounds it; under memory pressure use `DSH_GATE_CONCURRENCY=1 pnpm run build`, or run `build:src` and `build:test` separately. In the windows-build lane, `build` runs concurrently with `docs:build`.
- **Passing steps' output is hidden by default:** Only failed steps print their complete output.
- **`tsc -p` does not skip an up-to-date root program:** An immediate rerun of `build:test` without changes still takes 19.4 s because both programs are parsed again; `tsc -b` skips an up-to-date root.
- **On many-core cold builds `build:src` is only 17.6 s faster than `build`:** This branch's cold `build` takes 170.1 s and `build:src` 152.5 s (one sample each), because host-test is off the critical path and client-test (34.8 s) is only about 16 s longer than client-bundle plus web (18.4 s). The rest of `build:src`'s saving is CPU and memory: in the prototype the two aggregate checks together use about 148 s of CPU, and the Host aggregate check overlapping Host tsdown raises the memory peak by about 2 GiB; on few-core machines and in incremental rebuilds this also turns into wall time.
- **CI invokes public commands in the root manifest:** PR artifact builds invoke `build:src` rather than an internal helper flag; a PR that edits these root manifest scripts activates the separate Node Addon System platform matrix.

## Alternatives considered

- **Keep the aggregate checks only in `typecheck`:** `pnpm run build` must stay complete and detect every error.
- **Keep `--artifacts-only` and add a `build:src` alias:** One operation would have two names.
- **`build:test` runs `tsc -b <aggregate>`:** Build mode compiles out-of-date references, doing `build:src`'s work.
- **`build:test` first completes or validates prerequisite outputs:** It violates each command doing only its own job and adds prerequisite logic; compiler diagnostics already name missing outputs.
- **A new scheduler (shell `&`/`wait`, `concurrently`, turbo/nx):** It duplicates run-gates' failure summary, process-tree termination, and Windows handling.
- **Expand `build` into several gates in CI's run-gates:** `pnpm run build` must be a complete command usable directly locally and by release workflows, and it writes the record.
- **Relax the non-data edges in the src chain (native ∥ host-src, desktop-bundle ∥ client-src):** Not measured; the Desktop bundle itself takes only 4.0–4.5 s.
- **Move tests into a new tsconfig:** The existing aggregates already separate package references from the root program.
- **Split the aggregate root programs into sub-programs:** Each sub-program must inject the 242 files carrying module augmentations, CPU grows by 9–57%, and only wall falls (see [the lossless speed-ups note](2026-10-11-lossless-build-speedups.md)).
- **Run `build:test` separately in CI:** The required lanes already get the same checks through `build`; a separate run repeats the work.

## Consequences

Development iterations can skip the two aggregate root programs with `build:src` (52% faster cold than master's `build`) and complete the checks with `build:test` or `build` before declaring work complete. `build` stays complete: the Host aggregate check is off the critical path, the Client aggregate check runs alongside the Client bundle and web, and a cold build is 46.5% faster than master (including the lossless speed-ups note's changes; one sample each). The costs are a higher memory peak, a little extra CPU from concurrent contention, less passing output by default, and several development and prerequisite commands that do not check test types (see the trade-offs above).

Removing or changing `build` in the two required lanes, consumers and windows-build, requires first transferring both aggregate checks to another blocking owner. If Typert later gains its own generation step, the step table adds it and client-src depends on it; command semantics and scheduling stay the same.

client-src's dependency on host-bundle guarantees the "Host and Remote artifacts complete before Client compilation" ordering that [Typert Remote method calls](../architecture/2026-08-02-typert-remote-method-calls.md) describes.

Verification: `scripts/build.spec.ts` covers the type-stripping check, rejection of the removed flag and invalid scopes, the conflict between `--profile` and `--scope test`, scope selection, step dependencies, and the environment; `compile-referenced-projects.spec.ts` covers project mode checking only the aggregate program, the diagnostic for missing declarations, and `tsc -b --dry` accepting the tsbuildinfo that `tsc -p` writes; failure propagation, output buffering, and process-tree termination come from the run-gates scheduler and its tests; `run-gates.spec.ts`, `ci-workflow.spec.ts`, `preview-workflow.spec.ts`, `build-exe-for-python-sdk.spec.ts`, `dev-web.spec.ts`, and `tests/ci-release-selfhosted.spec.ts` pin each caller's command.
