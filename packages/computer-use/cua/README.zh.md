---
description: "通过按应用和窗口限定的对象，观察和操作原生 macOS 应用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-cua

[English](README.md) | 中文

## 概述

检查 macOS 权限，选择运行中的应用和窗口，读取辅助功能树、截图并发送输入。外部持久执行环境可以保留这些对象。Swift 辅助进程直接使用 macOS 框架，并改写选取的 MIT 许可 Cua Driver 行为。本包不提供 PTC 运行时或变量持久化。

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

该提供方需要在 macOS 14 及以上通过源码配置显式启用，默认配置不加载它。先准备原生组件，再加载注册表和提供方覆盖层：

```sh
swift build --package-path packages/computer-use/cua/native --configuration release
cua_native_root="$PWD/packages/computer-use/cua/native"
export DSH_CUA_HELPER="$cua_native_root/.build/release/dsh-cua-native"
pnpm dsh headless --patch packages/computer-use/cua/examples/macos.cordis.yml --dump-config
```

配置输出命令不发起模型请求。执行真实任务时，将 `--dump-config` 替换为任务提示，并配置该 profile 的模型凭据。配置挂载 computer-use 注册表和本 provider；使用前需移除已有的竞争 provider。负责执行的宿主或辅助进程需要辅助功能权限来读取 AX 和输入，需要屏幕录制权限来截图。`getCapabilities` 查询权限和锁屏状态，不弹出系统授权窗口。桌面会话锁定或不可用时，界面观察与输入会在分派前拒绝，需由用户解锁 macOS 后继续。目标应用需提前启动，可按名称、bundle ID、应用绝对路径或 PID 选择。`getApp` 读取选中的应用，不自动激活它。模型指引要求先在后台观察和输入，不在初始化或每次动作前激活应用。窗口隐藏、位于其他桌面空间或被台前调度缩为缩略图而无法观察时，先说明需要前台的步骤，再显式调用 `app.activate()` 或窗口的 `raise` 动作，之后重新读取状态。应用收到输入后仍可能改变焦点，后台投递不保证用户操作始终不受干扰。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `allowedApps` | `[]` | 当前配置档的动态应用授权，绑定可执行文件路径和已验证的代码签名要求。 |
| `helperPath` | 包内可执行文件 | 可选的原生可执行文件绝对路径覆盖。 |
| `buildTimeoutMs` | `300000` | 原生组件准备的最长时间。 |
| `timeoutMs` | `30000` | 单次操作截止时间，取消后可能已发生部分输入。 |
| `axTimeoutMs` | `3000` | 每次 Accessibility 系统调用的截止时间，与完整操作截止独立配置。 |
| `maxRequestBytes` / `maxResponseBytes` | `1048576` / `33554432` | UTF-8 请求与响应字节限制。 |
| `maxClipboardBytes` | `33554432` | 粘贴时保存原剪贴板内容的字节上限；超限会在替换前拒绝。 |
| `maxElements` / `maxDepth` | `2000` / `25` | 辅助功能树遍历限制。 |
| `dragDurationMs` / `dragSteps` | `400` / `20` | 拖动时长和移动分段数。 |
| `textEventIntervalMs` | `0.25` | 每个 Unicode 按下或抬起事件后的间隔，范围为 0 至 1000 毫秒。组合键的节奏独立。 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-cua)列出全部字段。原生工具调用使用 `{method, params}`，模型可以看到每个方法的完整参数定义。例如，`getApp` 返回 `listWindows`、`getState` 和输入操作所需的 `appHandle`。

数字键盘名称（`KP_0` 到 `KP_9`、`KP_Enter` 和数字键盘运算键）保留独立的物理键码。组合键用 `+` 分隔修饰键与按键。加号键写作 `+`，Command 加号写作 `cmd++`，也可以使用键名 `plus`；`cmd+` 这类缺少按键的输入会被拒绝。

Agent 销毁和插件卸载会取消并等待完整工具调用，包括图像接入检查和附件存储。已经开始的图像写入必须结束后，销毁才会返回；已取消的调用不会返回成功截图。

CUA 工具在读取 AX、窗口标题、截图、激活和输入之前检查应用授权。User Questions 提供任务级允许和拒绝选项；应用签名可验证且组合支持配置持久化时，也可保存授权。任务授权绑定所选进程句柄，长期授权绑定真实可执行路径和指定代码签名要求。拒绝后，同一任务不再反复询问。删除保存的 `allowedApps` 条目会取消相关操作并使原生组件中的句柄失效；重新授权需要重新选择应用。同一组件中的其他句柄也会失效，已保存的授权仍可复用。Agent 或提供方销毁时等待组件清理。设计理由见[应用授权决策](../../../.agents/notes/implemented/architecture/2026-09-26-cua-application-consent.zh.md)。这些检查约束 CUA 调用；持久 PTC 和另行授权的 shell 工具保留各自的执行权限。

原始 `getState` 操作返回经过校验的状态字段和完整 `tree`。原生 helper 还返回供原生检查使用的结构化元素诊断数组；工具投影会从模型文本和结构化工具值中移除这份重复数组。

原生准备复用文件锁，串行检查编译和发布可执行文件，保留构建缓存，只在字节变化时原子替换可执行文件。取消或准备失败后，先完成受管进程清理再释放锁。

### 接入外部执行环境

使用 persistent PTC 时，在 macOS 配置后追加 `--patch packages/computer-use/cua/examples/persistent-ptc.cordis.yml`。该 provider 为存活的 Agent 保留变量，不启用文件沙箱。调用方导入适配模块，并提供当前执行中已授权的 `tools.cua` 绑定。persistent PTC 会在 CUA 指引中收到安装目录内 bridge 的文件 URL，项目无须安装本包。下面的例子用于能从自身安装目录解析本包、且已提供 `tools` 的外部宿主；本包不安装全局对象，也不负责保留变量：

```javascript
import { connectCua } from '@deepseek-ai/dsh-cua/bridge'
const cua = connectCua(() => tools.cua, text => console.log(text))
const app = await cua.getApp("com.apple.TextEdit")
void await app.getScreenshot()
```

单窗口任务直接使用 app 方法。`getApp` 已读取初始 AX，截图不需要枚举窗口或额外读取 AX。任务需要指定窗口或默认选窗存在歧义时，再调用 `app.getWindows()` 和 `app.getWindow(windowId)`，根据观察到的标题与位置选择目标。

`getWindow` 会输出初始 AX 树。已确认归属但没有 AX 界面的窗口返回空快照，仍可截图和发送坐标输入。不同窗口分别保留快照，读取一个窗口不会使另一个窗口失效；重新读取同一范围会使旧索引失效。观察期间节点被移除时，该次读取返回 `STALE_SNAPSHOT`，不发布部分树；可以重新读取，但不要重复此前的输入。应用级截图和坐标操作复用最近一次 AX 观察：优先使用其中在屏幕上且尺寸非零的焦点窗口，否则要求只有一个符合条件的窗口。它们不会重新查询即时焦点；需要跟随焦点变化时，先读取 `app.getAXState()`。显式窗口对象保持选定的目标。键盘方法保留在 `app` 上，因为输入跟随应用的当前焦点。

`paste(text, { format: "text" | "html" })` 临时提供指定格式的剪贴板内容，并调用应用已启用的标准 Paste 菜单命令。只在仍持有剪贴板时恢复保存的全部原格式，保留期间产生的新复制内容。粘贴操作共用跨进程锁，取消会等待辅助进程清理。强制终止进程可能阻止恢复。应用不支持 Paste 命令时明确失败，不自动改成逐字输入；`typeText` 仍单独提供按键事件输入。

`selectText` 通过可写的 `AXSelectedTextRange` 选中唯一的字面文本，或把光标放在它的前后。紧邻的前后文用于区分重复文本。选区操作保留其余文字和格式，并核对实际 UTF-16 范围；控件不支持、文本不存在、匹配不唯一或文字变化时明确失败，不自动改用键盘输入。AX 文本包含可用的 `selectionWritable`、选区范围和选中文字。

截图数据必须使用规范 Base64。响应字节上限在解析前执行，附件接入校验图像数据及配置的容量。

截图和鼠标输入会核对所选窗口的辅助功能框与显示边界；已知两者不一致时，在发送任何鼠标事件前返回 `WINDOW_CHANGED`。当 AX 保留完整窗口框时，这也会拦住 Stage Manager 变换后的窗口。需要重新读取状态；激活应用或抬起窗口仍须显式调用。元素声明的 AX 动作保持可用。缺少 AX 几何时保留无 AX 路径，不代表变换后的窗口一定可以操作。

保留的对象会在每次调用时获取当前工具绑定。外部运行时负责持久化、导入、取消和最终表达式值的序列化。截图返回 PNG 字节，标准工具链负责将图片作为附件传递一次。`emit: false` 只控制对象层的输出。使用其他分派器的宿主可以通过 `./api` 的 `createCuaApi` 创建对象。

AppKit sheet 可以通过其窗口 ID 单独选择，也会出现在所属文档窗口的控件树中。只有应用当前获得焦点的 sheet 指向唯一的 Apple 面板服务窗口，且该服务仍聚焦于同一面板时，键盘输入才转交系统打开或保存面板。无法确认或存在歧义的远端接收方会在输入前报错。

元素索引支持右键或中键单击以及左键单击、双击。点击和拖动选项可指定按键与修饰键；带修饰键的点击使用指针输入。拖动期间保持指定按键，并在移动和释放事件中携带修饰键。AX 文本标明禁用控件、`valueWritable=true` 和可读取的 `selected` 状态。不带修饰键的点击优先使用元素声明的辅助功能动作；需要发送鼠标事件时，会重新读取元素位置并核实所属窗口。动作返回只表示输入已分派。可视指针或点击标记可以独立绘制；AX 动作无需移动系统指针。窗口定向鼠标输入仍可能改变应用焦点、选区或对话框。输入后需要读取状态确认结果。`STALE_APP` 需要重新获取应用，`STALE_SNAPSHOT` 需要重新读取 AX。通信超时或取消会终止该 Agent 的辅助进程，使已有句柄失效。不能自动重试结果不确定的输入。关闭 Agent 会释放辅助进程和 AX 引用，但不会撤销应用中的修改。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>操作分派与资源归属</summary>

对象接口将应用和窗口方法转换为 JSON 操作。适配模块通过标准工具链保留授权、嵌套日志和图片接入。每个 Agent 拥有一个串行处理请求的辅助进程。原生句柄绑定进程身份及内核启动时间，快照中的 AX 引用只保存在辅助进程内。未来平台可以实现相同操作协议，无需在对象接口中加入平台逻辑。

原生请求 ID 与工具日志中的调用 ID 一致。成功的激活和窗口抬起操作会在原始工具结果中保留前台操作信息，以及操作前后的即时焦点观察。应用已在前台时跳过重复激活；窗口抬起还要求该窗口正是焦点主窗口、未最小化且位于可见普通窗口的最前方，才会跳过。无法确认时保留原请求。这些观察不能确认其他焦点切换的发起者，也不代表操作已经完成。

每次观察在同一批 AX 请求中读取节点角色和元数据。组节点和滚动区域节点只提供子节点，未使用的元数据错误不会导致它们被拒绝。不支持批量读取时保留逐个属性读取。AX 遍历对每个原生身份只访问一次，包括表示同一元素的不同代理引用，避免循环子节点重复展开整个子树。[源码清单](native/upstream.json)记录改写的上游行为和本地 Swift 模块。AppKit 使用主事件循环，独立串行执行器持有 AX 引用并发送同步输入。一条请求在截图和结果发送期间仍独占执行。本包不发布 invariant 入口，因为没有需要对照的独立注册表投影或持久执行器状态。协议验证、目标身份和资源清理由对应实现负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [Computer-use 注册](../computer-use/README.zh.md)
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
Use cua with method getCapabilities and params {} to inspect permissions and sessionLocked. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI attempts and ask the user to unlock macOS. A null sessionLocked means no usable console session was verified. After unlocking, read fresh state; screenshots from a locked desktop are not current observations. Use listApps and getApp to select an already running application. getApp requests user consent before application observations or input. If access is denied or revoked, stop using that application until the user explicitly grants access again. Never switch tools to bypass a refusal. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. getState returns a complete AX tree and snapshotId. Use its element indices only with that snapshotId. Raw screenshot and coordinate operations require a windowId. Coordinates are window-local macOS points, which may differ from screenshot pixels. A verified window can expose no AX elements. Its empty snapshot permits screenshots and coordinate input; element-index actions require an element from a fresh AX observation.

Initialize the object API once in persistent PTC. Reuse its variables in later calls; put temporary declarations inside { ... } blocks to avoid redeclaration errors. All object methods are async. getAXState returns text, not a structured state object. Its text marks disabled controls, valueWritable and selectionWritable capabilities, selected state and UTF-16 selection ranges when available.

Use app methods directly for single-window tasks; getApp already reads initial AX state. Call app.getWindows() and await app.getWindow(windowId) only to target a particular window or resolve ambiguous window selection. App screenshots and coordinate actions use the latest AX observation: its focused on-screen, nonzero-size window, otherwise the sole such window. They do not refresh focus automatically. Read app.getAXState() to follow changed focus.

Object API signatures (options default to { emit: true }):

- cua.getCapabilities(options?) -> { platform, permissions, sessionLocked, methods, coordinateSpace, browser }
- cua.listApps(options?) -> Array<{ id, displayName, isRunning, pid }>
- cua.getState(options?) -> { apps, browsers: [] }
- cua.getApp(selector: string) -> App
- app.activate() -> { dispatched: true, verified: false }
- app.getWindows(options?) -> Array<{ windowId, pid, appName, title, bounds, isOnScreen, onCurrentSpace }>
- app.getWindow(windowId: number) -> Window
- app.typeText(text: string), app.pressKey(chord: string) -> action result
- app.paste(text: string, options?: { format?: "text" | "html" }) -> action result

App and Window methods:

- getAXState(options?: { emit?: boolean, disableDiffing?: boolean }) -> string
- getScreenshot(options?: { emit?: boolean }) -> Uint8Array
- getAXStateAndScreenshot(options?) -> { state: string, screenshot: Uint8Array }
- click(target: number | [x, y], options?: { mouseButton?: "left" | "right" | "middle", clickCount?: 1 | 2, modifiers?: Array<"command" | "control" | "option" | "shift" | "fn"> }) -> action result
- setValue(elementIndex: number, value: string) -> action result
- selectText(elementIndex: number, text: string, options?: { prefix?: string, suffix?: string, selectionType?: "text" | "cursor_before" | "cursor_after" }) -> action result
- performSecondaryAction(elementIndex: number, action: string) -> action result
- scroll({ x, y, deltaLinesX, deltaLinesY }) -> action result
- drag(from: [x, y], to: [x, y], options?: { mouseButton?: "left" | "right" | "middle", modifiers?: Array<"command" | "control" | "option" | "shift" | "fn"> }) -> action result

Raw operation tools use { method, params }, including params: {} for parameterless methods. getApp selects without activating the app. Keep applications in the background for observation and routine input. Do not activate or raise an app during initialization, before each action, or merely because another app is foreground. Prefer advertised AX actions. If a hidden window, another Space or Stage Manager prevents usable observation, explain the foreground-dependent step before app.activate() or an advertised raise action, then read fresh state. Avoid repeated activation when the user switches away; continue background-capable steps and report what requires foreground access. Applications may still change focus in response to input.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. WINDOW_CHANGED requires fresh state before any retry; use an advertised AX action or explicitly restore the window before screenshot or coordinate input, then observe again. PERMISSION_DENIED requires the user to grant macOS Accessibility or Screen Recording access in System Settings. After granting access, observe fresh state before continuing; do not automatically replay prior input.

Use selectText only on controls advertising selectionWritable. It selects a unique literal occurrence, or places the cursor before/after it; prefix and suffix must be immediately adjacent. AMBIGUOUS_TEXT requires more context; TEXT_NOT_FOUND or SELECTION_CHANGED requires a fresh observation before deciding on input. Left clicks support single/double clicks; right and middle clicks support single clicks. Modified clicks use pointer input. Keypad names such as KP_0 and KP_Enter retain their physical key identity. Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste delivers plain text or HTML through the application's enabled standard Paste menu command. Original clipboard formats are restored if the clipboard still belongs to this paste; a later copy is preserved. Unsupported Paste commands fail without typing fallback. CLIPBOARD_CHANGED means another writer intervened; observe before deciding on further input. Browser applications can be controlled with getApp like other native apps; browser tabs and app launching are unavailable. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, use the host-provided initialization snippet below once. Its installation-owned file URL works independently of the project directory. Retain app objects between calls. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.
```

#### Token 影响

启用插件会增加固定参数定义和指导文本。AX 观察、操作结果和已接入的图片会增加模型输入。本包不将保留的对象序列化进提示。

#### KV Cache 影响

工具结果追加到 Session 历史。修改插件配置或工具呈现方式可能改变请求前缀；保留应用对象不会改变已有历史。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 只提供 macOS 原生实现。不支持浏览器标签、启动应用、AX 差分、无法确认应用归属的系统面板，以及仅后台辅助类型的应用。
- 坐标使用包含标题栏的窗口内部 point，可能不同于 PNG 像素尺寸。窗口移动、应用变化及其他桌面使用者的操作可能与观察和输入交错。
- macOS 台前调度可能将后台窗口的尺寸与截图变为缩略图，当前无法保证这种状态下的完整画面与坐标输入；模型指引要求说明前台需求并避免反复抢回焦点。
- 后台输入依赖私有 SkyLight 符号，macOS 升级可能使其不可用，需在目标系统版本验证。
- 实测 Blender Unicode 输入曾出现分派成功但界面未显示文本，后台 AppKit 的 Command+A 曾未选中全文。输入后必须检查应用状态；工具返回成功只表示已分派。
- 原生二进制需要本地构建。签名、分发和系统权限引导留待后续。
- 持久 PTC 是对外部运行环境的假设，本包不实现它。真实模型任务成功率需要在原生测试和协议测试之外单独评估。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景</summary>

无。

</details>
