import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import type {
  UserTextFacts, UserTextNode, UserTextRule, UserTextTransformContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '../src/client/conversation/user-text-registry.ts'
import {
  collapseWhitespaceRule, trimWhitespaceRule,
} from '../src/client/user-text/display-rules.ts'
import { sessionReferenceRule } from '../src/client/user-text/session-reference-rule.ts'

const displayRules = [trimWhitespaceRule, collapseWhitespaceRule]

function track(rule: UserTextRule) {
  return vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => rule.transform(segments, context))
}

function setup(rules: readonly UserTextRule[] = displayRules): UserTextRegistry {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  for (const rule of rules) registry.register(rule)
  return registry
}

function visible(nodes: readonly UserTextNode[]): string {
  return nodes.map(node => node.id === 'text' ? node.data.display ?? node.data.text : `[${node.id}]`).join('')
}

function assertSource(text: string, nodes: readonly UserTextNode[]): void {
  let cursor = 0
  for (const node of nodes) {
    expect(node.start).toBe(cursor)
    expect(node.end).toBeGreaterThan(cursor)
    if (node.id === 'text') expect(node.data.text).toBe(text.slice(node.start, node.end))
    cursor = node.end
  }
  expect(cursor).toBe(text.length)
  expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes)
}

function splitText(parts: readonly string[]): UserTextRule<'test.split-text'> {
  return {
    id: 'test.split-text', order: 0,
    transform() {
      let cursor = 0
      return parts.map((text): UserTextNode<'text'> => {
        const start = cursor
        cursor += text.length
        return { id: 'text', start, end: cursor, data: { text } }
      })
    },
  }
}

describe('user-text display facts', () => {
  it('declares independent boolean facts and an optional display string without new node kinds', () => {
    expectTypeOf<UserTextFacts['collapseWhitespace']>().toEqualTypeOf<boolean>()
    expectTypeOf<UserTextFacts['trimWhitespace']>().toEqualTypeOf<boolean>()
    expectTypeOf<UserTextFacts>().not.toHaveProperty('ellipsis')
    expectTypeOf<UserTextFacts>().not.toHaveProperty('interactive')
    expectTypeOf<UserTextFacts['sessionLabels']>().toEqualTypeOf<readonly string[]>()
    expectTypeOf<UserTextNode<'text'>['data']['display']>().toEqualTypeOf<string | undefined>()
  })

  it('keeps absent options as an identity no-op, including empty input', () => {
    const first = vi.fn((segments: readonly UserTextNode[]) => segments)
    const registry = setup([{ id: 'test.observe', order: 0, transform: first }, ...displayRules])
    const evaluate = registry.createEvaluator()
    const text = '  原文\r\n\t🙂e\u0301  '
    const nodes = evaluate({ text, facts: {} })
    expect(nodes).toBe(first.mock.lastCall?.[0])
    expect(evaluate({ text, facts: {} })).toBe(nodes)
    expect(nodes).toEqual([{ id: 'text', start: 0, end: text.length, data: { text } }])
    expect(evaluate({ text: '', facts: {} })).toBe(first.mock.lastCall?.[0])
    expect(evaluate({ text: '', facts: { collapseWhitespace: true, trimWhitespace: true } })).toEqual([])
  })

  it.each([
    ['collapseWhitespace', collapseWhitespaceRule, ' \t甲\r\n乙\u00a0 ', ' 甲 乙 '],
    ['trimWhitespace', trimWhitespaceRule, ' \t甲\r\n乙\u00a0 ', '甲\r\n乙'],
  ] as const)('reads only %s, recomputes missing-to-true and restores the source when withdrawn', (flag, rule, text, display) => {
    const reads: (keyof UserTextFacts)[] = []
    const transform = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => rule.transform(segments, {
      read(key) {
        reads.push(key)
        return context.read(key)
      },
    }))
    const registry = setup([{ ...rule, transform }])
    const evaluate = registry.createEvaluator()
    const original = evaluate({ text, facts: {} })
    expect(evaluate({ text, facts: { [flag]: true } })).toEqual([
      { id: 'text', start: 0, end: text.length, data: { text, display } },
    ])
    expect(evaluate({ text, facts: {} })).toBe(original)
    expect(evaluate({ text, facts: { [flag]: false } })).toBe(original)
    expect(transform).toHaveBeenCalledTimes(4)
    expect(reads).toEqual([flag, flag, flag, flag])
  })

  it('ignores unread business facts without truncating long display text', () => {
    const transforms = displayRules.map(track)
    const registry = setup(displayRules.map((rule, index) => ({ ...rule, transform: transforms[index]! })))
    const evaluate = registry.createEvaluator()
    const text = `  ${'原文🙂\n'.repeat(100)}  `
    const nodes = evaluate({ text, facts: {} })
    expect(evaluate({ text, facts: { sessionLabels: ['first'] } })).toBe(nodes)
    expect(evaluate({ text, facts: { sessionLabels: ['second'] } })).toBe(nodes)
    expect(visible(nodes)).toBe(text)
    for (const transform of transforms) expect(transform).toHaveBeenCalledOnce()
  })

  it('orders default display rules after the existing reference rule and preserves its atoms', () => {
    expect([collapseWhitespaceRule.order, trimWhitespaceRule.order]).toEqual([1010, 1020])
    expect(sessionReferenceRule.order).toBeLessThan(collapseWhitespaceRule.order)
    const content = track(sessionReferenceRule)
    const registry = setup([...displayRules, { ...sessionReferenceRule, transform: content }])
    const evaluate = registry.createEvaluator()
    const wire = '@[🧑‍🚀  引用](dsh-session:abc)'
    const text = ` \t🙂甲\n ${wire} \r\n乙🇨🇳 \t`
    const original = evaluate({ text, facts: {} })
    const nodes = evaluate({ text, facts: { collapseWhitespace: true, trimWhitespace: true } })
    expect(visible(nodes)).toBe('🙂甲 [session] 乙🇨🇳')
    expect(nodes[1]).toBe(original[1])
    expect(nodes[1]).toEqual({ id: 'session', start: text.indexOf(wire), end: text.indexOf(wire) + wire.length,
      data: { label: '🧑‍🚀  引用' } })
    expect(content).toHaveBeenCalledOnce()
    assertSource(text, nodes)
    expect(registry.createEvaluator()({ text, facts: { collapseWhitespace: true, trimWhitespace: true } })).toEqual(nodes)
  })

  it('allows a display rule to run before reference matching when its ordinary order is lower', () => {
    const observed: string[] = []
    const registry = setup([
      { ...sessionReferenceRule, order: 0, transform: (segments, context) => {
        observed.push(visible(segments))
        return sessionReferenceRule.transform(segments, context)
      } },
      { ...collapseWhitespaceRule, order: -1 },
    ])
    const text = '@[two  words](dsh-session:x)'
    const input = { text, facts: { collapseWhitespace: true } }
    const nodes = registry.createEvaluator()(input)
    expect(observed).toEqual(['@[two words](dsh-session:x)'])
    expect(nodes).toEqual([{ id: 'session', start: 0, end: text.length, data: { label: 'two  words' } }])
    assertSource(text, nodes)
  })

  it('allows custom transforms before and after the default display orders', () => {
    const observed: string[] = []
    const registry = setup([
      ...displayRules,
      { id: 'custom.before', order: 1005, transform: (segments) => {
        observed.push(visible(segments))
        return segments.map(node => node.id === 'text'
          ? { ...node, data: { ...node.data, display: `${node.data.display ?? node.data.text}\t乙  ` } } : node)
      } },
      { id: 'custom.after', order: 1021, transform: (segments) => {
        observed.push(visible(segments))
        return segments
      } },
    ])
    const text = ' 🙂 甲 '
    const facts = { collapseWhitespace: true, trimWhitespace: true }
    const nodes = registry.createEvaluator()({ text, facts })
    expect(observed).toEqual([' 🙂 甲 ', '🙂 甲 乙'])
    expect(visible(nodes)).toBe('🙂 甲 乙')
    assertSource(text, nodes)
  })

  it('composes whitespace transforms without removing emoji', () => {
    const evaluate = setup().createEvaluator()
    const text = ' \t🙂 \n甲  👨‍👩‍👧‍👦\t 乙🇨🇳 \t'
    const facts = { collapseWhitespace: true, trimWhitespace: true }
    expect(visible(evaluate({ text, facts }))).toBe('🙂 甲 👨‍👩‍👧‍👦 乙🇨🇳')
    expect(visible(evaluate({ text, facts: { trimWhitespace: true } }))).toBe(text.trim())
    expect(visible(evaluate({ text, facts: { collapseWhitespace: true } }))).toBe(' 🙂 甲 👨‍👩‍👧‍👦 乙🇨🇳 ')
    expect(visible(evaluate({ text, facts: {} }))).toBe(text)
  })

  it.each([
    { parts: ['a ', ' \nb'], expected: 'a b' },
    { parts: ['a ', '\t', ' b'], expected: 'a b' },
    { parts: ['a ', '\n', '\t', ' ', '  b'], expected: 'a b' },
    { parts: ['\t', '\n', 'a'], expected: ' a' },
    { parts: ['a ', '\n', '\t'], expected: 'a ' },
    { parts: ['a', '😀', 'b'], expected: 'a😀b' },
  ])('collapses contiguous display whitespace across adjacent Text nodes: $parts', ({ parts, expected }) => {
    const registry = setup([splitText(parts), collapseWhitespaceRule])
    const evaluate = registry.createEvaluator()
    const text = parts.join('')
    const original = evaluate({ text, facts: {} })
    const nodes = evaluate({ text, facts: { collapseWhitespace: true } })
    expect(visible(nodes)).toBe(expected)
    expect(nodes).toHaveLength(parts.length)
    if (parts[0]?.startsWith('a')) expect(nodes[0]).toBe(original[0])
    expect(evaluate({ text, facts: {} })).toBe(original)
    assertSource(text, nodes)
  })

  it('resets whitespace collapsing at each atomic reference and keeps spaces on both sides', () => {
    const parts = ['a ', '@[😀  ref](dsh-session:x)', ' ', ' \nb ', '@[tail](dsh-session:y)', ' ', '\tc']
    const registry = setup([splitText(parts), sessionReferenceRule, collapseWhitespaceRule])
    const evaluate = registry.createEvaluator()
    const text = parts.join('')
    const original = evaluate({ text, facts: {} })
    const nodes = evaluate({ text, facts: { collapseWhitespace: true } })
    expect(visible(nodes)).toBe('a [session] b [session] c')
    expect(nodes).toHaveLength(original.length)
    expect(nodes[0]).toBe(original[0])
    for (const [index, node] of nodes.entries()) {
      if (node.id === 'session') expect(node).toBe(original[index])
    }
    assertSource(text, nodes)
  })

  it.each([
    { parts: [' \t', '\t', '\n ', '甲 ', ' 乙', ' \t', '\t', '\n '], expected: '甲  乙' },
    { parts: [' \t', '\t', '\n '], expected: '' },
    { parts: ['甲 ', ' 乙'], expected: '甲  乙' },
  ])('trims only document edges across empty text displays: $parts', ({ parts, expected }) => {
    const registry = setup([splitText(parts), trimWhitespaceRule])
    const text = parts.join('')
    const evaluate = registry.createEvaluator()
    const original = evaluate({ text, facts: {} })
    const nodes = evaluate({ text, facts: { trimWhitespace: true } })
    expect(visible(nodes)).toBe(expected)
    expect(nodes).toHaveLength(parts.length)
    for (let index = 0; index < parts.length; index++) {
      if (parts[index] === '甲 ' || parts[index] === ' 乙') expect(nodes[index]).toBe(original[index])
    }
    assertSource(text, nodes)
  })

  it.each([
    [' \n@[a](dsh-session:x) \t @[b](dsh-session:y) \t', '[session] \t [session]'],
    ['@[a](dsh-session:x) \t 甲 \n @[b](dsh-session:y)', '[session] \t 甲 \n [session]'],
    ['@[a](dsh-session:x) \t 甲 \n', '[session] \t 甲'],
    [' \t 甲 \n @[b](dsh-session:y)', '甲 \n [session]'],
  ])('does not trim through visible business nodes or remove reference spacing: %s', (text, expected) => {
    const registry = setup([sessionReferenceRule, trimWhitespaceRule])
    const nodes = registry.createEvaluator()({ text, facts: { trimWhitespace: true } })
    expect(visible(nodes)).toBe(expected)
    assertSource(text, nodes)
  })

  it('preserves input identities when enabled transforms have no visible change', () => {
    const first = vi.fn((segments: readonly UserTextNode[]) => segments)
    const registry = setup([{ id: 'test.observe', order: 0, transform: first }, ...displayRules])
    const evaluate = registry.createEvaluator()
    const text = '甲 乙123'
    const original = evaluate({ text, facts: {} })
    expect(evaluate({ text, facts: { collapseWhitespace: true, trimWhitespace: true } })).toBe(original)
    expect(original).toBe(first.mock.lastCall?.[0])
  })

  it('reuses equivalent display output and stops downstream invalidation', () => {
    const first = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      context.read('sessionLabels')
      return collapseWhitespaceRule.transform(segments, context).map(node => node.id === 'text'
        ? { ...node, data: { ...node.data } } : node)
    })
    const last = track(trimWhitespaceRule)
    const registry = setup([{ ...collapseWhitespaceRule, transform: first }, { ...trimWhitespaceRule, transform: last }])
    const evaluate = registry.createEvaluator()
    const text = '甲\t乙'
    const facts = { collapseWhitespace: true, trimWhitespace: true }
    const original = evaluate({ text, facts })
    expect(evaluate({ text, facts: { ...facts, sessionLabels: ['first'] } })).toBe(original)
    expect(first).toHaveBeenCalledTimes(2)
    expect(last).toHaveBeenCalledOnce()
    expect(evaluate({ text, facts: { ...facts, sessionLabels: ['second'], trimWhitespace: false } })).toBe(original)
    expect(last).toHaveBeenCalledTimes(2)
  })
})
