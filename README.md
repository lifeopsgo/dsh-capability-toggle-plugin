<div align="center">

# dsh-capability-toggle-plugin

**Control agent capabilities from the DSH WebUI — with real runtime enforcement.**

[![platform](https://img.shields.io/badge/platform-DSH%20WebUI-2b7cd3?style=flat-square)](#quick-start)
![tests](https://img.shields.io/badge/tests-135%20passing-3fb950?style=flat-square)
[![release](https://img.shields.io/github/v/release/lifeopsgo/dsh-capability-toggle-plugin?style=flat-square)](https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

**English** · [简体中文](./README.zh-CN.md)

<img alt="Capability controls for Skills, MCP, Tools, Prompt, and Security" src="./docs/screenshot.jpeg" width="900">

<sub>Session · Project · Global — blue check = on, red cross = off, dashed dash = unset.</sub>

</div>

## What it is

A **DeepSeek Harness (DSH) WebUI** plugin for controlling **skills, MCP servers, tools, prompt injections, approval escalation, and safety guards** at session, project, or global scope. Depending on the family, disabling removes, suppresses, rejects, or intercepts the capability on the agent's next step.

## Quick start

Requires **Node.js ≥ 22.6**.

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.1.0
```

Restart the existing DSH Web GUI process, then refresh the page. Start it with the command below when it is stopped:

```bash
dsh --profile web web
```

Open the control beside the ➕ button while the agent is idle. Replace `web` with another profile name when needed.

<details>
<summary>Upgrade or remove</summary>

```bash
# Upgrade or downgrade: use any tag listed on the releases page
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.1.0

# Remove
dsh plugin --profile web remove dsh-capability-toggle-plugin
```

</details>

## Features

### Three-level resolution

Each capability has three independent levels:

```text
session  ›  project  ›  global  ›  default (enabled)
```

The nearest explicit value wins. **Unset** defers to the next level; with every level unset, the capability remains enabled. The row badge always shows the resolved result.

The button displays only its current state: click to toggle **on ↔ off**, or use its small clear badge to return to **unset**.

### Capability families

| Tab | Controls |
| :-- | :-- |
| **Skills** | Individual model-invocable skills, including project-level skills discovered from the session's workspace (`.dsh/skills`, `.agents/skills`) |
| **MCP** | MCP servers; expand a row to inspect member tools |
| **Tools** | Individual model-visible tools and their guidance sections |
| **Prompt** | A safe, presence-checked allowlist of prompt injections |
| **Security** | Approval escalation and five opt-in safety guards |

### Enforcement

Every mechanism is scoped to the current agent; global registrations are not mutated.

| Family | Enforcement |
| :-- | :-- |
| `tool` / `mcp` | Removed with `ctx.tools.restrict({ deny })`; forced calls are refused |
| `skill` | Shadowed by a same-named `modelInvocable:false` runtime skill |
| `prompt` | Shadowed with empty text, or suppressed with `suppressRuntimeContext()` |
| `approval` | Scoped approval requests resolve to `rejected` |
| `guard` | `tools/pre-execute` blocks or requests confirmation for matching calls |

### Security controls

Turning off **Approval escalation** rejects every approval request from that agent without changing the system `/permission` setting.

Safety guards are opt-in:

| Guard | Action |
| :-- | :-- |
| Read-only mode | Block file writes, creates, and edits |
| Protect secrets | Block access to common secret files and credentials |
| Dangerous shell | Confirm high-risk shell commands |
| Destructive git | Confirm history- or work-losing git commands |
| Outbound network | Confirm network tools and outbound shell actions |

### Usage stats

Skills, MCP servers, and tools carry a small badge showing how many times the model called them this session (`called 7`). Counts update when a turn ends while the panel is open, live for one agent's lifetime, and are never persisted — the same retention as a safety guard's `matched N` badge.

The tally counts **requests**, not successful runs: a call a guard blocked or sent to confirmation still counts, because the model asking for a capability is the signal worth seeing. Guards are matched against rather than called, so they keep their own badge and show no usage count; prompt and approval rows show none either.

Additional behavior: switches lock while the agent runs, state survives popup close and turn boundaries, and the UI follows the WebUI language.

## Roadmap

Planned, not yet implemented:

- **Cross-project config sync** — copy or link project-level settings from another project instead of configuring each project from scratch.
- ~~**Capability invocation stats**~~ — implemented, unreleased: skills, MCP servers, and tools now badge how many times the model called them this session. Not yet in a tagged release, so it is still listed here rather than attributed to a version.
- **Fraction-format tab counts** — render each tab's badge as `enabled / total` instead of the bare total it shows today, so the strip reports at a glance how much of each family is active. The security tab needs care: a guard reuses `disabled` to mean ACTIVE, so its numerator cannot reuse the default-on tally.
- **Settings menu for customizable defaults** — expose the plugin's own options in a settings menu, such as the default stance for newly discovered capabilities (today a capability with all three levels unset resolves to enabled, except the opt-in safety guards, which stay inactive).
- **Show only enabled / only disabled** — add a state filter next to the search box, which today matches names and descriptions only. Guards need the same care the fraction counts need: a guard reuses `disabled` to mean ACTIVE, so "only disabled" must not list a guard that is actually enforcing. The filter would also narrow what bulk actions apply to, since they act on every currently visible row.
- ~~**Filter and select-all**~~ — shipped in v1.1.0: the toolbar's search box filters rows, and each level's bulk menu applies enable/disable/clear to every currently visible row.
- ~~**Bulk actions on a filtered selection**~~ — shipped in v1.1.0 together with the filter (search narrows, bulk acts on what's shown).

---

<div align="center"><sub>MIT — see <a href="./LICENSE">LICENSE</a></sub></div>
