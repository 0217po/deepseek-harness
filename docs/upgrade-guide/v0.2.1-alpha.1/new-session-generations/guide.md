---
kind: upgrade-guide
description: "New Session creates a fresh Agent instead of reusing an existing empty Session."
---

# Start a fresh Agent with New Session

English | [中文](guide.zh.md)

## Change

In Web and Desktop, New Session creates a fresh Session and Agent using the current preset definition. It previously reused an existing empty Session in the workspace, which could retain tools from before an optional bundle changed.

Client calls to `uiWorkspace.startSession(workspaceId)` follow the same behavior. Workspace reconnection through `openWorkspace` or `connectWorkspace` still reuses an eligible blank. Calls with draft-preparation options preserve their existing reuse and content rules. Existing Agents retain their composition.

## Migration

1. After changing optional bundles, use New Session to obtain the current tool composition. Continue in an existing Session when its retained composition is intentional.
2. Client integrations that reconnect a workspace should use `openWorkspace` or `connectWorkspace`. Keep explicit draft-preparation options when preparing an existing draft.
3. Confirm that the new Agent has the selected tools; no persisted Session files or profile patches need rewriting.
