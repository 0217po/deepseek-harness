/** On-demand built-in artwork over the existing client resource lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { BundlePreviewInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Optional distribution-owned bundle artwork, fetched only while its details are viewed. */
    'builtin-plugin-preview': BundlePreviewInfo
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The preview address is not canonical or does not identify a bundle. */
    'plugin-preview/invalid-address': Record<string, never>
    /** Reading the Host's built-in artwork failed. */
    'plugin-preview/read-failed': Record<string, never>
  }
}

/**
 * Address one built-in bundle's artwork.
 * @param name - exact package name.
 * @returns canonical resource address with the package encoded as one path segment.
 */
export function previewAddress(name: string): string {
  return `dsh-resource://builtin-plugin-preview/${encodeURIComponent(name)}`
}

/**
 * Bind artwork reads to the Host's distribution-only reader; resources own sharing and discard results after release.
 * @param remote - generated plugin-manager artwork method.
 * @returns a provider reading one immutable artwork value per open resource.
 */
export function previewResourceProvider(remote: Pick<Context['remote']['pluginManager'], 'readBundlePreview'>): ResourceProvider<'builtin-plugin-preview'> {
  return {
    protocol: 'builtin-plugin-preview',
    async *open(address, { signal }) {
      const released = (): boolean => signal.aborted
      if (released()) return
      let name: string
      try {
        name = decodeURIComponent(new URL(address).pathname.slice(1))
        if (name === '' || address !== previewAddress(name)) throw new Error('Noncanonical preview address')
      } catch (_error) {
        yield { ok: false, error: new RemoteError('plugin-preview/invalid-address', 'Invalid built-in preview address.', {}) }
        return
      }
      try {
        const result = await remote.readBundlePreview(name)
        if (!released()) yield result
      } catch (error) {
        if (!released()) yield {
          ok: false,
          error: remoteErrorOf(error) ?? new RemoteError('plugin-preview/read-failed', error instanceof Error ? error.message : String(error), {}),
        }
      }
    },
  }
}
