---
description: "从插件页开启实验性 Computer Use 和 persistent PTC。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-cua-bundle

[English](README.md) | 中文

## 概述

从插件页开启 macOS Computer Use，并在当前 profile 使用 persistent PTC。默认关闭，关闭时不准备本机组件、不注册 CUA 工具或添加其模型指引。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

在仓库根目录运行下面的命令，再打开侧栏「插件 → 官方 → Computer Use」。卡片标注实验性，并说明当前配置档会切换为 persistent PTC、变量跨调用保留且不提供文件沙箱。

```sh
pnpm run build
pnpm dsh web
```

开关复用 profile 的 `package.json` 中 `dsh.profile.bundles`。开启时先准备本机组件；源码启动恢复已开启状态时也检查。后续 `pnpm run build` 读取现有 Web profile 的同一列表，选中才检查增量构建。首次准备需要本机编译工具，耗时取决于机器；失败保留原始诊断，不发布新的可执行文件。

关闭会卸载 CUA 和持久执行器，取消并等待自有操作结束；保留的代码变量随之清除，原有工具与执行器配置重新生效。项目构建更新可执行文件后，重新启用或重启，运行中的 helper 才会换用新版。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者说明</summary>

`cordis.patch.yml` 插入注册表、CUA 提供方和 persistent PTC，覆盖默认执行器与工具模式。插件管理器保存组合包选择并触发正常重组；没有第二份启用标记。此配置组合没有独立可变投影，因此不发布 runtime invariant 配套模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Computer use](../../../docs/subsystems/computer-use.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### Computer Use and persistent PTC

#### What the model sees

开启时模型获得 CUA 操作工具、使用指引和 persistent PTC 的执行说明；关闭时撤回这些贡献。完整接口与输出约定由 [CUA](../cua/README.zh.md) 和 [PTC](../../ptc-runtime/ptc-runtime-node/README.zh.md#persistent-repl) 说明。

#### Token effect

启用时添加 CUA 指引，并更新 `run_code` 说明。关闭时撤回这些贡献。

#### KV Cache effect

启停会改变模型工具与系统指引；后续请求使用更新后的前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 目前验收范围是仓库中的 macOS Web 启动。桌面安装包集成与系统授权引导另行处理。
- 开启影响当前 profile 的工具呈现和 PTC 执行器；它不是逐任务的模式开关。

<a id="dev-note"></a>
### 开发备注

None.
