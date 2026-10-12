---
kind: upgrade-guide
description: "终端 Remote 客户端通过同一 attach 流传输屏幕输出、键盘输入和尺寸调整。"
---

# 终端输入和输出共用附件流

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-api-terminal-controller` 的自定义客户端需将 `terminal.follow`、`terminal.write` 和 `terminal.resize` 替换为 `terminal.attach`。`TerminalAttachmentId` 和 `WebTerminalInfo.controllerId` 已移除。屏幕快照和状态帧携带属于当前附件的 `writable` 标记。内置 Web 客户端自动使用此协议。

## 迁移

1. 同时升级 Host 和浏览器资源。自定义客户端打开 `remote.terminal.attach(sessionId, terminalId, signal)`，迭代其屏幕、输出、状态和确认帧。
2. 通过句柄的 `send()` 发送 `TerminalInput` 命令：`write` 携带 `data`，`resize` 携带 `cols` 和 `rows`。每个附件的命令从一开始连续编号。`ack` 表示提供者已接受操作，除非其 `refusal` 报告失去控制权或进程已退出。未确认输入不得超过公布的字节限制；仅调用 `send()` 并不表示输入已被接受。
3. 从每个快照或状态帧读取 `writable`。输入被拒绝后停止发送，但继续显示输出。重连时使用新的附件和屏幕，绝不重放未确认输入。`retain` 和显式 `close` 继续独立于附件取消。
4. 验证键盘输入、尺寸调整、两个窗口间的控制权转移及重连后的屏幕恢复。进程所有权和限制见[包参考](../../../../packages/api/terminal-controller/README.zh.md)。
