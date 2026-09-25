/** Plugin selection, persistent execution and restoration through the existing Web switch. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import { expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('keeps Computer Use off by default and persists its explicit profile-wide PTC switch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cua-optin-web-'))
  let ownedScaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const patch = join(directory, 'native-fixture.yml')
    // Native execution is outside this UI scenario; the provider must not spawn it while merely enabled.
    await writeFile(patch, JSON.stringify([{ id: 'cua', config: { helperPath: process.execPath } }]))
    const scaffold = ownedScaffold = await launchWebScaffold({ extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), patch,
    ] })
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]')
    const toggle = card.getByRole('switch', { name: '启用 Computer Use', exact: true })
    await toggle.waitFor()
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    expect(await card.getByText('实验性', { exact: true }).count()).toBe(1)
    expect(await card.textContent()).toContain('persistent PTC')
    expect(await card.textContent()).not.toContain('Swift')
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe('function-body')
    expect(scaffold.ctx.get('computerUse')).toBeUndefined()
    const selected = async () => JSON.parse(await readFile(join(scaffold.harnessHome, 'profiles/scaffold/package.json'), 'utf8')).dsh.profile.bundles as string[]
    expect(await selected()).not.toContain('@deepseek-ai/dsh-cua-bundle')

    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    await expect.poll(() => scaffold.ctx.ptcRuntime.programFormat).toBe('repl')
    expect(await selected()).toContain('@deepseek-ai/dsh-cua-bundle')
    expect(scaffold.ctx.get('computerUse')).toBeDefined()
    const runtime = scaffold.ctx.ptcRuntime
    const stateOwner = {}
    const program = 'globalThis.counter = (globalThis.counter ?? 0) + 1'
    for (const value of [1, 2]) {
      expect((await runtime.run(runtime.resolve({ program, bindings: [], stateOwner }))).value).toBe(value)
    }
    await toggle.click()
    await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
    await expect.poll(() => scaffold.ctx.ptcRuntime.programFormat).toBe('function-body')
    expect(await selected()).not.toContain('@deepseek-ai/dsh-cua-bundle')
    expect(scaffold.ctx.get('computerUse')).toBeUndefined()
  } finally {
    try { await browser?.close() } finally {
      try { await ownedScaffold?.close() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
})
