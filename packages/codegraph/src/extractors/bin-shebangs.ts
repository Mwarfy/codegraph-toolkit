/**
 * Bin Shebangs Extractor — détecte les bin scripts package.json sans shebang
 * (ou cible introuvable).
 *
 * Pourquoi : npm publish auto-corrige et supprime silencieusement les entrées
 * `bin` dont le fichier cible n'a pas de shebang `#!/usr/bin/env node` (ou
 * variante). Le warning passe inaperçu dans le log de publish, et le package
 * est livré avec le bin manquant — `npx @scope/pkg` échoue côté consumer.
 * Cas vécu codegraph-toolkit 0.3.0 : 5 bins stripped à la publication.
 *
 * Granularité : 1 issue par bin entry (pas par package), pour permettre des
 * fixes ciblés et une tension "BIN-NO-SHEBANG package#binName".
 *
 * Trois kinds :
 *   - `missing-shebang`   : fichier existe mais 1ère ligne n'est pas un shebang.
 *                           Cause typique : oublié `#!/usr/bin/env node` en
 *                           tête du source (le compilateur TS ne l'ajoute pas).
 *   - `bin-target-missing`: déclaré mais le fichier n'existe pas sur disque.
 *                           Cause typique : oublié `npm run build` avant
 *                           publish OU mauvais chemin (`dist/cli.js` au lieu
 *                           de `dist/cli/index.js`). False-positive possible
 *                           si l'analyse tourne avant un build — accepté car
 *                           le fix (build) est trivial.
 *   - `wrong-shebang`     : 1ère ligne est un shebang mais ne pointe pas
 *                           vers node (ex: bash, python). Très rare en TS
 *                           projects, signal utile si typo.
 *
 * Limitations v1 :
 *   - Workspaces npm/yarn/pnpm non résolus — chaque package.json découvert
 *     est traité indépendamment.
 *   - Si `bin` est une string et le `package.json` n'a pas de `name`, on
 *     skip (cas pathologique, pas de clé pour reporter).
 *   - Ne valide pas le mode exécutable (chmod +x). Sur Windows c'est nop ;
 *     sur Unix npm publish ajoute le bit ; signal pas worth pour v1.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { BinShebangIssue, BinShebangIssueKind } from '../core/types.js'

const PKG_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  'coverage', '.turbo', '.cache',
])

const NODE_SHEBANG_PATTERNS = [
  /^#!\s*\/usr\/bin\/env\s+node(\s|$)/,
  /^#!\s*\/usr\/bin\/node(\s|$)/,
  /^#!\s*\/usr\/local\/bin\/node(\s|$)/,
]

export async function analyzeBinShebangs(rootDir: string): Promise<BinShebangIssue[]> {
  const manifests: Array<{ abs: string; dir: string; rel: string; raw: any }> = []
  await walkForManifests(rootDir, rootDir, manifests)

  const issues: BinShebangIssue[] = []
  for (const m of manifests) {
    const bins = normalizeBin(m.raw)
    if (bins.length === 0) continue
    for (const { name, target } of bins) {
      const issue = await checkBinEntry(rootDir, m, name, target)
      if (issue) issues.push(issue)
    }
  }
  issues.sort((a, b) => {
    if (a.packageJson !== b.packageJson) return a.packageJson.localeCompare(b.packageJson)
    return a.binName.localeCompare(b.binName)
  })
  return issues
}

/**
 * Normalise le champ `bin` de package.json en `[{name, target}]`.
 *
 *   - `bin: "dist/cli.js"`            → [{name: pkg.name, target: 'dist/cli.js'}]
 *   - `bin: { foo: "dist/foo.js" }`   → [{name: 'foo', target: 'dist/foo.js'}]
 *   - autre / absent                  → []
 */
function normalizeBin(raw: any): Array<{ name: string; target: string }> {
  const bin = raw?.bin
  if (!bin) return []
  if (typeof bin === 'string') {
    const name = typeof raw.name === 'string' ? unscope(raw.name) : null
    if (!name) return []
    return [{ name, target: bin }]
  }
  if (typeof bin === 'object') {
    const out: Array<{ name: string; target: string }> = []
    for (const [name, target] of Object.entries(bin)) {
      if (typeof target === 'string') out.push({ name, target })
    }
    return out
  }
  return []
}

/** `@scope/pkg` → `pkg`. Le bin name effectif quand `bin` est une string. */
function unscope(packageName: string): string {
  const slash = packageName.indexOf('/')
  return slash === -1 ? packageName : packageName.slice(slash + 1)
}

async function checkBinEntry(
  rootDir: string,
  manifest: { abs: string; dir: string; rel: string },
  binName: string,
  target: string,
): Promise<BinShebangIssue | null> {
  const targetAbs = path.resolve(manifest.dir, target)
  const targetRel = path.relative(rootDir, targetAbs).replace(/\\/g, '/')

  // Path leading-dot check : npm warn publish errors corrected. Précédence
  // sur missing-shebang — c'est le 1er truc à fixer dans le package.json,
  // indépendant du contenu du fichier.
  if (target.startsWith('./')) {
    return makeIssue('bin-path-leading-dot', manifest.rel, binName, target, targetRel)
  }

  let firstLine: string
  try {
    const fd = await fs.open(targetAbs, 'r')
    try {
      const buf = Buffer.alloc(256)
      const { bytesRead } = await fd.read(buf, 0, 256, 0)
      const text = buf.toString('utf-8', 0, bytesRead)
      firstLine = text.split('\n', 1)[0] ?? ''
    } finally {
      await fd.close()
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return makeIssue('bin-target-missing', manifest.rel, binName, target, targetRel)
    }
    return null
  }

  if (!firstLine.startsWith('#!')) {
    return makeIssue('missing-shebang', manifest.rel, binName, target, targetRel)
  }
  const isNode = NODE_SHEBANG_PATTERNS.some((re) => re.test(firstLine))
  if (!isNode) {
    return makeIssue('wrong-shebang', manifest.rel, binName, target, targetRel, firstLine.trim())
  }
  return null
}

function makeIssue(
  kind: BinShebangIssueKind,
  packageJson: string,
  binName: string,
  binPath: string,
  resolvedPath: string,
  observedShebang?: string,
): BinShebangIssue {
  return {
    kind,
    packageJson: packageJson.replace(/\\/g, '/'),
    binName,
    binPath,
    resolvedPath,
    observedShebang,
  }
}

async function walkForManifests(
  dir: string,
  rootDir: string,
  acc: Array<{ abs: string; dir: string; rel: string; raw: any }>,
): Promise<void> {
  if (PKG_SKIP_DIRS.has(path.basename(dir)) && dir !== rootDir) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const e of entries) {
    if (e.name === 'package.json' && e.isFile()) {
      const full = path.join(dir, e.name)
      try {
        const raw = JSON.parse(await fs.readFile(full, 'utf-8'))
        acc.push({
          abs: full,
          dir,
          rel: path.relative(rootDir, full).replace(/\\/g, '/'),
          raw,
        })
      } catch {
        // package.json invalide — skip silencieusement.
      }
    }
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      await walkForManifests(path.join(dir, e.name), rootDir, acc)
    }
  }
}
