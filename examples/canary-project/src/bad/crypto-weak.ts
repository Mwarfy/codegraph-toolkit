// VIOLATION #9 — crypto faible : md5 + Math.random pour token.
//
// Détection attendue :
//   - CryptoCall ≥ 1
//   - WeakRandomCall ≥ 1 (Math.random() utilisé pour génération de token)

import * as crypto from 'node:crypto'

export function hashPassword(p: string): string {
  // md5 = cryptographiquement cassé pour passwords (qualified crypto.createHash
  // pour matcher le détecteur — direct createHash est skip).
  return crypto.createHash('md5').update(p).digest('hex')
}

export function generateToken(): string {
  // Math.random n'est PAS cryptographically secure
  const token = Math.random().toString(36).slice(2)
  return token
}
