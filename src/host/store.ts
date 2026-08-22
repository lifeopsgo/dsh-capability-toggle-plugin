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
    const doc = this.read()
    // `update()` is merge-only and cannot express a key deletion, so an
    // `inherit` write (which removes the stored key) would silently persist the
    // old on/off. `replace()` writes the whole section wholesale, so we rebuild
    // the complete document and hand it over each time.
    if (selector.level === 'global') {
      await this.scope.replace({ ...doc, global: writeMap(doc.global, id, state) })
      return
    }
    const bucket = selector.level === 'project' ? doc.projects : doc.sessions
    const current = bucket[selector.key] ?? {}
    const nextMap = writeMap(current, id, state)
    const nextBucket = { ...bucket }
    // Self-cleaning: a bucket entry whose map just went empty (every toggle
    // reset to `inherit`) is dropped, not left as `{}`. This is the ONLY reclaim
    // path for the `sessions` bucket — there is deliberately no `agent/disposed`
    // hook that prunes a session's stored overrides, because a session-level
    // stance is meant to survive a reload/restart of that session (dropping it
    // when the live agent goes away would defeat the level's purpose). The
    // consequence is a KNOWN, bounded monotonic growth: one small `{id: on|off}`
    // entry persists per session that was ever toggled at session level and not
    // later cleared — a few bytes each, never touched on a hot path, only on an
    // explicit user write. It is not a runtime leak (nothing re-reads it into
    // memory per agent), and it self-heals whenever the user resets a session's
    // toggles. If a deployment ever accumulates enough dormant sessions to care,
    // the fix is a settings-level GC keyed on genuinely-ended sessions, not a
    // dispose-time delete here. Documented rather than "fixed" on purpose.
    if (Object.keys(nextMap).length === 0) delete nextBucket[selector.key]
    else nextBucket[selector.key] = nextMap
    const field = selector.level === 'project' ? 'projects' : 'sessions'
    await this.scope.replace({ ...doc, [field]: nextBucket })
  }

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
