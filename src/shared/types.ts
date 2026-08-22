/**
 * Shared contract between the Host half (`src/host`) and the browser half
 * (`src/client`) of dsh-capability-toggle-plugin. Type-only module: it carries
 * no runtime code, so the browser purity gate erases it and the two halves
 * agree on one wire shape without a shared runtime instance.
 *
 * @module dsh-capability-toggle-plugin/shared/types
 */

/**
 * The capability families a user can switch off. The first three are the
 * concrete tool/skill seams; `prompt` gates a curated set of system-prompt
 * contributions (persona, policy runtime-context, a hide-all-runtime-context
 * switch) by scoped same-name shadowing — the same override machinery, a
 * different enforcement seam. `approval` gates the model's ability to have an
 * approval-gated action wave through: OFF makes every `approval/request` for
 * this agent resolve `rejected` via a scoped waterfall listener (escalation
 * locked), a live-execution seam distinct from the schema/catalog/prompt ones.
 *
 * `guard` is the one family whose switch runs the OPPOSITE direction: a guard is
 * an opt-in SAFETY PRESET (readonly mode, block dangerous shell, protect
 * secrets…), inactive by default, that a user turns ON to tighten. It matches a
 * pending tool call by name and arguments in a scoped `tools/pre-execute`
 * waterfall and returns `deny` or `ask` for the calls it recognizes — a
 * per-call, argument-aware live-execution seam that the coarse tool/skill/mcp
 * switches (whole-tool on/off) cannot express. Because guards are opt-in, their
 * resolved default is OFF (inactive), so the resolver uses a per-family fallback
 * (see shared/resolve.ts `resolveStance` `fallback`).
 */
export type CapabilityKind = 'skill' | 'mcp' | 'tool' | 'prompt' | 'approval' | 'guard'

/**
 * A guard preset's disposition for a call it matches. `deny` materializes an
 * error result the model reads as a normal tool failure (with the preset's
 * reason); `ask` defers to the deployment's approval service — it runs only on
 * `allowed-once` and otherwise denies (fail closed), the `tools/pre-execute`
 * seam's native bridge to the same approval waterfall the `approval` family
 * gates. Fixed per preset in phase one (not user-editable), so a guard row
 * keeps the same pure tri-state switch as every other family; turning a guard
 * ON tightens, exactly like the others — the only difference is the default
 * (guards start OFF/inactive, see the `guard` fallback in resolve.ts).
 */
export type GuardAction = 'deny' | 'ask'

/**
 * One level's stance on one capability. `inherit` defers to the next lower
 * level; a stored map omits `inherit` entries, so absence and `inherit` are
 * the same fact on read.
 */
export type ToggleState = 'on' | 'off' | 'inherit'

/** The three override scopes, highest priority first. */
export type ToggleLevel = 'session' | 'project' | 'global'

/**
 * One member tool of an MCP server group: its public tool name and one-line
 * summary, shown when a user expands the group row to inspect its contents.
 */
export interface McpMemberTool {
  /** The public `mcp__<server>__<rawName>` tool name a group switch denies. */
  readonly name: string
  /** One-line summary from the tool schema; may be empty. */
  readonly description: string
}

/**
 * One switchable capability as presented to the UI. `id` is the stable switch
 * key (a tool/skill name, or `mcp:<server>` for an MCP server group); `kind`
 * selects the tab; `description` is the model-facing summary shown per row.
 */
export interface CapabilityDescriptor {
  /** Stable switch key, unique within its kind. */
  readonly id: string
  /** Row display name. */
  readonly name: string
  /** One-line summary; the UI truncates and reveals the full text on hover. */
  readonly description: string
  /** Which tab this row belongs to. */
  readonly kind: CapabilityKind
  /**
   * For `mcp` group rows, the tools this server contributes (name + summary);
   * a switch on the group denies every listed tool, and the UI lists them when
   * the row is expanded. Absent for `skill` and `tool` rows.
   */
  readonly memberTools?: readonly McpMemberTool[]
  /**
   * For `guard` rows only: what this preset does to a call it matches — `deny`
   * (materialize an error) or `ask` (defer to approval). Drives the per-row
   * action label; absent for every other kind.
   */
  readonly guardAction?: GuardAction
}

/**
 * One level's explicit stances, keyed by capability id. Only `on`/`off` entries
 * are stored; a missing key means `inherit`. Persisted verbatim in the session
 * event (session level) and in the settings namespace (project/global levels).
 */
export type OverrideMap = Readonly<Record<string, Exclude<ToggleState, 'inherit'>>>

/** The three override maps that merge into an effective decision. */
export interface LayeredOverrides {
  readonly session: OverrideMap
  readonly project: OverrideMap
  readonly global: OverrideMap
}

/**
 * One capability's per-level switch positions plus the resolved effect, as
 * pushed to the UI so each row can render its three switches and reflect the
 * inherited fallback without recomputing the merge.
 */
export interface CapabilityRow extends CapabilityDescriptor {
  /** This capability's stance at each level (`inherit` when the level is silent). */
  readonly levels: Readonly<Record<ToggleLevel, ToggleState>>
  /**
   * Resolved effect of the merged decision. For every family EXCEPT `guard`,
   * `true` means the capability is disabled (its default is enabled, so a
   * merged `off` disables it). For a `guard` row it means the preset is ACTIVE
   * (its default is inactive, so a merged `on` activates it) — same field, read
   * against the family's own default. The client renders the effect label per
   * kind, so one flag serves both directions.
   */
  readonly disabled: boolean
  /**
   * For `guard` rows only: how many tool calls this preset has matched (and
   * denied or deferred) in THIS agent's lifetime. Runtime, non-persistent, and
   * reset when the agent goes away — the visibility feedback that keeps an
   * invisible pre-execute rule from being unpredictable. Absent (undefined) for
   * every other kind, and for a guard that has matched nothing yet.
   */
  readonly hitCount?: number
}

/**
 * The complete projection the Host publishes for the composer panel: every
 * switchable capability with its per-level state, plus the project key the
 * project level is bound to (for display; empty when no project root resolved).
 */
export interface CapabilityToggleProjection {
  readonly rows: readonly CapabilityRow[]
  /** Absolute project-root path the `project` level writes under, or `''`. */
  readonly projectKey: string
}
