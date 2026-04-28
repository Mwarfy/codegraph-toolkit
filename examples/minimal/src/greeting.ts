// ADR-001: format canonique des salutations

export function formatGreeting(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'Hello, friend.'
  return `Hello, ${trimmed}.`
}
