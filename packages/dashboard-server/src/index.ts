#!/usr/bin/env node
import * as path from 'node:path'
import * as fs from 'node:fs'
import { startServer } from './server.js'

interface CliArgs {
  rootDir: string
  port: number
  host: string
  webStaticDir: string | null
}

type FlagHandler = (args: CliArgs, value: string) => void

const FLAG_HANDLERS: Record<string, FlagHandler> = {
  '--root': (a, v) => (a.rootDir = path.resolve(v)),
  '-r': (a, v) => (a.rootDir = path.resolve(v)),
  '--port': (a, v) => (a.port = parseInt(v, 10)),
  '-p': (a, v) => (a.port = parseInt(v, 10)),
  '--host': (a, v) => (a.host = v),
  '--web-static': (a, v) => (a.webStaticDir = path.resolve(v)),
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    rootDir: process.cwd(),
    port: 4242,
    host: '127.0.0.1',
    webStaticDir: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    }
    const handler = FLAG_HANDLERS[a]
    const next = argv[i + 1]
    if (handler && next !== undefined) {
      handler(args, next)
      i++
    }
  }
  return args
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`codegraph-dashboard — live cockpit for codegraph-toolkit

usage: codegraph-dashboard [options]

options:
  --root, -r <dir>     Project root containing .codegraph/ (default: cwd)
  --port, -p <n>       Port to bind (default: 4242)
  --host <host>        Host to bind (default: 127.0.0.1)
  --web-static <dir>   Serve a built dashboard-web at /  (optional)
  --help, -h           Show this help
`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const codegraphDir = path.join(args.rootDir, '.codegraph')
  if (!fs.existsSync(codegraphDir)) {
    // eslint-disable-next-line no-console
    console.error(`[dashboard-server] no .codegraph/ found at ${codegraphDir}`)
    // eslint-disable-next-line no-console
    console.error('  Run \`npx @liby-tools/codegraph analyze\` first to produce a snapshot.')
    process.exit(1)
  }

  // Auto-discover the bundled web/ if not explicitly provided.
  if (!args.webStaticDir) {
    const here = path.dirname(new URL(import.meta.url).pathname)
    const candidate = path.resolve(here, '../../dashboard-web/dist')
    if (fs.existsSync(candidate)) {
      args.webStaticDir = candidate
    }
  }

  const handle = await startServer(args)

  const shutdown = async (): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log('[dashboard-server] shutting down')
    await handle.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[dashboard-server] fatal:', err)
  process.exit(1)
})
