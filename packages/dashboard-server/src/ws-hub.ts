import type { WebSocket } from '@fastify/websocket'

export type WsEvent =
  | { type: 'snapshot:updated'; ts: number }
  | { type: 'telemetry:appended'; ts: number; record: Record<string, unknown> }
  | { type: 'commit:landed'; ts: number; sha: string }
  | { type: 'hello'; ts: number }

export class WsHub {
  private clients = new Set<WebSocket>()

  add(ws: WebSocket): void {
    this.clients.add(ws)
    ws.on('close', () => this.clients.delete(ws))
    this.send(ws, { type: 'hello', ts: Date.now() })
  }

  broadcast(evt: WsEvent): void {
    const payload = JSON.stringify(evt)
    for (const ws of this.clients) {
      try {
        ws.send(payload)
      } catch {
        this.clients.delete(ws)
      }
    }
  }

  private send(ws: WebSocket, evt: WsEvent): void {
    try {
      ws.send(JSON.stringify(evt))
    } catch {
      this.clients.delete(ws)
    }
  }

  size(): number {
    return this.clients.size
  }
}
