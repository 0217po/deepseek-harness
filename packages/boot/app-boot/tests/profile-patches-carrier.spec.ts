/** Patch identities work with archive-backed files and preserve physical filesystem aliases. */
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { loadOverlayPatches, realModuleFile } from '../src/index.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: actual.realpathSync.native }) }
})

afterEach(() => { vi.mocked(realpathSync).mockReset() })

function packagedRuntime(): void {
  const previous = Object.getOwnPropertyDescriptor(process, 'pkg')
  Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
  onTestFinished(() => {
    if (previous === undefined) Reflect.deleteProperty(process, 'pkg')
    else Object.defineProperty(process, 'pkg', previous)
  })
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'profile-patch-carrier-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

it('loads ordinary and anonymous scoped patches when packaged files support reads and directory realpath', () => {
  packagedRuntime()
  const root = fixture()
  const file = join(root, 'cordis.patch.yml')
  writeFileSync(file, JSON.stringify([
    { insert: [{ id: 'base', name: 'base' }] },
    { preset: 'preset-standard', insert: [{ name: 'anonymous' }] },
  ]))
  vi.mocked(realpathSync).mockImplementation((path, options) => {
    if (lstatSync(path).isFile()) throw Object.assign(new Error('archive file has no physical realpath'), { code: 'ENOENT' })
    return realpathSync.native(path, options)
  })
  expect(() => realpathSync(file)).toThrow('archive file has no physical realpath')
  const first = loadOverlayPatches('test', file)
  expect(first[0]).toEqual({ insert: [{ id: 'base', name: 'base' }] })
  expect(first[1]?.insert?.[0]).toEqual({ id: expect.any(String) as string, name: 'anonymous' })
  expect(loadOverlayPatches('test', file)).toEqual(first)
  expect(realModuleFile(file)).toBe(join(realpathSync(root), 'cordis.patch.yml'))
})

it.each([false, true])('keeps directory and file symlinks on the same patch identity (packaged: %s)', (packaged) => {
  if (packaged) packagedRuntime()
  const root = fixture()
  const directory = join(root, 'bundle')
  mkdirSync(directory)
  const file = join(directory, 'Patch.yml')
  writeFileSync(file, JSON.stringify([{ preset: 'preset-standard', insert: [{ name: 'anonymous' }] }]))
  const directoryAlias = join(root, 'bundle-alias')
  const fileAlias = join(root, 'patch-alias.yml')
  symlinkSync(directory, directoryAlias, process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(file, fileAlias, 'file')
  const first = loadOverlayPatches('test', file)
  expect(loadOverlayPatches('test', join(directoryAlias, 'Patch.yml'))).toEqual(first)
  expect(loadOverlayPatches('test', fileAlias)).toEqual(first)
  expect(realModuleFile(fileAlias)).toBe(realpathSync(file))
})

it('keeps ordinary physical resource normalization identical to Node realpath', () => {
  const root = fixture()
  const file = join(root, 'MixedCase.yml')
  writeFileSync(file, '[]\n')
  const requested = process.platform === 'win32' ? file.toLowerCase() : file
  expect(realModuleFile(requested)).toBe(realpathSync(requested))
})

it('reports missing packaged resources instead of assigning them an identity', () => {
  packagedRuntime()
  expect(() => realModuleFile(join(fixture(), 'absent.yml'))).toThrow('ENOENT')
})
