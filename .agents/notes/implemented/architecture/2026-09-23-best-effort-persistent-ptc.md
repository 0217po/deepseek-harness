# Agent Note: Best-effort persistent PTC memory

Status: implemented

English | [中文](2026-09-23-best-effort-persistent-ptc.zh.md)

## Problem

Interactive automation retains application objects, imported modules and helper functions between model calls. Recreating every object for every program prevents consumers from using ordinary JavaScript references across observations and actions.

## Decision

The optional `dsh-ptc-runtime-node/persistent` provider keeps an unsandboxed Node REPL process per explicit, object-identity state owner. PTC uses the live Agent as owner and awaits release during its context disposal. The default [sandboxed provider](2026-09-11-sandboxed-node-ptc-runtime.md) retains its fresh-process behavior. This extends the [PTC foundation](../feature/2026-06-15-ptc.md) with disposable memory, while preserving registry dispatch and logged model requests.

The Session records submitted programs, nested tool calls and returned output. It does not serialize the REPL heap or rerun earlier programs after restart, resume or fork: replaying automation could repeat external side effects. A missing variable is a normal program error, and the model-visible instructions require recreating variables and reacquiring resources. No environment identifier or new durable Session event is required because the provider exposes no unlogged model input.

Cancellation, deadline expiry, protocol or output-limit failure, owner disposal and process exit discard the environment. Ordinary exceptions retain earlier mutations. A retained function uses the active evaluation's host bindings; asynchronous work from an earlier evaluation cannot acquire a later evaluation's tool authority or output sink.

## Alternatives considered

Serializing arbitrary JavaScript objects cannot preserve native resources and closures. Replaying prior programs can repeat writes and input actions. Both would imply recovery guarantees that this provider does not offer.

A realm inside the Harness process shares process lifetime with model code and cannot terminate a synchronous loop independently. A managed child process permits cancellation and resource cleanup while retaining imports and variables during healthy use. This process is not a file sandbox or a multi-tenant security boundary.

## Consequences

Enabling the provider grants direct Node code full host access. It is opt-in, rejects explicit sandbox policies, and leaves nested tools under their normal authorization and logging. Memory and native handles may disappear without a Harness restart. The model must recover from reference or resource errors; the runtime never retries a program automatically.

An idle owner retains a process with no expiration timer. Callers release owners explicitly; ownerless service calls use temporary processes. Programs use REPL statements and a final expression rather than top-level return, and calls for one retained owner cannot overlap.
