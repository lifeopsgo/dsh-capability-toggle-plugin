<h1 align="center">dsh-capability-toggle-plugin</h1>

<p align="center">
  <strong>Turn individual agent capabilities on and off from the DSH WebUI composer — and have it actually enforced.</strong>
</p>

<p align="center">
  <a href="#install"><img alt="platform" src="https://img.shields.io/badge/platform-DSH%20WebUI-2b7cd3"></a>
  <a href="#development"><img alt="tests" src="https://img.shields.io/badge/tests-87%20passing-3fb950"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.6-5fa04e">
</p>

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

---

A composer-row control for the **DeepSeek Harness (DSH) WebUI**. While the agent is idle, open the popup and switch individual **skills, MCP servers, tools, prompt injections, the approval gate, and safety guards** on or off — independently at the **session**, **project**, or **global** level.

Disabling something is not a cosmetic filter. A disabled capability **really disappears** from the model's tool schema set and skill catalog on the agent's next step, and a forced call is **hard-refused**.

## What it does

- **Five tabs, six capability families** — `Skills` · `MCP` · `Tools` · `Prompt` · `Security` (the last folds the approval gate and the guard presets together, since both are permission concerns rather than capability toggles).
- **Three levels per row** — `session`, `project`, and `global`, each either `on`, `off`, or *unset*. Precedence is **session › project › global › default (enabled)**; a level left *unset* defers to the next one down. The badge at the row's end shows the **resolved** result across all three.
- **Real enforcement, not hiding** — see [How a disabled capability is enforced](#how-a-disabled-capability-is-enforced).
- **Per-round adjustability** — changes invalidate the skill-catalog cache and re-reconcile every live agent, so they take effect on the agent's **next step** without restarting the session.
- **Locked while running** — every switch is read-only while the agent is working (`session.running`); toggles apply when it is idle.
- **Survives popup close and turn boundaries** — state lives in a settings namespace, and the Host caches the last-known capability inventory, so reopening the popup between turns still shows disabled state correctly.
- **Internationalised** — ships zh-CN and en dictionaries and follows the WebUI language.
- **Framework-contract self-check** — the seams this plugin binds to are asserted at activation and printed as one greppable banner line: if a host event is ever renamed, enforcement would **fail open** and silently stop, which is the most dangerous direction.

## The six families

| Family | Tab | What one row is | Notes |
| --- | --- | --- | --- |
| `skill` | Skills | One model-invocable skill | Disabling shadows it with a `modelInvocable:false` skill of the same name |
| `mcp` | MCP | One MCP **server** (`mcp__<server>__*` collapses into one switch) | Disabling denies every tool that server exposes; the row expands to list its member tools |
| `tool` | Tools | One model-visible tool | Disabling also hides that tool's `tool:<name>` guidance section — saves tokens, avoids "tool gone, guidance still there" |
| `prompt` | Prompt | One gateable system-prompt injection point | A **curated allowlist**, probed for real presence: absent injection points show no switch |
| `approval` | Security | The approval-escalation gate (a singleton) | Off = every approval request from this agent is auto-rejected: no prompt, no elevation. Independent of the system `/permission` setting |
| `guard` | Security | One opt-in safety preset | **Default off** (opt-in). On = the guard acts on matching calls: `Block` refuses, `Confirm` raises one approval prompt |

## How a disabled capability is enforced

All five seams act on the **agent's own scope**, filtering the capability surface it inherits. Nothing global is mutated, and everything is restored when the agent is released.

| Family | Mechanism | Result |
| --- | --- | --- |
| `tool` / `mcp` | `ctx.tools.restrict({ deny })` on the agent's scope | The tool leaves the model's schema set; `request/header` snapshots stop listing it; a forced call is refused |
| `skill` | Register a same-named `modelInvocable:false` runtime skill in the agent scope, shadowing the real one | The skill vanishes from `<available_skills>`; the `skill` tool's `isModelInvocable` check fails and throws |
| `prompt` | Register a same-named **empty-text** `systemPrompt.section` / `.context` shadow, or call `suppressRuntimeContext()` | The section is overridden by the empty shadow during assembly and dropped at render; the owning service keeps running — only what the model is *told* changes |
| `approval` | A scoped `approval/request` listener that resolves `'rejected'` | Every approval request from this agent is denied deterministically, without touching the deployment's shared approval policy |
| `guard` | A `tools/pre-execute` listener matching the preset's predicate | `Block` refuses the call outright; `Confirm` raises one approval prompt and proceeds only if allowed |

## The Security tab

**Approval escalation** (default on) — allows this agent to raise actions that need user approval. When off, every approval request from this agent is auto-rejected, independent of the system `/permission` setting.

**Guard presets** (default off, opt-in). Unlike the other families, a guard being *on* means *protection is active*:

| Guard | Action | Catches |
| --- | --- | --- |
| Read-only mode | Block | Every file write / create / edit — the agent can read but not change files |
| Protect secrets | Block | Any read, write, or shell command touching `.env`, `*.pem`, `id_rsa`, credentials, `.ssh/` |
| Confirm dangerous shell | Confirm | `rm -rf`, `dd`, `mkfs`, `chmod 777`, `curl \| sh`, fork bombs |
| Confirm destructive git | Confirm | `push --force`, `reset --hard`, `clean -fd`, `branch -D` |
| Confirm outbound network | Confirm | `web_search`, `read_page`, `curl`/`wget`, `git push`, `npm publish` |

`Block` guards are evaluated before `Confirm` guards, so a blocking rule always wins over a confirmation prompt.

> A guard row reads inverted from the other families: it is **default off**, so its dot lights and its badge reads *Guarding* when the guard is **active**.

## Why the `prompt` family is a curated allowlist

The system-prompt registry exposes many entries, but most are unsafe to blank. This plugin gates only a few, and probes `assemble({scope})` so a switch appears only when the deployment actually registered that entry:

- `deployment:persona` — the order-0 persona section; empty text is a documented first-class state.
- `sandbox:policy` / `approval:policy` — the runtime-context snapshots that *tell the model* the sandbox mode and approval policy. **Gating changes only what the model is told; the owning services still enforce for real.**
- **Hide all runtime context** — one coarse `suppressRuntimeContext()` switch for this scope.

Deliberately **excluded** (blanking them breaks the model or the render): `harness:identity` (the model's identity foundation), `tools:code-only` / `tools:sdk` (critical to the code-mode protocol), and the strict interpolation variables `provider` / `model` / `cwd` (an empty shadow throws at render).

Additionally, disabling a plain tool also shadows its `tool:<name>` guidance section — saving tokens and removing the "tool gone, guidance still there" contradiction. Enabled only when the agent has a real scope.

## Where state lives

All three levels live in one document in the `capability-toggle` settings namespace:

```
{ global:   { <id>: on|off },
  projects: { <cwd>:       { <id>: on|off } },
  sessions: { <sessionId>: { <id>: on|off } } }
```

An absent entry means *unset* (inherit). Switch ids live in disjoint namespaces:

```
skill:<name>   mcp:<server>   tool:<name>
prompt:section:<name>   prompt:context:<name>   prompt:runtime
approval:policy   guard:<name>
```

**Why settings and not session-log events:** DSH persistence rejects an entire log containing an out-of-repo plugin event type that is not marked `ignorable` (`assertEventsSupported`), so a custom event would break session reload. The settings namespace survives reload for session-keyed state too, without touching the log. The **"model-visible ⟺ logged"** red line still holds: the *consequences* of a disabled capability are recorded by existing owners — `request/header` snapshots and the tool and skill catalogs.

## Architecture

```
src/
  shared/              pure types + pure logic, shared by both halves
    types.ts           CapabilityKind / ToggleState / ToggleLevel / projection rows
    resolve.ts         three levels -> resolved stance (session > project > global > default on)
  host/                Node half (ESM, @deepseek-ai/* externalised)
    config.ts          settings namespace + schema
    store.ts           OverrideStore: read / watch / layer / write one level
    inventory.ts       enumerate a scope's visible skills/mcps/tools, collapse MCP servers
    prompt.ts          curated allowlist + assemble presence probe + shadow/suppress
    approval.ts        scoped approval-request lock (probes the optional service)
    guards.ts          guard presets + the tools/pre-execute matcher
    agent-binding.ts   one agent's enforcement lifecycle and projection
    controller.ts      registry of live bindings + last-known inventory cache
    http.ts            two same-origin routes (read projection / write one level)
    self-check.ts      framework-contract banner + warn-once drift alarms
  client/              browser half (CJS, wrapped by __ModuleLoader__)
    index.tsx          composer trigger + centred popup host + request ordering
    components.tsx     tabs, rows, the three level switches
    api.ts             the two fetch calls
    locales.ts         zh / en dictionaries
    styles.ts          one injected stylesheet, driven by theme tokens
test/
  pure.test.ts         87 tests over the pure logic
```

**Data path.** The client talks to the Host over two same-origin routes:

- `GET  /api/plugin/capability-toggle/state?session=<id>` → `{ projection }`
- `POST /api/plugin/capability-toggle/set` `{ session, level, id, state }` → writes, then returns the refreshed `{ projection }`

Any write re-reconciles every live agent.

**Trust boundary.** These routes inherit DSH's local-GUI trust model: same-origin, no separate auth, no CSRF token, relying on "only this machine can reach the GUI port on `127.0.0.1`". `/set` is a write route that mutates persisted settings, so any local process able to reach that port can call it. If you expose the GUI beyond localhost, add authentication in front of it.

## Install

Install as a DSH bundle plugin in a profile:

1. Make the package resolvable from the profile (published: `npm i`; local development: `link:`):

   ```jsonc
   // ~/.dsh/profiles/<profile>/package.json
   {
     "dependencies": {
       "dsh-capability-toggle-plugin": "link:/abs/path/to/dsh-capability-toggle-plugin"
     },
     "dsh": { "profile": { "bundles": [
       "@deepseek-ai/dsh-base",
       "@deepseek-ai/dsh-web-app",
       "dsh-capability-toggle-plugin"
     ] } }
   }
   ```

2. The package ships `cordis.patch.yml`, which inserts the Host half into the loader; the `dsh.client` manifest tells the WebUI to load the client bundle.
3. Restart `dsh --profile <profile>` and refresh the page. The control appears in the composer row.

## Development

```bash
pnpm install
pnpm run typecheck   # tsc x2 (host + client tsconfigs)
pnpm run build       # tsdown -> lib/index.js (ESM) + lib/client.js (CJS)
pnpm test            # node --test, pure logic only
```

The client bundle is CJS, wrapped by `window.__ModuleLoader__.load`, with only platform modules (`react`, `react/jsx-runtime`, …) external — no cross-plugin values are inlined. The Host bundle is ESM with all `@deepseek-ai/*` and `node:*` externalised.

## License

MIT — see [LICENSE](./LICENSE).
