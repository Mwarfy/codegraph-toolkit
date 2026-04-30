/**
 * Hardcoded secrets — détecteur déterministe : regex + entropy.
 *
 * Capture les string literals qui ressemblent à des secrets hardcodés
 * dans le code source : tokens, clés API, mots de passe, credentials.
 *
 * Stratégie :
 *   1. Filtrer les StringLiterals par TAILLE (>= 20 chars — les secrets
 *      modernes sont longs).
 *   2. Filtrer par CONTEXTE — variable nommée `key`, `token`, `secret`,
 *      `password`, `credential`, `api_key`, etc.
 *   3. Filtrer par ENTROPY (Shannon) — un secret a une entropie élevée
 *      car aléatoire (>4.0 bits/char). Une string lisible (URL, message)
 *      a une entropie basse (~2-3 bits/char).
 *   4. Skip les patterns connus de TEST (test/fixture/example dans le
 *      path, ou marker `// secret-ok` sur la ligne précédente).
 *
 * Pourquoi : un secret hardcodé en code source git est silencieusement
 * exposé à toute personne avec accès au repo + à git history même si
 * fix ultérieur. Vrai vecteur de leak.
 *
 * Inspiration : Bandit (Python `B106 hardcoded_password_funcarg`),
 * gitleaks (regex-based), trufflehog (entropy-based). On combine les
 * deux : regex pour le contexte, entropy pour le contenu.
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'

export interface HardcodedSecret {
  file: string
  line: number
  /** Le nom de la variable / property qui contient le secret. */
  context: string
  /** Première section de la valeur (max 20 chars), reste maskée. */
  preview: string
  /** Score Shannon entropy (bits/char). */
  entropy: number
  /** Longueur de la valeur originale. */
  length: number
  /** Le pattern qui a déclenché : 'name' (variable name match) | 'pattern' (known prefix). */
  trigger: 'name' | 'pattern'
}

export interface HardcodedSecretsFileBundle {
  secrets: HardcodedSecret[]
}

export interface HardcodedSecretsOptions {
  /** Min length of value to be considered. Default 20. */
  minLength?: number
  /** Min entropy bits/char. Default 4.0. */
  minEntropy?: number
}

const DEFAULT_MIN_LENGTH = 20
const DEFAULT_MIN_ENTROPY = 4.0

// Variable / property names suspects.
const SUSPICIOUS_NAME_RE =
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|credential|auth|bearer|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)\b/i

// Patterns connus de prefixes de secrets — toujours flagger même sans
// contexte de variable name (les LLM-generated keys ont ces prefixes).
const KNOWN_PREFIX_RE =
  /^(?:sk-[A-Za-z0-9]{20,}|sk_(?:test|live)_[A-Za-z0-9]{20,}|pk_(?:test|live)_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bps]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_-]{20,})/

// Skip pour les fichiers test / fixture / example.
const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/|(^|\/)examples?\/)/

export function extractHardcodedSecretsFileBundle(
  sf: SourceFile,
  relPath: string,
  options: HardcodedSecretsOptions = {},
): HardcodedSecretsFileBundle {
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH
  const minEntropy = options.minEntropy ?? DEFAULT_MIN_ENTROPY
  const secrets: HardcodedSecret[] = []

  // Skip test/fixture files entirely.
  if (TEST_FILE_RE.test(relPath)) return { secrets }

  // Index ligne→texte pour le check `// secret-ok` exempt.
  const lines = sf.getFullText().split('\n')
  const isExempt = (line: number): boolean => {
    if (line < 2 || line - 2 >= lines.length) return false
    const prev = lines[line - 2]
    return /\/\/\s*secret-ok\b/.test(prev)
  }

  for (const lit of sf.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    const value = lit.getLiteralText()
    if (value.length < minLength) continue

    const line = lit.getStartLineNumber()
    if (isExempt(line)) continue

    // Identifier le contexte : nom de la variable / property qui contient
    // ce literal. On remonte le parent immédiat.
    const context = findContext(lit)

    let trigger: 'name' | 'pattern' | null = null
    if (KNOWN_PREFIX_RE.test(value)) {
      trigger = 'pattern'
    } else if (context && SUSPICIOUS_NAME_RE.test(context)) {
      trigger = 'name'
    }
    if (!trigger) continue

    // Pour 'name' trigger : exiger l'entropy minimum (filter les
    // placeholders comme "your-api-key-here"). Pour 'pattern' :
    // toujours flagger (les prefixes connus sont déjà spécifiques).
    const entropy = shannonEntropy(value)
    if (trigger === 'name' && entropy < minEntropy) continue

    secrets.push({
      file: relPath,
      line,
      context: context ?? '',
      preview: value.slice(0, Math.min(8, value.length)) + '…',
      entropy: Math.round(entropy * 100) / 100,
      length: value.length,
      trigger,
    })
  }

  return { secrets }
}

/**
 * Cherche le nom de la variable/property qui contient ce StringLiteral.
 * Patterns reconnus :
 *   - `const X = "..."` → 'X'
 *   - `let X: T = "..."` → 'X'
 *   - `{ X: "..." }` → 'X'
 *   - `obj.X = "..."` → 'X'
 *   - `foo({ X: "..." })` → 'X' (object literal arg)
 * Retourne null si pas de contexte nommé identifiable.
 */
function findContext(node: Node): string | null {
  const parent = node.getParent()
  if (!parent) return null
  if (Node.isVariableDeclaration(parent)) {
    return parent.getName()
  }
  if (Node.isPropertyAssignment(parent)) {
    return parent.getName().replace(/^['"]|['"]$/g, '')
  }
  if (Node.isBinaryExpression(parent)) {
    // foo.X = "...": LHS = PropertyAccessExpression.
    const lhs = parent.getLeft()
    if (Node.isPropertyAccessExpression(lhs)) {
      return lhs.getName()
    }
  }
  return null
}

/**
 * Shannon entropy d'une string (bits/char). Un alphabet aléatoire
 * uniforme sur 64 chars donne ~6.0. Un texte naturel anglais ~4.0-4.5.
 * Un placeholder type "your-api-key-here" donne ~3.0.
 */
function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let h = 0
  for (const count of counts.values()) {
    const p = count / s.length
    h -= p * Math.log2(p)
  }
  return h
}

export async function analyzeHardcodedSecrets(
  rootDir: string,
  files: string[],
  project: Project,
  options: HardcodedSecretsOptions = {},
): Promise<HardcodedSecret[]> {
  const fileSet = new Set(files)
  const all: HardcodedSecret[] = []

  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractHardcodedSecretsFileBundle(sf, rel, options)
    all.push(...bundle.secrets)
  }

  all.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  return all
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
