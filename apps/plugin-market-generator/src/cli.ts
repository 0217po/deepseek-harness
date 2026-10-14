/**
 * Reference plugin market index generator.
 *
 * Usage: plugin-market-generator --input <list> --output <index.json> --title <text> [options]
 *
 * The list holds one npm package name or https Git repository URL per line. The generator lists every non-deprecated
 * npm bundle version, and the versions at Git release tags and the default branch, never runs package code, and writes
 * a validated format-1 index. Unchanged releases and commits are read from the cache directory, and the index file is
 * rewritten only when its content changes.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { MAX_INLINE_ICON_BYTES } from '@deepseek-ai/dsh-plugin-market-index'
import { writeIfChanged } from './files.ts'
import { generate } from './generate.ts'
import { GENERATED_ICON } from './metadata.ts'
import { parseSources } from './sources.ts'

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'
/** Names of icon files the generator writes, which it may also remove. */

const HELP = `Usage: plugin-market-generator --input <list> --output <index.json> --title <text> [options]

Options:
  --input <file>             source list: one npm package name or https Git URL per line; lines starting with # are comments
  --output <file>            index file to write; large icons go to icons/ beside it, and stale generated icons there are removed
  --title <text>             market title
  --description <text>       market description
  --cache <dir>              cache directory (default: .plugin-market-cache beside the input list)
  --registry <url>           npm registry (default: ${PUBLIC_REGISTRY})
  --inline-icon-bytes <n>    largest icon embedded as a data URL, at most ${String(MAX_INLINE_ICON_BYTES)} (default: 16384)
  --concurrency <n>          sources read at once (default: 4)
  --timeout-ms <n>           deadline for one request or git command (default: 60000)
  -h, --help                 show this help

Exit status: 0 when every source was read, 1 when some source fell back to its cached result or was omitted,
2 for invalid arguments or input.`

function integer(value: string | undefined, fallback: number, name: string, max?: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new Error(`--${name} must be a positive integer${max === undefined ? '' : ` up to ${String(max)}`}`)
  }
  return parsed
}

/**
 * Run the generator.
 * @param argv - command-line arguments after the program name.
 * @returns the process exit status.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let values
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        input: { type: 'string' }, output: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
        cache: { type: 'string' }, registry: { type: 'string' }, 'inline-icon-bytes': { type: 'string' },
        concurrency: { type: 'string' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`)
    return 2
  }
  if (values.help === true) {
    console.log(HELP)
    return 0
  }
  try {
    if (values.input === undefined || values.output === undefined || values.title === undefined) throw new Error('--input, --output, and --title are required')
    // `pnpm --filter … start` runs in the package directory; paths are relative to where the user ran pnpm.
    const base = process.env.INIT_CWD ?? process.cwd()
    const input = resolve(base, values.input)
    const output = resolve(base, values.output)
    const registry = new URL(values.registry ?? PUBLIC_REGISTRY).href.replace(/\/?$/u, '/')
    const inlineIconBytes = integer(values['inline-icon-bytes'], 16384, 'inline-icon-bytes', MAX_INLINE_ICON_BYTES)
    const timeoutMs = integer(values['timeout-ms'], 60000, 'timeout-ms')
    const concurrency = integer(values.concurrency, 4, 'concurrency')
    const result = await generate({
      sources: parseSources(readFileSync(input, 'utf8')),
      cacheDir: values.cache === undefined ? join(dirname(input), '.plugin-market-cache') : resolve(base, values.cache),
      registry,
      recordRegistry: registry !== PUBLIC_REGISTRY,
      title: values.title,
      ...values.description === undefined ? {} : { description: values.description },
      inlineIconBytes,
      limits: { timeoutMs, maxTarballBytes: 64 * 1024 * 1024 },
      concurrency,
      warn: (message) => { console.error(`warning: ${message}`) },
    })
    for (const [path, cached] of result.icons) writeIfChanged(join(dirname(output), path), readFileSync(cached))
    const iconDir = join(dirname(output), 'icons')
    for (const name of existsSync(iconDir) ? readdirSync(iconDir) : []) {
      const file = join(iconDir, name)
      if (GENERATED_ICON.test(name) && !result.icons.has(`icons/${name}`) && lstatSync(file).isFile()) rmSync(file, { force: true })
    }
    const changed = writeIfChanged(output, `${JSON.stringify(result.index, null, 2)}\n`)
    const plugins = result.index.plugins.length
    console.log(`${changed ? 'wrote' : 'unchanged'} ${output}: ${plugins} plugin(s), ${result.failures.length} failed source(s)`)
    return result.failures.length === 0 ? 0 : 1
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
}
