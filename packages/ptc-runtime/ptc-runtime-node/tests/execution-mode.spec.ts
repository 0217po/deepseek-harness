import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import NodeRuntime from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { mountRuntime } from './setup.ts'

it.each<Config['executionMode']>([undefined, 'per-call'])('starts fresh state for each call in mode %s', async (executionMode) => {
  const runtime = await mountRuntime(new Context(), { executionMode })
  const stateOwner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))
  expect(runtime.programFormat).toBe('function-body')
  expect(runtime.sandboxMode).toBe('danger-full-access')
  expect((await run('globalThis.retained = 17; return retained;')).value).toBe(17)
  expect((await run('return typeof retained;')).value).toBe('undefined')
  await runtime.release(stateOwner)
})

it.each(['durable', 'fresh-process', 'persistent-repl'])('rejects unsupported execution mode %s at configuration parsing', (executionMode) => {
  expect(() => NodeRuntime.Config({ executionMode })).toThrow()
})

it('clears retained state when a provider is reloaded with another execution mode', async () => {
  const ctx = new Context()
  const owner = {}
  const memory = await mountRuntime(ctx, { executionMode: 'in-memory' })
  const first = await memory.run(memory.resolve({ program: 'let retained = 17;', bindings: [], stateOwner: owner }))
  expect(first.error).toBeUndefined()
  expect(memory.programFormat).toBe('repl')
  expect(memory.sandboxMode).toBeUndefined()
  await memory.ctx.fiber.dispose()
  const perCall = await mountRuntime(ctx, { executionMode: 'per-call' })
  expect(perCall.programFormat).toBe('function-body')
  expect(perCall.sandboxMode).toBe('danger-full-access')
  expect((await perCall.run(perCall.resolve({ program: 'return typeof retained;', bindings: [], stateOwner: owner }))).value).toBe('undefined')
  await perCall.ctx.fiber.dispose()
  const resumed = await mountRuntime(ctx, { executionMode: 'in-memory' })
  expect((await resumed.run(resumed.resolve({ program: 'typeof retained', bindings: [], stateOwner: owner }))).value).toBe('undefined')
})
