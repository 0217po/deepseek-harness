/** Controlled process streams exercise the platform-independent native protocol client. */
import { PassThrough, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { NativeClient, NativeError } from '../src/native-client.ts'

const Request = z.object({ id: z.string(), method: z.string(), params: z.record(z.string(), z.json()) })

function fixture(options: {
  maxRequestBytes?: number
  maxResponseBytes?: number
  timeoutMs?: number
  stdin?: boolean
  stdout?: boolean
  writeError?: Error
} = {}) {
  const requests: z.infer<typeof Request>[] = []
  const stdout = new PassThrough()
  const done = Promise.withResolvers<SubprocessOutcome>()
  const gone = Promise.withResolvers<boolean>()
  const stdin = new Writable({ write(chunk, _encoding, callback) {
    requests.push(Request.parse(JSON.parse(String(chunk))))
    callback(options.writeError)
  } })
  const terminated: PromiseWithResolvers<void> = Promise.withResolvers()
  const terminate = vi.fn(() => { terminated.resolve() })
  const waitForExit = vi.fn(() => gone.promise)
  const handle: SubprocessHandle = {
    stdin: options.stdin === false ? undefined : stdin,
    stdout: options.stdout === false ? undefined : stdout,
    stderr: undefined, control: undefined, collected: {},
    done: done.promise, terminate, waitForExit,
  }
  const spawn = vi.fn(() => handle)
  const client = new NativeClient({ subprocess: { spawn } }, {
    helperPath: '/fixture/helper', cwd: '/fixture', timeoutMs: options.timeoutMs ?? 60_000,
    maxRequestBytes: options.maxRequestBytes ?? 1024,
    maxResponseBytes: options.maxResponseBytes ?? 1024, graceMs: 10,
  })
  function finish() { done.resolve({ exitCode: 0, signal: null }); gone.resolve(true) }
  function reply(value: unknown) { stdout.write(Buffer.from(JSON.stringify(value) + '\n')) }
  function id(index = requests.length - 1) {
    const request = requests[index]
    if (!request) throw new Error('No native request was dispatched')
    return request.id
  }
  onTestFinished(async () => {
    finish()
    await client.dispose().catch(() => undefined)
    stdout.destroy()
    stdin.destroy()
  })
  return { client, requests, stdout, stdin, spawn, terminate, terminated: terminated.promise, waitForExit, done, gone, finish, reply, id }
}

describe('native helper transport', () => {
  it('accepts split UTF-8 replies and preserves native refusal codes without replacing the helper', async () => {
    const f = fixture()
    const first = f.client.request('listApps', {}, new AbortController().signal)
    const bytes = Buffer.from(JSON.stringify({ id: f.id(), result: [{ name: '编辑器' }] }) + '\n')
    for (const byte of bytes) f.stdout.write(Buffer.from([byte]))
    expect(await first).toEqual([{ name: '编辑器' }])
    const second = f.client.request('click', { appHandle: 'app-one' }, new AbortController().signal)
    const rejected = expect(second).rejects.toMatchObject({ name: 'NativeError', code: 'STALE_SNAPSHOT', message: 'STALE_SNAPSHOT: Refresh observation' })
    f.reply({ id: f.id(), error: { code: 'STALE_SNAPSHOT', message: 'Refresh observation' } })
    await rejected
    expect(f.client.disposed).toBe(false)
    expect(f.terminate).not.toHaveBeenCalled()
    const third = f.client.request('getCapabilities', {}, new AbortController().signal)
    f.reply({ id: f.id(), result: null })
    expect(await third).toBeNull()
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  it.each(['malformed', 'wrong-id', 'both', 'neither', 'empty-code', 'extra-field', 'invalid-utf8', 'extra-frame'] as const)('invalidates the helper on a %s response before releasing the caller', async (kind) => {
    const f = fixture()
    const pending = f.client.request('listApps', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_PROTOCOL' })
    if (kind === 'malformed') f.stdout.write('{broken}\n')
    else if (kind === 'wrong-id') f.reply({ id: 'not-active', result: [] })
    else if (kind === 'both') f.reply({ id: f.id(), result: [], error: { code: 'failure', message: 'bad' } })
    else if (kind === 'neither') f.reply({ id: f.id() })
    else if (kind === 'empty-code') f.reply({ id: f.id(), error: { code: '', message: 'bad' } })
    else if (kind === 'extra-field') f.reply({ id: f.id(), result: [], extra: true })
    else if (kind === 'invalid-utf8') f.stdout.write(Buffer.concat([Buffer.from(`{"id":"${f.id()}","result":"`), Buffer.from([0xff]), Buffer.from('"}\n')]))
    else f.stdout.write(JSON.stringify({ id: f.id(), result: [] }) + '\n{}\n')
    expect(f.client.disposed).toBe(true)
    expect(f.terminate).toHaveBeenCalledTimes(1)
    f.finish()
    await rejected
    await expect(f.client.request('listApps', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_CLOSED' })
    expect(f.requests).toHaveLength(1)
  })

  it('counts UTF-8 bytes and the newline against the response limit', async () => {
    const f = fixture({ maxResponseBytes: 128 })
    const first = f.client.request('listApps', {}, new AbortController().signal)
    const base = JSON.stringify({ id: f.id(), result: '' }) + '\n'
    const value = 'x'.repeat(128 - Buffer.byteLength(base))
    f.reply({ id: f.id(), result: value })
    expect(await first).toBe(value)
    const second = f.client.request('listApps', {}, new AbortController().signal)
    const rejected = expect(second).rejects.toMatchObject({ code: 'NATIVE_RESPONSE_LIMIT' })
    const bytes = Buffer.from(JSON.stringify({ id: f.id(), result: value.slice(1) + 'é' }) + '\n')
    expect(bytes).toHaveLength(129)
    f.stdout.write(bytes.subarray(0, 90))
    f.stdout.write(bytes.subarray(90))
    f.finish()
    await rejected
  })

  it('bounds request bytes before dispatch and keeps acquired handles after a rejected request', async () => {
    const f = fixture({ maxRequestBytes: 128 })
    const envelope = JSON.stringify({ id: '0'.repeat(36), method: 'typeText', params: { text: '' } }) + '\n'
    const text = 'x'.repeat(128 - Buffer.byteLength(envelope))
    const first = f.client.request('typeText', { text }, new AbortController().signal)
    f.reply({ id: f.id(), result: { dispatched: true } })
    await expect(first).resolves.toEqual({ dispatched: true })
    await expect(f.client.request('typeText', { text: text.slice(1) + 'é' }, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_REQUEST_LIMIT' })
    expect(f.requests).toHaveLength(1)
    expect(f.client.disposed).toBe(false)
    expect(f.terminate).not.toHaveBeenCalled()
    const next = f.client.request('listApps', {}, new AbortController().signal)
    f.reply({ id: f.id(), result: [] })
    await expect(next).resolves.toEqual([])
  })

  it('rejects an oversized unterminated response before retaining another chunk', async () => {
    const f = fixture({ maxResponseBytes: 64 })
    const pending = f.client.request('listApps', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_RESPONSE_LIMIT' })
    f.stdout.write('x'.repeat(65))
    f.stdout.write('late output')
    f.finish()
    await rejected
    expect(f.terminate).toHaveBeenCalledTimes(1)
  })

  it('cancellation waits for the complete managed process range', async () => {
    const f = fixture()
    const abort = new AbortController()
    const pending = f.client.request('getState', {}, abort.signal)
    let settled = false
    const observed = pending.then(() => { settled = true }, (error: unknown) => { settled = true; expect(error).toMatchObject({ code: 'NATIVE_CANCELLED' }) })
    abort.abort()
    f.done.resolve({ exitCode: 0, signal: null })
    await Promise.resolve()
    await Promise.resolve()
    expect(f.terminate).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
    f.gone.resolve(true)
    await observed
    expect(f.stdout.destroyed).toBe(true)
    expect(f.stdin.destroyed).toBe(true)
  })

  it('rejects a pre-cancelled operation without writing or invalidating acquired handles', async () => {
    const f = fixture()
    await expect(f.client.request('click', {}, AbortSignal.abort())).rejects.toMatchObject({ code: 'NATIVE_CANCELLED' })
    expect(f.requests).toEqual([])
    expect(f.client.disposed).toBe(false)
  })

  it('refuses overlapping operations without corrupting the active request', async () => {
    const f = fixture()
    const first = f.client.request('getState', {}, new AbortController().signal)
    await expect(f.client.request('click', {}, new AbortController().signal)).rejects.toMatchObject({ code: 'NATIVE_BUSY' })
    expect(f.requests).toHaveLength(1)
    f.reply({ id: f.id(), result: { snapshotId: 'one' } })
    expect(await first).toEqual({ snapshotId: 'one' })
  })

  it('cancellation after a reply but before result delivery still invalidates the helper', async () => {
    const f = fixture()
    const abort = new AbortController()
    const pending = f.client.request('click', {}, abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_CANCELLED' })
    f.reply({ id: f.id(), result: { dispatched: true } })
    abort.abort()
    f.finish()
    await rejected
  })

  it('expires the configured operation deadline and waits for shutdown', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture({ timeoutMs: 25 })
      const pending = f.client.request('getState', {}, new AbortController().signal)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(25)
      expect(f.client.disposed).toBe(true)
      f.finish()
      await rejected
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each(['stdout-error', 'stdin-error', 'stdout-end', 'stdout-close', 'process-exit', 'process-rejection'] as const)('contains %s while an operation is pending', async (kind) => {
    const f = fixture()
    const pending = f.client.request('getState', {}, new AbortController().signal)
    const code = kind.endsWith('-error') ? 'NATIVE_IO' : kind.startsWith('stdout-') ? 'NATIVE_EOF' : 'NATIVE_EXITED'
    const rejected = expect(pending).rejects.toMatchObject({ code })
    if (kind === 'stdout-error') f.stdout.emit('error', new Error('read failed'))
    else if (kind === 'stdin-error') f.stdin.emit('error', new Error('write failed'))
    else if (kind === 'stdout-end') f.stdout.emit('end')
    else if (kind === 'stdout-close') f.stdout.emit('close')
    else if (kind === 'process-exit') f.done.resolve({ exitCode: 1, signal: null })
    else f.done.reject(new Error('spawn failed'))
    f.gone.resolve(true)
    if (!kind.startsWith('process-')) f.done.resolve({ exitCode: 1, signal: null })
    await rejected
    expect(f.terminate).toHaveBeenCalledTimes(1)
  })

  it.each(['throw', 'callback'] as const)('invalidates uncertain dispatch after a write %s failure', async (kind) => {
    const failure = new Error('pipe failed')
    const f = fixture(kind === 'callback' ? { writeError: failure } : {})
    if (kind === 'throw') vi.spyOn(f.stdin, 'write').mockImplementation(() => { throw failure })
    const pending = f.client.request('click', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_IO', cause: failure })
    await f.terminated
    f.finish()
    await rejected
    expect(f.client.disposed).toBe(true)
    expect(f.terminate).toHaveBeenCalledTimes(1)
  })

  it.each([{ stdin: false }, { stdout: false }, { stdin: false, stdout: false }])('cleans up an incomplete process handle %j', async (options) => {
    const f = fixture(options)
    const pending = f.client.request('listApps', {}, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NATIVE_IO' })
    f.finish()
    await rejected
    expect(f.requests).toEqual([])
  })

  it('rejects unsolicited replies and shares one quiescent disposal across callers', async () => {
    const f = fixture()
    f.reply({ id: 'unsolicited', result: [] })
    const first = f.client.dispose()
    const second = f.client.dispose()
    expect(second).toBe(first)
    expect(f.waitForExit).toHaveBeenCalledTimes(1)
    f.finish()
    await first
    expect(() => {
      f.stdout.emit('error', new Error('late read error'))
      f.stdin.emit('error', new Error('late write error'))
    }).not.toThrow()
    expect(f.terminate).toHaveBeenCalledTimes(1)
  })

  it('rejects pending work on disposal and releases streams even when range observation fails', async () => {
    const f = fixture()
    const pending = f.client.request('getState', {}, new AbortController().signal)
    const failure = new Error('cannot observe range')
    const rejected = expect(pending).rejects.toBe(failure)
    const disposing = f.client.dispose()
    const disposalRejected = expect(disposing).rejects.toBe(failure)
    f.gone.reject(failure)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.stdout.destroyed).toBe(false)
    f.done.resolve({ exitCode: 0, signal: null })
    await disposalRejected
    await rejected
    expect(f.stdout.destroyed).toBe(true)
    expect(f.stdin.destroyed).toBe(true)
  })

  it('keeps native codes available to callers and in the model-visible diagnostic', () => {
    const error = new NativeError('PERMISSION_DENIED', 'Enable Accessibility')
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(error.message).toBe('PERMISSION_DENIED: Enable Accessibility')
  })
})
