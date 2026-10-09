---
kind: upgrade-guide
description: "The JSONL persistence package replaces its default service-class export with named function-plugin exports."
---

# JSONL persistence uses a namespace plugin import

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-session-persistence-jsonl` exports `name`, `Config`, and `apply` instead of a default service class. This affects code that imports or constructs that class. The plugin owns listeners and handles through the consumer unloads triggered by removing this provider; concurrent root disposal remains unordered. The `sessionPersistence` service API, YAML configuration, and stored files remain unchanged.

## Migration

1. Replace default imports with `import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'`. Continue mounting with `ctx.plugin(JsonlSessionPersistence, config)`.
2. Replace direct class construction with plugin mounting. Consumers declare `inject: ['sessionPersistence']` and use `ctx.sessionPersistence`; use the `SessionPersistence` type from `@deepseek-ai/dsh-session-persistence` for service annotations.
3. Await plugin startup and confirm a session can be created, flushed, and reopened. Register asynchronous consumer cleanup in the scope that injects `sessionPersistence` so backend unloading waits for it.
