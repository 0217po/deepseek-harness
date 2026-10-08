---
kind: upgrade-guide
description: "`session.create` reuses a named Session only while it is a reusable blank, under the requested or default preset, and no longer adopts other Sessions."
---

# `session.create` reuses only blank Sessions, under the requested preset

English | [中文](guide.zh.md)

## Change

`session.create` (`ctx.sessions.create` in Client plugins) previously returned the Session named by `sessionId` whenever it existed: a live Session as it was, or a stored one resumed under the preset its log recorded, whether or not it had started a turn. A recorded preset that was no longer declared failed with `agent-preset/not-found`, a requested `agentPreset` that differed from the recorded one failed with `agent-preset/conflict` carrying `existingPreset`, and a Session written by another owner failed with `session/writer-held`.

The named Session is now a reuse candidate. The Host reuses it only while no turn has started, it belongs to the requested directory, it is an unarchived member of the requested Workspace, and no other owner writes it. A reused Session runs the requested `agentPreset`, or the configured default when the request names none; its recorded preset is not resolved, and a change is logged as `agent-preset/selected`. Any other candidate stays unchanged and the Host creates a new Session; the response `sessionId` names the Session used. A `sessionId` with no stored Session still creates a Session under that identity, and a candidate in another directory still fails with `session/conflict`.

`session.create` no longer returns `session/writer-held`. `agent-preset/conflict` occurs only when the deployment composes no preset roster and the request names a preset for a reused Session, and its details no longer include `existingPreset`.

JSON-RPC clients and Client plugins that pass `sessionId` to `session.create` are affected. Web navigation is updated in the same release.

## Migration

1. Read the Session from the response `sessionId`; do not assume that the requested identity was used.
2. To continue an existing conversation, open it with `ctx.sessions.retain(target, options)` or `ctx.uiWorkspace.openSession(target)`, or send `session.prompt`; these resume the Session under its recorded preset. Do not use `session.create` for it.
3. To keep a blank draft's own preset, pass that preset as `agentPreset`. If the Host answers `agent-preset/not-found` or `agent-preset/invalid`, request again without `agentPreset` to continue under the default, as Web startup restoration does.
4. Remove `session/writer-held` handling around `session.create` and reads of `existingPreset` from `agent-preset/conflict`.
5. Confirm the migration: naming a Session that has started a turn returns a different `sessionId`, and naming a blank whose recorded preset is no longer declared succeeds with the configured default as the response `agentPreset`.
