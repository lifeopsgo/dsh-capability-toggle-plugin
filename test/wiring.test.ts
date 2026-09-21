import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { evaluateGuards, guardId } from '../src/host/guards.ts'
import { ConfirmationCenter, makeGuardConfirmer } from '../src/host/confirm.ts'
import { resolveAuthForTest } from '../src/host/http.ts'

// Wiring tests for the 1.5.0 confirmation channel. The channel's own behaviour is
// covered in confirm.test.ts; what was NOT covered is the GLUE that connects the
// plugin context to the guard listener — four independent breakages of it shipped
// with the whole suite green, including passing `projectKey` as the session (so
// `hasChannel` could never be true and every guarded call fell back to the native
// approval path, which auto-rejects under danger-full-access: precisely the bug
// this release exists to fix).
//
// These read `src/`, not `lib/`, on purpose: a bundle-marker assertion cannot see
// a regression until someone rebuilds, so it would pass on the very commit that
// introduced the break. Behaviour is exercised with real objects below; the
// structural facts that only `src/` can show (which key, which argument) are
// asserted against `src/` for that reason.
const src = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

test('the plugin constructs ONE center and hands the SAME one to registry and routes', () => {
  const index = src('index.ts')
  // A second center would let the browser subscribe to one while the guards ask
  // the other, so every confirmation would silently fall back.
  assert.equal((index.match(/new ConfirmationCenter\(\)/g) ?? []).length, 1,
    'exactly one ConfirmationCenter must be constructed')
  assert.match(index, /new ControllerRegistry\(store, ctx, center, onDrift\)/)
  assert.match(index, /installHttp\(ctx, store, registry, center\)/)
})

test('the plugin registers the center dispose so no blocked call outlives unload', () => {
  assert.match(src('index.ts'), /\(\) => center\.dispose\(\)/,
    'the center dispose must be registered as an effect')
})

test('the controller stores the center and passes it into every binding', () => {
  const controller = src('host/controller.ts')
  // The center is kept as a constructor parameter property, which is the store.
  assert.match(controller, /private readonly center\??: ConfirmationCenter/,
    'the controller must keep the center')
  assert.match(controller, /new AgentBinding\(this\.store, this\.hostCtx, agent, this\.center, this\.onDrift\)/,
    'the controller must pass the center into each binding')
})

test('the binding builds a confirmer keyed on the SESSION, never the project', () => {
  const binding = src('host/agent-binding.ts')
  // The browser subscribes with its session id, and the guard must ask with the
  // same key. The project key makes hasChannel always false, the confirmer answers
  // null, and the call falls back to the native approval path.
  const call = binding.match(/makeGuardConfirmer\(this\.center,\s*([^)]*)\)/)
  assert.ok(call, 'the binding must build a guard confirmer')
  assert.match(call[1], /sessionKey/, `the confirmer must be keyed on sessionKey, saw: ${call[1]}`)
  assert.doesNotMatch(call[1], /projectKey/, 'the confirmer must never be keyed on the project key')
})

test('the binding installs the guard listener with the confirmer', () => {
  const binding = src('host/agent-binding.ts')
  assert.match(binding, /applyGuards\(this\.scopedCtx/, 'the guard listener must be installed')
  assert.match(binding, /const confirmer = this\.center === undefined\s*\n?\s*\? undefined\s*\n?\s*: makeGuardConfirmer/,
    'the confirmer must be derived from the center, not left undefined unconditionally')
})

test('the auth seam is enforced on every route the plugin owns', () => {
  const http = src('host/http.ts')
  const routes = (http.match(/ctx\.webServer\.register\(\{/g) ?? []).length
  const authUses = (http.match(/auth\(req\)/g) ?? []).length
  assert.ok(routes >= 5, `expected the five routes, found ${routes}`)
  assert.ok(authUses >= routes, `every route must apply the seam: ${authUses} uses for ${routes} routes`)
})

// ---- behaviour, with real objects ----

test('a guard asked on the browser-subscribed session is answered end to end', async () => {
  const center = new ConfirmationCenter()
  const session = 'session-abc'
  const chunks: string[] = []
  center.subscribe(session, { write: (c) => { chunks.push(c); return true }, end() {} })

  const confirmer = makeGuardConfirmer(center, session)
  const hit = evaluateGuards(new Set([guardId('dangerous-shell')]), 'bash', { command: 'rm -rf /tmp/x' })
  assert.ok(hit, 'the dangerous-shell guard must match')
  const pending = confirmer({
    toolName: 'bash', args: { command: 'rm -rf /tmp/x' }, hit, signal: new AbortController().signal,
  })

  assert.ok(chunks.length > 0, 'the confirmation must reach the subscribed browser')
  const id = center.pendingFor(session)[0]?.id
  assert.ok(id, 'the request must be pending for that session')
  assert.equal(center.respond(session, id, 'allow'), true)
  assert.equal(await pending, 'allow')
  center.dispose()
})

test('a guard asked on a DIFFERENT session key falls back instead of blocking', async () => {
  // The failure mode the project-key bug produces: hasChannel false, confirmer
  // null, and the caller keeps the preset's legacy decision instead of hanging.
  const center = new ConfirmationCenter()
  center.subscribe('session-abc', { write: () => true, end() {} })
  const wrong = makeGuardConfirmer(center, '/some/project/path')
  const hit = evaluateGuards(new Set([guardId('dangerous-shell')]), 'bash', { command: 'rm -rf /tmp/x' })
  assert.equal(await wrong({
    toolName: 'bash', args: { command: 'rm -rf /tmp/x' }, hit: hit!, signal: new AbortController().signal,
  }), null, 'a mismatched session key must fall back, not block')
  center.dispose()
})

test('the auth seam refuses unauthenticated callers and admits trusted ones', () => {
  const seen: Array<string | undefined> = []
  const ctx = {
    get: (name: string) => name === 'connection' ? {
      trustedHosts: ['127.0.0.1:3080'],
      requestRejection(req: { headers: { host?: string } }) {
        seen.push(req.headers.host)
        return this.trustedHosts.includes(req.headers.host ?? '') ? undefined : 403
      },
    } : undefined,
  }
  const auth = resolveAuthForTest(ctx as never)
  assert.equal(auth({ headers: { host: '127.0.0.1:3080' } } as never), undefined)
  assert.equal(auth({ headers: { host: 'evil.example' } } as never), 403)
  assert.equal(seen.length, 2, 'the seam must actually be consulted')
})

test('a missing or broken seam fails closed on every request', () => {
  for (const connection of [undefined, {}, { requestRejection: 'not a function' }]) {
    const auth = resolveAuthForTest({ get: () => connection } as never)
    assert.equal(auth({ headers: { host: '127.0.0.1:3080' } } as never), 503)
  }
})
