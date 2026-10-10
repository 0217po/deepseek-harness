/** Per-document linear evaluation, dynamic fact dependencies, failure caching and JSON identity reuse. */
import type { UserTextFacts } from '../index.ts'
import type {
  UserTextDocumentInput, UserTextNode, UserTextRule, UserTextTransformContext,
} from '../contract/user-text.ts'

type FactKey = keyof UserTextFacts

class UserTextTransformError extends Error {
  constructor(readonly ruleId: string, cause: unknown) {
    super(`user-text rule "${ruleId}" failed to transform`, { cause })
    this.name = 'UserTextTransformError'
  }
}

interface Stage {
  definition: UserTextRule
  input: readonly UserTextNode[]
  /** Most recent valid nodes, initially the input, retained for reuse after a failed attempt. */
  output: readonly UserTextNode[]
  error: UserTextTransformError | undefined
  reads: ReadonlyMap<FactKey, unknown>
  dirty: boolean
}

/** Internal cache owned by one evaluator; no registry or React lifetime is retained here. */
export class UserTextDocument {
  private text: string | undefined
  private initial: readonly UserTextNode[] = Object.freeze([])
  private rules: readonly UserTextRule[] | undefined
  private readonly stages = new Map<string, Stage>()
  private readonly readers = new Map<FactKey, Set<Stage>>()
  private readonly frozen = new WeakSet<object>()
  private evaluating = false

  /**
   * Evaluate current ordered definitions, retaining only this document's stage state.
   * @param input - original text and immutable caller facts.
   * @param rules - immutable definitions sorted by order and ID.
   * @returns complete immutable nodes; failures throw with ruleId and cause, without partial publication.
   */
  evaluate(input: UserTextDocumentInput, rules: readonly UserTextRule[]): readonly UserTextNode[] {
    if (this.evaluating) throw new Error('user-text document evaluation cannot be reentrant')
    this.evaluating = true
    try {
      this.prepare(input, rules)
      let segments = this.initial
      for (const definition of rules) {
        let stage = this.stages.get(definition.id)
        if (!stage) {
          stage = { definition, input: segments, output: segments, error: undefined, reads: new Map(), dirty: true }
          this.stages.set(definition.id, stage)
        }
        if (stage.dirty || stage.definition !== definition || stage.input !== segments) {
          this.run(stage, definition, segments, input)
        }
        if (stage.error) throw stage.error
        segments = stage.output
      }
      return segments
    } finally {
      this.evaluating = false
    }
  }

  private prepare(input: UserTextDocumentInput, rules: readonly UserTextRule[]): void {
    if (this.text !== input.text) {
      this.text = input.text
      this.stages.clear()
      this.readers.clear()
      this.initial = input.text.length === 0 ? [] : [
        { id: 'text', start: 0, end: input.text.length, data: { text: input.text } },
      ]
      this.freeze(this.initial)
    }
    if (this.rules !== rules) {
      const ids = new Set(rules.map(rule => rule.id))
      for (const [id, stage] of this.stages) {
        if (ids.has(id)) continue
        this.replaceReads(stage, new Map())
        this.stages.delete(id)
      }
      this.rules = rules
    }
    // Dirty flags persist until their stage executes, including stages blocked by an upstream failure.
    for (const [key, stages] of this.readers) {
      const value = input.facts[key]
      for (const stage of stages) {
        if (!Object.is(stage.reads.get(key), value)) stage.dirty = true
      }
    }
  }

  private run(stage: Stage, definition: UserTextRule, segments: readonly UserTextNode[], input: UserTextDocumentInput): void {
    const reads = new Map<FactKey, unknown>()
    let active = true
    const context: UserTextTransformContext = Object.freeze({
      read: <K extends FactKey>(key: K): UserTextFacts[K] | undefined => {
        if (!active) throw new Error('user-text transform context is closed; read is synchronous only')
        const value = input.facts[key]
        reads.set(key, value)
        return value
      },
    })
    stage.definition = definition
    stage.input = segments
    stage.dirty = false
    stage.error = undefined
    try {
      let output: readonly UserTextNode[]
      try {
        output = definition.transform(segments, context)
      } finally {
        active = false
      }
      validateOutput(input.text, definition.id, segments, output)
      const aligned = alignNodes(output, stage.output, segments)
      this.freeze(aligned)
      stage.output = aligned
    } catch (cause) {
      stage.error = new UserTextTransformError(definition.id, cause)
    } finally {
      this.replaceReads(stage, reads)
    }
  }

  private replaceReads(stage: Stage, reads: ReadonlyMap<FactKey, unknown>): void {
    for (const key of stage.reads.keys()) {
      const readers = this.readers.get(key)
      if (readers) {
        readers.delete(stage)
        if (readers.size === 0) this.readers.delete(key)
      }
    }
    stage.reads = reads
    for (const key of reads.keys()) {
      let readers = this.readers.get(key)
      if (!readers) this.readers.set(key, readers = new Set())
      readers.add(stage)
    }
  }

  private freeze(value: unknown): void {
    if (value === null || typeof value !== 'object' || this.frozen.has(value)) return
    for (const child of Object.values(value)) this.freeze(child)
    Object.freeze(value)
    this.frozen.add(value)
  }
}

function assertSynchronousOutput(output: unknown): void {
  if (!Array.isArray(output)) throw new Error('transform must return a synchronous node array')
}

function validateOutput(
  text: string, ruleId: string, input: readonly UserTextNode[], output: readonly UserTextNode[],
): void {
  assertSynchronousOutput(output)
  if (output === input) return
  let cursor = 0
  const sources = input.values()
  let source = sources.next().value
  for (const node of output) {
    if (!Number.isInteger(node.start) || !Number.isInteger(node.end)
      || node.start !== cursor || node.end <= node.start || node.end > text.length) {
      throw new Error(`invalid range [${node.start}, ${node.end}); expected contiguous coverage from ${cursor} to ${text.length}`)
    }
    if (!source) throw new Error('output exceeds input text coverage')
    if (source.id !== 'text') {
      if (!equalNode(node, source)) throw new Error(`cannot replace atomic node "${source.id}" at ${source.start}`)
    } else if (node.id === 'text') {
      if (node.data.text !== text.slice(node.start, node.end)) throw new Error('text node must preserve its original substring')
      while (node.end > source.end) {
        source = sources.next().value
        if (!source || source.id !== 'text') throw new Error('text node cannot consume an atomic node or exceed input coverage')
      }
    } else if (node.id !== ruleId || node.end > source.end) {
      throw new Error(`new business node must use "${ruleId}" within one input text segment`)
    }
    cursor = node.end
    if (node.end === source.end) source = sources.next().value
  }
  if (cursor !== text.length) throw new Error(`incomplete text coverage: ended at ${cursor}, expected ${text.length}`)
}

function alignNodes(
  output: readonly UserTextNode[], previous: readonly UserTextNode[] | undefined, input: readonly UserTextNode[],
): readonly UserTextNode[] {
  if (output === previous || output === input) return output
  let previousIndex = 0
  let inputIndex = 0
  let aligned: UserTextNode[] | undefined
  for (const [index, node] of output.entries()) {
    let inputNode = input[inputIndex]
    while (inputNode && inputNode.start < node.start) inputNode = input[++inputIndex]
    let previousNode = previous?.[previousIndex]
    while (previousNode && previousNode.start < node.start) previousNode = previous?.[++previousIndex]
    const reused = inputNode && equalNode(node, inputNode) ? inputNode
      : previousNode && equalNode(node, previousNode) ? previousNode : node
    if (reused !== node && !aligned) aligned = output.slice(0, index)
    aligned?.push(reused)
  }
  const nodes = aligned ?? output
  if (previous && equalElements(nodes, previous)) return previous
  return equalElements(nodes, input) ? input : nodes
}

function equalElements(left: readonly UserTextNode[], right: readonly UserTextNode[]): boolean {
  return left === right || (left.length === right.length && left.every((node, index) => node === right[index]))
}

function equalNode(left: UserTextNode, right: UserTextNode): boolean {
  return Object.is(left, right) || (left.id === right.id && left.start === right.start && left.end === right.end
    && equalJson(left.data, right.data))
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => Object.hasOwn(right, key)
    && equalJson(Reflect.get(left, key), Reflect.get(right, key)))
}
