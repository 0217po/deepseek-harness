#!/usr/bin/env node
/** Deterministic JSONL native substitute; this fixture never reads or controls the desktop. */
import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const observe = existsSync(new URL('./observe-helper', import.meta.url))
const record = (event, data = {}) => {
  if (observe) appendFileSync(new URL('./helper-events.jsonl', import.meta.url), JSON.stringify({ event, pid: process.pid, ...data }) + '\n')
}
record('start')
process.once('exit', () => record('exit'))
process.once('SIGTERM', () => process.exit(0))
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const app = { appHandle: 'fixture-app', pid: 9, name: 'Fixture', bundleId: 'test.fixture' }
const bounds = { x: 40, y: 60, width: 320, height: 200 }
const window = { windowId: 7, pid: 9, appName: 'Fixture', title: 'CUA fixture', bounds, isOnScreen: true, onCurrentSpace: true }
const methods = ['getCapabilities', 'listApps', 'getApp', 'listWindows', 'getState', 'click', 'setValue', 'typeText', 'pressKey', 'scroll', 'drag', 'screenshot']
let acquired = false
let generation = 0
let count = 0
let value = ''
function refuse(code, message) { throw Object.assign(new Error(message), { code }) }
function call(method, params) {
  record('call', { method, params })
  if (method === 'getCapabilities') return { platform: 'macos', permissions: { accessibility: true, screenRecording: true }, methods, coordinateSpace: 'window-points', browser: false }
  if (method === 'listApps') return [{ pid: app.pid, name: app.name, bundleId: app.bundleId }]
  if (method === 'getApp') {
    if (!['Fixture', 'test.fixture', '9'].includes(params.selector)) refuse('APP_NOT_FOUND', 'Select the running Fixture application')
    acquired = true
    return app
  }
  if (!acquired || params.appHandle !== app.appHandle) refuse('APP_NOT_FOUND', 'Acquire an application in this helper first')
  if (method === 'listWindows') return [window]
  if (method === 'getState') {
    generation++
    return { appHandle: app.appHandle, pid: 9, windowId: params.windowId ?? null,
      snapshotId: `fixture-snapshot-${generation}`, tree: `0 AXButton Increment\n1 AXTextField value: ${value}\n2 AXStaticText Count: ${count}`,
      elements: [{ index: 0, role: 'AXButton', title: 'Increment', bounds: { x: 60, y: 80, width: 100, height: 20 } }], windows: [window], truncated: false }
  }
  if (method === 'screenshot') return { windowId: 7, mimeType: 'image/png', data: png, pixelWidth: 1, pixelHeight: 1, bounds, coordinateSpace: 'window-points' }
  if (method === 'click' || method === 'setValue') {
    if (params.snapshotId !== `fixture-snapshot-${generation}`) refuse('STALE_SNAPSHOT', 'Read fresh state before acting')
    if (method === 'click') count++
    else value = params.value
    record('state', { count, value })
    return { dispatched: true, verified: false }
  }
  if (method === 'typeText') value += params.text
  else if (!['pressKey', 'scroll', 'drag'].includes(method)) refuse('UNSUPPORTED_OPERATION', method)
  return { dispatched: true, verified: false }
}
const input = createInterface({ input: process.stdin })
input.once('close', () => process.exit(0))
input.on('line', (line) => {
  const request = JSON.parse(line)
  let response
  try { response = { id: request.id, result: call(request.method, request.params) } }
  catch (error) { response = { id: request.id, error: { code: error.code ?? 'FIXTURE_ERROR', message: error.message } } }
  process.stdout.write(JSON.stringify(response) + '\n')
})
