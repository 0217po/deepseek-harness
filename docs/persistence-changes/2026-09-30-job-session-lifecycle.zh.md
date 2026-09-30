---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-30-job-session-lifecycle

[English](2026-09-30-job-session-lifecycle.md) | 中文

## 概述

将有所有者 job 的注册与结算记录为仅日志 Session 事件，包含执行标识、原始时间戳、创建工具调用及生产方终止确认。

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
    after: "e1a4e287dd40ca5559cc4a00bef7e111631c2556e17a114b7a21dfa735487782"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

增加事件类型，不修改现有负载或 Session 封装。历史会话仍有效，不补造 job 历史。旧构建会拒绝未知的必需事件类型。这些事实不会恢复工作、改变模型消息或在强制失败后确认资源已释放。

<a id="verification"></a>
## 验证

job 注册表与快照归一化定向测试通过：181 个测试，受影响文件覆盖率 100%。生产方测试通过：432 个测试、7 个平台跳过，受影响文件覆盖率 100%。同一改动包含 SDK 回放和持久化验证。

<a id="dev-note"></a>
## 开发备注

无。
