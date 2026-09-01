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
 *   POST /api/plugin/capability-toggle/set-many
 *        body { session, level, ids, state } -> writes the same stance to every
 *           listed id in one settings write, and returns the refreshed
 *           projection. Backs the panel's bulk toolbar (enable/disable/clear a
 *           filtered tab's visible rows at one level).
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
import type { AgentBinding } from './agent-binding.ts'
import type { ControllerRegistry } from './controller.ts'
import type { LevelSelector, OverrideStore } from './store.ts'
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

/** Parsed and validated body of a set-many (bulk) request. */
export interface SetManyBody {
  readonly session: string
  readonly level: ToggleLevel
  readonly ids: readonly string[]
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
  const disposeSetMany = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/set-many`,
    handler: (req, res) => guard(ctx, res, () => handleSetMany(req, res, store, registry)),
  })
  return () => {
    disposeSetMany()
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
  const resolved = resolveWriteTarget(body.session, body.level, registry)
  if (resolved === null) {
    sendJson(res, 409, { error: 'this session has no project root; use session or global level' })
    return
  }
  await store.set(resolved.selector, body.id, body.state)
  await respondWithProjection(res, body.session, resolved.binding, registry)
}

/** Apply the same stance to every listed id in one write, then return the refreshed projection. */
async function handleSetMany(
  req: IncomingMessage,
  res: ServerResponse,
  store: OverrideStore,
  registry: ControllerRegistry,
): Promise<void> {
  let body: SetManyBody
  try {
    body = parseSetManyBody(await readBody(req))
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid body' })
    return
  }
  const resolved = resolveWriteTarget(body.session, body.level, registry)
  if (resolved === null) {
    sendJson(res, 409, { error: 'this session has no project root; use session or global level' })
    return
  }
  await store.setMany(resolved.selector, body.ids, body.state)
  await respondWithProjection(res, body.session, resolved.binding, registry)
}

/**
 * Resolve one write's level selector against the session's live or last-known
 * project key, shared by {@link handleSet} and {@link handleSetMany} so both
 * apply the exact same project-availability rule.
 * @param session - the session id the write addresses.
 * @param level - the requested write level.
 * @param registry - the live-agent controller registry.
 * @returns the selector and the session's live binding (if any), or `null`
 *   when a project-level write was requested with no resolvable project root.
 */
function resolveWriteTarget(
  session: string,
  level: ToggleLevel,
  registry: ControllerRegistry,
): { readonly selector: LevelSelector; readonly binding: AgentBinding | undefined } | null {
  const binding = registry.get(session)

  // The project root the project level writes under. A live binding carries it;
  // with no live agent (a write while idle, between turns) fall back to the
  // session's last-known snapshot. Writing the store needs only this key and the
  // session id — NOT a live agent — so a toggle applied while idle still
  // persists. `undefined` means we have never seen this session live and cannot
  // resolve its project root, so a project-level write cannot be placed.
  const projectKey = binding?.projectKey ?? registry.lastKnownProjectKey(session)

  if (level === 'project' && (projectKey === undefined || projectKey === '')) return null

  const selector: LevelSelector =
    level === 'global' ? { level: 'global' }
    : level === 'project' ? { level: 'project', key: projectKey as string }
    : { level: 'session', key: session }

  return { selector, binding }
}

/**
 * Answer a write with the refreshed projection, shared by {@link handleSet}
 * and {@link handleSetMany} once the store write itself has completed.
 * @param res - the response to complete.
 * @param session - the session id the write addressed.
 * @param binding - the session's live binding, or undefined when idle.
 * @param registry - the live-agent controller registry.
 */
async function respondWithProjection(
  res: ServerResponse,
  session: string,
  binding: AgentBinding | undefined,
  registry: ControllerRegistry,
): Promise<void> {
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
  const fallback = registry.fallbackProjection(session)
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

/**
 * Validate an unknown parsed body into a SetManyBody, throwing on any
 * deviation. Exported for the same unit-testability reason as
 * {@link parseSetBody}.
 */
export function parseSetManyBody(raw: unknown): SetManyBody {
  if (raw === null || typeof raw !== 'object') throw new Error('body must be an object')
  const b = raw as Record<string, unknown>
  const session = b['session']
  const level = b['level']
  const ids = b['ids']
  const state = b['state']
  if (typeof session !== 'string' || session === '') throw new Error('session must be a non-empty string')
  if (typeof level !== 'string' || !WRITABLE_LEVELS.includes(level as ToggleLevel)) {
    throw new Error('level must be one of session, project, global')
  }
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || id === '')) {
    throw new Error('ids must be an array of non-empty strings')
  }
  if (state !== 'on' && state !== 'off' && state !== 'inherit') {
    throw new Error('state must be on, off, or inherit')
  }
  return { session, level: level as ToggleLevel, ids: ids as string[], state }
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
