/** Built-in artwork requests use a typed resource read and discard results after release. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { previewAddress, previewResourceProvider } from '../src/client/preview-resource.ts'

type Read = Context['remote']['pluginManager']['readBundlePreview']
const name = '@deepseek-ai/dsh-experimental-badge-skill-bundle'

function fixture() {
  const remote = { readBundlePreview: vi.fn<Read>().mockResolvedValue({ ok: true, value: {} }) }
  return { remote, provider: previewResourceProvider(remote), abort: new AbortController() }
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

describe('built-in preview resource', () => {
  it('uses the encoded package segment for one Host read', async () => {
    const { provider, remote, abort } = fixture()
    const frames = await collect(provider.open(previewAddress(name), { signal: abort.signal }))
    expect(frames).toEqual([{ ok: true, value: {} }])
    expect(remote.readBundlePreview).toHaveBeenCalledExactlyOnceWith(name)
  })

  it.each(['not a URL', 'dsh-resource://builtin-plugin-preview/', 'dsh-resource://builtin-plugin-preview/%broken', 'dsh-resource://builtin-plugin-preview/name?version=1'])('rejects malformed or noncanonical address %s without a Host read', async (address) => {
    const { provider, remote, abort } = fixture()
    const frames = await collect(provider.open(address, { signal: abort.signal }))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.ok).toBe(false)
    expect(frames[0] && !frames[0].ok ? frames[0].error.code : undefined).toBe('plugin-preview/invalid-address')
    expect(remote.readBundlePreview).not.toHaveBeenCalled()
  })

  it.each([new Error('offline'), new RemoteError('plugin-preview/read-failed', 'denied', {}), 'unavailable'])('reports a failed Remote read: %j', async (failure) => {
    const { provider, remote, abort } = fixture()
    remote.readBundlePreview.mockRejectedValue(failure)
    const frames = await collect(provider.open(previewAddress(name), { signal: abort.signal }))
    expect(frames).toHaveLength(1)
    expect(frames[0]?.ok).toBe(false)
    expect(frames[0] && !frames[0].ok ? frames[0].error.code : undefined).toBe('plugin-preview/read-failed')
  })

  it('does not read an already closed resource', async () => {
    const { provider, remote, abort } = fixture()
    abort.abort()
    expect(await collect(provider.open(previewAddress(name), { signal: abort.signal }))).toEqual([])
    expect(remote.readBundlePreview).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'])('drops a late %s after resource release', async (outcome) => {
    const { provider, remote, abort } = fixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<Read>>>()
    remote.readBundlePreview.mockReturnValue(pending.promise)
    const frames = collect(provider.open(previewAddress(name), { signal: abort.signal }))
    await vi.waitFor(() => { expect(remote.readBundlePreview).toHaveBeenCalledOnce() })
    abort.abort()
    if (outcome === 'success') pending.resolve({ ok: true, value: {} })
    else pending.reject(new Error('cancelled'))
    expect(await frames).toEqual([])
  })
})
