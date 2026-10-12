import type { ChatConversationViewNode } from './chat-nodes.ts'

/**
 * Chat group-tree positions from the outermost grouping inward; a Node at a
 * position also stands outside every inner grouping.
 * - `exchange`: the Node's Turn opens an exchange, the run of Turns that lasts
 *   until the next opening Turn.
 * - `turn`: the Node stays in its Turn outside the Turn's process disclosure.
 * - `process`: the Node stays in the process disclosure outside step runs.
 *
 * Only `exchange` is read today; process disclosure and step runs still select
 * independent Nodes by kind (`TURN_PROCESS_INDEPENDENT_KINDS`, the process-group
 * `INDEPENDENT` set), so no Definition publishes `turn` or `process` yet.
 */
export type ChatGroupTree = 'exchange' | 'turn' | 'process'

const DEPTH: Readonly<Record<ChatGroupTree, number>> = { exchange: 0, turn: 1, process: 2 }

/**
 * Test whether a Node stands at a group-tree position or outside it.
 * @param node - Chat Node.
 * @param position - group-tree position to compare against.
 * @returns whether the Node's position is `position` or an outer one.
 */
export function isAtOrOutside(node: Pick<ChatConversationViewNode, 'groupTree'>, position: ChatGroupTree): boolean {
  return node.groupTree !== undefined && DEPTH[node.groupTree] <= DEPTH[position]
}
