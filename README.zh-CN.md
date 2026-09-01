<div align="center">

# dsh-capability-toggle-plugin

**在 DSH WebUI 中控制 agent 能力，并在运行时真正强制执行。**

[![platform](https://img.shields.io/badge/platform-DSH%20WebUI-2b7cd3?style=flat-square)](#快速开始)
![tests](https://img.shields.io/badge/tests-107%20passing-3fb950?style=flat-square)
[![release](https://img.shields.io/github/v/release/lifeopsgo/dsh-capability-toggle-plugin?style=flat-square)](https://github.com/lifeopsgo/dsh-capability-toggle-plugin/releases)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

[English](./README.md) · **简体中文**

<img alt="技能、MCP、工具、提示词与安全能力开关" src="./docs/screenshot.jpeg" width="900">

<sub>会话 · 项目 · 全局 —— 蓝色对勾 = 开，红色叉 = 关，虚线横杠 = 未设。</sub>

</div>

## 这是什么

一个 **DeepSeek Harness（DSH）WebUI** 插件，在输入栏旁增加能力开关。它可以在会话、项目或全局层级控制**技能、MCP 服务器、工具、提示词注入、审批升权和安全守卫**。

停用不是界面上的假过滤：能力会在模型下一步从可见能力面中消失，强行调用也会在执行时被拦截。

## 快速开始

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.0.4
dsh --profile web web
```

刷新页面，在 agent 空闲时点击输入栏 ➕ 旁边的开关按钮。若使用其他 profile，请替换 `web`。

<details>
<summary>升级或卸载</summary>

```bash
# 升级或降级：tag 换成 releases 页面上的任意版本
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v1.0.4

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

其他行为：agent 运行时锁定开关；关闭弹窗或跨轮次后状态仍保留；界面语言跟随 WebUI。

## 规划

以下为规划中、尚未实现：

- **跨项目同步配置** — 从其他项目复制或引用项目级配置，无需逐个项目重新配置。
- ~~**筛选与全选**~~ — 已于 v1.0.4 实现：工具栏搜索框可筛选行，各层级的批量菜单可对当前可见的所有行执行启用/停用/清除。
- ~~**筛选全选后批量操作**~~ — 已于 v1.0.4 与筛选功能一同交付（搜索缩小范围，批量作用于当前可见行）。

---

<div align="center"><sub>MIT，见 <a href="./LICENSE">LICENSE</a></sub></div>
