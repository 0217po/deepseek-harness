/** Raw bundle declarations remain inspectable while their prerequisite layers are disabled. */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { realModuleFile, profilePatchPreset, type ProfilePatch, type PluginPackages } from '@deepseek-ai/dsh-app-boot'

/** A declared child row and the outer preset operation that contributes it. */
export interface BundleDeclaration {
  readonly row: EntryOptions
  readonly preset?: string
}

/** Read inserted rows without applying a bundle against an incomplete profile.
 * @param patches Parsed bundle patches, whose module paths are already anchored.
 * @returns Declarations in patch order, including nested groups.
 */
export function bundleDeclarations(patches: readonly ProfilePatch[]): BundleDeclaration[] {
  const result: BundleDeclaration[] = []
  const visit = (rows: EntryOptions[], preset?: string): void => {
    for (const row of rows) {
      result.push({ row, ...preset === undefined ? {} : { preset } })
      if (row.group && Array.isArray(row.config)) visit(row.config as EntryOptions[], preset)
    }
  }
  for (const patch of patches) {
    if (patch.insert !== undefined) visit(patch.insert, profilePatchPreset(patch))
  }
  return result
}

/** Locate the package owning a bare import or filesystem module without importing its code.
 * @param specifier Configured module name or anchored file URL.
 * @param base Declaring Loader tree's resolution URL.
 * @param packages Optional profile package lookup for bare specifiers.
 * @returns Canonical package manifest path, or undefined for builtins, missing modules, and unowned files.
 */
export function bundleModuleOwner(
  specifier: string, base: string, packages?: Pick<PluginPackages, 'packageOf'>,
): string | undefined {
  const known = packages?.packageOf(specifier, base)
  if (known !== undefined) return realModuleFile(known.manifestPath)
  if (!specifier.startsWith('file:') && !specifier.startsWith('.') && !isAbsolute(specifier)) return undefined
  const file = isAbsolute(specifier) ? specifier : fileURLToPath(new URL(specifier, base))
  if (!existsSync(file)) return undefined
  let dir = dirname(realModuleFile(file))
  while (true) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) return realModuleFile(manifest)
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
