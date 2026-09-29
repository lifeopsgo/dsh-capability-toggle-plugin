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
 *   - OverrideStore        durable three-level state in the Loader config entry.
 *   - ControllerRegistry   per-agent enforcement on the tool and skill seams.
 *   - installHttp          the browser panel's read/write channel.
 *
 * Enforcement is re-applied whenever the store commits (any level, any client)
 * and whenever an agent starts; it is dropped when an agent is disposed.
 *
 * @module dsh-capability-toggle-plugin
 */

import type { Context } from '@deepseek-ai/cordis'

import { readLegacyOverridesSyncResult } from './host/legacy-migration.ts'
import { OverrideStore } from './host/store.ts'
import { ControllerRegistry } from './host/controller.ts'
import { StoredDocumentSchema } from './host/config.ts'
import type { OverrideConfig } from './host/config.ts'
import type {} from '@deepseek-ai/dsh-config-editor'
import { installHttp } from './host/http.ts'
import { ConfirmationCenter } from './host/confirm.ts'
import { checkRequiredServices, emitContractBanner, makeWarnOnce } from './host/self-check.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-capability-toggle-plugin'

/**
 * Required services. `configEditor` backs the durable state, `tools` and `skills`
 * are the enforced seams, `systemPrompt` carries the tool-guidance section
 * shadow that accompanies a disabled tool, `agents` is unused directly but its
 * lifecycle events drive tracking, and `webServer` carries the browser panel
 * channel.
 */
export const inject = ['agents', 'configEditor', 'tools', 'skills', 'systemPrompt', 'webServer', 'connection']

/**
 * Host plugin body. Every contribution is an effect, so plugin unload (or HMR
 * hot-swap) tears down the routes and every per-agent application.
 * @param ctx - the Host root context.
 */
export const Config = StoredDocumentSchema

export function apply(ctx: Context, config: OverrideConfig): void {
  // One-time contract audit: name the framework assumptions enforcement rests on
  // (so an upgrade regression is greppable) and confirm the injected services
  // actually resolved (a miss means the inject contract itself moved upstream).
  emitContractBanner(ctx)
  checkRequiredServices(ctx)
  // Warn-once sink for framework-shape drift surfaced while reading the tool /
  // skill inventory. Shared across every agent's reconcile so a persistent drift
  // alarms once, not once per agent per store commit.
  const onDrift = makeWarnOnce(ctx)

  const legacy = readLegacyOverridesSyncResult()
  if (legacy.status === 'invalid') {
    ctx.logger.warn('capability-toggle could not read valid legacy overrides; continuing without legacy migration.')
  }
  const store = new OverrideStore(ctx, config, legacy.status === 'available' ? legacy.value : undefined)
  const center = new ConfirmationCenter()
  const registry = new ControllerRegistry(store, ctx, center, onDrift)

  ctx.effect(() => installHttp(ctx, store, registry, center), 'capability-toggle: http routes')
  ctx.effect(() => () => registry.disposeAll(), 'capability-toggle: bindings')
  ctx.effect(() => () => center.dispose(), 'capability-toggle: confirmation center')

  const bindAgent = async (agent: Parameters<typeof registry.add>[0], source: string): Promise<undefined> => {
    try {
      await registry.add(agent)
    } catch (error) {
      ctx.logger.warn(`capability-toggle failed to bind ${source}: ${messageOf(error)}`)
    }
    return undefined
  }

  for (const agent of ctx.agents.list()) void bindAgent(agent, 'existing agent')
  void store.migrateLegacy().catch((error: unknown) => {
    ctx.logger.warn(`capability-toggle failed to migrate legacy overrides: ${messageOf(error)}`)
  })

  ctx.on('agent/created', ({ agent }) => bindAgent(agent, 'created agent'))

  ctx.on('loader/volatile-update', () => {
    void registry.reconcileAll().catch((error: unknown) => {
      ctx.logger.warn(`capability-toggle failed to reconcile volatile override update: ${messageOf(error)}`)
    })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    registry.remove(agent)
  })
}

/** Extract a log-safe message from an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
