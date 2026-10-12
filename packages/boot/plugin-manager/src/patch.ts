/** Comment-preserving profile plugin enablement edits. */
import { readFile } from 'node:fs/promises'
import { isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Flatten only the groups addressable by the profile's patch composer.
 * @param rows Composed top-level entries.
 * @returns Entries in depth-first order.
 */
export function flatten(rows: EntryOptions[]): EntryOptions[] {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config as EntryOptions[]) : [])])
}

/** Replace the last matching override or append one after existing insertions. An override that holds only `id` and
 * `disabled` is removed, or not appended, when the bundle layers and the remaining profile patches already give the
 * entry the requested enablement.
 * @param filename Current profile patch file.
 * @param id Unique composition entry id.
 * @param name Module name used to match name-qualified overrides.
 * @param enabled Desired entry enablement.
 * @param layers Bundle patches applied before the profile patch file.
 * @returns Whether the file changed.
 */
export async function writePluginEnabled(
  filename: string, id: string, name: string, enabled: boolean, layers: readonly PatchOptions[],
): Promise<boolean> {
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  const error = document.errors[0]
  if (error !== undefined) throw error
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  const patches = loadOptionalPatches('dsh', filename) ?? []
  const items = document.contents.items
  const target = items.findLast((item, index) => {
    if (!isMap(item) || document.getIn([index, 'id']) !== id || item.has('insert')) return false
    const expectedName = document.getIn([index, 'name'])
    return !expectedName || expectedName === name
  })
  const inherits = (index: number): boolean => {
    const row = flatten(composeEntries([[...layers, ...patches.toSpliced(index, 1)]])).find(entry => entry.id === id)
    return row !== undefined && (row.disabled ?? false) === !enabled
  }
  if (isMap(target)) {
    const index = items.indexOf(target)
    const onlySwitch = target.items.every(pair => isScalar(pair.key) && (pair.key.value === 'id' || pair.key.value === 'disabled'))
    if (onlySwitch && inherits(index)) {
      document.deleteIn([index])
      // The comment above the removed override can be the file header, so it moves to the following node.
      const comment = target.commentBefore
      const next = items[index]
      if (comment && isNode(next)) next.commentBefore = next.commentBefore ? `${comment}\n${next.commentBefore}` : comment
      else if (comment) document.comment = document.comment ? `${comment}\n${document.comment}` : comment
    } else if (document.getIn([index, 'disabled']) === !enabled) {
      return false
    } else {
      document.setIn([index, 'disabled'], !enabled)
    }
  } else {
    if (inherits(items.length)) return false
    document.add({ id, disabled: !enabled })
  }
  await writeFileAtomic(filename, String(document), { mode: 0o600 })
  return true
}
