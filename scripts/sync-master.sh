#!/usr/bin/env bash
# Léger : `git fetch` + alerte si master a avancé. Conçu pour SessionStart
# hook Claude Code (output va dans le contexte de session).
#
# Exit toujours 0 — un échec ne doit jamais bloquer le démarrage de session.
# Réseau capé via `timeout` pour ne pas faire traîner le start.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 0

# Skip si pas un git repo (sécurité)
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Fetch origin/master avec timeout — `timeout` est GNU (Linux), `gtimeout`
# est l'équivalent BSD/macOS via coreutils. Fallback à fetch nu si aucun
# des deux dispo (le fetch est <2s en pratique sur ce repo).
if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout 10"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout 10"
else
  TIMEOUT_CMD=""
fi

if ! $TIMEOUT_CMD git fetch origin master --quiet 2>/dev/null; then
  echo "ℹ️  sync-master: fetch failed (offline?). Skipping."
  exit 0
fi

LOCAL_MASTER=$(git rev-parse master 2>/dev/null || echo "missing")
REMOTE_MASTER=$(git rev-parse origin/master 2>/dev/null || echo "missing")
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")

if [ "$LOCAL_MASTER" = "missing" ] || [ "$REMOTE_MASTER" = "missing" ]; then
  exit 0
fi

# Master à jour
if [ "$LOCAL_MASTER" = "$REMOTE_MASTER" ]; then
  exit 0
fi

# Master a avancé sur origin
COMMITS_BEHIND=$(git rev-list --count "$LOCAL_MASTER..$REMOTE_MASTER" 2>/dev/null || echo "?")

echo "🔔 codegraph-toolkit master a avancé ($COMMITS_BEHIND commits sur origin/master)"
echo ""
echo "Nouveaux commits:"
git log --oneline --no-decorate "$LOCAL_MASTER..$REMOTE_MASTER" 2>/dev/null | head -10 | sed 's/^/  /'
echo ""

# Si on est sur master : rappel pull
if [ "$CURRENT_BRANCH" = "master" ]; then
  echo "→ Tu es sur master. Run: git pull --ff-only origin master"
  echo "  (ou: ./scripts/sync-toolkit.sh — pull + rebuild + relink)"
  exit 0
fi

# Sur une feature branch : check si elle est divergente de origin/master
if [ "$CURRENT_BRANCH" != "detached" ]; then
  COMMITS_DIVERGED=$(git rev-list --count "$REMOTE_MASTER..HEAD" 2>/dev/null || echo "?")
  COMMITS_BEHIND_BRANCH=$(git rev-list --count "HEAD..$REMOTE_MASTER" 2>/dev/null || echo "?")

  echo "→ Tu es sur \`$CURRENT_BRANCH\` ($COMMITS_DIVERGED commits ahead, $COMMITS_BEHIND_BRANCH behind master)"

  if [ "$COMMITS_BEHIND_BRANCH" != "0" ] && [ "$COMMITS_BEHIND_BRANCH" != "?" ]; then
    # Détecter overlap potentiel avec ton WIP : fichiers que master a touchés ET branche aussi
    COMMON_FILES=$(comm -12 \
      <(git diff --name-only "$REMOTE_MASTER...HEAD" 2>/dev/null | sort -u) \
      <(git diff --name-only "$LOCAL_MASTER..$REMOTE_MASTER" 2>/dev/null | sort -u))

    if [ -n "$COMMON_FILES" ]; then
      echo ""
      echo "⚠️  Conflit potentiel — fichiers modifiés sur les deux côtés:"
      echo "$COMMON_FILES" | head -8 | sed 's/^/    /'
      [ "$(echo "$COMMON_FILES" | wc -l)" -gt 8 ] && echo "    … +$(( $(echo "$COMMON_FILES" | wc -l) - 8 )) autres"
      echo ""
      echo "→ Considérer rebase préventif: git rebase origin/master"
    fi
  fi
fi

exit 0
