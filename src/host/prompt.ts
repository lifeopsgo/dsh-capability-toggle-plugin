/**
 * Prompt-context capability family: switchable system-prompt contributions
 * beyond tools and skills.
 *
 * Unlike tools/skills — enumerated live from their registries — the promptable
 * surface is a CURATED ALLOWLIST. The `dsh-system-prompt` registry exposes many
 * sections/contexts, but only a few are SAFE to gate per scope:
 *
 *   - `deployment:persona`   — the order-0 persona; empty text is a documented
 *                              first-class state, so shadowing it is safe.
 *   - `sandbox:policy`       — runtime-context telling the model the sandbox
 *   - `approval:policy`        mode / approval policy. Gating only changes what
 *                              the model is TOLD, never what is ENFORCED (the
 *                              owning services keep running).
 *   - a coarse "hide all runtime context" switch backed by
 *     `suppressRuntimeContext()`.
 *
 * Deliberately EXCLUDED (would break the model or the render):
 *   - `harness:identity`            — the model's framework grounding.
 *   - `tools:code-only`/`tools:sdk` — protocol-critical in code-presentation.
 *   - `provider`/`model`/`cwd`      — strict-interpolated variables; shadowing
 *                                     one to empty throws at render.
 *
 * Every gate is the SAME mechanism tools/skills use: register a same-name entry
 * in the agent's scope. A scoped same-name section/context shadows the global
 * one (nearest-scope-wins in the assembly merge) and, being empty, is dropped
 * at render — so the model no longer reads it, while the owning service is
 * untouched. All registrations are Cordis effects (return a disposer).
 *
 * Presence is PROBED, not assumed: `assemble({ scope })` reports which section
 * and context names are actually active for this scope, so a deployment that
 * never registered `sandbox:policy` simply shows no switch for it.
 *
 * @module dsh-capability-toggle-plugin/host/prompt
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
// Loads the `ctx.systemPrompt` augmentation onto Context (declaration merging).
import type {} from '@deepseek-ai/dsh-system-prompt'

import type { CapabilityDescriptor } from '../shared/types.ts'

/** Prefix for a prompt-section gate switch id: `prompt:section:<name>`. */
const SECTION_PREFIX = 'prompt:section:'
/** Prefix for a prompt-context gate switch id: `prompt:context:<name>`. */
const CONTEXT_PREFIX = 'prompt:context:'
/**
 * The single coarse runtime-context suppressor switch id. Unlike the other
 * prompt ids (`prompt:section:<name>` / `prompt:context:<name>`, 3 segments,
 * each targeting one named registry entry), this is an intentionally bare
 * 2-segment singleton: it shadows no specific name, it toggles the all-or-
 * nothing `suppressRuntimeContext()` seam, so there is no `<name>` to carry.
 */
export const RUNTIME_SUPPRESS_ID = 'prompt:runtime'

/**
 * A safe-to-gate prompt entry in the curated allowlist. `render` names the
 * i18n key suffix the UI uses for this row's label/description.
 */
interface PromptGateSpec {
  /** The registry name this gates (`deployment:persona`, `sandbox:policy`, …). */
  readonly registryName: string
  /** The prompt order to register the empty shadow at (matches the original). */
  readonly order: number
  /** i18n suffix: the UI reads `prompt.<key>.name` / `prompt.<key>.desc`. */
  readonly key: string
}

/**
 * Curated allowlist of safe-to-gate SECTIONS. Orders mirror the framework's own
 * registrations so the shadow lands at the same ordinal (irrelevant once empty,
 * but keeps the intent legible).
 */
const SECTION_GATES: readonly PromptGateSpec[] = [
  { registryName: 'deployment:persona', order: 0, key: 'persona' },
]

/**
 * Curated allowlist of safe-to-gate CONTEXTS (runtime-context snapshots). These
 * only change what the model is told; the sandbox/approval services still run.
 */
const CONTEXT_GATES: readonly PromptGateSpec[] = [
  { registryName: 'sandbox:policy', order: 100, key: 'sandbox' },
  { registryName: 'approval:policy', order: 200, key: 'approval' },
]

/** Build the `prompt:section:<name>` switch id. */
function sectionId(registryName: string): string {
  return `${SECTION_PREFIX}${registryName}`
}

/** Build the `prompt:context:<name>` switch id. */
function contextId(registryName: string): string {
  return `${CONTEXT_PREFIX}${registryName}`
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
export async function collectPromptGates(
  ctx: Context,
  scope: ScopeKey | undefined,
): Promise<CapabilityDescriptor[]> {
  if (scope === undefined) return []
  const system = ctx.get('systemPrompt')
  if (system === undefined) return []

  const assembly = await system.assemble({ scope })
  const sectionNames = new Set(assembly.sections.map(s => s.name))
  const contextNames = new Set(assembly.contexts.map(c => c.name))

  const rows: CapabilityDescriptor[] = []
  for (const gate of SECTION_GATES) {
    if (sectionNames.has(gate.registryName)) {
      rows.push({ id: sectionId(gate.registryName), name: gate.key, description: gate.registryName, kind: 'prompt' })
    }
  }
  for (const gate of CONTEXT_GATES) {
    if (contextNames.has(gate.registryName)) {
      rows.push({ id: contextId(gate.registryName), name: gate.key, description: gate.registryName, kind: 'prompt' })
    }
  }
  // The coarse runtime suppressor is always offered when there is a scope: it
  // needs no pre-existing registration to shadow, it simply adds a suppressor.
  rows.push({ id: RUNTIME_SUPPRESS_ID, name: 'runtime', description: '', kind: 'prompt' })
  return rows
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
export function applyPromptGates(
  scopedCtx: Context,
  descriptors: readonly CapabilityDescriptor[],
  disabledIds: ReadonlySet<string>,
): Array<() => void> {
  const disposers: Array<() => void> = []
  const system = scopedCtx.get('systemPrompt')
  if (system === undefined) return disposers

  for (const d of descriptors) {
    if (d.kind !== 'prompt' || !disabledIds.has(d.id)) continue

    if (d.id === RUNTIME_SUPPRESS_ID) {
      disposers.push(system.suppressRuntimeContext())
      continue
    }
    if (d.id.startsWith(SECTION_PREFIX)) {
      const registryName = d.id.slice(SECTION_PREFIX.length)
      const spec = SECTION_GATES.find(g => g.registryName === registryName)
      disposers.push(system.section({ name: registryName, order: spec?.order ?? 0, text: '' }))
      continue
    }
    if (d.id.startsWith(CONTEXT_PREFIX)) {
      const registryName = d.id.slice(CONTEXT_PREFIX.length)
      const spec = CONTEXT_GATES.find(g => g.registryName === registryName)
      disposers.push(system.context({ name: registryName, order: spec?.order ?? 100, text: '' }))
    }
  }
  return disposers
}
