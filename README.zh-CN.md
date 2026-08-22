<h1 align="center">dsh-capability-toggle-plugin</h1>

<p align="center">
  <strong>在 DSH WebUI 对话输入栏逐项开关 agent 能力——而且是真强制。</strong>
</p>

<p align="center">
  <a href="#安装"><img alt="platform" src="https://img.shields.io/badge/platform-DSH%20WebUI-2b7cd3"></a>
  <a href="#开发"><img alt="tests" src="https://img.shields.io/badge/tests-87%20passing-3fb950"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.6-5fa04e">
</p>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

---

<p align="center">
  <img alt="能力开关弹窗" src="./docs/screenshot.jpeg" width="900">
</p>

<p align="center"><i>逐条能力 × 三级开关（会话 / 项目 / 全局）：蓝色对勾＝启用，红色叉＝停用，虚线短横＝未设；已设定的开关右上角带一个清除角标，行尾徽标是三级综合后的真实结果。</i></p>

一个 **DeepSeek Harness (DSH) WebUI** 插件：在对话输入栏加一个按钮。agent 空闲时点开，弹窗列出这个 agent 当前能触达的每一项能力——**技能、MCP 服务器、工具、提示词注入点、审批闸门、可选安全守卫**——每项都带一个**三级开关**：会话、项目、全局。

关掉某项不是界面上的假过滤。被停用的能力会**在模型下一步就从工具 schema 和技能目录里真实消失**，模型若仍强行调用，会被**硬拦截**。

## 快速开始

一条命令装进 profile（把 `web` 换成你自己的 profile 名）：

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v0.1.0
```

然后重启 `dsh --profile web` 并刷新页面，输入栏就会出现能力开关按钮。

`dsh plugin` 装完会自动把本插件写进 profile 的 `dsh.profile.bundles`（因为包里声明了 `dsh.bundle`），**不需要手改 package.json**。

想跟随主干最新代码，把 `#v0.1.0` 换成 `#main`：

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#main
```

升级与卸载：

```bash
# 升到某个新 tag
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v0.1.0

# 卸载（同时会从 bundles 里摘掉）
dsh plugin --profile web remove dsh-capability-toggle-plugin
```

> 本仓库随包提交了构建产物 `lib/`，所以从 git 安装无需本地构建，也不会触发 pnpm 的 `allowBuilds` 白名单确认。

本地开发用软链接：见 [安装](#安装)。

## 核心能力

- **五个 tab，六个能力族** —— 技能 · MCP · 工具 · 提示词 · 安全（安全 tab 收纳审批闸门和守卫预设，两者本质是权限问题，而非能力开关）。
- **每行三级** —— 会话 / 项目 / 全局，每级可取 `开`、`关` 或*未设*。优先级 **会话 › 项目 › 全局 › 默认（启用）**；某级未设则向下一级跟随。行尾徽标显示三级综合后的**真实生效结果**。
- **真强制，不是隐藏** —— 见 [停用是怎么强制的](#停用是怎么强制的)。
- **逐轮可调** —— 改动会让技能目录缓存失效，并对每个在线 agent 重新 reconcile，**下一步 agent 即生效**，无需重启会话。
- **运行中锁定** —— `session.running` 为真时所有开关只读，切换只在空闲时落地。
- **关弹窗、跨轮次都不丢** —— 状态存在 settings 命名空间，Host 还缓存了最后一次已知的能力清单，所以轮次之间重开弹窗仍能正确显示已关闭状态。
- **国际化** —— 内置简体中文与英文词典，跟随 WebUI 语言。
- **框架契约自检** —— 插件依赖的接缝在激活时断言并打印一行可 grep 的横幅：宿主事件一旦改名，行为会**失效为放行**（fail-open）并悄悄停止强制，这是最危险的方向。

## 六个能力族

| 能力族 | Tab | 一行是什么 | 说明 |
| --- | --- | --- | --- |
| `skill` | 技能 | 一个模型可调用的技能 | 停用即用同名 `modelInvocable:false` 技能影子掉它 |
| `mcp` | MCP | 一个 MCP **服务器**（`mcp__<server>__*` 聚合成一个开关） | 关掉即拒绝该服务器全部工具；该行可展开列出成员工具 |
| `tool` | 工具 | 一个模型可见工具 | 停用时顺带隐藏它的 `tool:<name>` 指导段——省 token，避免「工具没了指导还在」 |
| `prompt` | 提示词 | 一个可闸门的系统提示词注入点 | 一份**精选白名单**，且探测真实存在性：当前部署没注册的项不出现开关 |
| `approval` | 安全 | 审批升权闸门（单例） | 关 = 本 agent 所有审批请求一律自动拒绝：不弹窗、不升权。与系统 `/permission` 设置互不干扰 |
| `guard` | 安全 | 一个可选安全预设 | **默认关**（需主动开启）。开 = 守卫对命中调用生效：`拦截`直接拒绝，`确认`转交你确认 |

## 停用是怎么强制的

五条路径都作用在 agent **自己的层**上：过滤/覆盖继承来的能力面与提示词面，不改全局注册；agent 释放时全部还原。

| 能力族 | 机制 | 结果 |
| --- | --- | --- |
| `tool` / `mcp` | 在 agent 自身 scope 上 `ctx.tools.restrict({ deny })` | 工具离开模型 schema 集；`request/header` 快照不再列出它；强行调用被限制拒绝 |
| `skill` | 在 agent scope 注册同名、`modelInvocable:false` 的运行时技能，影子掉真技能 | 技能从 `<available_skills>` 目录消失；`skill` 工具的 `isModelInvocable` 判定失败并抛错 |
| `prompt` | 用同名**空文本** `systemPrompt.section` / `.context` 影子覆盖，或调用 `suppressRuntimeContext()` | 该提示词段落在组装时被空影子覆盖、渲染时丢弃；owner 服务照常运行，仅「告知模型的内容」变化 |
| `approval` | scoped `approval/request` 监听器直接 resolve `'rejected'` | 本 agent 的所有审批请求一律确定性拒绝，且不动部署共享的审批策略 |
| `guard` | `tools/pre-execute` 监听器按固定预设匹配 | `拦截`直接拒绝该调用；`确认`弹一次审批，允许后才继续 |

## 安全 tab

**审批升权**（默认开）—— 允许本 agent 发起需用户审批的操作。关掉后本 agent 的所有审批请求一律自动拒绝，与系统 `/permission` 设置互不干扰。

**守卫预设**（默认关，需主动开启）。与其它族不同，守卫的「开」意味着*保护已启用*：

| 守卫 | 动作 | 覆盖范围 |
| --- | --- | --- |
| 只读模式 | 拦截 | 所有文件写入 / 新建 / 编辑一律拒绝——只能读不能改 |
| 保护密钥 | 拦截 | 任何触及 `.env`、`*.pem`、`id_rsa`、`credentials`、`.ssh/` 的读写或 shell 命令 |
| 危险 shell 需确认 | 确认 | `rm -rf`、`dd`、`mkfs`、`chmod 777`、`curl \| sh`、fork 炸弹 |
| 破坏性 git 需确认 | 确认 | `push --force`、`reset --hard`、`clean -fd`、`branch -D` |
| 外网出站需确认 | 确认 | `web_search`、`read_page`、`curl`/`wget`、`git push`、`npm publish` |

`拦截`类守卫先于`确认`类求值，所以拦截规则永远优先于确认弹窗。

> 守卫行的读法与其它族相反：它**默认关**，所以当守卫**已启用**时它的状态点才亮起、徽标显示*守卫中*。

## 提示词 tab 为什么是精选白名单

提示词 tab 只暴露一份**精选白名单**，并非全量枚举已注册提示词段落；每项都要先探测 `assemble({scope})` 才显示——当前部署没注册的项就不会出现开关。

- `deployment:persona` —— order-0 人格段落（空文本是官方文档化的一等状态，影子安全）。
- `sandbox:policy` / `approval:policy` —— 告知模型沙箱模式与审批策略的运行时上下文。**停用只改「告诉模型什么」，实际策略仍由 owner 服务强制。**
- **隐藏全部运行时上下文** —— 一把 `suppressRuntimeContext()` 粗开关，隐藏本 scope 全部运行时上下文快照。

被**刻意排除**（动了会崩）：`harness:identity`（模型身份根基）、`tools:code-only` / `tools:sdk`（code 模式协议关键）、`provider` / `model` / `cwd`（strict 插值变量，空影子会在渲染时抛错）。

此外，停用一个普通工具时会顺带影子掉它的 `tool:<name>` 指导段，省 token 并消除「工具没了指导还在」的矛盾。仅在 agent 有真实 scope 时启用。

## 状态存在哪

三级状态都存在 `capability-toggle` settings 命名空间的同一份文档里：

```
{ global:   { <id>: on|off },
  projects: { <cwd>:       { <id>: on|off } },
  sessions: { <sessionId>: { <id>: on|off } } }
```

键缺省即*未设*（继承）。开关 id 命名空间互不相交：

```
skill:<name>   mcp:<server>   tool:<name>
prompt:section:<name>   prompt:context:<name>   prompt:runtime
approval:policy   guard:<name>
```

**为什么用 settings 而不是 session-log 事件：** harness 的持久化对「仓库外插件事件类型且未标记 `ignorable`」会拒绝整条日志（`assertEventsSupported`），自定义事件会让会话重载直接坏掉。按 `sessionId` 键的 settings 命名空间在重载后同样存活，且完全不碰日志。「**模型可见 ⟺ 已记录**」红线依然成立：被停用的后果由既有 owner 记录——`request/header` 快照与工具/技能目录。

## 架构

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
    approval.ts        scoped 审批请求锁（探测可选服务是否存在）
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

## 安装

作为 DSH bundle 插件安装到 profile：

1. 让 profile 能解析到本包（已发布用 `npm i`，本地开发用 `link:`）：

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

## 开发

```bash
pnpm install
pnpm run typecheck   # tsc × 2（host 与 client 两套 tsconfig）
pnpm run build       # tsdown → lib/index.js (ESM) + lib/client.js (CJS)
pnpm test            # node --test，纯逻辑
```

客户端 bundle 是 CJS，由 `window.__ModuleLoader__.load` 包裹，externals 仅平台模块（`react`、`react/jsx-runtime` 等），不内联任何跨插件值。Host bundle 是 ESM，`@deepseek-ai/*` 与 `node:*` 全部外部化。

## 许可

MIT，见 [LICENSE](./LICENSE)。
