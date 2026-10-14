/** Official bundles offered without installing their provider runtimes in the DSH distribution. */

import type { PluginLocalizedMeta } from '@deepseek-ai/dsh-package-manifest'

export { ON_DEMAND_BUNDLES } from './official-bundle-packages.ts'

/** Offline discovery metadata; installation state and the requested version belong to the running host. */
export interface OfficialBundleCatalogEntry {
  /** Exact npm package name accepted by the existing bundle installer. */
  readonly packageName: string
  /** Package-owned localized text and self-contained images, embedded without provider code. */
  readonly meta: Required<Pick<PluginLocalizedMeta, 'title' | 'description' | 'icon'>> & Pick<PluginLocalizedMeta, 'preview'>
}

export { OFFICIAL_ON_DEMAND_CATALOG } from './official-bundles.generated.ts'
