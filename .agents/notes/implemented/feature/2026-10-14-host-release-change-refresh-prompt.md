# Agent Note: Prompt to reload when the Host release changes instead of hot-replacing across releases

Status: implemented

English | [中文](2026-10-14-host-release-change-refresh-prompt.zh.md)

## Problem

After `dsh web` is upgraded, or after a developer restarts `pnpm run dev:web` at another commit, an open browser page reconnects to the new Host automatically while its static shell stays at the old release. When the protocol is no longer compatible, the page keeps failing to reconnect or shows errors, and the user is not told that a reload is required.

Technical causes:

- After a reconnect, [client-hmr](../../../../packages/client/hmr/src/client/index.ts) receives the new Host's complete graph, and [ClientEntries](../../../../packages/client/modules/src/client/entries.ts) hot-replaces plugins by each row's `rev` (the bundle's mtime, ctime, and size). The Vite shell, static libraries, and the bootstrap are never replaced during the page's lifetime.
- The API connection validates its ready frame against an exact key set ([remote-events.ts](../../../../packages/api/gateway/src/client/remote-events.ts)), so an old page cannot recover from a protocol change by itself.
- The page has no way to learn that the Host now runs another release.
- Desktop is unaffected: after its Host is replaced, the main process navigates the window again ([main.ts](../../../../apps/desktop/src/main.ts)).

The [client plugin loading model](../architecture/2026-07-23-client-plugin-loading-model.md) owns the loading chain and hot replacement. It states that static libraries and the shell require a reloaded page; this note owns how the page learns that the Host's release changed and what it does about it.

## Decision

A release is the Host's version identity: a version plus an optional source commit. The name deliberately differs from "build", which names the build process and its artifacts.

The change touches three owners: client-modules (producing, publishing, and comparing the release identity), the shared client build preset (fixing the commit into the Host artifact), and ui-settings-general (the confirmation dialog). web-app and client-hmr are unchanged.

### Behavior

| Situation | Behavior |
|---|---|
| Reconnect to the same release | Unchanged: plugins hot-replace by `rev`. |
| Reconnect to another release | Plugin replacement pauses and a dialog shows the service and page version changes. |
| The user chooses **Reload to load the new version** | `location.reload()` loads the new shell and plugins from the new Host. |
| The user chooses **Not now**, the close control, a mask click, or Escape | The dialog closes, the new release becomes the page's current release, and hot replacement resumes from the latest graph. |
| Reconnect to the current release later | No prompt; plugins hot-replace directly. |
| Reconnect to any release other than the current one, the boot release included | The dialog appears again. |

The page remembers one current release, the release of the latest graph it applied, in page memory only; nothing is written to localStorage or IndexedDB. After a reload, the new boot release is the current release.

### Release identity

- Fields: `{ version, commit? }`; two releases are the same only when both fields are equal.
- `version` is client-modules' own package.json version. All packages release under one version, so it equals the CLI version.
- `commit` is fixed at build time. The shared client build preset [tsdown.client.ts](../../../../packages/client/tsdown.client.ts) injects the same public `process.env.DSH_CLIENT_*` values into the Node half of every client package that it injects into the browser half ([`clientBuildValueDefines`](../../../../scripts/client-build-environment.ts) replaces the named variables and leaves `process.env` itself in place). The client-modules Host code reads `process.env.DSH_CLIENT_COMMIT_HASH`, which is a constant in the built artifact.
- A Host started from TypeScript source has no build step: `pnpm run dev:web` places the build values in the Host process environment, so the Host reads the same commit; a source launch without dev-web publishes the version alone.
- Field values are wire data that the dialog renders verbatim, without localization.

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

- [ClientModuleRegistry](../../../../packages/client/modules/src/index.ts) computes the release once at construction and `compose()` writes it into every graph; `release` stays outside `graph.rev`. There is no new config field and the composition is unchanged.
- `__DSH_BOOT__` and every SSE `graph` frame carry the field; the client-hmr Host half is unchanged.
- `parseBootManifest` accepts an absent `release`, rejects a non-string `version` or `commit`, and drops members outside the identity, so equality compares only those two fields. Older pages that do not know the field ignore it.

### Page side

The decision logic lives in [release-change.ts](../../../../packages/client/modules/src/client/release-change.ts); `ClientEntries` consults it from `sync`, `reload`, and `acceptRelease`.

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

Order of operations:

1. `ClientEntries` creates the gate from the boot manifest's `release`.
2. `sync(graph)` parses the graph and passes it to `admit`. A graph of the current release reconciles as before. A graph of another release is held; its first appearance logs the old and new identities through `console.warn` and publishes the change without entering the reconciliation queue. Later graph frames of the held release replace the held graph without publishing again; `retry()` keeps reconciling the last applied graph.
3. While a graph is held, `reload(id, rev)` (a rebuilt frame) is ignored, because every Host rebuild is followed by a complete graph frame.
4. When a graph of the current release arrives (including a Host that returned to it), or `acceptRelease()` takes the held graph, `ClientEntries` calls `applied` and reconciles as usual.
5. The UI's inject face reloads the page through `location.reload()`; `ClientEntries` does not navigate.

### UI

- Owner: [ui-settings-general](../../../../packages/client/ui-settings-general/src/client/index.ts), which already owns the connection pill (`ConnectionIndicator`) and the Desktop update prompt; its `inject` adds `modules`.
- It registers the `shell.overlay` entry `host-release-change` through `ctx.slots.inject('shell.overlay', ...)` and renders it with `Modal`. The inject face provides `hooks: { releaseChange: ctx.modules.entries.releaseChange }`, `acceptRelease`, and `reloadPage`.
- Copy lives in the zh/en locale dictionaries. The title is **Service version changed** (服务版本变化); the description is "After the connection was re-established, versions changed as follows." (连接重新建立后版本信息变化如下). Two gray-labelled lines follow:
  - **Service**: `current` (gray) → `next` (solid), joined by a 1px solid green arrow because the service already switched.
  - **Page**: `page` (solid) → `next` (gray), joined by a 1px dashed gray arrow because only a reload completes the switch. Both connectors are a fixed 56px and do not stretch across the dialog.
  - Each line shows versions when its two ends differ in version and commits otherwise; a release or field the Host did not publish shows **Not labeled**. Screen readers read the two lines as text; the arrows are decorative.
- The buttons are **Not now** and **Reload to load the new version** (primary, with `data-modal-autofocus`). The close control, a mask click, and Escape act as **Not now** through the shared `Modal` close behavior.

## Alternatives considered

- **Call `location.reload()` automatically**: it can discard unsaved input, and the user should see and confirm the reload.
- **Carry the identity in the API ready frame (`ConnectionHostInfo`)**: when the protocol is incompatible, the ready frame itself may fail to parse, so detection would never run; pausing hot replacement would still belong to `ClientEntries`.
- **Let web-app compose the identity (CLI version + web-app version + commit) and pass it to modules through the `webApp` service and the composition**: it changes web-app's service interface, tests, docs, and the generated API catalog, and makes modules wait for web-runtime activation; the two versions release together, so reading them separately adds nothing.
- **Add a client-modules `commit` config field set from `!!js process.env.DSH_CLIENT_COMMIT_HASH` in the composition**: it reads the environment at run time, and released `dsh web` launches do not set the variable; the commit must be fixed at build time.
- **Read the CLI version by depending on app-boot from client-modules**: it adds a dependency edge, a dependency-policy classification, a tsconfig reference, and a lockfile change, while the package's own version is the same number.
- **Keep the decision logic inside `ClientEntries`**: reconciliation and release comparison are independent concerns; the separate gate keeps `ClientEntries` to a few added lines.
- **Name the field `build`**: it is easily confused with the build process and build artifacts.
- **Reopen a permanently closed SSE stream in client-hmr**: in end-to-end restarts the 404 window never appeared, because the browser's own retry covered connection refusals; the gap is a documented limitation.
- **Store the decision in localStorage**: the decision concerns one page's code, and a reload replaces that code, so it should not outlive the page.
- **Remember a set of accepted releases (the boot release plus every accepted one)**: after accepting B, a Host back on boot release A would not prompt although the page runs B's plugins; one current release is simpler and accurate.
- **Keep the identity an opaque string and let the page split version and commit**: the display rule needs the two parts separately, and parsing a concatenated string breaks whenever its format changes.
- **Create a separate UI package**: it needs three more registrations, while ui-settings-general already owns connection state and update prompts.

## Consequences

- An upgraded Host or a dev Host at another commit no longer hot-replaces plugin code into a page whose shell belongs to another release without asking; the user decides when to reload.
- **Not now** keeps hot-replacing across releases, with the same risk as before this change, by the user's choice.
- A composition without the dialog registered only pauses hot replacement and logs the warning; the user sees no prompt.
- The API connection and SSE are independent channels, so an old page can show a protocol error before the dialog appears.
- If a restarting Host answers `/plugins/events` with a non-200 status before registering the route, the browser closes that SSE stream for good, and the page cannot detect the release change until it reloads.
- A source launch without dev-web has no commit, so development detection falls back to version changes.
- Each tab prompts and remembers independently.
- Unit tests pin the gate's behavior through `ClientEntries`, the manifest parser, the Host-published release, the shared preset's Node-half defines, and the dialog's rendering and callbacks; the end-to-end restart scenario was verified against a real Host.
