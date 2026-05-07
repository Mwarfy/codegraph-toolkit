export type WsEvent =
  | { type: 'snapshot:updated'; ts: number }
  | { type: 'telemetry:appended'; ts: number; record: Record<string, unknown> }
  | { type: 'commit:landed'; ts: number; sha: string }
  | { type: 'hello'; ts: number }

type Listener = (evt: WsEvent) => void

export class WsClient {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private reconnectTimer: number | null = null

  constructor(private readonly url: string) {}

  start(): void {
    this.connect()
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as WsEvent
        for (const fn of this.listeners) fn(evt)
      } catch {
        // skip malformed
      }
    }
    this.ws.onclose = () => this.scheduleReconnect()
    this.ws.onerror = () => this.ws?.close()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, 2000)
  }
}
