/** Model-authored operation JSON cannot supply host configuration or bypass retained identities. */
import { expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Request, ScreenshotResult } from '../src/protocol.ts'

const rejectedRequests: Array<{ reason: string; request: JsonValue }> = [
  { reason: 'raw process ID instead of a selected app handle', request: { method: 'typeText', params: { pid: 17, text: 'hello' } } },
  { reason: 'unknown native method', request: { method: 'shutdown', params: {} } },
  { reason: 'host-owned traversal limit', request: { method: 'getState', params: { appHandle: 'app', maxElements: 1000000 } } },
  { reason: 'extra tool argument', request: { method: 'listApps', params: {}, helperPath: '/untrusted/helper' } },
  { reason: 'element click without an observed snapshot', request: { method: 'click', params: { appHandle: 'app', elementIndex: 0 } } },
  { reason: 'coordinate click without a window', request: { method: 'click', params: { appHandle: 'app', x: 1, y: 2 } } },
  { reason: 'mixed element and coordinate click', request: { method: 'click', params: { appHandle: 'app', snapshotId: 'snapshot', elementIndex: 0, windowId: 23, x: 1, y: 2 } } },
  { reason: 'unsupported modifier', request: { method: 'pressKey', params: { appHandle: 'app', key: 'a', modifiers: ['hyper'] } } },
]

it.each(rejectedRequests)('rejects $reason at operation admission', ({ request }) => {
  expect(Request.safeParse(request).success).toBe(false)
})

it('rejects malformed screenshot encoding before decoding bytes', () => {
  expect(ScreenshotResult.safeParse({
    mimeType: 'image/png', data: 'not base64!', pixelWidth: 1, pixelHeight: 1, windowId: 23,
    bounds: { x: 0, y: 0, width: 10, height: 10 }, coordinateSpace: 'window-points',
  }).success).toBe(false)
})
