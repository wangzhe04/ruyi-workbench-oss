# 对当前源码快照的阅读结论

这份目录不是一个可直接构建的完整工程，而是 README 加大量 `src` 源码快照。`README.md` 明确说明来源是 npm sourcemap 泄露，并声明原始代码属于 Anthropic。因此本项目采用 clean-room 方式复刻产品能力，不复制 Anthropic 源码、提示词或私有实现。

## 观察到的主要结构

- `src/entrypoints/cli.tsx`：CLI 启动层，先处理 `--version`、MCP、Chrome、computer-use、daemon、remote-control、background session 等快速路径，再进入主 CLI。
- `src/main.tsx`：Commander 命令入口和交互启动逻辑，包含 `-p/--print`、`--mcp-config`、`--allowed-tools`、`--model`、`--resume`、`--add-dir`、插件、auth、server、doctor、update 等命令。
- `src/QueryEngine.ts`：非交互/SDK 查询生命周期，负责会话消息、系统提示、工具上下文、流式事件、结果、用量、错误和持久化。
- `src/Tool.ts` 与 `src/tools.ts`：工具抽象和工具池组合。核心内置工具包括 Bash、PowerShell、Read、Write、Edit、Glob、Grep、WebFetch、WebSearch、Todo、Agent、Task、MCP resource 等。
- `src/services/mcp/*`：MCP 配置、连接、OAuth、资源/工具/命令同步、插件 MCP 集成。
- `src/utils/computerUse/*` 与 `src/utils/claudeInChrome/*`：电脑控制与浏览器桥接入口。
- `src/services/plugins/*`、`src/utils/plugins/*`、`src/skills/*`：插件市场、插件缓存、skills、agents、commands 的加载与校验。

## 可复刻的产品能力

- 本地会话与历史记录。
- 文件读写、搜索、编辑和项目目录上下文。
- PowerShell/脚本执行。
- MCP 服务器接入，使 Claude CLI 能发现并调用本机能力。
- 插件/skills/agents 的离线种子目录。
- 浏览器和 Office 的本地打开/交接。
- 桌面截图与简单键盘输入。
- 可打包为 Windows 离线 zip。

## 不直接复刻的内容

- Anthropic 私有 CLI 源码、系统提示词、内部模型/遥测/权限分类器实现。
- Anthropic 官方 Claude CLI 可执行文件和任何需要授权分发的官方插件。
- 依赖公网的 OAuth、官方 marketplace 拉取、WebSearch/WebFetch 在线能力。

## 本工具的替代设计

本工具提供一个独立 Windows Workbench：

- `serve`：启动本地 Web UI。
- `mcp`：作为 stdio MCP server 暴露 Windows 工具。
- `install`：生成 MCP 配置并尝试注册到内网 Claude CLI。
- `doctor`：输出部署诊断。

Claude 的推理仍由用户内网已有的 `claude` CLI 负责；Workbench 负责 UI、附件管理、本机工具和离线资源组织。
