# Contributing

Thanks for helping improve `dsh-capability-toggle-plugin`.

## Development setup

Requirements:

- Node.js 22.6 or newer
- pnpm 11

```bash
pnpm install --frozen-lockfile
pnpm run link-host-framework
pnpm run typecheck
pnpm test
pnpm run build
```

`pnpm run link-host-framework` is required after every install **if this checkout is
linked into a live DSH profile** (`"dsh-capability-toggle-plugin": "link:/path/to/checkout"`).

The framework packages are declared as `peerDependencies` — they must resolve to the
running host's copy. They are also pinned in `devDependencies` so a clean CI checkout can
typecheck, and that install materializes a **second** copy under this checkout's
`node_modules`. Because a profile `link:` is resolved by realpath, the plugin then loads
that second copy instead of the host's. `@deepseek-ai/dsh-scope` keys scope identity on a
module-private `Symbol`, so the duplicate cannot read the host's tag: `scopeOf()` returns
`undefined`, per-agent enforcement silently stops applying, and the panel's skills tab
collapses to globally registered skills only. The script re-points those packages at the
host copy; it is idempotent, and `--check` reports without writing (use it in a pre-commit
hook or a local gate).

## Pull requests

1. Create a focused branch from `main`.
2. Keep each change scoped to one concern.
3. Add or update tests for behavior changes.
4. Update both `README.md` and `README.zh-CN.md` when user-facing documentation changes.
5. Run type checking, tests, and the build before opening the pull request.
6. Do not commit credentials, local DSH settings, generated source maps, or `node_modules`.

## DSH plugin constraints

- Keep model-visible behavior and enforcement aligned.
- Register host and client contributions through disposable Cordis effects.
- Preserve the session > project > global precedence model.
- Disabled capabilities must remain both hidden from the model surface and blocked at execution time.
- Include refreshed prebuilt `lib/` files when a release changes runtime code.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](./SECURITY.md).
