// Concept 1 : union type avec 4 états. L'un (`expired`) sera orphelin
// (jamais écrit dans les fixtures).
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

// Concept 2 : enum avec 3 valeurs. Tous écrits → pas d'orphan.
export enum TaskPhase {
  Queued = 'queued',
  Running = 'running',
  Done = 'done',
}

// Concept hors suffixe (ne doit PAS être extrait).
export type Color = 'red' | 'green' | 'blue'

// Concept 4 (phase 3.6 #2) : DocumentPhase testé uniquement via SQL DEFAULT.
// Aucun code TS de la fixture n'écrit ses valeurs — seules les colonnes
// `phase DEFAULT 'drafting'|'reviewing'` de schema.sql les produisent.
export type DocumentPhase = 'drafting' | 'reviewing' | 'published' | 'archived'
