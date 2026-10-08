---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-job-session-lifecycle

[English](2026-09-30-job-session-lifecycle.md) | 中文

## 概述

将有所有者 job 的注册与结算记录为仅日志 Session 事件，包含执行标识、原始时间戳、创建工具调用及生产方完成报告。

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
    after: "f05be3e066ef054a610f0825251f19ee3fcfc98908b5ceaa869ee143d7e91fa5"
    decision: same-version
  - root: "event:job/settled"
    previous: null
    after: "a103c03b3bc0ca7a7809d1eb2572dec08899f7a15a90072736777acd4e517648"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

增加事件类型，不修改现有负载或 Session 封装。历史会话仍有效，不补造 job 历史。旧构建会拒绝未知的必需事件类型。producerReported 描述生产方完成 promise 的兑现情况，不确认资源已释放。

<a id="verification"></a>
## 验证

定向注册表、归一化、关停与 headless 回归覆盖因果发布顺序、不同执行标识，以及已有退出时限内的清理。真实 CLI 快照和 SDK 回放验证注册/结算持久化与通知。

<a id="dev-note"></a>
## 开发备注

无。
