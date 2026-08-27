/**
 * Wiring assertions for the scope-identity drift alarm, checked against the
 * BUILT artifact rather than the source.
 *
 * Why the artifact and not `AgentBinding` directly: the class declares
 * constructor parameter properties, which Node's strip-only type stripping
 * rejects (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), so this suite cannot import it.
 * Checking `lib/` instead is not a workaround but the stronger target: this
 * plugin is installed straight from a git tag with no build step, so `lib/` is
 * literally the code users run. A source-only assertion would pass while the
 * committed artifact shipped without the alarm.
 *
 * @module dsh-capability-toggle-plugin/test/scope-identity-wiring
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { SCOPE_IDENTITY_DRIFT_KEY } from '../src/host/self-check.ts'

/** The shipped Host bundle, read once. */
const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('the shipped Host bundle carries the scope-identity decision function', () => {
  assert.match(built, /function scopeIdentityDrift\(/)
  assert.ok(
    built.includes(`"${SCOPE_IDENTITY_DRIFT_KEY}"`)
    || built.includes(`'${SCOPE_IDENTITY_DRIFT_KEY}'`),
    `built lib does not contain the drift key "${SCOPE_IDENTITY_DRIFT_KEY}"`,
  )
})

test('the binding consults the scope key it just read, not some other value', () => {
  // Guards against a refactor that keeps the alarm but feeds it the wrong input
  // (e.g. a fresh `scopeOf` call on the host context, which always has no tag
  // and would alarm on every agent).
  assert.match(built, /scopeIdentityDrift\(this\.scopeKey\)/)
})

test('the alarm is reported through the warn-once sink under its stable key', () => {
  // The sink dedupes by key; reporting under a different (or absent) key would
  // either flood the log or lose the alarm entirely.
  const reported = new RegExp(
    `onDrift[^\\n]{0,40}\\(\\s*SCOPE_IDENTITY_DRIFT_KEY|onDrift[^\\n]{0,40}\\(\\s*["']${SCOPE_IDENTITY_DRIFT_KEY}["']`,
  )
  assert.match(built, reported)
})

test('the alarm names the duplicate-copy cause and the actionable fix', () => {
  // An operator seeing only "no scope tag" cannot act. The message must point at
  // the duplicate dsh-scope copy and at declaring the framework as peer deps.
  assert.match(built, /SECOND copy of @deepseek-ai\/dsh-scope/)
  assert.match(built, /peerDependency/)
})
