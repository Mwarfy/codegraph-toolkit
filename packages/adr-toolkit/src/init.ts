/**
 * `init` — scaffold un projet pour utiliser @liby-tools/adr-toolkit (+ codegraph).
 *
 * Idempotent : ne réécrit pas un fichier existant.
 *
 * Étapes orchestrées par `initProject` :
 *   1. Détecte le layout (simple src/, monorepo backend+frontend, apps/*, packages/*)
 *   2. Écrit `.codegraph-toolkit.json` (config adr-toolkit)
 *   3. Écrit `codegraph.config.json` (config codegraph) avec les bons paths
 *   4. Crée `<adrDir>/_TEMPLATE.md` + `INDEX.md`
 *   5. Crée `scripts/git-hooks/{pre,post}-commit` + `adr-hook.sh`
 *   6. Set `git config core.hooksPath` + chmod +x
 *   7. Optionnel : invariants Datalog + Claude hooks PostToolUse
 *   8. Optionnel : `.claude/settings.json`
 *
 * Refonte mai 2026 : split de `initProject` (130+ LOC) et `wireClaudeHooks`
 * (115 LOC) en helpers nommés, un par étape. Cyclomatic complexity réduite.
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

  const sqlPaths = [
    'migrations',
    'db/migrations',
    'sentinel-core/src/db/migrations',
    'backend/migrations',
    'backend/src/db/migrations',
    'src/db/migrations',
  ]
  for (const rel of sqlPaths) {
    if (await exists(path.join(rootDir, rel))) {
      stack.hasRawSqlMigrations = true
      break
    }
  }

  return stack
}

async function detectLayout(rootDir: string): Promise<DetectedLayout> {
  const has = (p: string) => exists(path.join(rootDir, p))
  const hasGit = await has('.git')

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

const POST_TOOL_USE_HOOK = {
  matcher: 'Edit|Write|MultiEdit',
  hooks: [
    {
      type: 'command',
      command: 'scripts/git-hooks/codegraph-feedback.sh',
    },
  ],
}

export async function initProject(
  rootDir: string,
  opts: InitOptions = {},
): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], warnings: [], layout: 'simple' }
  const layout = await detectLayout(rootDir)
  const stack = await detectStack(rootDir)
  result.layout = layout.kind
  warnAboutStack(stack, result)

  await writeAdrToolkitConfig(rootDir, layout, result)
  await writeCodegraphConfig(rootDir, layout, stack, result)
  await writeAdrTemplates(rootDir, result)
  await writeGitHooks(rootDir, result)
  await setGitHooksPath(rootDir, layout, result)

  if (opts.withInvariants) {
    await wireInvariantsPackage(rootDir, opts.withInvariants, result)
  }
  if (opts.withClaudeHooks) {
    await wireClaudeHooks(rootDir, layout, result)
  }
  if (opts.withClaudeSettings) {
    await writeClaudePreToolUseSettings(rootDir, result)
  }

  return result
}

function warnAboutStack(stack: DetectedStack, result: InitResult): void {
  if (stack.hasDrizzle) {
    result.warnings.push('Drizzle ORM détecté → drizzle-schema detector activé')
  }
  if (stack.hasRawSqlMigrations) {
    result.warnings.push('Migrations .sql détectées → sql-schema detector activé')
  }
  if (stack.hasPrisma) {
    result.warnings.push(
      'Prisma détecté → pas encore supporté (FK invariants seulement raw SQL + Drizzle pour l\'instant)',
    )
  }
}

async function writeAdrToolkitConfig(
  rootDir: string,
  layout: DetectedLayout,
  result: InitResult,
): Promise<void> {
  const adrConfigPath = path.join(rootDir, CONFIG_FILENAME)
  if (await exists(adrConfigPath)) {
    result.skipped.push(CONFIG_FILENAME)
    return
  }
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

async function writeCodegraphConfig(
  rootDir: string,
  layout: DetectedLayout,
  stack: DetectedStack,
  result: InitResult,
): Promise<void> {
  const codegraphConfigPath = path.join(rootDir, 'codegraph.config.json')
  if (await exists(codegraphConfigPath)) {
    result.skipped.push('codegraph.config.json')
    return
  }
  // Détecteurs SQL/Drizzle activés selon stack détectée. Si absente,
  // overhead minime (~50ms) à retourner tables.length === 0.
  const detectorOptions: Record<string, Record<string, unknown>> = {
    sqlSchema: { enabled: stack.hasRawSqlMigrations },
    drizzleSchema: { enabled: stack.hasDrizzle },
  }
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

async function writeAdrTemplates(rootDir: string, result: InitResult): Promise<void> {
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
}

async function writeGitHooks(rootDir: string, result: InitResult): Promise<void> {
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
}

async function setGitHooksPath(
  rootDir: string,
  layout: DetectedLayout,
  result: InitResult,
): Promise<void> {
  if (!layout.hasGit) {
    result.warnings.push('Pas de .git/ — set core.hooksPath manuellement après git init')
    return
  }
  try {
    execSync('git config core.hooksPath scripts/git-hooks', { cwd: rootDir, stdio: 'pipe' })
    result.created.push('git config core.hooksPath')
  } catch (err) {
    result.warnings.push(`git config core.hooksPath échoué : ${(err as Error).message}`)
  }
}

async function writeClaudePreToolUseSettings(
  rootDir: string,
  result: InitResult,
): Promise<void> {
  const claudeDir = path.join(rootDir, '.claude')
  const claudeSettingsPath = path.join(claudeDir, 'settings.json')
  await mkdir(claudeDir, { recursive: true })

  if (!(await exists(claudeSettingsPath))) {
    await writeFile(
      claudeSettingsPath,
      JSON.stringify(CLAUDE_SETTINGS_TEMPLATE, null, 2) + '\n',
      'utf-8',
    )
    result.created.push('.claude/settings.json')
    return
  }

  // Existing settings — on n'écrase pas, mais on log si notre hook absent.
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
  const pkgInvariants = path.join(rootDir, 'node_modules', pkgName, 'invariants')

  if (!(await exists(pkgInvariants))) {
    result.warnings.push(
      `${pkgName} pas installé — run \`npm install --save-dev ${pkgName}\` puis relance init`,
    )
    return
  }

  const targetDir = path.join(rootDir, 'invariants')
  await mkdir(targetDir, { recursive: true })

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
 *   1. Copie `codegraph-feedback.sh` (templated) dans `scripts/git-hooks/`.
 *   2. Wire dans `.claude/settings.json` : ajoute hook PostToolUse pour
 *      `Edit|Write|MultiEdit` qui appelle ce script.
 *   3. Copie le test runner Datalog dans le test dir détecté.
 *
 * Demande que `@liby-tools/codegraph` soit installé.
 */
async function wireClaudeHooks(
  rootDir: string,
  layout: DetectedLayout,
  result: InitResult,
): Promise<void> {
  const copied = await copyCodegraphFeedbackHook(rootDir, result)
  if (!copied) return // source absent — abandon (warning déjà logué)
  await mergeClaudeSettingsForPostHook(rootDir, result)
  await copyDatalogTestRunner(rootDir, layout, result)
}

/** Copie codegraph-feedback.sh dans scripts/git-hooks/. Retourne false si source absente. */
async function copyCodegraphFeedbackHook(
  rootDir: string,
  result: InitResult,
): Promise<boolean> {
  const hooksDir = path.join(rootDir, 'scripts', 'git-hooks')
  await mkdir(hooksDir, { recursive: true })
  const target = path.join(hooksDir, 'codegraph-feedback.sh')
  if (await exists(target)) {
    result.skipped.push('scripts/git-hooks/codegraph-feedback.sh')
    return true
  }
  const source = path.join(HOOKS_TEMPLATES_DIR, 'codegraph-feedback.sh')
  if (!(await exists(source))) {
    result.warnings.push(`hook source absent: ${source}`)
    return false
  }
  await copyFile(source, target)
  await chmod(target, 0o755)
  result.created.push('scripts/git-hooks/codegraph-feedback.sh')
  return true
}

/** Merge POST_TOOL_USE_HOOK dans .claude/settings.json (créé si absent). */
async function mergeClaudeSettingsForPostHook(
  rootDir: string,
  result: InitResult,
): Promise<void> {
  const claudeDir = path.join(rootDir, '.claude')
  const claudeSettingsPath = path.join(claudeDir, 'settings.json')
  await mkdir(claudeDir, { recursive: true })

  if (!(await exists(claudeSettingsPath))) {
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
    return
  }

  try {
    const existing = JSON.parse(await readFile(claudeSettingsPath, 'utf-8'))
    if (JSON.stringify(existing).includes('codegraph-feedback.sh')) {
      result.skipped.push('.claude/settings.json (codegraph-feedback déjà wired)')
      return
    }
    existing.hooks = existing.hooks ?? {}
    existing.hooks.PostToolUse = existing.hooks.PostToolUse ?? []
    existing.hooks.PostToolUse.push(POST_TOOL_USE_HOOK)
    await writeFile(claudeSettingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
    result.created.push('.claude/settings.json (codegraph-feedback merged)')
  } catch {
    result.warnings.push('.claude/settings.json existe mais invalide JSON — non modifié')
  }
}

/** Copie le test runner Datalog templated dans le test dir détecté. */
async function copyDatalogTestRunner(
  rootDir: string,
  layout: DetectedLayout,
  result: InitResult,
): Promise<void> {
  const testDirCandidates = [
    'tests/unit',
    '__tests__',
    `${layout.srcDirs[0] ?? '.'}/tests/unit`,
  ]
  let testDir: string | null = null
  for (const candidate of testDirCandidates) {
    if (await exists(path.join(rootDir, candidate))) {
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
    return
  }
  const tmplSource = path.join(TEMPLATES_DIR, 'datalog-invariants.test.ts.tmpl')
  if (!(await exists(tmplSource))) {
    result.warnings.push(`template absent: ${tmplSource}`)
    return
  }
  const tmpl = await readFile(tmplSource, 'utf-8')
  // Compute relative path from test file to repo root (e.g. tests/unit → ../..).
  const depth = testDir.split('/').filter(Boolean).length
  const relToRoot = depth === 0 ? '.' : new Array(depth).fill('..').join('/')
  const rendered = tmpl
    .replaceAll('__TESTFILE_TO_REPO__', relToRoot)
    .replaceAll('__INVARIANTS_DIR__', 'invariants')
  await writeFile(testTarget, rendered, 'utf-8')
  result.created.push(`${testDir}/datalog-invariants.test.ts`)
}
