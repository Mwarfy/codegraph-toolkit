# Runtime-graph recipes — par framework

Exemples concrets de probe pour les frameworks Node typiques. Les facts
produits sont les mêmes (HttpRouteHit, DbQueryExecuted, etc.) — seule la
commande diffère.

> **Press-button** : utilise `npx liby-runtime-graph probe -- <cmd>` qui
> auto-détecte CJS/ESM et configure les env vars pour toi. Les recipes
> ci-dessous sont les commandes alternatives si tu veux contrôle complet.

---

## Express / Connect / similar

```bash
# Press-button (recommandé)
npx liby-runtime-graph probe --cpu-profile -- node app.js

# Manuel (CJS)
NODE_OPTIONS="--require ./node_modules/@liby-tools/runtime-graph/dist/capture/auto-bootstrap.js" \
  LIBY_RUNTIME_PROJECT_ROOT="$(pwd)" \
  LIBY_RUNTIME_FACTS_OUT="$(pwd)/.codegraph/facts-runtime" \
  LIBY_RUNTIME_CPU_PROFILE=1 \
  node app.js

# Manuel (ESM, package.json "type": "module")
NODE_OPTIONS="--import file://$(realpath ./node_modules/@liby-tools/runtime-graph/dist/capture/auto-bootstrap.js)" \
  LIBY_RUNTIME_PROJECT_ROOT="$(pwd)" \
  LIBY_RUNTIME_FACTS_OUT="$(pwd)/.codegraph/facts-runtime" \
  node app.mjs
```

**Facts attendus** : `HttpRouteHit` (1 par route hit), `DbQueryExecuted`
si pg/mysql/mongodb auto-instruments matchent.

---

## Fastify

```bash
# Identique à Express — Fastify utilise node:http en interne
npx liby-runtime-graph probe -- node server.mjs
```

Note : Fastify ajoute des middlewares qui peuvent obscurcir certains spans.
Pour avoir les routes ciblées, run avec `--cpu-profile` aussi.

---

## Next.js (server only)

```bash
# Probe le serveur Next pendant un load test
npx liby-runtime-graph probe -- npm run start

# Ou avec le runner Vercel
npx liby-runtime-graph probe -- next start -p 3000
```

**Limitations** : Next bundle le code applicatif → les attributs `code.filepath`
peuvent pointer vers des chunks générés (`/.next/server/pages/...`) au lieu du
source. Pour avoir les bons noms, build avec `productionBrowserSourceMaps: true`
dans next.config.js + filtre les patterns `.next/` dans aggregateProfile.

---

## NestJS

```bash
npx liby-runtime-graph probe --cpu-profile -- npm run start:dev
```

NestJS utilise Express (ou Fastify) sous le capot — comportement identique.

---

## Vitest / Jest test runs

```bash
# Probe pendant npm test — capture les chemins exécutés par les tests
npx liby-runtime-graph probe --cpu-profile -- npm test

# Important : les test runners spawnent des sub-processes. Chaque sub-process
# a son propre pid-N/ dans .codegraph/facts-runtime/.
```

**Use case** : identifier les fonctions hot pendant les tests = candidates
à optimiser, identifier les fonctions JAMAIS touchées = dead code candidates.

---

## TSX / TypeScript scripts directs

```bash
# tsx résout l'ESM transparently — auto-detect marche
npx liby-runtime-graph probe -- npx tsx scripts/your-script.ts
```

---

## Worker threads / Cluster

Le bootstrap se charge dans le main process. Les worker threads créés via
`new Worker(...)` n'héritent **pas** automatiquement de NODE_OPTIONS.

**Workaround** : passer le bootstrap dans les options du Worker :

```js
new Worker('./worker.mjs', {
  execArgv: [
    `--import=file://${require.resolve('@liby-tools/runtime-graph/capture/auto-bootstrap')}`,
  ],
})
```

---

## Coverage runtime patterns

Une fois les facts capturés, exploite-les via :

```bash
# Run datalog rules sur runtime + statique
npx liby-runtime-graph check

# Ou via API
import { suggestOptimizations, analyzeDivergence } from '@liby-tools/runtime-graph'
```

---

## Check rapide post-probe

```bash
# Combien de spans capturés ?
ls .codegraph/facts-runtime/pid-*/RuntimeRunMeta.facts | head -1 | xargs cat
# auto-bootstrap  <unix>  <durMs>  <totalSpans>

# Quelles routes hit ?
cat .codegraph/facts-runtime/pid-*/HttpRouteHit.facts

# Hot symbols (si --cpu-profile activé)
sort -t$'\t' -k3 -rn .codegraph/facts-runtime/pid-*/SymbolTouchedRuntime.facts | head -10
```
