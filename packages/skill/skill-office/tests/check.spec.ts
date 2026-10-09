/** Checker process arguments, exit status, cancellation, and signal-handler ownership. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveWorkspaceDependencies } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { runOfficeCheck } from '../src/check.ts'

vi.mock('node:child_process', { spy: true })

vi.mock('@deepseek-ai/dsh-tool-workspace-dependencies', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-tool-workspace-dependencies')>(),
  resolveWorkspaceDependencies: vi.fn(),
}))

let root: string
let originalExitCode: typeof process.exitCode
let originalInterrupt: NodeJS.SignalsListener[]
let originalTerminate: NodeJS.SignalsListener[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-office-check-'))
  originalExitCode = process.exitCode
  originalInterrupt = process.listeners('SIGINT')
  originalTerminate = process.listeners('SIGTERM')
  vi.mocked(resolveWorkspaceDependencies).mockResolvedValue({ python: process.execPath, pythonPackages: root, pythonDistributions: {} })
})

afterEach(async () => {
  try {
    expect(process.listeners('SIGINT')).toEqual(originalInterrupt)
    expect(process.listeners('SIGTERM')).toEqual(originalTerminate)
  } finally {
    process.exitCode = originalExitCode
    vi.resetAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

function config(): string {
  return Buffer.from(JSON.stringify({ source: root })).toString('base64url')
}

function interruptOwnedCheck(): void {
  const listener = process.listeners('SIGINT').find(listener => !originalInterrupt.includes(listener))
  if (listener === undefined) throw new Error('Checker did not register its signal handler')
  Reflect.apply(listener, process, [])
}

it.each([
  { args: [] }, { args: ['relative-checker', 'e30'] }, { args: [join(tmpdir(), 'checker.py')] },
])('rejects missing launcher resources: $args', async ({ args }) => {
  await expect(runOfficeCheck(args)).rejects.toThrow('missing launcher resources')
  expect(resolveWorkspaceDependencies).not.toHaveBeenCalled()
})

it.each(['not JSON', JSON.stringify({ source: 3 })])('rejects invalid runtime configuration before preparation: %s', async (serialized) => {
  await expect(runOfficeCheck([join(root, 'checker.py'), Buffer.from(serialized).toString('base64url')])).rejects.toThrow()
  expect(resolveWorkspaceDependencies).not.toHaveBeenCalled()
})

it('forwards checker arguments and preserves the completed process exit status', async () => {
  const checker = join(root, 'checker.mjs'), output = join(root, 'arguments.json')
  await writeFile(checker, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); process.exitCode = 7;\n")
  await runOfficeCheck([checker, config(), output, 'space and 中文', "apostrophe'value"])
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(['space and 中文', "apostrophe'value"])
  expect(process.exitCode).toBe(7)
  expect(resolveWorkspaceDependencies).toHaveBeenCalledWith({ source: root }, expect.any(AbortSignal))
})

it('propagates runtime preparation failures without leaving signal handlers', async () => {
  vi.mocked(resolveWorkspaceDependencies).mockRejectedValue(new Error('payload unavailable'))
  await expect(runOfficeCheck([join(root, 'checker.py'), config()])).rejects.toThrow('payload unavailable')
})

it('propagates process-start errors after the child closes', async () => {
  vi.mocked(resolveWorkspaceDependencies).mockResolvedValue({ python: join(root, 'missing-python'), pythonPackages: root, pythonDistributions: {} })
  await expect(runOfficeCheck([join(root, 'checker.py'), config()])).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a signal-terminated checker as unsuccessful', async () => {
  const checker = join(root, 'checker.mjs')
  await writeFile(checker, 'setInterval(() => {}, 1000);\n')
  const { spawn: spawnProcess } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const spawned = Promise.withResolvers<ChildProcess>()
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = spawnProcess(process.execPath, [checker], { stdio: 'inherit' })
    child.once('spawn', () => { spawned.resolve(child) })
    return child
  })
  const pending = runOfficeCheck([checker, config()])
  const child = await spawned.promise
  try {
    expect(child.kill('SIGTERM')).toBe(true)
    await pending
    expect(child.signalCode).toBe('SIGTERM')
    expect(process.exitCode).toBe(1)
  } finally {
    child.kill('SIGKILL')
    await pending.catch(() => undefined)
  }
})

it('cancels pending preparation before starting a checker', async () => {
  const prepared = Promise.withResolvers<Awaited<ReturnType<typeof resolveWorkspaceDependencies>>>()
  vi.mocked(resolveWorkspaceDependencies).mockReturnValue(prepared.promise)
  const pending = runOfficeCheck([join(root, 'checker.mjs'), config()])
  interruptOwnedCheck()
  prepared.resolve({ python: process.execPath, pythonPackages: root, pythonDistributions: {} })
  await expect(pending).rejects.toThrow('Office check cancelled')
})

it('waits for the cancelled checker to exit before releasing its signal handlers', async () => {
  const checker = join(root, 'checker.mjs'), ready = join(root, 'ready')
  await writeFile(checker, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n")
  const pending = runOfficeCheck([checker, config(), ready])
  try {
    await vi.waitFor(async () => { expect(await readFile(ready, 'utf8')).toMatch(/^\d+$/u) }, { timeout: 10_000 })
    interruptOwnedCheck()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const pid = Number(await readFile(ready, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    const listener = process.listeners('SIGINT').find(listener => !originalInterrupt.includes(listener))
    if (listener !== undefined) Reflect.apply(listener, process, [])
    await pending.catch(() => undefined)
  }
})
