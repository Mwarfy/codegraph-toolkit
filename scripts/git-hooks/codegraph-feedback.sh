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

# ADR-028 — Délégation à .mjs pour permettre session-state + clean syntax.
# Le heredoc bash 3.2 ne tolère pas les TS annotations + nested generics du
# code embedded ; extract en .mjs résout les 2.
IMPL="$REPO_ROOT/scripts/git-hooks/codegraph-feedback-impl.mjs"
if [ ! -f "$IMPL" ]; then
  exit 0
fi
FEEDBACK=$(node "$IMPL" "$REPO_ROOT" "$RELATIVE" 2>/dev/null)

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
