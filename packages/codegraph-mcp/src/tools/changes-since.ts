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

interface SnapshotEntry { path: string; name: string; mtime: number; isLive: boolean }

export function codegraphChangesSince(args: ChangesSinceArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const codegraphDir = path.join(repoRoot, '.codegraph')

  const filesOrError = listSnapshotFiles(codegraphDir)
  if (typeof filesOrError === 'string') return { content: filesOrError }
  const files = filesOrError

  // Current = freshest (snapshot-live.json si watcher actif, sinon le plus
  // récent post-commit).
  files.sort((a, b) => b.mtime - a.mtime)
  const current = files[0]

  const refResult = resolveReferencePath(args.reference, files, current, codegraphDir)
  if (typeof refResult === 'string') return { content: refResult }
  const referencePath = refResult

  const snapshotsOrError = loadSnapshots(referencePath, current.path)
  if (typeof snapshotsOrError === 'string') return { content: snapshotsOrError }
  const { before, after } = snapshotsOrError

  const diff = buildStructuralDiff(before, after)
  const md = renderStructuralDiffMarkdown(diff)
  return { content: buildDiffHeader(current, referencePath) + md }
}

/** Read .codegraph dir → snapshot entries OR return user-friendly error string. */
function listSnapshotFiles(codegraphDir: string): SnapshotEntry[] | string {
  let names: string[]
  try {
    names = fs.readdirSync(codegraphDir).filter(
      (f) => f.startsWith('snapshot-') && f.endsWith('.json'),
    )
  } catch {
    return 'No .codegraph directory. Run `npx codegraph analyze` first.'
  }
  if (names.length === 0) return 'No snapshots found in .codegraph/.'
  return names.map((f) => {
    const p = path.join(codegraphDir, f)
    return {
      path: p,
      name: f,
      mtime: fs.statSync(p).mtimeMs,
      isLive: f === 'snapshot-live.json',
    }
  })
}

/**
 * Reference par défaut = dernier post-commit (= le plus récent qui n'est PAS
 * snapshot-live.json). Si l'utilisateur passe une autre ref, on cherche par
 * nom ou par path absolu. Returns string error si pas trouvable.
 */
function resolveReferencePath(
  reference: string | undefined,
  files: SnapshotEntry[],
  current: SnapshotEntry,
  codegraphDir: string,
): string {
  if (!reference || reference === 'post-commit') {
    return resolvePostCommitRef(files, current)
  }
  if (reference === 'live') {
    return resolveLiveRef(files, current)
  }
  if (path.isAbsolute(reference) || reference.endsWith('.json')) {
    return path.isAbsolute(reference) ? reference : path.join(codegraphDir, reference)
  }
  return `Unknown reference: ${reference}`
}

function resolvePostCommitRef(files: SnapshotEntry[], current: SnapshotEntry): string {
  const postCommit = files.find((f) => !f.isLive)
  if (!postCommit) {
    return 'No post-commit snapshot found (only snapshot-live.json present). ' +
      'Commit current state first to establish a reference, or pass an explicit reference path.'
  }
  if (postCommit.path === current.path) {
    return 'Current snapshot IS the latest post-commit (no watcher running, ' +
      'or no edits since last analyze). Nothing to diff.'
  }
  return postCommit.path
}

function resolveLiveRef(files: SnapshotEntry[], current: SnapshotEntry): string {
  const live = files.find((f) => f.isLive)
  if (!live || live.path === current.path) {
    return 'Reference "live" but no live snapshot exists or it equals current.'
  }
  return live.path
}

function loadSnapshots(
  referencePath: string,
  currentPath: string,
): { before: any; after: any } | string {
  // Si referencePath n'est pas un path (= un message d'erreur en string), on
  // l'a déjà court-circuité plus haut. Mais on garde un guard try/catch ici
  // au cas où le fichier n'existerait plus entre listing + read.
  try {
    return {
      before: JSON.parse(fs.readFileSync(referencePath, 'utf-8')),
      after: JSON.parse(fs.readFileSync(currentPath, 'utf-8')),
    }
  } catch (err) {
    return `Failed to load snapshots: ${err instanceof Error ? err.message : err}`
  }
}

function buildDiffHeader(current: SnapshotEntry, referencePath: string): string {
  const refLabel = current.isLive
    ? 'live (uncommitted edits)'
    : `current snapshot ${current.name}`
  const beforeLabel = path.basename(referencePath)
  return `# Changes since ${beforeLabel}\n\n_Diff: \`${beforeLabel}\` → \`${refLabel}\`_\n\n`
}
