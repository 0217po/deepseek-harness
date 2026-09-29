/** JSON validation shared by model tool admission and the native object facade. */
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import type { CuaAppHandle, CuaSnapshotId } from './types.ts'

const id = z.number().int().positive().max(2 ** 32 - 1)
const pid = z.number().int().positive().max(2 ** 31 - 1)
const point = z.number().nonnegative()
const app = { appHandle: z.string().min(1) }
const pointer = { mouseButton: z.enum(['left', 'right', 'middle']).optional(),
  modifiers: z.array(z.enum(['command', 'control', 'option', 'shift', 'fn'])).optional() }
const window = { ...app, windowId: id }
const snapshot = { ...app, snapshotId: z.string().min(1), elementIndex: z.number().int().nonnegative() }
const coordinate = { ...window, snapshotId: z.string().min(1).optional(), x: point, y: point }
const bounds = z.object({
  x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative(),
})
const operation = <M extends string, S extends z.ZodRawShape>(method: M, params: S) => z.object({
  method: z.literal(method), params: z.object(params).strict(),
}).strict()
// Native responses are byte-bounded before parsing. Exact re-encoding also rejects
// whitespace, missing padding and nonzero pad bits without a recursive regex.
const imageBase64 = z.string().min(1).refine(value => Buffer.from(value, 'base64').toString('base64') === value, {
  message: 'Expected canonical base64 image data',
})

/** Model-submittable operation parameters; Host resource fields and private continuations are separate. */
export const Request = z.discriminatedUnion('method', [
  operation('getCapabilities', {}), operation('listApps', {}), operation('findApps', { query: z.string().min(1).regex(/\S/) }),
  operation('getApp', { selector: z.string().min(1) }),
  operation('activate', app),
  operation('listWindows', app),
  operation('getState', { ...app, windowId: id.optional() }),
  z.object({ method: z.literal('click'), params: z.union([
    z.object({ ...snapshot, ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
    z.object({ ...coordinate, ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  ]) }).strict(),
  operation('setValue', { ...snapshot, value: z.string() }),
  operation('selectText', { ...snapshot, text: z.string().min(1), prefix: z.string().optional(), suffix: z.string().optional(),
    selectionType: z.enum(['text', 'cursor_before', 'cursor_after']).optional() }),
  operation('performSecondaryAction', { ...snapshot, action: z.string().min(1) }),
  operation('typeText', { ...app, text: z.string() }),
  operation('paste', { ...app, text: z.string(), format: z.enum(['text', 'html']).optional() }),
  operation('pressKey', { ...app, key: z.string().min(1), modifiers: z.array(z.enum(['command', 'control', 'option', 'shift', 'fn'])).optional() }),
  operation('scroll', { ...coordinate, deltaLinesX: z.number().int().min(-10).max(10), deltaLinesY: z.number().int().min(-10).max(10) }),
  operation('drag', { ...window, ...pointer, snapshotId: z.string().min(1).optional(), fromX: point, fromY: point, toX: point, toY: point }),
  operation('screenshot', window),
])

/** Resource parameters supplied by the Host, never accepted from model tool arguments. */
export const NativeResourceParameters = {
  getState: z.object({ maxElements: z.number().int().min(1).max(10000), maxDepth: z.number().int().min(1).max(100) }).strict(),
  drag: z.object({ durationMs: z.number().int().min(1).max(5000), steps: z.number().int().min(1).max(240) }).strict(),
  paste: z.object({ maxClipboardBytes: z.number().int().min(1024),
    maxElements: z.number().int().min(1).max(10000), maxDepth: z.number().int().min(1).max(100),
  }).strict(),
  findApps: z.object({ maxAppMatches: z.number().int().min(1).max(1000) }).strict(),
}
/** Executor-only continuation after application consent; absent from the model Request union. */
export const NativeOnlyOperations = [operation('launchApp', app)] as const

/** Process identity returned only after a successful app selection. */
export const AppResult = z.object({
  appHandle: z.string().min(1).transform(value => value as CuaAppHandle), pid, name: z.string(), bundleId: z.string().optional(),
})
/** Running application records from the helper. */
export const AppsResult = z.array(z.object({ pid, name: z.string(), bundleId: z.string().optional() }))
/** Installed application matches keep running and stopped records distinct. */
export const FoundAppsResult = z.array(z.intersection(z.object({ id: z.string().min(1), displayName: z.string(), path: z.string().min(1) }),
  z.discriminatedUnion('isRunning', [z.object({ isRunning: z.literal(true), pid }), z.object({ isRunning: z.literal(false) })])))
/** Current windows and their global point bounds. */
export const WindowsResult = z.array(z.object({
  windowId: id, pid, appName: z.string(), title: z.string(), bounds,
  isOnScreen: z.boolean(), onCurrentSpace: z.boolean().nullable(),
}))
/** Observed state with window and process identity for stale-target rejection. */
export const StateResult = z.object({
  appHandle: z.string().min(1).transform(value => value as CuaAppHandle),
  pid, windowId: id.nullable(),
  focusedWindowId: id.nullable().optional(),
  snapshotId: z.string().min(1).transform(value => value as CuaSnapshotId),
  tree: z.string(), windows: WindowsResult, truncated: z.boolean(),
})
/** PNG data and coordinate metadata; pixel dimensions do not define input coordinates. */
export const ScreenshotResult = z.object({
  mimeType: z.literal('image/png'), data: imageBase64, pixelWidth: id, pixelHeight: id, windowId: id,
  bounds: bounds.extend({ width: z.number().positive(), height: z.number().positive() }), coordinateSpace: z.literal('window-points'),
})
/** Permissions are reported without opening system permission dialogs. */
export const CapabilitiesResult = z.object({
  platform: z.string(), permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }),
  sessionLocked: z.boolean().nullable(),
  methods: z.array(z.string()), coordinateSpace: z.literal('window-points'), browser: z.literal(false),
})
/** An action has reached native dispatch; application state was not verified. */
export const ActionResult = z.object({ dispatched: z.literal(true), verified: z.literal(false) })
