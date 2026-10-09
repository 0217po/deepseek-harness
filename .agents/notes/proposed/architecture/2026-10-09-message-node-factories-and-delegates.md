# Agent Note: Message image Factories with explicit loaders

Status: proposed

English | [中文](2026-10-09-message-node-factories-and-delegates.zh.md)

## Problem

Message images pass through multiple layers of application props via custom `renderMessageImages` / `renderImages` functions that combine the rendering entry point with image-loading capability. Chat, Trajectory, and Tool need to retain their own image replacement positions while allowing official default entries and third-party wrapper entries to reuse the same gallery implementation.

## Proposal

Follow the [division between Body Slots and Content Factories](../../implemented/architecture/2026-10-09-reasoning-content-slot-factory.md), using only the existing `registerFactory`, `renderFactorySlot`, and ordinary image Slots.

| Entry point | Responsibility |
| --- | --- |
| `conversation.message.images.view` Factory | Reusable entry point for Chat images, scoped to the Session; owns and calls the existing `conversation.message.images` Slot. |
| `conversation.trajectory.images.view` Factory | Reusable entry point for Trajectory images, scoped to the Session; owns and calls the existing `conversation.trajectory.images` Slot. |
| `conversation.message.images.content` Factory | Official gallery implementation, scoped to root; receives images, an authorized loader, layout parameters, and optional complete labels. |

Chat and Trajectory each retain the owning package and Session scope of their existing image Slot. Each entry-point Factory exclusively owns its Slot declaration; ChatFlow and TrajectoryView do not repeat it. The attachment plugin continues to provide the default entries; both defaults and the Tool image entry call the same Content Factory. Disabling the official attachment plugin does not remove the Chat or Trajectory image positions, so third parties can still provide implementations.

Image-rendering components call the corresponding entry point through the framework's `renderFactorySlot`, explicitly passing image references, `loadImage`, and presentation parameters. Conversation continues to manage read authorization, per-Session URL caching, and cleanup; Factories do not look up a global current Session. The gallery, load retries, thumbnails, and lightbox continue to use the attachment package's existing components; they do not move to ui-primitives.

`AssistantNodeView` passes `loadImage` to `AssistantMarkdown`; `UserMessageNodeView` and Flow's pending-input bubbles pass it to `UserStyleBubble`. `AssistantMarkdown` and `UserStyleBubble` call the Chat image entry-point Factory at their existing image positions, retaining their component responsibilities and keys. These short prop paths keep the authorized loader explicit without a separate image adapter. Cross-plugin `ChatNodeOwnerProps.loadImage` and the image Factories' loader parameters remain explicit.

`ChatView` directly supplies the existing `MarkdownDelegateProvider` with `requestOpenFile`, `openExternalLink`, and `fileImages`. The wrapped file opener retains Chat's failure feedback and retry handling; Markdown navigation and image handling remain unchanged.

`MessageImagesContentInput` adds an optional complete `MessageImageLabels` to the existing image parameters. Supplied labels are used unchanged; when omitted, the official Content Factory's locale seat provides the default copy.

## Alternatives considered

**Expose only the gallery component and import it directly across feature packages.** This bypasses the standard image Slots and framework assembly and cannot preserve existing third-party replacement support.

**Continue passing custom image-rendering functions.** This mixes rendering entry points with authorized reads; the existing Factories already provide reusable entry points.

**Supply the loader implicitly through ImageDelegateProvider and extend Markdown node bindings.** This exceeds what native message-image reuse requires; the short explicit-loader prop paths and existing Markdown implementation are sufficient.

## Acceptance criteria

- Chat and Trajectory no longer define or pass custom rendering functions of type `RenderMessageImages`; image entry points use the framework's Factory renderer.
- Default image entries for Chat, Trajectory, and Tool reuse the official Content Factory; plugins replacing the original image Slots can still take over the corresponding positions.
- Image Factories and cross-plugin Slots receive the loader explicitly, preserving existing authorization, caching, preview URLs, image order, layout, retry, and lightbox behavior.
- Native Assistant, user-message, and pending-input images retain their component responsibilities, drawing positions, and keys, with `loadImage` passed through explicit props to each Factory call.
- Markdown still uses Chat's wrapped file-open action through the existing `MarkdownDelegateProvider`, with the same external-link and file-image capabilities.
- The Content Factory supports both default labels and caller-supplied complete custom labels.
- Markdown code blocks, Markdown images, generic Delegate Providers, the incremental parser, the renderer framework, and UserMessage text semantics remain unchanged.

## Risks

Each entry-point Factory must own the sole declaration of its original image Slot; downstream calls must not bypass existing replacement positions. The shared gallery remains root-scoped, but reads of persistent images must use the authorized loader explicitly provided by the caller.

Explicit prop forwarding requires each native-image call site to supply its authorized loader. Required verification covers image Factory assembly, replacement and unloading, native Assistant/user/pending-input loader paths, preserved keys, default and custom labels, and Markdown file-open failure feedback.
