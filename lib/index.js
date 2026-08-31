import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";
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
/**
* Read one capability's stance at one level. A stored map omits `inherit`, so a
* missing key resolves to `inherit`.
* @param map - one level's override map.
* @param id - capability switch key.
* @returns the stored stance, or `inherit` when the level is silent.
*/
function stanceAt(map, id) {
	if (!Object.prototype.hasOwnProperty.call(map, id)) return "inherit";
	return map[id] ?? "inherit";
}
/**
* Resolve the effective stance for one capability across all levels. Session
* beats project beats global; a level that is `inherit` (or silent) falls
* through. When every level is silent the `fallback` decides — `on` for the
* capability families that are enabled by default (skill/mcp/tool/prompt/
* approval), `off` for the opt-in `guard` family that starts inactive.
* @param overrides - the three level maps.
* @param id - capability switch key.
* @param fallback - the stance when every level is silent (default `on`).
* @returns the winning explicit stance, or `fallback` when none is set.
*/
function resolveStance(overrides, id, fallback = "on") {
	for (const level of LEVEL_PRIORITY) {
		const stance = stanceAt(overrides[level] ?? {}, id);
		if (stance !== "inherit") return stance;
	}
	return fallback;
}
/**
* Whether one capability of a DEFAULT-ON family resolves to disabled. Uses the
* `on` fallback, so a silent capability is enabled and only an explicit merged
* `off` disables it. Not for `guard` rows — those default off; use
* {@link isGuardActive}.
* @param overrides - the three level maps.
* @param id - capability switch key.
* @returns `true` when the merged decision is `off`.
*/
function isDisabled(overrides, id) {
	return resolveStance(overrides, id, "on") === "off";
}
/**
* Whether one `guard` preset resolves to ACTIVE. Uses the `off` fallback, so a
* silent guard is inactive and only an explicit merged `on` activates it — the
* opt-in direction that keeps freshly-installed guards from tightening every
* agent until a user turns one on.
* @param overrides - the three level maps.
* @param id - guard switch key.
* @returns `true` when the merged decision is `on`.
*/
function isGuardActive(overrides, id) {
	return resolveStance(overrides, id, "off") === "on";
}
/**
* The complete set of capability ids that resolve to disabled, across a known
* id universe. Ids the caller does not list are not considered — a stored
* stance for an id no longer present is inert until the id reappears.
* @param overrides - the three level maps.
* @param ids - the known switch keys to evaluate.
* @returns the disabled ids, in the input order.
*/
function disabledIds(overrides, ids) {
	return ids.filter((id) => isDisabled(overrides, id));
}
/**
* Build the UI projection from an inventory and the layered overrides — the
* pure core of the per-row transform. Shared by the live-agent binding (which
* passes its per-agent guard-hit tally) and the no-live-agent fallback read
* (which has no running tally, so guard rows report zero hits). Keeping this a
* pure function is what lets the panel show persisted state even when no agent
* is currently bound: the effect a row reports is `store.layered()` resolved
* against a known inventory, independent of whether enforcement is applied
* right now.
*
* A `guard` row is opt-in (default off): its resolved effect is ACTIVE
* (`isGuardActive`, off fallback) and it carries a hit count. Every other
* family is default-on: its effect is DISABLED (`isDisabled`, on fallback) and
* hitCount is inapplicable. Both flags are always present on the wire; only the
* one matching the kind is meaningful.
*
* @param descriptors - the full (pristine) capability inventory to render.
* @param overrides - the three level maps resolved for this scope.
* @param projectKey - the project root the project level binds to (`''` none).
* @param guardHits - optional per-guard hit tally; absent → 0 for every guard.
* @returns the projection the composer panel renders.
*/
function buildProjection(descriptors, overrides, projectKey, guardHits) {
	return {
		rows: descriptors.map((d) => {
			const levels = {
				session: stanceAt(overrides.session, d.id),
				project: stanceAt(overrides.project, d.id),
				global: stanceAt(overrides.global, d.id)
			};
			if (d.kind === "guard") return {
				...d,
				levels,
				disabled: isGuardActive(overrides, d.id),
				hitCount: guardHits?.get(d.id) ?? 0
			};
			return {
				...d,
				levels,
				disabled: isDisabled(overrides, d.id)
			};
		}),
		projectKey
	};
}
//#endregion
//#region src/host/config.ts
/**
* Settings-namespace schema and stored-document shape for
* dsh-capability-toggle-plugin.
*
* All three override levels live in ONE settings namespace rather than a
* session-log event. This is deliberate: `Session.append()` exposes no way to
* mark a non-surface event `ignorable`, and the persistence read path
* (`assertEventsSupported`) refuses to reconstruct any log carrying an event
* type outside the harness's generated `KNOWN_SESSION_EVENT_TYPES` set — an
* out-of-repo plugin event can never be in that set, so a custom
* `capability/toggle` session event would brick the session on reload. The
* settings namespace persists across restarts too, so the session level (keyed
* by session id) keeps its survives-reload guarantee without that risk.
*
* Model-visible ⟺ logged still holds: this state never becomes model text on
* its own. Its only model effect — a capability disappearing from the tool
* schema set or the `<available_skills>` catalog — is emitted and logged by
* their owners (the `request/header` snapshot and tool-skill's catalog
* message), which replay recomputes.
*
* @module dsh-capability-toggle-plugin/host/config
*/
/** The settings namespace this plugin owns. */
const SETTINGS_NAMESPACE = "capability-toggle";
/** One capability's stored stance: only the explicit `on`/`off` are persisted. */
const StanceSchema = z.union(["on", "off"]);
/** One level's stored override map (capability id to explicit stance). */
const OverrideMapSchema = z.dict(StanceSchema);
const StoredDocumentSchema = z.object({
	global: OverrideMapSchema.default({}),
	projects: z.dict(OverrideMapSchema).default({}),
	sessions: z.dict(OverrideMapSchema).default({})
});
//#endregion
//#region src/host/store.ts
/**
* Owns the settings scope for this plugin's namespace and exposes level-aware
* reads and writes. One instance per Host plugin activation.
*/
var OverrideStore = class {
	scope;
	/**
	* @param ctx - the Host context (must inject `settings`).
	*/
	constructor(ctx) {
		this.scope = ctx.settings.register(settingsNamespace(SETTINGS_NAMESPACE), StoredDocumentSchema);
	}
	/**
	* Observe committed changes to the stored document.
	* @param callback - invoked after each commit with the resolved next value.
	* @returns the disposer removing this observer.
	*/
	watch(callback) {
		return this.scope.watch((next) => callback(next));
	}
	/** @returns the current resolved stored document. */
	read() {
		return this.scope.get();
	}
	/**
	* Assemble the three override maps that apply to one session in one project.
	* A missing project/session key contributes an empty map (all `inherit`).
	* @param projectKey - absolute project root, or `''` when none resolved.
	* @param sessionKey - the session id.
	* @returns the layered overrides for resolution.
	*/
	layered(projectKey, sessionKey) {
		const doc = this.read();
		return {
			session: doc.sessions[sessionKey] ?? {},
			project: projectKey === "" ? {} : doc.projects[projectKey] ?? {},
			global: doc.global
		};
	}
	/**
	* Set one capability's stance at one level, persisting the whole updated
	* document through the settings scope. A `state` of `inherit` removes the
	* stored key so the level goes silent.
	* @param selector - which level (and key) to write.
	* @param id - capability switch key.
	* @param state - the new stance; `inherit` clears the stored entry.
	*/
	async set(selector, id, state) {
		const doc = this.read();
		if (selector.level === "global") {
			await this.scope.replace({
				...doc,
				global: writeMap(doc.global, id, state)
			});
			return;
		}
		const bucket = selector.level === "project" ? doc.projects : doc.sessions;
		const nextMap = writeMap(bucket[selector.key] ?? {}, id, state);
		const nextBucket = { ...bucket };
		if (Object.keys(nextMap).length === 0) delete nextBucket[selector.key];
		else nextBucket[selector.key] = nextMap;
		const field = selector.level === "project" ? "projects" : "sessions";
		await this.scope.replace({
			...doc,
			[field]: nextBucket
		});
	}
};
/**
* Produce the next override map after setting one id to one stance. An
* `inherit` stance deletes the key; `on`/`off` store it.
* @param map - the current stored map.
* @param id - capability switch key.
* @param state - the new stance.
* @returns a new map (the input is not mutated).
*/
function writeMap(map, id, state) {
	const next = { ...map };
	if (state === "inherit") delete next[id];
	else next[id] = state;
	return next;
}
/**
* The three levels a UI write may address, for input validation. Aliases the
* shared priority order so the writable set and the resolution order can never
* drift apart.
*/
const WRITABLE_LEVELS = LEVEL_PRIORITY;
//#endregion
//#region src/host/prompt.ts
/** Prefix for a prompt-section gate switch id: `prompt:section:<name>`. */
const SECTION_PREFIX = "prompt:section:";
/** Prefix for a prompt-context gate switch id: `prompt:context:<name>`. */
const CONTEXT_PREFIX = "prompt:context:";
/**
* The single coarse runtime-context suppressor switch id. Unlike the other
* prompt ids (`prompt:section:<name>` / `prompt:context:<name>`, 3 segments,
* each targeting one named registry entry), this is an intentionally bare
* 2-segment singleton: it shadows no specific name, it toggles the all-or-
* nothing `suppressRuntimeContext()` seam, so there is no `<name>` to carry.
*/
const RUNTIME_SUPPRESS_ID = "prompt:runtime";
/**
* Curated allowlist of safe-to-gate SECTIONS. Orders mirror the framework's own
* registrations so the shadow lands at the same ordinal (irrelevant once empty,
* but keeps the intent legible).
*/
const SECTION_GATES = [{
	registryName: "deployment:persona",
	order: 0,
	key: "persona"
}];
/**
* Curated allowlist of safe-to-gate CONTEXTS (runtime-context snapshots). These
* only change what the model is told; the sandbox/approval services still run.
*/
const CONTEXT_GATES = [{
	registryName: "sandbox:policy",
	order: 100,
	key: "sandbox"
}, {
	registryName: "approval:policy",
	order: 200,
	key: "approval"
}];
/** Build the `prompt:section:<name>` switch id. */
function sectionId(registryName) {
	return `${SECTION_PREFIX}${registryName}`;
}
/** Build the `prompt:context:<name>` switch id. */
function contextId(registryName) {
	return `${CONTEXT_PREFIX}${registryName}`;
}
/**
* Enumerate the promptable capabilities that ACTUALLY exist for one scope.
*
* Probes the live assembly for this scope and keeps only allowlisted names that
* are present, plus the always-available coarse runtime suppressor. Pure read:
* `assemble` registers nothing. Returns `[]` when there is no scope (a global
* shadow would collide with the framework's own same-name registration) or when
* `systemPrompt` is unavailable.
*
* @param ctx - a context that can read `systemPrompt` (the scoped ctx).
* @param scope - the agent scope key; undefined disables prompt gating.
* @returns descriptors carrying the i18n key in `name` (the UI resolves it).
*/
async function collectPromptGates(ctx, scope) {
	if (scope === void 0) return [];
	const system = ctx.get("systemPrompt");
	if (system === void 0) return [];
	const assembly = await system.assemble({ scope });
	const sectionNames = new Set(assembly.sections.map((s) => s.name));
	const contextNames = new Set(assembly.contexts.map((c) => c.name));
	const rows = [];
	for (const gate of SECTION_GATES) if (sectionNames.has(gate.registryName)) rows.push({
		id: sectionId(gate.registryName),
		name: gate.key,
		description: gate.registryName,
		kind: "prompt"
	});
	for (const gate of CONTEXT_GATES) if (contextNames.has(gate.registryName)) rows.push({
		id: contextId(gate.registryName),
		name: gate.key,
		description: gate.registryName,
		kind: "prompt"
	});
	rows.push({
		id: RUNTIME_SUPPRESS_ID,
		name: "runtime",
		description: "",
		kind: "prompt"
	});
	return rows;
}
/**
* Apply prompt-gate enforcement for one scope: for every disabled prompt switch,
* register the matching empty shadow (section/context) or the runtime
* suppressor. Each returns a Cordis disposer, collected by the caller.
*
* MUST be called on a SCOPED context (never the host root): a same-name section
* or context in the global layer collides with the framework's own registration
* and throws. The caller gates on `scope !== undefined` before invoking.
*
* @param scopedCtx - the agent's scoped context.
* @param descriptors - this scope's promptable inventory.
* @param disabledIds - switch ids resolved to disabled.
* @returns disposers for every shadow/suppressor installed.
*/
function applyPromptGates(scopedCtx, descriptors, disabledIds) {
	const disposers = [];
	const system = scopedCtx.get("systemPrompt");
	if (system === void 0) return disposers;
	for (const d of descriptors) {
		if (d.kind !== "prompt" || !disabledIds.has(d.id)) continue;
		if (d.id === "prompt:runtime") {
			disposers.push(system.suppressRuntimeContext());
			continue;
		}
		if (d.id.startsWith(SECTION_PREFIX)) {
			const registryName = d.id.slice(15);
			const spec = SECTION_GATES.find((g) => g.registryName === registryName);
			disposers.push(system.section({
				name: registryName,
				order: spec?.order ?? 0,
				text: ""
			}));
			continue;
		}
		if (d.id.startsWith(CONTEXT_PREFIX)) {
			const registryName = d.id.slice(15);
			const spec = CONTEXT_GATES.find((g) => g.registryName === registryName);
			disposers.push(system.context({
				name: registryName,
				order: spec?.order ?? 100,
				text: ""
			}));
		}
	}
	return disposers;
}
//#endregion
//#region src/host/approval.ts
/**
* The sole approval-family switch id. Like `prompt:runtime` it is an
* intentionally bare singleton: it gates one all-or-nothing behavior (lock this
* agent's approvals), so it carries no `<name>` segment. The `:policy` suffix
* reads as "the approval policy gate" and keeps it clear of the `approval/…`
* event namespace.
*/
const APPROVAL_GATE_ID = "approval:policy";
/**
* Whether the deployment loaded the approval service. Non-strict `get` returns
* undefined instead of throwing when the service is absent, so this is a safe
* presence probe from a context that does not inject `approval`.
* @param ctx - any context.
* @returns true when `ctx.approval` is resolvable.
*/
function approvalAvailable(ctx) {
	return ctx.get("approval", false) !== void 0;
}
/**
* The approval-family inventory: one row when the approval service is present,
* none otherwise. Pure read — registers nothing.
* @param ctx - a context whose service presence reflects the deployment.
* @returns a single-element array, or an empty array when approval is absent.
*/
function collectApprovalGate(ctx) {
	if (!approvalAvailable(ctx)) return [];
	return [{
		id: APPROVAL_GATE_ID,
		name: "policy",
		description: "Allow approval escalation for this agent. When off, every approval request is auto-rejected (no interactive prompt, no sandbox elevation).",
		kind: "approval"
	}];
}
/**
* Install the approval lock on a scoped context when the gate is disabled.
*
* Registration MUST go through a context carrying the agent's scope tag so the
* `approval/request` listener is filtered to this agent only. The caller (the
* agent binding) guarantees this by passing its `scopedCtx`, and by only
* calling this when the agent has a real scope — a listener registered on the
* global layer would intercept every agent's approvals.
*
* @param scopedCtx - the agent-scoped context (its scope tag filters dispatch).
* @param disabled - the switch ids resolved to disabled for this agent.
* @returns a disposer array: one entry that removes the listener when the gate
*   is disabled, empty when it is on (nothing installed).
*/
function applyApprovalGate(scopedCtx, disabled) {
	if (!disabled.has("approval:policy")) return [];
	if (!approvalAvailable(scopedCtx)) return [];
	return [scopedCtx.on("approval/request", () => Promise.resolve("rejected"), { prepend: true })];
}
//#endregion
//#region src/host/guards.ts
/** The `guard:<name>` id namespace, disjoint from skill/mcp/tool/prompt/approval. */
function guardId(name) {
	return `guard:${name}`;
}
/** Coerce one argument field to a string; anything non-string reads as `''`. */
function argStr(args, key) {
	const v = args[key];
	return typeof v === "string" ? v : "";
}
/** The file-mutating tool names, denied wholesale by the read-only preset. */
const FILE_WRITE_TOOLS = /* @__PURE__ */ new Set([
	"write",
	"create",
	"edit",
	"str_replace_editor"
]);
/**
* Common file-mutating SHELL invocations the read-only preset also blocks, so a
* `bash` call cannot trivially route around the native file-write tools with
* `sed -i` / `tee` / `dd of=`. This is a HIGH-PRECISION subset, deliberately not
* exhaustive: it targets the three canonical in-place writers with near-zero
* false positives (`tee`, `sed -i`, `dd … of=`) and intentionally does NOT try
* to catch shell redirection (`>`, `>>`) — redirection's false-positive surface
* (`2>&1`, `>/dev/null`, a `>` inside a quoted string) is too wide to deny on,
* and readonly is defense-in-depth, not a sealed sandbox (see the preset
* description). A determined `python -c "open(...,'w')"`, a heredoc, or an MCP
* write tool is out of scope by design.
*/
const READONLY_SHELL_WRITE = /\btee\b|\bsed\s+-i|\bdd\b[^\n]*\bof=/;
/** Tool names that reach the network directly (not via bash). */
const NETWORK_TOOLS = /* @__PURE__ */ new Set(["web_search", "read_page"]);
/**
* Dangerous shell fragments: recursive/forced rm, raw disk writes, mkfs, world
* writable chmod, piping a download straight into a shell, a fork bomb, or
* clobbering a block device.
*/
const DANGEROUS_SHELL = /\brm\s+-\w*[rf]|\bdd\s+if=|\bmkfs\b|\bchmod\s+(-R\s+)?777\b|\|\s*(sudo\s+)?(sh|bash)\b|:\(\)\s*\{\s*:\s*\|\s*:|>\s*\/dev\/(sd|nvme|disk)/;
/**
* Destructive git operations: force push, hard reset, forced clean, forced
* branch delete.
*/
const DESTRUCTIVE_GIT = /git\s+push\b[^\n|&;]*(--force\b|--force-with-lease\b|-f\b)|git\s+reset\s+--hard\b|git\s+clean\s+-\w*f|git\s+branch\s+-D\b/;
/** Outbound-network shell fragments. */
const NETWORK_CMD = /\b(curl|wget)\b|git\s+push\b|npm\s+publish\b|scp\b/;
/**
* Secret-bearing path fragments: dotenv files, private keys, credential stores,
* cloud/ssh credential dirs. Each token is anchored on a boundary that holds
* both for a bare `file_path` (start or a `/`) AND for a token embedded in a
* shell command (a preceding space, quote, `=`, or `:`), so `rm -rf .env` and
* `cat .env.local` match while ordinary words (`environment`, `prevent`,
* `README.md`) do not.
*/
const SECRET_PATH = /(?:^|[\s/"'=:])\.env(?:\.[\w.-]+)?\b|\.pem\b|\bid_rsa\b|\bid_ed25519\b|\bcredentials(?:\.\w+)?\b|\.aws\/credentials|(?:^|[\s/"'=:])\.ssh\//;
/**
* The shipped guard presets, in evaluation order. `deny` presets precede `ask`
* presets so a hard block wins over a confirmation when both would match one
* call. Within an action the order is stable.
*/
const GUARD_PRESETS = [
	{
		id: guardId("readonly"),
		name: "readonly",
		description: "Read-only mode: block file write/create/edit tools and common in-place shell writers (tee, sed -i, dd of=). Defense-in-depth, not a sealed sandbox — exotic shell writes and MCP write tools are out of scope.",
		action: "deny",
		reason: "Blocked by the \"readonly\" guard preset: file writes/edits are disabled for this agent. Turn the readonly guard off to allow edits.",
		matches: (name, args) => {
			if (FILE_WRITE_TOOLS.has(name)) return true;
			return name === "bash" && READONLY_SHELL_WRITE.test(argStr(args, "command"));
		}
	},
	{
		id: guardId("protect-secrets"),
		name: "protect-secrets",
		description: "Block reads/writes and shell access to secret files (.env, keys, credentials).",
		action: "deny",
		reason: "Blocked by the \"protect-secrets\" guard preset: this call touches a secret-bearing path (.env, private key, or credentials). Turn the protect-secrets guard off to allow it.",
		matches: (name, args) => {
			if (SECRET_PATH.test(argStr(args, "file_path"))) return true;
			if (SECRET_PATH.test(argStr(args, "path"))) return true;
			if (name === "bash") return SECRET_PATH.test(argStr(args, "command"));
			return false;
		}
	},
	{
		id: guardId("dangerous-shell"),
		name: "dangerous-shell",
		description: "Confirm dangerous shell commands (rm -rf, dd, mkfs, curl | sh, fork bombs).",
		action: "ask",
		reason: "The \"dangerous-shell\" guard flagged this command for confirmation.",
		matches: (name, args) => name === "bash" && DANGEROUS_SHELL.test(argStr(args, "command"))
	},
	{
		id: guardId("no-destructive-git"),
		name: "no-destructive-git",
		description: "Confirm destructive git (push --force, reset --hard, clean -fd, branch -D).",
		action: "ask",
		reason: "The \"no-destructive-git\" guard flagged this git command for confirmation.",
		matches: (name, args) => name === "bash" && DESTRUCTIVE_GIT.test(argStr(args, "command"))
	},
	{
		id: guardId("no-network"),
		name: "no-network",
		description: "Confirm outbound network (web search, page fetch, curl/wget, git push, npm publish).",
		action: "ask",
		reason: "The \"no-network\" guard flagged this outbound-network action for confirmation.",
		matches: (name, args) => {
			if (NETWORK_TOOLS.has(name)) return true;
			return name === "bash" && NETWORK_CMD.test(argStr(args, "command"));
		}
	}
];
/** The full guard id universe, for the resolver and projection. */
const GUARD_IDS = GUARD_PRESETS.map((p) => p.id);
/**
* The guard inventory rows. Guards are always offered (the `tools/pre-execute`
* seam is core to the tool runtime, always present); their opt-in default is
* expressed by the resolver fallback, not by hiding the rows.
* @returns one descriptor per shipped preset, in evaluation order.
*/
function collectGuards() {
	return GUARD_PRESETS.map((p) => ({
		id: p.id,
		name: p.name,
		description: p.description,
		kind: "guard",
		guardAction: p.action
	}));
}
/**
* Pure guard evaluation: the first active preset (deny presets first) whose
* predicate matches a call decides it. No live agent, no ctx — the entire
* matching core is exercised by unit tests through this function.
* @param active - the guard ids resolved active for this agent.
* @param name - the pending call's tool name.
* @param args - the pending call's parsed arguments (any shape; coerced).
* @returns the decisive hit, or null when no active preset matches (→ allow).
*/
function evaluateGuards(active, name, args) {
	const argObj = args !== null && typeof args === "object" ? args : {};
	for (const action of ["deny", "ask"]) for (const preset of GUARD_PRESETS) {
		if (preset.action !== action) continue;
		if (!active.has(preset.id)) continue;
		if (!preset.matches(name, argObj)) continue;
		const decision = action === "deny" ? {
			kind: "deny",
			reason: preset.reason
		} : {
			kind: "ask",
			reason: preset.reason
		};
		return {
			id: preset.id,
			decision
		};
	}
	return null;
}
/**
* Install the guard enforcement listener on a scoped context when at least one
* preset is active. A single scoped `tools/pre-execute` listener runs the pure
* `evaluateGuards` over each call; a decisive match counts a hit (via `onHit`)
* and returns its decision, otherwise the call passes through with `next()`.
*
* PREPEND: the decision must win over any later pre-execute listener, so we
* register at the head. SCOPE: the caller passes the agent's scoped context and
* only calls this with a real scope, so the listener is filtered to this agent.
*
* @param scopedCtx - the agent-scoped context (its scope tag filters dispatch).
* @param active - the guard ids resolved active for this agent.
* @param onHit - invoked with the preset id each time a call is denied/asked.
* @returns a disposer array: one listener disposer when any guard is active,
*   empty when none are (nothing installed).
*/
function applyGuards(scopedCtx, active, onHit) {
	if (active.size === 0) return [];
	return [scopedCtx.on("tools/pre-execute", (exec, next) => {
		let hit;
		try {
			hit = evaluateGuards(active, exec.name, exec.arguments);
		} catch {
			return Promise.resolve({
				kind: "deny",
				reason: "Blocked: a guard preset failed to evaluate this call, so it was denied (fail closed)."
			});
		}
		if (hit === null) return next();
		try {
			onHit(hit.id);
		} catch {}
		return Promise.resolve(hit.decision);
	}, { prepend: true })];
}
//#endregion
//#region src/host/inventory.ts
/** Prefix marking an MCP public tool name; capture group 1 is the server. */
const MCP_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__/;
/** Build the `skill:<name>` switch id. */
function skillId(name) {
	return `skill:${name}`;
}
/** Build the `mcp:<server>` switch id. */
function mcpId(server) {
	return `mcp:${server}`;
}
/** Build the `tool:<name>` switch id. */
function toolId(name) {
	return `tool:${name}`;
}
/**
* Enumerate every switchable capability for one agent scope. Pure read: it
* registers nothing and mutates no state.
* @param ctx - a context that can read `skills` and `tools`.
* @param scope - the agent scope key to view, or undefined for the global view.
* @param cwd - the agent's session cwd, so project-level skill roots
*   (`<projectRoot>/.dsh/skills`, `<projectRoot>/.agents/skills`) are
*   discovered; omitted (or `''`) yields only the user/bundled roots.
* @param onDrift - optional warn-once sink for unexpected framework shapes.
* @returns descriptors in tab order (skills, then mcps, then tools), each tab
*   sorted by name.
*/
async function collectInventory(ctx, scope, cwd, onDrift) {
	const skills = await collectSkills(ctx, scope, cwd, onDrift);
	const { mcps, tools } = collectTools(ctx, scope, onDrift);
	const prompts = await collectPromptGates(ctx, scope);
	const approval = collectApprovalGate(ctx);
	const guards = collectGuards();
	return [
		...skills,
		...mcps,
		...tools,
		...prompts,
		...approval,
		...guards
	];
}
/** Skill rows: one per model-invocable skill, sorted by name. */
async function collectSkills(ctx, scope, cwd, onDrift) {
	const options = {};
	if (scope !== void 0) options.scope = scope;
	if (cwd !== void 0 && cwd !== "") options.cwd = cwd;
	const snapshot = await ctx.skills.snapshot(options);
	if (!Array.isArray(snapshot?.skills)) {
		onDrift?.("skills.snapshot.shape", "capability-toggle: skills.snapshot() returned no `skills` array (DSH skills surface may have changed); the skills tab will be empty.");
		return [];
	}
	return snapshot.skills.map((skill) => ({
		id: skillId(skill.name),
		name: skill.name,
		description: skill.description,
		kind: "skill"
	})).sort(byName);
}
/**
* Tool rows split into MCP server groups and plain tools. The `skill` tool
* itself is excluded — skills are switched on the skills tab, and denying the
* loader tool would be a coarser, confusing duplicate.
*/
function collectTools(ctx, scope, onDrift) {
	const schemas = ctx.tools.schemas(scope);
	const mcpMembers = /* @__PURE__ */ new Map();
	const plain = [];
	if (schemas == null || typeof schemas[Symbol.iterator] !== "function") {
		onDrift?.("tools.schemas.shape", "capability-toggle: tools.schemas() is not iterable (DSH tools surface may have changed); the tools and MCP tabs will be empty.");
		return {
			mcps: [],
			tools: []
		};
	}
	for (const schema of schemas) {
		if (typeof schema?.name !== "string") {
			onDrift?.("tools.schemas.name", "capability-toggle: a tool schema had no string `name` (DSH tool-schema shape may have changed); that entry is skipped.");
			continue;
		}
		if (schema.name === "skill") continue;
		const mcp = MCP_NAME.exec(schema.name);
		if (mcp !== null) {
			const server = mcp[1];
			const list = mcpMembers.get(server) ?? [];
			list.push({
				name: schema.name,
				description: schema.description ?? ""
			});
			mcpMembers.set(server, list);
			continue;
		}
		plain.push({
			id: toolId(schema.name),
			name: schema.name,
			description: schema.description ?? "",
			kind: "tool"
		});
	}
	const mcps = [...mcpMembers.entries()].map(([server, members]) => ({
		id: mcpId(server),
		name: server,
		description: `MCP server "${server}" — ${members.length} tool(s)`,
		kind: "mcp",
		memberTools: members.slice().sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
	})).sort(byName);
	plain.sort(byName);
	return {
		mcps,
		tools: plain
	};
}
/** Sort descriptors by display name using code-point order. */
function byName(a, b) {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
/**
* Map every disabled switch id to the concrete tool names it denies, for one
* inventory. A `tool:<name>` denies that tool; an `mcp:<server>` denies all its
* member tool names; a `skill:<name>` denies nothing here (skills are enforced
* by scoped shadow, not tool restriction).
* @param descriptors - the inventory.
* @param disabledIds - the switch ids resolved to disabled.
* @returns the concrete tool names to deny through `ctx.tools.restrict`.
*/
function deniedToolNames(descriptors, disabledIds) {
	const denied = [];
	for (const d of descriptors) {
		if (!disabledIds.has(d.id)) continue;
		if (d.kind === "tool") denied.push(d.name);
		else if (d.kind === "mcp" && d.memberTools !== void 0) for (const m of d.memberTools) denied.push(m.name);
	}
	return denied;
}
/**
* The disabled skill names from an inventory, for scoped shadowing.
* @param descriptors - the inventory.
* @param disabledIds - the switch ids resolved to disabled.
* @returns the skill names to shadow with a non-model-invocable stub.
*/
function disabledSkillNames(descriptors, disabledIds) {
	const names = [];
	for (const d of descriptors) if (d.kind === "skill" && disabledIds.has(d.id)) names.push(d.name);
	return names;
}
/**
* Map every disabled PLAIN tool to the name of its usage-guidance prompt
* section, so the section can be shadowed away when the tool is off. By
* convention each tool contributes one `systemPrompt.section` named
* `tool:<toolName>` (e.g. `tool:bash`, `tool:web_search`) — the same string as
* our `tool:<name>` switch id, which is exactly why the switch id doubles as
* the section name here.
*
* Only plain tools qualify:
*   - `skill` rows use the skill-shadow seam and have no such section.
*   - `mcp` group rows deny member tools whose guidance sections (if any) are
*     not named after the group, so there is nothing deterministic to shadow.
*
* Shadowing a section is best-effort cosmetics (it saves prompt tokens and
* removes stale guidance for an already-denied tool); a tool that ships no
* such section simply has its empty shadow render to nothing, which is inert.
* @param descriptors - the inventory.
* @param disabledIds - the switch ids resolved to disabled.
* @returns the `tool:<name>` guidance section names to shadow with empty text.
*/
function disabledToolGuidanceSections(descriptors, disabledIds) {
	const names = [];
	for (const d of descriptors) if (d.kind === "tool" && disabledIds.has(d.id)) names.push(`tool:${d.name}`);
	return names;
}
//#endregion
//#region src/host/self-check.ts
const SCOPE_IDENTITY_DRIFT_KEY = "scope.identity";
function scopeIdentityDrift(scopeKey) {
	if (scopeKey !== void 0) return null;
	return "capability-toggle: this agent carries no dsh-scope tag, so per-agent enforcement is inoperative and the panel can only list globally registered capabilities (the skills tab collapses to global skills while tools, MCP groups and guards still look correct). dsh-agent-loop mints a scope for every agent, so a missing tag means the read went through a SECOND copy of @deepseek-ai/dsh-scope: scope identity is a module-private Symbol plus private WeakMaps, which a duplicate copy cannot read. Make the framework packages resolve to the host's copy — declare every @deepseek-ai/* package as a peerDependency and keep a second copy out of this plugin's own node_modules.";
}
/**
* The framework contract this plugin depends on, in one place. Kept as data (not
* scattered string literals) so the banner, the audit trail, and a future
* compatibility test all read the SAME source of truth. Update this when a seam
* moves — the banner then advertises the new assumption automatically.
*/
const FRAMEWORK_CONTRACT = {
	/** Services whose absence makes the whole plugin fail to activate (via `inject`). */
	requiredServices: [
		"settings",
		"tools",
		"skills",
		"systemPrompt",
		"webServer"
	],
	/** Services probed non-strictly; absence degrades one family, not the plugin. */
	optionalServices: ["approval"],
	/**
	* The enforcement events a scoped listener claims. A rename here turns a guard
	* or the approval lock into dead code with no runtime error — the single most
	* important line to check after a DSH upgrade.
	*/
	enforcementEvents: ["tools/pre-execute", "approval/request"],
	/**
	* The agent-lifecycle events this plugin tracks. `agent/session-start` mints a
	* binding; `agent/disposed` drops it (and its scope fiber + hit tally). The
	* disposed event is load-bearing for MEMORY: it is the only path that removes
	* a binding from the live map, so a rename/miss upstream would strand one
	* binding per agent that ever started — a slow leak with no runtime error.
	*/
	lifecycleEvents: ["agent/session-start", "agent/disposed"],
	/** The `Execution` field the pre-execute waterfall routes scope by. */
	scopeRoutingKey: "exec.agent",
	/** The MCP public-tool name grammar the inventory groups servers by. */
	mcpNameGrammar: "mcp__<server>__<tool>",
	/** The settings namespace holding the three-level override document. */
	settingsNamespace: "capability-toggle"
};
/**
* Log one activation banner naming the framework assumptions enforcement rests
* on. This is the anchor an operator greps when a guard or lock "stopped
* working" after an upgrade: if a listed event or routing key was renamed
* upstream, the seam fails silently, and this line is the record of what the
* running build assumed. Logged at `info` once per activation.
* @param ctx - the Host context, for its logger.
*/
function emitContractBanner(ctx) {
	const c = FRAMEWORK_CONTRACT;
	ctx.logger.info(`active — enforcement binds events [${c.enforcementEvents.join(", ")}] scoped by "${c.scopeRoutingKey}", groups MCP tools by "${c.mcpNameGrammar}", tracks agent lifecycle via [${c.lifecycleEvents.join(", ")}]. If a DSH upgrade renames an enforcement event, the affected guard/lock stops matching WITHOUT error (fail-open); if it renames "agent/disposed", per-agent bindings stop being reclaimed (slow memory leak). Grep this line when auditing an upgrade.`);
}
/**
* Verify each required service actually resolves. `inject` already gates
* activation on these, so a miss here means the inject contract itself changed
* (a required service was renamed/removed upstream) — an `error`-level signal,
* not a mere warning, because enforcement is then partially inoperative.
* @param ctx - the Host context.
* @returns the names that failed to resolve (empty when all present).
*/
function checkRequiredServices(ctx) {
	const missing = FRAMEWORK_CONTRACT.requiredServices.filter((name) => ctx.get(name, false) === void 0);
	if (missing.length > 0) ctx.logger.error(`required service(s) unexpectedly absent despite inject: [${missing.join(", ")}]. A DSH upgrade may have renamed or removed them; enforcement is degraded.`);
	return missing;
}
/**
* Build a warn-once sink: the first message per key logs at `warn`, repeats are
* dropped. Drift (a surface returning an unexpected shape) persists across every
* reconcile, so an un-deduped warn would flood the log; the key lets one alarm
* stand for a whole class of repeated drift.
* @param ctx - the Host context, for its logger.
* @returns a `(key, message)` sink that logs each distinct key once.
*/
function makeWarnOnce(ctx) {
	const seen = /* @__PURE__ */ new Set();
	return (key, message) => {
		if (seen.has(key)) return;
		seen.add(key);
		ctx.logger.warn(message);
	};
}
//#endregion
//#region src/host/agent-binding.ts
/**
* Order for our empty guidance-shadow sections. Any finite number works: an
* empty section is dropped at render regardless of order, and the shadow wins
* its name in the scope-chain merge by scope, not by order. Kept in the tool
* guidance band (100–199) for tidiness when inspecting an assembly.
*/
const GUIDANCE_SHADOW_ORDER = 150;
/** Resolve the project key (absolute cwd) an agent's project level binds to. */
function projectKeyOf(agent) {
	return agent.session.header.cwd ?? "";
}
/** Human label for the level a shadowed skill's stub attributes itself to. */
function scopeLabel(projectKey) {
	return projectKey === "" ? "session" : "session/project/global scope";
}
/**
* One live agent's enforcement binding. Holds the agent identity plus the
* disposers of the current application generation, and re-derives them on
* demand. Not reused across agents.
*/
var AgentBinding = class {
	store;
	agent;
	onDrift;
	scopeKey;
	/**
	* A context that inherits THIS plugin's `skills`/`tools` inject but carries
	* the agent's scope tag. Both seams read the caller's scope via
	* `scopeOf(this.ctx)` AND are gated by Cordis's per-fiber inject guard, so
	* `agent.ctx` cannot be used directly: its fiber does not inject `skills`, so
	* `agent.ctx.skills` throws "cannot get property skills without inject". This
	* scoped context passes the guard (host inject) while landing restrict() /
	* register() in the agent's own layer (agent scope tag).
	*/
	scope;
	scopedCtx;
	projectKey;
	sessionKey;
	/** Disposers for the current application generation. */
	disposers = [];
	/** Monotonic generation, so a slow reconcile cannot overwrite a newer one. */
	generation = 0;
	/**
	* The last PRISTINE inventory — captured inside reconcile's dispose window,
	* before our own enforcement is re-applied. Serving the UI from this cache is
	* mandatory: `tools.schemas(scope)` returns only the VISIBLE set (a denied
	* tool vanishes) and `skills.snapshot(scope)` returns the SHADOW's stub
	* description, so a live read while enforcement is applied would drop
	* toggled-off tools from the panel (making them impossible to re-enable) and
	* mislabel toggled-off skills. `null` until the first reconcile.
	*/
	lastInventory = null;
	/**
	* Per-guard hit counters for THIS agent, keyed by `guard:<name>` id. A guard
	* listener increments the count each time it denies/asks a call. This is
	* RUNTIME state, not persisted: it lives on the binding for the agent's
	* lifetime and is deliberately NOT cleared by `dispose()` (a reconcile that
	* reinstalls the listeners must not reset a running tally), only dropped when
	* the agent goes away with the binding. The projection reads it so the panel
	* can show "blocked N calls" per guard row.
	*/
	guardHits = /* @__PURE__ */ new Map();
	/**
	* @param store - the shared override store.
	* @param hostCtx - this plugin's context (injects `skills` and `tools`).
	* @param agent - the live agent this binding enforces.
	* @param onDrift - optional warn-once sink for unexpected framework shapes
	*   seen while reading this agent's inventory (threaded to `collectInventory`).
	*/
	constructor(store, hostCtx, agent, onDrift) {
		this.store = store;
		this.agent = agent;
		this.onDrift = onDrift;
		this.scopeKey = scopeOf(agent.ctx);
		this.projectKey = projectKeyOf(agent);
		this.sessionKey = agent.session.id;
		const scopeDrift = scopeIdentityDrift(this.scopeKey);
		if (scopeDrift !== null) onDrift?.(SCOPE_IDENTITY_DRIFT_KEY, scopeDrift);
		this.scope = this.scopeKey === void 0 ? void 0 : createScope(hostCtx, this.scopeKey);
		this.scopedCtx = this.scope?.ctx ?? hostCtx;
	}
	/**
	* The UI's inventory: the last pristine snapshot captured by reconcile. It
	* reflects the FULL capability set (nothing our own enforcement hid), which
	* is what the panel must render so a toggled-off tool stays listed and can be
	* turned back on. Triggers a reconcile when never yet populated.
	*/
	async inventory() {
		if (this.lastInventory === null) await this.reconcile();
		return this.lastInventory ?? [];
	}
	/**
	* The last pristine inventory this binding captured, WITHOUT triggering a
	* reconcile — `null` when it has never reconciled. The registry reads it at
	* dispose time to seed its cross-lifetime fallback cache, so a panel reopened
	* after the agent goes idle can still render the persisted stances against a
	* known capability set (see ControllerRegistry.fallbackProjection). A plain
	* synchronous getter because dispose must not await a fresh scope read after
	* the agent's scope has begun tearing down.
	*/
	get knownInventory() {
		return this.lastInventory;
	}
	/**
	* Read the agent's PRISTINE inventory — the full set with our own
	* enforcement lifted. Only valid to call while `this.disposers` is empty
	* (inside reconcile's dispose window); otherwise `tools.schemas` omits denied
	* tools and `skills.snapshot` returns shadow stubs.
	*/
	async pristineInventory() {
		return collectInventory(this.scopedCtx, this.scopeKey, this.agent.session.header.cwd, this.onDrift);
	}
	/**
	* The set of switch ids resolved to disabled for this agent, over an
	* already-collected inventory.
	* @param descriptors - this agent's inventory.
	* @returns the disabled switch ids.
	*/
	disabledSet(descriptors) {
		const overrides = this.store.layered(this.projectKey, this.sessionKey);
		return new Set(disabledIds(overrides, descriptors.map((d) => d.id)));
	}
	/**
	* Dispose the current application and install a fresh one from the current
	* inventory and overrides. Latest-wins: a reconcile started later always
	* ends up as the installed generation.
	*/
	async reconcile() {
		const gen = ++this.generation;
		this.dispose();
		this.installGuards();
		const descriptors = await this.pristineInventory();
		if (gen !== this.generation) return;
		this.lastInventory = descriptors;
		const disabled = this.disabledSet(descriptors);
		const deny = deniedToolNames(descriptors, disabled);
		if (deny.length > 0) this.disposers.push(this.scopedCtx.tools.restrict({ deny }));
		for (const name of disabledSkillNames(descriptors, disabled)) this.disposers.push(this.scopedCtx.skills.register({
			name,
			description: `Disabled by capability-toggle for this ${scopeLabel(this.projectKey)}.`,
			source: "runtime",
			content: "",
			invocation: {
				modelInvocable: false,
				userInvocable: false
			}
		}));
		if (this.scopeKey !== void 0) {
			for (const sectionName of disabledToolGuidanceSections(descriptors, disabled)) this.disposers.push(this.scopedCtx.systemPrompt.section({
				name: sectionName,
				order: GUIDANCE_SHADOW_ORDER,
				text: ""
			}));
			for (const dispose of applyPromptGates(this.scopedCtx, descriptors, disabled)) this.disposers.push(dispose);
			for (const dispose of applyApprovalGate(this.scopedCtx, disabled)) this.disposers.push(dispose);
		}
	}
	/**
	* Install the guard-preset enforcement listener for this agent, synchronously.
	* Called at the head of reconcile (right after dispose, before any await) so a
	* safety guard has NO fail-open window: see the call site in {@link reconcile}.
	*
	* A guard's active set is `GUARD_IDS` intersected with the synchronous store
	* read — it never needs the pristine inventory the default-on seams await for,
	* so this stays await-free. Scope-only for the same reason as the approval
	* lock: the `tools/pre-execute` scope routing key is `exec.agent`, so a
	* scopeless listener would gate every agent; a scopeless binding installs no
	* guard. A single prepended listener runs the pure matcher and counts each hit
	* on the reconcile-surviving `guardHits` tally.
	*/
	installGuards() {
		if (this.scopeKey === void 0) return;
		const overrides = this.store.layered(this.projectKey, this.sessionKey);
		const activeGuards = new Set(GUARD_IDS.filter((id) => isGuardActive(overrides, id)));
		for (const dispose of applyGuards(this.scopedCtx, activeGuards, (id) => {
			this.guardHits.set(id, (this.guardHits.get(id) ?? 0) + 1);
		})) this.disposers.push(dispose);
	}
	/**
	* Build the UI projection for this agent: every capability with its per-level
	* stored stance and resolved disabled flag.
	* @param descriptors - this agent's inventory.
	* @returns the projection the composer panel renders.
	*/
	projection(descriptors) {
		return buildProjection(descriptors, this.store.layered(this.projectKey, this.sessionKey), this.projectKey, this.guardHits);
	}
	/** The last pristine inventory this binding captured, or null before its first
	* reconcile. Exposed so the registry can retain it as a cross-lifetime cache:
	* a later read after the agent is disposed still has a capability set to
	* project the persisted overrides against. */
	cachedInventory() {
		return this.lastInventory;
	}
	/** Dispose the current application generation's registrations. */
	dispose() {
		const current = this.disposers;
		this.disposers = [];
		for (const d of current) try {
			d();
		} catch {}
	}
	/**
	* Full teardown when the agent goes away: drop the current registrations and
	* dispose the minted scope fiber. The agent's own scope teardown also unwinds
	* anything registered through it, so this is idempotent with that path.
	*/
	destroy() {
		this.generation += 1;
		this.dispose();
		this.scope?.dispose();
	}
};
//#endregion
//#region src/host/controller.ts
/**
* Registry of live agent bindings. One per Host activation; agents come and go
* through `agent/session-start` and `agent/disposed`.
*/
var ControllerRegistry = class {
	store;
	hostCtx;
	onDrift;
	bindings = /* @__PURE__ */ new Map();
	/**
	* Last-known inventory per session id, surviving the live binding's disposal.
	* Bounded by distinct session ids seen this Host activation (a few per user
	* session); entries are overwritten on each dispose and never grow per turn.
	* Read only by the no-live-agent fallback read.
	*/
	lastKnown = /* @__PURE__ */ new Map();
	/**
	* @param store - the shared override store.
	* @param hostCtx - this plugin's context, whose `skills`/`tools` inject each
	*   binding borrows through a scope minted onto the agent's scope key.
	* @param onDrift - optional warn-once sink handed to every binding's inventory
	*   read, so an unexpected framework shape alarms once instead of silently
	*   yielding an empty capability list.
	*/
	constructor(store, hostCtx, onDrift) {
		this.store = store;
		this.hostCtx = hostCtx;
		this.onDrift = onDrift;
	}
	/**
	* Track a newly started agent and apply the current decision to it.
	* @param agent - the agent that just started its session.
	* @returns the created binding.
	*/
	async add(agent) {
		const binding = new AgentBinding(this.store, this.hostCtx, agent, this.onDrift);
		this.bindings.set(agent.session.id, binding);
		await binding.reconcile();
		return binding;
	}
	/**
	* Stop tracking an agent and drop its application (and its minted scope).
	* @param sessionId - the disposed agent's session id.
	*/
	remove(sessionId) {
		const binding = this.bindings.get(sessionId);
		if (binding === void 0) return;
		const inventory = binding.knownInventory;
		if (inventory !== null) this.lastKnown.set(sessionId, {
			inventory,
			projectKey: binding.projectKey
		});
		binding.destroy();
		this.bindings.delete(sessionId);
	}
	/**
	* Look up one live agent's binding.
	* @param sessionId - the session id.
	* @returns the binding, or undefined when the agent is not tracked.
	*/
	get(sessionId) {
		return this.bindings.get(sessionId);
	}
	/**
	* Build a projection for a session that has NO live binding, from its
	* last-known inventory resolved against the CURRENT store. This is what lets
	* the panel show persisted stances after the agent goes idle (an agent's
	* `agent/disposed` drops the live binding every turn). Returns undefined only
	* when this session was never seen live this activation — the caller then
	* answers "no agent" rather than a misleading empty panel. Guard hit tallies
	* are per-agent runtime state that does not survive disposal, so guard rows
	* report zero hits here (their on/off effect is still resolved correctly).
	* @param sessionId - the session id.
	* @returns the fallback projection, or undefined when nothing is cached.
	*/
	fallbackProjection(sessionId) {
		const snapshot = this.lastKnown.get(sessionId);
		if (snapshot === void 0) return void 0;
		const overrides = this.store.layered(snapshot.projectKey, sessionId);
		return buildProjection(snapshot.inventory, overrides, snapshot.projectKey);
	}
	/**
	* The project root a disposed session's project level binds to, from its
	* last-known snapshot. Lets an idle-time (no live binding) project-level
	* write resolve its selector key without a live agent. Returns undefined when
	* this session was never seen live this activation, in which case a
	* project-level write cannot be placed (the caller answers 409/404).
	* @param sessionId - the session id.
	* @returns the cached project key, or undefined when nothing is cached.
	*/
	lastKnownProjectKey(sessionId) {
		return this.lastKnown.get(sessionId)?.projectKey;
	}
	/** Re-apply the current decision to every tracked agent (store changed). */
	async reconcileAll() {
		await Promise.all([...this.bindings.values()].map((b) => b.reconcile()));
	}
};
//#endregion
//#region src/host/http.ts
/** URL path prefix this plugin claims on the web server. */
const ROUTE_PREFIX = "/api/plugin/capability-toggle";
/**
* Install the two HTTP routes. Returns the composed disposer.
* @param ctx - the Host context (must inject `webServer`).
* @param store - the shared override store.
* @param registry - the live-agent controller registry.
* @returns a disposer that unregisters both routes.
*/
function installHttp(ctx, store, registry) {
	const disposeState = ctx.webServer.register({
		kind: "exact",
		path: `${ROUTE_PREFIX}/state`,
		handler: (req, res) => guard(ctx, res, () => handleState(req, res, registry))
	});
	const disposeSet = ctx.webServer.register({
		kind: "exact",
		path: `${ROUTE_PREFIX}/set`,
		handler: (req, res) => guard(ctx, res, () => handleSet(req, res, store, registry))
	});
	return () => {
		disposeSet();
		disposeState();
	};
}
/**
* Run a handler and never let it throw to the web server's fallback (which
* swallows the error into an empty 400 with no body). On any error, log it and
* answer 500 with the message — the panel treats a non-200 as unavailable, so
* surfacing the cause here is the only way to see it.
* @param ctx - the Host context, for logging.
* @param res - the response to complete on failure.
* @param run - the wrapped handler.
*/
async function guard(ctx, res, run) {
	try {
		await run();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.logger.warn(`capability-toggle route failed: ${message}`);
		if (!res.headersSent) sendJson(res, 500, { error: message });
		else res.end();
	}
}
/** Answer the projection read for one session's live agent. */
async function handleState(req, res, registry) {
	const session = new URL(req.url ?? "", "http://localhost").searchParams.get("session");
	if (session === null || session === "") {
		sendJson(res, 400, { error: "missing session parameter" });
		return;
	}
	const binding = registry.get(session);
	if (binding === void 0) {
		const fallback = registry.fallbackProjection(session);
		if (fallback === void 0) {
			sendJson(res, 404, { error: "no live agent for session" });
			return;
		}
		sendJson(res, 200, { projection: fallback });
		return;
	}
	const descriptors = await binding.inventory();
	sendJson(res, 200, { projection: binding.projection(descriptors) });
}
/** Apply one stance write, then return the refreshed projection. */
async function handleSet(req, res, store, registry) {
	let body;
	try {
		body = parseSetBody(await readBody(req));
	} catch (error) {
		sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid body" });
		return;
	}
	const binding = registry.get(body.session);
	const projectKey = binding?.projectKey ?? registry.lastKnownProjectKey(body.session);
	if (body.level === "project" && (projectKey === void 0 || projectKey === "")) {
		sendJson(res, 409, { error: "this session has no project root; use session or global level" });
		return;
	}
	const selector = body.level === "global" ? { level: "global" } : body.level === "project" ? {
		level: "project",
		key: projectKey
	} : {
		level: "session",
		key: body.session
	};
	await store.set(selector, body.id, body.state);
	if (binding !== void 0) {
		await binding.reconcile();
		const descriptors = await binding.inventory();
		sendJson(res, 200, { projection: binding.projection(descriptors) });
		return;
	}
	const fallback = registry.fallbackProjection(body.session);
	if (fallback === void 0) {
		sendJson(res, 404, { error: "no live agent for session" });
		return;
	}
	sendJson(res, 200, { projection: fallback });
}
/**
* Validate an unknown parsed body into a SetBody, throwing on any deviation.
* Exported (not a route-private helper) so its rejection/accept paths can be
* unit-tested without a live `IncomingMessage`/`ServerResponse` pair.
*/
function parseSetBody(raw) {
	if (raw === null || typeof raw !== "object") throw new Error("body must be an object");
	const b = raw;
	const session = b["session"];
	const level = b["level"];
	const id = b["id"];
	const state = b["state"];
	if (typeof session !== "string" || session === "") throw new Error("session must be a non-empty string");
	if (typeof level !== "string" || !WRITABLE_LEVELS.includes(level)) throw new Error("level must be one of session, project, global");
	if (typeof id !== "string" || id === "") throw new Error("id must be a non-empty string");
	if (state !== "on" && state !== "off" && state !== "inherit") throw new Error("state must be on, off, or inherit");
	return {
		session,
		level,
		id,
		state
	};
}
/** Read a request body as UTF-8 text, bounded to a sane size. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	const limit = 262144;
	for await (const chunk of req) {
		const buf = chunk;
		total += buf.length;
		if (total > limit) throw new Error("request body too large");
		chunks.push(buf);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (text.trim() === "") return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("body is not valid JSON");
	}
}
/** Send a JSON response with the given status. */
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(text);
}
//#endregion
//#region src/index.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "dsh-capability-toggle-plugin";
/**
* Required services. `settings` backs the durable state, `tools` and `skills`
* are the enforced seams, `systemPrompt` carries the tool-guidance section
* shadow that accompanies a disabled tool, `agents` is unused directly but its
* lifecycle events drive tracking, and `webServer` carries the browser panel
* channel.
*/
const inject = [
	"settings",
	"tools",
	"skills",
	"systemPrompt",
	"webServer"
];
/**
* Host plugin body. Every contribution is an effect, so plugin unload (or HMR
* hot-swap) tears down the routes, the settings observer, and every per-agent
* application.
* @param ctx - the Host root context.
*/
function apply(ctx) {
	emitContractBanner(ctx);
	checkRequiredServices(ctx);
	const onDrift = makeWarnOnce(ctx);
	const store = new OverrideStore(ctx);
	const registry = new ControllerRegistry(store, ctx, onDrift);
	ctx.effect(() => installHttp(ctx, store, registry), "capability-toggle: http routes");
	ctx.effect(() => store.watch(() => {
		registry.reconcileAll().catch((error) => {
			ctx.logger.warn(`capability-toggle reconcile failed: ${messageOf(error)}`);
		});
	}), "capability-toggle: settings observer");
	ctx.on("agent/session-start", ({ agent }) => {
		registry.add(agent).catch((error) => {
			ctx.logger.warn(`capability-toggle failed to bind agent: ${messageOf(error)}`);
		});
	});
	ctx.on("agent/disposed", ({ agent }) => {
		registry.remove(agent.session.id);
	});
}
/** Extract a log-safe message from an unknown error. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { apply, inject, name };
