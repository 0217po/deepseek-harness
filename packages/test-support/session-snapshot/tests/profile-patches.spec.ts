/** Materialized profile patches retain scoped declaration paths and package ownership. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished } from 'vitest'
import { materializeProfilePatch } from '../src/launcher.ts'

it('discovers relocated packages and relative modules in scoped and complete preset insertions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-preset-patch-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const sourceDir = join(dir, 'authored')
  const runDir = join(dir, 'run')
  const targetDir = join(runDir, 'patches')
  mkdirSync(sourceDir)
  mkdirSync(targetDir, { recursive: true })
  const packages = ['@deepseek-ai/dsh-tool-terminal', '@deepseek-ai/dsh-agent-preset']
  for (const name of packages) {
    const packageDir = join(sourceDir, 'node_modules', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  const source = join(sourceDir, 'cordis.patch.yml')
  writeFileSync(source, [
    '- preset: preset-ptc',
    '  insert:',
    '    - id: scoped-group',
    '      name: cordis:group',
    '      group: true',
    '      config:',
    '        - id: relocated-terminal',
    "          name: '@deepseek-ai/dsh-tool-terminal'",
    '        - id: relative',
    '          name: ./relative.mjs',
    '          disabled: !!js process.platform === "win32"',
    '- insert:',
    '    - id: preset-added',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: added',
    '        plugins:',
    '          - id: nested',
    '            name: cordis:group',
    '            group: true',
    '            config:',
    '              - id: child',
    '                name: ../child.mjs',
    '              - id: terminal',
    "                name: '@deepseek-ai/dsh-tool-terminal'",
    '- preset: preset-ptc',
    '  id: relative',
    '  disabled: true',
    '',
  ].join('\n'))
  const output = materializeProfilePatch(source, runDir, 'web', targetDir, 0)
  expect(load(readFileSync(output, 'utf8'), { schema: entryListSchema })).toMatchObject([
    { preset: 'preset-ptc', insert: [{ config: [
      { name: packages[0] },
      { name: pathToFileURL(join(sourceDir, 'relative.mjs')).href, disabled: { __jsExpr: 'process.platform === "win32"' } },
    ] }] },
    { insert: [{ config: { plugins: [{ config: [
      { name: pathToFileURL(join(dir, 'child.mjs')).href }, { name: packages[0] },
    ] }] } }] },
    { preset: 'preset-ptc', id: 'relative', disabled: true },
  ])
  for (const name of packages) {
    expect(realpathSync(join(runDir, '.dsh', 'profiles', 'web', 'node_modules', name)))
      .toBe(realpathSync(join(sourceDir, 'node_modules', name)))
  }
})
