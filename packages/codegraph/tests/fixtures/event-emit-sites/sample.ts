// Fixture for event-emit-sites extractor.
// Covers all three kinds: literal, eventConstRef (kernel + pack), dynamic.
// Plus negative cases that must NOT be captured.

const EVENTS = {
  RENDER_COMPLETED: 'render.completed',
  BLOCK_ERROR: 'block.error',
} as const

const VISUAL_EVENTS = {
  STARTED: 'visual.started',
} as const

declare function emit(payload: unknown): void
declare function emitEvent(payload: unknown): void
declare const bus: { emit(payload: unknown): void }

// ─── kind: 'literal' ─────────────────────────────────────────────────────
function literalCase() {
  emit({ type: 'render.completed', data: 1 })
  emitEvent({ type: 'block.error', err: 'x' })
}

// ─── kind: 'eventConstRef' ──────────────────────────────────────────────
function constRefCase() {
  emit({ type: EVENTS.RENDER_COMPLETED, data: 1 })
  emitEvent({ type: VISUAL_EVENTS.STARTED, ts: 0 })
}

// ─── kind: 'dynamic' ────────────────────────────────────────────────────
function dynamicCase(name: string) {
  emit({ type: name, data: 1 })
}

// ─── method-call form (this.emit / bus.emit) ────────────────────────────
class Block {
  emit(payload: unknown): void { void payload }
  doWork() {
    this.emit({ type: 'block.work', n: 1 })
    bus.emit({ type: EVENTS.BLOCK_ERROR, err: 'oops' })
  }
}

// ─── must NOT be captured ───────────────────────────────────────────────
// 1) emit(...) without an object literal first arg
function notCaptured1(payload: { type: string }) {
  emit(payload)
}

// 2) object literal without `type:` property
function notCaptured2() {
  emit({ kind: 'render.completed' as any })
}

// 3) function call whose name is not `emit` / `emitEvent`
declare function send(payload: unknown): void
function notCaptured3() {
  send({ type: 'should.not.match' })
}
