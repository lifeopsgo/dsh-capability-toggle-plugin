/**
 * Registry of live agent bindings: one `AgentBinding` per live agent, tracked
 * across `agent/session-start` and `agent/disposed`. The per-agent enforcement
 * mechanics live in ./agent-binding.ts; this module only owns the lifecycle map
 * and the fan-out reconcile a store commit triggers.
 *
 * @module dsh-capability-toggle-plugin/host/controller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import type { CapabilityDescriptor, CapabilityToggleProjection } from '../shared/types.ts'
import { buildProjection } from '../shared/resolve.ts'
import { AgentBinding } from './agent-binding.ts'
import type { DriftSink } from './inventory.ts'
import type { OverrideStore } from './store.ts'

export { AgentBinding, projectKeyOf } from './agent-binding.ts'

/**
 * A disposed agent's last-known capability set, kept so the panel can still be
 * read after the agent goes idle. Session id is stable across an agent's
 * turn-by-turn dispose/restart, so this cache — keyed by session id — bridges
 * the gap: `agent/disposed` removes the live binding, but the next panel read
 * for that session finds this snapshot and resolves the CURRENT store against
 * it, so a persisted stance stays visible without a live agent.
 */
interface InventorySnapshot {
  /** The full pristine inventory captured while the agent was live. */
  readonly inventory: readonly CapabilityDescriptor[]
  /** The project root the agent's project level bound to (`''` when none). */
  readonly projectKey: string
}

/**
 * Registry of live agent bindings. One per Host activation; agents come and go
 * through `agent/session-start` and `agent/disposed`.
 */
export class ControllerRegistry {
  private readonly bindings = new Map<string, AgentBinding>()
  /**
   * Last-known inventory per session id, surviving the live binding's disposal.
   * Bounded by distinct session ids seen this Host activation (a few per user
   * session); entries are overwritten on each dispose and never grow per turn.
   * Read only by the no-live-agent fallback read.
   */
  private readonly lastKnown = new Map<string, InventorySnapshot>()

  /**
   * @param store - the shared override store.
   * @param hostCtx - this plugin's context, whose `skills`/`tools` inject each
   *   binding borrows through a scope minted onto the agent's scope key.
   * @param onDrift - optional warn-once sink handed to every binding's inventory
   *   read, so an unexpected framework shape alarms once instead of silently
   *   yielding an empty capability list.
   */
  constructor(
    private readonly store: OverrideStore,
    private readonly hostCtx: Context,
    private readonly onDrift?: DriftSink,
  ) {}

  /**
   * Track a newly started agent and apply the current decision to it.
   * @param agent - the agent that just started its session.
   * @returns the created binding.
   */
  async add(agent: Agent): Promise<AgentBinding> {
    const binding = new AgentBinding(this.store, this.hostCtx, agent, this.onDrift)
    this.bindings.set(agent.session.id, binding)
    await binding.reconcile()
    return binding
  }

  /**
   * Stop tracking an agent and drop its application (and its minted scope).
   * @param sessionId - the disposed agent's session id.
   */
  remove(sessionId: string): void {
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) return
    // Snapshot the agent's last pristine inventory BEFORE destroying it, so the
    // panel can still be read for this session once no agent is bound. Skip when
    // the binding never reconciled (null) — an empty snapshot would only mask
    // the fallback with a blank list.
    const inventory = binding.knownInventory
    if (inventory !== null) {
      this.lastKnown.set(sessionId, { inventory, projectKey: binding.projectKey })
    }
    binding.destroy()
    this.bindings.delete(sessionId)
  }

  /**
   * Look up one live agent's binding.
   * @param sessionId - the session id.
   * @returns the binding, or undefined when the agent is not tracked.
   */
  get(sessionId: string): AgentBinding | undefined {
    return this.bindings.get(sessionId)
  }

  /**
   * Build a projection for a session that has NO live binding, from its
   * last-known inventory resolved against the CURRENT store. This is what lets
   * the panel show persisted stances after the agent goes idle (an agent's
   * `agent/disposed` drops the live binding every turn). Returns undefined only
   * when this session was never seen live this activation — the caller then
   * answers "no agent" rather than a misleading empty panel. Guard hit tallies
   * are per-agent runtime state that does not survive disposal, so guard rows
   * report zero hits here (their on/off effect is still resolved correctly).
   * @param sessionId - the session id.
   * @returns the fallback projection, or undefined when nothing is cached.
   */
  fallbackProjection(sessionId: string): CapabilityToggleProjection | undefined {
    const snapshot = this.lastKnown.get(sessionId)
    if (snapshot === undefined) return undefined
    const overrides = this.store.layered(snapshot.projectKey, sessionId)
    return buildProjection(snapshot.inventory, overrides, snapshot.projectKey)
  }

  /**
   * The project root a disposed session's project level binds to, from its
   * last-known snapshot. Lets an idle-time (no live binding) project-level
   * write resolve its selector key without a live agent. Returns undefined when
   * this session was never seen live this activation, in which case a
   * project-level write cannot be placed (the caller answers 409/404).
   * @param sessionId - the session id.
   * @returns the cached project key, or undefined when nothing is cached.
   */
  lastKnownProjectKey(sessionId: string): string | undefined {
    return this.lastKnown.get(sessionId)?.projectKey
  }

  /** Re-apply the current decision to every tracked agent (store changed). */
  async reconcileAll(): Promise<void> {
    await Promise.all([...this.bindings.values()].map(b => b.reconcile()))
  }
}
