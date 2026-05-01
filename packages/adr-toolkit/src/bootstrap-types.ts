/**
 * Bootstrap detector types — extraits pour casser le cycle d'imports
 * `bootstrap.ts ↔ bootstrap-fsm.ts` (Tier 17 self-audit).
 *
 * Ces types sont partages entre les detecteurs (singleton, write-isolation,
 * hub, fsm). Aucune logique ici, juste les contrats types.
 */

export type PatternKind = 'singleton' | 'fsm' | 'write-isolation' | 'hub'

export interface PatternCandidate {
  kind: PatternKind
  /** Path absolu du fichier candidat. */
  filePath: string
  /** Path relatif au rootDir. */
  relativePath: string
  /** Indice specifique au pattern (line numbers, symbol names, etc.). */
  evidence: string
}
