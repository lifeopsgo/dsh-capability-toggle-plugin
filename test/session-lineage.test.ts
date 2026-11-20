/**
 * Session-level stances follow a session's subagent children.
 *
 * A subagent runs as its own session, so before this change a capability the
 * user switched on at the session level for the parent (with project and global
 * left unset) came back enabled for the child and unreachable from the panel —
 * the child was restricted by project/global only, never by the session it was
 * spawned from. The chain is read root-first so the child's own entries still
 * win over an ancestor's, and a cycle cannot hang the walk.
 *
 * @module dsh-capability-toggle-plugin/test/session-lineage
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { mergeSessionStances, sessionChain } from '../src/host/lineage.ts'
import { OverrideStore } from '../src/host/store.ts'

test('a root session is its own chain', () => {
  assert.deepEqual(sessionChain(new Map(), 'root'), ['root'])
})

test('a subagent chain runs from the root down to the child', () => {
  const parentOf = new Map([['child', 'root']])
  assert.deepEqual(sessionChain(parentOf, 'child'), ['root', 'child'])
})

test('nested subagents keep every ancestor, root first', () => {
  const parentOf = new Map([
    ['mid', 'root'],
    ['leaf', 'mid'],
  ])
  assert.deepEqual(sessionChain(parentOf, 'leaf'), ['root', 'mid', 'leaf'])
})

test('the walk stops at the last link the registry knows', () => {
  const parentOf = new Map([['leaf', 'mid']])
  assert.deepEqual(sessionChain(parentOf, 'leaf'), ['mid', 'leaf'])
})

test('a cycle cannot hang the walk', () => {
  const parentOf = new Map([
    ['a', 'b'],
    ['b', 'a'],
  ])
  assert.deepEqual(sessionChain(parentOf, 'a'), ['b', 'a'])
})

test('the nearest level wins when chain entries collide', () => {
  const merged = mergeSessionStances([
    { 'tool:bash': 'on', 'tool:grep': 'off' },
    { 'tool:bash': 'off' },
  ])
  assert.deepEqual(merged, { 'tool:bash': 'off', 'tool:grep': 'off' })
})

test('a child with no entries inherits the whole parent session layer', () => {
  assert.deepEqual(mergeSessionStances([{ 'tool:bash': 'off' }, undefined]), { 'tool:bash': 'off' })
})

test('a subagent panel shows its own session entries while the effect follows the chain', async () => {
  const { buildProjection } = await import('../src/shared/resolve.ts')
  const config = {
    global: { get: () => ({}) },
    projects: { get: () => ({}) },
    sessions: { get: () => ({ root: { 'tool:bash': 'off' as const } }) },
    legacyMigrationCompleted: { get: () => true },
  }
  const store = new OverrideStore({ configEditor: {} } as never, config as never)
  const overrides = store.layeredChain('', sessionChain(new Map([['child', 'root']]), 'child'))
  const row = buildProjection([{ id: 'tool:bash', name: 'bash', description: '', kind: 'tool' }], overrides, '').rows[0]!
  assert.equal(row.levels.session, 'inherit', "the child's own session cell stays unset")
  assert.equal(row.disabled, true, 'the inherited stance still disables the capability')
})

test('the store resolves a session chain against the stored document', async () => {
  const config = {
    global: { get: () => ({}) },
    projects: { get: () => ({}) },
    sessions: {
      get: () => ({
        root: { 'tool:bash': 'off' as const, 'skill:lark-doc': 'off' as const },
        child: { 'tool:bash': 'on' as const },
      }),
    },
    legacyMigrationCompleted: { get: () => true },
  }
  const store = new OverrideStore({ configEditor: {} } as never, config as never)

  const child = store.layeredChain('', sessionChain(new Map([['child', 'root']]), 'child'))
  assert.equal(child.session['skill:lark-doc'], 'off', 'the child inherits what the parent switched off')
  assert.equal(child.session['tool:bash'], 'on', "the child's own entry wins")

  const alone = store.layeredChain('', ['child'])
  assert.deepEqual(alone.session, { 'tool:bash': 'on' }, 'a child with no known parent reads only its own entries')
})

test('the binding reads the chain instead of the bare session id', async () => {
  const { readFileSync } = await import('node:fs')
  const built = readFileSync(new URL('../src/host/agent-binding.ts', import.meta.url), 'utf8')
  // Read as text: AgentBinding's constructor uses parameter properties, which
  // Node's strip-only loader rejects on import, and a text assertion is immune
  // to a stale or hand-edited lib/.
  for (const method of ['disabledSet(descriptors:', 'installGuards(): void', 'installCapabilityGate(): void', 'projection(descriptors:']) {
    const at = built.indexOf(method)
    assert.ok(at !== -1, `missing ${method} in the binding source`)
    const body = built.slice(at, at + 900)
    assert.ok(body.includes('this.sessionChain()'), `${method} must resolve over the chain, not this.sessionKey`)
  }
  const controller = readFileSync(new URL('../src/host/controller.ts', import.meta.url), 'utf8')
  assert.ok(
    controller.includes("origin === 'subagent'"),
    'the registry must record a parent link only for sessions classified as subagents',
  )
})
