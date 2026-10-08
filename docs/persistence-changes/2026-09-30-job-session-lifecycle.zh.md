---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-job-session-lifecycle

[English](2026-09-30-job-session-lifecycle.md) | 中文

## 概述

以唯一 JobId 将有所有者 job 的注册与结算记录为 Session 事件，包含原始时间戳、创建工具调用和生产方完成报告。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-30-job-session-lifecycle
baseline: false
changes:
  - root: "event:job/registered"
    previous: null
    after: "f5520c1d261ca86ea03735799c311a0a9ede8babb588cf0a65422576d2ee0ad1"
    decision: same-version
  - root: "event:job/settled"
    previous: null
    after: "edd37b1e4974af648633014435572089b1e8fb71910468a0767a7e28fdd22abf"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

增加必需的 job 事件类型，不改变 Session 封装。新 JobId 用带 kind 前缀的 UUID 同时进行运行期控制与持久化配对；不为历史会话补造 job 事件。旧构建拒绝未知的必需事件。producerReported 表示完成 promise 兑现，不确认资源已释放。

<a id="verification"></a>
## 验证

注册表、快照归一化、关停与 headless 测试覆盖因果顺序、唯一 JobId，以及正常退出和信号退出的有序清理。CLI 和 SDK 快照验证持久化注册、结算和通知。

<a id="dev-note"></a>
## 开发备注

无。
