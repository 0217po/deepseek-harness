/** Physical WebSocket selection and ownership for one Client Connection. */

/** Events consumed by Connection and Gateway on either browser or Node sockets. */
export interface ConnectionWebSocketEventMap {
  readonly open: object
  readonly error: object
  readonly close: object
  readonly message: { readonly data: unknown }
}

/** WebSocket operations shared by the browser API and Node carriers. */
export interface ConnectionWebSocket {
  /** Standard WebSocket connection state, from CONNECTING (0) through CLOSED (3). */
  readonly readyState: number
  /** @param data - complete text frame to send. */
  send(data: string): void
  /**
   * @param code - protocol close code.
   * @param reason - peer-facing close explanation.
   */
  close(code?: number, reason?: string): void
  /**
   * @param event - physical socket event.
   * @param listener - callback for that event.
   * @param options - whether the listener is removed after its first delivery.
   */
  addEventListener<Event extends keyof ConnectionWebSocketEventMap>(
    event: Event,
    listener: (event: ConnectionWebSocketEventMap[Event]) => void,
    options?: { readonly once?: boolean },
  ): void
  /**
   * @param event - physical socket event.
   * @param listener - previously registered callback.
   */
  removeEventListener<Event extends keyof ConnectionWebSocketEventMap>(
    event: Event,
    listener: (event: ConnectionWebSocketEventMap[Event]) => void,
  ): void
}

/**
 * Open an authenticated physical socket; framing remains with its consumer.
 * @param url - absolute WebSocket URL below the selected Host or document mount.
 * @returns the newly created socket, including its pending connection lifetime.
 */
export type ConnectionWebSocketFactory = (url: string) => ConnectionWebSocket

const WEBSOCKET_CLOSED = 3

/** Own sockets until their close event, including failed connection attempts. */
export class ConnectionSockets {
  private readonly sockets = new Map<ConnectionWebSocket, Promise<void>>()
  private disposed = false

  /**
   * @param factory - physical carrier; omission uses the browser WebSocket API.
   * @param baseUrl - shell-owned Host base; omission uses the current document base.
   */
  constructor(
    private readonly factory: ConnectionWebSocketFactory = url => new WebSocket(url),
    private readonly baseUrl?: string,
  ) {}

  /**
   * Open a channel beneath the selected Host or document mount.
   * @param path - absolute logical channel path.
   * @returns a physical socket whose lifetime belongs to this Connection.
   */
  open(path: string): ConnectionWebSocket {
    if (this.disposed) throw new Error('connection: WebSocket carrier is disposed')
    const base = this.baseUrl ?? (typeof document === 'undefined' ? undefined : document.baseURI)
    if (base === undefined) throw new Error('connection: WebSocket carrier requires streamBaseUrl outside a document')
    const url = new URL(path.slice(1), base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = this.factory(url.href)
    if (socket.readyState === WEBSOCKET_CLOSED) return socket
    // Node sockets can emit an error after a cancelled opener removes its listeners.
    const error = (): void => {}
    socket.addEventListener('error', error)
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener('close', () => {
        socket.removeEventListener('error', error)
        this.sockets.delete(socket)
        resolve()
      }, { once: true })
    })
    this.sockets.set(socket, closed)
    return socket
  }

  /**
   * Close every owned socket.
   * @returns after every physical close event has arrived.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const sockets = [...this.sockets]
    for (const [socket] of sockets) socket.close(1000, 'Connection disposed')
    await Promise.all(sockets.map(([, closed]) => closed))
  }
}
