/** Shared Koffi pin for workspace declarations and fresh Desktop production installs. */

import { load as loadYaml } from 'js-yaml'

/** Version qualified for source builds when optional native prebuilts are omitted. */
export const KOFFI_VERSION = '3.1.1'

/**
 * Reject missing or divergent Koffi resolutions before installing the Desktop runtime.
 * @param lockfile - Freshly generated pnpm lockfile text.
 * @throws When Koffi is absent or its JavaScript or native packages use another version.
 */
export function verifyKoffiLockfile(lockfile: string): void {
  const data: unknown = loadYaml(lockfile)
  if (typeof data !== 'object' || data === null || !('packages' in data)
    || typeof data.packages !== 'object' || data.packages === null || Array.isArray(data.packages)) {
    throw new Error('Koffi: lockfile must contain a packages mapping')
  }
  const packages = Object.keys(data.packages)
  if (!packages.includes(`koffi@${KOFFI_VERSION}`)) {
    throw new Error(`Koffi: lockfile must resolve koffi@${KOFFI_VERSION}`)
  }
  for (const entry of packages) {
    const match = /^(koffi|@koromix\/koffi-[^@]+)@(.+)$/u.exec(entry)
    if (match !== null && match[2] !== KOFFI_VERSION) {
      throw new Error(`Koffi: lockfile resolved ${entry}; all Koffi packages must use ${KOFFI_VERSION}`)
    }
  }
}
