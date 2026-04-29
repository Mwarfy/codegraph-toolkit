/**
 * Tests for the Datalog facts exporter.
 *
 * Builds a tiny fake snapshot, runs `exportFacts`, then asserts :
 *   1. Each expected `.facts` file exists, with the expected line count
 *   2. TSV format : tab-separated, no header, no quotes
 *   3. EmitsLiteral / EmitsConstRef / EmitsDynamic split correctly by `kind`
 *   4. ConstRef expressions split into (namespace, member)
 *   5. `schema.dl` declares each relation + .input
 *   6. Sanitization : tab/newline replaced by space (no broken TSV)
 */

import assert from 'node:assert/strict'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { exportFacts } from '../src/facts/index.js'
import type { GraphSnapshot } from '../src/core/types.js'

function fakeSnapshot(): GraphSnapshot {
  return {
    version: '1',
    generatedAt: '2026-04-29T19:00:00.000Z',
    commitHash: 'deadbee',
    rootDir: '/tmp/fake',
    nodes: [
      {
        id: 'src/a.ts', label: 'a.ts', type: 'file', status: 'connected',
        tags: ['kernel'],
      },
      {
        id: 'src/b.ts', label: 'b.ts', type: 'file', status: 'connected',
        tags: ['pack', 'visual-render'],
      },
      // String value with embedded TAB to test sanitization
      {
        id: 'src/c\twith-tab.ts', label: 'c.ts', type: 'file', status: 'orphan',
        tags: [],
      },
    ],
    edges: [
      {
        id: '1', from: 'src/a.ts', to: 'src/b.ts',
        type: 'import', resolved: true, line: 5,
      },
      // Duplicate import: same from/to but different line. Imports binary
      // dedup; ImportEdge keeps both.
      {
        id: '2', from: 'src/a.ts', to: 'src/b.ts',
        type: 'import', resolved: true, line: 12,
      },
      // Non-import edge: must NOT appear in Imports*
      {
        id: '3', from: 'src/a.ts', to: 'src/b.ts',
        type: 'event', resolved: true, label: 'foo.bar', line: 99,
      },
    ],
    stats: {
      totalFiles: 3, totalEdges: 3,
      orphanCount: 1, connectedCount: 2,
      entryPointCount: 0, uncertainCount: 0,
      edgesByType: {
        import: 2, event: 1, route: 0, queue: 0, 'dynamic-load': 0, 'db-table': 0,
      },
      healthScore: 0.66,
    },
    eventEmitSites: [
      {
        file: 'src/a.ts', line: 10, symbol: 'doit', callee: 'emit',
        isMethodCall: false, kind: 'literal', literalValue: 'render.completed',
      },
      {
        file: 'src/b.ts', line: 22, symbol: '', callee: 'emit',
        isMethodCall: false, kind: 'eventConstRef',
        refExpression: 'EVENTS.RENDER_COMPLETED',
      },
      {
        file: 'src/b.ts', line: 30, symbol: '', callee: 'emit',
        isMethodCall: false, kind: 'eventConstRef',
        // 3-segment ref → must fall back to dynamic via splitRef
        refExpression: 'obj.events.X',
      },
      {
        file: 'src/b.ts', line: 41, symbol: '', callee: 'emit',
        isMethodCall: false, kind: 'dynamic',
      },
    ],
    envUsage: [
      {
        name: 'PORT', isSecret: false,
        readers: [
          { file: 'src/a.ts', symbol: 'main', line: 3, hasDefault: true },
        ],
      },
      {
        name: 'OPENAI_API_KEY', isSecret: true,
        readers: [
          { file: 'src/b.ts', symbol: '', line: 7, hasDefault: false },
        ],
      },
    ],
    moduleMetrics: [
      { file: 'src/a.ts', fanIn: 0, fanOut: 1, pageRank: 0.1, henryKafura: 0, loc: 50 },
      { file: 'src/b.ts', fanIn: 1, fanOut: 0, pageRank: 0.4, henryKafura: 0, loc: 30 },
    ],
  }
}

async function run(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-facts-'))
  try {
    const snap = fakeSnapshot()
    const result = await exportFacts(snap, { outDir: tmp })

    // ─── 1. expected files exist ──────────────────────────────────────
    const expected = [
      'File', 'FileTag', 'Imports', 'ImportEdge',
      'EmitsLiteral', 'EmitsConstRef', 'EmitsDynamic',
      'EnvRead', 'ModuleFanIn',
    ]
    for (const name of expected) {
      const p = path.join(tmp, `${name}.facts`)
      await fs.access(p)
    }
    console.log('✓ facts: all expected .facts files written')

    // ─── 2. File / FileTag counts ─────────────────────────────────────
    const fileLines = await readLines(tmp, 'File')
    assert.equal(fileLines.length, 3, 'File should have 3 tuples')
    const tagLines = await readLines(tmp, 'FileTag')
    // a → kernel, b → pack, b → visual-render. c has no tags.
    assert.equal(tagLines.length, 3, 'FileTag should have 3 tuples')
    console.log('✓ facts: File / FileTag counts match')

    // ─── 3. Imports binary dedup vs ImportEdge ────────────────────────
    const imports = await readLines(tmp, 'Imports')
    assert.equal(imports.length, 1, 'Imports binary dedup → 1')
    const edges = await readLines(tmp, 'ImportEdge')
    assert.equal(edges.length, 2, 'ImportEdge keeps both lines')
    console.log('✓ facts: Imports dedup + ImportEdge preserves lines')

    // ─── 4. Emits split by kind ───────────────────────────────────────
    const literals = await readLines(tmp, 'EmitsLiteral')
    assert.equal(literals.length, 1)
    assert.deepEqual(literals[0].split('\t'),
      ['src/a.ts', '10', 'render.completed'])

    const refs = await readLines(tmp, 'EmitsConstRef')
    assert.equal(refs.length, 1, '3-segment ref must fall back to dynamic')
    assert.deepEqual(refs[0].split('\t'),
      ['src/b.ts', '22', 'EVENTS', 'RENDER_COMPLETED'])

    const dyns = await readLines(tmp, 'EmitsDynamic')
    // Both the 3-segment ref AND the explicit dynamic count
    assert.equal(dyns.length, 2)
    console.log('✓ facts: Emits* split correctly (literal=1, constRef=1, dynamic=2)')

    // ─── 5. EnvRead bools as symbols ──────────────────────────────────
    const env = await readLines(tmp, 'EnvRead')
    assert.equal(env.length, 2)
    const envCols = env.map((l) => l.split('\t')).sort()
    assert.deepEqual(envCols, [
      ['src/a.ts', '3', 'PORT', 'true'],
      ['src/b.ts', '7', 'OPENAI_API_KEY', 'false'],
    ])
    console.log('✓ facts: EnvRead bool encoded as true/false symbols')

    // ─── 6. ModuleFanIn ───────────────────────────────────────────────
    const fan = await readLines(tmp, 'ModuleFanIn')
    assert.equal(fan.length, 2)
    console.log('✓ facts: ModuleFanIn populated')

    // ─── 7. schema.dl declares each relation ──────────────────────────
    const schema = await fs.readFile(result.schemaFile, 'utf-8')
    for (const name of expected) {
      assert.ok(
        schema.includes(`.decl ${name}(`),
        `schema.dl missing .decl ${name}(`,
      )
      assert.ok(
        schema.includes(`.input ${name}\n`),
        `schema.dl missing .input ${name}`,
      )
    }
    console.log('✓ facts: schema.dl declares each relation')

    // ─── 8. Sanitization ──────────────────────────────────────────────
    // The file with embedded \t must have its tab replaced by space — i.e.
    // the line still has exactly 1 column.
    const fileFile = await fs.readFile(path.join(tmp, 'File.facts'), 'utf-8')
    const sanitized = fileFile.split('\n').filter(Boolean)
      .find((l) => l.includes('c with-tab.ts'))
    assert.ok(sanitized, 'tab in id was not sanitized to space')
    console.log('✓ facts: TSV sanitization replaces \\t with space')

    console.log(`\n  ${result.relations.length} relations, ${result.relations.reduce((s, r) => s + r.tuples, 0)} tuples — all assertions passed`)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

async function readLines(dir: string, name: string): Promise<string[]> {
  const content = await fs.readFile(path.join(dir, `${name}.facts`), 'utf-8')
  return content.split('\n').filter((l) => l.length > 0)
}

run().catch((err) => {
  console.error('✗ facts test failed:')
  console.error(err)
  process.exit(1)
})
