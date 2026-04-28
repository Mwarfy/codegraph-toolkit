// Cache in-memory associé au concept `trust`.
// Le nom de variable `trustCache` doit matcher la table `trust_scores`.
export const trustCache = new Map<string, number>()

// Cache sans rapport — ne doit PAS être attribué au concept trust_scores.
export const unrelatedStore = new Map<string, string>()
