/**
 * Text-selection contract for the capability popup.
 *
 * The host mounts this plugin's control inside the composer card, whose own
 * `mousedown` handler calls `preventDefault()` on any non-control text to keep
 * the draft editor focused. That makes a drag inside the popup unable to start
 * a native selection, so the user cannot copy a skill name or description. The
 * host publishes one escape hatch for exactly this case — a target matching
 * `[data-composer-overlay]` is skipped — and the popup must opt into it.
 *
 * The stylesheet half of the contract covers the elements the host handler
 * cannot help with: Chromium refuses to START a selection inside a button, so a
 * press that begins on a tab, an MCP row, or a guard button needs an explicit
 * `user-select:text`. A selection that starts elsewhere already includes such a
 * label, which is why the rule only matters for presses that begin there.
 *
 * Because those labels are also controls, a drag that ends on one still fires
 * its `click`. The guard in `drag-guard.ts` drops that click for the drag only.
 *
 * @module dsh-capability-toggle-plugin/test/panel-selection
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { available, renderConfirmationCard, renderPanel } from './render-harness.ts'

/** Capture the stylesheet `injectStyles` writes, without a real DOM. */
async function injectedCss(): Promise<string> {
  interface FakeTag { dataset: Record<string, string>; textContent: string; remove(): void }
  const created: FakeTag[] = []
  const realDocument = (globalThis as { document?: unknown }).document
  ;(globalThis as { document?: unknown }).document = {
    querySelector: () => null,
    createElement: () => {
      const tag: FakeTag = { dataset: {}, textContent: '', remove() {} }
      created.push(tag)
      return tag
    },
    head: { appendChild() {} },
  }
  try {
    const { injectStyles } = await import('../src/client/styles.ts')
    const dispose = injectStyles()
    const css = created[0]?.textContent ?? ''
    dispose()
    return css
  } finally {
    ;(globalThis as { document?: unknown }).document = realDocument
  }
}

test('the popup opts out of the composer mousedown that cancels selection', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  const mounted = await renderPanel({
    projection: { rows: [], projectKey: '/tmp/proj' },
    disabled: false,
    t: (key: string) => key,
    prefs: { showFraction: true, showUsage: true, levels: 'all', disableSessionRefs: false },
    onPrefsChange() {},
    onSet() {},
    onSetMany() {},
  })
  const panel = mounted.find('dshct-panel')
  assert.ok(panel, 'the panel root must render')
  assert.equal(panel.props['data-composer-overlay'], '', 'the panel must carry the host escape hatch attribute')
})

test('the blocking-guard card opts out of the composer mousedown too', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  const card = await renderConfirmationCard({
    guardId: 'guard:dangerous-shell', guardAction: 'ask', reason: 'why', toolName: 'bash',
    detail: 'ls', busy: false, t: (key: string) => key, onAnswer() {},
  })
  const root = card.find('dshct-confirm')
  assert.ok(root, 'the card root must render')
  assert.equal(root.props['data-composer-overlay'], '', 'the card must carry the host escape hatch attribute')
})

interface FakePointerEvent {
  clientX: number
  clientY: number
  detail: number
  target: unknown
  stopped: boolean
  stopPropagation(): void
}

/** A document that records capture-phase listeners and lets a test fire them. */
function fakeDocument(): { doc: Document; emit: (type: string, event: FakePointerEvent) => void; count: () => number } {
  const listeners = new Map<string, ((event: FakePointerEvent) => void)[]>()
  const doc = {
    addEventListener(type: string, handler: (event: FakePointerEvent) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    },
    removeEventListener(type: string, handler: (event: FakePointerEvent) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== handler))
    },
  }
  return {
    doc: doc as unknown as Document,
    emit(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event)
    },
    count() {
      return [...listeners.values()].reduce((total, entries) => total + entries.length, 0)
    },
  }
}

function pointer(x: number, y: number, inPopup: boolean, detail = 1): FakePointerEvent {
  return {
    clientX: x, clientY: y, detail, stopped: false,
    target: { closest: (selector: string) => (inPopup && selector === '.dshct-panel,.dshct-confirm' ? {} : null) },
    stopPropagation() { this.stopped = true },
  }
}

test('a press and release that travel between pixels is a drag, a jitter is not', async () => {
  const { isSelectionDrag, SELECTION_DRAG_THRESHOLD_PX } = await import('../src/client/drag-guard.ts')
  assert.equal(isSelectionDrag({ x: 10, y: 10 }, { x: 10, y: 10 }), false)
  assert.equal(isSelectionDrag({ x: 10, y: 10 }, { x: 12, y: 11 }), false, 'a 2px wobble stays a click')
  assert.equal(isSelectionDrag({ x: 10, y: 10 }, { x: 10 + SELECTION_DRAG_THRESHOLD_PX + 1, y: 10 }), true)
})

test('a drag that ends on a popup control does not also fire the control', async () => {
  const { installSelectionClickGuard } = await import('../src/client/drag-guard.ts')
  const fake = fakeDocument()
  const dispose = installSelectionClickGuard(fake.doc)
  const down = pointer(40, 40, true)
  const up = pointer(120, 90, true)
  fake.emit('mousedown', down)
  fake.emit('mousemove', pointer(80, 60, true))
  fake.emit('mousemove', pointer(120, 90, true))
  fake.emit('click', up)
  assert.equal(up.stopped, true, 'the click that follows a selection drag must not reach the control')
  dispose()
})

test('a drag that swings out and returns to the press point still suppresses the click', async () => {
  const { installSelectionClickGuard } = await import('../src/client/drag-guard.ts')
  const fake = fakeDocument()
  const dispose = installSelectionClickGuard(fake.doc)
  fake.emit('mousedown', pointer(40, 40, true))
  fake.emit('mousemove', pointer(160, 120, true))
  const up = pointer(41, 40, true)
  fake.emit('click', up)
  assert.equal(up.stopped, true, 'a selection that returns near the press point is still a drag')
  dispose()
})

test('a plain click on a popup control still works', async () => {
  const { installSelectionClickGuard } = await import('../src/client/drag-guard.ts')
  const fake = fakeDocument()
  const dispose = installSelectionClickGuard(fake.doc)
  const down = pointer(40, 40, true)
  const up = pointer(41, 40, true)
  fake.emit('mousedown', down)
  fake.emit('click', up)
  assert.equal(up.stopped, false)
  dispose()
})

test('a keyboard activation is never treated as a drag', async () => {
  const { installSelectionClickGuard } = await import('../src/client/drag-guard.ts')
  const fake = fakeDocument()
  const dispose = installSelectionClickGuard(fake.doc)
  fake.emit('mousedown', pointer(40, 40, true))
  const entered = pointer(0, 0, true, 0)
  fake.emit('click', entered)
  assert.equal(entered.stopped, false, 'Enter/Space on a focused control reports detail 0 and no pointer position')
  dispose()
})

test('a drag that ends outside the popup leaves the click alone', async () => {
  const { installSelectionClickGuard } = await import('../src/client/drag-guard.ts')
  const fake = fakeDocument()
  const dispose = installSelectionClickGuard(fake.doc)
  fake.emit('mousedown', pointer(40, 40, true))
  const up = pointer(400, 300, false)
  fake.emit('click', up)
  assert.equal(up.stopped, false)
  dispose()
})

test('the guard removes every listener on dispose', async () => {
  const { installSelectionClickGuard } = await import('../src/client/drag-guard.ts')
  const fake = fakeDocument()
  const dispose = installSelectionClickGuard(fake.doc)
  assert.equal(fake.count(), 3)
  dispose()
  assert.equal(fake.count(), 0)
})

test('the stylesheet makes popup text selectable, including button labels', async () => {
  const css = await injectedCss()
  assert.match(css, /\.dshct-overlay,\.dshct-panel,\.dshct-confirm\{[^}]*user-select:text/, 'popup surfaces must set user-select:text')
  assert.match(css, /\.dshct-panel button[^{]*\{[^}]*user-select:text/, 'popup buttons must set user-select:text')
  assert.match(css, /-webkit-user-select:text/, 'WebKit needs the prefixed property')
  assert.ok(!/user-select:none/.test(css), 'no popup rule may opt out of selection')
})

test('the built client bundle carries the same selection contract', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('data-composer-overlay'), 'the shipped bundle must mark the popup roots')
  assert.ok(bundle.includes('.dshct-panel,.dshct-confirm{user-select:text'), 'the shipped bundle must ship the selectable rule')
  assert.ok(bundle.includes('-webkit-user-select:text'), 'the shipped bundle must ship the WebKit prefix')
})

test('the installed host still exempts [data-composer-overlay] from its composer mousedown', () => {
  const host = readFileSync(
    new URL('../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', import.meta.url),
    'utf8',
  )
  assert.ok(
    host.includes('closest("[data-composer-overlay]")'),
    'the popup relies on this host escape hatch; if the host renamed it, the selection fix silently regresses',
  )
})

test('a press that drifts past the threshold counts as a drag, not a click', async () => {
  const { installSelectionClickGuard } = await import('../src/client/drag-guard.ts')
  const fake = fakeDocument()
  const dispose = installSelectionClickGuard(fake.doc)
  fake.emit('mousedown', pointer(40, 40, true))
  fake.emit('mousemove', pointer(47, 40, true))
  const up = pointer(47, 40, true)
  fake.emit('click', up)
  assert.equal(up.stopped, true)
  dispose()
})
