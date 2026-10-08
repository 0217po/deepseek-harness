/** Agent-owned PTC resources across calls, temporary approvals, and permission changes. */
import { symbols } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-permission-presets'

interface OwnerState {
  providers: Map<PtcRuntime, Set<object>>
  controllers: Set<AbortController>
  changing: boolean
}

/** Keeps admission closed until permission changes and resource disposal settle. */
export class PtcOwners {
  private readonly agents = new WeakMap<Agent, OwnerState>()

  /**
   * Reserve one execution before approval or directory resolution can yield.
   * @param agent - Calling Agent, if the program has a durable conversation.
   * @param runtime - Runtime receiving the program.
   * @param signal - Cancellation of this tool call.
   * @param temporary - Whether approval applies only to this execution.
   * @param policy - Read the Agent's current standing file policy.
   * @returns Owner and cancellation signal, with an awaited per-call cleanup.
   */
  enter(
    agent: Agent | undefined, runtime: PtcRuntime, signal: AbortSignal, temporary: boolean,
    policy: () => SandboxExecutionPolicy | undefined,
  ) {
    if (agent === undefined) {
      return { owner: undefined, signal, finish: async () => {} }
    }
    let state = this.agents.get(agent)
    if (state === undefined) {
      state = { providers: new Map(), controllers: new Set(), changing: false }
      this.agents.set(agent, state)
      const owned = state
      const clear = async (): Promise<void> => {
        for (const controller of owned.controllers) controller.abort(new Error('PTC environment cleared for a permission change or Agent disposal'))
        const results = await Promise.allSettled([...owned.providers].flatMap(([provider, owners]) =>
          [...owners].map(owner => provider.release(owner))))
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        owned.providers.clear()
      }
      agent.ctx.effect(() => async () => { owned.changing = true; await clear() }, 'PTC retained environments')
      agent.ctx.on('permission-presets/apply', async (session, mode, next) => {
        if (session !== agent.session || policy()?.mode === mode) return next()
        if (owned.changing) throw new Error('PTC environment cleanup is still in progress')
        owned.changing = true
        const retained = [...owned.providers.keys()].some(provider => provider.retainsState)
        try {
          await clear()
          const notices = await next()
          return retained ? [...notices, 'PTC variables were cleared after the sandbox mode changed. Recreate variables before using them.'] : notices
        } finally { owned.changing = false }
      }, { global: true })
      agent.ctx.on('internal/dispatch', (_mode, name, args) => {
        if (name !== 'session/event') return
        const [session, event] = args as [Session, SessionEvent]
        if (session !== agent.session || event.type !== 'sandbox/mode' || event.data.mode === policy()?.mode) return
        if ([...owned.providers.keys()].some(provider => provider.retainsState)) {
          throw new Error('release retained PTC environments before changing the sandbox mode; use the permission preset setter')
        }
      }, { global: true })
    }
    if (state.changing) throw new Error('PTC cannot start while its permission or lifecycle cleanup is in progress')
    let provider = runtime
    for (;;) {
      const original = (provider as PtcRuntime & { [symbols.original]?: PtcRuntime })[symbols.original]
      if (original === undefined) break
      provider = original
    }
    const owner = temporary ? {} : agent
    let owners = state.providers.get(provider)
    if (owners === undefined) state.providers.set(provider, owners = new Set())
    owners.add(owner)
    const controller = new AbortController()
    state.controllers.add(controller)
    return {
      owner,
      signal: AbortSignal.any([signal, controller.signal]),
      finish: async (): Promise<void> => {
        try {
          if (temporary) {
            await provider.release(owner)
            owners.delete(owner)
            if (owners.size === 0 && state.providers.get(provider) === owners) state.providers.delete(provider)
          }
        } finally { state.controllers.delete(controller) }
      },
    }
  }
}
