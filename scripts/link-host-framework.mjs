#!/usr/bin/env node
/**
 * Point this checkout's `@deepseek-ai/*` packages at the installed DSH host copy.
 *
 * WHY THIS EXISTS. A plugin developed against a live profile is linked into it
 * (`"dsh-capability-toggle-plugin": "link:/path/to/checkout"`), and Node resolves
 * a linked package's imports from its REAL path — so the plugin loads
 * `@deepseek-ai/*` from this checkout's own `node_modules`, not the profile's.
 * When `pnpm install` materialises the framework devDependencies here, the
 * process ends up with TWO copies of `@deepseek-ai/dsh-scope`. Scope identity in
 * that module is a module-private `Symbol("dsh.scope")` plus private WeakMaps, so
 * the second copy cannot read a tag written by the host copy: `scopeOf()` returns
 * undefined for every agent, per-agent enforcement goes inoperative, and the
 * panel silently degrades to globally registered capabilities only (the observed
 * symptom is a skills tab with one row while tools and guards still look right).
 *
 * The devDependencies themselves are load-bearing — CI and a fresh clone need
 * them to typecheck without a DSH install — so they are kept, and this script
 * re-points the resulting directories at the host copy instead. Idempotent: it
 * reports what already pointed at the host and rewrites only the rest.
 *
 * Run it after any `pnpm install` / `pnpm add` / `pnpm update` in this checkout:
 *
 *   node scripts/link-host-framework.mjs [--check]
 *
 * `--check` reports drift and exits non-zero without touching the filesystem,
 * which is what a pre-flight or a git hook wants.
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const CHECK_ONLY = process.argv.includes('--check')
const SCOPE = '@deepseek-ai'
const here = path.resolve(import.meta.dirname, '..')
const localScopeDir = path.join(here, 'node_modules', SCOPE)

/**
 * Locate the host DSH package directory: the `@deepseek-ai/dsh` install whose
 * bundled `node_modules/@deepseek-ai` holds the framework copies the running
 * harness itself loads. Tries the `dsh` binary on PATH first (the authoritative
 * answer for "which harness will load this plugin"), then a plain resolve.
 * @returns the host `@deepseek-ai` directory, or null when DSH is not installed.
 */
function findHostScopeDir() {
  const candidates = []

  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (bin !== '') {
      // ~/.npm-global/bin/dsh -> ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
      const real = fs.realpathSync(bin)
      const marker = path.join(SCOPE, 'dsh') + path.sep
      const at = real.indexOf(marker)
      if (at !== -1) candidates.push(path.join(real.slice(0, at + marker.length), 'node_modules', SCOPE))
    }
  } catch {
    // `which` missing or no dsh on PATH: fall through to the resolve attempt.
  }

  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve(`${SCOPE}/dsh/package.json`)
    candidates.push(path.join(path.dirname(pkg), 'node_modules', SCOPE))
  } catch {
    // Not resolvable from here; the `which` candidate may still be valid.
  }

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'dsh-scope'))) return dir
  }
  return null
}

/** True when `entry` already resolves into the host scope directory. */
function pointsAtHost(entry, hostScopeDir) {
  try {
    return fs.realpathSync(entry).startsWith(fs.realpathSync(hostScopeDir))
  } catch {
    return false
  }
}

const hostScopeDir = findHostScopeDir()
if (hostScopeDir === null) {
  console.error(
    'link-host-framework: no DSH installation found. Install the harness '
    + `(npm i -g ${SCOPE}/dsh) or run this from a machine that has it; this script only `
    + 'matters when developing against a live profile.',
  )
  process.exit(1)
}

if (!fs.existsSync(localScopeDir)) {
  console.log(`link-host-framework: no ${SCOPE} directory in this checkout — nothing to re-point.`)
  process.exit(0)
}

const entries = fs.readdirSync(localScopeDir).sort()
const drifted = []
let alreadyHost = 0

for (const name of entries) {
  const entry = path.join(localScopeDir, name)
  if (pointsAtHost(entry, hostScopeDir)) {
    alreadyHost += 1
    continue
  }
  if (!fs.existsSync(path.join(hostScopeDir, name))) {
    // A dev-only package the host does not bundle: leaving the local copy is
    // correct, since nothing in the host process can conflict with it.
    continue
  }
  drifted.push(name)
}

if (drifted.length === 0) {
  console.log(`link-host-framework: all ${alreadyHost} ${SCOPE} packages already resolve to the host copy.`)
  process.exit(0)
}

if (CHECK_ONLY) {
  console.error(
    `link-host-framework: ${drifted.length} ${SCOPE} package(s) resolve to a LOCAL copy, `
    + 'which splits framework identity when this checkout is linked into a live profile:\n  '
    + drifted.join('\n  ')
    + '\n\nRun `node scripts/link-host-framework.mjs` to re-point them.',
  )
  process.exit(1)
}

for (const name of drifted) {
  const entry = path.join(localScopeDir, name)
  fs.rmSync(entry, { recursive: true, force: true })
  fs.symlinkSync(path.join(hostScopeDir, name), entry)
}

console.log(
  `link-host-framework: re-pointed ${drifted.length} package(s) to the host copy `
  + `(${alreadyHost} already correct):\n  ${drifted.join('\n  ')}`,
)
