/** Synchronous ordered transformations over immutable JSON nodes and caller-supplied facts. */

import type { UserTextDataMap, UserTextFacts } from '../index.ts'

/** Registered business IDs plus the document-owned `text` ID. */
export type UserTextId = Extract<keyof UserTextDataMap, string>

type JsonPayload<T> = T extends string | number | boolean | null ? T
  : T extends (...args: never[]) => unknown ? never
    : T extends readonly unknown[] ? { readonly [K in keyof T]: JsonPayload<T[K]> }
      : T extends object ? { readonly [K in keyof T]: JsonPayload<T[K]> }
        : never

/** Original UTF-16 text and immutable facts; absence is observable through `context.read`. */
export interface UserTextDocumentInput {
  readonly text: string
  readonly facts: Readonly<Partial<UserTextFacts>>
}

/** Discriminated JSON node over a nonempty half-open UTF-16 range in the original text. */
export type UserTextNode<K extends UserTextId = UserTextId> = {
  [Id in K]: {
    readonly id: Id
    readonly start: number
    readonly end: number
    readonly data: JsonPayload<UserTextDataMap[Id]>
  }
}[K]

/** Facts reader valid only during its owning synchronous transform call; never retain it. */
export interface UserTextTransformContext {
  /**
   * Record a field dependency, including an absent value; throws after the transform returns or throws.
   * @param key - field of the caller's immutable facts snapshot.
   * @returns the borrowed read-only value, or undefined when absent.
   */
  read<K extends keyof UserTextFacts>(key: K): UserTextFacts[K] | undefined
}

/** One synchronous linear stage; rule IDs need not be node kinds, but `text` remains reserved. */
export interface UserTextRule<Id extends string = string> {
  readonly id: Id
  /** Finite order, ascending; ties use code-unit ID ordering, not registration order. */
  readonly order: number
  /**
   * May split or merge adjacent Text nodes, update their `data.display`, and create business nodes using this rule's ID.
   * Text `data.text` always retains its original substring; display transforms compose from `display ?? text`.
   * Must not mutate inputs or consume or rewrite existing business nodes.
   * @param segments - complete, frozen upstream nodes in original UTF-16 coordinates.
   * @param context - synchronous facts reader; reads replace this stage's previous dependencies.
   * @returns full ordered source coverage; new business nodes stay within one input Text segment.
   * Preserve unchanged input objects and return the input array when nothing changes.
   */
  transform(segments: readonly UserTextNode[], context: UserTextTransformContext): readonly UserTextNode[]
}

/**
 * Evaluate one document with current registered rules; the caller alone owns its cache lifetime.
 * Reentrant calls throw. A failed stage throws an Error carrying ruleId and cause, never partial output;
 * its failure and reads are cached until its definition, upstream input, text or a read field changes.
 * @param input - original text and immutable JSON facts; fields are compared with Object.is.
 * @returns frozen nodes covering the text, or [] for empty text; equivalent results retain identities.
 */
export type UserTextEvaluator = (input: UserTextDocumentInput) => readonly UserTextNode[]
