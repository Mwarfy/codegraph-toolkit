/**
 * codegraph_recent(path, weeks) — git archaeology programmatique.
 *
 * Plus riche que la section du hook PostToolUse : retourne aussi le top
 * contributeur, l'âge du fichier, le pattern de changements (concentré
 * vs dispersé).
 */

import { execSync } from 'node:child_process'
import * as path from 'node:path'

export interface RecentArgs {
  file_path: string
  repo_root?: string
  /** Default 4 weeks. */
  weeks?: number
}

export function codegraphRecent(args: RecentArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const weeks = args.weeks ?? 4
  const relPath = path.isAbsolute(args.file_path)
    ? path.relative(repoRoot, args.file_path).replace(/\\/g, '/')
    : args.file_path.replace(/\\/g, '/')

  let log = ''
  try {
    log = execSync(
      `git log --no-merges --since="${weeks}.weeks.ago" --pretty=format:"%h|%an|%ar|%s" -- "${relPath}"`,
      { cwd: repoRoot, timeout: 2000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim()
  } catch {
    return { content: `git log failed for ${relPath} — not a git repo or path invalid.` }
  }

  if (!log) {
    return { content: `No commits touched ${relPath} in the last ${weeks} weeks.` }
  }

  const commits = log.split('\n').map(line => {
    const [hash, author, when, ...subjectParts] = line.split('|')
    return { hash, author, when, subject: subjectParts.join('|') }
  })

  // Top contributor
  const byAuthor = new Map<string, number>()
  for (const c of commits) byAuthor.set(c.author, (byAuthor.get(c.author) ?? 0) + 1)
  const topAuthor = [...byAuthor.entries()].sort((a, b) => b[1] - a[1])[0]

  // Age (first commit ever for this file)
  let firstCommitDate = ''
  try {
    firstCommitDate = execSync(
      `git log --diff-filter=A --pretty=format:"%ar" --reverse -- "${relPath}" | head -1`,
      { cwd: repoRoot, timeout: 1000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim()
  } catch {}

  const lines: string[] = []
  lines.push(`📅 git activity for ${relPath} (last ${weeks} weeks):`)
  lines.push(`   ${commits.length} commit(s), top author: ${topAuthor[0]} (${topAuthor[1]} commits)`)
  if (firstCommitDate) lines.push(`   File created: ${firstCommitDate}`)

  lines.push('\n## Recent commits')
  for (const c of commits.slice(0, 10)) {
    const subj = c.subject.length > 70 ? c.subject.slice(0, 70) + '…' : c.subject
    lines.push(`  ${c.hash} ${c.when.padEnd(15)} ${subj}`)
  }
  if (commits.length > 10) {
    lines.push(`  ... +${commits.length - 10} more`)
  }

  return { content: lines.join('\n') }
}
