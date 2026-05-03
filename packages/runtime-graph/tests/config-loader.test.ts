/**
 * Config loader tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadConfig, defineConfig } from '../src/core/config-loader.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rg-config-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const r = await loadConfig(tmpDir)
    expect(r.path).toBeNull()
    expect(r.config.projectRoot).toBe(tmpDir)
    expect(r.config.factsOutDir).toContain('.codegraph/facts-runtime')
    expect(r.config.drivers).toHaveLength(1)
    expect(r.config.drivers[0].name).toBe('synthetic')
    expect(r.config.capture.sampleRate).toBe(1.0)
  })

  it('loads .libyrc.json and applies defaults to missing fields', async () => {
    const cfgPath = path.join(tmpDir, '.libyrc.json')
    await fs.writeFile(cfgPath, JSON.stringify({
      drivers: [{ name: 'replay-tests', config: { command: 'pnpm', args: ['test'] } }],
      capture: { excludePaths: ['/admin/*'] },
    }))
    const r = await loadConfig(tmpDir)
    expect(r.path).toBe(cfgPath)
    expect(r.config.drivers[0].name).toBe('replay-tests')
    expect(r.config.capture.excludePaths).toEqual(['/admin/*'])
    // Defaults appliqués sur les autres champs capture
    expect(r.config.capture.sampleRate).toBe(1.0)
    expect(r.config.capture.enableAutoInstruments).toBe(true)
  })

  it('preserves expectedTables / expectedRoutes when set', async () => {
    await fs.writeFile(path.join(tmpDir, 'liby-runtime.config.json'), JSON.stringify({
      expectedTables: [{ name: 'orders', maxQuietMin: 60 }],
      expectedRoutes: [{ method: 'GET', path: '/api/orders' }],
    }))
    const r = await loadConfig(tmpDir)
    expect(r.config.expectedTables).toEqual([{ name: 'orders', maxQuietMin: 60 }])
    expect(r.config.expectedRoutes).toEqual([{ method: 'GET', path: '/api/orders' }])
  })

  it('falls back to defaults gracefully when config file is malformed', async () => {
    await fs.writeFile(path.join(tmpDir, '.libyrc.json'), '{ this is not valid JSON')
    const r = await loadConfig(tmpDir)
    // Phase α tolérant : malformed file → defaults (no throw)
    expect(r.path).toBeNull()                                          // not loaded
    expect(r.config.drivers[0].name).toBe('synthetic')                 // default
  })

  it('honors resolution priority (.ts > .js > .json > .libyrc)', async () => {
    // Create both .json and .libyrc — .json wins (earlier in CONFIG_BASENAMES)
    await fs.writeFile(path.join(tmpDir, 'liby-runtime.config.json'), JSON.stringify({
      drivers: [{ name: 'priority-json' }],
    }))
    await fs.writeFile(path.join(tmpDir, '.libyrc.json'), JSON.stringify({
      drivers: [{ name: 'priority-libyrc' }],
    }))
    const r = await loadConfig(tmpDir)
    expect(r.path).toContain('liby-runtime.config.json')
    expect(r.config.drivers[0].name).toBe('priority-json')
  })
})

describe('defineConfig', () => {
  it('returns the config as-is (type-safety helper)', () => {
    const c = defineConfig({
      drivers: [{ name: 'synthetic' }],
      capture: { sampleRate: 0.5 },
    })
    expect(c.drivers[0].name).toBe('synthetic')
    expect(c.capture?.sampleRate).toBe(0.5)
  })
})
