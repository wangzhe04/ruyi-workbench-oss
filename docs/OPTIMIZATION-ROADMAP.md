# 如意 Ruyi 优化路线图（当前版）

> 本文只保留**当前发布线、发布准入与后续计划**；已交付波次历史移入 [`archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md`](archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md)（第46–86波）与 [`archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md`](archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)（第1–45波）。
> 当前排期以本文「后续计划」为准；新引擎版 Pretender 3.0 的范围、证据与发布门见 [`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md)，第 103–107 波的结构前置、上下文演进与出门序列见 [`optimization-plan/23-architecture-repayment-sequence.md`](optimization-plan/23-architecture-repayment-sequence.md)；第 108–110 波（出门前提示词自我认知／制图与交互／结构精简）见本文「第 108–110 波」节。`docs/PRETENDER-PLAN.md` v4 保留为旧壳层线依据，不再统管新引擎线。

---

## 发布线、产品代号与内部波次（2026-07-24 起）

对外发布与内部交付分开管理：**版本号告诉用户可安装、可回退、可比较的产品版本；波次只服务于研发拆解、验证和路线图追踪。**两者不再一一映射。

| 对外产品线 | 技术版本与 Git tag | 面向用户的写法 | 状态 |
|---|---|---|---|
| **Escapade** | `v2.x.y` | **如意 Ruyi Escapade 2.0**；修订版写作 Escapade 2.0.1、2.1 … | 当前大版本；源码版本与 Git tag 已到 `v2.6.2`；`CHANGELOG.md` 最后已归档发布条目为 `v2.6.2`（2026-08-27） |
| **Pretender** | `v3.0.0` | **如意 Ruyi Pretender 3.0** | **重新立项（2026-08-27）**：版本核心改为引擎侧 Agent SoC 微架构迭代（见「Pretender 3.0 重新立项」节与 [`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md)）；原壳层线 P1✅ / P2✅ / P3 工程✅，P4 默认切换与发布保持搁置，不因重新立项自动恢复 |

- Release 标题使用产品名与主次版本，不加冗余的 `V`；技术 tag 保持短、稳定且可供脚本解析（当前技术基线为 `v2.6.2`）。离线包也继续用短文件名（如 `Ruyi-v2.6.2-full.zip`），避免 Full 包在 Windows Explorer 的路径预算中失效；源码／tag 的版本号不替代发布物与发布状态核验。
- `第N波`、`Nx` 等只表示内部工作切片；一个 Release 可以汇总多波，一个波也可只在后续补丁版发布。只有范围冻结、测试与打包门通过后，才决定是 `2.0.x` 补丁、`2.x` 功能版本或下一主版本。
- 每个对外大版本以一个产品代号统摄体验目标；Pretender 3.0.0 正式发布批准前不把 Pretender 名/3.0 版本号混入用户界面、下载名或兼容承诺（22 号方案 §8 的品牌冻结纪律）。

---

## 当前状态（2026-09-02）

| 线 | 状态 | 依据 |
|---|---|---|
| **Escapade 发布线** | 当前源码与技术 tag 为 `v2.6.2`；`CHANGELOG.md` 已归档 `v2.6.2`（2026-08-27，固定预算上下文压缩与安全重播种），后续变更进入 Unreleased | `ruyi-workbench/package.json`、git tag `v2.6.2`、`CHANGELOG.md` |
| **Pretender 3.0 交付线（🔁 重新立项：核心改向引擎侧）** | P1 Data & Contract Ready ✅；P2 Preview Ready ✅；P3 工程切片 81–85 全部收口 ✅，**正式外部受试者人因验证未执行**；P4 第86波硬化切片已交付，第87–91波用于交办台/任务单 UX 打磨并随 2.4.1 发布；**2026-08-10 拍板先跑 3.0 前 UX 迭代线再收口，第99波走查与第100波三段式重构已交付**；**同日用户决定跳过第101波（正式人因验证）、产品首页保留 v2.5.0，不切 3.0.0 默认壳、不做 3.0 正名 → 3.0 收口线整体搁置（第102波随 101 跳过而暂缓）**；**2026-08-27 重新立项：版本核心改为引擎侧 Agent SoC 微架构迭代（[`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md) 与本文「Pretender 3.0 重新立项」节），原壳层 P1–P3 成果已随 Escapade 2.x 交付，P4 默认切换保持搁置** | `docs/PRETENDER-PLAN.md` v4、`docs/PRETENDER-METRICS.md`、第99/100波记录 `docs/archive/optimization-plan/08-task-sheet-ux-audit.md` |
| **第 103–107 波架构／上下文前序列** | **推进中**：第 103、104 波与第 105 波总门已交付。105a–105g 均经各自采用门默认开启并保留显式回退；32K×20–28K 真实总门再次确认 105f 单发优先有净收益（实体 88.9%、跨块 87.5%、5 次调用），≤4 块 refine 无净收益保持默认关，>4 块 user 大纲因 8 块至少 9 次串行调用／真实基线超 8 分钟而撤掉，overlap 不实施。105g 保留默认开启；超长 history-24 事实表甜点门将默认上限从 16 提到 64（82.8% 实体保留，6 次调用，成本/延迟仍在可接受增量内）。**106 已开工**：#13a／13a-t 预算保护基础层＋长命令时间预算已交付（默认关闭，A 类合成门 44 项全绿）；#1 G1 保持默认关、G2 经 DeepSeek v4-pro Responses 真实 A/B 门后默认开启；#2a 在 4×2MB 多文件真实重复读取门中确认工具阶段耗时约降 64%，已默认开启并保留显式回退。**#3 已收口**：design-and-decide option 扇出真实配对门实测批量臂 −33% 调用／−25% 费用但深度变薄、墙钟 +10%，裁决条件性正收益、模板不翻默认。106 波至此全部收口；**2026-09-02 新增第 108–110 波（提示词自我认知／制图与交互／结构精简），107 发布批准点保留编号、执行序排在 108–110 之后** | [`optimization-plan/23-architecture-repayment-sequence.md`](optimization-plan/23-architecture-repayment-sequence.md)、本文「第 108–110 波」节 |
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
2. **#1 Prompt Cache 纪律验证**：固定多轮请求＋真实 provider 的冷／热缓存与费用回执；布局变更加任务质量对照。**✅ provider 层 2026-08-27 已验证**（deepseek-v4-flash 两次独立复现：热重发命中 96%、逐字节前缀匹配（改一词归零）、追加式布局第 4 轮守住 97% 命中、易变前置每轮全 miss，四轮费用估算差 ~9×；缓存块 64 token。证据 `benchmark-results/prompt-cache-22-1/`；Ruyi 自身布局收敛与跨子 Agent 共享前缀未闭合）
3. **#6 已有只读 worker pool 增量验证**：复用 21-E2，与当前 legacy 而非仅与串行比较；构造 >8 批、争用／故障／取消，用实际本地工具测量。**⏸️ 2026-08-27 热点基线后降级为数据触发**（真实负载 wideReadBatchesOver8=0、readOnlyBatchShare≈1%，无增量验证对象；重启条件 = 报表出现显著纯读宽批／混合只读岛）
4. **#2a 受限结果缓存**：资源版本与权限明确的白名单，验证失效和零命中开销；不捆绑观察压缩。
5. **#13a 预算保护基础层（2026-08-27 提前至 #2a 之前）**：预警、在途／收尾预留、停止新增调用与暂停；暂不自动换模型或激进摘要。随批附工具级切片候选 **13a-t 长命令预算策略**（热点基线实证：powershell_run 占工具墙钟 87.6%，7 条 >60s 命令吃掉该工具约八成时间，最差单条 28 分钟失败且 stdout 达 2.51MB——时间与输出治理是当前最大杠杆）。
6. **#3 或 #9 的一个限定场景试验**：批量输出或宏融合，固定真实模型任务集验证质量、总成本和失败重试。

**热点基线（2026-08-27）**：基于校准后口径对本机 dogfood 日志（07-27→08-27，18 会话／83 回合）完成第一份真实负载画像——单调用输入 token p50 62K（86% 已走缓存价）、工具墙钟约七成集中在串行 shell 长命令、元工具链与参数历史确认不是成本中心。完整数字、口径边界与排序影响见 [`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md) §4.3「热点基线记录」。

**配套与后排**：#12 锁审计前移为缓存／并行安全配套；#14a 有实际竞争负载再安排。#2b 先补可用的按需回载，#7 预取排其后；#4/#10 按固定任务集另行验证；#11/#13b 的模型降档必须与 #15 升级／暂停闭环一起验收；#5 模板提议走 R2 人工发布纪律，#8 投机先验证受控 DAG 的收益边界。暂缓不等于统一等待几个月用户数据。

**红线与发布门**：只读不自动等于可缓存／可安全投机；命中与预执行都要验证权限和资源状态。独立开关、默认关或有界 shadow、先单轴后组合；overall 退化目标 ≤1pp，固定任务集配对重复并报告置信区间，证据不足不宣告非劣；权限／配对／checkpoint／审计零回归。总费用包括失败、重试、摘要、升级和后台工作。发布前以 Release Brief 冻结必交项、目标任务族、收益阈值、默认启用范围与回退；全部默认关闭不冒称用户收益。20-T1/C1 的现有阻断不自动解除。

详细架构、逐项验收与执行序见 [`optimization-plan/22-agent-soc-microarchitecture.md`](optimization-plan/22-agent-soc-microarchitecture.md)。

### 第 103–107 波 · 架构偿还、上下文演进与 Pretender 出门序列（2026-08-30 纳入）

> 原《第 103 波 · 架构偿还波（提案 v0.7）》经当前主树复核裁决为 **revise-major**：方向成立，但“command core 尚未落码”“17 模块”“227 E2E／6 unit”“7 处都重造原子写”等基线已过期。现状是 75b 单一 `decideIntervention()`、第 103／104 波均已交付，manifest 有 30 个拼接模块、目录重算为 243 E2E／14 unit（`facts.json` 由目录重算交叉校验），持久化面以 39 项机器清册管理。实施以 [`optimization-plan/23-architecture-repayment-sequence.md`](optimization-plan/23-architecture-repayment-sequence.md) 为准，不以原提案直接施工。

| 波次 | 冻结范围 | 出门与解锁 |
|---|---|---|
| **103 · 架构基座偿还（已交付 2026-08-31）** | 103a 路由 descriptor／旧新决策快照；103b 模块依赖图、`provides/requires` 与 `AgentLoopHooks` 隔离试点；103c 39 项持久化清册、durable JSON 原语与 context calibration 迁移 | 零用户可见行为；路由／鉴权可校验、无新增隐式依赖、每个私役迁移或豁免成文；已解锁 104 高触碰结构工作 |
| **104 · 内聚与上下文结构（已交付 2026-08-31）** | 视觉管线出 04、桌面 shell 出 10、07 职责拆分；压缩职责簇 + `CompactionPlan`；规则外置；契约快照与依赖图更新 | 零行为；主路径／forced-400／子代理与提示词快照等价；为上下文实验提供单一落点，已解锁 105 |
| **105 · 上下文行为实验** | `observation_recall`、session notes、实体校验、估算分桶、单发优先与 map-reduce 跨块保真 | 逐项受控取证；105a–105g 已通过各自门并默认开启（均可显式 false 回退），其余保持默认关／canary；为 #7 建立生产消费者，不通过不启用 |
| **106 · Agent SoC 证据收敛（推进中）** | #13a／13a-t 已交付默认关（回合 token 预算保护＋长命令时间轴软硬终态＋字节轴 shadow 计数，44 项合成门全绿）；#1 Ruyi 布局核查＋探针 S5 已交付（tools 计入缓存前缀、位置敏感，两轮复现），G1 在 16 轮×约 5.2K 字符历史真实门中仍保持默认关（cached-input 再降 11.2pp、墙钟升 22%），G2 经 DeepSeek v4-pro Responses 真实 A/B 门后默认开启（schema 冻结只追加＋layout_shadow 计量，26 项合成门全绿）；#2a 受限执行结果缓存已在大文件真实门后默认开启（白名单仅 file_read，mtime+size 版本失效＋命中重新验权＋cacheHit 诚实标记，34 项合成门全绿；4×2MB 文件、12 次读取、8 次命中，工具阶段约 311ms→112ms，但端到端墙钟仅约 1.5% 改善）；**#3 批量输出纪律限定场景已收口**（design-and-decide option 扇出逐项 vs 批量真实配对门，批量臂 −33.3% 调用／−24.7% 费用／+10.3% 墙钟、槽位深度变薄，裁决条件性正收益、模板保持逐项并行现状不翻默认，17 项离线机制门全绿）；#9 不再单做（22 号文 #3/#9 为二选一）；#7 仅在回载与耗时证据成立后进入 | 沿用 22 号单轴、非劣、权限／配对／恢复零回归门；不以完成数量冒充收益 |
| **107 · 出门准备与批准点** | Escapade 六类发布门 + 22 号 Release Brief；冻结默认启用、适用范围、回退和版本归属；**执行序改排在第 108–110 波之后（2026-09-02），冻结范围须覆盖这三波交付的默认启用项** | 形成 Pretender 3.0 发布批准材料；不自动恢复旧壳 P4／人因／默认切壳 |

**顺序纪律**：103 为 104 与后续高触碰结构改动的前置；104 为 105 的前置。105 不自动批准 106 的任何优化。#13a 若因已证实热点申请提前，只能在 103 出门后成文重排，不能静默并行占号。103／104 可随 Escapade 补丁或后续版本交付；105／106 若改变默认行为或 UI，版本级别由实际变更决定，不在规划阶段预写 `2.6.x` 或 `2.7`。

**独立 ASR 候选**：音频转文字与本地 Qwen3-ASR 是功能线，不占 103–107、也不是 Pretender 前置；若另行立项，只依赖 103a 的路由 descriptor，并复用 providers + `caps:['asr']`、独立 ASR 选择键、token 级转写端点和本地按需拉起边界。详见 23 号方案 §7。

### 第 108–110 波 · 出门前提示词自我认知、制图能力与结构精简（2026-09-02 立项）

> 立项理由（用户 2026-09-02）：Pretender 出门检测（107）之前还需三个优化波次：① 系统提示词详细排查与优化——agent 不知道 Ruyi 自身的很多功能（如 Playbook/skill）、不太能自己改 Ruyi 设置、不知道当前运行位置与版本号（一台机子可能装多个版本）；② 原生工具/ACC 增强——制图能力与 Mermaid 流程图等，提升日常交互体验与实用性；③ 系统结构化重构——拆分巨大文件、立 SPEC 规范、精简代码。编号按立项顺序取 108–110；**107 发布批准点保留编号、执行序排在这三波之后**。三波串行，每波独立取证过门再进下一波；不改变默认行为的切片不设开关、无回退面，改变默认行为的切片沿用独立开关＋显式 false 回退纪律。

**第 108 波 · 系统提示词「自我认知」排查与优化**

- 摸底结论（2026-09-02 主树核实）：主会话提示词 = stable 层（`buildStableSystemPrompt`，`06-provider-engine.js:1343-1369`，实测约 1300 字符）+ volatile 层（`buildVolatileParts` `:1372-1477` + `09-workflow.js:1560-1589` volatileExtras，实测约 4000 字符），文本统一外置 `06b-prompt-registry.js`（`PROMPT_PACK_VERSION` 锁版本），每回合动态重组装。子代理提示词同源但不含 skills/memory/mission（`08-agent-runs.js:510-517`）。
- 已确认缺口：**不含版本号**（权威值 `00-boot.js:26` VERSION，仅进 config/日志/`/api/health`）、**不含安装/运行位置与 overlay 标识**（`OVERLAY_ID`/`LAUNCH_MODE`，多版本共存机台上 agent 无法自答「我是谁、我在哪」）、**playbook/command 类条目被明确过滤不进提示词**（`06-provider-engine.js:1489-1491`）、无完整工具清单文本（只有数量与不可用名单）。已有：mcp_configure 改设置指引、workflow 模板清单、技能索引、工作台记忆指引。
- 范围：① Ruyi 自功能全量清单排查（版本/位置/overlay/playbook/skill/记忆/设置/模板/数据目录），逐项裁决「进提示词／进工具／不进」；② 注入层归属裁决——稳定信息进 stable 层保 prefix cache（105f/#1 缓存纪律：易变前置每轮全 miss），易变信息进 volatile；③ 子代理提示词是否同步补齐，逐项裁决；④ 长度预算重新分配（stable<1500、总长闸 800–12000，`prompt-snapshot.static.e2e.js`）。
- 过门：prompt-snapshot／meta-guard／software-engineering-prompt 三个 static e2e + prompt-benchmark 6 seed 配对 A/B（改前改后各一次，通过率不得退化）+ build --check；新增注入须先计量对 prefix cache 命中率的影响（#1 纪律）。

**第 109 波 · 制图与日常交互能力（ACC/原生工具）**

- 摸底结论：制图现状 = ACC `chart_image`（bar/line/pie/scatter → PNG，`office_chart.py:72-130`）+ `excel_chart`（嵌 xlsx，无 scatter）；**Mermaid/流程图渲染是全链路空白**——前端 marked 管线无 mermaid.js（`chat-render-primitives.js:114`），ACC Python 侧 0 命中，docs 无 gap 记录，agent 只能输出 mermaid 源码文本。
- 范围候选（逐项独立取证）：① Mermaid 渲染链路选型与落地（前端 vendor 渲染 vs ACC 侧出图），须过纯离线红线（CONTRIBUTING 五条；mermaid-cli/puppeteer 类重依赖原则上排除）；② chart_image/Office 出图能力补强；③ 日常交互体验项（沿用第 99 波 dogfood 不爽点收录主渠道）。
- 新增 ACC 工具的机械同步面（缺一即红）：`smoke_registry.py` 工具总数断言、`smoke_toolsets.py`、`smoke_descriptions.py` 规范审计、`BRIDGED_WRITE_PATH_ARGS` 快照表（`02-session-store.js:3103-3128`，写族工具发布检查项）、`dev-harness/fake-mcp.js` 双侧＋`fake-mcp-contract.e2e.js` 静态锁、`capabilities.e2e.js`。
- 过门：第 49 波新工具入库全部门 + 上述同步面 + 离线回归。

**第 110 波 · 结构化重构与代码精简（先规范、后拆分）**

- 摸底结论：app/src 30 模块 37,075 行，>2000 行 5 件（09-workflow 3370、02-session-store 3176、05b-kimi-bridge 2752、13-http-router 2603、01-config 2423）；前端 preview-shell.js 3557 行（第 100 波保守搬家后仍是前端第一大）、preview-shell.css 1982 行；dev-harness 55,080 行（约为 app/src 的 1.5 倍）。**无独立 SPEC/编码规范文档**，本波为新建。结构债存量（23 号文 §0 裁决）：101 个 `pathname===` 判定点未 descriptor 化、30 模块共享拼接顶层作用域（1 个 SCC、1481 个 provides 符号）、65 条前向边被 policy 冻结但未消除、04/07/10 内聚错位部分未偿还。
- 两阶段硬序：① **SPEC 先行**——新建编码/结构规范（模块职责、文件规模上限、注释与命名、测试断言纪律），须尊重 CONTRIBUTING 五条红线（纯离线、server.js 零 npm 运行时依赖、e2e 断言只加不改）与 23 号文既有裁决（如不得一次性强推全树 IIFE）；② **按 SPEC 逐文件拆分**——每文件独立 commit、纯搬家零行为变更（第 100 波先例），每步过生成器链（module-graph／route-inventory／facts／architecture-contract-snapshots／manifest-ranges `--write` + 对应 static e2e 独立重算）+ build --check + 全量 e2e。
- 明确不做：不改任何运行时行为、不设开关；dev-harness 测试瘦身须先破例评审「断言只加不改」红线，单列决策不夹带；realhist-fixtures 环境缺口（23 号文已记录）不夹带修复。
- 风险标注：拆分波及 46 件 static e2e 的 grep 锁与 facts 门面数字，工作量主要在校验链同步而非搬家本身。

### 已交付／候选编排方法论线 · MicroAgent 论文借鉴（不占第 103 波编号）

`docs/optimization-plan/07-microagent-lessons.md`（2026-08-10 立）：MicroAgent 论文 × Ruyi 逐项对照（主会话核实），产出 M1–M6——编排上下文分级注入（P0）、确定性节点扩展 + vote 门防误杀、verify 节点输入覆盖率职责、HB360 单轴消融纪律、模板方法论工具、O3 证据回溯升级。与 06（HB360 成本收敛）互为姊妹篇，分 A–D 四个**候选批次**。相关成果实际以独立提交交付，没有形成“第 103 波”实施记录；为保持波次唯一，本线不再占用第 103 波编号，未完成项继续按候选立项。

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
