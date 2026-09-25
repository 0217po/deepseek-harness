/** Native preparation follows the same persisted bundle selection as the Web switch. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { computerUseSelected } from './build-cua.ts'

it('does not create or select a profile when Computer Use has not been enabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cua-selection-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  expect(computerUseSelected(home, 'web')).toBe(false)
  const directory = join(home, 'profiles/web')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), '{}')
  expect(computerUseSelected(home, 'web')).toBe(false)
})

it('reads enable and disable changes from the existing profile manifest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cua-selection-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, 'profiles/web')
  await mkdir(directory, { recursive: true })
  for (const enabled of [false, true, false]) {
    const bundles = ['@deepseek-ai/dsh-base', ...(enabled ? ['@deepseek-ai/dsh-cua-bundle'] : [])]
    await writeFile(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
    expect(computerUseSelected(home, 'web')).toBe(enabled)
    expect(computerUseSelected(home, 'another-profile')).toBe(false)
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: 'cua' } } }))
  expect(() => computerUseSelected(home, 'web')).toThrow('string array')
})
