/**
 * Tests for the plugin-owned blocking confirmation channel: the host-side
 * ConfirmationCenter (pending registry, SSE fan-out, abort/dispose semantics),
 * the applyGuards confirmer wiring (allow→next, deny→block, null→legacy),
 * the respond-body parser, and the client-side subscription/card source shape.
 *
 * These are dependency-free: the SSE sink is a two-method interface, so no
 * node:http objects are needed, and the client assertions are source scans in
 * the same style as the existing client tests in pure.test.ts.
 *
 * @module dsh-capability-toggle-plugin/test/confirm
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  ConfirmationCenter, buildConfirmDetail, makeGuardConfirmer,
} from '../src/host/confirm.ts'
import type { SseSink } from '../src/host/confirm.ts'
import { applyGuards, guardId } from '../src/host/guards.ts'
import type { GuardConfirmRequest, GuardConfirmer } from '../src/host/guards.ts'
import { parseRespondBody } from '../src/host/http.ts'
import {
  available as renderAvailable, DisabledControl, renderConfirmationCard, userClick,
} from './render-harness.ts'

/** A recording SSE sink standing in for the ServerResponse write side. */
class FakeSink implements SseSink {
  readonly chunks: string[] = []
  ended = false
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  end(): void {
    this.ended = true
  }
  /** All `data:` payloads parsed as JSON, in write order. */
  datas(): Array<Record<string, unknown>> {
    return this.chunks
      .flatMap(c => c.split('\n'))
      .filter(l => l.startsWith('data:'))
      .map(l => JSON.parse(l.slice(5).trim()) as Record<string, unknown>)
  }
}

function payload(guard = 'dangerous-shell', tool = 'bash', detail = 'rm -rf /tmp/x') {
  return {
    guardId: guardId(guard),
    guardAction: 'ask' as const,
    reason: `The "${guard}" guard flagged this command for confirmation.`,
    toolName: tool,
    detail,
  }
}

// ---- ConfirmationCenter: channel presence ----

test('center starts with no channel for any session', () => {
  const c = new ConfirmationCenter()
  assert.equal(c.hasChannel('s1'), false)
  c.dispose()
})

test('subscribe creates a channel; the returned disposer removes it', () => {
  const c = new ConfirmationCenter()
  const sink = new FakeSink()
  const off = c.subscribe('s1', sink)
  assert.equal(c.hasChannel('s1'), true)
  assert.equal(c.hasChannel('s2'), false)
  off()
  assert.equal(c.hasChannel('s1'), false)
  assert.equal(sink.ended, true)
  c.dispose()
})

test('two subscribers on one session: channel survives one leaving', () => {
  const c = new ConfirmationCenter()
  const a = new FakeSink()
  const b = new FakeSink()
  const offA = c.subscribe('s1', a)
  c.subscribe('s1', b)
  offA()
  assert.equal(c.hasChannel('s1'), true)
  c.dispose()
})

// ---- ConfirmationCenter: request/respond ----

test('request stays pending, respond(allow) resolves it and notifies subscribers', async () => {
  const c = new ConfirmationCenter()
  const sink = new FakeSink()
  c.subscribe('s1', sink)
  const p = c.request('s1', payload())
  assert.equal(c.pendingFor('s1').length, 1)
  const id = c.pendingFor('s1')[0]!.id
  // The subscriber received the confirm push with the full payload.
  const pushed = sink.datas().find(d => d['id'] === id && d['detail'] !== undefined)
  assert.ok(pushed, 'confirm event not pushed')
  assert.equal(pushed!['toolName'], 'bash')
  assert.equal(pushed!['detail'], 'rm -rf /tmp/x')
  assert.equal(c.respond('s1', id, 'allow'), true)
  assert.equal(await p, 'allow')
  assert.equal(c.pendingFor('s1').length, 0)
  // A resolved notification lets every other tab close its card too.
  assert.ok(sink.datas().some(d => d['id'] === id && d['resolved'] === true), 'no resolved event')
  c.dispose()
})

test('respond(deny) resolves deny', async () => {
  const c = new ConfirmationCenter()
  c.subscribe('s1', new FakeSink())
  const p = c.request('s1', payload())
  const id = c.pendingFor('s1')[0]!.id
  assert.equal(c.respond('s1', id, 'deny'), true)
  assert.equal(await p, 'deny')
  c.dispose()
})

test('respond is first-wins: unknown id, wrong session, and double respond all return false', async () => {
  const c = new ConfirmationCenter()
  c.subscribe('s1', new FakeSink())
  const p = c.request('s1', payload())
  const id = c.pendingFor('s1')[0]!.id
  assert.equal(c.respond('s2', id, 'allow'), false)
  assert.equal(c.respond('s1', 'nope', 'allow'), false)
  assert.equal(c.respond('s1', id, 'allow'), true)
  assert.equal(c.respond('s1', id, 'deny'), false)
  assert.equal(await p, 'allow')
  c.dispose()
})

test('a late subscriber replays the still-pending requests', () => {
  const c = new ConfirmationCenter()
  c.subscribe('s1', new FakeSink())
  void c.request('s1', payload('readonly', 'write', '{"file_path":"x"}'))
  const late = new FakeSink()
  c.subscribe('s1', late)
  const replayed = late.datas().filter(d => d['detail'] !== undefined)
  assert.equal(replayed.length, 1)
  assert.equal(replayed[0]!['toolName'], 'write')
  c.dispose()
})

// ---- ConfirmationCenter: abort and dispose ----

test('signal abort resolves cancelled and clears the pending entry', async () => {
  const c = new ConfirmationCenter()
  const sink = new FakeSink()
  c.subscribe('s1', sink)
  const ac = new AbortController()
  const p = c.request('s1', payload(), ac.signal)
  const id = c.pendingFor('s1')[0]!.id
  ac.abort()
  assert.equal(await p, 'cancelled')
  assert.equal(c.pendingFor('s1').length, 0)
  assert.ok(sink.datas().some(d => d['id'] === id && d['resolved'] === true))
  c.dispose()
})

test('an already-aborted signal resolves cancelled without registering', async () => {
  const c = new ConfirmationCenter()
  c.subscribe('s1', new FakeSink())
  const ac = new AbortController()
  ac.abort()
  const p = c.request('s1', payload(), ac.signal)
  assert.equal(await p, 'cancelled')
  assert.equal(c.pendingFor('s1').length, 0)
  c.dispose()
})

test('dispose cancels every pending request and ends every sink', async () => {
  const c = new ConfirmationCenter()
  const a = new FakeSink()
  const b = new FakeSink()
  c.subscribe('s1', a)
  c.subscribe('s2', b)
  const p1 = c.request('s1', payload())
  const p2 = c.request('s2', payload())
  c.dispose()
  assert.equal(await p1, 'cancelled')
  assert.equal(await p2, 'cancelled')
  assert.equal(a.ended, true)
  assert.equal(b.ended, true)
  assert.equal(c.hasChannel('s1'), false)
})

test('request with no subscriber still registers and can be answered after a late subscribe', async () => {
  // hasChannel is the CALLER's fallback gate; the center itself never refuses.
  const c = new ConfirmationCenter()
  const p = c.request('s1', payload())
  const sink = new FakeSink()
  c.subscribe('s1', sink)
  const id = c.pendingFor('s1')[0]!.id
  assert.equal(c.respond('s1', id, 'deny'), true)
  assert.equal(await p, 'deny')
  c.dispose()
})

// ---- buildConfirmDetail ----

test('buildConfirmDetail shows the full command for shell tools', () => {
  assert.equal(buildConfirmDetail('bash', { command: 'rm -rf /tmp/x' }), 'rm -rf /tmp/x')
  assert.equal(buildConfirmDetail('pwsh', { command: 'Remove-Item -Recurse -Force C:\\t' }), 'Remove-Item -Recurse -Force C:\\t')
})

test('buildConfirmDetail falls back to bounded JSON for other tools', () => {
  const d = buildConfirmDetail('web_fetch', { url: 'http://x' })
  assert.ok(d.includes('http://x'))
  const big = buildConfirmDetail('write', { content: 'a'.repeat(50000) })
  assert.ok(big.length <= 8200, `detail must be bounded, got ${big.length}`)
})

// ---- applyGuards × confirmer wiring ----

interface FakeGuardCtx {
  ctx: Parameters<typeof applyGuards>[0]
  listener: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null
}

function fakeGuardCtx(): FakeGuardCtx {
  const rec: { listener: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null } = { listener: null }
  const ctx = {
    on: (_event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      rec.listener = listener
      return () => {}
    },
  }
  return { ctx: ctx as unknown as Parameters<typeof applyGuards>[0], get listener() { return rec.listener } }
}

const ALLOW_NEXT = { kind: 'allow' } as const

test('confirmer allow delegates to next() so downstream gates still run', async () => {
  const f = fakeGuardCtx()
  const seen: Array<{ tool: string; guard: string }> = []
  const confirmer: GuardConfirmer = async (req) => {
    seen.push({ tool: req.toolName, guard: req.hit.id })
    return 'allow'
  }
  applyGuards(f.ctx, new Set([guardId('dangerous-shell')]), () => {}, confirmer)
  let nextCalls = 0
  const decision = await f.listener!(
    { name: 'bash', arguments: { command: 'rm -rf /tmp/x' }, signal: new AbortController().signal },
    () => { nextCalls += 1; return Promise.resolve(ALLOW_NEXT) },
  )
  assert.deepEqual(seen, [{ tool: 'bash', guard: guardId('dangerous-shell') }])
  assert.equal(nextCalls, 1)
  assert.equal((decision as { kind: string }).kind, 'allow')
})

test('confirmer deny blocks with the hit reason and never calls next()', async () => {
  const f = fakeGuardCtx()
  const confirmer: GuardConfirmer = async () => 'deny'
  applyGuards(f.ctx, new Set([guardId('readonly')]), () => {}, confirmer)
  let nextCalls = 0
  const decision = await f.listener!(
    { name: 'write', arguments: { file_path: 'x' }, signal: new AbortController().signal },
    () => { nextCalls += 1; return Promise.resolve(ALLOW_NEXT) },
  )
  assert.equal(nextCalls, 0)
  const d = decision as { kind: string; reason?: string }
  assert.equal(d.kind, 'deny')
  assert.ok((d.reason ?? '').includes('readonly'), `reason must identify the guard: ${d.reason}`)
})

test('confirmer null (no browser channel) falls back to the legacy decision', async () => {
  // A deny preset must stay a hard deny, an ask preset must stay an ask — the
  // fallback is exactly today's behavior, so headless sessions are unaffected.
  const confirmer: GuardConfirmer = async () => null
  const deny = fakeGuardCtx()
  applyGuards(deny.ctx, new Set([guardId('readonly')]), () => {}, confirmer)
  const denyDecision = await deny.listener!(
    { name: 'write', arguments: { file_path: 'x' }, signal: new AbortController().signal },
    () => Promise.resolve(ALLOW_NEXT),
  )
  assert.equal((denyDecision as { kind: string }).kind, 'deny')
  const ask = fakeGuardCtx()
  applyGuards(ask.ctx, new Set([guardId('dangerous-shell')]), () => {}, askConfirmerNull)
  const askDecision = await ask.listener!(
    { name: 'bash', arguments: { command: 'rm -rf /tmp/x' }, signal: new AbortController().signal },
    () => Promise.resolve(ALLOW_NEXT),
  )
  assert.equal((askDecision as { kind: string }).kind, 'ask')
})

const askConfirmerNull: GuardConfirmer = async () => null

test('a non-matching call never reaches the confirmer', async () => {
  const f = fakeGuardCtx()
  let asked = 0
  const confirmer: GuardConfirmer = async () => { asked += 1; return 'deny' }
  applyGuards(f.ctx, new Set([guardId('readonly')]), () => {}, confirmer)
  let nextCalls = 0
  await f.listener!(
    { name: 'read', arguments: { file_path: 'x' }, signal: new AbortController().signal },
    () => { nextCalls += 1; return Promise.resolve(ALLOW_NEXT) },
  )
  assert.equal(asked, 0)
  assert.equal(nextCalls, 1)
})

test('a throwing confirmer fails closed to deny', async () => {
  const f = fakeGuardCtx()
  const confirmer: GuardConfirmer = async () => { throw new Error('center exploded') }
  applyGuards(f.ctx, new Set([guardId('dangerous-shell')]), () => {}, confirmer)
  let nextCalls = 0
  const decision = await f.listener!(
    { name: 'bash', arguments: { command: 'rm -rf /tmp/x' }, signal: new AbortController().signal },
    () => { nextCalls += 1; return Promise.resolve(ALLOW_NEXT) },
  )
  assert.equal(nextCalls, 0)
  assert.equal((decision as { kind: string }).kind, 'deny')
})

test('the hit is counted before the confirmation is awaited', async () => {
  // Telemetry must record the match even if the user never answers (the call
  // stays blocked on the prompt); onHit runs at match time, not at resolution.
  const f = fakeGuardCtx()
  const order: string[] = []
  const confirmer: GuardConfirmer = async () => { order.push('confirm'); return 'allow' }
  applyGuards(f.ctx, new Set([guardId('dangerous-shell')]), () => order.push('hit'), confirmer)
  await f.listener!(
    { name: 'bash', arguments: { command: 'rm -rf /tmp/x' }, signal: new AbortController().signal },
    () => Promise.resolve(ALLOW_NEXT),
  )
  assert.deepEqual(order, ['hit', 'confirm'])
})

test('applyGuards without a confirmer keeps the exact legacy behavior', async () => {
  // The fourth parameter is optional: every pre-existing call site (and the
  // whole pure.test.ts listener suite) must behave identically without it.
  const f = fakeGuardCtx()
  applyGuards(f.ctx, new Set([guardId('readonly')]), () => {})
  const decision = await f.listener!(
    { name: 'write', arguments: { file_path: 'x' } },
    () => Promise.resolve(ALLOW_NEXT),
  )
  assert.equal((decision as { kind: string }).kind, 'deny')
})

// ---- HTTP respond-body parser ----

test('parseRespondBody accepts a well-formed response', () => {
  const r = parseRespondBody({ session: 's1', id: 'abc', decision: 'allow' })
  assert.deepEqual(r, { session: 's1', id: 'abc', decision: 'allow' })
})

test('parseRespondBody rejects malformed bodies', () => {
  for (const bad of [
    null, 'x', 42,
    { id: 'abc', decision: 'allow' },
    { session: '', id: 'abc', decision: 'allow' },
    { session: 's1', id: '', decision: 'allow' },
    { session: 's1', id: 'abc' },
    { session: 's1', id: 'abc', decision: 'maybe' },
    { session: 1, id: 'abc', decision: 'allow' },
  ]) {
    assert.throws(() => parseRespondBody(bad), undefined, JSON.stringify(bad))
  }
})

// ---- client half: source-shape gates (no DOM in this repo's test env) ----

test('the client subscribes to the confirm SSE stream and can respond', () => {
  const api = readFileSync(new URL('../src/client/api.ts', import.meta.url), 'utf8')
  assert.ok(/EventSource/.test(api), 'api.ts must open an EventSource for confirm pushes')
  assert.ok(/confirm\/stream/.test(api), 'api.ts must target the confirm/stream route')
  assert.ok(/confirm\/respond/.test(api), 'api.ts must post to the confirm/respond route')
})

test('the composer control renders a confirmation card with the full detail', () => {
  const idx = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const comp = readFileSync(new URL('../src/client/components.tsx', import.meta.url), 'utf8')
  assert.ok(/ConfirmationCard/.test(comp), 'components.tsx must define ConfirmationCard')
  assert.ok(/ConfirmationCard/.test(idx), 'index.tsx must render ConfirmationCard')
  // The card must show the guarded call's detail (full command text), not just
  // the guard name — the user explicitly chose full-command disclosure.
  assert.ok(/detail/.test(comp), 'ConfirmationCard must render the detail field')
})

// ---- ConfirmationCard: real element-tree render (render-harness, no DOM) ----

function cardT(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key
}

function cardProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    guardId: 'guard:dangerous-shell',
    guardAction: 'ask' as const,
    reason: 'The "dangerous-shell" guard flagged this command for confirmation.',
    toolName: 'bash',
    detail: 'rm -rf /tmp/x',
    busy: false,
    t: cardT,
    onAnswer: () => {},
    ...overrides,
  }
}

test('the card renders the FULL command text in a detail block', { skip: !renderAvailable && 'needs the React 18 dispatcher' }, async () => {
  const card = await renderConfirmationCard(cardProps())
  const detail = card.find('dshct-confirm-detail')
  assert.ok(detail, 'the card must render a detail block')
  // The user explicitly chose full-command disclosure, so the exact command
  // must reach the DOM, not a truncated summary or just the guard name.
  assert.equal(detail.props.children, 'rm -rf /tmp/x')
})

test('the card labels the guard by its bare name, not the guard: id', { skip: !renderAvailable && 'needs the React 18 dispatcher' }, async () => {
  const card = await renderConfirmationCard(cardProps())
  const body = card.find('dshct-confirm-body')
  assert.ok(body, 'the card must render a body line')
  assert.ok(
    String(body.props.children ?? '').includes('"dangerous-shell"'),
    'the body must interpolate the stripped guard name',
  )
  assert.ok(
    !String(body.props.children ?? '').includes('guard:dangerous-shell'),
    'the raw guard: prefix must not leak into the body',
  )
})

test('clicking Allow answers allow; clicking Deny answers deny', { skip: !renderAvailable && 'needs the React 18 dispatcher' }, async () => {
  const answers: Array<'allow' | 'deny'> = []
  const card = await renderConfirmationCard(cardProps({ onAnswer: (d: 'allow' | 'deny') => { answers.push(d) } }))
  const btns = card.findAll('dshct-confirm-btn')
  assert.equal(btns.length, 2, 'exactly two answer buttons')
  const deny = btns.find(b => b.props['data-kind'] === 'deny')
  const allow = btns.find(b => b.props['data-kind'] === 'allow')
  assert.ok(deny && allow, 'both allow and deny buttons must render')
  userClick(deny!)
  userClick(allow!)
  assert.deepEqual(answers, ['deny', 'allow'], 'each button must answer its own decision')
})

test('while busy, both answer buttons are locked against double-submit', { skip: !renderAvailable && 'needs the React 18 dispatcher' }, async () => {
  const card = await renderConfirmationCard(cardProps({ busy: true }))
  for (const btn of card.findAll('dshct-confirm-btn')) {
    assert.equal(btn.props.disabled, true, 'a busy card must disable its buttons')
    // userClick models the browser rule that a disabled control never fires, so
    // this throws rather than reaching onAnswer — pinning the lock for real.
    assert.throws(() => userClick(btn), DisabledControl)
  }
  const waiting = card.find('dshct-confirm-waiting')
  assert.ok(waiting, 'a busy card must show the waiting hint')
})

test('a deny-action guard carries the deny styling hook on the card', { skip: !renderAvailable && 'needs the React 18 dispatcher' }, async () => {
  const card = await renderConfirmationCard(cardProps({ guardAction: 'deny', guardId: 'guard:readonly' }))
  const root = card.find('dshct-confirm')
  assert.ok(root, 'the card root must render')
  assert.equal(root.props['data-action'], 'deny', 'the card must expose its action for styling')
})

test('confirm card copy exists in both dictionaries', async () => {
  const { dictionaries } = await import('../src/client/locales.ts')
  for (const dict of ['zh', 'en'] as const) {
    for (const key of ['guard.confirm.title', 'guard.confirm.allow', 'guard.confirm.deny']) {
      assert.ok(
        typeof dictionaries[dict][key] === 'string' && dictionaries[dict][key] !== '',
        `${dict}.${key} missing`,
      )
    }
  }
})

// ---- makeGuardConfirmer: the binding's confirmer factory (fallback semantics) ----

function confirmReq(overrides: Partial<GuardConfirmRequest> = {}): GuardConfirmRequest {
  return {
    toolName: 'bash',
    args: { command: 'rm -rf /tmp/x' },
    hit: {
      id: guardId('dangerous-shell'),
      decision: { kind: 'ask', reason: 'flagged' },
    },
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('makeGuardConfirmer returns null (legacy fallback) when no browser is subscribed', async () => {
  const c = new ConfirmationCenter()
  const confirmer = makeGuardConfirmer(c, 's1')
  assert.equal(await confirmer(confirmReq()), null)
  c.dispose()
})

test('makeGuardConfirmer blocks until answered allow when a browser IS subscribed', async () => {
  const c = new ConfirmationCenter()
  c.subscribe('s1', new FakeSink())
  const confirmer = makeGuardConfirmer(c, 's1')
  const p = confirmer(confirmReq())
  const id = c.pendingFor('s1')[0]!.id
  assert.equal(c.respond('s1', id, 'allow'), true)
  assert.equal(await p, 'allow')
  c.dispose()
})

test('makeGuardConfirmer maps deny to deny', async () => {
  const c = new ConfirmationCenter()
  c.subscribe('s1', new FakeSink())
  const confirmer = makeGuardConfirmer(c, 's1')
  const p = confirmer(confirmReq())
  const id = c.pendingFor('s1')[0]!.id
  c.respond('s1', id, 'deny')
  assert.equal(await p, 'deny')
  c.dispose()
})

test('makeGuardConfirmer maps a cancelled wait (abort) to deny, never allow', async () => {
  // A turn abort or plugin dispose settles the wait as cancelled; that must NOT
  // be mistaken for consent — fail closed to deny.
  const c = new ConfirmationCenter()
  c.subscribe('s1', new FakeSink())
  const confirmer = makeGuardConfirmer(c, 's1')
  const ac = new AbortController()
  const p = confirmer(confirmReq({ signal: ac.signal }))
  ac.abort()
  assert.equal(await p, 'deny')
  c.dispose()
})

test('makeGuardConfirmer builds the payload detail from the request', async () => {
  const c = new ConfirmationCenter()
  const sink = new FakeSink()
  c.subscribe('s1', sink)
  const confirmer = makeGuardConfirmer(c, 's1')
  const p = confirmer(confirmReq())
  const pushed = sink.datas().find(d => d['detail'] !== undefined)
  assert.equal(pushed!['detail'], 'rm -rf /tmp/x')
  assert.equal(pushed!['guardId'], guardId('dangerous-shell'))
  assert.equal(pushed!['toolName'], 'bash')
  const id = c.pendingFor('s1')[0]!.id
  c.respond('s1', id, 'allow')
  await p
  c.dispose()
})
