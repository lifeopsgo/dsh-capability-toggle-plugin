/**
 * Pure resolution of layered capability overrides into an effective decision.
 * Shared by the Host (which applies the decision to the tool/skill seams) and
 * the browser panel (which shows the resolved fallback per row). No runtime
 * dependency on either half.
 *
 * @module dsh-capability-toggle-plugin/shared/resolve
 */

import type {
  CapabilityDescriptor, CapabilityRow, CapabilityToggleProjection,
  LayeredOverrides, OverrideMap, ToggleLevel, ToggleState,
} from './types.ts'

/**
 * Priority order applied on read: the first level with an explicit stance wins.
 * This is also the display and write order, so it is the single source of truth
 * the store (`WRITABLE_LEVELS`) and the panel (`LEVELS`) both import — no level
 * list is spelled out a second time.
 */
export const LEVEL_PRIORITY: readonly ToggleLevel[] = ['session', 'project', 'global']

/**
 * Read one capability's stance at one level. A stored map omits `inherit`, so a
 * missing key resolves to `inherit`.
 * @param map - one level's override map.
 * @param id - capability switch key.
 * @returns the stored stance, or `inherit` when the level is silent.
 */
export function stanceAt(map: OverrideMap, id: string): ToggleState {
  // Read own properties only. A bare `map[id]` walks the prototype chain, so an
  // id like `constructor`/`toString`/`__proto__` would resolve to an inherited
  // function and defeat the `?? 'inherit'` fallback, letting a non-stance value
  // flow into resolveStance as if it were an explicit `on`/`off`. Ids come from
  // the inventory and (for writes) HTTP input, so treat the map as a plain
  // lookup table: a key that is not an own property is simply `inherit`.
  if (!Object.prototype.hasOwnProperty.call(map, id)) return 'inherit'
  return map[id] ?? 'inherit'
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
export function resolveStance(
  overrides: LayeredOverrides,
  id: string,
  fallback: Exclude<ToggleState, 'inherit'> = 'on',
): Exclude<ToggleState, 'inherit'> {
  for (const level of LEVEL_PRIORITY) {
    // Tolerate a missing level map (partial construction / incomplete
    // deserialization): a silent level is `inherit`, same as an empty map.
    const stance = stanceAt(overrides[level] ?? {}, id)
    if (stance !== 'inherit') return stance
  }
  return fallback
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
export function isDisabled(overrides: LayeredOverrides, id: string): boolean {
  return resolveStance(overrides, id, 'on') === 'off'
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
export function isGuardActive(overrides: LayeredOverrides, id: string): boolean {
  return resolveStance(overrides, id, 'off') === 'on'
}

/**
 * The complete set of capability ids that resolve to disabled, across a known
 * id universe. Ids the caller does not list are not considered — a stored
 * stance for an id no longer present is inert until the id reappears.
 * @param overrides - the three level maps.
 * @param ids - the known switch keys to evaluate.
 * @returns the disabled ids, in the input order.
 */
export function disabledIds(overrides: LayeredOverrides, ids: readonly string[]): string[] {
  return ids.filter(id => isDisabled(overrides, id))
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
export function buildProjection(
  descriptors: readonly CapabilityDescriptor[],
  overrides: LayeredOverrides,
  projectKey: string,
  guardHits?: ReadonlyMap<string, number>,
): CapabilityToggleProjection {
  const rows: CapabilityRow[] = descriptors.map((d): CapabilityRow => {
    const levels: Record<ToggleLevel, ToggleState> = {
      session: stanceAt(overrides.session, d.id),
      project: stanceAt(overrides.project, d.id),
      global: stanceAt(overrides.global, d.id),
    }
    if (d.kind === 'guard') {
      return {
        ...d, levels,
        disabled: isGuardActive(overrides, d.id),
        hitCount: guardHits?.get(d.id) ?? 0,
      }
    }
    return { ...d, levels, disabled: isDisabled(overrides, d.id) }
  })
  return { rows, projectKey }
}
