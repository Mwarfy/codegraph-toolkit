---
asserts:
  - symbol: "bootstrap#bootstrapAdrs"
    exists: true
  - symbol: "bootstrap#detectSingletonCandidates"
    exists: true
  - symbol: "bootstrap-writer#applyDrafts"
    exists: true
---

# ADR-004: Bootstrap = 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)

**Date:** 2026-04-29
**Status:** Proposed

## Rule

> Le bootstrap agentique sépare 3 rôles, et aucun ne franchit son périmètre :
>
> 1. **OÙ regarder** : codegraph + pattern detectors (déterministe). Le
>    LLM ne décide jamais quels fichiers méritent un ADR.
> 2. **COMMENT formuler** : un agent Sonnet par candidat avec prompt
>    cadré et output JSON forcé. Le LLM rédige Rule + Why + asserts depuis
>    le code, rien d'autre.
> 3. **QUOI accepter** : humain (CLI revue + `--apply` confirmé). Les
>    ADRs sont écrits avec `Status: Proposed`, jamais `Accepted`.

## Why

Sans cette séparation, deux dérives :
- LLM choisit quoi protéger → propose 50 ADRs (bruit), ou rate les vrais
  invariants parce qu'ils ne sont pas évidents textuellement.
- LLM valide son output → hallucinations propagées dans le code (asserts
  cassés qui pèteraient au pre-commit suivant).

Le risque qui justifie ces 3 rôles est l'**illusion de précision** : un
ADR auto-généré ressemble à une décision humaine, mais c'est juste une
photographie du code (parfois mauvais code). L'ADR doit dire *"ce qui
DOIT être"*, pas *"ce qui EST"*. Le filtre humain est la fonction
critique, pas une lourdeur.

## How to apply

- Codegraph détecte (`detectSingletonCandidates`, futurs `detectFsm`,
  `detectWriteIsolation`, `detectHub`) — fonctions pures, regex sur le
  code, pas d'appel LLM ici.
- L'orchestrateur (`bootstrapAdrs`) spawn UN agent par candidat avec un
  prompt-template par pattern (`SINGLETON_PROMPT_TEMPLATE`, etc.). Le
  prompt force l'output JSON, donne le format `module#symbol` exact,
  bannit les phrases génériques.
- Validation pré-écriture (`validateDraftAsserts`) : chaque draft passe
  par `checkAsserts` sur un ADR temporaire. Asserts qui pètent → retirés
  du draft + `validationNotes` annoté.
- Output : `Status: Proposed`. Le user lit, complète "How to apply" /
  "Tested by", puis passe `Status: Accepted` à la main.
- ANTI-PATTERN : ajouter un détecteur qui ferait des appels LLM pour
  élargir le périmètre. ANTI-PATTERN : générer un ADR `Status: Accepted`
  directement.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/adr-toolkit/src/bootstrap-fsm.ts` — 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)
- `packages/adr-toolkit/src/bootstrap-writer.ts` — 3 rôles séparés (Status: Proposed only, jamais Accepted)
- `packages/adr-toolkit/src/bootstrap.ts` — 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)


## Tested by

- `packages/adr-toolkit/tests/bootstrap-detect.test.ts` — valide que le
  détecteur singleton matche les bons patterns (4 cas : positif strict,
  positif readonly, négatif util pure, négatif faux ami).
- _(à ajouter : test E2E qui mock l'agent LLM et vérifie que le
  `validateDraftAsserts` retire correctement les asserts cassés.)_
