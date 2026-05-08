/**
 * SARIF 2.1.0 output formatter — convert datalog violations en format
 * standard consume par GitHub Code Scanning, IDE plugins (VS Code SARIF
 * Viewer), et autres tools de la chaine OASIS.
 *
 * Spec : https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 *
 * Usage : `codegraph datalog-check --format sarif > violations.sarif.json`
 *
 * Integration GitHub :
 *   - name: Upload SARIF
 *     uses: github/codeql-action/upload-sarif@v3
 *     with:
 *       sarif_file: violations.sarif.json
 *
 * → les violations apparaissent dans l'onglet "Code scanning" des PRs.
 */

export interface SarifViolation {
  /** Rule id (ex: 'SQL-FK-INDEX', 'COMPOSITE-CYCLE'). */
  adr: string
  /** Path relatif depuis le repo root. Vide pour les violations sans
   * file (ex: rules at-package level type COMPOSITE-DEP-UNUSED). */
  file: string
  /** 1-based. 0 si non-applicable (ex: package.json-level). */
  line: number
  /** Message human-readable (1 sentence). */
  msg: string
}

export interface SarifBuildOptions {
  /** Version du toolkit (ex: '0.6.0'). */
  toolVersion: string
  /** URL du tool (ex: 'https://github.com/Mwarfy/codegraph-toolkit'). */
  toolUri?: string
}

const DEFAULT_TOOL_URI = 'https://github.com/Mwarfy/codegraph-toolkit'

/**
 * Convertit une liste de violations en document SARIF 2.1.0 valide.
 *
 * Le document est self-contained : le `tool.driver.rules` deduit la
 * liste des rules a partir des `adr` distincts presents dans les
 * violations. Pas besoin de pre-charger les `.dl` pour generer le SARIF.
 *
 * Mapping :
 *   - `adr` → `result.ruleId` + `tool.driver.rules[].id`
 *   - `msg` → `result.message.text`
 *   - `file` + `line` → `result.locations[].physicalLocation`
 *   - `level` → toujours `'warning'` (les rules toolkit sont conseil,
 *     pas erreur bloquante)
 */
export function buildSarifReport(
  violations: SarifViolation[],
  options: SarifBuildOptions,
): SarifReport {
  // Deduplique les rules en preservant l'ordre de premiere apparition
  // (deterministe : meme input → meme output byte-equivalent).
  const ruleIds = new Set<string>()
  const rulesOrdered: string[] = []
  const ruleMessages = new Map<string, string>()
  for (const v of violations) {
    if (!ruleIds.has(v.adr)) {
      ruleIds.add(v.adr)
      rulesOrdered.push(v.adr)
      // Premier message rencontre = description courte de la rule
      ruleMessages.set(v.adr, v.msg)
    }
  }

  const rules: SarifReportingDescriptor[] = rulesOrdered.map((id) => ({
    id,
    shortDescription: { text: id },
    fullDescription: { text: ruleMessages.get(id) ?? id },
    helpUri: `${options.toolUri ?? DEFAULT_TOOL_URI}#rule-${id.toLowerCase()}`,
    defaultConfiguration: { level: 'warning' },
  }))

  const results: SarifResult[] = violations.map((v) => buildSarifResult(v))

  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'codegraph',
          version: options.toolVersion,
          informationUri: options.toolUri ?? DEFAULT_TOOL_URI,
          rules,
        },
      },
      results,
    }],
  }
}

function buildSarifResult(v: SarifViolation): SarifResult {
  const result: SarifResult = {
    ruleId: v.adr,
    level: 'warning',
    message: { text: v.msg },
    locations: [],
  }
  if (v.file) {
    const region = v.line > 0 ? { startLine: v.line } : undefined
    result.locations.push({
      physicalLocation: {
        artifactLocation: { uri: v.file, uriBaseId: '%SRCROOT%' },
        ...(region ? { region } : {}),
      },
    })
  }
  return result
}

// ─── SARIF 2.1.0 types (subset utilise) ────────────────────────────────────
// Reference : https://docs.oasis-open.org/sarif/sarif/v2.1.0/cs01/schemas/sarif-schema-2.1.0.json

export interface SarifReport {
  version: '2.1.0'
  $schema: string
  runs: SarifRun[]
}

interface SarifRun {
  tool: { driver: SarifToolComponent }
  results: SarifResult[]
}

interface SarifToolComponent {
  name: string
  version: string
  informationUri: string
  rules: SarifReportingDescriptor[]
}

interface SarifReportingDescriptor {
  id: string
  shortDescription: { text: string }
  fullDescription: { text: string }
  helpUri: string
  defaultConfiguration: { level: 'note' | 'warning' | 'error' }
}

interface SarifResult {
  ruleId: string
  level: 'note' | 'warning' | 'error'
  message: { text: string }
  locations: SarifLocation[]
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId?: string }
    region?: { startLine: number }
  }
}
