#!/usr/bin/env node
/**
 * @liby-tools/codegraph-mcp — MCP server exposing codegraph snapshot queries.
 *
 * 5 outils architecturaux complémentaires de LSP MCP :
 *   - codegraph_context        : bloc de contexte d'un fichier (push hook → pull on-demand)
 *   - codegraph_who_imports    : qui importe ce fichier (file-level, pas symbol-level)
 *   - codegraph_truth_point_for: participation aux truth-points (SSOT participation)
 *   - codegraph_recent         : git archaeology (commits, top author, age)
 *   - codegraph_uncovered      : fichiers sans test, rankés par criticité
 *
 * LSP fait du sémantique fin-grained (symbols, types, refs).
 * codegraph-mcp fait du structurel coarse-grained (fichiers, ADRs, SSOT, dette).
 * Complémentaires, jamais redondants.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { codegraphContext } from './tools/context.js'
import { codegraphWhoImports } from './tools/importers.js'
import { codegraphTruthPointFor } from './tools/truth-point.js'
import { codegraphRecent } from './tools/recent.js'
import { codegraphUncovered } from './tools/uncovered.js'
import { codegraphCoChanged } from './tools/co-changed.js'
import { codegraphWhoCalls } from './tools/who-calls.js'
import { codegraphExtractCandidates } from './tools/extract-candidates.js'
import { codegraphAffected } from './tools/affected.js'
import { codegraphChangesSince } from './tools/changes-since.js'
import { codegraphDatalogQuery } from './tools/datalog-query.js'

const server = new Server(
  {
    name: 'codegraph-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

const TOOLS = [
  {
    name: 'codegraph_context',
    description:
      'Get the architectural context of a file from the codegraph snapshot: ' +
      'in/out degree, top importers, exports problématiques, cycles, truth-points, ' +
      'long functions, magic numbers, test coverage. Same info the PostToolUse hook ' +
      'pushes after Edit, but on-demand. Use BEFORE editing a file to understand ' +
      'its blast radius — especially if you suspect it\'s a hub or truth-point writer.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative-to-repo path of the file.' },
        repo_root: { type: 'string', description: 'Repo root (default: server cwd).' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'codegraph_who_imports',
    description:
      'List every file that imports the given file (FILE-level dependents). ' +
      'Different from lsp_find_references which tracks SYMBOL-level usage. ' +
      'Use this for impact analysis at the module boundary: ' +
      'if I delete this file, what breaks?',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path of the imported file.' },
        repo_root: { type: 'string' },
        include_indirect: {
          type: 'boolean',
          description: 'Include event/queue/db-table edges in addition to imports? Default false.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'codegraph_truth_point_for',
    description:
      'Detail the file\'s participation in truth-points (canonical concepts ' +
      'with their writers/readers/mirrors). Use BEFORE modifying a file that ' +
      'reads/writes business state to understand which schema-of-truth concepts ' +
      'you\'re touching. Critical for changes to anything DB/SSOT-related.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        repo_root: { type: 'string' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'codegraph_recent',
    description:
      'Git archaeology for a file: commits in last N weeks, top contributor, ' +
      'file age. Use to understand temporal context — was this file recently ' +
      'touched by an incident fix? A refactor? Or is it stable for years?',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        repo_root: { type: 'string' },
        weeks: { type: 'number', description: 'Default 4 weeks.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'codegraph_uncovered',
    description:
      'List source files without test coverage, ranked by criticality ' +
      '(hubs and truth-point writers first). Use to identify the most ' +
      'pressing test gaps — files that lack tests AND have high blast radius.',
    inputSchema: {
      type: 'object',
      properties: {
        repo_root: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 30).' },
        critical_only: {
          type: 'boolean',
          description: 'Only show high-criticality (hub OR truth-point writer). Default false.',
        },
      },
    },
  },
  {
    name: 'codegraph_co_changed',
    description:
      'List files frequently co-modified with the given file (last 90 days, ' +
      'minCount=3 by default). Source: git log + jaccard coefficient. Use to ' +
      'detect operational coupling not codified in imports — "when I touch X, ' +
      'I also tend to touch Y". Strong signal for truth-point readers/writers ' +
      'or feature components that span multiple files.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path of the file (absolute or relative-to-repo).' },
        repo_root: { type: 'string' },
        limit: { type: 'number', description: 'Top-N pairs returned (default 10).' },
        min_jaccard: {
          type: 'number',
          description: 'Filter pairs below this jaccard (default 0, no filter).',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'codegraph_who_calls',
    description:
      'List the call sites of a symbol with their observed argument types and ' +
      'return type at the call site (source: typedCalls.callEdges). ' +
      'Complementary to lsp_find_references which gives compile-time syntax-level ' +
      'usage — here you see the *actual types* passed at each call. Useful when ' +
      'auditing a function\'s contract-of-fact vs declared signature, or when ' +
      'planning to change a signature and you need to see what types pass through.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Symbol id. Either "file/path.ts:symbolName" (exact match) or just "symbolName" (matches all *:symbolName).',
        },
        repo_root: { type: 'string' },
        limit: { type: 'number', description: 'Top-N call sites (default 20).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_extract_candidates',
    description:
      'Score the long functions in a file by extract-method candidate strength: ' +
      'score = loc × (1 + fanIn/5). Favors long AND called-often functions ' +
      '(high cognitive load × high blast radius). Useful before refactoring a ' +
      'large file — points at which functions warrant extraction first.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        repo_root: { type: 'string' },
        limit: { type: 'number', description: 'Top-N candidates (default 5).' },
        min_loc: { type: 'number', description: 'Minimum LOC to be considered (default 50).' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'codegraph_affected',
    description:
      'BFS reverse from a list of files to find ALL files transitively impacted ' +
      'by their modification. Separates affected tests for selective test running. ' +
      'Use to answer "what should I re-test after changing these files?" or ' +
      '"what is the blast radius of my current edits?". Pre-commit selector: ' +
      '`git diff --name-only` → affected → tests subset → `vitest run <list>`.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of modified files (absolute or relative-to-repo paths).',
        },
        repo_root: { type: 'string' },
        include_indirect: {
          type: 'boolean',
          description: 'Include event/queue/db-table edges in addition to imports? Default false.',
        },
        max_depth: {
          type: 'number',
          description: 'Max BFS depth (default Infinity). Set 1 for direct importers only.',
        },
        separate_tests: {
          type: 'boolean',
          description: 'Return affected tests separately? Default true.',
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'codegraph_changes_since',
    description:
      'Structural diff between the current snapshot (live if `codegraph watch` ' +
      'is running, otherwise latest post-commit) and a reference. Default ' +
      'reference = latest post-commit snapshot. Answers "since the last ' +
      'commit, what did my uncommitted edits change structurally?". Returns ' +
      'cycles added/removed, FSMs changed, truth-points modified, dataFlows, ' +
      'typed-call signatures. Useful before committing to review the impact.',
    inputSchema: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          description: 'Optional. "post-commit" (default) | "live" | absolute path to a snapshot JSON.',
        },
        repo_root: { type: 'string' },
      },
    },
  },
  {
    name: 'codegraph_datalog_query',
    description:
      'Execute an ad hoc Datalog rule against the emitted facts ' +
      '(.codegraph/facts/). Use for structural questions that don\'t warrant ' +
      'a custom detector or invariant: transitive imports, anti-joins, ' +
      'aggregation, FileTag filters. The schema (`ImportEdge`, `EmitsLiteral`, ' +
      '`SqlForeignKey`, `CycleNode`, …) is auto-included — no need to redeclare. ' +
      'You declare your own `.decl` + rules; the tool auto-marks the last ' +
      '`.decl` as `.output` (or use output_relation to pick explicitly). ' +
      'Example rule: ' +
      '`.decl R(f:symbol)\\nR(F) :- ImportEdge(F, "path/to/file.ts", _).`',
    inputSchema: {
      type: 'object',
      properties: {
        rule_text: {
          type: 'string',
          description:
            'Datalog rule text. Must contain at least one `.decl` and one rule. ' +
            'Schema relations are pre-included, do not redeclare them.',
        },
        output_relation: {
          type: 'string',
          description:
            'Name of the relation to observe in output. Default: last `.decl` of rule_text.',
        },
        repo_root: { type: 'string' },
        limit: {
          type: 'number',
          description: 'Cap on tuples returned (default 200).',
        },
      },
      required: ['rule_text'],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    let result: { content: string }
    switch (name) {
      case 'codegraph_context':
        result = codegraphContext(args as any)
        break
      case 'codegraph_who_imports':
        result = codegraphWhoImports(args as any)
        break
      case 'codegraph_truth_point_for':
        result = codegraphTruthPointFor(args as any)
        break
      case 'codegraph_recent':
        result = codegraphRecent(args as any)
        break
      case 'codegraph_uncovered':
        result = codegraphUncovered(args as any)
        break
      case 'codegraph_co_changed':
        result = codegraphCoChanged(args as any)
        break
      case 'codegraph_who_calls':
        result = codegraphWhoCalls(args as any)
        break
      case 'codegraph_extract_candidates':
        result = codegraphExtractCandidates(args as any)
        break
      case 'codegraph_affected':
        result = codegraphAffected(args as any)
        break
      case 'codegraph_changes_since':
        result = codegraphChangesSince(args as any)
        break
      case 'codegraph_datalog_query':
        result = codegraphDatalogQuery(args as any)
        break
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }

    return {
      content: [{ type: 'text', text: result.content }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[codegraph-mcp] Server running on stdio')
}

main().catch((err) => {
  console.error('[codegraph-mcp] Fatal error:', err)
  process.exit(1)
})
