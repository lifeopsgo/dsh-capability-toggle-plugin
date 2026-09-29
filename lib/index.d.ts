import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/shared/types.d.ts
/**
 * One level's stance on one capability. `inherit` defers to the next lower
 * level; a stored map omits `inherit` entries, so absence and `inherit` are
 * the same fact on read.
 */
type ToggleState = 'on' | 'off' | 'inherit';
/**
 * One level's explicit stances, keyed by capability id. Only `on`/`off` entries
 * are stored; a missing key means `inherit`. Persisted verbatim in the Loader
 * configuration entry at every level.
 */
type OverrideMap = Readonly<Record<string, Exclude<ToggleState, 'inherit'>>>;
//#endregion
//#region src/host/config.d.ts
/** The resolved override document (all defaults applied). */
interface StoredDocument {
  readonly global: OverrideMap;
  readonly projects: Readonly<Record<string, OverrideMap>>;
  readonly sessions: Readonly<Record<string, OverrideMap>>;
}
interface StoredConfigDocument extends StoredDocument {
  readonly legacyMigrationCompleted: boolean;
}
interface OverrideConfig {
  readonly global: {
    get(): OverrideMap | undefined;
  };
  readonly projects: {
    get(): Readonly<Record<string, OverrideMap>> | undefined;
  };
  readonly sessions: {
    get(): Readonly<Record<string, OverrideMap>> | undefined;
  };
  readonly legacyMigrationCompleted: {
    get(): boolean | undefined;
  };
}
//#endregion
//#region src/index.d.ts
/** Cordis plugin name used by loader diagnostics. */
declare const name = "dsh-capability-toggle-plugin";
/**
 * Required services. `configEditor` backs the durable state, `tools` and `skills`
 * are the enforced seams, `systemPrompt` carries the tool-guidance section
 * shadow that accompanies a disabled tool, `agents` is unused directly but its
 * lifecycle events drive tracking, and `webServer` carries the browser panel
 * channel.
 */
declare const inject: string[];
/**
 * Host plugin body. Every contribution is an effect, so plugin unload (or HMR
 * hot-swap) tears down the routes and every per-agent application.
 * @param ctx - the Host root context.
 */
declare const Config: import("@deepseek-ai/schemastery").default<StoredConfigDocument>;
declare function apply(ctx: Context, config: OverrideConfig): void;
//#endregion
export { Config, apply, inject, name };