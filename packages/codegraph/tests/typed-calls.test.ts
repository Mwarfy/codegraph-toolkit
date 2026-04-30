/**
 * Test d'intégration pour l'extracteur typed-calls sur fixture.
 *
 * Invariants testés :
 *   1. Signatures : chaque export callable de la fixture produit une entrée
 *      avec le bon kind, les bons params et la bonne return type.
 *   2. Call edges : chaque appel résolvable à un export de la fixture produit
 *      un edge, avec argTypes et returnType corrects.
 *   3. Déterminisme : deux runs consécutifs produisent une sortie JSON
 *      strictement octet-équivalente.
 *   4. Omission : les calls vers des symboles non trackés (libs externes,
 *      fichiers hors `files`) n'émettent pas d'edge inventé.
 *
 * Lancé via `npm run test:typed-calls` dans codegraph/.
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSharedProject } from '../src/extractors/unused-exports.js'
import { analyzeTypedCalls } from '../src/extractors/typed-calls.js'
import type { TypedCalls, TypedSignature, TypedCallEdge } from '../src/core/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixtureDir = path.resolve(__dirname, 'fixtures/typed-calls')

async function listFixtureFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.ts')) out.push(e.name)
  }
  return out.sort()
}

function findSig(
  sigs: TypedSignature[],
  file: string,
  exportName: string,
): TypedSignature {
  const sig = sigs.find((s) => s.file === file && s.exportName === exportName)
  if (!sig) {
    throw new Error(`signature not found: ${file}:${exportName}`)
  }
  return sig
}

function findEdges(
  edges: TypedCallEdge[],
  from: string,
  to: string,
): TypedCallEdge[] {
  return edges.filter((e) => e.from === from && e.to === to)
}

async function run(): Promise<void> {
  const files = await listFixtureFiles(fixtureDir)
  assert.ok(files.length >= 4, `expected ≥4 fixture files, got ${files.length}`)

  const tsConfigPath = path.join(fixtureDir, 'tsconfig.json')
  const project = createSharedProject(fixtureDir, files, tsConfigPath)
  const result: TypedCalls = await analyzeTypedCalls(fixtureDir, files, project)

  // ─── 1. Signatures ──────────────────────────────────────────────────

  // math.ts : add / multiply / square
  const add = findSig(result.signatures, 'math.ts', 'add')
  assert.equal(add.kind, 'function')
  assert.deepEqual(
    add.params.map((p) => ({ name: p.name, type: p.type, optional: p.optional })),
    [
      { name: 'a', type: 'number', optional: false },
      { name: 'b', type: 'number', optional: false },
    ],
  )
  assert.equal(add.returnType, 'number')

  const square = findSig(result.signatures, 'math.ts', 'square')
  assert.equal(square.kind, 'const')
  assert.equal(square.params.length, 1)
  assert.equal(square.params[0].name, 'x')
  assert.equal(square.returnType, 'number')

  // greeter.ts : Greeter (class) + Greeter.greet (method)
  const greeterClass = findSig(result.signatures, 'greeter.ts', 'Greeter')
  assert.equal(greeterClass.kind, 'class')
  assert.equal(greeterClass.returnType, 'Greeter')
  assert.equal(greeterClass.params.length, 1)
  assert.equal(greeterClass.params[0].name, 'prefix')
  assert.equal(greeterClass.params[0].type, 'string')

  const greet = findSig(result.signatures, 'greeter.ts', 'Greeter.greet')
  assert.equal(greet.kind, 'method')
  assert.equal(greet.params.length, 1)
  assert.equal(greet.params[0].name, 'opts')
  // Le type est scopé : soit "GreetOptions", soit l'inline structural.
  assert.ok(
    greet.params[0].type.includes('GreetOptions') || greet.params[0].type.includes('name'),
    `greet.opts type unexpected: ${greet.params[0].type}`,
  )
  assert.equal(greet.returnType, 'string')

  // consumer.ts : run / runOnce
  const run_ = findSig(result.signatures, 'consumer.ts', 'run')
  assert.equal(run_.kind, 'function')
  assert.equal(run_.returnType, 'string')

  const runOnce = findSig(result.signatures, 'consumer.ts', 'runOnce')
  assert.equal(runOnce.kind, 'const')
  assert.equal(runOnce.returnType, 'number')

  // unused.ts : solo (orphelin, pas d'appelant mais doit avoir sa signature)
  const solo = findSig(result.signatures, 'unused.ts', 'solo')
  assert.equal(solo.kind, 'function')

  // ─── 2. Call edges ──────────────────────────────────────────────────

  // consumer.run() appelle : add (named), multiply (named), square (named),
  // math.add (namespace), new Greeter (named), greeter.greet (method → NON
  // résolu v1, donc pas d'edge ici).

  const fromRun = 'consumer.ts:run'

  // add : appelé 2 fois depuis run (ligne distinctes : direct + via ns)
  // direct
  const addCalls = findEdges(result.callEdges, fromRun, 'math.ts:add')
  assert.ok(addCalls.length >= 1, 'consumer.run should call math.add (direct)')
  const directAdd = addCalls[0]
  assert.deepEqual(directAdd.argTypes, ['number', 'number'])
  assert.equal(directAdd.returnType, 'number')

  // multiply
  const multEdges = findEdges(result.callEdges, fromRun, 'math.ts:multiply')
  assert.equal(multEdges.length, 1)
  assert.deepEqual(multEdges[0].argTypes, ['number', 'number'])

  // square
  const sqEdges = findEdges(result.callEdges, fromRun, 'math.ts:square')
  assert.equal(sqEdges.length, 1)

  // new Greeter(...)
  const greeterEdges = findEdges(result.callEdges, fromRun, 'greeter.ts:Greeter')
  assert.equal(greeterEdges.length, 1)
  assert.equal(greeterEdges[0].returnType, 'Greeter')
  assert.deepEqual(greeterEdges[0].argTypes, ['string'])

  // runOnce appelle add (via arrow body)
  const fromRunOnce = 'consumer.ts:runOnce'
  assert.equal(findEdges(result.callEdges, fromRunOnce, 'math.ts:add').length, 1)

  // greeter.greet n'est PAS résolu (méthode sur instance) — edge absent. OK.
  const methodCalls = result.callEdges.filter((e) => e.to === 'greeter.ts:Greeter.greet')
  assert.equal(methodCalls.length, 0, 'v1 ne doit PAS résoudre les calls sur instance')

  // Namespace : math.add → doit aussi produire un edge de consumer.run vers math.ts:add
  // (déjà compté dans addCalls — on vérifie qu'il y a au moins 2 calls distincts)
  assert.ok(
    addCalls.length >= 2,
    `expected ≥2 edges run→math.add (direct + via namespace), got ${addCalls.length}`,
  )

  // ─── 3. Omission ────────────────────────────────────────────────────
  // Aucun edge vers un symbole hors fixture (ex : console.log, les templates).
  for (const e of result.callEdges) {
    const [toFile] = e.to.split(':')
    assert.ok(files.includes(toFile), `unexpected edge target outside fixture: ${e.to}`)
  }

  // Aucun edge dont `from` est dans unused.ts (pas de call site).
  const fromUnused = result.callEdges.filter((e) => e.from.startsWith('unused.ts:'))
  assert.equal(fromUnused.length, 0)

  // ─── 4. Déterminisme ────────────────────────────────────────────────
  const project2 = createSharedProject(fixtureDir, files, tsConfigPath)
  const result2 = await analyzeTypedCalls(fixtureDir, files, project2)
  assert.equal(
    JSON.stringify(result),
    JSON.stringify(result2),
    'typed-calls output is not byte-equivalent between runs',
  )

  console.log(`✓ typed-calls: ${result.signatures.length} signatures, ${result.callEdges.length} call edges`)
  console.log('  all assertions passed')
}

run().catch((err) => {
  console.error('✗ typed-calls test failed:')
  console.error(err)
  process.exit(1)
})
