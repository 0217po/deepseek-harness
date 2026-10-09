/** Browser attachment plugin: fills conversation's composer and image slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { ComposerAttachments } from './ComposerAttachments.tsx'
import { MessageImages, MessageImagesContent } from './MessageImages.tsx'

/** Slot registry required by this presentation plugin. */
export const inject = ['slots']

/** Register attachment presentation without exporting React components as package values. */
export function apply(ctx: ClientContext): void {
  ctx.slots.registerFactory({
    name: 'conversation.message.images.content', scope: 'root', locale: 'conversation',
  }, MessageImagesContent)
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments',
    locale: 'conversation',
  }, ComposerAttachments))
  ctx.slots.inject('conversation.message.images', () => ctx.slots.register({
    name: 'conversation.message.images',
    priority: 100,
  }, MessageImages))
  ctx.slots.inject('conversation.trajectory.images', () => ctx.slots.register({
    name: 'conversation.trajectory.images',
    priority: 100,
  }, MessageImages))
  // Tool image entries reuse the same gallery Factory.
  ctx.slots.inject('tool.call.images', () => ctx.slots.register({
    name: 'tool.call.images',
    priority: 100,
  }, MessageImages))
}
