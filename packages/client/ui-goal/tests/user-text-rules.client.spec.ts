import { Context } from '@deepseek-ai/cordis'
import { UserTextRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserTextFacts, UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { goalCommandReferenceRule } from '../src/client/user-text-rules.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'test.command.blocker': { readonly label: string }
  }
}

function setup(rules: readonly UserTextRule[] = [goalCommandReferenceRule]) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  for (const rule of rules) registry.register(rule)
  return registry.createEvaluator()
}

describe('goalCommandReferenceRule', () => {
  it('does not read command facts or rerun without a slash-token candidate', () => {
    const read = vi.fn()
    const transform = vi.fn<UserTextRule['transform']>((segments, context) => goalCommandReferenceRule.transform(segments, {
      read: (key) => { read(key); return context.read(key) },
    }))
    const evaluate = setup([{ ...goalCommandReferenceRule, transform }])
    const text = 'plain text prefix/goal'
    const before = evaluate({ text, facts: {} })
    expect(evaluate({ text, facts: { commands: [{ start: 0, end: 5, name: 'goal' }] } })).toBe(before)
    expect(read).not.toHaveBeenCalled()
    expect(transform).toHaveBeenCalledOnce()
  })

  it('uses only supplied ranges in current Text and never consumes an earlier business node', () => {
    const text = '/goal /goal /goal'
    const blocker: UserTextNode<'test.command.blocker'> = {
      id: 'test.command.blocker', start: 0, end: 5, data: { label: 'claimed' },
    }
    const evaluate = setup([
      {
        id: 'test.command.blocker', order: 0,
        transform: () => [blocker, { id: 'text', start: 5, end: text.length, data: { text: text.slice(5) } }],
      },
      goalCommandReferenceRule,
    ])
    const nodes = evaluate({
      text, facts: { commands: [{ start: 0, end: 5, name: 'goal' }, { start: 6, end: 11, name: 'goal' }] },
    })
    expect(nodes[0]).toBe(blocker)
    expect(nodes.filter(node => node.id === 'command').map(node => [node.start, node.end])).toEqual([[6, 11]])
    expect(nodes.at(-1)).toEqual({ id: 'text', start: 11, end: text.length, data: { text: ' /goal' } })
    expect(evaluate({ text, facts: { commands: [{ start: 6, end: 10, name: 'goal' }] } }).filter(node => node.id === 'command')).toEqual([])
  })

  it('marks only the actual leading command range, not repeated command text in the body', () => {
    const evaluate = setup()
    const text = '/goal ship it\nthen discuss /goal again'
    const input = Object.freeze({ text, facts: Object.freeze({ commands: Object.freeze([{ start: 0, end: 5, name: 'goal' }]) }) })
    const matches = evaluate(input).filter(node => node.id === 'command')
    expect(goalCommandReferenceRule.id).toBe('command')
    expect(matches).toEqual([{ id: 'command', start: 0, end: 5, data: { name: 'goal' } }])
    expect(JSON.parse(JSON.stringify(matches))).toEqual(matches)
    expect(evaluate({ text, facts: {} }).filter(node => node.id === 'command')).toEqual([])
    expect(evaluate({ text, facts: { commands: [] } }).filter(node => node.id === 'command')).toEqual([])
  })

  it('orders confirmed ranges, ignores overlap, and preserves unclaimed nodes by identity', () => {
    const first: UserTextNode<'text'> = { id: 'text', start: 0, end: 5, data: { text: '/goal' } }
    const blocker: UserTextNode<'test.command.blocker'> = {
      id: 'test.command.blocker', start: 5, end: 6, data: { label: 'claimed' },
    }
    const tail: UserTextNode<'text'> = { id: 'text', start: 6, end: 17, data: { text: '/goal /goal' } }
    const plain: UserTextNode<'text'> = { id: 'text', start: 17, end: 23, data: { text: ' plain' } }
    const segments = [first, blocker, tail, plain]
    const commands = [
      { start: 12, end: 17, name: 'goal' },
      { start: 6, end: 17, name: 'goal' },
      { start: 0, end: 5, name: 'goal' },
      { start: 6, end: 11, name: 'goal' },
    ]
    const facts: Partial<UserTextFacts> = { commands }
    const result = goalCommandReferenceRule.transform(Object.freeze(segments), { read: key => facts[key] })
    expect(result).toEqual([
      { id: 'command', start: 0, end: 5, data: { name: 'goal' } },
      blocker,
      { id: 'command', start: 6, end: 11, data: { name: 'goal' } },
      { id: 'text', start: 11, end: 12, data: { text: ' ' } },
      { id: 'command', start: 12, end: 17, data: { name: 'goal' } },
      plain,
    ])
    expect(result[1]).toBe(blocker)
    expect(result.at(-1)).toBe(plain)
    expect(segments).toEqual([first, blocker, tail, plain])
  })

  it.each([
    [' /goalx', 1, 6],
    [' /other x/goal', 9, 14],
    [' /goal', 1, 7],
    [' /goal', 20, 25],
  ] as const)('keeps unmatched confirmed ranges plain in %s', (text, start, end) => {
    const segments: UserTextNode[] = [{ id: 'text', start: 0, end: text.length, data: { text } }]
    const facts: Partial<UserTextFacts> = { commands: [{ start, end, name: 'goal' }] }
    const result = goalCommandReferenceRule.transform(segments, { read: key => facts[key] })
    expect(result).toBe(segments)
  })

  it('uses caller-provided UTF-16 ranges instead of searching or guessing names', () => {
    const evaluate = setup()
    const text = '🙂 /goal body /goal'
    const input = { text, facts: { commands: [{ start: 3, end: 8, name: 'goal' }] } }
    expect(evaluate(input).filter(node => node.id === 'command')).toEqual([{ id: 'command', start: 3, end: 8, data: { name: 'goal' } }])
  })
})
