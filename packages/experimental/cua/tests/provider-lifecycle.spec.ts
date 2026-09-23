/** Native helper replacement is synchronized with Agent and provider disposal. */
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subprocess from '@deepseek-ai/dsh-subprocess'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as NativeProvider from '../src/index.ts'

const native = vi.hoisted(() => ({
  request: vi.fn(), dispose: vi.fn(), instances: [] as Array<{ disposed: boolean }>,
}))
vi.mock('../src/native-client.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/native-client.ts')>(),
  NativeClient: class {
    disposed = false
    constructor() { native.instances.push(this) }
    request = native.request
    async dispose() { this.disposed = true; await native.dispose() }
  },
}))

const config = {
  helperPath: resolve('fixture-helper'), timeoutMs: 10_000, maxRequestBytes: 1024, maxResponseBytes: 4096,
  graceMs: 10, maxElements: 64, maxDepth: 8, dragDurationMs: 200, dragSteps: 10,
} satisfies NativeProvider.Config

async function setup() {
  native.request.mockReset().mockResolvedValue([])
  native.dispose.mockReset()
  native.instances.length = 0
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ComputerUseRegistry)
  await ctx.plugin(Subprocess, [])
  const provider = await ctx.plugin(NativeProvider, config)
  await mountAgentLoopTestHarness(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId('native-lifecycle') })
  let index = 0
  const execute = (method = 'listApps', params: Record<string, unknown> = {}, signal = new AbortController().signal) => ctx.tools.execute({
    agent: handle.agent, signal, callId: ToolCallId(`lifecycle-${++index}`), name: 'cua', arguments: { method, params },
  })
  return { ctx, provider, handle, execute }
}

it('rejects a relative helper path before publishing computer-use operations', () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  expect(() => { NativeProvider.apply(ctx, { ...config, helperPath: 'relative-helper' }) }).toThrow('helperPath must be absolute')
})

it('rejects helper acquisition when Agent disposal begins during replacement cleanup', async () => {
  const f = await setup()
  await f.execute()
  const previous = native.instances[0]
  if (!previous) throw new Error('No helper was acquired')
  previous.disposed = true
  const acquisition: PromiseWithResolvers<void> = Promise.withResolvers()
  const disposal: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  let calls = 0
  native.dispose.mockImplementation(async () => {
    if (++calls === 1) acquisition.resolve()
    else disposal.resolve()
    await release.promise
  })
  onTestFinished(() => { release.resolve() })
  const reacquiring = f.execute()
  await acquisition.promise
  const disposing = f.handle.dispose()
  try {
    await disposal.promise
    release.resolve()
    expect((await reacquiring).isError).toBe(true)
    await disposing
    expect(native.instances).toHaveLength(1)
    expect(native.request).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); await disposing; await reacquiring }
})

it('aborts pending replacement before provider disposal can finish', async () => {
  const f = await setup()
  await f.execute()
  const previous = native.instances[0]
  if (!previous) throw new Error('No helper was acquired')
  previous.disposed = true
  const acquisition: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  native.dispose.mockImplementation(async () => { acquisition.resolve(); await release.promise })
  onTestFinished(() => { release.resolve() })
  const reacquiring = f.execute()
  await acquisition.promise
  let disposed = false
  const disposing = f.provider.dispose().then(() => { disposed = true })
  try {
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve()
    expect((await reacquiring).isError).toBe(true)
    await disposing
    expect(native.instances).toHaveLength(1)
    expect(f.ctx.tools.schemas()).toEqual([])
  } finally { release.resolve(); await disposing; await reacquiring }
})

it('replaces a failed helper before dispatching the next operation', async () => {
  const f = await setup()
  await f.execute()
  const previous = native.instances[0]
  if (!previous) throw new Error('No helper was acquired')
  previous.disposed = true
  expect((await f.execute()).isError).toBe(false)
  expect(native.dispose).toHaveBeenCalledTimes(1)
  expect(native.instances).toHaveLength(2)
})

it('keeps Agent disposal pending until its helper cleanup completes', async () => {
  const f = await setup()
  await f.execute()
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  native.dispose.mockImplementation(async () => { started.resolve(); await release.promise })
  onTestFinished(() => { release.resolve() })
  let disposed = false
  const disposing = f.handle.dispose().then(() => { disposed = true })
  try {
    await started.promise
    // Drain this turn's promise continuations while cleanup remains held by the explicit barrier.
    await setImmediate()
    expect(disposed).toBe(false)
    release.resolve()
    await disposing
    expect(disposed).toBe(true)
  } finally { release.resolve(); await disposing }
})

it('joins helper cleanup already started by Agent disposal when the provider unloads', async () => {
  const f = await setup()
  await f.execute()
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  native.dispose.mockImplementation(async () => { started.resolve(); await release.promise })
  onTestFinished(() => { release.resolve() })
  const agentClosing = f.handle.dispose()
  await started.promise
  let providerClosed = false
  const providerClosing = f.provider.dispose().then(() => { providerClosed = true })
  try {
    await setImmediate()
    expect(providerClosed).toBe(false)
    release.resolve()
    await Promise.all([agentClosing, providerClosing])
    expect(native.dispose).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); await Promise.all([agentClosing, providerClosing]) }
})

it('reports failed cleanup after waiting for other owners and releasing their Agent effects', async () => {
  const f = await setup()
  await f.execute()
  const other = await f.ctx.agents.create({ sessionId: SessionId('native-lifecycle-other') })
  await f.ctx.tools.execute({
    agent: other.agent, signal: new AbortController().signal, callId: ToolCallId('other-owner'),
    name: 'cua', arguments: { method: 'listApps', params: {} },
  })
  const failure = new Error('native range observation failed')
  const started: PromiseWithResolvers<void> = Promise.withResolvers()
  const release: PromiseWithResolvers<void> = Promise.withResolvers()
  native.dispose.mockImplementationOnce(async () => { throw failure })
    .mockImplementationOnce(async () => { started.resolve(); await release.promise })
  onTestFinished(() => { release.resolve() })
  const reported: unknown[] = []
  const errors = vi.spyOn(f.provider.ctx.logger, 'error').mockImplementation((error: unknown) => { reported.push(error) })
  onTestFinished(() => { errors.mockRestore() })
  let closed = false
  const closing = f.provider.dispose().then(() => { closed = true })
  try {
    await started.promise
    await setImmediate()
    expect(closed).toBe(false)
    expect(errors).not.toHaveBeenCalled()
    release.resolve()
    await closing
    expect(native.dispose).toHaveBeenCalledTimes(2)
    const aggregate = reported.find(error => error instanceof AggregateError)
    expect(aggregate?.errors).toContain(failure)
    const errorsBeforeAgentDisposal = errors.mock.calls.length
    await Promise.all([f.handle.dispose(), other.dispose()])
    expect(native.dispose).toHaveBeenCalledTimes(2)
    expect(errors).toHaveBeenCalledTimes(errorsBeforeAgentDisposal)
    expect(f.ctx.tools.schemas()).toEqual([])
  } finally { release.resolve(); await closing }
})

it('rejects malformed and unowned operations before acquiring a helper', async () => {
  const f = await setup()
  expect((await f.execute('screenshot', { pid: 9, windowId: 7 })).isError).toBe(true)
  const unowned = await f.ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('unowned'), name: 'cua', arguments: { method: 'listApps', params: {} },
  })
  expect(unowned.isError).toBe(true)
  expect(native.instances).toEqual([])
  expect(native.request).not.toHaveBeenCalled()
})

it('supplies configured resource bounds and clears registrations on unload', async () => {
  const f = await setup()
  await f.execute('getState', { appHandle: 'app-one' })
  expect(native.request).toHaveBeenLastCalledWith('getState', { appHandle: 'app-one', maxElements: 64, maxDepth: 8 }, expect.any(AbortSignal))
  await f.execute('drag', { appHandle: 'app-one', windowId: 7, fromX: 1, fromY: 2, toX: 3, toY: 4 })
  expect(native.request).toHaveBeenLastCalledWith('drag', expect.objectContaining({ durationMs: 200, steps: 10 }), expect.any(AbortSignal))
  await f.provider.dispose()
  expect(f.ctx.tools.schemas()).toEqual([])
  expect(native.dispose).toHaveBeenCalledTimes(1)
})
