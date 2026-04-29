/**
 * End-to-end : simulate the codegraph use case (parseFile → importsOf →
 * reverseDeps). Validates that with N files, on a single-file change,
 * only the affected queries recompute.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Database, input, derived } from '../src/index.js'

describe('salsa — e2e codegraph-like', () => {
  let db: Database
  let fileContent: ReturnType<typeof input<string, string>>
  let projectFiles: ReturnType<typeof input<string, readonly string[]>>
  let importsOf: ReturnType<typeof derived<string, readonly string[]>>
  let reverseDeps: ReturnType<typeof derived<string, readonly string[]>>

  beforeEach(() => {
    db = new Database()
    fileContent = input<string, string>(db, 'fileContent')
    projectFiles = input<string, readonly string[]>(db, 'projectFiles')

    // importsOf : trivial regex on file content.
    importsOf = derived<string, readonly string[]>(db, 'importsOf', (path) => {
      const src = fileContent.get(path)
      const re = /import.*from ['"](\.[^'"]+)['"]/g
      const out: string[] = []
      let m
      while ((m = re.exec(src)) !== null) out.push(m[1])
      return Object.freeze(out)
    })

    // reverseDeps : for `target`, list files that import `target` directly.
    reverseDeps = derived<string, readonly string[]>(db, 'reverseDeps', (target) => {
      const files = projectFiles.get('all')
      const out: string[] = []
      for (const f of files) {
        if (importsOf.get(f).includes(target)) out.push(f)
      }
      return Object.freeze(out)
    })
  })

  it('first run computes everything', () => {
    projectFiles.set('all', ['a.ts', 'b.ts', 'c.ts'])
    fileContent.set('a.ts', `import { x } from './b'`)
    fileContent.set('b.ts', `// nothing`)
    fileContent.set('c.ts', `import { y } from './b'`)

    expect(reverseDeps.get('./b')).toEqual(['a.ts', 'c.ts'])
    expect(db.stats().misses.importsOf).toBe(3)            // each file parsed once
    expect(db.stats().misses.reverseDeps).toBe(1)
  })

  it('changing a file content reparses ONLY that file', () => {
    projectFiles.set('all', ['a.ts', 'b.ts', 'c.ts'])
    fileContent.set('a.ts', `import { x } from './b'`)
    fileContent.set('b.ts', ``)
    fileContent.set('c.ts', `import { y } from './b'`)
    reverseDeps.get('./b')

    // Change 'a.ts' — different imports
    fileContent.set('a.ts', `import { z } from './c'`)

    expect(reverseDeps.get('./b')).toEqual(['c.ts'])
    expect(db.stats().misses.importsOf).toBe(4)            // 3 first run + 1 reparse a.ts
    expect(db.stats().misses.reverseDeps).toBe(2)          // result changed
  })

  it('no-op set doesn\'t recompute anything', () => {
    projectFiles.set('all', ['a.ts'])
    fileContent.set('a.ts', `import { x } from './b'`)
    reverseDeps.get('./b')
    fileContent.set('a.ts', `import { x } from './b'`)    // same content
    reverseDeps.get('./b')                                  // hit
    expect(db.stats().misses.importsOf).toBe(1)
    expect(db.stats().misses.reverseDeps).toBe(1)
  })

  it('changing one file does NOT reparse the others', () => {
    projectFiles.set('all', ['a.ts', 'b.ts', 'c.ts'])
    fileContent.set('a.ts', `import 'a-content'`)
    fileContent.set('b.ts', `import 'b-content'`)
    fileContent.set('c.ts', `import 'c-content'`)
    reverseDeps.get('./x')                                  // forces all 3 to parse
    expect(db.stats().misses.importsOf).toBe(3)

    fileContent.set('b.ts', `import 'b-NEW-content'`)
    reverseDeps.get('./x')

    // Only b.ts re-parsed, a.ts + c.ts cached.
    expect(db.stats().misses.importsOf).toBe(4)
  })

  it('scales: 100 files, 1 change → only 1 reparse', () => {
    const N = 100
    const allFiles = Array.from({ length: N }, (_, i) => `f${i}.ts`)
    projectFiles.set('all', allFiles)
    for (const f of allFiles) {
      fileContent.set(f, `import { x } from './shared'`)
    }
    reverseDeps.get('./shared')                             // 100 parses
    expect(db.stats().misses.importsOf).toBe(N)

    // One file content changed (but still imports './shared')
    fileContent.set('f42.ts', `import { y } from './shared'`)
    reverseDeps.get('./shared')

    // Only f42.ts re-parsed. Everything else cached.
    expect(db.stats().misses.importsOf).toBe(N + 1)
    // reverseDeps recomputed because f42.ts importsOf was bumped, but
    // the resulting array is the same — still misses (we did call fn) but
    // value unchanged means downstream of reverseDeps would skip.
    expect(db.stats().misses.reverseDeps).toBe(2)
  })

  it('verifies determinism: multiple runs produce same outputs', () => {
    projectFiles.set('all', ['a.ts', 'b.ts'])
    fileContent.set('a.ts', `import { x } from './b'`)
    fileContent.set('b.ts', `import { y } from './a'`)
    const r1 = reverseDeps.get('./a')
    const r2 = reverseDeps.get('./b')
    // Reset and rerun.
    db.reset()
    const fc2 = input<string, string>(db, 'fileContent')
    const pf2 = input<string, readonly string[]>(db, 'projectFiles')
    const io2 = derived<string, readonly string[]>(db, 'importsOf', (path) => {
      const src = fc2.get(path)
      const re = /import.*from ['"](\.[^'"]+)['"]/g
      const out: string[] = []
      let m
      while ((m = re.exec(src)) !== null) out.push(m[1])
      return Object.freeze(out)
    })
    const rd2 = derived<string, readonly string[]>(db, 'reverseDeps', (target) => {
      const files = pf2.get('all')
      const out: string[] = []
      for (const f of files) {
        if (io2.get(f).includes(target)) out.push(f)
      }
      return Object.freeze(out)
    })
    pf2.set('all', ['a.ts', 'b.ts'])
    fc2.set('a.ts', `import { x } from './b'`)
    fc2.set('b.ts', `import { y } from './a'`)
    expect(rd2.get('./a')).toEqual(r1)
    expect(rd2.get('./b')).toEqual(r2)
  })
})
