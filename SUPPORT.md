# Support

## Before opening an issue

1. Confirm you are using the latest release.
2. Restart the DSH Web GUI after installing or upgrading the plugin.
3. Reproduce while the agent is idle; switches are intentionally locked while it is running.
4. Run the project checks when working from source:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
```

## Where to ask

- Use a **bug report** for reproducible incorrect behavior.
- Use a **feature request** for proposed capabilities or UI changes.
- Use private vulnerability reporting for security issues; see [SECURITY.md](./SECURITY.md).

When reporting a problem, include the DSH version, plugin version, profile name, operating system, relevant logs with secrets removed, and clear reproduction steps.
