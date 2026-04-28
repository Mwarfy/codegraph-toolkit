// Fixture : entry-points `interval` + `bullmq-job` + sink `http-outbound`.
// @ts-nocheck — fixture stub.

declare const db: any
declare const emitEvent: (e: any) => Promise<void>

// --- setInterval: handler nommé, traversable par BFS typedCalls ---
export function pollMetrics(): void {
  void db.query('SELECT 1 FROM metrics')
}

setInterval(pollMetrics, 60_000)  // → entry-point interval, handler=scheduler.ts:pollMetrics

// --- setTimeout module-level (scheduled start) — même détection ---
setTimeout(() => {
  void emitEvent({ type: 'boot.completed', payload: {}, source: { projectId: '', blockId: '', blockType: '' }, timestamp: new Date() })
}, 5000)

// --- BullMQ Worker ---

declare class Worker {
  constructor(name: string, handler: (...args: any[]) => any)
}

export async function processEmail(job: any): Promise<void> {
  void job
  // HTTP outbound sink : fetch literal URL
  await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST' })
}

new Worker('email-queue', processEmail)  // → entry bullmq-job:queue:email-queue, handler=scheduler.ts:processEmail

// --- HTTP outbound via axios client ---
declare const axios: any

export async function callYoutube(): Promise<void> {
  await axios.get('https://www.googleapis.com/youtube/v3/videos')
  await axios.post('https://www.googleapis.com/upload/youtube/v3/videos')
}

// --- Relative URL should NOT be treated as outbound ---
export async function localFetch(): Promise<void> {
  await fetch('/api/internal')  // → pas de sink outbound (URL relative)
}

// --- Dynamic URL (template) → target = '<dynamic>' ---
export async function dynamicFetch(base: string): Promise<void> {
  await fetch(`${base}/v1/users`)
}
