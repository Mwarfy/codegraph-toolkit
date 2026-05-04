// VIOLATION #3 — orphan : aucun fichier ne l'importe.
//
// Détection attendue : 1 fichier avec status === 'orphan' dans snapshot.nodes.

export function orphanedHelper(): string {
  return 'this is never called from anywhere'
}
