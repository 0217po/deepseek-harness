/** Experimental Codex-style macOS computer use over locally built native source. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import { NativeClient } from './native-client.ts'
import { Request, ScreenshotResult } from './protocol.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
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
  /** Maximum bytes retained for one helper response frame. */
  maxResponseBytes: number
  /** Maximum UTF-8 bytes admitted for one helper request frame. */
  maxRequestBytes: number
  /** Duration in milliseconds of one same-window drag. */
  dragDurationMs: number
  /** Number of movement segments dispatched during a drag. */
  dragSteps: number
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
  maxRequestBytes: Schema.number().step(1).min(1024).default(1024 * 1024),
  dragDurationMs: Schema.number().step(1).min(1).max(5000).default(400),
  dragSteps: Schema.number().step(1).min(1).max(240).default(20),
  maxResponseBytes: Schema.number().step(1).min(1024).default(32 * 1024 * 1024),
  graceMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(3000),
  maxElements: Schema.number().step(1).min(1).max(10000).default(2000),
  maxDepth: Schema.number().step(1).min(1).max(100).default(25),
})

/** Instructions for raw operation calls and optional object-API bindings. */
export const GUIDANCE = `Use cua with method getCapabilities to inspect permissions, then listApps and getApp to select an already running application. Keep the returned appHandle; every app operation requires it. listWindows returns window IDs and point bounds. getState returns a complete AX tree and snapshotId. Use its element indices only with that snapshotId. Select a windowId explicitly for screenshots and coordinate actions. Coordinates are window-local macOS points, which may differ from screenshot pixels.

getApp selects without activating the app. Prefer background actions so the user can keep working elsewhere; native apps may still change focus in response to input. Invoke performSecondaryAction with an action advertised in the AX tree, such as raise, only when that visible action is needed. Raising a window explicitly activates its app.

Await operations sequentially. After input, read fresh state to verify the effect. A successful action means dispatched, not verified completion. Cancellation may leave partial effects; never retry uncertain input without observing. STALE_APP requires getApp again; STALE_SNAPSHOT requires getState again. PERMISSION_DENIED requires the user to grant macOS Accessibility or Screen Recording permission.

The optional object API exposes getCapabilities, listApps, getState and getApp. App objects expose getWindows, getWindow(windowId), getAXState, getScreenshot, getAXStateAndScreenshot, click, setValue, performSecondaryAction, scroll, drag, typeText, paste and pressKey. Window objects expose observation and pointer/AX actions; keyboard input remains app-scoped and follows current focus. Scroll deltas are integer lines from -10 to 10; positive values reveal content above or left. Paste inserts plain text using native Unicode input without changing the clipboard; rich-text formats are unavailable. Browser applications can be controlled with getApp like other native apps; browser tabs and app launching are unavailable. The execution host must install the object API and own variable persistence; this plugin does not preload a cua global. In persistent PTC, initialize once with const { connectCua } = await import("@deepseek-ai/dsh-experimental-cua/bridge"); const cua = connectCua(() => tools.cua, text => console.log(text)). Retain app objects between calls. End screenshot calls with void await app.getScreenshot() or void await app.getAXStateAndScreenshot() so image bytes are not serialized as the program completion value.`

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
  const ownerCleanups = new Map<Agent, { close: () => Promise<void>; release: () => Promise<void> }>()
  const closedOwners = new WeakSet<Agent>()
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
    yield ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'cua', rawName: 'cua',
      description: 'Inspect macOS permissions, select an application and window, read AX state, capture screenshots or dispatch input. Use appHandle from getApp; verify actions by reading fresh state.',
      inputSchema: { ...z.record(z.string(), z.json()).parse(z.toJSONSchema(Request)), type: 'object' },
      async call(args, execution) {
        const { method, params: parsedParams } = Request.parse(args)
        const params = z.record(z.string(), z.json()).parse(parsedParams)
        const agent = execution.agent
        if (!agent) throw new Error('dsh-cua requires an agent-owned execution')
        const signal = AbortSignal.any([execution.signal, lifetime.signal])
        signal.throwIfAborted()
        const operation = (async () => {
          const previous = clients.get(agent)
          if (previous?.disposed) await previous.dispose()
          signal.throwIfAborted()
          if (closedOwners.has(agent) || ctx.agents.get(agent.id) !== agent) throw new Error('dsh-cua agent has been disposed')
          if (!ownerCleanups.has(agent)) {
            let closing: Promise<void> | undefined
            const close = (): Promise<void> => {
              closedOwners.add(agent)
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
            ownerCleanups.set(agent, { close, release })
          }
          let client = clients.get(agent)
          if (!client || client.disposed) {
            client = new NativeClient(ctx, {
              helperPath: config.helperPath, cwd: process.cwd(), timeoutMs: config.timeoutMs,
              maxRequestBytes: config.maxRequestBytes, maxResponseBytes: config.maxResponseBytes, graceMs: config.graceMs,
            })
            clients.set(agent, client)
          }
          return client.request(method, method === 'getState'
            ? { ...params, maxElements: config.maxElements, maxDepth: config.maxDepth }
            : method === 'drag' ? { ...params, durationMs: config.dragDurationMs, steps: config.dragSteps }
              : params, signal)
        })()
        pending.set(operation, agent)
        try {
          const result = await operation
          signal.throwIfAborted()
          if (method === 'screenshot') {
            const { data, mimeType, ...metadata } = ScreenshotResult.parse(result)
            return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', mimeType, data }], structuredContent: result }
          }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
        } finally {
          pending.delete(operation)
        }
      },
    }))
    yield ctx.systemPrompt.section({ name: 'computer-use:dsh-cua', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'), text: GUIDANCE })
  }, 'dsh-cua.runtime')
}
