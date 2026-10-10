/** Session references transform only remaining Text segments; wire references are resolved before bare labels. */
import type { UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    session: { readonly label: string }
  }
  interface UserTextFacts {
    sessionLabels: readonly string[]
  }
}

interface SessionRange {
  readonly start: number
  readonly end: number
  readonly label: string
}

function replaceSessions(
  segments: readonly UserTextNode[],
  rangesOf: (text: string) => readonly SessionRange[],
): readonly UserTextNode[] {
  let result: UserTextNode[] | undefined
  for (const [index, segment] of segments.entries()) {
    if (segment.id !== 'text') {
      result?.push(segment)
      continue
    }
    const ranges = rangesOf(segment.data.text)
    if (ranges.length === 0) {
      result?.push(segment)
      continue
    }
    result ??= segments.slice(0, index)
    let cursor = 0
    for (const range of ranges) {
      if (range.start < cursor) continue
      if (range.start > cursor) {
        result.push({ id: 'text', start: segment.start + cursor, end: segment.start + range.start,
          data: { text: segment.data.text.slice(cursor, range.start) } })
      }
      result.push({ id: 'session', start: segment.start + range.start, end: segment.start + range.end,
        data: { label: range.label } })
      cursor = range.end
    }
    if (cursor < segment.data.text.length) {
      result.push({ id: 'text', start: segment.start + cursor, end: segment.end,
        data: { text: segment.data.text.slice(cursor) } })
    }
  }
  return result ?? segments
}

/** Session wire forms need no Facts; bare labels read their dependency only while unclaimed @ text remains. */
export const sessionReferenceRule: UserTextRule<'session'> = {
  id: 'session',
  order: 10,
  transform(segments, context) {
    const wire = replaceSessions(segments, text => [...text.matchAll(/@\[([^\]\n]+)\]\(dsh-session:[^)\s]+\)/gu)]
      .map(match => ({ start: match.index, end: match.index + match[0].length, label: match[1] as string })))
    if (!wire.some(segment => segment.id === 'text' && segment.data.text.includes('@'))) return wire
    const labels = context.read('sessionLabels')
    if (labels === undefined || labels.length === 0) return wire
    const unique = [...new Set(labels)]
    return replaceSessions(wire, (text) => {
      const ranges: SessionRange[] = []
      for (const label of unique) {
        const spelling = `@${label}`
        let start = text.indexOf(spelling)
        while (start >= 0) {
          ranges.push({ start, end: start + spelling.length, label })
          start = text.indexOf(spelling, start + spelling.length)
        }
      }
      return ranges.sort((a, b) => a.start - b.start || b.end - a.end)
    })
  },
}
