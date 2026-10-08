---
description: "为智能体提供搜索和读取当前工作区历史会话的工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-session-search

[English](README.md) | 中文

## 概述

为 standard、cordis 和 ptc 中的智能体提供五个实验性只读工具，用于搜索历史会话。内容索引在首次搜索时打开，由使用同一预设版本的智能体共享。Web 和 Desktop 随附此配置包，默认关闭。在插件页选择它即可启用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在 Web 或 Desktop 中打开插件页，在官方分组启用 **会话搜索**。关闭后移除其配置层。

新智能体和随后重新打开的会话使用所选组合；正在运行的智能体保留已有插件。minimal 预设和 Host 层工具目录保持不变。

此配置包启用智能体的搜索工具。侧边栏搜索保留现有行为。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 通过 `preset: preset-standard`、`preset: preset-cordis` 和 `preset: preset-ptc` 贡献插件行。后续配置补丁可以覆盖这些设置。[配置组合器](../../boot/app-boot/README.zh.md) 负责补丁顺序和错误处理。

每个预设版本拥有独立的 `sessionQuery` 提供方和惰性打开的 `:memory:` 索引。已被替换的版本在最后一个智能体关闭时释放其索引。Host 的元数据服务仍使用 `openAt: never`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[能力实现](../tool-session-query/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过[能力实现](../tool-session-query/README.zh.md) 贡献模型上下文和结果。

#### KV Cache 影响

此配置层不直接添加请求内容；能力实现负责工具目录、提示和结果的缓存影响。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 每个当前或保留的预设版本在首次搜索后持有自己的内存索引。索引会在应用重启后重建。搜索仍仅限获授权的工作区。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
