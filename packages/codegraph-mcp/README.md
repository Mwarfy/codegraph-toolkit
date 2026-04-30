# @liby-tools/codegraph-mcp

MCP server exposing codegraph snapshot queries — architectural intelligence for Claude Code.

## Why

LSP gives **semantic fine-grained** intelligence (symbols, types, refs).
codegraph-mcp gives **structural coarse-grained** intelligence: files,
ADRs, truth-points, cycles, technical debt, co-change patterns, FK
issues. Together: complete architectural context, push-and-pull, no
redundancy.

Without codegraph-mcp, the codegraph snapshot is a static artifact only
consumed by hooks (push). With it, queries become callable on-demand
(pull) — the same way LSP exposes semantic queries on-demand.

## 9 Tools

### File-level (5)

| Tool | Use case |
|---|---|
| `codegraph_context(file)` | Architectural context: in/out degree, top importers, exports problématiques, cycles, truth-points, long functions, magic numbers, test coverage. Same as PostToolUse hook, on-demand. **Use BEFORE editing.** |
| `codegraph_who_imports(file, include_indirect?)` | Files that import the given file (FILE-level). Distinct from `lsp_find_references` which is SYMBOL-level. For impact analysis at the module boundary. |
| `codegraph_truth_point_for(file)` | The file's participation in truth-points: canonical concepts it writes/reads/mirrors. **Critical before modifying anything DB/SSOT-related.** |
| `codegraph_recent(file, weeks?)` | Git archaeology: commits in last N weeks, top contributor, file age. |
| `codegraph_uncovered(critical_only?, limit?)` | Source files without test coverage, ranked by criticality (truth-point writers + hubs first). |

### Temporal (1)

| Tool | Use case |
|---|---|
| `codegraph_co_changed(file, limit?, min_jaccard?)` | Files frequently co-modified with the given file (90d window, Jaccard coefficient). Detects operational coupling NOT codified in imports. "When I touch X, I tend to touch Y" — strong signal for truth-point readers/writers. |

### Symbol-level (2)

| Tool | Use case |
|---|---|
| `codegraph_who_calls(symbol, limit?)` | Call sites of a symbol with **observed types at the call site** (zod schemas, etc.). Complementary to `lsp_find_references` which is compile-time syntax-level — here you see actual runtime types. Useful when auditing contract-of-fact vs declared signature. |
| `codegraph_extract_candidates(file, limit?, min_loc?)` | Long functions in a file ranked by extract-method strength: `score = loc × (1 + fanIn/5)`. Favors long AND called-often (high cognitive load × high blast radius). |

### Graph-level (2)

| Tool | Use case |
|---|---|
| `codegraph_affected(files, max_depth?, separate_tests?)` | BFS reverse from a list of files to find ALL transitively impacted files. Separates affected tests for selective test running. **Pre-commit selector**: `git diff --name-only` → affected → tests subset → `vitest run <list>`. |
| `codegraph_changes_since(reference?)` | Structural diff between current snapshot (live if `codegraph watch` running, else latest post-commit) and a reference. **Default reference = last post-commit** → "since last commit, what did my uncommitted edits change structurally?". Cycles, FSMs, truth-points, dataFlows, typed signatures. |

## Setup

### Prerequisites

- **Node.js** ≥ 18
- A consuming project that has run `codegraph analyze` at least once (creates `.codegraph/snapshot-*.json`)

### Install

```bash
npm install -g @liby-tools/codegraph-mcp
# OR via this monorepo:
npm link --workspace=@liby-tools/codegraph-mcp
```

### Wire in Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph-mcp",
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

Restart Claude Code. The 9 tools become available as `mcp__codegraph__*`.

### Verify

In Claude Code:
> `codegraph_context(file_path: "path/to/some/file.ts")`

Should return the architectural context block.

## Recommended workflow

1. **Start of session**: launch the watcher in background
   ```bash
   npx codegraph watch &
   ```
   Maintains `.codegraph/snapshot-live.json` fresh (~50ms warm via Salsa cache).

2. **Before editing a file**: `codegraph_context(file)` to know its blast radius. Watch for:
   - HIGH-RISK header (truth-point writer / hub / cycle participant)
   - Top importers count
   - Co-change pairs

3. **Before changing a function signature**: `codegraph_who_calls(symbol)` to see all observed call sites with their argument types. Compare with `lsp_hover` for the contract.

4. **Before refactoring a long file**: `codegraph_extract_candidates(file)` to identify which functions to extract first.

5. **Before committing**: `codegraph_changes_since()` to see structural diff vs last commit. Catch unexpected changes early.

6. **In pre-commit hook**: pipe `git diff --name-only` through CLI `codegraph affected --tests-only` to run only relevant tests.

## How it works

The server reads the latest `.codegraph/snapshot-*.json` from `<cwd>/.codegraph/`, **sorted by mtime descending** (so `snapshot-live.json` from the watcher wins over older post-commit snapshots). Snapshot is mtime-cached in RAM — no re-parse on each tool call, refresh only when snapshot file changes.

100% local. No network. No telemetry. ~600 LOC total.

## Architecture

```
┌────────────────────────────────┐
│  Claude Code (host)            │
└─────┬──────────┬───────────────┘
      │ stdio    │ stdio
      ▼          ▼
   MCP "lsp"  MCP "codegraph"
   semantic   architectural
   ─────────  ──────────────
   • hover    • context, who_imports, truth_point_for
   • find_refs• who_calls (typed call sites)
   • rename   • affected (BFS reverse)
   ...        • changes_since (structural diff)
              • co_changed (temporal)
              • extract_candidates (refactor scoring)
              • recent, uncovered (git + coverage)
```

LSP and codegraph-mcp are complementary, not redundant. LSP zooms on symbols, codegraph-mcp zooms on file-level architecture + temporal patterns + structural change tracking. Use both.

## License

MIT.
