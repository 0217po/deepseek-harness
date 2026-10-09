/** Local Office command launchers contributed to model shell calls. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, toNamespacedPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-shell-env'

/** Local interpreter and resource selection; commands execute in the same host as these resources. */
export interface Config {
  /** dsoffice argv; defaults to the carrier or installed Kit. False disables dsoffice. */
  command?: string[] | false
  /** Python checker command argv; defaults to the supplied runtime; absent without a runtime. */
  checkCommand?: string[] | false
  /** Directory containing the shared scripts/ and Office skills. */
  assetRoot?: string
}

/** Validate local command configuration. */
export const Config: z<Config> = z.object({
  command: z.union([z.array(z.string()).min(1), z.const(false)]),
  checkCommand: z.union([z.array(z.string()).min(1), z.const(false)]),
  assetRoot: z.string().min(1),
})

/** Cordis plugin identity. */
export const name = 'office-commands'
/** Registry that publishes the launcher directory for each shell execution. */
export const inject = ['shellEnv']

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function writeLauncher(directory: string, name: string, command: readonly string[]): void {
  const executable = command[0]
  if (executable === undefined || !isAbsolute(executable)) throw new Error(`office-commands: ${name} requires an absolute executable`)
  if (command.some(argument => /[\0\r\n]/u.test(argument))) throw new Error('office-commands: command arguments must not contain NUL or newlines')
  const script = join(directory, name)
  writeFileSync(script, `#!/bin/sh\nexec ${command.map(quote).join(' ')} "$@"\n`, { mode: 0o700, flag: 'wx' })
  chmodSync(script, 0o700)
  if (process.platform === 'win32') {
    const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const args = command.slice(1).map(literal).join(', ')
    // Windows PowerShell counts escaped quotes when deciding whether to wrap an argument; doubled quotes keep each value enclosed.
    const nativeArguments = String.raw`$quoteReplacement = if ($PSVersionTable.PSVersion.Major -le 5) { '$1$1""' } else { '$1$1\"' }
$nativeArgs = @(foreach ($argument in $commandArgs) {
  $value = if ($argument -is [array]) { $argument -join ',' } else { [string]$argument }
  '"' + ($value -replace '(\\*)"', $quoteReplacement -replace '(\\+)$', '$1$1') + '"'
})`
    // Framework Process.Start flushes Console.InputEncoding's preamble before PowerShell writes pipeline text.
    // The private cache avoids the public setter's no-console failure and leaves Console.In's buffered data intact.
    const inputEncoding = `$inputEncodingField = $null
if ($MyInvocation.ExpectingInput -and $PSVersionTable.PSVersion.Major -le 5) {
  $inputEncodingField = [Console].GetField('_inputEncoding', 'NonPublic,Static')
  if ($null -eq $inputEncodingField) { throw 'office-commands: Windows PowerShell input encoding field is unavailable' }
  $savedInputEncoding = $inputEncodingField.GetValue($null)
}`
    writeFileSync(`${script}.ps1`, '\ufeff$PSNativeCommandArgumentPassing = \'Legacy\'\n'
      + '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'
      + `$commandArgs = @(${args}) + $args\n${nativeArguments}\n${inputEncoding}\n$global:LASTEXITCODE = 127\ntry {\n`
      + '  if ($null -ne $inputEncodingField) { $inputEncodingField.SetValue($null, $OutputEncoding) }\n'
      + `  if ($MyInvocation.ExpectingInput) { $input | & ${literal(executable)} @nativeArgs }\n`
      + `  else { & ${literal(executable)} @nativeArgs }\n`
      + '} finally {\n  if ($null -ne $inputEncodingField) { $inputEncodingField.SetValue($null, $savedInputEncoding) }\n}\n'
      + 'exit $LASTEXITCODE\n', { flag: 'wx' })
  }
}

/**
 * Publish stable Office commands without preparing interpreters or engines at activation.
 * @param ctx - Local shell environment.
 * @param config - Command overrides and interpreter resources.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const bundled = process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME
  const carrierRuntime = process.env.DSH_BUNDLED_PRIMARY_RUNTIME
  const node = process.env.DSH_BUNDLED_OFFICE_NODE ?? (carrierRuntime ? join(carrierRuntime, 'dependencies/node/bin', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath)
  const assetRoot = config.assetRoot ?? process.env.DSH_BUNDLED_OFFICE_SKILLS ?? (bundled ? join(dirname(bundled), 'office-skills') : fileURLToPath(new URL('../assets/', import.meta.url)))
  if (!isAbsolute(assetRoot)) throw new Error('office-commands: assetRoot must be an absolute directory')
  const kit = config.command ?? (process.env.DSH_BUNDLED_OFFICE_CLI === '' ? false : [node, process.env.DSH_BUNDLED_OFFICE_CLI
    ?? join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))), 'lib/cli.js')])
  const checker = join(assetRoot, 'scripts/check_office.py')
  const check = config.checkCommand ?? (bundled
    ? [join(bundled, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'), checker]
    : false)
  const parent = join(resolveDshHome(), 'commands')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  // Windows mkdtemp needs extended paths; shell PATH keeps ordinary absolute directories.
  const directory = join(parent, basename(mkdtempSync(toNamespacedPath(join(parent, 'office-')))))
  const shortcutDirectories: string[] = []
  const shortCommand = (command: readonly string[]): readonly string[] => {
    const executable = command[0]
    if (process.platform !== 'win32' || executable === undefined || executable.length < 260
      || !isAbsolute(executable) || !existsSync(toNamespacedPath(dirname(executable)))) return command
    const shortcutDirectory = mkdtempSync(join(tmpdir(), 'dsh-office-exe-'))
    shortcutDirectories.push(shortcutDirectory)
    const junction = join(shortcutDirectory, 'bin')
    symlinkSync(toNamespacedPath(dirname(executable)), junction, 'junction')
    return [join(junction, basename(executable)), ...command.slice(1)]
  }
  const removeDirectories = () => {
    rmSync(directory, { recursive: true, force: true })
    for (const shortcutDirectory of shortcutDirectories) rmSync(shortcutDirectory, { recursive: true, force: true })
  }
  try {
    if (kit !== false) writeLauncher(directory, 'dsoffice', shortCommand(kit))
    if (check !== false) writeLauncher(directory, 'office-check', shortCommand(check))
    ctx.effect(() => () => { removeDirectories() })
    ctx.shellEnv.register({ name, commandDirectories: [directory], variables: {}, resolve: () => ({}) })
  } catch (error) {
    removeDirectories()
    throw error
  }
}
