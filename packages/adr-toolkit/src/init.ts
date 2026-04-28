/**
 * `init` — scaffold un projet pour utiliser @liby/adr-toolkit.
 *
 * Idempotent : ne réécrit pas un fichier existant. Détecte ce qui est
 * déjà présent et rapporte ce qu'il a fait + ce qui reste à faire.
 *
 * Étapes :
 *   1. Détecte conventions (srcDirs candidats, tsconfig.json présent ?)
 *   2. Écrit `.codegraph-toolkit.json` si absent (avec valeurs détectées)
 *   3. Crée `<adrDir>/INDEX.md` + `_TEMPLATE.md` si absent
 *   4. Crée `scripts/git-hooks/{pre,post}-commit` + `adr-hook.sh`
 *      (depuis les templates installés avec le package)
 *   5. Set `git config core.hooksPath scripts/git-hooks` + chmod +x
 *   6. Affiche le checklist next steps
 */

import { readFile, writeFile, mkdir, copyFile, chmod, stat, readdir } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILENAME } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Lors du package npm publié : src/init.ts → dist/init.js, hooks dans dist/hooks/
// Pendant le dev workspace : pareil (build copie hooks). Le path est relatif à
// l'exécutable.
const PACKAGE_ROOT = path.resolve(__dirname, '..')
const HOOKS_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'src', 'hooks')
// Si le package est consommé compilé (dist/), les hooks sont dans le src
// adjacent au package (cf. `files` du package.json).
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates')

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

interface InitResult {
  created: string[]
  skipped: string[]
  warnings: string[]
}

interface DetectedDefaults {
  srcDirs: string[]
  tsconfigPath: string
  hasGit: boolean
}

async function detectDefaults(rootDir: string): Promise<DetectedDefaults> {
  const candidates: string[] = []
  for (const dir of ['src', 'backend/src', 'frontend/src', 'shared/src', 'lib']) {
    if (await exists(path.join(rootDir, dir))) candidates.push(dir)
  }
  const srcDirs = candidates.length > 0 ? candidates : ['src']

  let tsconfigPath = 'tsconfig.json'
  if (!(await exists(path.join(rootDir, tsconfigPath)))) {
    // try common alternative locations
    for (const alt of ['backend/tsconfig.json', 'tsconfig.base.json']) {
      if (await exists(path.join(rootDir, alt))) {
        tsconfigPath = alt
        break
      }
    }
  }

  const hasGit = await exists(path.join(rootDir, '.git'))

  return { srcDirs, tsconfigPath, hasGit }
}

export async function initProject(rootDir: string): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], warnings: [] }
  const defaults = await detectDefaults(rootDir)

  // 1. .codegraph-toolkit.json
  const configPath = path.join(rootDir, CONFIG_FILENAME)
  if (await exists(configPath)) {
    result.skipped.push(CONFIG_FILENAME)
  } else {
    const config = {
      rootDir: '.',
      adrDir: 'docs/adr',
      srcDirs: defaults.srcDirs,
      tsconfigPath: defaults.tsconfigPath,
      briefPath: 'CLAUDE-CONTEXT.md',
      anchorMarkerExtensions: ['ts', 'tsx', 'sh', 'sql'],
      skipDirs: ['node_modules', 'dist', '.next', '.codegraph', 'coverage', '.git'],
      hubThreshold: 15,
      invariantTestPaths: [],
    }
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    result.created.push(CONFIG_FILENAME)
  }

  // 2. ADR dir + templates
  const adrDir = path.join(rootDir, 'docs/adr')
  await mkdir(adrDir, { recursive: true })

  const templatePath = path.join(adrDir, '_TEMPLATE.md')
  if (await exists(templatePath)) {
    result.skipped.push('docs/adr/_TEMPLATE.md')
  } else {
    await copyFile(path.join(TEMPLATES_DIR, '_TEMPLATE.md'), templatePath)
    result.created.push('docs/adr/_TEMPLATE.md')
  }

  const indexPath = path.join(adrDir, 'INDEX.md')
  if (await exists(indexPath)) {
    result.skipped.push('docs/adr/INDEX.md')
  } else {
    await copyFile(path.join(TEMPLATES_DIR, 'INDEX.md.tmpl'), indexPath)
    result.created.push('docs/adr/INDEX.md')
  }

  // 3. Hooks
  const hooksDir = path.join(rootDir, 'scripts/git-hooks')
  await mkdir(hooksDir, { recursive: true })

  for (const hook of ['pre-commit.sh', 'post-commit.sh', 'adr-hook.sh']) {
    const targetName = hook === 'adr-hook.sh' ? 'adr-hook.sh' : hook.replace(/\.sh$/, '')
    const target = path.join(hooksDir, targetName)
    if (await exists(target)) {
      result.skipped.push(`scripts/git-hooks/${targetName}`)
      continue
    }
    const source = path.join(HOOKS_TEMPLATES_DIR, hook)
    if (!(await exists(source))) {
      result.warnings.push(`hook source absent: ${source}`)
      continue
    }
    const content = await readFile(source, 'utf-8')
    await writeFile(target, content, 'utf-8')
    await chmod(target, 0o755)
    result.created.push(`scripts/git-hooks/${targetName}`)
  }

  // 4. git config core.hooksPath
  if (defaults.hasGit) {
    try {
      execSync('git config core.hooksPath scripts/git-hooks', { cwd: rootDir, stdio: 'pipe' })
      result.created.push('git config core.hooksPath')
    } catch (err) {
      result.warnings.push(`git config core.hooksPath échoué : ${(err as Error).message}`)
    }
  } else {
    result.warnings.push('Pas de .git/ — set core.hooksPath manuellement après git init')
  }

  return result
}
