# 如意 Ruyi · 本地 AI 全能工作台

<img src="docs/branding/ruyi-mark.svg" alt="如意 Ruyi" width="72" align="right" />

> **Ruyi — an offline-first, Windows-native, all-in-one AI workbench that non-programmers can use safely.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Third-Party Notices](https://img.shields.io/badge/third--party-notices-informational.svg)](./THIRD-PARTY-NOTICES.md)
[![Offline e2e](https://img.shields.io/badge/%E7%A6%BB%E7%BA%BF%20e2e-100%2B-success.svg)](./dev-harness)
[![Zero npm deps](https://img.shields.io/badge/npm%20%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-orange.svg)](./ruyi-workbench/app/server.js)

一台 Windows 机器 + 任意一个可用的模型端点(任意 OpenAI 兼容 API 或内网 Claude CLI)= 一个**能真正替你动手**的本地 AI 工作台:读写文件、跑脚本、操控桌面和 Office、派一队子代理协作调研——每一步可审计、可撤销、成本透明,**有网没网都能正常运行**。

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/hero-light.png" />
  <img src="docs/screenshots/hero-dark.png" alt="如意主界面:对话驱动本机工具,回答带表格结论,文件改动可一键撤销" />
</picture>

<sub>▲ 真实工作流:一句话让 AI 读取工作区里的 CSV → 分析并落一份报告文件 → 对话里给出结构化结论;每个工具调用有卡片、每处文件改动可「撤销」、每轮消耗有账。</sub>

**快速跳转**:[这是什么](#如意是什么) · [与同类软件对比](#与同类软件的对比) · [界面导览](#界面一览) · [核心能力](#核心能力一览v16) · [功能详解](#功能详解) · [快速开始](#快速开始五分钟跑起来) · [进阶指引](#进阶操作指引) · [English](#english)

---

## 如意是什么

**如意(Ruyi)** 是一个 clean-room 实现的 Windows 本地 AI 工作台:把「模型对话」升级成「模型替你干活」。它不是又一个聊天壳,也不是程序员专属的编程 CLI——它面向**同一台机器上的两种人**:不写代码的知识工作者(整理文件、汇总报表、写周报、操作 Office),和要干工程活的进阶用户(跑脚本、审代码、多 Agent 调研)。

三组数字勾勒它的形状:

| | |
|---|---|
| **1 个文件** | 后端是单文件 `server.js`(约 1.4 万行),**零 npm 运行时依赖**,只用 Node 内建模块——`node server.js` 直接跑,无需 `npm install`,政企内网过审成本最低 |
| **39+3 个原生工具 · 99 个桌面工具** | 文件/终端/搜索/Git/联网/编排等 39 个常驻原生工具(+3 个按需注册),外加可选的桌面控制组件 ACC(截图/OCR/UIA/键鼠/窗口/Office/PDF 共 99 个工具) |
| **8 套模板 · 9 种角色 · 100+ 离线 e2e** | 内置 8 套多 Agent 工作流模板与 9 种节点角色;每项功能经「实现 → 多视角对抗验证 → 修复 → 独立回归」闭环交付,附 100+ 离线 e2e |

> 原名 **Win Claude Workbench**,自 v0.8 起更名**如意 Ruyi**——去 "Claude" 化是开源发布的法务考量(商标风险 + 旧提示词曾致 provider 模型自称「我是 Claude」的身份错认)。「如意」取「称心如意、如你所愿」之意,图标为青花如意云纹。

## 与同类软件的对比

市面上的 AI 工具大致分三类:云端对话应用(网页/客户端聊天壳)、编程 CLI Agent(面向开发者的终端工具)、云端自动化 Agent(任务托管在别人服务器上)。如意占的是它们都没占的位置——**本地、动手、可撤销、非程序员可用**:

| 维度 | 云端对话应用 | 编程 CLI Agent | 云端自动化 Agent | **如意 Ruyi** |
|---|---|---|---|---|
| 运行位置 | 厂商服务器 | 本机终端 | 厂商沙箱 | **本机,数据不出门** |
| 无外网 / 内网部署 | ✗ | 部分(模型仍需在线) | ✗ | **✓ 端点可指向内网模型** |
| 操控本机桌面/Office | 基本没有 | 弱(以代码为主) | 在云端虚拟机里 | **✓ 99 工具直接控本机,纯文本模型也能用(OCR+UIA 文字定位,不依赖视觉模型)** |
| 做错了能撤销吗 | 无此概念 | 靠 git | 很难 | **✓ 文件检查点+对话回溯成对交付,权限弹窗上就写着「可撤销」** |
| 多 Agent 协作 | 无/黑箱 | 有但多为命令行输出 | 黑箱 | **✓ DAG 图形编辑器 + 实时协作监控画布** |
| 成本透明 | 订阅价 | 部分 | 订阅价 | **✓ 分币种逐笔记账,子代理/压缩全入账,不虚报成本** |
| 非程序员可用 | ✓(但只能聊) | ✗ | ✓(但不可控) | **✓ 简易/专业双模式,一键任务卡** |
| 部署/审计成本 | — | 需 Node/Python 生态 | — | **单文件零依赖,离线 zip 解压即用** |

五个别处很难同时拿到的点:

1. **操作级撤销** —— 文件检查点 + 对话回溯**成对交付**,可撤销性直接体现在权限弹窗时刻(见下方截图)。多数 computer-use 产品的 OS 级撤销基本缺席,这是最强的安全差异化。
2. **纯文本模型也能操控桌面** —— OCR + UIA 文本 grounding,不依赖视觉模型。受限内网往往只有文本模型,这直接决定可用性下限(视觉是增强,不是前提)。
3. **内网部署优先 + 零依赖可审计** —— 单文件后端、零 npm 运行时依赖、前端无框架无构建,全部离线可跑;安全团队要审的面最小。
4. **中文优先 + 中英双语** —— 默认中文体验，同时可在设置中切换简体中文、英文或跟随系统；设置、Provider 卡片、权限/能力弹层、模型菜单、产物、快捷键、命令面板、技能库与结构化 API 错误均由语言资源渲染。内置技能和一键任务随界面语言本地化，用户/项目自定义内容保持作者原文。会写代码的和不写代码的共用一套壳，双模式切换。
5. **双引擎不锁定** —— 任意 OpenAI 兼容端点(DeepSeek / 通义千问 / 智谱 GLM / 内网 vLLM·Ollama)或内网 Claude CLI,随时切换、上下文跨引擎续接。

## 界面一览

| | |
|---|---|
| ![多 Agent 协作监控](docs/screenshots/workflow-monitor.png) | ![工作流图形编辑器](docs/screenshots/workflow-editor.png) |
| **工作台画布**:多 Agent 工作流实时协作图——谁在跑、跑到哪、卡在哪;右栏是节点详情、任务池审批、Agent 邮箱 | **工作流图形编辑器**:拖节点、连箭头、按角色配色;检查器可给每个节点指派引擎/模型/工具级别/质量门 |
| ![权限审批卡](docs/screenshots/permission-approval.png) | ![用量看板](docs/screenshots/usage-dashboard.png) |
| **权限审批**:执行级操作弹卡确认,「此操作无法自动撤销」写在脸上;可拒绝、可本会话内自动允许 | **用量与成本**:输入/输出 token、对话轮次(含工作流子代理回合)、按引擎/服务商/会话三维拆分,诚实计账 |
| ![简易模式一键任务](docs/screenshots/simple-mode-home.png) | ![设置 · 模型服务商](docs/screenshots/settings-providers.png) |
| **简易模式**:非程序员画像——一键任务卡(归档/重命名/合并 Excel/OCR/PDF 汇总/写周报…),开发者页签自动隐藏 | **模型服务**:填 Base URL + 密钥即接入任意 OpenAI 兼容端点;密钥只存本机、界面掩码;可配单价用于成本估算 |

<details>
<summary><b>更多截图(文件面板 / 检查点 / 审计 / 技能库 / 记忆 / 首启引导…)</b></summary>

| | |
|---|---|
| ![首启引导](docs/screenshots/onboarding.png) | ![文件面板](docs/screenshots/pane-files.png) |
| **首次启动**:选一个工作文件夹就能开始;自动探测本机 Claude CLI 与可用引擎 | **文件页签**:工作区文件树 + 单击预览;AI 只能看到工作区内的东西 |
| ![检查点与变更](docs/screenshots/pane-checkpoints.png) | ![审计时间线](docs/screenshots/audit-timeline.png) |
| **变更页签**:每轮的文件改动逐条列出,单条撤销或整轮回滚 | **审计时间线**:每个回合、每次工具调用、每次权限决定都有据可查 |
| ![技能库](docs/screenshots/skills-library.png) | ![工作台记忆](docs/screenshots/workbench-memory.png) |
| **技能库**:内置/用户/项目/Playbook 四源技能,会话级启用 | **工作台记忆**:跨会话的个人经验与项目惯例,起草-确认入库,按项目分组 |
| ![工作流结果](docs/screenshots/workflow-summary.png) | |
| **工作流汇总**:运行结束后各节点结论回填对话,Explorer 拆解 → Researcher 双镜头 → Critic 核验剔除 → Synthesizer 综述 | |

</details>

## 核心能力一览(v1.6)

| 能力 | 说明 | 详解 |
|------|------|------|
| 双引擎对话 | 任意 OpenAI 兼容端点与 Claude CLI 随时切换,跨引擎上下文续接 | [§1](#1-双引擎任意模型端点都能开工) |
| 原生工具环 | 39 常驻 + 3 按需的内置工具:文件/终端/搜索/Git/联网/编排,按 read/edit/exec 三级分档 | [§2](#2-原生工具环39--3-个内置工具) |
| 多 Agent 编排 | DAG 工作流、8 套模板、9 种角色、5 种质量门、图形编辑器、实时监控;AI 主动编排并按任务难易自主选模型 | [§3](#3-多-agent-编排dag--质量门--图形编辑器) |
| 长任务自主推进 | 任务账本 until-done 驱动;零 token 等待;可选的分级崩溃恢复;增量监控(传输量降 ≥80%)与运营指标 | [§3](#3-多-agent-编排dag--质量门--图形编辑器) |
| 信任层 | 文件检查点 + 对话回溯成对交付;5 档权限模式 × 工具三级;全量审计时间线 | [§4](#4-信任层检查点--回溯--权限--审计) |
| 桌面 / Office 操控 | 截图/OCR/UIA/键鼠/窗口/Office/PDF(桌面控制 MCP,ACC v1.8.1,99 工具,可选安装) | [§5](#5-桌面--office-操控acc可选) |
| 技能 / 记忆 / Playbook | 四源技能注册表 + 跨会话工作台记忆 + 可复用任务剧本,全部渐进注入 | [§6](#6-技能--记忆--playbook) |
| 联网检索 | 8 种搜索后端,内置后端零配置可用;SSRF 防御;抓取带离线缓存 | [§7](#7-联网检索与网页抓取) |
| 成本 / 用量看板 | 分币种逐笔记账,区分官方/第三方计划/按量;子代理与压缩全入账;月度预算告警 | [§8](#8-用量与成本看板诚实计账) |
| 中英界面 | 设置中支持跟随系统、简体中文、英文；设置、动态弹层、技能库/一键任务与 API 错误可本地化 | [多语言方案](docs/i18n/README.md) |
| 团队模式 | 共享任务池(子代理提案→审批→物化)、Agent 邮箱、对指定节点定向插话 | [§3](#3-多-agent-编排dag--质量门--图形编辑器) |
| 分级 UI | 简易/专业双模式、深浅双主题、青花瓷视觉系统 | [§9](#9-分级-ui简易专业双模式) |

> 每项功能均经「实现 → 多视角对抗验证 → 修复 → 独立回归」闭环交付,附 100+ 离线 e2e。迭代记录见 [优化路线图](docs/OPTIMIZATION-ROADMAP.md)。

## 功能详解

### 1. 双引擎:任意模型端点都能开工

- **OpenAI 兼容引擎(原生)**:直连 HTTP + SSE 流式,带完整原生工具循环。内置四组预设:**DeepSeek / 通义千问 DashScope / 智谱 GLM / 自定义**(内网 vLLM、Ollama、one-api 网关均可)。多 Provider 并存,顶栏一键切换模型。
- **Claude CLI 引擎(可选)**:指向本机已装的 Claude CLI 即可并存使用;工作台自动生成 MCP 配置,把自己的工具与桥接工具喂给 CLI;另有火山方舟 Ark 等 Anthropic 兼容端点预设。
- **工具提示词智能按需**:默认先按任务装载相关工具包,缺少能力时由 AI 搜索并增量装载；OpenAI 兼容引擎在下一次工具循环加入具体 schema，Claude CLI 通过分级代理调用隐藏工具。简单问题不再反复携带整套约 140 个工具；设置 → 高级可切回“全部常驻”兼容模式。[设计与本机 A/B](ruyi-workbench/docs/TOOL-LOADING_CN.md)
- **跨引擎续接**:同一会话里从 DeepSeek 切到 Claude(或反向),历史自动嫁接,不断上下文。
- **可靠交互提问**:Claude CLI 与 OpenAI 兼容引擎共用 `request_user_input` 弹窗通道；选择只有在工作台确认已送达后才会关闭，后台会话的提问也会立即提示。
- **上下文电量表**:顶栏实时显示已用/上限 token(自动探测上下文窗口,支持手动锁定);超阈值自动两级压缩(蒸发 → 摘要),也可手动 `压缩`。
- **能力矩阵**:视觉(看图)、推理链、工具调用等能力按端点探测/标注,缺什么 UI 直接告诉你,不让你对着黑箱猜。
- **计划模式**:提问先出 `PLAN:`,你批准了才动手(provider 引擎真流程,不是提示词装饰)。

### 2. 原生工具环:40 + 3 个内置工具

全部用 Node 内建模块实现(零依赖),按风险三级分档:**read**(只读,自动放行)/ **edit**(写入,先记检查点,可撤销)/ **exec**(执行,最高危,默认逐次确认):

| 类别 | 工具 |
|---|---|
| 终端 / 执行(7) | `powershell_run` · 持久终端会话 `shell_start/send/poll/kill/list` · `script_run`(PS/Python/Node 临时脚本) |
| 文件(12) | `file_read/write/edit/delete/move/copy` · `file_list/search/glob` · `archive_zip/unzip`(防 Zip-Slip) · `http_download` |
| 桌面交接(4) | `browser_open` · `office_open` · `desktop_screenshot` · `keyboard_send_keys` |
| 项目智能(6) | `project_snapshot` · `dependency_inventory` · `code_review_scan` · `frontend_audit` · `claude_md_audit` · `docs_search`(全部离线扫描器) |
| Git(4) | `git_status/diff/log`(只读)· `git_commit` |
| 联网(3) | `web_search` · `web_fetch`(SSRF 防御 + 离线缓存)· `http_request`(本机/内网 API 调试) |
| 规划 / 编排(4) | `request_user_input`(可靠收集用户选择)· `todo_write`(驱动 UI 步骤条)· `spawn_agent`(隔离子回合)· `orchestrate_agents`(启动 DAG 工作流) |
| 按需注册(3) | `skill_read`(技能全文拉取)· `propose_task`(任务池提案)· `send_to_agent`(Agent 邮箱) |

外部 MCP 工具(桌面控制、drop-in 连接器)会**桥接**进这个循环,并沿用同一套分级审批。

### 3. 多 Agent 编排:DAG + 质量门 + 图形编辑器

一句「深度调研一下竞品定价」,如意会派一队各司其职的子代理,并在**工作台画布**上实时画出协作图(见上方截图)。

**8 套内置模板**(节点数为默认值,均可在编辑器里改):

| 模板 | 形状 | 适用 |
|---|---|---|
| 深度研究 → 核验 → 综述 | 拆解 → 双镜头并行检索 → 对抗核验 → 带引用综述(5 节点) | 要可靠、可追溯结论的调研 |
| 代码审计 | 建库地图 → 正确性/安全/质量三维并行 → 核验 → P1/P2/P3 排期(6 节点) | 接手陌生代码库、上线前体检 |
| 实现 → 审查 → 修复 → 测试 | 审查不过才进修复,最后独立验收(4 节点) | 有明确验收标准的开发任务 |
| Bug 定位 | 复现 → 双假设并行 → 验证 → 根因修复(5 节点) | 难缠 bug 的系统化排查 |
| 需求 → 多方案 → 选型 → 落地清单 | 三种取向并行出方案 → 加权横评 → 可执行清单(6 节点) | 技术选型、架构决策 |
| 文档生成 | 提纲 → 分节并行撰写 → 事实核查 → 统稿落盘(5 节点) | 从零写长文档 |
| 数据洞察 | 探查 → 方案 → 主线/交叉双分析 → 核验 → 洞察(6 节点) | 数据分析与报告 |
| 正反辩论 → 裁决 | 正反并行 → 交叉审查裁决(3 节点) | 有争议的决策 |

**9 种节点角色**(各带提示词、工具面、预算与配色):Explorer 探索 · Worker 实现 · Reviewer 审查 · Verifier 验证 · Planner 规划 · Researcher 调研 · Critic 对抗评审 · Synthesizer 汇总 · Analyst 分析。

**编排原语**:节点级引擎/模型指派(如「检索用快模型、核验用强模型」)· 依赖边 · 条件执行(审查不过才修复)· 循环(直到满足条件,防空转)· 失败策略(阻塞/继续/重试)· 资源租约(防死锁)· Git worktree 隔离(并行改文件不打架)· 结构化输出 Schema · **5 种质量门**(review / verify / vote 法定人数 / cross_review / dedupe,其中 vote 与 dedupe 为确定性算法,不烧 token)。

**AI 主动编排 + 按难度选模型**:对话里出现「调研 / 审计 / 排查 / 选型 / 写文档」这类意图时,两个引擎都会收到模板清单、意图→模板映射,以及**当前可用模型的能力档位清单**(按引擎分组、快 / 均衡 / 强分档)——模型可自主发起 `orchestrate_agents`,并**按每个节点的任务难易自主指派模型**:简单/大批量节点用快模型省成本提速、核心推理/综合/质量门用强模型保质量(带「简单任务别套模板」护栏防过度编排)。也可一键开启「按工具级别自动派档」,让没显式指定模型的节点由后端按 read→快 / exec→强 兜底。

**团队模式 v2**:运行中的子代理可 `propose_task` **提案追加节点**,经你审批物化进 DAG(运行时嵌套委派的可观测替代);节点间可用 `send_to_agent` 单向异步传话(与用户插话分池);你还能对**指定节点**中途**定向插话**,下一次模型调用前生效。

**长任务自主推进(可跑数小时、崩了能续)**:不是把「继续执行」粗暴地变成无限循环,而是让目标、等待、恢复和人工接管都可见、可控。

- **任务账本**:把目标拆成带验收证据的里程碑,可选 `until-done` 自动推进;连续无进展会停滞,预算用尽则存档暂停——进度保留,不把「还没做完」伪装成报错或完成。
- **等待不烧 token**:`wait_for` 可等到指定时间、文件出现、进程存在或 URL 可达;等待节点不占并发槽、不调用模型,并对工作区路径、进程探测和 URL 请求分别设护栏。
- **恢复按副作用分级**:每一步状态原子落盘,重启后先诚实标出中断点。开启自动恢复后,纯读 / 等待 / 确定性质量门可继续;命令执行、已写入或能力不明的节点一律暂停等待确认,**绝不盲目重放不可逆副作用**。
- **上下文、产物与监控都有边界**:子代理的上游结论按预算收敛,文件产物可单独追溯;监控改走增量事件流(相比全量轮询传输量降 ≥80%),运行干预次数、失败分类和预算超支率随手可查。

### 4. 信任层:检查点 / 回溯 / 权限 / 审计

「让 AI 动手」的前提是「动错了能收回来」:

- **文件检查点**:每个写操作(写/改/删/移/复制/解压/下载)先把「改前状态」压缩入检查点日志——单条撤销、整轮回滚,对话里每轮变更直接列出(见上方截图)。
- **对话回溯**:把会话拨回任意轮次,可选同时回滚该轮之后的文件改动——**对话和文件一起回**,不是只删聊天记录。
- **5 档权限模式 × 工具三级**:默认「每步都问」(exec 逐次确认),另有 接受编辑 / 计划模式 / 全自动 / 跳过确认;审批卡上明示风险级别与「此操作无法自动撤销」;只读/编辑级可记住「本会话自动允许」,**执行级永远不能被持久放行**。
- **自主性授权书**:需要连续执行时,可从本机 UI 签发一张比当前权限更窄的临时授权——文件路径 glob、命令前缀、联网许可、次数和有效期都可限定,支持本次运行/本会话范围并可随时撤销;不会出现「全工具、全工作区、无限次」的宽泛预设。
- **审计时间线**:每个回合、每次工具调用、每次权限决定落 NDJSON 审计日志,右栏可按来源/类型过滤(见上方截图);记录经密钥脱敏后才下发。
- **本机加固**(部分成果,详见 [SECURITY.md](./SECURITY.md)):服务只绑 `127.0.0.1` + 页面 token;Host 白名单抗 DNS-rebinding;`web_fetch`/`http_download` 拒绝私网/回环地址(SSRF);数据目录敏感文件(密钥、会话、审计)对文件工具**双向拒绝**(含 junction/短名绕路);API 响应里密钥一律掩码。

### 5. 桌面 / Office 操控(ACC,可选)

`mcp/ai-computer-control/` 是随发行包捆绑的**桌面控制 MCP**(v1.8.1,Python ≥3.12,共 **99 个工具**),装好后工作台自动探测,并把工具同时供给两个引擎:

启动时，工作台会先验证候选 Python 能否导入 ACC；完整离线包内的 `python_embed` 和安装器部署到 `%LOCALAPPDATA%\ai-computer-control\runtime\python` 的运行时均可直接识别。发现缺少依赖的旧运行时会自动跳过并回退到旧版安装器的 `venv` 或可用的系统 Python。

- **看**:全屏/区域/窗口截图、OCR 文字识别与定位、UIA 控件树读取、模板匹配。
- **动**:鼠标(移动/点击/拖拽/滚轮)、键盘(输入/组合键)、窗口管理(9 工具)、应用启停、剪贴板、对话框处理、宏录制回放。
- **办公**:Word/Excel/PPT/PDF 读写,Excel 美化与图表、PPT 生成走**三套内置设计系统**(青花商务/墨白极简/活力现代),中文字体纪律(`w:eastAsia`)内建。
- **关键设计**:①**文字 grounding 优先**——OCR+UIA 让纯文本模型也能精准定位控件,视觉模型只是增强;②**观察-验证**工具(`observe`/`act_and_verify`)把「点了没生效」变成可判定;③可选依赖缺失时**优雅降级**(无 winsdk 则 OCR 停用,其余照常);④文件类改动同样进工作台检查点,可撤销;⑤变更类操作自动落 NDJSON 审计。

### 6. 技能 / 记忆 / Playbook

- **技能库**:四源注册表——内置 toolkit(16 技能:代码审查/前端审计/本地文档/提交说明/API 调试/安全检查…)、用户库(`dataRoot/skills`)、项目库(`.ruyi/skills/`)、Playbook 并入;会话级启用(上限 8),系统提示词只放紧凑索引,provider 引擎经 `skill_read` 按需拉全文,Claude 引擎经 `--append-system-prompt` 展开——**两引擎同一套技能**。
- **工作台记忆**:跨会话的个人经验/项目惯例/教训,**起草-确认**才入库(AI 不会偷偷写),按项目分组、可迁移;注入时带围栏标记且默认只进当前项目相关内容。与随代码仓库走的 `CLAUDE.md` 项目记忆分工明确。
- **Playbook**:把跑顺了的任务「存为剧本」,AI 自动起草步骤与参数,确认后进技能库,下次一键复跑(内置 10 个常用剧本)。

### 7. 联网检索与网页抓取

- `web_search` 支持 **8 种后端**:内置(零配置,必应中国→百度 HTML 解析,无需任何 Key)/ SearXNG / Bing / Brave / Tavily / 博查 / 自定义 / 关闭。
- `web_fetch` 抓正文并抽取标题/主体(≤3 跳转、10s、2MB 上限),**失败回退离线缓存**;拒绝内网/回环地址。
- 子代理与工作流节点同样可以联网(Researcher 角色默认带检索),因此「深度研究」模板在有网环境是真检索,断网或受限内网环境自动退化为基于本地材料的分析。

### 8. 用量与成本看板:诚实计账

- **分币种逐笔记账**,绝不强行换算汇率;给服务商填了单价才估成本,没填就只显示 token,并明确标注「等价估算(非实际扣费)」。
- 第三方 Coding Plan(如火山方舟 Ark)标注「计划内计费」,**不计入真实花费**——不虚报你没花的钱。
- **所有烧 token 的路径全入账**:工作流子代理回合、自动/手动压缩、Playbook 起草……看板上「对话轮次」直接标出「其中工作流子代理 N 回合」。
- 按 **引擎 / 服务商 / 会话** 三维拆分,支持今天/本周/本月/全部;可设月度软预算,超了告警不拦人。

### 9. 分级 UI:简易/专业双模式

- **简易模式**(默认):一键任务卡(按内容归档/批量重命名/清理下载/合并 Excel/OCR/PDF 汇总/网页填表/写周报…)、开发者页签隐藏、术语全部人话。
- **专业模式**:右栏 11 页签全开——文件/产物/变更/Agent 工作流/用量/审计 + 终端/桌面/MCP/调试/体检;设置 7 页签(基础/Claude CLI/服务商/Agent 角色/集成 MCP/联网搜索/高级)。
- **青花瓷视觉系统**:深/浅双主题、密度分级、语义色 token、SVG 图标体系;`Ctrl+K` 命令面板直达所有功能。
- **语言**:设置中可选跟随系统、简体中文或英文。运行时语言包与审校基准、错误码契约见[多语言兼容方案](docs/i18n/README.md)。

## 快速开始(五分钟跑起来)

**前置**:Windows 10/11 + [Node.js](https://nodejs.org/) **≥ 20**。零 npm 运行时依赖,不需要 `npm install`。

```powershell
git clone https://github.com/wangzhe04/ruyi-workbench-oss.git
cd ruyi-workbench-oss\ruyi-workbench
node .\app\server.js serve --open
```

浏览器会自动打开工作台(只监听 `127.0.0.1`,带页面 token):

![首次启动引导](docs/screenshots/onboarding.png)

1. **选工作文件夹**:把文件夹拖进来(或点击选择)。AI 的文件操作被限制在工作区内,数据目录敏感文件另有硬拒绝。
2. **接一个模型**(二选一,或都要):
   - **OpenAI 兼容端点**(推荐新手):设置 → 服务商 → 选 DeepSeek/通义/智谱预设或自定义,填 Base URL + API 密钥 → 「测试连接」变绿即可。国产模型注册即得免费额度,几分钟能用起来;内网 vLLM/Ollama 填内网地址即可。
   - **Claude CLI**(可选):本机已装 Claude CLI 的话通常**自动探测**;也可在 设置 → Claude CLI 指定路径。两引擎并存,顶栏随时切换。
3. **说一句人话**:比如「帮我分析一下工作区里的 销售数据.csv,给出结论,并把完整报告写成 Markdown」。你会看到:思考过程 → 工具卡片(读文件/写文件)→ 结构化结论 → 本轮变更(带撤销按钮)→ 本轮消耗。

数据目录默认 `~/.win-claude-workbench`(存量兼容),可用环境变量 `RUYI_HOME` 覆盖。

## 进阶操作指引

<details>
<summary><b>跑一个多 Agent 模板 / 自定义工作流</b></summary>

- **快速运行**:右栏「Agent 工作流」页签 → 下拉选模板 → 「运行模板」;或在对话里直接说「深度调研 ××」让 AI 自己发起。
- **图形编辑**:「新建 / 编辑」打开编辑器 → 载入模板或新建空白 → 拖节点、连箭头 → 检查器里改任务/角色/引擎/模型/迭代预算/质量门 → 「保存并运行」。内置模板保存即成个人副本,不会改坏原件。
- **过程干预**:切到「工作台」画布看实时协作图;点节点看详情;子代理提案的新任务在「任务池审批」里等你点头;要补充信息就对指定节点定向插话。
</details>

<details>
<summary><b>安装桌面控制(ACC)</b></summary>

完整离线包**不要求目标机预装 Python**；源码开发或普通 pip 安装需要 Python ≥3.12。二选一:

```powershell
# 方式一:完整离线包解压后双击（推荐）
.\mcp\ai-computer-control\install.bat

# 方式二:pip 装离线依赖清单
pip install -r mcp\ai-computer-control\requirements_offline.txt
```

装好后重启工作台即自动探测(设置 → 集成/MCP 可确认)。完整离线包包含经过校验的 Python 3.12 运行时、纯 wheel 依赖缓存和匹配的 Chromium；目标机不会联网或现场编译。普通源码安装时，大多数可选依赖缺失会**优雅降级**。
</details>

<details>
<summary><b>离线 / 受限内网部署</b></summary>

在有网机器上打包,拷到内网解压即用:

```powershell
cd ruyi-workbench
# 精简包(不含桌面控制)
powershell -ExecutionPolicy Bypass -File .\tools\package-offline.ps1 -SkipExeBuild -Variant 'offline-slim'
# 完整包(首次构建 ACC 运行时需联网；目标机完全离线)
powershell -ExecutionPolicy Bypass -File .\tools\package-offline.ps1 -SkipExeBuild -IncludeAcc -BuildAccOffline -Variant 'offline-full-acc'
```

产物 `dist\Ruyi-<变体>.zip`(内含 node.exe 源码运行器,目标机**无需安装任何东西**),解压后双击 `Start-Workbench.cmd`。完整包会在首次启动时自动校验、安装并注册 ACC，后续启动走快速检查，开箱即用。也支持 `npx pkg` 打成单体 `Ruyi.exe`,以及增量 overlay 升级包(见 [管理员手册](ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md))。
</details>

<details>
<summary><b>接入更多 MCP 连接器(drop-in,免配置)</b></summary>

把任意 stdio MCP 做成文件夹,放进发行包 `mcp/` 或数据目录 `mcp/`,写一个 `ruyi-mcp.json`(`{id, command, args…}`),**重启即自动注册**——不改配置文件;删文件夹即卸载。工具默认桥接给两个引擎，并由按需目录发现、纳入同一套分级审批(`bridgedToolTiers` 可给桥接工具定级)。详见 [mcp/README.md](mcp/README.md)。
</details>

<details>
<summary><b>常用 CLI 与排障</b></summary>

```powershell
node .\app\server.js doctor       # 体检:引擎/依赖/端口/数据目录一图看清(UI 里也有「体检」按钮)
node .\app\server.js mcp-config   # 输出可粘贴进 .mcp.json 的工作台 MCP 配置
node .\app\server.js install      # 把工作台 MCP 注册进本机 Claude CLI
node .\app\server.js mcp          # 以 stdio MCP server 方式运行(供 CLI 调用)
```

手册:[用户手册(任务导向)](ruyi-workbench/docs/manuals/USER-GUIDE_CN.md) · [管理员手册(部署/安全边界/计费)](ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md) · [架构说明](ruyi-workbench/docs/ARCHITECTURE_CN.md)
</details>

## 目录结构

```
.
├── ruyi-workbench/               如意工作台(Node 后端 + 原生 JS 三栏 UI + 自身 MCP server)
│   ├── app/server.js             主服务(零 npm 运行时依赖);双引擎 + 原生工具循环 + MCP stdio 桥
│   ├── app/public/               index.html / app.js / styles.css(原生 JS,无框架无构建)
│   ├── docs/                     架构说明 + 手册(USER-GUIDE / ADMIN-GUIDE)
│   └── tools/                    离线打包 / overlay 升级 / 开发脚手架
├── mcp/
│   ├── ai-computer-control/      内置桌面控制 MCP(99 工具:截图/OCR/UIA/键鼠/窗口/Office/PDF)
│   └── README.md                 drop-in 连接器(文件夹即插即用)说明
├── dev-harness/                  验证脚手架(100+ 离线 e2e,Node 直跑)
├── docs/
│   ├── screenshots/              本 README 的界面截图(演示实例拍摄)
│   ├── branding/                 品牌图标(青花如意云纹 SVG)
│   └── OPTIMIZATION-ROADMAP.md   迭代记录与验收(§0–§28)
├── LICENSE                       Apache-2.0(含 ai-computer-control)
├── THIRD-PARTY-NOTICES.md        第三方组件与许可清单
├── CONTRIBUTING.md               贡献指南(含五条硬约束)
└── SECURITY.md                   安全策略与威胁模型
```

## 测试

全部 e2e 离线可跑,Node 直跑,无需装包:

```powershell
node dev-harness\plan-mode.e2e.js       # 单件
node dev-harness\repo-hygiene.e2e.js    # 合规回归
node dev-harness\meta-guard.e2e.js      # 门面数字/鉴权路由覆盖护栏
```

每件文件头部注释都写明了它断言的边界;末行 `... E2E: ALL PASS` 为通过判据。串行跑(端口固定,并行会撞)。

**需自备条件的实弹件**(不在离线回归清单里):

| e2e | 需要 |
|---|---|
| `deepseek-live` / `deepseek-tools` | 真实 DeepSeek API 密钥(命令行参数传入) |
| `desktop-bridge-live` / `desktop-mcp-smoke` | 已装 ACC 依赖的 Python 环境(缺依赖时相关断言 SKIP) |

## 安全与隐私

- 服务仅监听 `127.0.0.1` + 页面 token;Host 白名单抗 DNS-rebinding;不对外暴露。
- 所有写操作进检查点日志,可逐条回滚;执行级操作永不持久放行。
- 联网工具带 SSRF 防御(拒绝私网/回环);数据目录敏感文件对文件工具双向拒绝;API 响应密钥掩码。
- 零遥测:不上报任何数据;唯一的出站流量是你配置的模型端点与搜索后端。
- 威胁模型与已知边界详见 [`SECURITY.md`](./SECURITY.md)。

## 品牌与兼容标识

为不破坏存量接入,以下**存量兼容标识有意保持不变**:MCP server id `win-claude-workbench`、默认数据目录 `~/.win-claude-workbench`、环境变量 `WIN_CLAUDE_WORKBENCH_HOME`(`RUYI_HOME` 优先,旧变量继续识别)。

## Clean-room 声明

本项目为 **clean-room 独立实现**:**不含** Anthropic 泄露源码、**不分发**官方 Claude CLI(用户在内网机器上自备并注册)、**不复制**第三方插件源码。随包前端静态库(marked / highlight.js 及主题)的许可义务见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

> 本 README 中的界面截图取自本机演示实例:模型端点为本地脚本化的演示服务(内容为脚本预置),密钥为占位假值;界面、工具卡、检查点、工作流运行与用量记账均为真实功能实拍。

## 许可

[Apache-2.0](./LICENSE)(含 `ai-computer-control`)· 第三方组件见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) · Copyright 2026 Ruyi Workbench contributors。

---

## English

**Ruyi (如意)** is an offline-first, Windows-native, all-in-one AI workbench you can drive from any model endpoint — any OpenAI-compatible API *or* an on-prem Claude CLI. One Windows machine plus one reachable model = a local workbench that actually **does the work**: reads/writes files, runs scripts, drives the desktop and Office, and dispatches a team of sub-agents — every step auditable, reversible, and honestly metered. **Works with or without an internet connection.**

> Formerly **Win Claude Workbench**, renamed to **Ruyi** at v0.8 (trademark caution for open-sourcing, plus an old system prompt that made provider models misidentify as "I am Claude"). *Ruyi* means "as you wish"; the mark is a blue-and-white *ruyi* cloud motif.

### Why Ruyi (five differentiators)

1. **Operation-grade undo/rewind** — file checkpoints and conversation rewind ship as a pair; reversibility surfaces right on the permission prompt. OS-level undo is largely absent from most computer-use products.
2. **Text-only models can still drive the desktop** — OCR + UIA text grounding, no vision model required. Air-gapped networks often have text-only models; vision is an enhancement, not a prerequisite.
3. **Air-gap first, auditable, zero runtime deps** — a single `server.js` with **zero npm runtime dependencies** (Node built-ins only), framework-less vanilla-JS frontend, offline zip deployment. Minimal audit surface for enterprise/government review.
4. **Chinese-first with English support, built for non-programmers** — the interface defaults to Chinese and can follow the system language or switch to Simplified Chinese or English. Settings, Provider cards, safety/capability popovers, model menus, artifacts, shortcuts, the command palette, the skill library, and stable API errors are localized. Built-in skills and quick tasks follow the UI language, while user and project-authored content remains in its original language; simple/pro UI is shared by coders and non-coding knowledge workers.
5. **Dual engine, no lock-in** — any OpenAI-compatible endpoint (DeepSeek / Qwen / GLM / on-prem vLLM·Ollama) or an on-prem Claude CLI, switchable mid-session with cross-engine context continuation.

### Capabilities (v1.6)

Dual-engine chat with reliable `request_user_input` prompts (delivery-acknowledged across Claude CLI and OpenAI-compatible providers) · a native tool loop of 40 resident + 3 conditional built-in tools (read/edit/exec tiers) · desktop/Office control (screenshot / OCR / UIA / keyboard-mouse / window / Office / PDF — bundled ACC MCP v1.8.1, 99 tools, optional) · multi-agent orchestration (DAG workflows, **8 built-in templates**, **9 node roles**, **5 quality-gate modes**, graphical editor, live monitor canvas, intent-triggered auto-orchestration) · **team mode** (shared task pool with propose→approve→materialize, agent mailbox, directed steering of a running node) · trust layer (file checkpoints + conversation rewind as a pair, 5 permission modes × 3 tool tiers, full audit timeline) · Skills registry (four sources, progressive injection across both engines) · cross-session workbench memory (draft-then-confirm) · Playbooks · web search (8 backends incl. a zero-config built-in) with SSRF defenses · honest cost/usage dashboard (per-currency, sub-agents and compaction all metered) · tiered simple/pro UI with dark/light themes · localization runtime and dual catalogs for Simplified Chinese and English. Each feature ships through an implement → adversarial multi-agent review → fix → regression loop with 100+ offline e2e.

### Detailed documentation

| Topic | English | 中文 |
|---|---|---|
| Everyday operation | [User Guide](ruyi-workbench/docs/manuals/USER-GUIDE_EN.md) | [用户手册](ruyi-workbench/docs/manuals/USER-GUIDE_CN.md) |
| Deployment, engines, security, and regression | [Administrator Guide](ruyi-workbench/docs/manuals/ADMIN-GUIDE_EN.md) | [管理员手册](ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md) |
| Offline package | [Offline Deployment](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_EN.md) | [离线部署说明](ruyi-workbench/docs/OFFLINE_DEPLOYMENT_CN.md) |
| Runtime design | [Architecture](ruyi-workbench/docs/ARCHITECTURE_EN.md) | [架构说明](ruyi-workbench/docs/ARCHITECTURE_CN.md) |
| Clean-room rationale | [Source Review](ruyi-workbench/docs/SOURCE_REVIEW_EN.md) | [源码审阅结论](ruyi-workbench/docs/SOURCE_REVIEW_CN.md) |
| UI language contract | [Localization Guide](docs/i18n/README_EN.md) | [多语言兼容方案](docs/i18n/README.md) |

The complete bilingual documentation index is available in [docs/README.md](docs/README.md).

### Quick start

**Prerequisites:** Windows 10/11 + [Node.js](https://nodejs.org/) **≥ 20**. Zero npm runtime deps — no `npm install` needed.

```powershell
cd ruyi-workbench
node .\app\server.js serve --open
```

First launch walks you through picking a workspace folder and configuring a provider (DeepSeek preset recommended; on-prem vLLM/Ollama work too). The on-prem Claude CLI engine is optional and coexists with providers. Data dir defaults to `~/.win-claude-workbench`; override with `RUYI_HOME`.

### Desktop control (optional)

`mcp/ai-computer-control/` is a bundled **desktop-control MCP** (99 tools, ACC v1.8.1, requires **Python ≥3.12** for source installs). The verified full offline release includes CPython 3.12, a wheel-only dependency cache, and matching Chromium, so the target needs neither Python nor network access. Optional dependencies degrade gracefully in source installs.

At startup the workbench verifies that a candidate Python can import ACC. It recognizes both the release's `python_embed` runtime and the installer's `%LOCALAPPDATA%\ai-computer-control\runtime\python\python.exe`, while retaining the legacy `venv` fallback. `-IncludeAcc` now requires a checksummed, pre-hydrated payload; add `-BuildAccOffline` to build it on the connected packaging machine.

### Tests

All e2e run offline via `node dev-harness\<name>.e2e.js` (no packages to install). Run them **serially** — ports are fixed. Live tests (`deepseek-live`, `desktop-bridge-live`, …) require your own key / Python and are skipped by default.

### Security

Binds `127.0.0.1` + a page token; Host allowlist against DNS rebinding; every write goes through a rollback-able checkpoint journal; networked tools carry SSRF defenses; sensitive data-dir files are hard-denied to file tools; API responses mask secrets; zero telemetry. See [`SECURITY.md`](./SECURITY.md).

> Screenshots in this README were taken from a local demo instance: the model endpoint is a scripted local stub (canned content) with a placeholder API key; the UI, tool cards, checkpoints, workflow runs and usage accounting are the real features in action.

### License

[Apache-2.0](./LICENSE) (includes `ai-computer-control`). Third-party components are listed in [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md). Copyright 2026 Ruyi Workbench contributors.
