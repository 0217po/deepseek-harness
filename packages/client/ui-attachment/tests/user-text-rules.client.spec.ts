import { Context } from '@deepseek-ai/cordis'
import { UserTextRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-registry.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { attachmentReferenceRule } from '../src/client/user-text-rules.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'test.attachment.blocker': { readonly label: string }
  }
}

function setup(rules: readonly UserTextRule[] = [attachmentReferenceRule]) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new UserTextRegistry(ctx)
  for (const rule of rules) registry.register(rule)
  return registry.createEvaluator()
}

describe('attachmentReferenceRule', () => {
  it('does not read attachment facts when an earlier rule leaves no Text', () => {
    const read = vi.fn()
    const transform = vi.fn<UserTextRule['transform']>((segments, context) => attachmentReferenceRule.transform(segments, {
      read: (key) => { read(key); return context.read(key) },
    }))
    const blocker: UserTextNode<'test.attachment.blocker'> = {
      id: 'test.attachment.blocker', start: 0, end: 5, data: { label: 'claimed' },
    }
    const evaluate = setup([
      { id: 'test.attachment.blocker', order: 0, transform: () => [blocker] },
      { ...attachmentReferenceRule, transform },
    ])
    const before = evaluate({ text: 'image', facts: {} })
    expect(before).toEqual([blocker])
    expect(evaluate({ text: 'image', facts: { attachments: [] } })).toBe(before)
    expect(read).not.toHaveBeenCalled()
    expect(transform).toHaveBeenCalledOnce()
  })

  it('rejects invalid and overlapping fact ranges with its rule ID and cause', () => {
    const evaluate = setup()
    const attachment = { type: 'file' as const, ref: { attachmentId: AttachmentId('file'), name: 'a', bytes: 1 } }
    for (const ranges of [
      [{ start: -1, end: 1 }], [{ start: 0, end: 0 }], [{ start: 0, end: 5 }],
      [{ start: 0.5, end: 1 }], [{ start: 0, end: Infinity }],
      [{ start: 0, end: 3 }, { start: 2, end: 4 }],
    ]) {
      let failure: unknown
      try {
        evaluate({ text: 'abcd', facts: { attachments: ranges.map(range => ({ ...range, attachment })) } })
      } catch (error) { failure = error }
      expect(failure).toHaveProperty('ruleId', 'attachment')
      expect(failure).toHaveProperty('cause', expect.any(RangeError))
    }
  })

  it('preserves earlier business nodes and claims only fact ranges inside remaining Text', () => {
    const blocker: UserTextNode<'test.attachment.blocker'> = {
      id: 'test.attachment.blocker', start: 1, end: 4, data: { label: 'claimed' },
    }
    const evaluate = setup([
      {
        id: 'test.attachment.blocker', order: 0,
        transform: () => [
          { id: 'text', start: 0, end: 1, data: { text: 'a' } }, blocker,
          { id: 'text', start: 4, end: 6, data: { text: 'ef' } },
        ],
      },
      attachmentReferenceRule,
    ])
    const attachment = { type: 'file' as const, ref: { attachmentId: AttachmentId('file'), name: 'a', bytes: 1 } }
    const nodes = evaluate({
      text: 'abcdef', facts: { attachments: [{ start: 1, end: 4, attachment }, { start: 4, end: 6, attachment }] },
    })
    expect(nodes[1]).toBe(blocker)
    expect(nodes.filter(node => node.id === 'attachment').map(node => [node.start, node.end])).toEqual([[4, 6]])
    const crossing = evaluate({ text: 'abcdef', facts: { attachments: [{ start: 0, end: 5, attachment }] } })
    expect(crossing[1]).toBe(blocker)
    expect(crossing.filter(node => node.id === 'attachment')).toEqual([])
  })

  it('carries only explicitly located image and file references as JSON', () => {
    const evaluate = setup()
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId('image-id'), mediaType: 'image/png', bytes: 13,
      width: 10, height: 20, name: 'photo.png', originalDimensions: { width: 100, height: 200 },
    }
    const file: FileAttachmentRef = { attachmentId: AttachmentId('file-id'), name: 'report.pdf', bytes: 42 }
    const imageAttachment = Object.freeze({ type: 'image' as const, ref: Object.freeze(image) })
    const fileAttachment = Object.freeze({ type: 'file' as const, ref: Object.freeze(file) })
    const input = Object.freeze({
      text: '🙂 image file',
      facts: Object.freeze({ attachments: Object.freeze([
        Object.freeze({ start: 3, end: 8, attachment: imageAttachment }),
        Object.freeze({ start: 9, end: 13, attachment: fileAttachment }),
      ]) }),
    })
    const matches = evaluate(input).filter(node => node.id === 'attachment')
    expect(attachmentReferenceRule.id).toBe('attachment')
    expect(matches).toEqual([
      { id: 'attachment', start: 3, end: 8, data: { attachment: imageAttachment } },
      { id: 'attachment', start: 9, end: 13, data: { attachment: fileAttachment } },
    ])
    expect(JSON.parse(JSON.stringify(matches))).toEqual(matches)
  })

  it('never treats a display name as a path or infers a second same-name reference', () => {
    const evaluate = setup()
    const text = '@report.pdf and @report.pdf'
    const ref: FileAttachmentRef = { attachmentId: AttachmentId('chosen-file'), name: 'report.pdf', bytes: 5 }
    expect(evaluate({ text, facts: {} }).filter(node => node.id === 'attachment')).toEqual([])
    expect(evaluate({ text, facts: { attachments: [] } }).filter(node => node.id === 'attachment')).toEqual([])
    const start = text.lastIndexOf('@report.pdf')
    expect(evaluate({
      text, facts: { attachments: [{ start, end: text.length, attachment: { type: 'file', ref } }] },
    }).filter(node => node.id === 'attachment')).toEqual([{ id: 'attachment', start, end: text.length, data: { attachment: { type: 'file', ref } } }])
  })
})
