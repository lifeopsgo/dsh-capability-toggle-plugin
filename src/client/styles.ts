/**
 * One-shot stylesheet injection for the capability-toggle control. The plugin
 * uses no CSS Modules (that build pipeline is monorepo-internal); instead it
 * injects one `<style data-plugin=...>` tag on first import, idempotent across
 * re-imports. Colors come from the shared `--dsw-*` theme tokens so the control
 * matches the surrounding composer chrome in every theme.
 *
 * @module dsh-capability-toggle-plugin/client/styles
 */

/** The plugin id stamped on the injected style tag (for dedupe and cleanup). */
const STYLE_ID = 'dsh-capability-toggle-plugin'

/**
 * The shared column template that keeps every row's three level segments and
 * the result badge aligned with the column-header labels above them. Kept in
 * one constant so the header grid and the row grid can never drift apart.
 */
const LEVELS_COLS = 'repeat(3,48px) 52px'

/** The complete stylesheet, scoped under the `.dshct-` class prefix. */
const CSS = `
.dshct-wrap{position:relative;display:inline-flex;align-items:center}

/* trigger button */
.dshct-button{position:relative;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0;transition:background .15s ease,color .15s ease}
.dshct-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshct-button[data-open=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshct-button:disabled{opacity:.4;cursor:default}
/* overlay: a fixed full-viewport backdrop that CENTERS the panel. Centering (not
   anchoring to the trigger) is deliberate — an expanded right sidebar (e.g.
   dsh-better-sidebar) overlaps a trigger-anchored panel; a viewport-centered
   panel clears any side chrome. The dim backdrop also gives a clear click-out
   target. Fixed + flex-center is the same mechanism that makes it work on a
   narrow phone screen, so this one rule covers both the sidebar and mobile. */
.dshct-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(0,0,0,.28);animation:dshct-fade .13s ease-out}
@keyframes dshct-fade{from{opacity:0}to{opacity:1}}
/* panel: FIXED width AND height — switching tabs never resizes it; only the
   inner list scrolls. Height is a viewport-bounded value so a short phone
   screen never clips it (min() picks the smaller of the cap and the space that
   actually fits after the overlay's 16px padding, top and bottom). */
.dshct-panel{position:relative;z-index:1;width:min(560px,100%);height:min(540px,calc(100vh - 32px));box-sizing:border-box;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3);overflow:hidden;animation:dshct-pop .14s cubic-bezier(.34,1.56,.64,1)}
@keyframes dshct-pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
.dshct-panel-loading{height:auto;min-height:132px;align-items:center;justify-content:center;padding:26px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center}

/* header */
.dshct-header{flex:none;display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:13px 15px 10px}
.dshct-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;letter-spacing:.01em}
.dshct-header-sub{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:1;font-variant-numeric:tabular-nums}
.dshct-header-sub[data-has=true]{color:var(--dsw-alias-state-error-primary)}

/* tabs */
.dshct-tabs{flex:none;display:flex;gap:2px;padding:0 11px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshct-tab{position:relative;display:inline-flex;align-items:center;gap:6px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:33px;padding:0 9px;margin-bottom:-1px;cursor:pointer;transition:color .15s ease}
.dshct-tab:hover{color:var(--dsw-alias-label-primary)}
.dshct-tab[data-active=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:600}
.dshct-tab-count{min-width:17px;height:16px;box-sizing:border-box;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-caption);font-size:10px;line-height:1;font-weight:600;font-variant-numeric:tabular-nums;transition:background .15s ease,color .15s ease}
.dshct-tab[data-active=true] .dshct-tab-count{background:var(--dsw-alias-state-business-tertiary,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-business-primary)}

/* priority note: one always-on line explaining nearest-level precedence */
.dshct-note{flex:none;padding:7px 15px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5}
.dshct-note b{color:var(--dsw-alias-label-secondary);font-weight:600}

/* running note: shown only while the agent is busy */
.dshct-running{flex:none;padding:7px 15px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;border-bottom:1px solid var(--dsw-alias-border-l1)}

/* column header row: capability | session · project · global · result */
.dshct-colhead{flex:none;display:grid;grid-template-columns:1fr ${LEVELS_COLS};align-items:center;gap:0 10px;padding:7px 15px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshct-colhead>span{font-size:11.5px;line-height:1;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);font-weight:600;text-align:center}

/* list — the only scrolling region; fills the fixed remaining height */
.dshct-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:2px 0;overscroll-behavior:contain}
.dshct-list::-webkit-scrollbar{width:9px}
.dshct-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l1);border-radius:999px;border:3px solid var(--dsw-alias-bg-base)}
.dshct-list::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary)}
.dshct-empty{margin:auto;padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}

/* rows: line 1 = name + level segments + result badge; line 2 = full-width desc */
.dshct-row{padding:9px 15px;border-bottom:1px solid var(--dsw-alias-border-l1);transition:background .12s ease,opacity .12s ease}
.dshct-row:last-child{border-bottom:0}
.dshct-row:hover{background:var(--dsw-alias-bg-layer-1)}
.dshct-row[data-disabled=true]{opacity:.66}
.dshct-row-top{display:grid;grid-template-columns:1fr ${LEVELS_COLS};align-items:center;gap:0 10px}
.dshct-row-name{min-width:0;display:flex;align-items:center;gap:7px;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
/* the name TEXT only — not every span in the row-name flexbox. A bare
   .dshct-row-name span selector also hit the status dot and the mcp caret (both
   spans), forcing sizing onto them and fighting their own rules. Target the last
   child (the text node) so the dot/caret keep their own. Single-line with
   ellipsis: the name column now takes all the width the fixed-width switch band
   leaves, so most names fit on one line; a rare long one truncates and the full
   text is on the row's title tooltip. */
.dshct-row-name>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35}
.dshct-dot{flex:none;width:7px;height:7px;border-radius:50%}
.dshct-row-name .dshct-dot{margin-top:0}
.dshct-dot[data-off=false]{background:var(--dsw-alias-state-business-primary)}
.dshct-dot[data-off=true]{background:var(--dsw-alias-state-error-primary)}
.dshct-row-desc{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5}
/* An mcp row's description doubles as a second disclosure target: the same
   click as the name caret expands the member-tool list, so the whole row (name
   OR summary) is one big hit area. Reset the button chrome to read as text, keep
   the one-line truncation, and hint interactivity on hover. */
.dshct-row-desc-btn{display:block;width:100%;border:0;background:transparent;font:inherit;font-size:11.5px;line-height:1.5;text-align:left;cursor:pointer;padding:0;color:var(--dsw-alias-label-secondary);transition:color .14s ease}
.dshct-row-desc-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshct-row-desc-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:4px}

/* mcp row: name is a disclosure button; members list read-only below the desc */
.dshct-row-name-btn{border:0;background:transparent;font:inherit;font-weight:600;text-align:left;cursor:pointer;padding:0}
.dshct-caret{flex:none;font-size:13px;line-height:1;color:var(--dsw-alias-label-secondary);transition:transform .14s ease,color .14s ease}
.dshct-caret[data-open=true]{transform:rotate(90deg);color:var(--dsw-alias-state-business-primary)}
.dshct-row-name-btn:hover .dshct-caret{color:var(--dsw-alias-label-primary)}
.dshct-members{list-style:none;margin:7px 0 1px;padding:0 0 0 14px;border-left:2px solid var(--dsw-alias-border-l1)}
.dshct-member{display:flex;flex-direction:column;gap:1px;padding:4px 0}
.dshct-member+.dshct-member{border-top:1px solid var(--dsw-alias-border-l1)}
.dshct-member-name{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;word-break:break-word;overflow-wrap:anywhere}
.dshct-member-desc{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.45;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}

/* One level's stance = a SINGLE icon button showing ONLY the current stance
   (not all three at once — the earlier three-segment control turned every row
   into a wall of identical grey boxes). A two-state toggle: click flips on↔off;
   an unset level shows a faint neutral dash and flips to "off" on click. The
   button colours by stance (on=brand blue / off=red / unset=neutral outline) so a row
   reads as one coloured dot per level. Once a level is explicitly set, a small
   clear badge appears at its top-right corner; clicking it reverts to unset. */
.dshct-lvsw{position:relative;justify-self:center;display:inline-flex}
.dshct-lvsw-main{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:1;cursor:pointer;transition:background .14s ease,color .14s ease,border-color .14s ease,transform .1s ease}
.dshct-lvsw-main svg{font-size:14px}
.dshct-lvsw-main[data-kind=inherit]{color:var(--dsw-alias-label-caption);border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-style:dashed}
.dshct-lvsw-main[data-kind=on]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}
.dshct-lvsw-main[data-kind=off]{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff}
.dshct-lvsw-main:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 1px 4px rgba(0,0,0,.14)}
.dshct-lvsw-main[data-kind=inherit]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshct-lvsw-main:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshct-lvsw-main:disabled{cursor:default;opacity:.42}
.dshct-lvsw-main:active:not(:disabled){transform:scale(.9)}
.dshct-lvsw-clear{position:absolute;top:-5px;right:-5px;display:flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:1.5px solid var(--dsw-alias-bg-base);border-radius:50%;background:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-bg-base);font-size:8px;line-height:1;cursor:pointer;transition:background .14s ease,transform .1s ease}
.dshct-lvsw-clear:hover:not(:disabled){background:var(--dsw-alias-label-secondary);transform:scale(1.12)}
.dshct-lvsw-clear:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshct-lvsw-clear:disabled{cursor:default;opacity:.42}

/* result badge in the last column */
.dshct-badge{justify-self:center;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-secondary));font-size:10.5px;line-height:15px;font-weight:600;white-space:nowrap}
/* "disabled" badge: SOLID red with white text, not the tinted-background pattern
   the "active" badge uses. Reason: the error family has no tertiary (pale-tint)
   step like the business family's state-business-tertiary, so the tinted pattern
   has to borrow state-error-secondary as the background — and that resolves to
   red-400, the SAME value state-error-primary takes in the DARK theme. Tinted bg
   + primary text therefore rendered red-on-red (invisible label) in dark mode,
   and only barely worked in light mode where primary happens to be red-600. A
   solid fill with white text is contrast-safe in BOTH themes and matches the
   "off" stance chip on the switches, so a row's result and its switch agree. */
.dshct-badge[data-off=true]{background:var(--dsw-alias-state-error-primary);color:#fff}
/* guard badge: an active guard's colour tracks its action (deny=error, ask=warning);
   inactive is neutral grey. Overrides the default [data-off] mapping above, whose
   on/off polarity does not apply to a guard's active/inactive meaning. */
.dshct-badge-guard[data-off=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-caption)}
/* deny: solid red + white text, for the same reason as the "disabled" badge above
   (in the dark theme the tinted error bg and the error text are the same red). */
.dshct-badge-guard[data-off=false][data-action=deny]{background:var(--dsw-alias-state-error-primary);color:#fff}
.dshct-badge-guard[data-off=false][data-action=ask]{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-state-business-primary))}

/* footer */
.dshct-foot{flex:none;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Narrow-screen (phone / very slim window) adaptation. The panel shell is
   already responsive (fixed centered overlay + width:min(560px,100%) +
   viewport-bounded height), so the only thing that breaks below ~440px is the
   row's fixed switch band (3×72px + 52px badge = 268px) crowding the name
   column out. Shrink that band and trim horizontal padding so the name keeps
   breathing room; both the column header and the row grid share LEVELS_COLS, so
   override both together to stay aligned. */
@media (max-width:440px){
  .dshct-colhead,.dshct-row-top{grid-template-columns:1fr repeat(3,40px) 42px;gap:0 6px}
  .dshct-colhead{padding-left:12px;padding-right:12px}
  .dshct-row{padding-left:12px;padding-right:12px}
  .dshct-header{padding-left:12px;padding-right:12px}
  .dshct-note,.dshct-running{padding-left:12px;padding-right:12px}
  .dshct-tabs{padding:0 6px}
  .dshct-tab{padding:0 6px;font-size:12px;gap:4px}
  .dshct-badge{padding:2px 6px;font-size:10px}
  .dshct-foot{padding-left:12px;padding-right:12px}
}
`

/**
 * Inject the stylesheet once, returning a disposer that removes the tag it
 * created. Idempotent and SSR-safe: a no-op returning a no-op disposer when
 * `document` is absent or the tag already exists (so a second caller never
 * removes the first caller's tag). Wire the disposer into the client's
 * `ctx.effect` so the stylesheet is torn down on unload/HMR instead of leaking
 * a stale `<style>` into `document.head`.
 *
 * Dedup key: the single `data-plugin` attribute — query, write, and the module
 * comment all agree on one marker, so a host cleanup or older build that only
 * knows `data-plugin` can never miss it and double-inject.
 *
 * @returns a disposer removing the injected tag, or a no-op when none was added.
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin="${STYLE_ID}"]`) !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
