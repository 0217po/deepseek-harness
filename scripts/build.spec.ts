import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildGates, parseBuildArguments } from './build.ts'

const root = resolve(import.meta.dirname, '..')

function graph(scope: Parameters<typeof buildGates>[1]): Record<string, string[] | undefined> {
  return Object.fromEntries(buildGates(root, scope).map(gate => [gate.id, gate.needs]))
}

describe('repository build CLI', () => {
  // The sentinel makes parseArgs fail fast if the check ever stops running first.
  it('rejects a Node process without TypeScript type stripping before any build step', () => {
    const result = spawnSync(
      process.execPath,
      ['--no-experimental-strip-types', '--import', 'tsx/esm', resolve(root, 'scripts/build.ts'), '--spec-sentinel'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('build: Node.js TypeScript type stripping is unavailable')
  })

  it('rejects the removed artifacts-only flag before any build step', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve(root, 'scripts/build.ts'), '--artifacts-only'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("Unknown option '--artifacts-only'")
  })

  it('selects the complete build by default and one step set by scope', () => {
    expect(parseBuildArguments([])).toEqual({ scope: 'complete', profile: undefined })
    expect(parseBuildArguments(['--scope', 'src', '--profile', 'official'])).toEqual({ scope: 'src', profile: 'official' })
    expect(parseBuildArguments(['--scope', 'test'])).toEqual({ scope: 'test', profile: undefined })
  })

  it.each([
    [['--scope', 'complete'], '--scope must be src or test'],
    [['--scope', 'lib'], '--scope must be src or test'],
    [['--scope', 'test', '--profile', 'official'], '--profile selects artifact values and does not apply to --scope test'],
  ])('rejects %j', (args, message) => {
    expect(() => parseBuildArguments(args)).toThrow(message)
  })
})

describe('repository build steps', () => {
  it('keeps artifact steps in serial dependency order', () => {
    expect(graph('src')).toEqual({
      'native': [],
      'host-src': ['native'],
      'host-bundle': ['host-src'],
      'desktop-bundle': ['host-bundle'],
      'client-src': ['desktop-bundle'],
      'client-bundle': ['client-src'],
      'web': ['client-bundle'],
    })
  })

  it('checks both aggregate programs without artifact predecessors', () => {
    expect(graph('test')).toEqual({ 'host-test': [], 'client-test': [] })
    expect(buildGates(root, 'test').map(gate => gate.args.slice(-2))).toEqual([
      ['-p', 'tsconfig.host.json'],
      ['-p', 'tsconfig.client.json'],
    ])
  })

  it('starts each aggregate check after its own package compilation in the complete build', () => {
    expect(graph('complete')).toEqual({
      ...graph('src'),
      'host-test': ['host-src'],
      'client-test': ['client-src'],
    })
  })

  it('applies the environment overlay to every step', () => {
    const environment = { DSH_CLIENT_TITLE: 'Title', DSH_BUILD_CLIENT_PROFILE: undefined }
    for (const gate of buildGates(root, 'complete', environment)) expect(gate.env).toEqual(environment)
  })
})
