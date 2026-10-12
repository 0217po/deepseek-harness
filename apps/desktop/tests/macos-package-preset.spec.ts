import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { expect, it } from 'vitest'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'

it('loads machine signing credentials independently of the checkout and rejects misplaced settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'macos-preset-'))
  try {
    await mkdir(join(root, 'presets'))
    await mkdir(join(root, 'secrets'))
    const preset = join(root, 'presets/test.env')
    const secrets = join(root, 'secrets/macos-signing.env')
    await writeFile(preset, 'DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDSH_DESKTOP_MACOS_PACK_CONCURRENCY=2\nDSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR=/machine/cache\n')
    await writeFile(secrets, 'CSC_LINK=../certificates/app.p12\nCSC_KEY_PASSWORD=machine-secret\nAPPLE_API_KEY=../certificates/key.p8\n')
    const env = { DSH_PACKAGING_PRESET: 'test', DSH_PACKAGING_CONFIG_DIR: root, CSC_KEY_PASSWORD: 'ambient-secret' }
    for (const options of [{}, { prepareOnly: true }]) {
      const selected = loadDesktopPackageEnvironment('darwin', env, join(root, 'absent-checkout'), options)
      expect(selected.CSC_LINK).toBe(join(root, 'certificates/app.p12'))
      expect(selected.APPLE_API_KEY).toBe(join(root, 'certificates/key.p8'))
      expect(selected.CSC_KEY_PASSWORD).toBe('machine-secret')
      expect(selected.DSH_DESKTOP_MACOS_PACK_CONCURRENCY).toBe('2')
      expect(selected.DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR).toBe('/machine/cache')
    }
    await rm(secrets)
    expect(loadDesktopPackageEnvironment('darwin', env, root, { unsigned: true }).CSC_KEY_PASSWORD).toBeUndefined()
    expect(() => loadDesktopPackageEnvironment('darwin', env)).toThrow(/cannot read/u)
    await writeFile(secrets, 'DSH_DESKTOP_MACOS_DOWNLOAD_PROXY=http://localhost:1234\n')
    expect(() => loadDesktopPackageEnvironment('darwin', env)).toThrow(/unsupported setting/u)
    await writeFile(preset, 'DSH_DESKTOP_AUTO_UPDATE_ENV=test\nCSC_KEY_PASSWORD=private-value\n')
    expect(() => loadDesktopPackageEnvironment('darwin', env)).toThrow(/unsupported setting CSC_KEY_PASSWORD/u)
    expect(() => loadDesktopPackageEnvironment('darwin', env)).not.toThrow(/private-value/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform !== 'darwin')('prepares private machine directories without overwriting existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'macos-setup-'))
  try {
    const machine = join(await realpath(root), 'machine')
    const run = (...args: string[]) => spawnSync(process.execPath,
      [join(import.meta.dirname, '../scripts/setup-macos-packaging.mjs'), machine, ...args], { encoding: 'utf8' })
    expect(run().status).toBe(0)
    const config = join(machine, 'packaging/presets/test.env.example')
    expect(parseEnv(await readFile(config, 'utf8')).DSH_DESKTOP_MACOS_SIGNATURE_CACHE_DIR).toBe(join(machine, 'cache/macos-signatures'))
    await writeFile(config, 'keep existing configuration\n')
    expect(run().status).toBe(0)
    expect(await readFile(config, 'utf8')).toBe('keep existing configuration\n')
    expect(run('--check').status).toBe(0)
    await rm(join(machine, 'packaging/secrets'), { recursive: true })
    const missing = run('--check')
    expect(missing.error).toBeUndefined()
    expect(missing.signal).toBeNull()
    expect(missing.status).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
