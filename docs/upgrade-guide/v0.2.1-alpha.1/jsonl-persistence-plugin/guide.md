---
kind: upgrade-guide
description: "The JSONL persistence default export is a plugin object; direct service-class construction and class type annotations must use the persistence service instead."
---

# Mount JSONL persistence through its plugin

English | [中文](guide.zh.md)

## Change

The default export of `@deepseek-ai/dsh-session-persistence-jsonl` is a plugin object rather than the service class. Existing default imports and `ctx.plugin(JsonlSessionPersistence, config)` calls remain valid. Direct construction, subclassing, `instanceof`, and class type annotations are affected. The plugin retains listeners and handles through the consumer unloads triggered by removing this provider; concurrent root disposal remains unordered. The `sessionPersistence` service API, YAML configuration, and stored files remain unchanged.

## Migration

1. Replace direct construction with `ctx.plugin(JsonlSessionPersistence, config)`, using the existing default import. Consumers declare `inject: ['sessionPersistence']` and access `ctx.sessionPersistence`.
2. Use the `SessionPersistence` type from `@deepseek-ai/dsh-session-persistence` for service annotations. Replace concrete-class `instanceof` checks and subclasses with consumers of that service; the concrete JSONL class is private.
3. Await plugin startup and confirm a session can be created, flushed, and reopened. Register asynchronous consumer cleanup in the scope that injects `sessionPersistence` so backend unloading waits for it.
