<div align="center">

# dsh-capability-toggle-plugin

**Control agent capabilities from the DSH WebUI — with real runtime enforcement.**

[![platform](https://img.shields.io/badge/platform-DSH%20WebUI-2b7cd3?style=flat-square)](#quick-start)
![tests](https://img.shields.io/badge/tests-97%20passing-3fb950?style=flat-square)
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
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.0.3
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
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.0.3

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

Additional behavior: switches lock while the agent runs, state survives popup close and turn boundaries, and the UI follows the WebUI language.

## Roadmap

Planned, not yet implemented:

- **Cross-project config sync** — copy or link project-level settings from another project instead of configuring each project from scratch.
- **Filter and select-all** — filter rows within a tab and select all matching rows at once.
- **Bulk actions on a filtered selection** — apply enable/disable/unset to every row selected via filter + select-all in one action.

---

<div align="center"><sub>MIT — see <a href="./LICENSE">LICENSE</a></sub></div>
