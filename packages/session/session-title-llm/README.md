---
description: "Shared model-backed title generation policy for users and maintainers configuring title providers or debugging auxiliary LLM requests."
kind: "package-library"
---

# @deepseek-ai/dsh-session-title-llm

English | [中文](README.zh.md)

## Summary

`dsh-session-title-llm` generates concise session titles from selected human messages with a consistent model request policy. Callers choose which messages contribute to each revision and may either supply a provider and model route together or use the route recorded for the current session. Required limits cap the framed input, generated output, and end-to-end duration, while caller cancellation remains effective throughout streaming. Invalid, empty, late, tool-call, or otherwise non-text results are rejected before they can replace a title.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

As a deployment, configure this policy through the [first-prompt](../session-title-first-prompt-llm/README.md) or [all-prompts](../../experimental/session-title-all-prompts-llm/README.md) provider plugin. As a provider author, register through the shared helper instead of hand-rolling generation.

### Registering a provider

A provider plugin calls `registerSessionTitleLlmProvider(ctx, config, id, automatic, selectMessages)`; the helper validates the shared config, registers the provider on `ctx.sessionTitle`, and runs every generation through the shared policy. The two shipped plugins register the `first-prompt` and `all-prompts` cadences with their message selectors, and a second registration on the service throws.

### Route and failure contract

`provider` and `model` overrides are optional but must be supplied together as non-empty strings. Without that pair, the helper uses the exact provider/model route captured from the current session's logged `request/header`, so an explicit refresh before any route exists needs overrides. The helper measures the final JSON-framed user prompt against `maxInputBytes` before logging or dispatch instead of truncating it, and rechecks timeout and caller cancellation while consuming the stream and after it completes, so a late successful result cannot be accepted even if an interceptor or adapter ignores abort. Malformed or empty output, tool calls, and non-stop finish reasons reject; the session-title service decides whether that rejection is an automatic warning or an explicit caller failure. The accepted title is the first non-empty line of the model's text output, with one emphasis pair removed when it wraps that whole line, so commentary a model writes after the title cannot become the title. The title request uses `maxOutputTokens` independently of the conversation's cap. Its route must have a registered adapter so preparation can resolve the request before it is recorded.

### Configuration

<a id="configuration"></a>

Every field is required except the paired route override; there are no library defaults.

| Key | Default | Meaning |
|---|---|---|
| `targetWords` | required | Target word count for non-CJK titles |
| `targetCjkCharacters` | required | Target character count for Chinese, Japanese, or Korean titles |
| `maxInputBytes` | required | UTF-8 byte ceiling for the final JSON-framed user prompt |
| `maxOutputTokens` | required | Title output-token cap, independent of conversation requests |
| `timeoutMs` | required | End-to-end deadline within the runtime timer limit |
| `provider`, `model` | optional | Explicit route; both or neither |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the generation path; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

One shared policy so provider plugins cannot drift: config validation, route resolution, prompt framing, budget enforcement, cancellation, and output validation all live here, parameterized only by the provider's cadence and message selector.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema and validation, provider registration helper, request framing, dispatch, and output validation |

### Request flow

Each revision frames the selected messages as JSON and checks `maxInputBytes`. The title configuration function selects the first effort from the route's least-to-greatest list during `ctx.llm.prepareCall()`. The helper records the exact input, output cap, and resolved effort in `session/title-llm-request`, then dispatches through the same captured adapter generation under the shared deadline. `purpose: 'session-title'` supplies attribution only. The request has no agent-loop identity and does not enter conversation history. Generation failures preserve the request record.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the generation policy is not enough. They move from the service it plugs into to the provider plugins that consume it.

- [Session title service](../session-title/README.md) — the title service, fallback behavior, and provider registration contract.
- [Session title subsystem](../../../docs/subsystems/session-title.md) — durable title state and the auxiliary request record.
- [First-message title provider](../session-title-first-prompt-llm/README.md) — titles from the first eligible human message.
- [All-messages title provider](../../experimental/session-title-all-prompts-llm/README.md) — titles from every eligible human message.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary title request

#### What the model sees

The title model receives a fixed system instruction to return one concise unadorned title in the input language, including the configured word and CJK-character targets and a short title instead of an explanation when the messages give little to name. Its one user message contains a JSON array of the exact selected human messages and their seqs.

#### Token effect

The auxiliary request consumes tokens according to selected input size and `maxOutputTokens`. It is separate from the main agent request and does not add title text or framing to agent history. Title calls disable thinking on DeepSeek routes and use the model's lowest supported level on pi-ai routes; a model that cannot stop reasoning still spends part of `maxOutputTokens` on it. The main conversation retains its configured thinking mode.

#### KV Cache effect

No main-request invalidation. Auxiliary cache reuse is provider-specific; the fixed instruction is reusable while the JSON message array changes with each revision.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the accepted generation shapes. They are current package constraints.

- **Text output only** — the helper accepts text output and rejects tool calls; structured-output adapters and provider-specific prompt variants are not exposed.
- **Whole-prompt byte ceiling** — it enforces a byte ceiling for the whole framed user prompt rather than clipping individual messages or applying a retention policy.
- **Minimum reasoning is capability-dependent** — title policy selects the first advertised effort. Routes without selectable reasoning leave effort unspecified; the least selectable effort does not guarantee zero reasoning tokens or a complete title within the output cap.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
