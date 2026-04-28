// Cycle 2, gated : c → d → e → c.
// Ici d.ts appelle `isAllowed(...)` — devrait rendre le cycle `gated: true`.
export function fromC(): number {
  return 1
}
