import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import Approval from '@deepseek-ai/dsh-user-approval'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PtcOwners } from '../src/ptc-owners.ts'

class Runtime extends PtcRuntime {
  language = 'typescript'
  isolation = 'test'
  override get retainsState() { return true }
  resolve(request: PtcRunRequest) { return { ...request, cwd: process.cwd(), timeoutMs: null } }
  run() { return Promise.resolve({ logs: [] }) }
}

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  await ctx.plugin(Approval)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  await ctx.plugin(PermissionPresets, { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  await ctx.plugin(Runtime)
  const session = ctx.sessions.create(SessionId('ptc-permission-owner'))
  const agent = { ctx, session } as Agent
  const owners = new PtcOwners()
  const enter = (temporary = false) => owners.enter(agent, ctx.ptcRuntime, new AbortController().signal, temporary,
    () => ctx.sandboxPolicy.resolve({ session }))
  return { ctx, session, agent, enter }
}

it('waits for cleanup before recording a permission change and fences new programs', async () => {
  const { ctx, session, agent, enter } = await setup()
  const call = enter()
  await call.finish()
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const release = vi.spyOn(ctx.ptcRuntime, 'release').mockImplementation(async () => { entered.resolve(undefined); await released.promise })
  const before = session.snapshotEvents()
  const switching = ctx.permissionPresets.set(session, 'read-only')
  try {
    await entered.promise
    expect(release).toHaveBeenCalledWith(agent)
    expect(session.snapshotEvents()).toEqual(before)
    expect(call.signal.aborted).toBe(false)
    expect(() => enter()).toThrow('cleanup is in progress')
    await expect(ctx.permissionPresets.set(session, 'danger-full-access')).rejects.toThrow('still in progress')
    released.resolve(undefined)
    expect(await switching).toEqual(['PTC variables were cleared after the sandbox mode changed. Recreate variables before using them.'])
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
    const next = enter()
    await next.finish()
  } finally { released.resolve(undefined); await switching; release.mockRestore() }
})

it('keeps permission events unchanged when cleanup fails and rejects raw mode writes', async () => {
  const { ctx, session, enter } = await setup()
  await enter().finish()
  const before = session.snapshotEvents()
  expect(() => setSandboxMode(session, 'read-only')).toThrow('release retained PTC')
  const release = vi.spyOn(ctx.ptcRuntime, 'release').mockRejectedValue(new Error('cleanup failed'))
  try {
    await expect(ctx.permissionPresets.set(session, 'read-only')).rejects.toThrow('cleanup failed')
    expect(session.snapshotEvents()).toEqual(before)
  } finally { release.mockRestore() }
})

it('does not reset retained state for the same sandbox mode or another session', async () => {
  const { ctx, session, enter } = await setup()
  await enter().finish()
  const release = vi.spyOn(ctx.ptcRuntime, 'release')
  try {
    expect(await ctx.permissionPresets.set(session, 'workspace-write')).toEqual([])
    const other = ctx.sessions.create(SessionId('ptc-other-owner'))
    await ctx.permissionPresets.set(other, 'read-only')
    expect(release).not.toHaveBeenCalled()
  } finally { release.mockRestore() }
})

it('isolates temporary owners and awaits their release without clearing the standing owner', async () => {
  const { ctx, agent, enter } = await setup()
  const standing = enter()
  await standing.finish()
  const release = vi.spyOn(ctx.ptcRuntime, 'release')
  try {
    const elevated = enter(true)
    expect(standing.owner).toBe(agent)
    expect(elevated.owner).not.toBe(agent)
    await elevated.finish()
    expect(release).toHaveBeenCalledExactlyOnceWith(elevated.owner)
    const next = enter()
    expect(next.owner).toBe(agent)
    await next.finish()
  } finally { release.mockRestore() }
})

it('cancels admitted programs while switching permissions', async () => {
  const { ctx, session, enter } = await setup()
  const call = enter(true)
  await ctx.permissionPresets.set(session, 'read-only')
  expect(call.signal.aborted).toBe(true)
  await call.finish()
})
