/** Pure attachment references use only caller-confirmed ranges and durable identities. */
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** A durable attachment identity, never a path inferred from its display name. */
export type UserTextAttachment =
  | { readonly type: 'image'; readonly ref: ImageAttachmentRef }
  | { readonly type: 'file'; readonly ref: FileAttachmentRef }

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    attachment: { readonly attachment: UserTextAttachment }
  }

  interface UserTextFacts {
    readonly attachments: readonly {
      readonly start: number
      readonly end: number
      readonly attachment: UserTextAttachment
    }[]
  }
}

function appendText(nodes: UserTextNode[], segment: UserTextNode<'text'>, start: number, end: number): void {
  if (start < end) {
    nodes.push({
      id: 'text', start, end,
      data: { text: segment.data.text.slice(start - segment.start, end - segment.start) },
    })
  }
}

/**
 * Read explicit attachment facts only when Text remains; never infer references from names.
 * Invalid or overlapping fact ranges throw; valid ranges outside a single Text segment stay unclaimed.
 */
export const attachmentReferenceRule: UserTextRule<'attachment'> = {
  id: 'attachment',
  order: 15,
  transform(segments, context) {
    const lastSegment = segments.at(-1)
    if (!lastSegment || !segments.some(segment => segment.id === 'text')) return segments
    const attachments = context.read('attachments')
    if (!attachments?.length) return segments
    const end = lastSegment.end
    for (const range of attachments) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end)
        || range.start < 0 || range.end <= range.start || range.end > end) {
        throw new RangeError(`invalid attachment range [${range.start}, ${range.end}); expected a nonempty UTF-16 range within [0, ${end})`)
      }
    }
    const ranges = [...attachments].sort((left, right) => left.start - right.start)
    let previousEnd = 0
    for (const range of ranges) {
      if (range.start < previousEnd) {
        throw new RangeError(`overlapping attachment range [${range.start}, ${range.end})`)
      }
      previousEnd = range.end
    }
    const nodes: UserTextNode[] = []
    let changed = false
    let rangeIndex = 0
    for (const segment of segments) {
      if (segment.id !== 'text') {
        nodes.push(segment)
        continue
      }
      let cursor = segment.start
      for (let range = ranges[rangeIndex]; range && range.start < segment.end; range = ranges[++rangeIndex]) {
        if (range.start < segment.start || range.end > segment.end) continue
        appendText(nodes, segment, cursor, range.start)
        nodes.push({ id: 'attachment', start: range.start, end: range.end, data: { attachment: range.attachment } })
        cursor = range.end
      }
      if (cursor === segment.start) {
        nodes.push(segment)
      } else {
        changed = true
        appendText(nodes, segment, cursor, segment.end)
      }
    }
    return changed ? nodes : segments
  },
}
