// VIOLATIONS additionnelles : floating promise, env read, regex,
// hardcoded secret, boolean param, try-catch swallow, deprecated.

import { hub } from './hub.js'

// FloatingPromise — promise sans await ni .catch()
export function fireAndForget(): void {
  fetch('https://example.com')  // floating
}

// EnvRead — process.env.X direct (pas via wrapper typé)
export function getApiUrl(): string {
  return process.env.API_URL ?? 'http://localhost:3000'
}

// RegexLiteral — /pattern/flags
export const EMAIL_RE = /^[a-z]+@[a-z]+\.[a-z]+$/i

// HardcodedSecret — string high-entropy nommée comme un secret
export const api_key = 'sk-aB7xQ9zR2mN8vL4kP1jH6tY3wE5rT0uI'

// BooleanParam — paramètre booléen positionnel
export function setEnabled(name: string, enabled: boolean): void {
  console.log(name, enabled, hub())
}

// TryCatchSwallow — catch vide
export function silentFail(): void {
  try {
    JSON.parse('{}')
  } catch {
    // swallow — anti-pattern
  }
}

/**
 * @deprecated use newApi() instead
 */
export function oldApi(): string {
  return 'old'
}

// ConstantExpression — calcul constant à l'AST
export const HOUR_IN_SEC = 60 * 60
