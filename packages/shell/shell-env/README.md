---
description: "Configure per-call Harness shell variables and directories for deployment-supplied commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-shell-env

English | [中文](README.zh.md)

## Summary

`dsh-shell-env` gives Bash and PowerShell tool calls current Harness home, session, and profile variables. Plugins can contribute declared `DSH_*` values and directories for deployment-supplied commands. Each call receives the current registrations without changing `process.env` or the user's shell configuration. Duplicate variable ownership and undeclared values fail loudly. Registrations follow plugin lifetimes; the shell tools retain their schemas and prompts.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin in any composition that mounts a model shell tool (`dsh-tool-bash` or `dsh-tool-pwsh`): each foreground or background shell call then runs with a freshly collected managed environment instead of whatever `DSH_*` values the process inherited.

### What every shell call receives

Every call receives `DSH_HOME` (the absolute Harness home), `DSH_SHELL=1`, and, for agent calls, `DSH_SESSION_ID` (the calling session's id). When the launcher provided a profile context, every call also receives `DSH_PROFILE` (the profile name) and `DSH_PROFILE_DIR` (its absolute directory; its `node_modules` holds only profile-installed packages, while the harness's own bundles resolve from the dsh installation); compositions booted without a profile omit both.

### Adding your own environment facts

Other plugins contribute facts by registering a contributor with a stable name, the complete set of `DSH_*` keys it may return, a description per key, and a resolver that computes values for one execution:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell-env'

export const inject = ['shellEnv']

export function apply(ctx: Context): void {
  ctx.shellEnv.register({
    name: 'deployment-region',
    variables: { DSH_DEPLOYMENT_REGION: { description: 'Current deployment region.' } },
    resolve: execution => execution.agent === undefined ? {} : { DSH_DEPLOYMENT_REGION: 'cn-north' },
  })
}
```

Contributors must declare every key they return; returning an undeclared or non-string value fails the call. Registration is disposed with the registering plugin, so hot-reloading a plugin removes its facts.

Contributors may also declare absolute `commandDirectories`. The registry prepends these directories to the local shell's `PATH` in contributor-name order, preserving each contributor's directory order and removing repeated directories. The inherited `PATH` follows them. With no command directories, it leaves `PATH` unchanged. Directory registration does not install commands or verify their contents; the contributing plugin owns those files and their lifetime. The [Office commands plugin](../../skill/skill-office/README.md) supplies `dsoffice` and `office-check` this way.

### Choosing the Harness home

The single config field picks the home directory exposed as `DSH_HOME`; the default resolution order is the `dshHome` config, then ambient `$DSH_HOME`, then `~/.dsh`.

| Field | Default | Meaning |
|---|---|---|
| `dshHome` | `$DSH_HOME`, then `~/.dsh` | Absolute Harness home exposed as `DSH_HOME` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-shell-env) is the exhaustive source for every accepted field and its JSDoc.

### What can go wrong

Two contributors declaring the same key, or a contributor claiming a reserved built-in (`DSH_HOME`, `DSH_SHELL`, `DSH_SESSION_ID`, `DSH_PROFILE`, `DSH_PROFILE_DIR`), fails plugin load loudly. A `DSH_*` key must be all-caps with underscores (for example `DSH_REGION`), and a missing description fails registration. Relative command directories also fail registration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the registry and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Trusted namespace, rebuilt per call.** The environment is a Harness-owned `DSH_*` namespace: the shell executor discards inherited `DSH_*` values and merges the registry's current snapshot for each execution, so nested harnesses and concurrent parent/child agents cannot leak stale identities, and `process.env` is never modified.
- **Declared ownership, loud conflicts.** Contributors declare their keys up front so duplicate ownership is detected before the first command; resolvers may only return declared keys.
- **Built-ins stay here.** `DSH_HOME`, `DSH_SHELL`, `DSH_SESSION_ID`, `DSH_PROFILE`, and `DSH_PROFILE_DIR` are reserved for the registry; contributors cannot claim them.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, `ShellEnvRegistry` service, and the built-in facts |

### Collection

`collect(execution)` combines built-in facts, contributor values, and any command-directory `PATH` into a frozen snapshot passed through `ShellExecRequest.dshEnv`. This trusted snapshot takes precedence over ordinary caller environment entries. `list()` enumerates variable declarations without running resolvers; it does not include command directories or execution-dependent values.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shell family to the executor seam and the generated catalogs.

- [shell package map](../README.md) — the bash capability family and its roles.
- [Bash executor subsystem](../../../docs/subsystems/shell.md) — the `ctx.shell` seam the tools execute through.
- [tool-bash](../tool-bash/README.md) — the bash tool that consumes this environment.
- [tool-pwsh](../tool-pwsh/README.md) — the pwsh tool that consumes this environment.
- [home paths package](../../util/home-paths/README.md) — how `DSH_HOME` is resolved.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-shell-env) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the shell tools (`dsh-tool-bash`, `dsh-tool-pwsh`), which expose this registry's managed `DSH_*` facts and command lookup paths in every shell-tool call.

#### KV Cache effect

The managed environment never enters the request prefix, so it does not invalidate provider cache reuse; the shell tools' definitions and the current request envelope own any prefix change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the registry is a poor fit or needs care. They are current package constraints, not a task backlog.

- **`list()` enumerates plugin-contributed variables only** — registry-owned built-ins (`DSH_HOME`, `DSH_SHELL`, `DSH_SESSION_ID`, `DSH_PROFILE`, `DSH_PROFILE_DIR`) are not included, so diagnostics, prompt, or UI code must not treat `list()` as an exhaustive environment catalog.
- **Command directories belong to the local host.** A remote execution provider needs commands installed and configured in its own execution environment; local directory contributions do not provision the remote host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
