/** Preset operations preserve native root patch lookup and share startup/dump/reload compilation. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { load } from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { EntryGroup, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import {
  applyProfilePatches, boot, compileProfilePatches, composeEntries, loadOverlayPatches,
  prepareProfilePatches, profilePatchPreset, reconcileProfilePatches, renderConfigDump, type ProfilePatch,
} from '../src/index.ts'

import { cloneProfilePatches } from '../src/profile-patches.ts'

const preset = (plugins: EntryOptions[] = []): Omit<EntryOptions, 'config'> & {
  config: { id: string; description: string; plugins: EntryOptions[] }
} => ({
  id: 'preset-standard', name: 'cordis:test-preset', config: { id: 'standard', description: 'Original', plugins },
})
const row = (id: string): EntryOptions => ({ id, name: 'test-plugin', config: { value: 'initial' } })
const children = (rows: EntryOptions[]): EntryOptions[] => (rows[0]!.config as { plugins: EntryOptions[] }).plugins
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preset-patches-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

describe('preset patch composition', () => {
  it('composes bundle insertions and later scoped user overrides without mutating inputs', () => {
    const initial = [preset([row('base')])]
    const patches: ProfilePatch[] = [
      { preset: 'preset-standard', insert: [row('optional')] },
      { preset: 'preset-standard', id: 'optional', config: { value: { __jsExpr: 'ctx.value' } } },
      { preset: 'preset-standard', id: 'base', disabled: true },
    ]
    const original = structuredClone({ initial, patches })
    const result = applyProfilePatches(initial, patches)
    expect(children(result)).toEqual([
      { ...row('base'), disabled: true },
      { ...row('optional'), config: { value: { __jsExpr: 'ctx.value' } } },
    ])
    expect(result[0]?.config).toMatchObject({ description: 'Original' })
    expect({ initial, patches }).toEqual(original)
    expect(composeEntries([[{ insert: initial }], patches])).toEqual(result)
    expect(compileProfilePatches(initial, patches).every(patch => !Object.hasOwn(patch, 'preset'))).toBe(true)
  })

  it('allows a later whole-preset replacement to replace all scoped edits', () => {
    const replacement = { id: 'standard', plugins: [row('user')] }
    expect(applyProfilePatches([preset()], [
      { preset: 'preset-standard', insert: [row('optional')] },
      { id: 'preset-standard', config: replacement },
    ])[0]?.config).toEqual(replacement)
  })

  it('applies each scoped operation to the current child list, including replacement children', () => {
    const group = { id: 'group', name: 'cordis:group', group: true, config: [] }
    const result = applyProfilePatches([preset([group])], [
      { preset: 'preset-standard', id: 'group', config: [row('replaced-child')] },
      { preset: 'preset-standard', id: 'replaced-child', disabled: true },
      { preset: 'preset-standard', id: 'group', insert: [row('inserted-child')] },
    ])
    expect(children(result)[0]?.config).toEqual([
      { ...row('replaced-child'), disabled: true }, row('inserted-child'),
    ])
  })

  it('retains ordinary root single-index behavior before and after a scoped operation', () => {
    const warn: string[] = []
    const result = applyProfilePatches([
      { id: 'group', name: 'cordis:group', group: true, config: [] }, preset(),
    ], [
      { id: 'group', config: [row('replacement')] },
      { preset: 'preset-standard', insert: [row('optional')] },
      { id: 'replacement', disabled: true },
    ], message => warn.push(message))
    expect(result[0]?.config).toEqual([row('replacement')])
    expect(warn).toEqual(['patch: entry %C not found'])
  })

  it.each([
    [{ id: 'group', name: 'cordis:group', group: true, config: [] }, [preset()]],
    [{ id: 'group', name: 'cordis:group', group: true, config: [preset()] }, []],
  ])('rejects an outer target added or removed by a whole-group replacement', (group, replacement) => {
    expect(() => applyProfilePatches([group as EntryOptions], [
      { id: 'group', config: replacement }, { preset: 'preset-standard', insert: [row('optional')] },
    ])).toThrow('is missing or not addressable')
  })

  it('accepts an outer target inserted in a patchable group', () => {
    const result = applyProfilePatches([{ id: 'group', name: 'cordis:group', group: true, config: [] }], [
      { id: 'group', insert: [preset()] },
      { preset: 'preset-standard', insert: [row('optional')] },
    ])
    expect(children(result[0]?.config as EntryOptions[])).toEqual([row('optional')])
  })

  it('warns and skips a stale user override after its optional bundle is deselected', () => {
    const messages: unknown[][] = []
    expect(applyProfilePatches([preset()], [{ preset: 'preset-standard', id: 'optional', disabled: true }],
      (...args) => messages.push(args))).toEqual([preset()])
    expect(messages).toEqual([['preset "preset-standard": patch: entry %C not found', 'optional']])
  })

  it.each([null, '', '  ', 1, { __jsExpr: 'ctx.preset' }])('rejects a nonliteral or empty outer target %j', (target) => {
    const dir = temp()
    const path = join(dir, 'patch.yml')
    writeFileSync(path, JSON.stringify([{ preset: target, insert: [] }]))
    expect(() => loadOverlayPatches('test', path)).toThrow('nonempty literal row id')
    expect(() => loadOverlayPatches('test', path)).toThrow(path)
  })

  it('allows callers to omit a warning sink for skipped ordinary and scoped rows', () => {
    expect(applyProfilePatches([], [{ id: 'missing', disabled: true }])).toEqual([])
    expect(compileProfilePatches([preset()], [{ preset: 'preset-standard', id: 'missing', disabled: true }]))
      .toEqual([{ id: 'preset-standard', config: preset().config }])
  })

  it('rejects a missing outer row', () => {
    expect(() => applyProfilePatches([], [{ preset: 'missing', insert: [] }])).toThrow('preset "missing" is missing')
    expect(profilePatchPreset({ id: 'ordinary' })).toBeUndefined()
  })

  it.each([undefined, null, [], { plugins: { __jsExpr: '[]' } }])('rejects a malformed preset config %j', (config) => {
    expect(() => applyProfilePatches([{ ...preset(), config }], [{ preset: 'preset-standard', insert: [] }]))
      .toThrow('literal config.plugins entry list')
  })

  it.each([
    { inserted: [row('same')] },
    { inserted: [{ id: 'nested', name: 'cordis:group', group: true, config: [row('same')] }] },
  ])('rejects inserted ids colliding with existing nested ids', ({ inserted }) => {
    expect(() => applyProfilePatches([preset([
      { id: 'old-group', name: 'cordis:group', group: true, config: [row('same')] },
    ])], [{ preset: 'preset-standard', insert: inserted }])).toThrow('duplicate entry id "same"')
  })

  it('rejects duplicate ids inside an insertion and allows anonymous rows', () => {
    expect(() => applyProfilePatches([preset()], [{ preset: 'preset-standard', insert: [row('same'), row('same')] }]))
      .toThrow('duplicate entry id "same"')
    const path = join(temp(), 'anonymous.patch.yml')
    writeFileSync(path, JSON.stringify([{ preset: 'preset-standard', insert: [{ name: 'anonymous' }] }]))
    expect(children(applyProfilePatches([preset()], loadOverlayPatches('test', path))))
      .toEqual([{ id: expect.any(String) as string, name: 'anonymous' }])
  })

  it('keeps anonymous scoped identities stable by file and position without naming ordinary anonymous rows', () => {
    const dir = temp()
    const file = join(dir, 'contribution.patch.yml')
    const content = JSON.stringify([
      { insert: [{ name: 'ordinary-anonymous' }] },
      { preset: 'preset-standard', insert: [
        { name: 'anonymous' },
        { id: 'explicit', name: 'cordis:group', group: true, config: [{ name: 'nested-anonymous' }] },
      ] },
      { preset: 'preset-standard', insert: [{ name: 'anonymous' }] },
    ])
    writeFileSync(file, content)
    const first = loadOverlayPatches('test', file)
    const second = loadOverlayPatches('test', file)
    expect(second).toEqual(first)
    expect(first[0]?.insert?.[0]?.id).toBeUndefined()
    expect(first[1]?.insert?.[1]?.id).toBe('explicit')
    const nested = first[1]?.insert?.[1]?.config as EntryOptions[]
    const ids = [first[1]?.insert?.[0]?.id, nested[0]?.id, first[2]?.insert?.[0]?.id]
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(3)
    const other = join(dir, 'other.patch.yml')
    writeFileSync(other, content)
    expect(loadOverlayPatches('test', other)[1]?.insert?.[0]?.id).not.toBe(ids[0])
    expect(children(applyProfilePatches([preset()], first))).toEqual(children(applyProfilePatches([preset()], second)))
    expect(Object.keys(first[1]!)).toEqual(['preset', 'insert'])
  })

  it.each([
    { initial: [], insert: [] },
    { initial: [preset()], insert: [{ id: 'group', name: 'cordis:group', group: true, config: [row('duplicate'), row('duplicate')] }] },
    { initial: [{ ...preset(), config: null }], insert: [] },
  ])('attributes scoped errors after cloning and flattening through composition, dumps, and boot', async ({ initial, insert }) => {
    const dir = temp()
    const path = join(dir, 'cordis.yml')
    writeFileSync(path, JSON.stringify(initial))
    const patchFile = join(dir, 'third-party.patch.yml')
    writeFileSync(patchFile, JSON.stringify([{ preset: 'preset-standard', insert }]))
    const patches = cloneProfilePatches(loadOverlayPatches('test', patchFile))
    expect(() => composeEntries([[{ insert: initial }], patches])).toThrow(patchFile)
    expect(() => renderConfigDump('test', path, [{ label: 'third-party', patches }])).toThrow(patchFile)
    await expect(boot('test', path, patches)).rejects.toThrow(patchFile)
  })

  it('keeps anonymous rows from the initial preset beside newly inserted rows', () => {
    const initial = load(JSON.stringify([{ ...preset(), config: { id: 'standard', plugins: [{ name: 'anonymous-base' }] } }])) as EntryOptions[]
    expect(children(applyProfilePatches(initial, [{ preset: 'preset-standard', insert: [row('contributed')] }])))
      .toEqual([{ name: 'anonymous-base' }, row('contributed')])
  })

  it('attributes errors from a caller warning sink to the loaded scoped operation', () => {
    const path = join(temp(), 'warning.patch.yml')
    writeFileSync(path, JSON.stringify([{ preset: 'preset-standard', id: 'absent', disabled: true }]))
    expect(() => applyProfilePatches([preset()], loadOverlayPatches('test', path), () => { throw 'warning sink unavailable' }))
      .toThrow(`warning sink unavailable in ${path}`)
  })

  it('attributes ordinary and scoped warnings to their own dump layers', () => {
    const dir = temp()
    const path = join(dir, 'cordis.yml')
    writeFileSync(path, JSON.stringify([preset()]))
    const warnings: string[] = []
    renderConfigDump('test', path, [
      { label: 'ordinary', patches: [{ id: 'missing', disabled: true }] },
      { label: 'scoped', patches: [{ preset: 'preset-standard', id: 'missing', disabled: true }] },
    ], message => warnings.push(message))
    expect(warnings).toEqual([
      'test: [ordinary] patch: entry "missing" not found',
      'test: [scoped] preset "preset-standard": patch: entry "missing" not found',
    ])
  })
})

const capturePreset = {
  [EntryGroup.key]: true,
  async apply(ctx: Context, config: { plugins: EntryOptions[] }) { await ctx.plugin(Group, config.plugins) },
}

it('boots, dumps, and reloads a third-party relative module inside a contributed group', async () => {
  const dir = temp()
  const bundleDir = join(dir, 'third-party')
  mkdirSync(bundleDir)
  writeFileSync(join(bundleDir, 'relative.mjs'), [
    'export function apply(ctx, config) {',
    '  ctx.effect(() => ctx.reflect.provide("presetPatchResult", config.value))',
    '}',
    '',
  ].join('\n'))
  const path = join(dir, 'cordis.yml')
  writeFileSync(path, JSON.stringify([preset()]))
  const patchPath = join(bundleDir, 'cordis.patch.yml')
  writeFileSync(patchPath, [
    '- preset: preset-standard',
    '  insert:',
    '    - id: nested',
    '      name: cordis:group',
    '      group: true',
    '      config:',
    '        - id: contributed',
    '          name: ./relative.mjs',
    '          config:',
    '            value: !!js ctx.get("fixtureValue")',
    '',
  ].join('\n'))
  const patches = loadOverlayPatches('test', patchPath)
  const ctx = await boot('test', path, patches, (context) => {
    context.loader.builtins['test-preset'] = capturePreset
    context.provide('fixtureValue', 'from-child-context')
  })
  onTestFinished(() => ctx.fiber.dispose())
  expect(ctx.get('presetPatchResult')).toBe('from-child-context')
  const declared = [...ctx.loader.entries()].find(entry => entry.options.id === 'preset-standard')!
  const dump = renderConfigDump('test', path, [{ label: 'third-party', patches }])
  expect(load(dump, { schema: entryListSchema })).toEqual([declared.options])
  expect(dump).toContain(pathToFileURL(join(bundleDir, 'relative.mjs')).href)
  expect(dump).toContain('!!js ctx.get("fixtureValue")')
  await reconcileProfilePatches(ctx, [...patches, {
    preset: 'preset-standard', id: 'contributed', config: { value: 'user' },
  }], 'test')
  expect(ctx.get('presetPatchResult')).toBe('user')
  await reconcileProfilePatches(ctx, [], 'test')
  expect(ctx.get('presetPatchResult')).toBeUndefined()
  await reconcileProfilePatches(ctx, [{ preset: 'preset-standard', id: 'contributed', disabled: true }], 'test')
  expect(ctx.get('presetPatchResult')).toBeUndefined()
  await reconcileProfilePatches(ctx, patches, 'test')
  expect(ctx.get('presetPatchResult')).toBe('from-child-context')
})

it('rejects a malformed root configuration before compiling its scoped patch', async () => {
  const dir = temp()
  const path = join(dir, 'cordis.yml')
  writeFileSync(path, '{}\n')
  await expect(boot('test', path, [{ preset: 'preset-standard', insert: [] }]))
    .rejects.toThrow('must be a top-level array of entries')
})

it('leaves lower-level nonprofile compatibility callers in control of their native patches', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const patches = [{ id: 'custom', disabled: true }]
  expect(prepareProfilePatches(ctx, patches, pathToFileURL(temp()).href)).toBe(patches)
})

it('anchors relative modules in an inserted preset definition and its nested groups', () => {
  const dir = temp()
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, JSON.stringify([{ insert: [{
    ...preset([{ id: 'group', name: 'cordis:group', group: true, config: [{ id: 'child', name: './child.mjs' }] }]),
    name: '@deepseek-ai/dsh-agent-preset',
  }] }]))
  const patches = loadOverlayPatches('test', path)
  expect(patches[0]?.insert?.[0]?.config).toMatchObject({ plugins: [{ config: [{
    name: pathToFileURL(join(dir, 'child.mjs')).href,
  }] }] })
})
