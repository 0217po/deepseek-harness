import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import type { PtcBindingFunction, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import PersistentRuntime, { type Config } from '../src/persistent.ts'

async function setup(config: Config = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-persistent-ptc-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }) })
  await ctx.plugin(FileSystem)
  await ctx.plugin(Subprocess)
  const fiber = await ctx.plugin(PersistentRuntime, config)
  const runtime = ctx.ptcRuntime
  const owner = {}
  const run = (program: string, options: Partial<PtcRunRequest> = {}) =>
    runtime.run(runtime.resolve({ program, bindings: [], cwd, stateOwner: owner, ...options }))
  return { ctx, fiber, runtime, owner, run, cwd }
}

function bindings(value: PtcBindingFunction) {
  return [{ global: 'tools', functions: { value }, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]
}

describe('persistent Node REPL', () => {
  it('retains declarations, closures, object identity, and imports across evaluations', async () => {
    const { run, cwd } = await setup()
    expect(await run('const box: { count: number } = { count: 1 }; let alias = box; function increment() { return ++box.count }; const path = await import("node:path");')).toEqual({ logs: [] })
    expect(await run('console.log("second call"); ({ count: increment(), same: box === alias, dir: path.basename(process.cwd()), env: Object.keys(process.env) })')).toEqual({ logs: ['second call'], value: { count: 2, same: true, dir: cwd.split(/[\\/]/).at(-1), env: [] } })
  })

  it('uses current host bindings through retained functions and saved method references', async () => {
    const { run } = await setup()
    const first = vi.fn(async () => 'old')
    const second = vi.fn(async () => 'new')
    expect((await run('const saved = tools.value; async function query() { return await saved({}) }; await query()', { bindings: bindings(first) })).value).toBe('old')
    expect((await run('await query()', { bindings: bindings(second) })).value).toBe('new')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect((await run('let failure; try { await query() } catch (error) { console.log(error.toolName); failure = "unavailable" }; failure')).value).toBe('unavailable')
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('isolates owners and uses fresh state when no owner is supplied', async () => {
    const { run } = await setup()
    expect((await run('let privateValue = 7;')).error).toBeUndefined()
    expect((await run('typeof privateValue', { stateOwner: {} })).value).toBe('undefined')
    expect((await run('let temporary = 8;', { stateOwner: undefined })).error).toBeUndefined()
    expect((await run('typeof temporary', { stateOwner: undefined })).value).toBe('undefined')
    expect((await run('privateValue')).value).toBe(7)
  })

  it('releases an owner and reports missing variables until the caller recreates them', async () => {
    const { run, runtime, owner } = await setup()
    await run('let app = { ready: true };')
    await runtime.release(owner)
    const missing = await run('app.ready')
    expect(missing.error?.kind).toBe('exception')
    expect(missing.error?.message).toContain('app is not defined')
    expect((await run('let app = { ready: true }; app.ready')).value).toBe(true)
    await runtime.release(owner)
    await runtime.release(owner)
  })

  it('keeps mutations before an exception and recovers after syntax and output errors', async () => {
    const { run } = await setup()
    await run('let count = 0;')
    expect((await run('count++; throw new Error("expected failure")')).error?.message).toContain('expected failure')
    expect((await run('count')).value).toBe(1)
    expect((await run('const =')).error?.kind).toBe('exception')
    expect((await run('() => count')).error?.kind).toBe('invalid-output')
    expect((await run('count')).value).toBe(1)
  })

  it('cancels active execution, awaits process exit, and clears all variables', async () => {
    const { run } = await setup()
    const entered = Promise.withResolvers<true>()
    const controller = new AbortController()
    const pending = run('let app = {}; await tools.value({}); while (true) {}', {
      signal: controller.signal,
      bindings: bindings(async () => { entered.resolve(true); return null }),
    })
    await entered.promise
    controller.abort()
    expect((await pending).error?.kind).toBe('abort')
    expect((await run('typeof app')).value).toBe('undefined')
  })

  it('resets a timed-out environment and does not reuse an exited process', async () => {
    const { run } = await setup()
    await run('let retained = 1;')
    expect((await run('while (true) {}', { timeoutMs: 50 })).error?.kind).toBe('timeout')
    expect((await run('typeof retained')).value).toBe('undefined')
    expect((await run('process.exit(7)')).error?.kind).toBe('worker-exit')
    expect((await run('40 + 2')).value).toBe(42)
  })

  it('rejects overlapping runs for one owner and permits other owners', async () => {
    const { run } = await setup()
    const entered = Promise.withResolvers<true>()
    const proceed = Promise.withResolvers<null>()
    const pending = run('await tools.value({})', { bindings: bindings(async () => { entered.resolve(true); return await proceed.promise }) })
    try {
      await entered.promise
      await expect(run('1')).rejects.toThrow('concurrent runs')
      expect((await run('2', { stateOwner: {} })).value).toBe(2)
    } finally { proceed.resolve(null) }
    expect((await pending).value).toBeNull()
  })

  it('disposes in-flight execution and removes the service on plugin unload', async () => {
    const { run, fiber, ctx, runtime } = await setup()
    const entered = Promise.withResolvers<true>()
    const pending = run('await tools.value({}); await new Promise(() => {})', { bindings: bindings(async () => { entered.resolve(true); return null }) })
    await entered.promise
    await fiber.dispose()
    expect((await pending).error?.kind).toBe('abort')
    expect(ctx.get('ptcRuntime')).toBeUndefined()
    expect(() => runtime.resolve({ program: '1', bindings: [] })).toThrow('after disposal')
    await expect(runtime.run({ program: '1', bindings: [], cwd: process.cwd(), timeoutMs: null })).rejects.toThrow('after disposal')
  })

  it('rejects confinement requests and validates options before starting a process', async () => {
    const { run, runtime } = await setup()
    expect(runtime.sandboxMode).toBeUndefined()
    expect(runtime.programFormat).toBe('repl')
    expect(runtime.timeout).toEqual({ defaultMs: 120_000, maxMs: 600_000 })
    expect(() => runtime.resolve({ program: '1', bindings: [], sandboxPolicy: { mode: 'read-only', workspaceRoot: process.cwd() } })).toThrow('sandbox policies')
    expect(() => runtime.resolve({ program: '1', bindings: [], cwd: 'relative' })).toThrow('absolute')
    expect(() => runtime.resolve({ program: '1', bindings: [], timeoutMs: 0 })).toThrow()
    await expect(run('1', { bindings: [{ global: 'console', functions: {} }] })).rejects.toThrow('reserved')
    expect((await run('1', { signal: AbortSignal.abort() })).error?.kind).toBe('abort')
    expect((await run('42', { timeoutMs: null })).value).toBe(42)
  })

  it('bounds output and clears state after an overflow', async () => {
    const { run } = await setup({ maxOutputBytes: 100 })
    expect((await run('let retained = true; console.log("x".repeat(1000))')).error?.kind).toBe('output-limit')
    expect((await run('typeof retained')).value).toBe('undefined')
  })
})
