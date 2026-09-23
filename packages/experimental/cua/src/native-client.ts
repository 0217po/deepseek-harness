/** Bounded JSON-line transport to one owned native helper process. */
import { randomUUID } from 'node:crypto'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'

const Reply = z.union([
  z.object({ id: z.string(), result: z.json() }).strict(),
  z.object({ id: z.string(), error: z.object({ code: z.string().min(1), message: z.string() }).strict() }).strict(),
])

/** Native refusal or transport failure with a stable machine-readable code. */
export class NativeError extends Error {
  /**
   * @param code - Native error code or a transport-owned NATIVE_* code.
   * @param message - Actionable diagnostic, without its code prefix.
   * @param options - Original failure when available.
   */
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'NativeError'
  }
}

/** Resolved helper executable and bounded process/response configuration. */
export interface NativeClientConfig {
  helperPath: string
  cwd: string
  timeoutMs: number
  maxRequestBytes: number
  maxResponseBytes: number
  graceMs: number
}

/** Serial helper calls retain native handles until helper disposal or replacement. */
export class NativeClient {
  private readonly handle: SubprocessHandle
  private readonly config: NativeClientConfig
  private tail = Buffer.alloc(0)
  private failure: NativeError | undefined
  private disposal: Promise<void> | undefined
  private active: { id: string; resolve: (value: JsonValue) => void; reject: (error: NativeError) => void } | undefined

  constructor(owner: { subprocess: Pick<SubprocessRuntime, 'spawn'> }, config: NativeClientConfig) {
    this.config = config
    this.handle = owner.subprocess.spawn({
      argv: [config.helperPath], cwd: config.cwd, graceMs: config.graceMs,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8192 } },
    })
    this.handle.stdout?.on('data', (chunk: Buffer) => { this.receive(chunk) })
    this.handle.stdout?.on('error', (error: Error) => { this.fail(new NativeError('NATIVE_IO', 'Helper stdout failed', { cause: error })) })
    this.handle.stdout?.on('end', () => { this.fail(new NativeError('NATIVE_EOF', 'Helper output ended; acquire fresh application handles')) })
    this.handle.stdout?.on('close', () => { this.fail(new NativeError('NATIVE_EOF', 'Helper output closed; acquire fresh application handles')) })
    this.handle.stdin?.on('error', (error: Error) => { this.fail(new NativeError('NATIVE_IO', 'Helper stdin failed', { cause: error })) })
    void this.handle.done.then(
      () => { this.fail(new NativeError('NATIVE_EXITED', 'Helper exited; acquire fresh application handles')) },
      (error: unknown) => { this.fail(new NativeError('NATIVE_EXITED', 'Helper process failed', { cause: error })) },
    )
  }

  /**
   * Send one operation. Native refusals preserve the helper; transport failures invalidate it.
   * @param method - Helper operation name.
   * @param params - JSON operation parameters.
   * @param signal - Cancellation kills this helper and invalidates its retained handles.
   * @returns The validated helper result, after failure cleanup when needed.
   */
  async request(method: string, params: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue> {
    if (signal.aborted) throw new NativeError('NATIVE_CANCELLED', 'Operation was cancelled before dispatch')
    if (this.disposed) {
      await this.dispose()
      throw new NativeError('NATIVE_CLOSED', 'Helper is closed; acquire fresh application handles', { cause: this.failure })
    }
    if (this.active) throw new NativeError('NATIVE_BUSY', 'Await native operations sequentially')
    const id = randomUUID()
    const frame = `${JSON.stringify({ id, method, params })}\n`
    if (Buffer.byteLength(frame) > this.config.maxRequestBytes) {
      throw new NativeError('NATIVE_REQUEST_LIMIT', 'Request exceeded the configured byte limit before dispatch')
    }
    const outcome = Promise.withResolvers<JsonValue>()
    this.active = { id, ...outcome }
    const abort = (): void => { this.fail(new NativeError('NATIVE_CANCELLED', 'Operation cancelled; inspect fresh state before retrying input')) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      this.fail(new NativeError('NATIVE_TIMEOUT', `Operation exceeded ${this.config.timeoutMs}ms`))
    }, this.config.timeoutMs)
    try {
      if (!this.handle.stdin || !this.handle.stdout) {
        this.fail(new NativeError('NATIVE_IO', 'Helper did not expose the requested protocol pipes'))
      } else {
        try {
          this.handle.stdin.write(frame, (error) => {
            if (error) this.fail(new NativeError('NATIVE_IO', 'Writing a helper request failed', { cause: error }))
          })
        } catch (error) {
          this.fail(new NativeError('NATIVE_IO', 'Writing a helper request failed', { cause: error }))
        }
      }
      const result = await outcome.promise
      if (this.failure) throw this.failure
      return result
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (this.failure !== undefined) await this.dispose()
    }
  }

  /** Whether this helper has lost its retained native state. */
  get disposed(): boolean { return this.failure !== undefined }

  /** Stop pending work and await the entire managed process range before releasing streams. */
  dispose(): Promise<void> {
    this.fail(new NativeError('NATIVE_DISPOSED', 'Helper disposed'))
    this.disposal ??= (async () => {
      try {
        const [, range] = await Promise.allSettled([this.handle.done, this.handle.waitForExit()])
        if (range.status === 'rejected') throw range.reason
      } finally {
        this.handle.stdout?.destroy()
        this.handle.stdin?.destroy()
      }
    })()
    return this.disposal
  }

  private fail(error: NativeError): void {
    if (this.failure) return
    this.failure = error
    this.tail = Buffer.alloc(0)
    this.active?.reject(error)
    this.active = undefined
    this.handle.terminate()
  }

  private receive(chunk: Buffer): void {
    if (this.failure) return
    if (this.tail.length + chunk.length > this.config.maxResponseBytes) {
      this.fail(new NativeError('NATIVE_RESPONSE_LIMIT', 'Helper response exceeded the configured byte limit'))
      return
    }
    this.tail = Buffer.concat([this.tail, chunk])
    const newline = this.tail.indexOf(10)
    if (newline < 0) return
    try {
      if (newline !== this.tail.length - 1) throw new Error('One request must produce exactly one response frame')
      const line = new TextDecoder('utf-8', { fatal: true }).decode(this.tail.subarray(0, newline))
      const reply = Reply.parse(JSON.parse(line))
      const active = this.active
      if (!active || reply.id !== active.id) throw new Error('Helper reply has no matching request')
      this.tail = Buffer.alloc(0)
      this.active = undefined
      if ('error' in reply) active.reject(new NativeError(reply.error.code, reply.error.message))
      else active.resolve(reply.result)
    } catch (error) {
      this.fail(new NativeError('NATIVE_PROTOCOL', 'Helper returned an invalid response; acquire fresh application handles', { cause: error }))
    }
  }
}
