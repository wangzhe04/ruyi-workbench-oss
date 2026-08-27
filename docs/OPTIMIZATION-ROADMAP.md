# 如意 Ruyi 优化路线图（当前版）

> 本文只保留**当前发布线、发布准入与后续计划**；已交付波次历史移入 [`archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md`](archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md)（第46–86波）与 [`archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md`](archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)（第1–45波）。
> 当前排期以本文「后续计划」为准；新引擎版 Pretender 3.0 的范围、证据与发布门见 [`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md)。`docs/PRETENDER-PLAN.md` v4 保留为旧壳层线依据，适用边界见 22 号方案 §8，不再统管新引擎线。

---

## 发布线、产品代号与内部波次（2026-07-24 起）

对外发布与内部交付分开管理：**版本号告诉用户可安装、可回退、可比较的产品版本；波次只服务于研发拆解、验证和路线图追踪。**两者不再一一映射。

| 对外产品线 | 技术版本与 Git tag | 面向用户的写法 | 状态 |
|---|---|---|---|
| **Escapade** | `v2.x.y` | **如意 Ruyi Escapade 2.0**；修订版写作 Escapade 2.0.1、2.1 … | 当前大版本；源码版本与 Git tag 已到 `v2.6.1`；`CHANGELOG.md` 最后已归档发布条目仍为 `v2.5.0`（2026-08-09） |
| **Pretender** | `v3.0.0` | **如意 Ruyi Pretender 3.0** | **重新立项（2026-08-27）**：版本核心改为引擎侧 Agent SoC 微架构迭代（见「Pretender 3.0 重新立项」节与 [`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md)）；原壳层线 P1✅ / P2✅ / P3 工程✅，P4 默认切换与发布保持搁置，不因重新立项自动恢复 |

- Release 标题使用产品名与主次版本，不加冗余的 `V`；技术 tag 保持短、稳定且可供脚本解析（当前技术基线为 `v2.6.1`）。离线包也继续用短文件名（如 `Ruyi-v2.6.1-full.zip`），避免 Full 包在 Windows Explorer 的路径预算中失效；源码／tag 的版本号不替代发布物与发布状态核验。
- `第N波`、`Nx` 等只表示内部工作切片；一个 Release 可以汇总多波，一个波也可只在后续补丁版发布。只有范围冻结、测试与打包门通过后，才决定是 `2.0.x` 补丁、`2.x` 功能版本或下一主版本。
- 每个对外大版本以一个产品代号统摄体验目标；Pretender 3.0.0 正式发布批准前不把 Pretender 名/3.0 版本号混入用户界面、下载名或兼容承诺（22 号方案 §8 的品牌冻结纪律）。

---

## 当前状态（2026-08-27）

| 线 | 状态 | 依据 |
|---|---|---|
| **Escapade 发布线** | 当前源码与技术 tag 为 `v2.6.1`；`CHANGELOG.md` 最后已归档发布条目为 `v2.5.0`（2026-08-09，含第95–98波），后续变更仍列于 Unreleased。本次规划修订不改变版本号或发布状态 | `ruyi-workbench/package.json`、git tag `v2.6.1`、`CHANGELOG.md` |
| **Pretender 3.0 交付线（🔁 重新立项：核心改向引擎侧）** | P1 Data & Contract Ready ✅；P2 Preview Ready ✅；P3 工程切片 81–85 全部收口 ✅，**正式外部受试者人因验证未执行**；P4 第86波硬化切片已交付，第87–91波用于交办台/任务单 UX 打磨并随 2.4.1 发布；**2026-08-10 拍板先跑 3.0 前 UX 迭代线再收口，第99波走查与第100波三段式重构已交付**；**同日用户决定跳过第101波（正式人因验证）、产品首页保留 v2.5.0，不切 3.0.0 默认壳、不做 3.0 正名 → 3.0 收口线整体搁置（第102波随 101 跳过而暂缓）**；**2026-08-27 重新立项：版本核心改为引擎侧 Agent SoC 微架构迭代（[`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md) 与本文「Pretender 3.0 重新立项」节），原壳层 P1–P3 成果已随 Escapade 2.x 交付，P4 默认切换保持搁置** | `docs/PRETENDER-PLAN.md` v4、`docs/PRETENDER-METRICS.md`、第99/100波记录 `docs/archive/optimization-plan/08-task-sheet-ux-audit.md` |
| **Traveler 4.0** | 概念稿 v0.1（非承诺） | `docs/TRAVELER-CONCEPT.md` |

---

## 发布准入（现行）

### Escapade 通用发布准入

每个候选版本至少通过以下门槛：

- **版本与构建**：版本三角（`package.json` / `00-boot.js` / `facts.json`）、构建新鲜度、源码 manifest 映射和生成物差异检查。
- **行为回归**：相关单元、E2E、DOM/IA、提示词快照与 A/B、权限和恢复路径回归；KNOWN_FAILURE 不得被静默扩张。
- **视觉与无障碍**：涉及 UI 的版本必须完成双主题、支持的界面模式、键盘和焦点验收。
- **离线交付**：Full/Slim 包完整性、checksum、全新目录启动、覆盖升级和回滚演练。
- **外部探针**：真实 provider、Claude CLI、远程 MCP/connector 明确标注通过、失败或未配置；skip 不能伪装为通过。
- **文档与迁移**：CHANGELOG、用户/管理员手册、兼容说明、数据迁移与恢复步骤和实现同步。

建议在每次范围冻结时给出一页 Release Brief，只回答四个问题：解决谁的什么问题、明确不做什么、怎样证明完成、失败后怎样恢复。


---

## 后续计划（第99波起）

> 第87–91波已用于交办台/任务单 UX 打磨并随 2.4.1 发布；第95–98波（再开一回合、悬停快速操作、Layout 精简、交办台附件、历史轮次验收报告、真实调度波次、执行模式显式选择等）随 Escapade 2.5.0（2026-08-09）发布；3.0.0 默认切换未做，因正式外部受试者人因验证尚未执行（用户 2026-08-03 决定暂缓）。
> **2026-08-10 编号纠正**：本文件同日早些时候曾把 UX 迭代线误编为第92–95波，与代码中已交付的第95–98波冲突（波次是唯一序号），已顺延为第99–102波。

### 3.0 前 UX 迭代线（2026-08-10 拍板立项：先优化交办台 UX，再收口）

> 立项理由（用户 2026-08-10）：交办台流程 UI/UX 需进一步优化后才收口，重点为**任务单信息架构**与**进度/状态反馈**（允许大幅优化乃至重构）。顺序必须先优化、再做人因验证、最后默认切换——**在优化前的 UX 上做人因验证等于浪费验证**（P3 出门闸要求在最终形态上达标）。三波串行，每波出门再进下一波。

**第99波 · 交办台 UX 走查与诊断（诊断波，零交互变更）**
- 四旅程逐步走查：立单下发 / 推进续办 / 待决决策 / 收工归档，记录每步点击数、犹豫点、断头路；与经典模式做同任务效率对比（完成时长、点击数）
- 启发式评审（Nielsen 十则）+ 双主题 / 390px / 键盘焦点 / 输入不中断场景的视觉与交互走查
- 用户日常 dogfood 不爽点随时收录（主渠道，不等正式访谈）
- **`preview-shell.js` 架构摸底**：该文件已 192KB / 5000+ 行，承载立单、任务单、档案、决策抽屉全部逻辑；评估按域拆分方案（只出方案与风险清单，本波不动手）
- 产出与出门：UX 问题清单（每条含复现路径、P0/P1/P2 分级、建议修法、验收标准），冻结为第100波范围；本波不改变任何交互
- **走查已交付（2026-08-10）**：[`archive/optimization-plan/08-task-sheet-ux-audit.md`](archive/optimization-plan/08-task-sheet-ux-audit.md)——代码级事实走查，任务单 IA（A1–A7）+ 进度/状态反馈（B1–B7）共 14 条分级清单、preview-shell.js 拆分方案、第100波方案 A（渐进）/方案 B（三段式重构）分叉；**方案 B 已拍板（2026-08-10，用户选定，见第100波）**

**第100波 · 交办台任务单三段式重构（✅ 2026-08-10 已交付）**
- 拍板范围（`archive/optimization-plan/08-task-sheet-ux-audit.md` §6 方案 B）：任务单重排为「**现状头**（五态+速报 v2+可展开进度清单）/ **结果与行动**（收工·停工·待决前置 + 控制台收敛为头部内联行，页脚去经典 primary）/ **过程**（默认折叠，现场镜头=纪要+班组合一 + 原始记录+台账）」；A1–A7、B1–B7 全量覆盖，P2 记档可顺移
- 实施次序（硬约束）：① `preview-shell.js` 按域拆分**先行**（纯搬家、零视觉变化，独立 commit）→ ② B1 速报 v2 + B2 可解释进度（与结构无关的 P0，可单独发布）→ ③ 三段式重构主体（先出视觉稿，走 v4-glass token 体系）
- 每项改动过既有门：双主题截图回归、390px、a11y、输入不中断回归、经典零回归闸、五态首屏结构快照断言
- 出门：清单逐项销号 + 全量回归绿；随 Escapade 修订版发布，走既有发布门
- **交付记录**：先以独立 commit 完成 `preview-shell.js` 五域拆分，再落地现状头 / 结果与行动 / 可折叠过程、现场+班组合镜、速报 v2 与可解释验收项；浅色主题经 dogfood 复核改为与现有青花体系一致的清透白，移除大面积灰/米色与禁用态灰块。A1–A7、B1–B7 销号及自动化证据见 `archive/optimization-plan/08-task-sheet-ux-audit.md` §8。

**第101波 · 正式人因验证 + 收口准备（⏭️ 2026-08-10 用户决定跳过，3.0 收口就此搁置）**
- 原计划：按 `docs/PRETENDER-PLAN.md` §3 规程执行**外部受试者**人因验证（在优化后形态上）：打开任务到正确复述「离开后发生了什么」≤10s；可回滚/部分恢复/不可逆判断正确率 ≥90%；北极星四指标全测；验证发现分级（阻断项当场修复复测、非阻断项入 post-3.0 清单）；收口准备（Release Brief / 发布物正名预案 / 回滚预案）；出门 = **P3 Product Ready 正式宣告**
- **决定记录（2026-08-10，用户）**：跳过正式外部受试者人因验证；**产品首页保留 Escapade v2.5.0 版本号，不切 3.0.0 默认壳、不做 3.0 正名**。影响：P3 Product Ready 不正式宣告，第102波默认切换前置（101 出门）消失，3.0 收口线整体搁置。第100波三段式重构成果已随 Escapade 2.x 交付，不浪费，只是不对外唤作 3.0。本波保留为可回头记录，不删除；若未来重新立项 3.0，需从本决定重新评估。

**第102波 · Pretender P4 第二切片 — 3.0.0 默认切换与发布（⏸️ 暂缓，随 101 跳过而搁置）**

按 `docs/PRETENDER-PLAN.md` v4 P4 原计划：新壳层默认开（经典可切）、版本三角 bump `3.0.0`（`00-boot.js` / `package.json` / `facts.json`）、CHANGELOG / USER-GUIDE / 发布物正名（解除 §2.2 品牌冻结）、发布门同 2.2/2.3 三门（范围冻结 / 测试 / 打包）。
前置条件（原）：**第101波出门**（人因验证达标）；以及 **P4 硬化终审剩余项**（安全红队终审、性能终验、双主题/双语/a11y 终审、离线升级、数据迁移与恢复演练，第86波只交付了工程硬化切片）。
**搁置状态（2026-08-10；2026-08-27 衔接澄清）**：因第101波跳过、产品首页保留 v2.5.0，本波暂缓执行。新引擎线重新立项不自动恢复本波；是否恢复默认切壳须另行拍板并重新评估人因与切换前置。

### post-3.0 退出线（不计入 3.0 交付工期）

**2026-08-27 触发点修订**：以首次默认启用新壳的公开 Release 为起点，其后第 1 个公开 Release 保留经典；最迟第 2 个公开 Release 且不晚于该起点后 6 个月进入强制退出评审（22 号方案 §8 对旧 v4 C2 的显式衔接）。仅发布引擎版 3.0 不启动双壳退出时钟。门绿退出；仍有 P0/P1 红项则恢复经典默认或阻断下一公开 Release 并成文整改，不得按日历强删安全退路。

### Pretender 3.0 重新立项 · Agent SoC 微架构收敛线（2026-08-27 拍板）

> **决定记录（2026-08-27，用户）**：重新立项 Pretender 3.0，版本核心改为引擎侧迭代；本轮评审进一步明确「先取得足够证据，不统一等待长期真实用户数据」。原壳层 P1–P3 工程成果保留，正式外部人因验证仍未执行；P4 默认切壳、发布正名保持搁置，是否恢复另行拍板。品牌冻结与通用安全／恢复／升级门继续有效。

**目标与边界**：让每个验收成功的任务更便宜、更快、更可控。保留 15 项候选方向 + 4 项排除，但不要求全部落地；SoC 仅为分析比喻，不宣称同类最优、天然语义等价或数量级收益。#2 拆为执行结果缓存／观察去重，#13 拆为预算保护／自适应降级，#14 拆为资源隔离／模型策略，分别验证。

**证据三类**：A＝确定性测试＋本地真实工具基准；B＝固定任务集上的真实模型／后端对照；C＝收益边界模拟＋限定工作流验证。真实模型测试不等于真实用户数据；长期使用数据主要用于扩围与总体收益评估，不是所有候选的入场门。

**首批六项范围（待实施／验证，逐项独立，不同时启用）**：

1. **第 0 步计量校准**：先修 E0/E1 抽样明细被当总量的口径，分清 turn/task、HTTP attempt、费用来源与缺失覆盖；再做热点统计。用已知合成账目与固定夹具验收，无需长期日志或新后台服务。**✅ 核心 2026-08-27 已交付**（econ_call_totals 不抽样总量 + econ_summary_call 摘要归属 + 报表 schema 2 对账三分断；合成 32 断言与离线真链路 e2e 全绿，见 [`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md) §4.2）
2. **#1 Prompt Cache 纪律验证**：固定多轮请求＋真实 provider 的冷／热缓存与费用回执；布局变更加任务质量对照。
3. **#6 已有只读 worker pool 增量验证**：复用 21-E2，与当前 legacy 而非仅与串行比较；构造 >8 批、争用／故障／取消，用实际本地工具测量。
4. **#2a 受限结果缓存**：资源版本与权限明确的白名单，验证失效和零命中开销；不捆绑观察压缩。
5. **#13a 预算保护基础层**：预警、在途／收尾预留、停止新增调用与暂停；暂不自动换模型或激进摘要。
6. **#3 或 #9 的一个限定场景试验**：批量输出或宏融合，固定真实模型任务集验证质量、总成本和失败重试。

**配套与后排**：#12 锁审计前移为缓存／并行安全配套；#14a 有实际竞争负载再安排。#2b 先补可用的按需回载，#7 预取排其后；#4/#10 按固定任务集另行验证；#11/#13b 的模型降档必须与 #15 升级／暂停闭环一起验收；#5 模板提议走 R2 人工发布纪律，#8 投机先验证受控 DAG 的收益边界。暂缓不等于统一等待几个月用户数据。

**红线与发布门**：只读不自动等于可缓存／可安全投机；命中与预执行都要验证权限和资源状态。独立开关、默认关或有界 shadow、先单轴后组合；overall 退化目标 ≤1pp，固定任务集配对重复并报告置信区间，证据不足不宣告非劣；权限／配对／checkpoint／审计零回归。总费用包括失败、重试、摘要、升级和后台工作。发布前以 Release Brief 冻结必交项、目标任务族、收益阈值、默认启用范围与回退；全部默认关闭不冒称用户收益。20-T1/C1 的现有阻断不自动解除。

详细架构、逐项验收与执行序见 [`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md)。

### 第103波起 · 编排方法论升级 — MicroAgent 论文借鉴（2026-08-10 立项，3.0 搁置后提前）

`docs/optimization-plan/07-microagent-lessons.md`（2026-08-10 立）：MicroAgent 论文 × Ruyi 逐项对照（主会话核实），产出 M1–M6——编排上下文分级注入（P0）、确定性节点扩展 + vote 门防误杀、verify 节点输入覆盖率职责、HB360 单轴消融纪律、模板方法论工具、O3 证据回溯升级。与 06（HB360 成本收敛）互为姊妹篇，分 A–D 四个候选波次。原计划排在 3.0 之后；**2026-08-10 用户决定跳过第101波、3.0 收口搁置，本线提前推进**（在 Escapade 2.5.0 线上）。

**候选 A 波（✅ 已交付）**：M3（verify 输入覆盖率）+ M4（单轴消融纪律）。
- **M3 已交付（`9696483`）**：`QUALITY_GATE_OUTPUT_SCHEMA` 加可选 coverage 字段（不破坏存量 verify）+ 质量门 prompt 引导逐项核验 + 后端 unhandled 收紧（`gate_uncovered`）；e2e（quality-gates + quality-workflow + prompt-snapshot）+ build --check 全绿。实施文档 [`archive/optimization-plan/09-m3-coverage-gate.md`](archive/optimization-plan/09-m3-coverage-gate.md)。
- **M4（流程项，不涉代码）**：实施文档已落 [`archive/optimization-plan/10-m4-ablation.md`](archive/optimization-plan/10-m4-ablation.md)——06 各优化项按「波次打包」上开关无法单轴归因，改为「每项独立开关 + 单轴回测 + 全量累进」，归因轴对齐工作流/工具/上下文三轴，含消融记账模板。**已交付（`bcd8fa7`）**：消融记账模板 + 三轴归因（工作流/工具/上下文）已成文。

**候选 B 波（✅ 已交付）**：M1（编排上下文分级注入，**唯一 P0**）+ M6（O3 证据回溯）。
- **M1 实施文档已落** [`archive/optimization-plan/11-m1-context-tiering.md`](archive/optimization-plan/11-m1-context-tiering.md)：把 `09-workflow.js:647` 单一 `contextText`（所有节点同一份）升级为「全局层 + per-node 覆盖」--节点对象（L173）加 `context` 字段、contextPrefix（L647）追加节点层、节点 schema（L1883）补描述；节点无 context 时行为逐字节不变（存量模板零迁移）。**已交付（`0b3100d`，含节点级 context 注入 + 对抗加固 + e2e）**。
- **M6**：O3 自检升级为证据回溯，并入 06-O3，已随 R1 Evidence Graph 完成（R1 即 M6 的工程化落点）。

**候选 D 波（07 §5 · ✅ 两工具已交付 2026-08-13）**：M5 高频模板方法论工具已落地两个——① `codebase_symbol_search`（codebase-audit 符号定义/引用检索）② `debug_hypothesis`（debug-root-cause 假设/实验/证伪状态机）。均过第 49 波新工具入库全部门（契约 + fake 回归 + description 审计 + tool-dispatch 行为锁 + facts 门面数字），见 [`archive/optimization-plan/17-m5-methodology-tools.md`](archive/optimization-plan/17-m5-methodology-tools.md) 与 [`archive/optimization-plan/18-m5-debug-recorder.md`](archive/optimization-plan/18-m5-debug-recorder.md)。data-insights 候选及 M4 消融收益验证待后续逐个启动。

**后续候选 C–F · Agent 架构研究补充（2026-08-10 纳入；不代表自动实现）**：在 MicroAgent M1–M6 之上，新增五段受控闭环：R1 claim-level Evidence Graph（P0，M6 的工程化落点）→ R2 从已验收轨迹归纳、人工发布的 Workflow Candidate Factory（P1）→ R3 基于 M4/HB360 的离线 Champion–Challenger Lab（P1）→ R4 Local Memory Graph（P2）与 R5 Replan Patch Ledger（P2）。所有能力都止于候选/提案，禁止自动发布模板、篡改记忆、扩大权限或在线学习。详细的架构、分期、验收和暂缓项见 [`optimization-plan/12-agent-architecture-research-roadmap.md`](optimization-plan/12-agent-architecture-research-roadmap.md)。

- **候选 C（✅ 已交付）**：M2 确定性结构节点 + R1 Evidence Graph；先将“断言/结论 → 工具结果/文件片段/来源/人工确认”变成可校验关系。**R1 设计文档已落** [`archive/optimization-plan/13-r1-evidence-graph.md`](archive/optimization-plan/13-r1-evidence-graph.md)（P0，证据契约 + 引用校验 + 脱敏 + 威胁建模 + fake e2e，M6 工程化落点）；**M2 设计文档已落** [`archive/optimization-plan/14-m2-deterministic-nodes.md`](archive/optimization-plan/14-m2-deterministic-nodes.md)：vote 防误杀（abstainThreshold 低置信弃权，默认 0 存量零迁移）+ coverage/propagate 确定性节点（机器版 coverage 是 M3 校验源 + R1 evidence 数据源）。**阶段 C 全完成（R1 `935ad73` + M2 `caf7e57` + C1/C2/C3 均已交付）**。
- **候选 D（⏸️ 暂缓）**：R2 Workflow Candidate Factory；只使用充分验收、脱敏且证据完整的轨迹，候选经隔离回放和用户确认后才可成为项目模板。
- **候选 E（⏸️ 暂缓）**：R3 Champion–Challenger Lab；不做线上 MCTS，先对受限变体在固定基准和 holdout 上做可重放的单轴/全量对比。
- **候选 F（✅ 已收口）**：R4 Local Memory Graph 已完成 S1/S2/S3（关系存储 + 冲突检索 + gate 自动提议 + confirmed 图确定性聚类 + review-only 过期建议 + 孤儿边提示，`8effffc`/`0b69856`/`3b8bdf7`）；R5 Replan Patch Ledger 已完整实现（触发→提案→review 生成 changes→审批→apply/rollback 端到端闭环，`111723c`/`6922e48`/`26e1186`/`40d0113`/`292cf29`）。R2/R3 暂缓。
- **明确暂缓**：基于相关性校准的高阶 vote，及任何在线 RL/自动训练；前者需 R1/R3 产生的 holdout 可靠性数据，后者最多作为独立、脱敏、离线的远期导出能力。

**运行时优化性价比候选线（2026-08-15，shadow 已启用、非纯收益）**：完成 AgentRx、AgentDiet、工具检索、上下文治理、模型/预算路由、DAG 调度、推测执行、语义事务、Windows 感知与 KV cache 等方向的去重和成本收益评审。`runtimeOptimizationShadowV1` 默认开启，只旁路计算/脱敏记录，不改变工具结果、上下文、权限、retry 或记忆。基础 60/20/30 合成门虽通过，但后续 283 条检索、89 条 observation、59 条失败分类与 1,000 指纹探针的对抗审计给出 `mixed_benefit_with_identified_costs_and_blockers`：T1 正例收益显著且无样本内退化，但攻击/无关 query 有误召回和大 catalog 线性成本；C1 发现纯文本错误漏保护、超宽结构化结果非法 JSON、重复压缩非幂等三个 High，**主动启用阻断**；F1 对部分写操作 transport ambiguity 分类不足，但仍 fail-safe、只保留 telemetry。Recovery Brief/自动恢复未准入；完整 AgentRx/AgentDiet、学习型路由/调度及新运行时服务继续暂缓。详细证据与修复前置门见 [`optimization-plan/20-runtime-optimization-cost-benefit.md`](optimization-plan/20-runtime-optimization-cost-benefit.md) §0.4。

**工具调用经济性校准与收敛线（2026-08-27 状态同步）**：E0 三层账本、E1 报表、E2a worker pool／E2c 重放、E3 参数双视图与 E5 元工具链已有实现；主动优化开关仍关闭，E2b/E4 延后，HB360 历史对账 blocked/deferred。E0/E1 抽样明细被当总量的口径缺陷已随 22-S0 修复（不抽样总量事件 + 摘要调用归属 + 报表以真实总量为事实源），基线自此可信；后续与 22 号线共用计量、缓存和并行实验；可用构造夹具／固定真实模型任务验证限定范围，不等待长期流量，也不冒称历史对账已通过。旧 HB360 的 `1,739` 合成轮次不等于模型调用，`10.1–10.4/任务` 等数字保留为历史样本口径，不直接外推当前版本。已有 read 重放相对 serial 的 p95 -26% 是既有并行能力，legacy == pool，不是新 pool 增量收益。原 21 号线量化目标保留为候选门，须基于校准后的当前对照和适用任务范围冻结。20-T1/C1 仍按各自原有数据与安全门管理。详见 [`optimization-plan/21-tool-call-economics-convergence.md`](optimization-plan/21-tool-call-economics-convergence.md)。

### Traveler 4.0（概念稿）

`docs/TRAVELER-CONCEPT.md` v0.1 已立（可迁移的任务旅程 / Portable Missions），非范围、版本或发布时间承诺；其实施不得抢占或稀释 Pretender 3.0 收口。

---
