# Sprint 13 — détecteur `fsm` pour bootstrap ADR

> **Pour Claude qui reprend dans une nouvelle session :** lis CE FICHIER
> EN ENTIER avant toute action. Lis aussi `BOOTSTRAP-DETECTORS-BACKLOG.md`
> pour le contexte global et les 2 détecteurs déjà livrés (write-isolation,
> hub) qui suivent le même pattern.

## Contexte

3 détecteurs bootstrap déjà livrés (v0.1.0 → v0.2.0) :
- ✅ `singleton` — private static instance + getInstance
- ✅ `write-isolation` — truth-points avec UN seul writer (depuis snapshot)
- ✅ `hub` — in-degree ≥ threshold sans marqueur ADR

Reste : `fsm` — c'est le plus complexe parce qu'il demande une analyse
AST cross-référencée (types declarations + writes observables).

## Pourquoi détecter les FSMs

Les unions de string literals avec suffixe `Status` / `State` / `Phase` /
`Stage` sont typiquement des FSMs implicites : il y a des transitions
valides (PENDING → APPROVED) et invalides (REJECTED → APPROVED). Sans
ADR, ces invariants sont nulle part formalisés.

Quand quelqu'un rajoute un nouvel état dans l'union ou retire un
existant, l'effet sur les transitions est souvent invisible jusqu'à un
bug de prod (transition impossible déclenchée silencieusement).

L'ADR proposé verrouille les transitions valides + leur trigger (event
listener / HTTP route / init). Cf. `DeployLogPhase` dans Sentinel qui
était un cas évident.

## Architecture proposée

```ts
// packages/adr-toolkit/src/bootstrap.ts (extension)

interface FsmCandidate extends PatternCandidate {
  kind: 'fsm'
  /** Nom du type FSM (ex: BlockStatus) */
  fsmName: string
  /** Valeurs littérales détectées (ex: ['pending', 'running', 'completed', 'failed']) */
  values: string[]
  /** Sites où une valeur est ÉCRITE (assignments + SQL UPDATE + object literal) */
  writeSites: Array<{
    file: string
    line: number
    value: string  // valeur attribuée
    trigger?: string  // contexte (function name, route, etc.) si trouvable
  }>
}

export async function detectFsmCandidates(
  config: AdrToolkitConfig,
  files: string[],
  options: { suffixes?: string[] } = {},
): Promise<FsmCandidate[]>
```

## Heuristique de détection

### Étape 1 — trouver les types FSM-like

Walk les sources via ts-morph Project, filter sur :

```ts
function isFsmCandidate(node: TypeAliasDeclaration | EnumDeclaration): boolean {
  const name = node.getName()
  if (!name) return false

  // Suffix matching strict (sinon faux positifs)
  const suffixes = ['Status', 'State', 'Phase', 'Stage']
  if (!suffixes.some(s => name.endsWith(s))) return false

  // Pour TypeAlias : vérifier que c'est une union de string literals
  if (TypeAliasDeclaration) {
    const type = node.getType()
    return type.isUnion() && type.getUnionTypes().every(t => t.isStringLiteral())
  }
  // Pour Enum : vérifier que les values sont strings
  if (EnumDeclaration) {
    return node.getMembers().every(m => m.getInitializer()?.getKind() === StringLiteral)
  }
  return false
}
```

### Étape 2 — extraire les valeurs

```ts
function extractFsmValues(node: TypeAliasDeclaration | EnumDeclaration): string[] {
  if (TypeAliasDeclaration) {
    const type = node.getType()
    return type.getUnionTypes()
      .filter(t => t.isStringLiteral())
      .map(t => t.getLiteralValue() as string)
  }
  if (EnumDeclaration) {
    return node.getMembers()
      .map(m => {
        const init = m.getInitializer()
        if (init && init.getKind() === StringLiteral) {
          return (init as StringLiteral).getLiteralValue()
        }
        return null
      })
      .filter((v): v is string => v !== null)
  }
  return []
}
```

### Étape 3 — trouver les writes observables

Le cross-référencement est le coût principal. Approche en 3 passes :

#### A. Object literal writes : `{ status: 'X' }`

```ts
// Walk PropertyAssignments où la propriété a le même nom que le FSM
// (ex: status / state / phase / stage)
for (const sf of project.getSourceFiles()) {
  for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = pa.getName()
    if (!FSM_PROPERTY_NAMES.has(name)) continue
    const init = pa.getInitializer()
    if (!init) continue
    if (init.getKind() === SyntaxKind.StringLiteral) {
      const value = (init as StringLiteral).getLiteralValue()
      // Cross-référencer avec les FSM values découvertes
      if (fsmValues.includes(value)) {
        writeSites.push({ file: sf.getFilePath(), line: pa.getStartLineNumber(), value })
      }
    }
  }
}
```

`FSM_PROPERTY_NAMES = new Set(['status', 'state', 'phase', 'stage'])`

#### B. SQL UPDATE writes

Reuse l'existant `extractWriteTable` du `data-flows` extractor. Plus
précisément, scanner les literal SQL strings pour `UPDATE foo SET status =
'X'`. Ce code existe déjà dans `extractors/state-machines.ts` — réutiliser.

#### C. Direct assignments : `obj.status = 'X'`

```ts
for (const ba of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
  const op = ba.getOperatorToken().getKind()
  if (op !== SyntaxKind.EqualsToken) continue
  const left = ba.getLeft()
  if (!Node.isPropertyAccessExpression(left)) continue
  if (!FSM_PROPERTY_NAMES.has(left.getName())) continue
  const right = ba.getRight()
  if (right.getKind() === SyntaxKind.StringLiteral) {
    const value = (right as StringLiteral).getLiteralValue()
    if (fsmValues.includes(value)) {
      writeSites.push({ ... })
    }
  }
}
```

### Étape 4 — déduire les transitions (optionnel v1)

Pour chaque write site, trouver le contexte englobant :
- Le nom de la fonction (ts-morph `getAncestorByKind(FunctionDeclaration | MethodDeclaration | ArrowFunction)`)
- Si dans une route HTTP / event listener (cross-ref avec data-flows entry-points)

V1 : juste capturer le contexte fonction. V2 : reconstruire les
transitions (read state X → write state Y).

## Pièges à NE PAS rater

### Piège 1 — Suffix-only = faux positifs

`ConsoleState`, `DefaultState`, `EmptyState` peuvent matcher le suffix
sans être des FSMs métier. Le filtre "union de string literals" élimine
les types non-FSM (ex: `interface ConsoleState { logs: string[] }` n'est
pas une union de littéraux).

### Piège 2 — Enum const vs Enum string

`enum BlockStatus { PENDING = 'pending', RUNNING = 'running' }` est OK.
Mais `enum BlockStatus { PENDING, RUNNING }` (sans initializer) compile
en numbers — pas une FSM string. Skip.

### Piège 3 — Cross-référencer sans Project shared

ts-morph Project est lourd (3-5s build). Le détecteur `singleton` actuel
ne charge pas un Project (regex-only). Pour `fsm` on a besoin du Project.

Solution : prendre le Project en paramètre, comme `extractUnusedExportsFileBundle`.
L'orchestrateur (`bootstrap.ts`) crée un Project une fois et le passe.

### Piège 4 — String literals dans des contextes non-FSM

Une string `'pending'` peut être dans un commentaire, un test, une
constante non-FSM. Filtrer par cross-référencement avec les valeurs
EXACTES du type FSM élimine ces faux positifs.

### Piège 5 — Suffixes hors anglais

Sentinel a `BlockStatus` (anglais) mais d'autres projets pourraient avoir
`ÉtatBlock` (français), `BlockEstado` (espagnol). Pour v1 : supporter
seulement anglais (suffixes par défaut). Permettre customisation via
options.

## Plan d'attaque pas-à-pas

### Étape 1 — Helper d'extraction (1h)

Créer `packages/adr-toolkit/src/bootstrap-fsm.ts` (séparer du fichier
bootstrap.ts qui devient gros) :

```ts
export interface FsmCandidate extends PatternCandidate { ... }

export function detectFsmCandidates(
  config: AdrToolkitConfig,
  files: string[],
  options: { suffixes?: string[] } = {},
): FsmCandidate[]
```

Fonction sync (pas async) — Project ts-morph est synchrone.

### Étape 2 — Tests fixtures (1h)

`packages/adr-toolkit/tests/fixtures/fsm/` :

```
positive-strict.ts:
  type BlockStatus = 'pending' | 'running' | 'completed' | 'failed'
  function setStatus(b: Block, s: BlockStatus) { b.status = s }
  function start(b: Block) { b.status = 'running' }

negative-suffix-not-fsm.ts:
  interface ConsoleState { logs: string[] }  // pas une union literals
  type ResultState<T> = { ok: T } | { err: Error }  // pas literals

negative-numeric-enum.ts:
  enum BlockStatus { PENDING, RUNNING }  // pas string

limit-no-writes.ts:
  type DeployPhase = 'init' | 'build' | 'deploy'  // pas de writes → pas FSM active
```

Tests dans `packages/adr-toolkit/tests/bootstrap-fsm.test.ts` :

```ts
describe('detectFsmCandidates', () => {
  it('detects FSM with values + write sites', () => {
    const candidates = detectFsmCandidates(config, ['fixtures/fsm/positive-strict.ts'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].fsmName).toBe('BlockStatus')
    expect(candidates[0].values).toEqual(['pending', 'running', 'completed', 'failed'])
    expect(candidates[0].writeSites.length).toBeGreaterThanOrEqual(2)
  })

  it('skips suffix matches without literal union', () => {
    const candidates = detectFsmCandidates(config, ['fixtures/fsm/negative-suffix-not-fsm.ts'])
    expect(candidates).toHaveLength(0)
  })

  it('skips numeric enums', () => {
    const candidates = detectFsmCandidates(config, ['fixtures/fsm/negative-numeric-enum.ts'])
    expect(candidates).toHaveLength(0)
  })

  it('returns FSM but flags it as inactive (no writes)', () => {
    // Décision : on retourne quand même mais writeSites = []
    const candidates = detectFsmCandidates(config, ['fixtures/fsm/limit-no-writes.ts'])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].writeSites).toEqual([])
  })
})
```

### Étape 3 — Wirage dans bootstrap.ts (30min)

Ajouter au runner orchestrateur :

```ts
// dans bootstrap.ts
const candidates = [
  ...await detectSingletonCandidates(config, files),
  ...await detectWriteIsolationCandidates(config, snapshotPath),
  ...await detectHubCandidates(config, snapshotPath),
  ...detectFsmCandidates(config, files),  // ← nouveau (sync)
]
```

### Étape 4 — Prompt template FSM (1h)

`packages/adr-toolkit/src/bootstrap-prompts.ts` (à créer si pas
existant) :

```ts
export const FSM_PROMPT_TEMPLATE = (candidate: FsmCandidate) => `
Tu rédiges un draft d'ADR pour une FSM (Finite State Machine) implicite.

CANDIDAT :
- Type : ${candidate.fsmName}
- Valeurs : ${candidate.values.join(', ')}
- Write sites observés (${candidate.writeSites.length}) :
${candidate.writeSites.slice(0, 10).map(s => `  - ${s.file}:${s.line} → '${s.value}'`).join('\n')}

CONTRAINTES :
- Rule : 1 phrase, présent indicatif. Doit énoncer "X est une FSM avec
  les états {values}". Pas de transitions ici (on ne les déduit pas
  encore en v1).
- Why : 2 phrases max. Doit citer un commentaire/git/TODO. Si rien :
  flag basse confiance.
- Asserts : ts-morph asserts sur l'existence du type + la liste de
  valeurs (string literal union check).
- Anchors : 1 fichier max (celui qui définit le type).

Output JSON {verdict, rule, why, asserts, anchors}.
`
```

### Étape 5 — Build + tests parité (30min)

```bash
cd codegraph-toolkit
npx tsc -b packages/adr-toolkit
npx vitest run packages/adr-toolkit
```

Tests existants doivent passer + nouveaux fsm tests pass.

### Étape 6 — Commit + bump version (30min)

```
feat(adr-toolkit): détecteur fsm — unions string literals + write sites

[mesures sur Sentinel : N FSM candidates détectés]

Co-Authored-By: ...
```

Bump `@liby-tools/adr-toolkit` à 0.3.0 (et inter-deps consumers à
^0.3.0). Republish + tag v0.3.0.

## Estimation effort

3-4h dédiées :
- Étape 1 : 1h (extract helper, types, ts-morph walk)
- Étape 2 : 1h (fixtures + tests)
- Étape 3 : 30min (wiring orchestrateur)
- Étape 4 : 1h (prompt template — optionnel pour v1, peut juste réutiliser un template singleton-like)
- Étape 5-6 : 1h (build, tests, commit, publish)

## Reprise rapide checklist

1. [ ] Lire CE FICHIER en entier
2. [ ] Lire `BOOTSTRAP-DETECTORS-BACKLOG.md` pour le contexte global
3. [ ] Lire `packages/adr-toolkit/src/bootstrap.ts` :
   - Section `detectSingletonCandidates` comme référence regex-only
   - Section `detectWriteIsolationCandidates` comme référence snapshot-based
   - Section `detectHubCandidates` comme référence in-degree compute
4. [ ] `git log --oneline | head -10` pour voir l'état actuel des commits
5. [ ] `npx vitest run --workspace=@liby-tools/adr-toolkit` doit passer
6. [ ] Suivre les 6 étapes ci-dessus dans l'ordre
7. [ ] Pas de commit avant tests fsm passants
8. [ ] Bump version + republish une fois validé

## Décisions architecturales prises (ne pas remettre en cause)

- **Suffix-only filtering avec validation literal union** : OK pour
  v1. Les faux positifs sont éliminés par la 2e check.
- **ts-morph Project shared** : oui, le détecteur reçoit le Project
  pour ne pas re-parse. Coût : signature légèrement différente vs
  singleton (qui est regex-only).
- **String enums acceptés, numeric enums skippés** : volontaire (les
  numeric enums n'ont pas la sémantique "FSM avec étiquettes").
- **Transitions non-déduites en v1** : on capture juste les write
  sites + le contexte fonction. La reconstruction "read X → write Y"
  est V2 (demande control flow analysis non-triviale).
- **Output FsmCandidate étend PatternCandidate** : le runner
  bootstrap.ts traite uniformément via `kind`.
