// VIOLATION #11 — events : emit + listen avec string littérale (pas const ref).
//
// Détection attendue :
//   - EmitsLiteral ≥ 1 ('order.placed' string literal)
//   - ListensLiteral ≥ 1

interface Bus {
  emit(payload: { type: string }): void
  on(type: string, h: (...args: unknown[]) => void): void
}

export function publishOrder(bus: Bus): void {
  // string literal au lieu de EVENTS.X — détecté par event-emit-sites
  bus.emit({ type: 'order.placed' })
}

export function subscribe(bus: Bus): void {
  bus.on('order.placed', () => {})
}
