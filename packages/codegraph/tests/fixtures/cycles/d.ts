// Cycle 2, gated : le gate vit ici.
function isAllowed(tag: string): boolean {
  return tag.length > 0
}

export function fromD(tag: string): number {
  if (isAllowed(tag)) return 2
  return 0
}
