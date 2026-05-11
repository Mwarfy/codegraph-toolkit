// ADR-032
/**
 * Cross-package contract test : `adr-toolkit` ↔ `@liby-tools/codegraph`.
 *
 * adr-toolkit n'a pas d'import TS direct vers codegraph — il utilise :
 *   - `npx @liby-tools/codegraph` (CLI bin) au runtime depuis les hooks
 *   - `require.resolve('@liby-tools/codegraph/scripts/datalog-check-fast.mjs')`
 *
 * NB : on teste contre le PATH WORKSPACE (`../../codegraph/...`) plutôt
 * que via `require.resolve` depuis adr-toolkit, parce que le
 * `node_modules` nested d'adr-toolkit peut être une COPIE statique
 * (cf. ADR-032 ## Gotcha). Le path workspace est la source de vérité ;
 * si on retire un fichier, le test pète immédiatement, peu importe le
 * mode d'install.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODEGRAPH_DIR = path.resolve(__dirname, '../../codegraph')
const require = createRequire(import.meta.url)

describe('cross-package contract : adr-toolkit ← @liby-tools/codegraph', () => {
  it('package `@liby-tools/codegraph` reste résoluble (= main entry export)', () => {
    expect(() => require.resolve('@liby-tools/codegraph')).not.toThrow()
  })

  it('script `datalog-check-fast.mjs` existe dans le workspace', () => {
    // adr-toolkit hook utilise ce script (référencé dans
    // codegraph-feedback.sh via require.resolve). Si codegraph le
    // supprime, le hook crash en runtime. Test contre path workspace
    // direct — robuste au node_modules nested.
    const scriptPath = path.join(CODEGRAPH_DIR, 'scripts', 'datalog-check-fast.mjs')
    expect(fs.existsSync(scriptPath), `script attendu : ${scriptPath}`).toBe(true)
  })

  it('bin `codegraph` déclaré dans package.json workspace', () => {
    // adr-toolkit hooks invoquent `npx @liby-tools/codegraph analyze`.
    // Si le bin disparaît du package.json, l'invocation pète.
    const pkgPath = path.join(CODEGRAPH_DIR, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      bin?: Record<string, string>
    }
    expect(pkg.bin).toBeDefined()
    expect(pkg.bin?.codegraph).toBeDefined()
  })

  it('exports stables déclarés dans codegraph package.json (ADR-032 contract list)', () => {
    // Garde-fou : la liste des exports publics est documentée dans
    // ADR-032. Si un export listé est retiré, ce test pète et force
    // une réévaluation explicite du contract.
    const pkgPath = path.join(CODEGRAPH_DIR, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      exports?: Record<string, unknown>
    }
    const requiredExports = ['.', './synopsis', './diff', './snapshot-loader']
    for (const ex of requiredExports) {
      expect(pkg.exports, `export "${ex}" attendu dans package.json`).toHaveProperty(ex)
    }
  })
})
