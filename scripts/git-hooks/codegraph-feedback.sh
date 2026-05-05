#!/bin/bash
# ============================================
# codegraph-feedback.sh — PostToolUse hook for Edit/Write/MultiEdit
# ============================================
# Configuré dans .claude/settings.json (PostToolUse). Reçoit le tool input
# en JSON sur stdin, extrait le file_path, lit le dernier snapshot codegraph
# (.codegraph/snapshot-*.json), et injecte un résumé du contexte du fichier
# édité dans la frame Claude via additionalContext.
#
# But : réduire les tool calls exploratoires (grep / Read) en donnant à
# Claude le contexte structurel du fichier qu'il vient de toucher.
# Le snapshot date du dernier commit (régénéré post-commit), pas du WIP —
# ce qui est OK car ce qu'on cherche c'est la "carte" architecturale, pas
# le diff WIP.
#
# Output : JSON Claude Code hook protocol :
#   {"hookSpecificOutput":{"hookEventName":"PostToolUse",
#                          "additionalContext":"..."}}
#
# Skip cas (silencieux, exit 0 sans output JSON):
#   - tool_input.file_path absent
#   - file_path hors repo, dans node_modules/, dist/, .codegraph/, docs/
#   - file_path n'est pas .ts/.tsx
#   - aucun snapshot codegraph (premier analyze pas encore fait)
#   - le fichier n'est pas dans le snapshot (orphelin / nouveau / out-of-scope)
#   - SKIP_CODEGRAPH_FEEDBACK=1 (debug)
#
# Latence : ~150ms (node startup + JSON parse 7MB + lookup). Acceptable
# en PostToolUse — l'output est asynchrone du POV de Claude (déjà reçu
# le résultat du tool, le hook ajoute juste du contexte pour le tour
# suivant).

set -e

if [ -n "$SKIP_CODEGRAPH_FEEDBACK" ]; then
  exit 0
fi

INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | grep -oE '"file_path":\s*"[^"]+"' | head -1 | sed 's/.*"file_path":\s*"\([^"]*\)".*/\1/')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Resolve REPO_ROOT dynamically from FILE_PATH (the file being edited).
# Walk up from FILE_PATH until we find a .git directory.
DIR=$(dirname "$FILE_PATH")
while [ "$DIR" != "/" ] && [ ! -d "$DIR/.git" ]; do
  DIR=$(dirname "$DIR")
done
if [ "$DIR" = "/" ]; then
  exit 0
fi
REPO_ROOT="$DIR"

case "$FILE_PATH" in
  *"/docs/"*|*"/node_modules/"*|*"/dist/"*|*".codegraph/"*|*"/scripts/"*|*"/.claude/"*) exit 0 ;;
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

RELATIVE="${FILE_PATH#$REPO_ROOT/}"

FEEDBACK=$(node --experimental-vm-modules - <<'NODE_SCRIPT' "$REPO_ROOT" "$RELATIVE"
const fs = require('node:fs')
const path = require('node:path')

const [, , repoRoot, relPath] = process.argv
const codegraphDir = path.join(repoRoot, '.codegraph')

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
    .sort((a, b) => b.mtime - a.mtime)
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
const truthPointParticipations: Array<{ concept: string; role: string }> = []
for (const tp of (snapshot.truthPoints ?? [])) {
  const inWriters = (tp.writers ?? []).some((w: any) => w.file === relPath)
  const inReaders = (tp.readers ?? []).some((r: any) => r.file === relPath)
  const inMirrors = (tp.mirrors ?? []).some((m: any) => m.file === relPath)
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
const hasManyMagic = (snapshot.magicNumbers ?? []).filter((m: any) => m.file === relPath).length >= 5
const hasLongFn = (snapshot.longFunctions ?? []).filter((f: any) => f.file === relPath).length > 0
const hasNoTest = !!(snapshot.testCoverage?.entries?.find((e: any) =>
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

// Stats de base (toujours)
const degreeLine = `  in: ${inDegree}  out: ${outDegree}  loc: ${node.loc ?? '?'}`
lines.push(degreeLine + (isHub ? '  ⚠ hub' : ''))

// Importers (si N modeste — sinon "see brief")
if (inDegree > 0 && inDegree <= 30) {
  const top = importers.slice(0, 3).map(e => e.from)
  lines.push(`  importers (${Math.min(3, inDegree)}/${inDegree}): ${top.join(', ')}`)
} else if (inDegree > 30) {
  lines.push(`  importers: ${inDegree} files (top hub — see brief)`)
}

// Out direction : ce dont CE fichier depend (signal de couplage outgoing)
// Affiche si out >= 5 : le fichier est tres couple en sortie. Sert a
// voir ce que cette modif POURRAIT casser en aval, pas l inverse qui est
// deja couvert par les importers.
if (outDegree >= 5) {
  const topImports = imports.slice(0, 3).map((e: any) => e.to)
  lines.push(`  imports (${Math.min(3, outDegree)}/${outDegree}): ${topImports.join(', ')}`)
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
    if (data.new > 0) {
      lines.push('  --- Datalog NEW violations (' + data.new + ' nouvelles vs baseline, ' + data.elapsed + 'ms) ---')
      for (const v of data.violations.slice(0, 8)) {
        const lineStr = v.line === 0 ? '' : ':' + v.line
        lines.push('    [' + v.adr + '] ' + v.file + lineStr)
        lines.push('      ' + v.msg)
        // Tier 12 : path proof tree affiche le POURQUOI (chaine de
        // derivation des facts). Limite a 4 lignes pour rester lisible.
        if (v.path) {
          const pathLines = v.path.split('\n').slice(0, 4)
          for (const p of pathLines) {
            if (p.trim().length > 0) lines.push('      ' + p)
          }
        }
      }
      if (data.violations.length > 8) {
        lines.push('    (+' + (data.violations.length - 8) + ' more)')
      }
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
const riskLines: string[] = []

if (truthPointParticipations.length > 0) {
  const byConcept = new Map<string, Set<string>>()
  for (const p of truthPointParticipations) {
    if (!byConcept.has(p.concept)) byConcept.set(p.concept, new Set())
    byConcept.get(p.concept)!.add(p.role)
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
if (exports.length > 0 && problematic.length > 0) {
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
const debtLines: string[] = []

const longFns = (snapshot.longFunctions ?? []).filter((f: any) => f.file === relPath)
if (longFns.length > 0) {
  debtLines.push(`  ⚠ long functions: ${longFns.length} >100 LOC`)
  for (const f of longFns.slice(0, 3)) {
    debtLines.push(`    L${f.line} ${f.name} (${f.loc} LOC)`)
  }
}

const magic = (snapshot.magicNumbers ?? []).filter((m: any) => m.file === relPath)
if (magic.length >= 5) {
  const byCat = new Map<string, number>()
  for (const m of magic) byCat.set(m.category, (byCat.get(m.category) ?? 0) + 1)
  const summary = [...byCat.entries()].map(([c, n]) => `${n} ${c}`).join(', ')
  debtLines.push(`  🔢 magic numbers: ${magic.length} hardcoded (${summary}) — ADR-019?`)
}

const todos = (snapshot.todos ?? []).filter((t: any) => t.file === relPath)
const fixmesAndHacks = todos.filter((t: any) => t.tag === 'FIXME' || t.tag === 'HACK')
// Show TODOs only si FIXME/HACK (signal fort) ou si pas d'autre signal de dette
if (fixmesAndHacks.length > 0 || (todos.length > 0 && debtLines.length === 0)) {
  const tagCounts = new Map<string, number>()
  for (const t of todos) tagCounts.set(t.tag, (tagCounts.get(t.tag) ?? 0) + 1)
  const summary = [...tagCounts.entries()].map(([tag, n]) => `${n} ${tag}`).join(', ')
  debtLines.push(`  📝 markers: ${summary}`)
  // Surface FIXME/HACK in priority
  const sortedTodos = [...todos].sort((a: any, b: any) => {
    const order = { FIXME: 0, HACK: 1, TODO: 2, XXX: 3, NOTE: 4 }
    return (order[a.tag as keyof typeof order] ?? 5) - (order[b.tag as keyof typeof order] ?? 5)
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
if (snapshot.testCoverage) {
  const entry = snapshot.testCoverage.entries.find((e: any) => e.sourceFile === relPath)
  if (entry && entry.testFiles.length === 0) {
    if (!relPath.includes('/tests/') && !relPath.includes('/scripts/')) {
      lines.push(`  🧪 no test — ajouter ${path.basename(relPath, '.ts')}.test.ts ?`)
    }
  } else if (entry && entry.testFiles.length > 0) {
    lines.push(`  🧪 ${entry.testFiles.length} test(s) [${entry.matchedBy.join(',')}]`)
  }
}

// ─── Section "Souvent modifié ensemble" (co-change) ───
// Lit snapshot.coChangePairs (extracteur co-change, axe 2). Affiche
// les top-3 paires touchant ce fichier avec count >= 3.
try {
  const pairs = snapshot.coChangePairs ?? []
  const matches = pairs
    .filter((p) => p.from === relPath || p.to === relPath)
    .map((p) => ({
      other: p.from === relPath ? p.to : p.from,
      count: p.count,
      jaccard: p.jaccard,
    }))
    .sort((a, b) => b.count - a.count || b.jaccard - a.jaccard)
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
// Pas via commande externe synchrone bloquante : on a déjà commitMessage
// dans le snapshot. Pour le détail on lit `.codegraph/activity-cache.json`
// si présent (généré par un sub-script optionnel) — sinon on skip.
//
// Version inline simple : utilise child_process.execSync sur git log avec
// timeout court. Donne 3 lignes max.
try {
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

lines.push('─────────────────────────────────────────────────────────────')
lines.push(`  source: ${path.basename(snapshotPath)} (last commit)`)

console.log(lines.join('\n'))
NODE_SCRIPT
)

if [ -z "$FEEDBACK" ]; then
  exit 0
fi

# ─── Déduplication par hash sur fenêtre 5 min ──────────────────────────
# Le feedback complet (importers, NEW violations, exports, co-change…)
# fait ~2k tokens et ne change PAS entre éditions consécutives du même
# fichier dans le même run agent. Sur une session avec 5+ edits sur
# analyzer.ts, c'est ~10k tokens de bruit identique.
#
# Stratégie : SHA du payload + timestamp. Si même hash dans les 5 min,
# on remplace par un stub "(unchanged)". Le 1er run du fichier voit le
# blob complet ; les suivants ne reçoivent qu'une ligne de marqueur.
#
# Cache : .codegraph/.hook-cache/<sha8>.hash → "<full_sha> <epoch_s>".
CACHE_DIR="$REPO_ROOT/.codegraph/.hook-cache"
mkdir -p "$CACHE_DIR" 2>/dev/null || true

REL_HASH=$(printf '%s' "$RELATIVE" | shasum | cut -c1-12)
CACHE_FILE="$CACHE_DIR/$REL_HASH.hash"

# Hash sur version normalisée : strip les valeurs variables qui changent
# run-to-run sans refléter de changement structurel.
#   - Timings ms : `220ms` → `Nms`
#   - WIP counts : `+128/-10` → `+N/-N` (le marker "WIP" reste visible
#     pour signal qualitatif, mais le compteur exact ne déclenche pas
#     un re-render à chaque edit)
NORMALIZED=$(printf '%s' "$FEEDBACK" | sed -E '
  s/[0-9]+ms/Nms/g
  s/[0-9]+\.[0-9]+ms/Nms/g
  s/\+[0-9]+\/-[0-9]+/+N\/-N/g
')
NEW_HASH=$(printf '%s' "$NORMALIZED" | shasum | cut -c1-40)
NOW=$(date +%s)
DEDUP_TTL=${CODEGRAPH_FEEDBACK_TTL:-300}

if [ -f "$CACHE_FILE" ]; then
  OLD_LINE=$(cat "$CACHE_FILE" 2>/dev/null || true)
  OLD_HASH=$(printf '%s' "$OLD_LINE" | awk '{print $1}')
  OLD_TS=$(printf '%s' "$OLD_LINE" | awk '{print $2}')
  if [ -n "$OLD_TS" ] && [ "$NEW_HASH" = "$OLD_HASH" ]; then
    AGE=$((NOW - OLD_TS))
    if [ "$AGE" -lt "$DEDUP_TTL" ]; then
      FEEDBACK="📍 codegraph context : $RELATIVE (unchanged since ${AGE}s ago — codegraph_feedback dedup)"
    fi
  fi
fi
printf '%s %s\n' "$NEW_HASH" "$NOW" > "$CACHE_FILE"

python3 -c '
import json, sys
ctx = sys.stdin.read()
print(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": ctx
  }
}))
' <<< "$FEEDBACK"

exit 0
