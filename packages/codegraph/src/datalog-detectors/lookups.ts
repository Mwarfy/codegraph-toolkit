// ADR-024 — Phase γ.4 prototype : lookup tables statiques pour les rules
/**
 * Tables de lookup utilisées par les rules .dl. Émises comme facts à
 * chaque évaluation (constants, pas dépendants du codebase).
 *
 * Source de vérité : reproduit exactement les Set du detector legacy
 * (extractors/magic-numbers.ts, extractors/dead-code.ts) pour préserver
 * le comportement bit-identique.
 */

export const TIMEOUT_FN_NAMES = [
  'setInterval', 'setTimeout', 'setImmediate', 'delay', 'sleep', 'wait',
] as const

export const TIMEOUT_PROPERTY_NAMES = [
  'timeout', 'timeoutMs', 'delay', 'delayMs', 'interval', 'intervalMs',
  'ttl', 'ttlMs', 'retryAfter', 'retryAfterMs', 'maxAge', 'maxAgeMs',
] as const

export const THRESHOLD_PROPERTY_NAMES = [
  'maxRetries', 'limit', 'maxConcurrency', 'maxSize', 'minSize',
  'threshold', 'budget', 'capacity', 'maxTokens', 'minTokens',
] as const

export const SUSPECT_BINARY_OPS = [
  '&&', '||', '==', '===', '!=', '!==',
  '>', '>=', '<', '<=',
] as const

// Source : COMPARISON_OPS dans extractors/magic-numbers.ts. Subset des
// SUSPECT (sans &&, ||) — utilisé pour binary comparisons large-int.
export const COMPARISON_BINARY_OPS = [
  '>', '<', '>=', '<=', '===', '==', '!==', '!=',
] as const

// Source : extractors/crypto-algo.ts CRYPTO_METHODS
export const CRYPTO_METHOD_NAMES = [
  'createHash', 'createCipher', 'createCipheriv', 'createHmac',
  'createDecipher', 'createDecipheriv',
  'pbkdf2', 'pbkdf2Sync', 'scrypt', 'scryptSync',
] as const

// Source : objText.split('.').pop() lowercased — match `crypto`, `node:crypto`
export const CRYPTO_OBJECT_LAST_NAMES = [
  'crypto',
] as const

// Boolean param strict types (extractors/boolean-params.ts isExactBooleanParam)
export const BOOLEAN_PARAM_TYPE_TEXTS = [
  'boolean', 'bool',
] as const

export interface LookupTuples {
  TimeoutFnName: Array<[string]>
  TimeoutPropertyName: Array<[string]>
  ThresholdPropertyName: Array<[string]>
  SuspectBinaryOp: Array<[string]>
  ComparisonBinaryOp: Array<[string]>
  CryptoMethodName: Array<[string]>
  CryptoObjectLast: Array<[string]>
  BooleanParamTypeText: Array<[string]>
}

export function buildLookupTuples(): LookupTuples {
  return {
    TimeoutFnName: TIMEOUT_FN_NAMES.map((n) => [n]),
    TimeoutPropertyName: TIMEOUT_PROPERTY_NAMES.map((n) => [n]),
    ThresholdPropertyName: THRESHOLD_PROPERTY_NAMES.map((n) => [n]),
    SuspectBinaryOp: SUSPECT_BINARY_OPS.map((o) => [o]),
    ComparisonBinaryOp: COMPARISON_BINARY_OPS.map((o) => [o]),
    CryptoMethodName: CRYPTO_METHOD_NAMES.map((n) => [n]),
    CryptoObjectLast: CRYPTO_OBJECT_LAST_NAMES.map((n) => [n]),
    BooleanParamTypeText: BOOLEAN_PARAM_TYPE_TEXTS.map((n) => [n]),
  }
}
