/**
 * Presentational components for the capability-toggle popup: the three-state
 * `LevelSwitch`, the two-line `Row`, and the tabbed `Panel` body. All are pure
 * (state and fetch live in the control host, ./index.tsx) so they render from
 * props alone and carry no side effects.
 *
 * @module dsh-capability-toggle-plugin/client/components
 */

import { useState } from 'react'

import type {
  CapabilityKind, CapabilityRow, CapabilityToggleProjection, ToggleLevel, ToggleState,
} from '../shared/types.ts'
import { LEVEL_PRIORITY } from '../shared/resolve.ts'
import type { Translate } from './types.ts'

/**
 * The tab strip's identity set. Four capability families each get their own
 * tab (skills, mcps, tools, prompt gates); the two safety families — the
 * approval lock and the opt-in guard presets — are grouped under one trailing
 * "security" tab, since both are permission/safety controls rather than plain
 * capability switches. So a tab is no longer 1:1 with a `CapabilityKind`.
 */
type TabId = 'skill' | 'mcp' | 'tool' | 'prompt' | 'security'

/** Tab display order. */
const TAB_ORDER: readonly TabId[] = ['skill', 'mcp', 'tool', 'prompt', 'security']

/**
 * Which capability kinds each tab shows. Every tab but `security` maps to its
 * single like-named kind; `security` gathers the approval lock and the guard
 * presets. This is the one source of the tab→kind mapping — row filtering, the
 * per-tab counts, and the tab strip all read it, so they cannot drift.
 */
const TAB_KINDS: Readonly<Record<TabId, readonly CapabilityKind[]>> = {
  skill: ['skill'],
  mcp: ['mcp'],
  tool: ['tool'],
  prompt: ['prompt'],
  security: ['approval', 'guard'],
}

/** The three levels a row exposes, highest priority first (shared source). */
const LEVELS: readonly ToggleLevel[] = LEVEL_PRIORITY

/**
 * The glyph for one segment state. Tiny inline SVGs (no icon-font dependency),
 * sized in `em` so they scale with the button's font-size and inherit its
 * color via `currentColor`. `on` is a check, `off` an ✕, `inherit` a dash —
 * a legible at-a-glance triad. The segments are icon-only, so the stance meaning
 * lives in each segment's hover tooltip and its accessible name; the glyph itself
 * is decorative and aria-hidden.
 */
function StateGlyph(props: { readonly kind: ToggleState }): JSX.Element {
  const common = {
    width: '1em', height: '1em', viewBox: '0 0 16 16',
    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (props.kind === 'on') return <svg {...common}><path d="M3.5 8.5l3 3 6-7" /></svg>
  if (props.kind === 'off') return <svg {...common}><path d="M4 4l8 8M12 4l-8 8" /></svg>
  return <svg {...common}><path d="M4 8h8" /></svg>
}

/**
 * The switch for one level of one capability row: a SINGLE icon button showing
 * ONLY the current stance (not all three at once — the earlier three-segment
 * control turned every row into a wall of identical grey boxes). It is a
 * two-state toggle: clicking flips enabled ↔ disabled, so the common "turn this
 * off here" is one click. The third stance, "unset" (inherit from the next
 * level), is the DEFAULT and is reached by the small clear badge that appears
 * only once a level has been explicitly set — click it to revert to inherit.
 * An unset button shows a faint dash and, on click, goes to "off" (the usual
 * intent when acting on a default-enabled capability is to disable it here).
 *
 * The button colours by stance (on=green / off=red / unset=neutral) so a row
 * reads as one coloured dot per level. `disabled` reflects either a running
 * agent (whole panel) or a level that cannot be set here (e.g. project with no
 * root). Full keyboard/AT reach: the accessible name states the level and
 * current stance; the clear badge has its own label.
 */
function LevelSwitch(props: {
  readonly level: ToggleLevel
  readonly value: ToggleState
  readonly disabled: boolean
  readonly t: Translate
  readonly onPick: (next: ToggleState) => void
}): JSX.Element {
  const { level, value, disabled, t, onPick } = props
  // Main-button click flips the enabled sense; an unset level goes to "off"
  // (acting on a default-on capability usually means disabling it here).
  const toggled: ToggleState = value === 'on' ? 'off' : 'on'
  const isSet = value !== 'inherit'
  const levelName = t(`level.${level}`)
  return (
    <div className="dshct-lvsw">
      <button
        type="button"
        className="dshct-lvsw-main"
        data-kind={value}
        disabled={disabled}
        aria-label={`${levelName} · ${t(`state.${value}`)}`}
        title={`${levelName} · ${t(`state.${value}`)}`}
        onClick={() => onPick(toggled)}
      >
        <StateGlyph kind={value} />
      </button>
      {isSet
        ? (
          <button
            type="button"
            className="dshct-lvsw-clear"
            disabled={disabled}
            aria-label={`${levelName} · ${t('state.clear')}`}
            title={t('state.clear')}
            onClick={() => onPick('inherit')}
          >
            <svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )
        : null}
    </div>
  )
}

/**
 * One capability row, laid out as two lines against the shared column grid:
 * line 1 is the name (with a status dot) plus the three level segments and the
 * result badge, each aligned under its column header; line 2 is the full-width
 * description, truncated to one line and revealed in full on hover.
 *
 * An `mcp` row is expandable: its name becomes a disclosure button that reveals
 * the server's member tools (name + summary) below the description. The listing
 * is read-only — a group switch denies every member together, so there are no
 * per-member controls to show.
 *
 * `projectDisabled` greys the project segment when the session has no project
 * root to write under; the whole row's controls are also disabled while busy.
 */
function Row(props: {
  readonly row: CapabilityRow
  readonly disabled: boolean
  readonly projectDisabled: boolean
  readonly t: Translate
  readonly onSet: (level: ToggleLevel, id: string, next: ToggleState) => void
}): JSX.Element {
  const { row, disabled, projectDisabled, t } = props
  const [expanded, setExpanded] = useState(false)
  // Prompt rows carry an i18n key suffix in `name` and the registry name in
  // `description`; the approval singleton uses fixed i18n strings; every other
  // kind carries its own display strings verbatim.
  const displayName = row.kind === 'prompt'
    ? t(`prompt.${row.name}.name`)
    : row.kind === 'approval' ? t('approval.name')
      : row.kind === 'guard' ? t(`guard.${row.name}.name`) : row.name
  const displayDesc = row.kind === 'prompt'
    ? t(`prompt.${row.name}.desc`)
    : row.kind === 'approval' ? t('approval.desc')
      : row.kind === 'guard' ? t(`guard.${row.name}.desc`) : row.description
  const members = row.memberTools ?? []
  const expandable = row.kind === 'mcp' && members.length > 0
  // A guard row reuses `disabled` to mean ACTIVE (opt-in default off). Its
  // status dot lights when active (protection on) — the opposite of the
  // default-on families, where the dot lights when the capability is available
  // and greys when off. So `dotOff` is inverted for guards.
  const isGuard = row.kind === 'guard'
  const guardActive = isGuard && row.disabled
  const dotOff = isGuard ? !guardActive : row.disabled
  // Row dimming reads "not the effective/attention state": a default-on family
  // dims when disabled; a guard (default off) dims when INACTIVE, so an active
  // guard row stays full-strength like an enabled capability. `disabled` is the
  // raw wire flag, so invert it for guards here just as `dotOff` does.
  const rowDim = isGuard ? !guardActive : row.disabled
  return (
    <div className="dshct-row" data-disabled={rowDim}>
      <div className="dshct-row-top">
        {expandable
          ? (
            <button
              type="button"
              className="dshct-row-name dshct-row-name-btn"
              aria-expanded={expanded}
              title={t('mcp.expand', { count: members.length })}
              onClick={() => setExpanded(v => !v)}
            >
              <span className="dshct-caret" data-open={expanded} aria-hidden="true">▸</span>
              <span className="dshct-dot" data-off={dotOff} aria-hidden="true" />
              <span>{displayName}</span>
            </button>
          )
          : (
            <div className="dshct-row-name">
              <span className="dshct-dot" data-off={dotOff} aria-hidden="true" />
              <span title={displayName}>{displayName}</span>
            </div>
          )}
        {LEVELS.map(level => (
          <LevelSwitch
            key={level}
            level={level}
            value={row.levels[level]}
            disabled={disabled || (level === 'project' && projectDisabled)}
            t={t}
            onPick={next => props.onSet(level, row.id, next)}
          />
        ))}
        {isGuard
          ? (
            <span
              className="dshct-badge dshct-badge-guard"
              data-off={!guardActive}
              data-action={row.guardAction}
              title={guardActive
                ? (row.hitCount && row.hitCount > 0
                  ? t('guard.hits.title', { count: row.hitCount })
                  : t('guard.badge.active.title', { action: t(`guard.action.${row.guardAction}`) }))
                : t('guard.badge.inactive.title')}
            >
              {guardActive
                ? (row.hitCount && row.hitCount > 0
                  ? t('guard.hits', { count: row.hitCount })
                  : t('guard.badge.active'))
                : t('guard.badge.inactive')}
            </span>
          )
          : (
            <span
              className="dshct-badge"
              data-off={row.disabled}
              title={row.disabled ? t('badge.off.title') : t('badge.on.title')}
            >
              {row.disabled ? t('badge.off') : t('badge.on')}
            </span>
          )}
      </div>
      {expandable
        ? (
          <button
            type="button"
            className="dshct-row-desc dshct-row-desc-btn"
            data-open={expanded}
            aria-expanded={expanded}
            title={t('mcp.expand', { count: members.length })}
            onClick={() => setExpanded(v => !v)}
          >
            {displayDesc}
          </button>
        )
        : <div className="dshct-row-desc" title={displayDesc}>{displayDesc}</div>}
      {expandable && expanded
        ? (
          <ul className="dshct-members">
            {members.map(m => (
              <li key={m.name} className="dshct-member">
                <span className="dshct-member-name" title={m.name}>{m.name}</span>
                {m.description !== ''
                  ? <span className="dshct-member-desc" title={m.description}>{m.description}</span>
                  : null}
              </li>
            ))}
          </ul>
        )
        : null}
    </div>
  )
}

/** The popup body: tab strip plus the active tab's row list. */
export function Panel(props: {
  readonly projection: CapabilityToggleProjection
  readonly disabled: boolean
  readonly t: Translate
  readonly onSet: (level: ToggleLevel, id: string, next: ToggleState) => void
}): JSX.Element {
  const { projection, disabled, t } = props
  const [tab, setTab] = useState<TabId>('skill')
  // Rows for the active tab: every kind that tab gathers (one kind for the four
  // capability tabs, two for `security`), in the row order the projection gives.
  const activeKinds = TAB_KINDS[tab]
  const rows = projection.rows.filter(r => activeKinds.includes(r.kind))
  // Per-TAB counts: sum each tab's kinds. Seed from TAB_ORDER so a tab with zero
  // rows still shows 0, and read TAB_KINDS so the count matches exactly what the
  // tab would list (the security tab counts approval + guard together).
  const counts = Object.fromEntries(TAB_ORDER.map(id => [id, 0])) as Record<TabId, number>
  for (const r of projection.rows) {
    for (const id of TAB_ORDER) if (TAB_KINDS[id].includes(r.kind)) counts[id] += 1
  }
  // Only default-on families count as "off" here: a guard reuses `disabled` to
  // mean ACTIVE, so counting it would report turning a safety preset ON as a
  // capability being disabled (and light the composer's red count dot). Exclude
  // guards from this default-on tally.
  const offCount = projection.rows.filter(r => r.kind !== 'guard' && r.disabled).length
  const projectDisabled = projection.projectKey === ''

  return (
    <div className="dshct-panel" role="dialog" aria-label={t('panel.title')}>
      <div className="dshct-header">
        <span className="dshct-title">{t('panel.title')}</span>
        {offCount > 0
          ? <span className="dshct-header-sub" data-has={true}>{t('header.off', { count: offCount })}</span>
          : null}
      </div>
      <div className="dshct-tabs" role="tablist">
        {TAB_ORDER.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            className="dshct-tab"
            data-active={tab === id}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {t(`tab.${id}`)}
            <span className="dshct-tab-count">{counts[id]}</span>
          </button>
        ))}
      </div>
      <div className="dshct-note">
        {t('note.priority.lead')}
        <b>{t('note.priority.chain')}</b>
        {t('note.priority.tail')}
      </div>
      {disabled ? <div className="dshct-note dshct-running" role="status">{t('note.running')}</div> : null}
      <div className="dshct-colhead" aria-hidden="true">
        <span className="dshct-col-cap">{t('col.capability')}</span>
        {LEVELS.map(level => (
          <span key={level} className="dshct-col-lv">{t(`level.${level}`)}</span>
        ))}
        <span className="dshct-col-badge">{t('col.result')}</span>
      </div>
      <div className="dshct-list">
        {rows.length === 0
          ? <div className="dshct-empty">{t('empty')}</div>
          : rows.map(row => (
            <Row
              key={row.id}
              row={row}
              disabled={disabled}
              projectDisabled={projectDisabled}
              t={t}
              onSet={props.onSet}
            />
          ))}
      </div>
      {projectDisabled
        ? <div className="dshct-foot">{t('foot.noProject')}</div>
        : <div className="dshct-foot" title={projection.projectKey}>{t('foot.project')}</div>}
    </div>
  )
}
