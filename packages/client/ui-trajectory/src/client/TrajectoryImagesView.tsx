/** Portable owner of the Trajectory image presentation Slot. */
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './trajectory-contract.ts'

/**
 * Render record images without passing a custom ReactNode-producing closure through the ledger.
 * @param props - image references, authorized loader, presentation hints, and Slot renderer.
 * @returns the registered Trajectory image presentation.
 */
export function TrajectoryImagesView({ images, loadImage, align, compact, thumbnail, renderSlot }:
FactoryComponentPropsOf<'conversation.trajectory.images.view'>) {
  return renderSlot('conversation.trajectory.images', {
    images, loadImage, align,
    ...compact === undefined ? {} : { compact },
    ...thumbnail === undefined ? {} : { thumbnail },
  })
}
