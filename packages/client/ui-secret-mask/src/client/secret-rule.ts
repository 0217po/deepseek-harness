/**
 * Original-text credential candidates. A value is recognized by its published
 * format alone: provider key and token prefixes, JSON Web Tokens, private key
 * blocks, and the password of an address that carries credentials. Free-form
 * passwords and `name=value` assignments have no such format and stay plain.
 *
 * Matching is prefix-pruned and linear and allocates nothing until it returns a
 * node. One literal-only alternation finds each place a format can begin, and
 * resumes inside a literal that can overlap the next one. Format checks are
 * bounded character comparisons and sticky `[class]*` runs, which end at the
 * first character outside the class and leave nothing to backtrack into. Run
 * ends, the next digit, and the next key-block `END` line are memoized per text
 * across queries, so each is measured once per text.
 */
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** One recognized credential range. */
    secret: {
      /** Display form of the original range; line breaks stay in place. */
      readonly masked: string
    }
  }
}

/** Character that replaces each hidden credential character in `masked`. */
export const MASK = '*'
/** Leading characters of a prefixed key left readable: the provider prefix and little else. */
const VISIBLE_PREFIX = 8
const MASKS = MASK.repeat(4096)
const MASKS_LF = `${MASKS}\n`
const MASKS_CR = `${MASKS}\r`
/** `count` marks: up to the shared string's length, one slice of it. */
const marks = (count: number): string => count <= MASKS.length ? MASKS.slice(0, count) : MASK.repeat(count)
/** `count` marks and then the line break `code`, 10 or 13: one slice where `marks` would be one. */
const marksThen = (count: number, code: number): string => count <= MASKS.length
  ? (code === 10 ? MASKS_LF : MASKS_CR).slice(MASKS.length - count)
  : MASK.repeat(count) + (code === 10 ? '\n' : '\r')

// Classes of one ASCII code unit, as bits of CLASSES.
const KEY = 1 // [A-Za-z0-9_-]
const ALNUM = 2 // [A-Za-z0-9]
const WORD = 4 // \w
const ALNUM_DASH = 8 // [A-Za-z0-9-]
const UPPER_ALNUM = 16 // [A-Z0-9]
const LABEL = 32 // [A-Z0-9 ]
const SCHEME = 64 // [a-z0-9+.-]
const LOWER = 128 // [a-z]
const USER = 256 // [^\s/:@?#]
const PASSWORD = 512 // [^\s/@?#]

const CLASSES = new Uint16Array(128)
for (let code = 0; code < 128; code++) {
  const upper = code >= 65 && code <= 90
  const lower = code >= 97 && code <= 122
  const digit = code >= 48 && code <= 57
  const alnum = upper || lower || digit
  const authority = !((code >= 9 && code <= 13) || code === 32 || code === 47 || code === 64 || code === 63 || code === 35)
  CLASSES[code] = (alnum || code === 95 || code === 45 ? KEY : 0) | (alnum ? ALNUM : 0) | (alnum || code === 95 ? WORD : 0)
    | (alnum || code === 45 ? ALNUM_DASH : 0) | (upper || digit ? UPPER_ALNUM : 0) | (upper || digit || code === 32 ? LABEL : 0)
    | (lower || digit || code === 43 || code === 46 || code === 45 ? SCHEME : 0) | (lower ? LOWER : 0)
    | (authority && code !== 58 ? USER : 0) | (authority ? PASSWORD : 0)
}

/** `\s` above ASCII. */
function isWideSpace(code: number): boolean {
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
    || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
}

/** `\w` at `index`; out of range is not a word character. */
function isWordAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return code < 128 && ((CLASSES[code] as number) & WORD) !== 0
}

/** `[^\s/:@?#]` for one UTF-16 code unit; NaN, read out of range, is not one. */
function isUserCode(code: number): boolean {
  return code < 128 ? ((CLASSES[code] as number) & USER) !== 0 : code === code && !isWideSpace(code)
}

/**
 * Sticky run patterns: nothing follows the starred class, so nothing backtracks,
 * and `test` allocates nothing. Every use sets `lastIndex` first; matching is
 * synchronous and never re-enters, so no two runs share a cursor.
 */
const KEY_RUN = /[A-Za-z0-9_-]*/y
const ALNUM_RUN = /[A-Za-z0-9]*/y
const WORD_RUN = /\w*/y
const ALNUM_DASH_RUN = /[A-Za-z0-9-]*/y
const UPPER_ALNUM_RUN = /[A-Z0-9]*/y
const USER_RUN = /[^\s/:@?#]*/y
const PASSWORD_RUN = /[^\s/@?#]*/y
const NON_DIGITS = /\D*/y
/** Code units that `maskLines` counts without inspection: neither line breaks nor surrogates. */
const ORDINARY = /[^\r\n\ud800-\udfff]*/y

/** Offset after the run that `pattern` matches at `start`. */
function runEnd(pattern: RegExp, text: string, start: number): number {
  pattern.lastIndex = start
  pattern.test(text)
  return pattern.lastIndex
}

// Literal kinds; same-start candidates resolve by ascending kind, so a token used as an address password is masked completely.
const KEY_BLOCK = 0
const ADDRESS = 1
const PREFIXED = 2
// Prefixed shapes.
const RUN = 0 // the whole run, at least `min`
const BOUNDED = 1 // `min`..`max`, then `\b`
const SK = 2 // at least `min`, with a digit among the first 256
const GOOGLE = 3 // exactly `min`
const JWT = 4 // three runs joined by `.eyJ` and `.`

interface Format {
  readonly literal: string
  readonly kind: number
  readonly shape: number
  readonly run: number
  readonly min: number
  readonly max: number
}

const format = (literal: string, kind: number, shape = RUN, run = 0, min = 0, max = 0): Format => ({ literal, kind, shape, run, min, max })

/** Every prefixed format matches more than `VISIBLE_PREFIX` characters. */
const FORMATS: readonly Format[] = [
  format('-----BEGIN ', KEY_BLOCK),
  format('://', ADDRESS),
  // Model services: `sk-` keys carry a digit, which hyphenated identifiers rarely do.
  format('sk-', PREFIXED, SK, KEY, 20),
  format('AIza', PREFIXED, GOOGLE, KEY, 35),
  // Code hosting and package registries.
  ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'].map(literal => format(literal, PREFIXED, RUN, ALNUM, 36)),
  format('github_pat_', PREFIXED, RUN, WORD, 22),
  format('glpat-', PREFIXED, RUN, KEY, 20),
  format('npm_', PREFIXED, RUN, ALNUM, 36),
  format('hf_', PREFIXED, RUN, ALNUM, 30),
  // Cloud access key IDs.
  format('AKIA', PREFIXED, BOUNDED, UPPER_ALNUM, 16, 16),
  format('ASIA', PREFIXED, BOUNDED, UPPER_ALNUM, 16, 16),
  format('LTAI', PREFIXED, BOUNDED, ALNUM, 12, 20),
  format('AKID', PREFIXED, BOUNDED, ALNUM, 28, 36),
  // Collaboration and payment services.
  ...['xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-'].map(literal => format(literal, PREFIXED, RUN, ALNUM_DASH, 10)),
  ...['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_'].map(literal => format(literal, PREFIXED, RUN, ALNUM, 16)),
  format('whsec_', PREFIXED, RUN, ALNUM, 24),
  format('eyJ', PREFIXED, JWT, KEY, 8, 2048),
]
const LITERAL_LENGTH = Uint8Array.from(FORMATS, f => f.literal.length)
const LITERAL_KIND = Uint8Array.from(FORMATS, f => f.kind)
const LITERAL_SHAPE = Uint8Array.from(FORMATS, f => f.shape)
const LITERAL_MIN = Int32Array.from(FORMATS, f => f.min)
const LITERAL_MAX = Int32Array.from(FORMATS, f => f.max)
const LITERAL_RUN: readonly RegExp[] = FORMATS.map(f => f.run === ALNUM ? ALNUM_RUN : f.run === WORD ? WORD_RUN
  : f.run === ALNUM_DASH ? ALNUM_DASH_RUN : f.run === UPPER_ALNUM ? UPPER_ALNUM_RUN : KEY_RUN)
/**
 * Length of the longest proper suffix of each literal that begins a literal. The
 * scan resumes there, so a key block whose first dash ends `sk-` is still seen.
 */
const LITERAL_OVERLAP = Uint8Array.from(FORMATS, (f) => {
  for (let size = f.literal.length - 1; size > 0; size--) {
    const suffix = f.literal.slice(-size)
    if (FORMATS.some(other => other.literal.startsWith(suffix))) return size
  }
  return 0
})

const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')

/** Literal alternatives grouped by shared leading characters; groups only factor literals and add no quantifier. */
function alternation(literals: readonly string[]): string {
  const groups = new Map<string, string[]>()
  for (const literal of literals) groups.set(literal.charAt(0), [...groups.get(literal.charAt(0)) ?? [], literal.slice(1)])
  return [...groups].map(([head, tails]) => tails.length === 1
    ? escape(head + tails.join(''))
    : `${escape(head)}(?:${alternation(tails)})`).join('|')
}

/** Literal-only alternation of every place a format can begin; no literal is a suffix of another. */
export const PREFIX_SOURCE = alternation(FORMATS.map(f => f.literal))
/** Compiled once; every query sets `lastIndex` before its first test. */
const PREFIXES = new RegExp(PREFIX_SOURCE, 'g')
/** Literal ending in two ASCII code units: its index plus one, or -1 where several literals share the ending. */
const ENDING = new Int8Array(128 * 128)
/** Literals that share an ending, by the same key. */
const SHARED_ENDINGS: number[][] = []
FORMATS.forEach((f, index) => {
  const key = f.literal.charCodeAt(f.literal.length - 2) * 128 + f.literal.charCodeAt(f.literal.length - 1)
  if (ENDING[key] === 0) {
    ENDING[key] = index + 1
    return
  }
  if ((ENDING[key] as number) > 0) {
    SHARED_ENDINGS[key] = [(ENDING[key] as number) - 1]
    ENDING[key] = -1
  }
  (SHARED_ENDINGS[key] as number[]).push(index)
})

const LITERALS: readonly string[] = FORMATS.map(f => f.literal)

/** Index of the literal that PREFIXES matched ending at `end`; one of the literals sharing its ending matches, so the last needs no check. */
function literalEndingAt(text: string, end: number): number {
  const key = text.charCodeAt(end - 2) * 128 + text.charCodeAt(end - 1)
  const literal = ENDING[key] as number
  if (literal > 0) return literal - 1
  const shared = SHARED_ENDINGS[key] as readonly number[]
  let index = 0
  for (; index < shared.length - 1; index++) {
    const candidate = shared[index] as number
    if (text.startsWith(LITERALS[candidate] as string, end - (LITERAL_LENGTH[candidate] as number))) break
  }
  return shared[index] as number
}

// Memo layout: [start, end] pairs. A lookup at `offset` hits when start <= offset <= end; -1 pairs hold nothing.
const KEY_SLOTS = 0 // four pairs: a JSON Web Token measures three runs
const KEY_NEXT = 8
const ALNUM_SLOT = 9
const WORD_SLOT = 11
const ALNUM_DASH_SLOT = 13
const UPPER_ALNUM_SLOT = 15
const USER_SLOT = 17
const PASSWORD_SLOT = 19
const DIGIT_FROM = 21
const DIGIT_AT = 22
const BLOCK_FROM = 23
const BLOCK_END_START = 24
const BLOCK_END = 25
/** Start of the password that the last address check accepted. */
const CANDIDATE_START = 26
const MEMO_SIZE = 27
const LITERAL_SLOT = Uint8Array.from(FORMATS, f => f.run === ALNUM ? ALNUM_SLOT : f.run === WORD ? WORD_SLOT
  : f.run === ALNUM_DASH ? ALNUM_DASH_SLOT : f.run === UPPER_ALNUM ? UPPER_ALNUM_SLOT : 0)

/** Memo entry at `index`; the layout keeps every index inside the array. */
const slotAt = (memo: Int32Array, index: number): number => memo[index] as number

/** End of the `[A-Za-z0-9_-]*` run at `start`, through four memo pairs replaced in turn. */
function keyRunEnd(text: string, start: number, memo: Int32Array): number {
  for (let slot = KEY_SLOTS; slot < KEY_NEXT; slot += 2) {
    if (slotAt(memo, slot) <= start && start <= slotAt(memo, slot + 1)) return slotAt(memo, slot + 1)
  }
  const end = runEnd(KEY_RUN, text, start)
  const next = (slotAt(memo, KEY_NEXT) + 1) & 3
  memo[KEY_NEXT] = next
  memo[KEY_SLOTS + 2 * next] = start
  memo[KEY_SLOTS + 2 * next + 1] = end
  return end
}

/** End of the run `pattern` matches at `start`, through the memo pair at `slot`. */
function memoRunEnd(pattern: RegExp, text: string, start: number, slot: number, memo: Int32Array): number {
  if (slotAt(memo, slot) <= start && start <= slotAt(memo, slot + 1)) return slotAt(memo, slot + 1)
  const end = runEnd(pattern, text, start)
  memo[slot] = start
  memo[slot + 1] = end
  return end
}

/** Offset of the first digit at or after `start`, or the text length. */
function nextDigit(text: string, start: number, memo: Int32Array): number {
  if (slotAt(memo, DIGIT_FROM) <= start && start <= slotAt(memo, DIGIT_AT)) return slotAt(memo, DIGIT_AT)
  memo[DIGIT_FROM] = start
  memo[DIGIT_AT] = runEnd(NON_DIGITS, text, start)
  return slotAt(memo, DIGIT_AT)
}

/** Offset after `[A-Z0-9 ]{0,40}PRIVATE KEY-----` at `start`, or -1; reads at most 52 characters. */
function labelEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + 52)
  let index = start
  while (index < limit) {
    const code = text.charCodeAt(index)
    if (code > 127 || ((CLASSES[code] as number) & LABEL) === 0) break
    index++
  }
  // "PRIVATE KEY" is label characters and the `-` after it is not, so the run ends right after it.
  const tail = index - 'PRIVATE KEY'.length
  return index < start + 52 && tail >= start && text.startsWith('PRIVATE KEY-----', tail) ? tail + 'PRIVATE KEY-----'.length : -1
}

/** Offset after the first complete `END` line at or after `start`, or the text length. */
function keyBlockEnd(text: string, start: number, memo: Int32Array): number {
  if (slotAt(memo, BLOCK_FROM) <= start && start <= slotAt(memo, BLOCK_END_START)) return slotAt(memo, BLOCK_END)
  memo[BLOCK_FROM] = start
  memo[BLOCK_END_START] = text.length
  memo[BLOCK_END] = text.length
  for (let at = text.indexOf('-----END ', start); at >= 0; at = text.indexOf('-----END ', at + 1)) {
    const end = labelEnd(text, at + '-----END '.length)
    if (end < 0) continue
    memo[BLOCK_END_START] = at
    memo[BLOCK_END] = end
    break
  }
  return slotAt(memo, BLOCK_END)
}

/** End of the `-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----` block at `at` through its first `END` line or the end of the text, or -1. */
function keyBlockCandidate(text: string, at: number, memo: Int32Array): number {
  const header = labelEnd(text, at + '-----BEGIN '.length)
  return header < 0 ? -1 : keyBlockEnd(text, header, memo)
}

/** Whether `\b[a-z][a-z0-9+.-]{1,15}` ends at `at`; reads at most 17 characters back. */
function schemeBefore(text: string, at: number): boolean {
  for (let start = at - 1; start >= 0 && start >= at - 16; start--) {
    const code = text.charCodeAt(start)
    const bits = code < 128 ? (CLASSES[code] as number) : 0
    if ((bits & SCHEME) === 0) return false
    if ((bits & LOWER) !== 0 && at - start >= 2 && !isWordAt(text, start - 1)) return true
  }
  return false
}

/**
 * The password in `\b[a-z][a-z0-9+.-]{1,15}://[^\s/:@?#]{0,256}:[^\s/@?#]+@` for the `://` at
 * `at`; neither part crosses `?` or `#`, where the authority ends. Callers pass a `://` at or after
 * the query offset, or one whose user name reaches it, so the password never starts before it.
 * @returns the password end with its start in `memo[CANDIDATE_START]`, or -1.
 */
function addressPassword(text: string, at: number, memo: Int32Array): number {
  if (!schemeBefore(text, at)) return -1
  const userStart = at + '://'.length
  const userEnd = memoRunEnd(USER_RUN, text, userStart, USER_SLOT, memo)
  if (userEnd - userStart > 256 || text.charCodeAt(userEnd) !== 58) return -1
  const start = userEnd + 1
  const end = memoRunEnd(PASSWORD_RUN, text, start, PASSWORD_SLOT, memo)
  if (end === start || text.charCodeAt(end) !== 64) return -1
  memo[CANDIDATE_START] = start
  return end
}

/**
 * The address password at or after `from` whose `://` starts before `from`, as `addressPassword`
 * returns it. The walk back over the user name runs only when a `:`, a password, and `@` follow.
 */
function addressBefore(text: string, from: number, memo: Int32Array): number {
  if (from < 3) return -1
  // `from` inside the `://`.
  if (text.startsWith('://', from - 1)) return addressPassword(text, from - 1, memo)
  if (text.startsWith('://', from - 2)) return addressPassword(text, from - 2, memo)
  let index = from - 1
  const before = text.charCodeAt(index)
  let passwordStart: number
  if (before === 58) {
    // The password starts at `from`, right after the user name's `:`.
    passwordStart = from
    index--
  } else if (isUserCode(before)) {
    const userEnd = memoRunEnd(USER_RUN, text, from, USER_SLOT, memo)
    if (text.charCodeAt(userEnd) !== 58) return -1
    passwordStart = userEnd + 1
  } else {
    return text.startsWith('://', from - 3) ? addressPassword(text, from - 3, memo) : -1
  }
  const passwordEnd = memoRunEnd(PASSWORD_RUN, text, passwordStart, PASSWORD_SLOT, memo)
  if (passwordEnd === passwordStart || text.charCodeAt(passwordEnd) !== 64) return -1
  // A user name is at most 256 characters, followed by `:`.
  const lowest = Math.max(0, passwordStart - 258)
  while (index >= lowest && isUserCode(text.charCodeAt(index))) index--
  return index >= 2 && text.startsWith('://', index - 2) ? addressPassword(text, index - 2, memo) : -1
}

/** End of the prefixed credential whose literal starts at `at`, or -1. */
function prefixedEnd(text: string, literal: number, at: number, memo: Int32Array): number {
  if (isWordAt(text, at - 1)) return -1
  const start = at + (LITERAL_LENGTH[literal] as number)
  const shape = (LITERAL_SHAPE[literal] as number)
  const min = (LITERAL_MIN[literal] as number)
  if (shape === SK) {
    // `(?=[A-Za-z0-9_-]{0,255}\d)[A-Za-z0-9_-]{20,}`: the memoized next digit rejects a digit-free `sk-` before any run is measured.
    const digit = nextDigit(text, start, memo)
    if (digit - start > 255) return -1
    const end = keyRunEnd(text, start, memo)
    return end - start >= min && digit < end ? end : -1
  }
  const slot = (LITERAL_SLOT[literal] as number)
  const end = slot === 0 ? keyRunEnd(text, start, memo) : memoRunEnd((LITERAL_RUN[literal] as RegExp), text, start, slot, memo)
  const length = end - start
  if (length < min) return -1
  if (shape === RUN) return end
  if (shape === GOOGLE) return start + min
  if (shape === BOUNDED) return length <= (LITERAL_MAX[literal] as number) && !isWordAt(text, end) ? end : -1
  // `[A-Za-z0-9_-]{8,2048}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` after `eyJ`.
  if (length > (LITERAL_MAX[literal] as number) || !text.startsWith('.eyJ', end)) return -1
  const payloadStart = end + '.eyJ'.length
  const payloadEnd = keyRunEnd(text, payloadStart, memo)
  if (payloadEnd - payloadStart < min || text.charCodeAt(payloadEnd) !== 46) return -1
  const signatureEnd = keyRunEnd(text, payloadEnd + 1, memo)
  return signatureEnd - (payloadEnd + 1) >= min ? signatureEnd : -1
}

/**
 * `text[start, end)` with every character except line breaks replaced; a
 * surrogate pair is one character, as `[^\r\n]` with the `u` flag counts it.
 * A character loop, because a native run could read far past `end`.
 */
function maskRange(text: string, start: number, end: number): string {
  let masked = ''
  let count = 0
  for (let index = start; index < end; index++) {
    const code = text.charCodeAt(index)
    if (code === 10 || code === 13) {
      masked += marksThen(count, code)
      count = 0
      continue
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < end) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) index++
    }
    count++
  }
  return masked + marks(count)
}

/**
 * `maskRange` for a key-block body, which ends at a line break or the end of the
 * text, so native runs stop at `end`. One slice of a shared string per line.
 */
function maskLines(text: string, start: number, end: number): string {
  let masked = ''
  let count = 0
  let index = start
  while (index < end) {
    const stop = Math.min(runEnd(ORDINARY, text, index), end)
    count += stop - index
    if (stop === end) break
    const code = text.charCodeAt(stop)
    index = stop + 1
    if (code === 10 || code === 13) {
      masked += marksThen(count, code)
      count = 0
      continue
    }
    // A high surrogate followed by a low one is one character.
    if (code <= 0xdbff && index < end) {
      const next = text.charCodeAt(index)
      if (next >= 0xdc00 && next <= 0xdfff) index++
    }
    count++
  }
  return masked + marks(count)
}

/** The display form of a range whose earliest candidate has `kind`; `plain` ranges hold only prefixed-format characters. */
function masked(text: string, kind: number, plain: boolean, start: number, end: number): string {
  if (kind === ADDRESS) return maskRange(text, start, end)
  if (kind === PREFIXED) {
    const prefix = text.slice(start, start + VISIBLE_PREFIX)
    return prefix + (plain ? marks(end - start - VISIBLE_PREFIX) : maskRange(text, start + VISIBLE_PREFIX, end))
  }
  // A key block keeps its `BEGIN` line, its `END` line when present, and every line break; one written on one line is masked whole.
  const firstBreak = text.indexOf('\n', start)
  const bodyStart = firstBreak < 0 || firstBreak >= end ? start : firstBreak + 1
  const endLine = text.lastIndexOf('\n-----END', end - 1)
  const bodyEnd = endLine < bodyStart ? end : endLine
  return text.slice(start, bodyStart) + maskLines(text, bodyStart, bodyEnd) + text.slice(bodyEnd, end)
}

/**
 * Create the credential matcher. Each instance owns a memo of the last queried
 * text, which it keeps until a query for another text.
 * @returns the `secret` rule; it reads no Facts, so Facts changes never invalidate its queries.
 */
export function createSecretRule(): UserTextRule<'secret'> {
  const memo = new Int32Array(MEMO_SIZE).fill(-1)
  let memoText: string | undefined

  return {
    id: 'secret',
    // Same-start ties with other rules draw the credential masked.
    order: 0,
    /**
     * Return the nearest credential at or after `from`. Overlapping candidates of any format join
     * the earliest one and take its mask, so no credential is drawn half masked. Candidates arrive
     * in start order; an address password waits until the scan passes its start, and no other
     * `://` can occur before then, because a user name and a password exclude `/`. A password that
     * starts inside a range also ends inside it: the range holds the `:` before the password, so it
     * is a key block, whose `END` line has spaces, or one that runs to the end of the text.
     */
    match(text, from) {
      if (text !== memoText) {
        memo.fill(-1)
        memoText = text
      }
      const length = text.length
      let start = -1
      let end = -1
      let kind = PREFIXED
      let plain = true
      let deferredEnd = addressBefore(text, from, memo)
      let deferredStart = deferredEnd < 0 ? -1 : slotAt(memo, CANDIDATE_START)
      PREFIXES.lastIndex = from
      while (PREFIXES.test(text)) {
        const literalEnd = PREFIXES.lastIndex
        const literal = literalEndingAt(text, literalEnd)
        const at = literalEnd - (LITERAL_LENGTH[literal] as number)
        PREFIXES.lastIndex = literalEnd - (LITERAL_OVERLAP[literal] as number)
        if (deferredStart >= 0 && deferredStart <= at) {
          if (start < 0) {
            start = deferredStart
            end = deferredEnd
            kind = ADDRESS
          } else if (deferredStart >= end) {
            break
          }
          deferredStart = -1
        }
        // A candidate starts at or after its literal, so none past the range reaches it; nothing extends a range to the end.
        if (start >= 0 && (at >= end || end === length)) break
        const literalKind = (LITERAL_KIND[literal] as number)
        if (literalKind === ADDRESS) {
          deferredEnd = addressPassword(text, at, memo)
          deferredStart = deferredEnd < 0 ? -1 : slotAt(memo, CANDIDATE_START)
          continue
        }
        const candidateEnd = literalKind === KEY_BLOCK ? keyBlockCandidate(text, at, memo) : prefixedEnd(text, literal, at, memo)
        if (candidateEnd < 0) continue
        if (start < 0) {
          start = at
          end = candidateEnd
          kind = literalKind
          plain = literalKind === PREFIXED
        } else if (candidateEnd > end) {
          end = candidateEnd
          if (literalKind !== PREFIXED) plain = false
        }
      }
      if (start < 0 && deferredStart >= 0) {
        start = deferredStart
        end = deferredEnd
        kind = ADDRESS
      }
      if (start < 0) return undefined
      return { id: 'secret', start, end, data: { masked: masked(text, kind, plain, start, end) } }
    },
  }
}
