// VIOLATION #10 — scope OAuth string littéral hors registry typé.
//
// Détection attendue :
//   - OauthScopeLiteral ≥ 1

export const SCOPES_USED = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
]
