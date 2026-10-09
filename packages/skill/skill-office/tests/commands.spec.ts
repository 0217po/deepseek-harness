/** Shell command discovery, argument preservation, and launcher ownership. */
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, toNamespacedPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { execa } from 'execa'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Commands from '../src/commands.ts'

const contexts: Context[] = []
let root: string
const execution: ToolExecution = {
  signal: new AbortController().signal,
  token: Symbol('office-command') as ToolExecution['token'],
  callId: ToolCallId('office-command'), rootCallId: ToolCallId('office-command'),
  name: 'bash', arguments: { command: 'dsoffice capabilities' },
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-office-commands-'))
  vi.stubEnv('DSH_HOME', root)
  for (const key of ['DSH_PRIMARY_RUNTIME', 'DSH_BUNDLED_PRIMARY_RUNTIME', 'DSH_BUNDLED_OFFICE_CLI', 'DSH_BUNDLED_OFFICE_NODE', 'DSH_BUNDLED_OFFICE_SKILLS']) vi.stubEnv(key, undefined)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function context() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ShellEnv)
  return ctx
}

function directory(ctx: Context): string {
  const path = ctx.shellEnv.collect(execution).PATH
  if (path === undefined) throw new Error('Missing Office command directory')
  return path.split(delimiter)[0]!
}

async function checkerRuntime(ctx: Context): Promise<unknown> {
  const script = await readFile(join(directory(ctx), 'office-check'), 'utf8')
  const serialized = / '([A-Za-z0-9_-]+)' "\$@"\n$/u.exec(script)?.[1]
  if (serialized === undefined) throw new Error('Missing serialized checker runtime')
  return JSON.parse(Buffer.from(serialized, 'base64url').toString('utf8'))
}

it.skipIf(process.platform === 'win32')('executes the installed capabilities command without Node on PATH', async () => {
  vi.stubEnv('PATH', '')
  const ctx = await context()
  await ctx.plugin(Commands)
  const env = ctx.shellEnv.collect(execution)
  const result = await execa('dsoffice', ['capabilities'], { cwd: root, env, extendEnv: false })
  expect(JSON.parse(result.stdout)).toMatchObject({ runtime: {
    cliPath: fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/cli')),
  } })
  expect(process.env.PATH).toBe('')
  expect(await readdir(root)).toEqual(['commands'])
  await expect(readFile(join(directory(ctx), 'office-check'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')('preserves configured and forwarded shell arguments literally', async () => {
  const ctx = await context()
  const fixed = ['', "apostrophe' and space", '$(printf substituted)', '`printf substituted`', '%PATH%', 'double"quote']
  const command = [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...fixed]
  await ctx.plugin(Commands, { command, checkCommand: command })
  for (const name of ['dsoffice', 'office-check']) {
    const result = await execa(join(directory(ctx), name), ['forwarded value', ''], { env: { PATH: '' }, extendEnv: false })
    expect(JSON.parse(result.stdout)).toEqual([...fixed, 'forwarded value', ''])
  }
})

it('owns separate launcher directories under a long home until each contributing context is disposed', async () => {
  const home = join(root, 'a'.repeat(120), 'b'.repeat(120))
  vi.stubEnv('DSH_HOME', home)
  expect(home.length).toBeGreaterThan(260)
  const first = await context(), second = await context()
  const [one, two] = await Promise.all([
    first.plugin(Commands, { command: false, checkCommand: false }),
    second.plugin(Commands, { command: false, checkCommand: false }),
  ])
  const firstDirectory = directory(first), secondDirectory = directory(second)
  expect(firstDirectory).not.toBe(secondDirectory)
  expect(dirname(firstDirectory)).toBe(join(home, 'commands'))
  expect(dirname(secondDirectory)).toBe(join(home, 'commands'))
  await one.dispose()
  await expect(readdir(firstDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(first.shellEnv.collect(execution)).not.toHaveProperty('PATH')
  expect(await readdir(secondDirectory)).toEqual([])
  await two.dispose()
  await expect(readdir(secondDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('defers missing executable failures to invocation and permits each command to be disabled', async () => {
  const ctx = await context()
  await ctx.plugin(Commands, { command: [join(root, 'missing-kit')], checkCommand: false })
  const files = await readdir(directory(ctx))
  expect(files.sort()).toEqual(process.platform === 'win32' ? ['dsoffice', 'dsoffice.ps1'] : ['dsoffice'])
  const disabled = await context()
  await disabled.plugin(Commands, { command: false, checkCommand: [join(root, 'missing-python')] })
  expect(await readdir(directory(disabled))).toContain('office-check')
})

it.each([[], ['relative-command'], [process.execPath, 'line\nbreak'], [process.execPath, 'nul\0byte']].map(command => ({ command })))(
  'rejects an invalid command and removes its partial directory: $command', async ({ command }) => {
    const ctx = await context()
    expect(() => { Commands.apply(ctx, { command: [process.execPath], checkCommand: command }) })
      .toThrow(/absolute executable|NUL or newlines/)
    expect(await readdir(join(root, 'commands'))).toEqual([])
    expect(ctx.shellEnv.collect(execution)).not.toHaveProperty('PATH')
  },
)

it('rejects relative asset roots before publishing commands', async () => {
  const ctx = await context()
  expect(() => { Commands.apply(ctx, { assetRoot: 'relative-assets' }) }).toThrow('assetRoot must be an absolute directory')
  expect(ctx.shellEnv.collect(execution)).not.toHaveProperty('PATH')
  expect(await readdir(root)).toEqual([])
})

it.skipIf(process.platform === 'win32')('runs Kit with the host Node when the selected authoring environment contains only Python', async () => {
  vi.stubEnv('DSH_PRIMARY_RUNTIME', join(root, 'python-only'))
  const ctx = await context()
  await ctx.plugin(Commands)
  const result = await execa('dsoffice', ['capabilities'], {
    cwd: root, env: { ...ctx.shellEnv.collect(execution), PATH: directory(ctx) }, extendEnv: false,
  })
  expect(JSON.parse(result.stdout)).toHaveProperty('runtime.cliPath')
  expect(await readFile(join(directory(ctx), 'office-check'), 'utf8')).toContain(join(root, 'python-only/dependencies/python'))
})

it.each(['win32', 'linux'])('uses bundled interpreters and explicit resources without preparing the payload on %s', async (platformName) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platformName })
  try {
    const bundled = join(root, 'carrier', 'primary-runtime')
    const cli = join(root, 'carrier', 'kit-cli.js'), assets = join(root, 'custom-assets')
    vi.stubEnv('DSH_BUNDLED_PRIMARY_RUNTIME', bundled)
    vi.stubEnv('DSH_BUNDLED_OFFICE_CLI', cli)
    const ctx = await context()
    await ctx.plugin(Commands, { assetRoot: assets })
    const kit = await readFile(join(directory(ctx), 'dsoffice'), 'utf8')
    expect(kit).toContain(cli)
    expect(kit).toContain(join(bundled, 'dependencies/node/bin', platformName === 'win32' ? 'node.exe' : 'node'))
    const checker = await readFile(join(directory(ctx), 'office-check'), 'utf8')
    expect(checker).toContain(join(bundled, 'dependencies/python', platformName === 'win32' ? 'python.exe' : 'bin/python3'))
    expect(checker).toContain(join(assets, 'scripts/check_office.py'))
    await expect(readdir(join(root, 'carrier'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

it('uses explicit runtime configuration with the source checker launcher', async () => {
  vi.stubEnv('DSH_PRIMARY_RUNTIME', join(root, 'primary-runtime'))
  const runtime = { source: join(root, 'custom-runtime'), root: join(root, 'installed') }
  const ctx = await context()
  await ctx.plugin(Commands, { runtime })
  expect(await checkerRuntime(ctx)).toEqual(runtime)
})

it('does not acquire a checker runtime for a carrierless profile', async () => {
  const ctx = await context(), profile = join(root, 'profiles', 'headless')
  ctx.provide('profileContext', {
    name: 'headless', dir: profile, patchPath: join(profile, 'cordis.patch.yml'), installAnchor: join(root, 'package.json'),
    cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  await ctx.plugin(Commands)
  await expect(readFile(join(directory(ctx), 'office-check'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(join(profile, 'runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('writes PowerShell launchers with literal arguments and the selected checker environment', async () => {
  const ctx = await context(), configured = await context()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const bundled = join(root, 'primary-runtime')
    vi.stubEnv('DSH_BUNDLED_PRIMARY_RUNTIME', bundled)
    Commands.apply(ctx, { command: [process.execPath, 'percent%value', 'double"quote', "apostrophe'value"] })
    const launcher = await readFile(join(directory(ctx), 'dsoffice.ps1'))
    expect([...launcher.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(launcher.toString('utf8')).toContain("$commandArgs = @('percent%value', 'double\"quote', 'apostrophe''value') + $args")
    expect(launcher.toString('utf8')).toContain("$PSNativeCommandArgumentPassing = 'Legacy'")
    expect(await readFile(join(directory(ctx), 'office-check.ps1'), 'utf8')).toContain('python.exe')
    Commands.apply(configured, { runtime: { source: join(root, 'custom-runtime') } })
    expect(await readFile(join(directory(configured), 'office-check.ps1'), 'utf8')).toContain('$env:TSX_TSCONFIG_PATH')
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

it('removes short executable paths without removing the original interpreter', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const runtime = join(root, 'a'.repeat(120), 'b'.repeat(120))
    await mkdir(toNamespacedPath(runtime), { recursive: true })
    const node = join(runtime, 'node.exe')
    expect(node.length).toBeGreaterThan(260)
    await writeFile(toNamespacedPath(node), 'fixture')
    const ctx = await context()
    const commands = await ctx.plugin(Commands, { command: [node], checkCommand: false })
    const launcher = await readFile(join(directory(ctx), 'dsoffice.ps1'), 'utf8')
    const shortNode = /& '([^']+)' @nativeArgs/u.exec(launcher)?.[1]
    if (shortNode === undefined) throw new Error('Missing executable path in the PowerShell launcher')
    expect(shortNode).not.toBe(node)
    expect(await readFile(shortNode, 'utf8')).toBe('fixture')
    await commands.dispose()
    await expect(readFile(shortNode)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(toNamespacedPath(node), 'utf8')).toBe('fixture')
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

it.skipIf(process.platform !== 'win32').each([undefined, 'powershell.exe'])(
  'preserves native arguments and pipelines through the Windows shell executor: %s', async (pwshPath) => {
    const { LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
    const { PwshLocalExecutor } = await import('@deepseek-ai/dsh-pwsh-local')
    const runtime = join(root, 'runtime 中文', 'a'.repeat(220))
    await mkdir(toNamespacedPath(runtime), { recursive: true })
    const node = join(runtime, 'node.exe'), fixture = join(runtime, 'arguments.mjs')
    expect(node.length).toBeGreaterThan(260)
    await copyFile(process.execPath, toNamespacedPath(node))
    await writeFile(toNamespacedPath(fixture), "import { readFileSync } from 'node:fs'; process.stdout.write(JSON.stringify({ args: process.argv.slice(2), stdin: readFileSync(0, 'utf8') })); process.stderr.write('fixture stderr'); process.exitCode = 7;\n")
    const argumentsToPreserve = ['', 'space and 中文', "apostrophe'value", 'double"quote', 'quote" with space',
      'slash\\" quote', 'trailing\\', 'space trailing\\', '%PATH%', '!literal!', '&<|>']
    const quoted = argumentsToPreserve.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')
    if (pwshPath === undefined) vi.stubEnv('DSH_HOME', join(root, 'a'.repeat(120), 'b'.repeat(120)))
    const ctx = await context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(PwshLocalExecutor, pwshPath === undefined ? {} : { pwshPath })
    const commands = await ctx.plugin(Commands, { command: [node, fixture, ...argumentsToPreserve], checkCommand: false })
    const commandDirectory = directory(ctx)
    if (pwshPath === undefined) expect(commandDirectory.length).toBeGreaterThan(260)
    // Seeding the Framework cache forces its BOM independently of the runner's code page and attached console.
    const result = await (await ctx.shell.execute(ctx.shell.resolve({
      command: `$OutputEncoding = [System.Text.UTF8Encoding]::new($true)
if ($PSVersionTable.PSVersion.Major -le 5) {
  [Console].GetField('_inputEncoding', 'NonPublic,Static').SetValue($null, $OutputEncoding)
}
$originalInputEncoding = [Console]::InputEncoding
$originalInputReader = [Console]::In
'piped 中文' | dsoffice ${quoted} | Out-String
if (-not [object]::ReferenceEquals($originalInputEncoding, [Console]::InputEncoding)) { throw 'Input encoding was not restored' }
if (-not [object]::ReferenceEquals($originalInputReader, [Console]::In)) { throw 'Input reader was replaced' }
exit $LASTEXITCODE`,
      env: { PSExecutionPolicyPreference: 'Restricted' }, dshEnv: ctx.shellEnv.collect(execution),
    }))).result()
    expect(result.exitCode, result.stderr.text).toBe(7)
    expect(result.stderr.text).toContain('fixture stderr')
    const output = JSON.parse(result.stdout.text) as { args: string[]; stdin: string }
    expect(output.args).toEqual([...argumentsToPreserve, ...argumentsToPreserve])
    expect(output.stdin.trimEnd()).toBe('piped 中文')
    const pages = await (await ctx.shell.execute(ctx.shell.resolve({
      command: 'dsoffice --pages 1,3,4; exit $LASTEXITCODE',
      dshEnv: ctx.shellEnv.collect(execution),
    }))).result()
    expect(pages.exitCode, pages.stderr.text).toBe(7)
    expect((JSON.parse(pages.stdout.text) as { args: string[] }).args).toEqual([...argumentsToPreserve, '--pages', '1,3,4'])
    await commands.dispose()
    await expect(readdir(commandDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(ctx.shellEnv.collect(execution)).not.toHaveProperty('PATH')
  },
)

it.skipIf(process.platform !== 'win32')('reports a missing Windows executable as a failed shell command', async () => {
  const { LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
  const { PwshLocalExecutor } = await import('@deepseek-ai/dsh-pwsh-local')
  const ctx = await context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(PwshLocalExecutor, { pwshPath: 'powershell.exe' })
  await ctx.plugin(Commands, { command: [join(root, 'missing.exe')], checkCommand: false })
  const result = await (await ctx.shell.execute(ctx.shell.resolve({
    command: 'dsoffice --pages 1,3,4; exit $LASTEXITCODE',
    dshEnv: ctx.shellEnv.collect(execution),
  }))).result()
  expect(result.exitCode).toBe(127)
  expect(result.stderr.text).toContain('missing.exe')
})

it('uses the downloaded sidecar Node and disables Kit for an authoring-only carrier', async () => {
  const node = join(root, 'sidecar/node'), cli = join(root, 'sidecar/cli.js')
  vi.stubEnv('DSH_BUNDLED_OFFICE_NODE', node)
  vi.stubEnv('DSH_BUNDLED_OFFICE_CLI', cli)
  const ctx = await context()
  await ctx.plugin(Commands)
  const launcher = await readFile(join(directory(ctx), 'dsoffice'), 'utf8')
  expect(launcher).toContain(node)
  expect(launcher).toContain(cli)
  vi.stubEnv('DSH_BUNDLED_OFFICE_CLI', '')
  const disabled = await context()
  await disabled.plugin(Commands)
  expect(await readdir(directory(disabled))).toEqual([])
})
