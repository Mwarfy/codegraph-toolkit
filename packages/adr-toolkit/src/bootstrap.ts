/**
 * `adr-toolkit bootstrap` — auto-rédaction de drafts ADR via agents Sonnet ciblés.
 *
 * Architecture en 3 rôles séparés (la clé du cadrage) :
 *
 *   OÙ regarder       → codegraph + pattern detectors (déterministe)
 *   COMMENT formuler  → agents Sonnet avec prompt ultra-cadré (LLM)
 *   QUOI accepter     → humain (CLI revue + apply confirmé)
 *
 * L'agent ne décide pas du périmètre. L'agent ne valide pas son output.
 * L'agent fait UNE chose : rédiger un draft ADR depuis un pattern détecté.
 *
 * Garde-fous anti-dérive :
 * - Why halluciné → forcé à citer commentaire/git OU "TODO" → flag basse confiance
 * - Asserts inventés → checkAsserts AVANT d'écrire l'ADR, refusé si pète
 * - Sur-génération → candidat vient de codegraph, pas du LLM
 * - Rule générique → refus si "for consistency", "for maintainability", etc.
 */

import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import type { AdrToolkitConfig } from './config.js'

// ─── Pattern candidates ─────────────────────────────────────────────────────

export type PatternKind = 'singleton' | 'fsm' | 'write-isolation' | 'hub'

export interface PatternCandidate {
  kind: PatternKind
  /** Path absolu du fichier candidat */
  filePath: string
  /** Path relatif au rootDir */
  relativePath: string
  /** Indice spécifique au pattern (line numbers, symbol names, etc.) */
  evidence: string
}

const SINGLETON_REGEX = /(?:private\s+)?static\s+(?:readonly\s+)?instance\s*[:=]/

/**
 * Scan les fichiers (depuis le snapshot codegraph ou un walk simple) et
 * retourne les candidats pattern par catégorie.
 *
 * Pour le MVP : seul `singleton` est détecté. FSM/write-isolation/hub
 * arriveront en suite.
 */
export async function detectSingletonCandidates(
  config: AdrToolkitConfig,
  files: string[],
): Promise<PatternCandidate[]> {
  const candidates: PatternCandidate[] = []

  for (const relativePath of files) {
    if (!relativePath.endsWith('.ts') && !relativePath.endsWith('.tsx')) continue
    const fullPath = path.join(config.rootDir, relativePath)
    let content: string
    try {
      content = await readFile(fullPath, 'utf-8')
    } catch {
      continue
    }
    if (!SINGLETON_REGEX.test(content)) continue
    const lines = content.split('\n')
    const evidenceLine = lines.findIndex(l => SINGLETON_REGEX.test(l))
    candidates.push({
      kind: 'singleton',
      filePath: fullPath,
      relativePath,
      evidence: `line ${evidenceLine + 1}: ${lines[evidenceLine]?.trim() ?? ''}`,
    })
  }

  return candidates
}

// ─── Draft schema (output du LLM) ───────────────────────────────────────────

export interface AdrDraft {
  /** Verdict de l'agent : propose ou skip */
  verdict: 'propose' | 'skip'
  /** Raison du skip si applicable */
  reason?: string
  /** Numéro proposé (incrémenté dans l'orchestrateur, pas le LLM) */
  num?: string
  /** Titre court (≤60 chars) */
  title?: string
  /** Rule (1 phrase, ≤120 chars, présent indicatif) */
  rule?: string
  /** Why (2 phrases max, doit citer source ou TODO) */
  why?: string
  /** Asserts ts-morph */
  asserts?: Array<{
    symbol: string
    exists?: boolean
    type?: string
  }>
  /** Fichiers à ancrer (paths relatifs) */
  anchors?: string[]
  /** Confiance auto-calculée par l'orchestrateur (low/medium/high) */
  confidence?: 'low' | 'medium' | 'high'
  /** Pattern détecté qui a déclenché ce draft */
  pattern: PatternKind
  /** Path du candidat principal */
  primaryAnchor: string
}

// ─── Prompt templates par pattern ───────────────────────────────────────────

const SINGLETON_PROMPT_TEMPLATE = (args: {
  filePath: string
  fileContent: string
  evidence: string
}) => `Tu es un assistant d'extraction d'ADR. UN seul fichier, UN seul pattern.

PATTERN DÉTECTÉ : SINGLETON
FICHIER : ${args.filePath}
ÉVIDENCE : ${args.evidence}

CODE (max 200 lignes) :
\`\`\`typescript
${args.fileContent.slice(0, 8000)}
\`\`\`

TÂCHE LIMITÉE :
1. Confirme le pattern Singleton (constructeur privé + static instance + getInstance) OU réponds avec verdict "skip" si c'est un faux positif.
2. Rule : 1 phrase, ≤120 chars, présent indicatif. PAS de "for consistency" / "for maintainability" / "for cleanliness".
3. Why : 2 phrases MAX. PRIORITÉ : cite un commentaire en tête de fichier ou de classe (avec numéro de ligne entre parenthèses si possible). Si rien à citer → écrire littéralement "TODO: pourquoi ce singleton ?".
4. Title : nom court (≤60 chars).
5. Asserts ts-morph : symbole exact (className, getInstance), exists: true.
6. Anchors : ce fichier uniquement (l'orchestrateur étendra si besoin).

OUTPUT : utilise OBLIGATOIREMENT l'outil "submit_draft" avec un JSON conforme au schema. Ne réponds rien d'autre.`

// ─── Tool définition pour structured output ─────────────────────────────────

const DRAFT_TOOL = {
  name: 'submit_draft',
  description: 'Soumet un draft d\'ADR (ou skip)',
  input_schema: {
    type: 'object' as const,
    properties: {
      verdict: { type: 'string', enum: ['propose', 'skip'] },
      reason: { type: 'string' },
      title: { type: 'string', maxLength: 60 },
      rule: { type: 'string', maxLength: 120 },
      why: { type: 'string' },
      asserts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            exists: { type: 'boolean' },
            type: { type: 'string' },
          },
          required: ['symbol'],
        },
      },
      anchors: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['verdict'],
  },
}

// ─── Orchestrateur ──────────────────────────────────────────────────────────

export interface BootstrapOptions {
  config: AdrToolkitConfig
  /**
   * Mode d'invocation de l'agent :
   *   - 'auto' (default) : utilise Claude CLI s'il est dispo (auth keychain),
   *     sinon SDK avec ANTHROPIC_API_KEY
   *   - 'cli' : force Claude CLI (échoue si absent)
   *   - 'sdk' : force Anthropic SDK (échoue si pas d'API key)
   */
  agentMode?: 'auto' | 'cli' | 'sdk'
  /** API key Anthropic (pour mode sdk). Default : process.env.ANTHROPIC_API_KEY */
  apiKey?: string
  /** Modèle. Default : sonnet (alias Claude CLI) ou claude-sonnet-4-5 (SDK) */
  model?: string
  /** Liste des candidats à traiter. Sinon détection auto. */
  candidates?: PatternCandidate[]
  /** Limiter le nombre de candidats traités (cost control) */
  maxCandidates?: number
}

export interface BootstrapResult {
  drafts: AdrDraft[]
  skipped: Array<{ candidate: PatternCandidate; reason: string }>
  errors: Array<{ candidate: PatternCandidate; error: string }>
}

const GENERIC_RULE_PHRASES = [
  /for\s+consistency/i,
  /for\s+maintainability/i,
  /for\s+cleanliness/i,
  /best\s+practice/i,
  /code\s+quality/i,
]

function calculateConfidence(draft: AdrDraft): 'low' | 'medium' | 'high' {
  if (draft.verdict !== 'propose') return 'low'
  if (!draft.rule || !draft.why) return 'low'
  if (draft.why.startsWith('TODO')) return 'low'
  if (GENERIC_RULE_PHRASES.some(re => re.test(draft.rule!))) return 'low'
  // Confiance haute = Why cite quelque chose (parenthèses avec ligne, ou guillemets)
  if (/\(line\s+\d+\)|"[^"]+"/.test(draft.why)) return 'high'
  return 'medium'
}

// ─── Claude CLI invocation ──────────────────────────────────────────────────

async function isClaudeCliAvailable(): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('which', ['claude'], { stdio: 'pipe' })
    child.on('close', code => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

const CLI_SYSTEM_PROMPT = `Tu es un assistant d'extraction d'ADR. Tu réponds UNIQUEMENT avec un objet JSON brut conforme au schema fourni dans le prompt utilisateur.

RÈGLES STRICTES :
- Pas de markdown, pas de \`\`\`json, pas d'explication.
- Seulement l'objet JSON brut sur stdout.
- Si tu hésites ou si le pattern ne tient pas, output {"verdict":"skip","reason":"..."}.`

const CLI_SCHEMA_HINT = `
Schema attendu :
{
  "verdict": "propose" | "skip",
  "reason": string (si skip),
  "title": string (≤60 chars),
  "rule": string (≤120 chars, présent indicatif, PAS "for consistency" / "best practice"),
  "why": string (2 phrases max, cite ligne ou TODO),
  "asserts": [{ "symbol": string, "exists": boolean, "type"?: string }],
  "anchors": [string]
}`

async function callViaClaudeCli(args: {
  systemPrompt: string
  userPrompt: string
  model: string
}): Promise<Partial<AdrDraft>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--model', args.model,
        '--output-format', 'json',
        '--system-prompt', args.systemPrompt,
        args.userPrompt,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`))
        return
      }
      // Wrapper Claude CLI : { type:"result", result:"<le JSON string>" }
      let cliWrapper: { result?: string }
      try {
        cliWrapper = JSON.parse(stdout)
      } catch (e) {
        reject(new Error(`CLI output not JSON: ${stdout.slice(0, 200)}`))
        return
      }
      if (!cliWrapper.result) {
        reject(new Error(`CLI wrapper has no result field: ${stdout.slice(0, 200)}`))
        return
      }
      // Strip markdown au cas où le LLM en ajoute malgré le system prompt
      let jsonText = cliWrapper.result.trim()
      const fence = jsonText.match(/```(?:json)?\n([\s\S]+?)\n```/)
      if (fence) jsonText = fence[1].trim()
      try {
        resolve(JSON.parse(jsonText) as Partial<AdrDraft>)
      } catch (e) {
        reject(new Error(`Cannot parse draft JSON: ${jsonText.slice(0, 300)}`))
      }
    })
  })
}

// ─── Anthropic SDK invocation ───────────────────────────────────────────────

async function callViaSdk(args: {
  client: Anthropic
  systemPrompt: string
  userPrompt: string
  model: string
}): Promise<Partial<AdrDraft>> {
  const response = await args.client.messages.create({
    model: args.model,
    max_tokens: 1024,
    system: args.systemPrompt,
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_draft' },
    messages: [{ role: 'user', content: args.userPrompt }],
  })
  const toolUse = response.content.find(c => c.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('No tool_use in response')
  }
  return toolUse.input as Partial<AdrDraft>
}

// ─── Orchestrateur ──────────────────────────────────────────────────────────

export async function bootstrapAdrs(opts: BootstrapOptions): Promise<BootstrapResult> {
  const { config } = opts
  const candidates = (opts.candidates ?? []).slice(0, opts.maxCandidates ?? 10)
  if (candidates.length === 0) {
    return { drafts: [], skipped: [], errors: [] }
  }

  // Choix du mode
  const requestedMode = opts.agentMode ?? 'auto'
  const cliAvailable = await isClaudeCliAvailable()
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
  let mode: 'cli' | 'sdk'
  if (requestedMode === 'cli') {
    if (!cliAvailable) throw new Error('Claude CLI demandé mais introuvable dans PATH')
    mode = 'cli'
  } else if (requestedMode === 'sdk') {
    if (!apiKey) throw new Error('Mode SDK demandé mais ANTHROPIC_API_KEY absent')
    mode = 'sdk'
  } else {
    if (cliAvailable) mode = 'cli'
    else if (apiKey) mode = 'sdk'
    else throw new Error('Ni Claude CLI ni ANTHROPIC_API_KEY disponibles. Install Claude Code (https://claude.com/claude-code) ou set ANTHROPIC_API_KEY.')
  }

  const sdkClient = mode === 'sdk' ? new Anthropic({ apiKey: apiKey! }) : null
  const model = opts.model ?? (mode === 'cli' ? 'sonnet' : 'claude-sonnet-4-5')

  const drafts: AdrDraft[] = []
  const skipped: BootstrapResult['skipped'] = []
  const errors: BootstrapResult['errors'] = []

  for (const candidate of candidates) {
    try {
      let fileContent: string
      try {
        fileContent = await readFile(candidate.filePath, 'utf-8')
      } catch (e) {
        errors.push({ candidate, error: `Cannot read file: ${(e as Error).message}` })
        continue
      }

      const userPrompt =
        candidate.kind === 'singleton'
          ? SINGLETON_PROMPT_TEMPLATE({
              filePath: candidate.relativePath,
              fileContent,
              evidence: candidate.evidence,
            }) + (mode === 'cli' ? CLI_SCHEMA_HINT : '')
          : null

      if (!userPrompt) {
        skipped.push({ candidate, reason: `Pattern ${candidate.kind} not yet supported` })
        continue
      }

      const draftPayload = mode === 'cli'
        ? await callViaClaudeCli({
            systemPrompt: CLI_SYSTEM_PROMPT,
            userPrompt,
            model,
          })
        : await callViaSdk({
            client: sdkClient!,
            systemPrompt: 'Tu es un assistant d\'extraction d\'ADR.',
            userPrompt,
            model,
          })

      const draft: AdrDraft = {
        verdict: draftPayload.verdict ?? 'skip',
        reason: draftPayload.reason,
        title: draftPayload.title,
        rule: draftPayload.rule,
        why: draftPayload.why,
        asserts: draftPayload.asserts,
        anchors: draftPayload.anchors ?? [candidate.relativePath],
        pattern: candidate.kind,
        primaryAnchor: candidate.relativePath,
      }
      draft.confidence = calculateConfidence(draft)

      if (draft.verdict === 'skip') {
        skipped.push({ candidate, reason: draft.reason ?? 'agent skip' })
      } else {
        drafts.push(draft)
      }
    } catch (e) {
      errors.push({ candidate, error: (e as Error).message })
    }
  }

  return { drafts, skipped, errors }
}
