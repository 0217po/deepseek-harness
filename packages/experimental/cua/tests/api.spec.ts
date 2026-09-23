/** App and window behavior over a fixture operation dispatcher, without desktop access. */
import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createCuaApi } from '../src/api.ts'
import type { CuaApp, CuaOperation } from '../src/types.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const bounds = { x: -640, y: 100, width: 640, height: 480 }
const selected = { appHandle: 'app-17', pid: 17, name: 'Editor', bundleId: 'test.editor' }
const delivered = { dispatched: true, verified: false }
const capabilities = { platform: 'macos', permissions: { accessibility: true, screenRecording: false }, methods: ['getState', 'click'], coordinateSpace: 'window-points', browser: false }

function windowInfo(windowId: number) {
  return { windowId, pid: 17, appName: 'Editor', title: `Document ${windowId}`, bounds, isOnScreen: true, onCurrentSpace: null }
}

function fixture(withSink = true) {
  let windows = [windowInfo(23)]
  let generation = 0
  const sink = { text: vi.fn<(value: string) => void>(), image: vi.fn<(data: Uint8Array) => void>() }
  const dispatch = vi.fn(async ({ method, params }: CuaOperation): Promise<JsonValue> => {
    switch (method) {
      case 'getCapabilities': return capabilities
      case 'listApps': return [selected, { pid: 18, name: 'Utility' }]
      case 'getApp': return selected
      case 'listWindows': return windows
      case 'getState': return {
        appHandle: selected.appHandle, pid: 17, windowId: params.windowId ?? null,
        snapshotId: `snapshot-${++generation}`, tree: `Tree ${generation}`, truncated: false,
        windows: params.windowId === undefined ? windows : windows.filter(window => window.windowId === params.windowId),
      }
      case 'screenshot': return { mimeType: 'image/png', data: PNG, pixelWidth: 1, pixelHeight: 1, windowId: params.windowId!, bounds, coordinateSpace: 'window-points' }
      default: return delivered
    }
  })
  return {
    dispatch, sink, api: createCuaApi(dispatch, withSink ? sink : undefined),
    setWindows: (ids: number[]) => { windows = ids.map(windowInfo) },
    setWindowRecords: (records: ReturnType<typeof windowInfo>[]) => { windows = records },
  }
}

function state(overrides: Record<string, JsonValue> = {}): JsonValue {
  return { appHandle: selected.appHandle, pid: 17, windowId: null, snapshotId: 'changed', tree: 'Changed tree', windows: [windowInfo(23)], truncated: false, ...overrides }
}

function screenshot(overrides: Record<string, JsonValue> = {}): JsonValue {
  return { mimeType: 'image/png', data: PNG, pixelWidth: 1, pixelHeight: 1, windowId: 23, bounds, coordinateSpace: 'window-points', ...overrides }
}

describe('application discovery', () => {
  it('reports permissions and discovers both bundle and PID selectors without activating an app', async () => {
    const f = fixture()
    expect(await f.api.getCapabilities()).toEqual(capabilities)
    expect(await f.api.getState()).toEqual({ apps: [
      { id: 'test.editor', displayName: 'Editor', isRunning: true, pid: 17 },
      { id: '18', displayName: 'Utility', isRunning: true, pid: 18 },
    ], browsers: [] })
    expect(f.dispatch.mock.calls.map(([operation]) => operation.method)).toEqual(['getCapabilities', 'listApps'])
    const emitted = f.sink.text.mock.calls.map(([text]): unknown => JSON.parse(text))
    expect(emitted).toEqual([capabilities, await f.api.getState({ emit: false })])
    expect(f.sink.text).toHaveBeenCalledTimes(2)
  })

  it('returns observations without requiring an output sink', async () => {
    const f = fixture(false)
    expect(await f.api.getCapabilities({ emit: false })).toEqual(capabilities)
    expect(await f.api.listApps()).toHaveLength(2)
    const app = await f.api.getApp('Editor')
    expect(app.pid).toBe(17)
    expect(app.appHandle).toBe('app-17')
    expect(await app.getWindows()).toEqual([windowInfo(23)])
    expect(await app.getScreenshot()).toEqual(Uint8Array.from(Buffer.from(PNG, 'base64')))
    expect(f.sink.text).not.toHaveBeenCalled()
    expect(f.sink.image).not.toHaveBeenCalled()
  })

  it('rejects malformed discovery and capability results', async () => {
    const f = fixture()
    f.dispatch.mockResolvedValueOnce({ platform: 'macos' })
    await expect(f.api.getCapabilities()).rejects.toThrow()
    f.dispatch.mockResolvedValueOnce([{ pid: 0, name: 'Invalid' }])
    await expect(f.api.listApps()).rejects.toThrow()
    f.dispatch.mockResolvedValueOnce({ ...selected, appHandle: '' })
    await expect(f.api.getApp('Editor')).rejects.toThrow()
    expect(f.sink.text).not.toHaveBeenCalled()
  })
})

describe('application and window observations', () => {
  it('keeps the latest AX index scope separate for an app and each selected window', async () => {
    const f = fixture()
    f.setWindows([23, 24])
    const app = await f.api.getApp('Editor')
    expect(await app.getWindows({ emit: false })).toEqual([windowInfo(23), windowInfo(24)])
    const first = await app.getWindow(23)
    const second = await app.getWindow(24)
    await app.click(0)
    await first.setValue(1, 'First document')
    await second.click(2)
    expect(f.dispatch.mock.calls.slice(-3).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 0 } },
      { method: 'setValue', params: { appHandle: 'app-17', snapshotId: 'snapshot-2', elementIndex: 1, value: 'First document' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-3', elementIndex: 2 } },
    ])
    expect(first.windowId).toBe(23)
    expect(second.windowId).toBe(24)
    expect(f.sink.text.mock.calls.map(([text]) => text)).toEqual(['Tree 1', 'Tree 2', 'Tree 3'])
    await expect(second.getAXState({ emit: false, disableDiffing: true })).resolves.toBe('Tree 4')
    await second.click(3)
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-4', elementIndex: 3 } })
    expect(f.sink.text).toHaveBeenCalledTimes(3)
  })

  it.each([{ ids: [] }, { ids: [23, 24] }])('requires an explicit window when discovery yields $ids', async ({ ids }) => {
    const f = fixture()
    f.setWindows(ids)
    const app = await f.api.getApp('Editor')
    const calls = f.dispatch.mock.calls.length
    await expect(app.click([1, 2])).rejects.toThrow('Select a window')
    await expect(app.getScreenshot()).rejects.toThrow('Select a window')
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it('selects the one visible nonzero window while preserving menu and hidden windows in discovery', async () => {
    const f = fixture()
    const windows = [
      windowInfo(23),
      { ...windowInfo(24), title: 'Menu helper', bounds: { ...bounds, width: 0, height: 0 } },
      { ...windowInfo(25), isOnScreen: false },
      { ...windowInfo(26), bounds: { ...bounds, height: 0 } },
    ]
    f.setWindowRecords(windows)
    const app = await f.api.getApp('Editor')
    expect(await app.getWindows({ emit: false })).toEqual(windows)
    await app.getScreenshot()
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 23 } })
    await app.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
    const hidden = await app.getWindow(25)
    await hidden.click([10, 20])
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'click', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', windowId: 25, x: 10, y: 20, mouseButton: 'left', clickCount: 1,
    } })
  })

  it('requires explicit selection when every window is hidden or has zero size', async () => {
    const f = fixture()
    f.setWindowRecords([
      { ...windowInfo(24), bounds: { ...bounds, width: 0, height: 0 } },
      { ...windowInfo(25), isOnScreen: false },
    ])
    const app = await f.api.getApp('Editor')
    const calls = f.dispatch.mock.calls.length
    await expect(app.getScreenshot()).rejects.toThrow('Select a window')
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it('captures the focused application window when several visible windows exist', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state({ focusedWindowId: 24, windows: [windowInfo(23), windowInfo(24)] }))
    await app.getAXState()
    await app.getScreenshot()
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 24 } })
  })

  it('does not select a focused window absent from the application observation', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state({ focusedWindowId: 99, windows: [windowInfo(23), windowInfo(24)] }))
    await app.getAXState()
    await expect(app.getScreenshot()).rejects.toThrow('Select a window')
  })

  const identityMismatches: Record<string, JsonValue>[] = [
    { appHandle: 'another-app' }, { pid: 18 }, { windowId: 24 },
  ]
  it.each(identityMismatches)('rejects a snapshot belonging to another identity: %j', async (identity) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(state(identity))
    await expect(app.getAXState()).rejects.toThrow('another application or window')
    const calls = f.dispatch.mock.calls.length
    await expect(app.click(0)).rejects.toThrow('Read getAXState')
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it('rejects wrong-process windows in both snapshot and standalone window discovery', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const otherWindow = { ...windowInfo(23), pid: 18 }
    f.dispatch.mockResolvedValueOnce(state({ windows: [otherWindow] }))
    await expect(app.getAXState()).rejects.toThrow('windows belong to another application')
    f.dispatch.mockResolvedValueOnce([otherWindow])
    await expect(app.getWindows()).rejects.toThrow('windows belong to another application')
    expect(f.sink.text).toHaveBeenCalledTimes(1)
  })

  it('clears a failed refresh and obtains new state before a later screenshot', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const failure = new Error('Native app is busy')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.getAXState()).rejects.toBe(failure)
    await expect(app.setValue(0, 'stale')).rejects.toThrow('Read getAXState')
    f.sink.text.mockClear()
    await app.getScreenshot()
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation.method)).toEqual(['getState', 'screenshot'])
    expect(f.sink.text).not.toHaveBeenCalled()
    expect(f.sink.image).toHaveBeenCalledTimes(1)
  })
})

describe('screenshots', () => {
  it('returns PNG pixels independently of input point bounds and supports selective output', async () => {
    const f = fixture()
    f.setWindows([23, 24])
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(24)
    f.sink.text.mockClear()
    const observation = await window.getAXStateAndScreenshot()
    expect(observation.state).toBe('Tree 3')
    expect(observation.screenshot).toEqual(Uint8Array.from(Buffer.from(PNG, 'base64')))
    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'screenshot', params: { appHandle: 'app-17', windowId: 24 } })
    expect(f.sink.text).toHaveBeenCalledWith('Tree 3')
    expect(f.sink.image).toHaveBeenCalledWith(observation.screenshot)
    await window.getAXStateAndScreenshot({ emit: false })
    expect(f.sink.text).toHaveBeenCalledTimes(1)
    expect(f.sink.image).toHaveBeenCalledTimes(1)
  })

  it('rejects a screenshot captured from another window before emitting it', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(screenshot({ windowId: 24 }))
    await expect(app.getScreenshot()).rejects.toThrow('another window')
    expect(f.sink.image).not.toHaveBeenCalled()
  })

  const invalidImages: Record<string, JsonValue>[] = [
    { data: Buffer.from('short').toString('base64') },
    { data: Buffer.alloc(24).toString('base64') },
    { pixelWidth: 2 }, { pixelHeight: 2 },
  ]
  it.each(invalidImages)('rejects invalid PNG dimensions before emitting a screenshot: %j', async (invalid) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    f.dispatch.mockResolvedValueOnce(screenshot(invalid))
    await expect(app.getScreenshot()).rejects.toThrow('invalid PNG dimensions')
    expect(f.sink.image).not.toHaveBeenCalled()
  })
})

describe('input actions', () => {
  it('keeps the selected app and window when scroll options include another target identity', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const window = await app.getWindow(23)
    const options = {
      x: 10, y: 20, deltaLinesX: 0, deltaLinesY: 1,
      appHandle: 'another-app', snapshotId: 'another-snapshot', windowId: 24,
    }

    await window.scroll(options)

    expect(f.dispatch).toHaveBeenLastCalledWith({ method: 'scroll', params: {
      appHandle: 'app-17', snapshotId: 'snapshot-2', windowId: 23, x: 10, y: 20, deltaLinesX: 0, deltaLinesY: 1,
    } })
  })

  it('dispatches window-point gestures and reports delivery without claiming the action succeeded', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    expect(await app.click([10, 20], { mouseButton: 'right' })).toEqual(delivered)
    expect(await app.click([11, 21], { clickCount: 2 })).toEqual(delivered)
    expect(await app.scroll({ x: 10, y: 20, deltaLinesX: -2, deltaLinesY: 3 })).toEqual(delivered)
    expect(await app.drag([1, 2], [30, 40])).toEqual(delivered)
    expect(f.dispatch.mock.calls.slice(-4).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 10, y: 20, mouseButton: 'right', clickCount: 1 } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 11, y: 21, mouseButton: 'left', clickCount: 2 } },
      { method: 'scroll', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, x: 10, y: 20, deltaLinesX: -2, deltaLinesY: 3 } },
      { method: 'drag', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', windowId: 23, fromX: 1, fromY: 2, toX: 30, toY: 40 } },
    ])
  })

  const invalidActions: Array<[string, (app: CuaApp) => Promise<unknown>]> = [
    ['right double click', app => app.click([1, 2], { mouseButton: 'right', clickCount: 2 })],
    ['right AX double click', app => app.click(0, { mouseButton: 'right', clickCount: 2 })],
    ['negative AX index', app => app.click(-1)],
    ['nonfinite coordinate', app => app.click([NaN, 0])],
    ['negative coordinate', app => app.click([-1, 0])],
    ['negative value index', app => app.setValue(-1, 'value')],
    ['zero scroll', app => app.scroll({ x: 0, y: 0, deltaLinesX: 0, deltaLinesY: 0 })],
    ['oversized scroll', app => app.scroll({ x: 0, y: 0, deltaLinesX: 11, deltaLinesY: 0 })],
    ['fractional scroll', app => app.scroll({ x: 0, y: 0, deltaLinesX: 0.5, deltaLinesY: 0 })],
    ['negative drag point', app => app.drag([0, 0], [-1, 3])],
    ['empty chord', app => app.pressKey('')],
    ['missing key', app => app.pressKey('super+')],
    ['unknown modifier', app => app.pressKey('unknown+a')],
  ]
  it.each(invalidActions)('rejects %s without invoking native input', async (_label, run) => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const calls = f.dispatch.mock.calls.length
    await expect(run(app)).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })

  it('passes literal text and keys to the selected app identity', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.typeText('中文\nline two')
    await app.pressKey('Control_L+shift+a')
    await app.pressKey('Return')
    expect(f.dispatch.mock.calls.slice(-3).map(([operation]) => operation)).toEqual([
      { method: 'typeText', params: { appHandle: 'app-17', text: '中文\nline two' } },
      { method: 'pressKey', params: { appHandle: 'app-17', key: 'a', modifiers: ['control', 'shift'] } },
      { method: 'pressKey', params: { appHandle: 'app-17', key: 'Return', modifiers: [] } },
    ])
  })

  it('retains the snapshot identity for indexed right and double clicks', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    await app.click(12, { mouseButton: 'right' })
    await app.click(13, { clickCount: 2 })
    expect(f.dispatch.mock.calls.slice(-2).map(([operation]) => operation)).toEqual([
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 12, mouseButton: 'right' } },
      { method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 13, clickCount: 2 } },
    ])
  })

  it('propagates native failures once and rejects malformed delivery claims', async () => {
    const f = fixture()
    const app = await f.api.getApp('Editor')
    const failure = new Error('Application was restarted; select it again')
    f.dispatch.mockRejectedValueOnce(failure)
    await expect(app.typeText('hello')).rejects.toBe(failure)
    expect(f.dispatch).toHaveBeenCalledTimes(3)
    f.dispatch.mockResolvedValueOnce({ dispatched: true, verified: true })
    await expect(app.click(0)).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(4)
  })

  it('rejects invalid selection inputs before dispatch', async () => {
    const f = fixture()
    await expect(f.api.getApp('')).rejects.toThrow()
    expect(f.dispatch).not.toHaveBeenCalled()
    const app = await f.api.getApp('Editor')
    const calls = f.dispatch.mock.calls.length
    await expect(app.getWindow(0)).rejects.toThrow()
    expect(f.dispatch).toHaveBeenCalledTimes(calls)
  })
})
