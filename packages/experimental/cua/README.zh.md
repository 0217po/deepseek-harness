---
description: "通过按应用和窗口限定的对象，观察和操作原生 macOS 应用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cua

[English](README.md) | 中文

## 概述

检查 macOS 权限，选择运行中的应用和窗口，读取辅助功能树、截图并发送输入。外部持久执行环境可以保留这些对象。原生辅助进程从选取的 MIT 许可 Cua Driver 源码本地构建。本包不提供 PTC 运行时或变量持久化。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 macOS 上使用 Rust 和 Xcode 命令行工具构建，然后从仓库根目录挂载源码配置：

```sh
cargo build --release --locked --manifest-path packages/experimental/cua/native/Cargo.toml
cua_native_root="$PWD/packages/experimental/cua/native"
export DSH_CUA_HELPER="$cua_native_root/target/release/dsh-cua-native"
pnpm dsh headless --patch packages/experimental/cua/examples/macos.cordis.yml --dump-config
```

配置输出命令不发起模型请求。执行真实任务时，将 `--dump-config` 替换为任务提示，并配置该 profile 的模型凭据。配置挂载 computer-use 注册表和本 provider；使用前需移除已有的竞争 provider。负责执行的宿主或辅助进程需要辅助功能权限来读取 AX 和输入，需要屏幕录制权限来截图。`getCapabilities` 只查询权限，不弹出系统授权窗口。目标应用需提前启动，可按名称、bundle ID、应用绝对路径或 PID 选择。`getApp` 激活选中的应用，再读取初始状态。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `helperPath` | 必填 | 原生可执行文件的绝对路径。 |
| `timeoutMs` | `30000` | 单次操作截止时间，取消后可能已发生部分输入。 |
| `maxRequestBytes` / `maxResponseBytes` | `1048576` / `33554432` | UTF-8 请求与响应字节限制。 |
| `maxElements` / `maxDepth` | `2000` / `25` | 辅助功能树遍历限制。 |
| `dragDurationMs` / `dragSteps` | `400` / `20` | 拖动时长和移动分段数。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-cua)列出全部字段。原生工具调用使用 `{method, params}`，模型可以看到每个方法的完整参数定义。例如，`getApp` 返回 `listWindows`、`getState` 和输入操作所需的 `appHandle`。

### 接入外部执行环境

使用 persistent PTC 时，在 macOS 配置后追加 `--patch packages/experimental/cua/examples/persistent-ptc.cordis.yml`。该 provider 为存活的 Agent 保留变量，不启用文件沙箱。调用方导入适配模块，并提供当前执行中已授权的 `tools.cua` 绑定。下面的接入代码假设执行宿主已提供 `tools`；本包不安装全局对象，也不负责保留变量：

```javascript
import { connectCua } from '@deepseek-ai/dsh-experimental-cua/bridge'
const cua = connectCua(() => tools.cua, text => console.log(text))
const app = await cua.getApp("com.apple.TextEdit")
const windows = await app.getWindows()
const window = await app.getWindow(windows[0].windowId)
await window.getScreenshot()
```

根据标题和位置选择目标窗口。`getWindow` 会输出初始 AX 树。不同窗口分别保留快照，读取一个窗口不会使另一个窗口失效；重新读取同一范围会使旧索引失效。应用级截图和坐标操作优先使用最新观察中的焦点窗口，否则要求只有一个可见且非零尺寸窗口。显式窗口对象可以选择具体目标。键盘方法保留在 `app` 上，因为输入跟随应用的当前焦点。

保留的对象会在每次调用时获取当前工具绑定。外部运行时负责持久化、导入、取消和最终表达式值的序列化。截图返回 PNG 字节，标准工具链负责将图片作为附件传递一次。`emit: false` 只控制对象层的输出。使用其他分派器的宿主可以通过 `./api` 的 `createCuaApi` 创建对象。

元素索引支持右键单击以及左键单击、双击。辅助进程优先使用元素声明的辅助功能动作；需要发送鼠标事件时，会重新读取元素位置并核实所属窗口。动作返回只表示输入已分派。输入后需要读取状态确认结果。`STALE_APP` 需要重新获取应用，`STALE_SNAPSHOT` 需要重新读取 AX。通信超时或取消会终止该 Agent 的辅助进程，使已有句柄失效。不能自动重试结果不确定的输入。关闭 Agent 会释放辅助进程和 AX 引用，但不会撤销应用中的修改。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>操作分派与资源归属</summary>

对象接口将应用和窗口方法转换为 JSON 操作。适配模块通过标准工具链保留授权、嵌套日志和图片接入。每个 Agent 拥有一个串行处理请求的辅助进程。原生句柄绑定进程身份及内核启动时间，快照中的 AX 引用只保存在辅助进程内。未来平台可以实现相同操作协议，无需在对象接口中加入平台逻辑。

[源码清单](native/upstream.json)区分未修改的上游文件和本地接入代码。本包不发布 invariant 入口，因为没有需要对照的独立注册表投影或持久执行器状态。协议验证、目标身份和资源清理由对应实现负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Computer-use 注册](../../computer-use/computer-use/README.zh.md)
- [原生协议](native/protocol.schema.json)
- [对象接口](src/types.ts)

-----

<a id="model-experience"></a>
## 模型体验

### 原生应用操作

#### 模型可见内容

插件提供一个 `cua` 操作工具，定义各方法的参数。标准 PTC 呈现通过 `run_code` 将它暴露为 `tools.cua`。以下是本包逐字输出的指导文本：

##### 操作指导文本（原文）

```markdown
Use cua with method getCapabilities to inspect permissions, then listApps and getApp to select an already running application. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. getState returns a complete AX tree and snapshotId. Use its element indices only with that snapshotId. Select a windowId explicitly for screenshots and coordinate actions. Coordinates are window-local macOS points, which may differ from screenshot pixels.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. PERMISSION_DENIED requires the user to grant macOS Accessibility or Screen Recording permission.

The optional object API exposes getCapabilities, listApps, getState and getApp. App objects expose getWindows, getWindow(windowId), getAXState, getScreenshot, getAXStateAndScreenshot, click, setValue, scroll, drag, typeText, paste and pressKey. Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste inserts plain text using native Unicode input without changing the clipboard; rich-text formats are unavailable. Browser applications can be controlled with getApp like other native apps; browser tabs and app launching are unavailable. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, initialize once with const { connectCua } = await import("@deepseek-ai/dsh-experimental-cua/bridge"); const cua = connectCua(() => tools.cua, text => console.log(text)). Retain app objects between calls. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.
```

#### Token 影响

启用插件会增加固定参数定义和指导文本。AX 观察、操作结果和已接入的图片会增加模型输入。本包不将保留的对象序列化进提示。

#### KV Cache 影响

工具结果追加到 Session 历史。修改插件配置或工具呈现方式可能改变请求前缀；保留应用对象不会改变已有历史。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只提供 macOS 原生实现。不支持浏览器标签、启动应用、富文本剪贴板格式、AX 差分、独立进程中的打开或保存对话框，以及仅后台辅助类型的应用。
- 坐标使用包含标题栏的窗口内部 point，可能不同于 PNG 像素尺寸。窗口移动、应用变化及其他桌面使用者的操作可能与观察和输入交错。
- 原生二进制需要本地构建。签名、分发和权限引导尚未实现。
- 持久 PTC 是对外部运行环境的假设，本包不实现它。真实模型任务成功率需要在原生测试和协议测试之外单独评估。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无。

</details>
