/** Profile patch edits preserve user-authored syntax and are idempotent. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { writePluginEnabled } from '../src/patch.ts'

async function fixture(text?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'manager-patch-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'cordis.patch.yml')
  if (text !== undefined) await writeFile(file, text)
  return file
}

it('preserves comments, expressions, unrelated configuration and the last override', async () => {
  const file = await fixture('# personal configuration\n- id: tool\n  config:\n    value: !!js process.platform\n- id: tool\n  disabled: false # availability\n')
  expect(await writePluginEnabled(file, 'tool', 'package', false, [])).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('# personal configuration')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  expect(loadOptionalPatches('test', file)).toEqual([
    { id: 'tool', config: { value: { __jsExpr: 'process.platform' } } }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(file, 'tool', 'package', false, [])).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(text)
  expect(await writePluginEnabled(file, 'tool', 'package', true, [])).toBe(true)
})

it('creates a missing patch file and appends after insertions', async () => {
  const file = await fixture()
  await writePluginEnabled(file, 'tool', 'package', false, [])
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'tool', disabled: true }])
  await writeFile(file, '- insert:\n    - id: tool\n      name: package\n')
  await writePluginEnabled(file, 'tool', 'package', false, [])
  expect(loadOptionalPatches('test', file)).toEqual([
    { insert: [{ id: 'tool', name: 'package' }] }, { id: 'tool', disabled: true },
  ])
})

it.each(['- id: [broken', 'mapping: true\n'])('refuses malformed documents without overwriting %s', async (text) => {
  const file = await fixture(text)
  await expect(writePluginEnabled(file, 'tool', 'package', true, [])).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe(text)
})


it('retains name-asserting overrides and appends an unambiguous switch', async () => {
  const file = await fixture('- id: tool\n  name: another-package\n  disabled: false\n')
  await writePluginEnabled(file, 'tool', 'package', false, [])
  expect(loadOptionalPatches('test', file)).toEqual([
    { id: 'tool', name: 'another-package', disabled: false }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(file, 'tool', 'package', false, [])).toBe(false)
})

it('reports read failures without replacing a directory with configuration', async () => {
  const file = await fixture()
  await mkdir(file)
  await expect(writePluginEnabled(file, 'tool', 'package', true, [])).rejects.toThrow()
})

it('updates the last matching named override and leaves mismatched names untouched', async () => {
  const file = await fixture('- id: tool\n  disabled: true\n- id: tool\n  name: package\n  config:\n    value: !!js process.platform\n  disabled: true # availability\n- id: tool\n  name: another-package\n  disabled: true\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true, [])).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  const patches = loadOptionalPatches('test', file)
  expect(patches).toEqual([
    { id: 'tool', disabled: true },
    { id: 'tool', name: 'package', config: { value: { __jsExpr: 'process.platform' } }, disabled: false },
    { id: 'tool', name: 'another-package', disabled: true },
  ])
  expect(applyEntryPatches([{ id: 'tool', name: 'package' }], patches, () => {}))
    .toMatchObject([{ id: 'tool', name: 'package', disabled: false }])
  expect(await writePluginEnabled(file, 'tool', 'package', true, [])).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(text)
  expect(await writePluginEnabled(file, 'tool', 'package', false, [])).toBe(true)
  expect(loadOptionalPatches('test', file)).toHaveLength(3)
})

it('removes or omits a plain switch that restates the bundle layers', async () => {
  const layers = [{ insert: [{ id: 'tool', name: 'package' }] }]
  const file = await fixture('# personal configuration\n- id: other\n  disabled: true\n- id: tool\n  disabled: true\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true, layers)).toBe(true)
  expect(await readFile(file, 'utf8')).toBe('# personal configuration\n- id: other\n  disabled: true\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true, layers)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe('# personal configuration\n- id: other\n  disabled: true\n')
  expect(await writePluginEnabled(file, 'tool', 'package', false, layers)).toBe(true)
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'other', disabled: true }, { id: 'tool', disabled: true }])
})

it('keeps a switch that carries other settings or differs from the bundle layers', async () => {
  const file = await fixture('- id: tool\n  config: { value: 1 }\n  disabled: true\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true, [{ insert: [{ id: 'tool', name: 'package' }] }])).toBe(true)
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'tool', config: { value: 1 }, disabled: false }])
  const plain = await fixture('- id: tool\n  disabled: true\n')
  expect(await writePluginEnabled(plain, 'tool', 'package', true, [{ insert: [{ id: 'tool', name: 'package', disabled: true }] }])).toBe(true)
  expect(loadOptionalPatches('test', plain)).toEqual([{ id: 'tool', disabled: false }])
})

it('keeps the comment above a removed switch and prunes a switch the composition already implies', async () => {
  const layers = [{ insert: [{ id: 'tool', name: 'package' }] }]
  const file = await fixture('# header\n- id: tool\n  disabled: false\n# other\n- id: other\n  disabled: true\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true, layers)).toBe(true)
  expect(await readFile(file, 'utf8')).toBe('# header\n# other\n- id: other\n  disabled: true\n')
  const first = await fixture('# header\n- id: tool\n  disabled: true\n- id: other\n  disabled: true\n')
  expect(await writePluginEnabled(first, 'tool', 'package', true, layers)).toBe(true)
  expect(await readFile(first, 'utf8')).toBe('# header\n- id: other\n  disabled: true\n')
  const only = await fixture('# header\n- id: tool\n  disabled: true\n')
  expect(await writePluginEnabled(only, 'tool', 'package', true, layers)).toBe(true)
  expect(loadOptionalPatches('test', only)).toEqual([])
  expect(await readFile(only, 'utf8')).toBe('# header\n[]\n')
  const last = await fixture('- id: other\n  disabled: true\n# about tool\n- id: tool\n  disabled: true\n')
  expect(await writePluginEnabled(last, 'tool', 'package', true, layers)).toBe(true)
  expect(await readFile(last, 'utf8')).toBe('- id: other\n  disabled: true\n\n# about tool\n')
  const lastWithTail = await fixture('- id: other\n  disabled: true\n# about tool\n- id: tool\n  disabled: true\n# tail\n')
  expect(await writePluginEnabled(lastWithTail, 'tool', 'package', true, layers)).toBe(true)
  expect(await readFile(lastWithTail, 'utf8')).toBe('- id: other\n  disabled: true\n\n# about tool\n# tail\n')
  const trailing = await fixture('- id: tool\n  disabled: true # removed\n# tail\n')
  expect(await writePluginEnabled(trailing, 'tool', 'package', true, layers)).toBe(true)
  expect(loadOptionalPatches('test', trailing)).toEqual([])
  expect(await readFile(trailing, 'utf8')).toContain('# tail')
  const both = await fixture('# header\n- id: tool\n  disabled: true\n# tail\n')
  expect(await writePluginEnabled(both, 'tool', 'package', true, layers)).toBe(true)
  expect(await readFile(both, 'utf8')).toBe('# header\n[]\n\n# tail\n')
})

it('treats insertions in the profile patch as part of the inherited composition', async () => {
  const file = await fixture('- insert:\n    - id: tool\n      name: package\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true, [])).toBe(false)
  expect(loadOptionalPatches('test', file)).toEqual([{ insert: [{ id: 'tool', name: 'package' }] }])
})

it.each([
  ['a value', '- id: &plugin tool\n  disabled: true\n- id: other\n  config: { target: *plugin }\n', { target: 'tool' }],
  ['the entry', '- &plugin { id: tool, disabled: true }\n- id: other\n  config: { target: *plugin }\n', { target: { id: 'tool', disabled: false } }],
  ['a key', '- id: tool\n  &key disabled: true\n- id: other\n  config: { *key : 1 }\n', { disabled: 1 }],
])('keeps a switch whose anchor on %s other entries reference', async (_, text, config) => {
  const file = await fixture(text)
  expect(await writePluginEnabled(file, 'tool', 'package', true, [{ insert: [{ id: 'tool', name: 'package' }] }])).toBe(true)
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'tool', disabled: false }, { id: 'other', config }])
})

it('keeps a switch whose value is an alias', async () => {
  const file = await fixture('- id: other\n  config: { flag: &flag true }\n- id: tool\n  disabled: *flag\n')
  expect(await writePluginEnabled(file, 'tool', 'package', true, [{ insert: [{ id: 'tool', name: 'package' }] }])).toBe(true)
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'other', config: { flag: true } }, { id: 'tool', disabled: false }])
})
