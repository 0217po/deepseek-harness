/** Test-local MCP presentation and result envelopes; no server, transport, or automatic exposure. */

import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { sessionClient, sessionOperations } from './client.ts'

const failureSchema = {
  type: 'object', properties: {
    ok: { const: false },
    error: {
      type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' } },
      required: ['code', 'message', 'details'], additionalProperties: false,
    },
  },
  required: ['ok', 'error'], additionalProperties: false,
}

function withoutDescriptions(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = structuredClone(schema)
  function strip(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) { value.forEach(strip); return }
    const node = value as Record<string, unknown>
    delete node.description
    if (typeof node.properties === 'object' && node.properties !== null) Object.values(node.properties).forEach(strip)
    strip(node.items)
    strip(node.oneOf)
  }
  strip(result)
  return result
}

/**
 * Project generated schemas into MCP envelopes without requiring an output projection.
 * @param input - required local intake schema.
 * @param output - optional generated output JSON Schema, independent of the output parser.
 * @returns detached input fields and an output envelope only when projectable.
 */
export function mcpSchemas(input: Readonly<Record<string, unknown>>, output?: Readonly<Record<string, unknown>>) {
  return {
    inputSchema: { ...withoutDescriptions(input), type: 'object' },
    ...(output === undefined ? {} : { outputSchema: {
      type: 'object', oneOf: [
        { type: 'object', properties: { ok: { const: true }, value: withoutDescriptions(output) }, required: ['ok', 'value'], additionalProperties: false },
        failureSchema,
      ],
    } }),
  }
}

/**
 * Present the explicitly selected finite operation; stream endpoints are not MCP tools.
 * @param operations - offline Registry-backed operation selection.
 * @returns an MCP tools/list entry with detached validation fields.
 */
export function pageTool(operations: ReturnType<typeof sessionOperations>) {
  return {
    name: 'remote_session_page',
    description: 'Read Session or subagent history without starting it. Records are oldest first. Use the opening follow cursor as throughSeq and the first record\'s sequence as beforeSeq to read older history when hasMore is true. maxMessages limits complete messages; turnWindow requests minimum messages and turns within that limit. To target the calling Session, set current: true and omit its target from arguments.request. This requires caller identity from the selected server.',
    ...mcpSchemas(operations.inputSchema('session/page'), operations.method('session/page').result.jsonSchema),
  }
}

/**
 * Run the selected unary operation with CLI-compatible success/failure envelopes.
 * @param client - mounted Session Client whose executor validates intake and output.
 * @param input - untrusted local wrapper supplied by an MCP caller.
 * @param signal - caller-owned cancellation.
 * @returns identical text and structured results, with isError on failures.
 */
export async function callPageTool(client: ReturnType<typeof sessionClient>, input: unknown, signal?: AbortSignal) {
  try {
    const success = { ok: true, value: await client.call('session/page', input, signal) }
    return { content: [{ type: 'text', text: JSON.stringify(success) }], structuredContent: success }
  } catch (error) {
    const remote = remoteErrorOf(error)
    const failure = { ok: false, error: remote !== undefined
      ? { code: remote.code, message: remote.message, details: remote.details }
      : { code: 'session-client/invalid', message: error instanceof Error ? error.message : String(error), details: {} },
    }
    return { content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure, isError: true }
  }
}
