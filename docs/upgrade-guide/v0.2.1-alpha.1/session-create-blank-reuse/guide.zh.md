---
kind: upgrade-guide
description: "`session.create` 只在指明的 Session 仍是可复用的空白会话时复用它，按请求的或默认的 preset 运行，不再接管其他 Session。"
---

# `session.create` 只复用空白会话，并运行请求的 preset

[English](guide.md) | 中文

## 变更

`session.create`（客户端插件中为 `ctx.sessions.create`）过去只要 `sessionId` 指明的 Session 存在就返回它：活动的 Session 原样返回，已存储的 Session 按其日志记录的 preset 恢复，无论它是否已开始轮次。记录的 preset 不再声明时以 `agent-preset/not-found` 失败；请求的 `agentPreset` 与记录的不同时以带 `existingPreset` 的 `agent-preset/conflict` 失败；Session 被其他写者占用时以 `session/writer-held` 失败。

现在指明的 Session 只是复用候选。仅当它尚未开始任何轮次、属于请求的目录、是请求工作区中未归档的成员且没有其他写者时，Host 才复用它。被复用的 Session 运行请求的 `agentPreset`，请求未指明时运行配置的默认 preset；Host 不解析其记录的 preset，变更记录为 `agent-preset/selected`。其他候选保持不变，Host 改为新建 Session；响应中的 `sessionId` 指明实际使用的 Session。未存储任何 Session 的 `sessionId` 仍按该标识新建，属于其他目录的候选仍以 `session/conflict` 失败。

`session.create` 不再返回 `session/writer-held`。`agent-preset/conflict` 只在部署未组装 preset 列表、且请求为被复用的 Session 指明 preset 时出现，其详情不再包含 `existingPreset`。

受影响的是向 `session.create` 传入 `sessionId` 的 JSON-RPC 客户端与客户端插件。Web 导航已在同一版本中更新。

## 迁移

1. 从响应的 `sessionId` 读取 Session，不要假定使用了请求的标识。
2. 继续已有对话时，用 `ctx.sessions.retain(target, options)` 或 `ctx.uiWorkspace.openSession(target)` 打开它，或直接发送 `session.prompt`；这些方式按记录的 preset 恢复 Session。不要为此调用 `session.create`。
3. 要保留空白草稿自己的 preset，把该 preset 作为 `agentPreset` 传入。若 Host 返回 `agent-preset/not-found` 或 `agent-preset/invalid`，不带 `agentPreset` 再请求一次，在默认 preset 下继续，与 Web 启动恢复的做法相同。
4. 删除 `session.create` 周围对 `session/writer-held` 的处理，以及从 `agent-preset/conflict` 读取 `existingPreset` 的代码。
5. 验证迁移：指明已开始轮次的 Session 时返回不同的 `sessionId`；指明记录的 preset 已不再声明的空白会话时请求成功，响应中的 `agentPreset` 为配置的默认 preset。
