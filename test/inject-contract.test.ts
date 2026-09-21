import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The 1.5.0 release blocked EVERY route with 503 on a real restart, so the panel
// reported "no running agent" and no switch was visible. Root cause: the plugin
// read `ctx.get('connection')` from `apply()`, but `connection` was missing from
// the plugin's `inject` list, so the service was not yet resolved at apply time —
// `resolveAuth` then failed closed on all five routes. `dsh-api-gateway` and
// `dsh-host-open-in-app` both declare it in `inject` and read it as a plain
// property; the framework guarantees injected services are ready before apply.
const src = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

test('the plugin injects the connection service it authenticates routes with', () => {
  const index = src('index.ts')
  const inject = index.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(inject, 'the plugin must declare its inject list')
  const names = (inject[1].match(/'([^']+)'/g) ?? []).map(s => s.replaceAll("'", ''))
  assert.ok(names.includes('connection'),
    `connection must be injected so the framework resolves it before apply; saw [${names.join(', ')}]`)
})

test('the auth seam reads the injected service, not a module-level lookup at import time', () => {
  const http = src('host/http.ts')
  // The service must be reachable from the ctx handed to installHttp; a stale
  // import-time capture would read undefined and fail every route closed.
  assert.match(http, /ctx\.get\('connection'\)|Reflect\.get\(ctx, ['"]connection['"]\)/,
    'the seam must be resolved from the live context')
})

test('the auth seam resolves the service per request, so a late service recovers', async () => {
  // The one-shot capture was the actual outage: installHttp ran before the
  // service was resolvable and permanently bound a 503 answer. Resolving per
  // request means the routes recover as soon as the service appears.
  const { resolveAuthForTest } = await import('../src/host/http.ts')
  let available = false
  const ctx = {
    get: (name: string) => name !== 'connection' || !available ? undefined : {
      requestRejection: () => undefined,
    },
  }
  const auth = resolveAuthForTest(ctx as never)
  const req = { headers: { host: '127.0.0.1:3080' } } as never
  assert.equal(auth(req), 503, 'an absent service still fails the request closed')
  available = true
  assert.equal(auth(req), undefined, 'the same route must recover once the service exists')
})
