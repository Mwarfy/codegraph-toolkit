/**
 * Tests pour hardcoded-secrets extractor (Phase 4 Tier 2).
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { extractHardcodedSecretsFileBundle } from '../src/extractors/hardcoded-secrets.js'

function fileFromText(text: string, name = 'src/test.ts') {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile(name, text)
  return { sf, name }
}

describe('hardcoded-secrets — name trigger', () => {
  it('flag une variable api_key avec valeur high-entropy', () => {
    const { sf, name } = fileFromText(`
      const api_key = "sk-aB7xQ9zR2mN8vL4kP1jH6tY3wE5rT0uI"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toHaveLength(1)
    expect(secrets[0].context).toBe('api_key')
    expect(secrets[0].entropy).toBeGreaterThan(4)
  })

  it('skip une variable api_key avec placeholder low-entropy', () => {
    const { sf, name } = fileFromText(`
      const api_key = "your-api-key-here-please-change"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toEqual([])
  })

  it('flag une property "token" dans object literal', () => {
    const { sf, name } = fileFromText(`
      export const config = {
        token: "GH7d9F3kL2mN8vQ4xR6yZ1bC5tWp0jU8eHs"
      }
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toHaveLength(1)
    expect(secrets[0].context).toBe('token')
  })

  it('skip si valeur < min length', () => {
    const { sf, name } = fileFromText(`
      const api_key = "shortone"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toEqual([])
  })

  it('skip si nom de variable n\\u0027est pas suspect', () => {
    const { sf, name } = fileFromText(`
      const message = "aB7xQ9zR2mN8vL4kP1jH6tY3wE5rT0uI"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toEqual([])
  })
})

// Prefixes connus reconstitues au runtime — sinon GitHub secret scanning
// flag le test file lui-meme comme leak (faux-positif sur fixtures de test).
const PREFIX_STRIPE = 'sk_live' + '_'
const PREFIX_GITHUB = 'ghp' + '_'
const PREFIX_AWS = 'AKIA' + 'IOSFODNN7EXAMPLE'
const PREFIX_SLACK = 'xoxb' + '-'
const RANDOM_BODY = 'aB7xQ9zR2mN8vL4kP1jH6tY3wE5rT0uI'

describe('hardcoded-secrets — pattern trigger (known prefix)', () => {
  it('flag stripe live token meme sans variable name suspect', () => {
    const { sf, name } = fileFromText(`
      const x = "${PREFIX_STRIPE}${RANDOM_BODY}"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toHaveLength(1)
    expect(secrets[0].trigger).toBe('pattern')
  })

  it('flag GitHub PAT', () => {
    const { sf, name } = fileFromText(`
      const x = "${PREFIX_GITHUB}${RANDOM_BODY}"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toHaveLength(1)
  })

  it('flag AWS access key', () => {
    const { sf, name } = fileFromText(`
      const x = "${PREFIX_AWS}"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toHaveLength(1)
  })

  it('flag Slack bot token', () => {
    const { sf, name } = fileFromText(`
      const x = "${PREFIX_SLACK}${RANDOM_BODY}"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toHaveLength(1)
  })
})

describe('hardcoded-secrets — exemptions', () => {
  it('skip les fichiers de test', () => {
    const { sf, name } = fileFromText(
      `const api_key = "sk-aB7xQ9zR2mN8vL4kP1jH6tY3wE5rT0uI"`,
      'tests/auth.test.ts',
    )
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toEqual([])
  })

  it('skip avec marker secret-ok sur ligne précédente', () => {
    const { sf, name } = fileFromText(`
      // secret-ok: dummy secret pour mock OAuth flow
      const api_key = "sk-aB7xQ9zR2mN8vL4kP1jH6tY3wE5rT0uI"
    `)
    const { secrets } = extractHardcodedSecretsFileBundle(sf, name)
    expect(secrets).toEqual([])
  })
})
