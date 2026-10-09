/** Entry-page insets are checked as CSS because jsdom does not lay out window chrome. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/PluginManagerPage.module.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
  selectors: (match[1] ?? '').split(',').map(selector => selector.trim()),
  declarations: (match[2] ?? '').split(';').map(declaration => declaration.trim()),
}))

function topInsets(selector: string): string[] {
  return rules.filter(rule => rule.selectors.includes(selector))
    .flatMap(rule => rule.declarations.filter(declaration => /^padding(?:-top)?:/.test(declaration)))
}

describe('Plugins entry-page titlebar clearance', () => {
  it.each(['.pageHead', '.moreHead', '.detailTop'])('%s keeps the browser inset and adds macOS clearance only once', (selector) => {
    expect(topInsets(selector)).toEqual(['padding-top: 28px'])
    expect(topInsets(`:global([data-platform='darwin']) ${selector}`))
      .toEqual(['padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px))'])
  })

  it('leaves the top inset with the header rather than the scrolling page', () => {
    expect(topInsets('.page')).toEqual(['padding: 0 clamp(24px, 4vw, 48px) 48px'])
  })

  it('does not redefine shared clearance or reference it outside the macOS headers', () => {
    expect(css).not.toMatch(/--dsh-frame-top-clearance\s*:/)
    const clearanceRules = rules.filter(rule => rule.declarations.some(declaration => declaration.includes('--dsh-frame-top-clearance')))
    expect(clearanceRules.flatMap(rule => rule.selectors)).toEqual([
      ":global([data-platform='darwin']) .pageHead",
      ":global([data-platform='darwin']) .detailTop",
      ":global([data-platform='darwin']) .moreHead",
    ])
  })
})
