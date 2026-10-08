/** Built-artifact Session Client regression; generated schemas, declarations, and runtime share one plane. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { expect, it } from 'vitest'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '../../../..')
const fixture = join(directory, 'fixtures/session-client')
const required = [
  'packages/api/session-controller/lib/typert.host.js',
  'packages/api/session-controller/lib/typert.remote-client.js',
  'packages/api/session-controller/lib/typert.remote-client.d.ts',
  'packages/api/session-controller/lib/index.js',
  'packages/api/gateway/lib/types/client/index.js',
  'packages/client/connection/lib/types/client/index.js',
  'packages/typert/registry/lib/types/client/index.js',
  'packages/typert/protocol/lib/types/remote-info.js',
]

it.skipIf(required.some(path => !existsSync(join(root, path))))('runs the extracted Session Client against real controller artifacts in plain Node', async () => {
  // Stay under the package for ordinary Node package resolution, with one private output per test.
  const output = await mkdtemp(join(fixture, '.compiled-'))
  try {
    const config = ts.readConfigFile(join(fixture, 'tsconfig.json'), path => ts.sys.readFile(path))
    expect(config.error).toBeUndefined()
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fixture, { outDir: output })
    const program = ts.createProgram(parsed.fileNames, parsed.options)
    const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: path => path,
      getNewLine: () => '\n',
    })
    expect(formatted).toBe('')
    expect(program.emit().emitSkipped).toBe(false)
    await copyFile(join(fixture, 'run.mjs'), join(output, 'run.mjs'))
    const result = await promisify(execFile)(process.execPath, [join(output, 'run.mjs')], {
      cwd: root,
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: 25_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    const summary: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}')
    expect(summary).toMatchObject({ endpoints: ['session/page', 'session/follow'], realController: true, sockets: 1 })
  } finally {
    // mkdtemp returns this test's absolute directory; never remove a caller-provided path.
    if (dirname(output) !== fixture || !output.startsWith(join(fixture, '.compiled-'))) throw new Error('Unexpected fixture output path')
    await rm(output, { recursive: true, force: true })
  }
}, 60_000)
