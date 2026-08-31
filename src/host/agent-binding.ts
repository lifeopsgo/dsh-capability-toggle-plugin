/**
 * One live agent's enforcement binding. For a single agent it resolves the
 * effective disabled set (session over project over global over default-enabled)
 * and applies it to the agent's own scope across three seams:
 *
 *   - tools: `tools.restrict({ deny })` removes every disabled plain tool and
 *     every member tool of a disabled MCP server group from the agent's
 *     inherited surface. A denied tool leaves the model schema set, so the next
 *     `request/header` snapshot no longer advertises it, and any call the model
 *     still attempts is refused by the restriction.
 *   - skills: for each disabled skill, `skills.register` installs a same-name
 *     runtime skill with `modelInvocable:false` in the agent's scope layer. The
 *     registry merges the agent layer after global (`merged.set` overwrites),
 *     so the stub shadows the real skill, and tool-skill's `isModelInvocable`
 *     filter then drops it from the `<available_skills>` catalog. Registering /
 *     disposing invalidates the skill catalog cache, so a mid-session toggle
 *     takes effect on the next agent step — no restart.
 *   - prompt: disabled plain tools shadow away their `tool:<name>` guidance
 *     section, and the curated prompt-gate family shadows sections/contexts or
 *     installs the runtime-context suppressor (see ./prompt.ts).
 *
 * Reconcile is latest-wins: any store change disposes the current application
 * and installs a fresh one from the current inventory and overrides.
 *
 * @module dsh-capability-toggle-plugin/host/agent-binding
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
// Load the Context service augmentations these seams live on (program-wide).
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'

import type {
  CapabilityDescriptor, CapabilityToggleProjection,
} from '../shared/types.ts'
import { buildProjection, disabledIds, isGuardActive } from '../shared/resolve.ts'
import {
  collectInventory, type DriftSink, deniedToolNames, disabledSkillNames,
  disabledToolGuidanceSections,
} from './inventory.ts'
import { applyPromptGates } from './prompt.ts'
import { applyApprovalGate } from './approval.ts'
import { applyGuards, GUARD_IDS } from './guards.ts'
import { SCOPE_IDENTITY_DRIFT_KEY, scopeIdentityDrift } from './self-check.ts'
import type { OverrideStore } from './store.ts'

/**
 * Order for our empty guidance-shadow sections. Any finite number works: an
 * empty section is dropped at render regardless of order, and the shadow wins
 * its name in the scope-chain merge by scope, not by order. Kept in the tool
 * guidance band (100–199) for tidiness when inspecting an assembly.
 */
const GUIDANCE_SHADOW_ORDER = 150

/** Resolve the project key (absolute cwd) an agent's project level binds to. */
export function projectKeyOf(agent: Agent): string {
  return agent.session.header.cwd ?? ''
}

/** Human label for the level a shadowed skill's stub attributes itself to. */
function scopeLabel(projectKey: string): string {
  return projectKey === '' ? 'session' : 'session/project/global scope'
}

/**
 * One live agent's enforcement binding. Holds the agent identity plus the
 * disposers of the current application generation, and re-derives them on
 * demand. Not reused across agents.
 */
export class AgentBinding {
  private readonly scopeKey: ScopeKey | undefined
  /**
   * A context that inherits THIS plugin's `skills`/`tools` inject but carries
   * the agent's scope tag. Both seams read the caller's scope via
   * `scopeOf(this.ctx)` AND are gated by Cordis's per-fiber inject guard, so
   * `agent.ctx` cannot be used directly: its fiber does not inject `skills`, so
   * `agent.ctx.skills` throws "cannot get property skills without inject". This
   * scoped context passes the guard (host inject) while landing restrict() /
   * register() in the agent's own layer (agent scope tag).
   */
  private readonly scope: Scope | undefined
  private readonly scopedCtx: Context
  readonly projectKey: string
  readonly sessionKey: string
  /** Disposers for the current application generation. */
  private disposers: Array<() => void> = []
  /** Monotonic generation, so a slow reconcile cannot overwrite a newer one. */
  private generation = 0
  /**
   * The last PRISTINE inventory — captured inside reconcile's dispose window,
   * before our own enforcement is re-applied. Serving the UI from this cache is
   * mandatory: `tools.schemas(scope)` returns only the VISIBLE set (a denied
   * tool vanishes) and `skills.snapshot(scope)` returns the SHADOW's stub
   * description, so a live read while enforcement is applied would drop
   * toggled-off tools from the panel (making them impossible to re-enable) and
   * mislabel toggled-off skills. `null` until the first reconcile.
   */
  private lastInventory: readonly CapabilityDescriptor[] | null = null

  /**
   * Per-guard hit counters for THIS agent, keyed by `guard:<name>` id. A guard
   * listener increments the count each time it denies/asks a call. This is
   * RUNTIME state, not persisted: it lives on the binding for the agent's
   * lifetime and is deliberately NOT cleared by `dispose()` (a reconcile that
   * reinstalls the listeners must not reset a running tally), only dropped when
   * the agent goes away with the binding. The projection reads it so the panel
   * can show "blocked N calls" per guard row.
   */
  private readonly guardHits = new Map<string, number>()

  /**
   * @param store - the shared override store.
   * @param hostCtx - this plugin's context (injects `skills` and `tools`).
   * @param agent - the live agent this binding enforces.
   * @param onDrift - optional warn-once sink for unexpected framework shapes
   *   seen while reading this agent's inventory (threaded to `collectInventory`).
   */
  constructor(
    private readonly store: OverrideStore,
    hostCtx: Context,
    private readonly agent: Agent,
    private readonly onDrift?: DriftSink,
  ) {
    this.scopeKey = scopeOf(agent.ctx)
    this.projectKey = projectKeyOf(agent)
    this.sessionKey = agent.session.id
    const scopeDrift = scopeIdentityDrift(this.scopeKey)
    if (scopeDrift !== null) onDrift?.(SCOPE_IDENTITY_DRIFT_KEY, scopeDrift)
    this.scope = this.scopeKey === undefined ? undefined : createScope(hostCtx, this.scopeKey)
    this.scopedCtx = this.scope?.ctx ?? hostCtx
  }

  /**
   * The UI's inventory: the last pristine snapshot captured by reconcile. It
   * reflects the FULL capability set (nothing our own enforcement hid), which
   * is what the panel must render so a toggled-off tool stays listed and can be
   * turned back on. Triggers a reconcile when never yet populated.
   */
  async inventory(): Promise<readonly CapabilityDescriptor[]> {
    if (this.lastInventory === null) await this.reconcile()
    return this.lastInventory ?? []
  }

  /**
   * The last pristine inventory this binding captured, WITHOUT triggering a
   * reconcile — `null` when it has never reconciled. The registry reads it at
   * dispose time to seed its cross-lifetime fallback cache, so a panel reopened
   * after the agent goes idle can still render the persisted stances against a
   * known capability set (see ControllerRegistry.fallbackProjection). A plain
   * synchronous getter because dispose must not await a fresh scope read after
   * the agent's scope has begun tearing down.
   */
  get knownInventory(): readonly CapabilityDescriptor[] | null {
    return this.lastInventory
  }

  /**
   * Read the agent's PRISTINE inventory — the full set with our own
   * enforcement lifted. Only valid to call while `this.disposers` is empty
   * (inside reconcile's dispose window); otherwise `tools.schemas` omits denied
   * tools and `skills.snapshot` returns shadow stubs.
   */
  private async pristineInventory(): Promise<CapabilityDescriptor[]> {
    return collectInventory(this.scopedCtx, this.scopeKey, this.agent.session.header.cwd, this.onDrift)
  }

  /**
   * The set of switch ids resolved to disabled for this agent, over an
   * already-collected inventory.
   * @param descriptors - this agent's inventory.
   * @returns the disabled switch ids.
   */
  disabledSet(descriptors: readonly CapabilityDescriptor[]): Set<string> {
    const overrides = this.store.layered(this.projectKey, this.sessionKey)
    return new Set(disabledIds(overrides, descriptors.map(d => d.id)))
  }

  /**
   * Dispose the current application and install a fresh one from the current
   * inventory and overrides. Latest-wins: a reconcile started later always
   * ends up as the installed generation.
   */
  async reconcile(): Promise<void> {
    const gen = ++this.generation

    // Dispose our current enforcement FIRST, then read: only with our restrict
    // and shadows lifted does the scope report the full, pristine capability
    // set. Reading before disposing would drop already-denied tools from the
    // inventory (unrecoverable) and mislabel already-shadowed skills.
    this.dispose()

    // Install the guard listener SYNCHRONOUSLY here, in the same tick as the
    // dispose above — before the `await` below yields the event loop. Guards
    // are a SAFETY seam, so their enforcement must never have a fail-open
    // window: the pre-execute waterfall snapshots its listener list at each
    // call's start (cordis dispatch), so a guard removed by dispose() and only
    // re-added AFTER the await would leave every in-flight/new call in that gap
    // unguarded (a `deny`/`ask` silently downgraded to allow). Unlike the
    // default-on seams below, a guard's active set needs no pristine inventory
    // (it is GUARD_IDS ∩ the synchronous store read), so it can — and for
    // safety MUST — be installed without awaiting. A later superseding
    // reconcile disposes this generation first, so latest-wins still holds.
    this.installGuards()

    const descriptors = await this.pristineInventory()
    if (gen !== this.generation) return
    this.lastInventory = descriptors
    const disabled = this.disabledSet(descriptors)

    const deny = deniedToolNames(descriptors, disabled)
    if (deny.length > 0) {
      this.disposers.push(this.scopedCtx.tools.restrict({ deny }))
    }
    for (const name of disabledSkillNames(descriptors, disabled)) {
      this.disposers.push(this.scopedCtx.skills.register({
        name,
        description: `Disabled by capability-toggle for this ${scopeLabel(this.projectKey)}.`,
        source: 'runtime',
        content: '',
        invocation: { modelInvocable: false, userInvocable: false },
      }))
    }

    // For each disabled plain tool, also shadow away its `tool:<name>` usage
    // guidance section: an empty same-name scoped section wins the assembly
    // merge for this scope and is dropped at render, so the model no longer
    // reads guidance for a tool it can no longer call. Purely cosmetic
    // (token-saving) — a tool that ships no such section renders nothing.
    //
    // GATED ON A REAL SCOPE: a same-name section registered in the GLOBAL layer
    // (scopeKey undefined -> scopedCtx is hostCtx) collides with the tool's own
    // global registration and throws (duplicate name in one layer). Shadowing is
    // a scope-chain override, so it is only valid when this agent has a scope.
    if (this.scopeKey !== undefined) {
      for (const sectionName of disabledToolGuidanceSections(descriptors, disabled)) {
        this.disposers.push(this.scopedCtx.systemPrompt.section({
          name: sectionName,
          order: GUIDANCE_SHADOW_ORDER,
          text: '',
        }))
      }
      // Prompt-context family (curated allowlist): shadow disabled sections /
      // contexts with an empty same-name entry, or install the runtime-context
      // suppressor. Same scope-only rule as the guidance shadows above.
      for (const dispose of applyPromptGates(this.scopedCtx, descriptors, disabled)) {
        this.disposers.push(dispose)
      }
      // Approval gate: when `approval:policy` is off, install a scoped
      // `approval/request` waterfall listener that rejects every ask for THIS
      // agent (an escalation lock). Scope-only for the same reason as the
      // shadows: on a scopeless context the listener would be global and
      // reject every agent's asks. Unlike setPolicy(), this writes no session
      // event and injects no message, so it never fights the first-class
      // permission UI that owns `approval/policy`.
      for (const dispose of applyApprovalGate(this.scopedCtx, disabled)) {
        this.disposers.push(dispose)
      }
    }
  }

  /**
   * Install the guard-preset enforcement listener for this agent, synchronously.
   * Called at the head of reconcile (right after dispose, before any await) so a
   * safety guard has NO fail-open window: see the call site in {@link reconcile}.
   *
   * A guard's active set is `GUARD_IDS` intersected with the synchronous store
   * read — it never needs the pristine inventory the default-on seams await for,
   * so this stays await-free. Scope-only for the same reason as the approval
   * lock: the `tools/pre-execute` scope routing key is `exec.agent`, so a
   * scopeless listener would gate every agent; a scopeless binding installs no
   * guard. A single prepended listener runs the pure matcher and counts each hit
   * on the reconcile-surviving `guardHits` tally.
   */
  private installGuards(): void {
    if (this.scopeKey === undefined) return
    const overrides = this.store.layered(this.projectKey, this.sessionKey)
    const activeGuards = new Set(GUARD_IDS.filter(id => isGuardActive(overrides, id)))
    for (const dispose of applyGuards(this.scopedCtx, activeGuards, (id) => {
      this.guardHits.set(id, (this.guardHits.get(id) ?? 0) + 1)
    })) {
      this.disposers.push(dispose)
    }
  }

  /**
   * Build the UI projection for this agent: every capability with its per-level
   * stored stance and resolved disabled flag.
   * @param descriptors - this agent's inventory.
   * @returns the projection the composer panel renders.
   */
  projection(descriptors: readonly CapabilityDescriptor[]): CapabilityToggleProjection {
    // The per-row transform is a pure function shared with the no-live-agent
    // fallback read (see shared/resolve.ts buildProjection). This binding passes
    // its live per-agent guard-hit tally; the fallback path has none and reports
    // zero hits.
    const overrides = this.store.layered(this.projectKey, this.sessionKey)
    return buildProjection(descriptors, overrides, this.projectKey, this.guardHits)
  }

  /** The last pristine inventory this binding captured, or null before its first
   * reconcile. Exposed so the registry can retain it as a cross-lifetime cache:
   * a later read after the agent is disposed still has a capability set to
   * project the persisted overrides against. */
  cachedInventory(): readonly CapabilityDescriptor[] | null {
    return this.lastInventory
  }

  /** Dispose the current application generation's registrations. */
  dispose(): void {
    const current = this.disposers
    this.disposers = []
    for (const d of current) {
      try {
        d()
      } catch {
        /* a disposer that already ran during agent teardown is inert */
      }
    }
  }

  /**
   * Full teardown when the agent goes away: drop the current registrations and
   * dispose the minted scope fiber. The agent's own scope teardown also unwinds
   * anything registered through it, so this is idempotent with that path.
   */
  destroy(): void {
    this.generation += 1
    this.dispose()
    void this.scope?.dispose()
  }
}
