/** Connection chooses WebSocket URLs and retains physical close ownership. */

import { EventEmitter } from 'node:events'
import type { ConnectionWebSocket, ConnectionWebSocketEventMap } from '../src/client/socket.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionSockets } from '../src/client/socket.ts'

afterEach(() => { vi.unstubAllGlobals() })

class Socket extends EventTarget {
  override addEventListener<E extends keyof ConnectionWebSocketEventMap>(
    type: E, listener: (event: ConnectionWebSocketEventMap[E]) => void, options?: { readonly once?: boolean },
  ): void
  override addEventListener(
    type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions,
  ): void
  override addEventListener(type: string, listener: unknown, options?: boolean | AddEventListenerOptions): void {
    // This fixture dispatches MessageEvent for messages and Event for other socket events.
    super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options)
  }

  override removeEventListener<E extends keyof ConnectionWebSocketEventMap>(
    type: E, listener: (event: ConnectionWebSocketEventMap[E]) => void,
  ): void
  override removeEventListener(
    type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions,
  ): void
  override removeEventListener(type: string, listener: unknown, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null, options)
  }

  readyState = 0
  readonly closedWith: { readonly code?: number; readonly reason?: string }[] = []

  constructor(readonly url: string) { super() }

  send(_data: string): void {}

  close(code?: number, reason?: string): void {
    this.closedWith.push({
      ...code === undefined ? {} : { code },
      ...reason === undefined ? {} : { reason },
    })
    this.readyState = 2
  }

  finishClose(): void {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

describe('Connection WebSocket carrier', () => {
  it('does not retain a socket that is already closed when its factory returns', async () => {
    const socket = new Socket('ws://fixture/api/remote.mux')
    socket.finishClose()
    const sockets = new ConnectionSockets(() => socket, 'http://fixture/')
    expect(sockets.open('/api/remote.mux')).toBe(socket)
    await sockets.dispose()
    expect(socket.closedWith).toEqual([])
  })

  it('contains Node socket errors until physical close, then removes its handler', async () => {
    const events = new EventEmitter()
    const socket: ConnectionWebSocket = {
      readyState: 0,
      send() {},
      close() {},
      addEventListener(event, listener, options) {
        if (options?.once === true) events.once(event, listener)
        else events.on(event, listener)
      },
      removeEventListener(event, listener) { events.off(event, listener) },
    }
    const sockets = new ConnectionSockets(() => socket, 'http://fixture/')
    sockets.open('/api/remote.mux')
    expect(() => events.emit('error', new Error('opening failed'))).not.toThrow()
    const closed = sockets.dispose()
    expect(() => events.emit('error', new Error('cancelled while opening'))).not.toThrow()
    events.emit('close', {})
    await closed
    expect(events.listenerCount('error')).toBe(0)
  })

  it.each([
    ['https://harness.example/mounted/app/', 'wss://harness.example/mounted/app/api/remote.mux'],
    ['http://127.0.0.1:43210', 'ws://127.0.0.1:43210/api/remote.mux'],
  ])('resolves channel paths below the selected base %s', async (base, expected) => {
    vi.stubGlobal('document', { baseURI: 'dsh-app://app/' })
    const created: Socket[] = []
    const sockets = new ConnectionSockets((url) => {
      const socket = new Socket(url)
      created.push(socket)
      return socket
    }, base)
    const socket = sockets.open('/api/remote.mux')
    expect(created[0]?.url).toBe(expected)
    expect(socket).toBe(created[0])
    created[0]!.finishClose()
    await sockets.dispose()
  })

  it('uses the browser document base and native socket when no carrier is supplied', async () => {
    vi.stubGlobal('document', { baseURI: 'https://harness.example/application/' })
    vi.stubGlobal('WebSocket', Socket)
    const sockets = new ConnectionSockets()
    const socket = sockets.open('/api/remote.mux')
    expect(socket).toBeInstanceOf(Socket)
    expect((socket as Socket).url).toBe('wss://harness.example/application/api/remote.mux')
    ;(socket as Socket).finishClose()
    await sockets.dispose()
  })

  it('waits for a connecting socket to close and rejects later opens', async () => {
    const socket = new Socket('ws://fixture/api/remote.mux')
    const sockets = new ConnectionSockets(() => socket, 'http://fixture/')
    sockets.open('/api/remote.mux')
    let disposed = false
    const closing = sockets.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(socket.closedWith).toEqual([{ code: 1000, reason: 'Connection disposed' }])
    expect(() => sockets.open('/api/remote.mux')).toThrow('carrier is disposed')
    socket.finishClose()
    await closing
    expect(disposed).toBe(true)
  })

  it('requires an explicit stream base when no document exists', () => {
    vi.stubGlobal('document', undefined)
    const sockets = new ConnectionSockets(url => new Socket(url))
    expect(() => sockets.open('/api/remote.mux')).toThrow('requires streamBaseUrl')
  })
})
