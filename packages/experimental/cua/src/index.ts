/** Shared CUA tool execution, application consent, and object-runtime integration. */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'
import { NativeClient, NativeError, type NativeClientConfig, type NativeChannelFactory } from './native-client.ts'
import { ApplicationAuthorizationResult, ApplicationAccess } from './application-access.ts'
import type { CuaApplicationGrant, CuaApplicationId } from './application-types.ts'
import type { CuaAppHandle } from './types.ts'
import { AppResult, Request, ScreenshotResult, StateResult } from './protocol.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'


/** Native executable and per-operation resource bounds. */
export interface CuaConfig {
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
  /** Maximum time to connect to or start the shared native helper. */
  connectTimeoutMs: number
  /** Screenshot deadline including time queued behind other native operations. */
  screenshotTimeoutMs: number
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
  /** Native connection cleanup, socket-write and launcher termination budget in milliseconds. */
  graceMs: number
  /** Maximum nodes admitted by a native accessibility snapshot. */
  maxElements: number
  /** Maximum depth traversed by a native accessibility snapshot. */
  maxDepth: number
}

/** Validated host configuration; no driver is downloaded at runtime. */
export const CuaConfig = Schema.object({
  allowedApps: Schema.array(Schema.object({
    id: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
    name: Schema.string().required(), executablePath: Schema.string().min(1).required(),
  })).default([]).volatile(),
  helperPath: Schema.string(),
  buildTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(300_000),
  timeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(30_000),
  connectTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5000),
  screenshotTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5000),
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
}) satisfies Schema<Record<string, unknown>, CuaConfig>


function executionAgent(execution: Readonly<ToolExecution>): Agent {
  if (!execution.agent) throw new Error('dsh-cua requires an agent-owned execution')
  return execution.agent
}

interface CuaExecution extends ToolExecution {
  nativeClient: NativeClient
}


/** Prepared platform executable, transport, and platform-specific operating instructions. */
export interface CuaBackend {
  helperPath: string
  createChannel: NativeChannelFactory
  guidance: string
  description: string
}

/**
 * Install authorized CUA calls and Agent-owned native connections.
 * @param ctx - Provider context with computer-use, subprocess, tools, prompt, and Agent services.
 * @param config - Validated resource limits and live application grants.
 * @param backend - Platform-owned executable, connection factory, and instructions.
 */
export function installCua(ctx: Context, config: CuaConfig, backend: CuaBackend): void {
  const { helperPath } = backend
  const native: NativeClientConfig = {
    helperPath, cwd: process.cwd(), timeoutMs: config.timeoutMs, axTimeoutMs: config.axTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs, screenshotTimeoutMs: config.screenshotTimeoutMs,
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
      description: backend.description,
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
            client = new NativeClient(ctx, native, backend.createChannel, (message) => { ctx.logger.debug(message) })
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
      text: () => ctx.get('ptcRuntime')?.programFormat !== 'repl' ? backend.guidance : `${backend.guidance}

Persistent PTC initialization:
var { connectCua } = await import(${JSON.stringify(new URL('../lib/bridge.js', import.meta.url).href)});
var cua = connectCua(() => tools.cua, text => console.log(text));`,
    })
  }, 'dsh-cua.runtime')
}
