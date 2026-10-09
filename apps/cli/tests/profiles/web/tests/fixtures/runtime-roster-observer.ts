/** Test-only IPC observer mounted beside the unchanged default Web composition. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { runtimeRoster } from '../runtime-roster.ts'

/** Services whose live state the observer reads. */
export const inject = ['loader', 'clientModules']

/**
 * Observe the shipped process and optionally mount the real negative-control plugin dynamically.
 * @param ctx - context in the real Loader tree.
 * @param config - absolute module URL used only by the explicit negative-control command.
 */
export function apply(ctx: Context, config: { negativeControl: string }): void {
  if (process.send === undefined) throw new Error('Runtime roster observer requires an IPC channel')
  const receive = (message: unknown): void => {
    if (message === 'stop') {
      process.emit('SIGTERM')
      return
    }
    if (message !== 'roster' && message !== 'mount-experimental' && message !== 'mount-experimental-entry' && message !== 'office-catalog' && message !== 'office-dependencies' && message !== 'office-render') return
    void (async () => {
      if (message === 'mount-experimental') {
        const namespace: unknown = await import(config.negativeControl)
        await ctx.plugin(ctx.loader.unwrapExports(namespace))
      }
      if (message === 'mount-experimental-entry') await ctx.loader.create({ name: config.negativeControl })
      await ctx.loader.await()
      const roster = runtimeRoster(ctx)
      if (message === 'office-render') {
        const shell = ctx.get('shell'), shellEnv = ctx.get('shellEnv')
        if (shell === undefined || shellEnv === undefined) throw new Error('Office shell unavailable')
        roster.officeShell = []
        for (const command of ['dsoffice render --input input.docx --output-dir rendered --pages 1',
          'dsoffice convert --input input.docx --output converted.pdf']) {
          const execution: ToolExecution = { name: 'pwsh', arguments: { command }, token: Symbol('office-smoke') as ToolExecution['token'],
            callId: 'office-smoke' as ToolCallId, rootCallId: 'office-smoke' as ToolCallId, signal: new AbortController().signal }
          const result = await (await shell.execute(shell.resolve({ command, workdir: process.cwd(), timeoutMs: 60_000,
            dshEnv: shellEnv.collect(execution), sandboxPolicy: { mode: 'workspace-write', workspaceRoot: process.cwd() },
          }))).result()
          roster.officeShell.push({ exitCode: result.exitCode, timedOut: result.timedOut,
            ...(result.sandbox === undefined ? {} : { sandboxMode: result.sandbox.mode }), stderr: result.stderr.text })
          if (result.exitCode !== 0 || result.timedOut) break
        }
      }
      if (message === 'office-catalog' || message === 'office-dependencies') {
        const skills = ctx.get('skills'), tools = ctx.get('tools'), agents = ctx.get('agents'), presets = ctx.get('agentPresets')
        if (skills === undefined || tools === undefined || agents === undefined || presets === undefined) {
          throw new Error('Office registries unavailable')
        }
        const handle = await agents.create({
          sessionId: `office-${message}` as SessionId,
          meta: { agentPreset: 'standard' },
          setup: agentCtx => presets.mount(agentCtx, 'standard').then(() => undefined),
        })
        try {
          if (message === 'office-catalog') {
            roster.office = {
              names: (await skills.list({ scope: handle.agent })).filter(skill => skill.modelCatalogVisibility !== 'unlisted').map(skill => skill.name),
              tools: tools.schemas(handle.agent).map(tool => tool.name),
              instructions: (await skills.get('office-docx', { scope: handle.agent }))?.content ?? '',
            }
          } else {
            const result = await tools.execute({ name: 'load_workspace_dependencies', callId: 'office-runtime' as ToolCallId,
              arguments: {}, signal: new AbortController().signal, agent: handle.agent })
            const value = result.value
            roster.dependencies = { isError: result.isError,
              ...(value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.python === 'string' ? { python: value.python } : {}) }
          }
        } finally { await handle.dispose() }
      }
      process.send!({ command: message, roster })
    })().catch((error: unknown) => {
      process.send!({ command: message, error: error instanceof Error ? error.stack : String(error) })
    })
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => { process.off('message', receive) }
  })
}
