#!/usr/bin/env node
// Tier 8 — fast path datalog-check pour le hook PostToolUse.
// Skip le commander/chalk/CLI loading complet. Latence cible <500ms.
//
// Usage : node datalog-check-fast.mjs <repo-root> [--update-baseline]
//   - sans --update-baseline : sort JSON {elapsed, total, baseline, new, violations[]}
//   - avec --update-baseline : sort JSON {updated: true, count}
//
// Lit :
//   <repo-root>/sentinel-core/invariants/  OR  <repo-root>/invariants/
//   <repo-root>/.codegraph/facts/
//   <repo-root>/.codegraph/violations-baseline.json (cache)

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { runFromDirs, formatProof, tupleKey } from '@liby-tools/datalog'

const args = process.argv.slice(2)
const root = args[0]
const updateBaseline = args.includes('--update-baseline')
const TIMEOUT_MS = 3000

if (!root) {
  console.log(JSON.stringify({ error: 'usage: datalog-check-fast.mjs <repo-root>' }))
  process.exit(1)
}

const start = Date.now()

async function exists(p) {
  try { await fs.stat(p); return true } catch { return false }
}

// Détection rules-dir(s) :
//   1. Si le projet utilise @liby-tools/invariants-postgres-ts (linké via
//      node_modules) → multi-dir [toolkit-canonical, project-local].
//   2. Sinon fallback : un seul dir local.
async function resolveRulesDirs(root) {
  // Local path (project-specific overrides) — ajoute uniquement s'il existe.
  let local = null
  if (await exists(path.join(root, 'sentinel-core/invariants'))) {
    local = path.join(root, 'sentinel-core/invariants')
  } else if (await exists(path.join(root, 'invariants'))) {
    local = path.join(root, 'invariants')
  }

  // Cherche le pkg toolkit dans plusieurs layers, par ordre de preference :
  //   1. node_modules (project consumer)
  //   2. sentinel-core/node_modules (Sentinel-specific layout)
  //   3. packages/invariants-postgres-ts/invariants (workspace path —
  //      cas du toolkit lui-meme qui s'auto-checke)
  const candidates = [
    path.join(root, 'node_modules/@liby-tools/invariants-postgres-ts/invariants'),
    path.join(root, 'sentinel-core/node_modules/@liby-tools/invariants-postgres-ts/invariants'),
    path.join(root, 'packages/invariants-postgres-ts/invariants'),
  ]
  for (const c of candidates) {
    if (await exists(c)) {
      // Si local existe ET differe du canonical, multi-dir.
      if (local && path.resolve(c) !== path.resolve(local)) return [c, local]
      return [c]
    }
  }
  // Pas de canonical trouve, fallback sur local s'il existe.
  return local ? [local] : []
}

const rulesDirs = await resolveRulesDirs(root)
const factsDir = path.join(root, '.codegraph/facts')
const baselinePath = path.join(root, '.codegraph/violations-baseline.json')

const allRulesDirsExist = (await Promise.all(rulesDirs.map(exists))).every(Boolean)
if (!allRulesDirsExist || !(await exists(factsDir))) {
  console.log(JSON.stringify({ skipped: true, reason: 'no rules or facts dir' }))
  process.exit(0)
}

// Tier 12 : record proofs for Violation pour pouvoir afficher le path
// (proof tree) dans le hook output. Coût eval +5-10ms typique mais
// l'agent voit POURQUOI une violation existe, pas juste OÙ.
const evalPromise = runFromDirs({
  // multi-dir si le toolkit canonical est trouvé, sinon single-dir.
  rulesDir: rulesDirs.length === 1 ? rulesDirs[0] : rulesDirs,
  factsDir, allowRecursion: true,
  recordProofsFor: ['Violation'],
}).catch((err) => ({ __error: String(err) }))
let timer
const timeoutPromise = new Promise((resolve) => {
  timer = setTimeout(() => resolve({ __timeout: true }), TIMEOUT_MS)
  // unref() permet a Node d'exit si le main termine avant le timeout —
  // sans ca le process attend la fin du timer (3s wall clock).
  timer.unref()
})
const raced = await Promise.race([evalPromise, timeoutPromise])
clearTimeout(timer)

if (raced.__timeout) {
  console.log(JSON.stringify({ timeout: true, ms: TIMEOUT_MS }))
  process.exit(0)
}
if (raced.__error) {
  console.log(JSON.stringify({ error: raced.__error }))
  process.exit(0)
}

const violations = raced.result.outputs.get('Violation') ?? []
const proofs = raced.result.proofs?.get('Violation') ?? new Map()
const keyOf = (v) => `${v[0]}\x00${v[1]}\x00${v[2]}\x00${v[3]}`

// Extrait un PATH lisible depuis le proof tree d'un Violation. Le proof
// liste les facts/rules qui ont permis de derive la conclusion. On
// retourne juste les noms de relations + tuples cles (pas le tree full).
function proofPath(violationTuple) {
  try {
    const proofKey = tupleKey('Violation', violationTuple)
    const proof = proofs.get(proofKey)
    if (!proof) return null
    // formatProof renvoie un texte multi-lignes avec indent. On garde
    // les 8 premieres lignes pour l'output JSON (acceptable taille hook).
    const text = formatProof(proof)
    return text.split('\n').slice(0, 8).join('\n')
  } catch {
    return null
  }
}

if (updateBaseline) {
  await fs.writeFile(baselinePath, JSON.stringify({
    violations,
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n')
  console.log(JSON.stringify({ updated: true, count: violations.length, elapsed: Date.now() - start }))
  process.exit(0)
}

let baselineCount = 0
let baselineKeys = new Set()
try {
  const raw = await fs.readFile(baselinePath, 'utf-8')
  const baseline = JSON.parse(raw)
  baselineKeys = new Set((baseline.violations ?? []).map(keyOf))
  baselineCount = baselineKeys.size
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.log(JSON.stringify({ error: String(err) }))
    process.exit(0)
  }
  // Pas de baseline → tout est nouveau (premier run).
}

const newViolations = violations.filter((v) => !baselineKeys.has(keyOf(v)))

console.log(JSON.stringify({
  elapsed: Date.now() - start,
  total: violations.length,
  baseline: baselineCount,
  new: newViolations.length,
  violations: newViolations.slice(0, 20).map((tuple) => {
    const [adr, file, line, msg] = tuple
    const path = proofPath(tuple)
    return path ? { adr, file, line, msg, path } : { adr, file, line, msg }
  }),
  truncated: newViolations.length > 20 ? newViolations.length - 20 : 0,
}))
