/** Desktop resource paths consumed by the shared Web Office configuration. */

import { realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeArchivePath } from './office-engine.ts'

/** Application-selected bundled payload and installation directories. */
export interface Config {
  /** Bundled payload directory. Missing sibling `office-skills` resources fail Host startup. */
  readonly source: string
  /** Harness-home directory where workspace dependencies are installed. */
  readonly root: string
  /** Prepared or ASAR-contained application dependency directory. */
  readonly runtimeDir: string
}

/**
 * Resolve carrier defaults before the shared profile evaluates its configuration.
 * @param config - Bundled payload, installation root, and application dependency directory.
 * @returns Resource environment consumed by patchable Web bundle rows.
 */
export function desktopOfficeEnvironment(config: Config): Record<string, string> {
  const archive = runtimeArchivePath(config.runtimeDir) === undefined ? undefined : dirname(realpathSync(config.runtimeDir))
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
  const packageRoot = dirname(archive === undefined ? manifest : join(`${archive}.unpacked`, relative(archive, manifest)))
  return {
    DSH_BUNDLED_PRIMARY_RUNTIME: config.source,
    DSH_BUNDLED_PRIMARY_RUNTIME_ROOT: config.root,
    DSH_BUNDLED_OFFICE_CLI: join(packageRoot, 'lib', 'cli.js'),
  }
}
