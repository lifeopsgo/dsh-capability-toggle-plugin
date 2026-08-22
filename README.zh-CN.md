<div align="center">

# dsh-capability-toggle-plugin

**在 DSH WebUI 输入栏逐项开关 agent 的能力 —— 而且是真的强制生效。**

[![platform](https://img.shields.io/badge/platform-DSH%20WebUI-2b7cd3?style=flat-square)](#快速开始)
![tests](https://img.shields.io/badge/tests-87%20passing-3fb950?style=flat-square)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A522.6-5fa04e?style=flat-square)

[English](./README.md) · **简体中文**

<img alt="能力开关弹窗：五个 tab，一行一项能力，每行三级开关" src="./docs/screenshot.jpeg" width="900">

<sub>每行三个开关 —— 会话、项目、全局。蓝色对勾 = 开 · 红色叉 = 关 · 虚线横杠 = 未设。<br>已设开关右上角的小角标可清除回未设；行尾徽标是三级综合后的真实结果。</sub>

</div>

---

## 这是什么

一个 **DeepSeek Harness (DSH) WebUI** 插件，在对话输入栏加一个按钮。agent 空闲时点开，逐项开关**技能、MCP 服务器、工具、提示词注入点、审批闸门、安全守卫** —— 每项都能在**会话**、**项目**、**全局**三级独立设置。

关掉某项不是界面上的假过滤。被停用的能力会**在模型下一步就从工具 schema 和技能目录里真实消失**，模型若仍强行调用，会被**硬拦截**。

| | |
| --- | --- |
| 🎛️ **五个 tab，六个能力族** | 技能 · MCP · 工具 · 提示词 · 安全 |
| 🧭 **每行三级** | 会话 › 项目 › 全局 › 默认（启用） |
| 🔒 **真强制** | 从 schema 集移除，不是界面隐藏 |
| ⚡ **下一步即生效** | 无需重启会话 |
| 🌐 **双语** | 中英词典，跟随 WebUI 语言 |

## 快速开始

一条命令，按 tag 装进你的 DSH profile：

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v0.1.0
```

重启 GUI，然后刷新页面：

```bash
dsh --profile web web
```

输入栏 ➕ 旁边会出现能力开关按钮，agent 空闲时点开即可。

> **就这样。** `dsh plugin` 会把参数转发给 profile 目录下的 pnpm，装完自动 reconcile `dsh.profile.bundles` —— 声明了 `dsh.bundle` 的包（本插件就有）会自动加入 layer stack，不用手改 `package.json`。

<details>
<summary><b>注意事项与其它命令</b></summary>

<br>

- **锁定 tag** —— 把 `v0.1.0` 换成你要的版本，见 [releases](https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases)；也可以用 `#main` 跟随分支。
- **`--profile web`** 是 Web GUI 常用的 profile，名字不同就换成你自己的。
- **不需要构建** —— tag 里带了预构建的 `lib/`，安装不触发 `prepare` 脚本，所以不会碰到 git 插件常见的 pnpm 构建审批门槛（`allowBuilds`）。

```bash
# 升级到另一个 tag
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v0.2.0

# 卸载
dsh plugin --profile web remove dsh-capability-toggle-plugin
```

</details>

## 功能说明

### 三级模型

每项能力都有 `会话`、`项目`、`全局` 三个开关，每个可取 **开**、**关** 或 **未设**。

```
会话  ›  项目  ›  全局  ›  默认（启用）
```

**就近生效**：最近一层设了什么就按什么来；某层**未设**则向下一层跟随。三层都未设时，能力保持启用。行尾徽标始终显示三级综合后的**真实结果**，你不需要自己在脑子里推演优先级。

开关只显示当前状态：点一下在**开 ↔ 关**之间翻转，点右上角的清除角标回到**未设**。

### 六个能力族

| 能力族 | Tab | 一行代表 | 说明 |
| :-- | :-- | :-- | :-- |
| `skill` | 技能 | 一个模型可调用的技能 | 停用时用同名 `modelInvocable:false` 技能影子掉它 |
| `mcp` | MCP | 一个 MCP **服务器**（`mcp__<server>__*` 聚合成一个开关） | 停用即拒绝该服务器全部工具；行可展开查看成员工具 |
| `tool` | 工具 | 一个模型可见工具 | 顺带隐藏它的 `tool:<name>` 指导段 —— 省 token，避免「工具没了指导还在」 |
| `prompt` | 提示词 | 一个可开关的系统提示词注入点 | **精选白名单**，且探测真实存在性：当前部署没注册的就不显示开关 |
| `approval` | 安全 | 审批升权闸门（单例） | 关 ⇒ 本 agent 的所有审批请求一律自动拒绝。与系统 `/permission` 设置互不干扰 |
| `guard` | 安全 | 一个可选安全守卫预设 | **默认关**。开 ⇒ 守卫对命中的调用生效 |

### 强制是怎么实现的

五条路径都作用在 **agent 自己的层**上，过滤它继承来的能力面。不改任何全局注册，agent 释放时全部还原。

| 能力族 | 机制 | 结果 |
| :-- | :-- | :-- |
| `tool` / `mcp` | 在 agent 自身 scope 上 `ctx.tools.restrict({ deny })` | 工具离开模型 schema 集；`request/header` 快照不再列出它；强行调用被拒 |
| `skill` | 用同名 `modelInvocable:false` 运行时技能影子掉真技能 | 技能从 `<available_skills>` 消失；`skill` 工具的 `isModelInvocable` 判定失败并抛错 |
| `prompt` | 同名**空文本** `systemPrompt.section` / `.context` 影子，或 `suppressRuntimeContext()` | 该段落在组装时被空影子覆盖、渲染时丢弃；owner 服务照常运行，只是「告知模型的内容」变了 |
| `approval` | scoped `approval/request` 监听器直接 resolve `'rejected'` | 本 agent 的审批请求被确定性拒绝，且不动部署共享的审批策略 |
| `guard` | `tools/pre-execute` 监听器按预设谓词匹配 | `拦截` 直接拒绝调用；`确认` 弹一次审批，允许才继续 |

### 安全 tab

**审批升权**（默认**开**）—— 允许本 agent 发起需要你审批的操作。关掉后，本 agent 的所有审批请求一律自动拒绝：不弹窗、不升权。与系统 `/permission` 设置互不干扰。

**守卫预设**（默认**关**，需主动开启）。守卫的语义与其它族相反：**开**意味着*保护已启用*，所以它生效时徽标显示*守卫中*。

| 守卫 | 动作 | 覆盖范围 |
| :-- | :-- | :-- |
| 只读模式 | 🚫 拦截 | 所有文件写入 / 新建 / 编辑 —— 只能读不能改 |
| 保护密钥 | 🚫 拦截 | 任何触及 `.env`、`*.pem`、`id_rsa`、`credentials`、`.ssh/` 的读写或 shell 命令 |
| 危险 shell 需确认 | ⚠️ 确认 | `rm -rf`、`dd`、`mkfs`、`chmod 777`、`curl \| sh`、fork 炸弹 |
| 破坏性 git 需确认 | ⚠️ 确认 | `push --force`、`reset --hard`、`clean -fd`、`branch -D` |
| 外网出站需确认 | ⚠️ 确认 | `web_search`、`read_page`、`curl`/`wget`、`git push`、`npm publish` |

`拦截`类守卫先于`确认`类求值，所以拦截规则永远优先于确认弹窗。

### 提示词 tab

系统提示词注册表里条目很多，但大部分置空会出问题。本插件只开放精选的几项，并且**探测**实际装配情况 —— 只有当前部署真的注册了，才会出现对应开关：

- **`deployment:persona`** —— order-0 人格段落；空文本是官方文档化的一等状态。
- **`sandbox:policy` / `approval:policy`** —— 告知模型沙箱模式与审批策略的运行时上下文。停用只改「告诉模型什么」，实际策略仍由 owner 服务强制。
- **隐藏全部运行时上下文** —— 一把粗开关，作用于本 scope。

被**刻意排除**（动了会崩）：`harness:identity`（身份根基）、`tools:code-only` / `tools:sdk`（code 模式协议关键）、以及 strict 插值变量 `provider` / `model` / `cwd`。

### 行为细节

- **运行中锁定** —— agent 工作时（`session.running`）所有开关只读，切换在它空闲后生效。
- **关弹窗、跨轮次都不丢** —— 状态存在 settings 命名空间，Host 还缓存了最后一次已知的能力清单，所以轮次之间重开弹窗仍能正确显示已停用状态。
- **框架契约自检** —— 插件依赖的接缝在激活时断言，并打印一行可 grep 的横幅。宿主事件一旦改名，强制会**失效为放行**（fail-open）并悄悄停止 —— 这是最危险的方向，所以让它可被观测。

---

<div align="center">
<sub>MIT，见 <a href="./LICENSE">LICENSE</a></sub>
</div>
