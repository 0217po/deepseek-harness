/** Display-only text transforms; source coordinates and business payloads remain unchanged. */
import type { UserTextNode, UserTextRule } from '../contract/user-text.ts'

function withDisplay(node: UserTextNode<'text'>, display: string): UserTextNode<'text'> {
  if (display === (node.data.display ?? node.data.text)) return node
  return { ...node, data: { ...node.data, display } }
}

/** Collapse whitespace across adjacent Text displays when enabled; business nodes separate runs. */
export const collapseWhitespaceRule: UserTextRule<'text.collapse-whitespace'> = {
  id: 'text.collapse-whitespace',
  order: 1010,
  transform(segments, context) {
    if (!context.read('collapseWhitespace')) return segments
    let result: UserTextNode[] | undefined
    let trailingSpace = false
    for (const [index, node] of segments.entries()) {
      if (node.id !== 'text') {
        trailingSpace = false
        result?.push(node)
        continue
      }
      let display = (node.data.display ?? node.data.text).replace(/\s+/gu, ' ')
      if (trailingSpace && display.startsWith(' ')) display = display.slice(1)
      if (display.length > 0) trailingSpace = display.endsWith(' ')
      const updated = withDisplay(node, display)
      if (updated !== node) result ??= segments.slice(0, index)
      result?.push(updated)
    }
    return result ?? segments
  },
}

/** Trim document-edge display whitespace when enabled, skipping empty Text displays but never crossing a business node. */
export const trimWhitespaceRule: UserTextRule<'text.trim-whitespace'> = {
  id: 'text.trim-whitespace',
  order: 1020,
  transform(segments, context) {
    if (!context.read('trimWhitespace')) return segments
    let result: UserTextNode[] | undefined
    for (const direction of [1, -1]) {
      let index = direction === 1 ? 0 : segments.length - 1
      while (index >= 0 && index < segments.length) {
        const node = (result ?? segments)[index]
        if (!node || node.id !== 'text') break
        const display = node.data.display ?? node.data.text
        const trimmed = direction === 1 ? display.trimStart() : display.trimEnd()
        const updated = withDisplay(node, trimmed)
        if (updated !== node) {
          result ??= [...segments]
          result[index] = updated
        }
        if (trimmed.length > 0) break
        index += direction
      }
    }
    return result ?? segments
  },
}
