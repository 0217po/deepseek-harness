/** Connect retained application objects to the calling program's current logged tool binding. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCuaApi } from './api.ts'
import type { CuaApi, CuaOperation } from './types.ts'

/** Standard tools.cua binding; its image content is admitted by the host tool pipeline. */
export type CuaToolBinding = (operation: CuaOperation) => Promise<JsonValue>

/**
 * Connect the object API without owning an evaluator or its lifetime.
 * @param getTool - Resolves the current execution's tools.cua binding on every operation; do not capture a completed execution's binding.
 * @param onText - Optional text output captured by the caller's execution environment.
 * @returns Application objects retaining tool approval, logging and image delivery. Rejected calls propagate without retries.
 */
export function connectCua(getTool: () => CuaToolBinding, onText?: (text: string) => void | Promise<void>): CuaApi {
  return createCuaApi(async (operation) => {
    const result = await getTool()(operation)
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('CUA tool result requires structuredContent')
    }
    if (result.isError === true) {
      const details = Array.isArray(result.content) ? result.content.flatMap((block) => {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) return []
        return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
      }).join('\n') : ''
      throw new Error(details || 'CUA tool operation failed')
    }
    if (!Object.hasOwn(result, 'structuredContent') || result.structuredContent === undefined) {
      throw new Error('CUA tool result requires structuredContent')
    }
    return result.structuredContent
  }, {
    text: value => onText?.(value),
    // The standard tools.cua result already carries the screenshot attachment.
    image: () => {},
  })
}
