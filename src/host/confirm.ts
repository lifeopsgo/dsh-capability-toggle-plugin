/**
 * The plugin-owned blocking confirmation channel.
 *
 * WHY THIS EXISTS (not the native `ask`/approval seam): a guard that returns
 * `{ kind: 'ask' }` is routed by the tool runtime through `approval.request()`,
 * whose `decide()` short-circuits to `'rejected'` the instant the session's
 * effective approval policy is `'never'` (the `danger-full-access` permission
 * preset) — BEFORE the `approval/request` waterfall is dispatched, so the
 * browser answerer is never consulted and NO prompt is shown. The user sees the
 * call silently blocked with `the user rejected tool "bash"`. That is correct
 * DSH behavior for `never`, but it makes every `ask` guard useless under it.
 *
 * This module gives the plugin its OWN confirmation path that is independent of
 * the approval policy: a guard match registers a pending confirmation, the call
 * BLOCKS in the `tools/pre-execute` listener until a browser answers over an SSE
 * push + POST respond pair, and the answer (`allow`/`deny`) becomes the
 * decision. Because it never enters the approval waterfall, `never` cannot
 * swallow it.
 *
 * Fallback: when no browser is subscribed for the session (`hasChannel` false —
 * headless, or the panel was never opened), the caller does NOT block; it falls
 * back to the legacy decision (deny stays deny, ask stays ask), so a headless
 * turn can never hang forever waiting for a channel that will never arrive.
 *
 * Pure host logic: the SSE transport is a two-method {@link SseSink}, so this
 * module is unit-testable without any node:http objects.
 *
 * @module dsh-capability-toggle-plugin/host/confirm
 */

import { randomUUID } from 'node:crypto'

import type { GuardConfirmRequest, GuardConfirmer } from './guards.ts'

/** The write side of one Server-Sent Events connection. */
export interface SseSink {
  /** Write one already-framed SSE chunk; false when the socket is gone. */
  write(chunk: string): boolean
  /** Close the stream. */
  end(): void
}

/** What a guard match pushes to the browser so the user can decide. */
export interface ConfirmPayload {
  /** The winning `guard:<name>` id. */
  readonly guardId: string
  /** The preset's fixed action, so the card can label block vs confirm. */
  readonly guardAction: 'deny' | 'ask'
  /** The model-facing reason text. */
  readonly reason: string
  /** The guarded tool name. */
  readonly toolName: string
  /** Human-readable detail (full shell command, or bounded JSON args). */
  readonly detail: string
}

/** One pending confirmation, as the browser sees it. */
export interface PendingConfirm extends ConfirmPayload {
  /** Opaque id correlating a respond POST back to this request. */
  readonly id: string
}

/** How a blocking confirmation settled. */
export type ConfirmOutcome = 'allow' | 'deny' | 'cancelled'

/** Settle one pending confirmation exactly once. */
type Settle = (outcome: ConfirmOutcome) => void

interface Entry {
  readonly id: string
  readonly payload: ConfirmPayload
  readonly settle: Settle
}

/** Upper bound on the pushed detail text, so a huge arg cannot bloat SSE. */
const DETAIL_LIMIT = 8000

/**
 * Build the human detail for one guarded call: the full command for shell tools
 * (the user explicitly chose full-command disclosure), else bounded JSON of the
 * arguments. Never throws — a hostile `arguments` object degrades to `String()`.
 * @param toolName - the guarded tool.
 * @param args - the call's parsed arguments.
 * @returns the detail text, bounded to {@link DETAIL_LIMIT} characters.
 */
export function buildConfirmDetail(toolName: string, args: Record<string, unknown>): string {
  if ((toolName === 'bash' || toolName === 'pwsh') && typeof args['command'] === 'string') {
    return bound(args['command'] as string)
  }
  let json: string
  try {
    json = JSON.stringify(args) ?? ''
  } catch {
    json = String(args)
  }
  return bound(json)
}

function bound(text: string): string {
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(0, DETAIL_LIMIT)}…`
}

/**
 * Registry of live confirmations and their browser channels, keyed by session.
 * One instance per Host activation, shared by every agent binding and the HTTP
 * routes. All operations are synchronous except the promise a {@link request}
 * returns, which settles on respond/abort/dispose.
 */
export class ConfirmationCenter {
  private readonly channels = new Map<string, Set<SseSink>>()
  private readonly pending = new Map<string, Map<string, Entry>>()
  private readonly disposers = new WeakMap<SseSink, () => void>()
  private disposed = false

  /** Whether at least one browser is subscribed for this session right now. */
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
   * answers, the caller's signal aborts, or the center is disposed.
   * @param session - the session id whose browser should answer.
   * @param payload - what to show the user.
   * @param signal - the guarded call's cancellation; an abort settles `cancelled`.
   * @returns the outcome; `cancelled` covers both abort and dispose.
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

  /**
   * Answer one pending confirmation (first-wins). Unknown id, wrong session, or
   * an already-settled id all return false and change nothing.
   * @param session - the session the confirmation belongs to.
   * @param id - the confirmation id from the SSE push.
   * @param decision - the user's choice.
   * @returns whether this call settled the confirmation.
   */
  respond(session: string, id: string, decision: 'allow' | 'deny'): boolean {
    const entry = this.pending.get(session)?.get(id)
    if (entry === undefined) return false
    entry.settle(decision)
    return true
  }

  /** The live confirmations for a session, in registration order. */
  pendingFor(session: string): PendingConfirm[] {
    return [...(this.pending.get(session)?.values() ?? [])].map(e => ({ id: e.id, ...e.payload }))
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Tear down the center: cancel every pending confirmation and end every
   * sink. Called on plugin unload so no blocked call outlives the plugin.
   */
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
 * It is a pure factory over the center plus the session id, so the fallback
 * (no-channel) and answer-mapping logic is unit-testable without a live agent.
 *
 * The contract: when no browser is subscribed for the session it answers `null`
 * — the caller's signal to fall back to the preset's legacy decision, so a
 * headless turn never blocks on a channel that will never arrive. When a browser
 * IS subscribed it registers a blocking confirmation and maps the outcome:
 * `allow` passes through, while `deny` AND `cancelled` (turn aborted or plugin
 * disposed mid-wait) both map to `deny`, so a settled-by-cancellation call can
 * never slip through as consent.
 *
 * If the center is already disposed or the caller's signal is already aborted
 * at the moment of the call, the confirmer answers `deny` immediately — a
 * disposed/aborted state must never silently downgrade to the legacy `ask`
 * fallback, because that would let a `never`-policy session's blocked call
 * slip through as consent.
 *
 * @param center - the shared confirmation registry.
 * @param session - the session id whose browser should answer.
 * @returns a confirmer closure capturing both.
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
