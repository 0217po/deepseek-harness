import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembly.ts'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { AttachmentReference, type AttachmentReferenceInjected } from '../src/client/AttachmentReference.tsx'
import { apply as applyHost } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { ComposerAttachments } from '../src/client/ComposerAttachments.tsx'
import { MessageImages, MessageImagesContent } from '../src/client/MessageImages.tsx'

async function bench() {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  ctx.provide('sessions', sessions)
  ctx.provide('locale', new LocaleRuntime(ctx))
  new UiConversation(ctx, sessions)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.user.text.node': { kind: 'keyed', scope: 'session' },
      'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
      'conversation.message.images': { kind: 'single', scope: 'session' },
      'conversation.trajectory.images': { kind: 'single', scope: 'session' },
      'tool.call.images': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
  const registerFactory = vi.spyOn(ctx.slots, 'registerFactory')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, registerFactory }
}

describe('attachment plugin', () => {
  it('keeps the host half empty', () => {
    expect(() => { applyHost() }).not.toThrow()
  })

  it('binds image reads and cache peeks to the reference Session', async () => {
    const { ctx } = await bench()
    const attachment = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const, bytes: 68, width: 1, height: 1 }
    const imageUrl = vi.spyOn(ctx.uiConversation, 'imageUrl').mockResolvedValue('blob:loaded')
    const peekImageUrl = vi.spyOn(ctx.uiConversation, 'peekImageUrl').mockReturnValue('blob:cached')
    const entry = ctx.slots.entries('conversation.user.text.node')[0]!
    const factory = entry.inject as NonNullable<typeof entry.inject> & ((id: SessionId) => AttachmentReferenceInjected)
    const first = factory(SessionId('first'))
    const second = factory(SessionId('second'))
    expect(first.loadImage.peek?.(attachment)).toBe('blob:cached')
    await expect(first.loadImage(attachment)).resolves.toBe('blob:loaded')
    await expect(second.loadImage(attachment)).resolves.toBe('blob:loaded')
    expect(peekImageUrl).toHaveBeenCalledWith('first', attachment)
    expect(imageUrl.mock.calls).toEqual([['first', attachment], ['second', attachment]])
  })

  it('registers all entries and removes them with the plugin fiber', async () => {
    const { ctx, fiber, registerFactory } = await bench()
    expect(inject).toEqual(['slots', 'uiConversation', 'locale'])
    expect(ctx.slots.entries('conversation.user.text.node')).toMatchObject([{
      options: { key: 'attachment' }, component: AttachmentReference,
    }])
    expect(ctx.slots.entries('conversation.user.text.node')[0]?.inject).toBeTypeOf('function')
    expect(ctx.uiConversation.userText.entries().map(rule => rule.id)).toEqual(['attachment'])
    expect(registerFactory).toHaveBeenCalledWith({
      name: 'conversation.message.images.content', scope: 'root', locale: 'conversation',
    }, MessageImagesContent)
    expect(ctx.slots.snapshot('factory:conversation.message.images.content')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.input.attachments')).toMatchObject([{
      locale: 'conversation',
      component: ComposerAttachments,
    }])
    expect(ctx.slots.entries('conversation.message.images')).toMatchObject([{
      component: MessageImages,
    }])
    expect(ctx.slots.entries('conversation.trajectory.images')).toMatchObject([{
      component: MessageImages,
    }])
    expect(ctx.slots.entries('tool.call.images')).toMatchObject([{
      component: MessageImages,
    }])

    await fiber.dispose()

    expect(ctx.slots.entries('conversation.user.text.node')).toHaveLength(0)
    expect(ctx.uiConversation.userText.entries()).toHaveLength(0)
    expect(ctx.slots.entries('conversation.input.attachments')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.message.images')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.trajectory.images')).toHaveLength(0)
    expect(ctx.slots.entries('tool.call.images')).toHaveLength(0)
    expect(ctx.slots.snapshot('factory:conversation.message.images.content')).toHaveLength(0)
  })
})
