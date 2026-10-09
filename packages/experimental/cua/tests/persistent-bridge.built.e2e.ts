/** Built bridge imports and retained objects from a project outside the Harness installation. */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { LlmAdapter, ToolCallId, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'
import * as Cua from '../src/index.ts'
import { installNativeFixture } from './native-fixture.ts'
import { Request } from '../src/protocol.ts'

const bridge = fileURLToPath(new URL('../lib/bridge.js', import.meta.url))
const bootstrap = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json'))), 'lib/persistent-process.js')

class VisualAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  stream(): AsyncIterable<StreamChunk> { throw new Error('This bridge integration does not request model generation') }
}

// This lane runs after build; the fixture helper uses a POSIX shebang and never accesses the desktop.
it.skipIf(process.platform === 'win32' || !existsSync(bridge) || !existsSync(bootstrap))(
  'imports the installation-owned bridge outside the repository and retains objects with current bindings', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-cua-external-project-'))
    const ctx = new Context()
    try {
      const helperPath = await installNativeFixture(cwd)
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(FileSystem)
      await ctx.plugin(Subprocess)
      await ctx.plugin(LocalAttachmentStore, { dshHome: join(cwd, 'home') })
      await ctx.plugin(ComputerUseRegistry)
      await ctx.plugin(Sandbox)
      await ctx.plugin(SandboxPolicy)
      await ctx.plugin(NodeRuntime, { executionMode: 'persistent-in-memory', bootstrapPath: bootstrap })
      await ctx.plugin(Loader)
      ctx.loader.builtins.cua = Cua
      const entry = await ctx.loader.create({ name: 'cordis:cua', config: { helperPath, allowedApps: [{ 'id': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'name': 'Fixture', 'executablePath': '/fixture/app' }] } })
      await ctx.loader.resolve(entry).fiber!.await()
      await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['bridge-fixture'], new VisualAdapter())
      const handle = await ctx.agents.create({ sessionId: SessionId('external-cua-project'), agentOptions: { provider: 'bridge-fixture', model: 'vision' } })
      let count = 0
      let images = 0
      const calls: Array<{ phase: string; method: string }> = []
      const run = (program: string, phase: string) => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
        cwd, program, stateOwner: handle.agent,
        bindings: [{ global: 'tools', functions: { cua: async (args) => {
          const operation = Request.parse(args)
          calls.push({ phase, method: operation.method })
          const result = await ctx.tools.execute({ agent: handle.agent, signal: new AbortController().signal,
            callId: ToolCallId(`external-cua-${++count}`), name: 'cua', arguments: operation })
          images += result.content.filter(block => block.type === 'image').length
          return result.value ?? null
        } } }],
      }))
      expect((await run('await import("@deepseek-ai/dsh-cua/bridge")', 'unresolved')).error?.message).toContain('Cannot find package')
      const section = (await ctx.systemPrompt.assemble()).sections.find(value => value.name === 'computer-use:dsh-cua')
      const initialization = section?.text.split('Persistent PTC initialization:\n')[1]
      expect(initialization).toContain('/lib/bridge.js')
      const first = await run(`${initialization}\nvar app = await cua.getApp("test.fixture"); var win = await app.getWindow(7); await win.click(0); void await win.getScreenshot();`, 'first')
      expect(first.error).toBeUndefined()
      expect(images).toBe(1)
      expect(JSON.stringify(first)).not.toContain('iVBORw0KGgo')
      const second = await run('await win.getAXState({emit:false}); await win.click(0); await win.getAXState({emit:false});', 'second')
      expect(second.error).toBeUndefined()
      expect(second.value).toContain('Count: 2')
      expect(calls.filter(call => call.phase === 'second').map(call => call.method)).toEqual(['getState', 'click', 'getState'])
    } finally {
      try { await ctx.fiber.dispose() } finally { await rm(cwd, { recursive: true, force: true }) }
    }
  },
)
