# Agent Note: Linear user-text transforms, Facts dependencies, and business-node rendering

Status: implemented

English | [中文](<2026-10-10-user-text-json-nodes.zh.md>)

## Problem

User text contains plain text and structured references from different businesses. Each business needs to extend recognition, JSON data, and presentation independently; a Facts field update must not repeat matching for unrelated businesses. Processing must be deterministic, and text processing, caching, and dependency tracking must remain independent of React component lifecycles.

## Decision

The design is “business registration → linear segment transforms → pure JSON nodes → keyed Slot → the business Slot's own Injection.” The existing UserText registry composes the pipeline, the data-layer runner evaluates and incrementally updates it, and React displays only the final nodes.

### Linear pipeline

Nonempty original text starts as one Text segment covering `[0, text.length)`; empty text produces an empty array. Registrations sort only by ascending `order`, then by stable registration ID for ties, independently of plugin load timing and without grouping by processing category. Each stage applies one synchronous `transform` to the preceding stage's result, with no additional passes or repetition to a fixed point. Registration order values explicitly express rule precedence.

Each stage receives the complete current readonly segment array. Segments outside its scope retain their references; changed parts produce new objects. Text recognition operates on the current eligible Text segments, while existing business nodes remain atomic and pass through to later stages. Rules must not independently match the initial full text and substitute global candidate sorting for sequential transforms.

The original text remains unchanged, and output retains its original UTF-16 coordinates. Each stage's output is ordered, nonoverlapping, and covers the same original-text range; replacement nodes retain the ranges they consume. A business must not rejoin text separated by structured nodes into adjacent text or scan the preceding stage's JSX or display labels.

### Transform and read Context

Each registration contains a unique registration ID, order, and transform function. New business nodes use that rule's ID; rules that only process Text display values need no corresponding business node or renderer. Every rule follows the same original-text coverage and business-node protection constraints. The core interfaces are:

```ts
import type { UserTextFacts, UserTextNode } from '@deepseek-ai/dsh-client-ui-conversation/client'

interface UserTextTransformContext {
  read<K extends keyof UserTextFacts>(
    key: K,
  ): UserTextFacts[K] | undefined
}

interface UserTextRule<Id extends string = string> {
  readonly id: Id
  readonly order: number
  transform(
    segments: readonly UserTextNode[],
    context: UserTextTransformContext,
  ): readonly UserTextNode[]
}
```

Context reads facts and records dependencies for the current synchronous evaluation; it is not a Cordis Context, React Context, or service locator. It exposes only readonly Facts fields, not actions such as opening files, navigation, or attachment loading, and must not be retained beyond the current evaluation.

Businesses do not receive the complete Facts object, maintain separate `dependsOn` declarations, or receive `previous` or cache objects. Matching, regular expressions, and table lookups are implementation details of each business transform, not business-specific branches in the shared runner.

### Actual read dependencies

The runner creates a read record for each stage evaluation. `context.read(key)` returns the value from the current Facts snapshot and records the field and its version or value reference. Reading `undefined` also establishes a dependency, so the field's later appearance can trigger recomputation.

Each execution collects its actual read set anew and replaces the old record rather than permanently accumulating fields it no longer reads. A business may return early for irrelevant input; a stage that does not call `read('skillNames')` is not invalidated when that field changes.

Dependency tracking operates at Facts-field granularity. Reading `skillNames` depends on that field, without automatically tracking individual array elements. Fields update immutably; a new outer Facts object reference does not mean every field changed.

### Incremental updates and caching

For each document and stage, the runner stores input segments, actually read fields and their versions, the rule version, and output segments, plus a reverse index from Facts fields to the stages that read them. Linear order already expresses upstream relationships, so there is no general dependency graph of arbitrary form.

When Facts update, only stages that actually read changed fields are marked invalid. The runner proceeds in pipeline order: a stage recomputes only when its own dependencies, rule, or upstream output change; otherwise it reuses the cache. Unchanged stage output stops downstream invalidation caused by that stage, but later stages that directly read other changed fields still execute.

Original-text changes recompute every stage from the single initial Text segment; character-level incremental parsing is not required. Rule additions, removals, reordering, or implementation updates cause reevaluation from the earliest affected stage; earlier unaffected caches can be reused.

The document's data-layer evaluation instance owns its cache. The registry creates a document evaluation callback but retains neither the callback nor the document and adds no registry subscription for the document; releasing the callback from the display binding also releases the document cache. Separate text instances do not share evaluators, and caches are not shared across Sessions by original-text string. Unmounted history does not need to reread Session logs for display-rule updates.

### Reference reuse and determinism

Input arrays, nodes, and Facts use readonly TypeScript types; the runner borrows values without freezing or copying them. Rules must not `splice` input in place, mutate node payloads, or use retained references to modify later results. Unchanged input nodes remain shared; entirely unchanged results retain the array reference instead of using full deep copies for isolation.

The runner retains its previous output internally to align recomputed results. When new business nodes are equivalent to old nodes in ID, original-text range, and JSON data, the old objects can be reused; when all result elements are identical, the old array is reused. Comparison occurs only in stages that need recomputation, with a reference-equality fast path first, rather than serializing the whole pipeline on every refresh.

Old results serve only the runner's object reuse, not business decisions. The same original text, rule order, and Facts snapshot must produce the same JSON content on initial evaluation, repeated evaluation, and incremental updates.

### Facts and display Props

The document runner receives only `{ text, facts }`. Facts contain only business context and processing parameters actually needed by transforms, consumed through `Context.read`; a value does not belong in Facts merely because it is configuration. Pure display behavior, such as UserText interaction and CSS ellipsis, uses ordinary React Props that the runner does not read. The core does not branch on scenario names such as message body, queue, or Goal.

Each node has `{ id, start, end, data }`. `id` is the business type and the node Slot's key; `start` and `end` define a nonempty half-open UTF-16 range in the original text; `data` is that business's JSON payload. Text's `data.text` always retains the original text, while `data.display` is optional display text. Ordinary transforms may set display values or perform valid Text-segment transforms, but must not change the original text, break coverage, or consume existing business nodes. Node identity within a document combines the business ID and original-text position, never just the business ID or array index.

Nodes and Facts contain no functions, ReactNode, service handles, DOM, observables, Date, or Map. `UserTextDataMap` and `UserTextFacts` are extensible declarations on the public `/client` entry point, and internal types reference those same declarations; business declaration merging must survive in published type files. Type constraints and unit tests ensure JSON compatibility, without repeatedly serializing and validating entire trees of trusted same-process input.

Callers supply business Facts; the runner does not query global state for them. Skills use confirmed names, session references use associated labels, commands use actual execution ranges. Ordinary file paths can be recognized from text alone; an attachment display name is not a file path and must not be used to guess an attachmentId.

`collapseWhitespace` and `trimWhitespace` each control one text-display transform and are disabled by default. Each rule reads only its own switch and uses the preceding stage's display result. Whitespace collapsing continues across consecutive Text segments but not business nodes; trimming affects only the document's two ends without removing normal spaces between references. Built-in rules use ordinary `order` values to place these transforms after existing reference recognition, preserving characters and identity within references; there is no additional category priority.

`interactive` and CSS `ellipsis` are React Props, not Facts. Ellipsis neither removes original text nor limits the number of input characters. The queue enables whitespace collapsing and trimming through Facts and ellipsis through display Props; message bodies and Goal retain full display. Callers retain no `previewOf`, 200-character pre-truncation, or concatenated unknown-block placeholders; nontext attachments continue through the existing attachment display.

Reference summaries obtain display data from `UserContentData.referenceLabels`, not Facts. The session-reference transform still obtains recognition input through `Context.read('sessionLabels')`. Callers pass the same label array by reference to both consumers, without copying it or introducing a second state.

### Rendering and interaction ownership

`conversation.user.text` is a session-scoped Factory that independently owns the session/keyed `conversation.user.text.node`. UserText traverses final nodes in order and selects each renderer by node ID, without centralized skill or file rendering branches. Default entries use `priority: 100`; external businesses override the corresponding keys through the existing Slot mechanism.

`ui-conversation` provides `text` and session labels; `ui-skill` provides skills; `ui-reference` provides ordinary file and directory references; `ui-goal` provides Goal command markers. Each business's own Slot registration declares its action dependencies. Parsed data carries no callbacks, and parent layouts do not forward node-specific actions.

The display layer passes the `interactive` Prop and original-text fragment `raw` to node renderers; these are ordinary data, not execution capabilities. Reference actions may appear only when `interactive` is true. Queues, submission echoes, and pending incoming input remain nonclickable; sessions, directories, and commands remain labels by default. Native attachments remain outside the text pipeline: file cards retain their name and size, and image galleries use the existing Session-authorized loader.

The file-reference business handles file-navigation failures rather than returning them to the Chat action aggregator. A local Modal provides retry and close actions; synchronous navigation adds neither request sequence numbers nor fictitious aborts. Document previews still handle file-read errors, and Sidebar retains its existing public location semantics. Existing Assistant Markdown feedback and component responsibilities remain separate.

Inline node Slots use span anchors with `inline: true` and inline error placeholders, retaining `data-slot` and `display: contents`; default DOM for other Slots is unchanged. Text selection, keyboard activation, protection against unintended opening on double-click, line wrapping, and queue ellipsis behavior are preserved. This introduces no business Context, React transform stages, or general injection inheritance.

### Publication and failure

Only fully successful evaluation results may be published. Failures publish no partial segments; the display layer retains the original text and reports the business ID. Fields read during a failed execution still establish dependencies for later retries. Missing node renderers fall back to the node's original-text fragment, while component exceptions use the framework's existing isolation mechanism.

React learns about rule-version changes through the existing framework, passes the current original text and Facts to an independent document evaluation callback, and consumes only final node results. Stage dependencies, cache updates, and result alignment all stay in the data layer. The display layer does not feed input or segments back through effects and reuses rendered elements when the node array is unchanged. Unloading a rule revokes its registration, and the document's next evaluation removes the corresponding dependencies; the fact-reading Context must not leak into nodes or display components.

### Scope

UserContent retains attachments, the body container, unknown content, and reference summaries, while the message wrapper retains ownership of keys, timestamps, copying, and pending/echo state. Queue, Goal, and Chat reuse UserText's data processing and rendering entry point. The native attachment-list loader, draft editing model, persisted Session original text, and Assistant responsibilities are outside this pipeline refactor.

## Verification requirements

- Registering a new business requires only a transform, JSON type, and keyed renderer, with no new business branches in the shared runner or UserText.
- After an earlier rule claims text, later rules calculate from the actual remaining segments rather than presenting initial full-text candidates as current matches.
- Changes to unread Facts fields do not execute a stage; reading an absent field allows its later appearance to trigger recomputation; conditional read dependencies can be added or removed.
- When a stage's Facts change but its output remains equivalent, old node and array references are reused and unrelated downstream stages do not execute; later stages that directly depend on other changed fields still execute.
- Original-text changes run the entire pipeline; incremental results match a newly created evaluation instance with the same input.
- Readonly type assertions cover arrays and payloads; node output is ordered, fully covers the original text without overlaps, and survives a JSON round-trip.
- Only `order/id` determines sequence; transform unit tests cover ordinary registration order for built-in display transforms, independent switches, whitespace across adjacent segments, document-edge trimming, emoji preservation, and reference atomicity.
- Text processing executes no UI actions; Slot-injected actions do not make previews clickable; registration and unloading leak no evaluation state or subscriptions.

## Alternatives considered

**Independent full-text matching with global arbitration.** This cannot express each stage's input after earlier rules consume text.

**React component transform chain.** Text processing, dependency tracking, and caching must remain independent of display lifecycles.

## Consequences

Field-level dependencies do not promise element-level invalidation within a field; a changed field that a stage reads can still require that stage to execute. Result alignment also has comparison costs, so reference reuse is not zero computation. Any rule update may affect previously plain text, so history updates cannot be filtered solely by existing business-node IDs. Every business must honor readonly inputs and synchronous determinism; external mutable state, hidden reads, or asynchronous Context use break dependency correctness. File-feedback ownership changes and inline Slot behavior require independent display-layer verification rather than data-layer tests alone.
