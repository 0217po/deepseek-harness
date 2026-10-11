/**
 * Build repository artifacts, type-check the aggregate test and script programs, or both.
 *
 * `--scope src` emits every artifact and binds the client outputs to their public environment;
 * `--scope test` type-checks only the Host and Client aggregate programs against the package
 * declarations already on disk; the default runs both step sets as one dependency graph, so the
 * aggregate checks overlap the remaining artifact steps.
 */

import { rmSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CLIENT_BUILD_RECORD_PATH,
  CLIENT_BUILD_PROFILE_SELECTOR,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
} from './client-build-environment.ts'
import { aggregateCheckArgs, libraryBuildSteps } from './compile-referenced-projects.ts'
import { pnpmCommand } from './release/process.ts'
import { runAggregate } from './run-gates.ts'
import type { Gate } from './run-gates.ts'

/** Steps one build invocation runs: every artifact and check, only artifacts, or only aggregate checks. */
export type BuildScope = 'complete' | 'src' | 'test'

/** Parsed command-line selection of one build invocation. */
export interface BuildArguments {
  readonly scope: BuildScope
  /** Client build profile requested by `--profile`; artifact scopes only. */
  readonly profile: string | undefined
}

/**
 * Parse the build command line.
 * @param args - Arguments after the script path.
 * @returns The selected scope and requested client build profile.
 * @throws If an option is unknown, the scope is not `src` or `test`, or `--profile` accompanies `--scope test`.
 */
export function parseBuildArguments(args: readonly string[]): BuildArguments {
  const { values } = parseArgs({
    args: [...args],
    options: {
      profile: { type: 'string' },
      scope: { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.scope !== undefined && values.scope !== 'src' && values.scope !== 'test') {
    throw new Error(`build: --scope must be src or test, got ${JSON.stringify(values.scope)}; omit it for the complete build`)
  }
  const scope: BuildScope = values.scope ?? 'complete'
  if (scope === 'test' && values.profile !== undefined) {
    throw new Error('build: --profile selects artifact values and does not apply to --scope test')
  }
  return { scope, profile: values.profile }
}

/**
 * Construct the build steps of one scope as a gate dependency graph.
 * Artifact steps keep the serial order native, Host compilation, Host bundle (Typert),
 * Desktop bundle, Client compilation, Client bundle, then Web. In the complete scope each
 * aggregate check waits only for its own face's package compilation; alone, the checks
 * have no predecessors and read whatever declarations already exist.
 * @param root - Repository root containing the compiler and bundle configurations.
 * @param scope - Steps to include.
 * @param environment - Environment overlay applied to every step; the parent value of a key mapped to `undefined` is removed.
 * @returns The gate graph in report order.
 * @throws If an aggregate configuration is invalid.
 */
export function buildGates(
  root: string,
  scope: BuildScope,
  environment: Readonly<Record<string, string | undefined>> = {},
): Gate[] {
  const env = { ...environment }
  const gates: Gate[] = []
  if (scope !== 'test') {
    gates.push(pnpmGate('native', 'native addon', ['run', 'build:native-system'], [], env))
    for (const step of libraryBuildSteps(root, 'all')) {
      gates.push({
        id: step.id,
        label: step.label,
        displayCommand: step.displayCommand,
        command: step.command,
        args: [...step.args],
        needs: step.id === 'host-src' ? ['native'] : [...step.needs],
        env,
      })
    }
    gates.push(pnpmGate('web', 'Web build', ['run', 'build:web'], ['client-bundle'], env))
  }
  if (scope !== 'src') {
    for (const face of ['host', 'client'] as const) {
      gates.push({
        id: `${face}-test`,
        label: `${face} aggregate check`,
        displayCommand: `tsc -p tsconfig.${face}.json`,
        command: process.execPath,
        args: aggregateCheckArgs(face),
        needs: scope === 'complete' ? [`${face}-src`] : [],
        env,
      })
    }
  }
  return gates
}

function pnpmGate(
  id: string,
  label: string,
  args: readonly string[],
  needs: readonly string[],
  env: Record<string, string | undefined>,
): Gate {
  const [command, ...prefix] = pnpmCommand()
  return { id, label, displayCommand: `pnpm ${args.join(' ')}`, command, args: [...prefix, ...args], needs: [...needs], env }
}

/**
 * Express a complete child environment as an overlay on the parent environment.
 * @param parent - Environment the gate executor merges the overlay into.
 * @param child - Complete environment every step must observe.
 * @returns `child` plus an `undefined` entry for each parent key it omits.
 */
function environmentOverlay(parent: NodeJS.ProcessEnv, child: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return { ...Object.fromEntries(Object.keys(parent).map(name => [name, undefined])), ...child }
}

async function main(): Promise<number> {
  // tsdown.config.ts loads only through Node type stripping (`--config-loader native`); this names the cause before tsdown fails.
  if (!process.features.typescript) {
    throw new Error('build: Node.js TypeScript type stripping is unavailable in this Node.js process; remove --no-experimental-strip-types from NODE_OPTIONS or use a Node.js build with TypeScript support')
  }
  const { scope, profile } = parseBuildArguments(process.argv.slice(2))
  const root = resolve(import.meta.dirname, '..')
  const name = scope === 'complete' ? 'build' : `build:${scope}`
  const available = availableParallelism()
  const workers = (gates: readonly Gate[]) => ({
    workers: Math.min(gates.length, available),
    source: `${String(available)} available CPU(s)`,
  })
  if (scope === 'test') {
    const gates = buildGates(root, scope)
    return runAggregate(name, gates, workers(gates))
  }

  const repositoryEnvironment = repositoryClientBuildEnvironment(root, process.env)
  const clientEnvironment = resolveClientBuildEnvironment(repositoryEnvironment, profile ?? process.env[CLIENT_BUILD_PROFILE_SELECTOR])
  const environment = environmentOverlay(process.env, clientBuildProcessEnvironment(process.env, clientEnvironment))
  rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
  const gates = buildGates(root, scope, environment)
  const exitCode = await runAggregate(name, gates, workers(gates))
  if (exitCode !== 0) return exitCode
  const record = writeClientBuildRecord(root, clientEnvironment)
  console.log(
    `build: recorded ${String(record.artifacts.fileCount)} client artifact(s) with ${String(Object.keys(record.environment).length)} public value(s)`,
  )
  return 0
}

if (import.meta.main) process.exitCode = await main()
