/**
 * `init` — scaffold un projet pour utiliser @liby-tools/adr-toolkit (+ codegraph).
 *
 * Idempotent : ne réécrit pas un fichier existant.
 *
 * Étapes :
 *   1. Détecte le layout (simple src/, monorepo backend+frontend, apps/*, packages/*)
 *   2. Écrit `.codegraph-toolkit.json` (config adr-toolkit)
 *   3. Écrit `codegraph.config.json` (config codegraph) avec les bons paths
 *   4. Crée `<adrDir>/_TEMPLATE.md` + `INDEX.md`
 *   5. Crée `scripts/git-hooks/{pre,post}-commit` + `adr-hook.sh`
 *   6. Set `git config core.hooksPath` + chmod +x
 *   7. Optionnel : `.claude/settings.json` (avec confirmation, voir options)
 */

import { readFile, writeFile, mkdir, copyFile, chmod, stat } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_FILENAME } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..')
const HOOKS_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'src', 'hooks')
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates')

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

interface InitResult {
  created: string[]
  skipped: string[]
  warnings: string[]
  layout: LayoutKind
}

export interface InitOptions {
  /** Si true, écrit aussi `.claude/settings.json` avec le hook PreToolUse. */
  withClaudeSettings?: boolean
}

type LayoutKind = 'simple' | 'fullstack-monorepo' | 'workspaces-monorepo' | 'flat'

interface DetectedLayout {
  kind: LayoutKind
  /** srcDirs pour `.codegraph-toolkit.json` (où chercher les marqueurs ADR) */
  srcDirs: string[]
  /** tsconfigPath pour les deux configs */
  tsconfigPath: string
  /** include[] pour `codegraph.config.json` (globs) */
  codegraphInclude: string[]
  /** entryPoints[] pour `codegraph.config.json` */
  codegraphEntryPoints: string[]
  hasGit: boolean
}

async function detectLayout(rootDir: string): Promise<DetectedLayout> {
  const has = (p: string) => exists(path.join(rootDir, p))
  const hasGit = await has('.git')

  // Cas 1 : monorepo "fullstack" (backend/ + frontend/ + éventuellement shared/)
  if ((await has('backend/src')) && (await has('frontend'))) {
    const srcDirs = ['backend/src']
    if (await has('shared/src')) srcDirs.push('shared/src')
    srcDirs.push('frontend')
    let tsconfigPath = 'tsconfig.json'
    if (await has('backend/tsconfig.json')) tsconfigPath = 'backend/tsconfig.json'
    return {
      kind: 'fullstack-monorepo',
      srcDirs,
      tsconfigPath,
      codegraphInclude: [
        'backend/src/**/*.ts',
        ...(await has('shared/src') ? ['shared/src/**/*.ts'] : []),
        'frontend/**/*.{ts,tsx}',
      ],
      codegraphEntryPoints: [
        'backend/src/index.ts',
        'frontend/app/**/page.tsx',
        'frontend/app/**/layout.tsx',
        'frontend/pages/**/*.tsx',
      ],
      hasGit,
    }
  }

  // Cas 2 : monorepo "workspaces" (apps/* ou packages/*)
  if ((await has('apps')) || (await has('packages'))) {
    const srcDirs: string[] = []
    if (await has('apps')) srcDirs.push('apps')
    if (await has('packages')) srcDirs.push('packages')
    let tsconfigPath = 'tsconfig.json'
    if (!(await has(tsconfigPath))) {
      if (await has('tsconfig.base.json')) tsconfigPath = 'tsconfig.base.json'
    }
    return {
      kind: 'workspaces-monorepo',
      srcDirs,
      tsconfigPath,
      codegraphInclude: [
        ...(await has('apps') ? ['apps/**/*.{ts,tsx}'] : []),
        ...(await has('packages') ? ['packages/**/*.{ts,tsx}'] : []),
      ],
      codegraphEntryPoints: [
        'apps/**/index.ts',
        'apps/**/main.ts',
        'packages/**/index.ts',
      ],
      hasGit,
    }
  }

  // Cas 3 : projet simple (src/)
  if (await has('src')) {
    let tsconfigPath = 'tsconfig.json'
    if (!(await has(tsconfigPath)) && (await has('src/tsconfig.json'))) {
      tsconfigPath = 'src/tsconfig.json'
    }
    return {
      kind: 'simple',
      srcDirs: ['src'],
      tsconfigPath,
      codegraphInclude: ['src/**/*.{ts,tsx}'],
      codegraphEntryPoints: ['src/index.ts', 'src/main.ts', 'src/server.ts'],
      hasGit,
    }
  }

  // Cas 4 : flat (rien à la racine — fallback minimal)
  return {
    kind: 'flat',
    srcDirs: ['.'],
    tsconfigPath: 'tsconfig.json',
    codegraphInclude: ['**/*.{ts,tsx}'],
    codegraphEntryPoints: ['index.ts', 'main.ts'],
    hasGit,
  }
}

const CLAUDE_SETTINGS_TEMPLATE = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: 'scripts/git-hooks/adr-hook.sh',
          },
        ],
      },
    ],
  },
}

export async function initProject(
  rootDir: string,
  opts: InitOptions = {},
): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], warnings: [], layout: 'simple' }
  const layout = await detectLayout(rootDir)
  result.layout = layout.kind

  // 1. .codegraph-toolkit.json
  const adrConfigPath = path.join(rootDir, CONFIG_FILENAME)
  if (await exists(adrConfigPath)) {
    result.skipped.push(CONFIG_FILENAME)
  } else {
    const config = {
      rootDir: '.',
      adrDir: 'docs/adr',
      srcDirs: layout.srcDirs,
      tsconfigPath: layout.tsconfigPath,
      briefPath: 'CLAUDE-CONTEXT.md',
      anchorMarkerExtensions: ['ts', 'tsx', 'sh', 'sql'],
      skipDirs: ['node_modules', 'dist', '.next', '.codegraph', 'coverage', '.git'],
      hubThreshold: 15,
      invariantTestPaths: [],
    }
    await writeFile(adrConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    result.created.push(CONFIG_FILENAME)
  }

  // 2. codegraph.config.json
  const codegraphConfigPath = path.join(rootDir, 'codegraph.config.json')
  if (await exists(codegraphConfigPath)) {
    result.skipped.push('codegraph.config.json')
  } else {
    const codegraphConfig = {
      rootDir: '.',
      include: layout.codegraphInclude,
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/coverage/**',
        '**/__tests__/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.d.ts',
      ],
      entryPoints: layout.codegraphEntryPoints,
      detectors: ['ts-imports', 'event-bus', 'http-routes', 'bullmq-queues', 'db-tables'],
      snapshotDir: '.codegraph',
      maxSnapshots: 50,
      tsconfigPath: layout.tsconfigPath,
    }
    await writeFile(codegraphConfigPath, JSON.stringify(codegraphConfig, null, 2) + '\n', 'utf-8')
    result.created.push('codegraph.config.json')
  }

  // 3. ADR dir + templates
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

  // 4. Hooks
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

  // 5. git config core.hooksPath
  if (layout.hasGit) {
    try {
      execSync('git config core.hooksPath scripts/git-hooks', { cwd: rootDir, stdio: 'pipe' })
      result.created.push('git config core.hooksPath')
    } catch (err) {
      result.warnings.push(`git config core.hooksPath échoué : ${(err as Error).message}`)
    }
  } else {
    result.warnings.push('Pas de .git/ — set core.hooksPath manuellement après git init')
  }

  // 6. .claude/settings.json (optionnel)
  if (opts.withClaudeSettings) {
    const claudeDir = path.join(rootDir, '.claude')
    const claudeSettingsPath = path.join(claudeDir, 'settings.json')
    await mkdir(claudeDir, { recursive: true })
    if (await exists(claudeSettingsPath)) {
      // Merge si possible : on n'écrase pas, mais on log un warning si
      // notre hook PreToolUse n'est pas présent.
      try {
        const existing = JSON.parse(await readFile(claudeSettingsPath, 'utf-8'))
        const hasOurHook = JSON.stringify(existing).includes('adr-hook.sh')
        if (hasOurHook) {
          result.skipped.push('.claude/settings.json (adr-hook déjà wired)')
        } else {
          result.warnings.push(
            '.claude/settings.json existe sans adr-hook — ajoute manuellement le hook PreToolUse (cf. README)',
          )
        }
      } catch {
        result.warnings.push('.claude/settings.json existe mais invalide JSON — non modifié')
      }
    } else {
      await writeFile(
        claudeSettingsPath,
        JSON.stringify(CLAUDE_SETTINGS_TEMPLATE, null, 2) + '\n',
        'utf-8',
      )
      result.created.push('.claude/settings.json')
    }
  }

  return result
}
