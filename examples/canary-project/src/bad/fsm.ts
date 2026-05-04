// VIOLATION #6 — FSM avec état orphelin (déclaré mais jamais transitionné).
//
// Détection attendue :
//   - FsmStateDeclared ≥ 4 (pending, processing, done, abandoned)
//   - FsmStateOrphan ≥ 1 (abandoned : déclaré jamais écrit dans le code)

export type JobStatus = 'pending' | 'processing' | 'done' | 'abandoned'

export function transition(current: JobStatus, event: 'start' | 'finish'): JobStatus {
  if (current === 'pending' && event === 'start') return 'processing'
  if (current === 'processing' && event === 'finish') return 'done'
  // 'abandoned' est déclaré dans JobStatus mais jamais écrit → orphan state
  return current
}
