/**
 * Same-origin HTTP client for the composer panel. Two thin wrappers over the
 * Host's read/write routes (see host/http.ts): both resolve to the refreshed
 * projection, or `null` on any transport or Host error so the caller can fall
 * back to the "unavailable" panel state without a try/catch at the call site.
 *
 * @module dsh-capability-toggle-plugin/client/api
 */

import type { CapabilityToggleProjection } from '../shared/types.ts'
import type { SetManyRequest, SetRequest, StateResponse } from './types.ts'

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
