/** Production user content for component units; registry integration uses SlotTestRuntime. */
import { createElement, type ComponentProps } from 'react'
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { UserContentInput } from '../src/client/contract/slots.ts'
import { UserContent } from '../src/client/chat/UserContent.tsx'

/**
 * Render the content component with only the seats it reads in standalone units.
 * @param input - prepared user content and explicit callbacks.
 * @param renderFactorySlot - the unit's image Factory renderer.
 * @param t - the unit's Chat translator.
 * @returns the production content stack without registry machinery.
 */
export function renderUserContent(
  input: UserContentInput,
  renderFactorySlot: PropsRenderFactories['renderFactorySlot'],
  t: PropsLocale<'chat'>['t'],
) {
  return createElement(UserContent, { ...input, renderFactorySlot, t } as ComponentProps<typeof UserContent>)
}
