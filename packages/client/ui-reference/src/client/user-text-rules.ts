/** Pure file and folder transforms scan current Text segments without discovery or facts reads. */
import type { UserTextNode, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

interface PathReferenceData {
  readonly path: string
  readonly label: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    file: PathReferenceData
    folder: PathReferenceData
  }
}

function appendText(nodes: UserTextNode[], segment: UserTextNode<'text'>, start: number, end: number): void {
  if (start < end) {
    nodes.push({
      id: 'text', start: segment.start + start, end: segment.start + end,
      data: { text: segment.data.text.slice(start, end) },
    })
  }
}

function transformPaths(segments: readonly UserTextNode[], id: 'file' | 'folder'): readonly UserTextNode[] {
  const nodes: UserTextNode[] = []
  let changed = false
  for (const segment of segments) {
    if (segment.id !== 'text') {
      nodes.push(segment)
      continue
    }
    const tokens = /(^|\s)(@"[^"\n]+"|@[^\s]+)/gu
    let cursor = 0
    for (const match of segment.data.text.matchAll(tokens)) {
      const prefix = match[1] as string // The boundary capture is empty at the start of text.
      const token = match[2] as string // Every match contains the reference capture.
      const start = match.index + prefix.length
      const raw = token.startsWith('@"') ? token : token.replace(/[.,;:!?，。；：！？]+$/u, '')
      if (raw.length <= 1) continue
      const path = raw.slice(1).replace(/^"|"$/gu, '')
      if (path.endsWith('/') !== (id === 'folder')) continue
      const label = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? raw.slice(1)
      appendText(nodes, segment, cursor, start)
      nodes.push({ id, start: segment.start + start, end: segment.start + start + raw.length, data: { path, label } })
      cursor = start + raw.length
    }
    if (cursor === 0) {
      nodes.push(segment)
    } else {
      changed = true
      appendText(nodes, segment, cursor, segment.data.text.length)
    }
  }
  return changed ? nodes : segments
}

/** Recognize whitespace-bounded `@` file paths, retaining quoted punctuation and source ranges. */
export const fileReferenceRule: UserTextRule<'file'> = {
  id: 'file',
  order: 30,
  transform: segments => transformPaths(segments, 'file'),
}

/** Recognize trailing-slash directories with the same grammar and root-label fallback as files. */
export const folderReferenceRule: UserTextRule<'folder'> = {
  id: 'folder',
  order: 30,
  transform: segments => transformPaths(segments, 'folder'),
}
