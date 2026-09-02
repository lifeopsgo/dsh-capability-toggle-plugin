# Changelog

All notable changes to this project are documented here.

The project follows [Semantic Versioning](https://semver.org/).

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

[1.1.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.1.0
[1.0.3]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.3
[1.0.2]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.2
[1.0.1]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.1
[1.0.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v1.0.0
[0.1.0]: https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases/tag/v0.1.0
