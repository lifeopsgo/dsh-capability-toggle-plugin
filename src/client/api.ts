/**
 * Same-origin HTTP client for the composer panel. Two thin wrappers over the
 * Host's read/write routes (see host/http.ts): both resolve to the refreshed
 * projection, or `null` on any transport or Host error so the caller can fall
 * back to the "unavailable" panel state without a try/catch at the call site.
 *
 * @module dsh-capability-toggle-plugin/client/api
 */

import type { CapabilityToggleProjection } from '../shared/types.ts'
import type { ConfirmCard, ConfirmPush, ConfirmResponse, SetManyRequest, SetRequest, StateResponse } from './types.ts'

/** URL prefix the Host claims (mirrors host/http.ts ROUTE_PREFIX). */
const API = '/api/plugin/capability-toggle'

/** Fetch one session's projection; null on any transport or Host error. */
export async function fetchState(session: string): Promise<CapabilityToggleProjection | null> {
  try {
    const res = await fetch(`${API}/state?session=${encodeURIComponent(session)}`, {
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as StateResponse
    // Normalize a missing/undefined `projection` to null. Callers branch on
    // `projection === null`; an undefined would slip past that check and reach
    // `projection.rows` (a TypeError that blanks the whole composer control).
    return body.projection ?? null
  } catch {
    return null
  }
}

/** Write one stance; returns the refreshed projection, or null on failure. */
export async function writeState(req: SetRequest): Promise<CapabilityToggleProjection | null> {
  try {
    const res = await fetch(`${API}/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(req),
    })
    if (!res.ok) return null
    const body = (await res.json()) as StateResponse
    return body.projection ?? null
  } catch {
    return null
  }
}

/** Write one stance to every listed id; returns the refreshed projection, or null on failure. */
export async function writeStateMany(req: SetManyRequest): Promise<CapabilityToggleProjection | null> {
  try {
    const res = await fetch(`${API}/set-many`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(req),
    })
    if (!res.ok) return null
    const body = (await res.json()) as StateResponse
    return body.projection ?? null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseConfirmCard(value: unknown): ConfirmCard | null {
  if (!isRecord(value) || 'snapshot' in value || 'resolved' in value) return null
  const { id, guardId, guardAction, reason, toolName, detail } = value
  if (typeof id !== 'string' || id === '' || typeof guardId !== 'string' || guardId === ''
    || (guardAction !== 'deny' && guardAction !== 'ask') || typeof reason !== 'string'
    || typeof toolName !== 'string' || typeof detail !== 'string') return null
  return { id, guardId, guardAction, reason, toolName, detail }
}

function parseConfirmPush(value: unknown): ConfirmPush | null {
  if (!isRecord(value)) return null
  if ('snapshot' in value) {
    if (!Array.isArray(value.snapshot) || 'id' in value || 'resolved' in value) return null
    const cards: ConfirmCard[] = []
    const ids = new Set<string>()
    for (const entry of value.snapshot) {
      const card = parseConfirmCard(entry)
      if (card === null || ids.has(card.id)) return null
      ids.add(card.id)
      cards.push(card)
    }
    return { kind: 'snapshot', cards }
  }
  if ('resolved' in value) {
    return value.resolved === true && typeof value.id === 'string' && value.id !== ''
      ? { kind: 'resolved', id: value.id }
      : null
  }
  const card = parseConfirmCard(value)
  return card === null ? null : { kind: 'pending', card }
}

export function subscribeConfirm(session: string, onPush: (push: ConfirmPush) => void): () => void {
  if (session === '') return () => {}
  const url = `${API}/confirm/stream?session=${encodeURIComponent(session)}`
  const es = new EventSource(url)
  let active = true
  es.onmessage = (ev: MessageEvent<unknown>) => {
    if (!active || typeof ev.data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(ev.data)
    } catch {
      return
    }
    const push = parseConfirmPush(parsed)
    if (push !== null) onPush(push)
  }
  return () => { active = false; es.onmessage = null; es.close() }
}

export async function respondConfirm(
  session: string,
  id: string,
  decision: 'allow' | 'deny',
): Promise<ConfirmResponse> {
  try {
    const res = await fetch(`${API}/confirm/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ session, id, decision }),
    })
    if (res.status === 410) return 'gone'
    return res.ok ? 'accepted' : 'retry'
  } catch {
    return 'retry'
  }
}
