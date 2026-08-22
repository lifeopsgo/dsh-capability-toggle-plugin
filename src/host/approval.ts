/**
 * Approval-policy capability family: a single switch that locks one agent's
 * approval requests to a deterministic rejection, without touching the
 * deployment's shared approval-policy state.
 *
 * WHY A DEDICATED SEAM (not `approval.setPolicy`):
 * DSH already ships a first-class permission UI (`dsh-permission-presets` +
 * `dsh-client-ui-permission-presets`: the `/permission` command, the composer
 * chip, the Settings row) that OWNS the session's approval policy. It writes a
 * durable `approval/policy` session-log event AND injects a model message
 * ("the approval policy changed…"). `ApprovalService.setPolicy` does the same.
 * If this plugin also called `setPolicy`, its reconcile would repeatedly
 * overwrite the user's `/permission` choice on the ONE shared policy value —
 * two controllers fighting over one piece of log-folded state, last-write-wins.
 *
 * Instead we gate the SAME seam the policy consults, one layer earlier and
 * scoped to this agent only: `approval/request` is a `Scoped<ApprovalService>`
 * waterfall. A scope-tagged listener (registered through the agent's scoped
 * context) receives ONLY that agent's requests. When the switch is off we claim
 * the request with `'rejected'`; when on we `next()` to delegate to whatever
 * the deployment composed (the real answerers, or the policy's own decision).
 *
 * Properties this buys us:
 *   - Clean disposer, exactly like `tools.restrict`: reconcile installs the
 *     listener when disabled and disposes it when re-enabled — no state to
 *     unwind, no log event, no injected message.
 *   - No collision with `dsh-permission-presets`: we never write
 *     `approval/policy`; the user's `/permission` value is read-through
 *     untouched by our `next()`.
 *   - Scope-isolated: only the bound agent is affected. A same-name listener on
 *     the GLOBAL layer (no scope) would intercept EVERY agent, so enforcement
 *     is gated on a real scope, exactly like the prompt shadows.
 *
 * SEMANTICS (direction matches the other switches — off = tighten/lock):
 *   - on / inherit  → normal: delegate via `next()` (answerers or session policy).
 *   - off           → locked: every approval request for this agent resolves
 *                     `'rejected'` (no interactive escalation, no sandbox
 *                     elevation). The model still sees a normal rejected tool
 *                     result — the audit pair the service always logs remains
 *                     the record of the decision.
 *
 * OPTIONAL SERVICE: not every deployment loads `dsh-user-approval`, so the
 * `approval` service is NOT in the plugin's `inject` list (that would block the
 * whole plugin from loading where approval is absent). Presence is probed with
 * `ctx.get('approval', false)`; when absent, no row is offered and no listener
 * is registered — the family simply does not exist for that deployment.
 *
 * @module dsh-capability-toggle-plugin/host/approval
 */

import type { Context } from '@deepseek-ai/cordis'
// Loads the `ctx.approval` service augmentation (declaration merging) and the
// `approval/request` scoped-waterfall event onto Context, program-wide.
import type {} from '@deepseek-ai/dsh-user-approval'

import type { CapabilityDescriptor } from '../shared/types.ts'

/**
 * The sole approval-family switch id. Like `prompt:runtime` it is an
 * intentionally bare singleton: it gates one all-or-nothing behavior (lock this
 * agent's approvals), so it carries no `<name>` segment. The `:policy` suffix
 * reads as "the approval policy gate" and keeps it clear of the `approval/…`
 * event namespace.
 */
export const APPROVAL_GATE_ID = 'approval:policy'

/**
 * Whether the deployment loaded the approval service. Non-strict `get` returns
 * undefined instead of throwing when the service is absent, so this is a safe
 * presence probe from a context that does not inject `approval`.
 * @param ctx - any context.
 * @returns true when `ctx.approval` is resolvable.
 */
function approvalAvailable(ctx: Context): boolean {
  return ctx.get('approval', false) !== undefined
}

/**
 * The approval-family inventory: one row when the approval service is present,
 * none otherwise. Pure read — registers nothing.
 * @param ctx - a context whose service presence reflects the deployment.
 * @returns a single-element array, or an empty array when approval is absent.
 */
export function collectApprovalGate(ctx: Context): CapabilityDescriptor[] {
  if (!approvalAvailable(ctx)) return []
  return [{
    id: APPROVAL_GATE_ID,
    name: 'policy',
    description:
      'Allow approval escalation for this agent. When off, every approval '
      + 'request is auto-rejected (no interactive prompt, no sandbox elevation).',
    kind: 'approval',
  }]
}

/**
 * Install the approval lock on a scoped context when the gate is disabled.
 *
 * Registration MUST go through a context carrying the agent's scope tag so the
 * `approval/request` listener is filtered to this agent only. The caller (the
 * agent binding) guarantees this by passing its `scopedCtx`, and by only
 * calling this when the agent has a real scope — a listener registered on the
 * global layer would intercept every agent's approvals.
 *
 * @param scopedCtx - the agent-scoped context (its scope tag filters dispatch).
 * @param disabled - the switch ids resolved to disabled for this agent.
 * @returns a disposer array: one entry that removes the listener when the gate
 *   is disabled, empty when it is on (nothing installed).
 */
export function applyApprovalGate(
  scopedCtx: Context,
  disabled: ReadonlySet<string>,
): Array<() => void> {
  if (!disabled.has(APPROVAL_GATE_ID)) return []
  if (!approvalAvailable(scopedCtx)) return []

  // Claim every approval request for this agent with a deterministic rejection.
  // Returning an outcome (instead of calling `next()`) short-circuits the
  // waterfall, so no downstream answerer — and not the session policy — is
  // consulted. `ctx.on` returns the exact Cordis disposer for this listener.
  //
  // PREPEND IS LOAD-BEARING: `approval/request` is a waterfall run in listener
  // REGISTRATION order until one claims. `dsh-host-apiproxy` registers its own
  // global `approval/request` listener at STARTUP (long before any agent) that
  // forwards the ask to the browser UI and waits for a human click. Our scoped
  // listener is registered later, at reconcile, so by default it sorts AFTER
  // apiproxy's — which would claim first and let the user click through, making
  // this "lock" dead code. Registering with `prepend: true` puts us at the head
  // of the list so we claim before apiproxy is consulted. Scope filtering is
  // independent of order, so we still only see THIS agent's requests; prepend
  // only decides who among the matching listeners runs first.
  const dispose = scopedCtx.on('approval/request', () => Promise.resolve('rejected'), { prepend: true })
  return [dispose]
}
