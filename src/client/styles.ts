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
/* confirm card: FIXED so a blocked call surfaces its prompt even with the
   toggle panel closed, anchored bottom-right (clear of the centered panel and
   the composer). Multiple cards would overlap; the host blocks one call per
   agent at a time, and a second card stacking over the first is still legible
   because each is opaque. Reuses dshct-pop below for its entrance. */
.dshct-confirm{position:fixed;right:16px;bottom:16px;z-index:2147482000;width:min(420px,calc(100vw - 32px));box-sizing:border-box;display:flex;flex-direction:column;gap:9px;padding:14px 15px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-label-tertiary);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3);animation:dshct-pop .14s cubic-bezier(.34,1.56,.64,1)}
.dshct-confirm[data-action="deny"]{border-left-color:var(--dsw-alias-danger,#e5484d)}
.dshct-confirm[data-action="ask"]{border-left-color:var(--dsw-alias-warning,#f5a623)}
.dshct-confirm-head{display:flex;align-items:center;gap:8px}
.dshct-confirm-badge{flex:none;font-size:11px;font-weight:600;line-height:1;padding:3px 7px;border-radius:6px;color:#fff;background:var(--dsw-alias-label-tertiary)}
.dshct-confirm-badge[data-action="deny"]{background:var(--dsw-alias-danger,#e5484d)}
.dshct-confirm-badge[data-action="ask"]{background:var(--dsw-alias-warning,#f5a623)}
.dshct-confirm-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshct-confirm-body{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dshct-confirm-section{display:flex;flex-direction:column;gap:4px}
.dshct-confirm-label{font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary)}
.dshct-confirm-reason{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.dshct-confirm-detail{margin:0;max-height:160px;overflow:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.03));font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}
.dshct-confirm-waiting{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshct-confirm-error{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-danger,#e5484d)}
.dshct-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.dshct-confirm-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;cursor:pointer;transition:background .15s ease,opacity .15s ease}
.dshct-confirm-btn:disabled{opacity:.5;cursor:default}
.dshct-confirm-btn[data-kind="allow"]{background:var(--dsw-alias-brand,#3b82f6);border-color:transparent;color:#fff}
.dshct-confirm-btn[data-kind="allow"]:hover:not(:disabled){filter:brightness(1.06)}
.dshct-confirm-btn[data-kind="deny"]:hover:not(:disabled){background:var(--dsw-alias-bg-subtle,rgba(0,0,0,.05))}
/* panel: FIXED width AND height — switching tabs never resizes it; only the
   inner list scrolls. Height is a viewport-bounded value so a short phone
   screen never clips it (min() picks the smaller of the cap and the space that
   actually fits after the overlay's 16px padding, top and bottom). */
.dshct-panel{--dshct-lv-w:48px;--dshct-badge-w:52px;--dshct-lv-n:3;--dshct-cols:repeat(var(--dshct-lv-n),var(--dshct-lv-w)) var(--dshct-badge-w);position:relative;z-index:1;width:min(560px,100%);height:min(540px,calc(100vh - 32px));box-sizing:border-box;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3);overflow:hidden;animation:dshct-pop .14s cubic-bezier(.34,1.56,.64,1)}
@keyframes dshct-pop{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
.dshct-panel-loading{height:auto;min-height:132px;align-items:center;justify-content:center;padding:26px;color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center}

/* header */
.dshct-header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 15px 9px}
.dshct-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;letter-spacing:.01em}
.dshct-header-actions{flex:none;display:flex;align-items:center;gap:8px;min-width:0}
.dshct-header-sub{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:1;font-variant-numeric:tabular-nums}
.dshct-header-sub[data-has=true]{color:var(--dsw-alias-state-error-primary)}
.dshct-pref-toggle{flex:none;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .14s ease,color .14s ease}
.dshct-pref-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshct-pref-toggle[data-open=true]{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dshct-pref-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshct-pref-caret{transition:transform .16s ease}
.dshct-pref-toggle[data-open=true] .dshct-pref-caret{transform:rotate(180deg)}

.dshct-prefs{flex:none;padding:4px 15px 10px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshct-pref-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0}
.dshct-pref-row+.dshct-pref-row{border-top:1px solid var(--dsw-alias-border-l1)}
.dshct-pref-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshct-pref-label{color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;line-height:1.3}
.dshct-pref-hint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:1.4}
.dshct-switch{position:relative;flex:none;width:36px;height:24px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-border-l2));cursor:pointer;transition:background .16s ease}
.dshct-switch::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.24);transition:transform .16s ease}
.dshct-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary)}
.dshct-switch[aria-checked=true]::after{transform:translateX(12px)}
.dshct-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dshct-pref-select{flex:none;max-width:190px;height:26px;box-sizing:border-box;padding:0 24px 0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238a8f99' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center}
.dshct-pref-select:hover{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.dshct-pref-select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}

/* tabs */
.dshct-tabs{flex:none;display:flex;gap:2px;padding:0 11px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshct-tab{position:relative;display:inline-flex;align-items:center;gap:6px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:33px;padding:0 9px;margin-bottom:-1px;cursor:pointer;transition:color .15s ease}
.dshct-tab:hover{color:var(--dsw-alias-label-primary)}
.dshct-tab[data-active=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:600}
.dshct-tab-count{min-width:17px;height:16px;box-sizing:border-box;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-caption);font-size:10px;line-height:1;font-weight:600;font-variant-numeric:tabular-nums;transition:background .15s ease,color .15s ease}
.dshct-tab-count[data-fraction=true]{min-width:31px;letter-spacing:.01em}
.dshct-tab[data-active=true] .dshct-tab-count{background:var(--dsw-alias-state-business-tertiary,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-state-business-primary)}

/* priority note: one always-on line explaining nearest-level precedence */
.dshct-note{flex:none;padding:7px 15px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5}
.dshct-note b{color:var(--dsw-alias-label-secondary);font-weight:600}

/* running note: shown only while the agent is busy */
.dshct-running{flex:none;padding:7px 15px;background:var(--dsw-specific-tip,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;border-bottom:1px solid var(--dsw-alias-border-l1)}

/* column header row: capability | session · project · global · result */
.dshct-colhead{flex:none;display:grid;grid-template-columns:1fr var(--dshct-cols);align-items:center;gap:0 10px;padding:7px 15px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshct-colhead>span{font-size:11.5px;line-height:1;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);font-weight:600;text-align:center}
/* the capability column header doubles as the search toggle's home: the glyph
   sits left of the label instead of the label alone being centered. */
.dshct-col-cap{display:flex;align-items:center;justify-content:center;gap:5px}
.dshct-search-toggle{flex:none;display:flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .14s ease,color .14s ease}
.dshct-search-toggle svg{font-size:12px}
.dshct-search-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dshct-search-toggle[data-open=true]{color:var(--dsw-alias-state-business-primary)}
.dshct-search-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}

/* search + bulk-action toolbar: same column grid as the header/rows so the
   per-level bulk trios land squarely under their level's header label. */
.dshct-toolbar{flex:none;display:grid;grid-template-columns:1fr var(--dshct-cols);align-items:center;gap:0 10px;padding:6px 15px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshct-search-input{min-width:0;width:100%;height:28px;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:26px}
.dshct-search-input::placeholder{color:var(--dsw-alias-label-caption)}
.dshct-search-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshct-bulk{position:relative;justify-self:center;display:inline-flex;align-items:center}
.dshct-bulk-btn{display:flex;align-items:center;justify-content:center;width:28px;height:28px;box-sizing:border-box;padding:0;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .14s ease,color .14s ease,border-color .14s ease,box-shadow .14s ease}
.dshct-bulk-btn svg{width:15px;height:15px;font-size:15px;transition:transform .14s ease}
.dshct-bulk-btn[data-open=false]:hover:not(:disabled){border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshct-bulk-btn[data-open=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.dshct-bulk-btn[data-open=true] svg{transform:rotate(180deg)}
.dshct-bulk-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshct-bulk-btn:disabled{cursor:default;opacity:.4}
.dshct-bulk-menu{position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:10;width:128px;box-sizing:border-box;padding:5px;display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2,var(--dsw-shadow-lv3))}
.dshct-bulk-item{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;column-gap:8px;width:100%;height:32px;box-sizing:border-box;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:500;line-height:1;letter-spacing:0;white-space:nowrap;text-align:left;cursor:pointer;transition:background .12s ease,color .12s ease}
.dshct-bulk-item svg{justify-self:center;width:14px;height:14px;font-size:14px;color:var(--dsw-alias-label-secondary)}
.dshct-bulk-item span{min-width:0;display:block;line-height:16px}
.dshct-bulk-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshct-bulk-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.dshct-bulk-item[data-kind=on] svg{color:var(--dsw-alias-state-business-primary)}
.dshct-bulk-item[data-kind=off] svg{color:var(--dsw-alias-state-error-primary)}
.dshct-bulk-item[data-kind=inherit] svg{color:var(--dsw-alias-label-secondary)}

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
.dshct-row-top{display:grid;grid-template-columns:1fr var(--dshct-cols);align-items:center;gap:0 10px}
.dshct-row-name{min-width:0;display:flex;align-items:center;gap:7px;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
/* the name TEXT only — not every span in the row-name flexbox. A bare
   .dshct-row-name span selector also hit the status dot, the mcp caret, and the
   usage badge (all spans), forcing sizing onto them and fighting their own
   rules. The text carries an explicit .dshct-row-text class for that reason:
   it used to be a >span:last-child selector, but appending the usage badge
   after the name moved :last-child onto the badge and silently dropped the
   name's truncation. Single-line with ellipsis: the name column now takes all
   the width the fixed-width switch band leaves, so most names fit on one line;
   a rare long one truncates and the full text is on the row's title tooltip. */
.dshct-row-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35}
.dshct-usage{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
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
   row's fixed switch band crowding the name column out. Shrink the per-column
   widths and trim horizontal padding so the name keeps breathing room. Only the
   width variables are overridden here: the grid template on .dshct-panel already
   derives from them via repeat(var(--dshct-lv-n),var(--dshct-lv-w)), so this
   stays aligned with the header/row/toolbar grids AND with however many level
   columns the user has made visible — the column count never has to be restated. */
@media (max-width:440px){
  .dshct-panel{--dshct-lv-w:40px;--dshct-badge-w:42px}
  .dshct-colhead,.dshct-row-top,.dshct-toolbar{gap:0 6px}
  .dshct-colhead{padding-left:12px;padding-right:12px}
  .dshct-toolbar{padding-left:12px;padding-right:12px}
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
