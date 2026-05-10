#!/bin/bash
# ADR-027 — .codegraph/snapshot-*.json ne s'accumulent plus.
# Garde les N plus récents (default 3, override via MAX_SNAPSHOTS env var).
# Le déterminisme du pipeline garantit qu'à tout moment, `git checkout <sha> &&
# codegraph analyze` reproduit le snapshot de ce commit. Pas besoin d'archive.

set -e

GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || echo "")"
if [ -z "$GIT_COMMON_DIR" ]; then exit 0; fi
REPO_ROOT="$(cd "$GIT_COMMON_DIR/.." && pwd)"
SNAPSHOT_DIR="$REPO_ROOT/.codegraph"

if [ ! -d "$SNAPSHOT_DIR" ]; then exit 0; fi

MAX="${MAX_SNAPSHOTS:-3}"

# Liste triée chronologiquement (le nom contient le timestamp ISO).
# Compatible bash 3.2 (macOS) — pas de mapfile.
COUNT=$(find "$SNAPSHOT_DIR" -maxdepth 1 -name 'snapshot-*.json' -type f | wc -l | tr -d ' ')

if [ "$COUNT" -le "$MAX" ]; then exit 0; fi

TO_DELETE="$((COUNT - MAX))"
find "$SNAPSHOT_DIR" -maxdepth 1 -name 'snapshot-*.json' -type f | sort | head -n "$TO_DELETE" | while read -r f; do
  rm -f "$f"
done

echo -e "\033[0;32m  prune\033[0m ✓ $TO_DELETE old snapshot(s) removed (kept $MAX)"
