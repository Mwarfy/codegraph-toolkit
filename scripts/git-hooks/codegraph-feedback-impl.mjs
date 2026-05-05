// ADR-028 — Token-efficient hook injection (session-aware)
// Refactor 2026-05 : extracted from codegraph-feedback.sh heredoc to allow
// session-state tracking + bash 3.2 compatibility.
// Usage: node codegraph-feedback-impl.mjs <repoRoot> <relPath>

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const fs = require('node:fs')
const path = require('node:path')

const [, , repoRoot, relPath] = process.argv
const codegraphDir = path.join(repoRoot, '.codegraph')

// ADR-028 — Session manifest tracks per-file "first-time-seen" + violations
// baseline. 1er hook sur fichier dans la session = full context (importers,
// co-change, recent git, dette, tests). Hooks suivants = juste les signaux
// qui changent (NEW vs session-baseline violations, drift, memory, WIP).
// Ratio signal-per-token x10 vs hook v0.5 sans manifestation visible de
// réduction de signal — au contraire, NEW est plus net car non noyé dans
// grandfathered.
const SESSION_TTL_MS = 30 * 60 * 1000
const sessionPath = path.join(codegraphDir, '.hook-cache', 'session-state.json')
let session
try {
  const raw = fs.readFileSync(sessionPath, 'utf-8')
  const parsed = JSON.parse(raw)
  if (Date.now() - (parsed.lastEditAt || 0) < SESSION_TTL_MS) session = parsed
} catch { /* fresh session */ }
if (!session) {
  session = { startedAt: Date.now(), lastEditAt: Date.now(), seenFiles: {} }
}
session.lastEditAt = Date.now()
const fileState = session.seenFiles[relPath]
const isFirstTimeOnFile = !fileState

let snapshotPath
try {
  // Tri par mtime : préfère le snapshot le plus frais (snapshot-live.json
  // si `codegraph watch` tourne, sinon le dernier post-commit). Cf. B2.
  const filesWithMtime = fs.readdirSync(codegraphDir)
    .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
    .map(f => {
      const p = path.join(codegraphDir, f)
      return { path: p, mtime: fs.statSync(p).mtimeMs }
    })
    .sort((a,  b) => b.mtime - a.mtime)
  if (filesWithMtime.length === 0) process.exit(0)
  snapshotPath = filesWithMtime[0].path
} catch {
  process.exit(0)
}

let snapshot
try {
  snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))
} catch {
  process.exit(0)
}

const node = snapshot.nodes?.find(n => n.id === relPath)
if (!node) process.exit(0)

const edges = snapshot.edges ?? []
const importers = edges.filter(e => e.to === relPath && e.type === 'import')
const imports = edges.filter(e => e.from === relPath && e.type === 'import')

const inDegree = importers.length
const outDegree = imports.length

const exports = node.exports ?? []
const problematic = exports.filter(e =>
  e.confidence && e.confidence !== 'used' && e.confidence !== 'test-only',
)
const safeToRemove = exports.filter(e => e.confidence === 'safe-to-remove')
const localOnly = exports.filter(e => e.confidence === 'local-only')
const possiblyDynamic = exports.filter(e => e.confidence === 'possibly-dynamic')

// Cycles : trouver les cycles qui contiennent ce fichier
const cycles = (snapshot.cycles ?? []).filter(c => c.files?.includes(relPath))

// Truth points : ce fichier participe-t-il à un truth-point (writer/reader/mirror) ?
// Note : tp.file n'existe PAS au niveau racine — la structure est
// { concept, canonical, writers: [{file, symbol, line}], readers, mirrors }.
// Découvert lors de l'audit auto-référentiel codegraph-on-codegraph.
const truthPointParticipations = []
for (const tp of (snapshot.truthPoints ?? [])) {
  const inWriters = (tp.writers ?? []).some((w) => w.file === relPath)
  const inReaders = (tp.readers ?? []).some((r) => r.file === relPath)
  const inMirrors = (tp.mirrors ?? []).some((m) => m.file === relPath)
  if (inWriters) truthPointParticipations.push({ concept: tp.concept, role: 'writer' })
  if (inReaders) truthPointParticipations.push({ concept: tp.concept, role: 'reader' })
  if (inMirrors) truthPointParticipations.push({ concept: tp.concept, role: 'mirror' })
}

// ─── Score de criticité (ranking Axon-style) ──────────────────────
// Plus le score est élevé, plus le fichier mérite attention. Détermine
// si on affiche un RISK header en tête + l'ordre des sections.

const isHub = inDegree >= 20
const isWriter = truthPointParticipations.some(p => p.role === 'writer')
const inCycle = cycles.length > 0
const hasManyMagic = (snapshot.magicNumbers ?? []).filter((m) => m.file === relPath).length >= 5
const hasLongFn = (snapshot.longFunctions ?? []).filter((f) => f.file === relPath).length > 0
const hasNoTest = !!(snapshot.testCoverage?.entries?.find((e) =>
  e.sourceFile === relPath && e.testFiles.length === 0,
))

// RISK score: 0-10. Au-delà de 3, on affiche un header explicite.
let riskScore = 0
if (isHub) riskScore += 4
if (isWriter) riskScore += 3
if (inCycle) riskScore += 3
if (hasLongFn) riskScore += 1
if (hasManyMagic) riskScore += 1
if (hasNoTest && (isHub || isWriter || inCycle)) riskScore += 1

// Build the message — sections ordonnées par criticité décroissante
const lines = []
lines.push(`📍 codegraph context : ${relPath}`)
lines.push('─────────────────────────────────────────────────────────────')

// RISK header — 1 ligne synthèse si le fichier est sensible
if (riskScore >= 3) {
  const flags = []
  if (isHub) flags.push(`hub (in:${inDegree})`)
  if (isWriter) flags.push('truth-point writer')
  if (inCycle) flags.push(`${cycles.length} cycle(s)`)
  lines.push(`  ⚠⚠ HIGH-RISK : ${flags.join(', ')} — modifs ont un blast radius`)
}

// ADR-028 — context statique (in/out/loc/importers/imports) : ONLY 1ère fois
// sur ce fichier dans la session. Aux hooks suivants, ces données n'ont pas
// changé entre 2 saves successifs (sauf refactor majeur structural) donc
// les répéter = bruit pur. Le RISK header reste affiché (signal fort).
if (isFirstTimeOnFile) {
  const degreeLine = `  in: ${inDegree}  out: ${outDegree}  loc: ${node.loc ?? '?'}`
  lines.push(degreeLine + (isHub ? '  ⚠ hub' : ''))

  if (inDegree > 0 && inDegree <= 30) {
    const top = importers.slice(0, 3).map(e => e.from)
    lines.push(`  importers (${Math.min(3, inDegree)}/${inDegree}): ${top.join(', ')}`)
  } else if (inDegree > 30) {
    lines.push(`  importers: ${inDegree} files (top hub — see brief)`)
  }

  if (outDegree >= 5) {
    const topImports = imports.slice(0, 3).map((e) => e.to)
    lines.push(`  imports (${Math.min(3, outDegree)}/${outDegree}): ${topImports.join(', ')}`)
  }
}

// ─── Section "Datalog NEW violations" (Tier 8 live gate) ───
// Invoque le script datalog-check-fast.mjs qui exec toutes les rules
// (mono + composites multi-relation) contre les facts live regeneres
// par le watcher. Output : JSON {elapsed, total, baseline, new,
// violations[]}. On affiche UNIQUEMENT les NEW (delta vs baseline
// post-commit) — les grandfathered restent silencieux.
//
// Latence ~70ms wall clock (mesure Sentinel). Skip si script absent
// ou timeout 3s atteint cote script.
try {
  const cp = require('node:child_process')
  // Resolve fast script via require.resolve (works after npm install).
  // Fallback : try node_modules direct path.
  let fastScript = null
  try {
    fastScript = require.resolve('@liby-tools/codegraph/scripts/datalog-check-fast.mjs', {
      paths: [repoRoot],
    })
  } catch {
    const candidate = path.join(repoRoot, 'node_modules/@liby-tools/codegraph/scripts/datalog-check-fast.mjs')
    if (fs.existsSync(candidate)) fastScript = candidate
  }
  if (fastScript) {
    const out = cp.execSync('node ' + fastScript + ' ' + repoRoot, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    const data = JSON.parse(out)
    const violations = data.violations || []
    const violationKey = (v) => v.adr + '|' + v.file + '|' + v.line
    const currentKeys = new Set(violations.map(violationKey))

    // ADR-028 — Snapshot 1ère fois dans la session : establish baseline.
    if (!Array.isArray(session.commitBaselineKeys)) {
      session.commitBaselineKeys = [...currentKeys].slice(0, 500)
    }
    const sessionBaseline = new Set(session.commitBaselineKeys)

    const newSinceSession = violations.filter(v => !sessionBaseline.has(violationKey(v)))
    const resolvedSinceSessionCount = [...sessionBaseline].filter(k => !currentKeys.has(k)).length
    const grandfatheredCount = violations.length - newSinceSession.length

    // Bucket 1 — NEW since session : full visibility (le signal qui corrige)
    if (newSinceSession.length > 0) {
      lines.push('  --- Datalog NEW (this session, ' + data.elapsed + 'ms) ---')
      for (const v of newSinceSession.slice(0, 5)) {
        const lineStr = v.line === 0 ? '' : ':' + v.line
        lines.push('    [' + v.adr + '] ' + v.file + lineStr + '  ' + v.msg)
        if (v.path) {
          const pathLines = v.path.split('\n').slice(0, 2)
          for (const p of pathLines) {
            if (p.trim().length > 0) lines.push('      ' + p.trim())
          }
        }
      }
      if (newSinceSession.length > 5) {
        lines.push('    (+' + (newSinceSession.length - 5) + ' more — codegraph datalog-check --diff)')
      }
    }

    // Bucket 2 — RESOLVED : signal positif (l'agent voit que son fix a marché)
    if (resolvedSinceSessionCount > 0) {
      lines.push('  ✓ ' + resolvedSinceSessionCount + ' violation(s) resolved this session')
    }

    // Bucket 3 — grandfathered overview : ONLY 1ère fois sur fichier
    if (isFirstTimeOnFile && grandfatheredCount > 0) {
      const byAdr = new Map()
      for (const v of violations) {
        if (sessionBaseline.has(violationKey(v))) {
          byAdr.set(v.adr, (byAdr.get(v.adr) ?? 0) + 1)
        }
      }
      const top = [...byAdr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      const summary = top.map(([adr, n]) => n + '× ' + adr).join(', ')
      const more = byAdr.size > 4 ? ', +' + (byAdr.size - 4) + ' rules' : ''
      lines.push('  · ' + grandfatheredCount + ' grandfathered : ' + summary + more)
    }
  }
} catch (err) {
  // Script absent / timeout / parse error — silent (ne bloque pas le hook).
}

// ─── Section "Drift signals" (patterns agentiques pour ce fichier) ───
// Lit snapshot.driftSignals (Phase 4 axe 4) — patterns ajoutes par
// agent plus que les humains : excessive-optional-params,
// wrapper-superfluous, todo-no-owner. RALENTIT au bon moment, ne
// bloque pas. Convention drift-ok sur ligne precedente supprime
// un signal.
try {
  const drift = (snapshot.driftSignals || []).filter((s) => s && s.file === relPath)
  if (drift.length > 0) {
    lines.push('  ─── Drift signals ('+drift.length+') ───')
    for (let i = 0; i < Math.min(5, drift.length); i++) {
      const s = drift[i]
      const sevTag = s.severity === 3 ? '⚠⚠ ' : s.severity === 2 ? '⚠ ' : ''
      lines.push('    '+sevTag+'['+s.kind+'] L'+s.line+' — '+s.message)
    }
    if (drift.length > 5) {
      lines.push('    (+'+(drift.length - 5)+' more — codegraph_drift pour le détail)')
    }
  }
} catch {
  // Snapshot sans driftSignals (ancien) — silent.
}

// ─── Section "Mémoire" (entrées inter-sessions pour ce fichier) ───
// Lit ~/.codegraph-toolkit/memory/<basename>-<hash8>.json — store local
// peuplé par `codegraph memory mark` ou `codegraph_memory_mark` MCP tool.
//
// Affiche les entrées non-obsolètes qui matchent CE fichier dans leur
// scope. C'est de la connaissance humaine codifiée — décisions, faux
// positifs marqués, fingerprints d'incidents — qui peuvent NUANCER ou
// ANNULER les signaux structurels qui suivent (ex: "ce truth-point est
// un FP marqué 2026-04-15"). À voir AVANT les sections automatiques.
//
// Logique de path dupliquée depuis @liby-tools/codegraph (memory/store.ts) —
// le toolkit est ESM-only, le hook est require()-based. Si memoryPathFor()
// change côté toolkit, sync ici. Format : <basename>-<sha256(absPath, 8)>
try {
  const os = require('node:os')
  const crypto = require('node:crypto')
  const memDir = path.join(os.homedir(), '.codegraph-toolkit', 'memory')
  const baseSan = (path.basename(repoRoot).replace(/[^A-Za-z0-9_-]/g, '_')) || 'root'
  const hash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)
  const memFile = path.join(memDir, `${baseSan}-${hash}.json`)
  if (fs.existsSync(memFile)) {
    const memStore = JSON.parse(fs.readFileSync(memFile, 'utf-8'))
    if (memStore && Array.isArray(memStore.entries)) {
      const matched = memStore.entries.filter((e) => {
        if (!e || e.obsoleteAt) return false
        if (e.scope && e.scope.file === relPath) return true
        if (e.scope && Array.isArray(e.scope.tags) && e.scope.tags.indexOf('always-show') !== -1) return true
        return false
      })
      if (matched.length > 0) {
        lines.push('  ─── Mémoire (sessions précédentes) ───')
        for (let i = 0; i < Math.min(5, matched.length); i++) {
          const e = matched[i]
          const reason = String(e.reason).split('\n')[0].slice(0, 80)
          lines.push('    [' + e.kind + '] ' + e.fingerprint)
          lines.push('      ' + reason)
        }
        if (matched.length > 5) {
          lines.push('    (+' + (matched.length - 5) + ' more — codegraph_memory_recall pour le détail)')
        }
      }
    }
  }
} catch {
  // Store inexistant / corrompu / autre erreur — silent.
}

// ─── Section "Risques structurels" (si signaux load-bearing) ───
const riskLines = []

if (truthPointParticipations.length > 0) {
  const byConcept = new Map()
  for (const p of truthPointParticipations) {
    if (!byConcept.has(p.concept)) byConcept.set(p.concept, new Set())
    byConcept.get(p.concept).add(p.role)
  }
  const summary = [...byConcept.entries()]
    .map(([c, roles]) => `${c} (${[...roles].join('/')})`)
    .join(', ')
  riskLines.push(`  📊 truth-point: ${summary} — schema-of-truth`)
}

if (cycles.length > 0) {
  riskLines.push(`  ⚠ participates in ${cycles.length} import cycle(s)`)
  const c = cycles[0]
  if (c.files && c.files.length <= 6) {
    riskLines.push(`    ${c.files.join(' → ')} → ${c.files[0]}`)
  }
}

if (riskLines.length > 0) {
  lines.push('  ─── Risques structurels ───')
  lines.push(...riskLines)
}

// ─── Section "Exports / API" (si problématiques) ───
// ADR-028 : ONLY 1ère fois sur fichier — analyse statique stable per file.
if (isFirstTimeOnFile && exports.length > 0 && problematic.length > 0) {
  const counts = []
  if (safeToRemove.length) counts.push(`${safeToRemove.length} safe-to-remove`)
  if (localOnly.length) counts.push(`${localOnly.length} local-only`)
  if (possiblyDynamic.length) counts.push(`${possiblyDynamic.length} possibly-dynamic`)
  lines.push('  ─── Exports problématiques ───')
  lines.push(`  exports: ${exports.length} total — ${counts.join(', ')}`)
  for (const ex of problematic.slice(0, 5)) {
    const reason = ex.reason ? ` — ${ex.reason.slice(0, 60)}${ex.reason.length > 60 ? '…' : ''}` : ''
    lines.push(`    L${ex.line} ${ex.name} [${ex.confidence}]${reason}`)
  }
}

// ─── Section "Dette / Refactor" ───
// ADR-028 : ONLY 1ère fois sur fichier — long fns + magic numbers + todos
// statiques per file. Pas besoin de répéter à chaque save.
const debtLines = []

const longFns = isFirstTimeOnFile
  ? (snapshot.longFunctions ?? []).filter((f) => f.file === relPath)
  : []
if (longFns.length > 0) {
  debtLines.push(`  ⚠ long functions: ${longFns.length} >100 LOC`)
  for (const f of longFns.slice(0, 3)) {
    debtLines.push(`    L${f.line} ${f.name} (${f.loc} LOC)`)
  }
}

const magic = isFirstTimeOnFile
  ? (snapshot.magicNumbers ?? []).filter((m) => m.file === relPath)
  : []
if (magic.length >= 5) {
  const byCat = new Map()
  for (const m of magic) byCat.set(m.category, (byCat.get(m.category) ?? 0) + 1)
  const summary = [...byCat.entries()].map(([c, n]) => `${n} ${c}`).join(', ')
  debtLines.push(`  🔢 magic numbers: ${magic.length} hardcoded (${summary}) — ADR-019?`)
}

const todos = isFirstTimeOnFile
  ? (snapshot.todos ?? []).filter((t) => t.file === relPath)
  : []
const fixmesAndHacks = todos.filter((t) => t.tag === 'FIXME' || t.tag === 'HACK')
// Show TODOs only si FIXME/HACK (signal fort) ou si pas d'autre signal de dette
if (fixmesAndHacks.length > 0 || (todos.length > 0 && debtLines.length === 0)) {
  const tagCounts = new Map()
  for (const t of todos) tagCounts.set(t.tag, (tagCounts.get(t.tag) ?? 0) + 1)
  const summary = [...tagCounts.entries()].map(([tag, n]) => `${n} ${tag}`).join(', ')
  debtLines.push(`  📝 markers: ${summary}`)
  // Surface FIXME/HACK in priority
  const sortedTodos = [...todos].sort((a, b) => {
    const order = { FIXME: 0, HACK: 1, TODO: 2, XXX: 3, NOTE: 4 }
    return (order[a.tag] ?? 5) - (order[b.tag] ?? 5)
  })
  for (const t of sortedTodos.slice(0, 3)) {
    const msg = t.message.length > 60 ? t.message.slice(0, 60) + '…' : t.message
    debtLines.push(`    L${t.line} [${t.tag}] ${msg}`)
  }
}

if (debtLines.length > 0) {
  lines.push('  ─── Dette / Refactor ───')
  lines.push(...debtLines)
}

// ─── Section "Tests" ───
// ADR-028 : ONLY 1ère fois sur fichier — couverture stable per file.
if (isFirstTimeOnFile && snapshot.testCoverage) {
  const entry = snapshot.testCoverage.entries.find((e) => e.sourceFile === relPath)
  if (entry && entry.testFiles.length === 0) {
    if (!relPath.includes('/tests/') && !relPath.includes('/scripts/')) {
      lines.push(`  🧪 no test — ajouter ${path.basename(relPath, '.ts')}.test.ts ?`)
    }
  } else if (entry && entry.testFiles.length > 0) {
    lines.push(`  🧪 ${entry.testFiles.length} test(s) [${entry.matchedBy.join(',')}]`)
  }
}

// ─── Section "Souvent modifié ensemble" (co-change) ───
// ADR-028 : ONLY 1ère fois sur fichier — co-change est stable per file.
if (isFirstTimeOnFile) try {
  const pairs = snapshot.coChangePairs ?? []
  const matches = pairs
    .filter((p) => p.from === relPath || p.to === relPath)
    .map((p) => ({
      other: p.from === relPath ? p.to : p.from,
      count: p.count,
      jaccard: p.jaccard,
    }))
    .sort((a,  b) => b.count - a.count || b.jaccard - a.jaccard)
    .slice(0, 3)
  if (matches.length > 0) {
    lines.push('  ─── Souvent modifié ensemble (90j) ───')
    for (const m of matches) {
      const j = m.jaccard.toFixed(2)
      lines.push(`    ${m.count}× (j=${j})  ${m.other}`)
    }
  }
} catch {
  // snapshot sans coChangePairs ou structure inattendue — silent
}

// ─── Section "Activité git récente" (archaeology) ───
// ADR-028 : ONLY 1ère fois sur fichier — git log stable dans une session.
if (isFirstTimeOnFile) try {
  const cp = require('node:child_process')
  const log = cp.execSync(
    `git log --no-merges --since="3.weeks.ago" --pretty=format:"%h %s" --abbrev-commit -- "${relPath}"`,
    { cwd: repoRoot, timeout: 800, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString().trim()
  if (log.length > 0) {
    const recentCommits = log.split('\n').slice(0, 3)
    if (recentCommits.length > 0) {
      lines.push('  ─── Activité récente (3 sem.) ───')
      for (const c of recentCommits) {
        const [hash, ...msgParts] = c.split(' ')
        const msg = msgParts.join(' ').slice(0, 70)
        lines.push(`    ${hash} ${msg}${msgParts.join(' ').length > 70 ? '…' : ''}`)
      }
      const totalCommits = log.split('\n').length
      if (totalCommits > 3) lines.push(`    (+${totalCommits - 3} more in 3 weeks)`)
    }
  }
} catch {
  // git log timeout / file not in repo / no git — silent
}

// ─── Section "Intent detection" via diff WIP ───
// Si le fichier a des changes WIP non-commitées, montre une synthèse
// pour orienter le contexte (renamed symbol? new export? bugfix line?).
try {
  const cp = require('node:child_process')
  const diffStat = cp.execSync(
    `git diff --stat -- "${relPath}"`,
    { cwd: repoRoot, timeout: 500, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).toString().trim()
  if (diffStat.length > 0) {
    // Extract `N insertions(+), M deletions(-)` summary
    const match = diffStat.match(/(\d+)\s+insertion[s]?\(\+\)?,?\s*(\d+)?\s*deletion/)
    if (match) {
      const ins = parseInt(match[1], 10)
      const del = parseInt(match[2] || '0', 10)
      const intent = ins > del * 3 ? 'add'
                   : del > ins * 3 ? 'remove'
                   : Math.abs(ins - del) < 5 ? 'tweak/rename'
                   : 'edit'
      lines.push(`  ✏ WIP: +${ins}/-${del} [${intent}] — non commité`)
    }
  }
} catch {
  // No git / no diff / timeout — silent
}

// Footer source : ONLY 1ère fois sur fichier
if (isFirstTimeOnFile) {
  lines.push('─────────────────────────────────────────────────────────────')
  lines.push(`  source: ${path.basename(snapshotPath)} (last commit)`)
}

// ADR-028 — sauvegarde du session manifest
session.seenFiles[relPath] = {
  firstSeenAt: fileState?.firstSeenAt ?? Date.now(),
}
try {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.writeFileSync(sessionPath, JSON.stringify(session))
} catch { /* persistence best-effort */ }

console.log(lines.join('\n'))
