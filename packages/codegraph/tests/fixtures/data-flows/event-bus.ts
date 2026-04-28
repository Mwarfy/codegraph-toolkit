// Stub d'event bus exporté — les extracteurs reconnaissent `emit` / `listen`
// comme sinks / entries par nom de fonction, indépendamment de ce module.
export function emit(event: string, payload: unknown): void {
  void event; void payload
}

export function listen(event: string, handler: (payload: unknown) => void): void {
  void event; void handler
}

export function query(sql: string, params?: unknown[]): Promise<unknown> {
  void sql; void params
  return Promise.resolve()
}
