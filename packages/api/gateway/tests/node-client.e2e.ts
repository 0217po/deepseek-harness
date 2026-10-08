/** Published Client entries expose ordinary ESM for passive Node compositions. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const built = ['../../client/connection', '../../typert/registry', '.']
  .every(path => existsSync(fileURLToPath(new URL(`${path}/lib/types/client/index.js`, new URL('../', import.meta.url)))))

describe.skipIf(!built)('Node Client package entries', () => {
  it('mounts typed Remotes without a browser or forwarded-event subscription', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { Context } from '@deepseek-ai/cordis'
      import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
      import * as Registry from '@deepseek-ai/dsh-typert-registry/client'
      import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
      import { z } from 'zod'

      if ('window' in globalThis || 'document' in globalThis) throw new Error('smoke requires plain Node')
      const calls = []
      const ctx = new Context()
      try {
        await ctx.plugin(Registry)
        installConnection(ctx, { transport: { rpc: {
          async call(channel, endpoint) {
            calls.push(endpoint)
            return { ok: true, value: 7 }
          },
          async *open(channel, endpoint) {
            calls.push(endpoint)
            yield 8
          },
        } } })
        await ctx.plugin(Gateway)
        const result = { mode: 'strict', typeSymbol: 'nodeProbe#number', create: () => z.number() }
        const common = { service: 'nodeProbe', namespace: 'nodeProbe', invocation: { kind: 'direct' }, parameters: [], result }
        await ctx.remote.$mount({ package: '@fixture/node-probe', descriptors: [
          { ...common, id: 'nodeProbe#read', method: 'read' },
          { ...common, id: 'nodeProbe#follow', method: 'follow', mode: 'stream' },
        ] })
        const read = await ctx.remote.nodeProbe.read()
        const items = []
        for await (const item of ctx.remote.nodeProbe.follow()) items.push(item)
        console.log(JSON.stringify({ read, items, calls, generation: ctx.connection.generation.getSnapshot() ?? null }))
      } finally {
        await ctx.fiber.dispose()
      }
    `], { cwd: packageDirectory, encoding: 'utf8', timeout: 30_000 })
    expect(JSON.parse(stdout.trim())).toEqual({
      read: { ok: true, value: 7 }, items: [8],
      calls: ['nodeProbe/read', 'nodeProbe/follow'], generation: null,
    })
  })
})
