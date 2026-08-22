/**
 * Settings-namespace schema and stored-document shape for
 * dsh-capability-toggle-plugin.
 *
 * All three override levels live in ONE settings namespace rather than a
 * session-log event. This is deliberate: `Session.append()` exposes no way to
 * mark a non-surface event `ignorable`, and the persistence read path
 * (`assertEventsSupported`) refuses to reconstruct any log carrying an event
 * type outside the harness's generated `KNOWN_SESSION_EVENT_TYPES` set — an
 * out-of-repo plugin event can never be in that set, so a custom
 * `capability/toggle` session event would brick the session on reload. The
 * settings namespace persists across restarts too, so the session level (keyed
 * by session id) keeps its survives-reload guarantee without that risk.
 *
 * Model-visible ⟺ logged still holds: this state never becomes model text on
 * its own. Its only model effect — a capability disappearing from the tool
 * schema set or the `<available_skills>` catalog — is emitted and logged by
 * their owners (the `request/header` snapshot and tool-skill's catalog
 * message), which replay recomputes.
 *
 * @module dsh-capability-toggle-plugin/host/config
 */

import z from '@deepseek-ai/schemastery'

import type { OverrideMap } from '../shared/types.ts'

/** The settings namespace this plugin owns. */
export const SETTINGS_NAMESPACE = 'capability-toggle'

/** One capability's stored stance: only the explicit `on`/`off` are persisted. */
const StanceSchema = z.union(['on', 'off'] as const)

/** One level's stored override map (capability id to explicit stance). */
const OverrideMapSchema = z.dict(StanceSchema)

/**
 * The complete stored document: the global level, plus per-project and
 * per-session maps keyed by absolute project root and session id respectively.
 * A silent (absent) entry at any level means `inherit`.
 */
/** The resolved stored document (all defaults applied). */
export interface StoredDocument {
  readonly global: OverrideMap
  readonly projects: Readonly<Record<string, OverrideMap>>
  readonly sessions: Readonly<Record<string, OverrideMap>>
}

// Schemastery infers a mutable object type from `z.object`, but `StoredDocument`
// is deliberately `readonly` throughout (the store never mutates in place). The
// two shapes are structurally identical at runtime, so we assert the schema to
// the readonly-typed handle; the leading `z<StoredDocument>` annotation is what
// callers see, the trailing cast bridges the mutable-vs-readonly inference gap.
export const StoredDocumentSchema: z<StoredDocument> = z.object({
  global: OverrideMapSchema.default({}),
  projects: z.dict(OverrideMapSchema).default({}),
  sessions: z.dict(OverrideMapSchema).default({}),
}) as unknown as z<StoredDocument>
