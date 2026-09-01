/**
 * Browser half of dsh-capability-toggle-plugin — the composer-row entry point.
 *
 * Registers one control into the composer tool row (`conversation.input.left`):
 * a small toggle button that opens the capability popup. This module owns only
 * the control host (open/close, load-on-open, out-of-click/Escape dismissal,
 * the request-ordering guard, and the write callback) plus the plugin wiring;
 * the popup's presentation lives in ./components.tsx and the two same-origin
 * HTTP calls live in ./api.ts.
 *
 * The button and every switch are disabled while the agent is running — toggles
 * apply only when the agent is idle, per the plugin's contract. State is read
 * from and written to the Host over the ./api.ts routes; the Host owns
 * persistence and enforcement.
 *
 * The component is authored with React from the loader's module table and needs
 * no framework client types at build time (see ./types.ts for why the platform
 * slot/locale types are declared locally).
 *
 * @module dsh-capability-toggle-plugin/client
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type {
  CapabilityToggleProjection, ToggleLevel, ToggleState,
} from '../shared/types.ts'
import { fetchState, writeState, writeStateMany } from './api.ts'
import { Panel } from './components.tsx'
import { NS, dictionaries } from './locales.ts'
import { injectStyles } from './styles.ts'
import type { ClientContext, InputZoneProps } from './types.ts'

/** The always-visible control: a button that toggles the popup. */
function CapabilityToggleControl(props: InputZoneProps): JSX.Element | null {
  const { session, t } = props
  const sessionId = session.sessionId
  const running = session.running
  const [open, setOpen] = useState(false)
  const [projection, setProjection] = useState<CapabilityToggleProjection | null>(null)
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const aliveRef = useRef(true)
  // Read and write each get their OWN monotonic token; a settled request
  // commits only when it is still its channel's latest. Separate channels
  // matter because a write and a refresh must not invalidate each other by
  // sharing one counter — that let a slow refresh discard a newer write's
  // committed projection (and vice versa), leaving the panel out of sync with
  // the server. A started write also bumps the read token, since its result
  // supersedes any refresh already in flight.
  const readSeqRef = useRef(0)
  const writeSeqRef = useRef(0)
  // Writes are serialized through this promise chain so rapid toggles apply in
  // FIFO order server-side; the last write's projection then reflects every
  // preceding write, instead of racing concurrent POSTs whose apply order (and
  // thus returned projection) is undefined.
  const writeChainRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    const seq = ++readSeqRef.current
    setLoading(true)
    try {
      const next = await fetchState(sessionId)
      // Bail if unmounted, superseded by a newer read, or overtaken by a write
      // started after us (which bumped readSeqRef): don't clobber fresher state.
      if (!aliveRef.current || seq !== readSeqRef.current) return
      setProjection(next)
    } finally {
      // Clear loading only if still the latest read, so a superseded refresh
      // never strands `loading` true nor fights the winner over it.
      if (aliveRef.current && seq === readSeqRef.current) setLoading(false)
    }
  }, [sessionId])

  // Load when the popup opens; also reload when the agent finishes a turn while
  // open, since restrictions may have changed the visible tool set.
  useEffect(() => {
    if (open) void refresh()
  }, [open, running, refresh])

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Return focus to the trigger when the panel closes, so a keyboard user who
  // opened it (and especially one who dismissed it with Escape) is not stranded
  // with focus on a now-removed panel element. Gated on `wasOpenRef` so the very
  // first render (open=false) does not steal focus on mount; only a real
  // open->close transition restores it.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (!open && wasOpenRef.current) buttonRef.current?.focus()
    wasOpenRef.current = open
  }, [open])

  const onSet = useCallback((level: ToggleLevel, id: string, next: ToggleState) => {
    const seq = ++writeSeqRef.current
    // A fresh write supersedes any refresh in flight: invalidate the read token
    // so a late-landing refresh cannot overwrite this write's projection.
    readSeqRef.current++
    // Enqueue on the write chain so writes apply in FIFO order server-side.
    writeChainRef.current = writeChainRef.current.then(async () => {
      const updated = await writeState({ session: sessionId, level, id, state: next })
      // Only the latest write commits its projection; earlier writes' results
      // are stale (the latest reflects them too, applied cumulatively).
      if (!aliveRef.current || seq !== writeSeqRef.current) return
      if (updated !== null) setProjection(updated)
      else void refresh()
    })
  }, [sessionId, refresh])

  // The toolbar's bulk action: same one-token-per-write / FIFO-chain discipline
  // as onSet, just posting the batched /set-many route instead of N single
  // writes. Sharing writeChainRef with onSet keeps a bulk action and an
  // in-flight single toggle from racing each other server-side.
  const onSetMany = useCallback((level: ToggleLevel, ids: readonly string[], next: ToggleState) => {
    const seq = ++writeSeqRef.current
    readSeqRef.current++
    writeChainRef.current = writeChainRef.current.then(async () => {
      const updated = await writeStateMany({ session: sessionId, level, ids, state: next })
      if (!aliveRef.current || seq !== writeSeqRef.current) return
      if (updated !== null) setProjection(updated)
      else void refresh()
    })
  }, [sessionId, refresh])

  return (
    <div className="dshct-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className="dshct-button"
        data-open={open}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('button.aria')}
        title={running ? t('button.title.running') : t('button.title')}
        onClick={() => setOpen(v => !v)}
      >
        <SlidersIcon />
      </button>
      {open
        ? (
          <div
            className="dshct-overlay"
            // Backdrop click closes. The panel stops propagation, so only a click
            // on the backdrop itself (target === the overlay) reaches here. The
            // document-level outside-click handler cannot serve this: the overlay
            // is a DOM descendant of the wrap, so a backdrop click counts as
            // "inside" there and would never close.
            onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false) }}
          >
            {loading && projection === null
              ? <div className="dshct-panel dshct-panel-loading">{t('loading')}</div>
              : projection === null
                ? <div className="dshct-panel dshct-panel-loading">{t('unavailable')}</div>
                : (
                  <Panel
                    projection={projection}
                    disabled={running}
                    t={t}
                    onSet={onSet}
                    onSetMany={onSetMany}
                  />
                )}
          </div>
        )
        : null}
    </div>
  )
}

/** Inline sliders glyph (self-contained; avoids depending on the icon package). */
function SlidersIcon(): JSX.Element {
  const s: CSSProperties = { display: 'block' }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={s} aria-hidden="true">
      <path d="M2 4.5h6M11 4.5h3M2 11.5h3M8 11.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="9.5" cy="4.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6.5" cy="11.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** Cordis plugin name (client half). */
export const name = 'dsh-capability-toggle-plugin/client'

/** Services this client half injects. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: install the dictionaries and the composer-row control.
 * @param ctx - the client root context (narrowed locally; see ./types.ts).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectStyles(), 'capability-toggle: styles')
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'capability-toggle: dictionaries')
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      { name: 'conversation.input.left', id: NS, order: 40, locale: NS },
      CapabilityToggleControl as unknown as (props: InputZoneProps) => unknown,
    ),
  )
}
