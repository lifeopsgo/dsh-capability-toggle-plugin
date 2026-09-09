import { LEVEL_SCOPES } from './tabs.ts'
import type { LevelScope } from './tabs.ts'

export interface PanelPrefs {
  readonly showFraction: boolean
  readonly showUsage: boolean
  readonly levels: LevelScope
}

export interface PrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const PREFS_KEY = 'dsh-capability-toggle-plugin:panel-prefs'

export const DEFAULT_PREFS: PanelPrefs = {
  showFraction: true,
  showUsage: true,
  levels: 'all',
}

function isLevelScope(value: string): value is LevelScope {
  return (LEVEL_SCOPES as readonly string[]).includes(value)
}

function defaultStorage(): PrefsStorage | undefined {
  if (typeof localStorage === 'undefined') return undefined
  return localStorage
}

export function readPrefs(storage: PrefsStorage | undefined = defaultStorage()): PanelPrefs {
  if (storage === undefined) return DEFAULT_PREFS
  let raw: string | null
  try {
    raw = storage.getItem(PREFS_KEY)
  } catch {
    return DEFAULT_PREFS
  }
  if (raw === null) return DEFAULT_PREFS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_PREFS
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_PREFS
  const candidate = parsed as Partial<Record<keyof PanelPrefs, unknown>>
  if (typeof candidate.showFraction !== 'boolean') return DEFAULT_PREFS
  if (typeof candidate.showUsage !== 'boolean') return DEFAULT_PREFS
  if (typeof candidate.levels !== 'string' || !isLevelScope(candidate.levels)) return DEFAULT_PREFS
  return { showFraction: candidate.showFraction, showUsage: candidate.showUsage, levels: candidate.levels }
}

export function writePrefs(prefs: PanelPrefs, storage: PrefsStorage | undefined = defaultStorage()): void {
  if (storage === undefined) return
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    return
  }
}
