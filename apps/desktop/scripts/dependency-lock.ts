/** Preserve repository dependency resolutions and patches in the packed Desktop runtime. */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { dump, load } from 'js-yaml'
import { readWorkspaceManifests } from '../../../scripts/check-workspace-constraints.ts'
import { desktopCorePackageSpec, type DesktopCorePackageSet } from '../src/core-package-set.ts'

function mapping(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop dependencies: ${subject} must be a mapping`)
  }
  return value as Record<string, unknown>
}

function strings(value: unknown, subject: string): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping(value, subject)).map(([key, entry]) => {
    if (typeof entry !== 'string') throw new Error(`desktop dependencies: ${subject}.${key} must be a string`)
    return [key, entry]
  }))
}

function parseLockfile(text: string, subject: string) {
  const data = mapping(load(text), subject)
  if (data.lockfileVersion !== '9.0') throw new Error(`desktop dependencies: ${subject} must use lockfile version 9.0`)
  const packages = mapping(data.packages, `${subject}.packages`)
  if (Object.keys(packages).length === 0) throw new Error(`desktop dependencies: ${subject}.packages must not be empty`)
  const snapshots = mapping(data.snapshots, `${subject}.snapshots`)
  const patchedDependencies = strings(data.patchedDependencies ?? {}, `${subject}.patchedDependencies`)
  return { data, packages, snapshots, patchedDependencies }
}

function dependencyPolicy(repositoryRoot: string, packageSet: DesktopCorePackageSet) {
  const lock = parseLockfile(readFileSync(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'), 'repository lockfile')
  const workspace = mapping(load(readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')), 'repository workspace')
  const patches = strings(workspace.patchedDependencies ?? {}, 'repository workspace.patchedDependencies')
  const overrides = strings(workspace.overrides ?? {}, 'repository workspace.overrides')
  const members = new Map(readWorkspaceManifests(repositoryRoot).map(entry => [entry.manifest.name, entry.manifest]))
  const packed = new Set(packageSet.packages.map(entry => entry.name))
  const optionalWorkspaceVersions: Record<string, string> = {}
  for (const entry of packageSet.packages) {
    const manifest = members.get(entry.name)
    if (manifest === undefined) throw new Error(`desktop dependencies: ${entry.name} is not a workspace member`)
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      const optional = members.get(name)
      if (packed.has(name) || optional === undefined) continue
      if (optional.version === undefined) throw new Error(`desktop dependencies: ${name} has no workspace version`)
      optionalWorkspaceVersions[name] = optional.version
    }
  }
  return { lock, patches, overrides, optionalWorkspaceVersions }
}

/**
 * Seed the disposable production project with repository resolutions and patch files.
 * @param projectDir - Staged project containing local tarballs and its generated workspace configuration.
 * @param repositoryRoot - Checkout whose lockfile and patches qualified those tarballs.
 * @param packageSet - Verified local first-party tarballs.
 */
export function prepareDesktopDependencyLock(projectDir: string, repositoryRoot: string, packageSet: DesktopCorePackageSet): void {
  const policy = dependencyPolicy(repositoryRoot, packageSet)
  const path = join(projectDir, 'pnpm-workspace.yaml')
  const workspace = mapping(load(readFileSync(path, 'utf8')), 'production workspace')
  workspace.overrides = {
    ...policy.overrides,
    ...policy.optionalWorkspaceVersions,
    ...strings(workspace.overrides ?? {}, 'production workspace.overrides'),
  }
  const patchedDependencies: Record<string, string> = {}
  const patchDir = 'dependency-patches'
  mkdirSync(join(projectDir, patchDir), { recursive: true })
  for (const [index, [name, source]] of Object.entries(policy.patches).sort(([left], [right]) => left.localeCompare(right)).entries()) {
    const destination = `${patchDir}/${String(index)}.patch`
    copyFileSync(resolve(repositoryRoot, source), join(projectDir, destination))
    patchedDependencies[name] = destination
  }
  workspace.patchedDependencies = patchedDependencies
  // The repository also patches build-only dependencies absent from the production graph.
  workspace.allowUnusedPatches = true
  writeFileSync(path, dump(workspace))
  writeFileSync(join(projectDir, 'pnpm-lock.yaml'), dump({
    ...policy.lock.data,
    settings: { ...mapping(policy.lock.data.settings, 'repository lockfile.settings'), autoInstallPeers: false },
    overrides: workspace.overrides,
    importers: { '.': {} },
  }))
}

/**
 * Reject production resolutions outside the repository lock and verified local package set.
 * Existing repository versions, including distinct compatible dependency trees, remain permitted.
 * @param text - Production lockfile generated from the seeded project.
 * @param repositoryRoot - Checkout supplying the dependency and patch baseline.
 * @param packageSet - Verified local first-party tarballs.
 * @throws When a package version, integrity, local tarball, or applied patch differs from its baseline.
 */
export function verifyDesktopDependencyLock(text: string, repositoryRoot: string, packageSet: DesktopCorePackageSet): void {
  const policy = dependencyPolicy(repositoryRoot, packageSet)
  const actual = parseLockfile(text, 'production lockfile')
  const packed = new Map(packageSet.packages.map(entry => [entry.name, entry]))
  const errors: string[] = []
  for (const [key, value] of Object.entries(actual.packages)) {
    const match = /^((?:@[^/]+\/)?[^@]+)@(.+)$/u.exec(key)
    const name = match?.[1]
    const version = match?.[2]
    if (name === undefined || version === undefined) {
      errors.push(`invalid package identity ${key}`)
      continue
    }
    const resolution = mapping(mapping(value, key).resolution, `${key}.resolution`)
    const local = packed.get(name)
    if (local !== undefined) {
      const spec = desktopCorePackageSpec(local).replace('file:./', 'file:')
      if (version !== spec || resolution.integrity !== local.integrity || resolution.tarball !== spec) {
        errors.push(`${key} must resolve to the verified local tarball ${spec}`)
      }
      continue
    }
    const expected = policy.lock.packages[key]
    if (expected === undefined) {
      if (policy.optionalWorkspaceVersions[name] !== version || typeof resolution.integrity !== 'string') {
        errors.push(`${key} is absent from the repository lockfile; update and qualify the repository dependency first`)
      }
      continue
    }
    if (!isDeepStrictEqual(resolution, mapping(expected, `repository ${key}`).resolution)) {
      errors.push(`${key} resolution differs from the repository lockfile`)
    }
  }
  const snapshots = Object.keys(actual.snapshots)
  for (const key of Object.keys(actual.packages)) {
    const patch = policy.lock.patchedDependencies[key]
    if (actual.patchedDependencies[key] !== patch) errors.push(`${key} patch differs from the repository lockfile`)
    const instances = snapshots.filter(snapshot => snapshot.split('(')[0] === key)
    if (instances.length === 0) errors.push(`${key} has no dependency snapshot`)
    for (const snapshot of instances) {
      if (/\(patch_hash=([^)]+)\)/u.exec(snapshot)?.[1] !== patch) {
        errors.push(`${snapshot} does not apply the repository patch`)
      }
    }
  }
  const importers = mapping(actual.data.importers, 'production lockfile.importers')
  if (importers['.'] === undefined) errors.push('missing production root importer')
  for (const [owner, value] of [...Object.entries(importers), ...Object.entries(actual.snapshots)]) {
    const entry = mapping(value, owner)
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [name, dependency] of Object.entries(mapping(entry[section] ?? {}, `${owner}.${section}`))) {
        const reference = typeof dependency === 'string' ? dependency : mapping(dependency, `${owner}.${name}`).version
        if (typeof reference !== 'string'
          || (actual.snapshots[`${name}@${reference}`] === undefined && actual.snapshots[reference] === undefined)) {
          errors.push(`${owner}.${section}.${name} has no resolved dependency snapshot`)
        }
      }
    }
  }
  for (const snapshot of snapshots) {
    if (actual.packages[snapshot.split('(')[0] ?? ''] === undefined) errors.push(`${snapshot} has no package resolution`)
  }
  for (const entry of packageSet.packages) {
    const key = `${entry.name}@${desktopCorePackageSpec(entry).replace('file:./', 'file:')}`
    if (actual.packages[key] === undefined) errors.push(`missing local package ${entry.name}`)
  }
  if (errors.length > 0) throw new Error(`desktop dependencies:\n${errors.join('\n')}`)
}
