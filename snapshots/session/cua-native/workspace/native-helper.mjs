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
const axlessWindow = { ...window, windowId: 8, title: 'AXless canvas' }
const snapshots = new Map()
const methods = ['getCapabilities', 'listApps', 'getApp', 'activate', 'listWindows', 'getState', 'click', 'setValue', 'typeText', 'pressKey', 'scroll', 'drag', 'screenshot']
let acquired = false
let generation = 0
let count = 0
let value = ''
let observationChanged = false
let visualCount = 0
let frontPid = 42
let frontWindowId = 99
function refuse(code, message) { throw Object.assign(new Error(message), { code }) }
function call(requestId, method, params) {
  record('call', { requestId, method, params })
  if (method === 'getCapabilities') return { platform: 'macos', sessionLocked: false, permissions: { accessibility: true, screenRecording: true }, methods, coordinateSpace: 'window-points', browser: false }
  if (method === 'listApps') return [{ pid: app.pid, name: app.name, bundleId: app.bundleId }]
  if (method === 'getApp') {
    if (!['Fixture', 'test.fixture', '9'].includes(params.selector)) refuse('APP_NOT_FOUND', 'Select the running Fixture application')
    acquired = true
    return app
  }
  if (!acquired || params.appHandle !== app.appHandle) refuse('APP_NOT_FOUND', 'Acquire an application in this helper first')
  if (method === 'activate') {
    const before = { frontPid, focusedWindowId: window.windowId, frontWindowId, frontWindowPid: frontPid }
    const activationRequested = frontPid !== app.pid
    if (activationRequested) {
      frontPid = app.pid
      frontWindowId = window.windowId
    }
    const after = { frontPid, focusedWindowId: window.windowId, frontWindowId, frontWindowPid: frontPid }
    return { dispatched: true, verified: false, foreground: {
      requestId, operation: 'activate', targetPid: app.pid, targetWindowId: null,
      before, after, activationRequested, raiseRequested: false,
    } }
  }
  if (method === 'listWindows') return [window, axlessWindow]
  if (method === 'getState') {
    snapshots.delete(params.windowId ?? null)
    if (observationChanged) {
      observationChanged = false
      refuse('STALE_SNAPSHOT', 'Accessibility tree changed during observation; read fresh getAXState')
    }
    generation++
    const axless = params.windowId === 8
    const snapshotId = `fixture-snapshot-${generation}`
    snapshots.set(params.windowId ?? null, { snapshotId, windowId: params.windowId ?? null, axless })
    if (axless) return { appHandle: app.appHandle, pid: 9, windowId: 8, snapshotId,
      tree: '', elements: [], windows: [axlessWindow], truncated: false }
    return { appHandle: app.appHandle, pid: 9, windowId: params.windowId ?? null,
      snapshotId: `fixture-snapshot-${generation}`, tree: `0 AXButton Increment\n1 AXTextField value: ${value}\n2 AXStaticText Count: ${count}`,
      elements: [{ index: 0, role: 'AXButton', title: 'Increment', bounds: { x: 60, y: 80, width: 100, height: 20 } }], windows: [window], truncated: false }
  }
  if (method === 'screenshot') return { windowId: params.windowId, mimeType: 'image/png', data: png, pixelWidth: 1, pixelHeight: 1, bounds, coordinateSpace: 'window-points' }
  if (method === 'click' || method === 'setValue') {
    const observed = [...snapshots.values()].find(snapshot => snapshot.snapshotId === params.snapshotId)
    if (!observed) refuse('STALE_SNAPSHOT', 'Read fresh state before acting')
    if (params.windowId !== undefined && observed.windowId !== null && observed.windowId !== params.windowId) refuse('STALE_SNAPSHOT', 'Snapshot belongs to another window')
    if (observed.axless && params.elementIndex !== undefined) refuse('INVALID_ARGUMENT', 'Element index is absent from the selected snapshot')
    if (method === 'click' && params.windowId === 8) visualCount++
    else if (method === 'click') count++
    else value = params.value
    record('state', { count, value, visualCount })
    return { dispatched: true, verified: false }
  }
  if (method === 'pressKey' && params.key === 'Return') observationChanged = true
  if (method === 'typeText') value += params.text
  else if (!['pressKey', 'scroll', 'drag'].includes(method)) refuse('UNSUPPORTED_OPERATION', method)
  return { dispatched: true, verified: false }
}
const input = createInterface({ input: process.stdin })
input.once('close', () => process.exit(0))
input.on('line', (line) => {
  const request = JSON.parse(line)
  let response
  try { response = { id: request.id, result: call(request.id, request.method, request.params) } }
  catch (error) { response = { id: request.id, error: { code: error.code ?? 'FIXTURE_ERROR', message: error.message } } }
  process.stdout.write(JSON.stringify(response) + '\n')
})
