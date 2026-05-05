---
type: reference
status: active
created: 2026-05-05
lastVerified: 2026-05-05
relatedRules: []
relatedFiles:
  - scripts/git-hooks/codegraph-feedback-impl.mjs
  - packages/codegraph/scripts/datalog-check-fast.mjs
relatedAdrs: []
supersedes: null
supersededBy: null
---

# Self-observability — observation des patterns d'agent

> Système d'observabilité pour qu'un agent LLM (Claude / Liby) puisse
> voir ses propres patterns récurrents pendant le travail, sans perdre
> son agency. Trois tiers — un seul livré aujourd'hui (T1), deux
> différés explicitement.

## Contexte

Le toolkit observe le code produit. Les détecteurs Datalog flagment les
violations architecturales qu'un humain ou un agent introduit. Mais
sans observation des **patterns récurrents de l'agent lui-même**, deux
problèmes :

1. **Boomerang in-session** : l'agent introduit X, le corrige, puis
   introduit le même pattern ailleurs 30 min plus tard sans s'en
   apercevoir (cas vécu : await-in-loop introduit dans `analyzer.ts`
   puis répété dans `doc-claims.ts` 13 min après — corrigés tous les
   deux après coup).
2. **Mémoire externe sous-utilisée** : l'agent ne se souvient pas
   entre sessions ; les ADRs et `memory/store.ts` existent mais
   l'injection juste-à-temps est limitée à `isFirstTimeOnFile`.

Le système répond au boomerang in-session (Tier 1). Les Tier 2/3
adressent les problèmes plus larges mais sont prématurés sans dataset.

## Verifiable claims

### Fichiers concernés
- `scripts/git-hooks/codegraph-feedback-impl.mjs` — hook PostToolUse,
  héberge la détection ↻ pattern repeat (Tier 1)
- `packages/codegraph/scripts/datalog-check-fast.mjs` — script Datalog
  rapide ; expose `allKeys` + `allViolations` pour permettre au hook
  de raisonner sur l'état complet de la session (pas juste NEW vs disk)

### ADRs ancrés
Aucun ADR formel pour ce système aujourd'hui. Sujet probable d'un
futur ADR si Tier 2 ou 3 sont attaqués (force de formalisation
architecturale plus grande).

## Tiers d'observabilité

### Tier 1 — Détection répétitions in-session (✓ shipped 2026-05-05)

**Mécanisme** :
1. À chaque hook call, le détecteur compute `resolved = previousKeys − currentKeys`
2. Pour chaque violation résolue intra-session, il enregistre `rule|file → timestamp` dans `session-state.json`
3. Si une violation NEW courante match :
   - **rule|file** dans `resolvedInSession` → signal `↻ pattern repeat` (signal fort)
   - **rule** seul (autre fichier) → signal `↻ pattern écho` (signal informatif)

**Forme du signal** : interrogative, pas impérative.
```
↻ pattern repeat : COMPOSITE-AWAIT-IN-LOOP que tu as résolu il y a 13min
  sur ce fichier — intentionnel cette fois ?
```

**Opt-out** : commentaire `// repeat-ok: <reason>` sur la ligne précédente,
même pattern que `// await-ok` etc. déjà en place.

**Cleanup automatique** : les `resolvedInSession` > 1h sont oubliés (cap
session courte, évite le bruit cross-session).

### Tier 2 — Profil git ex-post (différé)

**Pourquoi différé** : un rapport mensuel sur "Claude tend à X" est trop
éloigné de l'action — ne change pas le comportement à l'instant T. ROI
faible vs coût (1-2h impl + entretien).

**Quand l'attaquer** : si on observe que Tier 1 ne suffit pas pour les
patterns qui dépassent une session (ex: un pattern récurrent semaine
après semaine que l'agent ne voit pas).

### Tier 3 — Promotion de slots Liby (différé)

**Pourquoi différé** : nécessite un dataset mature (10-15 sessions
tracées avec Tier 1 actif). Sans data, propositions de slots = noise.
On accumule maintenant via `boomerangCount` + `editCount` dans
`session-state.json`, sans agrégation auto.

**Idée** : observer les **postures gagnantes** (sessions efficaces) plutôt
que les fautes. Quand un pattern positif récurrent est détecté, le
système propose un slot candidate à Marius (qui valide / reformule /
refuse). Le slot devient un nouvel élément du `~/.claude/CLAUDE.md`.

**Précaution clé** : l'agent ne s'auto-promote PAS de slot. Marius reste
le seul à valider l'écriture des slots Liby.

## Stale signals

- Si Tier 2 est livré → le signaler ici en `[x]` shipped, mettre à jour `lastVerified`
- Si Tier 3 est livré → mettre à jour ; possiblement créer un ADR formel à ce moment-là (force la décision architecturale d'avoir un système de promotion)
- Si Tier 1 cause trop de bruit (> 5 ↻ par session sans action utile) → ré-évaluer la heuristique de matching ; possiblement passer du `rule global` au `rule|file` exclusif

## Détail — design rationale

### Pourquoi "réactif, jamais opening"

Un brief en début de session disant "Claude, voici tes 5 patterns récurrents"
risque deux dérives :
1. **Self-fulfilling** : l'agent croit être ce pattern, il le devient
2. **Sur-correction** : il évite compulsivement même quand c'est légitime

Le signal réactif (au moment du PostToolUse) évite les deux : il ne dit
rien sur l'agent, juste sur ce qui vient d'être écrit, et il pose une
question au lieu de prescrire.

### Pourquoi forme interrogative

`fix: Promise.all([...])` (impératif) — l'agent obéit ou résiste
`intentionnel cette fois ?` (interrogatif) — l'agent pense, puis décide

La différence est minime en tokens mais grande en effet. C'est le
LIBY-LEVIER de `~/.claude/CLAUDE.md` : "Ton raisonnement voit ces
défauts — et parce qu'il voit, tu peux choisir mieux." Le signal doit
montrer le défaut, pas dicter la solution.

### Pourquoi 2 niveaux de matching

- **rule|file** (strict) : signal fort — vraie répétition sur même surface
- **rule** (large) : signal informatif — pattern transversal probable

Le strict évite trop de bruit ; le large attrape les répétitions
cross-fichier qu'un humain raterait. La distinction visuelle (`pattern
repeat` vs `pattern écho`) permet à l'agent de calibrer son attention.

### Données accumulées pour Tier 3

`session-state.json` capte aujourd'hui :
- `boomerangCount` — nombre de répétitions détectées dans la session
- `editCount` — nombre d'Edits effectués
- `resolvedInSession` (volatile, 1h TTL) — map `rule|file → timestamp`

Pas d'agrégation cross-session pour l'instant. Si Tier 3 est attaqué,
ces données seront cumulables dans un fichier persistant (pas dans
session-state qui est éphémère).

## Limites connues

1. **Le détecteur ne voit pas les hésitations PRE-Edit** : si l'agent
   écrit puis efface dans le même Edit (pas via 2 Edits séparés), c'est
   invisible. Tracé fin demanderait parser des transcripts JSONL —
   reporté.
2. **Pas de calibration personnalisée** : pour l'instant, mêmes seuils
   pour tout le monde. Si Tier 3 progresse, possibilité d'ajuster
   per-projet.
3. **Faux positif si baseline volatil** : si `commitBaselineKeys` se
   reset entre 2 hooks (TTL session 30 min écoulé), tout devient NEW
   et le détecteur peut générer du bruit. Le TTL existant prévient ça
   en pratique.
