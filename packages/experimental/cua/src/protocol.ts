/** JSON validation shared by model tool admission and the native object facade. */
import { z } from 'zod'
import type { CuaAppHandle, CuaSnapshotId } from './types.ts'

const id = z.number().int().positive()
const point = z.number().nonnegative()
const app = { appHandle: z.string().min(1) }
const window = { ...app, windowId: id }
const snapshot = { ...app, snapshotId: z.string().min(1), elementIndex: z.number().int().nonnegative() }
const coordinate = { ...window, snapshotId: z.string().min(1).optional(), x: point, y: point }
const bounds = z.object({
  x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative(),
})
const operation = <M extends string, S extends z.ZodRawShape>(method: M, params: S) => z.object({
  method: z.literal(method), params: z.object(params).strict(),
}).strict()

/** Complete native request schema; resource bounds are supplied by the host. */
export const Request = z.discriminatedUnion('method', [
  operation('getCapabilities', {}), operation('listApps', {}),
  operation('getApp', { selector: z.string().min(1) }),
  operation('listWindows', app),
  operation('getState', { ...app, windowId: id.optional() }),
  z.object({ method: z.literal('click'), params: z.union([
    z.object({ ...snapshot, mouseButton: z.enum(['left', 'right']).optional(), clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
    z.object({ ...coordinate, mouseButton: z.enum(['left', 'right']).optional(), clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  ]) }).strict(),
  operation('setValue', { ...snapshot, value: z.string() }),
  operation('typeText', { ...app, text: z.string() }),
  operation('pressKey', { ...app, key: z.string().min(1), modifiers: z.array(z.enum(['command', 'control', 'option', 'shift', 'fn'])).optional() }),
  operation('scroll', { ...coordinate, deltaLinesX: z.number().int().min(-10).max(10), deltaLinesY: z.number().int().min(-10).max(10) }),
  operation('drag', { ...window, snapshotId: z.string().min(1).optional(), fromX: point, fromY: point, toX: point, toY: point }),
  operation('screenshot', window),
])

/** Process identity returned only after a successful app selection. */
export const AppResult = z.object({
  appHandle: z.string().min(1).transform(value => value as CuaAppHandle), pid: id, name: z.string(), bundleId: z.string().optional(),
})
/** Running application records from the helper. */
export const AppsResult = z.array(z.object({ pid: id, name: z.string(), bundleId: z.string().optional() }))
/** Current windows and their global point bounds. */
export const WindowsResult = z.array(z.object({
  windowId: id, pid: id, appName: z.string(), title: z.string(), bounds,
  isOnScreen: z.boolean(), onCurrentSpace: z.boolean().nullable(),
}))
/** Observed state with window and process identity for stale-target rejection. */
export const StateResult = z.object({
  appHandle: z.string().min(1).transform(value => value as CuaAppHandle),
  pid: id, windowId: id.nullable(),
  focusedWindowId: id.nullable().optional(),
  snapshotId: z.string().min(1).transform(value => value as CuaSnapshotId),
  tree: z.string(), windows: WindowsResult, truncated: z.boolean(),
})
/** PNG data and coordinate metadata; pixel dimensions do not define input coordinates. */
export const ScreenshotResult = z.object({
  mimeType: z.literal('image/png'), data: z.base64().min(1), pixelWidth: id, pixelHeight: id, windowId: id,
  bounds: bounds.extend({ width: z.number().positive(), height: z.number().positive() }), coordinateSpace: z.literal('window-points'),
})
/** Permissions are reported without opening system permission dialogs. */
export const CapabilitiesResult = z.object({
  platform: z.string(), permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }),
  methods: z.array(z.string()), coordinateSpace: z.literal('window-points'), browser: z.literal(false),
})
/** An action has reached native dispatch; application state was not verified. */
export const ActionResult = z.object({ dispatched: z.literal(true), verified: z.literal(false) })
