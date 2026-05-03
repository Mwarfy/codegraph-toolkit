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

    await this.scanBackendRoutes(ctx, routes)
    await this.scanFrontendApiCalls(ctx, apiCalls)
    this.matchRoutesToApiCalls(apiCalls, routes, links)
    this.linkHandlerMountsToRouteFiles(routes, ctx, links)

    return this.deduplicateLinks(links)
  }

  /** Scan backend api/server files pour les 3 patterns route declaration. */
  private async scanBackendRoutes(
    ctx: DetectorContext,
    routes: RouteDeclaration[],
  ): Promise<void> {
    const apiFiles = ctx.files.filter((f) =>
      f.endsWith('.ts') && (f.includes('api/') || f.includes('server')),
    )
    const fileContents = await Promise.all(
      apiFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )
    for (const { file, content } of fileContents) {
      this.scanFileForRoutes(file, content, routes)
    }
  }

  private scanFileForRoutes(
    file: string,
    content: string,
    routes: RouteDeclaration[],
  ): void {
    // Local regexes pour éviter race lastIndex partagé entre fichiers.
    const regexRouteRe = /path\.match\(\/\^(\\\/api\\\/[^/]+(?:\\\/[^)]*)?)\$\/\)/g
    const exactRouteRe = /path\s*===\s*['"](\/(api|health)[^'"]*)['"]/g
    const handlerMountRe = /await\s+(handle\w+Routes)\s*\(/g

    let match: RegExpExecArray | null
    while ((match = regexRouteRe.exec(content)) !== null) {
      routes.push({
        file,
        path: this.normalizeRegexRoutePath(match[1]),
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
    while ((match = handlerMountRe.exec(content)) !== null) {
      routes.push({
        file,
        path: match[1],
        line: this.getLineNumber(content, match.index),
        pattern: 'handler-mount',
      })
    }
  }

  private normalizeRegexRoutePath(raw: string): string {
    return raw
      .replace(/\\\//g, '/')
      .replace(/\(\[\^\/\]\+\)/g, ':param')
      .replace(/\[\^\/\]\+/g, ':param')
  }

  /** Scan frontend (.tsx + dirs) pour les 3 patterns API call. */
  private async scanFrontendApiCalls(
    ctx: DetectorContext,
    apiCalls: ApiCall[],
  ): Promise<void> {
    const frontendFiles = ctx.files.filter((file) => isFrontendFile(file))
    const frontendContents = await Promise.all(
      frontendFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )
    for (const { file, content } of frontendContents) {
      this.scanFileForApiCalls(file, content, apiCalls)
    }
  }

  private scanFileForApiCalls(
    file: string,
    content: string,
    apiCalls: ApiCall[],
  ): void {
    // Local regexes pour éviter race lastIndex partagé.
    const apiFetchRe = /apiFetch\s*(?:<[^>]*>)?\s*\(\s*['"`](\/api[^'"`]*)/g
    const templateFetchRe = /apiFetch\s*(?:<[^>]*>)?\s*\(\s*`(\/api[^`]*)`/g
    const directFetchRe = /fetch\(\s*`\$\{API_BASE\}(\/api[^`]*)`/g

    this.collectApiFetchCalls(file, content, apiFetchRe, false, apiCalls)
    this.collectApiFetchCalls(file, content, templateFetchRe, true, apiCalls)
    this.collectApiFetchCalls(file, content, directFetchRe, true, apiCalls)
  }

  /**
   * Si `templateInterpolated`, replace `${...}` par `:param` dans le path et
   * deduce isDynamic depuis la présence de `:param` dans la version normalisée.
   */
  private collectApiFetchCalls(
    file: string,
    content: string,
    re: RegExp,
    templateInterpolated: boolean,
    apiCalls: ApiCall[],
  ): void {
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      const apiPath = templateInterpolated
        ? match[1].replace(/\$\{[^}]+\}/g, ':param')
        : match[1]
      apiCalls.push({
        file,
        path: apiPath,
        line: this.getLineNumber(content, match.index),
        isDynamic: templateInterpolated && apiPath.includes(':param'),
      })
    }
  }

  /** Match each API call to backend routes ; émit "UNRESOLVED_ROUTE" si nope. */
  private matchRoutesToApiCalls(
    apiCalls: ApiCall[],
    routes: RouteDeclaration[],
    links: DetectedLink[],
  ): void {
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
  }

  /** Match handleProjectRoutes → routes/projects.ts. */
  private linkHandlerMountsToRouteFiles(
    routes: RouteDeclaration[],
    ctx: DetectorContext,
    links: DetectedLink[],
  ): void {
    const handlerMounts = routes.filter((r) => r.pattern === 'handler-mount')
    for (const mount of handlerMounts) {
      const routeName = mount.path
        .replace('handle', '')
        .replace('Routes', '')
        .toLowerCase()
      const matchingFile = ctx.files.find((f) =>
        f.includes('routes/') && f.includes(routeName),
      )
      if (!matchingFile) continue
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

/**
 * Heuristique frontend : .tsx OU dans un dir typiquement frontend
 * (app/, hooks/, components/, frontend/). Évite de scanner inutilement tous
 * les fichiers backend.
 */
function isFrontendFile(file: string): boolean {
  const isFrontendDir = /(?:^|\/)(?:app|hooks|components|frontend|src\/app|src\/components|src\/hooks)\//.test(file)
  const isTsx = file.endsWith('.tsx')
  if (!isTsx && !isFrontendDir) return false
  return file.endsWith('.ts') || file.endsWith('.tsx')
}
