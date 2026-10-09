import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as applyHost } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { ComposerAttachments } from '../src/client/ComposerAttachments.tsx'
import { MessageImages, MessageImagesContent } from '../src/client/MessageImages.tsx'

async function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
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

  it('registers all entries and removes them with the plugin fiber', async () => {
    const { ctx, fiber, registerFactory } = await bench()
    expect(inject).toEqual(['slots'])
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

    expect(ctx.slots.entries('conversation.input.attachments')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.message.images')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.trajectory.images')).toHaveLength(0)
    expect(ctx.slots.entries('tool.call.images')).toHaveLength(0)
    expect(ctx.slots.snapshot('factory:conversation.message.images.content')).toHaveLength(0)
  })
})
