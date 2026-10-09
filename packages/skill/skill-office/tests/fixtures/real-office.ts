/** Shared model configuration and usage reporting for real Office workflows. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { estimateMessage, estimateToolsTokens } from '../../../../llm/token-meter/src/estimate.ts'

/** @returns Model provider patches for the configured development or official API. */
export function officeModelPatches() {
  const model = process.env.MODEL_NAME ?? 'deepseek-flash'
  const completions = process.env.DSH_OFFICE_TEST_API === 'openai-completions'
  return [
    ...completions ? [
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { 'office-test': {
        api: 'openai-completions', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: process.env.DEEPSEEK_BASE_URL,
        compat: { thinkingFormat: 'deepseek' },
        models: [{ id: model, contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] }],
      } } } },
    ] : [{ id: 'llm-deepseek', config: { thinking: 'enabled', reasoningEffort: 'high', maxTokens: 8192,
      models: [{ id: model, contextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'] }],
    } }],
    { id: 'agent-default-model', config: { provider: completions ? 'office-test' : 'deepseek-official', model } },
  ]
}

/**
 * Write character estimates and server usage separately when a report directory is configured.
 * @param events - Completed recorded session.
 * @param name - Scenario report filename without extension.
 * @returns Resolves after the optional report is written.
 */
export async function reportOfficeUsage(events: SessionEvent[], name: string): Promise<void> {
  const root = process.env.DSH_OFFICE_USAGE_REPORT
  if (root === undefined) return
  const requests = events.flatMap((event, index) => {
    if (event.type !== 'assistant/message') return []
    const prefix = events.slice(0, index)
    const session = Session.create(SessionId('office-usage'), prefix)
    const messages = session.deriveMessages()
    const header = prefix.findLast(row => row.type === 'request/header')
    return [{ step: event.data.step, serverUsage: event.data.usage,
      estimatedRequestTokens: messages.reduce((total, message) => total + estimateMessage(message), 0)
        + estimateToolsTokens(header?.type === 'request/header' ? header.data.header : undefined),
      loadedSkills: [...new Set(messages.flatMap(message => message.content.flatMap(block => block.type === 'text'
        ? [...block.text.matchAll(/<skill_content name="([^"]+)">/g)].map(match => match[1]) : [])))],
    }]
  })
  await mkdir(root, { recursive: true })
  await writeFile(join(root, `${name}.json`), JSON.stringify(requests, null, 2) + '\n')
}

/**
 * Assert that a non-rendering task has received no rendering commands or detailed guidance.
 * @param events - Recorded task events, including nested skill and shell results.
 */
export function expectNoRenderContext(events: SessionEvent[]): void {
  const messages = Session.create(SessionId('office-context'), events).deriveMessages()
  expect(JSON.stringify(messages)).not.toMatch(/imageRendering|maxPixels|fragment rectangles|render --input|--output-dir|uniformly blank/)
}
