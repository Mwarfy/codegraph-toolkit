// Test fixture pour Phase γ.2 — extractor pure ts-morph qui prend (sf, relPath)
// et retourne Item[] directement. Utilisé par les tests de determinisme
// cross-thread sur runPerSourceFileExtractor.

export function extractFunctionsByName(sf, relPath) {
  const out = []
  for (const fn of sf.getFunctions()) {
    out.push({
      file: relPath,
      name: fn.getName() ?? '(anonymous)',
      line: fn.getStartLineNumber(),
    })
  }
  return out
}
