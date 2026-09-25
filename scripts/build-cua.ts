/** Prepare native components only when selected by the existing Web profile. */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { buildNativeExecutable } from '../packages/computer-use/cua/src/native-build.ts'

/**
 * Read the existing plugin selection without creating or mutating a profile.
 * @param home - Harness home used by the application launch.
 * @param profile - Profile whose optional bundle selection controls preparation.
 * @returns Whether Computer Use is selected in that profile.
 */
export function computerUseSelected(home: string, profile: string): boolean {
  const directory = join(home, 'profiles', profile)
  if (!existsSync(join(directory, 'package.json'))) return false
  const manifest = readProfileManifest('build:cua', directory)
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles === undefined) return false
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) throw new Error('build:cua: profile bundles must be a string array')
  return bundles.includes('@deepseek-ai/dsh-cua-bundle')
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    force: { type: 'boolean', default: false }, profile: { type: 'string', default: 'web' },
    arch: { type: 'string' },
  }, allowPositionals: false })
  const selected = values.force || computerUseSelected(resolveDshHome(), values.profile)
  if (!selected || process.platform !== 'darwin') return
  const architecture = values.arch ?? process.arch
  if (architecture !== 'arm64' && architecture !== 'x64') throw new Error(`build:cua: unsupported architecture ${architecture}`)
  const ctx = new Context()
  const controller = new AbortController()
  const stop = () => { controller.abort() }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    await ctx.plugin(Subprocess)
    const helper = await buildNativeExecutable({
      packageRoot: resolve(import.meta.dirname, '../packages/computer-use/cua'),
      architecture, subprocess: ctx.subprocess, signal: controller.signal,
      timeoutMs: 600_000, graceMs: 3000,
    })
    console.log(`build:cua: ready ${helper}`)
  } finally {
    try { await ctx.fiber.dispose() } finally {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
  }
}

if (import.meta.main) await main()
