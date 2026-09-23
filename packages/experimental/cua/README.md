---
description: "Inspect and operate native macOS applications through scoped app and window objects."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-cua

English | [中文](README.zh.md)

## Summary

Inspect macOS permissions, select running applications and windows, read accessibility trees, capture screenshots and send input. The object API can be retained by an external persistent execution environment. The native helper is built locally from selected MIT-licensed Cua Driver source. This package owns neither a PTC runtime nor variable persistence.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Build on macOS with Rust and Xcode command-line tools, then mount the source overlay from the repository root:

```sh
cargo build --release --locked --manifest-path packages/experimental/cua/native/Cargo.toml
cua_native_root="$PWD/packages/experimental/cua/native"
export DSH_CUA_HELPER="$cua_native_root/target/release/dsh-cua-native"
pnpm dsh headless --patch packages/experimental/cua/examples/macos.cordis.yml --dump-config
```

The dump command checks profile composition without a model request. For a real task, replace `--dump-config` with a prompt and configure the profile’s model credentials. The overlay mounts the computer-use registry and this provider; remove an existing competing provider before using it. The responsible host/helper needs Accessibility permission for AX/input and Screen Recording permission for capture. `getCapabilities` reports permissions and session lock state without opening a system dialog. Locked or unavailable desktop sessions reject UI observations and input before dispatch; the user must unlock macOS before resuming. Start the target application yourself. Select it by name, bundle ID, absolute application path, or PID. `getApp` reads the selected application without activating it. Use `performSecondaryAction(index, "raise")` on an observed window to activate it explicitly. If a hidden window or another Space prevents observation, `app.activate()` requests foreground recovery and may switch the focused app and Space; read fresh state afterward. Applications may change focus after input; background delivery does not guarantee an undisturbed user session.

| Field | Default | Meaning |
| --- | --- | --- |
| `helperPath` | required | Absolute native executable path. |
| `timeoutMs` | `30000` | Per-operation deadline; cancellation can leave partial input. |
| `maxRequestBytes` / `maxResponseBytes` | `1048576` / `33554432` | UTF-8 request and response limits. |
| `maxElements` / `maxDepth` | `2000` / `25` | Accessibility traversal limits. |
| `dragDurationMs` / `dragSteps` | `400` / `20` | Duration and movement segments for a drag. |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-cua) lists all fields. Native tool calls use `{method, params}`; the complete method-specific schema is exposed to the model. For example, `getApp` returns the `appHandle` needed by `listWindows`, `getState` and input operations.

### Connect an external execution environment

To run through persistent PTC, add `--patch packages/experimental/cua/examples/persistent-ptc.cordis.yml` after the macOS overlay. This provider keeps variables for the live Agent and runs without a file sandbox. The caller imports the bridge and supplies the current authorized `tools.cua` binding. This integration snippet assumes an execution host has supplied `tools`; the package does not install a global object or keep variables alive:

```javascript
import { connectCua } from '@deepseek-ai/dsh-experimental-cua/bridge'
const cua = connectCua(() => tools.cua, text => console.log(text))
const app = await cua.getApp("com.apple.TextEdit")
const windows = await app.getWindows()
const window = await app.getWindow(windows[0].windowId)
await window.getScreenshot()
```

Choose the intended window from its title and bounds. `getWindow` emits its initial AX tree. Window objects retain separate snapshots, so reading one window does not invalidate another. Re-reading the same scope invalidates old indices. App-scoped screenshots and coordinates use the focused window when it appears in the latest observation, otherwise require exactly one visible, nonzero-size window. Explicit window objects select a particular target. Keyboard methods stay on `app` because input follows the app’s current focus.

Retained objects resolve the current tool binding on every call. The external runtime owns persistence, imports, cancellation and completion-value serialization. Screenshots return PNG bytes; the standard tool pipeline admits the image attachment exactly once. `emit: false` suppresses facade output only. A host that uses another dispatcher can build objects through `createCuaApi` from `./api`.

Indexed clicks support a single right click or a single/double left click. The helper uses an advertised accessibility action when available; pointer delivery resolves the element’s current bounds and verifies its owning window. Actions report dispatch, not application success. Read state after input. `STALE_APP` requires acquiring the application again; `STALE_SNAPSHOT` requires a fresh AX read. Transport timeout/cancellation terminates that Agent’s helper and invalidates its handles. Never retry uncertain input automatically. Closing an Agent releases its helper and AX references, without undoing changes to applications.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Dispatch and resource ownership</summary>

The object facade translates app/window methods into JSON operations. The bridge routes them through the normal tool pipeline, preserving authorization, nested logs and image admission. A separate serial helper belongs to each Agent. Native handles bind a process identity to its kernel start time, and snapshots retain native AX references only inside that helper. The same operation protocol can serve a future platform provider without adding platform logic to the object API.

AX traversal visits each native identity once, including proxy references that compare equal, so cyclic accessibility children cannot repeat whole subtrees. The [source manifest](native/upstream.json) identifies unchanged copied files and local integration code. No invariant companion is published: there is no independently projected registry or durable evaluator state to reconcile. Protocol validation, target identity and resource cleanup are checked by their owning implementations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Computer-use registration](../../computer-use/computer-use/README.md)
- [Native protocol](native/protocol.schema.json)
- [Object interfaces](src/types.ts)

-----

<a id="model-experience"></a>
## Model Experience

### Native application operations

#### What the model sees

The plugin contributes one `cua` operation tool with method-specific parameters. Standard PTC presentation exposes it as `tools.cua` through `run_code`. The following package-owned guidance is emitted verbatim:

##### Operation guidance (verbatim)

```markdown
Use cua with method getCapabilities and params {} to inspect permissions and sessionLocked. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI attempts and ask the user to unlock macOS. A null sessionLocked means no usable console session was verified. After unlocking, read fresh state; screenshots from a locked desktop are not current observations. Use listApps and getApp to select an already running application. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. getState returns a complete AX tree and snapshotId. Use its element indices only with that snapshotId. Select a windowId explicitly for screenshots and coordinate actions. Coordinates are window-local macOS points, which may differ from screenshot pixels.

Initialize the object API once in persistent PTC. Reuse its variables in later calls; put temporary declarations inside { ... } blocks to avoid redeclaration errors. All object methods are async. Await getWindow before using the returned window object. getAXState returns text, not a structured state object.

Object API signatures (options default to { emit: true }):

- cua.getCapabilities(options?) -> { platform, permissions, sessionLocked, methods, coordinateSpace, browser }
- cua.listApps(options?) -> Array<{ id, displayName, isRunning, pid }>
- cua.getState(options?) -> { apps, browsers: [] }
- cua.getApp(selector: string) -> App
- app.activate() -> { dispatched: true, verified: false }
- app.getWindows(options?) -> Array<{ windowId, pid, appName, title, bounds, isOnScreen, onCurrentSpace }>
- app.getWindow(windowId: number) -> Window
- app.typeText(text: string), app.paste(text: string), app.pressKey(chord: string) -> action result

App and Window methods:

- getAXState(options?: { emit?: boolean, disableDiffing?: boolean }) -> string
- getScreenshot(options?: { emit?: boolean }) -> Uint8Array
- getAXStateAndScreenshot(options?) -> { state: string, screenshot: Uint8Array }
- click(target: number | [x, y], options?: { mouseButton?: "left" | "right", clickCount?: 1 | 2 }) -> action result
- setValue(elementIndex: number, value: string) -> action result
- performSecondaryAction(elementIndex: number, action: string) -> action result
- scroll({ x, y, deltaLinesX, deltaLinesY }) -> action result
- drag(from: [x, y], to: [x, y]) -> action result

Raw operation tools use { method, params }, including params: {} for parameterless methods. getApp selects without activating the app. Prefer background actions so the user can keep working elsewhere; native apps may still change focus in response to input. Invoke performSecondaryAction with an action advertised in the AX tree, such as raise, only when that visible action is needed. Raising a window explicitly activates its app. When a hidden window or a window on another Space cannot be observed, app.activate() is an explicit foreground recovery that may switch the focused app and Space; read fresh AX state afterward.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. PERMISSION_DENIED requires the user to grant macOS Accessibility or Screen Recording permission.

Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste inserts plain text using native Unicode input without changing the clipboard; rich-text formats are unavailable. Browser applications can be controlled with getApp like other native apps; browser tabs and app launching are unavailable. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, initialize once with var { connectCua } = await import("@deepseek-ai/dsh-experimental-cua/bridge"); var cua = connectCua(() => tools.cua, text => console.log(text)). Retain app objects between calls. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.
```

#### Token effect

Enabling the plugin adds a fixed schema and guidance. AX observations, operation results and admitted images add model input. Retained objects are not serialized into prompts by this package.

#### KV Cache effect

Tool results append to Session history. Changing plugin configuration or tool presentation can change the request prefix; retaining an app object does not change existing history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only the macOS native implementation is provided. Browser tabs, app launching, rich-text clipboard formats, AX diffs, separate-process Open/Save panels and accessory-only apps are unsupported.
- Coordinates use window-local points including the title bar. PNG pixel dimensions can differ. Window movement, application changes and other desktop users can race observations and input.
- Native binaries require a local build. Signing, distribution and permission onboarding remain future work.
- Persistent PTC is an external dependency assumption, not an implementation in this package. Real-model task success requires separate evaluation beyond native and protocol fixtures.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
