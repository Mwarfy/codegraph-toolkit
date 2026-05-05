// ADR-028 phase F.2 — Fix hints + exempt markers for Datalog rules.
/**
 * Mapping ADR-code → 1-line fix hint + marker pour exempt locale.
 * Quand le hook PostToolUse rapporte une NEW violation, il append cette
 * ligne `fix:` pour rendre l'output actionnable sans drill-down.
 *
 * Source des hints : tirés des `// Pourquoi` + `// Cas legitimes` des
 * fichiers `packages/invariants-postgres-ts/invariants/*.dl` + extracteurs
 * codegraph. Intentionnellement court (≤80 chars / hint).
 *
 * Si une rule manque ici, le hook skip silencieusement le `fix:` —
 * la violation reste affichée, juste sans hint. Ajout incrémental :
 * mettre à jour ce mapping quand une rule devient fréquente.
 */

export const FIX_HINTS = {
  // ─── Code quality patterns (Tier 17) ───────────────────────────────────
  'COMPOSITE-AWAIT-IN-LOOP': {
    fix: 'Promise.all([...]) si pas d\'ordre requis ; sinon // await-ok: <reason>',
    exempt: '// await-ok',
  },
  'COMPOSITE-ALLOC-IN-LOOP': {
    fix: 'hoist allocation hors boucle ou pool ; sinon // alloc-ok: <reason>',
    exempt: '// alloc-ok',
  },
  'COMPOSITE-CATCH-SWALLOW': {
    fix: 'logger l\'erreur ou commenter rationale ; sinon // catch-ok: <reason>',
    exempt: '// catch-ok',
  },
  'COMPOSITE-REGEX-CATASTROPHIC': {
    fix: 'simplifier le regex (éviter (a+)+, .+.+) ; sinon // regex-ok: <reason>',
    exempt: '// regex-ok',
  },

  // ─── Architecture (cycles, articulation, hubs) ─────────────────────────
  'cycles-no-new': {
    fix: 'casser le cycle via interface ou inversion de dépendance ; gate possible',
  },
  'no-new-articulation-point': {
    fix: 'fichier devenu hub déconnectant — extraire ou splitter en 2 modules',
  },
  'COMPOSITE-CRITICAL-INSTABILITY': {
    fix: 'fan-out élevé sur fichier instable (Martin I/A/D) — stabiliser API ou réduire deps',
  },
  'COMPOSITE-FANOUT-OVERLOAD': {
    fix: 'trop de modules dépendent de ce hub — splitter en sous-modules',
  },
  'COMPOSITE-BAYESIAN-DRIVER': {
    fix: 'co-change ≥80% directionnel — co-localiser ou shared abstraction',
  },
  'COMPOSITE-COCHANGE-WITHOUT-COTEST': {
    fix: 'fichiers co-modifiés mais leurs tests non — ajouter test couvrant la frontière',
  },

  // ─── SQL / Postgres ────────────────────────────────────────────────────
  'sql-fk-needs-index': {
    fix: 'CREATE INDEX sur la colonne FK — sinon DELETE CASCADE = full scan',
  },
  'sql-table-needs-pk': {
    fix: 'AJOUTER PRIMARY KEY — replication / partitionnement / dedup ne marchent pas sans',
  },
  'sql-timestamp-needs-tz': {
    fix: 'TIMESTAMPTZ au lieu de TIMESTAMP — sinon ambiguïté UTC vs local',
  },
  'sql-orphan-fk': {
    fix: 'la table cible n\'existe pas (encore ?) — vérifier ordre migrations',
  },
  'sql-naming-convention': {
    fix: 'Postgres convention : snake_case (table, columns, fk_*_id, index_*_idx)',
  },
  'sql-migration-order': {
    fix: 'FK référence une table créée APRÈS — réordonner les migrations',
  },
  'sql-audit-columns': {
    fix: 'ajouter created_at + updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  },

  // ─── Sécurité ──────────────────────────────────────────────────────────
  'no-eval': {
    fix: 'JAMAIS eval() / new Function() — utiliser JSON.parse, switch, function refs',
    exempt: '// eval-ok',
  },
  'no-hardcoded-secret': {
    fix: 'process.env.X (avec doc dans .env.example) ; sinon // secret-ok: <fixture-id>',
    exempt: '// secret-ok',
  },
  'cwe-022': {
    fix: 'path traversal — path.resolve + check startsWith(allowedRoot)',
  },
  'cwe-078': {
    fix: 'command injection — utiliser execFile([cmd, args[]]) au lieu de exec(string)',
  },
  'cwe-079': {
    fix: 'XSS — DOMPurify ou textContent au lieu de innerHTML',
  },
  'cwe-089': {
    fix: 'SQL injection — query builder paramétré (drizzle, knex, sql template tag)',
  },
  'cwe-327': {
    fix: 'algo crypto faible (md5/sha1/des) — utiliser sha256/argon2/bcrypt',
  },
  'cwe-502': {
    fix: 'unsafe deserialization — schema validation (zod) avant unmarshal',
  },
  'cwe-918': {
    fix: 'SSRF — whitelist hostname + résoudre + check non-private IP avant fetch',
  },
  'cwe-1321': {
    fix: 'prototype pollution — Object.create(null), schema validation des keys',
  },
  'COMPOSITE-CROSS-FN-SQL-INJECTION': {
    fix: 'taint multi-hop body→param→sink — sanitizer sur le path complet',
  },
  'COMPOSITE-CLEAR-TEXT-LOGGING': {
    fix: 'ne pas logger secrets/PII — masquer ou skip ces fields',
  },
  'COMPOSITE-CORS-MISCONFIG': {
    fix: 'CORS Origin: * + credentials:true = fuite — whitelist explicite',
  },

  // ─── Code quality / dead code ──────────────────────────────────────────
  'no-boolean-positional-param': {
    fix: 'remplacer flag positionnel par object literal { flag: true }',
  },
  'no-identical-subexpressions': {
    fix: 'expression a OP a — bug de copy-paste, vérifier l\'intention',
  },
  'no-return-then-else': {
    fix: 'if (x) return; else { ... } → if (x) return; ...',
  },
  'no-switch-fallthrough': {
    fix: 'ajouter break/return/throw, ou commenter // fallthrough',
  },
  'no-controlling-expression-constant': {
    fix: 'condition constante — code mort ou bug de logique',
  },
  'no-floating-promise': {
    fix: 'await ou void promise (et logger l\'error case)',
  },
  'no-deprecated-usage': {
    fix: 'API @deprecated — migrer vers la replacement mentionnée dans JSDoc',
  },
  'no-resource-imbalance': {
    fix: 'acquire sans release — utiliser try/finally ou pattern using',
  },

  // ─── Composites cross-cut runtime (ADR-026 phase D) ────────────────────
  'DEAD_HANDLER': {
    fix: 'export jamais touché runtime — supprimer ou ajouter un caller',
  },
  'DEAD_ROUTE': {
    fix: 'route HTTP sans trafic observé — vérifier registration ou supprimer',
  },
  'RUNTIME_DRIFT': {
    fix: 'symbol référencé statique, jamais touché runtime — refactor ou wire correctement',
  },
  'HOT_PATH_UNTESTED': {
    fix: 'fonction à fort trafic sans test — ajouter test couvrant le hot path',
  },
  'STALE_QUERY': {
    fix: 'table avec writers déclarés mais 0 activity DB — code mort ou refactor',
  },
  'COMPOSITE_CYCLE_RUNTIME_CONFIRMED': {
    fix: 'cycle statique CONFIRMÉ runtime — priorité haute, casser via inversion deps',
  },
  'COMPOSITE_HUB_BOTTLENECK': {
    fix: 'hub statique + p95 runtime > 500ms — profiler + optim ce fichier en priorité',
  },

  // ─── Drift agentique (Tier 4) ──────────────────────────────────────────
  'excessive-optional-params': {
    fix: '>5 params optionnels — extraire option object { ...opts }',
    exempt: '// drift-ok',
  },
  'wrapper-superfluous': {
    fix: 'wrapper pure forward — inliner ou supprimer',
    exempt: '// drift-ok',
  },
  'todo-no-owner': {
    fix: 'TODO sans @owner ni #issue — ajouter ou supprimer',
    exempt: '// drift-ok',
  },
  'deep-nesting': {
    fix: 'pyramide profonde — guard clauses ou extract method',
    exempt: '// drift-ok',
  },
  'empty-catch-no-comment': {
    fix: 'catch vide — logger ou commenter rationale',
    exempt: '// catch-ok',
  },

  // ─── Cross-discipline math (Tier 18) ───────────────────────────────────
  'COMPOSITE-CHAOS-AMPLIFIER': {
    fix: 'Lyapunov exponent élevé — modifs propagent largement, isoler le composant',
  },
  'COMPOSITE-COGNITIVE-BOMB': {
    fix: 'cognitive complexity > 30 — extraire sous-fonctions, simplifier control flow',
  },
  'COMPOSITE-CYCLOMATIC-BOMB': {
    fix: 'cyclomatic > 30 — split en functions plus petites, tester chaque branche',
  },
  'COMPOSITE-COPY-PASTE-FORK': {
    fix: 'Hamming distance 0 entre 2 sigs — factoriser, ou marquer divergence assumée',
  },
  'COMPOSITE-GOD-DISPATCHER': {
    fix: 'Shannon entropy callees > 4 bits — pattern God Object, splitter responsabilités',
  },
  'COMPOSITE-SPECTRAL-BOTTLENECK': {
    fix: 'Fiedler λ₂ faible — graphe quasi-cassé en 2, refactor connectivité',
  },
  'COMPOSITE-INFORMATION-HUB-UNTESTED': {
    fix: 'Information Bottleneck score haut + 0 tests — points d\'extension critiques sans safety',
  },
  'COMPOSITE-HIGH-CRITICAL-UNTESTED': {
    fix: 'articulation point + truth-point + 0 tests — blast radius max sans filet',
  },
  'COMPOSITE-NEAR-DUPLICATE-FN': {
    fix: 'NCD < 0.3 entre 2 fonctions — factoriser ou différencier explicitement',
  },
  'COMPOSITE-STRUCTURAL-CYCLE-PERSISTENT': {
    fix: 'cycle persistent > 50% snapshots — anomalie architecturale, casser maintenant',
  },

  // ─── Hygiène package ───────────────────────────────────────────────────
  'COMPOSITE-BARREL-LOW-VALUE': {
    fix: 'barrel pure re-export sans consumer — supprimer ou ajouter use case',
  },
  'COMPOSITE-PACKAGE-COUPLING': {
    fix: 'min-cut > 5 entre 2 packages — interface stricte ou merge',
  },

  // ─── Floating promises / async ─────────────────────────────────────────
  'COMPOSITE-FLOATING-PROMISE-IN-HOT': {
    fix: 'floating promise sur hot path — await + handle errors explicit',
  },
  'COMPOSITE-ASYNC-SINK-WITH-SWALLOW': {
    fix: 'async sink + try/catch silent — log au moins, ou re-throw',
  },
}

/**
 * Lookup avec fallback case-insensitive sur le code (les .dl utilisent
 * majuscules `COMPOSITE-X`, certains tests utilisent kebab-case).
 */
export function getFixHint(adr) {
  return FIX_HINTS[adr] ?? FIX_HINTS[adr?.toUpperCase()] ?? FIX_HINTS[adr?.toLowerCase()] ?? null
}
