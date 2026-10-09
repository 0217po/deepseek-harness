/** Exercise the wheel's Office API and model-shell commands from a shipped profile. */
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { createConverter } from '@deepseek-ai/libreoffice-kit'

export const name = 'python-sdk-office-smoke'

export async function apply(ctx, config) {
  const environment = ctx.shellEnv.collect({})
  const commandDirectory = environment.PATH?.split(delimiter)[0]
  if (!commandDirectory) throw new Error('Office commands were not registered in the profile')
  const commandPaths = [commandDirectory]
  if (process.platform !== 'win32') {
    const shellDirectory = await mkdtemp(join(dirname(config.input), '.office-shell-'))
    ctx.effect(() => () => rm(shellDirectory, { recursive: true, force: true }))
    await symlink('/bin/bash', join(shellDirectory, 'bash'))
    commandPaths.push(shellDirectory)
  }
  const quote = value => process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  async function cli(args) {
    const spec = ctx.shell.resolve({
      command: ['dsoffice', ...args.map(quote)].join(' '), workdir: dirname(config.input),
      timeoutMs: 120_000, stdoutMaxBytes: 64 * 1024,
      env: { PATH: '' }, dshEnv: { ...environment, PATH: commandPaths.join(delimiter) },
    })
    const result = await (await ctx.shell.execute(spec)).result()
    if (result.timedOut || result.aborted || result.signal || result.exitCode !== 0 || result.stdout.truncated) {
      throw new Error(`Office shell command failed: ${JSON.stringify(result)}`)
    }
    return JSON.parse(result.stdout.text)
  }
  const skill = await ctx.skills.get('office-export-pdf')
  if (!skill?.content.includes('dsoffice convert')) throw new Error('Office skill did not name the installed command')
  const capabilities = await cli(['capabilities', '--json'])
  await cli(['convert', '--input', config.input, '--output', config.output + '.cli.pdf'])
  const pdf = await readFile(config.output + '.cli.pdf')
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Office shell command did not create a PDF')
  const converter = await createConverter({ timeoutMs: 120_000 })
  try {
    const result = await converter.render({ inputPath: config.input, outputPath: config.output })
    const images = await converter.renderImages({ inputPath: config.imageInput, outputDir: config.imageOutput, pages: [1], dpi: 72 })
    await writeFile(config.result, JSON.stringify({ ...result, images, capabilities, moduleUrl: import.meta.resolve('@deepseek-ai/libreoffice-kit') }))
  } finally {
    await converter.dispose()
  }
}
