import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { expect, it, onTestFinished, vi } from 'vitest'
import { mountRuntime } from './setup.ts'

async function setup(mode: 'read-only' | 'workspace-write' = 'read-only') {
  const root = await mkdtemp(join(homedir(), '.dsh-persistent-sandbox-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const { runtime } = await mountRuntime(ctx, { executionMode: 'persistent-in-memory' }, { mode, workspaceRoot: cwd })
  const owner = {}
  const run = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))
  return { root, cwd, ctx, runtime, owner, run }
}

it('retains variables under read-only confinement and denies writes across calls', async () => {
  const { cwd, run } = await setup()
  expect((await run('const fsp = await import("node:fs/promises"); var count = 1;')).error).toBeUndefined()
  expect((await run('++count')).value).toBe(2)
  const result = await run('await fsp.writeFile("denied.txt", String(count))')
  expect(result.sandbox).toMatchObject({ mode: 'read-only', denied: true })
  await expect(readFile(join(cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await run('count')).value).toBe(2)
})

it('retains workspace write access while refusing a sibling path', async () => {
  const { root, cwd, run } = await setup('workspace-write')
  expect((await run('const fsp = await import("node:fs/promises"); await fsp.writeFile("inside.txt", "allowed")')).error).toBeUndefined()
  const result = await run(`await fsp.writeFile(${JSON.stringify(join(root, 'outside.txt'))}, "denied")`)
  expect(result.sandbox).toMatchObject({ mode: 'workspace-write', denied: true })
  expect(await readFile(join(cwd, 'inside.txt'), 'utf8')).toBe('allowed')
  await expect(readFile(join(root, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses reuse under another policy until the owner has been released', async () => {
  const { cwd, runtime, owner, run } = await setup()
  expect((await run('var retained = 42;')).error).toBeUndefined()
  const spec = runtime.resolve({ program: 'typeof retained', bindings: [], stateOwner: owner, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: cwd } })
  await expect(runtime.run(spec)).rejects.toThrow('release the retained environment')
  await runtime.release(owner)
  expect((await runtime.run(spec)).value).toBe('undefined')
})

it('fails closed when confinement is unavailable without spawning Node', async () => {
  const { ctx, run } = await setup()
  const confine = vi.spyOn(ctx.sandbox, 'confine').mockRejectedValue(new SandboxUnavailableError('read-only'))
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  onTestFinished(() => { confine.mockRestore(); spawn.mockRestore() })
  expect((await run('42')).error?.kind).toBe('sandbox-unavailable')
  expect(spawn).not.toHaveBeenCalled()
})

it('cancels a pending confinement operation before spawning', async () => {
  const { ctx, runtime, owner } = await setup()
  const entered = Promise.withResolvers<undefined>()
  const confinement = Promise.withResolvers<Awaited<ReturnType<typeof ctx.sandbox.confine>>>()
  const confine = vi.spyOn(ctx.sandbox, 'confine').mockImplementation(() => { entered.resolve(undefined); return confinement.promise })
  const spawn = vi.spyOn(ctx.subprocess, 'spawn')
  const controller = new AbortController()
  const pending = runtime.run(runtime.resolve({ program: '42', bindings: [], stateOwner: owner, signal: controller.signal }))
  try {
    await entered.promise
    controller.abort()
    confinement.resolve({ argv: ['unused'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    expect((await pending).error?.kind).toBe('abort')
    expect(spawn).not.toHaveBeenCalled()
  } finally {
    confinement.resolve({ argv: ['unused'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    await pending
    confine.mockRestore()
    spawn.mockRestore()
  }
})
