// VIOLATION #1 — hub : importé par 5+ fichiers (consumer*.ts).
//
// Détection attendue : top-hub flagué dans le snapshot, in-degree ≥ 5.

export function hub(): string {
  return 'hub-result'
}

export const HUB_VERSION = '1.0'
