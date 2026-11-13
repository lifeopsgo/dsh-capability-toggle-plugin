# dsh-capability-toggle-plugin

[![中文](https://img.shields.io/badge/README-中文-red?style=flat-square)](./README.md) [![English](https://img.shields.io/badge/README-English-blue?style=flat-square)](./README.en.md) [![详细中文](https://img.shields.io/badge/README-详细中文-orange?style=flat-square)](./README.zh-CN.md)

一个 DSH（DeepSeek Harness）插件：在会话输入框上方开一个面板，把 agent 能用的能力逐个打开或关掉。关掉的能力 agent 就看不见了——工具列表里没有、skill 目录里没有，强行调用会被直接拦截。

## 能关什么

- **skill**：一个一个关
- **tool**：内置工具和 MCP 服务器的工具都能关
- **MCP**：按服务器整体关，一次关掉它下面所有工具

## 三层生效范围

每个能力有三个档位，层层覆盖，会话 > 项目 > 全局：

- **全局**：对所有会话生效
- **项目**：只对这个项目目录下的会话生效
- **会话**：只对当前这个会话生效

关掉后想恢复，把对应档位清掉（回到「继承」）或改成开即可。设置保存在配置里，重启不丢。

## 顺带的显示偏好

面板里还能设置输入框下方的统计显示：token 余量分数/百分比、用量、水位层级，只影响显示，不影响 agent 能力。

界面的六个开关（隐藏 logo、隐藏新会话按钮等）已经拆到独立插件 [dsh-ui-toggle-plugin](https://github.com/lifeopsgo/dsh-ui-toggle-plugin)，本插件不再包含。

## 安装

```bash
dsh plugin --profile web add github:lifeopsgo/dsh-capability-toggle-plugin#v2.3.0
dsh --profile web web
```

装好后，等会话里有 agent 在跑时，点输入框上方的开关按钮打开面板（agent 空闲时面板打不开，这是设计如此）。

卸载：`dsh plugin --profile web remove dsh-capability-toggle-plugin`

## 兼容性

面向 DSH 0.2.1-rc.5 开发和验证（也兼容 0.2.1-rc.2 与 0.2.0-rc.1）。其他版本未验证。

## 开发

```bash
pnpm install
pnpm typecheck && pnpm build && pnpm test   # 381 项测试
```

实现细节见 [README.en.md](./README.en.md)（英文）与 [README.zh-CN.md](./README.zh-CN.md)（详细中文）。

MIT
