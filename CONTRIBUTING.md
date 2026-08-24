# Contributing

Thanks for helping improve `dsh-capability-toggle-plugin`.

## Development setup

Requirements:

- Node.js 22.6 or newer
- pnpm 11

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
```

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
