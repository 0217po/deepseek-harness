---
kind: upgrade-guide
description: "权限预设调用方必须等待执行资源清理后，再使用新权限。"
---
# 等待权限预设切换完成

[English](guide.md) | 中文

## 变更

`ctx.permissionPresets.set(session, name)` 返回 `Promise<string[]>`。保留的执行资源释放且权限事件提交后，Promise 才会完成。返回的字符串说明清空了哪些资源。独立的 `setSandboxMode(session, mode)` 导出被 `await ctx.sandboxPolicy.setMode(session, mode)` 替代，直接选择模式也使用同一个清理操作。模式变化也会取消待审批的 PTC 调用和默认 `per-call` 模式中正在执行的程序，并等待嵌套工具完成清理。无效预设和清理失败会使 Promise 拒绝。

## 迁移

1. 在新策略下启动工作前，等待 `ctx.permissionPresets.set(session, name)` 完成。
2. 处理 Promise 拒绝，替换只捕获同步异常的代码；实现权限控件时展示返回的提示。
3. 确认选择新沙箱模式的操作在下一个程序启动前完成。内置 `/permission` 命令已经等待完成并显示提示。
