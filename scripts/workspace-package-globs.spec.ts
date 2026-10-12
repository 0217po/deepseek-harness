/** Windows manifest paths still select the packages whose artifacts Desktop bundles. */
import { globSync } from 'node:fs'
import { resolve, win32 } from 'node:path'
import { expect, it } from 'vitest'
import { workspacePackageGlobs } from './workspace-package-globs.ts'

it('selects workspace packages from Windows and POSIX manifest paths', () => {
  const cwd = resolve(import.meta.dirname, '..')
  const manifests = ['packages\\util\\atomic-write\\package.json', 'vendor/cordis/package.json']
  const selected = globSync(workspacePackageGlobs(manifests), { cwd }).map(path => path.replaceAll('\\', '/')).sort()
  expect(selected).toEqual(['packages/util/atomic-write', 'vendor/cordis'])
  expect(globSync(manifests.map(path => win32.dirname(path)), { cwd })).toEqual([])
})
