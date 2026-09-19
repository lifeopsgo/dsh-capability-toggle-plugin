<div align="center">

# dsh-capability-toggle-plugin

**在 DSH WebUI 中控制 agent 能力，并在运行时真正强制执行。**

[![platform](https://img.shields.io/badge/platform-DSH%20WebUI-2b7cd3?style=flat-square)](#快速开始)
![tests](https://img.shields.io/badge/tests-197%20passing-3fb950?style=flat-square)
[![release](https://img.shields.io/github/v/release/lifeopsgo/dsh-capability-toggle-plugin?style=flat-square)](https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

[English](./README.md) · **简体中文**

<img alt="技能、MCP、工具、提示词与安全能力开关" src="./docs/screenshot.jpeg" width="900">

<sub>会话 · 项目 · 全局 —— 蓝色对勾 = 开，红色叉 = 关，虚线横杠 = 未设。</sub>

</div>

## 这是什么

一个 **DeepSeek Harness（DSH）WebUI** 插件，在输入栏旁增加能力开关。它可以在会话、项目或全局层级控制**技能、MCP 服务器、工具、提示词注入、审批升权和安全守卫**。

停用不是界面上的假过滤：能力会在模型下一步从可见能力面中消失，强行调用也会在执行时被拦截。

## 兼容的 DSH 版本

一份构建同时服务整个 0.1.x 系列。DSH 0.1.2 改动了输入栏插槽的 owner 参数——不再传
`session` 快照对象，改为框架标准的 `sessionId` 属性与 `useSession` hook——本插件两种
形态都能读取。

| DSH 版本 | 状态 | 验证方式 |
| --- | --- | --- |
| 0.1.1-rc.2 | 支持 | 单元测试、类型检查、构建，以及真实浏览器会话（面板渲染、开关写入） |
| 0.1.2-rc.1 | 支持 | 单元测试、类型检查（Host 与 Client 两个编译面）、对已安装 0.1.2 宿主的加载检查；上述浏览器验证仅在 0.1.1 上做过 |
| 0.1.3-alpha.1 / -alpha.2 | 支持 | 本插件消费的每个 DSH 符号都已从 0.1.2-rc.1 逐一对比到当前 HEAD，均未变化；未在已安装的 0.1.3 宿主上构建或运行 |
| 0.1.5-alpha.x / -rc.x | 支持 | Host 与 Client 类型检查、构建，以及对真实的 0.1.5-rc.2 包逐一对比本插件消费的每个 DSH 符号：`createScope`/`scopeOf`、`tools/pre-execute`、`tools/result`、`PreToolDecision`、`ApprovalOutcome`、`session.header.cwd` 与 0.1.1 逐字节相同；`approval/request` 的接收者（`Scoped<ApprovalService>` → `Scoped<Agent>`）与载荷名（`ApprovalRequest` → `ApprovalRequestEvent`）有变化，但本插件的监听器两者都不读取，故不受影响。未在已安装的 0.1.5 宿主上运行 |

声明的 `peerDependencies` 接纳以上全部版本，包括 npm 以 `next`（0.1.5-rc.2）和
`alpha`（0.1.5-alpha.2）发布的预发布版，并拒绝 0.2.0 及以后。

## 快速开始

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.4.0
dsh --profile web web
```

刷新页面，在 agent 空闲时点击输入栏 ➕ 旁边的开关按钮。若使用其他 profile，请替换 `web`。

<details>
<summary>升级或卸载</summary>

```bash
# 升级或降级：tag 换成 releases 页面上的任意版本
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.4.0

# 卸载
dsh plugin --profile web remove dsh-capability-toggle-plugin
```

</details>

## 功能说明

### 三级生效模型

每项能力都有三个独立层级：

```text
会话  ›  项目  ›  全局  ›  默认（启用）
```

最近的明确设置优先。**未设**会向下一层跟随；三层都未设时保持启用。行尾徽标始终显示三级综合后的真实结果。

按钮只显示当前状态：点击在**开 ↔ 关**之间切换，点击右上角清除角标可回到**未设**。

### 能力分类

| Tab | 控制内容 |
| :-- | :-- |
| **技能** | 单个模型可调用技能，包含从会话工作区发现的项目级技能（`.dsh/skills`、`.agents/skills`） |
| **MCP** | MCP 服务器；展开行可查看成员工具 |
| **工具** | 单个模型可见工具及其指导段 |
| **提示词** | 经过安全筛选并探测实际存在性的提示词注入项 |
| **安全** | 审批升权和 5 个可选安全守卫 |

### 强制机制

所有机制只作用于当前 agent，不修改全局注册。

| 能力族 | 强制方式 |
| :-- | :-- |
| `tool` / `mcp` | 通过 `ctx.tools.restrict({ deny })` 移除；强行调用被拒绝 |
| `skill` | 用同名 `modelInvocable:false` 运行时技能覆盖 |
| `prompt` | 用空文本覆盖，或通过 `suppressRuntimeContext()` 抑制 |
| `approval` | scoped 审批请求直接返回 `rejected` |
| `guard` | `tools/pre-execute` 对命中调用执行拦截或确认 |

### 安全控制

关闭**审批升权**后，该 agent 的所有审批请求都会被拒绝，但不会修改系统 `/permission` 设置。

安全守卫默认关闭，按需启用：

| 守卫 | 动作 |
| :-- | :-- |
| 只读模式 | 拦截文件写入、新建和编辑 |
| 保护密钥 | 拦截常见密钥文件与凭据访问 |
| 危险 shell | 高风险 shell 命令需确认 |
| 破坏性 git | 可能丢失历史或工作区内容的 git 命令需确认 |
| 外网出站 | 网络工具与外连 shell 操作需确认 |

### 用量统计

技能、MCP 服务与工具行会显示一个小徽章，标明本会话模型调用了多少次（「调用 7 次」）。计数在面板打开时于每轮结束后刷新，只存活于单个 agent 生命周期且不持久化——与安全守卫的「命中 N 次」徽章采用同一保留策略。

统计的是**请求次数**而非成功执行次数：被守卫拦截或转确认的调用同样计入，因为「模型想要用这个能力」本身就是值得看见的信号。守卫是被调用匹配而非被调用，因此沿用自己的徽章、不显示用量；提示词与审批行同样不显示。

### 面板偏好

面板标题旁的折叠箭头展开三个显示偏好，存入 `localStorage`，因此刷新页面与重启浏览器后仍然保留：

| 偏好 | 作用 |
| :-- | :-- |
| **标签页显示「启用数 / 总数」** | tab 徽章由纯总数改为分数形式（`67/106`），一眼看出每族能力的启用比例；无论开关与否，悬停提示都以文字给出两个数字。 |
| **显示调用统计** | 控制上文的每行用量徽章是否显示。 |
| **显示的层级列** | 将网格收窄为仅会话级、会话级 + 项目级，或三级全显。 |

分数只把**已生效**的守卫计入启用数。guard 行复用同一个 `disabled` 字段表示「已激活」，与其他默认启用族的方向相反——所以审批开关打开、五个守卫都未激活时，安全 tab 显示 `1/6` 而不是 `6/6`。

收窄层级列**只影响显示**：三级优先级解析照常运行，被隐藏的项目级或全局级设定仍然生效。每行的徽章与层级开关始终反映综合解析后的状态——默认启用族显示「生效中/已停用」，守卫显示「守护中/未启用」——因此隐藏一列不会隐藏任何生效影响。名称列会吸收释放出来的宽度；布局由 CSS 变量驱动，因此与窄屏适配保持对齐。

其他行为：agent 运行时，会写入设定的控件锁定——每行的层级开关、其清除徽章、以及批量菜单——但浏览保持可用，因此搜索框、层级列下拉、tab 切换、行展开照常工作；关闭弹窗或跨轮次后状态仍保留；界面语言跟随 WebUI。

## 规划

以下为规划中、尚未实现：

- **跨项目同步配置** — 从其他项目复制或引用项目级配置，无需逐个项目重新配置。
- ~~**能力调用统计**~~ — 已于 v1.2.0 实现：技能、MCP 服务与工具行会以徽章显示本会话被模型调用的次数。
- ~~**分数格式的 tab 计数**~~ — 已于 v1.3.0 实现：tab 徽章改为「已启用 / 总数」，面板标题旁的折叠箭头提供三个显示偏好。安全 tab 的 guard 只有已生效才计入分子，其反转的 `disabled` 字段不会虚增启用数。
- **可自定义默认项的设置菜单** — 在设置菜单中暴露插件自身的配置项，例如新发现能力的默认状态（当前三层都未设的能力解析为启用，但可选的安全守卫默认不启用）。
- **只显示已启用 / 只显示已禁用** — 在搜索框旁增加状态过滤（搜索当前只匹配名称与描述）。安全守卫需要与分数计数同样的处理：guard 复用 `disabled` 表示「已激活」，因此「只显示已禁用」不能把实际生效中的守卫列进去。该过滤还会缩小批量操作的作用范围，因为批量作用于当前可见的所有行。
- ~~**筛选与全选**~~ — 已于 v1.1.0 实现：工具栏搜索框可筛选行，各层级的批量菜单可对当前可见的所有行执行启用/停用/清除。
- ~~**筛选全选后批量操作**~~ — 已于 v1.1.0 与筛选功能一同交付（搜索缩小范围，批量作用于当前可见行）。

---

<div align="center"><sub>MIT — 见 <a href="./LICENSE">LICENSE</a></sub></div>
