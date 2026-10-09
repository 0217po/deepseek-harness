# Agent Note: 消息图片 Factory 与显式 loader

Status: proposed

[English](2026-10-09-message-node-factories-and-delegates.md) | 中文

## 问题

消息图片通过自制的 `renderMessageImages`／`renderImages` 函数穿过多层业务 props，函数同时携带渲染入口与图片读取能力。Chat、Trajectory 和 Tool 需要保留各自的图片替换位置，同时让官方默认条目和第三方包装条目复用同一份画廊实现。

## 方案

沿用 [Body Slot 与 Content Factory 的分工](../../implemented/architecture/2026-10-09-reasoning-content-slot-factory.zh.md)，仅使用现有的 `registerFactory`、`renderFactorySlot` 和普通图片 Slot。

| 入口 | 职责 |
| --- | --- |
| `conversation.message.images.view` Factory | Chat 图片的可复用入口，Session 作用域，拥有并调用原有 `conversation.message.images` Slot。 |
| `conversation.trajectory.images.view` Factory | Trajectory 图片的可复用入口，Session 作用域，拥有并调用原有 `conversation.trajectory.images` Slot。 |
| `conversation.message.images.content` Factory | 官方画廊实现，root 作用域，接收图片、授权 loader、布局参数和可选完整 labels。 |

Chat 和 Trajectory 分别保留原有图片 Slot 的所属包与 Session 作用域，声明由入口 Factory 独立拥有，不由 ChatFlow 或 TrajectoryView 重复声明。附件插件继续提供默认条目；两个默认条目与工具图片条目都调用同一个 Content Factory。停用官方附件插件不会撤销 Chat／Trajectory 的图片位置，第三方仍能提供实现。

图片渲染组件通过框架提供的 `renderFactorySlot` 调用对应入口，显式传入图片引用、`loadImage` 和展示参数。读取授权、逐会话 URL 缓存与回收继续由 Conversation 管理；Factory 不查找全局当前 Session。画廊、加载重试、缩略图及灯箱继续使用附件包现有组件，不迁到 ui-primitives。

`AssistantNodeView` 将 `loadImage` 传给 `AssistantMarkdown`；`UserMessageNodeView` 和 Flow 的待处理输入气泡将它传给 `UserStyleBubble`。`AssistantMarkdown` 和 `UserStyleBubble` 在原有图片绘制位置调用 Chat 图片入口 Factory，保持组件分工和 key。这些短 props 路径使授权 loader 保持显式，无需单独的图片适配器。跨插件的 `ChatNodeOwnerProps.loadImage` 和图片 Factory 的 loader 参数保持显式。

`ChatView` 直接向既有的 `MarkdownDelegateProvider` 提供 `requestOpenFile`、`openExternalLink` 和 `fileImages`。包装后的文件打开动作保留 Chat 的失败反馈与重试处理；Markdown 导航与图片处理保持不变。

`MessageImagesContentInput` 在原有图片参数上增加可选的完整 `MessageImageLabels`。提供 labels 时原样使用，省略时由官方 Content Factory 的 locale 席位提供默认文案。

## 考虑过的替代方案

**只公开画廊组件，跨功能包直接导入。** 绕过标准图片 Slot 和框架装配，不能保留现有的第三方替换能力。

**继续传递自制图片渲染函数。** 将渲染入口与授权读取混在一起；现有 Factory 已能提供可复用入口。

**通过 ImageDelegateProvider 隐式供应 loader，并扩展 Markdown 节点绑定。** 超出原生消息图片复用所需范围，短路径显式透传 loader 和现有 Markdown 实现已足够。

## 验收标准

- Chat／Trajectory 不再定义或传递 `RenderMessageImages` 型自制渲染函数；图片入口使用框架的 Factory renderer。
- Chat、Trajectory、Tool 的默认图片条目复用官方 Content Factory；替换原图片 Slot 的插件仍可接管对应位置。
- 图片 Factory 与跨插件 Slot 显式接收 loader，保留现有授权、缓存、预览 URL、图片顺序、布局、重试与灯箱行为。
- 原生 Assistant、用户消息与待处理输入图片保留组件分工、绘制位置和 key，通过显式 props 向每个 Factory 调用传入 `loadImage`。
- Markdown 仍通过既有的 `MarkdownDelegateProvider` 使用 Chat 包装过的文件打开动作，外链及文件图片能力保持不变。
- Content Factory 支持默认及调用者自定义的完整 labels。
- 不修改 Markdown 代码块、Markdown 图片、通用 Delegate Provider、增量解析器、renderer 框架或 UserMessage 文本语义。

## 风险

入口 Factory 必须拥有原图片 Slot 的唯一声明；下游调用不能绕过既有替换位置。共享画廊保持 root 作用域，但持久图片读取必须使用调用者显式提供的授权 loader。

显式 props 透传要求每个原生图片调用点提供自身的授权 loader。必要验证涵盖图片 Factory 的装配、替换和卸载，原生 Assistant／用户／待处理输入的 loader 路径，key 保持，默认及自定义 labels，以及 Markdown 文件打开失败反馈。
