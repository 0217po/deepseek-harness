import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { expect, it, onTestFinished, vi } from 'vitest'
import SandboxPolicy from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  const fiber = await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  const session = ctx.sessions.create(SessionId('mode-change'))
  return { ctx, fiber, session, policy: ctx.sandboxPolicy }
}

it('waits for both resources and complete operations before recording a new mode', async () => {
  const { session, policy } = await setup()
  const resourceEntered = Promise.withResolvers<undefined>()
  const resourceDone = Promise.withResolvers<undefined>()
  const operationDone = Promise.withResolvers<undefined>()
  const observed = Promise.withResolvers<AbortSignal>()
  const unregister = policy.registerResource(session.id, {
    release: async () => { resourceEntered.resolve(undefined); await resourceDone.promise }, notice: 'variables cleared',
  })
  const operation = policy.withExecution(session.id, new AbortController().signal, async (signal) => {
    observed.resolve(signal)
    await operationDone.promise
    return 7
  })
  const signal = await observed.promise
  const switching = policy.setMode(session, 'read-only')
  try {
    await resourceEntered.promise
    expect(signal.aborted).toBe(true)
    resourceDone.resolve(undefined)
    await expect(policy.withExecution(session.id, new AbortController().signal, async () => 0)).rejects.toThrow('still in progress')
    expect(() => policy.registerResource(session.id, { release: async () => {} })).toThrow('still in progress')
    await expect(policy.setMode(session, 'danger-full-access')).rejects.toThrow('still in progress')
    expect(session.snapshotEvents()).toEqual([])
    operationDone.resolve(undefined)
    expect(await operation).toBe(7)
    expect(await switching).toEqual(['variables cleared'])
    expect(policy.resolve({ session }).mode).toBe('read-only')
  } finally {
    resourceDone.resolve(undefined)
    operationDone.resolve(undefined)
    await Promise.allSettled([switching, operation])
    unregister()
  }
})

it('waits for sibling cleanup after a failure and preserves the old policy', async () => {
  const { session, policy } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const done = Promise.withResolvers<undefined>()
  const first = policy.registerResource(session.id, { release: () => Promise.reject(new Error('cleanup failed')) })
  const second = policy.registerResource(session.id, { release: async () => { entered.resolve(undefined); await done.promise } })
  const switching = policy.setMode(session, 'read-only')
  const rejected = expect(switching).rejects.toThrow('cleanup failed')
  try {
    await entered.promise
    await expect(policy.withExecution(session.id, new AbortController().signal, async () => 0)).rejects.toThrow('still in progress')
    done.resolve(undefined)
    await rejected
    expect(session.snapshotEvents()).toEqual([])
    expect(policy.resolve({ session }).mode).toBe('workspace-write')
  } finally { done.resolve(undefined); await Promise.allSettled([switching]); first(); second() }
})

it('keeps unchanged modes and other Sessions independent and deduplicates notices', async () => {
  const { ctx, session, policy } = await setup()
  const release = vi.fn(async () => {})
  const first = policy.registerResource(session.id, { release, notice: 'variables cleared' })
  const second = policy.registerResource(session.id, { release, notice: 'variables cleared' })
  const third = policy.registerResource(session.id, { release })
  try {
    expect(await policy.setMode(session, 'workspace-write')).toEqual([])
    const other = ctx.sessions.create(SessionId('other-mode-change'))
    expect(await policy.setMode(other, 'read-only')).toEqual([])
    expect(release).not.toHaveBeenCalled()
    expect(await policy.setMode(session, 'read-only')).toEqual(['variables cleared'])
    expect(release).toHaveBeenCalledTimes(3)
  } finally { first(); second(); third() }
})

it('rejects direct mode appends while execution or resources are registered', async () => {
  const { session, policy } = await setup()
  await policy.withExecution(session.id, new AbortController().signal, async () => {
    expect(() => { session.append('sandbox/mode', { mode: 'read-only' }) }).toThrow('await sandboxPolicy.setMode()')
    session.append('sandbox/mode', { mode: 'workspace-write' })
    session.append('turn/start', { turn: 1 })
    await expect(policy.setMode(session, 'read-only')).rejects.toThrow('operation that the change must cancel')
    expect(await policy.setMode(session, 'workspace-write')).toEqual([])
  })
  const unregister = policy.registerResource(session.id, { release: async () => {} })
  expect(() => { session.append('sandbox/mode', { mode: 'read-only' }) }).toThrow('await sandboxPolicy.setMode()')
  unregister()
  session.append('sandbox/mode', { mode: 'read-only' })
  expect(policy.resolve({ session }).mode).toBe('read-only')
})

it('releases a contributor resource before detaching its registration', async () => {
  const { ctx, session, policy } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const done = Promise.withResolvers<undefined>()
  const contributor = await ctx.plugin((child) => {
    child.sandboxPolicy.registerResource(session.id, { release: async () => { entered.resolve(undefined); await done.promise } })
  })
  const disposing = contributor.dispose()
  try {
    await entered.promise
    expect(() => { session.append('sandbox/mode', { mode: 'read-only' }) }).toThrow('await sandboxPolicy.setMode()')
    done.resolve(undefined)
    await disposing
    expect(await policy.setMode(session, 'read-only')).toEqual([])
  } finally { done.resolve(undefined); await disposing }
})

it('cancels operations on provider unload and rejects new calls through the old service', async () => {
  const { ctx, session, policy, fiber } = await setup()
  const entered = Promise.withResolvers<AbortSignal>()
  const done = Promise.withResolvers<undefined>()
  const operation = policy.withExecution(session.id, new AbortController().signal, async (signal) => {
    entered.resolve(signal)
    await done.promise
  })
  const signal = await entered.promise
  try {
    await fiber.dispose()
    expect(ctx.get('sandboxPolicy')).toBeUndefined()
    expect(signal.aborted).toBe(true)
    await expect(policy.withExecution(session.id, signal, async () => 0)).rejects.toThrow('disposed')
    await expect(policy.setMode(session, 'read-only')).rejects.toThrow('disposed')
    session.append('sandbox/mode', { mode: 'read-only' })
  } finally { done.resolve(undefined); await operation }
})

it('refuses a mode commit after disposal during cleanup', async () => {
  const { session, policy, fiber } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const disposalEntered = Promise.withResolvers<undefined>()
  const done = Promise.withResolvers<undefined>()
  let calls = 0
  const unregister = policy.registerResource(session.id, { release: async () => {
    if (++calls === 1) entered.resolve(undefined)
    else disposalEntered.resolve(undefined)
    await done.promise
  } })
  const switching = policy.setMode(session, 'read-only')
  const rejected = expect(switching).rejects.toThrow('disposed during the mode change')
  await entered.promise
  const disposing = fiber.dispose()
  try {
    await disposalEntered.promise
    done.resolve(undefined)
    await rejected
    await disposing
    expect(session.snapshotEvents()).toEqual([])
  } finally { done.resolve(undefined); await Promise.allSettled([switching, disposing]); unregister() }
})

it('revalidates caller state after cleanup before committing related events', async () => {
  const { session, policy } = await setup()
  let available = true
  const unregister = policy.registerResource(session.id, { release: async () => { available = false } })
  try {
    await expect(policy.setMode(session, 'read-only', (writeMode) => {
      if (!available) throw new Error('selection is no longer available')
      writeMode()
    })).rejects.toThrow('selection is no longer available')
    expect(session.snapshotEvents()).toEqual([])
  } finally { unregister() }
})
