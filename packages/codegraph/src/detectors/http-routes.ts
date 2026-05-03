/**
 * HTTP Route Detector
 *
 * Discovers connections between backend route handlers and frontend API calls.
 *
 * Backend patterns (raw http via path matching) :
 *   path.match(/^\/api\/projects\/([^/]+)$/)
 *   if (path === '/api/projects' && method === 'GET')
 *
 * Frontend patterns :
 *   apiFetch('/api/resources')
 *   apiFetch(`/api/projects/${id}`)
 *   fetch(`${API_BASE}/api/...`)
 *
 * Note : les patterns frontend ciblent `apiFetch()` (convention) et
 * `fetch(\`${API_BASE}/...\`)`. Si ton projet utilise des patterns différents
 * (axios, native fetch direct), ce détecteur ne matchera rien — fail silencieux.
 */

import type { Detector, DetectorContext, DetectedLink } from '../core/types.js'

interface RouteDeclaration {
  file: string
  path: string
  method?: string
  line: number
  pattern: 'regex' | 'exact' | 'handler-mount'
}

interface ApiCall {
  file: string
  path: string
  line: number
  isDynamic: boolean
}

export class HttpRouteDetector implements Detector {
  name = 'http-routes'
  edgeType = 'route' as const
  description = 'HTTP route declarations ↔ frontend API fetch calls'

  async detect(ctx: DetectorContext): Promise<DetectedLink[]> {
    const routes: RouteDeclaration[] = []
    const apiCalls: ApiCall[] = []
    const links: DetectedLink[] = []

    // ─── Scan backend route files ──────────────────────────────────

    // Regex route patterns: path.match(/^\/api\/.../)
    const regexRoutePattern = /path\.match\(\/\^(\\\/api\\\/[^/]+(?:\\\/[^)]*)?)\$\/\)/g

    // Exact route patterns: path === '/api/...'
    const exactRoutePattern = /path\s*===\s*['"](\/(api|health)[^'"]*)['"]/g

    // Handler mount patterns: handleXxxRoutes
    const handlerMountPattern = /await\s+(handle\w+Routes)\s*\(/g

    // Lit en parallèle les .ts api/server files (I/O fs indépendantes).
    const apiFiles = ctx.files.filter((f) =>
      f.endsWith('.ts') && (f.includes('api/') || f.includes('server')),
    )
    const fileContents = await Promise.all(
      apiFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )
    for (const { file, content } of fileContents) {
      let match: RegExpExecArray | null

      // Local regexes pour éviter race lastIndex partagé entre fichiers.
      const regexRouteRe = new RegExp(regexRoutePattern.source, regexRoutePattern.flags)
      const exactRouteRe = new RegExp(exactRoutePattern.source, exactRoutePattern.flags)
      const handlerMountRe = new RegExp(handlerMountPattern.source, handlerMountPattern.flags)
      while ((match = regexRouteRe.exec(content)) !== null) {
        const routePath = match[1]
          .replace(/\\\//g, '/')
          .replace(/\(\[\^\/\]\+\)/g, ':param')
          .replace(/\[\^\/\]\+/g, ':param')
        routes.push({
          file,
          path: routePath,
          line: this.getLineNumber(content, match.index),
          pattern: 'regex',
        })
      }

      while ((match = exactRouteRe.exec(content)) !== null) {
        routes.push({
          file,
          path: match[1],
          line: this.getLineNumber(content, match.index),
          pattern: 'exact',
        })
      }

      // Handler mounts in server.ts → link to route files
      while ((match = handlerMountRe.exec(content)) !== null) {
        routes.push({
          file,
          path: match[1],
          line: this.getLineNumber(content, match.index),
          pattern: 'handler-mount',
        })
      }
    }

    // ─── Scan frontend for API calls ───────────────────────────────

    // apiFetch('/api/...')  or  apiFetch(`/api/...`)
    const apiFetchPattern = /apiFetch\s*(?:<[^>]*>)?\s*\(\s*['"`](\/api[^'"`]*)/g

    // Template literal API calls: apiFetch(`/api/projects/${id}`)
    const templateFetchPattern = /apiFetch\s*(?:<[^>]*>)?\s*\(\s*`(\/api[^`]*)`/g

    // Direct fetch with API_BASE
    const directFetchPattern = /fetch\(\s*`\$\{API_BASE\}(\/api[^`]*)`/g

    // Filtre frontend files puis lit en parallèle.
    const frontendFiles = ctx.files.filter((file) => {
      // Heuristique frontend : .tsx OU dans un dir typiquement frontend
      // (app/, hooks/, components/, frontend/). Évite de scanner inutilement
      // tous les fichiers backend.
      const isFrontendDir = /(?:^|\/)(?:app|hooks|components|frontend|src\/app|src\/components|src\/hooks)\//.test(file)
      const isTsx = file.endsWith('.tsx')
      if (!isTsx && !isFrontendDir) return false
      return file.endsWith('.ts') || file.endsWith('.tsx')
    })
    const frontendContents = await Promise.all(
      frontendFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )
    for (const { file, content } of frontendContents) {
      let match: RegExpExecArray | null

      // Local regexes pour éviter race lastIndex partagé.
      const apiFetchRe = new RegExp(apiFetchPattern.source, apiFetchPattern.flags)
      const templateFetchRe = new RegExp(templateFetchPattern.source, templateFetchPattern.flags)
      const directFetchRe = new RegExp(directFetchPattern.source, directFetchPattern.flags)
      void apiFetchPattern; void templateFetchPattern; void directFetchPattern  // markers — used via local copies below

      while ((match = apiFetchRe.exec(content)) !== null) {
        apiCalls.push({
          file,
          path: match[1],
          line: this.getLineNumber(content, match.index),
          isDynamic: false,
        })
      }

      while ((match = templateFetchRe.exec(content)) !== null) {
        const apiPath = match[1].replace(/\$\{[^}]+\}/g, ':param')
        apiCalls.push({
          file,
          path: apiPath,
          line: this.getLineNumber(content, match.index),
          isDynamic: apiPath.includes(':param'),
        })
      }

      while ((match = directFetchRe.exec(content)) !== null) {
        const apiPath = match[1].replace(/\$\{[^}]+\}/g, ':param')
        apiCalls.push({
          file,
          path: apiPath,
          line: this.getLineNumber(content, match.index),
          isDynamic: apiPath.includes(':param'),
        })
      }
    }

    // ─── Match routes to API calls ─────────────────────────────────

    for (const call of apiCalls) {
      const matchingRoutes = this.findMatchingRoutes(call.path, routes)

      if (matchingRoutes.length > 0) {
        for (const route of matchingRoutes) {
          links.push({
            from: call.file,
            to: route.file,
            type: 'route',
            label: call.path,
            resolved: true,
            line: call.line,
            meta: {
              frontendLine: call.line,
              backendLine: route.line,
              routePattern: route.pattern,
              isDynamic: call.isDynamic,
            },
          })
        }
      } else {
        // API call with no matching route — might be an issue
        links.push({
          from: call.file,
          to: 'UNRESOLVED_ROUTE',
          type: 'route',
          label: `unresolved: ${call.path}`,
          resolved: false,
          line: call.line,
          meta: { unresolved: true },
        })
      }
    }

    // ─── Link server.ts handler mounts to route files ──────────────

    const handlerMounts = routes.filter(r => r.pattern === 'handler-mount')
    for (const mount of handlerMounts) {
      // Match handleProjectRoutes → routes/projects.ts
      const routeName = mount.path
        .replace('handle', '')
        .replace('Routes', '')
        .toLowerCase()

      const matchingFile = ctx.files.find(f =>
        f.includes('routes/') && f.includes(routeName)
      )

      if (matchingFile) {
        links.push({
          from: mount.file,
          to: matchingFile,
          type: 'route',
          label: mount.path,
          resolved: true,
          line: mount.line,
          meta: { handlerMount: true },
        })
      }
    }

    return this.deduplicateLinks(links)
  }

  private findMatchingRoutes(apiPath: string, routes: RouteDeclaration[]): RouteDeclaration[] {
    // Normalize the API call path for matching
    const normalizedCall = apiPath
      .replace(/\?.*$/, '')           // Remove query params
      .replace(/:param/g, '[^/]+')    // Convert :param to regex

    return routes.filter(route => {
      if (route.pattern === 'handler-mount') return false

      const normalizedRoute = route.path
        .replace(/:param/g, '[^/]+')

      // Check if paths match (ignoring dynamic segments)
      return this.pathsMatch(normalizedCall, normalizedRoute)
    })
  }

  private pathsMatch(callPath: string, routePath: string): boolean {
    // Direct match
    if (callPath === routePath) return true

    // Both sides might have [^/]+ patterns — compare segment by segment
    const callSegments = callPath.split('/').filter(Boolean)
    const routeSegments = routePath.split('/').filter(Boolean)

    if (callSegments.length !== routeSegments.length) return false

    return callSegments.every((seg, i) => {
      const routeSeg = routeSegments[i]
      if (seg === routeSeg) return true
      if (seg === '[^/]+' || routeSeg === '[^/]+') return true
      if (seg === ':param' || routeSeg === ':param') return true
      return false
    })
  }

  private getLineNumber(content: string, offset: number): number {
    return content.substring(0, offset).split('\n').length
  }

  private deduplicateLinks(links: DetectedLink[]): DetectedLink[] {
    const seen = new Set<string>()
    return links.filter(link => {
      if (link.to === 'UNRESOLVED_ROUTE') return true // keep all unresolved
      const key = `${link.from}--${link.to}--${link.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}
