/**
 * Tests pour bin-shebangs extractor — publish hygiene.
 *
 * Couvre les 4 kinds : missing-shebang, bin-target-missing, wrong-shebang,
 * bin-path-leading-dot, plus le case happy-path (rien à signaler).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { analyzeBinShebangs } from '../src/extractors/bin-shebangs.js'

let tmpRoot: string

async function writePkg(dir: string, name: string, bin: any): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', bin }, null, 2),
  )
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-bin-shebang-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('bin-shebangs — happy path', () => {
  it('returns empty when bin file has node shebang', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, 'mypkg', { mypkg: 'dist/cli.js' })
    await mkdir(path.join(pkgDir, 'dist'), { recursive: true })
    await writeFile(path.join(pkgDir, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("ok")')

    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toEqual([])
  })

  it('skips packages without bin field', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, 'mypkg', undefined)
    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toEqual([])
  })

  it('handles bin as string (uses unscoped package name as bin name)', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, '@scope/mypkg', 'cli.js')
    await writeFile(path.join(pkgDir, 'cli.js'), '#!/usr/bin/env node\n')
    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toEqual([])
  })
})

describe('bin-shebangs — missing-shebang', () => {
  it('flags bin file without shebang', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, 'mypkg', { mypkg: 'dist/cli.js' })
    await mkdir(path.join(pkgDir, 'dist'), { recursive: true })
    await writeFile(path.join(pkgDir, 'dist', 'cli.js'), 'console.log("no shebang")')

    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('missing-shebang')
    expect(issues[0].binName).toBe('mypkg')
    expect(issues[0].resolvedPath).toBe('pkg/dist/cli.js')
  })
})

describe('bin-shebangs — wrong-shebang', () => {
  it('flags bin file with non-node shebang', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, 'mypkg', { mypkg: 'cli.sh' })
    await writeFile(path.join(pkgDir, 'cli.sh'), '#!/bin/bash\necho hi')

    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('wrong-shebang')
    expect(issues[0].observedShebang).toBe('#!/bin/bash')
  })
})

describe('bin-shebangs — bin-target-missing', () => {
  it('flags bin pointing to non-existent file', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, 'mypkg', { mypkg: 'dist/missing.js' })

    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('bin-target-missing')
  })
})

describe('bin-shebangs — bin-path-leading-dot', () => {
  it('flags bin path starting with ./', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, 'mypkg', { mypkg: './dist/cli.js' })
    await mkdir(path.join(pkgDir, 'dist'), { recursive: true })
    await writeFile(path.join(pkgDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n')

    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('bin-path-leading-dot')
    expect(issues[0].binPath).toBe('./dist/cli.js')
  })

  it('takes precedence over other checks (file content not inspected)', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, 'mypkg', { mypkg: './dist/missing.js' })
    // file does NOT exist — but leading-dot fires first
    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toHaveLength(1)
    expect(issues[0].kind).toBe('bin-path-leading-dot')
  })
})

describe('bin-shebangs — multiple bins', () => {
  it('reports each bin entry independently', async () => {
    const pkgDir = path.join(tmpRoot, 'pkg')
    await writePkg(pkgDir, 'mypkg', {
      good: 'good.js',
      bad: 'bad.js',
      'leading-dot': './ld.js',
    })
    await writeFile(path.join(pkgDir, 'good.js'), '#!/usr/bin/env node\n')
    await writeFile(path.join(pkgDir, 'bad.js'), 'no shebang\n')
    await writeFile(path.join(pkgDir, 'ld.js'), '#!/usr/bin/env node\n')

    const issues = await analyzeBinShebangs(tmpRoot)
    expect(issues).toHaveLength(2)
    const kinds = issues.map((i) => i.kind).sort()
    expect(kinds).toEqual(['bin-path-leading-dot', 'missing-shebang'])
  })
})
