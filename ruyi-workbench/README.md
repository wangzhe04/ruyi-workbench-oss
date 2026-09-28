# 如意 Ruyi —— 工作台本体

这个目录是如意工作台的应用本体：Node 后端、原生 JS 前端、桌面壳、内置资源与打包工具。
**项目介绍、界面截图、能力一览与快速上手见仓库根目录的 [README](../README.md)。**

## 目录

| 路径 | 内容 |
|---|---|
| `app/src/` | 后端源码：63 个有序模块，顺序记在 `app/src/manifest.json` |
| `app/server.js` | 后端运行产物：`node app/build.js` 把 `app/src/` 拼接成这一个文件，**零 npm 运行时依赖**；改代码只改 `app/src/`，再重建 |
| `app/public/` | 前端：`index.html`、`app.js` 组合根、`js/` 下的原生 ES 模块、分层 CSS、`locales/` 中英语言包；无框架、无构建 |
| `desktop/` | WinForms + WebView2 桌面壳 `RuyiDesktop.exe` 的源码与构建脚本 |
| `resources/` | 内置 Playbook、Claude Code 离线插件市场 `plugins/win-workbench-offline`（`offline-toolkit` 技能集）、安装与启动脚本 |
| `config/` | 配置示例与出厂默认值 |
| `docs/` | 用户手册、管理员手册、架构、离线部署、源码审阅、技能目录 |
| `tools/` | 离线打包 `package-offline.ps1`、overlay 增量升级、开发脚手架 |
| `Start-Workbench.cmd` | 发布包里的双击启动器（有桌面壳时以独立窗口打开） |

## 运行

```powershell
node .\app\server.js serve --open     # 只监听 127.0.0.1，默认端口 8765，被占自动顺延
node .\app\server.js doctor           # 体检：引擎、依赖、端口、数据目录
node .\app\server.js mcp-config       # 输出工作台 MCP 配置
node .\app\server.js install          # 把工作台 MCP 注册进本机 Claude Code
node .\app\server.js mcp              # 以 stdio MCP server 方式运行
```

需要 Windows 10/11 与 Node.js ≥ 20，不需要 `npm install`（`package.json` 里的 devDependencies 只给打包单体 exe 用）。
数据目录默认 `~/.win-claude-workbench`，可用 `RUYI_HOME` 覆盖。

## 打包

```powershell
npm run package:offline          # Full：含桌面控制 ACC、CPython 3.12 与 OCR（从已校验缓存生成）
npm run package:offline:full:fresh   # 同上，但联网重建 ACC 运行时
npm run package:offline:slim     # Slim：不含桌面控制
npm run build:desktop            # 构建 RuyiDesktop.exe 桌面壳
```

名字里带 Full 的包必须同时满足：CPython 3.12、`winsdk` 的 cp312 wheel、嵌入式运行时能实际导入 OCR 投影、全部文件进入
`offline-manifest.json` 的 SHA-256 清单；任何一条不满足，打包脚本拒绝生成。增量 overlay 升级见 [`tools/APPLY-OVERLAY.md`](tools/APPLY-OVERLAY.md)。

## 文档

- 用户手册：[中文](docs/manuals/USER-GUIDE_CN.md) · [English](docs/manuals/USER-GUIDE_EN.md)
- 管理员手册（部署、引擎、安全边界、计费、回归）：[中文](docs/manuals/ADMIN-GUIDE_CN.md) · [English](docs/manuals/ADMIN-GUIDE_EN.md)
- 架构说明：[中文](docs/ARCHITECTURE_CN.md) · [English](docs/ARCHITECTURE_EN.md)
- 离线部署：[中文](docs/OFFLINE_DEPLOYMENT_CN.md) · [English](docs/OFFLINE_DEPLOYMENT_EN.md)
- 源码审阅（clean-room 依据）：[中文](docs/SOURCE_REVIEW_CN.md) · [English](docs/SOURCE_REVIEW_EN.md)
- 技能与一键任务目录：[中文](docs/SKILLS-CATALOG_CN.md)
- 工作流模型规范：[中文](docs/MODEL-WORKFLOW-SPEC_CN.md) · [English](docs/MODEL-WORKFLOW-SPEC_EN.md)

## 品牌与兼容标识

本项目原名 **Win Claude Workbench**，v0.8 起更名 **如意 Ruyi**，目录与可执行文件已改名（`ruyi-workbench/`、`Ruyi.exe`，启动脚本仍识别旧的 `WinClaudeWorkbench.exe`）。
为不破坏已有接入，MCP server id `win-claude-workbench`、默认数据目录 `~/.win-claude-workbench`、环境变量 `WIN_CLAUDE_WORKBENCH_HOME`（`RUYI_HOME` 优先）有意保持不变。

本项目是 clean-room 独立实现：不含 Anthropic 泄露源码，不分发官方 Claude Code，不复制第三方插件源码；随包前端静态库的许可见 [`../THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)，本体按 [Apache-2.0](../LICENSE) 发布。
