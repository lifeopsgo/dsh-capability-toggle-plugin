import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OverrideStore } from '../src/host/store.ts'

const root = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the host binds agents immediately from the synchronous legacy fallback', () => {
  const index = root('src/index.ts')
  assert.match(index, /readLegacyOverridesSyncResult/)
  assert.match(index, /const legacy = readLegacyOverridesSyncResult\(\)/)
  assert.match(index, /legacy\.status === 'available' \? legacy\.value : undefined/)
  assert.match(index, /ctx\.effect\(\(\) => installHttp\(ctx, store, registry, center\)/)
  assert.match(index, /for \(const agent of ctx\.agents\.list\(\)\) void bindAgent\(agent, 'existing agent'\)/)
  assert.match(index, /const bindAgent = async \(agent: Parameters<typeof registry\.add>\[0\], source: string\): Promise<undefined> =>/)
  assert.match(index, /ctx\.on\('agent\/created', \(\{ agent \}\) => bindAgent\(agent, 'created agent'\)\)/)
  assert.match(index, /void store\.migrateLegacy\(\)\.catch\(/)
  assert.match(index, /ctx\.on\('loader\/volatile-update', \(\) => \{\s*void registry\.reconcileAll\(\)\.catch\(/s)
  assert.match(index, /capability-toggle failed to bind \$\{source\}/)
  assert.match(index, /capability-toggle failed to reconcile volatile override update/)
  assert.doesNotMatch(index, /agent\/session-start/)
})

test('the override store persists through the 0.2 config editor seam', () => {
  const store = root('src/host/store.ts')
  assert.match(store, /@deepseek-ai\/dsh-config-editor/)
  assert.match(store, /\.configEditor\.edit\(/)
  assert.doesNotMatch(store, /@deepseek-ai\/dsh-settings/)
})

test('the bundle declares a default config for persistent overrides', () => {
  const patch = root('cordis.patch.yml')
  assert.match(patch, /config:\s*\{\s*global:\s*\{\},\s*projects:\s*\{\},\s*sessions:\s*\{\}\s*\}/)
})

test('all override roots are volatile so writes preserve the active plugin instance', () => {
  const config = root('src/host/config.ts')
  for (const field of ['global', 'projects', 'sessions']) {
    assert.match(config, new RegExp(`${field}:.*\\.volatile\\(\\)`))
  }
})

test('the config editor store reads the volatile document after it commits a write', async () => {
  const configEditor = {
    entries: () => [{ id: 'include:dsh-capability-toggle-plugin', options: { id: 'dsh-capability-toggle-plugin' } }],
    async edit(_entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) {
      this.value = change(this.value, {})
    },
    value: { global: {}, projects: {}, sessions: {} } as Record<string, unknown>,
  }
  const current = () => configEditor.value as {
    global: Record<string, 'on' | 'off'>
    projects: Record<string, Record<string, 'on' | 'off'>>
    sessions: Record<string, Record<string, 'on' | 'off'>>
  }
  const store = new OverrideStore({ configEditor } as never, {
    global: { get: () => current().global },
    projects: { get: () => current().projects },
    sessions: { get: () => current().sessions },
  } as never)
  await store.set({ level: 'global' }, 'tool:bash', 'off')
  assert.deepEqual(store.read().global, { 'tool:bash': 'off' })
})

test('concurrent config-editor writes merge against the latest locked document', async () => {
  const configEditor = {
    entries: () => [{ id: 'include:dsh-capability-toggle-plugin', options: { id: 'dsh-capability-toggle-plugin' } }],
    value: { global: {}, projects: {}, sessions: {} } as Record<string, unknown>,
    lock: Promise.resolve(),
    async edit(_entry: unknown, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) {
      const previous = this.lock
      let release: () => void = () => {}
      this.lock = new Promise<void>(resolve => { release = resolve })
      await previous
      try {
        this.value = change(this.value, {})
      } finally {
        release()
      }
    },
  }
  const current = () => configEditor.value as {
    global: Record<string, 'on' | 'off'>
    projects: Record<string, Record<string, 'on' | 'off'>>
    sessions: Record<string, Record<string, 'on' | 'off'>>
  }
  const store = new OverrideStore({ configEditor } as never, {
    global: { get: () => current().global },
    projects: { get: () => current().projects },
    sessions: { get: () => current().sessions },
  } as never)
  await Promise.all([
    store.set({ level: 'global' }, 'tool:bash', 'off'),
    store.set({ level: 'global' }, 'tool:pwsh', 'off'),
  ])
  assert.deepEqual(current().global, { 'tool:bash': 'off', 'tool:pwsh': 'off' })
})

test('all framework peers target the verified DSH 0.2 release candidates', () => {
  const pkg = JSON.parse(root('package.json')) as {
    peerDependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  // Every RC the plugin is verified against (0.2.0-rc.1 and 0.2.1-rc.2 per the
  // README table, 0.2.1-rc.5 verified against the live tree), one shared range so
  // no peer resolves a second framework copy.
  const RANGE = '0.2.0-rc.1 || 0.2.1-rc.2 || 0.2.1-rc.5'
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, RANGE, `${name} peer range`)
  }
  for (const [name, version] of Object.entries(pkg.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, '0.2.1-rc.5', `${name} dev version`)
  }
  assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '~4.0.4')
  // The dev pin mirrors the real 0.2.1-rc.5 runtime (its framework packages
  // peer-require cordis ~4.0.5 and schemastery ~3.18.5), so `pnpm peers check`
  // stays clean here; the cordis PEER range stays ~4.0.4 because it must also
  // admit an 0.2.0-rc.1 runtime (which peer-requires only ~4.0.4).
  assert.equal(pkg.devDependencies['@deepseek-ai/cordis'], '4.0.5')
})

test('the lockfile agrees with package.json so CI frozen installs cannot drift', () => {
  const pkg = JSON.parse(root('package.json')) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  // CI installs with `pnpm install --frozen-lockfile`: pnpm hard-fails there
  // when the importers section disagrees with package.json. Catching the
  // drift in the local suite names the culprit before CI does — the failure
  // mode is "edit deps, forget to re-run pnpm install".
  const lock = root('pnpm-lock.yaml')
  const importers = lock.slice(lock.indexOf('importers:'), lock.indexOf('packages:'))
  const lines = importers.split('\n')
  const specifierFor = (name: string): string | undefined => {
    for (let i = 0; i < lines.length - 1; i++) {
      const key = lines[i].trim()
      if (key === `'${name}':` || key === `${name}:`) {
        const m = /^ {8}specifier: (.+)$/.exec(lines[i + 1])
        if (m) return m[1].trim()
      }
    }
    return undefined
  }
  for (const [name, specifier] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.equal(specifierFor(name), specifier,
      `pnpm-lock.yaml importer for ${name} must pin specifier ${specifier} (re-run pnpm install)`)
  }
})
