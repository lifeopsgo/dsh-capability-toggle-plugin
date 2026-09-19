import { strict as assert } from 'node:assert'
import { EventEmitter, getEventListeners } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'

import { ConfirmationCenter, buildConfirmDetail, makeGuardConfirmer } from '../src/host/confirm.ts'
import type { ConfirmPayload, SseSink } from '../src/host/confirm.ts'
import { installHttp, ROUTE_PREFIX } from '../src/host/http.ts'

const payload: ConfirmPayload = {
  guardId: 'guard:dangerous-shell', guardAction: 'ask', reason: 'flagged', toolName: 'bash', detail: 'rm -rf /tmp/x',
}

class Sink implements SseSink {
  chunks: string[] = []
  ends = 0
  fail = false
  backpressure = false
  write(chunk: string): boolean {
    if (this.fail) throw new Error('closed socket')
    this.chunks.push(chunk)
    return !this.backpressure
  }
  end(): void { this.ends++ }
  events(): Array<Record<string, unknown>> {
    return this.chunks.flatMap(chunk => chunk.split('\n'))
      .filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice(5)))
  }
}

function confirmRequest(signal = new AbortController().signal) {
  return { toolName: 'bash', args: { command: payload.detail }, signal,
    hit: { id: payload.guardId, decision: { kind: 'ask' as const, reason: payload.reason } } }
}

for (const tool of ['bash', 'pwsh']) {
  test(`${tool} confirmation preserves long commands including the dangerous suffix`, () => {
    const command = `echo '${'x'.repeat(9000)}'\nrm -rf /important`
    assert.equal(buildConfirmDetail(tool, { command }), command)
  })
}

test('subscribe sends an authoritative snapshot even when nothing is pending', () => {
  const center = new ConfirmationCenter()
  const sink = new Sink()
  center.subscribe('s1', sink)
  assert.deepEqual(sink.events()[0], { snapshot: [] })
  center.dispose()
})

test('reconnect snapshot contains every still-pending card, never other sessions', () => {
  const center = new ConfirmationCenter()
  void center.request('s1', payload)
  void center.request('s2', { ...payload, detail: 'private s2' })
  const sink = new Sink()
  center.subscribe('s1', sink)
  assert.deepEqual(sink.events()[0], { snapshot: center.pendingFor('s1') })
  assert.ok(!sink.chunks.join('').includes('private s2'))
  center.dispose()
})

test('throwing sinks are removed and ended without poisoning other subscribers', async () => {
  const center = new ConfirmationCenter()
  const dead = new Sink()
  const live = new Sink()
  const off = center.subscribe('s1', dead)
  center.subscribe('s2', live)
  dead.fail = true
  const signal = new AbortController()
  const waiting = center.request('s1', payload, signal.signal)
  assert.equal(center.hasChannel('s1'), false)
  assert.equal(center.hasChannel('s2'), true)
  assert.equal(dead.ends, 1)
  off()
  assert.equal(dead.ends, 1, 'dead-sink disposal must be idempotent')
  assert.equal(await makeGuardConfirmer(center, 's1')(confirmRequest()), null)
  signal.abort()
  assert.equal(await waiting, 'cancelled')
  center.dispose()
})

test('write false is Node backpressure, not a dead channel or lost consent', async () => {
  const center = new ConfirmationCenter()
  const sink = new Sink()
  sink.backpressure = true
  center.subscribe('s1', sink)
  const waiting = center.request('s1', payload)
  assert.equal(center.hasChannel('s1'), true)
  center.respond('s1', center.pendingFor('s1')[0]!.id, 'allow')
  assert.equal(await waiting, 'allow')
  center.dispose()
})

test('dispose tolerates throwing end and still closes every channel', async () => {
  const center = new ConfirmationCenter()
  const bad: SseSink = { write: () => true, end: () => { throw new Error('end failed') } }
  const live = new Sink()
  center.subscribe('s1', bad)
  center.subscribe('s2', live)
  const waiting = center.request('s1', payload)
  assert.doesNotThrow(() => center.dispose())
  assert.equal(await waiting, 'cancelled')
  assert.equal(live.ends, 1)
  assert.equal(center.hasChannel('s1'), false)
  assert.equal(center.hasChannel('s2'), false)
})

test('disposed confirmer fails closed rather than returning legacy ask', async () => {
  const center = new ConfirmationCenter()
  const confirmer = makeGuardConfirmer(center, 's1')
  center.dispose()
  assert.equal(await confirmer(confirmRequest()), 'deny')
})

test('aborted confirmer without a browser fails closed rather than legacy ask', async () => {
  const center = new ConfirmationCenter()
  const signal = new AbortController()
  signal.abort()
  assert.equal(await makeGuardConfirmer(center, 's1')(confirmRequest(signal.signal)), 'deny')
  center.dispose()
})

for (const outcome of ['allow', 'deny', 'abort', 'dispose'] as const) {
  test(`${outcome} removes the pending entry and abort listener`, async () => {
    const center = new ConfirmationCenter()
    const signal = new AbortController()
    const waiting = center.request('s1', payload, signal.signal)
    const id = center.pendingFor('s1')[0]!.id
    assert.equal(getEventListeners(signal.signal, 'abort').length, 1)
    if (outcome === 'abort') signal.abort()
    else if (outcome === 'dispose') center.dispose()
    else center.respond('s1', id, outcome)
    assert.equal(await waiting, outcome === 'abort' || outcome === 'dispose' ? 'cancelled' : outcome)
    assert.deepEqual(center.pendingFor('s1'), [])
    assert.equal(getEventListeners(signal.signal, 'abort').length, 0)
    assert.equal(center.respond('s1', id, 'allow'), false)
    center.dispose()
  })
}

test('browser disconnect preserves an in-flight infinite wait for reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const center = new ConfirmationCenter()
  const off = center.subscribe('s1', new Sink())
  const waiting = center.request('s1', payload)
  let settled = false
  void waiting.then(() => { settled = true })
  off()
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000)
  await Promise.resolve()
  assert.equal(settled, false)
  const reconnect = new Sink()
  center.subscribe('s1', reconnect)
  const id = center.pendingFor('s1')[0]!.id
  center.respond('s1', id, 'deny')
  assert.equal(await waiting, 'deny')
  center.dispose()
})

class Response extends EventEmitter {
  statusCode = 0
  headers: Record<string, string> = {}
  chunks: string[] = []
  headersSent = false
  writableEnded = false
  destroyed = false
  writableNeedDrain = false
  flushes = 0
  writes = 0
  throwWrite = false
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.statusCode = status
    this.headers = { ...this.headers, ...headers }
    return this
  }
  setHeader(name: string, value: string): void { this.headers[name.toLowerCase()] = value }
  flushHeaders(): void { this.headersSent = true; this.flushes++ }
  write(chunk: string): boolean {
    this.writes++
    if (this.throwWrite) throw new Error('socket closed')
    this.headersSent = true
    this.chunks.push(chunk)
    return !this.writableNeedDrain
  }
  end(chunk?: string): void {
    if (this.writableEnded) return
    this.writableEnded = true
    if (chunk !== undefined) this.chunks.push(chunk)
    this.emit('finish')
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
function httpHarness(connection: unknown = { requestRejection: () => undefined }) {
  const center = new ConfirmationCenter()
  const routes = new Map<string, Handler>()
  const writes: unknown[] = []
  const ctx = {
    get: (name: string) => name === 'connection' ? connection : undefined,
    webServer: { register: (route: { path: string; handler: Handler }) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    } },
    logger: { warn: () => {} },
  }
  const store = { set: async (...args: unknown[]) => { writes.push(args) }, setMany: async (...args: unknown[]) => { writes.push(args) } }
  const registry = { get: () => undefined, fallbackProjection: () => ({ rows: [] }), lastKnownProjectKey: () => '/workspace' }
  const dispose = installHttp(ctx as never, store as never, registry as never, center)
  async function call(path: string, method = 'GET', headers: Record<string, string> = {}, body?: unknown) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { url: `${ROUTE_PREFIX}${path}`, method,
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', ...headers } })
    const res = new Response()
    const route = routes.get(`${ROUTE_PREFIX}${path.split('?')[0]}`)
    assert.ok(route, `missing route ${path}`)
    await route(req, res as unknown as ServerResponse)
    return { req, res }
  }
  return { center, routes, writes, call, dispose }
}

test('SSE flushes headers immediately and request close does not close the response', async (t) => {
  const h = httpHarness()
  t.after(() => { h.dispose(); h.center.dispose() })
  const { req, res } = await h.call('/confirm/stream?session=s1')
  assert.equal(res.flushes, 1)
  assert.match(res.headers['content-type']!, /^text\/event-stream/)
  req.emit('close')
  assert.equal(h.center.hasChannel('s1'), true, 'Node request close means request consumed, not client disconnected')
  assert.equal(res.writableEnded, false)
  res.emit('close')
  assert.equal(h.center.hasChannel('s1'), false)
  assert.equal(res.writableEnded, true)
})

for (const trigger of ['response-close', 'response-error', 'request-error', 'request-aborted', 'center-dispose', 'routes-dispose'] as const) {
  test(`${trigger} tears down SSE and its heartbeat`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const h = httpHarness()
    t.after(() => { h.dispose(); h.center.dispose() })
    const { req, res } = await h.call('/confirm/stream?session=s1')
    if (trigger === 'response-close') res.emit('close')
    else if (trigger === 'response-error') {
      assert.ok(res.listenerCount('error') > 0, 'response errors need a cleanup owner')
      res.emit('error', new Error('closed'))
    } else if (trigger === 'request-error') req.emit('error', new Error('closed'))
    else if (trigger === 'request-aborted') req.emit('aborted')
    else if (trigger === 'center-dispose') h.center.dispose()
    else h.dispose()
    const before = res.writes
    t.mock.timers.tick(60_000)
    assert.equal(res.writes, before, 'no writes after teardown')
    assert.equal(h.center.hasChannel('s1'), false)
    assert.equal(res.writableEnded, true)
    assert.equal(req.listenerCount('aborted'), 0)
    assert.equal(req.listenerCount('error'), 0)
    assert.equal(res.listenerCount('close'), 0)
    assert.equal(res.listenerCount('error'), 0)
    assert.equal(res.listenerCount('finish'), 0)
  })
}

test('a failing SSE heartbeat drops the channel without an uncaught exception', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const h = httpHarness()
  t.after(() => { h.dispose(); h.center.dispose() })
  const { res } = await h.call('/confirm/stream?session=s1')
  res.throwWrite = true
  assert.doesNotThrow(() => t.mock.timers.tick(15_000))
  assert.equal(h.center.hasChannel('s1'), false)
})

const routes = [
  ['/state?session=s1', 'GET'], ['/set', 'POST'], ['/set-many', 'POST'],
  ['/confirm/stream?session=s1', 'GET'], ['/confirm/respond', 'POST'],
] as const

for (const [path, method] of routes) {
  test(`${path} enforces its HTTP method before doing work`, async (t) => {
    const h = httpHarness()
    t.after(() => { h.dispose(); h.center.dispose() })
    const { res } = await h.call(path, method === 'GET' ? 'POST' : 'GET')
    assert.equal(res.statusCode, 405)
    assert.equal(res.headers['allow'], method)
    assert.deepEqual(h.writes, [])
    assert.equal(h.center.hasChannel('s1'), false)
  })
  for (const rejection of [401, 403]) {
    test(`${path} honors official Connection rejection ${rejection}`, async (t) => {
      // Named WebServer routes bypass /api and static-fallback authentication.
      const h = httpHarness({ requestRejection: () => rejection })
      t.after(() => { h.dispose(); h.center.dispose() })
      const { res } = await h.call(path, method, { 'content-type': 'application/json' },
        { session: 's1', id: 'guard:readonly', ids: ['guard:readonly'], level: 'session', state: 'off', decision: 'allow' })
      assert.equal(res.statusCode, rejection)
      assert.deepEqual(h.writes, [])
      assert.equal(h.center.hasChannel('s1'), false)
      assert.ok(!res.chunks.join('').includes('projection'))
    })
  }
}

for (const connection of [null, {}, { requestRejection: () => false }, { requestRejection: () => Promise.resolve(undefined) }]) {
  test('missing or incompatible authentication seam fails closed', async (t) => {
    const h = httpHarness(connection)
    t.after(() => { h.dispose(); h.center.dispose() })
    const { res } = await h.call('/confirm/stream?session=s1')
    assert.equal(res.statusCode, 503)
    assert.equal(h.center.hasChannel('s1'), false)
  })
}

for (const headers of [
  { origin: 'https://evil.example' }, { origin: 'null' },
  { origin: 'https://127.0.0.1:3080' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
]) {
  test(`SSE refuses cross-origin browser facts ${JSON.stringify(headers)}`, async (t) => {
    const h = httpHarness()
    t.after(() => { h.dispose(); h.center.dispose() })
    const { res } = await h.call('/confirm/stream?session=s1', 'GET', headers)
    assert.equal(res.statusCode, 403)
    assert.equal(h.center.hasChannel('s1'), false)
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })
}

for (const path of ['/set', '/set-many', '/confirm/respond']) {
  test(`${path} rejects form CSRF before parsing or mutating`, async (t) => {
    const h = httpHarness()
    t.after(() => { h.dispose(); h.center.dispose() })
    for (const contentType of ['', 'text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
      const { res } = await h.call(path, 'POST', { 'content-type': contentType }, {})
      assert.equal(res.statusCode, 415)
    }
    assert.deepEqual(h.writes, [])
  })
}

test('authenticated same-origin answer settles once and stale answer returns 410', async (t) => {
  const h = httpHarness()
  t.after(() => { h.dispose(); h.center.dispose() })
  const stream = await h.call('/confirm/stream?session=s1')
  const waiting = h.center.request('s1', payload)
  const body = { session: 's1', id: h.center.pendingFor('s1')[0]!.id, decision: 'allow' }
  const headers = { origin: 'http://127.0.0.1:3080', 'content-type': 'application/json; charset=utf-8' }
  const first = await h.call('/confirm/respond', 'POST', headers, body)
  assert.equal(first.res.statusCode, 200)
  assert.equal(await waiting, 'allow')
  assert.ok(stream.res.chunks.some(chunk => chunk.includes('"resolved":true')))
  const second = await h.call('/confirm/respond', 'POST', headers, body)
  assert.equal(second.res.statusCode, 410)
})
