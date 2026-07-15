# 如意 Ruyi —— 本地 AI 全能工作台

一个 clean-room 的 Windows 本地工作台，把内网 Claude CLI（或任意 OpenAI 兼容端点）包成类似 Claude App/Claude Code 的体验：对话、附件、项目目录、文件操作、PowerShell、脚本、浏览器/Office 交接、截图，以及可被 Claude CLI 调用的 MCP 工具。有网没网都能正常运行，非程序员也可安全使用。

> **项目门面(含界面截图、功能详解、同类对比、快速开始)见仓库根 [README](../README.md);界面截图在 [`../docs/screenshots/`](../docs/screenshots/)。**

> **关于品牌**：本项目原名 **Win Claude Workbench**，自 v0.8 起更名为 **如意 Ruyi**。改名是开源发布的法务考量——项目名含 "Claude" 存在**商标风险**，且旧系统提示词里「running inside Win Claude Workbench」一句曾导致 provider 模型**身份错认**（provider 模型自称「我是 Claude」）。「如意」取「称心如意、如你所愿」之意，图标为青花如意云纹。
> **兼容性**：目录名已改 `ruyi-workbench/`、可执行文件名已改 `Ruyi.exe`（启动/检测脚本双名兼容旧 `WinClaudeWorkbench.exe`）。为不破坏存量接入，以下**存量兼容标识有意保持不变**（建议下一个大版本收口）：MCP server id `win-claude-workbench`（已写进用户 `.mcp.json`）、默认数据目录 `~/.win-claude-workbench`、环境变量 `WIN_CLAUDE_WORKBENCH_HOME`（`RUYI_HOME` 优先，旧变量继续识别）。子进程 MCP 配置注入的仍是旧变量名（值=已解析的数据目录），故存量 `.mcp.json` 照常工作。

**多引擎(v0.5+)**：除内网 Claude CLI 外，还支持 **OpenAI 兼容 provider**（DeepSeek / 通义千问 DashScope / 智谱 GLM / 内网 vLLM·Ollama 等），直连 HTTP + SSE 流式，带原生工具循环。在设置里配置 base URL + 密钥即可切换模型，Claude CLI 引擎与 provider 引擎并存。

**桌面 MCP 桥接(v0.7d+)**：可自动探测本机的 `ai-computer-control` 桌面控制 MCP（及其它自定义 stdio MCP），把它们同时供给 Claude CLI 与 provider 引擎。v1.6.1 起默认按任务装载工具提示词：provider 可在循环中增量加入 schema，Claude CLI 通过风险分级代理发现/调用隐藏工具；“全部常驻”兼容模式仍可在高级设置启用。v1.6.2 增加安全的批量历史清理：保留当前、置顶与运行中的会话，可选一并清除关联的检查点和 Agent 记录。

压缩包内还包含一个本地 Claude Code marketplace：`resources\plugins\win-workbench-offline`。其中的 `offline-toolkit` 复刻了常用插件/skill 的离线能力，包括代码审查、前端审计、本地文档上下文、提交说明、CLAUDE.md 管理、API 调试、CI 复现、安全检查、插件开发和发布打包提示词。

**多 Agent 编排 + 团队模式(v1.4→v1.5)**：DAG 工作流、质量门、资源租约防死锁、Git worktree 隔离、实时监控。v1.5 团队模式在此之上增加：**共享任务池**(子代理 `propose_task` 提案→审批→物化为普通 DAG 节点，运行时嵌套委派的可观测替代)、**Agent 邮箱**(`send_to_agent` 节点间单向异步消息，与用户插话分池)、**定向插话**(运行中对指定 OpenAI 引擎节点 `steer_node`)、**跨会话工作台记忆**(`dataRoot/memory` 按项目分组、起草-确认入库、围栏渐进注入)。

**Skills 体系 v1(v1.5)**：四源技能注册表(内置 toolkit / 用户 `dataRoot/skills` / 项目 `.ruyi/skills/<id>/SKILL.md` / Playbook 并入)，会话级启用(上限 8)，跨引擎渐进注入——system prompt 只放紧凑索引，provider 引擎经 `skill_read` 工具按需拉全文，Claude 引擎经 `--append-system-prompt` + 自带 Read 展开。

**成本 / 用量看板(v1.5)**：诚实计费——区分 Anthropic 官方 / 第三方 Coding Plan(如火山方舟 Ark)/ OpenAI provider，分币种记账不强制换算，第三方端点标注「计划内计费」不计入真实花费；工作流子代理、自动/手动压缩、Playbook 起草等全部烧 token 路径均入账，月度预算告警。

**中英界面**：设置中支持跟随系统、简体中文和英文。语言资源随包发布；高频动态反馈和 API 错误通过稳定错误码本地化，详细契约见 [`../docs/i18n/README.md`](../docs/i18n/README.md)。

## 快速启动

```powershell
node .\app\server.js serve --open
```

打包后：

```powershell
.\Ruyi.exe serve --open
```

## 常用命令

```powershell
.\Ruyi.exe doctor
.\Ruyi.exe mcp-config
.\Ruyi.exe install
.\Ruyi.exe mcp
```

## 离线包

```powershell
npm.cmd install
powershell -ExecutionPolicy Bypass -File .\tools\package-offline.ps1
```

输出：

```text
dist\Ruyi-offline.zip
```

## 文档

- 用户手册：[English](docs/manuals/USER-GUIDE_EN.md) · [中文](docs/manuals/USER-GUIDE_CN.md)
- 管理员手册：[English](docs/manuals/ADMIN-GUIDE_EN.md) · [中文](docs/manuals/ADMIN-GUIDE_CN.md)
- 架构说明：[English](docs/ARCHITECTURE_EN.md) · [中文](docs/ARCHITECTURE_CN.md)
- 离线部署：[English](docs/OFFLINE_DEPLOYMENT_EN.md) · [中文](docs/OFFLINE_DEPLOYMENT_CN.md)
- 源码审阅：[English](docs/SOURCE_REVIEW_EN.md) · [中文](docs/SOURCE_REVIEW_CN.md)
- 多语言契约：[English](../docs/i18n/README_EN.md) · [中文](../docs/i18n/README.md)
- 迭代记录与验收：[`../docs/OPTIMIZATION-ROADMAP.md`](../docs/OPTIMIZATION-ROADMAP.md)

## Clean-room 声明

本项目为 **clean-room 独立实现**：**不含** Anthropic 泄露源码、**不分发**官方 Claude CLI、**不复制**第三方插件源码，也不假设公网可用。你需要在内网机器上提供自己的 Claude CLI（或配置任意 OpenAI 兼容端点），然后通过 UI 设置路径或运行安装脚本注册 MCP。随包前端静态库（marked / highlight.js 及主题）的许可义务见仓库根 [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)；本体在 [Apache-2.0](../LICENSE) 下发布。

详细文档见：

- `docs\SOURCE_REVIEW_CN.md`
- `docs\ARCHITECTURE_CN.md`
- `docs\OFFLINE_DEPLOYMENT_CN.md`
