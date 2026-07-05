# 离线部署说明

## 目标机器要求

- Windows 10/11 或 Windows Server。
- 已有可用的内网 `claude` CLI，或稍后在 UI 设置 Claude CLI 路径。
- 不要求公网。
- 不要求 npm install；压缩包内会带 `Ruyi.exe`，并尽量带一个 Node 运行时作为源码 fallback。

## 安装

解压离线包后，在包根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\resources\scripts\install-workbench.ps1
```

如果 Claude CLI 不在 PATH：

```powershell
powershell -ExecutionPolicy Bypass -File .\resources\scripts\install-workbench.ps1 -ClaudePath "D:\internal\claude\claude.cmd"
```

启动 UI：

```powershell
.\Ruyi.exe serve --open
```

或：

```cmd
Start-Workbench.cmd
```

## Claude CLI 接入

安装脚本会尝试执行：

```powershell
claude mcp add-json win-claude-workbench "{...}" -s user
```

如果自动注册失败，手动导入：

```powershell
.\Ruyi.exe mcp-config
```

该命令会打印生成的 MCP JSON 文件路径。把其中 `mcpServers.win-claude-workbench` 配置加入 Claude CLI 的 MCP 配置即可。

## 插件/技能

包内带本地 marketplace：

```text
resources\plugins\win-workbench-offline
```

安装脚本会尝试：

```powershell
claude plugin marketplace add .\resources\plugins\win-workbench-offline --scope user
claude plugin install offline-toolkit@win-workbench-offline --scope user
```

如果内网 Claude CLI 的插件命令不可用，可以只用 MCP 工具；核心功能不依赖插件。

当前离线插件包 `offline-toolkit` 复刻了常见 Claude Code 插件/skill 的核心工作流，均为本地 clean-room 实现，不需要公网：

- 代码审查与安全检查：`code-review-offline`、`security-guidance`、`offline-code-review` 命令。
- 前端设计与离线资源审计：`frontend-design-craft`、`frontend-audit` 命令。
- 功能开发、代码简化、提交说明：`feature-development`、`code-simplifier`、`commit-workflow`。
- 本地文档上下文：`local-docs-context`，用于替代在线文档检索类插件。
- API/CI/LSP/插件开发：`api-debugger`、`devops-ci-local`、`lsp-local-setup`、`plugin-development`。
- 项目指令维护：`claude-md-management`、`claude-md-audit` 命令。
- 角色提示词：`code-reviewer-offline`、`frontend-offline`、`release-packager`、`windows-operator`。

这些 skill 会调用 Workbench MCP 工具，例如 `dependency_inventory`、`git_status`、`code_review_scan`、`frontend_audit`、`docs_search` 和 `http_request`。目标机器不需要访问 Anthropic 在线插件市场，也不需要运行时下载 npm/pip 包。

## 验证

```powershell
.\Ruyi.exe doctor
```

在 Claude CLI 中可让它调用 MCP 工具，例如：

```text
请使用 win-claude-workbench 的 project_snapshot 查看当前项目结构。
```

也可以验证新增离线能力：

```text
请使用 win-claude-workbench 的 dependency_inventory 和 code_review_scan 审查当前项目。
```

## 边界

- 本工具不内置 Anthropic 官方 Claude CLI，也不分发官方插件。
- 无公网环境下，Web 搜索、OAuth、在线 marketplace 更新不可用。
- 为避免授权和供应链风险，压缩包不会直接复制第三方公开插件源码；这里提供的是常见能力的本地复刻版和离线提示词。
- 浏览器深度自动化目前是轻量交接：打开 URL、截图、键盘输入；复杂 DOM 自动化建议在内网预装 Playwright 后通过 `script_run` 调用。
