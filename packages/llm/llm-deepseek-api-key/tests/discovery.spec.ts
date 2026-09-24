/** The official catalog is offered only while its API key resolves. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as ApiKey from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
})

/** Mount the official route with `key` as its launch-environment credential. */
async function official(key: string): Promise<Context> {
  vi.stubEnv('DEEPSEEK_API_KEY', key)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ApiKey, {})
  return ctx
}

it('offers no models while the API key is missing', async () => {
  const ctx = await official('')
  expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
})

it('advertises the configured models once the API key resolves', async () => {
  const ctx = await official('sk-fixture')
  expect(await ctx.llm.listModels('deepseek-official')).toEqual(expect.arrayContaining([
    expect.objectContaining({ provider: 'deepseek-official', id: 'deepseek-flash' }),
  ]))
})

it('reports a malformed API key instead of advertising an empty catalog', async () => {
  const ctx = await official('invalid\nheader')
  await expect(ctx.llm.listModels('deepseek-official')).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
})
