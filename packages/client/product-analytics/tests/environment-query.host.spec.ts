import { expect, it } from 'vitest'
import { queryEnvironment } from '../src/environment-query.ts'

const options = () => ({ timeoutMillis: 5000, maxOutputBytes: 16384, signal: new AbortController().signal })

// These Node snippets are metadata-command stand-ins, with no Cordis or application boot.
it('captures UTF-8 output and closes the child before returning', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', "process.stdout.write('CPU 型号')"], options()))
    .toEqual({ kind: 'value', stdout: 'CPU 型号' })
})

it('omits nonzero command output and raw error text', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', "console.error('private error'); console.log('private output'); process.exitCode = 1"], options()))
    .toEqual({ kind: 'missing', reason: 'query-failed' })
})

it('settles a failed spawn without retaining an output buffer or child', async () => {
  expect(await queryEnvironment(`${process.execPath}-nonexistent`, [], options()))
    .toEqual({ kind: 'missing', reason: 'query-failed' })
})

it('terminates a timed-out query and awaits close', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options(), timeoutMillis: 20 }))
    .toEqual({ kind: 'missing', reason: 'timeout' })
})

it('bounds multibyte stdout without treating truncated metadata as valid', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', "process.stdout.write('界'.repeat(10000))"], { ...options(), maxOutputBytes: 128 }))
    .toEqual({ kind: 'missing', reason: 'output-limit' })
})

it('bounds stderr even when stdout could describe valid metadata', async () => {
  expect(await queryEnvironment(process.execPath, ['-e', "process.stderr.write('x'.repeat(10000))"], { ...options(), maxOutputBytes: 128 }))
    .toEqual({ kind: 'missing', reason: 'output-limit' })
})

it('aborts an in-flight query and waits for child closure', async () => {
  const lifetime = new AbortController()
  const result = queryEnvironment(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options(), signal: lifetime.signal })
  lifetime.abort()
  expect(await result).toEqual({ kind: 'missing', reason: 'query-failed' })
})
