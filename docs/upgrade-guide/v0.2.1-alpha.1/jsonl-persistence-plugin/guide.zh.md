---
kind: upgrade-guide
description: "JSONL 持久化包将默认导出的服务类改为函数插件的命名导出。"
---

# JSONL 持久化改用 namespace 插件导入

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-persistence-jsonl` 导出 `name`、`Config` 和 `apply`，不再默认导出服务类。这会影响导入或构造该类的代码。插件会保留监听器和句柄，直到移除该提供者所触发的消费者卸载完成；根作用域的并发卸载仍不保证顺序。`sessionPersistence` 服务 API、YAML 配置和存储文件保持不变。

## 迁移

1. 将默认导入替换为 `import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'`，继续通过 `ctx.plugin(JsonlSessionPersistence, config)` 挂载。
2. 将直接构造类实例改为挂载插件。消费者声明 `inject: ['sessionPersistence']` 并使用 `ctx.sessionPersistence`；服务类型标注使用 `@deepseek-ai/dsh-session-persistence` 的 `SessionPersistence` 类型。
3. 等待插件启动完成，确认能够创建、flush 并重新打开会话。将消费者的异步清理注册到注入 `sessionPersistence` 的作用域中，以便后端卸载时等待它完成。
