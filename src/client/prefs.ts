import { LEVEL_SCOPES } from './tabs.ts'
import type { LevelScope } from './tabs.ts'

export interface PanelPrefs {
  readonly showFraction: boolean
  readonly showUsage: boolean
  readonly levels: LevelScope
  readonly disableSessionRefs: boolean
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
  disableSessionRefs: false,
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
  return {
    showFraction: candidate.showFraction,
    showUsage: candidate.showUsage,
    levels: candidate.levels,
    disableSessionRefs: candidate.disableSessionRefs === true,
  }
}

export function writePrefs(prefs: PanelPrefs, storage: PrefsStorage | undefined = defaultStorage()): void {
  if (storage === undefined) return
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    return
  }
}

export const PREFS_EVENT = 'dsh-capability-toggle-plugin:prefs'

export function publishPrefs(next: PanelPrefs, storage: PrefsStorage | undefined = defaultStorage()): void {
  writePrefs(next, storage)
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: next }))
}

export function subscribePrefs(listener: (next: PanelPrefs) => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
  const onLocal = (event: Event): void => {
    const detail = (event as CustomEvent<PanelPrefs>).detail
    if (detail !== undefined) listener(detail)
  }
  const onStorage = (): void => listener(readPrefs())
  window.addEventListener(PREFS_EVENT, onLocal)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PREFS_EVENT, onLocal)
    window.removeEventListener('storage', onStorage)
  }
}
