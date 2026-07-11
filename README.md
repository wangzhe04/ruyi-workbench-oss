# 如意 Ruyi · 本地 AI 全能工作台

<img src="docs/branding/ruyi-mark.svg" alt="如意 Ruyi" width="72" align="right" />

> **Ruyi — an offline-first, Windows-native, all-in-one AI workbench that non‑programmers can use safely.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Third-Party Notices](https://img.shields.io/badge/third--party-notices-informational.svg)](./THIRD-PARTY-NOTICES.md)

一台 Windows 机器 + 任意一个可用的模型端点(内网 Claude CLI 或任意 OpenAI 兼容 API)= 一个具备
工程级能力 + 桌面/Office 操控能力、非程序员可安全使用、**有网没网都能正常运行**的本地 AI 工作台。

> 原名 **Win Claude Workbench**,自 v0.8 起更名为**如意 Ruyi**——去 "Claude" 化是开源发布的法务考量
> (项目名含 "Claude" 的商标风险,以及旧提示词曾致 provider 模型自称「我是 Claude」的身份错认)。
> 「如意」取「称心如意、如你所愿」之意,图标为青花如意云纹。

## 为什么用它(五大差异化)

1. **操控级撤销/回溯** —— 文件检查点 + 对话回溯**成对交付**,可撤销性直接体现在权限弹窗时刻。
   多数 computer-use 产品的 OS 级撤销基本缺席,这是最强的安全差异化点。
2. **纯文本模型也能操控桌面** —— OCR + UIA 文本 grounding,不依赖 vision 模型;
   气隙内网往往只有文本模型,这直接决定可用性下限(视觉是增强,不是前提)。
3. **气隙一等 + 零依赖可审计** —— 单文件 `server.js`、**零 npm 运行时依赖**(仅用 Node 内建模块) =
   政企内网安全过审成本最低。
4. **中文第一 + 非程序员主画像** —— 会写代码的进阶用户与不写代码的知识工作者共用一套壳。
5. **双引擎不锁定** —— 内网 Claude CLI 或任意 OpenAI 兼容端点(含国产模型全家:DeepSeek / 通义千问 / 智谱 / 内网 vLLM·Ollama)。

## 核心能力一览(v1.6)

| 能力 | 说明 |
|------|------|
| 双引擎对话 | Claude CLI 与 OpenAI 兼容端点随时切换,跨引擎上下文续接。 |
| 桌面 / Office 操控 | 截图 / OCR / UIA / 键鼠 / 窗口 / Office / PDF(桌面控制 MCP,ACC v1.8.1)。 |
| 多 Agent 编排 | DAG 工作流、质量门、资源租约防死锁、Git worktree 隔离、实时监控。 |
| 共享任务池 | 运行中的子代理可**提案追加节点**,经审批物化进 DAG——运行时嵌套委派的可观测替代。 |
| Agent 邮箱 | 工作流节点间单向异步消息,与用户插话分池,诚实投递语义。 |
| 定向插话 | 运行中对**指定节点**中途插话,下一次调用前生效。 |
| 跨会话工作台记忆 | 起草-确认入库、按项目分组、围栏渐进注入(与仓库 `CLAUDE.md` 项目记忆分工)。 |
| Skills 体系 | 四源技能注册表(内置 / 用户 / 项目 / Playbook),会话级启用 + 跨引擎渐进注入。 |
| 成本 / 用量看板 | 诚实计费:区分 Anthropic 官方 / 第三方 Coding Plan / OpenAI provider,分币种记账,子代理与压缩调用全入账,月度预算告警。 |
| 检查点 / 回溯 | 文件级检查点 + 对话回溯成对交付,可撤销性体现在权限弹窗。 |
| 分级 UI | 简单 / 专业双模式,青花瓷视觉系统。 |

> 每项功能均经「实现 → 多视角对抗验证 → 修复 → 独立回归」闭环交付,附 100+ 离线 e2e。迭代记录见 [优化路线图](docs/OPTIMIZATION-ROADMAP.md)。

## 目录结构

```
.
├── ruyi-workbench/               如意工作台(Node 后端 + 原生 JS 三栏 UI + 自身 MCP server)
│   ├── app/server.js             主服务(零 npm 运行时依赖);双引擎 + 原生工具循环 + MCP stdio 桥
│   ├── app/public/               index.html / app.js / styles.css(原生 JS,无框架无构建)
│   ├── docs/                     架构/手册(manuals/USER-GUIDE、ADMIN-GUIDE)
│   └── README.md                 工作台使用与打包说明
├── mcp/
│   ├── ai-computer-control/      内置桌面控制 MCP(99 工具:截图/OCR/UIA/键鼠/窗口/Office/PDF)
│   └── README.md                 drop-in 连接器(文件夹即插即用)说明
├── dev-harness/                  验证脚手架(100+ 离线 e2e,Node 直跑)
├── docs/branding/                品牌图标(青花如意云纹 SVG)
├── LICENSE                       Apache-2.0(含 ai-computer-control)
├── THIRD-PARTY-NOTICES.md        第三方组件与许可清单
├── CONTRIBUTING.md               贡献指南(含五条硬约束)
├── SECURITY.md                   安全策略与威胁模型
└── README.md                     本文件(开源门面)
```

## 快速开始

**前置**:Windows 10/11 + [Node.js](https://nodejs.org/) **≥ 20**(见 `ruyi-workbench/package.json` 的 `engines`)。零 npm 运行时依赖,`node app/server.js` 即可直接跑,无需 `npm install`。

```powershell
cd ruyi-workbench
node .\app\server.js serve --open
```

首次启动会引导你配置 provider。推荐 **DeepSeek**(便宜、国内直连);填入 base URL + 密钥即可切换模型。
内网 **Claude CLI** 引擎可选:在设置里指向本机已装的 Claude CLI 路径即可与 provider 引擎并存。

数据目录默认 `~/.win-claude-workbench`;可用环境变量 `RUYI_HOME` 覆盖(旧变量 `WIN_CLAUDE_WORKBENCH_HOME` 仍兼容)。

## 桌面控制(可选)

`mcp/ai-computer-control/` 是随发行包捆绑的**内置桌面控制 MCP**(99 工具,ACC v1.8.1,需 **Python 3.13**)。装好后工作台会**自动探测**并把它的工具供给两个引擎。

安装二选一:

```powershell
# 方式一:离线安装器
python mcp\ai-computer-control\installer\install.py

# 方式二:pip 装离线依赖清单
pip install -r mcp\ai-computer-control\requirements_offline.txt
```

> 离线 wheels 体积较大(含 opencv / matplotlib 等),**不进 git**,从 GitHub Release 附件下载;或直接联网 `pip install`。
> 大多数可选依赖缺失时相关工具会**优雅降级**(如无 `winsdk` 则 OCR 工具停用,其余照常)。

## 测试

全部 e2e 离线可跑,Node 直跑,无需装包:

```powershell
node dev-harness\plan-mode.e2e.js       # 单件
node dev-harness\repo-hygiene.e2e.js    # 合规回归
```

每件文件头部注释都写明了它断言的边界;末行 `... E2E: ALL PASS` 为通过判据。串行跑(端口固定,并行会撞)。

**需自备条件的实弹件**(不在离线回归清单里,条件不满足时不要跑或按各文件头说明提供参数):

| e2e | 需要 |
|---|---|
| `deepseek-live` / `deepseek-tools` | 真实 DeepSeek API 密钥(命令行参数传入,如 `node dev-harness\deepseek-live.e2e.js <你的KEY>`) |
| `desktop-bridge-live` | 已安装 ACC 依赖的真实 Python 环境 |
| `desktop-mcp-smoke` | 已安装 ACC 的 Python 环境(缺依赖时相关断言报 SKIP) |

## 安全与隐私

- 服务仅监听 `127.0.0.1` + 页面 token,不对外暴露。
- 所有写操作进检查点日志,可逐条回滚。
- 联网工具(`web_fetch` / `http_download`)带 SSRF 防御(拒绝私网/回环);详见 [`SECURITY.md`](./SECURITY.md)。

## 品牌与兼容标识

为不破坏存量接入,以下**存量兼容标识有意保持不变**:MCP server id `win-claude-workbench`、默认数据目录 `~/.win-claude-workbench`、环境变量 `WIN_CLAUDE_WORKBENCH_HOME`(`RUYI_HOME` 优先,旧变量继续识别)。

## Clean-room 声明

本项目为 **clean-room 独立实现**:**不含** Anthropic 泄露源码、**不分发**官方 Claude CLI(用户在内网机器上自备并注册)、**不复制**第三方插件源码。随包前端静态库(marked / highlight.js 及主题)的许可义务见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

## 许可

[Apache-2.0](./LICENSE)(含 `ai-computer-control`)· 第三方组件见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) · Copyright 2026 Ruyi Workbench contributors。

---

## English

**Ruyi (如意)** is an offline-first, Windows-native, all-in-one AI workbench you can drive from any model endpoint — an on-prem Claude CLI *or* any OpenAI-compatible API. One Windows machine plus one reachable model = a local workbench with real engineering and desktop/Office automation capabilities, safe for non-programmers, that **works with or without an internet connection**.

> Formerly **Win Claude Workbench**, renamed to **Ruyi** at v0.8. Dropping "Claude" from the name was a legal precaution for open-sourcing (trademark risk from a "Claude"-bearing project name, and an old system prompt that made provider models misidentify as "I am Claude"). *Ruyi* means "as you wish"; the mark is a blue-and-white *ruyi* cloud motif.

### Why Ruyi (five differentiators)

1. **Operation-grade undo/rewind** — file checkpoints and conversation rewind ship as a pair; reversibility surfaces at the permission-prompt moment. OS-level undo is largely absent from most computer-use products — this is the strongest safety differentiator.
2. **Text-only models can still drive the desktop** — OCR + UIA text grounding, no vision model required. Air-gapped networks often have text-only models, so this sets the usability floor (vision is an enhancement, not a prerequisite).
3. **Air-gap first, auditable, zero runtime deps** — a single `server.js` with **zero npm runtime dependencies** (Node built-ins only) minimizes the cost of passing enterprise/government security review.
4. **Chinese-first, non-programmer primary persona** — advanced coders and non-coding knowledge workers share one shell.
5. **Dual engine, no lock-in** — on-prem Claude CLI or any OpenAI-compatible endpoint (DeepSeek / Qwen / GLM / on-prem vLLM·Ollama).

### Capabilities (v1.6)

Dual-engine chat · desktop/Office control (screenshot / OCR / UIA / keyboard-mouse / window / Office / PDF, ACC v1.8.1) · multi-agent orchestration (DAG, quality gates, resource-lease deadlock prevention, worktree isolation) · **shared task pool** (sub-agents propose nodes, approved into the DAG — an observable replacement for runtime nesting) · **agent mailbox** (one-way async messages between nodes) · **directed steer** (interject into a specific running node) · **cross-session workbench memory** (draft-then-confirm, per-project, fenced progressive injection) · **Skills registry** (four sources, session-level enablement, cross-engine progressive injection) · **cost/usage dashboard** (honest per-currency accounting across Anthropic-direct / third-party Coding Plans / OpenAI providers) · checkpoints & rewind · tiered UI. Each feature ships through an implement → adversarial multi-agent review → fix → regression loop with 100+ offline e2e.

### Quick start

**Prerequisites:** Windows 10/11 + [Node.js](https://nodejs.org/) **≥ 20** (see `engines` in `ruyi-workbench/package.json`). Zero npm runtime deps — no `npm install` needed.

```powershell
cd ruyi-workbench
node .\app\server.js serve --open
```

First launch walks you through configuring a provider (DeepSeek recommended — cheap, well-connected in China). The on-prem Claude CLI engine is optional and coexists with providers.

### Desktop control (optional)

`mcp/ai-computer-control/` is a bundled **desktop-control MCP** (99 tools, ACC v1.8.1, requires **Python 3.13**). Install via the offline installer (`installer/install.py`) or `pip install -r requirements_offline.txt`; the workbench auto-detects it once installed. Offline wheels are large and are **not** in git — download them from the GitHub Release assets, or `pip install` online. Most optional dependencies degrade gracefully when absent.

### Tests

All e2e run offline via `node dev-harness\<name>.e2e.js` (no packages to install). Run them **serially** — ports are fixed. Live tests (`deepseek-live`, `deepseek-tools`, `desktop-bridge-live`, `desktop-mcp-smoke`, …) require your own key / desktop / Python and are skipped by default.

### Security

Binds `127.0.0.1` + a page token only; every write goes through a rollback-able checkpoint journal; networked tools carry SSRF defenses (private/loopback ranges rejected). See [`SECURITY.md`](./SECURITY.md).

### License

[Apache-2.0](./LICENSE) (includes `ai-computer-control`). Third-party components are listed in [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md). Copyright 2026 Ruyi Workbench contributors.
