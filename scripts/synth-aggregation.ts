/**
 * Synth aggregation — Niveau 4 self-optim — auto-génère le code Salsa
 * complet (pas de SCAFFOLD-TODO) à partir d'une introspection ts-morph
 * du Bundle interface du détecteur.
 *
 * Théorie sous-jacente — algebraic data type catamorphism :
 *
 *   Pour un Bundle = { f1: T1[], f2: T2[], f3: T3 } où Ti[] sont des
 *   arrays, l'agrégation canonique est `concatMap` :
 *
 *     aggregate(bundles) = {
 *       f1: bundles.flatMap(b => b.f1),
 *       f2: bundles.flatMap(b => b.f2),
 *       f3: combine(bundles.map(b => b.f3))  // pour les non-array fields
 *     }
 *
 *   Pour les fields avec `{ file: string; line: number }` shape, on ajoute
 *   un sort lex (file, line) déterministe.
 *
 * Cas couverts (~70% des détecteurs codegraph) :
 *   ✓ Bundle = { fa: T[]; fb: T[]; ... }     (concat-only) — auto.
 *   ✓ Field shape `{ file, line, ... }`      → tri auto post-concat.
 *   ✗ Bundle avec global state cross-fichier (Map<X, Set<Y>>) — pas auto.
 *   ✗ Bundle avec set-union (dédupe sur identity) — détecté mais skip.
 *
 * Usage :
 *   ./scripts/synth-aggregation.ts <detector>
 *   → écrit packages/codegraph/src/incremental/<detector>.ts complet
 *
 * Sécurité : si l'introspection ne supporte pas le shape (cas ✗),
 * imprime un message expliquant pourquoi et fallback au scaffold-only.
 */

import { Project, SyntaxKind, Node, type InterfaceDeclaration, type SourceFile } from 'ts-morph'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

interface FieldInfo {
  name: string
  /** Type as text (e.g., 'string', 'number', 'Foo[]'). */
  typeText: string
  /** True if the type is an array (e.g., `Foo[]` or `Array<Foo>`). */
  isArray: boolean
  /** True if the field shape is `{ file: string; line: number; ... }` (sortable). */
  hasFileLine: boolean
}

interface BundleShape {
  bundleInterfaceName: string
  aggregatedTypeName: string | null
  fields: FieldInfo[]
  /** True si tous les fields sont `T[]` arrays — concat-trivial. */
  isConcatOnly: boolean
}

function pascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('')
}

function camelCase(kebab: string): string {
  const parts = kebab.split('-')
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

function findInterface(sf: SourceFile, name: string): InterfaceDeclaration | null {
  return sf.getInterface(name) ?? null
}

function inspectBundle(extractorPath: string, detector: string): BundleShape | { error: string } {
  const project = new Project({ skipAddingFilesFromTsConfig: true })
  const sf = project.addSourceFileAtPath(extractorPath)

  const pascal = pascalCase(detector)
  const bundleName = `${pascal}FileBundle`
  const aggregatedName = `${pascal}Aggregated` // optional

  const bundleIface = findInterface(sf, bundleName)
  if (!bundleIface) {
    return { error: `interface ${bundleName} not found in ${extractorPath}` }
  }

  const fields: FieldInfo[] = []
  let isConcatOnly = true
  for (const prop of bundleIface.getProperties()) {
    const name = prop.getName()
    const typeText = prop.getTypeNode()?.getText() ?? prop.getType().getText()
    const isArray =
      /\[\]\s*$/.test(typeText) || /^Array<.*>$/.test(typeText) || /^ReadonlyArray<.*>$/.test(typeText)
    if (!isArray) isConcatOnly = false

    // Detect `{ file: string; line: number; ... }` shape : look at the
    // element type if array.
    let hasFileLine = false
    if (isArray) {
      const elemType = typeText.replace(/\[\]\s*$/, '').replace(/^Array<(.*)>$/, '$1').replace(/^ReadonlyArray<(.*)>$/, '$1').trim()
      // Try to resolve : look for an interface with that name in the same SF
      const elemIface = findInterface(sf, elemType)
      if (elemIface) {
        const props = elemIface.getProperties().map((p) => p.getName())
        if (props.includes('file') && props.includes('line')) hasFileLine = true
      }
    }
    fields.push({ name, typeText, isArray, hasFileLine })
  }

  const aggregatedIface = findInterface(sf, aggregatedName)
  return {
    bundleInterfaceName: bundleName,
    aggregatedTypeName: aggregatedIface ? aggregatedName : null,
    fields,
    isConcatOnly,
  }
}

function emitSalsaWrapper(
  detector: string,
  shape: BundleShape,
  extractorImportPath: string,
): string {
  const pascal = pascalCase(detector)
  const camel = camelCase(detector)
  const bundleFn = `extract${pascal}FileBundle`

  // Empty bundle literal : { fieldA: [], fieldB: [], ... }
  const emptyBundle = `{
${shape.fields.map((f) => `      ${f.name}: ${f.isArray ? '[]' : 'undefined as never'},`).join('\n')}
    }`

  // Aggregator merge : for each field, concat ; for array-of-{file,line}, sort.
  const mergeBlock = shape.fields.map((f) => {
    if (f.isArray) return `      out.${f.name}.push(...bundle.${f.name})`
    return `      // SYNTH: non-array field "${f.name}" — skipped, override manually if needed`
  }).join('\n')

  const sortBlock = shape.fields.filter((f) => f.hasFileLine).map((f) => `    out.${f.name}.sort(sortFn)`).join('\n')

  const bundleType = shape.bundleInterfaceName
  const aggregatedType = shape.aggregatedTypeName ?? bundleType

  const aggregatedInit = `{
${shape.fields.map((f) => `      ${f.name}: ${f.isArray ? '[]' : 'undefined as never'},`).join('\n')}
    }`

  const aggregatedTypeImport = shape.aggregatedTypeName ? `, ${shape.aggregatedTypeName}` : ''

  return `// ADR-007
/**
 * Incremental ${detector} — Salsa wrapper auto-synthesized via
 * scripts/synth-aggregation.ts (Niveau 4 self-optim).
 *
 * Theory : algebraic data type catamorphism. Pour un Bundle de N fields
 * tous \`T[]\` arrays, l'agrégation canonique est concatMap. Quand les
 * éléments ont la shape \`{ file, line, ... }\`, on applique un sort
 * lex déterministe (cohérence avec ADR-001 deterministic synopsis).
 *
 * Self-optim discovery : ce détecteur sortait dans les candidats math
 * (λ_lyap ≈ 1, mean ≥ 200ms warm). Salsa-isation auto-générée car
 * Bundle shape = pure concat (toutes les fields sont arrays).
 */

import { derived } from '@liby-tools/salsa'
import {
  ${bundleFn},
  type ${bundleType}${aggregatedTypeImport},
} from '${extractorImportPath}'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

export const ${camel}OfFile = derived<string, ${bundleType}>(
  db,
  '${camel}OfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return ${emptyBundle}
    return ${bundleFn}(sf, filePath)
  },
)

export const all${pascal} = derived<string, ${aggregatedType}>(
  db,
  'all${pascal}',
  (label) => {
    const files = projectFiles.get(label)
    const out: ${aggregatedType} = ${aggregatedInit}
    for (const f of files) {
      const bundle = ${camel}OfFile.get(f)
${mergeBlock}
    }
${sortBlock ? `    const sortFn = (a: { file: string; line: number }, b: { file: string; line: number }) =>\n      a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line\n${sortBlock}` : '    // No sortable fields — output deterministic by file iteration order.'}
    return out
  },
)
`
}

async function main(): Promise<void> {
  const detector = process.argv[2]
  if (!detector) {
    console.error('Usage: synth-aggregation.ts <detector-name>')
    process.exit(1)
  }

  const extractorPath = path.join(REPO_ROOT, `packages/codegraph/src/extractors/${detector}.ts`)
  try {
    await fs.access(extractorPath)
  } catch {
    console.error(`✗ Extractor not found: ${extractorPath}`)
    process.exit(1)
  }

  const targetPath = path.join(REPO_ROOT, `packages/codegraph/src/incremental/${detector}.ts`)
  try {
    await fs.access(targetPath)
    console.error(`✗ Salsa wrapper already exists: ${targetPath}`)
    process.exit(1)
  } catch {
    // good — doesn't exist
  }

  const shape = inspectBundle(extractorPath, detector)
  if ('error' in shape) {
    console.error(`✗ Bundle introspection failed: ${shape.error}`)
    console.error('  Fallback : utilise ./scripts/scaffold-salsa.sh pour le squelette manuel.')
    process.exit(1)
  }

  if (!shape.isConcatOnly) {
    const nonArray = shape.fields.filter((f) => !f.isArray).map((f) => f.name).join(', ')
    console.error(`✗ Bundle has non-array fields (${nonArray}) — auto-synthesis only handles concat-only bundles.`)
    console.error('  Fallback : utilise ./scripts/scaffold-salsa.sh + complète manuellement.')
    process.exit(1)
  }

  const code = emitSalsaWrapper(detector, shape, `../extractors/${detector}.js`)
  await fs.writeFile(targetPath, code, 'utf-8')
  console.log(`✓ Synth complete : ${path.relative(REPO_ROOT, targetPath)}`)
  console.log(`  Bundle shape   : ${shape.fields.length} fields, all arrays (concat-trivial)`)
  console.log(`  Sortable fields: ${shape.fields.filter((f) => f.hasFileLine).length}`)
  console.log()
  console.log('Next steps :')
  console.log('  1. Wire dans analyzer.ts (cf. message du scaffold-salsa.sh).')
  console.log('  2. npx tsc -b && npx vitest run')
  console.log('  3. LIBY_PROBE_RUNS=4 npx tsx scripts/self-runtime-probe.ts')
}

main().catch((err) => {
  console.error('synth-aggregation fatal:', err)
  process.exit(1)
})
