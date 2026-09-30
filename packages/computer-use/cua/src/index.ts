/** macOS computer use over a managed native helper. */
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { fileURLToPath } from 'node:url'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import { NativeClient, NativeError, type NativeClientConfig } from './native-client.ts'
import { ApplicationAuthorizationResult, ApplicationAccess } from './application-access.ts'
import type { CuaApplicationGrant, CuaApplicationId } from './application-types.ts'
import type { CuaAppHandle } from './types.ts'
import { nativeHostArchitecture, prepareNativeExecutable } from './native-build.ts'
import { AppResult, Request, ScreenshotResult, StateResult } from './protocol.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** Loader plugin identity. */
export const name = 'cua'
/** Services required for logged tools and owned native process lifetime. */
export const inject = ['computerUse', 'tools', 'systemPrompt', 'subprocess', 'agents']

/** Native executable and per-operation resource bounds. */
export interface Config {
  /** Signed applications explicitly approved for future tasks in this profile. */
  allowedApps: Volatile<Array<Omit<CuaApplicationGrant, 'id'> & {
    /** Unbranded digest at the profile configuration boundary; admitted by the Config schema. */
    id: string
  }>>
  /** Absolute native helper override; omission prepares the package-owned executable. */
  helperPath?: string
  /** Maximum time in milliseconds for native component preparation. */
  buildTimeoutMs: number
  /** Deadline for one native operation, including capture and AX traversal. */
  timeoutMs: number
  /** Deadline for each individual Accessibility system call. */
  axTimeoutMs: number
  /** Maximum bytes retained for one helper response frame. */
  maxResponseBytes: number
  /** Maximum installed application matches returned for one discovery query. */
  maxAppMatches: number
  /** Maximum bytes preserved from the system clipboard during one paste. */
  maxClipboardBytes: number
  /** Maximum UTF-8 bytes admitted for one helper request frame. */
  maxRequestBytes: number
  /** Duration in milliseconds of one same-window drag. */
  dragDurationMs: number
  /** Number of movement segments dispatched during a drag. */
  dragSteps: number
  /** Delay in milliseconds after each Unicode key-down or key-up event. */
  textEventIntervalMs: number
  /** Managed process termination grace in milliseconds. */
  graceMs: number
  /** Maximum nodes admitted by a native accessibility snapshot. */
  maxElements: number
  /** Maximum depth traversed by a native accessibility snapshot. */
  maxDepth: number
}

/** Validated host configuration; no driver is downloaded at runtime. */
export const Config = Schema.object({
  allowedApps: Schema.array(Schema.object({
    id: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
    name: Schema.string().required(), executablePath: Schema.string().min(1).required(),
  })).default([]).volatile(),
  helperPath: Schema.string(),
  buildTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(300_000),
  timeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(30_000),
  axTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxAppMatches: Schema.number().step(1).min(1).max(1000).default(20),
  maxClipboardBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
  maxRequestBytes: Schema.number().step(1).min(1024).default(1024 * 1024),
  dragDurationMs: Schema.number().step(1).min(1).max(5000).default(400),
  dragSteps: Schema.number().step(1).min(1).max(240).default(20),
  maxResponseBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
  textEventIntervalMs: Schema.number().min(0).max(1000).default(0.25),
  graceMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxElements: Schema.number().step(1).min(1).max(10000).default(2000),
  maxDepth: Schema.number().step(1).min(1).max(100).default(25),
}) satisfies Schema<Record<string, unknown>, Config>

/** Instructions for raw operation calls and optional object-API bindings. */
export const GUIDANCE = `Use cua with method getCapabilities and params {} to inspect permissions and sessionLocked. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI attempts and ask the user to unlock macOS. A null sessionLocked means no usable console session was verified. After unlocking, read fresh state; screenshots from a locked desktop are not current observations. Use listApps or cua.getState to discover running applications, and findApps(query) to search installed applications by name, bundle ID or absolute path. getApp requests user consent before launching a stopped application in the background, or before observations and input on a running one. If access is denied or revoked, stop using that application until the user explicitly grants access again. Never switch tools to bypass a refusal. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. Raw getState returns AX text and snapshotId. Menu-bar entries are shown by default; includeMenus=true expands their contents. details=true adds identifiers, global-point bounds and complete action names. Both options also apply to getAXState. Each read replaces the indices for that app/window scope. Use its element indices only with that snapshotId. Raw screenshot and coordinate operations require a windowId. Coordinates are window-local macOS points, which may differ from screenshot pixels. A verified window can expose no AX elements. Its empty snapshot permits screenshots and coordinate input; element-index actions require an element from a fresh AX observation.

Initialize the object API once in persistent PTC. Reuse its variables in later calls; put temporary declarations inside { ... } blocks to avoid redeclaration errors. All object methods are async. getAXState returns text, not a structured state object. Its text separates values and placeholders, and reports subroles, help, URLs, disabled/focused/selected/expanded state and UTF-16 selection ranges when available. Writability is true, false or unknown on relevant controls; omitted state fields do not assert false. selection=unavailable means the reported range exceeds the observed text. Compact output omits ordinary Press/Pick (click), ShowMenu (right click) and ScrollToVisible actions; details=true lists every available action. Use the displayed action name with performSecondaryAction; ambiguous aliases require the complete name from details=true. Truncation reports the reached provider limit. Narrow the window or increase that provider limit before reading again.

Use app methods directly for single-window tasks; getApp already reads initial AX state. Call app.getWindows() and await app.getWindow(windowId) only to target a particular window or resolve ambiguous window selection. App screenshots and coordinate actions use the latest AX observation: its focused on-screen, nonzero-size window, otherwise the sole such window. They do not refresh focus automatically. Read app.getAXState() to follow changed focus.

Object API signatures (options default to { emit: true }):

- cua.getCapabilities(options?) -> { platform, permissions, sessionLocked, methods, coordinateSpace, browser }
- cua.listApps(options?) -> Array<{ id, displayName, isRunning: true, pid }>
- cua.findApps(query: string, options?) -> Array<{ id, displayName, path, isRunning, pid? }>
- cua.getState(options?) -> { apps, browsers: [] }
- cua.getApp(selector: string) -> App
- app.activate() -> { dispatched: true, verified: false }
- app.getWindows(options?) -> Array<{ windowId, pid, appName, title, bounds, isOnScreen, onCurrentSpace }>
- app.getWindow(windowId: number) -> Window
- app.typeText(text: string), app.pressKey(chord: string) -> action result
- app.paste(text: string, options?: { format?: "text" | "html" }) -> action result

App and Window methods:

- show() -> { dispatched: true, verified: false, windowId: number | null, foregroundChanged: boolean | null }
- getAXState(options?: { emit?: boolean, disableDiffing?: boolean, includeMenus?: boolean, details?: boolean }) -> string
- getScreenshot(options?: { emit?: boolean }) -> Uint8Array
- getAXStateAndScreenshot(options?) -> { state: string, screenshot: Uint8Array }
- click(target: number | [x, y], options?: { mouseButton?: "left" | "right" | "middle", clickCount?: 1 | 2, modifiers?: Array<"command" | "control" | "option" | "shift" | "fn"> }) -> action result
- setValue(elementIndex: number, value: string) -> action result
- selectText(elementIndex: number, text: string, options?: { prefix?: string, suffix?: string, selectionType?: "text" | "cursor_before" | "cursor_after" }) -> action result
- performSecondaryAction(elementIndex: number, action: string) -> action result
- scroll({ x, y, deltaLinesX, deltaLinesY }) -> action result
- drag(from: [x, y], to: [x, y], options?: { mouseButton?: "left" | "right" | "middle", modifiers?: Array<"command" | "control" | "option" | "shift" | "fn"> }) -> action result

Raw operation tools use { method, params }, including params: {} for parameterless methods. getApp selects without activating the app. Keep applications in the background for observation and routine input. Do not activate or raise an app during initialization, before each action, or merely because another app is foreground. Prefer advertised AX actions. If a window is hidden or minimized, try app.show() or window.show() and read fresh state. show requests unhide and unminimize without activation, raising or switching Spaces; it chooses the explicit, focused, main or sole AX window. A null windowId means no window was selected for restoration. foregroundChanged compares the front app and top window before and after the request; null means unavailable, and delayed focus changes remain possible. If restoration is unsupported or the window remains unusable, including another Space or Stage Manager, explain the needed foreground step, use app.activate() or an advertised raise action, and read fresh state. Completing the task takes priority when foreground access is necessary. Avoid repeated activation when the user switches away; continue background-capable steps and report what requires foreground access. Applications may still change focus in response to input.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. Coordinate clicks, scrolling and dragging require a successful AX observation or screenshot of that window. Window resizing since the latest observation rejects coordinate input; movement alone preserves window-local coordinates. WINDOW_CHANGED requires fresh state before any retry; use an advertised AX action or explicitly restore the window before screenshot or coordinate input, then observe again. PERMISSION_DENIED requires the user to grant macOS Accessibility or Screen Recording access in System Settings. After granting access, observe fresh state before continuing; do not automatically replay prior input.

Use selectText only on controls advertising selectionWritable. It selects a unique literal occurrence, or places the cursor before/after it; prefix and suffix must be immediately adjacent. AMBIGUOUS_TEXT requires more context; TEXT_NOT_FOUND or SELECTION_CHANGED requires a fresh observation before deciding on input. Left clicks support single/double clicks; right and middle clicks support single clicks. Modified clicks use pointer input. Keypad names such as KP_0 and KP_Enter retain their physical key identity. Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste delivers plain text or HTML through the application's enabled standard Paste menu command. Original clipboard formats are restored if the clipboard still belongs to this paste; a later copy is preserved. Unsupported Paste commands fail without typing fallback. CLIPBOARD_CHANGED means another writer intervened; observe before deciding on further input. Browser applications can be controlled with getApp like other native apps; browser tabs are unavailable. Installed-app search covers standard macOS application directories; use an absolute application path for another location. Launch does not restore a window or document, and cancellation may leave an application already started. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, use the host-provided initialization snippet below once. Its installation-owned file URL works independently of the project directory. Retain app objects between calls. Observation methods emit by default and also return their value. Use void await app.getAXState() to avoid a duplicate REPL completion, or pass emit:false and print the returned text once. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.`

function executionAgent(execution: Readonly<ToolExecution>): Agent {
  if (!execution.agent) throw new Error('dsh-cua requires an agent-owned execution')
  return execution.agent
}

interface CuaExecution extends ToolExecution {
  nativeClient: NativeClient
}

/**
 * Mount logged native operations with a separate helper per agent.
 * @param ctx - Host context with computer-use, subprocess and tool services.
 * @param config - Validated native preparation and operation bounds.
 * @returns Completion after native preparation and tool registration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.helperPath !== undefined) {
    if (!isAbsolute(config.helperPath)) throw new Error('dsh-cua helperPath must be absolute')
    mount(ctx, config, config.helperPath)
    return
  }
  const architecture = nativeHostArchitecture(process.platform, process.arch)
  const controller = new AbortController()
  const prepared = prepareNativeExecutable({
    packageRoot: resolve(fileURLToPath(new URL('..', import.meta.url))),
    architecture, subprocess: ctx.subprocess,
    timeoutMs: config.buildTimeoutMs, graceMs: config.graceMs, signal: controller.signal,
  })
  ctx.effect(() => async () => {
    controller.abort()
    // The Loader receives preparation failures through apply; disposal only awaits quiescence.
    await prepared.catch(() => {})
  }, 'dsh-cua.native-preparation')
  const helperPath = await prepared
  controller.signal.throwIfAborted()
  mount(ctx, config, helperPath)
}

function mount(ctx: Context, config: Config, helperPath: string): void {
  const native: NativeClientConfig = {
    helperPath, cwd: process.cwd(), timeoutMs: config.timeoutMs, axTimeoutMs: config.axTimeoutMs,
    maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxResponseBytes, graceMs: config.graceMs,
    textEventIntervalMs: config.textEventIntervalMs,
  }
  const entryId = ctx.fiber.entry?.options.id
  ctx.inject(['settings'], scope => scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)))
  const access = new ApplicationAccess(ctx, {
    grants: () => config.allowedApps.get().map(grant => ({ ...grant, id: grant.id as CuaApplicationId })),
    get save() {
      const settings = ctx.get('settings')
      if (entryId === undefined || settings === undefined) return undefined
      const descriptor = settings.describe().find(entry => entry.ns === entryId)
      if (!descriptor) return undefined
      return async (grants: readonly CuaApplicationGrant[]) => {
        await settings.mutate(entryId, [{ op: 'set', path: ['allowedApps'], value: grants }], descriptor.revision)
      }
    },
  })
  const clients = new Map<Agent, NativeClient>()
  const lifetime = new AbortController()
  const pending = new Map<Promise<unknown>, Agent>()
  const ownerCleanups = new Map<Agent, { close: () => Promise<void>; release: () => Promise<void>; signal: AbortSignal }>()
  const closedOwners = new WeakSet<Agent>()
  const projectionExecutions = new WeakMap<Readonly<ToolExecution>, CuaExecution>()
  function ownerFor(agent: Agent) {
    if (closedOwners.has(agent) || ctx.agents.get(agent.id) !== agent) throw new Error('dsh-cua agent has been disposed')
    const existing = ownerCleanups.get(agent)
    if (existing) return existing
    const controller = new AbortController()
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => {
      closedOwners.add(agent)
      controller.abort()
      return closing ??= Promise.resolve().then(async () => {
        try {
          await clients.get(agent)?.dispose()
        } finally {
          await Promise.allSettled([...pending].filter(([, owner]) => owner === agent).map(([task]) => task))
          clients.delete(agent)
          access.forget(agent)
          ownerCleanups.delete(agent)
        }
      })
    }
    const release = agent.ctx.effect(() => close, 'dsh-cua.agent')
    const owner = { close, release, signal: controller.signal }
    ownerCleanups.set(agent, owner)
    return owner
  }
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName('dsh-cua'))
    yield async () => {
      lifetime.abort()
      const permissions = Promise.allSettled([access.dispose()])
      await Promise.allSettled(pending.keys())
      const owners = [...ownerCleanups.values()]
      const results = await Promise.allSettled(owners.map(owner => owner.close()))
      const releases = await Promise.allSettled(owners.map(owner => owner.release()))
      const errors: unknown[] = []
      for (const result of [...await permissions, ...results, ...releases]) if (result.status === 'rejected') errors.push(result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'dsh-cua helper cleanup failed')
    }
    const definition = createMcpToolDefinition(ctx, {
      name: 'cua', rawName: 'cua',
      description: 'Inspect macOS permissions, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state.',
      inputSchema: { ...z.record(z.string(), z.json()).parse(z.toJSONSchema(Request)), type: 'object' },
      async call(args, execution) {
        // The owning execute callback admits the request before entering this private MCP adapter.
        const { method, params: parsedParams } = args as z.infer<typeof Request>
        const params = z.record(z.string(), z.json()).parse(parsedParams)
        const agent = executionAgent(execution)
        const signal = execution.signal
        signal.throwIfAborted()
        const client = (execution as Readonly<CuaExecution>).nativeClient
        const nativeParams = method === 'findApps'
          ? { ...params, maxAppMatches: config.maxAppMatches }
          : method === 'paste'
            ? { ...params, maxClipboardBytes: config.maxClipboardBytes, maxElements: config.maxElements, maxDepth: config.maxDepth }
            : method === 'getState'
              ? { ...params, maxElements: config.maxElements, maxDepth: config.maxDepth }
              : method === 'drag' ? { ...params, durationMs: config.dragDurationMs, steps: config.dragSteps }
                : params
        const requestNative = () => client.request(method, nativeParams, signal, execution.callId)
        const result = method === 'paste'
          ? await withFileLock(join(tmpdir(), 'dsh-cua-system-clipboard'), requestNative, { waitMs: config.timeoutMs, signal })
          : await requestNative()
        if (method === 'getApp') {
          const prepared = AppResult.extend({ pid: AppResult.shape.pid.nullable() }).parse(result)
          const { authorization } = z.object({ authorization: ApplicationAuthorizationResult }).parse(result)
          await access.select(agent, client, prepared.appHandle, authorization, signal)
          signal.throwIfAborted()
          const selected = prepared.pid === null
            ? AppResult.parse(await access.run(client, prepared.appHandle, signal,
              signal => client.request('launchApp', { appHandle: prepared.appHandle }, signal, execution.callId)))
            : AppResult.parse(prepared)
          if (selected.appHandle !== prepared.appHandle) throw new NativeError('NATIVE_PROTOCOL', 'Launched application has another handle')
          return { content: [{ type: 'text', text: JSON.stringify(selected) }], structuredContent: selected }
        }
        signal.throwIfAborted()
        if (method === 'screenshot') {
          const { data, mimeType, ...metadata } = ScreenshotResult.parse(result)
          return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType, data }], structuredContent: result }
        }
        const visible = method === 'getState' ? StateResult.parse(result) : result
        return { content: [{ type: 'text', text: JSON.stringify(visible) }], structuredContent: visible }
      },
    })
    yield ctx.tools.register({
      ...definition,
      async execute(args, execution) {
        const request = Request.parse(args)
        const agent = executionAgent(execution)
        execution.signal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        const owner = ownerFor(agent)
        const signal = AbortSignal.any([execution.signal, lifetime.signal, owner.signal])
        signal.throwIfAborted()
        const operation = (async () => {
          const previous = clients.get(agent)
          if (previous?.disposed) await previous.dispose()
          signal.throwIfAborted()
          let client = clients.get(agent)
          if ('appHandle' in request.params && !client) {
            throw new NativeError('APP_ACCESS_REQUIRED', 'Select the application with getApp before reading or controlling it')
          }
          if (!client || (client.disposed && !('appHandle' in request.params))) {
            client = new NativeClient(ctx, native)
            clients.set(agent, client)
          }
          const nativeClient = client
          const dispatch = async (signal: AbortSignal) => {
            const scoped = { ...execution, signal, nativeClient }
            projectionExecutions.set(execution, scoped)
            const result = await definition.execute(request, scoped)
            signal.throwIfAborted()
            return result
          }
          return 'appHandle' in request.params
            ? access.run(nativeClient, request.params.appHandle as CuaAppHandle, signal, dispatch)
            : dispatch(signal)
        })()
        pending.set(operation, agent)
        try {
          return await operation
        } catch (error) {
          projectionExecutions.delete(execution)
          throw error
        } finally {
          pending.delete(operation)
        }
      },
      projectContent(execution, result) {
        const scoped = projectionExecutions.get(execution)
        projectionExecutions.delete(execution)
        return scoped === undefined ? undefined : definition.projectContent?.(scoped, result)
      },
    })
    yield ctx.systemPrompt.section({
      name: 'computer-use:dsh-cua', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: () => ctx.get('ptcRuntime')?.programFormat !== 'repl' ? GUIDANCE : `${GUIDANCE}

Persistent PTC initialization:
var { connectCua } = await import(${JSON.stringify(new URL('../lib/bridge.js', import.meta.url).href)});
var cua = connectCua(() => tools.cua, text => console.log(text));`,
    })
  }, 'dsh-cua.runtime')
}
