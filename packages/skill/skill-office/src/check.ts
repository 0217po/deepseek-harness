/** Private launcher for the packaged OOXML checker and shared interpreter preparation. */
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { Config, resolveWorkspaceDependencies } from '@deepseek-ai/dsh-tool-workspace-dependencies'

/**
 * Run the checker with a prepared Python interpreter, preserving its output and exit status.
 * @param args - Absolute checker path, base64url runtime JSON, then checker arguments.
 */
export async function runOfficeCheck(args: string[]): Promise<void> {
  const [checker, serialized, ...forwarded] = args
  if (checker === undefined || !isAbsolute(checker) || serialized === undefined) throw new Error('office-check: missing launcher resources')
  const value: unknown = JSON.parse(Buffer.from(serialized, 'base64url').toString('utf8'))
  const config = z.resolve(value, Config, {})[0] as Config
  const controller = new AbortController()
  const abort = () => { controller.abort(new Error('Office check cancelled')) }
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    const runtime = await resolveWorkspaceDependencies(config, controller.signal)
    controller.signal.throwIfAborted()
    const child = spawn(runtime.python, [checker, ...forwarded], { stdio: 'inherit', signal: controller.signal })
    process.exitCode = await new Promise<number>((resolve, reject) => {
      let failure: Error | undefined
      child.once('error', (error) => { failure = error })
      child.once('close', (code) => { if (failure === undefined) resolve(code ?? 1); else reject(failure) })
    })
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}

// Worker image modules compile to CommonJS, which cannot contain top-level await.
/* v8 ignore next -- commands.built.e2e.ts invokes this entry as the main built Node program. */
if (import.meta.main) {
  void runOfficeCheck(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
