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

function textSlice(segment: UserTextNode<'text'>, start: number, end: number): UserTextNode<'text'> {
  return {
    id: 'text', start, end,
    data: { text: segment.data.text.slice(start - segment.start, end - segment.start) },
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
      const text = segment.data.text
      let cursor = segment.start
      for (const { start, end, name } of ordered) {
        if (start >= segment.end) break
        if (start < cursor || end > segment.end) continue
        const localStart = start - segment.start
        const localEnd = end - segment.start
        if (text.slice(localStart, localEnd) !== `/${name}`
          || (localStart !== 0 && !/\s/u.test(text.slice(localStart - 1, localStart)))
          || (localEnd !== text.length && !/\s/u.test(text.slice(localEnd, localEnd + 1)))) continue
        output ??= segments.slice(0, index)
        if (cursor < start) output.push(textSlice(segment, cursor, start))
        output.push({ id: 'command', start, end, data: { name } })
        cursor = end
      }
      if (output !== undefined) {
        if (cursor === segment.start) output.push(segment)
        else if (cursor < segment.end) output.push(textSlice(segment, cursor, segment.end))
      }
    }
    return output ?? segments
  },
}
