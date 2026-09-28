# 如意 Ruyi · 本地 AI 工作台

<img src="docs/branding/ruyi-mark.svg" alt="如意 Ruyi" width="72" align="right" />

> **把「和模型聊天」变成「让模型替你把事办完」——在你自己的 Windows 电脑上，离线也能用，每一步都能看见、都能反悔。**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Windows e2e](https://github.com/wangzhe04/ruyi-workbench-oss/actions/workflows/e2e.yml/badge.svg?branch=master)](https://github.com/wangzhe04/ruyi-workbench-oss/actions/workflows/e2e.yml)
[![Offline e2e](https://img.shields.io/badge/%E7%A6%BB%E7%BA%BF%20e2e-417-success.svg)](./dev-harness)
[![Zero npm deps](https://img.shields.io/badge/npm%20%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-orange.svg)](./ruyi-workbench/app/server.js)
[![Third-Party Notices](https://img.shields.io/badge/third--party-notices-informational.svg)](./THIRD-PARTY-NOTICES.md)

**如意（Ruyi）** 是一个 clean-room 实现的 Windows 本地 AI 工作台。给它一个能用的模型：任意 OpenAI 兼容端点（云端 API、内网 vLLM、本机 Ollama / LM Studio 都行），或者本机装好的 Claude Code / Kimi Code 命令行。它就能在你的电脑上**真正动手**：读写文件、跑脚本、操作 Office 和桌面、派一队子代理去调研；还有一位「管家」替你盯着所有在办的事。

> **当前版本：3.0 预览版 `v3.0.0-preview.2`**（2026-09-25，GitHub pre-release）。功能已冻结，自动化全量回归与离线包冒烟已过。安全红队终审、真读屏与人因走查这几项人工终验留到正式 3.0 前（见 [55 号文](docs/optimization-plan/55-release-3.0-preview.md)）。上一个正式 Release 是 `v2.6.2`；2.7.0 / 2.8.0 的变化随本预览版一起发布，全部变更见 [CHANGELOG](CHANGELOG.md)。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/hero-dark.png" />
  <img src="docs/screenshots/hero-light.png" alt="如意工作台视角：一句话让 AI 读 CSV、写报告，回答带结论表，右栏列出可撤销的文件改动" />
</picture>

<sub>▲ 工作台视角：一句话让 AI 读工作文件夹里的 `sales.csv`、把报告写成 `report.md`。回答里是结论表，写文件那一步经你允许才执行，右栏「改动」页可以逐条或整轮撤销。</sub>

**快速跳转**：[三步上手](#三步上手) · [两个视角](#两个视角管家与工作台) · [动手也能反悔](#让-ai-动手也能反悔) · [核心能力](#核心能力一览当前-master) · [部署](#部署离线包内网与源码运行) · [开发与测试](#开发与测试) · [English](#english)

---

## 三步上手

**不写代码也能用，全程不需要打开命令行。** 拿到发布包（Full 或 Slim 版的 `Ruyi-<版本>-*.zip`）之后：

1. **先完整解压**，不要在压缩包预览里直接运行。建议解压到 `C:\Ruyi` 这类短路径。
2. **双击 `Start-Workbench.cmd`**。包里自带 Node 运行时，不用装任何东西；有桌面壳时它会以独立窗口打开，没有就开浏览器。
3. **跟着欢迎向导走**：选语言 → 接一个模型（本机 Ollama / LM Studio 免密钥，或填一个 API 地址和密钥） → 选工作文件夹 → 选安全档。大约五分钟，每一步都有人话说明和当场校验。

之后遇到任何问题，都在应用里找：左下角「帮助」里有使用手册、体检和重新走引导，不用去翻日志文件。

---

## 如意是什么

市面上的 AI 工具大多是这三类之一：云端聊天应用（只能说）、编程 CLI Agent（给程序员用）、云端自动化 Agent（活在别人的服务器上）。如意占的是它们都没占的位置：**在本机、真动手、可撤销、不写代码的人也能放心用**。

| | |
|---|---|
| **单文件、零依赖** | 后端运行产物是一个 `app/server.js`（约 6.3 万行，由 `app/src/` 的 63 个有序模块拼接，字节级可复现），**零 npm 运行时依赖**，只用 Node 内建模块；前端是 60 个原生 ES 模块，无框架、无构建。内网安全审查要看的面最小。 |
| **107 个原生工具 · 108 个 ACC 工具** | 线程里可用的文件、终端、搜索、Git、联网、Office 交接、子代理编排等 65 个，加上管家专用的 42 个；可选的桌面控制组件 ACC 再提供截图 / OCR / UIA / 键鼠 / 窗口 / 浏览器 / Office / PDF 等 108 个工具。 |
| **8 套模板 · 10 种角色 · 417 项 e2e** | 内置 8 套多 Agent 工作流与 10 种节点角色；仓库里有 417 项 e2e（默认回归 410 项，另有 7 项需要真实 API / 桌面环境的 live probe 按需启用），另含 100 组 unit suite 与 17 组 ACC smoke，Windows CI 每次提交都跑。 |

> 原名 **Win Claude Workbench**，自 v0.8 起更名**如意 Ruyi**：项目名去掉 "Claude" 一是规避商标风险，二是旧提示词曾让 provider 模型自称「我是 Claude」。「如意」取「称心如意、如你所愿」之意，图标为青花如意云纹。

---

## 两个视角：管家与工作台

同一台工作台，顶栏一枚分段钮在两个视角间切换，左栏的线程列表两边共用。新装默认落在管家视角。

![管家视角：左栏按「等你 / 今天收工」分组的线程，中间是和管家的对话，右栏是选中线程的待决与操作](docs/screenshots/steward-home.png)

<sub>▲ 管家视角：左栏的线程按「等你」「今天收工」分组；问管家「这几件事怎么样了」，它按线程回你；右栏就是那条等你放行的线程，允许 / 拒绝可以当场按。</sub>

- **管家**：你说一件事，它开一条线程去办（或者交给已有的线程），办完回来告诉你。它看得见所有线程的状态（交办中 / 进行中 / 需要你 / 已收工 / 已停工），只在该出声的时候出声。它能自己搜网页、读你登记过的工作区文件，但**一个回合里只要读过外部内容，它这一回合的所有写动作都降级成「提议」**，由你按按钮。它会记住关于你的偏好（每条都能改、能否决、能导出），也能替你建定时任务。
- **工作台**：经典三栏。左边线程，中间对话，右边是「文件 / 产物 / 改动 / 记忆 / Agent 工作流 / 用量 / 记录」七个页签。线程头上能直接换权限、模型和引擎，只影响这一条线程。

---

## 让 AI 动手，也能反悔

「让 AI 动手」的前提是「动错了能收回来」：

![权限请求弹窗：模型想把一个安装包挪进新文件夹，弹窗写明「此操作可一键撤销」，可以拒绝、允许或稍后处理](docs/screenshots/permission-approval.png)

- **五档安全模式**：每步都问（默认）/ 小改动自动做 / 先计划再动手 / 智能自动 / 全自动。工具分只读、修改、执行三级；执行级操作**永远不能被持久放行**，切到「智能自动」或「全自动」都要再确认一次。管家开的线程默认档位可以单独设，单条线程只能在它上面收紧、不能放宽。
- **文件检查点**：写、改、删、移动、复制、解压、下载之前，先把「改前状态」存进检查点日志。改动可以单条撤销，也可以整轮回滚；代码任务还会在回合开始时建一个工作区基线，把绕过文件工具的改动也捉住。
- **对话回溯**：把线程拨回任意一轮，可以同时回滚那之后的文件改动。对话和文件一起回去，而不是只删聊天记录。
- **审计与回执**：每个回合、每次工具调用、每次权限决定都记进 NDJSON 审计日志（密钥脱敏后才下发）。「已安排 / 已发送」这类完成时的话只由处理器回执驱动，拿不到回执就如实说「发起了，没拿到回执」。
- **自主性授权书**：需要连续执行时，可以签一张比当前权限更窄的临时授权（路径、命令前缀、联网、次数、有效期都能限定），随时撤销。
- **本机加固**：服务只监听 `127.0.0.1`，页面凭据走握手；Host 白名单防 DNS rebinding；联网工具拒绝私网与回环地址（SSRF）；数据目录里的密钥、会话、审计对文件工具双向拒绝；零遥测。威胁模型见 [SECURITY.md](./SECURITY.md)。

---

## 核心能力一览（当前 master）

| 能力 | 说明 |
|---|---|
| **引擎：任意模型端点** | OpenAI 兼容端点直连 HTTP + SSE，自带原生工具循环，可选 Chat Completions 或 Responses API 协议；不内置厂商预设，填地址和密钥即可，本机 Ollama / LM Studio 免密钥。Agent CLI 可选 **Claude Code** 或 **Kimi Code**（官方 ACP 协议），两者都拿到一段「如意运行环境说明」。同一线程里换引擎，上下文自动续接。 |
| **原生工具环** | 107 个原生工具，按只读 / 修改 / 执行三级审批；工具说明按任务按需装载，缺什么由 AI 搜索后增量装载，简单问题不再背着整套工具。互不依赖的调用在一次响应里合批，有依赖的分阶段等待。 |
| **结构化提问** | 信息不够时 AI 弹问题卡，不猜。支持单选、多选、自由输入和「选项＋其他」；回答确认送达模型后卡片才关闭，两种引擎共用同一条通道。 |
| **管家** | 线程五态、焦点与「等你处理」队列、安静卡、事项内自动交接、人设与口吻可配；能改的设置 124 项（31 项直接生效，93 项递一枚按钮由你确认），密钥与安全边界类的 39 项永远不经管家。 |
| **定时任务** | 只这一次 / 每天 / 每周 / 每月 / cron；到点「只提醒我」（不动模型、不花钱）或「让如意跑一个回合」，可单独指定模型档位与权限。休眠错过的触发按约定补跑或如实标「跳过了」，崩在半路的记「结果未知，先核对」。 |
| **多 Agent 编排** | DAG 工作流：8 套模板、10 种角色、5 种质量门（review / verify / vote / cross_review / dedupe）、条件与循环、失败策略、资源租约、Git worktree 隔离；图形编辑器与实时监控画布。子代理只把精简的交付结果带回主会话，可在后台运行。 |
| **团队模式** | 运行中的子代理可提案追加节点（你审批后物化进 DAG）；节点间有邮箱；你可以对指定节点定向插话。 |
| **长任务** | 任务账本带验收证据的里程碑与 until-done 驱动；零 token 等待（等时间 / 文件 / 进程 / URL）；崩溃恢复按副作用分级，不可逆步骤一律停下等确认。 |
| **桌面与 Office（可选）** | 随包的桌面控制 MCP「ACC」v1.9.1：108 个工具，OCR + UIA 文字定位，**纯文本模型也能操作桌面**；Word / Excel / PPT / PDF 读写，三套内置版式。 |
| **语音输入** | 边说边出字，句尾自动改错（本地重听或大模型改字）。本地识别由可选的 [ruyi-toolbox](https://github.com/wangzhe04/ruyi-toolbox) 组件提供（`asr-stream` 流式、`asr-shim` 整句），装好即被自动发现并接入；也可以用云端语音模型。 |
| **技能 / 记忆 / Playbook** | 四源技能库（20 个内置技能 + 用户 / 项目 / Playbook），两种引擎共用；跨线程的工作台记忆「起草 → 确认」才入库；跑顺的任务一键存成 Playbook（内置 16 个）。 |
| **迁移中心** | 启动时导入 Claude Code 的 `CLAUDE.md`、Codex 与 Kimi 的 `AGENTS.md` 为核心记忆，并跟随原文件更新；自动导入三家的 MCP 与插件技能；认出老版本如意的安装并一键迁移（改前备份、可撤销）。 |
| **联网检索** | 内置零配置搜索，另可接 SearXNG / Bing / Brave / Tavily / 博查 / 自定义；`web_fetch` 带 SSRF 防护与离线缓存。断网时退化为只用本地材料。 |
| **用量与成本** | 分币种逐笔记账，不强行换算汇率；没填单价只显示 token，并标明「等价估算，非实际扣费」；子代理、压缩、Playbook 起草全部入账；月度软预算告警。 |
| **界面与语言** | 简体中文 / English / 跟随系统；深色 / 浅色 / 跟随系统；专家与精简两种模式；Mermaid 图在回复里直接渲染（可全屏）；`Ctrl+K` 命令面板。 |

---

## 一些细节

<table>
<tr>
<td width="50%"><img src="docs/screenshots/workflow-editor.png" alt="工作流图形编辑器：深度研究模板的节点图，右侧检查器正在编辑 verify 节点" /></td>
<td width="50%"><img src="docs/screenshots/scheduled-tasks.png" alt="设置里的定时任务：两条任务，一条每个工作日 9 点跑一个回合，一条一次性提醒" /></td>
</tr>
<tr>
<td><b>工作流图形编辑器</b>：载入「深度研究 → 核验 → 综述」模板，拖节点、连箭头；右侧检查器给每个节点指定任务、角色、引擎、模型、质量门。</td>
<td><b>定时任务</b>：每条任务都能暂停、立即运行（会先确认，它真的会起一个回合）、查看最近几次、删除。</td>
</tr>
<tr>
<td><img src="docs/screenshots/settings-models.png" alt="设置里的模型分配：对话主模型、管家模型、强 / 快两档、子代理与上下文压缩各用哪个模型" /></td>
<td valign="top"><b>模型分配</b>：谁用哪个模型一张表管完：对话主模型、新线程默认引擎、管家、强 / 快两档、子代理、上下文压缩、语音改错。选中即保存；「跟随」表示这一行不单独指定。<br/><br/>本页截图取自本地演示实例：模型端点是本地脚本化的演示服务（回答内容为预置），界面、工具卡、权限、检查点、定时任务与用量记账都是真实功能。</td>
</tr>
</table>

### 多 Agent 编排

在对话里说「深度调研一下××」「审计一下这个代码库」，模型会自己发起编排，并按节点难度指派模型：检索和批量节点用快模型，核验和综合用强模型。输入框的「Agent 团队」开关则强制这一轮用多 Agent。

| 内置模板 | 形状 |
|---|---|
| 深度研究 → 核验 → 综述 | 拆解 → 事实 / 背景双镜头并行检索 → 对抗核验 → 带引用综述 |
| 代码审计 | 建库地图 → 正确性 / 安全 / 质量三维并行 → 核验 → 修复排期 |
| 编码实现 → 独立审查 → 定向修复 → 验收 | 审查不过才进修复，最后独立验收 |
| Bug 定位 | 复现 → 双假设并行 → 验证 → 根因修复 |
| 需求 → 多方案 → 选型 → 落地清单 | 三种取向并行出方案 → 加权横评 → 可执行清单 |
| 文档生成 | 提纲 → 分节并行撰写 → 事实核查 → 统稿 |
| 数据洞察 | 探查 → 方案 → 多角度分析 → 核验 → 洞察 |
| 正反辩论 → 裁决 | 正反并行 → 交叉审查裁决 |

节点角色：Explorer · Planner · Researcher · Analyst · Worker · Coder · Reviewer · Verifier · Critic · Synthesizer。

### Kimi Code 的兼容边界

Kimi Code 经官方 ACP（JSON-RPC / NDJSON）驱动：原生工具事件、如意的权限审批、原生计划快照和结构化提问都桥接进如意的界面，上下文用量与原生压缩读 Kimi 自己的权威状态。当前 ACP 在一次 prompt 结束后会关掉子进程，所以跨回合的 Goal / Cron / 后台任务连续性**不宣称完整兼容**。对 npm 安装的 Kimi Code 0.37.2 有一个精确匹配时才启用的兼容补丁，不改写你的安装。细节见[管理员手册](ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md)。

---

## 与同类软件的对比

| 维度 | 云端对话应用 | 编程 CLI Agent | 云端自动化 Agent | **如意** |
|---|---|---|---|---|
| 运行位置 | 厂商服务器 | 本机终端 | 厂商沙箱 | **本机，数据不出门** |
| 无外网 / 内网部署 | ✗ | 部分（模型仍需在线） | ✗ | **✓ 端点可以指向内网模型** |
| 操作本机桌面和 Office | 基本没有 | 弱 | 在云端虚拟机里 | **✓ 纯文本模型也能用（OCR + UIA 文字定位）** |
| 做错了能撤销吗 | 无此概念 | 靠 git | 很难 | **✓ 文件检查点 + 对话回溯，弹窗上就写着「可撤销」** |
| 多 Agent 协作 | 黑箱 | 多为命令行输出 | 黑箱 | **✓ 图形编辑器 + 实时监控** |
| 有人替你盯着 | ✗ | ✗ | 部分 | **✓ 管家：状态、待决、定时任务一处看** |
| 成本透明 | 订阅价 | 部分 | 订阅价 | **✓ 分币种逐笔记账，不虚报** |
| 部署与审计成本 | — | 需 Node / Python 生态 | — | **单文件零依赖，离线 ZIP 解压即用** |

<details>
<summary><b>Harness-Bench-360 横评快照（2026-08-09，Escapade 2.5 时期）</b></summary>

我们在开源 [HarnessBench](https://github.com/Qihoo360/harness-bench) 的方法上做了扩展（HB360），用同一个 `deepseek-v4-flash` 模型、106 个真实文件系统任务，横评了 4 个 harness：

| Harness | Outcome | Process | Security | Efficiency | O×P×S | O×P×S×E | 估算成本 | 平均耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Ruyi** | 77.2 | 98.1 | 100.0 | **65.1** | 75.7 | **49.6** | **$0.60** | 97s |
| Hermes Agent | **80.6** | **98.8** | 100.0 | 51.3 | **79.6** | 41.9 | $0.92 | 159s |
| Codex (WSL2) | 76.9 | 78.2 | 100.0 | 63.6 | 60.1 | 36.6 | $1.58 | **90s** |
| OpenClaw | 63.2 | 74.4 | 100.0 | 50.1 | 47.0 | 23.0 | $1.18 | 156s |

上游原生的 O×P×S 由 Hermes 领先；加入工程效率后如意排第一，估算成本最低。这是单机、单模型、单次的测试快照，不是官方排行榜；成本是按统一基准价归一化的估算，不是账单。原始逐任务结果在独立的 benchmark 工程里，未随本仓库发布。
</details>

---

## 部署：离线包、内网与源码运行

**离线包（推荐）**：在一台能联网的 Windows 机器上打包，拷进内网解压即用。

```powershell
cd ruyi-workbench
npm run package:offline          # Full：含 ACC、CPython 3.12 与 OCR 组件（默认，从已校验缓存生成）
npm run package:offline:slim     # Slim：不含桌面控制
```

产物在 `dist\` 下，内含 Node 运行器与 `Start-Workbench.cmd`；有 `RuyiDesktop.exe`（WinForms + WebView2 桌面壳）时以独立窗口启动。Full 包在首次启动时校验并注册 ACC，目标机不需要装 Python、也不联网。还支持增量 overlay 升级包与单体 `Ruyi.exe`。完整说明见[离线部署](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_CN.md)与[管理员手册](ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md)。

> Full 包含 Chromium 与 WinSDK 的深层目录，务必**完整解压到短路径**（如 `C:\Ruyi`）；如果解压器提示路径过长，不要选「跳过」，否则 ACC 的完整性校验会拒绝桌面控制组件（基础工作台仍会启动并给出恢复提示）。

**从源码运行**（开发者）：Windows 10/11 + Node.js ≥ 20，不需要 `npm install`。

```powershell
git clone https://github.com/wangzhe04/ruyi-workbench-oss.git
cd ruyi-workbench-oss\ruyi-workbench
node .\app\server.js serve --open        # 只监听 127.0.0.1，默认端口 8765，被占自动顺延
```

| 命令 | 作用 |
|---|---|
| `node .\app\server.js doctor` | 体检：引擎、依赖、端口、数据目录（界面里「设置 · 系统 · 体检」是同一份） |
| `node .\app\server.js mcp-config` | 输出可粘进 `.mcp.json` 的工作台 MCP 配置 |
| `node .\app\server.js install` | 把工作台 MCP 注册进本机 Claude Code |
| `node .\app\server.js mcp` | 以 stdio MCP server 方式运行 |

数据目录默认 `~/.win-claude-workbench`，可用环境变量 `RUYI_HOME` 覆盖。

**扩展**：任意 stdio MCP 做成文件夹放进 `mcp/`，写一个 `ruyi-mcp.json`，重启即自动注册、删文件夹即卸载，工具同样走分级审批（见 [mcp/README.md](mcp/README.md)）。ruyi-toolbox 的组件装好后会被自动发现，在设置的「集成与 MCP」里能看到接了什么、逐个停用。

---

## 目录结构

```
.
├── ruyi-workbench/
│   ├── app/src/            后端源码：63 个有序模块（改这里，再跑 build.js）
│   ├── app/server.js       后端运行产物（由 app/build.js 拼接，零 npm 运行时依赖）
│   ├── app/public/         前端：index.html + 60 个原生 ES 模块 + 分层 CSS + 中英语言包
│   ├── desktop/            WinForms + WebView2 桌面壳
│   ├── resources/          内置 Playbook、离线插件与脚本
│   ├── docs/               用户手册、管理员手册、架构、离线部署
│   └── tools/              离线打包、overlay 升级
├── mcp/ai-computer-control/  桌面控制 MCP（ACC，Python，108 个工具）
├── dev-harness/            离线 e2e、unit、静态锁与假件（Node 直跑）
├── docs/                   工程规范、架构生成物、多语言契约、路线图与归档
├── CLAUDE.md               给 AI 编码助手的项目说明（动手前先读）
├── CONTRIBUTING.md         贡献指南与五条硬约束
├── SECURITY.md             安全策略与威胁模型
└── CHANGELOG.md            双语发行说明
```

---

## 开发与测试

动手前先读 [CONTRIBUTING.md](./CONTRIBUTING.md) 的五条硬约束：**纯离线可用、`server.js` 零 npm 运行时依赖、clean-room、Windows 10/11 为一等目标、行为变更必须带 e2e**。用 AI 编码助手改代码的，先让它读 [CLAUDE.md](./CLAUDE.md)，里面列了现成的公共件和生成物的重算方法。

提交前的快速检查（与 CI 同序）：

```bash
node dev-harness/syntax-gate.js
node ruyi-workbench/app/build.js --check      # 产物必须与 app/src 一致
node --test "dev-harness/unit/*.test.js"
node dev-harness/run-all.js --fast            # 纯静态锁，秒级
node dev-harness/<改动相关>.e2e.js             # 单件：末行 ... E2E: ALL PASS
```

全量回归是 `node dev-harness/run-all.js --parallel 4`。最终以 Windows CI（`.github/workflows/e2e.yml`）为准；在 Linux 容器里跑全量会有一批 Windows 专属的件（PowerShell、`C:\` 路径、像素基线）不过，这是预期，判断回归要和改动前的同环境基线比。需要真实 API 密钥或桌面环境的 live probe 默认跳过。

架构与工程规范：[架构说明](ruyi-workbench/docs/ARCHITECTURE_CN.md) · [工程规范](docs/ENGINEERING-SPEC.md) · [模块依赖图](docs/architecture/module-dependency-graph.md) · [路由清册](docs/architecture/route-inventory.md)

---

## 文档

| 主题 | 中文 | English |
|---|---|---|
| 日常使用 | [用户手册](ruyi-workbench/docs/manuals/USER-GUIDE_CN.md) | [User Guide](ruyi-workbench/docs/manuals/USER-GUIDE_EN.md) |
| 部署、引擎、安全与回归 | [管理员手册](ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md) | [Administrator Guide](ruyi-workbench/docs/manuals/ADMIN-GUIDE_EN.md) |
| 离线部署 | [离线部署说明](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_CN.md) | [Offline Deployment](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_EN.md) |
| 运行时架构 | [架构说明](ruyi-workbench/docs/ARCHITECTURE_CN.md) | [Architecture](ruyi-workbench/docs/ARCHITECTURE_EN.md) |
| 内置技能与一键任务 | [技能与一键任务目录](ruyi-workbench/docs/SKILLS-CATALOG_CN.md) | — |
| Clean-room 依据 | [源码审阅结论](ruyi-workbench/docs/SOURCE_REVIEW_CN.md) | [Source Review](ruyi-workbench/docs/SOURCE_REVIEW_EN.md) |
| 界面多语言契约 | [多语言兼容方案](docs/i18n/README.md) | [Localization Guide](docs/i18n/README_EN.md) |

完整的双语文档索引见 [docs/README.md](docs/README.md)。

---

## 安全、隐私与 clean-room

- 服务只监听 `127.0.0.1`；页面凭据经握手下发，不写在 HTML 里；Host 白名单防 DNS rebinding。
- 所有写操作先进检查点，可逐条回滚；执行级操作永远不能被持久放行。
- 联网工具拒绝私网与回环地址；数据目录里的敏感文件对文件工具双向拒绝；API 响应里的密钥一律掩码。
- **零遥测**：唯一的出站流量是你配置的模型端点、搜索后端和你让它访问的网址。
- 本项目是 **clean-room 独立实现**：不含 Anthropic 泄露源码，不分发官方 Claude Code（用户自备），不复制第三方插件源码。随包前端静态库（marked、highlight.js、mermaid 等）的许可义务见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

**存量兼容标识**：为了不破坏已有的接入，MCP server id `win-claude-workbench`、默认数据目录 `~/.win-claude-workbench`、环境变量 `WIN_CLAUDE_WORKBENCH_HOME`（`RUYI_HOME` 优先）有意保持不变。

## 参与开源

- 提交修复、功能或文档之前，请先读 [CONTRIBUTING.md](./CONTRIBUTING.md)。
- Bug 与功能建议请用仓库的 Issue 表单；使用问题见 [SUPPORT.md](./SUPPORT.md)。
- 请遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。
- **未修复的安全问题不要公开披露**，请按 [SECURITY.md](./SECURITY.md) 私密报告。

## 许可

[Apache-2.0](./LICENSE)（含 `ai-computer-control`）· 第三方组件见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) · Copyright 2026 Ruyi Workbench contributors。

---

## English

**Ruyi (如意)** is a clean-room, offline-first AI workbench for Windows. Point it at any reachable model — any OpenAI-compatible endpoint (a cloud API, an on-prem vLLM, a local Ollama / LM Studio) or a locally installed Claude Code / Kimi Code CLI — and it **does the work on your machine**: reads and writes files, runs scripts, drives Office and the desktop, and dispatches teams of sub-agents, while a **steward** keeps watch over everything in flight. Every step is visible, reversible and honestly metered, and it works with or without an internet connection.

> **Current release: 3.0 Preview `v3.0.0-preview.2`** (2026-09-25, GitHub pre-release). Features are frozen and the full automated regression and offline-package smoke tests pass; the human sign-offs (independent security red-team review, real screen-reader and human-factors walkthroughs) remain before 3.0 final. The last full Release is `v2.6.2`; see the [CHANGELOG](CHANGELOG.md).

### Get started (no command line)

1. **Extract the whole ZIP** (the Full or Slim `Ruyi-<version>-*.zip`) — do not run it from the ZIP preview. A short path such as `C:\Ruyi` is recommended.
2. **Double-click `Start-Workbench.cmd`.** The package ships its own Node runtime; with the desktop shell present it opens in its own window.
3. **Follow the welcome wizard**: language → connect a model (local Ollama / LM Studio need no key) → pick a workspace folder → pick a safety level. About five minutes; the in-app Help menu has the manual, the health check and the wizard again.

### What it is

| | |
|---|---|
| **One file, zero dependencies** | The backend runtime is a single `app/server.js` (~63k lines concatenated from 63 ordered modules, byte-reproducible) with **zero npm runtime dependencies**; the frontend is 60 framework-free ES modules with no build step. |
| **107 native tools · 108 ACC tools** | 65 tools for threads (files, terminal, search, Git, web, Office hand-off, sub-agent orchestration) plus 42 steward-only tools; the optional ACC desktop-control component adds 108 more (screenshot, OCR, UIA, keyboard/mouse, windows, browser, Office, PDF). |
| **8 templates · 10 roles · tested** | 8 built-in multi-agent workflows and 10 node roles. The repository contains **417 e2e cases** (410 run by default; 7 live API/desktop probes are opt-in), plus 100 unit suites and 17 ACC smoke groups, run on Windows CI for every change. |

**Two views, one workbench.** The **steward** view is a conversation: tell it what you want, it opens a thread (or hands it to an existing one) and reports back. It sees every thread's state (dispatching / running / needs you / done / stopped), can search the web and read your registered workspaces — and once it has read anything external in a turn, every write action in that turn becomes a proposal you press. The **workbench** view is the classic three-pane layout: threads, conversation, and a seven-tab side pane (files, artifacts, changes, memory, agent workflows, usage, records).

**Hands-on, and reversible.** Five safety levels (ask every step — the default — / auto-apply small edits / plan first / smart auto / full auto); read / edit / exec tool tiers, with exec never persistently allowed. File checkpoints before every write (undo one change or a whole turn), conversation rewind that rolls files back with it, an NDJSON audit trail, receipt-driven completion claims, narrow revocable autonomy grants, and a hardened localhost server with zero telemetry.

### Capabilities (current master)

- **Engines** — any OpenAI-compatible endpoint (Chat Completions or Responses API), no bundled vendor presets; Claude Code or Kimi Code (official ACP) as Agent CLIs, each with a Ruyi environment briefing; switch engines mid-thread with context carried over.
- **107 native built-in tools** with on-demand tool loading, batching of independent calls, and structured user prompts (single / multiple choice, free text, choice + other) acknowledged only after delivery.
- **Steward** — thread states, a "waiting for you" queue, quiet cards, configurable persona, 124 settings it can change (31 directly, 93 via a button you press; 39 security-critical keys never), and **scheduled tasks** (once / daily / weekly / monthly / cron; remind only, or run a turn) with honest missed-run handling.
- **Multi-agent orchestration** — DAG workflows with 8 templates, 10 roles, 5 quality gates, conditions, loops, failure policies, resource leases, Git worktree isolation, a graphical editor and a live monitor; sub-agents return a compact delivery envelope and can run in the background; team mode adds task proposals, an agent mailbox and directed steering.
- **Desktop & Office (optional ACC v1.9.1)** — OCR + UIA text grounding, so text-only models can drive the desktop; Word / Excel / PowerPoint / PDF with built-in design systems.
- **Voice input** — text appears as you speak and each sentence is corrected when you pause; local recognition comes from the optional [ruyi-toolbox](https://github.com/wangzhe04/ruyi-toolbox) components, auto-discovered on start-up.
- **Skills, memory, Playbooks, migration** — a four-source skill library (20 built-in skills), draft-then-confirm workbench memory, 16 built-in Playbooks; imports `CLAUDE.md` / `AGENTS.md`, MCP servers and plugin skills from Claude Code, Codex and Kimi, and migrates older Ruyi installs with backup and undo.
- **Web search** (zero-config built-in plus SearXNG / Bing / Brave / Tavily / Bocha / custom) with SSRF defenses; **honest usage accounting** per currency, sub-agents and compaction included.
- **Interface** — Simplified Chinese / English / follow system, dark / light / follow system, expert and simple modes, inline Mermaid diagrams, `Ctrl+K` command palette.

### Deploy and develop

Build offline packages on a connected Windows machine with `npm run package:offline` (Full: ACC + CPython 3.12 + OCR) or `npm run package:offline:slim`, then extract on the target — no Python, no network required. From source: Windows 10/11 + Node.js ≥ 20, then `node .\app\server.js serve --open` inside `ruyi-workbench` (binds `127.0.0.1`, default port 8765). Contributors: read [CONTRIBUTING.md](./CONTRIBUTING.md) (five hard constraints) and [CLAUDE.md](./CLAUDE.md), and run the fast checks listed above before pushing; Windows CI is authoritative.

| Topic | English | 中文 |
|---|---|---|
| Everyday use | [User Guide](ruyi-workbench/docs/manuals/USER-GUIDE_EN.md) | [用户手册](ruyi-workbench/docs/manuals/USER-GUIDE_CN.md) |
| Deployment, engines, security | [Administrator Guide](ruyi-workbench/docs/manuals/ADMIN-GUIDE_EN.md) | [管理员手册](ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md) |
| Offline package | [Offline Deployment](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_EN.md) | [离线部署说明](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_CN.md) |
| Architecture | [Architecture](ruyi-workbench/docs/ARCHITECTURE_EN.md) | [架构说明](ruyi-workbench/docs/ARCHITECTURE_CN.md) |
| Clean-room rationale | [Source Review](ruyi-workbench/docs/SOURCE_REVIEW_EN.md) | [源码审阅结论](ruyi-workbench/docs/SOURCE_REVIEW_CN.md) |

### Security, clean-room, license

Localhost-only server with a handshake token and a Host allowlist; checkpointed writes; SSRF defenses; sensitive data-dir files hard-denied to file tools; masked secrets; zero telemetry — see [SECURITY.md](./SECURITY.md) (report vulnerabilities privately). Ruyi is a clean-room implementation: it contains no leaked Anthropic source, does not redistribute Claude Code, and copies no third-party plugin source. Formerly **Win Claude Workbench** (renamed at v0.8); the legacy identifiers `win-claude-workbench`, `~/.win-claude-workbench` and `WIN_CLAUDE_WORKBENCH_HOME` are kept for compatibility. Screenshots come from a local demo instance with a scripted model endpoint; the interface and features shown are real. Licensed under [Apache-2.0](./LICENSE) (including `ai-computer-control`); third-party components are listed in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). Copyright 2026 Ruyi Workbench contributors.
