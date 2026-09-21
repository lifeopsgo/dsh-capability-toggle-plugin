/**
 * The plugin-owned blocking confirmation channel.
 *
 * WHY THIS EXISTS (not the native `ask`/approval seam): a guard that returns
 * `{ kind: 'ask' }` is routed by the tool runtime through `approval.request()`,
 * whose `decide()` short-circuits to `'rejected'` the instant the session's
 * effective approval policy is `'never'` (the `danger-full-access` permission
 * preset) — BEFORE the `approval/request` waterfall is dispatched, so the
 * browser answerer is never consulted and NO prompt is shown. So this module
 * registers the confirmation itself, outside the approval policy.
 *
 * @module dsh-capability-toggle-plugin/host/confirm
 */

import { randomUUID } from 'node:crypto'

import type { GuardConfirmRequest, GuardConfirmer } from './guards.ts'
import { SHELL_TOOLS } from './guards.ts'

export interface SseSink {
  /** Write one already-framed SSE chunk; false when the socket is gone. */
  write(chunk: string): boolean
  end(): void
}

export interface ConfirmPayload {
  readonly guardId: string
  readonly guardAction: 'deny' | 'ask'
  readonly reason: string
  readonly toolName: string
  /** Full shell command, or JSON args bounded to {@link DETAIL_LIMIT}. */
  readonly detail: string
}

export interface PendingConfirm extends ConfirmPayload {
  readonly id: string
}

export type ConfirmOutcome = 'allow' | 'deny' | 'cancelled'

type Settle = (outcome: ConfirmOutcome) => void

interface Entry {
  readonly id: string
  readonly payload: ConfirmPayload
  readonly settle: Settle
}

/**
 * Build the human detail for one guarded call.
 *
 * A shell command is returned VERBATIM: truncating it would hide a dangerous
 * suffix (a long heredoc whose final line is `rm -rf /`) from the user who is
 * being asked to approve that exact command. Non-shell arguments are bounded,
 * because a `write` call carries a whole file body that no card can show.
 */
export function buildConfirmDetail(toolName: string, args: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(toolName) && typeof args['command'] === 'string') {
    return args['command'] as string
  }
  let json: string
  try {
    json = JSON.stringify(args) ?? ''
  } catch {
    json = String(args)
  }
  return bound(json)
}

/** Upper bound on pushed non-shell detail, so a huge arg cannot bloat SSE. */
const DETAIL_LIMIT = 8000

function bound(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT)}…`
}

/**
 * Registry of live confirmations and their browser channels, keyed by session.
 * One instance per Host activation, shared by every agent binding and the HTTP
 * routes.
 */
export class ConfirmationCenter {
  private readonly channels = new Map<string, Set<SseSink>>()
  private readonly pending = new Map<string, Map<string, Entry>>()
  private readonly disposers = new WeakMap<SseSink, () => void>()
  private disposed = false

  hasChannel(session: string): boolean {
    const set = this.channels.get(session)
    return set !== undefined && set.size > 0
  }

  subscribe(session: string, sink: SseSink): () => void {
    if (this.disposed) {
      sink.end()
      return () => {}
    }
    let set = this.channels.get(session)
    if (set === undefined) {
      set = new Set()
      this.channels.set(session, set)
    }
    set.add(sink)
    this.push(sink, { snapshot: this.pendingFor(session) })
    for (const entry of this.pending.get(session)?.values() ?? []) {
      this.push(sink, confirmEvent(entry))
    }
    let done = false
    const dispose = (): void => {
      if (done) return
      done = true
      this.disposers.delete(sink)
      const cur = this.channels.get(session)
      if (cur !== undefined) {
        cur.delete(sink)
        if (cur.size === 0) this.channels.delete(session)
      }
      try { sink.end() } catch { /* a dead socket must not break the registry */ }
    }
    this.disposers.set(sink, dispose)
    return dispose
  }

  /**
   * Register a blocking confirmation for a session. Resolves when a browser
   * answers, the caller's signal aborts, or the center is disposed; `cancelled`
   * covers both abort and dispose.
   */
  request(session: string, payload: ConfirmPayload, signal?: AbortSignal): Promise<ConfirmOutcome> {
    if (signal?.aborted || this.disposed) return Promise.resolve('cancelled')
    return new Promise<ConfirmOutcome>((resolve) => {
      const id = randomUUID()
      let settled = false
      const settle: Settle = (outcome) => {
        if (settled) return
        settled = true
        const map = this.pending.get(session)
        if (map !== undefined) {
          map.delete(id)
          if (map.size === 0) this.pending.delete(session)
        }
        if (signal !== undefined && onAbort !== undefined) {
          signal.removeEventListener('abort', onAbort)
        }
        this.broadcast(session, { id, resolved: true })
        resolve(outcome)
      }
      const onAbort = signal === undefined ? undefined : () => { settle('cancelled') }
      const entry: Entry = { id, payload, settle }
      let map = this.pending.get(session)
      if (map === undefined) {
        map = new Map()
        this.pending.set(session, map)
      }
      map.set(id, entry)
      if (signal !== undefined && onAbort !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.broadcast(session, confirmEvent(entry))
    })
  }

  /** Answer one pending confirmation (first-wins); false if it never existed or already settled. */
  respond(session: string, id: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.pending.get(session)?.get(id)
    if (entry === undefined) return false
    entry.settle(decision)
    return true
  }

  pendingFor(session: string): PendingConfirm[] {
    return [...(this.pending.get(session)?.values() ?? [])].map(e => ({ id: e.id, ...e.payload }))
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Cancel every pending confirmation and end every sink; called on plugin unload. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const map of this.pending.values()) {
      for (const entry of map.values()) entry.settle('cancelled')
    }
    this.pending.clear()
    for (const set of this.channels.values()) {
      for (const sink of set) {
        try { sink.end() } catch { /* a disposed sink must not throw */ }
      }
    }
    this.channels.clear()
  }

  private broadcast(session: string, event: Record<string, unknown>): void {
    for (const sink of this.channels.get(session) ?? []) {
      this.push(sink, event)
    }
  }

  private push(sink: SseSink, event: Record<string, unknown>): void {
    try {
      if (!sink.write(`data: ${JSON.stringify(event)}\n\n`)) return
    } catch {
      this.drop(sink)
    }
  }

  private drop(sink: SseSink): void {
    const dispose = this.disposers.get(sink)
    if (dispose !== undefined) {
      dispose()
    }
  }
}

function confirmEvent(entry: Entry): Record<string, unknown> {
  return { id: entry.id, ...entry.payload }
}

/**
 * Build the {@link GuardConfirmer} one agent binding hands to `applyGuards`.
 *
 * Returning `null` (no browser subscribed) means "fall back to the preset's
 * legacy decision" rather than blocking a headless turn forever. `deny` and
 * `cancelled` both map to `deny` so a cancellation can never read as consent,
 * and an already-disposed/aborted call denies outright instead of downgrading
 * to the legacy `ask` fallback — that downgrade would let a `never`-policy
 * session's blocked call slip through.
 */
export function makeGuardConfirmer(
  center: ConfirmationCenter,
  session: string,
): GuardConfirmer {
  return async (req: GuardConfirmRequest) => {
    if (center.isDisposed || req.signal.aborted) return 'deny'
    if (!center.hasChannel(session)) return null
    const outcome = await center.request(session, {
      guardId: req.hit.id,
      guardAction: req.hit.decision.kind,
      reason: req.hit.decision.reason ?? '',
      toolName: req.toolName,
      detail: buildConfirmDetail(req.toolName, req.args),
    }, req.signal)
    return outcome === 'allow' ? 'allow' : 'deny'
  }
}
