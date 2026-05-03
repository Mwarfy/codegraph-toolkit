// ADR-010
/**
 * Datalog Fact Exporter
 *
 * Sérialise un `GraphSnapshot` codegraph vers le format `.facts` Soufflé
 * (TSV — un tuple par ligne, colonnes séparées par TAB, pas de header,
 * pas de quotes).
 *
 * Le but : exposer ce que codegraph détecte déjà comme faits Datalog que des
 * règles `.dl` peuvent consommer pour exprimer des invariants ADR de manière
 * déclarative. Cf. ADR Datalog (à venir, M5).
 *
 * Pour chaque relation émise :
 *   - `<RelName>.facts` : un fichier TSV, prêt à être chargé par `souffle -F<dir>`
 *   - une déclaration `.decl <RelName>(...)` accumulée dans `schema.dl`,
 *     que les règles peuvent `#include "schema.dl"` ou copier.
 *
 * Soufflé accepte aussi les symbols quotés `"foo bar"` mais le format
 * unquoted-TSV est plus compact et plus déterministe. Les valeurs string
 * sont sanitizées : tab/newline → espace. Toute autre valeur est passée
 * brute. Les entiers sont stringifiés sans quotes.
 *
 * Relations émises en M1 (sous-ensemble) :
 *   File(file:symbol)
 *   FileTag(file:symbol, tag:symbol)
 *   Imports(from:symbol, to:symbol)
 *   ImportEdge(from:symbol, to:symbol, line:number)
 *   EmitsLiteral(file:symbol, line:number, eventName:symbol)
 *   EmitsConstRef(file:symbol, line:number, namespace:symbol, member:symbol)
 *   EmitsDynamic(file:symbol, line:number)
 *   EnvRead(file:symbol, line:number, varName:symbol, hasDefault:symbol)
 *   ModuleFanIn(file:symbol, count:number)
 *
 * Conventions :
 *   - Bools encodés en symbols 'true' / 'false' (Soufflé n'a pas de Bool natif).
 *   - Refs `EVENTS.X` splittées en `(namespace='EVENTS', member='X')` — c'est
 *     la forme la plus utilisable côté règle.
 *   - Refs sans `.` (ex `someVar` vu comme PropertyAccessExpression dégénéré)
 *     restent côté `EmitsDynamic`.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { GraphSnapshot } from '../core/types.js'
import { discoverManifests } from '../extractors/package-deps.js'

export interface ExportFactsOptions {
  /** Dossier cible. Sera créé. Les fichiers existants seront écrasés. */
  outDir: string
}

export interface ExportFactsResult {
  outDir: string
  /** Une entrée par relation : nom + nombre de tuples écrits. */
  relations: Array<{ name: string; tuples: number; file: string }>
  /** Chemin du fichier `schema.dl`. */
  schemaFile: string
}

interface RelationDef {
  name: string
  /** Décl Soufflé : `(file:symbol, line:number)` (sans le keyword `.decl`). */
  decl: string
  /** Tuples : array de colonnes, chaque colonne déjà stringifiée. */
  rows: string[][]
}

export async function exportFacts(
  snapshot: GraphSnapshot,
  options: ExportFactsOptions,
): Promise<ExportFactsResult> {
  const relations: RelationDef[] = []

  // ─── File / FileTag ───────────────────────────────────────────────────
  const fileRel: RelationDef = {
    name: 'File',
    decl: '(file:symbol)',
    rows: [],
  }
  const tagRel: RelationDef = {
    name: 'FileTag',
    decl: '(file:symbol, tag:symbol)',
    rows: [],
  }
  // ─── UnusedExport (Tier 17) ──────────────────────────────────────────
  // Symbols exportes avec confidence "safe-to-remove" — candidats dead
  // code. Source : node.exports[] (calcule par unused-exports detector).
  const unusedExportRel: RelationDef = {
    name: 'UnusedExport',
    decl: '(file:symbol, name:symbol, line:number, kind:symbol, confidence:symbol)',
    rows: [],
  }
  // ─── LongFunction (Tier 17) ──────────────────────────────────────────
  // Calcule par long-functions detector, deja en snapshot.longFunctions.
  const longFunctionRel: RelationDef = {
    name: 'LongFunction',
    decl: '(file:symbol, name:symbol, line:number, locCount:number)',
    rows: [],
  }
  // ─── MagicNumber (Tier 17) ──────────────────────────────────────────
  // Litteraux numeriques hardcoded suspects (timeouts/thresholds/ratios).
  // value en symbol pour preserver les forms decimales/grandes (1e9, etc.).
  const magicNumberRel: RelationDef = {
    name: 'MagicNumber',
    decl: '(file:symbol, line:number, value:symbol, context:symbol, category:symbol)',
    rows: [],
  }

  // Pattern files de fixtures synthétiques — non-importés par construction
  // (sinon ils ne sont plus isolés). Couvert par FileTag("test-fixture")
  // pour permettre aux rules (orphan-file, copy-paste-fork) de les exclure.
  const FIXTURE_PATH_RE = /(^|\/)tests?\/fixtures?\/|(^|\/)__fixtures__\//
  for (const n of snapshot.nodes) {
    if (n.type !== 'file') continue
    fileRel.rows.push([sym(n.id)])
    for (const t of n.tags ?? []) {
      tagRel.rows.push([sym(n.id), sym(t)])
    }
    if (FIXTURE_PATH_RE.test(n.id)) {
      tagRel.rows.push([sym(n.id), sym('test-fixture')])
    }
    for (const ex of n.exports ?? []) {
      // Garde tous les exports avec confidence non-vide, la rule filtre.
      if (!ex.confidence) continue
      unusedExportRel.rows.push([
        sym(n.id), sym(ex.name), num(ex.line),
        sym(ex.kind), sym(ex.confidence),
      ])
    }
  }
  for (const lf of snapshot.longFunctions ?? []) {
    longFunctionRel.rows.push([
      sym(lf.file), sym(lf.name), num(lf.line), num(lf.loc),
    ])
  }
  for (const mn of snapshot.magicNumbers ?? []) {
    magicNumberRel.rows.push([
      sym(mn.file), num(mn.line), sym(mn.value),
      sym(mn.context || '_'), sym(mn.category),
    ])
  }
  // Bug fix : fileRel + tagRel etaient peuples mais jamais pushes
  // depuis Tier 17 (regression mid-Phase-5). Detecte via self-audit
  // byte-comparison. Tests datalog ne casseraient pas (anti-joins
  // matchent silencieusement personne) mais les rules ImportedFile +
  // IsEntryPoint silencieusement degradent leur precision.
  relations.push(fileRel, tagRel, unusedExportRel, longFunctionRel, magicNumberRel)

  // ─── Barrel (Tier 17) ──────────────────────────────────────────────
  // Files barrel (100% re-exports). lowValue=true ssi peu de consumers.
  const barrelRel: RelationDef = {
    name: 'Barrel',
    decl: '(file:symbol, reExportCount:number, consumerCount:number, lowValue:symbol)',
    rows: [],
  }
  for (const b of snapshot.barrels ?? []) {
    barrelRel.rows.push([
      sym(b.file),
      num(b.reExportCount),
      num(b.consumerCount),
      sym(b.lowValue ? 'true' : 'false'),
    ])
  }
  relations.push(barrelRel)

  // ─── PackageDepIssue (Tier 17) ──────────────────────────────────────
  // Issues sur dependencies package.json (declared-unused, missing, etc.).
  const packageDepIssueRel: RelationDef = {
    name: 'PackageDepIssue',
    decl: '(packageName:symbol, packageJson:symbol, kind:symbol, declaredIn:symbol)',
    rows: [],
  }
  for (const d of snapshot.packageDeps ?? []) {
    packageDepIssueRel.rows.push([
      sym(d.packageName),
      sym(d.packageJson),
      sym(d.kind),
      sym(d.declaredIn ?? '_'),
    ])
  }
  relations.push(packageDepIssueRel)

  // ─── IsPackageEntryPoint (Tier 17 self-audit) ────────────────────────
  // Resout les `main`/`bin`/`exports` de CHAQUE package.json decouvert vers
  // les paths source TS correspondants. Sert a whitelister les entry
  // points npm dans les rules composite-barrel-low-value et
  // composite-orphan-file (faux positifs systemiques sinon).
  //
  // Utilise `discoverManifests` (full fs scan) plutot que `snapshot.packageDeps`
  // qui n'inclut QUE les packages avec issues — cassait le whitelist sur
  // les packages sans dette (codegraph, codegraph-mcp, datalog, salsa…).
  const isPackageEntryPointRel: RelationDef = {
    name: 'IsPackageEntryPoint',
    decl: '(file:symbol)',
    rows: [],
  }
  const allManifests = await discoverManifests(snapshot.rootDir)
  // Lit N package.json en parallèle (I/O fs indépendantes), parse séquentiel.
  const manifestPjs = await Promise.all(
    allManifests.map(async (m) => {
      try {
        return { m, raw: await fs.readFile(m.abs, 'utf8') }
      } catch { return null /* skip silently — best effort */ }
    }),
  )
  for (const entry of manifestPjs) {
    if (!entry) continue
    const { m, raw } = entry
    try {
      const pj = JSON.parse(raw)
      // m.rel pointe vers le package.json relatif au rootDir — on prend
      // son dirname pour préfixer les paths candidats. m.dir est absolu
      // (cf. PackageManifest interface), pas utilisable ici.
      const pjDir = path.dirname(m.rel)
      const candidates: string[] = []
      const collect = (val: unknown): void => {
        if (typeof val === 'string') candidates.push(val)
        else if (val && typeof val === 'object') {
          for (const v of Object.values(val)) collect(v)
        }
      }
      collect(pj.main)
      collect(pj.bin)
      collect(pj.exports)
      for (const c of candidates) {
        // dist/foo.js → src/foo.ts (heuristique standard)
        const srcGuess = c.replace(/^\.?\/?dist\//, 'src/').replace(/\.js$/, '.ts')
        const fullPath = path.join(pjDir, srcGuess).replace(/\\/g, '/')
        isPackageEntryPointRel.rows.push([sym(fullPath)])
      }
    } catch {
      // pjson parse error — skip silently (fact emit best effort)
    }
  }
  relations.push(isPackageEntryPointRel)

  emitGraphMetricFacts(snapshot, relations)
  emitListenerFacts(snapshot, relations)
  emitCodeQualityAndComplexityFacts(snapshot, relations)
  emitCrossDisciplineFacts(snapshot, relations)

  // ─── Imports / ImportEdge ─────────────────────────────────────────────
  // `Imports` est binaire (pratique pour la jointure transitive) ;
  // `ImportEdge` ajoute la ligne pour les règles qui veulent localiser le
  // call site exact.
  const importsRel: RelationDef = {
    name: 'Imports',
    decl: '(from:symbol, to:symbol)',
    rows: [],
  }
  const importEdgeRel: RelationDef = {
    name: 'ImportEdge',
    decl: '(from:symbol, to:symbol, line:number)',
    rows: [],
  }
  const importSeen = new Set<string>()
  for (const e of snapshot.edges) {
    if (e.type !== 'import') continue
    const key = e.from + '\x00' + e.to
    if (!importSeen.has(key)) {
      importsRel.rows.push([sym(e.from), sym(e.to)])
      importSeen.add(key)
    }
    importEdgeRel.rows.push([sym(e.from), sym(e.to), num(e.line ?? 0)])
  }
  relations.push(importsRel, importEdgeRel)

  // ─── EmitsLiteral / EmitsConstRef / EmitsDynamic ──────────────────────
  const emitsLiteralRel: RelationDef = {
    name: 'EmitsLiteral',
    decl: '(file:symbol, line:number, eventName:symbol)',
    rows: [],
  }
  const emitsConstRefRel: RelationDef = {
    name: 'EmitsConstRef',
    decl: '(file:symbol, line:number, namespace:symbol, member:symbol)',
    rows: [],
  }
  const emitsDynamicRel: RelationDef = {
    name: 'EmitsDynamic',
    decl: '(file:symbol, line:number)',
    rows: [],
  }
  for (const s of snapshot.eventEmitSites ?? []) {
    if (s.kind === 'literal' && s.literalValue !== undefined) {
      emitsLiteralRel.rows.push([sym(s.file), num(s.line), sym(s.literalValue)])
    } else if (s.kind === 'eventConstRef' && s.refExpression) {
      const split = splitRef(s.refExpression)
      if (split) {
        emitsConstRefRel.rows.push([sym(s.file), num(s.line), sym(split.ns), sym(split.member)])
      } else {
        emitsDynamicRel.rows.push([sym(s.file), num(s.line)])
      }
    } else {
      emitsDynamicRel.rows.push([sym(s.file), num(s.line)])
    }
  }
  relations.push(emitsLiteralRel, emitsConstRefRel, emitsDynamicRel)

  // ─── EnvRead ──────────────────────────────────────────────────────────
  const envReadRel: RelationDef = {
    name: 'EnvRead',
    decl: '(file:symbol, line:number, varName:symbol, hasDefault:symbol)',
    rows: [],
  }
  // EnvReadWrapped — uniquement les sites où process.env.X est passé
  // directement comme arg d'un call (parseInt, Number, envInt, …). Le 4e
  // arg est le nom du callee. Sert à ADR-019.
  const envReadWrappedRel: RelationDef = {
    name: 'EnvReadWrapped',
    decl: '(file:symbol, line:number, varName:symbol, wrappedIn:symbol)',
    rows: [],
  }
  for (const u of snapshot.envUsage ?? []) {
    for (const r of u.readers) {
      envReadRel.rows.push([
        sym(r.file),
        num(r.line),
        sym(u.name),
        sym(r.hasDefault ? 'true' : 'false'),
      ])
      if (r.wrappedIn) {
        envReadWrappedRel.rows.push([
          sym(r.file),
          num(r.line),
          sym(u.name),
          sym(r.wrappedIn),
        ])
      }
    }
  }
  relations.push(envReadRel, envReadWrappedRel)

  // ─── OauthScopeLiteral ────────────────────────────────────────────────
  const oauthScopeRel: RelationDef = {
    name: 'OauthScopeLiteral',
    decl: '(file:symbol, line:number, scope:symbol)',
    rows: [],
  }
  for (const s of snapshot.oauthScopeLiterals ?? []) {
    oauthScopeRel.rows.push([sym(s.file), num(s.line), sym(s.scope)])
  }
  relations.push(oauthScopeRel)

  // ─── ModuleFanIn ──────────────────────────────────────────────────────
  const fanInRel: RelationDef = {
    name: 'ModuleFanIn',
    decl: '(file:symbol, count:number)',
    rows: [],
  }
  for (const m of snapshot.moduleMetrics ?? []) {
    fanInRel.rows.push([sym(m.file), num(m.fanIn)])
  }
  relations.push(fanInRel)

  emitSqlFacts(snapshot, relations)

  // ─── CycleNode ────────────────────────────────────────────────────────
  // Pour chaque cycle détecté (Tarjan SCC sur graphe combiné import + event +
  // queue + dynamic-load), émet un tuple par fichier participant. Le champ
  // `gated` indique si le cycle est gated par un gate explicite (ex
  // `if (env.X)` autour de l'import dynamique) — un cycle gated reste un
  // cycle au sens topo mais est intentionnel donc PAS à bloquer.
  // Source: ADR-022 ratchet pattern, axe 5 enrichissement post-Phase-C.
  const cycleNodeRel: RelationDef = {
    name: 'CycleNode',
    decl: '(file:symbol, cycleId:symbol, gated:symbol)',
    rows: [],
  }
  const cycleNodeSeen = new Set<string>()
  for (const c of snapshot.cycles ?? []) {
    const gatedSym = c.gated ? 'true' : 'false'
    for (const file of c.nodes) {
      // dedupe : un fichier peut apparaître plusieurs fois dans un cycle
      // listé en path (premier == dernier). On émet un tuple unique
      // par (file, cycleId).
      const key = file + '\x00' + c.id
      if (cycleNodeSeen.has(key)) continue
      cycleNodeSeen.add(key)
      cycleNodeRel.rows.push([sym(file), sym(c.id), gatedSym])
    }
  }
  relations.push(cycleNodeRel)

  // ─── CycleSize (Top-5 SCC hierarchy) ─────────────────────────────────
  // Distingue cycles benins (size==sccSize) vs cycles niches (size < sccSize,
  // le path affiche est extrait d'une SCC plus large = signal pathologique).
  // Tarjan SCC depth via comparaison size vs sccSize.
  const cycleSizeRel: RelationDef = {
    name: 'CycleSize',
    decl: '(cycleId:symbol, size:number, sccSize:number)',
    rows: [],
  }
  for (const c of snapshot.cycles ?? []) {
    cycleSizeRel.rows.push([sym(c.id), num(c.size), num(c.sccSize)])
  }
  relations.push(cycleSizeRel)

  // ─── SymbolCallEdge / SymbolSignature ────────────────────────────────
  // Phase 4 axe 2 : path queries CFG-level via Datalog. Émet les call edges
  // typés et les signatures pour permettre des rules taint-analysis lite
  // (auth-before-write, validate-before-db, etc.) sans coder un détecteur
  // dédié.
  // Source : snapshot.typedCalls (callEdges + signatures).
  const symbolCallEdgeRel: RelationDef = {
    name: 'SymbolCallEdge',
    decl: '(fromFile:symbol, fromSymbol:symbol, toFile:symbol, toSymbol:symbol, line:number)',
    rows: [],
  }
  const symbolSignatureRel: RelationDef = {
    name: 'SymbolSignature',
    decl: '(file:symbol, name:symbol, kind:symbol, line:number)',
    rows: [],
  }
  if (snapshot.typedCalls) {
    for (const sig of snapshot.typedCalls.signatures) {
      symbolSignatureRel.rows.push([
        sym(sig.file),
        sym(sig.exportName),
        sym(sig.kind),
        num(sig.line),
      ])
    }
    for (const edge of snapshot.typedCalls.callEdges) {
      // `from` / `to` sont au format "file:symbolName". Le séparateur est
      // le DERNIER `:` (les noms TS d'export ne contiennent pas `:`).
      const fromSplit = splitFileSymbol(edge.from)
      const toSplit = splitFileSymbol(edge.to)
      if (!fromSplit || !toSplit) continue   // edge dégradé — skip
      symbolCallEdgeRel.rows.push([
        sym(fromSplit.file),
        sym(fromSplit.symbol),
        sym(toSplit.file),
        sym(toSplit.symbol),
        num(edge.line),
      ])
    }
  }
  relations.push(symbolCallEdgeRel, symbolSignatureRel)

  // ─── EntryPoint ──────────────────────────────────────────────────────
  // Source : snapshot.dataFlows[].entry. Dédupe par (file, kind, id) car
  // un handler peut apparaître plusieurs fois (downstream chains).
  const entryPointRel: RelationDef = {
    name: 'EntryPoint',
    decl: '(file:symbol, kind:symbol, id:symbol)',
    rows: [],
  }
  const entryPointSeen = new Set<string>()
  const collectEntries = (flows: Array<{ entry: { kind: string; id: string; file: string }; downstream?: any[] }>): void => {
    for (const f of flows) {
      const key = f.entry.file + '\x00' + f.entry.kind + '\x00' + f.entry.id
      if (!entryPointSeen.has(key)) {
        entryPointSeen.add(key)
        entryPointRel.rows.push([
          sym(f.entry.file),
          sym(f.entry.kind),
          sym(f.entry.id),
        ])
      }
      if (f.downstream && f.downstream.length > 0) collectEntries(f.downstream)
    }
  }
  if (snapshot.dataFlows) {
    collectEntries(snapshot.dataFlows as any)
  }
  relations.push(entryPointRel)

  // ─── EvalCall ────────────────────────────────────────────────────────
  // Phase 4 Tier 1 : `eval(...)` et `new Function(...)` — vecteurs RCE
  // classiques. Source : extractors/eval-calls.ts.
  const evalCallRel: RelationDef = {
    name: 'EvalCall',
    decl: '(file:symbol, line:number, kind:symbol, containingSymbol:symbol)',
    rows: [],
  }
  for (const ec of snapshot.evalCalls ?? []) {
    evalCallRel.rows.push([
      sym(ec.file),
      num(ec.line),
      sym(ec.kind),
      sym(ec.containingSymbol),
    ])
  }
  relations.push(evalCallRel)

  // ─── CryptoCall (Tier 16) ──────────────────────────────────────────
  // Crypto API calls avec algo extrait. Permet rule cwe-327 algo-aware.
  // Source : extractors/crypto-algo.ts.
  const cryptoCallRel: RelationDef = {
    name: 'CryptoCall',
    decl: '(file:symbol, line:number, fn:symbol, algo:symbol, containingSymbol:symbol)',
    rows: [],
  }
  for (const cc of snapshot.cryptoCalls ?? []) {
    cryptoCallRel.rows.push([
      sym(cc.file),
      num(cc.line),
      sym(cc.fn),
      sym(cc.algo || '_'),
      sym(cc.containingSymbol),
    ])
  }
  relations.push(cryptoCallRel)

  // ─── Security patterns (Tier 16) — 4 facts en bundle ─────────────────
  // Source : extractors/security-patterns.ts.
  const secretRefRel: RelationDef = {
    name: 'SecretVarRef',
    decl: '(file:symbol, line:number, varName:symbol, kind:symbol, callee:symbol, containingSymbol:symbol)',
    rows: [],
  }
  const corsConfigRel: RelationDef = {
    name: 'CorsConfig',
    decl: '(file:symbol, line:number, originKind:symbol, containingSymbol:symbol)',
    rows: [],
  }
  const tlsUnsafeRel: RelationDef = {
    name: 'TlsConfigUnsafe',
    decl: '(file:symbol, line:number, key:symbol, containingSymbol:symbol)',
    rows: [],
  }
  const weakRandomRel: RelationDef = {
    name: 'WeakRandomCall',
    decl: '(file:symbol, line:number, varName:symbol, secretKind:symbol, containingSymbol:symbol)',
    rows: [],
  }
  const sp = snapshot.securityPatterns
  if (sp) {
    for (const r of sp.secretRefs) {
      secretRefRel.rows.push([
        sym(r.file), num(r.line), sym(r.varName), sym(r.kind),
        sym(r.callee), sym(r.containingSymbol),
      ])
    }
    for (const r of sp.corsConfigs) {
      corsConfigRel.rows.push([
        sym(r.file), num(r.line), sym(r.originKind), sym(r.containingSymbol),
      ])
    }
    for (const r of sp.tlsUnsafe) {
      tlsUnsafeRel.rows.push([
        sym(r.file), num(r.line), sym(r.key), sym(r.containingSymbol),
      ])
    }
    for (const r of sp.weakRandoms) {
      weakRandomRel.rows.push([
        sym(r.file), num(r.line), sym(r.varName || '_'),
        sym(r.secretKind || '_'), sym(r.containingSymbol),
      ])
    }
  }
  relations.push(secretRefRel, corsConfigRel, tlsUnsafeRel, weakRandomRel)

  // ─── HardcodedSecret (Tier 2) ────────────────────────────────────────
  const hardcodedSecretRel: RelationDef = {
    name: 'HardcodedSecret',
    decl: '(file:symbol, line:number, context:symbol, trigger:symbol, entropy:number)',
    rows: [],
  }
  for (const s of snapshot.hardcodedSecrets ?? []) {
    hardcodedSecretRel.rows.push([
      sym(s.file),
      num(s.line),
      sym(s.context || '_'),
      sym(s.trigger),
      num(Math.round(s.entropy * 100)),  // entropy * 100 pour rester en int
    ])
  }
  relations.push(hardcodedSecretRel)

  emitTier234Facts(snapshot, relations)
  emitSqlViolationFacts(snapshot, relations)
  emitTruthAndCoverageFacts(snapshot, relations)
  emitDriftAndCoChangeFacts(snapshot, relations)
  emitTaintFacts(snapshot, relations)

  // ─── Write to disk ────────────────────────────────────────────────────
  await fs.mkdir(options.outDir, { recursive: true })

  const result: ExportFactsResult = {
    outDir: options.outDir,
    relations: [],
    schemaFile: path.join(options.outDir, 'schema.dl'),
  }

  // Write N relations en parallèle (.facts files indépendants).
  await Promise.all(
    relations.map(async (rel) => {
      const factPath = path.join(options.outDir, `${rel.name}.facts`)
      const content = rel.rows.map((cols) => cols.join('\t')).join('\n')
      // Soufflé attend que les .facts existent même vides (sinon il warn).
      await fs.writeFile(factPath, content + (content.length > 0 ? '\n' : ''))
      result.relations.push({ name: rel.name, tuples: rel.rows.length, file: factPath })
    }),
  )

  // ─── schema.dl ────────────────────────────────────────────────────────
  // Header + .decl + .input pour chaque relation. Les règles `.dl`
  // utilisateur peuvent `#include "schema.dl"` et écrire seulement les
  // règles + .output Violation.
  const lines: string[] = []
  lines.push(`// AUTO-GÉNÉRÉ par @liby-tools/codegraph 'codegraph facts'.`)
  lines.push(`// Source : snapshot ${snapshot.commitHash ?? '(no-commit)'} @ ${snapshot.generatedAt}.`)
  lines.push(`// NE PAS éditer à la main — relancer 'codegraph facts <out>' pour régénérer.`)
  lines.push('')
  for (const rel of relations) {
    lines.push(`.decl ${rel.name}${rel.decl}`)
    lines.push(`.input ${rel.name}`)
  }
  await fs.writeFile(result.schemaFile, lines.join('\n') + '\n')

  return result
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Sanitize une valeur string pour le format `.facts` Soufflé non-quoté :
 * remplace les tabs et newlines par un espace. Les autres caractères
 * (espaces, ponctuation, accents) sont préservés.
 */
// ─── Helpers d'extraction par groupe (split de exportFacts) ────────────────
// Self-audit refactor : reduit la cyclomatic + cognitive de exportFacts
// en isolant les groupes logiques en sub-fns. Output byte-identique
// preserve (push order conserve dans exportFacts).

/**
 * SqlNamingViolation + SqlMigrationOrderViolation (Tier 5).
 */
function emitSqlViolationFacts(snapshot: GraphSnapshot, relations: RelationDef[]): void {
  const sqlNamingViolationRel: RelationDef = {
    name: 'SqlNamingViolation',
    decl: '(file:symbol, line:number, table:symbol, column:symbol, kind:symbol)',
    rows: [],
  }
  for (const v of snapshot.sqlNamingViolations ?? []) {
    sqlNamingViolationRel.rows.push([
      sym(v.file), num(v.line), sym(v.table), sym(v.column || '_'), sym(v.kind),
    ])
  }
  relations.push(sqlNamingViolationRel)

  const sqlMigOrderRel: RelationDef = {
    name: 'SqlMigrationOrderViolation',
    decl: '(file:symbol, line:number, fromTable:symbol, fromCol:symbol, toTable:symbol, fkMig:number, targetMig:number)',
    rows: [],
  }
  for (const v of snapshot.sqlMigrationOrderViolations ?? []) {
    sqlMigOrderRel.rows.push([
      sym(v.file), num(v.line), sym(v.fromTable), sym(v.fromColumn),
      sym(v.toTable), num(v.fkMigrationNumber), num(v.targetMigrationNumber),
    ])
  }
  relations.push(sqlMigOrderRel)
}

/**
 * TruthPointWriter + TruthPointReader + TestedFile (Tier 7 prereq).
 * Promotion de snapshot.truthPoints[].writers[]/readers[] vers facts
 * Datalog plats. Dédup par (concept, file).
 */
function emitTruthAndCoverageFacts(snapshot: GraphSnapshot, relations: RelationDef[]): void {
  const truthPointWriterRel: RelationDef = {
    name: 'TruthPointWriter',
    decl: '(concept:symbol, file:symbol)',
    rows: [],
  }
  const truthPointReaderRel: RelationDef = {
    name: 'TruthPointReader',
    decl: '(concept:symbol, file:symbol)',
    rows: [],
  }
  if (snapshot.truthPoints) {
    const writerSeen = new Set<string>()
    const readerSeen = new Set<string>()
    for (const tp of snapshot.truthPoints) {
      for (const w of tp.writers ?? []) {
        const key = tp.concept + '\x00' + w.file
        if (writerSeen.has(key)) continue
        writerSeen.add(key)
        truthPointWriterRel.rows.push([sym(tp.concept), sym(w.file)])
      }
      for (const r of tp.readers ?? []) {
        const key = tp.concept + '\x00' + r.file
        if (readerSeen.has(key)) continue
        readerSeen.add(key)
        truthPointReaderRel.rows.push([sym(tp.concept), sym(r.file)])
      }
    }
  }
  relations.push(truthPointWriterRel, truthPointReaderRel)

  const testedFileRel: RelationDef = {
    name: 'TestedFile',
    decl: '(file:symbol)',
    rows: [],
  }
  if (snapshot.testCoverage) {
    for (const e of snapshot.testCoverage.entries) {
      if (e.testFiles.length > 0) {
        testedFileRel.rows.push([sym(e.sourceFile)])
      }
    }
  }
  relations.push(testedFileRel)
}

/**
 * DriftSignalFact + CoChange + ResourceImbalance (Tier 6/7).
 * CoChange émise dans les 2 sens pour faciliter les joins symétriques.
 */
function emitDriftAndCoChangeFacts(snapshot: GraphSnapshot, relations: RelationDef[]): void {
  const driftSignalFactRel: RelationDef = {
    name: 'DriftSignalFact',
    decl: '(file:symbol, line:number, kind:symbol)',
    rows: [],
  }
  for (const ds of snapshot.driftSignals ?? []) {
    driftSignalFactRel.rows.push([sym(ds.file), num(ds.line), sym(ds.kind)])
  }
  relations.push(driftSignalFactRel)

  const coChangeRel: RelationDef = {
    name: 'CoChange',
    decl: '(fileA:symbol, fileB:symbol, count:number, jaccardX100:number)',
    rows: [],
  }
  if (snapshot.coChangePairs) {
    const seen = new Set<string>()
    for (const pair of snapshot.coChangePairs) {
      const key1 = pair.from + '\x00' + pair.to
      const key2 = pair.to + '\x00' + pair.from
      if (seen.has(key1) || seen.has(key2)) continue
      seen.add(key1)
      const j100 = Math.round((pair.jaccard ?? 0) * 100)
      coChangeRel.rows.push([sym(pair.from), sym(pair.to), num(pair.count), num(j100)])
      coChangeRel.rows.push([sym(pair.to), sym(pair.from), num(pair.count), num(j100)])
    }
  }
  relations.push(coChangeRel)

  const resourceImbalanceRel: RelationDef = {
    name: 'ResourceImbalance',
    decl: '(file:symbol, line:number, containingSymbol:symbol, pair:symbol, acquireCount:number, releaseCount:number)',
    rows: [],
  }
  for (const r of snapshot.resourceImbalances ?? []) {
    resourceImbalanceRel.rows.push([
      sym(r.file), num(r.line), sym(r.containingSymbol || '_'), sym(r.pair),
      num(r.acquireCount), num(r.releaseCount),
    ])
  }
  relations.push(resourceImbalanceRel)
}

/**
 * Taint analysis facts (Tier 10/11/14) — TaintSink, SanitizerCall,
 * TaintedVarDecl, TaintedArgCall, TaintedArgumentToCall, FunctionParam.
 */
function emitTaintFacts(snapshot: GraphSnapshot, relations: RelationDef[]): void {
  const taintSinkRel: RelationDef = {
    name: 'TaintSink',
    decl: '(file:symbol, line:number, kind:symbol, callee:symbol, containingSymbol:symbol)',
    rows: [],
  }
  for (const s of snapshot.taintSinks ?? []) {
    taintSinkRel.rows.push([
      sym(s.file), num(s.line), sym(s.kind), sym(s.callee),
      sym(s.containingSymbol || '_'),
    ])
  }
  relations.push(taintSinkRel)

  const sanitizerCallRel: RelationDef = {
    name: 'SanitizerCall',
    decl: '(file:symbol, line:number, callee:symbol, containingSymbol:symbol)',
    rows: [],
  }
  for (const s of snapshot.sanitizerCalls ?? []) {
    sanitizerCallRel.rows.push([
      sym(s.file), num(s.line), sym(s.callee), sym(s.containingSymbol || '_'),
    ])
  }
  relations.push(sanitizerCallRel)

  const taintedVarDeclRel: RelationDef = {
    name: 'TaintedVarDecl',
    decl: '(file:symbol, containingSymbol:symbol, varName:symbol, line:number, source:symbol)',
    rows: [],
  }
  const taintedArgCallRel: RelationDef = {
    name: 'TaintedArgCall',
    decl: '(file:symbol, line:number, callee:symbol, argVarName:symbol, argIndex:number, source:symbol, containingSymbol:symbol)',
    rows: [],
  }
  if (snapshot.taintedVars) {
    for (const d of snapshot.taintedVars.decls) {
      taintedVarDeclRel.rows.push([
        sym(d.file), sym(d.containingSymbol || '_'), sym(d.varName),
        num(d.line), sym(d.source),
      ])
    }
    for (const ac of snapshot.taintedVars.argCalls) {
      taintedArgCallRel.rows.push([
        sym(ac.file), num(ac.line), sym(ac.callee), sym(ac.argVarName),
        num(ac.argIndex), sym(ac.source), sym(ac.containingSymbol || '_'),
      ])
    }
  }
  relations.push(taintedVarDeclRel, taintedArgCallRel)

  const taintedArgumentToCallRel: RelationDef = {
    name: 'TaintedArgumentToCall',
    decl: '(callerFile:symbol, callerSymbol:symbol, callee:symbol, paramIndex:number, source:symbol)',
    rows: [],
  }
  const functionParamRel: RelationDef = {
    name: 'FunctionParam',
    decl: '(file:symbol, symbol:symbol, paramName:symbol, paramIndex:number)',
    rows: [],
  }
  if (snapshot.argumentsFacts) {
    for (const ta of snapshot.argumentsFacts.taintedArgs) {
      taintedArgumentToCallRel.rows.push([
        sym(ta.callerFile), sym(ta.callerSymbol), sym(ta.callee),
        num(ta.paramIndex), sym(ta.source),
      ])
    }
    for (const p of snapshot.argumentsFacts.params) {
      functionParamRel.rows.push([
        sym(p.file), sym(p.symbol), sym(p.paramName), num(p.paramIndex),
      ])
    }
  }
  relations.push(taintedArgumentToCallRel, functionParamRel)
}

/**
 * Graph metrics + FSM + DSM back-edges (Tier 17 / Top-5 graph theory).
 * - ModuleCentrality : PageRank + Henry-Kafura par fichier (Brin/Page 1998).
 * - FsmStateDeclared/Orphan : etats declares + orphans par concept FSM.
 * - BackEdge : edges DSM qui inversent l'ordre architectural attendu.
 */
function emitGraphMetricFacts(snapshot: GraphSnapshot, relations: RelationDef[]): void {
  const moduleCentralityRel: RelationDef = {
    name: 'ModuleCentrality',
    decl: '(file:symbol, pageRank:number, henryKafura:number)',
    rows: [],
  }
  for (const m of snapshot.moduleMetrics ?? []) {
    const pr = Math.round(m.pageRank * 1000)
    const hk = Math.min(m.henryKafura, 1_000_000_000)
    moduleCentralityRel.rows.push([sym(m.file), num(pr), num(hk)])
  }
  relations.push(moduleCentralityRel)

  const fsmStateDeclaredRel: RelationDef = {
    name: 'FsmStateDeclared',
    decl: '(concept:symbol, state:symbol)',
    rows: [],
  }
  const fsmStateOrphanRel: RelationDef = {
    name: 'FsmStateOrphan',
    decl: '(concept:symbol, state:symbol, confidence:symbol)',
    rows: [],
  }
  for (const sm of snapshot.stateMachines ?? []) {
    for (const st of sm.states ?? []) {
      fsmStateDeclaredRel.rows.push([sym(sm.concept), sym(st)])
    }
    for (const st of sm.orphanStates ?? []) {
      fsmStateOrphanRel.rows.push([
        sym(sm.concept), sym(st), sym(sm.detectionConfidence),
      ])
    }
  }
  relations.push(fsmStateDeclaredRel, fsmStateOrphanRel)

  const backEdgeRel: RelationDef = {
    name: 'BackEdge',
    decl: '(fromGroup:symbol, toGroup:symbol)',
    rows: [],
  }
  for (const be of snapshot.dsm?.backEdges ?? []) {
    backEdgeRel.rows.push([sym(be.from), sym(be.to)])
  }
  relations.push(backEdgeRel)
}

/**
 * EventListener (Tier 17) — symetrique de Emits* (ListensLiteral,
 * ListensConstRef, ListensDynamic). Source : extractors/event-listener-sites.ts.
 */
function emitListenerFacts(snapshot: GraphSnapshot, relations: RelationDef[]): void {
  const listenerLitRel: RelationDef = {
    name: 'ListensLiteral',
    decl: '(file:symbol, line:number, eventName:symbol)',
    rows: [],
  }
  const listenerConstRel: RelationDef = {
    name: 'ListensConstRef',
    decl: '(file:symbol, line:number, namespace:symbol, member:symbol)',
    rows: [],
  }
  const listenerDynRel: RelationDef = {
    name: 'ListensDynamic',
    decl: '(file:symbol, line:number)',
    rows: [],
  }
  for (const ls of snapshot.eventListenerSites ?? []) {
    if (ls.kind === 'literal' && ls.literalValue !== undefined) {
      listenerLitRel.rows.push([sym(ls.file), num(ls.line), sym(ls.literalValue)])
    } else if (ls.kind === 'eventConstRef' && ls.refExpression) {
      const parts = ls.refExpression.split('.')
      const ns = parts[0] ?? ''
      const member = parts.slice(1).join('.') || ''
      listenerConstRel.rows.push([
        sym(ls.file), num(ls.line), sym(ns), sym(member),
      ])
    } else {
      listenerDynRel.rows.push([sym(ls.file), num(ls.line)])
    }
  }
  relations.push(listenerLitRel, listenerConstRel, listenerDynRel)
}

/**
 * SQL Schema (Phase 2) — emit 6 relations issues de l'extracteur
 * sql-schema (parse migrations Postgres).
 */
function emitSqlFacts(snapshot: GraphSnapshot, relations: RelationDef[]): void {
  const sqlTableRel: RelationDef = {
    name: 'SqlTable',
    decl: '(name:symbol, file:symbol, line:number)',
    rows: [],
  }
  const sqlColumnRel: RelationDef = {
    name: 'SqlColumn',
    decl: '(table:symbol, column:symbol, type:symbol, file:symbol, line:number)',
    rows: [],
  }
  const sqlForeignKeyRel: RelationDef = {
    name: 'SqlForeignKey',
    decl: '(fromTable:symbol, fromCol:symbol, toTable:symbol, toCol:symbol, file:symbol, line:number)',
    rows: [],
  }
  const sqlIndexRel: RelationDef = {
    name: 'SqlIndex',
    decl: '(name:symbol, table:symbol, firstCol:symbol, file:symbol, line:number)',
    rows: [],
  }
  const sqlFkWithoutIndexRel: RelationDef = {
    name: 'SqlFkWithoutIndex',
    decl: '(fromTable:symbol, fromCol:symbol, toTable:symbol, toCol:symbol)',
    rows: [],
  }
  const sqlPrimaryKeyRel: RelationDef = {
    name: 'SqlPrimaryKey',
    decl: '(table:symbol, column:symbol, file:symbol, line:number)',
    rows: [],
  }
  if (snapshot.sqlSchema) {
    for (const t of snapshot.sqlSchema.tables) {
      sqlTableRel.rows.push([sym(t.name), sym(t.file), num(t.line)])
      for (const c of t.columns) {
        sqlColumnRel.rows.push([
          sym(t.name), sym(c.name), sym(c.type),
          sym(t.file), num(c.line),
        ])
      }
    }
    for (const fk of snapshot.sqlSchema.foreignKeys) {
      sqlForeignKeyRel.rows.push([
        sym(fk.fromTable), sym(fk.fromColumn),
        sym(fk.toTable), sym(fk.toColumn),
        sym(fk.file), num(fk.line),
      ])
    }
    for (const idx of snapshot.sqlSchema.indexes) {
      // Skip les indexes sur expression (firstColumn=null).
      if (idx.firstColumn === null) continue
      sqlIndexRel.rows.push([
        sym(idx.name), sym(idx.table), sym(idx.firstColumn),
        sym(idx.file), num(idx.line),
      ])
    }
    // Dedupe FkWithoutIndex par (fromTable, fromCol).
    const seenFkPair = new Set<string>()
    for (const fk of snapshot.sqlSchema.fkWithoutIndex) {
      const key = fk.fromTable + '\x00' + fk.fromColumn
      if (seenFkPair.has(key)) continue
      seenFkPair.add(key)
      sqlFkWithoutIndexRel.rows.push([
        sym(fk.fromTable), sym(fk.fromColumn),
        sym(fk.toTable), sym(fk.toColumn),
      ])
    }
    for (const pk of snapshot.sqlSchema.primaryKeys ?? []) {
      sqlPrimaryKeyRel.rows.push([
        sym(pk.table), sym(pk.column),
        sym(pk.file), num(pk.line),
      ])
    }
  }
  relations.push(
    sqlTableRel, sqlColumnRel, sqlForeignKeyRel,
    sqlIndexRel, sqlFkWithoutIndexRel, sqlPrimaryKeyRel,
  )
}

/**
 * Tier 2/3/4/5 misc facts — BooleanParam + DeadCode + FloatingPromise +
 * Deprecated{Decl,Usage} + ArticulationPoint. Tous des facts simples
 * (loop unique sur un array de snapshot, mapping flat). Extraits ensemble
 * pour reduire la cyclomatic + cognitive de exportFacts.
 */
function emitTier234Facts(snapshot: GraphSnapshot, relations: RelationDef[]): void {
  const booleanParamRel: RelationDef = {
    name: 'BooleanParam',
    decl: '(file:symbol, line:number, name:symbol, paramName:symbol, paramIndex:number, totalParams:number)',
    rows: [],
  }
  for (const b of snapshot.booleanParams ?? []) {
    booleanParamRel.rows.push([
      sym(b.file), num(b.line), sym(b.name),
      sym(b.paramName), num(b.paramIndex), num(b.totalParams),
    ])
  }
  relations.push(booleanParamRel)

  const deadCodeRel: RelationDef = {
    name: 'DeadCode',
    decl: '(file:symbol, line:number, kind:symbol)',
    rows: [],
  }
  for (const d of snapshot.deadCode ?? []) {
    deadCodeRel.rows.push([sym(d.file), num(d.line), sym(d.kind)])
  }
  relations.push(deadCodeRel)

  const floatingPromiseRel: RelationDef = {
    name: 'FloatingPromise',
    decl: '(file:symbol, line:number, callee:symbol, containingSymbol:symbol)',
    rows: [],
  }
  for (const fp of snapshot.floatingPromises ?? []) {
    floatingPromiseRel.rows.push([
      sym(fp.file), num(fp.line),
      sym(fp.callee), sym(fp.containingSymbol || '_'),
    ])
  }
  relations.push(floatingPromiseRel)

  const deprecatedDeclRel: RelationDef = {
    name: 'DeprecatedDecl',
    decl: '(name:symbol, file:symbol, line:number)',
    rows: [],
  }
  const deprecatedUsageRel: RelationDef = {
    name: 'DeprecatedUsage',
    decl: '(file:symbol, line:number, callee:symbol)',
    rows: [],
  }
  if (snapshot.deprecatedUsage) {
    for (const d of snapshot.deprecatedUsage.declarations) {
      deprecatedDeclRel.rows.push([sym(d.name), sym(d.file), num(d.line)])
    }
    for (const u of snapshot.deprecatedUsage.sites) {
      deprecatedUsageRel.rows.push([sym(u.file), num(u.line), sym(u.callee)])
    }
  }
  relations.push(deprecatedDeclRel, deprecatedUsageRel)

  const articulationPointRel: RelationDef = {
    name: 'ArticulationPoint',
    decl: '(file:symbol, severity:number)',
    rows: [],
  }
  for (const ap of snapshot.articulationPoints ?? []) {
    articulationPointRel.rows.push([sym(ap.file), num(ap.severity)])
  }
  relations.push(articulationPointRel)

  // Constant expressions (tautology / contradiction / gratuitous bool / etc.)
  const constantExprRel: RelationDef = {
    name: 'ConstantExpression',
    decl: '(kind:symbol, file:symbol, line:number, exprRepr:symbol)',
    rows: [],
  }
  for (const ce of snapshot.constantExpressions ?? []) {
    constantExprRel.rows.push([sym(ce.kind), sym(ce.file), num(ce.line), sym(ce.exprRepr)])
  }
  relations.push(constantExprRel)

  // ESLint violations imported from .codegraph/eslint.json (if present).
  const eslintRel: RelationDef = {
    name: 'EslintViolation',
    decl: '(file:symbol, line:number, ruleId:symbol, severity:number)',
    rows: [],
  }
  for (const ev of snapshot.eslintViolations ?? []) {
    eslintRel.rows.push([sym(ev.file), num(ev.line), sym(ev.ruleId), num(ev.severity)])
  }
  relations.push(eslintRel)
}

/**
 * Code Quality (Tier 17) + FunctionComplexity (Top-5) — bundle de
 * facts AST-level : RegexLiteral, TryCatchSwallow, AwaitInLoop,
 * AllocationInLoop + FunctionComplexity. Tous emis ensemble car ils
 * partagent la meme source (extractors AST par-fonction).
 */
function emitCodeQualityAndComplexityFacts(
  snapshot: GraphSnapshot,
  relations: RelationDef[],
): void {
  const regexLiteralRel: RelationDef = {
    name: 'RegexLiteral',
    decl: '(file:symbol, line:number, source:symbol, flags:symbol, hasNestedQuantifier:symbol)',
    rows: [],
  }
  const tryCatchSwallowRel: RelationDef = {
    name: 'TryCatchSwallow',
    decl: '(file:symbol, line:number, kind:symbol, containingSymbol:symbol)',
    rows: [],
  }
  const awaitInLoopRel: RelationDef = {
    name: 'AwaitInLoop',
    decl: '(file:symbol, line:number, loopKind:symbol, containingSymbol:symbol)',
    rows: [],
  }
  const allocationInLoopRel: RelationDef = {
    name: 'AllocationInLoop',
    decl: '(file:symbol, line:number, allocKind:symbol, containingSymbol:symbol)',
    rows: [],
  }
  const cqp = snapshot.codeQualityPatterns
  if (cqp) {
    for (const r of cqp.regexLiterals) {
      regexLiteralRel.rows.push([
        sym(r.file), num(r.line), sym(r.source), sym(r.flags || '_'),
        sym(r.hasNestedQuantifier ? 'true' : 'false'),
      ])
    }
    for (const r of cqp.tryCatchSwallows) {
      tryCatchSwallowRel.rows.push([
        sym(r.file), num(r.line), sym(r.kind), sym(r.containingSymbol),
      ])
    }
    for (const r of cqp.awaitInLoops) {
      awaitInLoopRel.rows.push([
        sym(r.file), num(r.line), sym(r.loopKind), sym(r.containingSymbol),
      ])
    }
    for (const r of cqp.allocationInLoops ?? []) {
      allocationInLoopRel.rows.push([
        sym(r.file), num(r.line), sym(r.allocKind), sym(r.containingSymbol),
      ])
    }
  }
  relations.push(regexLiteralRel, tryCatchSwallowRel, awaitInLoopRel, allocationInLoopRel)

  const fnComplexityRel: RelationDef = {
    name: 'FunctionComplexity',
    decl: '(file:symbol, name:symbol, line:number, cyclomatic:number, cognitive:number, containingClass:symbol)',
    rows: [],
  }
  for (const fc of snapshot.functionComplexity ?? []) {
    fnComplexityRel.rows.push([
      sym(fc.file), sym(fc.name), num(fc.line),
      num(fc.cyclomatic), num(fc.cognitive),
      sym(fc.containingClass || '_'),
    ])
  }
  relations.push(fnComplexityRel)
}

/**
 * Cross-discipline metrics (Cycle 2bis) — emit Spectral, Entropy, SignatureDup
 * facts depuis les compute-helpers correspondants. Origine : disciplines
 * classiques en math/info theory pas portees aux analyzers TS/JS.
 */
function emitCrossDisciplineFacts(
  snapshot: GraphSnapshot,
  relations: RelationDef[],
): void {
  // ─── SpectralMetric (théorie spectrale, Fiedler λ₂) ─────────────────
  const spectralRel: RelationDef = {
    name: 'SpectralMetric',
    decl: '(scope:symbol, nodeCount:number, edgeCount:number, fiedlerX1000:number, cheegerBound:number)',
    rows: [],
  }
  for (const m of snapshot.spectralMetrics ?? []) {
    spectralRel.rows.push([
      sym(m.scope), num(m.nodeCount), num(m.edgeCount),
      num(m.fiedlerX1000), num(m.cheegerBound),
    ])
  }
  relations.push(spectralRel)

  // ─── SymbolEntropy (théorie de l'information, Shannon) ──────────────
  const entropyRel: RelationDef = {
    name: 'SymbolEntropy',
    decl: '(fromSymbol:symbol, callCount:number, distinctCallees:number, entropyX1000:number)',
    rows: [],
  }
  for (const e of snapshot.symbolEntropy ?? []) {
    entropyRel.rows.push([
      sym(e.fromSymbol), num(e.callCount),
      num(e.distinctCallees), num(e.entropyX1000),
    ])
  }
  relations.push(entropyRel)

  // ─── SignatureNearDuplicate (théorie des codes, Hamming) ────────────
  const sigDupRel: RelationDef = {
    name: 'SignatureNearDuplicate',
    decl: '(symbolA:symbol, symbolB:symbol, hamming:number)',
    rows: [],
  }
  for (const d of snapshot.signatureDuplicates ?? []) {
    sigDupRel.rows.push([sym(d.symbolA), sym(d.symbolB), num(d.hamming)])
  }
  relations.push(sigDupRel)

  // ─── PersistentCycle (TDA — homologie persistante) ─────────────────
  const persistentCycleRel: RelationDef = {
    name: 'PersistentCycle',
    decl: '(cycleId:symbol, snapshotCount:number, totalSnapshots:number, persistenceX1000:number, gated:symbol)',
    rows: [],
  }
  for (const c of snapshot.persistentCycles ?? []) {
    persistentCycleRel.rows.push([
      sym(c.cycleId), num(c.snapshotCount), num(c.totalSnapshots),
      num(c.persistenceX1000), sym(c.gated ? 'true' : 'false'),
    ])
  }
  relations.push(persistentCycleRel)

  // ─── LyapunovMetric (théorie systèmes dynamiques) ──────────────────
  const lyapunovRel: RelationDef = {
    name: 'LyapunovMetric',
    decl: '(file:symbol, totalCoChanges:number, partnerCount:number, lyapunovX1000:number)',
    rows: [],
  }
  for (const l of snapshot.lyapunovMetrics ?? []) {
    lyapunovRel.rows.push([
      sym(l.file), num(l.totalCoChanges),
      num(l.partnerCount), num(l.lyapunovX1000),
    ])
  }
  relations.push(lyapunovRel)

  // ─── PackageMinCut (théorie des flots, Ford-Fulkerson) ─────────────
  const minCutRel: RelationDef = {
    name: 'PackageMinCut',
    decl: '(fromPackage:symbol, toPackage:symbol, edgeCount:number, minCut:number)',
    rows: [],
  }
  for (const m of snapshot.packageMinCuts ?? []) {
    minCutRel.rows.push([
      sym(m.fromPackage), sym(m.toPackage),
      num(m.edgeCount), num(m.minCut),
    ])
  }
  relations.push(minCutRel)

  // ─── InformationBottleneck (Tishby/Pereira/Bialek 1999) ────────────
  const ibRel: RelationDef = {
    name: 'InformationBottleneck',
    decl: '(symbol:symbol, callerCount:number, calleeCount:number, scoreX1000:number)',
    rows: [],
  }
  // Auxiliaire : SymbolFile(symbol, file) — extrait depuis "file:name".
  // Permet aux rules de joindre des facts file-level (EntryPoint, etc.)
  // avec des facts symbol-level (IB, NCD, signatures, ...).
  const symbolFileRel: RelationDef = {
    name: 'SymbolFile',
    decl: '(symbol:symbol, file:symbol)',
    rows: [],
  }
  for (const ib of snapshot.informationBottlenecks ?? []) {
    ibRel.rows.push([
      sym(ib.symbol), num(ib.callerCount),
      num(ib.calleeCount), num(ib.bottleneckScoreX1000),
    ])
    // Extract `file:name` → file
    const colonIdx = ib.symbol.lastIndexOf(':')
    if (colonIdx > 0) {
      symbolFileRel.rows.push([sym(ib.symbol), sym(ib.symbol.slice(0, colonIdx))])
    }
  }
  relations.push(ibRel)
  relations.push(symbolFileRel)

  // ─── ImportCommunity (Newman-Girvan 2004 / Louvain 2008) ──────────
  // 8e discipline : community detection sur le graphe d'imports.
  // misplaced=1 si le file est dans une community != son package physique.
  const communityRel: RelationDef = {
    name: 'ImportCommunity',
    decl: '(file:symbol, communityId:number, physicalPackage:symbol, misplaced:number)',
    rows: [],
  }
  for (const c of snapshot.importCommunities ?? []) {
    communityRel.rows.push([
      sym(c.file), num(c.communityId),
      sym(c.physicalPackage), num(c.misplaced),
    ])
  }
  relations.push(communityRel)

  // ─── ModularityScore — score Q global Newman-Girvan ────────────────
  // Singleton fact : un seul tuple par snapshot.
  const modularityRel: RelationDef = {
    name: 'ModularityScore',
    decl: '(globalQX1000:number, communityCount:number, misplacedCount:number)',
    rows: [],
  }
  if (snapshot.modularityScore) {
    modularityRel.rows.push([
      num(snapshot.modularityScore.globalModularityX1000),
      num(snapshot.modularityScore.communityCount),
      num(snapshot.modularityScore.misplacedCount),
    ])
  }
  relations.push(modularityRel)

  // ─── FactKindStability (Markov stationary distribution) ────────────
  const stabilityRel: RelationDef = {
    name: 'FactKindStability',
    decl: '(relationName:symbol, snapshotsTotal:number, stableTransitions:number, stationaryStableX1000:number, avgTupleCount:number)',
    rows: [],
  }
  for (const fs of snapshot.factStabilities ?? []) {
    stabilityRel.rows.push([
      sym(fs.relationName), num(fs.snapshotsTotal),
      num(fs.stableTransitions), num(fs.stationaryStableX1000),
      num(fs.avgTupleCount),
    ])
  }
  relations.push(stabilityRel)

  // ─── BayesianCoChange (9e discipline : P(B|A) directionnelle) ──────
  const bayesRel: RelationDef = {
    name: 'BayesianCoChange',
    decl: '(driver:symbol, follower:symbol, conditionalProbX1000:number)',
    rows: [],
  }
  for (const b of snapshot.bayesianCoChanges ?? []) {
    bayesRel.rows.push([
      sym(b.driver), sym(b.follower),
      num(b.conditionalProbX1000),
    ])
  }
  relations.push(bayesRel)

  // ─── CompressionDistance (10e discipline : NCD Kolmogorov) ─────────
  const ncdRel: RelationDef = {
    name: 'CompressionDistance',
    decl: '(symbolA:symbol, symbolB:symbol, ncdX1000:number)',
    rows: [],
  }
  for (const ncd of snapshot.compressionDistances ?? []) {
    ncdRel.rows.push([
      sym(ncd.symbolA), sym(ncd.symbolB),
      num(ncd.ncdX1000),
    ])
  }
  relations.push(ncdRel)

  // ─── GrangerCausality (11e discipline : lag-1 causation git) ───────
  const grangerRel: RelationDef = {
    name: 'GrangerCausality',
    decl: '(driverFile:symbol, followerFile:symbol, observations:number, excessConditionalX1000:number)',
    rows: [],
  }
  for (const g of snapshot.grangerCausalities ?? []) {
    grangerRel.rows.push([
      sym(g.driverFile), sym(g.followerFile),
      num(g.observations), num(g.excessConditionalX1000),
    ])
  }
  relations.push(grangerRel)
}

function sym(value: string): string {
  return value.replace(/[\t\n\r]/g, ' ')
}

function num(n: number): string {
  return String(Math.trunc(n))
}

/**
 * Splitte un id symbole `"file/path.ts:symbolName"` en `{ file, symbol }`.
 * Retourne null si pas de `:` (id dégénéré). Le séparateur est le DERNIER
 * `:` (un path peut en théorie contenir `:`, en pratique non — paths POSIX).
 */
function splitFileSymbol(id: string): { file: string; symbol: string } | null {
  const idx = id.lastIndexOf(':')
  if (idx <= 0 || idx === id.length - 1) return null
  return { file: id.slice(0, idx), symbol: id.slice(idx + 1) }
}

/**
 * Splitte `EVENTS.RENDER_COMPLETED` en `{ ns: 'EVENTS', member: 'RENDER_COMPLETED' }`.
 * Retourne null si l'expression n'est pas un property access simple à 1 niveau
 * (ex: `obj.events.X`).
 */
function splitRef(expr: string): { ns: string; member: string } | null {
  const parts = expr.split('.')
  if (parts.length !== 2) return null
  const [ns, member] = parts
  if (!ns || !member) return null
  return { ns, member }
}
