/**
 * Presentational components for the capability-toggle popup: the three-state
 * `LevelSwitch`, the two-line `Row`, the preferences drawer, and the tabbed
 * `Panel` body. All render from props alone; the drawer's persistence lives in
 * the control host (./index.tsx), which reads and writes the stored prefs and
 * hands the result down.
 *
 * @module dsh-capability-toggle-plugin/client/components
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type {
  CapabilityRow, CapabilityToggleProjection, ToggleLevel, ToggleState,
} from '../shared/types.ts'
import type { Translate } from './types.ts'
import type { PanelPrefs } from './prefs.ts'
import { LEVEL_SCOPES, TAB_KINDS, TAB_ORDER, levelsVisible, tabCounts } from './tabs.ts'
import type { LevelScope, TabId } from './tabs.ts'

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
 * The button colours by stance (on=brand blue / off=red / unset=neutral) so a row
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
 * The bulk-action dropdown for one level column in the search toolbar: a
 * single 28×28 trigger that opens a three-item menu (enable all / disable all
 * / clear all), reusing the same ✓/✕/– glyph language as {@link LevelSwitch}'s
 * stances so a column reads as one control whether it is acting on a single
 * row or on every currently visible one. One 28×28 target replaces the old
 * 9-button grid whose 15×20 members fell below the WCAG 2.5.8 target-size
 * floor; the actions move into a menu whose 32px rows are comfortably
 * reachable. `open`/`onOpenChange` are owned by the Panel so at most one
 * menu is ever expanded (opening B closes A). `disabled` covers the
 * running-agent lock, a project column with no project root, AND an empty
 * visible set (nothing to act on) — the caller folds all three into one flag
 * since the button has no other state to show.
 */
function BulkActions(props: {
  readonly level: ToggleLevel
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly disabled: boolean
  readonly t: Translate
  readonly onPick: (next: ToggleState) => void
}): JSX.Element {
  const { level, open, onOpenChange, disabled, t, onPick } = props
  const rootRef = useRef<HTMLDivElement>(null)
  const levelName = t(`level.${level}`)
  const actions: readonly ToggleState[] = ['on', 'off', 'inherit']
  useEffect(() => {
    if (!open) return
    const onDocPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // The Panel's own outside-close also listens for Escape on document;
        // swallowing here (capture runs first) keeps one press closing only
        // the menu, not the whole panel underneath it.
        e.stopPropagation()
        onOpenChange(false)
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, onOpenChange])
  return (
    <div className="dshct-bulk" ref={rootRef}>
      <button
        type="button"
        className="dshct-bulk-btn"
        data-open={open}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${levelName} · ${t('bulk.menu')}`}
        title={`${levelName} · ${t('bulk.menu')}`}
        onClick={() => onOpenChange(!open)}
      >
        <svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 6.25 8 9.75l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open
        ? (
            <div className="dshct-bulk-menu" role="menu" aria-label={`${levelName} · ${t('bulk.menu')}`}>
              {actions.map(state => (
                <button
                  key={state}
                  type="button"
                  role="menuitem"
                  className="dshct-bulk-item"
                  data-kind={state}
                  onClick={() => { onOpenChange(false); onPick(state) }}
                >
                  <StateGlyph kind={state} />
                  <span>{t(`bulk.${state}`)}</span>
                </button>
              ))}
            </div>
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
/**
 * Resolve one row's displayed name and description. Prompt rows carry an i18n
 * key suffix in `name` and the registry name in `description`; the approval
 * singleton uses fixed i18n strings; the guard family looks up its name/desc
 * by row name; every other kind carries its own display strings verbatim.
 * Shared by {@link Row} (rendering) and {@link Panel} (search filtering), so
 * a search matches what the user actually reads on screen, not a raw id the
 * UI never shows for these three kinds.
 */
function rowDisplayText(row: CapabilityRow, t: Translate): { name: string; desc: string } {
  if (row.kind === 'prompt') return { name: t(`prompt.${row.name}.name`), desc: t(`prompt.${row.name}.desc`) }
  if (row.kind === 'approval') return { name: t('approval.name'), desc: t('approval.desc') }
  if (row.kind === 'guard') return { name: t(`guard.${row.name}.name`), desc: t(`guard.${row.name}.desc`) }
  return { name: row.name, desc: row.description }
}

function Row(props: {
  readonly row: CapabilityRow
  readonly disabled: boolean
  readonly projectDisabled: boolean
  readonly visibleLevels: readonly ToggleLevel[]
  readonly showUsage: boolean
  readonly t: Translate
  readonly onSet: (level: ToggleLevel, id: string, next: ToggleState) => void
}): JSX.Element {
  const { row, disabled, projectDisabled, visibleLevels, showUsage, t } = props
  const [expanded, setExpanded] = useState(false)
  const { name: displayName, desc: displayDesc } = rowDisplayText(row, t)
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
              <span className="dshct-row-text">{displayName}</span>
              {showUsage && row.callCount !== undefined && row.callCount > 0
                ? (
                  <span className="dshct-usage" title={t('usage.calls.title', { count: row.callCount })}>
                    {t('usage.calls', { count: row.callCount })}
                  </span>
                )
                : null}
            </button>
          )
          : (
            <div className="dshct-row-name">
              <span className="dshct-dot" data-off={dotOff} aria-hidden="true" />
              <span className="dshct-row-text" title={displayName}>{displayName}</span>
              {showUsage && row.callCount !== undefined && row.callCount > 0
                ? (
                  <span className="dshct-usage" title={t('usage.calls.title', { count: row.callCount })}>
                    {t('usage.calls', { count: row.callCount })}
                  </span>
                )
                : null}
            </div>
          )}
        {visibleLevels.map(level => (
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

/**
 * A filtered row's plain-text haystack for the search box: the resolved
 * display name and description, lower-cased once per row per render. Search
 * matches against what the user actually SEES (translated strings), not the
 * wire `id`/`name`, so typing a guard's shown label finds it even though its
 * `row.name` is the untranslated preset key.
 */
function rowHaystack(row: CapabilityRow, t: Translate): string {
  const { name, desc } = rowDisplayText(row, t)
  return `${name} ${desc}`.toLowerCase()
}

/** The popup body: tab strip, preferences drawer, and the active tab's row list. */
export function Panel(props: {
  readonly projection: CapabilityToggleProjection
  readonly disabled: boolean
  readonly t: Translate
  readonly prefs: PanelPrefs
  readonly onPrefsChange: (prefs: PanelPrefs) => void
  readonly onSet: (level: ToggleLevel, id: string, next: ToggleState) => void
  readonly onSetMany: (level: ToggleLevel, ids: readonly string[], next: ToggleState) => void
}): JSX.Element {
  const { projection, disabled, t, prefs } = props
  const [tab, setTab] = useState<TabId>('skill')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [prefsOpen, setPrefsOpen] = useState(false)
  // Which level's bulk dropdown is expanded — one shared slot so opening a
  // second menu collapses the first (null = all closed). Closing on tab or
  // search toggle keeps a stale menu from floating over another tab's rows.
  const [bulkMenu, setBulkMenu] = useState<ToggleLevel | null>(null)
  // Rows for the active tab: every kind that tab gathers (one kind for the four
  // capability tabs, two for `security`), in the row order the projection gives.
  const activeKinds = TAB_KINDS[tab]
  const tabRows = projection.rows.filter(r => activeKinds.includes(r.kind))
  // The search box narrows the active tab's rows further, by display text; a
  // blank (or closed) search box is a no-op filter, so `rows` degrades to
  // exactly the prior per-tab list when search is untouched.
  const needle = query.trim().toLowerCase()
  const rows = needle === '' ? tabRows : tabRows.filter(r => rowHaystack(r, t).includes(needle))
  const counts = tabCounts(projection.rows)
  // Only default-on families count as "off" here: a guard reuses `disabled` to
  // mean ACTIVE, so counting it would report turning a safety preset ON as a
  // capability being disabled (and light the composer's red count dot). Exclude
  // guards from this default-on tally.
  const offCount = projection.rows.filter(r => r.kind !== 'guard' && r.disabled).length
  const projectDisabled = projection.projectKey === ''
  // Bulk-action target ids: every row CURRENTLY VISIBLE (active tab + search
  // filter), not the whole inventory and not a manual selection — matching the
  // "search narrows, bulk acts on what's shown" contract the toolbar promises.
  const visibleIds = rows.map(r => r.id)
  const visibleLevels = levelsVisible(prefs.levels)

  return (
    <div className="dshct-panel" role="dialog" aria-label={t('panel.title')} style={{ '--dshct-lv-n': visibleLevels.length } as CSSProperties}>
      <div className="dshct-header">
        <span className="dshct-title">{t('panel.title')}</span>
        <span className="dshct-header-actions">
          {offCount > 0
            ? <span className="dshct-header-sub" data-has={true}>{t('header.off', { count: offCount })}</span>
            : null}
          <button
            type="button"
            className="dshct-pref-toggle"
            data-open={prefsOpen}
            aria-expanded={prefsOpen}
            aria-label={t('prefs.toggle')}
            title={t('prefs.toggle')}
            onClick={() => { setBulkMenu(null); setPrefsOpen(v => !v) }}
          >
            <svg className="dshct-pref-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 6.25 8 9.75l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </span>
      </div>
      {prefsOpen
        ? (
          <div className="dshct-prefs">
            <div className="dshct-pref-row">
              <span className="dshct-pref-text">
                <span className="dshct-pref-label" id="dshct-pref-fraction">{t('prefs.fraction')}</span>
                <span className="dshct-pref-hint">{t('prefs.fraction.hint')}</span>
              </span>
              <button
                type="button"
                role="switch"
                className="dshct-switch"
                aria-checked={prefs.showFraction}
                aria-labelledby="dshct-pref-fraction"
                onClick={() => props.onPrefsChange({ ...prefs, showFraction: !prefs.showFraction })}
              />
            </div>
            <div className="dshct-pref-row">
              <span className="dshct-pref-text">
                <span className="dshct-pref-label" id="dshct-pref-usage">{t('prefs.usage')}</span>
                <span className="dshct-pref-hint">{t('prefs.usage.hint')}</span>
              </span>
              <button
                type="button"
                role="switch"
                className="dshct-switch"
                aria-checked={prefs.showUsage}
                aria-labelledby="dshct-pref-usage"
                onClick={() => props.onPrefsChange({ ...prefs, showUsage: !prefs.showUsage })}
              />
            </div>
            <div className="dshct-pref-row">
              <span className="dshct-pref-text">
                <span className="dshct-pref-label" id="dshct-pref-levels">{t('prefs.levels')}</span>
                <span className="dshct-pref-hint">{t('prefs.levels.hint')}</span>
              </span>
              <select
                className="dshct-pref-select"
                value={prefs.levels}
                aria-labelledby="dshct-pref-levels"
                onChange={e => props.onPrefsChange({ ...prefs, levels: e.target.value as LevelScope })}
              >
                {LEVEL_SCOPES.map(scope => (
                  <option key={scope} value={scope}>{t(`prefs.levels.${scope}`)}</option>
                ))}
              </select>
            </div>
          </div>
        )
        : null}
      <div className="dshct-tabs" role="tablist">
        {TAB_ORDER.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            className="dshct-tab"
            data-active={tab === id}
            aria-selected={tab === id}
            onClick={() => { setBulkMenu(null); setTab(id) }}
          >
            {t(`tab.${id}`)}
            <span
              className="dshct-tab-count"
              data-fraction={prefs.showFraction}
              title={t('tab.count.title', { enabled: counts[id].enabled, total: counts[id].total })}
            >
              {prefs.showFraction ? `${counts[id].enabled}/${counts[id].total}` : counts[id].total}
            </span>
          </button>
        ))}
      </div>
      <div className="dshct-note">
        {t('note.priority.lead')}
        <b>{t('note.priority.chain')}</b>
        {t('note.priority.tail')}
      </div>
      {disabled ? <div className="dshct-note dshct-running" role="status">{t('note.running')}</div> : null}
      <div className="dshct-colhead">
        <span className="dshct-col-cap">
          <button
            type="button"
            className="dshct-search-toggle"
            data-open={searchOpen}
            aria-expanded={searchOpen}
            aria-label={t('search.toggle')}
            title={t('search.toggle')}
            onClick={() => { setBulkMenu(null); setSearchOpen(v => !v) }}
          >
            <svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.6 10.6L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <span aria-hidden="true">{t('col.capability')}</span>
        </span>
        {visibleLevels.map(level => (
          <span key={level} className="dshct-col-lv" aria-hidden="true">{t(`level.${level}`)}</span>
        ))}
        <span className="dshct-col-badge" aria-hidden="true">{t('col.result')}</span>
      </div>
      {searchOpen
        ? (
          <div className="dshct-toolbar">
            <input
              type="search"
              className="dshct-search-input"
              value={query}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              onChange={e => setQuery(e.target.value)}
            />
            {visibleLevels.map(level => (
              <BulkActions
                key={level}
                level={level}
                open={bulkMenu === level}
                onOpenChange={open => setBulkMenu(open ? level : null)}
                disabled={disabled || (level === 'project' && projectDisabled) || visibleIds.length === 0}
                t={t}
                onPick={next => props.onSetMany(level, visibleIds, next)}
              />
            ))}
            <span aria-hidden="true" />
          </div>
        )
        : null}
      <div className="dshct-list" onScroll={bulkMenu !== null ? () => setBulkMenu(null) : undefined}>
        {rows.length === 0
          ? <div className="dshct-empty">{t(needle === '' ? 'empty' : 'search.empty')}</div>
          : rows.map(row => (
            <Row
              key={row.id}
              row={row}
              disabled={disabled}
              projectDisabled={projectDisabled}
              visibleLevels={visibleLevels}
              showUsage={prefs.showUsage}
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

/**
 * Shown regardless of whether the toggle panel is open — a blocked call must
 * surface its prompt even with the popup closed. The card is dismissed by the
 * Host's resolved broadcast (so every tab closes in sync), not by local state.
 */
export function ConfirmationCard(props: {
  readonly guardId: string
  readonly guardAction: 'deny' | 'ask'
  readonly reason: string
  readonly toolName: string
  readonly detail: string
  readonly busy: boolean
  readonly failed?: boolean
  readonly t: Translate
  readonly onAnswer: (decision: 'allow' | 'deny') => void
}): JSX.Element {
  const guardName = props.guardId.startsWith('guard:') ? props.guardId.slice(6) : props.guardId
  return (
    <div
      className="dshct-confirm"
      role="alertdialog"
      aria-modal="false"
      aria-label={props.t('guard.confirm.title')}
      data-action={props.guardAction}
    >
      <div className="dshct-confirm-head">
        <span className="dshct-confirm-badge" data-action={props.guardAction}>
          {props.guardAction === 'deny'
            ? props.t('guard.action.deny')
            : props.t('guard.action.ask')}
        </span>
        <span className="dshct-confirm-title">{props.t('guard.confirm.title')}</span>
      </div>
      <div className="dshct-confirm-body">
        {props.t('guard.confirm.body', { guard: guardName, tool: props.toolName })}
      </div>
      <div className="dshct-confirm-section">
        <div className="dshct-confirm-label">{props.t('guard.confirm.reason')}</div>
        <div className="dshct-confirm-reason">{props.reason}</div>
      </div>
      <div className="dshct-confirm-section">
        <div className="dshct-confirm-label">{props.t('guard.confirm.detail')}</div>
        <pre
          className="dshct-confirm-detail"
          tabIndex={0}
          aria-label={props.t('guard.confirm.detail')}
        >{props.detail}</pre>
      </div>
      {props.busy
        ? <div className="dshct-confirm-waiting">{props.t('guard.confirm.waiting')}</div>
        : null}
      {props.failed
        ? <div className="dshct-confirm-error" role="alert">{props.t('guard.confirm.retry')}</div>
        : null}
      <div className="dshct-confirm-actions">
        <button
          type="button"
          className="dshct-confirm-btn"
          data-kind="deny"
          disabled={props.busy}
          onClick={() => props.onAnswer('deny')}
        >
          {props.t('guard.confirm.deny')}
        </button>
        <button
          type="button"
          className="dshct-confirm-btn"
          data-kind="allow"
          disabled={props.busy}
          onClick={() => props.onAnswer('allow')}
        >
          {props.t('guard.confirm.allow')}
        </button>
      </div>
    </div>
  )
}
