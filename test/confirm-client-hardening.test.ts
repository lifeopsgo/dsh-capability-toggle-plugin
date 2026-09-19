import { strict as assert } from 'node:assert'
import { after, before, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import React from 'react'
import { Rolldown } from 'tsdown'
import { respondConfirm, subscribeConfirm } from '../src/client/api.ts'
import { renderConfirmationCard, userClick } from './render-harness.ts'

const pending = (id = 'one', extra = {}) => ({
  id, guardId: 'guard:dangerous-shell', guardAction: 'ask',
  reason: 'Review the full command', toolName: 'bash', detail: 'rm -rf /tmp/example', ...extra,
})

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onmessage: ((event: { data: string }) => void) | null = null
  closed = false
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this) }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
  close() { this.closed = true }
}

const realFetch = globalThis.fetch
const realEventSource = globalThis.EventSource
before(() => { globalThis.EventSource = FakeEventSource as unknown as typeof EventSource })
after(() => { globalThis.fetch = realFetch; globalThis.EventSource = realEventSource })

function stream() { return FakeEventSource.instances.at(-1)! }
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

test('subscription rejects malformed pending, resolved, and snapshot frames', () => {
  const seen: unknown[] = []
  const stop = subscribeConfirm('session', frame => seen.push(frame))
  try {
    for (const bad of [null, [], {}, { id: 'one' }, { id: 12, resolved: true },
      { id: '', resolved: true }, pending('one', { guardId: {} }),
      pending('one', { detail: 5 }), pending('one', { reason: [] }),
      pending('one', { toolName: null }), pending('one', { guardAction: 'allow' }),
      { snapshot: {} }, { snapshot: [pending(), { id: 'invalid' }] },
      { snapshot: [], id: 'one', resolved: true }, pending('one', { resolved: 'true' }),
    ]) stream().emit(bad)
    stream().onmessage?.({ data: '{bad JSON' })
    assert.deepEqual(seen, [], 'invalid wire data must never reach component state')
  } finally { stop() }
})

test('subscription normalizes valid wire events into a discriminated union', () => {
  const seen: unknown[] = []
  const stop = subscribeConfirm('a/b ?x', frame => seen.push(frame))
  try {
    assert.equal(stream().url, '/api/plugin/capability-toggle/confirm/stream?session=a%2Fb%20%3Fx')
    stream().emit(pending())
    stream().emit({ id: 'one', resolved: true })
    stream().emit({ snapshot: [pending('two')] })
    assert.deepEqual(seen, [
      { kind: 'pending', card: pending() }, { kind: 'resolved', id: 'one' },
      { kind: 'snapshot', cards: [pending('two')] },
    ])
  } finally { stop() }
})

test('disposing the stream also fences queued callbacks', () => {
  const seen: unknown[] = []
  const stop = subscribeConfirm('session', frame => seen.push(frame))
  const callback = stream().onmessage!
  stop()
  callback({ data: JSON.stringify(pending()) })
  assert.equal(stream().closed, true)
  assert.deepEqual(seen, [])
})

test('an empty session never opens a confirmation channel', () => {
  const count = FakeEventSource.instances.length
  subscribeConfirm('', () => assert.fail('no frame expected'))()
  assert.equal(FakeEventSource.instances.length, count)
})

test('response API distinguishes accepted, stale, HTTP failure and lost connection', async () => {
  const bodies: unknown[] = []
  for (const [status, expected] of [[200, 'accepted'], [410, 'gone'], [403, 'retry'], [500, 'retry']] as const) {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/plugin/capability-toggle/confirm/respond')
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('', { status })
    }
    assert.equal(await respondConfirm('s1', 'one', 'deny'), expected)
  }
  assert.deepEqual(bodies, Array(4).fill({ session: 's1', id: 'one', decision: 'deny' }))
  globalThis.fetch = async () => { throw new TypeError('offline') }
  assert.equal(await respondConfirm('s1', 'one', 'allow'), 'retry')
})

type Node = { type?: unknown; props?: Record<string, any> }
function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...nodes(node.props?.children)]
}

// This narrow dispatcher runs the registered control's real effects, including
// cleanup and dependency changes. Child cards remain real React elements; their
// leaf DOM contracts are tested using the existing shared render harness below.
const seat = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
let component: (props: unknown) => unknown
before(async () => {
  mkdirSync(new URL('../.temp/', import.meta.url), { recursive: true })
  const out = new URL('../.temp/confirm-client-hardening.mjs', import.meta.url)
  const bundle = await Rolldown.rolldown({
    input: new URL('../src/client/index.tsx', import.meta.url).pathname,
    external: ['react', 'react/jsx-runtime'],
  })
  const { output } = await bundle.generate({ format: 'esm' })
  writeFileSync(out, output[0].code)
  await bundle.close()
  const mod = await import(`${out.pathname}?v=${Date.now()}`)
  mod.apply({
    effect() { return () => {} },
    locale: { register() { return () => {} } },
    slots: {
      inject(_name: string, fn: () => void) { fn() },
      register(_spec: unknown, fn: (props: unknown) => unknown) { component = fn; return () => {} },
    },
  })
  assert.equal(typeof component, 'function', 'the actual composer slot must register')
})

function mountControl(session = 's1') {
  const slots: any[] = []
  const effects: Array<{ deps: unknown[]; cleanup?: () => void }> = []
  let index = 0
  let effectIndex = 0
  let dirty = false
  let props = { sessionId: session, t: (key: string) => key }
  let tree: unknown
  const dispatcher = {
    useState(initial: any) {
      const at = index++
      if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
      return [slots[at], (next: any) => {
        slots[at] = typeof next === 'function' ? next(slots[at]) : next
        dirty = true
      }]
    },
    useRef(initial: any) {
      const at = index++
      if (!(at in slots)) slots[at] = { current: initial }
      return slots[at]
    },
    useCallback(fn: unknown) { return fn },
    useEffect(fn: () => (() => void) | void, deps: unknown[]) {
      const at = effectIndex++
      const old = effects[at]
      if (old && deps.every((d, i) => Object.is(d, old.deps[i]))) return
      pendingEffects.push(() => {
        old?.cleanup?.()
        effects[at] = { deps, cleanup: fn() || undefined }
      })
    },
  }
  let pendingEffects: Array<() => void> = []
  function render(flush = true) {
    let runs = 0
    do {
      dirty = false; index = 0; effectIndex = 0; pendingEffects = []
      const old = seat.current
      seat.current = dispatcher
      try { tree = component(props) } finally { seat.current = old }
      if (!flush) break
      pendingEffects.forEach(fn => fn())
      assert.ok(++runs < 10, 'control must settle without a render loop')
    } while (dirty)
    return tree
  }
  render()
  return {
    render,
    switchSession(next: string, flush = true) { props = { ...props, sessionId: next }; return render(flush) },
    cards() {
      render()
      return nodes(tree).filter(n => typeof n.type === 'function' && 'guardId' in (n.props ?? {}))
    },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
  }
}

test('closed composer still subscribes and every guard kind renders a pending card', () => {
  const control = mountControl()
  try {
    for (const [id, action] of [['readonly', 'deny'], ['dangerous-shell', 'ask'], ['custom-guard', 'deny']]) {
      stream().emit(pending(id, { guardId: `guard:${id}`, guardAction: action }))
    }
    assert.equal(control.cards().length, 3)
    assert.equal(nodes(control.render()).some(n => n.props?.className === 'dshct-overlay'), false)
  } finally { control.unmount() }
})

test('session switch immediately hides stale cards and fences stale answer and SSE callbacks', () => {
  const control = mountControl()
  globalThis.fetch = async () => { assert.fail('stale session must never POST') }
  try {
    const first = stream()
    first.emit(pending())
    const staleCard = control.cards()[0]!
    const oldCallback = first.onmessage!
    const transition = control.switchSession('s2', false)
    assert.equal(nodes(transition).filter(n => typeof n.type === 'function' && 'guardId' in (n.props ?? {})).length, 0)
    staleCard.props!.onAnswer('allow')
    control.render()
    oldCallback({ data: JSON.stringify(pending('late')) })
    assert.equal(first.closed, true)
    assert.equal(control.cards().length, 0)
    control.switchSession('')
    assert.equal(stream().closed, true)
  } finally { control.unmount() }
})

test('a reconnect snapshot replaces pending cards, including an empty snapshot', () => {
  const control = mountControl()
  try {
    stream().emit(pending('ghost'))
    stream().emit(pending('live'))
    assert.equal(control.cards().length, 2)
    stream().emit({ snapshot: [pending('live')] })
    assert.deepEqual(control.cards().map(c => c.props!.detail), ['rm -rf /tmp/example'])
    stream().emit({ snapshot: [] })
    assert.equal(control.cards().length, 0)
  } finally { control.unmount() }
})

test('network failure retains a retryable card and a successful retry closes without SSE', async () => {
  const control = mountControl()
  try {
    globalThis.fetch = async () => { throw new TypeError('offline') }
    stream().emit(pending())
    control.cards()[0]!.props!.onAnswer('allow')
    await tick()
    const failed = control.cards()[0]!
    assert.ok(failed, 'failed response must retain the full card')
    assert.equal(failed.props!.busy, false)
    assert.equal(failed.props!.failed, true, 'failure must be visible, not silently unlocked')
    globalThis.fetch = async () => new Response('', { status: 200 })
    failed.props!.onAnswer('deny')
    await tick()
    assert.equal(control.cards().length, 0)
  } finally { control.unmount() }
})

test('410 removes a stale card even when its resolved frame was missed', async () => {
  const control = mountControl()
  try {
    globalThis.fetch = async () => new Response('', { status: 410 })
    stream().emit(pending())
    control.cards()[0]!.props!.onAnswer('deny')
    await tick()
    assert.equal(control.cards().length, 0)
  } finally { control.unmount() }
})

test('concurrent cards keep independent busy locks and suppress same-tick double submits', async () => {
  const control = mountControl()
  const replies: Array<(response: Response) => void> = []
  const requests: unknown[] = []
  try {
    globalThis.fetch = (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Promise(resolve => replies.push(resolve))
    }
    stream().emit(pending('one'))
    stream().emit(pending('two'))
    const cards = control.cards()
    cards[0]!.props!.onAnswer('allow')
    cards[0]!.props!.onAnswer('deny')
    cards[1]!.props!.onAnswer('deny')
    assert.deepEqual(requests, [
      { session: 's1', id: 'one', decision: 'allow' }, { session: 's1', id: 'two', decision: 'deny' },
    ])
    assert.deepEqual(control.cards().map(c => c.props!.busy), [true, true])
    replies[0]!(new Response('', { status: 500 }))
    await tick()
    assert.deepEqual(control.cards().map(c => c.props!.busy), [false, true])
    replies[1]!(new Response('', { status: 200 }))
    await tick()
    assert.equal(control.cards().length, 1)
  } finally { control.unmount() }
})

test('late response cannot remove a new session card or resurrect a resolved card', async () => {
  const control = mountControl()
  let reply!: (response: Response) => void
  try {
    globalThis.fetch = () => new Promise(resolve => { reply = resolve })
    stream().emit(pending('one'))
    control.cards()[0]!.props!.onAnswer('allow')
    control.switchSession('s2')
    stream().emit(pending('one', { detail: 'new session command' }))
    reply(new Response('', { status: 200 }))
    await tick()
    assert.equal(control.cards()[0]!.props!.detail, 'new session command')
    control.cards()[0]!.props!.onAnswer('deny')
    stream().emit({ id: 'one', resolved: true })
    reply(new Response('', { status: 500 }))
    await tick()
    assert.equal(control.cards().length, 0)
  } finally { control.unmount() }
})

test('card exposes full text, keyboard-scrollable detail and retry status without autofocus', async () => {
  const command = 'echo full-command\n'.repeat(1000)
  const choices: string[] = []
  const card = await renderConfirmationCard({
    ...pending(), detail: command, busy: false, failed: true,
    t: (key: string) => key, onAnswer: (choice: string) => choices.push(choice),
  })
  assert.equal(card.find('dshct-confirm-detail')!.props.children, command)
  assert.equal(card.find('dshct-confirm-detail')!.props.tabIndex, 0)
  assert.equal(card.find('dshct-confirm-detail')!.props['aria-label'], 'guard.confirm.detail')
  assert.equal(card.find('dshct-confirm-reason')!.props.children, 'Review the full command')
  assert.equal(card.find('dshct-confirm-error')!.props.role, 'alert')
  assert.ok(card.elements.every(el => !el.props.autoFocus), 'new prompts must not steal typing focus onto approval')
  const buttons = card.findAll('dshct-confirm-btn')
  assert.equal(buttons[0]!.props['data-kind'], 'deny', 'deny precedes allow in keyboard order')
  for (const button of buttons) {
    assert.equal(button.tag, 'button')
    assert.equal(button.props.type, 'button')
    userClick(button)
  }
  assert.deepEqual(choices, ['deny', 'allow'])
})
