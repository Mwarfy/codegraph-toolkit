/**
 * codegraph_changes_since(reference?) — diff structurel entre l'état
 * courant (snapshot-live.json si watcher actif, sinon dernier
 * snapshot post-commit) et une référence.
 *
 * Référence par défaut = "dernier post-commit" (le snapshot
 * `snapshot-2026-...-COMMIT.json` le plus récent qui n'est PAS
 * snapshot-live.json). Permet de répondre "depuis le dernier commit,
 * qu'est-ce que mes edits en cours ont changé structurellement ?".
 *
 * Output : markdown court (les changements détectés via
 * `buildStructuralDiff`). Cf. axe B4 du plan d'enrichissement.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  buildStructuralDiff,
  renderStructuralDiffMarkdown,
} from '@liby-tools/codegraph/diff'

export interface ChangesSinceArgs {
  /**
   * Référence à diff against. Trois formes acceptées :
   *   - undefined / "post-commit" : dernier snapshot post-commit (default)
   *   - chemin absolu vers un snapshot JSON
   *   - "live" : seulement comparer si snapshot-live existe (sinon empty diff)
   */
  reference?: string
  repo_root?: string
}

export function codegraphChangesSince(args: ChangesSinceArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const codegraphDir = path.join(repoRoot, '.codegraph')

  // Trouve les snapshots disponibles + leurs mtime
  let files: Array<{ path: string; name: string; mtime: number; isLive: boolean }>
  try {
    files = fs.readdirSync(codegraphDir)
      .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
      .map((f) => {
        const p = path.join(codegraphDir, f)
        return {
          path: p,
          name: f,
          mtime: fs.statSync(p).mtimeMs,
          isLive: f === 'snapshot-live.json',
        }
      })
  } catch {
    return { content: 'No .codegraph directory. Run `npx codegraph analyze` first.' }
  }

  if (files.length === 0) {
    return { content: 'No snapshots found in .codegraph/.' }
  }

  // Current = freshest (snapshot-live.json si watcher actif, sinon le plus
  // récent post-commit)
  files.sort((a, b) => b.mtime - a.mtime)
  const current = files[0]

  // Reference par défaut = dernier post-commit (= le plus récent qui
  // n'est PAS snapshot-live.json). Si l'utilisateur passe une autre ref,
  // on cherche par nom ou par path absolu.
  let referencePath: string | undefined
  if (!args.reference || args.reference === 'post-commit') {
    const postCommit = files.find((f) => !f.isLive)
    if (!postCommit) {
      return {
        content:
          'No post-commit snapshot found (only snapshot-live.json present). ' +
          'Commit current state first to establish a reference, or pass an explicit reference path.',
      }
    }
    if (postCommit.path === current.path) {
      return {
        content:
          'Current snapshot IS the latest post-commit (no watcher running, ' +
          'or no edits since last analyze). Nothing to diff.',
      }
    }
    referencePath = postCommit.path
  } else if (args.reference === 'live') {
    const live = files.find((f) => f.isLive)
    if (!live || live.path === current.path) {
      return {
        content: 'Reference "live" but no live snapshot exists or it equals current.',
      }
    }
    referencePath = live.path
  } else if (path.isAbsolute(args.reference) || args.reference.endsWith('.json')) {
    referencePath = path.isAbsolute(args.reference)
      ? args.reference
      : path.join(codegraphDir, args.reference)
  } else {
    return { content: `Unknown reference: ${args.reference}` }
  }

  // Load both snapshots
  let before: any, after: any
  try {
    before = JSON.parse(fs.readFileSync(referencePath!, 'utf-8'))
    after = JSON.parse(fs.readFileSync(current.path, 'utf-8'))
  } catch (err) {
    return { content: `Failed to load snapshots: ${err instanceof Error ? err.message : err}` }
  }

  const diff = buildStructuralDiff(before, after)
  const md = renderStructuralDiffMarkdown(diff)

  // Header explicite : indique ce qu'on diff vs quoi
  const refLabel = current.isLive
    ? `live (uncommitted edits)`
    : `current snapshot ${current.name}`
  const beforeLabel = path.basename(referencePath!)
  const header = `# Changes since ${beforeLabel}\n\n_Diff: \`${beforeLabel}\` → \`${refLabel}\`_\n\n`

  return { content: header + md }
}
