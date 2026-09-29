import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  mergeLegacyOverrides,
  parseLegacyOverrides,
  parseLegacyOverridesResult,
} from '../src/host/legacy-migration.ts'

test('imports all legacy override levels when the Loader document is empty', () => {
  const migrated = mergeLegacyOverrides(
    { global: {}, projects: {}, sessions: {} },
    {
      global: { 'skill:example': 'off' },
      projects: { '/workspace': { 'mcp:example': 'off' } },
      sessions: { 'session-1': { 'tool:example': 'off' } },
    },
  )

  assert.deepEqual(migrated, {
    global: { 'skill:example': 'off' },
    projects: { '/workspace': { 'mcp:example': 'off' } },
    sessions: { 'session-1': { 'tool:example': 'off' } },
  })
})

test('merges unimported legacy levels while keeping newer explicit stances authoritative', () => {
  const migrated = mergeLegacyOverrides(
    {
      global: { 'skill:current': 'off', 'skill:shared': 'on' },
      projects: { '/current': { 'mcp:current': 'off' } },
      sessions: {},
    },
    {
      global: { 'skill:legacy': 'off', 'skill:shared': 'off' },
      projects: { '/workspace': { 'mcp:legacy': 'off' } },
      sessions: { 'session-1': { 'tool:legacy': 'off' } },
    },
  )

  assert.deepEqual(migrated, {
    global: { 'skill:current': 'off', 'skill:shared': 'on', 'skill:legacy': 'off' },
    projects: {
      '/current': { 'mcp:current': 'off' },
      '/workspace': { 'mcp:legacy': 'off' },
    },
    sessions: { 'session-1': { 'tool:legacy': 'off' } },
  })
})

test('preserves valid legacy levels when a separate legacy bucket is malformed', () => {
  assert.deepEqual(
    parseLegacyOverridesResult('capability-toggle:\n  global:\n    skill:keep: off\n  projects:\n    /stale:\n      mcp:obsolete: inherit\n  sessions:\n    session-1:\n      tool:keep: off'),
    {
      status: 'available',
      value: {
        global: { 'skill:keep': 'off' },
        projects: {},
        sessions: { 'session-1': { 'tool:keep': 'off' } },
      },
    },
  )
})

test('distinguishes unavailable legacy data from an invalid legacy source', () => {
  assert.deepEqual(parseLegacyOverridesResult('other-plugin: {}'), { status: 'unavailable' })
  assert.deepEqual(parseLegacyOverridesResult('capability-toggle: disabled'), { status: 'invalid' })
  assert.deepEqual(parseLegacyOverridesResult('capability-toggle: \n  global: disabled'), { status: 'invalid' })
  assert.deepEqual(parseLegacyOverridesResult('capability-toggle:\n  global:\n    skill:example: inherit\n  projects: {}\n  sessions: {}'), { status: 'invalid' })
  assert.deepEqual(parseLegacyOverridesResult('capability-toggle: ['), { status: 'invalid' })
  assert.equal(parseLegacyOverrides('other-plugin: {}'), undefined)
  assert.equal(parseLegacyOverrides('capability-toggle: disabled'), undefined)
  assert.equal(parseLegacyOverrides('capability-toggle: ['), undefined)
})

test('accepts legacy data that omits unused override levels', () => {
  assert.deepEqual(
    parseLegacyOverridesResult('capability-toggle:\n  global:\n    skill:example: off'),
    { status: 'available', value: { global: { 'skill:example': 'off' }, projects: {}, sessions: {} } },
  )
})

test('does not resurrect legacy overrides after every new level is intentionally cleared', () => {
  const migrated = mergeLegacyOverrides(
    { global: {}, projects: {}, sessions: {} },
    { global: { 'skill:legacy': 'off' }, projects: {}, sessions: {} },
    true,
  )

  assert.deepEqual(migrated, { global: {}, projects: {}, sessions: {} })
})

function migrationHarness(completed = false) {
  const configEditor = {
    edits: 0,
    value: { global: {}, projects: {}, sessions: {}, legacyMigrationCompleted: completed } as Record<string, unknown>,
    entries: () => [{ id: 'include:dsh-capability-toggle-plugin', options: { id: 'dsh-capability-toggle-plugin' } }],
    async edit(_entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) {
      this.edits += 1
      this.value = change(this.value, {})
    },
  }
  const config = {
    global: { get: () => configEditor.value.global as Record<string, 'on' | 'off'> },
    projects: { get: () => configEditor.value.projects as Record<string, Record<string, 'on' | 'off'>> },
    sessions: { get: () => configEditor.value.sessions as Record<string, Record<string, 'on' | 'off'>> },
    legacyMigrationCompleted: { get: () => configEditor.value.legacyMigrationCompleted === true },
  }
  return { configEditor, config }
}

test('serves legacy overrides immediately while persistence is still pending', async () => {
  const { OverrideStore } = await import('../src/host/store.ts')
  const { configEditor, config } = migrationHarness()
  const legacy = { global: { 'skill:legacy': 'off' }, projects: {}, sessions: {} }
  const store = new OverrideStore({ configEditor } as never, config as never, legacy)

  assert.deepEqual(store.read(), legacy)
})

test('atomically migrates legacy values once and persists the completion marker', async () => {
  const { OverrideStore } = await import('../src/host/store.ts')
  const { configEditor, config } = migrationHarness()
  const legacy = { global: { 'skill:legacy': 'off' }, projects: {}, sessions: {} }
  const store = new OverrideStore({ configEditor } as never, config as never, legacy)

  assert.equal(await store.migrateLegacy(), true)
  assert.deepEqual(configEditor.value, {
    global: { 'skill:legacy': 'off' }, projects: {}, sessions: {}, legacyMigrationCompleted: true,
  })
  await store.set({ level: 'global' }, 'skill:legacy', 'inherit')
  assert.equal(await store.migrateLegacy(), false)
  assert.deepEqual(configEditor.value, {
    global: {}, projects: {}, sessions: {}, legacyMigrationCompleted: true,
  })
})

test('a first user clear finalizes migration without resurrecting the legacy stance', async () => {
  const { OverrideStore } = await import('../src/host/store.ts')
  const { configEditor, config } = migrationHarness()
  const legacy = { global: { 'skill:legacy': 'off' }, projects: {}, sessions: {} }
  const store = new OverrideStore({ configEditor } as never, config as never, legacy)

  await store.set({ level: 'global' }, 'skill:legacy', 'inherit')

  assert.deepEqual(configEditor.value, {
    global: {}, projects: {}, sessions: {}, legacyMigrationCompleted: true,
  })
  assert.equal(await store.migrateLegacy(), false)
  assert.deepEqual(configEditor.value, {
    global: {}, projects: {}, sessions: {}, legacyMigrationCompleted: true,
  })
})

test('does not rewrite the profile after the completion marker is live', async () => {
  const { OverrideStore } = await import('../src/host/store.ts')
  const { configEditor, config } = migrationHarness(true)
  const store = new OverrideStore({ configEditor } as never, config as never)

  assert.equal(await store.migrateLegacy({ global: { 'skill:legacy': 'off' }, projects: {}, sessions: {} }), false)
  assert.equal(configEditor.edits, 0)
})
