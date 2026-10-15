import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

it.each(['macos', 'windows'])('%s packaging accepts test branches but preserves production and tag restrictions', (platform) => {
  const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, `../.github/workflows/${platform}-package.yml`), 'utf8')) as {
    jobs: { package: { steps: Array<{ name?: string; run?: string }> } }
  }
  const command = workflow.jobs.package.steps.find(step => step.name === 'Validate selected source and adapter support')!.run!
  const script = command.slice('node -e "'.length, -1)
  const root = mkdtempSync(join(tmpdir(), 'desktop-source-'))
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
    git('init', '--initial-branch=master')
    mkdirSync(join(root, 'apps/desktop/scripts'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{"version":"1.0.0"}')
    writeFileSync(join(root, 'apps/desktop/scripts/desktop-ci-version.mjs'), 'PACKAGE_VERSION_MODE')
    git('add', '.')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
    const sha = git('rev-parse', 'HEAD')
    git('tag', 'dsh-v1.0.0')
    git('tag', 'dsh-v2.0.0')
    const run = (preset: string, ref: string) => {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: root, encoding: 'utf8', env: { ...process.env, DSH_PACKAGING_PRESET: preset, PACKAGE_SOURCE_REF: ref },
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      return result.status
    }
    for (const preset of ['test', 'production']) expect(run(preset, 'master')).toBe(0)
    git('checkout', '-b', 'feature/desktop-update')
    expect(run('test', 'feature/desktop-update')).toBe(0)
    expect(run('production', 'feature/desktop-update')).not.toBe(0)
    expect(run('test', 'refs/pull/42/head')).not.toBe(0)
    expect(run('test', 'refs/heads/feature/desktop-update')).not.toBe(0)
    expect(run('unknown', 'feature/desktop-update')).not.toBe(0)
    git('checkout', '--detach', sha)
    expect(run('test', sha)).not.toBe(0)
    expect(run('test', 'master')).not.toBe(0)
    for (const preset of ['test', 'production']) expect(run(preset, 'dsh-v1.0.0')).toBe(0)
    expect(run('test', 'dsh-v2.0.0')).not.toBe(0)
    writeFileSync(join(root, 'apps/desktop/scripts/desktop-ci-version.mjs'), 'old adapter')
    expect(run('test', 'dsh-v1.0.0')).not.toBe(0)
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
})
