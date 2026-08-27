/**
 * Pure-logic tests for the correctness-critical seams: three-level resolution
 * priority, and the disabled-id -> concrete-name mappers the Host applies to the
 * tool and skill seams. These run under Node's native type stripping
 * (`node --test`), with no build step and no framework runtime, because the
 * logic under test is deliberately dependency-free.
 *
 * @module dsh-capability-toggle-plugin/test/pure
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  resolveStance, isDisabled, isGuardActive, disabledIds, buildProjection,
} from '../src/shared/resolve.ts'
import {
  GUARD_IDS, applyGuards, collectGuards, evaluateGuards, guardId,
} from '../src/host/guards.ts'
import {
  deniedToolNames, disabledSkillNames, disabledToolGuidanceSections,
} from '../src/host/inventory.ts'
import { applyPromptGates, collectPromptGates } from '../src/host/prompt.ts'
import { APPROVAL_GATE_ID, applyApprovalGate, collectApprovalGate } from '../src/host/approval.ts'
import { writeMap } from '../src/host/store.ts'
import { parseSetBody } from '../src/host/http.ts'
import { SCOPE_IDENTITY_DRIFT_KEY, scopeIdentityDrift } from '../src/host/self-check.ts'
import type { LayeredOverrides, CapabilityDescriptor } from '../src/shared/types.ts'

/** Build a LayeredOverrides from partial per-level maps. */
function layered(
  session: Record<string, 'on' | 'off'> = {},
  project: Record<string, 'on' | 'off'> = {},
  global: Record<string, 'on' | 'off'> = {},
): LayeredOverrides {
  return { session, project, global }
}

test('default with no override resolves to on', () => {
  assert.equal(resolveStance(layered(), 'tool:x'), 'on')
  assert.equal(isDisabled(layered(), 'tool:x'), false)
})

test('a single explicit off at any level disables', () => {
  assert.equal(resolveStance(layered({ 'tool:x': 'off' }), 'tool:x'), 'off')
  assert.equal(resolveStance(layered({}, { 'tool:x': 'off' }), 'tool:x'), 'off')
  assert.equal(resolveStance(layered({}, {}, { 'tool:x': 'off' }), 'tool:x'), 'off')
})

test('session beats project beats global', () => {
  // session on overrides project off
  assert.equal(resolveStance(layered({ 'tool:x': 'on' }, { 'tool:x': 'off' }), 'tool:x'), 'on')
  // project off overrides global on (session silent)
  assert.equal(resolveStance(layered({}, { 'tool:x': 'off' }, { 'tool:x': 'on' }), 'tool:x'), 'off')
  // session off wins over everything
  assert.equal(
    resolveStance(layered({ 'tool:x': 'off' }, { 'tool:x': 'on' }, { 'tool:x': 'on' }), 'tool:x'),
    'off',
  )
})

test('inherit (silence) at a level falls through to the next', () => {
  // session silent, project on, global off -> project wins -> on
  assert.equal(resolveStance(layered({}, { 'tool:x': 'on' }, { 'tool:x': 'off' }), 'tool:x'), 'on')
})

test('disabledIds keeps input order and only listed ids', () => {
  const ov = layered({ 'tool:a': 'off', 'tool:c': 'off' })
  assert.deepEqual(disabledIds(ov, ['tool:a', 'tool:b', 'tool:c']), ['tool:a', 'tool:c'])
  // a stored stance for an id not in the universe is inert
  assert.deepEqual(disabledIds(ov, ['tool:b']), [])
})

const inventory: readonly CapabilityDescriptor[] = [
  { id: 'skill:research', name: 'research', description: '', kind: 'skill' },
  { id: 'skill:draft', name: 'draft', description: '', kind: 'skill' },
  { id: 'tool:web_search', name: 'web_search', description: '', kind: 'tool' },
  { id: 'tool:bash', name: 'bash', description: '', kind: 'tool' },
  {
    id: 'mcp:github',
    name: 'github',
    description: '',
    kind: 'mcp',
    memberTools: [
      { name: 'mcp__github__create_issue', description: 'Open an issue' },
      { name: 'mcp__github__list_repos', description: 'List repositories' },
    ],
  },
]

test('deniedToolNames maps a disabled plain tool to its own name', () => {
  const denied = deniedToolNames(inventory, new Set(['tool:bash']))
  assert.deepEqual(denied, ['bash'])
})

test('deniedToolNames expands a disabled mcp group to all member tools', () => {
  const denied = deniedToolNames(inventory, new Set(['mcp:github']))
  assert.deepEqual(denied.sort(), ['mcp__github__create_issue', 'mcp__github__list_repos'])
})

test('deniedToolNames ignores disabled skills (they use the shadow seam)', () => {
  const denied = deniedToolNames(inventory, new Set(['skill:research']))
  assert.deepEqual(denied, [])
})

test('deniedToolNames combines plain + mcp, still skipping skills', () => {
  const denied = deniedToolNames(
    inventory,
    new Set(['tool:web_search', 'mcp:github', 'skill:draft']),
  ).sort()
  assert.deepEqual(denied, [
    'mcp__github__create_issue',
    'mcp__github__list_repos',
    'web_search',
  ])
})

test('disabledToolGuidanceSections maps only disabled plain tools to tool:<name>', () => {
  // a disabled plain tool -> its guidance section name
  assert.deepEqual(
    disabledToolGuidanceSections(inventory, new Set(['tool:bash'])),
    ['tool:bash'],
  )
  // skills and mcp groups contribute no guidance section here
  assert.deepEqual(
    disabledToolGuidanceSections(inventory, new Set(['skill:research', 'mcp:github'])),
    [],
  )
  // combined: only the plain tool qualifies
  assert.deepEqual(
    disabledToolGuidanceSections(
      inventory,
      new Set(['tool:web_search', 'mcp:github', 'skill:draft']),
    ),
    ['tool:web_search'],
  )
})

test('disabledSkillNames returns only disabled skill names', () => {
  assert.deepEqual(
    disabledSkillNames(inventory, new Set(['skill:research', 'tool:bash'])),
    ['research'],
  )
  assert.deepEqual(disabledSkillNames(inventory, new Set(['skill:research', 'skill:draft'])).sort(), [
    'draft',
    'research',
  ])
})

// --- prompt-gate application dispatch ---------------------------------------

/**
 * A fake `systemPrompt` service that records the shape of every gate applied,
 * so the dispatch logic (which id -> section vs context vs suppressor) can be
 * asserted without a live harness. Each method returns a distinct disposer.
 */
function fakeScopedCtx(): {
  ctx: Parameters<typeof applyPromptGates>[0]
  calls: Array<{ fn: string; name?: string; order?: number; text?: string }>
} {
  const calls: Array<{ fn: string; name?: string; order?: number; text?: string }> = []
  const system = {
    section(s: { name: string; order: number; text: string }): () => void {
      calls.push({ fn: 'section', name: s.name, order: s.order, text: s.text })
      return () => {}
    },
    context(c: { name: string; order: number; text: string }): () => void {
      calls.push({ fn: 'context', name: c.name, order: c.order, text: c.text })
      return () => {}
    },
    suppressRuntimeContext(): () => void {
      calls.push({ fn: 'suppress' })
      return () => {}
    },
  }
  const ctx = { get: (name: string) => (name === 'systemPrompt' ? system : undefined) }
  return { ctx: ctx as unknown as Parameters<typeof applyPromptGates>[0], calls }
}

const promptInventory: readonly CapabilityDescriptor[] = [
  { id: 'prompt:section:deployment:persona', name: 'persona', description: 'deployment:persona', kind: 'prompt' },
  { id: 'prompt:context:sandbox:policy', name: 'sandbox', description: 'sandbox:policy', kind: 'prompt' },
  { id: 'prompt:runtime', name: 'runtime', description: '', kind: 'prompt' },
]

test('applyPromptGates shadows a disabled section with empty text at its order', () => {
  const { ctx, calls } = fakeScopedCtx()
  const disposers = applyPromptGates(ctx, promptInventory, new Set(['prompt:section:deployment:persona']))
  assert.equal(disposers.length, 1)
  assert.deepEqual(calls, [{ fn: 'section', name: 'deployment:persona', order: 0, text: '' }])
})

test('applyPromptGates shadows a disabled context with empty text', () => {
  const { ctx, calls } = fakeScopedCtx()
  applyPromptGates(ctx, promptInventory, new Set(['prompt:context:sandbox:policy']))
  assert.deepEqual(calls, [{ fn: 'context', name: 'sandbox:policy', order: 100, text: '' }])
})

test('applyPromptGates calls suppressRuntimeContext for the coarse switch', () => {
  const { ctx, calls } = fakeScopedCtx()
  applyPromptGates(ctx, promptInventory, new Set(['prompt:runtime']))
  assert.deepEqual(calls, [{ fn: 'suppress' }])
})

test('applyPromptGates ignores enabled (non-disabled) prompt gates', () => {
  const { ctx, calls } = fakeScopedCtx()
  const disposers = applyPromptGates(ctx, promptInventory, new Set())
  assert.equal(disposers.length, 0)
  assert.deepEqual(calls, [])
})

test('applyPromptGates applies every disabled gate together', () => {
  const { ctx, calls } = fakeScopedCtx()
  const disposers = applyPromptGates(
    ctx,
    promptInventory,
    new Set(['prompt:section:deployment:persona', 'prompt:context:sandbox:policy', 'prompt:runtime']),
  )
  assert.equal(disposers.length, 3)
  assert.deepEqual(calls.map(c => c.fn).sort(), ['context', 'section', 'suppress'])
})

// --- applyPromptGates id-parsing edge cases (M3) ----------------------------

test('applyPromptGates falls back to order 0 for a section id with no matching spec', () => {
  const { ctx, calls } = fakeScopedCtx()
  const rows: readonly CapabilityDescriptor[] = [
    { id: 'prompt:section:unknown:thing', name: 'x', description: 'unknown:thing', kind: 'prompt' },
  ]
  const disposers = applyPromptGates(ctx, rows, new Set(['prompt:section:unknown:thing']))
  assert.equal(disposers.length, 1)
  // registryName is everything after the prefix; order defaults to 0 (no spec).
  assert.deepEqual(calls, [{ fn: 'section', name: 'unknown:thing', order: 0, text: '' }])
})

test('applyPromptGates falls back to order 100 for a context id with no matching spec', () => {
  const { ctx, calls } = fakeScopedCtx()
  const rows: readonly CapabilityDescriptor[] = [
    { id: 'prompt:context:unknown:ctx', name: 'x', description: 'unknown:ctx', kind: 'prompt' },
  ]
  applyPromptGates(ctx, rows, new Set(['prompt:context:unknown:ctx']))
  assert.deepEqual(calls, [{ fn: 'context', name: 'unknown:ctx', order: 100, text: '' }])
})

test('applyPromptGates installs nothing for a prompt id matching no known prefix', () => {
  const { ctx, calls } = fakeScopedCtx()
  const rows: readonly CapabilityDescriptor[] = [
    { id: 'prompt:bogus', name: 'x', description: '', kind: 'prompt' },
  ]
  const disposers = applyPromptGates(ctx, rows, new Set(['prompt:bogus']))
  assert.equal(disposers.length, 0)
  assert.deepEqual(calls, [])
})

test('applyPromptGates returns no disposers when systemPrompt is unavailable', () => {
  const noSystem = { get: () => undefined } as unknown as Parameters<typeof applyPromptGates>[0]
  const disposers = applyPromptGates(noSystem, promptInventory, new Set(['prompt:runtime']))
  assert.equal(disposers.length, 0)
})

// --- store writeMap (H4) ----------------------------------------------------

test('writeMap stores an explicit on/off stance', () => {
  assert.deepEqual(writeMap({}, 'tool:x', 'off'), { 'tool:x': 'off' })
  assert.deepEqual(writeMap({ 'tool:x': 'off' }, 'tool:x', 'on'), { 'tool:x': 'on' })
})

test('writeMap deletes the key on an inherit write', () => {
  assert.deepEqual(writeMap({ 'tool:x': 'off', 'tool:y': 'on' }, 'tool:x', 'inherit'), { 'tool:y': 'on' })
  // deleting the only key yields an empty map (the caller drops the bucket)
  assert.deepEqual(writeMap({ 'tool:x': 'off' }, 'tool:x', 'inherit'), {})
})

test('writeMap does not mutate its input', () => {
  const input = { 'tool:x': 'off' as const }
  const out = writeMap(input, 'tool:y', 'on')
  assert.deepEqual(input, { 'tool:x': 'off' })
  assert.deepEqual(out, { 'tool:x': 'off', 'tool:y': 'on' })
})

// --- collectPromptGates probe (H4) ------------------------------------------

/**
 * A fake context whose `systemPrompt.assemble()` returns a canned set of active
 * section/context names, so the probe's allowlist filtering can be asserted
 * without a live harness. Passing `undefined` models a missing service.
 */
function fakeProbeCtx(
  sections: readonly string[],
  contexts: readonly string[],
  hasService = true,
): Parameters<typeof collectPromptGates>[0] {
  const system = {
    assemble: async () => ({
      sections: sections.map(name => ({ name })),
      contexts: contexts.map(name => ({ name })),
    }),
  }
  const ctx = { get: (n: string) => (hasService && n === 'systemPrompt' ? system : undefined) }
  return ctx as unknown as Parameters<typeof collectPromptGates>[0]
}

test('collectPromptGates returns [] with no scope', async () => {
  const rows = await collectPromptGates(fakeProbeCtx(['deployment:persona'], []), undefined)
  assert.deepEqual(rows, [])
})

test('collectPromptGates returns [] when systemPrompt is unavailable', async () => {
  const rows = await collectPromptGates(fakeProbeCtx([], [], false), 'scope-1' as never)
  assert.deepEqual(rows, [])
})

test('collectPromptGates offers only allowlisted names that the assembly actually has', async () => {
  // persona present as a section, sandbox present as a context, approval absent.
  const rows = await collectPromptGates(
    fakeProbeCtx(['deployment:persona', 'harness:identity'], ['sandbox:policy']),
    'scope-1' as never,
  )
  const ids = rows.map(r => r.id)
  assert.ok(ids.includes('prompt:section:deployment:persona'))
  assert.ok(ids.includes('prompt:context:sandbox:policy'))
  // approval:policy was not in the assembly -> no switch for it
  assert.ok(!ids.includes('prompt:context:approval:policy'))
  // harness:identity is not in the allowlist -> never offered
  assert.ok(!ids.some(id => id.includes('harness:identity')))
})

test('collectPromptGates always appends the coarse runtime suppressor when scoped', async () => {
  const rows = await collectPromptGates(fakeProbeCtx([], []), 'scope-1' as never)
  // nothing allowlisted is present, but the suppressor is always offered
  assert.deepEqual(rows.map(r => r.id), ['prompt:runtime'])
  assert.equal(rows[0]?.kind, 'prompt')
})

// --- parseSetBody validation (M4) -------------------------------------------

test('parseSetBody accepts a well-formed body', () => {
  const body = parseSetBody({ session: 's1', level: 'session', id: 'tool:x', state: 'off' })
  assert.deepEqual(body, { session: 's1', level: 'session', id: 'tool:x', state: 'off' })
})

test('parseSetBody accepts each valid level and state', () => {
  for (const level of ['session', 'project', 'global']) {
    for (const state of ['on', 'off', 'inherit']) {
      const body = parseSetBody({ session: 's', level, id: 'tool:x', state })
      assert.equal(body.level, level)
      assert.equal(body.state, state)
    }
  }
})

test('parseSetBody rejects a non-object body', () => {
  assert.throws(() => parseSetBody(null), /object/)
  assert.throws(() => parseSetBody('nope'), /object/)
})

test('parseSetBody rejects a missing or empty session', () => {
  assert.throws(() => parseSetBody({ level: 'session', id: 'tool:x', state: 'off' }), /session/)
  assert.throws(() => parseSetBody({ session: '', level: 'session', id: 'tool:x', state: 'off' }), /session/)
})

test('parseSetBody rejects an unknown level', () => {
  assert.throws(() => parseSetBody({ session: 's', level: 'workspace', id: 'tool:x', state: 'off' }), /level/)
})

test('parseSetBody rejects an empty id', () => {
  assert.throws(() => parseSetBody({ session: 's', level: 'global', id: '', state: 'off' }), /id/)
})

test('parseSetBody rejects an invalid state', () => {
  assert.throws(() => parseSetBody({ session: 's', level: 'global', id: 'tool:x', state: 'maybe' }), /state/)
})

// --- approval gate (5th capability family) ----------------------------------

/**
 * Fake context for the approval probe/enforcement. `hasApproval` toggles
 * whether `ctx.get('approval', false)` resolves a service; `onCalls` records
 * every `ctx.on(event, …)` registration and each returns a tagged disposer.
 */
function fakeApprovalCtx(hasApproval: boolean): {
  ctx: Parameters<typeof applyApprovalGate>[0]
  onCalls: string[]
  disposed: number
} {
  const onCalls: string[] = []
  const state = { disposed: 0 }
  const ctx = {
    get: (name: string, _strict?: boolean) =>
      (hasApproval && name === 'approval' ? {} : undefined),
    on: (event: string, _listener: unknown) => {
      onCalls.push(event)
      return () => { state.disposed += 1 }
    },
  }
  return {
    ctx: ctx as unknown as Parameters<typeof applyApprovalGate>[0],
    onCalls,
    get disposed() { return state.disposed },
  }
}

test('collectApprovalGate offers one approval row when the service is present', () => {
  const rows = collectApprovalGate(fakeApprovalCtx(true).ctx as never)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.id, APPROVAL_GATE_ID)
  assert.equal(rows[0]?.kind, 'approval')
})

test('collectApprovalGate offers nothing when the approval service is absent', () => {
  const rows = collectApprovalGate(fakeApprovalCtx(false).ctx as never)
  assert.deepEqual(rows, [])
})

test('applyApprovalGate installs an approval/request listener when the gate is off', () => {
  const f = fakeApprovalCtx(true)
  const disposers = applyApprovalGate(f.ctx, new Set([APPROVAL_GATE_ID]))
  assert.equal(disposers.length, 1)
  assert.deepEqual(f.onCalls, ['approval/request'])
})

test('applyApprovalGate installs nothing when the gate is on (not disabled)', () => {
  const f = fakeApprovalCtx(true)
  const disposers = applyApprovalGate(f.ctx, new Set())
  assert.equal(disposers.length, 0)
  assert.deepEqual(f.onCalls, [])
})

test('applyApprovalGate installs nothing when the approval service is absent', () => {
  const f = fakeApprovalCtx(false)
  const disposers = applyApprovalGate(f.ctx, new Set([APPROVAL_GATE_ID]))
  assert.equal(disposers.length, 0)
  assert.deepEqual(f.onCalls, [])
})

test('applyApprovalGate listener resolves to rejected (the escalation lock)', async () => {
  const captured: Array<(...a: unknown[]) => Promise<unknown>> = []
  const ctx = {
    get: (name: string) => (name === 'approval' ? {} : undefined),
    on: (_event: string, listener: (...a: unknown[]) => Promise<unknown>) => {
      captured.push(listener)
      return () => {}
    },
  } as unknown as Parameters<typeof applyApprovalGate>[0]
  applyApprovalGate(ctx, new Set([APPROVAL_GATE_ID]))
  assert.equal(captured.length, 1)
  const outcome = await captured[0]!({}, () => Promise.resolve('allowed-once'))
  assert.equal(outcome, 'rejected')
})

// --- guard presets (6th capability family, tools/pre-execute) ---------------

/** All shipped guard ids as an active set. */
const ALL_GUARDS = new Set(GUARD_IDS)

test('isGuardActive defaults OFF (opt-in) when every level is silent', () => {
  // Opposite of isDisabled: a silent guard is inactive, not active.
  assert.equal(isGuardActive(layered(), guardId('readonly')), false)
})

test('isGuardActive activates only on an explicit merged on', () => {
  assert.equal(isGuardActive(layered({ [guardId('readonly')]: 'on' }), guardId('readonly')), true)
  assert.equal(isGuardActive(layered({ [guardId('readonly')]: 'off' }), guardId('readonly')), false)
})

test('resolveStance off-fallback keeps a silent guard off; on-fallback keeps others on', () => {
  assert.equal(resolveStance(layered(), 'guard:x', 'off'), 'off')
  assert.equal(resolveStance(layered(), 'tool:x', 'on'), 'on')
})

test('collectGuards offers one row per preset, all kind=guard with an action', () => {
  const rows = collectGuards()
  assert.equal(rows.length, GUARD_IDS.length)
  for (const r of rows) {
    assert.equal(r.kind, 'guard')
    assert.ok(r.guardAction === 'deny' || r.guardAction === 'ask')
  }
})

test('evaluateGuards returns null when no guard is active (allow)', () => {
  assert.equal(evaluateGuards(new Set(), 'write', { file_path: 'a.txt' }), null)
})

test('readonly guard denies file-mutating tools when active', () => {
  const active = new Set([guardId('readonly')])
  for (const name of ['write', 'create', 'edit', 'str_replace_editor']) {
    const hit = evaluateGuards(active, name, { file_path: 'x' })
    assert.equal(hit?.id, guardId('readonly'))
    assert.equal(hit?.decision.kind, 'deny')
  }
})

test('readonly guard leaves reads and ordinary bash alone', () => {
  const active = new Set([guardId('readonly')])
  assert.equal(evaluateGuards(active, 'read', { file_path: 'x' }), null)
  assert.equal(evaluateGuards(active, 'bash', { command: 'ls' }), null)
  assert.equal(evaluateGuards(active, 'bash', { command: 'cat file.txt' }), null)
})

test('readonly guard also denies the canonical in-place shell writers', () => {
  const active = new Set([guardId('readonly')])
  for (const command of ['tee out.txt', 'sed -i s/a/b/ f.txt', 'dd if=/dev/zero of=disk.img']) {
    const hit = evaluateGuards(active, 'bash', { command })
    assert.equal(hit?.id, guardId('readonly'), command)
    assert.equal(hit?.decision.kind, 'deny', command)
  }
})

test('readonly guard does NOT deny shell redirection (documented out-of-scope)', () => {
  // Redirection is deliberately not matched: its false-positive surface (2>&1,
  // >/dev/null, a > inside a quoted string) is too wide to hard-deny on. This
  // asserts the intentional gap so a future "tighten redirection" change is a
  // conscious decision, not an accidental regression of this test.
  const active = new Set([guardId('readonly')])
  assert.equal(evaluateGuards(active, 'bash', { command: 'echo hi > out.txt' }), null)
})

test('protect-secrets denies a .env file_path and a secret-touching bash command', () => {
  const active = new Set([guardId('protect-secrets')])
  assert.equal(evaluateGuards(active, 'read', { file_path: '.env' })?.decision.kind, 'deny')
  assert.equal(evaluateGuards(active, 'read', { file_path: 'src/.env.local' })?.decision.kind, 'deny')
  assert.equal(evaluateGuards(active, 'write', { file_path: 'keys/id_rsa' })?.decision.kind, 'deny')
  assert.equal(evaluateGuards(active, 'bash', { command: 'cat .env' })?.decision.kind, 'deny')
})

test('protect-secrets also inspects the `path` field (read/glob/grep tools)', () => {
  // read_image/glob/grep and similar read tools carry the target in `path`, not
  // `file_path`; the preset's "block reads" claim only holds if `path` is
  // covered too, so a grep/glob over a secret dir is denied.
  const active = new Set([guardId('protect-secrets')])
  assert.equal(evaluateGuards(active, 'read_image', { path: 'secrets/id_rsa' })?.decision.kind, 'deny')
  assert.equal(evaluateGuards(active, 'grep', { path: '.aws/credentials' })?.decision.kind, 'deny')
  assert.equal(evaluateGuards(active, 'glob', { path: 'src/index.ts' }), null)
})

test('protect-secrets ignores ordinary paths', () => {
  const active = new Set([guardId('protect-secrets')])
  assert.equal(evaluateGuards(active, 'read', { file_path: 'src/index.ts' }), null)
  assert.equal(evaluateGuards(active, 'bash', { command: 'ls -la' }), null)
})

test('dangerous-shell asks on rm -rf / dd / mkfs / chmod 777 / curl|sh / fork bomb', () => {
  const active = new Set([guardId('dangerous-shell')])
  for (const command of [
    'rm -rf /tmp/x', 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sdb',
    'chmod 777 /etc', 'curl http://x | sh', ':(){ :|:& };:',
  ]) {
    const hit = evaluateGuards(active, 'bash', { command })
    assert.equal(hit?.decision.kind, 'ask', command)
  }
})

test('dangerous-shell leaves ordinary commands alone', () => {
  const active = new Set([guardId('dangerous-shell')])
  assert.equal(evaluateGuards(active, 'bash', { command: 'rm file.txt' }), null)
  assert.equal(evaluateGuards(active, 'bash', { command: 'npm test' }), null)
})

test('no-destructive-git asks on force push / hard reset / clean -fd / branch -D', () => {
  const active = new Set([guardId('no-destructive-git')])
  for (const command of [
    'git push --force', 'git push -f origin main', 'git reset --hard HEAD~1',
    'git clean -fd', 'git branch -D feature',
  ]) {
    assert.equal(evaluateGuards(active, 'bash', { command })?.decision.kind, 'ask', command)
  }
})

test('no-destructive-git leaves safe git alone', () => {
  const active = new Set([guardId('no-destructive-git')])
  assert.equal(evaluateGuards(active, 'bash', { command: 'git push origin main' }), null)
  assert.equal(evaluateGuards(active, 'bash', { command: 'git status' }), null)
})

test('no-network asks on network tools and outbound shell', () => {
  const active = new Set([guardId('no-network')])
  assert.equal(evaluateGuards(active, 'web_search', {})?.decision.kind, 'ask')
  assert.equal(evaluateGuards(active, 'read_page', { url: 'http://x' })?.decision.kind, 'ask')
  assert.equal(evaluateGuards(active, 'bash', { command: 'curl http://x' })?.decision.kind, 'ask')
  assert.equal(evaluateGuards(active, 'bash', { command: 'npm publish' })?.decision.kind, 'ask')
})

test('deny wins over ask when both match one call', () => {
  // A secret-touching rm -rf matches both protect-secrets (deny) and
  // dangerous-shell (ask); the deny preset precedes the ask preset, so deny wins.
  const active = new Set([guardId('protect-secrets'), guardId('dangerous-shell')])
  const hit = evaluateGuards(active, 'bash', { command: 'rm -rf .env' })
  assert.equal(hit?.id, guardId('protect-secrets'))
  assert.equal(hit?.decision.kind, 'deny')
})

test('an inactive preset never matches even if its predicate would', () => {
  // readonly not in the active set: a write passes through.
  assert.equal(evaluateGuards(new Set([guardId('no-network')]), 'write', { file_path: 'x' }), null)
})

test('evaluateGuards normalizes a non-object arguments value to {}', () => {
  const active = new Set([guardId('dangerous-shell')])
  // null/undefined/string args must not throw; they simply match nothing here.
  assert.equal(evaluateGuards(active, 'bash', null), null)
  assert.equal(evaluateGuards(active, 'bash', undefined), null)
  assert.equal(evaluateGuards(active, 'bash', 'rm -rf /'), null)
})

/**
 * Fake scoped context for applyGuards: records `tools/pre-execute` registration
 * (event + prepend flag) and exposes the captured listener for direct calling.
 */
function fakeGuardCtx(): {
  ctx: Parameters<typeof applyGuards>[0]
  onCalls: Array<{ event: string; prepend: boolean }>
  listener: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null
} {
  const rec: {
    onCalls: Array<{ event: string; prepend: boolean }>
    listener: ((exec: unknown, next: () => Promise<unknown>) => Promise<unknown>) | null
  } = { onCalls: [], listener: null }
  const ctx = {
    on: (event: string, listener: (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>, opts?: { prepend?: boolean }) => {
      rec.onCalls.push({ event, prepend: opts?.prepend === true })
      rec.listener = listener
      return () => {}
    },
  }
  return {
    ctx: ctx as unknown as Parameters<typeof applyGuards>[0],
    get onCalls() { return rec.onCalls },
    get listener() { return rec.listener },
  }
}

test('applyGuards installs nothing when no guard is active', () => {
  const f = fakeGuardCtx()
  const disposers = applyGuards(f.ctx, new Set(), () => {})
  assert.equal(disposers.length, 0)
  assert.deepEqual(f.onCalls, [])
})

test('applyGuards installs one prepended tools/pre-execute listener when active', () => {
  const f = fakeGuardCtx()
  const disposers = applyGuards(f.ctx, ALL_GUARDS, () => {})
  assert.equal(disposers.length, 1)
  assert.equal(f.onCalls.length, 1)
  assert.equal(f.onCalls[0]?.event, 'tools/pre-execute')
  assert.equal(f.onCalls[0]?.prepend, true)
})

test('applyGuards listener denies a matching call, counts the hit, and returns the decision', async () => {
  const f = fakeGuardCtx()
  const hits: string[] = []
  applyGuards(f.ctx, new Set([guardId('readonly')]), id => hits.push(id))
  const nextCalls = { n: 0 }
  const decision = await f.listener!(
    { name: 'write', arguments: { file_path: 'x' } },
    () => { nextCalls.n += 1; return Promise.resolve({ kind: 'allow' }) },
  )
  assert.deepEqual(hits, [guardId('readonly')])
  assert.equal(nextCalls.n, 0) // matched → did not call next()
  assert.equal((decision as { kind: string }).kind, 'deny')
})

test('applyGuards listener passes a non-matching call through via next()', async () => {
  const f = fakeGuardCtx()
  const hits: string[] = []
  applyGuards(f.ctx, new Set([guardId('readonly')]), id => hits.push(id))
  const nextCalls = { n: 0 }
  const decision = await f.listener!(
    { name: 'read', arguments: { file_path: 'x' } },
    () => { nextCalls.n += 1; return Promise.resolve({ kind: 'allow' }) },
  )
  assert.deepEqual(hits, []) // no match → no hit counted
  assert.equal(nextCalls.n, 1) // delegated to next()
  assert.equal((decision as { kind: string }).kind, 'allow')
})

// ---- Hardening: locale key parity (C10) ----

test('zh and en dictionaries have identical key sets', async () => {
  const { dictionaries } = await import('../src/client/locales.ts')
  const zhKeys = Object.keys(dictionaries.zh).sort()
  const enKeys = Object.keys(dictionaries.en).sort()
  const zhOnly = zhKeys.filter(k => !(k in dictionaries.en))
  const enOnly = enKeys.filter(k => !(k in dictionaries.zh))
  assert.deepEqual(zhOnly, [], `keys only in zh: ${zhOnly.join(', ')}`)
  assert.deepEqual(enOnly, [], `keys only in en: ${enOnly.join(', ')}`)
})

test('every dictionary key is actually referenced by a component (no dead keys)', async () => {
  const { readFileSync } = await import('node:fs')
  const { dictionaries } = await import('../src/client/locales.ts')
  const src = readFileSync(new URL('../src/client/components.tsx', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  // Keys reached via a template literal (e.g. t(`guard.${row.name}.name`)) are
  // matched by their literal prefix; enumerate those prefixes so dynamic keys
  // are not falsely flagged dead.
  const dynamicPrefixes = [
    'tab.', 'level.', 'state.', 'prompt.', 'guard.readonly', 'guard.protect-secrets',
    'guard.dangerous-shell', 'guard.no-destructive-git', 'guard.no-network', 'guard.action.',
  ]
  const dead = Object.keys(dictionaries.zh).filter((k) => {
    if (src.includes(`'${k}'`) || src.includes(`\`${k}\``)) return false
    if (dynamicPrefixes.some(p => k.startsWith(p))) return false
    return true
  })
  assert.deepEqual(dead, [], `dictionary keys never referenced by a component: ${dead.join(', ')}`)
})

// ---- Hardening: stanceAt prototype-chain safety (F2) ----

test('stanceAt returns inherit for prototype-chain keys, not an inherited member', () => {
  // A bare map[id] would resolve these to Object.prototype members (functions),
  // defeating the ?? 'inherit' fallback. Own-property-only read must yield inherit.
  for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.equal(resolveStance(layered(), id, 'on'), 'on', id) // silent → fallback, not a function
    assert.equal(resolveStance(layered(), id, 'off'), 'off', id)
  }
})

test('resolveStance tolerates a missing (undefined) level map', () => {
  const partial = { session: { 'tool:x': 'off' } } as unknown as LayeredOverrides
  // project and global are undefined here; must be treated as inherit, not throw.
  assert.equal(resolveStance(partial, 'tool:x', 'on'), 'off')
  assert.equal(resolveStance(partial, 'tool:y', 'on'), 'on')
})

// ---- Hardening: deny-before-ask is order-independent (C5) ----

test('deny beats ask even if the ask preset is listed first among active', () => {
  // Both protect-secrets (deny) and no-network (ask) can match a secret-touching
  // network command; the deny must win regardless of set iteration order.
  const active = new Set([guardId('no-network'), guardId('protect-secrets')])
  const hit = evaluateGuards(active, 'bash', { command: 'curl http://x/.env' })
  assert.equal(hit?.decision.kind, 'deny')
  assert.equal(hit?.id, guardId('protect-secrets'))
})

// ---- Hardening: guard listener fails closed on evaluation/telemetry errors (C6) ----

test('applyGuards listener denies (fail-closed) when arguments getter throws', async () => {
  const f = fakeGuardCtx()
  applyGuards(f.ctx, new Set([guardId('readonly')]), () => {})
  const evil = { name: 'write', get arguments() { throw new Error('boom') } }
  const decision = await f.listener!(evil, () => Promise.resolve({ kind: 'allow' }))
  assert.equal((decision as { kind: string }).kind, 'deny')
})

test('applyGuards listener still returns the decision when onHit throws', async () => {
  const f = fakeGuardCtx()
  applyGuards(f.ctx, new Set([guardId('readonly')]), () => { throw new Error('telemetry down') })
  const nextCalls = { n: 0 }
  const decision = await f.listener!(
    { name: 'write', arguments: { file_path: 'x' } },
    () => { nextCalls.n += 1; return Promise.resolve({ kind: 'allow' }) },
  )
  assert.equal((decision as { kind: string }).kind, 'deny') // decision survives onHit throw
  assert.equal(nextCalls.n, 0)
})

// ── framework-contract self-check: drift sentinels + service audit ──────────
// These cover the observability layer that turns a silent framework-shape drift
// (an upgraded surface returning an unexpected shape) into a warn-once alarm,
// and the required-service audit that flags an inject-contract move. They add
// no enforcement behavior; they exist so an upgrade regression is visible.

import { collectInventory } from '../src/host/inventory.ts'
import {
  FRAMEWORK_CONTRACT, checkRequiredServices, emitContractBanner, makeWarnOnce,
} from '../src/host/self-check.ts'

/** A fake logger recording calls per severity. */
function fakeLogger(): {
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug: (m: string) => void }
  calls: { info: string[]; warn: string[]; error: string[]; debug: string[] }
} {
  const calls = { info: [] as string[], warn: [] as string[], error: [] as string[], debug: [] as string[] }
  return {
    calls,
    logger: {
      info: m => calls.info.push(m),
      warn: m => calls.warn.push(m),
      error: m => calls.error.push(m),
      debug: m => calls.debug.push(m),
    },
  }
}

/**
 * A fake Context exposing just `logger` and a `get(name, strict)` presence probe
 * backed by a provided service-name set. Enough surface for the self-check and
 * the inventory drift path; cast at the call site to the tool's Context param.
 */
function fakeCtx(present: Set<string>, tools?: unknown, skills?: unknown): {
  ctx: Parameters<typeof checkRequiredServices>[0]
  calls: ReturnType<typeof fakeLogger>['calls']
} {
  const { logger, calls } = fakeLogger()
  const ctx = {
    logger,
    get: (name: string, _strict: boolean) => (present.has(name) ? {} : undefined),
    tools,
    skills,
  }
  return { ctx: ctx as unknown as Parameters<typeof checkRequiredServices>[0], calls }
}

test('emitContractBanner logs one info line naming the enforcement events', () => {
  const { ctx, calls } = fakeCtx(new Set())
  emitContractBanner(ctx)
  assert.equal(calls.info.length, 1)
  for (const event of FRAMEWORK_CONTRACT.enforcementEvents) {
    assert.ok(calls.info[0].includes(event), `banner should name ${event}`)
  }
  assert.ok(calls.info[0].includes(FRAMEWORK_CONTRACT.scopeRoutingKey))
})

test('emitContractBanner names agent/disposed as the memory-reclaim dependency', () => {
  // agent/disposed is the ONLY path that drops a per-agent binding from the
  // live map; if an upgrade renames it, bindings leak with no runtime error, so
  // the banner must name it (and the contract must carry it) for upgrade audits.
  assert.ok(FRAMEWORK_CONTRACT.lifecycleEvents.includes('agent/disposed'))
  const { ctx, calls } = fakeCtx(new Set())
  emitContractBanner(ctx)
  assert.ok(calls.info[0].includes('agent/disposed'), 'banner should name agent/disposed')
})

test('checkRequiredServices returns [] and stays quiet when all present', () => {
  const { ctx, calls } = fakeCtx(new Set(FRAMEWORK_CONTRACT.requiredServices))
  assert.deepEqual(checkRequiredServices(ctx), [])
  assert.equal(calls.error.length, 0)
})

test('checkRequiredServices names the missing services and logs error', () => {
  const present = new Set(FRAMEWORK_CONTRACT.requiredServices.filter(n => n !== 'skills'))
  const { ctx, calls } = fakeCtx(present)
  assert.deepEqual(checkRequiredServices(ctx), ['skills'])
  assert.equal(calls.error.length, 1)
  assert.ok(calls.error[0].includes('skills'))
})

test('makeWarnOnce logs each distinct key once, dropping repeats', () => {
  const { logger, calls } = fakeLogger()
  const warnOnce = makeWarnOnce({ logger } as unknown as Parameters<typeof makeWarnOnce>[0])
  warnOnce('k1', 'first')
  warnOnce('k1', 'first again')
  warnOnce('k2', 'second')
  assert.deepEqual(calls.warn, ['first', 'second'])
})

test('collectInventory alarms and yields empty when skills.snapshot has no array', async () => {
  const drifts: string[] = []
  const ctx = fakeCtx(
    new Set(),
    { schemas: () => [] },
    { snapshot: () => Promise.resolve({}) }, // no `skills` array
  ).ctx
  const rows = await collectInventory(ctx, undefined, key => drifts.push(key))
  assert.ok(drifts.includes('skills.snapshot.shape'))
  assert.equal(rows.filter(r => r.kind === 'skill').length, 0)
})

test('collectInventory alarms and yields empty tools when schemas() is not iterable', async () => {
  const drifts: string[] = []
  const ctx = fakeCtx(
    new Set(),
    { schemas: () => ({}) }, // not iterable
    { snapshot: () => Promise.resolve({ skills: [] }) },
  ).ctx
  const rows = await collectInventory(ctx, undefined, key => drifts.push(key))
  assert.ok(drifts.includes('tools.schemas.shape'))
  assert.equal(rows.filter(r => r.kind === 'tool' || r.kind === 'mcp').length, 0)
})

test('collectInventory skips a malformed schema.name entry without throwing', async () => {
  const drifts: string[] = []
  const ctx = fakeCtx(
    new Set(),
    { schemas: () => [{ name: 'ok' }, { name: 123 }, { name: 'web_search' }] },
    { snapshot: () => Promise.resolve({ skills: [] }) },
  ).ctx
  const rows = await collectInventory(ctx, undefined, key => drifts.push(key))
  const toolNames = rows.filter(r => r.kind === 'tool').map(r => r.name).sort()
  assert.deepEqual(toolNames, ['ok', 'web_search'])
  assert.ok(drifts.includes('tools.schemas.name'))
})

// --- buildProjection: the pure core the no-live-agent fallback read relies on.
// This is exactly what makes a persisted stance visible when no agent is bound,
// so its per-row resolution, guard inversion, and hit-tally handling are the
// correctness-critical seam of the fallback path.

/** A small inventory spanning a default-on family and the opt-in guard family. */
const projInventory: readonly CapabilityDescriptor[] = [
  { id: 'skill:research', name: 'research', description: 'r', kind: 'skill' },
  { id: 'tool:bash', name: 'bash', description: 'b', kind: 'tool' },
  { id: 'guard:readonly', name: 'readonly', description: 'g', kind: 'guard', guardAction: 'deny' },
]

test('buildProjection: a silent default-on capability resolves enabled', () => {
  const p = buildProjection(projInventory, layered(), '/proj')
  const row = p.rows.find(r => r.id === 'tool:bash')
  assert.ok(row !== undefined)
  assert.equal(row.disabled, false)
  assert.deepEqual(row.levels, { session: 'inherit', project: 'inherit', global: 'inherit' })
  assert.equal(p.projectKey, '/proj')
})

test('buildProjection: a session-off default-on capability resolves disabled', () => {
  // This is the exact fallback the persistence bug fix produces: a stance stored
  // at the session level must surface as disabled with no live agent present.
  const p = buildProjection(projInventory, layered({ 'tool:bash': 'off' }), '/proj')
  const row = p.rows.find(r => r.id === 'tool:bash')
  assert.ok(row !== undefined)
  assert.equal(row.disabled, true)
  assert.equal(row.levels.session, 'off')
})

test('buildProjection: a guard row inverts — silent means inactive', () => {
  const p = buildProjection(projInventory, layered(), '/proj')
  const g = p.rows.find(r => r.id === 'guard:readonly')
  assert.ok(g !== undefined)
  // guard default is OFF, so `disabled` (reused as ACTIVE for guards) is false.
  assert.equal(g.disabled, false)
  // no tally supplied -> zero, never undefined.
  assert.equal(g.hitCount, 0)
})

test('buildProjection: a guard row on means ACTIVE (disabled flag true)', () => {
  const p = buildProjection(projInventory, layered({ 'guard:readonly': 'on' }), '/proj')
  const g = p.rows.find(r => r.id === 'guard:readonly')
  assert.ok(g !== undefined)
  assert.equal(g.disabled, true)
})

test('buildProjection: supplied guard hit tally flows onto the guard row only', () => {
  const hits = new Map<string, number>([['guard:readonly', 4], ['tool:bash', 99]])
  const p = buildProjection(projInventory, layered(), '/proj', hits)
  const g = p.rows.find(r => r.id === 'guard:readonly')
  const bash = p.rows.find(r => r.id === 'tool:bash')
  assert.equal(g?.hitCount, 4)
  // hitCount is meaningful only for guards; a default-on family never reads it.
  assert.equal(bash?.hitCount, undefined)
})

test('buildProjection: session beats project beats global, per row', () => {
  const p = buildProjection(
    projInventory,
    layered({ 'tool:bash': 'on' }, { 'tool:bash': 'off' }, { 'tool:bash': 'off' }),
    '/proj',
  )
  const row = p.rows.find(r => r.id === 'tool:bash')
  assert.ok(row !== undefined)
  // session `on` wins, so the tool is NOT disabled despite lower levels off.
  assert.equal(row.disabled, false)
  assert.deepEqual(row.levels, { session: 'on', project: 'off', global: 'off' })
})

test('buildProjection: empty inventory yields no rows but keeps the projectKey', () => {
  const p = buildProjection([], layered({ 'tool:bash': 'off' }), '')
  assert.deepEqual(p.rows, [])
  assert.equal(p.projectKey, '')
})

// --- The no-live-agent fallback CONTRACT, modelled end to end. This is the
// persistence bug's exact scenario: the agent goes away (only an inventory
// snapshot survives), THEN the store is read for the panel. The fix resolves
// the snapshot against the CURRENT store, so a stance that is (or becomes)
// stored at the session level surfaces even though no binding exists — and a
// later store change is reflected on the next read, because the fallback keeps
// no cached stances, only the inventory shape.
test('fallback contract: a session-off read back after the agent is gone still resolves disabled', () => {
  // A mutable stand-in for OverrideStore.layered(): the only store surface the
  // registry's fallback path touches. It reads whatever is stored RIGHT NOW.
  const stored: Record<string, 'on' | 'off'> = {}
  const fakeLayered = (): LayeredOverrides => ({ session: { ...stored }, project: {}, global: {} })

  // The inventory snapshot the registry keeps past the agent's disposal.
  const snapshot = projInventory

  // 1) Agent gone, nothing stored yet: bash reads enabled (default-on).
  const before = buildProjection(snapshot, fakeLayered(), '/proj')
  assert.equal(before.rows.find(r => r.id === 'tool:bash')?.disabled, false)

  // 2) A session-level OFF is written while NO agent is bound (the idle write
  //    path). The store now holds it.
  stored['tool:bash'] = 'off'

  // 3) Re-open the panel (fallback read again): the same snapshot resolved
  //    against the now-updated store surfaces the OFF — the reopened panel shows
  //    the disabled state instead of silently reverting to enabled.
  const after = buildProjection(snapshot, fakeLayered(), '/proj')
  const bash = after.rows.find(r => r.id === 'tool:bash')
  assert.equal(bash?.disabled, true)
  assert.equal(bash?.levels.session, 'off')

  // 4) Clearing the stance (back to inherit) is likewise reflected next read,
  //    proving the fallback caches inventory shape only, never stale stances.
  delete stored['tool:bash']
  const cleared = buildProjection(snapshot, fakeLayered(), '/proj')
  assert.equal(cleared.rows.find(r => r.id === 'tool:bash')?.disabled, false)
})

// --- scope identity: the duplicate-framework-copy regression.
//
// dsh-agent-loop mints a scope for EVERY agent (its Agent constructor calls
// `createScope(loopCtx, this)` unconditionally), so `scopeOf(agent.ctx)`
// returning undefined never means "this agent is legitimately scopeless". It
// means the read went through a SECOND copy of @deepseek-ai/dsh-scope: that
// module keys identity on a module-private `Symbol("dsh.scope")` plus private
// WeakMaps, so a carrier minted by the host copy is invisible to a duplicate
// copy. Enforcement then degrades to the global layer alone — measured symptom:
// the skills tab lists only globally registered skills (one row) while tools,
// MCP groups and guards still look correct, which is why it reads as "a few
// skills went missing" rather than as a framework fault.

// AgentBinding itself is not imported here: it declares constructor parameter
// properties, which Node's strip-only type stripping rejects, so this suite can
// only exercise the pure decision function. The binding's use of it is asserted
// against the BUILT artifact in scope-identity-wiring.test.ts.

test('scopeIdentityDrift stays silent for a real scope key', () => {
  // ScopeKey is `object` — dsh-agent-loop passes the Agent instance itself.
  assert.equal(scopeIdentityDrift({}), null)
})

test('scopeIdentityDrift alarms when the scope key is missing', () => {
  const message = scopeIdentityDrift(undefined)
  assert.notEqual(message, null)
  // The message must name the real cause and the actionable fix.
  assert.match(String(message), /dsh-scope/)
  assert.match(String(message), /peerDependency/)
})

test('the scope-identity drift key is stable and namespaced', () => {
  // The key dedupes the warn-once sink; changing it silently would re-enable
  // log flooding, so it is pinned here.
  assert.equal(SCOPE_IDENTITY_DRIFT_KEY, 'scope.identity')
})
