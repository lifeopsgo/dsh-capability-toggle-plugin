/**
 * The durable override store: one settings-namespace section holding the
 * global, per-project, and per-session override maps, with typed reads, writes,
 * and change observation. Every write goes through the settings scope so the
 * harness owns persistence, revision fencing, and the `settings/updated`
 * commit event; this module never touches disk directly.
 *
 * @module dsh-capability-toggle-plugin/host/store
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'

import type { LayeredOverrides, OverrideMap, ToggleLevel, ToggleState } from '../shared/types.ts'
import { LEVEL_PRIORITY } from '../shared/resolve.ts'
import { SETTINGS_NAMESPACE, StoredDocumentSchema } from './config.ts'
import type { StoredDocument } from './config.ts'

/** The three level selectors a write addresses; project/session need a key. */
export type LevelSelector =
  | { readonly level: 'global' }
  | { readonly level: 'project'; readonly key: string }
  | { readonly level: 'session'; readonly key: string }

/**
 * Owns the settings scope for this plugin's namespace and exposes level-aware
 * reads and writes. One instance per Host plugin activation.
 */
export class OverrideStore {
  private readonly scope: SettingsScope<StoredDocument>

  /**
   * @param ctx - the Host context (must inject `settings`).
   */
  constructor(ctx: Context) {
    this.scope = ctx.settings.register(
      settingsNamespace(SETTINGS_NAMESPACE),
      StoredDocumentSchema,
    )
  }

  /**
   * Observe committed changes to the stored document.
   * @param callback - invoked after each commit with the resolved next value.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: StoredDocument) => void): () => void {
    return this.scope.watch(next => callback(next))
  }

  /** @returns the current resolved stored document. */
  read(): StoredDocument {
    return this.scope.get()
  }

  /**
   * Assemble the three override maps that apply to one session in one project.
   * A missing project/session key contributes an empty map (all `inherit`).
   * @param projectKey - absolute project root, or `''` when none resolved.
   * @param sessionKey - the session id.
   * @returns the layered overrides for resolution.
   */
  layered(projectKey: string, sessionKey: string): LayeredOverrides {
    const doc = this.read()
    return {
      session: doc.sessions[sessionKey] ?? {},
      project: projectKey === '' ? {} : (doc.projects[projectKey] ?? {}),
      global: doc.global,
    }
  }

  /**
   * Set one capability's stance at one level, persisting the whole updated
   * document through the settings scope. A `state` of `inherit` removes the
   * stored key so the level goes silent.
   * @param selector - which level (and key) to write.
   * @param id - capability switch key.
   * @param state - the new stance; `inherit` clears the stored entry.
   */
  async set(selector: LevelSelector, id: string, state: ToggleState): Promise<void> {
    await this.scope.replace(nextDocument(this.read(), selector, map => writeMap(map, id, state)))
  }

  /**
   * Set several ids to the same stance at one level in a SINGLE settings write.
   * Equivalent to calling {@link set} once per id, but batched: one `replace()`
   * (one queue slot, one persist, one commit/broadcast) instead of `ids.length`
   * separate round trips through the settings write queue. Used by the panel's
   * bulk toolbar action (enable-all / disable-all / clear-all on a filtered
   * tab), where an empty selection is a legal no-op.
   * @param selector - which level (and key) to write.
   * @param ids - the switch keys to set; duplicates are applied in order (the
   *   last occurrence of a given id wins, matching a sequential {@link set}).
   * @param state - the new stance for every id; `inherit` clears the stored entry.
   */
  async setMany(selector: LevelSelector, ids: readonly string[], state: ToggleState): Promise<void> {
    if (ids.length === 0) return
    await this.scope.replace(nextDocument(this.read(), selector, map => {
      let next = map
      for (const id of ids) next = writeMap(next, id, state)
      return next
    }))
  }

}

/**
 * Compute the whole next document after applying `transform` to one level's
 * override map. Shared by {@link OverrideStore.set} and
 * {@link OverrideStore.setMany} so both write through the exact same
 * self-cleaning bucket logic — see the field-level comment below for why an
 * emptied bucket entry is dropped, not left as `{}`.
 * @param doc - the current stored document.
 * @param selector - which level (and key) to write.
 * @param transform - maps the level's current override map to its next value.
 * @returns the complete next document, ready for `scope.replace()`.
 */
function nextDocument(
  doc: StoredDocument,
  selector: LevelSelector,
  transform: (map: OverrideMap) => OverrideMap,
): StoredDocument {
  // `update()` is merge-only and cannot express a key deletion, so an `inherit`
  // write (which removes the stored key) would silently persist the old
  // on/off. `replace()` writes the whole section wholesale, so we rebuild the
  // complete document and hand it over each time.
  if (selector.level === 'global') {
    return { ...doc, global: transform(doc.global) }
  }
  const bucket = selector.level === 'project' ? doc.projects : doc.sessions
  const nextMap = transform(bucket[selector.key] ?? {})
  const nextBucket = { ...bucket }
  // Self-cleaning: a bucket entry whose map just went empty (every toggle reset
  // to `inherit`) is dropped, not left as `{}`. This is the ONLY reclaim path
  // for the `sessions` bucket — there is deliberately no `agent/disposed` hook
  // that prunes a session's stored overrides, because a session-level stance is
  // meant to survive a reload/restart of that session (dropping it when the
  // live agent goes away would defeat the level's purpose). The consequence is
  // a KNOWN, bounded monotonic growth: one small `{id: on|off}` entry persists
  // per session that was ever toggled at session level and not later cleared —
  // a few bytes each, never touched on a hot path, only on an explicit user
  // write. It is not a runtime leak (nothing re-reads it into memory per
  // agent), and it self-heals whenever the user resets a session's toggles. If
  // a deployment ever accumulates enough dormant sessions to care, the fix is a
  // settings-level GC keyed on genuinely-ended sessions, not a dispose-time
  // delete here. Documented rather than "fixed" on purpose.
  if (Object.keys(nextMap).length === 0) delete nextBucket[selector.key]
  else nextBucket[selector.key] = nextMap
  const field = selector.level === 'project' ? 'projects' : 'sessions'
  return { ...doc, [field]: nextBucket }
}

/**
 * Produce the next override map after setting one id to one stance. An
 * `inherit` stance deletes the key; `on`/`off` store it.
 * @param map - the current stored map.
 * @param id - capability switch key.
 * @param state - the new stance.
 * @returns a new map (the input is not mutated).
 */
export function writeMap(map: OverrideMap, id: string, state: ToggleState): OverrideMap {
  const next: Record<string, 'on' | 'off'> = { ...map }
  if (state === 'inherit') delete next[id]
  else next[id] = state
  return next
}

/**
 * The three levels a UI write may address, for input validation. Aliases the
 * shared priority order so the writable set and the resolution order can never
 * drift apart.
 */
export const WRITABLE_LEVELS: readonly ToggleLevel[] = LEVEL_PRIORITY
