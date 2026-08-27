/**
 * Framework-contract self-check: the assumptions this plugin makes about the
 * DSH/Cordis surfaces it binds to, made observable.
 *
 * WHY THIS EXISTS. Every enforcement seam here is a silent-failure risk on a
 * framework upgrade: `ctx.on('tools/pre-execute', …)` registered against a
 * renamed (or re-routed) event does NOT throw — it installs a listener that is
 * simply never called, so a guard or the approval lock quietly stops matching
 * (fail-OPEN, the worst direction for a control). TypeScript catches a renamed
 * event only at the plugin's OWN compile; a host upgrade that ships new surfaces
 * while this plugin runs its already-built `lib/` gets no compile signal and no
 * runtime error. This module cannot re-add a compile check at runtime, but it
 * turns the invisible assumptions into (a) one startup line an operator can grep
 * when auditing an upgrade, and (b) warn-once drift alarms when a surface this
 * plugin reads returns a shape it did not expect.
 *
 * It changes NO enforcement behavior and adds no per-call cost: the banner logs
 * once at activation, and the drift alarms fire only off the shape checks the
 * inventory path already performs, deduped so a persistent drift cannot spam.
 *
 * @module dsh-capability-toggle-plugin/host/self-check
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'

export const SCOPE_IDENTITY_DRIFT_KEY = 'scope.identity'

export function scopeIdentityDrift(scopeKey: ScopeKey | undefined): string | null {
  if (scopeKey !== undefined) return null
  return 'capability-toggle: this agent carries no dsh-scope tag, so per-agent enforcement is '
    + 'inoperative and the panel can only list globally registered capabilities (the skills tab '
    + 'collapses to global skills while tools, MCP groups and guards still look correct). '
    + 'dsh-agent-loop mints a scope for every agent, so a missing tag means the read went through '
    + 'a SECOND copy of @deepseek-ai/dsh-scope: scope identity is a module-private Symbol plus '
    + 'private WeakMaps, which a duplicate copy cannot read. Make the framework packages resolve '
    + "to the host's copy — declare every @deepseek-ai/* package as a peerDependency and keep a "
    + "second copy out of this plugin's own node_modules."
}

/**
 * The framework contract this plugin depends on, in one place. Kept as data (not
 * scattered string literals) so the banner, the audit trail, and a future
 * compatibility test all read the SAME source of truth. Update this when a seam
 * moves — the banner then advertises the new assumption automatically.
 */
export const FRAMEWORK_CONTRACT = {
  /** Services whose absence makes the whole plugin fail to activate (via `inject`). */
  requiredServices: ['settings', 'tools', 'skills', 'systemPrompt', 'webServer'] as const,
  /** Services probed non-strictly; absence degrades one family, not the plugin. */
  optionalServices: ['approval'] as const,
  /**
   * The enforcement events a scoped listener claims. A rename here turns a guard
   * or the approval lock into dead code with no runtime error — the single most
   * important line to check after a DSH upgrade.
   */
  enforcementEvents: ['tools/pre-execute', 'approval/request'] as const,
  /**
   * The agent-lifecycle events this plugin tracks. `agent/session-start` mints a
   * binding; `agent/disposed` drops it (and its scope fiber + hit tally). The
   * disposed event is load-bearing for MEMORY: it is the only path that removes
   * a binding from the live map, so a rename/miss upstream would strand one
   * binding per agent that ever started — a slow leak with no runtime error.
   */
  lifecycleEvents: ['agent/session-start', 'agent/disposed'] as const,
  /** The `Execution` field the pre-execute waterfall routes scope by. */
  scopeRoutingKey: 'exec.agent',
  /** The MCP public-tool name grammar the inventory groups servers by. */
  mcpNameGrammar: 'mcp__<server>__<tool>',
  /** The settings namespace holding the three-level override document. */
  settingsNamespace: 'capability-toggle',
} as const

/**
 * Log one activation banner naming the framework assumptions enforcement rests
 * on. This is the anchor an operator greps when a guard or lock "stopped
 * working" after an upgrade: if a listed event or routing key was renamed
 * upstream, the seam fails silently, and this line is the record of what the
 * running build assumed. Logged at `info` once per activation.
 * @param ctx - the Host context, for its logger.
 */
export function emitContractBanner(ctx: Context): void {
  const c = FRAMEWORK_CONTRACT
  ctx.logger.info(
    `active — enforcement binds events [${c.enforcementEvents.join(', ')}] `
    + `scoped by "${c.scopeRoutingKey}", groups MCP tools by "${c.mcpNameGrammar}", `
    + `tracks agent lifecycle via [${c.lifecycleEvents.join(', ')}]. `
    + 'If a DSH upgrade renames an enforcement event, the affected guard/lock '
    + 'stops matching WITHOUT error (fail-open); if it renames "agent/disposed", '
    + 'per-agent bindings stop being reclaimed (slow memory leak). Grep this '
    + 'line when auditing an upgrade.',
  )
}

/**
 * Verify each required service actually resolves. `inject` already gates
 * activation on these, so a miss here means the inject contract itself changed
 * (a required service was renamed/removed upstream) — an `error`-level signal,
 * not a mere warning, because enforcement is then partially inoperative.
 * @param ctx - the Host context.
 * @returns the names that failed to resolve (empty when all present).
 */
export function checkRequiredServices(ctx: Context): string[] {
  const missing = FRAMEWORK_CONTRACT.requiredServices.filter(
    name => ctx.get(name, false) === undefined,
  )
  if (missing.length > 0) {
    ctx.logger.error(
      `required service(s) unexpectedly absent despite inject: [${missing.join(', ')}]. `
      + 'A DSH upgrade may have renamed or removed them; enforcement is degraded.',
    )
  }
  return missing
}

/**
 * Build a warn-once sink: the first message per key logs at `warn`, repeats are
 * dropped. Drift (a surface returning an unexpected shape) persists across every
 * reconcile, so an un-deduped warn would flood the log; the key lets one alarm
 * stand for a whole class of repeated drift.
 * @param ctx - the Host context, for its logger.
 * @returns a `(key, message)` sink that logs each distinct key once.
 */
export function makeWarnOnce(ctx: Context): (key: string, message: string) => void {
  const seen = new Set<string>()
  return (key, message) => {
    if (seen.has(key)) return
    seen.add(key)
    ctx.logger.warn(message)
  }
}
