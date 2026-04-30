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
