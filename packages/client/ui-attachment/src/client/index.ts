/** Browser attachment plugin: composer, image galleries, and explicit inline attachment references. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { ComposerAttachments } from './ComposerAttachments.tsx'
import { AttachmentReference, type AttachmentReferenceInjected } from './AttachmentReference.tsx'
import { attachmentReferenceRule } from './user-text-rules.ts'
export type {} from './user-text-rules.ts'
import { en, NS, zh } from './locales.ts'
import { MessageImages, MessageImagesContent } from './MessageImages.tsx'

/** Slot assembly, pure text rules, Session image loading, and attachment-owned copy. */
export const inject = ['slots', 'uiConversation', 'locale']

/**
 * Register attachment presentation and the explicit-range user-text provider.
 * @param ctx - client plugin context with Session-authorized image loading.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-attachment: dictionaries')
  ctx.effect(() => ctx.uiConversation.userText.register(attachmentReferenceRule), 'ui-attachment: text rule')
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'attachment', priority: 100, locale: NS,
    inject: (sessionId: UserTextNodeProps<'attachment'>['sessionId']): AttachmentReferenceInjected => ({
      loadImage: Object.assign(
        (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId, attachment),
        { peek: (attachment: ImageAttachmentRef) => ctx.uiConversation.peekImageUrl(sessionId, attachment) },
      ),
    }),
  }, AttachmentReference))
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
