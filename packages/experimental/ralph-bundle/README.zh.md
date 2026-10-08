---
description: "使用新智能体执行用户明确要求的循环工作。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-ralph-bundle

[English](README.md) | 中文

## 概述

为 standard、cordis 和 ptc 添加实验性 Ralph 工具，使用新的子智能体执行用户要求的循环工作。 Web 和 Desktop 随附此功能，默认关闭。在插件页选择它即可启用。

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

在 Web 或 Desktop 中打开插件页，在官方分组启用 **Ralph 循环**。关闭后移除其配置层。

新智能体和随后重新打开的会话使用所选组合；正在运行的智能体保留已有插件。minimal 预设和 Host 层工具目录保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 通过 `preset: preset-standard`、`preset: preset-cordis` 和 `preset: preset-ptc`，在隔离的 `optional-ralph` 组中贡献 `tool-ralph`。后续作用域补丁可以替换该工具的配置或禁用它；单独的覆盖不会选中组合包。[配置组合器](../../boot/app-boot/README.zh.md) 负责补丁顺序和错误处理。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[能力实现](../tool-ralph/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过[能力实现](../tool-ralph/README.zh.md) 贡献模型上下文和结果。

#### KV Cache 影响

此配置层不直接添加请求内容；能力实现负责工具目录、提示和结果的缓存影响。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- Ralph 需要用户明确要求执行循环，多轮运行可能消耗大量模型 token。其工作流引擎与其他工作流工具隔离。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

无。

</details>
