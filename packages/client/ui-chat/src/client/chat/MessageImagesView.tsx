/** Portable owner of the Chat message-image position. */
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'

/**
 * Render Chat images through the same replaceable position from any Chat child.
 * @param props - image references, authorized loader, presentation hints, and Slot renderer.
 * @returns the registered image presentation.
 */
export function MessageImagesView({ images, loadImage, align, compact, thumbnail, renderSlot }:
FactoryComponentPropsOf<'conversation.message.images.view'>) {
  return renderSlot('conversation.message.images', {
    images, loadImage, align,
    ...compact === undefined ? {} : { compact },
    ...thumbnail === undefined ? {} : { thumbnail },
  })
}
