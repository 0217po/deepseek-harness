---
kind: upgrade-guide
description: "Permission preset callers must await execution-resource cleanup before using the new permissions."
---
# Await permission preset changes

English | [中文](guide.zh.md)

## Change

`ctx.permissionPresets.set(session, name)` returns `Promise<string[]>`. The promise resolves after retained execution resources are released and permission events are committed. Its strings describe cleared resources. The standalone `setSandboxMode(session, mode)` export is replaced by `await ctx.sandboxPolicy.setMode(session, mode)` so direct mode changes use the same cleanup operation. A mode change also cancels pending approvals and in-flight PTC programs in the default `per-call` mode, waiting for nested tools to finish cleanup. Invalid presets and cleanup failures reject the promise.

## Migration

1. Await `ctx.permissionPresets.set(session, name)` before starting work under the new policy.
2. Replace the `setSandboxMode` import and calls with `await ctx.sandboxPolicy.setMode(session, mode)`, and declare `sandboxPolicy` in the plugin's `inject` list.
3. Handle promise rejection instead of catching only synchronous exceptions, and present returned notices when implementing a permission control.
4. Confirm that selecting a new sandbox mode completes before the next program starts. The built-in `/permission` command already waits and displays notices.
