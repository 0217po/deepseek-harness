/** Plain-Node artifact integration: offline consumer, real Session history, HTTP, and WebSocket. */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import WebSocket from 'ws'
import Registry from '@deepseek-ai/dsh-typert-registry'
import * as connectionHost from '@deepseek-ai/dsh-client-connection'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { TYPERT } from '@deepseek-ai/dsh-api-session-controller/typert'
import { sessionOperations, sessionClient } from './client.js'
import { pageTool, callPageTool, mcpSchemas } from './mcp.js'

// Search is outside this fixture; point observations and history windows use the real engine.
class PointQuery extends SessionQueryEngine {
  searchSessions() { throw new Error('Search is not selected') }
  searchEvents() { throw new Error('Search is not selected') }
}

const offline = new Context()
const host = new Context()
const client = new Context()
const routes = []
const upgrades = []
const records = new Map()
const counters = { http: 0, sockets: 0, uploads: 0 }
const nativeFetch = globalThis.fetch
const nativeWebSocket = globalThis.WebSocket
let server
try {
  for (const name of ['window', 'document', 'location']) assert.equal(name in globalThis, false)
  globalThis.fetch = () => { throw new Error('Offline metadata attempted network access') }
  globalThis.WebSocket = class { constructor() { throw new Error('Offline metadata opened a socket') } }
  const [registryClient, { installConnection }, gatewayClient, { TYPERT_REMOTE }] = await Promise.all([
    import('@deepseek-ai/dsh-typert-registry/client'),
    import('@deepseek-ai/dsh-client-connection/client'),
    import('@deepseek-ai/dsh-api-gateway/client'),
    import('@deepseek-ai/dsh-api-session-controller/remote'),
  ])
  await offline.plugin(registryClient)
  const offlineOwner = offline.plugin({
    inject: ['typert'],
    apply(ctx) { ctx.effect(() => ctx.typert.remotes.register(TYPERT_REMOTE)) },
  })
  await offlineOwner
  const operations = sessionOperations(offline.typert.remotes)
  assert.deepEqual(operations.list().map(item => item.endpoint), ['session/page', 'session/follow'])
  assert.throws(() => operations.method('workspace/list'), /Unselected/)
  for (const { endpoint, method } of operations.list()) {
    assert.equal(method, TYPERT_REMOTE.methods[endpoint])
    assert.equal(method, TYPERT_REMOTE.descriptors.find(item => `${item.namespace}/${item.method}` === endpoint))
    assert.equal('metadata' in method, false)
    assert.ok(method.description)
    assert.ok(method.parameters.find(parameter => parameter.wire === 'request').description)
    assert.equal(typeof method.input({ strict: true }).create().parse, 'function')
    assert.equal(typeof method.result.create().parse, 'function')
  }
  const normalSchema = TYPERT_REMOTE.methods['session/page'].input().jsonSchema
  assert.equal(normalSchema.properties.request.additionalProperties, true)
  const originalSchema = structuredClone(TYPERT_REMOTE.methods['session/page'].input({ strict: true }).jsonSchema)
  assert.equal(originalSchema.properties.request.additionalProperties, false)
  const tool = pageTool(operations)
  assert.equal(tool.name, 'remote_session_page')
  assert.equal(tool.description, 'Read Session or subagent history without starting it. Records are oldest first. Use the opening follow cursor as throughSeq and the first record\'s sequence as beforeSeq to read older history when hasMore is true. maxMessages limits complete messages; turnWindow requests minimum messages and turns within that limit. To target the calling Session, set current: true and omit its target from arguments.request. This requires caller identity from the selected server.')
  assert.equal(JSON.stringify(tool.inputSchema).includes('"description"'), false)
  // Exercise optional presentation without manufacturing replacement controller metadata.
  const inputOnly = mcpSchemas(operations.inputSchema('session/page'))
  assert.equal('outputSchema' in inputOnly, false)
  assert.deepEqual(inputOnly.inputSchema, tool.inputSchema)
  assert.deepEqual(TYPERT_REMOTE.methods['session/page'].input({ strict: true }).jsonSchema, originalSchema)
  assert.equal(counters.http + counters.sockets, 0)
  assert.throws(() => operations.prepare('session/page', { arguments: { request: { throughSeq: -1 } }, current: true }), /caller Session identity/)
  assert.throws(() => operations.prepare('session/page', { arguments: {}, content: [] }), /does not accept local content/)
  assert.throws(() => operations.prepare('session/page', { arguments: { request: { throughSeq: 'bad' } }, current: true }, 'session-fixture'))
  globalThis.fetch = nativeFetch
  globalThis.WebSocket = nativeWebSocket

  host.provide('webServer', {
    register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) },
    registerUpgrade(route) { upgrades.push(route); return () => upgrades.splice(upgrades.indexOf(route), 1) },
    tapIndex() { return () => {} }, port: 0,
  })
  host.provide('credentials', {
    readRecord(key) { return Promise.resolve(records.get(key)) },
    async modifyRecord(key, mutate) {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  })
  // Unselected upload operations are never called; only the constructor's registration is supplied.
  host.provide('fileUploads', {
    registerAgentResolver() { counters.uploads++; return () => { counters.uploads-- } },
  })
  await host.plugin({ inject: connectionHost.inject, apply: connectionHost.apply })
  await host.plugin(Registry)
  await host.plugin(AgentRegistry)
  await host.plugin(SessionStore)
  await host.plugin(SessionProjectionRegistry)
  await host.plugin(PointQuery)
  await host.plugin(Gateway)
  const session = host.sessions.create(undefined, { meta: { cwd: process.cwd() } })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'offline history' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const hostOwner = host.plugin({
    inject: ['typert', 'agents', 'sessions', 'sessionQuery', 'sessionProjections', 'fileUploads'],
    apply(ctx) {
      new SessionController(ctx, {})
      ctx.effect(() => ctx.typert.register(TYPERT))
    },
  })
  await hostOwner
  assert.equal(counters.uploads, 1)
  assert.equal(host.typert.local.get('session/page'), TYPERT.invocations.find(item => item.method === 'page'))
  assert.equal(routes.length, 1)
  assert.equal(upgrades.length, 1)
  server = createServer((request, response) => {
    if ((request.url ?? '/').startsWith('/?')) {
      if (host.connection.authorizeIndex(request, response)) response.end('Session test')
      return
    }
    void routes[0].handler(request, response).catch(error => { response.destroy(error) })
  })
  server.on('upgrade', (request, socket, head) => {
    const route = upgrades.find(item => item.path === new URL(request.url, 'http://localhost').pathname)
    if (route === undefined) socket.destroy()
    else route.handler(request, socket, head)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}/`
  const login = await fetch(host.connection.authenticatedUrl(origin), { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie').split(';', 1)[0]
  await login.body?.cancel()

  await client.plugin(registryClient)
  await client.plugin({
    apply(ctx) {
      installConnection(ctx, { transport: {
        fetch(input, init) {
          counters.http++
          const headers = new Headers(init.headers)
          headers.set('cookie', cookie)
          return fetch(new URL(input, origin), { ...init, headers })
        },
        streamBaseUrl: origin,
        webSocket(url) { counters.sockets++; return new WebSocket(url, { headers: { cookie } }) },
      } })
    },
  })
  await client.plugin(gatewayClient)
  const mounted = client.plugin({
    inject: ['remote'],
    async apply(ctx) { await ctx.remote.$mount(TYPERT_REMOTE) },
  })
  await mounted
  assert.equal(counters.http + counters.sockets, 0, 'passive install/mount must not subscribe')
  assert.equal(client.connection.generation.getSnapshot(), undefined)
  const calls = sessionClient(operations, client.remote, session.id)
  const address = { kind: 'session', sessionId: session.id }
  const args = { request: { address, throughSeq: 0 } }
  const valid = { arguments: args }
  const local = { arguments: { request: { throughSeq: 0 } }, current: true }
  assert.deepEqual(operations.prepare('session/page', local, session.id), args)
  assert.throws(() => operations.prepare('session/page', { arguments: args, current: true }, session.id))
  const direct = await TYPERT_REMOTE.methods['session/page'].invoke(client.remote, args)
  assert.equal(direct.ok, true)
  assert.equal(direct.value.records.length, 1)
  assert.equal(direct.value.hasMore, false)
  assert.deepEqual(await calls.call('session/page', local), direct.value)
  assert.equal(counters.http, 2)
  assert.equal(counters.sockets, 0)
  const extraArguments = { request: { ...args.request, maxMesssages: 1 } }
  const ordinary = await TYPERT_REMOTE.methods['session/page'].invoke(client.remote, extraArguments)
  assert.equal(ordinary.ok, true, 'consumer strictness must not tighten ordinary Host dispatch')
  assert.deepEqual(ordinary.value, direct.value)
  const malformed = await TYPERT_REMOTE.methods['session/page'].invoke(client.remote, { request: { address, throughSeq: 'bad' } })
  assert.equal(malformed.ok, false)
  const before = counters.http
  const misspelled = await callPageTool(calls, { arguments: extraArguments })
  assert.equal(misspelled.isError, true)
  assert.equal(counters.http, before, 'strict CLI/MCP intake rejects unknown fields before HTTP')
  const invalid = await callPageTool(calls, { arguments: { request: { throughSeq: 'bad' } }, current: true })
  assert.equal(invalid.isError, true)
  assert.equal(invalid.structuredContent.ok, false)
  assert.equal(counters.http, before, 'invalid local inputs never reach HTTP')
  assert.deepEqual(JSON.parse(invalid.content[0].text), invalid.structuredContent)
  const success = await callPageTool(calls, valid)
  assert.deepEqual(success.structuredContent, { ok: true, value: direct.value })
  assert.deepEqual(JSON.parse(success.content[0].text), success.structuredContent)
  const failure = await callPageTool(calls, { arguments: { request: { address, throughSeq: 999 } } })
  assert.equal(failure.isError, true)
  assert.equal(failure.structuredContent.ok, false)
  assert.deepEqual(JSON.parse(failure.content[0].text), failure.structuredContent)
  if (tool.outputSchema !== undefined) {
    const envelope = z.fromJSONSchema(tool.outputSchema)
    envelope.parse(success.structuredContent)
    envelope.parse(failure.structuredContent)
    assert.throws(() => envelope.parse({ ok: true, value: { records: 'bad', hasMore: false } }))
  }
  assert.throws(() => TYPERT_REMOTE.methods['session/page'].result.create().parse({ records: 'bad', hasMore: false }))
  // A corrupt response exercises the consumer's output parser without inventing descriptors.
  const corrupt = sessionClient(operations, { session: { page: async () => ({ ok: true, value: { records: 'bad' } }) } })
  await assert.rejects(corrupt.call('session/page', valid))
  await assert.rejects(calls.call('session/follow', { arguments: { request: { address } } }), /requires stream/)
  assert.throws(() => calls.stream('session/page', valid), /requires call/)

  const control = new AbortController()
  const handle = calls.stream('session/follow', { arguments: { request: {} }, current: true }, control.signal)
  for (const key of ['send', 'end', 'dispose']) assert.equal(typeof handle[key], 'function')
  const iterator = handle[Symbol.asyncIterator]()
  const opening = await iterator.next()
  assert.equal(opening.done, false)
  assert.equal(opening.value.type, 'snapshot')
  assert.equal(opening.value.cursor, 0)
  assert.equal(opening.value.records.length, 1)
  handle.end()
  const next = iterator.next()
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'live history' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const update = await next
  assert.equal(update.value.type, 'event')
  assert.equal(update.value.event.seq, 1)
  const pending = iterator.next()
  control.abort()
  const [aborted] = await Promise.allSettled([pending])
  if (aborted.status === 'fulfilled') assert.equal(aborted.value.done, true)
  handle.dispose()
  await iterator.return?.()
  assert.equal(counters.sockets, 1)
  assert.equal(host.agents.list().length, 0, 'following a live Session needs no activation')

  // Unmount while a second stream is pending, then await all consumer/socket teardown.
  const owned = calls.stream('session/follow', { arguments: { request: { address } } })
  const ownedIterator = owned[Symbol.asyncIterator]()
  await ownedIterator.next()
  const waiting = Promise.allSettled([ownedIterator.next()])
  await mounted.dispose()
  assert.equal(client.typert.remotes.get('session/page'), undefined)
  assert.deepEqual(client.typert.remotes.list(), [])
  await client.fiber.dispose()
  await waiting
  await hostOwner.dispose()
  assert.equal(host.typert.local.get('session/page'), undefined)
  assert.deepEqual(host.typert.local.list(), [])
  assert.equal(counters.uploads, 0)
  await offlineOwner.dispose()
  assert.deepEqual(offline.typert.remotes.list(), [])
  assert.throws(() => operations.list(), /Missing generated method/)
  console.log(JSON.stringify({ endpoints: ['session/page', 'session/follow'], http: counters.http, sockets: counters.sockets, realController: true }))
} finally {
  globalThis.fetch = nativeFetch
  globalThis.WebSocket = nativeWebSocket
  await client.fiber.dispose()
  await host.fiber.dispose()
  if (server !== undefined) {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()))
  }
  await offline.fiber.dispose()
}
