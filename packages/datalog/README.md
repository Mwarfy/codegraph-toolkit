# @liby-tools/datalog

Pure-TypeScript Datalog interpreter for codegraph invariants.
Zero binary dependency, zero JVM, zero C++ runtime.

## Why this exists

ADRs as prose drift from the code they govern. Today an invariant lives in
three places — the `.md` ADR, the boot guard TS, and the invariant test —
which cannot all be kept in sync forever.

This package lets you write the invariant ONCE in `.dl`:

```datalog
.decl EmitsLiteral(file: symbol, line: number, eventName: symbol)
.decl Violation(adr: symbol, file: symbol, line: number, msg: symbol)
.input EmitsLiteral
.output Violation

Violation("ADR-017", File, Line, "untyped emit") :-
    EmitsLiteral(File, Line, _).
```

…feed it facts produced by `codegraph facts` (TSV files), and get a
deterministic stream of violations + proof trees explaining why each
fired. The ADR becomes executable — the prose is just commentary.

## Determinism guarantees

Every layer is content-addressable + sorted:

- Tuples canonically encoded (`s:` / `n:` prefix, `\x00` separator)
- `tupleHash` = sha256 truncated to 16 hex
- Output relations sorted lex (`number < string`)
- SCCs walked in lex order (Tarjan + lex tie-break)
- Stratum order via Kahn with lex tie-break
- Rules within a stratum sorted by source-order index

3 reruns of the same `(rules, facts)` produce identical SHA-256 of stdout.

## What it deliberately does NOT do

- Recursion (off by default; gated behind `allowRecursion: true`).
- Aggregates, choice, lattices.
- ADTs or arithmetic.
- Soufflé `.functor`, `.component`, `.plan`, `.printsize`, `.pragma`.
- High performance: O(N^k) join, no indices. Fine at codegraph scale
  (~3000 tuples), unsuitable for millions.

These are explicit non-features: the interpreter is built to express ADR
invariants and nothing else. If you need any of the above, use Soufflé.

## What it offers Soufflé doesn't

- Errors with `file:line:col` and stable error codes
- Proof trees usable directly in test assertions and CLI output
- Pure TypeScript types end-to-end (facts, rules, results)
- No `brew install`, no `g++`, no Dockerfile gymnastics
- Tests can mock facts in 5 lines of TS

## API

```ts
import { runFromDirs, runFromString } from '@liby-tools/datalog'

// File-system entry point.
const { result } = await runFromDirs({
  rulesDir: 'invariants',
  factsDir: '.codegraph/facts',
  recordProofsFor: ['Violation'],
})
console.log(result.outputs.get('Violation'))

// Programmatic / test entry point.
const { result } = runFromString({
  rules: `.decl A(x: symbol) ...`,
  facts: new Map([['A', [['hello']]]]),
})
```

## CLI

```sh
datalog run <rules-dir> --facts <facts-dir> [--proofs Violation] [--json]
datalog parse <file.dl>
```

## Layout

- `src/types.ts` — AST + runtime types
- `src/canonical.ts` — encoding, hashing, sorting
- `src/parser.ts` — `.dl` parser with line/col errors
- `src/facts-loader.ts` — TSV `.facts` loader with type coercion
- `src/stratify.ts` — Tarjan SCC + Kahn topological order
- `src/eval.ts` — bottom-up evaluator + proof recorder
- `src/runner.ts` — file-system orchestrator + pretty printer
- `src/cli.ts` — `datalog` binary
- `src/index.ts` — public API
