/** Desktop resource resolution feeding the shared, patchable Web composition. */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { desktopOfficeEnvironment } from '../src/office.ts'

it('supplies carrier resource paths without installing tools or changing the environment', () => {
  const before = { ...process.env }
  const root = process.cwd()
  const source = join(root, 'runtime', 'primary-runtime')
  expect(desktopOfficeEnvironment({ source, root: join(root, 'installed'), runtimeDir: join(root, 'dsh') })).toEqual({
    DSH_BUNDLED_PRIMARY_RUNTIME: source,
    DSH_BUNDLED_PRIMARY_RUNTIME_ROOT: join(root, 'installed'),
    DSH_BUNDLED_OFFICE_CLI: join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))), 'lib', 'cli.js'),
  })
  expect(process.env).toEqual(before)
})
