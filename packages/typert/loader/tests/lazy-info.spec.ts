/** Loading a generated contribution must not request its consumer-owned lazy projections. */

import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { validateTypertManifest } from '../src/index.ts'

it('validates invocation facts without materializing parsers or derived tool projections', () => {
  const create = vi.fn(() => z.string())
  const codec = { mode: 'strict' as const, typeSymbol: 'pkg#Text', create, jsonSchema: { type: 'string' } }
  const info = createTypertRemoteInfo({ package: 'pkg', methods: {
    'goals/create': {
      service: 'goals', invocation: { kind: 'direct' },
      parameters: [{ name: 'request', source: 'json', codec }],
      result: { ...codec, description: 'Created goal.' },
    },
  } })
  const method = info.methods['goals/create']!
  const inputSchema = vi.spyOn(method.input, 'jsonSchema', 'get')
  const inputError = vi.spyOn(method.input, 'jsonSchemaError', 'get')
  const outputSchema = vi.spyOn(method.result, 'jsonSchema', 'get')
  const manifest = { package: 'pkg', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: info.descriptors }
  expect(validateTypertManifest('pkg', manifest)).toBe(manifest)
  expect(create).not.toHaveBeenCalled()
  expect(inputSchema).not.toHaveBeenCalled()
  expect(inputError).not.toHaveBeenCalled()
  expect(outputSchema).not.toHaveBeenCalled()
  expect(method.input.jsonSchema).toMatchObject({ properties: { request: { type: 'string' } } })
  expect(method.result.jsonSchema).toEqual({ type: 'string', description: 'Created goal.' })
  expect(method.input.create().parse({ request: 'ship' })).toEqual({ request: 'ship' })
  expect(create).toHaveBeenCalledTimes(1)
})
