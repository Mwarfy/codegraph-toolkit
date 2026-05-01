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
  /**
   * Si fourni, copie les rules Datalog du package
   * `@liby-tools/invariants-<flavor>` dans `<projet>/invariants/` et
   * crée le test runner générique. Flavors V1 : `postgres`.
   * Le package doit déjà être installé (npm install) — sinon warning.
   */
  withInvariants?: 'postgres'
  /**
   * Si true, copie aussi le hook PostToolUse `codegraph-feedback.sh`
   * (Tier 8 live datalog) ET wire dans `.claude/settings.json`. Plus
   * fournit le test runner Datalog `tests/unit/datalog-invariants.test.ts`.
   * Demande que `@liby-tools/codegraph` soit deja installe.
   */
  withClaudeHooks?: boolean
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

/**
 * Stack DB détectée — utilisée pour activer les bons détecteurs codegraph.
 * Plusieurs flags peuvent être true simultanément (projet hybride).
 */
interface DetectedStack {
  hasRawSqlMigrations: boolean  // .sql files dans **/migrations/* ou **/db/*
  hasDrizzle: boolean           // drizzle-orm dans un package.json
  hasPrisma: boolean            // prisma ou @prisma/client
}

async function detectStack(rootDir: string): Promise<DetectedStack> {
  const stack: DetectedStack = {
    hasRawSqlMigrations: false,
    hasDrizzle: false,
    hasPrisma: false,
  }

  // 1. Cherche les package.json (root + sub-packages communs)
  const candidates = [
    'package.json',
    'backend/package.json',
    'frontend/package.json',
    'shared/package.json',
    'apps/backend/package.json',
    'sentinel-core/package.json',
    'sentinel-web/package.json',
  ]
  for (const rel of candidates) {
    const p = path.join(rootDir, rel)
    if (!(await exists(p))) continue
    try {
      const pkg = JSON.parse(await readFile(p, 'utf-8'))
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      }
      if (allDeps['drizzle-orm']) stack.hasDrizzle = true
      if (allDeps['prisma'] || allDeps['@prisma/client']) stack.hasPrisma = true
    } catch { /* malformed package.json, skip */ }
  }

  // 2. Cherche des fichiers .sql dans les emplacements typiques
  const sqlPaths = [
    'migrations',
    'db/migrations',
    'sentinel-core/src/db/migrations',
    'backend/migrations',
    'backend/src/db/migrations',
    'src/db/migrations',
  ]
  for (const rel of sqlPaths) {
    const p = path.join(rootDir, rel)
    if (await exists(p)) {
      stack.hasRawSqlMigrations = true
      break
    }
  }

  return stack
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
  const stack = await detectStack(rootDir)
  result.layout = layout.kind
  if (stack.hasDrizzle) result.warnings.push('Drizzle ORM détecté → drizzle-schema detector activé')
  if (stack.hasRawSqlMigrations) result.warnings.push('Migrations .sql détectées → sql-schema detector activé')
  if (stack.hasPrisma) result.warnings.push('Prisma détecté → pas encore supporté (FK invariants seulement raw SQL + Drizzle pour l\'instant)')

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
    // Détecteurs SQL/Drizzle activés selon stack détectée. Si la stack
    // n'a pas de DB, le détecteur tournera quand même mais retournera
    // tables.length === 0 (overhead minime ~50ms, OK).
    const detectorOptions: Record<string, Record<string, unknown>> = {}
    detectorOptions.sqlSchema = { enabled: stack.hasRawSqlMigrations }
    detectorOptions.drizzleSchema = { enabled: stack.hasDrizzle }

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
      detectorOptions,
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

  // 5b. Invariants standards (optionnel)
  if (opts.withInvariants) {
    await wireInvariantsPackage(rootDir, opts.withInvariants, result)
  }

  // 5c. Claude hooks PostToolUse (Tier 9 — live datalog gate)
  if (opts.withClaudeHooks) {
    await wireClaudeHooks(rootDir, layout, result)
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

/**
 * Copie les rules .dl depuis `node_modules/@liby-tools/invariants-<flavor>/invariants/`
 * vers `<rootDir>/invariants/`. Skip schema-subset.dl (le projet doit déjà
 * avoir un schema.dl, sinon copie-le comme schema.dl).
 *
 * Si le package n'est pas installé : warning, pas d'erreur. Le user doit
 * `npm install --save-dev @liby-tools/invariants-postgres-ts` puis
 * relancer init.
 */
async function wireInvariantsPackage(
  rootDir: string,
  flavor: 'postgres',
  result: InitResult,
): Promise<void> {
  const pkgName = `@liby-tools/invariants-${flavor}-ts`
  const pkgDir = path.join(rootDir, 'node_modules', pkgName)
  const pkgInvariants = path.join(pkgDir, 'invariants')

  if (!(await exists(pkgInvariants))) {
    result.warnings.push(
      `${pkgName} pas installé — run \`npm install --save-dev ${pkgName}\` puis relance init`,
    )
    return
  }

  const targetDir = path.join(rootDir, 'invariants')
  await mkdir(targetDir, { recursive: true })

  // Copier les rules .dl du package, sauf schema-subset.dl.
  const { readdir } = await import('node:fs/promises')
  const ruleFiles = (await readdir(pkgInvariants)).filter(
    (f) => f.endsWith('.dl') && f !== 'schema-subset.dl',
  )

  for (const rule of ruleFiles) {
    const target = path.join(targetDir, rule)
    if (await exists(target)) {
      result.skipped.push(`invariants/${rule}`)
      continue
    }
    await copyFile(path.join(pkgInvariants, rule), target)
    result.created.push(`invariants/${rule}`)
  }

  // Si pas de schema.dl dans le projet, copier le schema-subset.dl du
  // package en tant que schema.dl initial.
  const schemaTarget = path.join(targetDir, 'schema.dl')
  const schemaSource = path.join(pkgInvariants, 'schema-subset.dl')
  if (!(await exists(schemaTarget)) && (await exists(schemaSource))) {
    await copyFile(schemaSource, schemaTarget)
    result.created.push('invariants/schema.dl')
    result.warnings.push(
      `invariants/schema.dl créé depuis le subset minimal — étendre si tu ajoutes des invariants qui consomment d'autres relations`,
    )
  } else if (await exists(schemaTarget)) {
    result.warnings.push(
      `invariants/schema.dl existe — vérifier qu'il déclare CycleNode, SqlFkWithoutIndex, SqlForeignKey (cf. ${pkgName}/invariants/schema-subset.dl)`,
    )
  }
}

/**
 * Wire Tier 9 — Claude Code hooks PostToolUse + test runner Datalog.
 *
 *   1. Copie `codegraph-feedback.sh` (templated, paths dynamiques) dans
 *      `<rootDir>/scripts/git-hooks/codegraph-feedback.sh` (chmod +x).
 *   2. Wire dans `.claude/settings.json` : ajoute hook PostToolUse pour
 *      `Edit|Write|MultiEdit` qui appelle ce script.
 *   3. Copie le template `datalog-invariants.test.ts` dans le test dir
 *      du projet (best-effort detect du layout : `tests/unit/`,
 *      `__tests__/`, ou `<srcDirs[0]>/tests/unit/`).
 *
 *   Demande que `@liby-tools/codegraph` soit installe (le hook l'utilise
 *   via `require.resolve` au runtime).
 */
async function wireClaudeHooks(
  rootDir: string,
  layout: DetectedLayout,
  result: InitResult,
): Promise<void> {
  // 1. Copie codegraph-feedback.sh
  const hooksDir = path.join(rootDir, 'scripts', 'git-hooks')
  await mkdir(hooksDir, { recursive: true })
  const target = path.join(hooksDir, 'codegraph-feedback.sh')
  if (await exists(target)) {
    result.skipped.push('scripts/git-hooks/codegraph-feedback.sh')
  } else {
    const source = path.join(HOOKS_TEMPLATES_DIR, 'codegraph-feedback.sh')
    if (await exists(source)) {
      await copyFile(source, target)
      await chmod(target, 0o755)
      result.created.push('scripts/git-hooks/codegraph-feedback.sh')
    } else {
      result.warnings.push(`hook source absent: ${source}`)
      return
    }
  }

  // 2. Wire dans .claude/settings.json
  const claudeDir = path.join(rootDir, '.claude')
  const claudeSettingsPath = path.join(claudeDir, 'settings.json')
  await mkdir(claudeDir, { recursive: true })
  const POST_TOOL_USE_HOOK = {
    matcher: 'Edit|Write|MultiEdit',
    hooks: [
      {
        type: 'command',
        command: 'scripts/git-hooks/codegraph-feedback.sh',
      },
    ],
  }
  if (await exists(claudeSettingsPath)) {
    try {
      const existing = JSON.parse(await readFile(claudeSettingsPath, 'utf-8'))
      const hasOurPostHook = JSON.stringify(existing).includes('codegraph-feedback.sh')
      if (hasOurPostHook) {
        result.skipped.push('.claude/settings.json (codegraph-feedback déjà wired)')
      } else {
        // Merge minimal : ajoute notre PostToolUse à existing.hooks
        existing.hooks = existing.hooks ?? {}
        existing.hooks.PostToolUse = existing.hooks.PostToolUse ?? []
        existing.hooks.PostToolUse.push(POST_TOOL_USE_HOOK)
        await writeFile(
          claudeSettingsPath,
          JSON.stringify(existing, null, 2) + '\n',
          'utf-8',
        )
        result.created.push('.claude/settings.json (codegraph-feedback merged)')
      }
    } catch {
      result.warnings.push('.claude/settings.json existe mais invalide JSON — non modifié')
    }
  } else {
    const merged = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [{ type: 'command', command: 'scripts/git-hooks/adr-hook.sh' }],
          },
        ],
        PostToolUse: [POST_TOOL_USE_HOOK],
      },
    }
    await writeFile(claudeSettingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
    result.created.push('.claude/settings.json')
  }

  // 3. Copie le test runner Datalog dans le test dir détecté.
  const testDirCandidates = [
    'tests/unit',
    '__tests__',
    `${layout.srcDirs[0] ?? '.'}/tests/unit`,
  ]
  let testDir: string | null = null
  for (const candidate of testDirCandidates) {
    const abs = path.join(rootDir, candidate)
    if (await exists(abs)) {
      testDir = candidate
      break
    }
  }
  if (!testDir) {
    testDir = 'tests/unit'
    await mkdir(path.join(rootDir, testDir), { recursive: true })
  }
  const testTarget = path.join(rootDir, testDir, 'datalog-invariants.test.ts')
  if (await exists(testTarget)) {
    result.skipped.push(`${testDir}/datalog-invariants.test.ts`)
  } else {
    const tmplSource = path.join(TEMPLATES_DIR, 'datalog-invariants.test.ts.tmpl')
    if (await exists(tmplSource)) {
      const tmpl = await readFile(tmplSource, 'utf-8')
      // Compute relative path from test file to repo root.
      // ex: tests/unit/datalog-invariants.test.ts → ../..
      const depth = testDir.split('/').filter(Boolean).length
      const relToRoot = depth === 0 ? '.' : new Array(depth).fill('..').join('/')
      // invariants dir : detected via wireInvariantsPackage si appele,
      // sinon on suppose 'invariants/' standard.
      const invariantsDir = (await exists(path.join(rootDir, 'invariants'))) ? 'invariants' : 'invariants'
      const rendered = tmpl
        .replaceAll('__TESTFILE_TO_REPO__', relToRoot)
        .replaceAll('__INVARIANTS_DIR__', invariantsDir)
      await writeFile(testTarget, rendered, 'utf-8')
      result.created.push(`${testDir}/datalog-invariants.test.ts`)
    } else {
      result.warnings.push(`template absent: ${tmplSource}`)
    }
  }
}
