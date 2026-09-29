import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type { LayeredOverrides, OverrideMap, ToggleLevel, ToggleState } from '../shared/types.ts'
import { LEVEL_PRIORITY } from '../shared/resolve.ts'
import type { OverrideConfig, StoredDocument } from './config.ts'
import { mergeLegacyOverrides, readLegacyOverrides } from './legacy-migration.ts'

export type LevelSelector =
  | { readonly level: 'global' }
  | { readonly level: 'project'; readonly key: string }
  | { readonly level: 'session'; readonly key: string }

interface StoredConfig extends StoredDocument {
  readonly legacyMigrationCompleted: boolean
}

export class OverrideStore {
  private readonly ctx: Context
  private readonly config: OverrideConfig
  private readonly legacy: StoredDocument | undefined

  constructor(ctx: Context, config: OverrideConfig, legacy?: StoredDocument) {
    this.ctx = ctx
    this.config = config
    this.legacy = legacy
  }

  read(): StoredDocument {
    const current = {
      global: this.config.global.get() ?? {},
      projects: this.config.projects.get() ?? {},
      sessions: this.config.sessions.get() ?? {},
    }
    return this.legacy === undefined || this.config.legacyMigrationCompleted.get() === true
      ? current
      : mergeLegacyOverrides(current, this.legacy)
  }

  layered(projectKey: string, sessionKey: string): LayeredOverrides {
    const doc = this.read()
    return {
      session: doc.sessions[sessionKey] ?? {},
      project: projectKey === '' ? {} : (doc.projects[projectKey] ?? {}),
      global: doc.global,
    }
  }

  async migrateLegacy(source?: StoredDocument): Promise<boolean> {
    if (this.config.legacyMigrationCompleted.get() === true) return false
    const legacy = source ?? this.legacy ?? await readLegacyOverrides()
    if (legacy === undefined) return false
    let migrated = false
    await this.ctx.configEditor.edit(this.entry(), current => {
      const existing = configOf(current)
      if (existing.legacyMigrationCompleted) return rawOf(existing)
      const next = mergeLegacyOverrides(existing, legacy)
      migrated = true
      return rawOf({ ...next, legacyMigrationCompleted: true })
    })
    return migrated
  }

  async set(selector: LevelSelector, id: string, state: ToggleState): Promise<void> {
    await this.persist(selector, map => writeMap(map, id, state))
  }

  async setMany(selector: LevelSelector, ids: readonly string[], state: ToggleState): Promise<void> {
    if (ids.length === 0) return
    await this.persist(selector, map => {
      let next = map
      for (const id of ids) next = writeMap(next, id, state)
      return next
    })
  }

  private entry() {
    const entry = this.ctx.configEditor.entries().find(row => row.options.id === 'dsh-capability-toggle-plugin')
    if (entry === undefined) throw new Error('capability-toggle configuration entry is unavailable')
    return entry
  }

  private async persist(selector: LevelSelector, transform: (map: OverrideMap) => OverrideMap): Promise<void> {
    await this.ctx.configEditor.edit(this.entry(), current => {
      const existing = configOf(current)
      const migrated = existing.legacyMigrationCompleted || this.legacy === undefined
        ? existing
        : { ...mergeLegacyOverrides(existing, this.legacy), legacyMigrationCompleted: true }
      return rawOf(nextDocument(migrated, selector, transform))
    })
  }
}

function configOf(current: Record<string, unknown>): StoredConfig {
  const doc = current as Partial<StoredConfig>
  return {
    global: doc.global ?? {},
    projects: doc.projects ?? {},
    sessions: doc.sessions ?? {},
    legacyMigrationCompleted: doc.legacyMigrationCompleted === true,
  }
}

function rawOf(document: StoredConfig): Record<string, unknown> {
  return {
    global: document.global,
    projects: document.projects,
    sessions: document.sessions,
    legacyMigrationCompleted: document.legacyMigrationCompleted,
  }
}

function nextDocument(
  doc: StoredConfig,
  selector: LevelSelector,
  transform: (map: OverrideMap) => OverrideMap,
): StoredConfig {
  if (selector.level === 'global') return { ...doc, global: transform(doc.global) }
  const bucket = selector.level === 'project' ? doc.projects : doc.sessions
  const nextMap = transform(bucket[selector.key] ?? {})
  const nextBucket = { ...bucket }
  if (Object.keys(nextMap).length === 0) delete nextBucket[selector.key]
  else nextBucket[selector.key] = nextMap
  const field = selector.level === 'project' ? 'projects' : 'sessions'
  return { ...doc, [field]: nextBucket }
}

export function writeMap(map: OverrideMap, id: string, state: ToggleState): OverrideMap {
  const next: Record<string, 'on' | 'off'> = { ...map }
  if (state === 'inherit') delete next[id]
  else next[id] = state
  return next
}

export const WRITABLE_LEVELS: readonly ToggleLevel[] = LEVEL_PRIORITY
