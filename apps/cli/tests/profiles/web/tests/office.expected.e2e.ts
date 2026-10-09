/** Web rendering is independent of optional authoring runtimes. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { workspaceDependencyPaths, type PrimaryRuntimeManifest } from '../../../../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { withDefaultWeb } from './default-web-process.ts'

it.for(['web', 'desktop-resources', 'explicit-runtime', 'disabled'] as const)('keeps Office rendering available while scoping authoring runtimes (%s)', async (carrier, test) => {
  const enabled = carrier === 'desktop-resources' || carrier === 'explicit-runtime'
  const env: NodeJS.ProcessEnv = {
    DSH_PRIMARY_RUNTIME: undefined, DSH_BUNDLED_PRIMARY_RUNTIME: undefined, DSH_BUNDLED_PRIMARY_RUNTIME_ROOT: undefined,
  }
  await withDefaultWeb(test, async ({ root, request }) => {
    const roster = await request('office-catalog')
    expect(roster.office?.names.filter(name => name.startsWith('office'))).toEqual(['office'])
    expect(roster.office?.tools.includes('load_workspace_dependencies')).toBe(enabled)
    expect(roster.office?.tools).not.toContain('office_tools')
    expect(roster.office?.tools).not.toContain('render_document')
    expect(roster.plugins.some(plugin => plugin.name === 'office-commands')).toBe(true)
    await expect(readFile(join(root, 'home', 'profiles', 'web', 'runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(roster.office?.instructions).toContain('python-docx')
    expect(roster.office?.instructions).toContain('office-check')
    expect(roster.office?.instructions).toContain('If `office-check` is unavailable')
    expect(roster.office?.instructions).not.toContain('carrier-runtime')
    if (!enabled) return
    const target = carrier === 'desktop-resources' ? join(root, 'installed') : join(root, 'carrier-runtime', 'primary-runtime')
    const manifest = JSON.parse(await readFile(join(root, 'carrier-runtime', 'primary-runtime', 'runtime.json'), 'utf8')) as PrimaryRuntimeManifest
    expect((await request('office-dependencies')).dependencies).toEqual({ isError: false, python: workspaceDependencyPaths(target, manifest).python })
  }, {
    env,
    async prepare(root) {
      if (carrier === 'web') return
      const source = join(root, 'carrier-runtime', 'primary-runtime')
      const manifest: PrimaryRuntimeManifest = { desktopVersion: 'test', platform: process.platform, arch: process.arch,
        python: '3.12.14', node: '24.11.0', pnpm: '11.7.0', pythonPackages: {} }
      const paths = workspaceDependencyPaths(source, manifest)
      for (const path of [paths.python, paths.node!, paths.pnpm!]) {
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'carrier runtime fixture')
      }
      await mkdir(paths.pythonPackages, { recursive: true }); await mkdir(paths.nodePackages!, { recursive: true })
      await writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
      await cp(fileURLToPath(new URL('../../../../../../packages/skill/skill-office/assets', import.meta.url)), join(dirname(source), 'office-skills'), { recursive: true })
      if (carrier === 'explicit-runtime') env.DSH_PRIMARY_RUNTIME = source
      else {
        env.DSH_BUNDLED_PRIMARY_RUNTIME = source
        env.DSH_BUNDLED_PRIMARY_RUNTIME_ROOT = join(root, 'installed')
        if (carrier === 'disabled') env.DSH_PRIMARY_RUNTIME = ''
      }
    },
  })
})

it.skipIf(process.platform !== 'win32')('renders and converts with the bundled Kit inside the default Windows sandbox', async (test) => {
  await withDefaultWeb(test, async ({ root, request }) => {
    const result = await request('office-render')
    for (const shell of result.officeShell!) {
      expect(shell.timedOut, shell.stderr).toBe(false)
      expect(shell.exitCode, shell.stderr).toBe(0)
      expect(shell.sandboxMode).toBe('workspace-write')
    }
    expect(result.officeShell).toHaveLength(2)
    const png = await readFile(join(root, 'rendered', 'page-0001.png'))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect((await readFile(join(root, 'converted.pdf'))).subarray(0, 5).toString()).toBe('%PDF-')
  }, { async prepare(root) {
    await cp(fileURLToPath(new URL('../../../../../../scripts/fixtures/office-render/color-blocks.docx', import.meta.url)), join(root, 'input.docx'))
  } })
})
