import * as path from 'node:path'
import Fastify from 'fastify'
import websocketPlugin from '@fastify/websocket'
import staticPlugin from '@fastify/static'
import { createState, loadSnapshot } from './state.js'
import { WsHub } from './ws-hub.js'
import { startWatcher } from './watch/file-watcher.js'
import { registerSnapshotRoutes } from './routes/snapshot.js'
import { registerTensionRoutes } from './routes/tensions.js'
import { registerTelemetryRoutes } from './routes/telemetry.js'
import { registerRuntimeRoutes } from './routes/runtime.js'
import { registerCommitRoutes } from './routes/commits.js'
import { registerDiffRoutes } from './routes/diff.js'
import { registerNodeRoutes } from './routes/node.js'

export interface ServerOptions {
  rootDir: string
  port: number
  host: string
  webStaticDir: string | null
}

export async function startServer(opts: ServerOptions): Promise<{ stop: () => Promise<void> }> {
  const state = createState(opts.rootDir)
  await loadSnapshot(state)

  const app = Fastify({ logger: { level: 'warn' } })
  const hub = new WsHub()

  await app.register(websocketPlugin)

  app.get('/api/status', async () => ({
    ok: true,
    rootDir: state.rootDir,
    snapshotLoaded: state.snapshotData !== null,
    snapshotPath: state.snapshotPath,
    wsClients: hub.size(),
  }))

  await registerSnapshotRoutes(app, state)
  await registerTensionRoutes(app, state)
  await registerTelemetryRoutes(app, state)
  await registerRuntimeRoutes(app, state)
  await registerCommitRoutes(app, state)
  await registerDiffRoutes(app, state)
  await registerNodeRoutes(app, state)

  app.register(async (instance) => {
    instance.get('/ws', { websocket: true }, (socket) => {
      hub.add(socket)
    })
  })

  if (opts.webStaticDir) {
    await app.register(staticPlugin, {
      root: opts.webStaticDir,
      prefix: '/',
    })
  }

  const stopWatcher = startWatcher(state, hub)

  await app.listen({ port: opts.port, host: opts.host })
  // eslint-disable-next-line no-console
  console.log(
    `[dashboard-server] listening on http://${opts.host}:${opts.port}  · root=${path.relative(process.cwd(), opts.rootDir) || '.'}`,
  )

  return {
    stop: async () => {
      stopWatcher()
      await app.close()
    },
  }
}
