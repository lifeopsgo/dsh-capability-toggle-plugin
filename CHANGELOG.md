# Changelog

All notable changes to this project are documented here.

The project follows [Semantic Versioning](https://semver.org/).

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

[1.3.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.3.0
[1.2.1]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.2.1
[1.2.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.2.0
[1.1.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.1.0
[1.0.3]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.3
[1.0.2]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.2
[1.0.1]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.0
[0.1.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v0.1.0
