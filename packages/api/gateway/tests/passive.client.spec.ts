/** Passive generated Remotes and explicit forwarded-event participation over Node carriers. */

import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { z } from 'zod'
import {
  installConnection, type ConnectionHandle, type ConnectionWebSocketFactory, type RpcFetch,
} from '@deepseek-ai/dsh-client-connection/client'
import * as TypertRegistry from '@deepseek-ai/dsh-typert-registry/client'
import type { RemoteResult, TypertRemoteContribution, TypertRemoteNamespace } from '@deepseek-ai/dsh-typert-protocol'
import { apply, Config, inject, isRemoteFailure } from '../src/client/index.ts'
import { GATEWAY_CLIENT_CONFIG_GLOBAL, parseRemoteStreamClientMessage, type RemoteStreamClientMessage } from '../src/stream-protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only forwarded Host event used to probe passive subscription refusal.
     * @param value - marker payload never delivered.
     */
    'passive-probe/changed'(value: string): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<'passive-probe/changed', true> {}
  interface TypertRemoteMap {
    'passiveProbe/echo': (value: string) => Promise<RemoteResult<string>>
    'passiveProbe/follow': (signal?: AbortSignal) => AsyncIterable<string>
  }
  interface TypertRemoteNamespaceMap {
    passiveProbe: TypertRemoteNamespace<'passiveProbe'>
  }
}

const contexts: Context[] = []
const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(cleanup.splice(0).map(dispose => dispose()))
  vi.unstubAllGlobals()
})

function contribution(): TypertRemoteContribution {
  const codec = { mode: 'strict' as const, typeSymbol: 'passiveProbe#text', create: () => z.string() }
  return {
    package: '@fixture/passive-probe',
    descriptors: [
      {
        id: 'passiveProbe#echo', namespace: 'passiveProbe', service: 'passiveProbe', method: 'echo',
        invocation: { kind: 'direct' },
        parameters: [{ name: 'value', wire: 'value', source: 'json', codec }],
        result: codec,
      },
      {
        id: 'passiveProbe#follow', namespace: 'passiveProbe', service: 'passiveProbe', method: 'follow',
        mode: 'stream', invocation: { kind: 'direct' }, parameters: [],
        cancellation: { parameter: 'signal' }, result: codec,
      },
    ],
  }
}

async function host() {
  const requests: { readonly url: string | undefined; readonly cookie: string | undefined }[] = []
  const frames: RemoteStreamClientMessage[] = []
  const upgrades: (string | undefined)[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      requests.push({ url: request.url, cookie: request.headers.cookie })
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        readonly rpcId: string
        readonly payload: { readonly args: { readonly value: string } }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        type: 'server-response', rpcId: body.rpcId,
        result: { ok: true, value: body.payload.args.value },
      }))
    })
  })
  const sockets = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    upgrades.push(request.headers.cookie)
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.on('message', (data) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
        const frame = parseRemoteStreamClientMessage(bytes.toString('utf8'))
        frames.push(frame)
        if (frame.type !== 'open') return
        client.send(JSON.stringify({
          type: 'item', streamId: frame.streamId,
          value: frame.endpoint === '$events'
            ? { type: 'ready', clientId: 'fixture-events', host: { home: '/fixture/home' } }
            : 'opening',
        }))
      })
    })
  })
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      sockets.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP address')
  return { origin: `http://127.0.0.1:${address.port}`, requests, frames, upgrades, sockets }
}

async function client(origin: string, doFetch?: RpcFetch, forwardedEvents: boolean | 'unconfigured' | 'page' = 'unconfigured') {
  const ctx = new Context()
  contexts.push(ctx)
  const cookie = 'session=fixture'
  const webSocket: ConnectionWebSocketFactory = url => new WebSocket(url, { headers: { cookie } })
  await ctx.plugin(TypertRegistry)
  installConnection(ctx, {
    transport: {
      streamBaseUrl: origin,
      webSocket,
      fetch: doFetch ?? ((input, init) => fetch(new URL(input, origin), {
        ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
      })),
    },
  })
  if (forwardedEvents === 'page') vi.stubGlobal(GATEWAY_CLIENT_CONFIG_GLOBAL, { forwardedEvents: true })
  const gateway = typeof forwardedEvents === 'boolean'
    ? ctx.plugin({ inject, apply, Config }, { forwardedEvents })
    : ctx.plugin({ inject, apply, Config })
  await gateway
  const unmount = await ctx.remote.$mount(contribution())
  return { ctx, gateway, unmount, connection: ctx.get('connection') as ConnectionHandle }
}

describe('passive Remote composition', () => {
  it.each(['contribution', 'gateway', 'context'] as const)('aborts and joins a pending response body when its %s closes', async (owner) => {
    const reading = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx, gateway, unmount } = await client('http://127.0.0.1:1', async (_input, init) => {
      const signal = init.signal
      if (signal === undefined || signal === null) throw new Error('Remote request has no cancellation signal')
      signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          reading.resolve(undefined)
          await release.promise
          controller.error(new Error('response body stopped'))
        },
      }, { highWaterMark: 0 }))
    })
    const retained = ctx.remote.passiveProbe.echo
    const invocation = retained('pending body')
    await reading.promise
    let disposed = false
    const disposal = (owner === 'contribution' ? unmount() : owner === 'gateway' ? gateway.dispose() : ctx.fiber.dispose())
      .then(() => { disposed = true })
    try {
      expect(await Promise.race([aborted.promise.then(() => true), disposal.then(() => false)])).toBe(true)
      // The next event-loop turn observes disposal after its ready microtasks, while the body owner remains held.
      await setImmediate()
      expect(disposed).toBe(false)
    } finally {
      release.resolve(undefined)
      await disposal
    }
    const outcome = await invocation
    expect(outcome).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    if (!outcome.ok) expect(isRemoteFailure(outcome.error)).toBe(true)
    expect(await retained('after disposal')).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
  })

  it('calls generated methods and cancels a stream without joining forwarded events', async () => {
    const server = await host()
    const { ctx, unmount, connection } = await client(server.origin)
    expect(server.requests).toEqual([])
    expect(server.upgrades).toEqual([])
    expect(connection.generation.getSnapshot()).toBeUndefined()

    await expect(ctx.remote.passiveProbe.echo('typed value')).resolves.toEqual({ ok: true, value: 'typed value' })
    expect(server.requests).toEqual([{ url: '/api/passiveProbe/echo', cookie: 'session=fixture' }])
    expect(server.upgrades).toEqual([])

    const stream = ctx.remote.passiveProbe.follow()[Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toEqual({ done: false, value: 'opening' })
    const waiting = stream.next()
    const aborted = expect(waiting).rejects.toThrow()
    await unmount()
    await aborted
    await expect.poll(() => server.frames.filter(frame => frame.type === 'cancel')).toHaveLength(1)
    expect(server.frames.filter(frame => frame.type === 'open').map(frame => frame.endpoint))
      .toEqual(['passiveProbe/follow'])
    expect(server.upgrades).toEqual(['session=fixture'])
    expect(connection.generation.getSnapshot()).toBeUndefined()

    await ctx.fiber.dispose()
    await expect.poll(() => server.sockets.clients.size).toBe(0)
  })

  it('stays passive unless forwarded events are explicitly configured', async () => {
    const server = await host()
    const opened = () => server.frames.filter(frame => frame.type === 'open').map(frame => frame.endpoint)
    const passive = [await client(server.origin), await client(server.origin, undefined, false)]
    for (const { ctx, connection } of passive) {
      await expect(ctx.remote.passiveProbe.echo('passive')).resolves.toEqual({ ok: true, value: 'passive' })
      expect(connection.generation.getSnapshot()).toBeUndefined()
      expect(() => ctx.remote.$on('passive-probe/changed', () => {})).toThrow('needs forwardedEvents')
      expect(() => ctx.remote.$stream({ name: 'fixture stream', open: () => ctx.remote.passiveProbe.follow() }))
        .toThrow('needs forwardedEvents')
    }
    expect(opened()).toEqual([])

    const configured = await client(server.origin, undefined, true)
    await expect.poll(() => configured.connection.generation.getSnapshot()?.host.home).toBe('/fixture/home')
    expect(opened()).toEqual(['$events'])
    await expect(configured.ctx.remote.passiveProbe.echo('joined')).resolves.toEqual({ ok: true, value: 'joined' })
    expect(() => configured.ctx.remote.$on('passive-probe/changed', () => {})).not.toThrow()

    // A browser page reads the choice its Host Gateway row published.
    const page = await client(server.origin, undefined, 'page')
    await expect.poll(() => page.connection.generation.getSnapshot()?.host.home).toBe('/fixture/home')
    expect(opened()).toEqual(['$events', '$events'])

    const overridden = await client(server.origin, undefined, false)
    await expect(overridden.ctx.remote.passiveProbe.echo('passive page')).resolves.toEqual({ ok: true, value: 'passive page' })
    expect(overridden.connection.generation.getSnapshot()).toBeUndefined()
    expect(opened()).toEqual(['$events', '$events'])

    for (const { ctx } of [overridden, page, configured, ...passive]) await ctx.fiber.dispose()
    await expect.poll(() => server.sockets.clients.size).toBe(0)
  })
})
