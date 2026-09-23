/** Optional, unsandboxed Node REPL provider with memory scoped to caller-owned objects. */
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunSpec, PtcRunResult, PtcRunFailure, PtcBindingNamespace, PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import { MAX_TIMER_DELAY_MS, clampTimeout } from '@deepseek-ai/dsh-timeout'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { NodePtcRuntime, type Config } from './index.ts'
import { validateBindings } from './bindings.ts'
import { JsonChannel } from './channel.ts'
import { bootstrapArgs } from './launch.ts'
import { STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from './json-wire.ts'
import { OutputLedger } from './output-ledger.ts'
import { drainOutput } from './output-stream.ts'
import type { ProgramBootData } from './protocol.ts'

export type { Config } from './index.ts'
type ResolvedConfig = Required<Omit<Config, 'bootstrapPath'>> & Pick<Config, 'bootstrapPath'>
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

interface Evaluation {
  id: number
  data: ProgramBootData
  spec: PtcRunSpec
  bindings: Map<string, PtcBindingNamespace>
  pending: number
  pendingBytes: number
  admit(text: string): void
  finish(error?: PtcRunFailure, value?: PtcJsonValue, discard?: boolean): void
}

/** One managed process; all mutable program state belongs to this process alone. */
class Kernel {
  private handle?: SubprocessHandle
  private channel?: JsonChannel
  private active: Evaluation | undefined
  private ready = false
  private sequence = 0
  private nextCall = 1
  private stopped?: Promise<void>
  private starting?: Promise<void>
  private readonly controller = new AbortController()
  closed = false

  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {}

  async run(spec: PtcRunSpec, bindings: Map<string, PtcBindingNamespace>, code: string): Promise<PtcRunResult> {
    if (this.active) throw new Error('persistent PTC does not accept concurrent runs for one state owner')
    const output = new OutputLedger(this.config.maxOutputBytes)
    const logs: string[] = []
    const result = Promise.withResolvers<PtcRunResult>()
    let settled = false
    const timer = spec.timeoutMs === null ? undefined : setTimeout(() => {
      evaluation.finish({ kind: 'timeout', message: `execution deadline reached (${spec.timeoutMs}ms); retained variables were cleared` }, undefined, true)
    }, spec.timeoutMs)
    const onAbort = (): void => { evaluation.finish({ kind: 'abort', message: 'execution canceled; retained variables were cleared' }, undefined, true) }
    const evaluation: Evaluation = {
      id: ++this.sequence,
      data: { code, maxOutputBytes: this.config.maxOutputBytes, namespaces: [...bindings.values()].map(binding => ({
        global: binding.global, names: Object.keys(binding.functions), ...binding.errorClass ? { errorClass: binding.errorClass } : {},
      })) },
      spec, bindings, pending: 0, pendingBytes: 0,
      admit: (text) => {
        if (!output.admit(text, logs)) {
          logs.push(text)
          evaluation.finish({ kind: 'output-limit', message: 'output limit exceeded' }, undefined, true)
        }
      },
      finish: (error, value, discard = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        spec.signal?.removeEventListener('abort', onAbort)
        this.active = undefined
        const outcome = error?.kind === 'output-limit' ? output.limit(logs)
          : error ? output.failure(logs, error) : output.success(logs, value)
        const cleanup = discard || spec.stateOwner === undefined ? this.stop() : Promise.resolve()
        void cleanup.then(() => result.resolve(outcome), (failure: unknown) => {
          result.resolve(output.failure(logs, { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(failure)}` }))
        })
      },
    }
    this.active = evaluation
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    if (spec.signal?.aborted) onAbort()
    else if (this.ready) this.dispatch(evaluation)
    else {
      this.starting = this.start(spec.cwd)
      void this.starting.catch((error: unknown) => this.fail('worker-exit', messageOf(error)))
    }
    return await result.promise
  }

  async dispose(): Promise<void> {
    this.active?.finish({ kind: 'abort', message: 'PTC environment disposed; retained variables were cleared' }, undefined, true)
    await this.stop()
  }

  private stop(): Promise<void> {
    if (this.stopped) return this.stopped
    this.closed = true
    this.controller.abort()
    this.channel?.close()
    this.stopped = (async () => {
      await this.starting?.catch(() => {})
      const handle = this.handle
      if (!handle) return
      try {
        handle.terminate()
        await Promise.all([handle.done.catch(() => {}), handle.waitForExit()])
        const drained = await Promise.all([
          drainOutput(handle.stdout, this.config.graceMs), drainOutput(handle.stderr, this.config.graceMs),
        ])
        if (drained.includes(false)) throw new Error('persistent Node process output did not close cleanly')
      } finally { handle.stdout?.destroy(); handle.stderr?.destroy() }
    })()
    return this.stopped
  }

  private fail(kind: PtcRunFailure['kind'], message: string): void {
    if (this.active) this.active.finish({ kind, message: `${message}; retained variables were cleared` }, undefined, true)
    else void this.stop().catch((error: unknown) => { this.ctx.logger.warn(messageOf(error)) })
  }

  private dispatch(evaluation: Evaluation): void {
    void this.channel?.send({ type: 'run', id: evaluation.id, cwd: evaluation.spec.cwd, data: evaluation.data })
      .catch((error: unknown) => this.fail('protocol', messageOf(error)))
  }

  private async start(cwd: string): Promise<void> {
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.nodeExecutable, undefined, this.controller.signal)
    if (this.closed) return
    const argv = [executable, `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`, ...bootstrapArgs(this.ctx.fs, this.config, this.config.maxMessageBytes, true)]
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env)
      .filter(key => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')
      .map(key => [key, undefined]))
    const handle = this.ctx.subprocess.spawn({ argv, cwd, env, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' }, graceMs: this.config.graceMs })
    this.handle = handle
    if (!handle.control || !handle.stdout || !handle.stderr) throw new Error('subprocess provider did not supply persistent PTC pipes')
    for (const stream of [handle.stdout, handle.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (text: string) => { this.active?.admit(text) })
      stream.on('error', (error: Error) => this.fail('worker-exit', error.message))
    }
    this.channel = new JsonChannel(handle.control, this.config.maxMessageBytes, (raw, bytes) => this.receive(raw, bytes), (error, kind) => {
      if (!this.closed) this.fail(kind === 'protocol' ? 'protocol' : 'worker-exit', error.message)
    })
    void handle.done.then((outcome) => {
      setImmediate(() => { if (!this.closed) this.fail('worker-exit', `persistent Node process exited (${String(outcome.exitCode)})`) })
    }, (error: unknown) => this.fail('worker-exit', messageOf(error)))
  }

  private receive(raw: unknown, bytes: number): void {
    if (this.closed) return
    if (!record(raw)) { this.fail('protocol', 'invalid persistent PTC frame'); return }
    if (!this.ready) {
      if (raw.type !== 'ready') { this.fail('protocol', 'expected persistent PTC readiness'); return }
      this.ready = true
      if (this.active) this.dispatch(this.active)
      return
    }
    const evaluation = this.active
    if (!evaluation || raw.id !== evaluation.id || !record(raw.payload)) { this.fail('protocol', 'frame does not belong to the active PTC evaluation'); return }
    const payload = raw.payload
    switch (payload.type) {
      case 'log':
        if (typeof payload.text === 'string') evaluation.admit(payload.text)
        else this.fail('protocol', 'invalid persistent PTC log')
        return
      case 'output-limit': evaluation.finish({ kind: 'output-limit', message: 'output limit exceeded' }, undefined, true); return
      case 'done': {
        if (payload.error !== undefined) {
          const error = payload.error
          if (!record(error) || typeof error.message !== 'string' || (error.kind !== 'exception' && error.kind !== 'invalid-output' && error.kind !== 'output-limit')) {
            this.fail('protocol', 'invalid persistent PTC failure'); return
          }
          evaluation.finish({ kind: error.kind, message: error.message }, undefined, error.kind === 'output-limit')
        } else {
          const value = payload.value === undefined ? undefined : decodePtcJsonWire(payload.value)
          evaluation.finish(payload.value !== undefined && value === undefined ? { kind: 'invalid-output', message: 'program completion must be lossless JSON' } : undefined, value)
        }
        return
      }
      case 'call': {
        if (payload.id !== this.nextCall || typeof payload.global !== 'string' || typeof payload.name !== 'string') { this.fail('protocol', 'invalid persistent PTC binding identity'); return }
        this.nextCall += 1
        const args = decodePtcJsonWire(payload.args)
        if (args === undefined) { this.fail('protocol', 'binding arguments must be lossless JSON'); return }
        if (++evaluation.pending > this.config.maxPendingCalls || (evaluation.pendingBytes += bytes) > this.config.maxMessageBytes) {
          this.fail('protocol', 'pending binding calls exceed configured limits'); return
        }
        const functions = evaluation.bindings.get(payload.global)?.functions
        const fn = functions && Object.hasOwn(functions, payload.name) ? functions[payload.name] : undefined
        const id = payload.id
        void (async () => {
          let reply: unknown
          try {
            if (!fn) throw new Error('binding is unavailable in this evaluation; reacquire the current tool')
            const value = snapshotJsonValue(await fn(args))
            if (value === undefined) throw new Error('binding resolution must be lossless JSON')
            reply = { type: 'reply', id, ok: true, value: encodePtcJsonWire(value) }
          } catch (error: unknown) {
            reply = { type: 'reply', id, ok: false, message: messageOf(error) }
          } finally { evaluation.pending -= 1; evaluation.pendingBytes -= bytes }
          if (this.active === evaluation) await this.channel?.send(reply)
        })().catch((error: unknown) => this.fail('protocol', messageOf(error)))
        return
      }
      default: this.fail('protocol', 'unknown persistent PTC message')
    }
  }
}

/** Unsandboxed, best-effort retained state; restart, disposal, and interrupted execution clear it. */
export class PersistentNodePtcRuntime extends PtcRuntime {
  static inject = ['fs', 'subprocess']
  static Config = NodePtcRuntime.Config
  readonly language = 'typescript'
  readonly isolation = 'process'
  override get programFormat(): 'repl' { return 'repl' }
  override get executionInstructions(): string {
    return 'Variables, functions, and imported modules remain in memory for this Agent across calls. Use await import(...) for modules. This environment has full host access without a file sandbox; process.env starts empty. Restart, Agent disposal, cancellation, timeout, or process failure clears the environment. If a variable is undefined, recreate it and reacquire its resources. State is not restored from the conversation, and failed evaluations can leave earlier mutations in memory. Await all tool calls; background callbacks cannot call tools after their evaluation ends.'
  }
  override get timeout(): { defaultMs: number; maxMs: number } {
    return { defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs), maxMs: this.config.maxTimeoutMs }
  }
  private readonly config: ResolvedConfig
  private readonly owners = new WeakMap<object, Kernel>()
  private readonly kernels = new Set<Kernel>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = { ...config, nodeExecutable: config.nodeExecutable ?? process.execPath } as ResolvedConfig
    for (const [name, value] of Object.entries(this.config)) {
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`persistent PTC: ${name} must be a positive safe integer`)
    }
    if (this.config.maxOutputBytes < 4 || this.config.maxMessageBytes > 0xffff_ffff) throw new Error('persistent PTC: invalid output or frame limit')
    if ([this.config.timeoutMs, this.config.maxTimeoutMs, this.config.graceMs].some(value => value > MAX_TIMER_DELAY_MS)) throw new Error('persistent PTC: timeout exceeds the supported timer range')
    if (!this.config.nodeExecutable || (this.config.bootstrapPath !== undefined && !isAbsolute(this.config.bootstrapPath))) throw new Error('persistent PTC: invalid executable or bootstrap path')
    ctx.effect(() => async () => {
      this.disposed = true
      await Promise.all([...this.kernels].map(kernel => kernel.dispose()))
      this.kernels.clear()
    }, 'Persistent PTC environments')
  }

  /**
   * Resolve full-access REPL execution without accepting a sandbox policy.
   * @param request - Program, bindings, owner, directory and elapsed budget.
   * @returns Resolved request; explicit confinement requests fail before execution.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    if (this.disposed) throw new Error('persistent PTC: resolve after disposal')
    if (request.sandboxPolicy !== undefined) throw new Error('persistent PTC does not support sandbox policies')
    const cwd = request.cwd ?? process.cwd()
    if (!isAbsolute(cwd)) throw new Error('persistent PTC: cwd must be absolute')
    return { ...request, cwd, timeoutMs: request.timeoutMs === null ? null : clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, 'persistent PTC timeoutMs') }
  }

  /**
   * Evaluate statements using this owner's process, or a temporary process without an owner.
   * @param spec - Resolved request; concurrent calls for one owner are rejected.
   * @returns Logs, a final JSON expression, or a structured execution failure.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (this.disposed) throw new Error('persistent PTC: run after disposal')
    if (spec.sandboxPolicy !== undefined || !isAbsolute(spec.cwd) || (spec.timeoutMs !== null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs))) throw new Error('persistent PTC: run requires resolved inputs without a sandbox policy')
    const bindings = validateBindings(spec)
    let code: string
    try { code = stripTypeScriptTypes(spec.program) } catch (error: unknown) { return { logs: [], error: { kind: 'exception', message: messageOf(error) } } }
    let kernel = spec.stateOwner === undefined ? undefined : this.owners.get(spec.stateOwner)
    if (!kernel || kernel.closed) {
      if (kernel) this.kernels.delete(kernel)
      kernel = new Kernel(this.ctx, this.config)
      this.kernels.add(kernel)
      if (spec.stateOwner) this.owners.set(spec.stateOwner, kernel)
    }
    try { return await kernel.run(spec, bindings, code) } finally {
      if (spec.stateOwner === undefined) this.kernels.delete(kernel)
    }
  }

  override async release(owner: object): Promise<void> {
    const kernel = this.owners.get(owner)
    if (!kernel) return
    this.owners.delete(owner)
    await kernel.dispose()
    this.kernels.delete(kernel)
  }
}

export default PersistentNodePtcRuntime
