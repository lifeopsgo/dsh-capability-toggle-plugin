/**
 * Render-level tests for the capability popup. These mount the real component
 * through ./render-harness.ts — no DOM and no react-dom, which the repo does not
 * depend on — so a locked or unwired control fails here rather than only in a
 * browser session.
 *
 * @module dsh-capability-toggle-plugin/test/panel-render
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { available, DisabledControl, renderPanel, userClick, userType } from './render-harness.ts'

function skillRow(id: string, name: string, session: 'on' | 'off' | 'inherit' = 'inherit') {
  return {
    id: `skill:${id}`, name, description: '', kind: 'skill',
    disabled: false, levels: { session, project: 'inherit', global: 'inherit' },
  }
}

function panelProps(running: boolean, rows = [skillRow('alpha', 'alpha'), skillRow('beta', 'beta')]) {
  return {
    projection: { rows, projectKey: '/tmp/proj' },
    disabled: running,
    t: (key: string, params?: Record<string, unknown>) =>
      (params ? `${key}:${JSON.stringify(params)}` : key),
    prefs: { showFraction: true, showUsage: true, levels: 'all' },
    onPrefsChange() {},
    onSet() {},
    onSetMany() {},
  }
}

async function openSearch(props: unknown) {
  const mounted = await renderPanel(props)
  const toggle = mounted.find('dshct-search-toggle')
  assert.ok(toggle, 'the search toggle must render')
  userClick(toggle)
  const opened = await renderPanel(props, true)
  const input = opened.find('dshct-search-input')
  assert.ok(input, 'clicking the search toggle must reveal the input')
  return { mounted, opened, toggle, input }
}

test('the search input stays usable while the agent runs', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  // The running lock exists because a stance write cannot be applied mid-turn.
  // The search box is a local filter that never touches the wire, so locking it
  // only strands the user: the toggle stays clickable, the input appears, and
  // then refuses keystrokes.
  const { input } = await openSearch(panelProps(true))
  assert.notEqual(input.props.disabled, true, 'search input must not be disabled while running')
})

test('the search toggle is clickable while the agent runs', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  const { toggle } = await openSearch(panelProps(true))
  assert.notEqual(toggle.props.disabled, true)
})

test('typing in the search box while running actually filters the rows', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  const props = panelProps(true)
  const { opened, input } = await openSearch(props)
  assert.equal(opened.findAll('dshct-row').length, 2, 'both rows before filtering')

  // userType goes through the DOM contract the harness models: a disabled
  // control never fires the handler, so this fails while the bug is present
  // instead of silently passing by calling onChange past the lock.
  userType(input, 'alpha')
  const typed = await renderPanel(props, true)
  const rows = typed.findAll('dshct-row')
  assert.equal(rows.length, 1, 'one row after typing')
  const names = typed.findAll('dshct-row-text').map(el => el.props.children ?? el.props.title)
  assert.deepEqual(names, ['alpha'])
})

test('the harness refuses user events on a disabled control', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  // Pins the harness contract the filtering tests above depend on. Driving it
  // through the live input would be circular: the fix leaves that control
  // enabled, so a `disabled === true` branch here would never execute. Feeding a
  // locked element directly is what proves a re-locked search box would fail the
  // typing test with DisabledControl instead of silently passing.
  const locked = { tag: 'input', path: 'probe', props: { className: 'probe', disabled: true, onChange() {}, onClick() {} } }
  assert.throws(() => userType(locked, 'alpha'), DisabledControl)
  assert.throws(() => userClick(locked), DisabledControl)

  let calls = 0
  const open = { tag: 'input', path: 'probe', props: { className: 'probe', disabled: false, onChange: () => { calls += 1 }, onClick: () => { calls += 1 } } }
  userType(open, 'alpha')
  userClick(open)
  assert.equal(calls, 2, 'an enabled control dispatches both handlers')
})

test('the search input keeps filtering while the agent is idle', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  const props = panelProps(false)
  const { input } = await openSearch(props)
  assert.notEqual(input.props.disabled, true)
  userType(input, 'beta')
  const typed = await renderPanel(props, true)
  assert.equal(typed.findAll('dshct-row').length, 1)
})

test('the running lock still holds on every control that writes a stance', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  // Guard against over-correcting: un-locking the search box must not leak into
  // the switches, the clear badges, or the bulk menus, because those reach the
  // Host and the plugin contract applies stances only while the agent is idle.
  // The rows carry an explicit session stance so the clear badge renders too —
  // it only appears for a level that is actually set.
  const props = panelProps(true, [skillRow('alpha', 'alpha', 'on'), skillRow('beta', 'beta', 'off')])
  const { opened } = await openSearch(props)

  const switches = opened.findAll('dshct-lvsw-main')
  assert.ok(switches.length > 0, 'level switches must render')
  for (const sw of switches) assert.equal(sw.props.disabled, true, 'level switch must stay locked while running')

  const clears = opened.findAll('dshct-lvsw-clear')
  assert.ok(clears.length > 0)
  for (const c of clears) assert.equal(c.props.disabled, true, 'clear badge must stay locked while running')

  const bulks = opened.findAll('dshct-bulk-btn')
  assert.ok(bulks.length > 0)
  for (const b of bulks) assert.equal(b.props.disabled, true, 'bulk menu must stay locked while running')
})

test('a projection refresh keeps the typed query and re-filters', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  // index.tsx reloads the projection when `running` flips while the popup is
  // open, which is exactly when this bug bit. Panel carries no key, so the
  // refresh re-renders the same instance: the query must survive it rather than
  // resetting to an empty filter and re-showing every row.
  const running = panelProps(true)
  const { input } = await openSearch(running)
  userType(input, 'alpha')
  assert.equal((await renderPanel(running, true)).findAll('dshct-row').length, 1)

  const refreshed = panelProps(false, [skillRow('alpha2', 'alpha'), skillRow('gamma', 'gamma')])
  const after = await renderPanel(refreshed, true)
  assert.equal(after.find('dshct-search-input')?.props.value, 'alpha', 'query survives the refresh')
  const names = after.findAll('dshct-row-text').map(el => el.props.children ?? el.props.title)
  assert.deepEqual(names, ['alpha'], 'the refreshed rows are filtered by the surviving query')
})

test('the same controls unlock when the agent is idle', { skip: !available && 'needs the React 18 dispatcher' }, async () => {
  const props = panelProps(false)
  const { opened } = await openSearch(props)
  const switches = opened.findAll('dshct-lvsw-main')
  assert.ok(switches.length > 0)
  for (const sw of switches) assert.equal(sw.props.disabled, false, 'level switch must unlock when idle')
})

test('the render harness actually renders, so the tests above cannot skip silently', async () => {
  // Deliberately the one test with NO skip guard. Every other test here skips
  // when the React 18 dispatcher is gone, which a React 19 bump would do — and a
  // suite reporting 0 failed / 8 skipped reads as green while covering nothing.
  // Failing here turns that silent coverage loss into a loud one.
  assert.equal(available, true,
    'the hook dispatcher this harness installs is missing: React dropped '
    + '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher. '
    + 'Port test/render-harness.ts to the new React, or these render tests will '
    + 'skip and stop protecting the panel.')

  const rendered = await renderPanel(panelProps(false))
  assert.ok(rendered.elements.length > 0, 'rendering the panel must produce elements')
  assert.ok(rendered.findAll('dshct-row').length > 0, 'the fixture rows must render')
  assert.ok(rendered.find('dshct-search-toggle') !== undefined, 'the search toggle must render')
})
