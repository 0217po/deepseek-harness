/** Experimental Codex-style macOS computer use over locally built native source. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import { NativeClient } from './native-client.ts'
import { Request, ScreenshotResult, StateResult } from './protocol.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-computer-use'

/** Loader plugin identity. */
export const name = 'experimental-cua'
/** Services required for logged tools and owned native process lifetime. */
export const inject = ['computerUse', 'tools', 'systemPrompt', 'subprocess', 'agents']

/** Native executable and per-operation resource bounds. */
export interface Config {
  /** Absolute path to the locally built macOS native helper. */
  helperPath: string
  /** Deadline for one native operation, including capture and AX traversal. */
  timeoutMs: number
  /** Deadline for each individual Accessibility system call. */
  axTimeoutMs: number
  /** Maximum bytes retained for one helper response frame. */
  maxResponseBytes: number
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
export const Config: Schema<Config> = Schema.object({
  helperPath: Schema.string().required(),
  timeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(30_000),
  axTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxRequestBytes: Schema.number().step(1).min(1024).default(1024 * 1024),
  dragDurationMs: Schema.number().step(1).min(1).max(5000).default(400),
  dragSteps: Schema.number().step(1).min(1).max(240).default(20),
  maxResponseBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
  textEventIntervalMs: Schema.number().min(0).max(1000).default(0.25),
  graceMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxElements: Schema.number().step(1).min(1).max(10000).default(2000),
  maxDepth: Schema.number().step(1).min(1).max(100).default(25),
})

/** Instructions for raw operation calls and optional object-API bindings. */
export const GUIDANCE = `Use cua with method getCapabilities and params {} to inspect permissions and sessionLocked. If sessionLocked is true or an operation reports SESSION_LOCKED, stop UI attempts and ask the user to unlock macOS. A null sessionLocked means no usable console session was verified. After unlocking, read fresh state; screenshots from a locked desktop are not current observations. Use listApps and getApp to select an already running application. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. getState returns a complete AX tree and snapshotId. Use its element indices only with that snapshotId. Select a windowId explicitly for screenshots and coordinate actions. Coordinates are window-local macOS points, which may differ from screenshot pixels. A verified window can expose no AX elements. Its empty snapshot permits screenshots and coordinate input; element-index actions require an element from a fresh AX observation.

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

Raw operation tools use { method, params }, including params: {} for parameterless methods. getApp selects without activating the app. Keep applications in the background for observation and routine input. Do not activate or raise an app during initialization, before each action, or merely because another app is foreground. Prefer advertised AX actions. If a hidden window, another Space or Stage Manager prevents usable observation, explain the foreground-dependent step before app.activate() or an advertised raise action, then read fresh state. Avoid repeated activation when the user switches away; continue background-capable steps and report what requires foreground access. Applications may still change focus in response to input.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. WINDOW_CHANGED requires fresh state before any retry; use an advertised AX action or explicitly restore the window before screenshot or coordinate input, then observe again. PERMISSION_DENIED requires the user to grant macOS Accessibility or Screen Recording permission.

Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste inserts plain text using native Unicode input without changing the clipboard; rich-text formats are unavailable. Browser applications can be controlled with getApp like other native apps; browser tabs and app launching are unavailable. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, initialize once with var { connectCua } = await import("@deepseek-ai/dsh-experimental-cua/bridge"); var cua = connectCua(() => tools.cua, text => console.log(text)). Retain app objects between calls. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.`

/**
 * Mount logged native operations with a separate helper per agent.
 * @param ctx - Host context with computer-use, subprocess and tool services.
 * @param config - Validated macOS helper path and bounds.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.helperPath)) throw new Error('dsh-cua helperPath must be absolute')
  const clients = new Map<Agent, NativeClient>()
  const lifetime = new AbortController()
  const pending = new Map<Promise<unknown>, Agent>()
  const ownerCleanups = new Map<Agent, { close: () => Promise<void>; release: () => Promise<void>; signal: AbortSignal }>()
  const closedOwners = new WeakSet<Agent>()
  const projectionExecutions = new WeakMap<Readonly<ToolExecution>, ToolExecution>()
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
      await Promise.allSettled(pending.keys())
      const owners = [...ownerCleanups.values()]
      const results = await Promise.allSettled(owners.map(owner => owner.close()))
      const releases = await Promise.allSettled(owners.map(owner => owner.release()))
      const errors: unknown[] = []
      for (const result of [...results, ...releases]) if (result.status === 'rejected') errors.push(result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'dsh-cua helper cleanup failed')
    }
    const definition = createMcpToolDefinition(ctx, {
      name: 'cua', rawName: 'cua',
      description: 'Inspect macOS permissions, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state.',
      inputSchema: { ...z.record(z.string(), z.json()).parse(z.toJSONSchema(Request)), type: 'object' },
      async call(args, execution) {
        const { method, params: parsedParams } = Request.parse(args)
        const params = z.record(z.string(), z.json()).parse(parsedParams)
        const agent = execution.agent
        if (!agent) throw new Error('dsh-cua requires an agent-owned execution')
        const signal = execution.signal
        signal.throwIfAborted()
        const previous = clients.get(agent)
        if (previous?.disposed) await previous.dispose()
        signal.throwIfAborted()
        let client = clients.get(agent)
        if (!client || client.disposed) {
          client = new NativeClient(ctx, {
            helperPath: config.helperPath, cwd: process.cwd(), timeoutMs: config.timeoutMs, axTimeoutMs: config.axTimeoutMs,
            maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxResponseBytes, graceMs: config.graceMs,
            textEventIntervalMs: config.textEventIntervalMs,
          })
          clients.set(agent, client)
        }
        const result = await client.request(method, method === 'getState'
          ? { ...params, maxElements: config.maxElements, maxDepth: config.maxDepth }
          : method === 'drag' ? { ...params, durationMs: config.dragDurationMs, steps: config.dragSteps }
            : params, signal, execution.callId)
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
        const agent = execution.agent
        if (!agent) throw new Error('dsh-cua requires an agent-owned execution')
        execution.signal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        const owner = ownerFor(agent)
        const signal = AbortSignal.any([execution.signal, lifetime.signal, owner.signal])
        signal.throwIfAborted()
        const scoped = { ...execution, signal }
        projectionExecutions.set(execution, scoped)
        const operation = (async () => {
          const result = await definition.execute(args, scoped)
          signal.throwIfAborted()
          return result
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
    yield ctx.systemPrompt.section({ name: 'computer-use:dsh-cua', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'), text: GUIDANCE })
  }, 'dsh-cua.runtime')
}
