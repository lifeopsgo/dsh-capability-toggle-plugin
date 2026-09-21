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
 *           projection. Backs the panel's bulk-toolbar (enable/disable/clear a
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
import type { ConfirmationCenter } from './confirm.ts'
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

/** Parsed and validated body of a confirmation response. */
export interface RespondBody {
  readonly session: string
  readonly id: string
  readonly decision: 'allow' | 'deny'
}

/**
 * Install the HTTP routes. Returns the composed disposer.
 * @param ctx - the Host context (must inject `webServer`).
 * @param store - the shared override store.
 * @param registry - the live-agent controller registry.
 * @returns a disposer that unregisters every route.
 */
export function installHttp(
  ctx: Context,
  store: OverrideStore,
  registry: ControllerRegistry,
  center: ConfirmationCenter,
): () => void {
  const auth = resolveAuth(ctx)
  const liveStreams = new Set<() => void>()
  const disposeState = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: (req, res) => guard(ctx, res, () =>
      handleMethod(req, res, 'GET', () => handleState(req, res, registry, auth))),
  })
  const disposeSet = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/set`,
    handler: (req, res) => guard(ctx, res, () =>
      handleMethod(req, res, 'POST', () => handleSet(req, res, store, registry, auth))),
  })
  const disposeSetMany = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/set-many`,
    handler: (req, res) => guard(ctx, res, async () =>
      handleMethod(req, res, 'POST', () => handleSetMany(req, res, store, registry, auth))),
  })
  const disposeConfirmStream = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/confirm/stream`,
    handler: (req, res) => guard(ctx, res, async () => {
      await handleMethod(req, res, 'GET', async () => {
        // The stream reports its own teardown instead of this route adding a
        // listener, so the connection's listener count stays exactly what the
        // stream owns.
        let teardown: (() => void) | undefined
        teardown = handleConfirmStream(req, res, center, auth, () => {
          if (teardown !== undefined) liveStreams.delete(teardown)
        })
        if (teardown !== undefined) liveStreams.add(teardown)
      })
    }),
  })
  const disposeConfirmRespond = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/confirm/respond`,
    handler: (req, res) => guard(ctx, res, async () => {
      await handleMethod(req, res, 'POST', async () => { await handleConfirmRespond(req, res, center, auth) })
    }),
  })
  return () => {
    disposeConfirmRespond()
    disposeConfirmStream()
    for (const teardown of [...liveStreams]) teardown()
    liveStreams.clear()
    disposeSetMany()
    disposeSet()
    disposeState()
  }
}

/**
 * Resolve the official Connection authentication seam. Named WebServer routes
 * bypass the `/api` RPC channel and the static-fallback authentication, so the
 * plugin MUST apply `connection.requestRejection(req)` itself.
 *
 * Resolved PER REQUEST, never captured at install time: a one-shot capture at
 * `installHttp` returned `() => 503` on a real restart (the service was not yet
 * resolvable), which failed EVERY route closed — the panel then reported "no
 * running agent" and showed no switches at all. `connection` is also declared in
 * the plugin's `inject`, so the framework does not call `apply` before the
 * service exists; the lazy read is the second half of the guarantee. If the seam
 * is genuinely absent the request still fails closed, but as a per-request 503
 * rather than a route that can never recover.
 */
export function resolveAuthForTest(ctx: Context): RequestRejection {
  return resolveAuth(ctx)
}

function resolveAuth(ctx: Context): RequestRejection {
  return (req) => {
    try {
      const connection = ctx.get('connection') as
        | { requestRejection?: (req: IncomingMessage) => unknown }
        | undefined
      const reject = connection?.requestRejection
      if (connection === undefined || typeof reject !== 'function') return 503
      // Call through the service object, never a detached reference: the
      // cordis traceable proxy only substitutes the real receiver when the
      // proxy itself is passed as `this`, so an unbound call throws inside the
      // service and would turn every request into a 503.
      const result = reject.call(connection, req)
      if (result === undefined) return undefined
      if (typeof result === 'number') return result
      return 503
    } catch {
      return 503
    }
  }
}

type RequestRejection = (req: IncomingMessage) => number | undefined

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

async function handleMethod(
  req: IncomingMessage,
  res: ServerResponse,
  expected: 'GET' | 'POST',
  run: () => Promise<void>,
): Promise<void> {
  if (req.method !== expected) {
    res.writeHead(405, { allow: expected })
    res.end()
    return
  }
  await run()
}

/** Answer the projection read for one session's live agent. */
async function handleState(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ControllerRegistry,
  auth: RequestRejection,
): Promise<void> {
  const rejection = auth(req)
  if (rejection !== undefined) {
    sendJson(res, rejection, { error: 'unauthorized' })
    return
  }
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
  auth: RequestRejection,
): Promise<void> {
  const rejection = auth(req)
  if (rejection !== undefined) {
    sendJson(res, rejection, { error: 'unauthorized' })
    return
  }
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { error: 'content-type must be application/json' })
    return
  }
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
  auth: RequestRejection,
): Promise<void> {
  const rejection = auth(req)
  if (rejection !== undefined) {
    sendJson(res, rejection, { error: 'unauthorized' })
    return
  }
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { error: 'content-type must be application/json' })
    return
  }
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
 * Open one browser's SSE confirmation stream; the center writes `confirm`
 * pushes into it for the subscription's lifetime. The 15s keep-alive comment
 * frame keeps intermediaries from dropping an idle stream.
 */
function handleConfirmStream(
  req: IncomingMessage,
  res: ServerResponse,
  center: ConfirmationCenter,
  auth: RequestRejection,
  onTeardown?: () => void,
): (() => void) | undefined {
  const rejection = auth(req)
  if (rejection !== undefined) {
    sendJson(res, rejection, { error: 'unauthorized' })
    return undefined
  }
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: 'cross-origin SSE is not allowed' })
    return undefined
  }
  const url = new URL(req.url ?? '', 'http://localhost')
  const session = url.searchParams.get('session')
  if (session === null || session === '') {
    sendJson(res, 400, { error: 'missing session parameter' })
    return undefined
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'connection': 'keep-alive',
  })
  res.flushHeaders()
  let torn = false
  let off: () => void = () => {}
  // The heartbeat exists BEFORE the center subscription, so a subscribe that
  // ends the sink still finds a timer to clear; creating it after `subscribe`
  // leaves the interval running forever in exactly that case.
  const keepAlive = setInterval(() => {
    try {
      if (!res.write(': keep-alive\n\n')) clearInterval(keepAlive)
    } catch {
      teardown()
    }
  }, 15_000)
  keepAlive.unref?.()
  const teardown = (): void => {
    if (torn) return
    torn = true
    clearInterval(keepAlive)
    off()
    req.removeListener('aborted', teardown)
    req.removeListener('error', teardown)
    res.removeListener('close', teardown)
    res.removeListener('error', teardown)
    res.removeListener('finish', teardown)
    if (!res.writableEnded) res.end()
    onTeardown?.()
  }
  // The center's own `end()` must run the FULL teardown, so the heartbeat stops
  // and every listener this stream installed is removed.
  const sink = {
    write: (chunk: string): boolean => res.write(chunk),
    end: (): void => teardown(),
  }
  off = center.subscribe(session, sink)
  req.once('aborted', teardown)
  req.once('error', teardown)
  res.once('close', teardown)
  res.once('error', teardown)
  res.once('finish', teardown)
  return teardown
}

async function handleConfirmRespond(
  req: IncomingMessage,
  res: ServerResponse,
  center: ConfirmationCenter,
  auth: RequestRejection,
): Promise<void> {
  const rejection = auth(req)
  if (rejection !== undefined) {
    sendJson(res, rejection, { error: 'unauthorized' })
    return
  }
  if (!isJsonContentType(req)) {
    sendJson(res, 415, { error: 'content-type must be application/json' })
    return
  }
  let body: RespondBody
  try {
    body = parseRespondBody(await readBody(req))
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid body' })
    return
  }
  const settled = center.respond(body.session, body.id, body.decision)
  // 410 (not 404) so the card reads it as "already answered" and closes itself.
  sendJson(res, settled ? 200 : 410, { settled })
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

/**
 * Validate an unknown parsed body into a RespondBody, throwing on any
 * deviation. Exported for the same unit-testability reason as
 * {@link parseSetBody}.
 */
export function parseRespondBody(raw: unknown): RespondBody {
  if (raw === null || typeof raw !== 'object') throw new Error('body must be an object')
  const b = raw as Record<string, unknown>
  const session = b['session']
  const id = b['id']
  const decision = b['decision']
  if (typeof session !== 'string' || session === '') throw new Error('session must be a non-empty string')
  if (typeof id !== 'string' || id === '') throw new Error('id must be a non-empty string')
  if (decision !== 'allow' && decision !== 'deny') throw new Error('decision must be allow or deny')
  return { session, id, decision }
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

function isJsonContentType(req: IncomingMessage): boolean {
  const header = req.headers['content-type']
  if (typeof header !== 'string') return false
  // Compare the MEDIA TYPE, not a prefix: `startsWith('application/json')`
  // also admits `application/jsonp`.
  return header.split(';', 1)[0]!.trim().toLowerCase() === 'application/json'
}

/**
 * Same-origin check for SSE. EventSource sends no Origin or Sec-Fetch-Site for
 * a same-origin GET, so when they are absent the Host header (always sent) is
 * what verifies the origin.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const host = req.headers['host']
  if (typeof host !== 'string') return false
  const origin = req.headers['origin']
  const secFetchSite = req.headers['sec-fetch-site']
  if (typeof secFetchSite === 'string') {
    if (secFetchSite === 'cross-site' || secFetchSite === 'same-site') return false
  }
  if (typeof origin === 'string') {
    // Any Origin we do see marks a cross-origin context, so accept it only when
    // it matches this server's origin exactly (scheme included) — which also
    // rejects an opaque `null` and https-on-http.
    try {
      const originUrl = new URL(origin)
      return originUrl.protocol === 'http:' && originUrl.host === host
    } catch {
      return false
    }
  }
  return true
}
