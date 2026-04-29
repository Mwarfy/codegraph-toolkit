// Fixture : accès variés à process.env.
// @ts-nocheck

// PropertyAccess direct.
export const DATABASE_URL = process.env.DATABASE_URL
// ElementAccess avec literal.
export const API_KEY = process.env['OPENAI_API_KEY']
// Avec default via `??`.
export const PORT = process.env.PORT ?? '3000'
// Avec default via `||`.
export const NODE_ENV = process.env.NODE_ENV || 'development'
// Lecture multiple du même nom — doit dedup par entry mais ajouter 2 readers.
export function readSecret(): string | undefined {
  return process.env.SECRET_TOKEN
}

export function readSecretAgain(): string | undefined {
  return process.env.SECRET_TOKEN
}

// Accès dynamique — ne doit PAS être capturé.
export function dynamic(name: string): string | undefined {
  return process.env[name]
}

// Faux positifs à éviter : process.envelope, user.env, etc.
declare const user: any
export function noise(): any {
  const unrelated = process  // pas d'access .env
  const x = user.env.FOO    // pas process.env
  void unrelated, x
}

// Property d'env qui n'est PAS un nom valide — ex : .toString.
export function getEnvCount(): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return process.env.toString()  // `toString` match-t-il ? Non : pattern exige uppercase.
}

// ─── ADR-019 wrapping detection ──────────────────────────────────────────
// `wrappedIn` doit capturer le callee qui enveloppe DIRECTEMENT le read.
export const HEALER_CYCLE_MS = parseInt(process.env.HEALER_CYCLE_MS ?? '900000', 10)
export const RETENTION_DAYS = parseFloat(process.env.RETENTION_DAYS)
export const MAX_BUDGET = Number(process.env.MAX_BUDGET)
// Method-call wrapping doit aussi marcher (cas custom helpers).
declare const helper: { coerce(x: unknown): number }
export const COERCED = helper.coerce(process.env.COERCED_VAL)
// Sans wrapping = pas d'entrée wrappedIn.
export const RAW_ENV = process.env.RAW_ENV
