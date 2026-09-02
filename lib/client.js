window.__ModuleLoader__.load({
	id: "dsh-capability-toggle-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/** URL prefix the Host claims (mirrors host/http.ts ROUTE_PREFIX). */
		const API = "/api/plugin/capability-toggle";
		/** Fetch one session's projection; null on any transport or Host error. */
		async function fetchState(session) {
			try {
				const res = await fetch(`${API}/state?session=${encodeURIComponent(session)}`, { headers: { accept: "application/json" } });
				if (!res.ok) return null;
				return (await res.json()).projection ?? null;
			} catch {
				return null;
			}
		}
		/** Write one stance; returns the refreshed projection, or null on failure. */
		async function writeState(req) {
			try {
				const res = await fetch(`${API}/set`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json"
					},
					body: JSON.stringify(req)
				});
				if (!res.ok) return null;
				return (await res.json()).projection ?? null;
			} catch {
				return null;
			}
		}
		/** Write one stance to every listed id; returns the refreshed projection, or null on failure. */
		async function writeStateMany(req) {
			try {
				const res = await fetch(`${API}/set-many`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json"
					},
					body: JSON.stringify(req)
				});
				if (!res.ok) return null;
				return (await res.json()).projection ?? null;
			} catch {
				return null;
			}
		}
		//#endregion
		//#region src/shared/resolve.ts
		/**
		* Priority order applied on read: the first level with an explicit stance wins.
		* This is also the display and write order, so it is the single source of truth
		* the store (`WRITABLE_LEVELS`) and the panel (`LEVELS`) both import — no level
		* list is spelled out a second time.
		*/
		const LEVEL_PRIORITY = [
			"session",
			"project",
			"global"
		];
		//#endregion
		//#region src/client/components.tsx
		/**
		* Presentational components for the capability-toggle popup: the three-state
		* `LevelSwitch`, the two-line `Row`, and the tabbed `Panel` body. All are pure
		* (state and fetch live in the control host, ./index.tsx) so they render from
		* props alone and carry no side effects.
		*
		* @module dsh-capability-toggle-plugin/client/components
		*/
		/** Tab display order. */
		const TAB_ORDER = [
			"skill",
			"mcp",
			"tool",
			"prompt",
			"security"
		];
		/**
		* Which capability kinds each tab shows. Every tab but `security` maps to its
		* single like-named kind; `security` gathers the approval lock and the guard
		* presets. This is the one source of the tab→kind mapping — row filtering, the
		* per-tab counts, and the tab strip all read it, so they cannot drift.
		*/
		const TAB_KINDS = {
			skill: ["skill"],
			mcp: ["mcp"],
			tool: ["tool"],
			prompt: ["prompt"],
			security: ["approval", "guard"]
		};
		/** The three levels a row exposes, highest priority first (shared source). */
		const LEVELS = LEVEL_PRIORITY;
		/**
		* The glyph for one segment state. Tiny inline SVGs (no icon-font dependency),
		* sized in `em` so they scale with the button's font-size and inherit its
		* color via `currentColor`. `on` is a check, `off` an ✕, `inherit` a dash —
		* a legible at-a-glance triad. The segments are icon-only, so the stance meaning
		* lives in each segment's hover tooltip and its accessible name; the glyph itself
		* is decorative and aria-hidden.
		*/
		function StateGlyph(props) {
			const common = {
				width: "1em",
				height: "1em",
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true
			};
			if (props.kind === "on") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...common,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M3.5 8.5l3 3 6-7" })
			});
			if (props.kind === "off") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...common,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 4l8 8M12 4l-8 8" })
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				...common,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 8h8" })
			});
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
		function LevelSwitch(props) {
			const { level, value, disabled, t, onPick } = props;
			const toggled = value === "on" ? "off" : "on";
			const isSet = value !== "inherit";
			const levelName = t(`level.${level}`);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshct-lvsw",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dshct-lvsw-main",
					"data-kind": value,
					disabled,
					"aria-label": `${levelName} · ${t(`state.${value}`)}`,
					title: `${levelName} · ${t(`state.${value}`)}`,
					onClick: () => onPick(toggled),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StateGlyph, { kind: value })
				}), isSet ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dshct-lvsw-clear",
					disabled,
					"aria-label": `${levelName} · ${t("state.clear")}`,
					title: t("state.clear"),
					onClick: () => onPick("inherit"),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
						width: "1em",
						height: "1em",
						viewBox: "0 0 16 16",
						fill: "none",
						"aria-hidden": "true",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M4.5 4.5l7 7M11.5 4.5l-7 7",
							stroke: "currentColor",
							strokeWidth: "2",
							strokeLinecap: "round"
						})
					})
				}) : null]
			});
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
		function BulkActions(props) {
			const { level, open, onOpenChange, disabled, t, onPick } = props;
			const rootRef = (0, react.useRef)(null);
			const levelName = t(`level.${level}`);
			const actions = [
				"on",
				"off",
				"inherit"
			];
			(0, react.useEffect)(() => {
				if (!open) return;
				const onDocPointerDown = (e) => {
					if (rootRef.current && !rootRef.current.contains(e.target)) onOpenChange(false);
				};
				const onKeyDown = (e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						onOpenChange(false);
					}
				};
				document.addEventListener("pointerdown", onDocPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("pointerdown", onDocPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [open, onOpenChange]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshct-bulk",
				ref: rootRef,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dshct-bulk-btn",
					"data-open": open,
					disabled,
					"aria-haspopup": "menu",
					"aria-expanded": open,
					"aria-label": `${levelName} · ${t("bulk.menu")}`,
					title: `${levelName} · ${t("bulk.menu")}`,
					onClick: () => onOpenChange(!open),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
						width: "1em",
						height: "1em",
						viewBox: "0 0 16 16",
						fill: "none",
						"aria-hidden": "true",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M4.5 6.25 8 9.75l3.5-3.5",
							stroke: "currentColor",
							strokeWidth: "1.5",
							strokeLinecap: "round",
							strokeLinejoin: "round"
						})
					})
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dshct-bulk-menu",
					role: "menu",
					"aria-label": `${levelName} · ${t("bulk.menu")}`,
					children: actions.map((state) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						role: "menuitem",
						className: "dshct-bulk-item",
						"data-kind": state,
						onClick: () => {
							onOpenChange(false);
							onPick(state);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StateGlyph, { kind: state }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(`bulk.${state}`) })]
					}, state))
				}) : null]
			});
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
		function rowDisplayText(row, t) {
			if (row.kind === "prompt") return {
				name: t(`prompt.${row.name}.name`),
				desc: t(`prompt.${row.name}.desc`)
			};
			if (row.kind === "approval") return {
				name: t("approval.name"),
				desc: t("approval.desc")
			};
			if (row.kind === "guard") return {
				name: t(`guard.${row.name}.name`),
				desc: t(`guard.${row.name}.desc`)
			};
			return {
				name: row.name,
				desc: row.description
			};
		}
		function Row(props) {
			const { row, disabled, projectDisabled, t } = props;
			const [expanded, setExpanded] = (0, react.useState)(false);
			const { name: displayName, desc: displayDesc } = rowDisplayText(row, t);
			const members = row.memberTools ?? [];
			const expandable = row.kind === "mcp" && members.length > 0;
			const isGuard = row.kind === "guard";
			const guardActive = isGuard && row.disabled;
			const dotOff = isGuard ? !guardActive : row.disabled;
			const rowDim = isGuard ? !guardActive : row.disabled;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshct-row",
				"data-disabled": rowDim,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshct-row-top",
						children: [
							expandable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dshct-row-name dshct-row-name-btn",
								"aria-expanded": expanded,
								title: t("mcp.expand", { count: members.length }),
								onClick: () => setExpanded((v) => !v),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshct-caret",
										"data-open": expanded,
										"aria-hidden": "true",
										children: "▸"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshct-dot",
										"data-off": dotOff,
										"aria-hidden": "true"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: displayName })
								]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshct-row-name",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dshct-dot",
									"data-off": dotOff,
									"aria-hidden": "true"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									title: displayName,
									children: displayName
								})]
							}),
							LEVELS.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LevelSwitch, {
								level,
								value: row.levels[level],
								disabled: disabled || level === "project" && projectDisabled,
								t,
								onPick: (next) => props.onSet(level, row.id, next)
							}, level)),
							isGuard ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshct-badge dshct-badge-guard",
								"data-off": !guardActive,
								"data-action": row.guardAction,
								title: guardActive ? row.hitCount && row.hitCount > 0 ? t("guard.hits.title", { count: row.hitCount }) : t("guard.badge.active.title", { action: t(`guard.action.${row.guardAction}`) }) : t("guard.badge.inactive.title"),
								children: guardActive ? row.hitCount && row.hitCount > 0 ? t("guard.hits", { count: row.hitCount }) : t("guard.badge.active") : t("guard.badge.inactive")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshct-badge",
								"data-off": row.disabled,
								title: row.disabled ? t("badge.off.title") : t("badge.on.title"),
								children: row.disabled ? t("badge.off") : t("badge.on")
							})
						]
					}),
					expandable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: "dshct-row-desc dshct-row-desc-btn",
						"data-open": expanded,
						"aria-expanded": expanded,
						title: t("mcp.expand", { count: members.length }),
						onClick: () => setExpanded((v) => !v),
						children: displayDesc
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshct-row-desc",
						title: displayDesc,
						children: displayDesc
					}),
					expandable && expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: "dshct-members",
						children: members.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: "dshct-member",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshct-member-name",
								title: m.name,
								children: m.name
							}), m.description !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshct-member-desc",
								title: m.description,
								children: m.description
							}) : null]
						}, m.name))
					}) : null
				]
			});
		}
		/**
		* A filtered row's plain-text haystack for the search box: the resolved
		* display name and description, lower-cased once per row per render. Search
		* matches against what the user actually SEES (translated strings), not the
		* wire `id`/`name`, so typing a guard's shown label finds it even though its
		* `row.name` is the untranslated preset key.
		*/
		function rowHaystack(row, t) {
			const { name, desc } = rowDisplayText(row, t);
			return `${name} ${desc}`.toLowerCase();
		}
		/** The popup body: tab strip plus the active tab's row list. */
		function Panel(props) {
			const { projection, disabled, t } = props;
			const [tab, setTab] = (0, react.useState)("skill");
			const [searchOpen, setSearchOpen] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			const [bulkMenu, setBulkMenu] = (0, react.useState)(null);
			const activeKinds = TAB_KINDS[tab];
			const tabRows = projection.rows.filter((r) => activeKinds.includes(r.kind));
			const needle = query.trim().toLowerCase();
			const rows = needle === "" ? tabRows : tabRows.filter((r) => rowHaystack(r, t).includes(needle));
			const counts = Object.fromEntries(TAB_ORDER.map((id) => [id, 0]));
			for (const r of projection.rows) for (const id of TAB_ORDER) if (TAB_KINDS[id].includes(r.kind)) counts[id] += 1;
			const offCount = projection.rows.filter((r) => r.kind !== "guard" && r.disabled).length;
			const projectDisabled = projection.projectKey === "";
			const visibleIds = rows.map((r) => r.id);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshct-panel",
				role: "dialog",
				"aria-label": t("panel.title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshct-header",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshct-title",
							children: t("panel.title")
						}), offCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dshct-header-sub",
							"data-has": true,
							children: t("header.off", { count: offCount })
						}) : null]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshct-tabs",
						role: "tablist",
						children: TAB_ORDER.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							role: "tab",
							className: "dshct-tab",
							"data-active": tab === id,
							"aria-selected": tab === id,
							onClick: () => {
								setBulkMenu(null);
								setTab(id);
							},
							children: [t(`tab.${id}`), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshct-tab-count",
								children: counts[id]
							})]
						}, id))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshct-note",
						children: [
							t("note.priority.lead"),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("note.priority.chain") }),
							t("note.priority.tail")
						]
					}),
					disabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshct-note dshct-running",
						role: "status",
						children: t("note.running")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshct-colhead",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dshct-col-cap",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dshct-search-toggle",
									"data-open": searchOpen,
									"aria-expanded": searchOpen,
									"aria-label": t("search.toggle"),
									title: t("search.toggle"),
									onClick: () => {
										setBulkMenu(null);
										setSearchOpen((v) => !v);
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
										width: "1em",
										height: "1em",
										viewBox: "0 0 16 16",
										fill: "none",
										"aria-hidden": "true",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
											cx: "7",
											cy: "7",
											r: "4.5",
											stroke: "currentColor",
											strokeWidth: "1.4"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
											d: "M10.6 10.6L14 14",
											stroke: "currentColor",
											strokeWidth: "1.4",
											strokeLinecap: "round"
										})]
									})
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									children: t("col.capability")
								})]
							}),
							LEVELS.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshct-col-lv",
								"aria-hidden": "true",
								children: t(`level.${level}`)
							}, level)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshct-col-badge",
								"aria-hidden": "true",
								children: t("col.result")
							})
						]
					}),
					searchOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshct-toolbar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "search",
								className: "dshct-search-input",
								value: query,
								placeholder: t("search.placeholder"),
								"aria-label": t("search.placeholder"),
								disabled,
								onChange: (e) => setQuery(e.target.value)
							}),
							LEVELS.map((level) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(BulkActions, {
								level,
								open: bulkMenu === level,
								onOpenChange: (open) => setBulkMenu(open ? level : null),
								disabled: disabled || level === "project" && projectDisabled || visibleIds.length === 0,
								t,
								onPick: (next) => props.onSetMany(level, visibleIds, next)
							}, level)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { "aria-hidden": "true" })
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshct-list",
						onScroll: bulkMenu !== null ? () => setBulkMenu(null) : void 0,
						children: rows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dshct-empty",
							children: t(needle === "" ? "empty" : "search.empty")
						}) : rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
							row,
							disabled,
							projectDisabled,
							t,
							onSet: props.onSet
						}, row.id))
					}),
					projectDisabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshct-foot",
						children: t("foot.noProject")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshct-foot",
						title: projection.projectKey,
						children: t("foot.project")
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Dictionary namespace this plugin owns. */
		const NS = "capability-toggle";
		/** Both dictionaries, in the shape `ctx.locale.register` expects. */
		const dictionaries = {
			zh: {
				"button.aria": "能力开关",
				"button.title": "能力开关 — 逐项启用/停用 skill、MCP、工具",
				"button.title.running": "agent 运行中，暂不可修改能力开关",
				"panel.title": "能力开关",
				"header.off": "{count} 项已停用",
				"tab.skill": "技能",
				"tab.mcp": "MCP",
				"tab.tool": "工具",
				"tab.prompt": "提示词",
				"tab.security": "安全",
				"approval.name": "审批升权",
				"approval.desc": "允许本 agent 发起需用户审批的操作（如沙箱升权）。停用后本 agent 的所有审批请求一律自动拒绝，不弹窗、不升权；与系统的 /permission 权限设置互不干扰。",
				"guard.readonly.name": "只读模式",
				"guard.readonly.desc": "开启后，本 agent 的所有文件写入/新建/编辑（write、create、edit）一律拦截并返回错误，只能读不能改。适合让 agent 只做分析、审查而不动代码。",
				"guard.protect-secrets.name": "保护密钥",
				"guard.protect-secrets.desc": "开启后，凡涉及 .env、私钥（*.pem、id_rsa）、credentials、.ssh/ 等密钥文件的读写或 shell 命令一律拦截。防止密钥被读出或覆写。",
				"guard.dangerous-shell.name": "危险 shell 需确认",
				"guard.dangerous-shell.desc": "开启后，rm -rf、dd、mkfs、chmod 777、curl|sh、fork 炸弹等高危命令不直接执行，转为向你发起一次审批确认——你点允许才跑，否则拦截。",
				"guard.no-destructive-git.name": "破坏性 git 需确认",
				"guard.no-destructive-git.desc": "开启后，git push --force、reset --hard、clean -fd、branch -D 等会丢历史/丢改动的命令转为审批确认，你点允许才执行。",
				"guard.no-network.name": "外网出站需确认",
				"guard.no-network.desc": "开启后，联网动作（web_search、read_page、curl/wget、git push、npm publish）转为审批确认，你点允许才执行。适合离线或敏感环境。",
				"guard.action.deny": "拦截",
				"guard.action.ask": "需确认",
				"guard.badge.active": "守护中",
				"guard.badge.inactive": "未启用",
				"guard.badge.active.title": "综合三级判定后：此守卫当前生效，命中的调用会被处置",
				"guard.badge.inactive.title": "综合三级判定后：此守卫当前未启用，不影响任何调用",
				"guard.hits": "命中 {count} 次",
				"guard.hits.title": "本会话已有 {count} 次调用命中此守卫并被处置（拦截或转确认）",
				"prompt.persona.name": "部署人格",
				"prompt.persona.desc": "注入到系统提示词开头的部署人格设定；停用后本会话不再注入这段人格。",
				"prompt.sandbox.name": "沙箱策略告知",
				"prompt.sandbox.desc": "告知模型当前文件沙箱模式的运行时上下文；停用只是不再告知模型，实际沙箱策略仍照常强制。",
				"prompt.approval.name": "审批策略告知",
				"prompt.approval.desc": "告知模型工具调用是否需要用户审批的运行时上下文；停用只是不再告知模型，实际审批策略仍照常强制。",
				"prompt.runtime.name": "隐藏全部运行时上下文",
				"prompt.runtime.desc": "一次性隐藏本会话所有运行时上下文快照（沙箱、审批等）；只影响告知模型的内容，不改变任何服务的实际强制行为。",
				"level.session": "会话级",
				"level.project": "项目级",
				"level.global": "全局",
				"col.capability": "能力",
				"col.result": "结果",
				"note.priority.lead": "就近生效原则：",
				"note.priority.chain": "会话级 › 项目级 › 全局",
				"note.priority.tail": "，某层「未设」就向下跟随；三层都未设时默认启用。右侧标签是综合三层后的真实结果。",
				"state.on": "本层始终启用此能力",
				"state.off": "本层停用此能力",
				"state.inherit": "本层不设，由下一层决定",
				"state.clear": "清除本层设置（恢复未设）",
				"badge.on": "生效中",
				"badge.off": "已停用",
				"badge.on.title": "综合三级判定后：此能力当前启用",
				"badge.off.title": "综合三级判定后：此能力当前停用",
				"note.running": "agent 运行中，修改已暂时锁定，待空闲后可调整",
				"empty": "当前分类没有可切换的项目",
				"mcp.expand": "展开查看该 server 的 {count} 个工具",
				"search.toggle": "搜索与批量操作",
				"search.placeholder": "按名称或描述搜索…",
				"search.empty": "没有匹配的项目",
				"bulk.menu": "批量操作",
				"bulk.on": "全部启用",
				"bulk.off": "全部停用",
				"bulk.inherit": "全部清除",
				"loading": "加载中…",
				"unavailable": "当前会话没有运行中的 agent，暂不可用",
				"foot.noProject": "当前会话没有项目目录，项目级开关不可用",
				"foot.project": "项目级开关作用于当前工作目录"
			},
			en: {
				"button.aria": "Capabilities",
				"button.title": "Capabilities — enable/disable skills, MCP, and tools per entry",
				"button.title.running": "Agent is running; capability toggles are locked",
				"panel.title": "Capabilities",
				"tab.skill": "Skills",
				"tab.mcp": "MCP",
				"tab.tool": "Tools",
				"tab.prompt": "Prompt",
				"tab.security": "Security",
				"approval.name": "Approval escalation",
				"approval.desc": "Allow this agent to raise actions that need user approval (e.g. sandbox escalation). When off, every approval request from this agent is auto-rejected — no prompt, no elevation; independent of the system /permission settings.",
				"guard.readonly.name": "Read-only mode",
				"guard.readonly.desc": "When on, every file write/create/edit (write, create, edit) by this agent is blocked with an error — it can read but not change files. Good for analysis or review runs that must not touch code.",
				"guard.protect-secrets.name": "Protect secrets",
				"guard.protect-secrets.desc": "When on, any read/write or shell command touching secret files (.env, private keys *.pem/id_rsa, credentials, .ssh/) is blocked, so secrets cannot be read out or overwritten.",
				"guard.dangerous-shell.name": "Confirm dangerous shell",
				"guard.dangerous-shell.desc": "When on, high-risk commands (rm -rf, dd, mkfs, chmod 777, curl|sh, fork bombs) are not run directly — they raise one approval prompt to you; they run only if you allow, else blocked.",
				"guard.no-destructive-git.name": "Confirm destructive git",
				"guard.no-destructive-git.desc": "When on, history/work-losing git commands (push --force, reset --hard, clean -fd, branch -D) raise an approval prompt and run only if you allow.",
				"guard.no-network.name": "Confirm outbound network",
				"guard.no-network.desc": "When on, network actions (web_search, read_page, curl/wget, git push, npm publish) raise an approval prompt and run only if you allow. Good for offline or sensitive environments.",
				"guard.action.deny": "Block",
				"guard.action.ask": "Confirm",
				"guard.badge.active": "Guarding",
				"guard.badge.inactive": "Inactive",
				"guard.badge.active.title": "Resolved across all three levels: this guard is active and will act on matching calls",
				"guard.badge.inactive.title": "Resolved across all three levels: this guard is inactive and affects no call",
				"guard.hits": "matched {count}",
				"guard.hits.title": "{count} call(s) matched and acted on by this guard this session (blocked or sent to confirm)",
				"prompt.persona.name": "Deployment persona",
				"prompt.persona.desc": "The deployment persona injected at the top of the system prompt; disabling stops injecting it for this session.",
				"prompt.sandbox.name": "Sandbox policy notice",
				"prompt.sandbox.desc": "Runtime context telling the model the current file-sandbox mode; disabling only stops telling the model — the sandbox policy is still enforced.",
				"prompt.approval.name": "Approval policy notice",
				"prompt.approval.desc": "Runtime context telling the model whether tool calls need user approval; disabling only stops telling the model — the approval policy is still enforced.",
				"prompt.runtime.name": "Hide all runtime context",
				"prompt.runtime.desc": "Hide every runtime-context snapshot (sandbox, approval, …) for this session at once; affects only what the model is told, never what any service enforces.",
				"level.session": "Session",
				"level.project": "Project",
				"level.global": "Global",
				"col.capability": "Capability",
				"col.result": "Result",
				"note.priority.lead": "Nearest level wins: ",
				"note.priority.chain": "Session › Project › Global",
				"note.priority.tail": ". An “Unset” level defers to the next; enabled by default when all three are unset. The right-hand badge is the real result across all three.",
				"state.on": "Always enable this capability at this level",
				"state.off": "Disable this capability at this level",
				"state.inherit": "Leave unset at this level; defer to the next",
				"state.clear": "Clear this level (revert to unset)",
				"badge.on": "Active",
				"badge.off": "Disabled",
				"badge.on.title": "Resolved across all three levels: currently enabled",
				"badge.off.title": "Resolved across all three levels: currently disabled",
				"header.off": "{count} disabled",
				"note.running": "Agent is running; changes are locked until it goes idle",
				"empty": "No switchable entries in this tab",
				"mcp.expand": "Show this server's {count} tool(s)",
				"search.toggle": "Search and bulk actions",
				"search.placeholder": "Search by name or description…",
				"search.empty": "No entries match",
				"bulk.menu": "Bulk actions",
				"bulk.on": "Enable all",
				"bulk.off": "Disable all",
				"bulk.inherit": "Clear all",
				"loading": "Loading…",
				"unavailable": "No running agent for this session",
				"foot.noProject": "This session has no project directory; the project level is unavailable",
				"foot.project": "The project level applies to the current working directory"
			}
		};
		//#endregion
		//#region src/client/styles.ts
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
		const STYLE_ID = "dsh-capability-toggle-plugin";
		/**
		* The shared column template that keeps every row's three level segments and
		* the result badge aligned with the column-header labels above them. Kept in
		* one constant so the header grid and the row grid can never drift apart.
		*/
		const LEVELS_COLS = "repeat(3,48px) 52px";
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
.dshct-toolbar{flex:none;display:grid;grid-template-columns:1fr ${LEVELS_COLS};align-items:center;gap:0 10px;padding:6px 15px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshct-search-input{min-width:0;width:100%;height:28px;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:26px}
.dshct-search-input::placeholder{color:var(--dsw-alias-label-caption)}
.dshct-search-input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dshct-search-input:disabled{opacity:.5;cursor:default}
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
  .dshct-colhead,.dshct-row-top,.dshct-toolbar{grid-template-columns:1fr repeat(3,40px) 42px;gap:0 6px}
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
`;
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
		function injectStyles() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector(`style[data-plugin="${STYLE_ID}"]`) !== null) return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* Browser half of dsh-capability-toggle-plugin — the composer-row entry point.
		*
		* Registers one control into the composer tool row (`conversation.input.left`):
		* a small toggle button that opens the capability popup. This module owns only
		* the control host (open/close, load-on-open, out-of-click/Escape dismissal,
		* the request-ordering guard, and the write callback) plus the plugin wiring;
		* the popup's presentation lives in ./components.tsx and the two same-origin
		* HTTP calls live in ./api.ts.
		*
		* The button and every switch are disabled while the agent is running — toggles
		* apply only when the agent is idle, per the plugin's contract. State is read
		* from and written to the Host over the ./api.ts routes; the Host owns
		* persistence and enforcement.
		*
		* The component is authored with React from the loader's module table and needs
		* no framework client types at build time (see ./types.ts for why the platform
		* slot/locale types are declared locally).
		*
		* @module dsh-capability-toggle-plugin/client
		*/
		/** The always-visible control: a button that toggles the popup. */
		function CapabilityToggleControl(props) {
			const { session, t } = props;
			const sessionId = session.sessionId;
			const running = session.running;
			const [open, setOpen] = (0, react.useState)(false);
			const [projection, setProjection] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const wrapRef = (0, react.useRef)(null);
			const buttonRef = (0, react.useRef)(null);
			const aliveRef = (0, react.useRef)(true);
			const readSeqRef = (0, react.useRef)(0);
			const writeSeqRef = (0, react.useRef)(0);
			const writeChainRef = (0, react.useRef)(Promise.resolve());
			(0, react.useEffect)(() => {
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
				};
			}, []);
			const refresh = (0, react.useCallback)(async () => {
				const seq = ++readSeqRef.current;
				setLoading(true);
				try {
					const next = await fetchState(sessionId);
					if (!aliveRef.current || seq !== readSeqRef.current) return;
					setProjection(next);
				} finally {
					if (aliveRef.current && seq === readSeqRef.current) setLoading(false);
				}
			}, [sessionId]);
			(0, react.useEffect)(() => {
				if (open) refresh();
			}, [
				open,
				running,
				refresh
			]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onDown = (e) => {
					if (wrapRef.current !== null && !wrapRef.current.contains(e.target)) setOpen(false);
				};
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const wasOpenRef = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (!open && wasOpenRef.current) buttonRef.current?.focus();
				wasOpenRef.current = open;
			}, [open]);
			const onSet = (0, react.useCallback)((level, id, next) => {
				const seq = ++writeSeqRef.current;
				readSeqRef.current++;
				writeChainRef.current = writeChainRef.current.then(async () => {
					const updated = await writeState({
						session: sessionId,
						level,
						id,
						state: next
					});
					if (!aliveRef.current || seq !== writeSeqRef.current) return;
					if (updated !== null) setProjection(updated);
					else refresh();
				});
			}, [sessionId, refresh]);
			const onSetMany = (0, react.useCallback)((level, ids, next) => {
				const seq = ++writeSeqRef.current;
				readSeqRef.current++;
				writeChainRef.current = writeChainRef.current.then(async () => {
					const updated = await writeStateMany({
						session: sessionId,
						level,
						ids,
						state: next
					});
					if (!aliveRef.current || seq !== writeSeqRef.current) return;
					if (updated !== null) setProjection(updated);
					else refresh();
				});
			}, [sessionId, refresh]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshct-wrap",
				ref: wrapRef,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					ref: buttonRef,
					className: "dshct-button",
					"data-open": open,
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": t("button.aria"),
					title: running ? t("button.title.running") : t("button.title"),
					onClick: () => setOpen((v) => !v),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SlidersIcon, {})
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dshct-overlay",
					onMouseDown: (e) => {
						if (e.target === e.currentTarget) setOpen(false);
					},
					children: loading && projection === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshct-panel dshct-panel-loading",
						children: t("loading")
					}) : projection === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshct-panel dshct-panel-loading",
						children: t("unavailable")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Panel, {
						projection,
						disabled: running,
						t,
						onSet,
						onSetMany
					})
				}) : null]
			});
		}
		/** Inline sliders glyph (self-contained; avoids depending on the icon package). */
		function SlidersIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 16 16",
				fill: "none",
				style: { display: "block" },
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M2 4.5h6M11 4.5h3M2 11.5h3M8 11.5h6",
						stroke: "currentColor",
						strokeWidth: "1.3",
						strokeLinecap: "round"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "9.5",
						cy: "4.5",
						r: "1.7",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "6.5",
						cy: "11.5",
						r: "1.7",
						stroke: "currentColor",
						strokeWidth: "1.3"
					})
				]
			});
		}
		/** Cordis plugin name (client half). */
		const name = "dsh-capability-toggle-plugin/client";
		/** Services this client half injects. */
		const inject = ["slots", "locale"];
		/**
		* Client plugin body: install the dictionaries and the composer-row control.
		* @param ctx - the client root context (narrowed locally; see ./types.ts).
		*/
		function apply(ctx) {
			ctx.effect(() => injectStyles(), "capability-toggle: styles");
			ctx.effect(() => ctx.locale.register(NS, dictionaries), "capability-toggle: dictionaries");
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: NS,
				order: 40,
				locale: NS
			}, CapabilityToggleControl));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map