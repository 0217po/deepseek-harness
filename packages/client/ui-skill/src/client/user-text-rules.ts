/** Pure skill-reference transforms over current Text segments and caller-confirmed names. */
import type { UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** A skill name confirmed for this message, without the leading slash. */
    skill: { readonly name: string }
  }

  interface UserTextFacts {
    /** Resolved skill names; absence supplies no skill references. */
    readonly skillNames: readonly string[]
  }
}

function textSlice(segment: UserTextNode<'text'>, start: number, end: number): UserTextNode<'text'> {
  return {
    id: 'text', start, end,
    data: { text: segment.data.text.slice(start - segment.start, end - segment.start) },
  }
}

/** Replace complete slash tokens; confirmed names are read only after a syntactically valid candidate. */
export const skillReferenceRule: UserTextRule<'skill'> = {
  id: 'skill',
  order: 20,
  transform(segments, context) {
    let names: ReadonlySet<string> | undefined
    let output: UserTextNode[] | undefined
    for (const [index, segment] of segments.entries()) {
      if (segment.id !== 'text') {
        output?.push(segment)
        continue
      }
      let cursor = segment.start
      for (const token of segment.data.text.matchAll(/\S+/gu)) {
        const raw = token[0]
        if (!/^\/[\w-]+$/u.test(raw)) continue
        if (names === undefined) {
          const confirmed = context.read('skillNames')
          if (confirmed === undefined || confirmed.length === 0) return segments
          names = new Set(confirmed)
        }
        const name = raw.slice(1)
        if (!names.has(name)) continue
        const start = segment.start + token.index
        const end = start + raw.length
        output ??= segments.slice(0, index)
        if (cursor < start) output.push(textSlice(segment, cursor, start))
        output.push({ id: 'skill', start, end, data: { name } })
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
