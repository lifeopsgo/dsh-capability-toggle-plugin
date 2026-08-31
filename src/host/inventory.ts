/**
 * Capability inventory: enumerate the switchable skills, MCP server groups, and
 * plain tools visible to one agent scope, as the descriptor rows the UI lists
 * and the id universe the resolver evaluates against.
 *
 * Three kinds, three sources:
 *   - `skill`: `ctx.skills.snapshot({ scope })` — every model-invocable skill
 *     summary (name + routing description).
 *   - `mcp`:   tools named `mcp__<server>__<rawName>` (the mcp-client public
 *     name grammar), grouped by `<server>` into one switch per server; a group
 *     switch denies every member tool.
 *   - `tool`:  every other model-facing tool from `ctx.tools.schemas(scope)`.
 *
 * The switch id namespaces are disjoint: `skill:<name>`, `mcp:<server>`,
 * `tool:<name>`. This keeps one flat OverrideMap unambiguous across kinds.
 *
 * @module dsh-capability-toggle-plugin/host/inventory
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
// Bare type-only imports load the `ctx.tools` / `ctx.skills` service
// augmentations onto Context (declaration merging is a program-level side effect).
import type {} from '@deepseek-ai/dsh-tools'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

import type { CapabilityDescriptor, McpMemberTool } from '../shared/types.ts'
import { collectPromptGates } from './prompt.ts'
import { collectApprovalGate } from './approval.ts'
import { collectGuards } from './guards.ts'

/** Prefix marking an MCP public tool name; capture group 1 is the server. */
const MCP_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__/

/** Build the `skill:<name>` switch id. */
export function skillId(name: string): string {
  return `skill:${name}`
}

/** Build the `mcp:<server>` switch id. */
export function mcpId(server: string): string {
  return `mcp:${server}`
}

/** Build the `tool:<name>` switch id. */
export function toolId(name: string): string {
  return `tool:${name}`
}

/**
 * A drift sink: called with a stable key and a message when a framework surface
 * this path reads returns a shape it did not expect. Passing one lets the
 * inventory turn a silent shape drift (e.g. `skills.snapshot()` no longer
 * exposing a `skills` array) into a warn-once alarm instead of an empty list
 * the operator cannot distinguish from "genuinely nothing to switch". Optional:
 * omitting it keeps `collectInventory` a pure read, so unit tests need no sink.
 */
export type DriftSink = (key: string, message: string) => void

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
export async function collectInventory(
  ctx: Context,
  scope: ScopeKey | undefined,
  cwd?: string,
  onDrift?: DriftSink,
): Promise<CapabilityDescriptor[]> {
  const skills = await collectSkills(ctx, scope, cwd, onDrift)
  const { mcps, tools } = collectTools(ctx, scope, onDrift)
  const prompts = await collectPromptGates(ctx, scope)
  const approval = collectApprovalGate(ctx)
  const guards = collectGuards()
  return [...skills, ...mcps, ...tools, ...prompts, ...approval, ...guards]
}

/** Skill rows: one per model-invocable skill, sorted by name. */
async function collectSkills(
  ctx: Context,
  scope: ScopeKey | undefined,
  cwd: string | undefined,
  onDrift?: DriftSink,
): Promise<CapabilityDescriptor[]> {
  const options: { scope?: ScopeKey, cwd?: string } = {}
  if (scope !== undefined) options.scope = scope
  if (cwd !== undefined && cwd !== '') options.cwd = cwd
  const snapshot = await ctx.skills.snapshot(options)
  // Contract: `snapshot.skills` is an array of summaries. If an upgrade changes
  // that shape, treat it as "no skills" (safe: nothing to switch) but alarm, so
  // an empty skills tab reads as a drift signal rather than a silent blank.
  if (!Array.isArray(snapshot?.skills)) {
    onDrift?.('skills.snapshot.shape', 'capability-toggle: skills.snapshot() returned no `skills` array '
      + '(DSH skills surface may have changed); the skills tab will be empty.')
    return []
  }
  return snapshot.skills
    .map((skill: SkillSummary): CapabilityDescriptor => ({
      id: skillId(skill.name),
      name: skill.name,
      description: skill.description,
      kind: 'skill',
    }))
    .sort(byName)
}

/**
 * Tool rows split into MCP server groups and plain tools. The `skill` tool
 * itself is excluded — skills are switched on the skills tab, and denying the
 * loader tool would be a coarser, confusing duplicate.
 */
function collectTools(
  ctx: Context,
  scope: ScopeKey | undefined,
  onDrift?: DriftSink,
): { mcps: CapabilityDescriptor[]; tools: CapabilityDescriptor[] } {
  const schemas = ctx.tools.schemas(scope)
  const mcpMembers = new Map<string, McpMemberTool[]>()
  const plain: CapabilityDescriptor[] = []

  // Contract: `schemas(scope)` is an iterable of `{ name, description? }`. A
  // non-iterable return means the tools surface changed shape upstream; alarm
  // and yield nothing (the tools/MCP tabs go empty) rather than throwing out of
  // reconcile, which would abort enforcement for the whole agent.
  if (schemas == null || typeof (schemas as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    onDrift?.('tools.schemas.shape', 'capability-toggle: tools.schemas() is not iterable '
      + '(DSH tools surface may have changed); the tools and MCP tabs will be empty.')
    return { mcps: [], tools: [] }
  }

  for (const schema of schemas) {
    // Contract: every schema carries a string `name`. A non-string means the
    // tool-schema shape drifted; skip the bad entry (rather than throwing or
    // minting a `tool:undefined` switch) and alarm once.
    if (typeof schema?.name !== 'string') {
      onDrift?.('tools.schemas.name', 'capability-toggle: a tool schema had no string `name` '
        + '(DSH tool-schema shape may have changed); that entry is skipped.')
      continue
    }
    if (schema.name === 'skill') continue
    const mcp = MCP_NAME.exec(schema.name)
    if (mcp !== null) {
      const server = mcp[1] as string
      const list = mcpMembers.get(server) ?? []
      list.push({ name: schema.name, description: schema.description ?? '' })
      mcpMembers.set(server, list)
      continue
    }
    plain.push({
      id: toolId(schema.name),
      name: schema.name,
      description: schema.description ?? '',
      kind: 'tool',
    })
  }

  const mcps: CapabilityDescriptor[] = [...mcpMembers.entries()]
    .map(([server, members]): CapabilityDescriptor => ({
      id: mcpId(server),
      name: server,
      description: `MCP server "${server}" — ${members.length} tool(s)`,
      kind: 'mcp',
      memberTools: members.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    }))
    .sort(byName)

  plain.sort(byName)
  return { mcps, tools: plain }
}

/** Sort descriptors by display name using code-point order. */
function byName(a: CapabilityDescriptor, b: CapabilityDescriptor): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
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
export function deniedToolNames(
  descriptors: readonly CapabilityDescriptor[],
  disabledIds: ReadonlySet<string>,
): string[] {
  const denied: string[] = []
  for (const d of descriptors) {
    if (!disabledIds.has(d.id)) continue
    if (d.kind === 'tool') denied.push(d.name)
    else if (d.kind === 'mcp' && d.memberTools !== undefined) {
      for (const m of d.memberTools) denied.push(m.name)
    }
  }
  return denied
}

/**
 * The disabled skill names from an inventory, for scoped shadowing.
 * @param descriptors - the inventory.
 * @param disabledIds - the switch ids resolved to disabled.
 * @returns the skill names to shadow with a non-model-invocable stub.
 */
export function disabledSkillNames(
  descriptors: readonly CapabilityDescriptor[],
  disabledIds: ReadonlySet<string>,
): string[] {
  const names: string[] = []
  for (const d of descriptors) {
    if (d.kind === 'skill' && disabledIds.has(d.id)) names.push(d.name)
  }
  return names
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
export function disabledToolGuidanceSections(
  descriptors: readonly CapabilityDescriptor[],
  disabledIds: ReadonlySet<string>,
): string[] {
  const names: string[] = []
  for (const d of descriptors) {
    if (d.kind === 'tool' && disabledIds.has(d.id)) names.push(`tool:${d.name}`)
  }
  return names
}
