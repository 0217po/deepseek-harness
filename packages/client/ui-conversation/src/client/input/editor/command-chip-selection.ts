/**
 * Two-step command chip deletion. A character deletion (Backspace, Delete,
 * or an input-event deletion) whose direction reaches the command chip from a
 * collapsed caret first selects the chip; the next deletion in that direction
 * removes it. Any other key, a click, blur, or a caret that no longer touches
 * the chip clears the selection. The selected state is presentation on the
 * chip's host and the root element; the editor selection stays a collapsed
 * range beside the chip, so typing and arrows keep their plain-text behavior.
 */
import type { LexicalEditor, NodeKey } from 'lexical'
import {
  $getAdjacentNode, $getSelection, $isRangeSelection, BLUR_COMMAND, CLICK_COMMAND, COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH, DELETE_CHARACTER_COMMAND, KEY_DOWN_COMMAND,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'
import { $isCommandChipNode } from './command-chip-node.tsx'
import type { CommandChipNode } from './command-chip-node.tsx'

/** Keys that keep a selected chip: deletions and bare modifiers. */
const RETAINING_KEYS = new Set(['Backspace', 'Delete', 'Shift', 'Control', 'Alt', 'Meta'])

/** The chip a collapsed caret deletes next in one direction, or null. */
function $commandChipBesideCaret(isBackward: boolean): CommandChipNode | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
  const node = $getAdjacentNode(selection.focus, isBackward)
  return $isCommandChipNode(node) ? node : null
}

/**
 * Register two-step deletion for the command chip.
 * @param editor - the shell-owned editor.
 * @returns the unregister disposer, which also clears a selected chip.
 */
export function registerCommandChipSelection(editor: LexicalEditor): () => void {
  let selected: { readonly key: NodeKey; readonly isBackward: boolean } | null = null
  const paint = (next: typeof selected): void => {
    if (selected !== null && selected.key !== next?.key) {
      editor.getElementByKey(selected.key)?.removeAttribute('data-selected')
    }
    selected = next
    if (next !== null) editor.getElementByKey(next.key)?.setAttribute('data-selected', '')
    editor.getRootElement()?.toggleAttribute('data-composer-chip-selected', next !== null)
  }
  const clear = (): false => {
    if (selected !== null) paint(null)
    return false
  }
  return mergeRegister(
    editor.registerCommand(DELETE_CHARACTER_COMMAND, (isBackward) => {
      const chip = $commandChipBesideCaret(isBackward)
      if (chip === null || (selected?.key === chip.getKey() && selected.isBackward === isBackward)) return clear()
      paint({ key: chip.getKey(), isBackward })
      return true
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(KEY_DOWN_COMMAND, event => RETAINING_KEYS.has(event.key) ? false : clear(), COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(CLICK_COMMAND, clear, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(BLUR_COMMAND, clear, COMMAND_PRIORITY_CRITICAL),
    editor.registerUpdateListener(({ editorState }) => {
      const current = selected
      if (current === null) return
      const touching = editorState.read(() => $commandChipBesideCaret(current.isBackward)?.getKey() === current.key)
      // A restore can remount the chip's host element; repaint keeps the mark on it.
      paint(touching ? current : null)
    }),
    () => { paint(null) },
  )
}
