/** Declaration identity and module ownership before activating a bundle. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { bundleDeclarations, bundleModuleOwner } from '../src/bundle-rows.ts'

it('reads nested declarations without requiring their target profile or preset', () => {
  const row = { id: 'child', name: './child.mjs' }
  expect(bundleDeclarations([
    { id: 'absent-group', insert: [row] },
    { preset: 'absent-preset', insert: [{ id: 'group', name: 'cordis:group', group: true, config: [row] }] },
    { preset: 'absent-preset', id: 'other', disabled: true },
  ])).toEqual([
    { row },
    { row: { id: 'group', name: 'cordis:group', group: true, config: [row] }, preset: 'absent-preset' },
    { row, preset: 'absent-preset' },
  ])
})

it('finds canonical owners for bare, relative, absolute, and file URL modules without evaluating them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-owner-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const packageDir = join(dir, 'node_modules', 'fixture')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  const manifest = join(packageDir, 'package.json')
  writeFileSync(manifest, '{"name":"fixture","version":"1.0.0","exports":"./lib/index.mjs"}\n')
  const module = join(packageDir, 'lib', 'index.mjs')
  writeFileSync(module, 'throw new Error("must not import ownership probes")\n')
  const base = pathToFileURL(join(dir, 'profile.json')).href
  await ctx.plugin(PluginPackages)
  const expected = realpathSync(manifest)
  expect(bundleModuleOwner('fixture', base, ctx.pluginPackages)).toBe(expected)
  expect(bundleModuleOwner('fixture/lib/index.mjs', base, ctx.pluginPackages)).toBe(expected)
  expect(bundleModuleOwner('./node_modules/fixture/lib/index.mjs', base)).toBe(expected)
  expect(bundleModuleOwner(module, base)).toBe(expected)
  expect(bundleModuleOwner(pathToFileURL(module).href, base)).toBe(expected)
  expect(bundleModuleOwner('cordis:group', base)).toBeUndefined()
  expect(bundleModuleOwner('uninstalled', base)).toBeUndefined()
  expect(bundleModuleOwner('./absent.mjs', base)).toBeUndefined()
  const loose = join(dir, 'loose.mjs')
  writeFileSync(loose, '')
  expect(bundleModuleOwner(loose, base)).toBeUndefined()
  const linked = join(dir, 'linked')
  symlinkSync(packageDir, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(bundleModuleOwner(pathToFileURL(join(linked, 'lib/index.mjs')).href, base)).toBe(expected)
  const otherPackage = join(dir, 'other-package')
  mkdirSync(otherPackage)
  writeFileSync(join(otherPackage, 'package.json'), '{"name":"other-package"}\n')
  const otherModule = join(otherPackage, 'foreign.mjs')
  writeFileSync(otherModule, 'export function apply() {}\n')
  const fileLink = join(packageDir, 'borrowed.mjs')
  symlinkSync(otherModule, fileLink, 'file')
  expect(bundleModuleOwner(fileLink, base)).toBe(realpathSync(join(otherPackage, 'package.json')))

})
