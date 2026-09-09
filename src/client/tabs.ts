import type { CapabilityRow, ToggleLevel } from '../shared/types.ts'
import { LEVEL_PRIORITY } from '../shared/resolve.ts'

/**
 * The tab strip's identity set. Four capability families each get their own
 * tab (skills, mcps, tools, prompt gates); the two safety families — the
 * approval lock and the opt-in guard presets — are grouped under one trailing
 * "security" tab, since both are permission/safety controls rather than plain
 * capability switches. So a tab is no longer 1:1 with a `CapabilityKind`.
 */
export type TabId = 'skill' | 'mcp' | 'tool' | 'prompt' | 'security'

export type LevelScope = 'session' | 'session-project' | 'all'

/** Tab display order. */
export const TAB_ORDER: readonly TabId[] = ['skill', 'mcp', 'tool', 'prompt', 'security']

/**
 * Which capability kinds each tab shows. Every tab but `security` maps to its
 * single like-named kind; `security` gathers the approval lock and the guard
 * presets. This is the one source of the tab→kind mapping — row filtering, the
 * per-tab counts, and the tab strip all read it, so they cannot drift.
 */
export const TAB_KINDS: Readonly<Record<TabId, readonly CapabilityRow['kind'][]>> = {
  skill: ['skill'],
  mcp: ['mcp'],
  tool: ['tool'],
  prompt: ['prompt'],
  security: ['approval', 'guard'],
}

export const LEVEL_SCOPES: readonly LevelScope[] = ['session', 'session-project', 'all']

export function tabCounts(rows: readonly CapabilityRow[]): Record<TabId, { enabled: number; total: number }> {
  const counts = Object.fromEntries(
    TAB_ORDER.map(id => [id, { enabled: 0, total: 0 }]),
  ) as Record<TabId, { enabled: number; total: number }>
  for (const row of rows) {
    for (const id of TAB_ORDER) {
      if (!TAB_KINDS[id].includes(row.kind)) continue
      const bucket = counts[id]
      bucket.total += 1
      const active = row.kind === 'guard' ? row.disabled : !row.disabled
      if (active) bucket.enabled += 1
    }
  }
  return counts
}

export function levelsVisible(scope: LevelScope): readonly ToggleLevel[] {
  return LEVEL_PRIORITY.slice(0, scope === 'session' ? 1 : scope === 'session-project' ? 2 : LEVEL_PRIORITY.length)
}
