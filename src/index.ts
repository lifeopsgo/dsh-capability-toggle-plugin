/**
 * Host (Node) half of dsh-capability-toggle-plugin.
 *
 * Lets a user switch off individual skills, MCP server groups, and plain tools
 * at three levels — session, project, and global — from a panel in the composer
 * tool row. A switched-off capability disappears from the model's tool schema
 * set / skill catalog on the next agent step and is hard-refused if the model
 * still attempts it, so the effect is enforced, not merely hidden.
 *
 * Composition:
 *   - OverrideStore        durable three-level state in one settings namespace.
 *   - ControllerRegistry   per-agent enforcement on the tool and skill seams.
 *   - installHttp          the browser panel's read/write channel.
 *
 * Enforcement is re-applied whenever the store commits (any level, any client)
 * and whenever an agent starts; it is dropped when an agent is disposed.
 *
 * @module dsh-capability-toggle-plugin
 */

import type { Context } from '@deepseek-ai/cordis'

import { OverrideStore } from './host/store.ts'
import { ControllerRegistry } from './host/controller.ts'
import { installHttp } from './host/http.ts'
import { checkRequiredServices, emitContractBanner, makeWarnOnce } from './host/self-check.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-capability-toggle-plugin'

/**
 * Required services. `settings` backs the durable state, `tools` and `skills`
 * are the enforced seams, `systemPrompt` carries the tool-guidance section
 * shadow that accompanies a disabled tool, `agents` is unused directly but its
 * lifecycle events drive tracking, and `webServer` carries the browser panel
 * channel.
 */
export const inject = ['settings', 'tools', 'skills', 'systemPrompt', 'webServer']

/**
 * Host plugin body. Every contribution is an effect, so plugin unload (or HMR
 * hot-swap) tears down the routes, the settings observer, and every per-agent
 * application.
 * @param ctx - the Host root context.
 */
export function apply(ctx: Context): void {
  // One-time contract audit: name the framework assumptions enforcement rests on
  // (so an upgrade regression is greppable) and confirm the injected services
  // actually resolved (a miss means the inject contract itself moved upstream).
  emitContractBanner(ctx)
  checkRequiredServices(ctx)
  // Warn-once sink for framework-shape drift surfaced while reading the tool /
  // skill inventory. Shared across every agent's reconcile so a persistent drift
  // alarms once, not once per agent per store commit.
  const onDrift = makeWarnOnce(ctx)

  const store = new OverrideStore(ctx)
  const registry = new ControllerRegistry(store, ctx, onDrift)

  ctx.effect(() => installHttp(ctx, store, registry), 'capability-toggle: http routes')

  // A committed change at any level (from any client) re-applies enforcement to
  // every live agent. The observer disposer is returned into the effect.
  ctx.effect(
    () => store.watch(() => {
      void registry.reconcileAll().catch((error: unknown) => {
        ctx.logger.warn(`capability-toggle reconcile failed: ${messageOf(error)}`)
      })
    }),
    'capability-toggle: settings observer',
  )

  // Track each agent for its whole lifetime. `agent/session-start` is the first
  // point the agent scope exists and tools/skills can be restricted on it.
  ctx.on('agent/session-start', ({ agent }) => {
    void registry.add(agent).catch((error: unknown) => {
      ctx.logger.warn(`capability-toggle failed to bind agent: ${messageOf(error)}`)
    })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    registry.remove(agent.session.id)
  })
}

/** Extract a log-safe message from an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
