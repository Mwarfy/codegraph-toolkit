#!/bin/bash
# ─── scaffold-salsa.sh ───
#
# Génère un fichier `packages/codegraph/src/incremental/<name>.ts` à partir
# d'un détecteur existant `packages/codegraph/src/extractors/<name>.ts`.
# Vérifie que le détecteur expose un per-file bundle (pattern ADR-005),
# génère un wrapper Salsa minimal selon ADR-007.
#
# Usage : ./scripts/scaffold-salsa.sh code-quality-patterns
#
# Le script :
#   1. Vérifie que extractors/<name>.ts existe et expose un
#      `extract<X>FileBundle` function.
#   2. Vérifie qu'il n'existe pas déjà incremental/<name>.ts.
#   3. Génère le squelette Salsa avec TODO markers où l'humain doit
#      compléter les détails.
#   4. Imprime les next steps : wire dans analyzer.ts + run probe.

set -e

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "Usage: $0 <detector-name>"
  echo "Example: $0 code-quality-patterns"
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
EXTRACTOR="$REPO_ROOT/packages/codegraph/src/extractors/$NAME.ts"
TARGET="$REPO_ROOT/packages/codegraph/src/incremental/$NAME.ts"

if [ ! -f "$EXTRACTOR" ]; then
  echo "✗ Extractor not found: $EXTRACTOR"
  echo "  Available extractors :"
  ls "$REPO_ROOT/packages/codegraph/src/extractors/" | grep '\.ts$' | sed 's/^/    /'
  exit 1
fi

if [ -f "$TARGET" ]; then
  echo "✗ Salsa wrapper already exists: $TARGET"
  echo "  If you want to regenerate, rm it first."
  exit 1
fi

# Detect bundle function name (camelCase from kebab-case)
PASCAL="$(echo "$NAME" | awk -F'-' '{for(i=1;i<=NF;i++){printf("%s%s", toupper(substr($i,1,1)), substr($i,2))}}')"
BUNDLE_FN="extract${PASCAL}FileBundle"

if ! grep -q "export function $BUNDLE_FN" "$EXTRACTOR"; then
  echo "✗ Extractor doesn't expose '$BUNDLE_FN' (per-file bundle)"
  echo "  ADR-005 : tout détecteur doit exposer un helper per-file."
  echo "  Refactor le détecteur d'abord :"
  echo "    export function $BUNDLE_FN(sf: SourceFile, relPath: string, ...): Bundle"
  exit 1
fi

CAMEL="$(echo "$NAME" | awk -F'-' '{printf("%s", $1); for(i=2;i<=NF;i++){printf("%s%s", toupper(substr($i,1,1)), substr($i,2))}}')"

cat > "$TARGET" <<EOF
// ADR-007
/**
 * Incremental $NAME — Salsa wrapper around the per-file scan.
 *
 * Auto-scaffolded by scripts/scaffold-salsa.sh on $(date -u +%Y-%m-%d).
 * TODO : compléter les sections marquées // SCAFFOLD-TODO ci-dessous.
 *
 * Self-optim discovery : ce détecteur est sorti des candidats math
 * (λ_lyap ≈ 1, mean ≥ 200ms warm). Salsa-isation attendue : cache hit
 * ~99% sur warm runs.
 */

import { derived } from '@liby-tools/salsa'
import {
  $BUNDLE_FN,
  // SCAFFOLD-TODO : importe les types Bundle / Aggregated du détecteur
  // type ${PASCAL}FileBundle,
  // type ${PASCAL}Aggregated,
} from '../extractors/$NAME.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

// SCAFFOLD-TODO : remplace 'unknown' par le bon type bundle
export const ${CAMEL}OfFile = derived<string, unknown>(
  db,
  '${CAMEL}OfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) {
      // SCAFFOLD-TODO : retourner un Bundle vide structurellement valide
      return {}
    }
    return $BUNDLE_FN(sf, filePath /* SCAFFOLD-TODO : extra args si requis */)
  },
)

// SCAFFOLD-TODO : agrégateur final — collecte tous les per-file bundles,
// fusionne, applique le tri lex déterministe.
export const all${PASCAL} = derived<string, unknown>(
  db,
  'all${PASCAL}',
  (label) => {
    const files = projectFiles.get(label)
    // SCAFFOLD-TODO : initialise out + accumule
    const out: unknown = {}
    for (const f of files) {
      const _bundle = ${CAMEL}OfFile.get(f)
      // SCAFFOLD-TODO : merge _bundle dans out
      void _bundle
    }
    // SCAFFOLD-TODO : tri lex déterministe par (file, line)
    return out
  },
)
EOF

echo "✓ Scaffold généré : $TARGET"
echo
echo "Next steps :"
echo "  1. Compléter les sections // SCAFFOLD-TODO (types, agrégation, tri)."
echo "  2. Wire dans packages/codegraph/src/core/analyzer.ts :"
echo "       import { all${PASCAL} as incAll${PASCAL} } from '../incremental/$NAME.js'"
echo "       const $CAMEL = await runDetectorTimed(timing, '$NAME',"
echo "         () => incremental"
echo "           ? Promise.resolve(incAll${PASCAL}.get('all'))"
echo "           : analyze${PASCAL}(...))"
echo "  3. npx tsc -b && npx vitest run"
echo "  4. LIBY_PROBE_RUNS=4 npx tsx scripts/self-runtime-probe.ts"
echo "     → confirmer que λ_lyap a explosé (cliff = cache fonctionne)"
echo "  5. Commit : 'perf: Salsa-isolate $NAME (self-optim discovered)'"
