/**
 * Express framework adapter — discover routes via reflection sur
 * `app._router.stack`. Permet au driver synthetic de générer du trafic
 * sur les routes RÉELLEMENT registered dans Express, sans dépendre
 * du codegraph statique EntryPoint (qui marche mais demande analyze).
 *
 * Pourquoi adapter ? Express n'expose pas une API publique pour lister
 * routes — il faut walker `app._router.stack` (private internal). Cette
 * walker est encapsulée ici pour être réutilisable.
 *
 * Compatible Express 4.x et 5.x. Express 5 utilise `app.router` au lieu
 * de `app._router` — l'adapter check les deux.
 */

export interface ExpressLikeApp {
  _router?: ExpressRouter
  router?: ExpressRouter                                                // Express 5
}

interface ExpressRouter {
  stack: ExpressLayer[]
}

interface ExpressLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
  }
  name?: string
  regexp?: RegExp
  handle?: ExpressRouter | ((...args: unknown[]) => unknown)
}

export interface DiscoveredRoute {
  method: string
  path: string
}

/**
 * Walk `app._router.stack` recursively pour extraire toutes les routes.
 * Gère les sub-routers montés via `app.use('/api', subRouter)`.
 *
 * Retourne une liste dédupliquée de (method, path) — order is stable
 * pour reproductibilité (sorted by path puis method).
 */
export function discoverExpressRoutes(app: ExpressLikeApp): DiscoveredRoute[] {
  const router = app._router ?? app.router
  if (!router || !Array.isArray(router.stack)) return []

  const routes: DiscoveredRoute[] = []
  walkStack(router.stack, '', routes)

  // Dédupliquer
  const seen = new Set<string>()
  const unique: DiscoveredRoute[] = []
  for (const r of routes) {
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(r)
  }

  unique.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  return unique
}

function walkStack(stack: ExpressLayer[], prefix: string, out: DiscoveredRoute[]): void {
  for (const layer of stack) {
    if (layer.route) {
      // Direct route declaration : `app.get('/foo', ...)`
      const fullPath = combinePaths(prefix, layer.route.path)
      for (const method of Object.keys(layer.route.methods)) {
        if (layer.route.methods[method]) {
          out.push({ method: method.toUpperCase(), path: fullPath })
        }
      }
    } else if (layer.name === 'router' && layer.handle && typeof layer.handle === 'object') {
      // Sub-router : `app.use('/api', subRouter)` — descend avec prefix
      const sub = layer.handle as ExpressRouter
      const subPrefix = combinePaths(prefix, extractPrefixFromRegexp(layer.regexp))
      if (Array.isArray(sub.stack)) {
        walkStack(sub.stack, subPrefix, out)
      }
    }
  }
}

function combinePaths(a: string, b: string): string {
  if (!a) return b || '/'
  if (!b || b === '/') return a
  return (a.replace(/\/$/, '') + (b.startsWith('/') ? b : '/' + b))
}

/**
 * Extract le prefix d'un sub-router depuis sa regexp.
 * Express encode `/api` → `/^\/api\/?(?=\/|$)/i`. Best-effort regex extraction.
 * Si on ne peut pas parser, retourne '' (sub-router monté à la racine).
 */
function extractPrefixFromRegexp(re?: RegExp): string {
  if (!re) return ''
  const src = re.source
  // Pattern typique : /^\\/api\\/?(?=\\/|$)/i  → captured = 'api'
  const m = src.match(/^\^\\\/([^\\/]+)\\\//) ?? src.match(/^\^\\\/([^\\/]+)/)
  if (!m) return ''
  return '/' + m[1]
}
