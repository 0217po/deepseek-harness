import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import type {
  UserTextDataMap, UserTextDocumentInput, UserTextEvaluator, UserTextNode, UserTextRule, UserTextTransformContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UserTextRegistry } from '../src/client/conversation/user-text-registry.ts'

interface AnnotationData {
  readonly label: string
  readonly nested?: { readonly values: readonly (string | number | boolean | null)[] }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'test.annotation': AnnotationData
    'test.A': { readonly label: string }
    'test.a': { readonly label: string }
    'test.z': { readonly label: string }
    '': { readonly label: string }
    'test.function': { readonly callback: () => void }
    'test.date': { readonly date: Date }
    'test.map': { readonly map: Map<string, string> }
    'test.symbol': { readonly symbol: symbol }
    'test.bigint': { readonly bigint: bigint }
    'test.unknown': { readonly value: unknown }
    'test.nested': { readonly values: readonly { readonly action: () => void }[] }
  }
  interface UserTextFacts {
    readonly testEnabled: boolean
    readonly testLabel: string
    readonly testNested: NonNullable<AnnotationData['nested']>
    readonly testOther: number
    readonly skillNames: readonly string[]
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { userTextTestRegistry: UserTextRegistry }
}

function setup(): { ctx: Context; registry: UserTextRegistry } {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  return { ctx, registry: new UserTextRegistry(ctx) }
}

type TestId = 'test.A' | 'test.a' | 'test.z' | ''

function plain(text: string, start = 0): UserTextNode<'text'> {
  return { id: 'text', start, end: start + text.length, data: { text } }
}

function claim(segments: readonly UserTextNode[], id: TestId, needle: string, label: string = id): readonly UserTextNode[] {
  let changed = false
  const result = segments.flatMap((node): UserTextNode[] => {
    if (node.id !== 'text') return [node]
    const index = node.data.text.indexOf(needle)
    if (index < 0) return [node]
    changed = true
    const start = node.start + index
    const end = start + needle.length
    return [
      ...(index > 0 ? [plain(node.data.text.slice(0, index), node.start)] : []),
      { id, start, end, data: { label } },
      ...(end < node.end ? [plain(node.data.text.slice(index + needle.length), end)] : []),
    ]
  })
  return changed ? result : segments
}

function rule(id: TestId, order: number, needle: string): UserTextRule<TestId> {
  return { id, order, transform: segments => claim(segments, id, needle) }
}

function assertCoverage(text: string, nodes: readonly UserTextNode[]): void {
  let cursor = 0
  for (const node of nodes) {
    expect(node.start).toBe(cursor)
    expect(node.end).toBeGreaterThan(node.start)
    if (node.id === 'text') expect(node.data.text).toBe(text.slice(node.start, node.end))
    cursor = node.end
  }
  expect(cursor).toBe(text.length)
  expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes)
}

describe('UserTextRegistry linear transforms', () => {
  it('initializes empty text as [] and nonempty UTF-16 text as one verbatim segment', () => {
    const { registry } = setup()
    const transform = vi.fn((segments: readonly UserTextNode[]) => segments)
    registry.register({ id: 'test.a', order: 0, transform })
    const evaluate = registry.createEvaluator()
    expectTypeOf(evaluate).toEqualTypeOf<UserTextEvaluator>()
    expect(evaluate({ text: '', facts: {} })).toEqual([])
    const text = '  原文\r\n\t🙂e\u0301 /path @name  '
    const nodes = evaluate({ text, facts: {} })
    expect(nodes).toEqual([plain(text)])
    expect(transform.mock.lastCall?.[0]).toBe(nodes)
    assertCoverage(text, nodes)
  })

  it('runs B against remaining de after A claims bc, rather than filtering whole-text candidates', () => {
    const { registry } = setup()
    const first = vi.fn((segments: readonly UserTextNode[]) => claim(segments, 'test.a', 'bc'))
    const second = vi.fn((segments: readonly UserTextNode[]) => {
      expect(segments.map(node => node.id === 'text' ? node.data.text : node.id)).toEqual(['a', 'test.a', 'de'])
      return claim(segments, 'test.z', 'de')
    })
    registry.register({ id: 'test.z', order: 1, transform: second })
    registry.register({ id: 'test.a', order: 0, transform: first })
    const nodes = registry.createEvaluator()({ text: 'abcde', facts: {} })
    expect(nodes).toEqual([
      plain('a'), { id: 'test.a', start: 1, end: 3, data: { label: 'test.a' } },
      { id: 'test.z', start: 3, end: 5, data: { label: 'test.z' } },
    ])
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it.each([
    [rule('test.a', 10, 'bc'), rule('test.z', -1, 'cde'), 'test.z'],
    [rule('test.a', -1, 'bc'), rule('test.z', 0, 'bcde'), 'test.a'],
    [rule('test.a', 0, 'bc'), rule('test.z', 0, 'bcde'), 'test.a'],
    [rule('test.A', 0, 'bc'), rule('test.a', 0, 'bcde'), 'test.A'],
  ] as const)('sorts by order then code-unit ID independently of load order (%j, %j)', (a, z, id) => {
    const { registry: forward } = setup()
    const { registry: reverse } = setup()
    forward.register(a)
    forward.register(z)
    reverse.register(z)
    reverse.register(a)
    const input = { text: 'abcde', facts: {} }
    const nodes = forward.createEvaluator()(input)
    expect(nodes.filter(node => node.id !== 'text').map(node => node.id)).toEqual([id])
    expect(reverse.createEvaluator()(input)).toEqual(nodes)
  })

  it('sorts arbitrary business labels only by order and code-unit ID', () => {
    const { registry } = setup()
    const seen: string[] = []
    for (const definition of [
      { id: 'display.z', order: -100 },
      { id: 'content.late', order: 10_000 },
      { id: 'display.A', order: -100 },
      { id: 'content.default', order: 0 },
      { id: 'display.first', order: -101 },
    ]) {
      registry.register({ ...definition, transform: (segments) => { seen.push(definition.id); return segments } })
    }
    registry.createEvaluator()({ text: 'abc', facts: {} })
    expect(seen).toEqual(['display.first', 'display.A', 'display.z', 'content.default', 'content.late'])
    expectTypeOf<UserTextRule>().not.toHaveProperty('phase')
  })

  it.each([-100, 100])('allows ordinary display updates at order %s before or after business claims', (order) => {
    const { registry } = setup()
    registry.register({ id: 'test.split', order: -200, transform: () => [plain('a'), plain('b', 1), plain('c', 2)] })
    registry.register(rule('test.a', 0, 'b'))
    const seen: string[][] = []
    registry.register({
      id: 'test.presentation', order,
      transform: (segments) => {
        seen.push(segments.map(node => node.id))
        return segments.map(node => node.id === 'text'
          ? { ...node, data: { ...node.data, display: node.data.text.toUpperCase() } } : node)
      },
    })
    const nodes = registry.createEvaluator()({ text: 'abc', facts: {} })
    expect(seen).toEqual([order < 0 ? ['text', 'text', 'text'] : ['text', 'test.a', 'text']])
    expect(nodes).toEqual([
      { ...plain('a'), data: { text: 'a', display: 'A' } },
      { id: 'test.a', start: 1, end: 2, data: { label: 'test.a' } },
      { ...plain('c', 2), data: { text: 'c', display: 'C' } },
    ])
    assertCoverage('abc', nodes)
  })

  it('allows one transform to split Text, update display and create its own business node', () => {
    const { registry } = setup()
    registry.register({
      id: 'test.a', order: 0,
      transform: () => [
        { ...plain('a'), data: { text: 'a', display: 'A' } },
        { id: 'test.a', start: 1, end: 2, data: { label: 'claimed' } },
        { ...plain('c', 2), data: { text: 'c', display: '' } },
      ],
    })
    const nodes = registry.createEvaluator()({ text: 'abc', facts: {} })
    expect(nodes.map(node => node.data)).toEqual([{ text: 'a', display: 'A' }, { label: 'claimed' }, { text: 'c', display: '' }])
    assertCoverage('abc', nodes)
  })

  it('allows display-bearing Text splits and merges with equal fresh and incremental results', () => {
    const { registry } = setup()
    registry.register({
      id: 'test.split', order: 0,
      transform: () => [
        { ...plain('a'), data: { text: 'a', display: 'A' } },
        { ...plain('bc', 1), data: { text: 'bc', display: 'BC' } },
      ],
    })
    registry.register({
      id: 'test.merge', order: 1,
      transform: (segments, context) => context.read('testEnabled')
        ? [{ ...plain('abc'), data: { text: 'abc', display: segments.map(node =>
          node.id === 'text' ? node.data.display ?? node.data.text : '').join('') } }] : segments,
    })
    const evaluate = registry.createEvaluator()
    for (const testEnabled of [false, true, false]) {
      const input = { text: 'abc', facts: { testEnabled } }
      const nodes = evaluate(input)
      expect(nodes).toHaveLength(testEnabled ? 1 : 2)
      expect(nodes).toEqual(registry.createEvaluator()(input))
      assertCoverage(input.text, nodes)
    }
  })

  it('updates display through read dependencies, reuses atoms and matches fresh evaluation', () => {
    const { registry } = setup()
    registry.register(rule('test.a', 0, 'b'))
    const evaluate = registry.createEvaluator()
    const original = evaluate({ text: 'abc', facts: {} })
    const transform = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      const label = context.read('testLabel')
      return label === undefined ? segments : segments.map(node => node.id === 'text'
        ? { ...node, data: { ...node.data, display: label + node.data.text } } : node)
    })
    registry.register({ id: 'test.presentation', order: 1, transform })
    const before = evaluate({ text: 'abc', facts: { testLabel: 'first' } })
    expect(evaluate({ text: 'abc', facts: { testLabel: 'first', testOther: 1 } })).toBe(before)
    expect(transform).toHaveBeenCalledOnce()
    for (const facts of [{ testLabel: 'second' }, { testLabel: '' }, {}]) {
      const input = { text: 'abc', facts }
      const nodes = evaluate(input)
      expect(nodes).toEqual(registry.createEvaluator()(input))
      expect(nodes[1]).toBe(original[1])
      assertCoverage(input.text, nodes)
    }
    expect(evaluate({ text: 'abc', facts: {} })).toBe(original)
  })

  it('constrains declaration-merged JSON payloads recursively', () => {
    expectTypeOf<UserTextNode<'test.annotation'>['data']>().toExtend<AnnotationData>()
    expectTypeOf<UserTextDataMap['test.function']>().not.toExtend<UserTextNode<'test.function'>['data']>()
    expectTypeOf<UserTextDataMap['test.date']>().not.toExtend<UserTextNode<'test.date'>['data']>()
    expectTypeOf<UserTextDataMap['test.map']>().not.toExtend<UserTextNode<'test.map'>['data']>()
    expectTypeOf<UserTextDataMap['test.symbol']>().not.toExtend<UserTextNode<'test.symbol'>['data']>()
    expectTypeOf<UserTextDataMap['test.bigint']>().not.toExtend<UserTextNode<'test.bigint'>['data']>()
    expectTypeOf<UserTextDataMap['test.unknown']>().not.toExtend<UserTextNode<'test.unknown'>['data']>()
    expectTypeOf<UserTextDataMap['test.nested']>().not.toExtend<UserTextNode<'test.nested'>['data']>()
  })

  it('performs zero transforms for unread facts and a replaced outer facts object', () => {
    const { registry } = setup()
    const transform = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      if (!segments.some(node => node.id === 'text' && node.data.text.includes('/'))) return segments
      context.read('skillNames')
      return segments
    })
    registry.register({ id: 'test.a', order: 0, transform })
    const evaluate = registry.createEvaluator()
    const previous = evaluate({ text: 'no candidate', facts: {} })
    expect(evaluate({ text: 'no candidate', facts: { skillNames: ['new'], testOther: 1 } })).toBe(previous)
    expect(transform).toHaveBeenCalledOnce()
    const skillNames = ['x']
    evaluate({ text: '/x', facts: { skillNames } })
    transform.mockClear()
    evaluate({ text: '/x', facts: { skillNames, testOther: 2 } })
    expect(transform).not.toHaveBeenCalled()
  })

  it('borrows fact fields without traversing or freezing the caller values', () => {
    const { registry } = setup()
    const skillNames = ['x']
    registry.register({
      id: 'test.a', order: 0,
      transform: (segments, context) => {
        expect(context.read('skillNames')).toBe(skillNames)
        return segments
      },
    })
    registry.createEvaluator()({ text: '/x', facts: { skillNames } })
    expect(Object.isFrozen(skillNames)).toBe(false)
  })

  it('tracks missing fields and replaces conditional read sets after each execution', () => {
    const { registry } = setup()
    const transform = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      if (!context.read('testEnabled')) return segments
      return claim(segments, 'test.a', 'x', context.read('testLabel') ?? 'missing')
    })
    registry.register({ id: 'test.a', order: 0, transform })
    const evaluate = registry.createEvaluator()
    evaluate({ text: 'x', facts: {} })
    expect(evaluate({ text: 'x', facts: { testEnabled: true } })[0]?.data).toEqual({ label: 'missing' })
    expect(evaluate({ text: 'x', facts: { testEnabled: true, testLabel: 'ready' } })[0]?.data).toEqual({ label: 'ready' })
    evaluate({ text: 'x', facts: { testEnabled: false, testLabel: 'ready' } })
    transform.mockClear()
    evaluate({ text: 'x', facts: { testEnabled: false, testLabel: 'changed' } })
    expect(transform).not.toHaveBeenCalled()
  })

  it('updates skillNames without running independent stages when output stays equivalent', () => {
    const { registry } = setup()
    const first = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      context.read('testOther')
      return segments
    })
    const skill = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      context.read('skillNames')
      return claim(segments, 'test.a', 'x', 'same')
    })
    const last = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      context.read('testLabel')
      return segments
    })
    registry.register({ id: 'test.A', order: -1, transform: first })
    registry.register({ id: 'test.a', order: 0, transform: skill })
    registry.register({ id: 'test.z', order: 1, transform: last })
    const evaluate = registry.createEvaluator()
    const before = evaluate({ text: 'x!', facts: { skillNames: ['a'], testLabel: 'old' } })
    const after = evaluate({ text: 'x!', facts: { skillNames: ['b'], testLabel: 'old' } })
    expect(after).toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(first).toHaveBeenCalledOnce()
    expect(skill).toHaveBeenCalledTimes(2)
    expect(last).toHaveBeenCalledOnce()
    expect(evaluate({ text: 'x!', facts: { skillNames: ['c'], testLabel: 'new' } })).toBe(before)
    expect(last).toHaveBeenCalledTimes(2)
  })

  it('aligns equal new nodes to input identities and keeps unchanged nodes when their indices move', () => {
    const { registry } = setup()
    const pass = vi.fn((segments: readonly UserTextNode[]) => segments.map(node => ({ ...node, data: { ...node.data } }) as UserTextNode))
    registry.register({ id: 'test.a', order: 0, transform: pass })
    const evaluate = registry.createEvaluator()
    const nodes = evaluate({ text: 'xyz', facts: {} })
    expect(nodes).toBe(pass.mock.calls[0]?.[0])
    registry.register({ id: 'test.z', order: 1, transform: segments => claim(segments, 'test.z', 'z') })
    const withLast = evaluate({ text: 'xyz', facts: {} })
    registry.register({ id: 'test.A', order: -1, transform: segments => claim(segments, 'test.A', 'x') })
    const withFirst = evaluate({ text: 'xyz', facts: {} })
    expect(withFirst[2]).toBe(withLast[1])
  })

  it('compares nested JSON by value, ignores object key order, and propagates actual payload changes', () => {
    const { registry } = setup()
    registry.register({
      id: 'test.annotation', order: 0,
      transform: (_segments, context) => {
        const label = context.read('testLabel') ?? 'same'
        const version = context.read('testOther') ?? 0
        const nested = { values: ['文字', 3, true, null] }
        const data = version % 2 ? { nested, label } : { label, nested }
        return [{ id: 'test.annotation', start: 0, end: 3, data }]
      },
    })
    const last = vi.fn((segments: readonly UserTextNode[]) => segments)
    registry.register({ id: 'test.z', order: 1, transform: last })
    const evaluate = registry.createEvaluator()
    const original = evaluate({ text: 'abc', facts: {} })
    expect(evaluate({ text: 'abc', facts: { testOther: 1 } })).toBe(original)
    expect(last).toHaveBeenCalledOnce()
    const changed = evaluate({ text: 'abc', facts: { testOther: 2, testLabel: 'changed' } })
    expect(changed).not.toBe(original)
    expect(changed[0]?.data).toMatchObject({ label: 'changed' })
    expect(last).toHaveBeenCalledTimes(2)
    expect(evaluate({ text: 'abc', facts: { testOther: 3, testLabel: 'changed' } })).toBe(changed)
    expect(last).toHaveBeenCalledTimes(2)
  })

  it('invalidates every stage on text changes and keeps evaluators isolated', () => {
    const { registry } = setup()
    const a = vi.fn((segments: readonly UserTextNode[]) => claim(segments, 'test.a', 'x'))
    const z = vi.fn((segments: readonly UserTextNode[]) => segments)
    registry.register({ id: 'test.a', order: 0, transform: a })
    registry.register({ id: 'test.z', order: 1, transform: z })
    const left = registry.createEvaluator()
    const right = registry.createEvaluator()
    const input = { text: 'x', facts: {} }
    const first = left(input)
    expect(right(input)).not.toBe(first)
    expect(left(input)).toBe(first)
    expect(a).toHaveBeenCalledTimes(2)
    left({ text: 'xx', facts: {} })
    expect(a).toHaveBeenCalledTimes(3)
    expect(z).toHaveBeenCalledTimes(3)
    expect(right(input)).toEqual(first)
    expect(a).toHaveBeenCalledTimes(3)
  })

  it('handles insertion, removal, definition replacement and reordering against fresh evaluation', () => {
    const { registry } = setup()
    const a = vi.fn((segments: readonly UserTextNode[]) => claim(segments, 'test.a', 'bc'))
    const disposeA = registry.register({ id: 'test.a', order: 0, transform: a })
    const evaluate = registry.createEvaluator()
    const input = { text: 'abcde', facts: {} }
    evaluate(input)
    let disposeZ = registry.register(rule('test.z', 1, 'de'))
    const inserted = evaluate(input)
    expect(a).toHaveBeenCalledOnce()
    expect(inserted).toEqual(registry.createEvaluator()(input))
    disposeZ()
    expect(evaluate(input)).toEqual(registry.createEvaluator()(input))
    disposeZ = registry.register(rule('test.z', -1, 'cde'))
    expect(evaluate(input)).toEqual(registry.createEvaluator()(input))
    disposeA()
    registry.register(rule('test.a', -2, 'ab'))
    expect(evaluate(input)).toEqual(registry.createEvaluator()(input))
    disposeZ()
    expect(evaluate(input)).toEqual(registry.createEvaluator()(input))
  })

  it('keeps incremental results deeply equal to fresh documents over facts and text changes', () => {
    const { registry } = setup()
    registry.register({
      id: 'test.a', order: 0,
      transform: (segments, context) => context.read('testEnabled')
        ? claim(segments, 'test.a', 'x', context.read('testLabel') ?? 'missing') : segments,
    })
    registry.register(rule('test.z', 1, 'yz'))
    const evaluate = registry.createEvaluator()
    for (const text of ['xyz', '🙂xyz', '', 'xyz']) {
      for (const facts of [{}, { testEnabled: true }, { testEnabled: true, testLabel: 'new' }, { testEnabled: false }]) {
        const input: UserTextDocumentInput = { text, facts }
        const nodes = evaluate(input)
        expect(nodes).toEqual(registry.createEvaluator()(input))
        assertCoverage(text, nodes)
      }
    }
  })

  it.each([
    [-1, 1], [0, 0], [2, 1], [0, 4], [0.5, 1], [0, 1.5], [NaN, 1], [0, Infinity],
  ])('rejects invalid UTF-16 range [%s, %s)', (start, end) => {
    const { registry } = setup()
    registry.register({ id: 'test.a', order: 0, transform: () => [{ id: 'test.a', start, end, data: { label: 'bad' } }] })
    expect(() => registry.createEvaluator()({ text: 'abc', facts: {} })).toThrow(/test\.a/)
  })

  it.each([
    { name: 'gap', output: [plain('a'), plain('c', 2)] },
    { name: 'overlap', output: [plain('ab'), plain('bc', 1)] },
    { name: 'out of order', output: [plain('bc', 1), plain('a')] },
    { name: 'missing tail', output: [plain('a')] },
    { name: 'wrong text payload', output: [plain('xyz')] },
    { name: 'wrong text with display', output: [{ ...plain('xyz'), data: { text: 'xyz', display: 'abc' } }] },
    { name: 'missing tail with display', output: [{ ...plain('ab'), data: { text: 'ab', display: 'abc' } }] },
    { name: 'foreign business ID', output: [{ id: 'test.z' as const, start: 0, end: 3, data: { label: 'z' } }] },
  ])('rejects $name instead of publishing partial coverage', ({ output }) => {
    const { registry } = setup()
    registry.register({ id: 'test.a', order: 0, transform: () => output })
    expect(() => registry.createEvaluator()({ text: 'abc', facts: {} })).toThrow(/test\.a/)
  })

  it('rejects a new business node spanning adjacent input Text segments', () => {
    const { registry } = setup()
    registry.register({ id: 'test.split', order: 0, transform: () => [plain('a'), plain('bc', 1)] })
    registry.register({
      id: 'test.a', order: 1,
      transform: () => [{ id: 'test.a', start: 0, end: 3, data: { label: 'claimed' } }],
    })
    expect(() => registry.createEvaluator()({ text: 'abc', facts: {} })).toThrow(/test\.a/)
  })

  it.each(['consume', 'rewrite', 'flatten'] as const)('preserves upstream atomic nodes against %s', (operation) => {
    const { registry } = setup()
    registry.register(rule('test.a', 0, 'b'))
    registry.register({
      id: 'test.z', order: 1,
      transform: (segments) => {
        if (operation === 'consume') return [{ id: 'test.z', start: 0, end: 3, data: { label: 'z' } }]
        if (operation === 'flatten') return [plain('abc')]
        return segments.map(node => node.id === 'test.a' ? { ...node, data: { label: 'changed' } } : node)
      },
    })
    expect(() => registry.createEvaluator()({ text: 'abc', facts: {} })).toThrow(/test\.z/)
  })

  it('keeps nodes readonly in types without freezing borrowed payloads', () => {
    expectTypeOf<Parameters<UserTextRule['transform']>[0]>().toEqualTypeOf<readonly UserTextNode[]>()
    expectTypeOf<UserTextNode<'text'>>().toEqualTypeOf<Readonly<UserTextNode<'text'>>>()
    expectTypeOf<UserTextNode<'text'>['data']>().toEqualTypeOf<{ readonly text: string; readonly display?: string }>()
    expectTypeOf<NonNullable<AnnotationData['nested']>['values']>().toEqualTypeOf<readonly (string | number | boolean | null)[]>()
    const { registry } = setup()
    const nested = { values: ['borrowed'] }
    const definition: UserTextRule = {
      id: 'test.annotation', order: 0,
      transform: (_segments, context) => {
        const value = context.read('testNested')
        if (value === undefined) throw new Error('Missing test payload')
        return [{ id: 'test.annotation', start: 0, end: 1, data: { label: 'x', nested: value } }]
      },
    }
    registry.register(definition)
    const nodes = registry.createEvaluator()({ text: 'x', facts: { testNested: nested } })
    if (nodes[0]?.id !== 'test.annotation') throw new Error('Missing annotation')
    expect(nodes[0].data.nested).toBe(nested)
    expect(Object.isFrozen(definition)).toBe(false)
    expect(Object.isFrozen(nodes)).toBe(false)
    expect(Object.isFrozen(nodes[0])).toBe(false)
    expect(Object.isFrozen(nested)).toBe(false)
    expect(Object.isFrozen(nested.values)).toBe(false)
  })

  it('closes escaped read contexts after both success and failure', () => {
    const { registry } = setup()
    let escaped: UserTextTransformContext | undefined
    registry.register({
      id: 'test.a', order: 0,
      transform: (segments, context) => {
        escaped = context
        if (context.read('testEnabled')) throw new Error('failed')
        return segments
      },
    })
    const evaluate = registry.createEvaluator()
    evaluate({ text: 'x', facts: {} })
    expect(() => escaped?.read('testLabel')).toThrow(/closed|active|synchronous/)
    expect(() => evaluate({ text: 'x', facts: { testEnabled: true } })).toThrow(/test\.a/)
    expect(() => escaped?.read('testLabel')).toThrow(/closed|active|synchronous/)
  })

  it('rejects reentrant evaluation without corrupting a later retry', () => {
    const { registry } = setup()
    const evaluate = registry.createEvaluator()
    registry.register({
      id: 'test.a', order: 0,
      transform: (segments, context) => {
        if (context.read('testEnabled')) evaluate({ text: 'nested', facts: {} })
        return segments
      },
    })
    expect(() => evaluate({ text: 'outer', facts: { testEnabled: true } })).toThrow(/test\.a/)
    expect(evaluate({ text: 'outer', facts: { testEnabled: false } })).toEqual([plain('outer')])
  })

  it('caches failures with ruleId/cause and retries when their missing dependency appears', () => {
    const { registry } = setup()
    const cause = new Error('not ready')
    const transform = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      const label = context.read('testLabel')
      if (label === undefined) throw cause
      return claim(segments, 'test.a', 'x', label)
    })
    const last = vi.fn((segments: readonly UserTextNode[]) => segments)
    registry.register({ id: 'test.a', order: 0, transform })
    registry.register({ id: 'test.z', order: 1, transform: last })
    const evaluate = registry.createEvaluator()
    let failure: unknown
    try { evaluate({ text: 'x', facts: {} }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toHaveProperty('ruleId', 'test.a')
    expect(failure).toHaveProperty('cause', cause)
    expect(() => evaluate({ text: 'x', facts: { testOther: 1 } })).toThrow(failure)
    expect(transform).toHaveBeenCalledOnce()
    expect(last).not.toHaveBeenCalled()
    expect(evaluate({ text: 'x', facts: { testLabel: 'ready' } })[0]?.data).toEqual({ label: 'ready' })
    expect(transform).toHaveBeenCalledTimes(2)
    expect(last).toHaveBeenCalledOnce()
  })

  it('replaces reads after failure, reuses recovered output, and removes failed stages', () => {
    const { registry } = setup()
    const transform = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      if (context.read('testEnabled')) throw new Error('blocked')
      return claim(segments, 'test.a', 'x', context.read('testLabel') ?? 'same')
    })
    const dispose = registry.register({ id: 'test.a', order: 0, transform })
    const evaluate = registry.createEvaluator()
    const original = evaluate({ text: 'x', facts: { testEnabled: false } })
    expect(() => evaluate({ text: 'x', facts: { testEnabled: true } })).toThrow(/test\.a/)
    expect(() => evaluate({ text: 'x', facts: { testEnabled: true, testLabel: 'same' } })).toThrow(/test\.a/)
    expect(transform).toHaveBeenCalledTimes(2)
    expect(evaluate({ text: 'x', facts: { testEnabled: false, testLabel: 'same' } })).toBe(original)
    expect(() => evaluate({ text: 'x', facts: { testEnabled: true } })).toThrow(/test\.a/)
    dispose()
    expect(evaluate({ text: 'x', facts: { testEnabled: true } })).toEqual([plain('x')])
    registry.register(rule('test.a', 0, 'x'))
    expect(evaluate({ text: 'x', facts: {} })[0]?.id).toBe('test.a')
  })

  it('rejects asynchronous output and closes its read context immediately', () => {
    const { registry } = setup()
    let escaped: UserTextTransformContext | undefined
    registry.register({
      id: 'test.a', order: 0,
      // @ts-expect-error Transforms cannot return promises, even when already resolved.
      transform: (segments, context) => {
        escaped = context
        return Promise.resolve(segments)
      },
    })
    expect(() => registry.createEvaluator()({ text: 'x', facts: {} })).toThrow(/test\.a/)
    expect(() => escaped?.read('testLabel')).toThrow(/closed|synchronous/)
  })

  it('retains downstream dirty dependencies across a failed upstream evaluation', () => {
    const { registry } = setup()
    registry.register({
      id: 'test.a', order: 0,
      transform: (segments, context) => {
        if (context.read('testEnabled')) throw new Error('blocked')
        return segments
      },
    })
    const last = vi.fn((segments: readonly UserTextNode[], context: UserTextTransformContext) => {
      return claim(segments, 'test.z', 'x', context.read('testLabel') ?? 'old')
    })
    registry.register({ id: 'test.z', order: 1, transform: last })
    const evaluate = registry.createEvaluator()
    evaluate({ text: 'x', facts: { testEnabled: false, testLabel: 'old' } })
    expect(() => evaluate({ text: 'x', facts: { testEnabled: true, testLabel: 'new' } })).toThrow(/test\.a/)
    expect(() => evaluate({ text: 'x', facts: { testEnabled: true, testLabel: 'new' } })).toThrow(/test\.a/)
    expect(evaluate({ text: 'x', facts: { testEnabled: false, testLabel: 'new' } })[0]?.data).toEqual({ label: 'new' })
    expect(last).toHaveBeenCalledTimes(2)
  })

  it.each([Infinity, -Infinity, NaN])('rejects invalid order %s before publication', (order) => {
    const { registry } = setup()
    const revision = registry.getSnapshot()
    const listener = vi.fn()
    registry.subscribe(listener)
    expect(() => registry.register(rule('test.a', order, 'x'))).toThrow(/test\.a/)
    expect(registry.getSnapshot()).toBe(revision)
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects empty, reserved and duplicate IDs without changing revision', () => {
    const { registry } = setup()
    registry.register(rule('test.a', 0, 'x'))
    const revision = registry.getSnapshot()
    expect(() => registry.register(rule('', 0, 'x'))).toThrow(/id|ID/)
    expect(() => registry.register({ id: 'text', order: 0, transform: segments => segments })).toThrow(/text/)
    expect(() => registry.register(rule('test.a', 1, 'x'))).toThrow(/test\.a/)
    expect(registry.getSnapshot()).toBe(revision)
  })

  it('publishes monotonic revisions and evaluates current rules without document subscriptions', () => {
    const { registry } = setup()
    const subscribe = vi.spyOn(registry, 'subscribe')
    const evaluate = registry.createEvaluator()
    expect(subscribe).not.toHaveBeenCalled()
    const revision = registry.getSnapshot()
    expectTypeOf(revision).toEqualTypeOf<number>()
    const seen: number[] = []
    const unsubscribe = registry.subscribe(() => { seen.push(registry.getSnapshot()) })
    const dispose = registry.register(rule('test.a', 0, 'a'))
    expect(registry.getSnapshot()).toBeGreaterThan(revision)
    const input = { text: 'abc', facts: {} }
    expect(evaluate(input)[0]?.id).toBe('test.a')
    dispose()
    expect(evaluate(input)).toEqual([plain('abc')])
    expect(seen[1]).toBeGreaterThan(seen[0]!)
    dispose()
    expect(seen).toHaveLength(2)
    unsubscribe()
    unsubscribe()
    registry.register(rule('test.a', 0, 'b'))
    dispose()
    expect(evaluate(input)[1]?.id).toBe('test.a')
    expect(seen).toHaveLength(2)
  })

  it('removes only the contributing fiber rules and cleans root registrations on disposal', async () => {
    const { ctx, registry } = setup()
    ctx.provide('userTextTestRegistry', registry)
    registry.register(rule('test.a', 0, 'a'))
    const feature = ctx.inject(['userTextTestRegistry'], (featureCtx) => {
      featureCtx.userTextTestRegistry.register(rule('test.z', 0, 'b'))
    })
    await feature.await()
    const evaluate = registry.createEvaluator()
    expect(evaluate({ text: 'ab', facts: {} }).map(node => node.id)).toEqual(['test.a', 'test.z'])
    await feature.dispose()
    expect(evaluate({ text: 'ab', facts: {} }).map(node => node.id)).toEqual(['test.a', 'text'])
    await ctx.fiber.dispose()
    expect(evaluate({ text: 'ab', facts: {} })).toEqual([plain('ab')])
  })
})

describe('sessionReferenceRule', () => {
  it('folds wire syntax to JSON label data while retaining the full original range', async () => {
    const { sessionReferenceRule } = await import('../src/client/user-text/session-reference-rule.ts')
    const { registry } = setup()
    registry.register(sessionReferenceRule)
    const wire = '@[查看并分析图片](dsh-session:InNlc3Npb24tNDM0)'
    const text = `看看 ${wire} 的结论`
    const nodes = registry.createEvaluator()({ text, facts: {} })
    expect(nodes).toEqual([
      plain('看看 '), { id: 'session', start: 3, end: 3 + wire.length, data: { label: '查看并分析图片' } },
      plain(' 的结论', 3 + wire.length),
    ])
    assertCoverage(text, nodes)
  })

  it('uses exact supplied labels, keeps the longest spelling and preserves repeated occurrences', async () => {
    const { sessionReferenceRule } = await import('../src/client/user-text/session-reference-rule.ts')
    const { registry } = setup()
    registry.register(sessionReferenceRule)
    const evaluate = registry.createEvaluator()
    const text = '@会话一 收尾 @会话一， @会话 @未知'
    const nodes = evaluate({ text, facts: { sessionLabels: ['会话', '会话一', '会话一'] } })
    expect(nodes.filter(node => node.id === 'session').map(node => ({ raw: text.slice(node.start, node.end), data: node.data })))
      .toEqual([
        { raw: '@会话一', data: { label: '会话一' } }, { raw: '@会话一', data: { label: '会话一' } },
        { raw: '@会话', data: { label: '会话' } },
      ])
    assertCoverage(text, nodes)
    expect(evaluate({ text: '@会话', facts: {} })).toEqual([plain('@会话')])
  })

  it('prefers complete wire syntax over an overlapping supplied label', async () => {
    const { sessionReferenceRule } = await import('../src/client/user-text/session-reference-rule.ts')
    const { registry } = setup()
    registry.register(sessionReferenceRule)
    const text = '@[a](dsh-session:x)'
    expect(registry.createEvaluator()({ text, facts: { sessionLabels: ['[a]'] } })).toEqual([
      { id: 'session', start: 0, end: text.length, data: { label: 'a' } },
    ])
  })
})
