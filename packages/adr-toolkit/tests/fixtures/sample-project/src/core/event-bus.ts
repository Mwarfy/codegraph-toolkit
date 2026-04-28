// ADR-002

type Listener = (data: unknown) => void
const listeners = new Map<string, Set<Listener>>()

export function emit(type: string, data: unknown): void {
  const set = listeners.get(type)
  if (!set) return
  for (const fn of set) fn(data)
}

export function on(type: string, fn: Listener): () => void {
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  set.add(fn)
  return () => set!.delete(fn)
}
