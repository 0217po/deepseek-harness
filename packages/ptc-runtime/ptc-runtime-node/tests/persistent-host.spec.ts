import { Duplex, PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { PtcBindingFunction, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import PersistentRuntime, { type Config } from '../src/persistent.ts'
import { JsonChannel } from '../src/channel.ts'
import { encodePtcJsonWire } from '../src/json-wire.ts'

const request: PtcRunRequest = { program: '1', bindings: [], stateOwner: {} }
const NO_INITIAL_FRAME = Symbol('no initial frame')
async function setup(config: Config = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(FileSystem)
  await ctx.plugin(Subprocess)
  await ctx.plugin(PersistentRuntime, config)
  const runtime = ctx.ptcRuntime
  const control = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (childControl.destroyed) { callback(new Error('peer closed')); return }
      childControl.push(chunk)
      callback()
    },
  })
  const childControl = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (control.destroyed) { callback(new Error('peer closed')); return }
      control.push(chunk)
      callback()
    },
  })
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const direct = Promise.withResolvers<SubprocessOutcome>()
  const messages: unknown[] = []
  const terminate = vi.fn(() => {
    stdout.end()
    stderr.end()
    direct.resolve({ exitCode: 0, signal: null })
  })
  const waitForExit = vi.fn(async () => true)
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout,
    stderr,
    control,
    collected: {},
    done: direct.promise,
    terminate,
    waitForExit,
  }
  const writes = new Set<Promise<void>>()
  let receive: (message: unknown) => void = () => {}
  const peer = new JsonChannel(childControl, 1024 * 1024, (message) => {
    messages.push(message)
    receive(message)
  }, () => {})
  const emit = (message: unknown): void => {
    const write = peer.send(message).catch(() => {}).finally(() => { writes.delete(write) })
    writes.add(write)
  }
  const resolveExecutable = vi.spyOn(ctx.subprocess, 'resolveExecutable').mockResolvedValue(process.execPath)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(handle)
  onTestFinished(async () => {
    peer.close()
    control.destroy()
    stdout.destroy()
    stderr.destroy()
    direct.resolve({ exitCode: 0, signal: null })
    await Promise.all(writes)
  })
  const start = (input: PtcRunRequest = request, first: unknown = { type: 'ready' }) => {
    const result = runtime.run(runtime.resolve(input))
    if (first !== NO_INITIAL_FRAME) queueMicrotask(() => { emit(first) })
    return result
  }
  const onBoot = (callback: () => void): void => {
    receive = (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'run') callback()
    }
  }
  return {
    ctx, runtime, handle, terminate, waitForExit, direct, stdout, stderr, control, peer, messages,
    spawn, resolveExecutable, emit, start, onBoot,
    receive: (callback: typeof receive) => { receive = callback },
  }
}

function frame(payload: unknown, id = 1) { return { id, payload } }
function call(id = 1, args: unknown = encodePtcJsonWire(null)) { return frame({ type: 'call', id, global: 'tools', name: 'test', args }) }
const bound: PtcRunRequest = { ...request, bindings: [{ global: 'tools', functions: { test: async () => 42 } }] }

describe('persistent PTC host protocol', () => {
  it.each([
    null,
    { id: 99, payload: {} },
    frame({ type: 'other' }),
    frame({ type: 'log', text: 1 }),
    frame({ type: 'done', error: { kind: 'other', message: '' } }),
    frame({ type: 'done', error: { kind: 'exception', message: 1 } }),
    call(2),
    call(1, 'not a wire value'),
  ])('rejects invalid process traffic %j', async (raw) => {
    const h = await setup()
    h.onBoot(() => { h.emit(raw) })
    expect((await h.start(bound)).error?.kind).toBe('protocol')
    expect(h.terminate).toHaveBeenCalledTimes(1)
    expect(h.waitForExit).toHaveBeenCalledTimes(1)
  })

  it('requires the readiness handshake and all requested pipes', async () => {
    const h = await setup()
    expect((await h.start(request, { type: 'other' })).error?.kind).toBe('protocol')
    const missing = await setup()
    missing.spawn.mockReturnValue({ ...missing.handle, control: undefined })
    expect((await missing.start(request, NO_INITIAL_FRAME)).error?.message).toContain('did not supply')
  })

  it.each(['exception', 'invalid-output', 'output-limit'])('accepts a terminal %s failure', async (kind) => {
    const h = await setup()
    h.onBoot(() => { h.emit(frame({ type: 'done', error: { kind, message: 'example' } })) })
    expect((await h.start()).error?.kind).toBe(kind)
  })

  it('rejects lossy terminal values and bounds complete results', async () => {
    const h = await setup()
    h.onBoot(() => { h.emit(frame({ type: 'done', value: 'bad' })) })
    expect((await h.start()).error?.kind).toBe('invalid-output')
    const limited = await setup({ maxOutputBytes: 30 })
    limited.onBoot(() => { limited.emit(frame({ type: 'log', text: 'x'.repeat(100) })) })
    expect((await limited.start()).error?.kind).toBe('output-limit')
  })

  it('returns current binding successes, exceptions and unavailable bindings', async () => {
    const cases: Record<string, PtcBindingFunction>[] = [
      { test: async () => 42 }, { test: async () => { throw new Error('denied') } },
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Host bindings may reject with a non-Error value.
      { test: () => Promise.reject('denied') }, {},
    ]
    for (const functions of cases) {
      const h = await setup()
      h.receive((raw) => {
        const message = raw as Record<string, unknown>
        if (message.type === 'run') h.emit(call())
        else if (message.type === 'reply') h.emit(frame({ type: 'done', value: encodePtcJsonWire(message.ok === true) }))
      })
      const result = await h.start({ ...request, bindings: [{ global: 'tools', functions }] })
      expect(result.error).toBeUndefined()
      const reply = h.messages.find(raw => (raw as { type: string }).type === 'reply') as { ok: boolean; message?: string }
      expect(result.value).toBe(reply.ok)
      if (!reply.ok) expect(reply.message).toMatch(/denied|unavailable/)
    }
  })

  it('bounds outstanding binding calls and drops replies after a run ends', async () => {
    const h = await setup({ maxPendingCalls: 1 })
    const pending = Promise.withResolvers<null>()
    h.onBoot(() => { h.emit(call()); h.emit(call(2)) })
    try {
      expect((await h.start({ ...request, bindings: [{ global: 'tools', functions: { test: () => pending.promise } }] })).error?.kind).toBe('protocol')
    } finally { pending.resolve(null) }
    await setImmediate()
    expect(h.messages.some(raw => (raw as { type: string }).type === 'reply')).toBe(false)
  })

  it('cleans up after launch failure and cancellation during executable resolution', async () => {
    const h = await setup()
    h.resolveExecutable.mockRejectedValue('missing executable')
    expect((await h.start(request, NO_INITIAL_FRAME)).error?.message).toContain('missing executable')
    const waiting = await setup()
    const ready = Promise.withResolvers<string>()
    waiting.resolveExecutable.mockImplementation(() => ready.promise)
    const controller = new AbortController()
    const result = waiting.start({ ...request, signal: controller.signal }, NO_INITIAL_FRAME)
    controller.abort()
    ready.resolve(process.execPath)
    expect((await result).error?.kind).toBe('abort')
    expect(waiting.spawn).not.toHaveBeenCalled()
  })

  it('reports raw pipe output, stream errors and process failures without retaining state', async () => {
    for (const action of ['raw', 'stream', 'exit', 'rejection'] as const) {
      const h = await setup()
      h.onBoot(() => {
        if (action === 'raw') h.stdout.write('unattributed')
        else if (action === 'stream') h.stderr.emit('error', new Error('pipe failed'))
        else if (action === 'exit') h.direct.resolve({ exitCode: 7, signal: null })
        else h.direct.reject(new Error('process failed'))
      })
      const result = await h.start()
      expect(result.error?.kind).toBe(action === 'raw' ? 'protocol' : 'worker-exit')
      expect(result.logs).toEqual([])
    }
  })

  it('reports failed managed cleanup and waits for both exit and pipe drain', async () => {
    const h = await setup()
    h.waitForExit.mockRejectedValue(new Error('cleanup failed'))
    h.onBoot(() => { h.emit(frame({ type: 'output-limit' })) })
    expect((await h.start()).error?.message).toContain('cleanup failed')
  })

  it('rejects invalid resolved inputs and deployment bounds', async () => {
    const h = await setup()
    expect(h.runtime.executionInstructions).toContain('Variables, functions, and imported modules remain in memory')
    await expect(h.runtime.run({ ...request, cwd: '.', timeoutMs: null })).rejects.toThrow('resolved inputs')
    await expect(h.runtime.run({ ...request, cwd: process.cwd(), timeoutMs: Infinity })).rejects.toThrow('resolved inputs')
    for (const config of [
      { timeoutMs: 0 }, { maxMessageBytes: 0x1_0000_0000 }, { maxOutputBytes: 3 }, { graceMs: 2_147_483_648 },
      { nodeExecutable: '' }, { bootstrapPath: 'relative' },
    ]) {
      await expect(setup(config)).rejects.toThrow('persistent PTC')
    }
  })
})

it('rejects corrupt framed traffic before it reaches the evaluator', async () => {
  const h = await setup()
  h.onBoot(() => { h.control.emit('data', Buffer.from([0, 0, 0, 1, 255])) })
  expect((await h.start()).error?.kind).toBe('protocol')
})

it('discards unsolicited idle traffic and awaits the retained process exit', async () => {
  const h = await setup()
  h.onBoot(() => { h.emit(frame({ type: 'done' })) })
  expect((await h.start()).error).toBeUndefined()
  h.emit(frame({ type: 'log', text: 'late' }))
  await h.direct.promise
  expect(h.terminate).toHaveBeenCalledTimes(1)
})
