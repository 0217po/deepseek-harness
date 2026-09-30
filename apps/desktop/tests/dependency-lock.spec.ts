/** Repository dependency and patch preservation in a disposable Desktop install. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { describe, expect, it, onTestFinished } from 'vitest'
import { prepareDesktopDependencyLock, verifyDesktopDependencyLock } from '../scripts/dependency-lock.ts'
import { desktopCorePackageOverrides, desktopCorePackageSpec, type DesktopCorePackageSet } from '../src/core-package-set.ts'

interface Lockfile {
  lockfileVersion: string
  settings: { autoInstallPeers: boolean }
  importers: Record<string, { dependencies: Record<string, { specifier: string; version: string }> }>
  packages: Record<string, { resolution: { integrity: string; tarball?: string }; version?: string }>
  snapshots: Record<string, { dependencies?: Record<string, string> }>
  patchedDependencies: Record<string, string>
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dependency-lock-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const project = join(root, 'project')
  mkdirSync(project)
  mkdirSync(join(root, 'patches'))
  writeFileSync(join(root, 'package.json'), '{}')
  const members = [
    ['apps/cli', { name: '@deepseek-ai/dsh', version: '1.0.0' }],
    ['apps/host', { name: '@deepseek-ai/dsh-desktop-host', version: '1.0.0', optionalDependencies: { '@test/native': '^1.0.0' } }],
    ['native/linux', { name: '@test/native', version: '1.0.0' }],
  ] as const
  for (const [dir, manifest] of members) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(manifest))
  }
  writeFileSync(join(root, 'patches/runtime.patch'), 'runtime patch\n')
  writeFileSync(join(root, 'patches/build.patch'), 'build patch\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), dump({
    packages: ['apps/*', 'native/*'],
    overrides: { '@deepseek-ai/dsh': 'link:apps/cli', 'parent>child': '1.0.0' },
    patchedDependencies: { 'library@1.0.0': 'patches/runtime.patch', 'build-only@1.0.0': 'patches/build.patch' },
  }))
  const source: Lockfile = {
    lockfileVersion: '9.0', settings: { autoInstallPeers: true }, importers: { '.': { dependencies: {} } },
    packages: {
      'library@1.0.0': { resolution: { integrity: 'sha512-one' } },
      'library@2.0.0': { resolution: { integrity: 'sha512-two' } },
      'build-only@1.0.0': { resolution: { integrity: 'sha512-build' } },
    },
    snapshots: { 'library@1.0.0(patch_hash=runtime)': {}, 'library@2.0.0': {}, 'build-only@1.0.0(patch_hash=build)': {} },
    patchedDependencies: { 'library@1.0.0': 'runtime', 'build-only@1.0.0': 'build' },
  }
  writeFileSync(join(root, 'pnpm-lock.yaml'), dump(source))
  const set: DesktopCorePackageSet = {
    schemaVersion: 1,
    packages: members.slice(0, 2).map(([, manifest], index) => ({
      name: manifest.name, version: manifest.version, file: `${String(index)}.tgz`, bytes: 1, integrity: `sha512-local${String(index)}`,
    })),
  }
  const local = Object.fromEntries(set.packages.map((entry) => {
    const spec = desktopCorePackageSpec(entry).replace('file:./', 'file:')
    return [`${entry.name}@${spec}`, { version: entry.version, resolution: { tarball: spec, integrity: entry.integrity } }]
  }))
  const actual: Lockfile = {
    ...source,
    importers: { '.': { dependencies: Object.fromEntries(set.packages.map((entry) => {
      const spec = desktopCorePackageSpec(entry).replace('file:./', 'file:')
      return [entry.name, { specifier: spec, version: spec }]
    })) } },
    packages: { ...local, 'library@1.0.0': source.packages['library@1.0.0']!, 'library@2.0.0': source.packages['library@2.0.0']! },
    snapshots: {
      ...Object.fromEntries(Object.keys(local).map(key => [key, { dependencies: { library: '1.0.0(patch_hash=runtime)', alias: 'library@2.0.0' } }])),
      'library@1.0.0(patch_hash=runtime)': {}, 'library@2.0.0': {},
    },
    patchedDependencies: { ...source.patchedDependencies },
  }
  writeFileSync(join(project, 'pnpm-workspace.yaml'), dump({
    packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false,
    overrides: desktopCorePackageOverrides(set), allowBuilds: { library: true },
  }))
  return { root, project, source, actual, set, localKey: Object.keys(local)[0]! }
}

describe('Desktop dependency lock', () => {
  it('seeds repository resolutions, overrides and patches while preserving the source checkout', () => {
    const { root, project, source, set } = fixture()
    prepareDesktopDependencyLock(project, root, set)
    expect(load(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8'))).toMatchObject({
      nodeLinker: 'hoisted', autoInstallPeers: false, allowBuilds: { library: true }, allowUnusedPatches: true,
      overrides: { ...desktopCorePackageOverrides(set), '@test/native': '1.0.0', 'parent>child': '1.0.0' },
      patchedDependencies: { 'build-only@1.0.0': 'dependency-patches/0.patch', 'library@1.0.0': 'dependency-patches/1.patch' },
    })
    expect(readFileSync(join(project, 'dependency-patches/0.patch'), 'utf8')).toBe('build patch\n')
    expect(readFileSync(join(project, 'dependency-patches/1.patch'), 'utf8')).toBe('runtime patch\n')
    expect(load(readFileSync(join(project, 'pnpm-lock.yaml'), 'utf8'))).toMatchObject({
      packages: source.packages, snapshots: source.snapshots, patchedDependencies: source.patchedDependencies,
      importers: { '.': {} }, settings: { autoInstallPeers: false },
    })
    expect(load(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))).toEqual(source)
  })

  it('accepts existing major versions, npm aliases and peer contexts without installing build-only dependencies', () => {
    const { root, actual, set } = fixture()
    actual.snapshots['library@2.0.0(peer@1.0.0)'] = {}
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).not.toThrow()
  })

  it.each(['another-library@1.0.0', 'library@3.0.0', '@scope/native@2.0.0'])(
    'rejects a new dependency or version: %s', (key) => {
      const { root, actual, set } = fixture()
      actual.packages[key] = { resolution: { integrity: 'sha512-unqualified' } }
      actual.snapshots[key] = {}
      expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow(`${key} is absent from the repository lockfile`)
    },
  )

  it('rejects changed registry integrity', () => {
    const { root, actual, set } = fixture()
    actual.packages['library@2.0.0']!.resolution.integrity = 'sha512-changed'
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('resolution differs from the repository lockfile')
  })

  it('requires both patch metadata and the patched dependency snapshot', () => {
    const { root, actual, set } = fixture()
    delete actual.patchedDependencies['library@1.0.0']
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('patch differs from the repository lockfile')
    actual.patchedDependencies['library@1.0.0'] = 'runtime'
    delete actual.snapshots['library@1.0.0(patch_hash=runtime)']
    actual.snapshots['library@1.0.0'] = {}
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('does not apply the repository patch')
  })

  it('rejects missing package metadata, dependency snapshots and local tarballs', () => {
    const { root, actual, set, localKey } = fixture()
    delete actual.packages['library@2.0.0']
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('has no package resolution')
    delete actual.snapshots['library@2.0.0']
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('has no resolved dependency snapshot')
    actual.packages = Object.fromEntries(Object.entries(actual.packages).filter(([key]) => key !== localKey))
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('missing local package')
  })

  it.each(['1.0.0', '9.0.0'])(
    'rejects a registry copy of a locally packed package at version %s', (version) => {
      const { root, actual, set } = fixture()
      actual.packages[`@deepseek-ai/dsh@${version}`] = { resolution: { integrity: 'sha512-registry' } }
      expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('must resolve to the verified local tarball')
    },
  )

  it('rejects corrupted local tarball integrity', () => {
    const { root, actual, set, localKey } = fixture()
    actual.packages[localKey]!.resolution.integrity = 'sha512-corrupt'
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('must resolve to the verified local tarball')
  })

  it('allows unpacked optional workspace platforms only at their exact source version', () => {
    const { root, actual, set } = fixture()
    actual.packages['@test/native@1.0.0'] = { resolution: { integrity: 'sha512-platform' } }
    actual.snapshots['@test/native@1.0.0'] = {}
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).not.toThrow()
    actual.packages['@test/native@1.0.1'] = { resolution: { integrity: 'sha512-other-platform' } }
    expect(() => { verifyDesktopDependencyLock(dump(actual), root, set) }).toThrow('@test/native@1.0.1 is absent')
  })

  it.each(['{}', 'lockfileVersion: "8.0"', 'lockfileVersion: "9.0"\npackages: {}', 'lockfileVersion: "9.0"\npackages: []'])(
    'rejects an invalid or empty production lockfile: %s', (text) => {
      const { root, set } = fixture()
      expect(() => { verifyDesktopDependencyLock(text, root, set) }).toThrow('desktop dependencies:')
    },
  )
})
