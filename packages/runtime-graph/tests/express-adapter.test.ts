/**
 * Express adapter tests — utilise un fake `app._router.stack` pour
 * éviter d'installer Express comme dev dep. Le format `_router.stack`
 * est stable depuis Express 4.0.
 */

import { describe, it, expect } from 'vitest'
import {
  discoverExpressRoutes,
  type ExpressLikeApp,
} from '../src/adapters/frameworks/express.js'

function fakeApp(stack: unknown[]): ExpressLikeApp {
  return { _router: { stack: stack as never } }
}

describe('discoverExpressRoutes', () => {
  it('returns [] when app has no router', () => {
    expect(discoverExpressRoutes({} as ExpressLikeApp)).toEqual([])
  })

  it('extracts direct route declarations', () => {
    const app = fakeApp([
      { route: { path: '/users', methods: { get: true, post: true } } },
      { route: { path: '/orders/:id', methods: { delete: true } } },
    ])
    const routes = discoverExpressRoutes(app)
    expect(routes).toEqual([
      { method: 'DELETE', path: '/orders/:id' },
      { method: 'GET', path: '/users' },
      { method: 'POST', path: '/users' },
    ])
  })

  it('walks into sub-routers with their prefix', () => {
    const subRouter = {
      stack: [
        { route: { path: '/list', methods: { get: true } } },
        { route: { path: '/:id', methods: { get: true } } },
      ],
    }
    const app = fakeApp([
      {
        name: 'router',
        regexp: /^\/api\/?(?=\/|$)/i,
        handle: subRouter,
      },
    ])
    const routes = discoverExpressRoutes(app)
    expect(routes.find(r => r.path === '/api/list')).toBeDefined()
    expect(routes.find(r => r.path === '/api/:id')).toBeDefined()
  })

  it('deduplicates same (method, path) declared twice', () => {
    const app = fakeApp([
      { route: { path: '/health', methods: { get: true } } },
      { route: { path: '/health', methods: { get: true } } },
    ])
    expect(discoverExpressRoutes(app)).toEqual([
      { method: 'GET', path: '/health' },
    ])
  })

  it('output is sorted (path, method) for determinism', () => {
    const app = fakeApp([
      { route: { path: '/zeta', methods: { get: true } } },
      { route: { path: '/alpha', methods: { post: true } } },
      { route: { path: '/alpha', methods: { get: true } } },
    ])
    const routes = discoverExpressRoutes(app)
    expect(routes.map(r => r.path)).toEqual(['/alpha', '/alpha', '/zeta'])
    // For same path, sorted by method alphabetically
    expect(routes[0].method).toBe('GET')
    expect(routes[1].method).toBe('POST')
  })

  it('supports Express 5 (.router instead of ._router)', () => {
    const app: ExpressLikeApp = {
      router: {
        stack: [
          { route: { path: '/v5', methods: { get: true } } } as never,
        ],
      },
    }
    expect(discoverExpressRoutes(app)).toEqual([
      { method: 'GET', path: '/v5' },
    ])
  })
})
