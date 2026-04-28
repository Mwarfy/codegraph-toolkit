export function listen(event: string, handler: (payload: unknown) => void): void {
  void event; void handler
}
export function query(sql: string, params?: unknown[]): Promise<unknown> {
  void sql; void params
  return Promise.resolve()
}
