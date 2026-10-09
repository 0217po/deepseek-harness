// @vitest-environment jsdom
import { globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GuideArtworkBrowser, GuideArtworkFiles,
  PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkSubagent, PluginArtworkTerminal,
} from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

const packagesRoot = resolve(import.meta.dirname, '../../..')
const packageIcons = globSync('*/*/package.json', { cwd: packagesRoot }).sort().flatMap((path) => {
  const manifest = JSON.parse(readFileSync(join(packagesRoot, path), 'utf8')) as { icon?: string }
  return manifest.icon === undefined ? [] : [join(dirname(path), manifest.icon)]
})

/** Package SVGs render as separate images; inline React artwork can use HTML and per-instance ids. */
function assertPackageArtwork(source: string): void {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml')
  expect(document.querySelector('parsererror')).toBeNull()
  const svg = document.documentElement
  expect(svg.localName).toBe('svg')
  expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
  expect(svg.getAttribute('viewBox')).toBe('0 0 36 36')
  expect(svg.getAttribute('width')).toBe('36')
  expect(svg.getAttribute('height')).toBe('36')
  expect(svg.querySelector('path, rect, circle, ellipse, line, polyline, polygon')).not.toBeNull()
  expect(svg.querySelector('script, style, image, foreignObject, text, animate, animateTransform, animateMotion, set')).toBeNull()
  const elements = [svg, ...svg.querySelectorAll('*')]
  const ids = elements.flatMap(element => element.hasAttribute('id') ? [element.id] : [])
  expect(new Set(ids).size).toBe(ids.length)
  for (const element of elements) {
    for (const attribute of element.attributes) {
      expect(attribute.name).not.toMatch(/^on/i)
      const references = [...attribute.value.matchAll(/url\(([^)]+)\)/g)].map(match => (match[1] ?? '').replace(/['"]/g, '').trim())
      if (attribute.localName === 'href') references.push(attribute.value)
      for (const reference of references) {
        expect(reference).toMatch(/^#/)
        expect(ids).toContain(reference.slice(1))
      }
    }
  }
}

const artworks = {
  GuideArtworkBrowser,
  GuideArtworkFiles,
  PluginArtworkTerminal,
  PluginArtworkLoop,
  PluginArtworkSubagent,
  PluginArtworkSearch,
  PluginArtworkDefault,
} as const

describe('package plugin artwork', () => {
  const valid = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"><defs><linearGradient id="ink"><stop stop-color="#69B9FF" /></linearGradient></defs><path d="M8 8H28V28H8Z" fill="url(#ink)" /></svg>'

  it('discovers a nonempty set of package-manifest artwork', () => {
    expect(packageIcons.length).toBeGreaterThan(0)
  })

  it.each(packageIcons)('%s is a self-contained 36-unit SVG image', (path) => {
    assertPackageArtwork(readFileSync(join(packagesRoot, path), 'utf8'))
  })

  it('accepts a local gradient reference', () => {
    assertPackageArtwork(valid)
  })

  it.each([
    ['malformed XML', valid.replace('</svg>', '')],
    ['toolbar canvas', valid.replace('0 0 36 36', '0 0 16 16')],
    ['toolbar width', valid.replace('width="36"', 'width="16"')],
    ['toolbar height', valid.replace('height="36"', 'height="16"')],
    ['missing definition', valid.replace('url(#ink)', 'url(#missing)')],
    ['external definition', valid.replace('url(#ink)', 'url(https://example.test/ink.svg#ink)')],
    ['external href', valid.replace('<path ', '<path href="https://example.test/icon.svg" ')],
    ['duplicate ids', valid.replace('<path ', '<path id="ink" ')],
    ['event handler', valid.replace('<path ', '<path onload="run()" ')],
    ['empty artwork', valid.replace(/<path[^>]+\/>/, '')],
    ...['script', 'style', 'image', 'foreignObject', 'text', 'animate', 'animateTransform', 'animateMotion', 'set']
      .map(tag => [tag, valid.replace('</svg>', `<${tag} /></svg>`)]),
  ])('rejects %s', (_name, source) => {
    expect(() => { assertPackageArtwork(source) }).toThrow()
  })
})

describe('plugin artwork', () => {
  it.each(Object.entries(artworks))('%s renders its 36-viewBox svg honoring size and className', (_name, Artwork) => {
    const { container } = render(<Artwork size={30} className="deco" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 36 36')
    expect(svg?.getAttribute('width')).toBe('30')
    expect(svg?.getAttribute('height')).toBe('30')
    expect(svg?.getAttribute('class')).toBe('deco')
  })

  it('clips the search ring through its per-instance clipPath around the conic-gradient div', () => {
    const { container } = render(<PluginArtworkSearch />)
    const clipId = container.querySelector('clipPath')?.id ?? ''
    expect(clipId).not.toBe('')
    expect(container.querySelector('g[clip-path]')?.getAttribute('clip-path')).toBe(`url(#${clipId})`)
    expect(container.querySelector('foreignObject div')).not.toBeNull()
  })

  it('pairs the search green with the loop upper-right blue-violet in its ring and handle', () => {
    const { container } = render(<PluginArtworkSearch />)
    const ring = container.querySelector<HTMLElement>('foreignObject div')
    expect(ring?.style.background).toBe('conic-gradient(from 90deg, rgb(65, 225, 172) 0deg, rgb(101, 142, 255) 62.0619deg, rgb(65, 225, 172) 360deg)')
    expect(container.querySelector('path[stroke]')?.getAttribute('stroke')).toBe('#658EFF')
  })

  it('uses light blue for both terminal strokes', () => {
    const { container } = render(<PluginArtworkTerminal />)
    const strokes = [...container.querySelectorAll('path')].map(path => path.getAttribute('stroke'))
    expect(strokes).toEqual(['#679EFE', '#679EFE'])
    expect(container.querySelector('linearGradient')).toBeNull()
  })

  it.each(Object.entries(artworks))('%s renders at 36 by default and repeats without document-global ids', (_name, Artwork) => {
    const { container } = render(
      <>
        <Artwork />
        <Artwork />
      </>,
    )
    for (const svg of container.querySelectorAll('svg')) expect(svg.getAttribute('width')).toBe('36')
    const ids = [...container.querySelectorAll('[id]')].map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const reference of container.querySelectorAll('[fill^="url("], [stroke^="url("], [clip-path^="url("]')) {
      const target = (reference.getAttribute('fill') ?? reference.getAttribute('stroke') ?? reference.getAttribute('clip-path') ?? '').slice('url(#'.length, -1)
      expect(ids).toContain(target)
    }
  })
})
