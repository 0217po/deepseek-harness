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
  /** Null means the helper could not verify a usable console session. */
  sessionLocked: boolean | null
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
/** Modifiers attached to a window-directed pointer gesture. */
export type CuaPointerModifier = 'command' | 'control' | 'option' | 'shift' | 'fn'
/** Buttons supported by window-directed clicks and drags. */
export type CuaMouseButton = 'left' | 'right' | 'middle'
/** Left clicks support one or two presses; right and middle clicks support one. */
export interface CuaClickOptions { mouseButton?: CuaMouseButton; clickCount?: 1 | 2; modifiers?: readonly CuaPointerModifier[] }
/** One same-window drag; omitted button is left and omitted modifiers are empty. */
export interface CuaDragOptions { mouseButton?: CuaMouseButton; modifiers?: readonly CuaPointerModifier[] }
/** Adjacent literal context disambiguates repeated text; cursor modes collapse the matched range. */
export interface CuaSelectTextOptions { prefix?: string; suffix?: string; selectionType?: 'text' | 'cursor_before' | 'cursor_after' }
/** Positive deltas reveal content above/left; each axis is an integer from -10 to 10. */
export interface CuaScrollOptions { x: number; y: number; deltaLinesX: number; deltaLinesY: number }
/** An observed AX tree and independently captured PNG; capture is not atomic. */
export interface CuaObservation { state: string; screenshot: Uint8Array }
/**
 * App-wide or explicitly scoped window observations and actions.
 * Capture and pointer delivery reject known AX/display frame conflicts with WINDOW_CHANGED.
 * Advertised AX actions remain available; failed actions are not retried through pointer input.
 */
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
   * Select one literal text occurrence through writable AXSelectedTextRange and verify its range.
   * @param index - Text control index from this surface's latest tree.
   * @param text - Nonempty literal text; multiple matches require adjacent context.
   * @param options - Adjacent prefix/suffix and selection or cursor placement.
   * @returns Dispatch evidence; rejects unsupported, ambiguous or changed text without keyboard fallback.
   */
  selectText(index: number, text: string, options?: CuaSelectTextOptions): Promise<CuaActionResult>
  /**
   * Invoke an action advertised by an observed element; raising a window activates its app.
   * @param index - Index from this surface's latest AX tree.
   * @param action - Advertised action name, such as raise or zoomwindow.
   * @returns Dispatch evidence; menu and window actions can change focus.
   */
  performSecondaryAction(index: number, action: string): Promise<CuaActionResult>
  /**
   * Scroll at a window point.
   * @param options - point and line deltas; at least one delta must be nonzero.
   * @returns dispatch evidence.
   */
  scroll(options: CuaScrollOptions): Promise<CuaActionResult>
  /**
   * Drag between points in one window while holding the selected button and modifiers.
   * @param from - starting window point.
   * @param to - destination window point.
   * @param options - Button and modifiers for the complete gesture.
   * @returns dispatch evidence.
   */
  drag(from: readonly [number, number], to: readonly [number, number], options?: CuaDragOptions): Promise<CuaActionResult>
}
/** One explicit window; keyboard operations remain app-scoped because they follow focus. */
export interface CuaWindow extends CuaSurface { readonly windowId: number }
/**
 * Native app handle supporting direct observations and actions without window enumeration.
 * Screenshots and coordinates reuse the latest AX observation's focused on-screen,
 * nonzero-size window, or require exactly one such window. Read fresh AX to follow
 * focus changes; explicit window objects retain their selected target.
 */
export interface CuaApp extends CuaSurface {
  readonly pid: number
  readonly appHandle: CuaAppHandle
  /**
   * Activate this application explicitly, potentially changing the user's focused app and Space.
   * @returns Dispatch evidence; read fresh state before further interaction.
   */
  activate(): Promise<CuaActionResult>
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
   * @param key - xdotool-style chord such as super+c, shift+Tab, + or cmd++; plus is also a key name.
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
   * Select an existing app and emit initial AX state without activating it.
   * @param selector - exact name, bundle ID, absolute application path or PID string.
   * @returns a handle tied to this process lifetime.
   */
  getApp(selector: string): Promise<CuaApp>
}
