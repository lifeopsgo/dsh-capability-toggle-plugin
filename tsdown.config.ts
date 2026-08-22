/**
 * Self-contained tsdown build for dsh-capability-toggle-plugin.
 *
 * Emits two artifacts into lib/:
 *   - index.js  : the Node (host) half — ESM, @deepseek-ai/* left external
 *     (resolved from the running dsh install at load time).
 *   - client.js : the browser half — a CJS closure-factory bundle wrapped in
 *     window.__ModuleLoader__.load({ id, factory }), matching the harness's
 *     own packages/client/tsdown.client.ts output contract. Platform modules
 *     (react, cordis, the shared client-ui packages) are required from the
 *     loader module table; everything else inlines. ESM output is incompatible
 *     with the top-level return in the footer, so the client half MUST be cjs.
 *
 * This plugin deliberately uses no CSS Modules: its styles inject through one
 * <style> tag from client code, so the build needs no lightningcss pipeline
 * and stays portable outside the harness monorepo.
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-capability-toggle-plugin'

/**
 * Browser platform modules answered by the loader's frozen require table,
 * mirrored from the harness's PLATFORM_MODULES plus the documented
 * dsh-client-runtime/client store exemption. A require the table cannot
 * answer is a guaranteed runtime throw, so anything NOT listed here must
 * inline into the bundle instead.
 */
const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const NODE_ENV = process.env.NODE_ENV ?? 'production'

/** Node (host) half: ESM, framework packages stay external. */
const host: UserConfig = {
  name: PLUGIN_ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: false,
  external: [/^@deepseek-ai\//, /^node:/],
}

/** Browser half: CJS closure-factory bundle for window.__ModuleLoader__. */
const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  // Inline every non-platform dependency; the loader table only answers the
  // externals above. undefined = defer to tsdown's default (external) for a
  // table entry, true = force-inline everything else.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
    'import.meta.env.MODE': JSON.stringify(NODE_ENV),
    'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
