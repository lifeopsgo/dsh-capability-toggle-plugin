/**
 * HTTP bridge between the browser panel and the Host controller. Registers two
 * routes on the shared web server (same origin as the GUI, so the client uses
 * relative fetch and inherits its auth):
 *
 *   GET  /api/plugin/capability-toggle/state?session=<id>
 *        -> { projection: CapabilityToggleProjection } for that session's agent,
 *           or 404 when the agent is not live.
 *   POST /api/plugin/capability-toggle/set
 *        body { session, level, id, state } -> writes one stance and returns the
 *           refreshed projection.
 *
 * This is a Host-owned control channel, not model-visible state, so it lives off
 * the session log entirely (see host/config.ts for why the state is not a
 * session event). Every write lands in the settings namespace, whose commit
 * event drives reconcile on every affected agent.
 *
 * @module dsh-capability-toggle-plugin/host/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'
// Type-only import that also loads the `ctx.webServer` augmentation onto Context.
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'

import type { ToggleLevel, ToggleState } from '../shared/types.ts'
import type { ControllerRegistry } from './controller.ts'
import type { OverrideStore } from './store.ts'
import { WRITABLE_LEVELS } from './store.ts'

/** URL path prefix this plugin claims on the web server. */
export const ROUTE_PREFIX = '/api/plugin/capability-toggle'

/** Parsed and validated body of a set request. */
export interface SetBody {
  readonly session: string
  readonly level: ToggleLevel
  readonly id: string
  readonly state: ToggleState
}

/**
 * Install the two HTTP routes. Returns the composed disposer.
 * @param ctx - the Host context (must inject `webServer`).
 * @param store - the shared override store.
 * @param registry - the live-agent controller registry.
 * @returns a disposer that unregisters both routes.
 */
export function installHttp(
  ctx: Context,
  store: OverrideStore,
  registry: ControllerRegistry,
): () => void {
  const disposeState = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: (req, res) => guard(ctx, res, () => handleState(req, res, registry)),
  })
  const disposeSet = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/set`,
    handler: (req, res) => guard(ctx, res, () => handleSet(req, res, store, registry)),
  })
  return () => {
    disposeSet()
    disposeState()
  }
}

/**
 * Run a handler and never let it throw to the web server's fallback (which
 * swallows the error into an empty 400 with no body). On any error, log it and
 * answer 500 with the message — the panel treats a non-200 as unavailable, so
 * surfacing the cause here is the only way to see it.
 * @param ctx - the Host context, for logging.
 * @param res - the response to complete on failure.
 * @param run - the wrapped handler.
 */
async function guard(
  ctx: Context,
  res: ServerResponse,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`capability-toggle route failed: ${message}`)
    if (!res.headersSent) sendJson(res, 500, { error: message })
    else res.end()
  }
}

/** Answer the projection read for one session's live agent. */
async function handleState(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ControllerRegistry,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost')
  const session = url.searchParams.get('session')
  if (session === null || session === '') {
    sendJson(res, 400, { error: 'missing session parameter' })
    return
  }
  const binding = registry.get(session)
  if (binding === undefined) {
    // No live agent: the state is still persisted, so serve a projection from
    // this session's last-known inventory resolved against the current store.
    // An agent's `agent/disposed` drops its live binding every turn, so a panel
    // reopened between turns must not lose the persisted stances — that was the
    // "reopening the popup shows nothing" bug. Only a session never seen live
    // this activation has no cache, and there is genuinely nothing to show.
    const fallback = registry.fallbackProjection(session)
    if (fallback === undefined) {
      sendJson(res, 404, { error: 'no live agent for session' })
      return
    }
    sendJson(res, 200, { projection: fallback })
    return
  }
  const descriptors = await binding.inventory()
  sendJson(res, 200, { projection: binding.projection(descriptors) })
}

/** Apply one stance write, then return the refreshed projection. */
async function handleSet(
  req: IncomingMessage,
  res: ServerResponse,
  store: OverrideStore,
  registry: ControllerRegistry,
): Promise<void> {
  let body: SetBody
  try {
    body = parseSetBody(await readBody(req))
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid body' })
    return
  }
  const binding = registry.get(body.session)

  // The project root the project level writes under. A live binding carries it;
  // with no live agent (a write while idle, between turns) fall back to the
  // session's last-known snapshot. Writing the store needs only this key and the
  // session id — NOT a live agent — so a toggle applied while idle still
  // persists. `undefined` means we have never seen this session live and cannot
  // resolve its project root, so a project-level write cannot be placed.
  const projectKey = binding?.projectKey ?? registry.lastKnownProjectKey(body.session)

  if (body.level === 'project' && (projectKey === undefined || projectKey === '')) {
    sendJson(res, 409, { error: 'this session has no project root; use session or global level' })
    return
  }

  const selector =
    body.level === 'global' ? { level: 'global' as const }
    : body.level === 'project' ? { level: 'project' as const, key: projectKey as string }
    : { level: 'session' as const, key: body.session }

  await store.set(selector, body.id, body.state)

  if (binding !== undefined) {
    // A live agent must have the write applied to its scope now. The settings
    // commit event also triggers reconcile on every agent (via the store watcher
    // in index.ts), so this agent reconciles twice per write: once here, once
    // from the watcher. That is harmless — reconcile is idempotent
    // (dispose-then-reapply) and its monotonic generation guard discards
    // whichever pass finishes second. We still await our own here so the
    // projection returned below reflects the write without racing the watcher's
    // async fan-out.
    await binding.reconcile()
    const descriptors = await binding.inventory()
    sendJson(res, 200, { projection: binding.projection(descriptors) })
    return
  }

  // No live agent: nothing to reconcile (no scope to apply to). Return the
  // fallback projection so the panel reflects the write it just made. It is
  // defined here because handleState/this write only reach the session-level
  // path with a cached snapshot; a session never seen live has no snapshot, so
  // guard against that and answer with the persisted stance echoed minimally.
  const fallback = registry.fallbackProjection(body.session)
  if (fallback === undefined) {
    sendJson(res, 404, { error: 'no live agent for session' })
    return
  }
  sendJson(res, 200, { projection: fallback })
}

/**
 * Validate an unknown parsed body into a SetBody, throwing on any deviation.
 * Exported (not a route-private helper) so its rejection/accept paths can be
 * unit-tested without a live `IncomingMessage`/`ServerResponse` pair.
 */
export function parseSetBody(raw: unknown): SetBody {
  if (raw === null || typeof raw !== 'object') throw new Error('body must be an object')
  const b = raw as Record<string, unknown>
  const session = b['session']
  const level = b['level']
  const id = b['id']
  const state = b['state']
  if (typeof session !== 'string' || session === '') throw new Error('session must be a non-empty string')
  if (typeof level !== 'string' || !WRITABLE_LEVELS.includes(level as ToggleLevel)) {
    throw new Error('level must be one of session, project, global')
  }
  if (typeof id !== 'string' || id === '') throw new Error('id must be a non-empty string')
  if (state !== 'on' && state !== 'off' && state !== 'inherit') {
    throw new Error('state must be on, off, or inherit')
  }
  return { session, level: level as ToggleLevel, id, state }
}

/** Read a request body as UTF-8 text, bounded to a sane size. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  const limit = 256 * 1024
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('body is not valid JSON')
  }
}

/** Send a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}
