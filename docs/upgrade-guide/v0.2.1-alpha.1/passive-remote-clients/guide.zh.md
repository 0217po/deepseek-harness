---
kind: upgrade-guide
description: 自定义 Remote Client 组合必须显式启用转发的 Host 事件，才能订阅事件和处理交互。
---

# 显式选择转发 Host 事件

[English](guide.md) | 中文

## 变更

Gateway Client 默认被动运行。生成的一元和流式方法仍可调用，但 `$on()` 订阅和由事件监督的 `$stream()` API 要求 `forwardedEvents: true`。被动调用方不加入审批/提问 waterfall（瀑布式事件），也不启动转发事件的 Connection 恢复循环。

随附的 Web profile 显式启用转发。依赖自动转发的自定义 profile 和直接 Client 组合必须选择是否参与。

## 迁移

1. 对需要处理交互 Host 事件的自定义 Web profile，在 Host `@deepseek-ai/dsh-api-gateway` 条目的 `config` 中设置 `forwardedEvents: true`。Gateway 将该选择发布到所服务的页面；参见[随附的 Web patch](../../../../packages/bundle/web-app/cordis.patch.yml)。
2. 对直接 Client 组合，仅在其拥有订阅或交互处理职责时向 `@deepseek-ai/dsh-api-gateway/client` 插件传入 `{ forwardedEvents: true }`。仅调用生成方法的 CLI/MCP 调用方应保持被动。显式 Client 选择覆盖所服务页面的选择。
3. 保持 Connection 传输钩子由实例拥有，并等待 Context 释放。事件转发不替代认证，生成的方法流也不要求事件转发。
4. 验证交互客户端能收到订阅事件并回答交互。验证被动客户端能调用生成方法，同时 `$on()` 和 `$stream()` 立即拒绝；参见 [Gateway 运行时文档](../../../../packages/api/gateway/README.zh.md)。
