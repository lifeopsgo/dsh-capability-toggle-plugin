/**
 * Guard presets: opt-in safety rules enforced at the `tools/pre-execute` seam.
 *
 * Unlike the skill/tool/mcp/approval families (which switch a whole capability
 * on or off), a guard inspects the ARGUMENTS of a pending call and decides per
 * call. This is the only seam that can express "bash is allowed, but not
 * `rm -rf`" or "writing is fine, but not to `.env`". `tools/pre-execute` is a
 * `Scoped<ToolRuntime>` waterfall returning a `PreToolDecision`:
 *   - `allow`        → run the call (our `next()`, i.e. no matching guard).
 *   - `deny{reason}` → materialize an error the model reads as a normal tool
 *                      failure carrying `reason`.
 *   - `ask{reason?}` → defer to the approval service: the call runs only on
 *                      `allowed-once`, otherwise denies (fail closed). This is
 *                      the pre-execute seam's NATIVE bridge to the same approval
 *                      waterfall the `approval` family gates — a dangerous call
 *                      becomes a human confirmation instead of a hard failure.
 *
 * OPT-IN, so the resolved default is OFF (see the `guard`-family fallback in
 * shared/resolve.ts): a freshly loaded plugin perturbs no agent until a user
 * turns a preset ON. Turning one ON tightens — direction uniform with the other
 * switches; only the default differs.
 *
 * SCOPE + ORDER: registration MUST go through the agent's scoped context. The
 * scope routing key for `tools/pre-execute` is `exec.agent`, so a scope-tagged
 * listener receives ONLY this agent's calls; a listener on the global layer
 * would gate EVERY agent (the caller gates on a real scope, exactly like the
 * approval seam and the prompt shadows). We register with `prepend: true` so a
 * decisive `deny`/`ask` is returned before any later-registered pre-execute
 * listener runs — the same ordering discipline the shipped `dsh-tool-jobs`
 * pre-execute listener uses.
 *
 * MATCHING IS A PURE FUNCTION (`evaluateGuards`): name + parsed arguments in, a
 * decision or null out. No `ctx`, no live agent — the whole matching core is
 * unit-tested directly. The listener is a thin scoped wrapper that counts hits
 * and returns the decision.
 *
 * @module dsh-capability-toggle-plugin/host/guards
 */

import type { Context } from '@deepseek-ai/cordis'
// Bare type-only import loads the `tools/pre-execute` event + `PreToolDecision`
// onto the tools service augmentation (program-level declaration merging).
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import type { CapabilityDescriptor, GuardAction } from '../shared/types.ts'

/** The `guard:<name>` id namespace, disjoint from skill/mcp/tool/prompt/approval. */
export function guardId(name: string): string {
  return `guard:${name}`
}

/**
 * One guard preset: a named, fixed-action rule matched by a pure predicate over
 * a pending call's tool name and parsed arguments.
 */
interface GuardPreset {
  /** The `guard:<name>` switch id. */
  readonly id: string
  /** Short display name (the `<name>` segment). */
  readonly name: string
  /** One-line model-facing summary of what the preset protects. */
  readonly description: string
  /** What a match does: hard `deny`, or `ask` (defer to approval). */
  readonly action: GuardAction
  /** The reason surfaced to the model (deny) or the approval prompt (ask). */
  readonly reason: string
  /**
   * Pure predicate: does this preset apply to a call of `name` with `args`?
   * `args` is the deep-frozen, losslessly-JSON parsed argument object (never
   * null; a non-object input is normalized to `{}` before the predicate runs).
   */
  readonly matches: (name: string, args: Record<string, unknown>) => boolean
}

/** Coerce one argument field to a string; anything non-string reads as `''`. */
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

/** The file-mutating tool names, denied wholesale by the read-only preset. */
const FILE_WRITE_TOOLS = new Set(['write', 'create', 'edit', 'str_replace_editor'])

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
const READONLY_SHELL_WRITE = /\btee\b|\bsed\s+-i|\bdd\b[^\n]*\bof=/

/** Tool names that reach the network directly (not via bash). */
const NETWORK_TOOLS = new Set(['web_search', 'read_page'])

/**
 * Dangerous shell fragments: recursive/forced rm, raw disk writes, mkfs, world
 * writable chmod, piping a download straight into a shell, a fork bomb, or
 * clobbering a block device.
 */
const DANGEROUS_SHELL =
  /\brm\s+-\w*[rf]|\bdd\s+if=|\bmkfs\b|\bchmod\s+(-R\s+)?777\b|\|\s*(sudo\s+)?(sh|bash)\b|:\(\)\s*\{\s*:\s*\|\s*:|>\s*\/dev\/(sd|nvme|disk)/

/**
 * Destructive git operations: force push, hard reset, forced clean, forced
 * branch delete.
 */
const DESTRUCTIVE_GIT =
  /git\s+push\b[^\n|&;]*(--force\b|--force-with-lease\b|-f\b)|git\s+reset\s+--hard\b|git\s+clean\s+-\w*f|git\s+branch\s+-D\b/

/** Outbound-network shell fragments. */
const NETWORK_CMD = /\b(curl|wget)\b|git\s+push\b|npm\s+publish\b|scp\b/

/**
 * Secret-bearing path fragments: dotenv files, private keys, credential stores,
 * cloud/ssh credential dirs. Each token is anchored on a boundary that holds
 * both for a bare `file_path` (start or a `/`) AND for a token embedded in a
 * shell command (a preceding space, quote, `=`, or `:`), so `rm -rf .env` and
 * `cat .env.local` match while ordinary words (`environment`, `prevent`,
 * `README.md`) do not.
 */
const SECRET_PATH =
  /(?:^|[\s/"'=:])\.env(?:\.[\w.-]+)?\b|\.pem\b|\bid_rsa\b|\bid_ed25519\b|\bcredentials(?:\.\w+)?\b|\.aws\/credentials|(?:^|[\s/"'=:])\.ssh\//

/**
 * The shipped guard presets, in evaluation order. `deny` presets precede `ask`
 * presets so a hard block wins over a confirmation when both would match one
 * call. Within an action the order is stable.
 */
const GUARD_PRESETS: readonly GuardPreset[] = [
  {
    id: guardId('readonly'),
    name: 'readonly',
    description:
      'Read-only mode: block file write/create/edit tools and common in-place '
      + 'shell writers (tee, sed -i, dd of=). Defense-in-depth, not a sealed '
      + 'sandbox — exotic shell writes and MCP write tools are out of scope.',
    action: 'deny',
    reason:
      'Blocked by the "readonly" guard preset: file writes/edits are disabled '
      + 'for this agent. Turn the readonly guard off to allow edits.',
    matches: (name, args) => {
      if (FILE_WRITE_TOOLS.has(name)) return true
      // Also stop the canonical in-place shell writers, so readonly is not
      // trivially bypassed by routing a write through bash. High-precision
      // subset only (see READONLY_SHELL_WRITE) — redirection is not covered.
      return name === 'bash' && READONLY_SHELL_WRITE.test(argStr(args, 'command'))
    },
  },
  {
    id: guardId('protect-secrets'),
    name: 'protect-secrets',
    description: 'Block reads/writes and shell access to secret files (.env, keys, credentials).',
    action: 'deny',
    reason:
      'Blocked by the "protect-secrets" guard preset: this call touches a '
      + 'secret-bearing path (.env, private key, or credentials). Turn the '
      + 'protect-secrets guard off to allow it.',
    matches: (name, args) => {
      // Cover the path-bearing fields across the read/write/search tools: the
      // file tools use `file_path`, while read_image/glob/grep expose `path`.
      // Checking both means "protect secrets" also stops a plain read/grep of a
      // secret file, not only a write to one.
      if (SECRET_PATH.test(argStr(args, 'file_path'))) return true
      if (SECRET_PATH.test(argStr(args, 'path'))) return true
      if (name === 'bash') return SECRET_PATH.test(argStr(args, 'command'))
      return false
    },
  },
  {
    id: guardId('dangerous-shell'),
    name: 'dangerous-shell',
    description: 'Confirm dangerous shell commands (rm -rf, dd, mkfs, curl | sh, fork bombs).',
    action: 'ask',
    reason: 'The "dangerous-shell" guard flagged this command for confirmation.',
    matches: (name, args) => name === 'bash' && DANGEROUS_SHELL.test(argStr(args, 'command')),
  },
  {
    id: guardId('no-destructive-git'),
    name: 'no-destructive-git',
    description: 'Confirm destructive git (push --force, reset --hard, clean -fd, branch -D).',
    action: 'ask',
    reason: 'The "no-destructive-git" guard flagged this git command for confirmation.',
    matches: (name, args) => name === 'bash' && DESTRUCTIVE_GIT.test(argStr(args, 'command')),
  },
  {
    id: guardId('no-network'),
    name: 'no-network',
    description: 'Confirm outbound network (web search, page fetch, curl/wget, git push, npm publish).',
    action: 'ask',
    reason: 'The "no-network" guard flagged this outbound-network action for confirmation.',
    matches: (name, args) => {
      if (NETWORK_TOOLS.has(name)) return true
      return name === 'bash' && NETWORK_CMD.test(argStr(args, 'command'))
    },
  },
]

/** The full guard id universe, for the resolver and projection. */
export const GUARD_IDS: readonly string[] = GUARD_PRESETS.map(p => p.id)

/**
 * The guard inventory rows. Guards are always offered (the `tools/pre-execute`
 * seam is core to the tool runtime, always present); their opt-in default is
 * expressed by the resolver fallback, not by hiding the rows.
 * @returns one descriptor per shipped preset, in evaluation order.
 */
export function collectGuards(): CapabilityDescriptor[] {
  return GUARD_PRESETS.map((p): CapabilityDescriptor => ({
    id: p.id,
    name: p.name,
    description: p.description,
    kind: 'guard',
    guardAction: p.action,
  }))
}

/** One decisive guard match: the winning preset id and the decision it yields. */
export interface GuardHit {
  readonly id: string
  readonly decision: Extract<PreToolDecision, { kind: 'deny' | 'ask' }>
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
export function evaluateGuards(
  active: ReadonlySet<string>,
  name: string,
  args: unknown,
): GuardHit | null {
  const argObj: Record<string, unknown> =
    args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  // Two passes, deny before ask, so a hard block ALWAYS wins over a
  // confirmation when both would match — independent of the order presets
  // happen to be written in GUARD_PRESETS. Enforcing the precedence
  // structurally (not by array position) means a preset added in the wrong
  // spot can never silently downgrade a deny to an ask.
  for (const action of ['deny', 'ask'] as const) {
    for (const preset of GUARD_PRESETS) {
      if (preset.action !== action) continue
      if (!active.has(preset.id)) continue
      if (!preset.matches(name, argObj)) continue
      const decision =
        action === 'deny'
          ? ({ kind: 'deny', reason: preset.reason } as const)
          : ({ kind: 'ask', reason: preset.reason } as const)
      return { id: preset.id, decision }
    }
  }
  return null
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
export function applyGuards(
  scopedCtx: Context,
  active: ReadonlySet<string>,
  onHit: (id: string) => void,
): Array<() => void> {
  if (active.size === 0) return []
  const dispose = scopedCtx.on(
    'tools/pre-execute',
    (exec, next) => {
      // FAIL CLOSED on any evaluation error. `evaluateGuards` is pure, but its
      // inputs are not fully trusted: `exec.arguments` could expose a throwing
      // getter, and a pathological `command` could drive catastrophic regex
      // backtracking. A guard is a SAFETY seam, so an error here must never
      // widen what is allowed — we deny rather than let the exception escape
      // the pre-execute waterfall (where the failure mode is undefined).
      let hit: GuardHit | null
      try {
        hit = evaluateGuards(active, exec.name, exec.arguments)
      } catch {
        return Promise.resolve({
          kind: 'deny',
          reason: 'Blocked: a guard preset failed to evaluate this call, so it was denied (fail closed).',
        } as const)
      }
      if (hit === null) return next()
      // A misbehaving hit counter is telemetry, not enforcement: never let it
      // swallow or alter the decision.
      try {
        onHit(hit.id)
      } catch {
        /* ignore hit-tally failures; the decision below stands */
      }
      return Promise.resolve(hit.decision)
    },
    { prepend: true },
  )
  return [dispose]
}
