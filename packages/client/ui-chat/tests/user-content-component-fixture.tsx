/** Production user content for component units; registry integration uses SlotTestRuntime. */
import { createElement, type ComponentProps } from 'react'
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { UserTextInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createUserTextFixture } from '../../ui-conversation/tests/user-text-component-fixture.client.tsx'
import type { UserContentInput } from '../src/client/contract/slots.ts'
import { UserContent } from '../src/client/chat/UserContent.tsx'

/**
 * Bind real text parsing and business renderers for one component-test lifetime.
 * @param actions - reference operations supplied by the test's node-injection fixture.
 * @returns renderer accepting prepared content, image Factory seats, and Chat locale.
 */
export function createUserContentFixture(actions?: Parameters<typeof createUserTextFixture>[0]) {
  const renderUserText = createUserTextFixture(actions)
  return (
    input: UserContentInput,
    renderFactorySlot: PropsRenderFactories['renderFactorySlot'],
    t: PropsLocale<'chat'>['t'],
  ) => {
    const renderFactory: PropsRenderFactories['renderFactorySlot'] = (name, owner, options) =>
      name === 'conversation.user.text'
        ? renderUserText(owner as UserTextInput)
        : renderFactorySlot(name, owner, options)
    return createElement(UserContent, { ...input, renderFactorySlot: renderFactory, t } as ComponentProps<typeof UserContent>)
  }
}
