import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
/** Cordis plugin name used by loader diagnostics. */
declare const name = "dsh-capability-toggle-plugin";
/**
 * Required services. `settings` backs the durable state, `tools` and `skills`
 * are the enforced seams, `systemPrompt` carries the tool-guidance section
 * shadow that accompanies a disabled tool, `agents` is unused directly but its
 * lifecycle events drive tracking, and `webServer` carries the browser panel
 * channel.
 */
declare const inject: string[];
/**
 * Host plugin body. Every contribution is an effect, so plugin unload (or HMR
 * hot-swap) tears down the routes, the settings observer, and every per-agent
 * application.
 * @param ctx - the Host root context.
 */
declare function apply(ctx: Context): void;
//#endregion
export { apply, inject, name };