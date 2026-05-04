/**
 * Demo app — minimal HTTP server + self-request, ESM only.
 *
 * Runtime ground-truth pour @liby-tools/runtime-graph :
 *   - 3 routes (GET /healthz, GET /users, GET /products)
 *   - 1 self-request par route (HTTP client + server spans)
 *   - exit après ~500ms → bootstrap flush sur exit
 *
 * Ce script est volontairement minimal : pas de DB, pas de framework.
 * Si le bootstrap OTel attache correctement le hook ESM, on doit voir :
 *   - HttpRouteHit : 3 lignes (1 par route)
 *   - SymbolTouchedRuntime / CallEdgeRuntime : selon attribution file:fn
 *
 * Si 0 facts → bootstrap n'a pas patché l'import ESM de `node:http`.
 */

import http from 'node:http'

const PORT = process.env.DEMO_PORT ? parseInt(process.env.DEMO_PORT, 10) : 0

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'
  res.setHeader('content-type', 'application/json')
  if (url.startsWith('/healthz')) {
    res.statusCode = 200
    res.end(JSON.stringify({ ok: true }))
  } else if (url.startsWith('/users')) {
    res.statusCode = 200
    res.end(JSON.stringify({ users: [{ id: 1, name: 'alice' }] }))
  } else if (url.startsWith('/products')) {
    res.statusCode = 200
    res.end(JSON.stringify({ products: [{ id: 'A', price: 10 }] }))
  } else {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  }
})

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
const addr = server.address()
const port = typeof addr === 'object' && addr ? addr.port : PORT
const base = `http://127.0.0.1:${port}`

console.log(`[demo] listening on ${base}`)

async function hit(path) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }))
      res.on('error', reject)
    })
  })
}

// Exerce 3 routes — chaque hit = 1 server span + 1 client span
for (const route of ['/healthz', '/users', '/products']) {
  const r = await hit(route)
  console.log(`[demo] ${route} → ${r.status}`)
}

await new Promise((r) => setTimeout(r, 100))
server.close()
console.log('[demo] done — facts will flush on exit')
