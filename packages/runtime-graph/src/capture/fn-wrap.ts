/**
 * Function wrapping via import-in-the-middle — capture exacte des
 * function-to-function calls (option C, complément de cpu-profile.ts).
 *
 * Pourquoi : le CPU profiler (cpu-profile.ts) sample la stack toutes les
 * 1ms — précision approximative, manque les fns < 1ms. Pour avoir un
 * call graph runtime EXACT (count exact, edges exacts caller→callee),
 * il faut intercepter chaque appel.
 *
 * Implementation : iitm `Hook` reçoit le namespace exporté de chaque
 * module loaded via ESM `import`. On wrap les exports qui sont des
 * fonctions avec un wrapper qui crée un span OTel à chaque appel. Les
 * spans sont collectés par OTel + projetés en SymbolTouchedRuntime +
 * CallEdgeRuntime via le span-aggregator existant. Pipeline unifié.
 *
 * Trade-offs (vs cpu-profile.ts) :
 *   ✓ 100% des fonctions exportées appelées au moins 1 fois
 *   ✓ Count exact (chaque appel = 1 span)
 *   ✓ Edges précis : OTel context propagation parent→child gratuite
 *   ✓ Pipeline unifié (mêmes facts que les spans HTTP/DB)
 *   ✗ Overhead ~30-50% (chaque call = span + setAttribute)
 *   ✗ Wrap seulement les exports (pas les fns internes)
 *   ✗ Wrap seulement les modules in-projet (filtre par pattern)
 *
 * Usage : opt-in via env var LIBY_RUNTIME_FN_WRAP=1 dans auto-bootstrap.
 * Cohabite avec OTel auto-instruments (HTTP/DB) et CPU profile.
 *
 * Limites iitm connues (cf. README iitm) :
 *   - Pas de require() (CJS uniquement via require-in-the-middle séparé)
 *   - Pas d'ajout de nouveaux exports — modification only
 *   - Modules dynamiques (`await import('foo')`) altérés au load time
 *     uniquement
 */

import { Hook } from 'import-in-the-middle'
import { trace, type Tracer } from '@opentelemetry/api'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import * as fs from 'node:fs'

export interface FnWrapOptions {
  /** Path racine du projet observé. Modules hors de ce path sont skip. */
  projectRoot: string
  /**
   * Patterns à exclure (relatifs au projectRoot). Default skip
   * node_modules, dist, .codegraph, build, coverage, tests/fixtures.
   */
  excludePatterns?: RegExp[]
  /** Tracer OTel à utiliser. Default : `trace.getTracer('runtime-graph-fn-wrap')` */
  tracer?: Tracer
}

const DEFAULT_EXCLUDE = [
  /\/node_modules\//,
  /\/dist\//,
  /\/build\//,
  /\/coverage\//,
  /\/\.codegraph\//,
  /\/\.git\//,
  /\/tests\/fixtures\//,
]

/**
 * Active le wrapping iitm. Idempotent — appel multiple = no-op (le 2e
 * Hook n'a pas d'effet sur les modules déjà loaded). Retourne false si
 * iitm n'est pas dispo (env CI restrictif), true sinon.
 *
 * IMPORTANT : doit être appelé AVANT que les modules cibles ne soient
 * importés. Côté auto-bootstrap, on appelle ça pendant la phase de
 * register loader hook → tous les imports utilisateurs subséquents
 * passent par iitm.
 */
export function attachFnWrap(opts: FnWrapOptions): boolean {
  let projectRoot: string
  try {
    projectRoot = fs.realpathSync(opts.projectRoot)
  } catch {
    projectRoot = path.resolve(opts.projectRoot)
  }
  const exclude = opts.excludePatterns ?? DEFAULT_EXCLUDE
  const tracer = opts.tracer ?? trace.getTracer('runtime-graph-fn-wrap')

  // Hook receives every module load post-register. We filter in the callback
  // (filtre Hook(['*']) couvrirait tout — on prend tout puis on filtre par
  // path car iitm ne supporte que les noms de packages dans le 1er argument,
  // pas les regex). Pattern : on intercepte l'URL du module et on regarde
  // son chemin réel.
  try {
    new Hook((exported: Record<string, unknown>, name: string) => {
      const fileRel = resolveModuleToProjectRel(name, projectRoot)
      if (!fileRel) return
      if (exclude.some((re) => re.test(name))) return

      // Iter les exports nommés. Ne wrap que les fonctions top-level pour
      // limiter la casse. Skip default exports anonymes, classes, getters.
      for (const key of Object.keys(exported)) {
        const value = exported[key]
        if (typeof value !== 'function') continue
        if (key === 'default') continue  // souvent re-export ou class — risque
        if (key.startsWith('_')) continue  // convention private

        const original = value as (...a: unknown[]) => unknown
        const wrapped = function (this: unknown, ...args: unknown[]): unknown {
          return tracer.startActiveSpan(`${fileRel}:${key}`, (span) => {
            // Attributs lus par span-aggregator → SymbolTouched + CallEdge.
            span.setAttribute('code.filepath', fileRel)
            span.setAttribute('code.function', key)
            try {
              const result = original.apply(this, args)
              // Si async, attendre la résolution avant span.end pour couvrir
              // l'async work (sinon span dure 0ms et CallEdge n'est pas
              // capté correctement).
              if (result && typeof (result as Promise<unknown>).then === 'function') {
                return (result as Promise<unknown>).finally(() => span.end())
              }
              span.end()
              return result
            } catch (err) {
              span.recordException(err as Error)
              span.end()
              throw err
            }
          })
        }
        // Conserver le name pour stack traces / debug.
        Object.defineProperty(wrapped, 'name', { value: key, configurable: true })
        try {
          exported[key] = wrapped
        } catch {
          // Some namespaces are read-only — skip silently.
        }
      }
    })
    return true
  } catch {
    return false
  }
}

/**
 * Convertit le `name` reçu de iitm (URL absolue) en path relatif au
 * projectRoot. Retourne null si hors-projet.
 */
function resolveModuleToProjectRel(name: string, projectRoot: string): string | null {
  let abs: string
  if (name.startsWith('file://')) {
    try {
      abs = fileURLToPath(name)
    } catch {
      return null
    }
  } else if (path.isAbsolute(name)) {
    abs = name
  } else {
    return null  // bare specifier — pkg dependency, skip
  }

  // Realpath pour gérer symlinks (npm link, /tmp → /private/tmp macOS).
  try {
    abs = fs.realpathSync(abs)
  } catch {
    // file may not exist (compiled-on-fly) — fallback sur le path tel quel
  }

  const rel = path.relative(projectRoot, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.replace(/\\/g, '/')
}
