/** Test-local extraction of Session Client selection, intake projection, and invocation. */

import { z } from 'zod'
import type { TypertClientRemote, TypertRemoteRegistry } from '@deepseek-ai/dsh-typert-protocol'
import { isTypertRemoteMethod } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Only explicitly selected endpoints become local operations. */
export const selectedEndpoints = ['session/page', 'session/follow'] as const
/** Statically known endpoint names; Registry lookup itself remains runtime-typed. */
export type Endpoint = typeof selectedEndpoints[number]
/** The ordinary generated artifact retains exact named arguments for known callers. */
export type PageArguments = Parameters<typeof TYPERT_REMOTE.methods['session/page']['invoke']>[1]
/** Successful output comes from the generated parser rather than a duplicate declaration. */
export type PageOutput = ReturnType<ReturnType<typeof TYPERT_REMOTE.methods['session/page']['result']['create']>['parse']>

/** Local wrapper retained from Session Client; neither selected operation accepts content. */
export interface LocalRemoteInput<Arguments = unknown> {
  readonly arguments: Arguments
  readonly current?: true
  readonly content?: readonly unknown[]
}

const intake = z.strictObject({
  arguments: z.record(z.string(), z.unknown()),
  current: z.literal(true).optional(),
})

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Selected Session operation requires an object schema')
  }
  return value as Record<string, unknown>
}

/**
 * Select documented operations from the caller's offline Registry without mounting a transport.
 * @param registry - Registry whose contribution lifetime belongs to the caller.
 * @returns local operation lookup, schema projection, and validated preparation.
 */
export function sessionOperations(registry: TypertRemoteRegistry) {
  function method(endpoint: Endpoint) {
    if (!selectedEndpoints.some(selected => selected === endpoint)) throw new Error(`Unselected Session endpoint: ${endpoint}`)
    const descriptor = registry.get(endpoint)
    if (descriptor === undefined || !isTypertRemoteMethod(descriptor)) throw new Error(`Missing generated method for ${endpoint}`)
    if (!descriptor.description || !descriptor.parameters.find(parameter => parameter.wire === 'request')?.description) {
      throw new Error(`Selected tool ${endpoint} requires method and request documentation`)
    }
    const input = descriptor.input({ strict: true })
    if (input.jsonSchema === undefined) {
      throw new Error(`Selected tool ${endpoint} requires an input JSON Schema: ${input.jsonSchemaError ?? 'unavailable'}`)
    }
    return descriptor
  }

  function inputSchema(endpoint: Endpoint): Readonly<Record<string, unknown>> {
    const schema = method(endpoint).input({ strict: true }).jsonSchema
    const branches = [false, true].map((current) => {
      const argumentsSchema = structuredClone(object(schema))
      if (current) {
        const request = object(object(argumentsSchema.properties).request)
        const properties = object(request.properties)
        request.properties = Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'address'))
        request.additionalProperties = false
        request.required = z.array(z.string()).parse(request.required).filter(key => key !== 'address')
      }
      return {
        type: 'object',
        properties: {
          arguments: argumentsSchema,
          ...(current ? { current: { type: 'boolean', const: true } } : {}),
        },
        required: ['arguments', ...(current ? ['current'] : [])],
        additionalProperties: false,
      }
    })
    return { oneOf: branches }
  }

  function prepare(endpoint: Endpoint, input: unknown, callerSessionId?: SessionId): object {
    if (typeof input === 'object' && input !== null && 'content' in input) {
      throw new TypeError(`${endpoint} does not accept local content`)
    }
    const parsed = intake.parse(input)
    z.fromJSONSchema(inputSchema(endpoint)).parse(parsed)
    const args = structuredClone(parsed.arguments)
    if (parsed.current === true) {
      if (!callerSessionId) throw new Error('current requires caller Session identity')
      args.request = { ...object(args.request), address: { kind: 'session', sessionId: callerSessionId } }
    }
    return method(endpoint).input({ strict: true }).create().parse(args)
  }

  return { method, inputSchema, prepare, list: () => selectedEndpoints.map(endpoint => ({ endpoint, method: method(endpoint) })) }
}

/**
 * Invoke through an already-mounted ordinary Remote; own neither its Context nor discovery.
 * @param operations - offline selection and intake projection.
 * @param remote - caller-owned mounted Gateway Client.
 * @param callerSessionId - optional identity used only by the current convenience.
 * @returns unary calls and complete, cancellable stream handles.
 */
export function sessionClient(
  operations: ReturnType<typeof sessionOperations>,
  remote: TypertClientRemote,
  callerSessionId?: SessionId,
) {
  return {
    async call(endpoint: Endpoint, input: unknown, signal?: AbortSignal): Promise<unknown> {
      const method = operations.method(endpoint)
      if (method.mode === 'stream') throw new Error(`${endpoint} requires stream()`)
      const result = await method.invoke(remote, operations.prepare(endpoint, input, callerSessionId), signal)
      if (!result.ok) throw result.error
      return method.result.create().parse(result.value)
    },
    stream(endpoint: Endpoint, input: unknown, signal?: AbortSignal) {
      const method = operations.method(endpoint)
      if (method.mode !== 'stream') throw new Error(`${endpoint} requires call()`)
      // Gateway validates each item; preserve the full handle, including send/end/dispose.
      return method.invoke(remote, operations.prepare(endpoint, input, callerSessionId), signal)
    },
  }
}
