# Agent Note: Host release 变化时提示刷新页面，而不是跨 release 热替换

Status: implemented

[English](2026-10-14-host-release-change-refresh-prompt.md) | 中文

## Problem

`dsh web` 升级后，或开发者在另一个 commit 上重启 `pnpm run dev:web` 后，已打开的浏览器页面会自动重连到新 Host，但页面的静态 shell 仍停在旧 release。协议一旦不兼容，页面会一直重连失败或报错，用户也不知道需要刷新。

技术原因：

- 重连后，[client-hmr](../../../../packages/client/hmr/src/client/index.ts) 会收到新 Host 的完整 graph，[ClientEntries](../../../../packages/client/modules/src/client/entries.ts) 按每行的 `rev`（bundle 的 mtime、ctime 和大小）热替换插件。Vite shell、静态库和 bootstrap 在页面生命周期内从不替换。
- API 连接按精确键集合校验 ready 帧（[remote-events.ts](../../../../packages/api/gateway/src/client/remote-events.ts)），协议一变，旧页面无法自行恢复。
- 页面没有任何途径得知 Host 已换成另一个 release。
- Desktop 不受影响：Host 被替换后，main 进程会重新导航窗口（[main.ts](../../../../apps/desktop/src/main.ts)）。

[client plugin loading model](../architecture/2026-07-23-client-plugin-loading-model.zh.md) 负责加载链与热替换，它写明静态库和 shell 需要刷新页面；本 Note 负责页面如何得知 Host 的 release 变了，以及之后怎么处理。

## Decision

release 指 Host 的版本身份：版本号加可选的源码 commit。名字刻意区别于 build，后者指构建过程和构建产物。

改动落在三处：client-modules（产生、下发和比较 release 身份）、共享 client 构建预设（把 commit 固化进 Host 产物）、ui-settings-general（确认框）。web-app 和 client-hmr 不改。

### 行为

| 场景 | 行为 |
|---|---|
| 重连到同一 release | 维持现状：按 `rev` 热替换。 |
| 重连到另一个 release | 暂停插件替换，弹出确认框，显示服务和页面两条版本变化。 |
| 用户选择**刷新以加载新版本** | `location.reload()` 从新 Host 加载新的 shell 和插件。 |
| 用户选择**暂不刷新**、关闭按钮、点击遮罩或 Escape | 关闭确认框，新 release 成为页面的当前 release，并按最新 graph 恢复热替换。 |
| 之后重连到当前 release | 不提示，直接热替换。 |
| 重连到当前 release 以外的任何 release（含启动 release） | 再次弹出确认框。 |

页面只记一个当前 release，即它最近一次应用的 graph 的 release，只存在页面内存里，不写 localStorage 或 IndexedDB。刷新后，新的启动 release 成为当前 release。

### Release 身份

- 字段：`{ version, commit? }`，两个字段都相等才算同一 release。
- `version` 取 client-modules 自己 package.json 的版本。所有包同一版本号发布，所以它等于 CLI 版本。
- `commit` 在构建时固化。共享 client 构建预设 [tsdown.client.ts](../../../../packages/client/tsdown.client.ts) 给每个 client 包的 Node 半侧注入与浏览器半侧相同的公开 `process.env.DSH_CLIENT_*` 取值（[`clientBuildValueDefines`](../../../../scripts/client-build-environment.ts) 只替换具体变量，保留 `process.env` 本身）。client-modules 的 Host 代码读 `process.env.DSH_CLIENT_COMMIT_HASH`，在构建产物里是常量。
- 从 TypeScript 源码启动的 Host 没有构建这一步：`pnpm run dev:web` 把构建取值放进 Host 进程环境，因此读到的是同一个 commit；不经 dev-web 的源码启动只发布版本号。
- 字段值属于 wire 数据，确认框原样显示，不做本地化。

### Wire

```
WebBootRelease { version: string; commit?: string }
WebBootGraph {
  rev; entries; batches   // unchanged
  /** Host release identity; absent from a Host that publishes none. */
  release?: WebBootRelease
}
BootManifest { ...; release?: WebBootRelease }
```

- [ClientModuleRegistry](../../../../packages/client/modules/src/index.ts) 在构造时计算一次 release，由 `compose()` 写入每个 graph；`release` 不计入 `graph.rev`。不新增配置项，组合配置不变。
- `__DSH_BOOT__` 和每个 SSE `graph` 帧都带这个字段；client-hmr 的 Host 半侧不变。
- `parseBootManifest` 允许 `release` 缺省，拒绝非字符串的 `version` 或 `commit`，并丢弃身份以外的成员，因此相等判断只看这两个字段。不认识该字段的旧页面会忽略它。

### 页面侧

判断逻辑在 [release-change.ts](../../../../packages/client/modules/src/client/release-change.ts)；`ClientEntries` 在 `sync`、`reload` 和 `acceptRelease` 中调用它。

```
interface ClientReleaseChange {
  /** Release this page booted from; its shell and static modules stay at it until a reload. */
  readonly page: WebBootRelease | undefined
  /** Release of the latest graph this page applied: its boot release or an accepted one. */
  readonly current: WebBootRelease | undefined
  /** Release of the latest Host graph. */
  readonly next: WebBootRelease | undefined
}

class ReleaseChangeGate {
  /** Pending release change; undefined while no change is pending. */
  readonly change: ObservableSnapshot<ClientReleaseChange | undefined>
  /** Whether a graph of another release is held. */
  get holding(): boolean
  /** Pass a graph of the current release; hold any other one and announce each new release once. */
  admit(manifest: BootManifest): boolean
  /** Release the held graph; undefined when no change is pending. */
  accept(): BootManifest | undefined
  /** Record an applied graph as the current release and withdraw the pending change. */
  applied(manifest: BootManifest): void
}

class ClientEntries {
  /** The gate's change. */
  readonly releaseChange: ObservableSnapshot<ClientReleaseChange | undefined>
  /** Accept the pending release and apply its latest graph; resolves at once without a pending change. */
  acceptRelease(): Promise<void>
}
```

调用顺序：

1. `ClientEntries` 以启动 manifest 的 `release` 创建 gate。
2. `sync(graph)` 解析 graph 后交给 `admit`。当前 release 的 graph 照常调和。其他 release 的 graph 被暂存；它首次出现时用 `console.warn` 记录新旧身份并发布变化，不进入调和队列。暂存 release 的后续 graph 帧替换暂存的 graph，不再重复发布；`retry()` 继续调和上次应用的 graph。
3. 暂存期间忽略 `reload(id, rev)`（rebuilt 帧），因为 Host 每次重建后都会紧跟一帧完整 graph。
4. 收到当前 release 的 graph（含 Host 退回当前 release）时，或 `acceptRelease()` 取走暂存的 graph 时，`ClientEntries` 调用 `applied` 后照常调和。
5. UI 的 inject 面通过 `location.reload()` 刷新页面；`ClientEntries` 不负责导航。

### UI

- 归属：[ui-settings-general](../../../../packages/client/ui-settings-general/src/client/index.ts)，它已经拥有连接状态药丸（`ConnectionIndicator`）和 Desktop 更新提示；其 `inject` 增加 `modules`。
- 它通过 `ctx.slots.inject('shell.overlay', ...)` 注册 `shell.overlay` 条目 `host-release-change`，用 `Modal` 渲染。inject 面提供 `hooks: { releaseChange: ctx.modules.entries.releaseChange }`、`acceptRelease` 和 `reloadPage`。
- 文案在中英 locale 字典里。标题为**服务版本变化**（Service version changed）；正文为「连接重新建立后版本信息变化如下」（After the connection was re-established, versions changed as follows.）。下面是两行灰色标签的版本：
  - **服务**：`current`（灰）→ `next`（实色），1px 绿色实线箭头，表示服务已经切换。
  - **页面**：`page`（实色）→ `next`（灰），1px 灰色虚线箭头，表示刷新后才会切换。两条连接线固定 56px，不撑满对话框。
  - 每行两端版本号不同时显示版本号，否则显示 commit；Host 没发布的 release 或字段显示**未标注**。读屏把两行当文字读，箭头只是装饰。
- 按钮为**暂不刷新**和**刷新以加载新版本**（主按钮，带 `data-modal-autofocus`）。关闭按钮、点击遮罩和 Escape 通过共用的 `Modal` 关闭行为等同**暂不刷新**。

## Alternatives considered

- **自动调用 `location.reload()`**：可能丢失尚未保存的输入，而且应当让用户看到并确认刷新。
- **把身份放进 API ready 帧（`ConnectionHostInfo`）**：协议不兼容时 ready 帧本身就可能解析失败，检测根本不会发生；暂停热替换仍然属于 `ClientEntries`。
- **由 web-app 拼身份（CLI 版本 + web-app 版本 + commit），通过 `webApp` 服务和组合配置交给 modules**：要改 web-app 的服务接口、测试、文档和生成的 API 清单，还让 modules 等待 web-runtime 激活；两个版本号一起发布，分开读取没有区别。
- **给 client-modules 加 `commit` 配置项，在组合配置里写 `!!js process.env.DSH_CLIENT_COMMIT_HASH`**：运行时读环境变量，而正式发布的 `dsh web` 不设置这个变量；commit 必须在构建时固化。
- **client-modules 依赖 app-boot 读取 CLI 版本**：要新增依赖边、依赖策略分类、tsconfig 引用和 lockfile 改动，而本包自己的版本就是同一个数。
- **把判断逻辑留在 `ClientEntries` 里**：调和与 release 比较是两件独立的事；拆出 gate 后 `ClientEntries` 只多几行。
- **字段命名为 `build`**：容易和构建过程、构建产物混淆。
- **在 client-hmr 里重开被永久关闭的 SSE**：端到端重启测试中从未出现 404 窗口，浏览器自带的重试已覆盖连接被拒；这个缺口记为已知限制。
- **把选择写进 localStorage**：这个选择只关乎一个页面的代码，而刷新会替换这些代码，所以不应比页面活得更久。
- **记一个已接受 release 的集合（启动 release 加每个接受过的 release）**：接受 B 后，Host 退回启动 release A 时不再提示，但页面此时运行的是 B 的插件；只记一个当前 release 更简单，也更准确。
- **身份保持一个不透明字符串，由页面拆出版本号和 commit**：显示规则需要分开这两部分，从拼接字符串里拆解，格式一变就会出错。
- **新建一个独立 UI 包**：要多做三处注册，而 ui-settings-general 已经拥有连接状态和更新提示。

## Consequences

- 升级后的 Host 或换了 commit 的开发 Host，不会再不经询问就把插件代码热替换进 shell 属于另一个 release 的页面；何时刷新由用户决定。
- 选择**暂不刷新**后会继续跨 release 热替换，风险与这次改动之前相同，由用户自行选择。
- 组合里没有注册确认框时，只会暂停热替换并记录警告，用户看不到提示。
- API 连接和 SSE 是两条独立通道，旧页面可能在确认框出现之前就已显示协议错误。
- 重启中的 Host 若在注册路由前对 `/plugins/events` 返回非 200 状态，浏览器会永久关闭这条 SSE，页面在刷新前检测不到 release 变化。
- 不经 dev-web 的源码启动没有 commit，开发期只能检测到版本号变化。
- 每个标签页各自提示、各自记录。
- 单元测试通过 `ClientEntries` 固定 gate 的行为，并覆盖 manifest 解析、Host 发布的 release、共享预设给 Node 半侧的 define，以及确认框的渲染与回调；端到端重启场景在真实 Host 上验证过。
