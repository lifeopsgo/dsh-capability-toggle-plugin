/**
 * The "@ session reference" kill switch.
 *
 * DSH's built-in `@` menu merges two candidate sources: file paths and historic
 * sessions. The session rows come from the host's `ui-reference` plugin, which
 * registers a source named `reference` on `ctx.inputTriggers`. That service keeps
 * its roster in `live.sources` and every open menu reads `source.candidates` at
 * fetch time, so wrapping that one function hides session rows without touching
 * the host package. The panel exposes the switch as a preference.
 *
 * @module dsh-capability-toggle-plugin/test/session-refs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { DEFAULT_PREFS, publishPrefs, readPrefs, subscribePrefs, writePrefs } from '../src/client/prefs.ts'
import { applySessionRefsPref, bindTriggerService, disableSessionReferences } from '../src/client/session-refs.ts'
import { available, renderPanel, userClick } from './render-harness.ts'

const PREFS_KEY = 'dsh-capability-toggle-plugin:panel-prefs'

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

const fileRow = { name: 'src/main.ts', description: '2 天前', icon: 'file', value: JSON.stringify({ kind: 'file', mention: '@src/main.ts' }) }
const sessionRow = { name: '昨天的排查', description: '3 小时前', icon: 'session', section: '对话', value: JSON.stringify({ kind: 'session', mention: '@session-1' }) }

function referenceService(rows: unknown[] = [fileRow, sessionRow]) {
  const calls: unknown[][] = []
  const source = {
    trigger: '@',
    name: 'reference',
    candidates: async (...args: unknown[]) => { calls.push(args); return rows },
  }
  return { service: { live: { sources: [source] } }, source, calls }
}

test('the pref defaults to keeping session references enabled', () => {
  assert.equal(DEFAULT_PREFS.disableSessionRefs, false)
})

test('a stored blob written before this pref existed keeps its other fields', () => {
  const storage = memoryStorage({
    [PREFS_KEY]: JSON.stringify({ showFraction: false, showUsage: true, levels: 'session' }),
  })
  assert.deepEqual(readPrefs(storage), {
    showFraction: false, showUsage: true, levels: 'session', disableSessionRefs: false,
  })
})

test('the pref round-trips through storage', () => {
  const storage = memoryStorage()
  writePrefs({ ...DEFAULT_PREFS, disableSessionRefs: true }, storage)
  assert.equal(readPrefs(storage).disableSessionRefs, true)
})

test('enabling the switch drops session rows and keeps file rows', async () => {
  const { service, source } = referenceService()
  const dispose = disableSessionReferences(service)
  assert.deepEqual(await source.candidates('s1', { query: '' }), [fileRow])
  dispose()
  assert.deepEqual(await source.candidates('s1', { query: '' }), [fileRow, sessionRow])
})

test('a session row is recognised by its value kind even without the icon', async () => {
  const bare = { name: '会话', value: JSON.stringify({ kind: 'session', mention: '@session-2' }) }
  const { service, source } = referenceService([fileRow, bare])
  const dispose = disableSessionReferences(service)
  assert.deepEqual(await source.candidates('s1', {}), [fileRow])
  dispose()
})

test('rows with an unreadable value survive the filter', async () => {
  const junk = { name: 'opaque', value: 'not json' }
  const missing = { name: 'no value' }
  const { service, source } = referenceService([fileRow, junk, missing])
  const dispose = disableSessionReferences(service)
  assert.deepEqual(await source.candidates('s1', {}), [fileRow, junk, missing])
  dispose()
})

test('two holders keep the filter until the last one releases', async () => {
  const { service, source } = referenceService()
  const first = disableSessionReferences(service)
  const second = disableSessionReferences(service)
  first()
  assert.deepEqual(await source.candidates('s1', {}), [fileRow], 'the surviving holder keeps the filter on')
  second()
  assert.deepEqual(await source.candidates('s1', {}), [fileRow, sessionRow])
})

test('a missing service or a foreign source is ignored', async () => {
  assert.doesNotThrow(() => disableSessionReferences(undefined)())
  assert.doesNotThrow(() => disableSessionReferences({})())
  const other = { trigger: '/', name: 'reference', candidates: async () => [sessionRow] }
  const service = { live: { sources: [other] } }
  const dispose = disableSessionReferences(service)
  assert.deepEqual(await other.candidates(), [sessionRow], 'only the @ reference source is touched')
  dispose()
})

test('the drawer carries a switch for the kill switch', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  const changes: { disableSessionRefs?: boolean }[] = []
  const props = {
    projection: { rows: [], projectKey: '/tmp/proj' },
    disabled: false,
    t: (key: string) => key,
    prefs: { ...DEFAULT_PREFS },
    onPrefsChange: (next: { disableSessionRefs?: boolean }) => { changes.push(next) },
    onSet() {},
    onSetMany() {},
  }
  const closed = await renderPanel(props)
  const opener = closed.find('dshct-pref-toggle')
  assert.ok(opener, 'the drawer toggle must render')
  userClick(opener)
  const opened = await renderPanel(props, true)
  const switches = opened.findAll('dshct-switch')
  assert.equal(switches.length, 3, 'three switches: fraction, usage, session references')
  const sessionSwitch = switches[2]!
  assert.equal(sessionSwitch.props['aria-checked'], false, 'the switch starts off')
  assert.equal(sessionSwitch.props['aria-labelledby'], 'dshct-pref-session-refs')
  userClick(sessionSwitch)
  assert.equal(changes.length, 1)
  assert.equal(changes[0]!.disableSessionRefs, true)
})

test('a candidate function the host replaced while the switch was on is left alone', async () => {
  const { service, source } = referenceService()
  const dispose = disableSessionReferences(service)
  const replacement = async () => [fileRow, sessionRow]
  source.candidates = replacement
  dispose()
  assert.equal(source.candidates, replacement, 'release must not clobber whatever is installed now')
})

test('the pref routes to the live trigger service and back', async () => {
  const { service, source } = referenceService()
  bindTriggerService(() => service)
  const dispose = applySessionRefsPref(true)
  assert.deepEqual(await source.candidates('s1', {}), [fileRow])
  dispose()
  assert.deepEqual(await source.candidates('s1', {}), [fileRow, sessionRow])

  const noop = applySessionRefsPref(false)
  assert.equal(typeof noop, 'function')
  assert.deepEqual(await source.candidates('s1', {}), [fileRow, sessionRow], 'the switch being off must not patch anything')
  noop()
})

test('a pref flip before the service exists changes nothing and never throws', async () => {
  bindTriggerService(() => undefined)
  const dispose = applySessionRefsPref(true)
  assert.doesNotThrow(() => dispose())
})

test('the installed host still keeps the trigger roster in live.sources', () => {
  const host = readFileSync(
    new URL('../node_modules/@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js', import.meta.url),
    'utf8',
  )
  assert.ok(host.includes('registerSource(src)'), 'the kill switch relies on registerSource keeping the source object')
  assert.ok(host.includes('live.sources.push(src)'), 'the kill switch walks live.sources to find the @ source')
  assert.ok(host.includes('super(ctx, "inputTriggers")'), 'the kill switch resolves the service as ctx.get("inputTriggers")')
})

test('the built client bundle ships the kill switch', () => {
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('disableSessionReferences'), 'shipped lib/client.js is stale: missing the filter — run pnpm build')
  assert.ok(bundle.includes('dshct-pref-session-refs'), 'shipped lib/client.js is stale: missing the drawer switch')
})

test('a malformed kill-switch value degrades to off without discarding the other fields', () => {
  const storage = memoryStorage({
    [PREFS_KEY]: JSON.stringify({ showFraction: false, showUsage: true, levels: 'all', disableSessionRefs: 'yes' }),
  })
  assert.deepEqual(readPrefs(storage), {
    showFraction: false, showUsage: true, levels: 'all', disableSessionRefs: false,
  })
})

test('a pref change reaches every control and the other tabs', () => {
  const listeners = new Map<string, ((event: { detail?: unknown; key?: string | null }) => void)[]>()
  const fakeWindow = {
    dispatchEvent(event: { type: string; detail?: unknown }) {
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    },
    addEventListener(type: string, listener: (event: { detail?: unknown; key?: string | null }) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    removeEventListener(type: string, listener: (event: { detail?: unknown; key?: string | null }) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== listener))
    },
  }
  const realWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = fakeWindow
  try {
    const storage = memoryStorage()
    const seen: unknown[] = []
    const stop = subscribePrefs(next => { seen.push(next) })
    const next = { ...DEFAULT_PREFS, disableSessionRefs: true }
    publishPrefs(next, storage)
    assert.deepEqual(seen, [next], 'a local publish reaches a sibling control')
    assert.equal(readPrefs(storage).disableSessionRefs, true, 'publish still persists')

    storage.setItem(PREFS_KEY, JSON.stringify(next))
    fakeWindow.dispatchEvent({ type: 'storage', key: PREFS_KEY })
    assert.equal(seen.length, 2, 'another tab writing the key reaches the listener')

    stop()
    publishPrefs({ ...next, disableSessionRefs: false }, storage)
    assert.equal(seen.length, 2, 'the unsubscribed listener stops receiving')
  } finally {
    ;(globalThis as { window?: unknown }).window = realWindow
  }
})
