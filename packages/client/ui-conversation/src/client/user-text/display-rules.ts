/** Display-only text transforms; source coordinates and business payloads remain unchanged. */
import type { UserTextNode, UserTextRule } from '../contract/user-text.ts'

function withDisplay(node: UserTextNode<'text'>, display: string): UserTextNode<'text'> {
  if (display === (node.data.display ?? node.data.text)) return node
  return { ...node, data: { ...node.data, display } }
}

function mapTextDisplay(
  segments: readonly UserTextNode[], transform: (display: string) => string,
): readonly UserTextNode[] {
  let result: UserTextNode[] | undefined
  for (const [index, node] of segments.entries()) {
    const updated = node.id === 'text' ? withDisplay(node, transform(node.data.display ?? node.data.text)) : node
    if (updated !== node) result ??= segments.slice(0, index)
    result?.push(updated)
  }
  return result ?? segments
}

/** Remove whole emoji graphemes only when `stripEmoji` is true; ordinary letters and digits are preserved. */
export const stripEmojiRule: UserTextRule<'text.strip-emoji'> = {
  id: 'text.strip-emoji',
  order: 1000,
  transform(segments, context) {
    if (!context.read('stripEmoji')) return segments
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
    const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Presentation}]|^[0-9#*]\ufe0f?\u20e3/u
    return mapTextDisplay(segments, (display) => {
      let result = ''
      for (const { segment } of segmenter.segment(display)) {
        if (!emoji.test(segment)) result += segment
      }
      return result
    })
  },
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
