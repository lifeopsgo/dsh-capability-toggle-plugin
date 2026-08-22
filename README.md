<h1 align="center">dsh-capability-toggle-plugin</h1>

<p align="center">
  <b>Turn individual agent capabilities on and off — from the composer row, at three levels, with real enforcement.</b>
</p>

<p align="center">
  <a href="#license"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.6-brightgreen.svg">
  <img alt="platform" src="https://img.shields.io/badge/platform-DSH%20WebUI-8A2BE2.svg">
  <img alt="tests" src="https://img.shields.io/badge/tests-87%20passing-success.svg">
</p>

<p align="center">
  <a href="#english">English</a> · <a href="#中文">中文</a>
</p>

---

<a name="english"></a>

## English

A plugin for the **DeepSeek Harness (DSH) WebUI** that adds one button to the conversation composer row. Click it while the agent is idle and you get a popup listing every capability the agent can currently reach — skills, MCP servers, tools, prompt injection points, the approval gate, and opt-in safety guards — each with a **three-level switch**: session, project, global.

Turning something off is not a cosmetic UI filter. A disabled capability **disappears from the model's tool schema and skill catalog on its next step**, and if the model still tries to call it, the call is **hard-refused**.

### Highlights

- **Five tabs, six capability families** — Skills · MCP · Tools · Prompt · Security (the Security tab folds the approval gate and the guard presets, both being permission concerns rather than capability toggles).
- **Three levels per row** — session / project / global, each `on`, `off`, or *unset*. Precedence is **session › project › global › default (enabled)**; an unset level defers to the next one down. A badge at the row's end shows the **real resolved result** across all three.
- **Real enforcement, not hiding** — see [How enforcement works](#how-enforcement-works).
- **Adjustable per round** — changes invalidate the skill-catalog cache and apply on the agent's **next step**; no session restart.
- **Locked while running** — every switch is read-only while `session.running` is true, so toggles only land when the agent is idle.
- **Survives popup close and turn boundaries** — state lives in a settings namespace, and the Host keeps a last-known inventory snapshot so reopening the popup between turns still shows the correct off-state.
- **i18n** — bundled Simplified Chinese and English dictionaries, following the WebUI language.
- **Framework-contract self-check** — the seams this plugin binds to are asserted at activation and logged as one greppable banner, because a renamed host event would otherwise fail *open* and silently stop enforcing.

### How enforcement works

| Family | Mechanism | Result |
| --- | --- | --- |
| `tool` / `mcp` | `ctx.tools.restrict({ deny })` on the agent's own scope | The tool leaves the model's schema set; the `request/header` snapshot stops listing it; a forced call is refused by the restriction |
| `skill` | Register a same-named runtime skill with `modelInvocable:false` at agent scope, shadowing the real one | The skill vanishes from the `<available_skills>` catalog; the `skill` tool's `isModelInvocable` check fails and throws |
| `prompt` | Shadow the section/context with a same-named **empty** `systemPrompt.section` / `.context`, or call `suppressRuntimeContext()` | That prompt segment is dropped at render; the owning service keeps running — only *what the model is told* changes |
| `approval` | A scoped `approval/request` listener that resolves `'rejected'` | Every approval request from this agent is auto-rejected: no prompt, no sandbox escalation, and the deployment's shared approval policy is untouched |
| `guard` | A `tools/pre-execute` listener matching fixed presets | A matching call is either **blocked** with an error or **sent to you for confirmation**, per the preset's action |

All five act on the agent's **own layer** — they filter or override inherited capability and prompt surfaces without mutating global registration, and everything unwinds when the agent is released.

### The Security tab

**Approval escalation** (default on) — allow this agent to raise actions needing user approval. Turn it off and every approval request from this agent is auto-rejected, independent of the system `/permission` settings.

**Guard presets** (default off, opt-in). Unlike the other families, a guard's "on" means *protection is active*:

| Guard | Action | What it covers |
| --- | --- | --- |
| Read-only mode | Block | Every file write / create / edit is refused — the agent can read but not change files |
| Protect secrets | Block | Any read, write, or shell command touching `.env`, `*.pem`, `id_rsa`, `credentials`, `.ssh/` |
| Confirm dangerous shell | Confirm | `rm -rf`, `dd`, `mkfs`, `chmod 777`, `curl\|sh`, fork bombs |
| Confirm destructive git | Confirm | `push --force`, `reset --hard`, `clean -fd`, `branch -D` |
| Confirm outbound network | Confirm | `web_search`, `read_page`, `curl`/`wget`, `git push`, `npm publish` |

`Block` guards are evaluated before `Confirm` guards, so a blocking rule always wins over a confirmation prompt.

### The Prompt tab

The Prompt tab exposes a **curated allowlist**, not every registered prompt segment, and each entry is shown only after probing `assemble({scope})` — an entry the deployment never registered simply shows no switch.

- `deployment:persona` — the order-0 persona section (empty text is a documented first-class state, so shadowing it is safe).
- `sandbox:policy` / `approval:policy` — runtime context telling the model the sandbox mode and approval policy. **Gating changes only what the model is told; the owning services still enforce the real policy.**
- *Hide all runtime context* — one coarse `suppressRuntimeContext()` switch for this scope's runtime-context snapshots.

Deliberately **excluded** because gating them breaks the model or the render: `harness:identity` (the model's identity foundation), `tools:code-only` / `tools:sdk` (critical to the code-mode protocol), and `provider` / `model` / `cwd` (strict interpolation variables — an empty shadow throws at render).

As a bonus, disabling an ordinary tool also shadows its `tool:<name>` guidance section, saving tokens and removing the "tool is gone but its guidance remains" contradiction. This applies only when the agent has a real scope.

### Where state lives

All three levels persist in one document in the `capability-toggle` settings namespace:

```
{ global:   { <id>: on|off },
  projects: { <cwd>: { <id>: on|off } },
  sessions: { <sessionId>: { <id>: on|off } } }
```

An absent key means *unset* (inherit). Switch ids occupy disjoint namespaces:

```
skill:<name>   mcp:<server>   tool:<name>
prompt:section:<name>   prompt:context:<name>   prompt:runtime
approval:policy   guard:<name>
```

**Why a settings namespace and not session-log events:** harness persistence rejects an entire log when it contains an out-of-repo plugin event type that is not marked `ignorable` (`assertEventsSupported`), so a custom event would break session reload outright. A settings namespace keyed by `sessionId` survives reload just as well and never touches the log. The **model-visible ⟺ logged** red line still holds: the consequences of a disabled capability are recorded by existing owners — the `request/header` snapshot and the tool/skill catalogs.

### Architecture

```
src/
  shared/              pure types and logic shared by both halves
    types.ts           CapabilityKind / ToggleState / ToggleLevel / projection rows
    resolve.ts         pure three-level resolution (session › project › global › default on)
  host/                Node half (ESM, @deepseek-ai/* externalized)
    config.ts          settings namespace + schema
    store.ts           OverrideStore: read / watch / layer / write one level
    inventory.ts       enumerate a scope's visible skills/mcps/tools, aggregate MCP
    prompt.ts          curated allowlist + assemble probe + shadow/suppress
    approval.ts        scoped approval-request lock
    guards.ts          guard presets + tools/pre-execute matcher
    agent-binding.ts   per-agent enforcement and projection
    controller.ts      binding registry + last-known inventory snapshots
    http.ts            two same-origin routes (read projection / write one level)
    self-check.ts      framework-contract banner + warn-once drift alarms
  client/              browser half (CJS, wrapped by __ModuleLoader__)
    index.tsx          composer button + centered popup host + request ordering
    components.tsx     tabs, rows, the three level switches
    api.ts             the two fetch calls
    locales.ts         zh / en dictionaries
    styles.ts          one injected stylesheet, driven by theme tokens
test/
  pure.test.ts         87 tests over the pure logic
```

**Data channel** — the client talks to the Host over two same-origin relative routes:

- `GET  /api/plugin/capability-toggle/state?session=<id>` → `{ projection }`
- `POST /api/plugin/capability-toggle/set` `{ session, level, id, state }` → the refreshed `{ projection }`

Any write triggers a reconcile against every live agent.

**Trust boundary** — these routes follow DSH's local-GUI trust model: same-origin, no separate auth, no CSRF token, resting on the assumption that only the local machine can reach the GUI port on `127.0.0.1`. `/set` is a write route that persists settings, so any local process able to reach that port can call it. If you expose the GUI beyond localhost, add authentication at a fronting proxy.

### Install

Install as a DSH bundle plugin in a profile:

1. Make the package resolvable from the profile:

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

2. The package ships `cordis.patch.yml`, which inserts the Host half into the loader; the `dsh.client` manifest makes the WebUI load the client bundle.
3. Restart `dsh --profile <profile>` and refresh the page. The toggle button appears in the composer row.

### Development

```bash
pnpm install
pnpm run typecheck   # tsc × 2 (separate host and client tsconfigs)
pnpm run build       # tsdown → lib/index.js (ESM) + lib/client.js (CJS)
pnpm test            # node --test, pure logic only
```

The client bundle is CJS, wrapped by `window.__ModuleLoader__.load`, with only platform modules (`react`, `react/jsx-runtime`, …) external — no cross-plugin values are inlined. The Host bundle is ESM with all `@deepseek-ai/*` and `node:*` externalized.

### License

MIT — see [LICENSE](./LICENSE).

---

<a name="中文"></a>

## 中文

一个 **DeepSeek Harness (DSH) WebUI** 插件：在对话输入栏加一个按钮。agent 空闲时点开，弹窗列出这个 agent 当前能触达的每一项能力——技能、MCP 服务器、工具、提示词注入点、审批闸门、可选安全守卫——每项都带一个**三级开关**：会话、项目、全局。

关掉某项不是界面上的假过滤。被停用的能力会**在模型下一步就从工具 schema 和技能目录里真实消失**，模型若仍强行调用，会被**硬拦截**。

### 核心能力

- **五个 tab，六个能力族** —— 技能 · MCP · 工具 · 提示词 · 安全（安全 tab 收纳审批闸门和守卫预设，两者本质是权限问题，而非能力开关）。
- **每行三级** —— 会话 / 项目 / 全局，每级可取 `开`、`关` 或*未设*。优先级 **会话 › 项目 › 全局 › 默认（启用）**；某级未设则向下一级跟随。行尾徽标显示三级综合后的**真实生效结果**。
- **真强制，不是隐藏** —— 见 [停用是怎么强制的](#停用是怎么强制的)。
- **逐轮可调** —— 改动会让技能目录缓存失效，**下一步 agent 即生效**，无需重启会话。
- **运行中锁定** —— `session.running` 为真时所有开关只读，切换只在空闲时落地。
- **关弹窗、跨轮次都不丢** —— 状态存在 settings 命名空间，Host 还缓存了最后一次已知的能力清单，所以轮次之间重开弹窗仍能正确显示已关闭状态。
- **国际化** —— 内置简体中文与英文词典，跟随 WebUI 语言。
- **框架契约自检** —— 插件依赖的接缝在激活时断言并打印一行可 grep 的横幅：宿主事件一旦改名，行为会**失效为放行**（fail-open）并悄悄停止强制，这是最危险的方向。

### 停用是怎么强制的

| 能力族 | 机制 | 结果 |
| --- | --- | --- |
| `tool` / `mcp` | 在 agent 自身 scope 上 `ctx.tools.restrict({ deny })` | 工具离开模型 schema 集；`request/header` 快照不再列出它；强行调用被限制拒绝 |
| `skill` | 在 agent scope 注册同名、`modelInvocable:false` 的运行时技能，影子掉真技能 | 技能从 `<available_skills>` 目录消失；`skill` 工具的 `isModelInvocable` 判定失败并抛错 |
| `prompt` | 用同名**空文本** `systemPrompt.section` / `.context` 影子覆盖，或调用 `suppressRuntimeContext()` | 该提示词段落在渲染时被丢弃；owner 服务照常运行，仅「告知模型的内容」变化 |
| `approval` | scoped `approval/request` 监听器直接 resolve `'rejected'` | 本 agent 的所有审批请求一律自动拒绝：不弹窗、不升权，且不动部署共享的审批策略 |
| `guard` | `tools/pre-execute` 监听器按固定预设匹配 | 命中的调用按预设动作被**拦截**报错，或**转交你确认** |

五条路径都作用在 agent **自己的层**上：过滤/覆盖继承来的能力面与提示词面，不改全局注册；agent 释放时全部还原。

### 安全 tab

**审批升权**（默认开）—— 允许本 agent 发起需用户审批的操作。关掉后本 agent 的所有审批请求一律自动拒绝，与系统 `/permission` 设置互不干扰。

**守卫预设**（默认关，需主动开启）。与其它族不同，守卫的「开」意味着*保护已启用*：

| 守卫 | 动作 | 覆盖范围 |
| --- | --- | --- |
| 只读模式 | 拦截 | 所有文件写入 / 新建 / 编辑一律拒绝——只能读不能改 |
| 保护密钥 | 拦截 | 任何触及 `.env`、`*.pem`、`id_rsa`、`credentials`、`.ssh/` 的读写或 shell 命令 |
| 危险 shell 需确认 | 确认 | `rm -rf`、`dd`、`mkfs`、`chmod 777`、`curl\|sh`、fork 炸弹 |
| 破坏性 git 需确认 | 确认 | `push --force`、`reset --hard`、`clean -fd`、`branch -D` |
| 外网出站需确认 | 确认 | `web_search`、`read_page`、`curl`/`wget`、`git push`、`npm publish` |

`拦截`类守卫先于`确认`类求值，所以拦截规则永远优先于确认弹窗。

### 提示词 tab

提示词 tab 只暴露一份**精选白名单**，并非全量枚举已注册提示词段落；每项都要先探测 `assemble({scope})` 才显示——当前部署没注册的项就不会出现开关。

- `deployment:persona` —— order-0 人格段落（空文本是官方文档化的一等状态，影子安全）。
- `sandbox:policy` / `approval:policy` —— 告知模型沙箱模式与审批策略的运行时上下文。**停用只改「告诉模型什么」，实际策略仍由 owner 服务强制。**
- *隐藏全部运行时上下文* —— 一把 `suppressRuntimeContext()` 粗开关，隐藏本 scope 全部运行时上下文快照。

被**刻意排除**（动了会崩）：`harness:identity`（模型身份根基）、`tools:code-only` / `tools:sdk`（code 模式协议关键）、`provider` / `model` / `cwd`（strict 插值变量，空影子会在渲染时抛错）。

此外，停用一个普通工具时会顺带影子掉它的 `tool:<name>` 指导段，省 token 并消除「工具没了指导还在」的矛盾。仅在 agent 有真实 scope 时启用。

### 状态存在哪

三级状态都存在 `capability-toggle` settings 命名空间的同一份文档里：

```
{ global:   { <id>: on|off },
  projects: { <cwd>: { <id>: on|off } },
  sessions: { <sessionId>: { <id>: on|off } } }
```

键缺省即*未设*（继承）。开关 id 命名空间互不相交：

```
skill:<name>   mcp:<server>   tool:<name>
prompt:section:<name>   prompt:context:<name>   prompt:runtime
approval:policy   guard:<name>
```

**为什么用 settings 而不是 session-log 事件：** harness 的持久化对「仓库外插件事件类型且未标记 `ignorable`」会拒绝整条日志（`assertEventsSupported`），自定义事件会让会话重载直接坏掉。按 `sessionId` 键的 settings 命名空间在重载后同样存活，且完全不碰日志。「**模型可见 ⟺ 已记录**」红线依然成立：被停用的后果由既有 owner 记录——`request/header` 快照与工具/技能目录。

### 架构

```
src/
  shared/              两半共用的纯类型与纯逻辑
    types.ts           CapabilityKind / ToggleState / ToggleLevel / 投影行
    resolve.ts         三级 → 实际生效的纯解析（会话 › 项目 › 全局 › 默认开）
  host/                Node 半（ESM，@deepseek-ai/* 外部化）
    config.ts          settings 命名空间与 schema
    store.ts           OverrideStore：读 / 监听 / 分层 / 写一级
    inventory.ts       枚举一个 scope 可见的 skill/mcp/tool，聚合 MCP
    prompt.ts          精选白名单 + assemble 探测 + 影子/抑制
    approval.ts        scoped 审批请求锁
    guards.ts          守卫预设 + tools/pre-execute 匹配器
    agent-binding.ts   单 agent 的强制执行与投影
    controller.ts      binding 注册表 + 最后已知清单快照
    http.ts            两条同源路由（读投影 / 写一级）
    self-check.ts      框架契约横幅 + warn-once 漂移告警
  client/              浏览器半（CJS，由 __ModuleLoader__ 包裹）
    index.tsx          输入栏按钮 + 居中弹窗宿主 + 请求排序守卫
    components.tsx     tab、行、三个层级开关
    api.ts             两条 fetch 调用
    locales.ts         zh / en 词典
    styles.ts          主题变量驱动的单份注入样式表
test/
  pure.test.ts         87 条纯逻辑测试
```

**数据通道** —— 客户端与 Host 之间走两条同源相对路由：

- `GET  /api/plugin/capability-toggle/state?session=<id>` → `{ projection }`
- `POST /api/plugin/capability-toggle/set` `{ session, level, id, state }` → 写入后返回刷新的 `{ projection }`

任一次写入都会触发对每个在线 agent 的 reconcile。

**信任边界** —— 这两条路由沿用 DSH 本地 GUI 的信任模型：同源、无独立鉴权、无 CSRF token，依赖「只有本机能访问 `127.0.0.1` 上的 GUI 端口」这一前提。`/set` 是持久化 settings 的写路由，任何能访问该端口的本地进程都能调用它。若把 GUI 暴露到非本机地址，需自行在前置代理加鉴权。

### 安装

作为 DSH bundle 插件安装到 profile：

1. 让 profile 能解析到本包：

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

2. 本包自带 `cordis.patch.yml`，会把 Host 半插入 loader；`dsh.client` 声明让 WebUI 加载客户端 bundle。
3. 重启 `dsh --profile <profile>` 并刷新页面，输入栏会出现能力开关按钮。

### 开发

```bash
pnpm install
pnpm run typecheck   # tsc × 2（host 与 client 两套 tsconfig）
pnpm run build       # tsdown → lib/index.js (ESM) + lib/client.js (CJS)
pnpm test            # node --test，纯逻辑
```

客户端 bundle 是 CJS，由 `window.__ModuleLoader__.load` 包裹，externals 仅平台模块（`react`、`react/jsx-runtime` 等），不内联任何跨插件值。Host bundle 是 ESM，`@deepseek-ai/*` 与 `node:*` 全部外部化。

### 许可

MIT，见 [LICENSE](./LICENSE)。
