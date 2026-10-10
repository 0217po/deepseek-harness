/** Pure command-reference transforms restricted to confirmed ranges within current Text segments. */
import type { UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** The executed command name, without the leading slash. */
    command: { readonly name: string }
  }

  interface UserTextFacts {
    /** Confirmed command ranges; repeated command spelling outside them stays plain text. */
    readonly commands: readonly { readonly start: number; readonly end: number; readonly name: string }[]
  }
}

/** Replace exact confirmed command ranges; facts are read only for Text with a slash-token candidate. */
export const goalCommandReferenceRule: UserTextRule<'command'> = {
  id: 'command',
  order: 20,
  transform(segments, context) {
    if (!segments.some(segment => segment.id === 'text' && /(?:^|\s)\//u.test(segment.data.text))) return segments
    const commands = context.read('commands')
    if (commands === undefined || commands.length === 0) return segments
    const ordered = [...commands].sort((a, b) => a.start - b.start || a.end - b.end)
    let output: UserTextNode[] | undefined
    for (const [index, segment] of segments.entries()) {
      if (segment.id !== 'text') {
        output?.push(segment)
        continue
      }
      let remainder = segment
      for (const { start, end, name } of ordered) {
        if (start >= remainder.end) break
        if (start < remainder.start || end > remainder.end) continue
        const text = remainder.data.text
        const localStart = start - remainder.start
        const localEnd = end - remainder.start
        if (text.slice(localStart, localEnd) !== `/${name}`
          || (localStart !== 0 && !/\s/u.test(text.slice(localStart - 1, localStart)))
          || (localEnd !== text.length && !/\s/u.test(text.slice(localEnd, localEnd + 1)))) continue
        output ??= segments.slice(0, index)
        if (localStart > 0) output.push({
          id: 'text', start: remainder.start, end: start, data: { text: text.slice(0, localStart) },
        })
        output.push({ id: 'command', start, end, data: { name } })
        remainder = { id: 'text', start: end, end: remainder.end, data: { text: text.slice(localEnd) } }
      }
      if (remainder.start < remainder.end) output?.push(remainder)
    }
    return output ?? segments
  },
}
