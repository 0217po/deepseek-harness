/** Native application objects independent of evaluator ownership and persistence. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Helper-issued application identity, bound to one process lifetime. */
export type CuaAppHandle = Branded<'CuaAppHandle'>
/** Helper-issued accessibility observation identity. */
export type CuaSnapshotId = Branded<'CuaSnapshotId'>
/** One operation sent through an authorized and logged host dispatcher. */
export interface CuaOperation { method: string; params: Record<string, JsonValue> }
/** Dispatch exactly once; a failed action must not be retried implicitly. */
export type CuaDispatch = (operation: CuaOperation) => Promise<JsonValue>
/** Optional output owned by the caller; persistence and image admission are external. */
export interface CuaObservationSink {
  /**
   * Emit text.
   * @param value - observed application state.
   */
  text(value: string): void | Promise<void>
  /**
   * Emit an image.
   * @param data - PNG bytes.
   */
  image(data: Uint8Array): void | Promise<void>
}
/** Observations emit by default. Returned values are unaffected by this option. */
export interface CuaObservationOptions { emit?: boolean }
/** Diffing is not implemented; all reads return a complete tree. */
export interface CuaAxOptions extends CuaObservationOptions { disableDiffing?: boolean }
/** Available permissions and operations reported by the selected native implementation. */
export interface CuaCapabilities {
  platform: string
  permissions: { accessibility: boolean; screenRecording: boolean }
  methods: string[]
  coordinateSpace: 'window-points'
  browser: false
}
/** App discovery result accepted by getApp. */
export interface CuaAppInfo { id: string; displayName: string; isRunning: true; pid: number }
/** Window bounds in global macOS points. Local operations use an origin of [0,0]. */
export interface CuaBounds { x: number; y: number; width: number; height: number }
/** Observed window metadata; identifiers are valid only while the window exists. */
export interface CuaWindowInfo {
  windowId: number
  pid: number
  appName: string
  title: string
  bounds: CuaBounds
  isOnScreen: boolean
  onCurrentSpace: boolean | null
}
/** Successful input dispatch; application outcome still requires observation. */
export interface CuaActionResult { dispatched: true; verified: false }
/** Indexed and coordinate clicks support left single/double clicks and right single clicks. */
export interface CuaClickOptions { mouseButton?: 'left' | 'right'; clickCount?: 1 | 2 }
/** Positive deltas reveal content above/left; each axis is an integer from -10 to 10. */
export interface CuaScrollOptions { x: number; y: number; deltaLinesX: number; deltaLinesY: number }
/** An observed AX tree and independently captured PNG; capture is not atomic. */
export interface CuaObservation { state: string; screenshot: Uint8Array }
/** App-wide or explicitly scoped window observations and actions. */
export interface CuaSurface {
  /**
   * Read a fresh full tree.
   * @param options - emission and diff options.
   * @returns AX text with element indices.
   */
  getAXState(options?: CuaAxOptions): Promise<string>
  /**
   * Capture the selected window.
   * @param options - emission options.
   * @returns PNG bytes, whose pixel dimensions may differ from window points.
   */
  getScreenshot(options?: CuaObservationOptions): Promise<Uint8Array>
  /**
   * Read AX then capture.
   * @param options - observation options.
   * @returns both non-atomic observations.
   */
  getAXStateAndScreenshot(options?: CuaAxOptions): Promise<CuaObservation>
  /**
   * Click a current AX index or window point.
   * @param target - index or [x,y].
   * @param options - button and click count.
   * @returns dispatch evidence.
   */
  click(target: number | readonly [number, number], options?: CuaClickOptions): Promise<CuaActionResult>
  /**
   * Set an observed control value.
   * @param index - index from this surface's latest tree.
   * @param value - replacement value.
   * @returns dispatch evidence.
   */
  setValue(index: number, value: string): Promise<CuaActionResult>
  /**
   * Scroll at a window point.
   * @param options - point and line deltas; at least one delta must be nonzero.
   * @returns dispatch evidence.
   */
  scroll(options: CuaScrollOptions): Promise<CuaActionResult>
  /**
   * Drag between points in one window.
   * @param from - starting window point.
   * @param to - destination window point.
   * @returns dispatch evidence.
   */
  drag(from: readonly [number, number], to: readonly [number, number]): Promise<CuaActionResult>
}
/** One explicit window; keyboard operations remain app-scoped because they follow focus. */
export interface CuaWindow extends CuaSurface { readonly windowId: number }
/** Native app handle; implicit coordinates use the focused window or the sole visible window. */
export interface CuaApp extends CuaSurface {
  readonly pid: number
  readonly appHandle: CuaAppHandle
  /**
   * Enumerate current windows.
   * @param options - output options.
   * @returns current window records.
   */
  getWindows(options?: CuaObservationOptions): Promise<CuaWindowInfo[]>
  /**
   * Observe a specific window.
   * @param windowId - ID obtained from getWindows.
   * @returns a reusable window object with its initial AX state emitted.
   */
  getWindow(windowId: number): Promise<CuaWindow>
  /**
   * Input at the application's current focus.
   * @param text - literal text; cancellation may leave a prefix entered.
   * @returns dispatch evidence.
   */
  typeText(text: string): Promise<CuaActionResult>
  /**
   * Insert plain text at current focus through native Unicode input, preserving the system clipboard.
   * @param text - Literal text; rich-text clipboard formats are unsupported.
   * @returns Dispatch evidence; cancellation may leave a prefix entered.
   */
  paste(text: string): Promise<CuaActionResult>
  /**
   * Send a key/chord at current focus.
   * @param key - xdotool-style chord such as super+c or shift+Tab.
   * @returns dispatch evidence.
   */
  pressKey(key: string): Promise<CuaActionResult>
}
/** Native app API; its caller owns global bindings and variable persistence. */
export interface CuaApi {
  /**
   * Inspect permissions without requesting them.
   * @param options - output options.
   * @returns reported native capabilities.
   */
  getCapabilities(options?: CuaObservationOptions): Promise<CuaCapabilities>
  /**
   * Enumerate running applications.
   * @param options - output options.
   * @returns identifiers accepted by getApp.
   */
  listApps(options?: CuaObservationOptions): Promise<CuaAppInfo[]>
  /**
   * Discover apps.
   * @param options - output options.
   * @returns native apps and an empty browser list.
   */
  getState(options?: CuaObservationOptions): Promise<{ apps: CuaAppInfo[]; browsers: [] }>
  /**
   * Select an existing app and emit initial AX state.
   * @param selector - exact name, bundle ID, absolute application path or PID string.
   * @returns a handle tied to this process lifetime.
   */
  getApp(selector: string): Promise<CuaApp>
}
