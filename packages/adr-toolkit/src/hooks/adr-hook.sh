#!/bin/bash
# ============================================
# adr-hook.sh — Claude Code PreToolUse hook for Edit/Write/MultiEdit
# ============================================
# Generic version (paramétré via env) — installé par `npx @liby-tools/adr-toolkit init`.
#
# Reçoit le tool input en JSON sur stdin (Claude Code hook protocol), extrait
# `file_path`, lance le linker `@liby-tools/adr-toolkit`, injecte les ADRs liés en
# `additionalContext` (vu par le modèle AVANT l'edit).
#
# Sans ce hook, l'agent peut Edit un fichier gouverné par un ADR sans avoir
# lu la règle. Avec : il voit une ⓘ ADR check juste avant le Edit.
#
# Output JSON Claude Code hook protocol :
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#                          "permissionDecision":"allow",
#                          "additionalContext":"..."}}
#
# Skip silencieux (exit 0 sans output) si :
#   - file_path absent
#   - file_path hors $ADR_TOOLKIT_REPO_ROOT
#   - file_path dans docs/archive/, node_modules/, dist/, .codegraph/
#   - aucun ADR ne match
#   - SKIP_ADR_HOOK=1 (debug)
#
# Variables d'environnement :
#   ADR_TOOLKIT_REPO_ROOT  Racine du projet (default: $PWD au moment de l'install)

set -e

if [ -n "$SKIP_ADR_HOOK" ]; then
  exit 0
fi

# Source nvm pour avoir Node ≥ 22 (vitest 4 + tsx). Sans ça, le hook tourne
# avec le node de login shell (souvent v20) et tsx pète silencieusement.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use --silent >/dev/null 2>&1 || true

INPUT=$(cat)

# Extract file_path via grep (no jq dependency).
FILE_PATH=$(echo "$INPUT" | grep -oE '"file_path":\s*"[^"]+"' | head -1 | sed 's/.*"file_path":\s*"\([^"]*\)".*/\1/')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

REPO_ROOT="${ADR_TOOLKIT_REPO_ROOT:-$PWD}"
case "$FILE_PATH" in
  "$REPO_ROOT"/*) ;;
  *) exit 0 ;;
esac

case "$FILE_PATH" in
  *"/docs/archive/"*|*"/node_modules/"*|*"/dist/"*|*".codegraph/"*) exit 0 ;;
esac

RELATIVE="${FILE_PATH#$REPO_ROOT/}"
LINKER_OUTPUT=$(cd "$REPO_ROOT" && npx @liby-tools/adr-toolkit linker "$RELATIVE" 2>/dev/null || true)

if [ -z "$LINKER_OUTPUT" ] || echo "$LINKER_OUTPUT" | grep -q "No ADR mentions"; then
  exit 0
fi

CONTEXT_TEXT="📋 ADR check : $RELATIVE
─────────────────────────────────────────────────────────────
$LINKER_OUTPUT
─────────────────────────────────────────────────────────────"

python3 -c '
import json, sys
ctx = sys.stdin.read()
print(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": ctx
  }
}))
' <<< "$CONTEXT_TEXT"

exit 0
