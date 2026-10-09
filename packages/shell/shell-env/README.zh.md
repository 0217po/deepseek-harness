---
description: "配置每次 Harness shell 调用的变量，以及部署提供的命令目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-shell-env

[English](README.md) | 中文

## 概述

`dsh-shell-env` 为 Bash 和 PowerShell 工具调用提供当前的 Harness 主目录、会话与 profile 变量。插件可以贡献已声明的 `DSH_*` 值，以及部署提供的命令目录。每次调用都会收到当前注册内容，不修改 `process.env` 或用户 shell 配置。变量所有权重复或返回未声明的值会明确报错。注册项随插件生命周期释放；shell 工具保留各自的 schema 与提示词。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在任何挂载模型 shell 工具（`dsh-tool-bash` 或 `dsh-tool-pwsh`）的组合中加载本插件：此后每次前台或后台 shell 调用都会运行在新收集的受管环境中，而不是进程继承来的任意 `DSH_*` 值。

### 每次 shell 调用都会收到什么

每次调用都会收到 `DSH_HOME`（Harness 主目录的绝对路径）、`DSH_SHELL=1`，agent（智能体）调用还会收到 `DSH_SESSION_ID`（调用方会话的 id）。启动器提供了 profile 上下文时，每次调用还会收到 `DSH_PROFILE`（profile 名）与 `DSH_PROFILE_DIR`（其绝对目录；其 `node_modules` 只存放 profile 自行安装的包，harness 自带的组合包从 dsh 安装目录解析）；不带 profile 启动的组合则两者都没有。

### 添加你自己的环境事实

其他插件通过注册一个 contributor 来贡献事实，需要提供稳定名称、它可能返回的完整 `DSH_*` 键集合、每个键的描述，以及为一次执行计算取值的 resolver：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell-env'

export const inject = ['shellEnv']

export function apply(ctx: Context): void {
  ctx.shellEnv.register({
    name: 'deployment-region',
    variables: { DSH_DEPLOYMENT_REGION: { description: 'Current deployment region.' } },
    resolve: execution => execution.agent === undefined ? {} : { DSH_DEPLOYMENT_REGION: 'cn-north' },
  })
}
```

contributor 必须声明它返回的每个键；返回未声明或非字符串的值会让该次调用失败。注册随注册插件的释放而释放，因此热重载插件会移除它的事实。

contributor 还可以声明绝对路径的 `commandDirectories`。注册表按 contributor 名称顺序将这些目录前置到本地 shell 的 `PATH`，保留各 contributor 内的目录顺序并去除重复目录，随后接上继承的 `PATH`。没有命令目录时，`PATH` 保持不变。目录注册不安装命令或验证其内容；贡献插件负责这些文件及其生命周期。[Office 命令插件](../../skill/skill-office/README.zh.md) 通过这种方式提供 `dsoffice` 和 `office-check`。

### 选择 Harness 主目录

唯一配置字段决定暴露为 `DSH_HOME` 的主目录；默认解析顺序为 `dshHome` 配置、环境变量 `$DSH_HOME`，然后是 `~/.dsh`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME`，然后 `~/.dsh` | 暴露为 `DSH_HOME` 的 Harness 主目录绝对路径 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-shell-env)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 可能出什么问题

两个 contributor 声明同一个键，或 contributor 声称拥有保留内置键（`DSH_HOME`、`DSH_SHELL`、`DSH_SESSION_ID`、`DSH_PROFILE`、`DSH_PROFILE_DIR`），都会导致插件加载时明确报错。`DSH_*` 键必须全大写并带下划线（例如 `DSH_REGION`），缺少描述也会让注册失败。相对命令目录也会导致注册失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释注册表背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **受信命名空间，每次调用重建。** 环境是归 Harness 所有的 `DSH_*` 命名空间：shell 执行器丢弃继承的 `DSH_*` 值，并为每次执行合并注册表的当前快照，因此嵌套 harness 与并发的父子 agent 无法泄漏陈旧身份，`process.env` 也永不被修改。
- **声明所有权，冲突明确报错。** contributor 预先声明键，使重复所有权在第一条命令之前就被发现；resolver 只能返回已声明的键。
- **内置键留在这里。** `DSH_HOME`、`DSH_SHELL`、`DSH_SESSION_ID`、`DSH_PROFILE` 与 `DSH_PROFILE_DIR` 为注册表保留；contributor 不能声称拥有它们。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、`ShellEnvRegistry` 服务与内置事实 |

### 收集

`collect(execution)` 将内置事实、contributor 值和命令目录的 `PATH` 合并为冻结快照，通过 `ShellExecRequest.dshEnv` 传递。该受信快照优先于普通调用方环境项。`list()` 枚举变量声明而不运行 resolver；不包含命令目录或依赖执行的值。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 shell 家族逐步进入执行器 seam 与生成目录。

- [shell 包映射](../README.zh.md)——bash 能力家族及其角色。
- [Bash 执行器子系统](../../../docs/subsystems/shell.zh.md)——工具执行所经由的 `ctx.shell` seam。
- [tool-bash](../tool-bash/README.zh.md)——消费本环境的 bash 工具。
- [tool-pwsh](../tool-pwsh/README.zh.md)——消费本环境的 pwsh 工具。
- [home paths 包](../../util/home-paths/README.zh.md)——`DSH_HOME` 如何解析。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-shell-env)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

通过 shell 工具（`dsh-tool-bash`、`dsh-tool-pwsh`）间接产生影响；这些工具在每次调用中提供本注册表的受管 `DSH_*` 事实和命令查找路径。

#### KV Cache 影响

受管环境永远不会进入请求前缀，因此不会使提供方缓存复用失效；任何前缀变更都取决于 shell 工具定义与当前请求信封。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明注册表何时不合适或需要小心使用。它们是当前包约束，不是任务积压。

- **`list()` 只枚举插件贡献的变量**——注册表自有的内置键（`DSH_HOME`、`DSH_SHELL`、`DSH_SESSION_ID`、`DSH_PROFILE`、`DSH_PROFILE_DIR`）不包含在内，因此诊断、提示词或 UI 代码不得把 `list()` 当作完整的环境目录。
- **命令目录属于本地主机。** 远程执行提供方需要在自己的执行环境中安装和配置命令；本地目录贡献不会为远程主机准备资源。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
