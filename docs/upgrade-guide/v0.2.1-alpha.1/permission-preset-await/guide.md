---
kind: upgrade-guide
description: "Permission preset callers must await execution-resource cleanup before using the new permissions."
---
# Await permission preset changes

English | [中文](guide.zh.md)

## Change

`ctx.permissionPresets.set(session, name)` returns `Promise<string[]>`. The promise resolves after retained execution resources are released and permission events are committed. Its strings describe cleared resources. Invalid presets and cleanup failures reject the promise.

## Migration

1. Await `ctx.permissionPresets.set(session, name)` before starting work under the new policy.
2. Handle promise rejection instead of catching only synchronous exceptions, and present returned notices when implementing a permission control.
3. Confirm that selecting a new sandbox mode completes before the next program starts. The built-in `/permission` command already waits and displays notices.
