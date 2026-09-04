# 25 · 第 111–113 波实施方案（压缩策略 v2／过程可见性／记忆与会话搜索向量化）

> **状态（2026-09-03）**：候选立项，编号 111–113 按提出顺序取；**执行序与是否排在第 107 波批准点之前待用户拍板**（本文 §4 给出建议）。三波均已完成主树只读摸底（HEAD `b80e36b`＋108a 工作树），落点与行号以本文为准。
> **性质**：111 为引擎侧行为切片（独立开关、默认关、逐项取证，沿用 22 号纪律）；112 先诊断后改，含前端零后端切片与一个后端行为切片；113 含新持久化面（索引文件）与可选外部能力（embedding 端点），必须过 103c 持久化清册与纯离线降级红线。
> **关联**：[24 号 第 108–110 波实施方案](24-waves-108-110-implementation.md)（统一纪律 §0 全部沿用）、[23 号](23-architecture-repayment-sequence.md)（CompactionPlan、105 系开关、realhist 门）、[22 号](22-agent-soc-microarchitecture.md)（证据三类、红线与发布门）。

---

## 1. 第 111 波 · 压缩策略 v2（引擎侧）

### 1.1 对外部只读分析的核查结论（2026-09-03）

| 论断 | 核查 | 证据 |
|---|---|---|
| L2 尾部只在 user 边界切；上限 min(16K, 预算×0.5)；最新一整回合放不下则一条不留 | **成立** | `recentTurnsBoundary` `10-context-governance.js:1877-1891`；`reseedTailMaxTokens:16000`、`tailBudgetRatio:0.5`（`context-governance-rules.json:107,152-156`）；`kept: boundary<=0?[]:history.slice(boundary)`（`:1922`） |
| L1 只改写「最近 2 条 assistant」之前的 tool 消息 | **成立，但边界是硬编码 `assistantsSeen===2`**，不在规则 JSON、无 token 预算变体 | `evaporateHistory` `:599-607`；影子评测 `measureObservationReductionShadow` `:640-643` 复用同一边界 |
| 重播种后不重附最近读过的文件 | **成立** | 全仓无 reattach 机制；session-notes 只存摘要切片文本，回注上限 2000 字符（`:512-533`） |
| 23 号文第 173 行记录病态循环，修复是放宽夹具窗口 | **机制成立、行号引用错**：循环记录在 `:173`（105a）与 `:243-244`（105e）两处，「只调夹具窗口」是 `:244` | 见 23 号原文 |
| 摘要 prompt 中文硬编码、标题字符串包含校验、接受英文别名 | **成立** | `summary.prompt`（`rules.json:110`）；`validateStructuredSummary` `:870-883`；别名表 `rules.json:111-117`，`minimumSections:4` |
| 历史内重复读同文件不去重 | **成立**：#2a 缓存命中仍全量展开写入历史 | `execCacheLookup` `12-tool-dispatch.js:384-405` |
| 估算常数／EMA／阈值／滞回 | **成立** | `estimateTextTokens` `09-workflow.js:3278-3287`；`noteEstimateSample` `:261-278`；阈值 0.8、`rearmMargin=max(2000, 2%窗口)`（`:2060-2062`） |
| 子代理共用 CompactionPlan | **成立，四点差异**：不传 `conversationWindow`、reseed 文案不同、splice 写回、不挂 session-notes | `maybeCompactSubHistory` `:1954-1992` |
| realhist-fixtures 本机不可用（23 号 :213） | **本机现状不符**：目录存在 288 文件，history-24/25/26 等均在 | `.gitignore:41` 排除、不受版本控制 |

已读文件的结构化来源：**不存在**——`actionAudit` 只收写族（`07-autonomy.js:908`），journal/checkpoint 只记写操作；唯一含「读了什么」的是 providerHistory 与 105a 快照（`writeHistorySnapshot` `:360-395`，带 rawRef）。

### 1.2 切片（每项独立开关、默认关、显式 false 回退；子代理路径逐项声明是否同步）

| 切片 | 开关（`01-config.js` 默认值区＋sanitize 表＋唯一判定函数） | 改动面 | 子代理 |
|---|---|---|---|
| **111a · L1 边界改 token 预算** | `runtimeEvaporateBudgetBoundaryV1=false` → `evaporateBudgetBoundaryEnabled()` | `evaporateHistory` 边界：从尾部累计 token，保护区 = clamp(`l1ProtectMinTokens`, 0.25×budget, `l1ProtectMaxTokens`)，规则键新增到 `context-governance-rules.json`（版本号 +1，内嵌 fallback 同构，`runtime-optimization.static` S 段锁同步重钉）；边界只允许落在 user 起点或「assistant(tool_calls)+其全部 tool 回复」单元起点；影子评测同时输出两种边界的可释放 token | 同步 |
| **111e · 历史内重复读取去重** | `runtimeHistoryReadDedupV1=false` → `historyReadDedupEnabled()` | 仅在 L1 缩减遍历内执行（不额外改写历史、不破坏 append-only）：同 path 且同资源版本（复用 #2a 的 mtime+size 键）的**较早** file_read 结果替换为指针文本（含 rawRef、指向后文第 N 次读取），最新一次保持全文 | 同步 |
| **111b · L2 尾部单元边界＋桥接** | `runtimeReseedTailUnitsV1=false` → `reseedTailUnitsEnabled()` | 新增 `assistantToolUnitStarts(history)`；`recentTurnsBoundary` 在最新 user 回合放不下时退化为按单元从尾部装入；`CompactionPlan.reseed` 在保留段首条为 assistant 时插入桥接 user 消息（registry 文案：「以下为摘要之后保留的最近工具往来，接续执行」）；切后调用 `repairProviderHistoryPairing`（`02-session-store.js:2039-2062`）并断言零孤儿；forced-400 路径同步 | 同步 |
| **111c · 重播种后重附最近读过的文件** | `runtimeReseedReattachFilesV1=false` → `reseedReattachFilesEnabled()` | 新增 `recentFileReads(history)` 扫描器（path→最新 rawRef/size/turnSeq，按 path 去重）；L2 出口构造 `<recent-files>` 有界块（预算 = min(8K token, 10%×budget)，每文件头部若干行取自 105a 快照 `rehydrateObservation(rawRef)`，不做新的磁盘读取）；贴在 reseed 摘要 user 消息之后、尾部之前 | 同步（无 session-notes 依赖） |
| **111d · 摘要 prompt 双语与标题容错** | `runtimeSummaryPromptI18nV1=false` → `summaryPromptI18nEnabled()` | `rules.json` 新增 `summary.promptEn`，按 `config.locale` 选包；校验前对标题做归一（去 `#`/`【】`/`:`、大小写不敏感）再匹配别名表；`minimumSections` 与状态标签规则不变 | 同步 |

顺序：111a → 111e（同在 L1 遍历）→ 111b → 111c → 111d。**前置建议**：110 波把 `10-context-governance.js` 的拆分序提前到第 2 位，让 111 在拆分后的模块上改行为；若 111 先于 110 执行，则 110 对该文件的拆分顺延到 111 出门之后（决策点见 §4）。

### 1.3 取证与门
- **A 类（确定性）**：`autocompact.e2e.js`、`context-governance.e2e.js`、`context-compact-v2.e2e.js`、`observation-recall*.e2e.js`、`unit/context-compact-trigger.test.js`、`unit/compact-marker-merge.test.js` 全部只加用例：① 单 user 回合 60 次工具调用夹具——111a 开时 L1 释放 ≥ 50% 观测 token 且不触发 L2；111b 开时尾部保留 ≥ 1 个完整单元且配对零孤儿；② 三次读同文件夹具——111e 开时只保留最新全文；③ reseed 后 `<recent-files>` 块存在、按 path 去重、不超预算；④ EN locale 下摘要 prompt 为英文且校验通过；⑤ 每个开关关时逐字节等价现状（快照断言）。
- **B 类（真实模型）**：复用 105 总门夹具与 `summary-long-context-pressure.js`；指标：实体保留率、跨块正确率、L2 触发次数／会话、压缩后首个工具调用为「重读已知文件」的比率（111c 目标 −50%）、每次压缩释放 token 与费用；配对重复 ≥ 3 次并报告区间；overall 退化 ≤ 1pp。
- **C 类（影子）**：新增 `compaction_shadow` 事件（两种 L1 边界的可释放 token、尾部单元数、重附块大小），进 econ 采样，不改行为。
- 默认翻开规则：A 类全绿 + B 类非劣且至少一项主指标改善（111a：L2 次数 −20%；111b：尾部为空的重播种比例 −80%；111c：重读比率 −50%；111e：压缩释放 token +10%；111d：EN 夹具校验通过率 ≥ ZH）。
- 回退：任一开关显式 false；彻底回退＝删开关三处＋判定函数＋对应函数分支＋规则键（版本号回退）＋新增 e2e。

### 1.4 明确不做
不引入 tokenizer；不做在线学习；不改 session store v2 与快照协议；不动 Claude／Kimi 引擎的原生压缩（外置压缩路径维持现状）；不做「跨会话」重附。

---

## 2. 第 112 波 · 过程可见性（「在干什么／干到哪／在等什么」）

### 2.1 摸底结论（2026-09-03）
- 服务端已发的进度事件族很完整：`tool_progress`（长工具心跳，`09-workflow.js:1904-1927`，仅 openai 引擎＋可中断工具）、`agent_workflow`（编排心跳 `:368-1185`）、`agent_resource`（等锁 `:2599-2897`、`08:883-1027`）、`budget_guard`（`:2184-2200`）、`compact`（唯一带 phase 的事件族）、`loop_recovery`、子代理族（`subagent_progress/mail/pool/no_progress`、`adaptive_tool_budget`）。
- **两壳把其中约十种事件静默丢弃**：`chat-stream-runtime.js:1220` 落 `default`，`preview-shell.js` 全文无引用（`tool_progress`／`agent_resource`／`budget_guard`／`loop_recovery`／`subagent_*` 细粒度／`adaptive_tool_budget`）。
- 无统一「当前在做什么」状态条：经典壳信息分散在工具卡片计时（客户端自算）、思考面板、步骤条、账本条、电量表五处；Preview 速报 v2 是「待决 > 班组单节点 > 最近一次 tool_use」的单句，且 Preview 壳完全没有上下文电量与压缩指示。
- 长命令无部分 stdout 直播（`powershell_run/script_run` 只 await 最终结果，`12-tool-dispatch.js:911-956`）；时间预算软／硬阈值默认关（`01-config.js:987-999`）。
- 编排全貌只在经典壳工作台画布（`agent-workflows.js:561-684`、`workbench.js:356-384`，2 秒轮询）；Preview 只挑一个当前节点。
- ETA 概念全仓不存在；「回来摘要」数据源是 Mission Change Ledger（`02-session-store.js:91-149`）——回合级突变点，不是逐工具调用叙事。
- 第 99／100 波 B1–B7 已全部销号，本波不重做。

### 2.2 切片
| 切片 | 类型 | 内容 | 门 |
|---|---|---|---|
| **112a · 诊断与状态机设计（零交互变更）** | 文档 | 三问 × 两壳 × 四场景（长命令／工具循环／多子代理编排／待决）走查表；把 §2.1 八条缺口＋dogfood 补录冻结为 112b–112d 范围；定义客户端派生状态机 `turnActivity = {phase: thinking|calling_tool|waiting_resource|waiting_you|compacting|orchestrating|idle, action, elapsedMs, stepIndex, waitingReason}` 与「事件 → 状态」映射表（服务端事件枚举 ↔ 前端 case 表机械对账） | 走查表与映射表入本文 §2.4 |
| **112b · 事件消费补齐（前端，零后端）** | UI | 两壳补齐 `tool_progress`（工具卡片内软／硬预算与等待态）、`agent_resource`（「等待资源：X，阻塞者：Y」）、`budget_guard`（回合预算警示条）、`loop_recovery`、`subagent_no_progress`／`adaptive_tool_budget`（子代理卡片状态行）；Preview 壳接入上下文电量与压缩指示（复用 `renderContextMeter`／压缩指示条） | 新增 `progress-events.static.e2e.js`：服务端 `onEvent({type})` 枚举与两壳 case 表对账（缺一即红）；`thinking-boundary.static`、`streaming-responsiveness.static`、`ui-bugfix.static`、`pretender-*` 静态锁；双主题＋390px 走查 |
| **112c · 统一状态条（两壳）** | UI | 由 `turnActivity` 驱动的一行：`阶段 · 当前动作 · 已运行 X · 本回合第 k 次工具调用 · 上次输出 Y 秒前 · （等待原因）`；经典壳置于输入框上方，Preview 壳升级速报 v2（`activityBrief` 改吃状态机，保留待决优先）；不承诺 ETA | `pretender-task-sheet.e2e.js` 真实浏览器五态截图；`turn-narrative.static`；状态机纯函数 unit（`dev-harness/unit/turn-activity.test.js`） |
| **112d · 长命令部分输出直播（后端行为切片）** | 引擎＋UI | 开关 `runtimeToolOutputStreamV1=false`：`powershell_run/script_run` 在 `tool_progress` 心跳中携带 ≤ 2KB 脱敏 stdout 尾部增量（复用最终结果同一 redact），前端工具卡片折叠区实时追加；Claude／Kimi 引擎路径不做（CLI 不透出） | `budget-guard.e2e.js`、`tool-dispatch.e2e.js` 只加用例；fake 长命令夹具；脱敏断言 |
| **112e · 时间预算软阈值默认开启评估** | 决策 | 112b 让 `budget_soft` 可见后，评估 `runtimeToolTimeBudgetV1` 软警告（不硬杀）默认开；需 dogfood 一周证据 | 单列 Release Brief |
| **112f · Preview 编排全貌** | UI（P1） | Preview「现场」镜头班组区改为节点列表（状态徽标＋每节点计时＋资源锁 chip），复用 `/api/agent-runs` 轮询数据 | `pretender-crew-lens.static` 只加 |

顺序：112a → 112b → 112c → 112d → 112f；112e 独立拍板。品牌冻结：新文案不出现 Pretender／3.0。

### 2.3 明确不做
不造 ETA；不重写 Mission Change Ledger；不把遥测 `logEvent` 转成流事件；不为 Claude CLI 引擎伪造心跳。

### 2.5 与 27 号管家线的衔接（2026-09-03）
用户拍板壳层线重新立项为工作台管家（[27 号](27-waves-115-117-steward.md)）后，本波收缩：112a／112b／112c 保留并前置（事件消费补齐与 `turnActivity` 状态机是管家 avatar 与「三问」的数据源）；112d 长命令输出直播与 112f 编排全貌并入 117d 线程抽屉；112e 独立拍板不变。交办台侧的新增 UI（112b 中的交办台电量表等）改为在管家线程抽屉内交付。

### 2.4 走查表与映射表（112a 交付，2026-09-04）

> 本节是 112a 的全部交付物：**零交互变更**，只把「服务端在说什么、两壳听见了什么、还差什么」冻结成可机械对账的三张表。
> 表里的每一格都由 `dev-harness/lib/stream-event-scan.js` 从源码扫出来，不是人肉抄的；`dev-harness/progress-events.static.e2e.js` 每次跑都重扫一遍，服务端新增事件而没人登记即红。

#### 2.4.1 事件全表（54 种，2026-09-04 扫描）

摸底时 25 号 §2.1 写的是「约十种事件被静默丢弃」——**实际是 20 种**。服务端下行事件共 **54 种**（含 `downstreamEvent` 直发的 `context_estimate` 与 `10-context-governance.js` 里 `emit` 发的 `session`／`error` 三种非 `onEvent` 形状），经典壳的 `switch` 有 34 个 case、`default: break` 静默丢弃，Preview 壳只认 5 种。

「状态机」列 = 112c 的 `turn-activity.js` 是否消费；「经典壳」「Preview」两列 = 该壳源码里是否存在对应的 `case`／`.type ===`／`.includes(.type)` 判定。三列全空的 11 种在 `progress-events.static.e2e.js` 的豁免表里逐条写明理由。

| 事件 | 发出点数 | 代表落点 | 状态机 | 经典壳 | Preview |
|---|---|---|---|---|---|
| `adaptive_tool_budget` | 1 | 08-agent-runs.js:940 | ✅ | ✅ | — |
| `agent_resource` | 9 | 08-agent-runs.js:883 | ✅ | — | — |
| `agent_workflow` | 17 | 09-workflow.js:195 | ✅ | ✅ | ✅ |
| `ask_user` | 1 | 04-permission-runtime.js:341 | ✅ | ✅ | — |
| `assistant_delta` | 16 | 05-claude-engine.js:113 | ✅ | ✅ | ✅ |
| `autonomy_grant` | 2 | 13-http-router.js:932 | — | ✅ | — |
| `autonomy_grant_consumed` | 1 | 09-workflow.js:2633 | — | ✅ | — |
| `budget_guard` | 2 | 09-workflow.js:2016 | ✅ | — | — |
| `compact` | 15 | 05b-kimi-bridge.js:242 | ✅ | ✅ | — |
| `context_estimate` | 1 | 09-workflow.js:1207 | ✅ | ✅ | — |
| `error` | 1 | 10-context-governance.js:2237 | ✅ | ✅ | ✅ |
| `failover` | 1 | 09-workflow.js:1945 | ✅ | ✅ | — |
| `kimi_plan_decision` | 1 | 05b-kimi-bridge.js:986 | ✅ | — | — |
| `kimi_plan_snapshot` | 1 | 05b-kimi-bridge.js:2350 | ✅ | ✅ | — |
| `loop_recovery` | 2 | 08-agent-runs.js:810 | ✅ | — | — |
| `meta` | 3 | 05-claude-engine.js:455 | ✅ | ✅ | — |
| `mission` | 12 | 02-session-store.js:1506 | — | ✅ | ✅ |
| `observation_reduced` | 2 | 09-workflow.js:2116 | — | — | — |
| `observation_reduction_shadow` | 2 | 09-workflow.js:2108 | — | — | — |
| `permission_decision` | 2 | 07-autonomy.js:768 | ✅ | ✅ | — |
| `permission_paused` | 2 | 07-autonomy.js:776 | ✅ | ✅ | — |
| `permission_request` | 2 | 07-autonomy.js:752 | ✅ | ✅ | — |
| `plan` | 1 | 07-autonomy.js:820 | ✅ | ✅ | ✅ |
| `plan_decision` | 1 | 07-autonomy.js:829 | ✅ | ✅ | — |
| `plan_note` | 1 | 09-workflow.js:2195 | — | ✅ | — |
| `process` | 6 | 05-claude-engine.js:474 | ✅ | ✅ | — |
| `question_answer` | 1 | 04-permission-runtime.js:316 | ✅ | ✅ | — |
| `raw_line` | 3 | 05-claude-engine.js:776 | — | ✅ | — |
| `raw_stdout` | 1 | 05-claude-engine.js:781 | — | — | — |
| `result` | 5 | 05-claude-engine.js:123 | ✅ | ✅ | ✅ |
| `resume_recovery` | 3 | 05-claude-engine.js:50 | ✅ | — | — |
| `self_check` | 1 | 09-workflow.js:2891 | — | — | — |
| `session` | 1 | 10-context-governance.js:2211 | — | ✅ | ✅ |
| `stderr` | 35 | 05-claude-engine.js:171 | — | ✅ | — |
| `steered` | 3 | 05b-kimi-bridge.js:2661 | — | ✅ | — |
| `subagent` | 11 | 05-claude-engine.js:552 | ✅ | ✅ | — |
| `subagent_mail_in` | 1 | 08-agent-runs.js:656 | — | — | — |
| `subagent_mail_out` | 1 | 08-agent-runs.js:830 | — | — | — |
| `subagent_no_progress` | 1 | 08-agent-runs.js:921 | ✅ | ✅ | — |
| `subagent_pool_proposed` | 1 | 08-agent-runs.js:826 | — | — | — |
| `subagent_progress` | 5 | 05-claude-engine.js:522 | ✅ | ✅ | — |
| `subagent_steered` | 2 | 07-autonomy.js:1787 | — | — | — |
| `subagent_usage` | 2 | 07-autonomy.js:1933 | — | — | — |
| `thinking_delta` | 7 | 05-claude-engine.js:658 | ✅ | ✅ | — |
| `todo` | 5 | 05b-kimi-bridge.js:1800 | — | ✅ | — |
| `tool_budget` | 1 | 09-workflow.js:1986 | ✅ | — | — |
| `tool_catalog` | 1 | 09-workflow.js:2528 | — | — | — |
| `tool_image` | 1 | 09-workflow.js:2844 | — | — | — |
| `tool_progress` | 3 | 09-workflow.js:1736 | ✅ | ✅ | — |
| `tool_result` | 17 | 05-claude-engine.js:721 | ✅ | ✅ | ✅ |
| `tool_use` | 14 | 05-claude-engine.js:677 | ✅ | ✅ | ✅ |
| `tool_use_update` | 1 | 05b-kimi-bridge.js:2269 | ✅ | ✅ | — |
| `turn_summary` | 3 | 05-claude-engine.js:978 | — | ✅ | — |
| `usage` | 6 | 05-claude-engine.js:763 | ✅ | ✅ | ✅ |

**传输面三点补充**（口径来自主树复核，写下来免得后续波再摸一遍）：
- 传输是 **NDJSON over HTTP**，不是 SSE 帧（`10-context-governance.js:2147`）；根 `emit`（`:2187`）把 `assistant_delta`／`thinking_delta` 按 50ms 窗口合批，其余事件先冲刷再写。
- 两个引擎入口各自**再包一层 `onEvent`**：Claude 侧（`05-claude-engine.js:1-13`）补 `traceId` 并喂 `turnSegments.consume`；Provider 侧（`09-workflow.js:1215-1228`）另补 `batchId` 与节流的 `context_estimate`。Kimi 不再包第三层，沿用 Claude 那层。
- **Preview 壳没有自己的读流器**：经典壳读到的每一行都经 `emitSessionStream`（`app.js:312` → `previewStreamSink`，`app.js:975`）转发给 `handlePreviewStreamEvent`。所以两壳看到的是同一份字节流，112b 才可能让它们共用一个状态机。

#### 2.4.2 `turnActivity` 状态机与事件→状态映射表

真身：`ruyi-workbench/app/public/js/turn-activity.js`（纯模块，零 import、零 DOM、零 `t()`）。单元门：`dev-harness/unit/turn-activity.test.js`。

**阶段（按优先级从高到低）**——同一时刻多个事实成立时，取用户最需要知道的那一个：

| 阶段 | 何时成立 | 为什么排这个位置 |
|---|---|---|
| `waiting_you` | 有未答复的 `ask_user`／`permission_request`／`plan`／`kimi_plan_snapshot` | 只有这一档需要用户动手，压过一切 |
| `compacting` | `compact` 处于 `started`／`running`／`applied` | 上下文在重建，此刻的「工具在跑」不是主线 |
| `waiting_resource` | `agent_resource:waiting` 未被 `acquired`／`released` 解除 | 卡住且有明确原因，比「在跑工具」信息量大 |
| `orchestrating` | 有活动的 `agent_workflow` 运行 | 班组视角概括，不逐个成员刷屏 |
| `calling_tool` | 有未回结果的主线 `tool_use` | 子代理自己的 `tool_use` 不计（由上一档概括） |
| `thinking` | 回合活着但以上都不成立 | 模型在产出（推理或正文） |
| `idle` | 回合未开始或已收尾 | 状态条整条隐藏 |

**事件→状态映射表**（33 种消费事件，与 `TURN_ACTIVITY_CONSUMED` 逐项对应）：

| 事件 | 对状态的作用 |
|---|---|
| `meta`／`process` | 开回合（`startedAt` 起表） |
| `assistant_delta`／`thinking_delta` | 开回合 + 刷新「上次输出时间」 |
| `tool_use` | 主线：步数 +1、登记活动工具；带 `subagentId` 则不计步 |
| `tool_use_update` | 改活动工具的名字 |
| `tool_progress` | 用服务端 `elapsedMs` 纠正计时；`budget_soft`／`budget_hard` 标预算档 |
| `tool_result` | 主线：注销活动工具、刷新「上次输出时间」 |
| `agent_resource` | `waiting` 进等资源态（带 `resources`／`blockers`）；`acquired`／`released` 解除 |
| `budget_guard` | 通知：`warning`→warn，`tripped`→attention |
| `tool_budget` | 通知：工具步数上限扩容 |
| `loop_recovery` | 通知：某工具在原地打转，第几次纠偏 |
| `failover` | 通知：主线路失败已切备 |
| `resume_recovery` | 通知：引擎会话失效、正在自动重开 |
| `subagent` | 登记成员与其 `start`／`end`／`retry`／`background` |
| `subagent_progress` | 成员进展文案 + 把「原地不动」计数清零 |
| `subagent_no_progress` | 成员停滞计数 + 通知 |
| `adaptive_tool_budget` | 成员工具预算变化 + 通知 |
| `agent_workflow` | 进／出编排态（`end` 解除） |
| `compact` | 进／出压缩态（`completed`／`failed` 都解除，否则会永远挂住） |
| `ask_user` → `question_answer` | 置／清待决（提问） |
| `permission_request`／`permission_paused` → `permission_decision` | 置／清待决（授权） |
| `plan`／`kimi_plan_snapshot` → `plan_decision`／`kimi_plan_decision` | 置／清待决（计划） |
| `usage`／`context_estimate` | 上下文电量（两壳共用同一份事实） |
| `result` | 收回合（成功／失败），**保留待决**——停在「等你拍板」是有效终态 |
| `error` | 收回合（失败） |

**故意不消费的 21 种**（`TURN_ACTIVITY_IGNORED`）：`autonomy_grant`、`autonomy_grant_consumed`、`mission`、`observation_reduced`、`observation_reduction_shadow`、`plan_note`、`raw_line`、`raw_stdout`、`self_check`、`session`、`steered`、`stderr`、`subagent_mail_in`、`subagent_mail_out`、`subagent_pool_proposed`、`subagent_steered`、`subagent_usage`、`todo`、`tool_catalog`、`tool_image`、`turn_summary`。它们是**内容**不是**过程状态**，多数已由两壳既有渲染路径处理；剩下 11 种确实没人管的，在静态门的豁免表里逐条写明理由与去向（班组内部往来那一组归 117d 线程抽屉）。

#### 2.4.3 三问 × 两壳 × 四场景走查表

「后」= 112b／112c 落地后的行为。四个场景取自 §2.1 的八条缺口。

**场景 A · 一条跑十分钟的长命令（`powershell_run`）**

| | 在干什么 | 干到哪 | 在等什么 |
|---|---|---|---|
| 经典壳 · 前 | 工具卡片写「运行中」 | 卡片本地秒表（标签页后台被节流后**停在原处不动**） | 无。时间预算的软警告／硬终态事件全被丢弃 |
| 经典壳 · 后 | 状态条：`正在调用工具 · powershell_run` | 服务端心跳纠正的权威计时 + `本回合第 k 次工具调用` | 超软预算→卡片与状态条同时转 warn；到硬上限→转 attention 并写明已中止 |
| Preview · 前 | 速报「正在运行命令」 | 回合起点粗算的时长 | 无 |
| Preview · 后 | 速报吃状态机，与经典壳同一句 | 同上 | 同上 |

**场景 B · 工具循环（同一个工具反复调用 / 回合预算逼近）**

| | 在干什么 | 干到哪 | 在等什么 |
|---|---|---|---|
| 经典壳 · 前 | 一张张工具卡片堆积 | 只能自己数卡片 | 无。`loop_recovery`／`budget_guard`／`tool_budget` 三族全丢 |
| 经典壳 · 后 | 状态条主句 + 右侧通知位 | `第 k 次工具调用`，且「已 X 没有新输出」在沉默 ≥10s 时才出现 | 打转纠偏第几次／回合 token 逼近或触到预算／工具步数上限被扩容，各一条有界通知 |
| Preview · 前后 | 通知位不进速报（速报是一句话）；打转与预算仍由经典壳承担 | — | — |

**场景 C · 多子代理编排**

| | 在干什么 | 干到哪 | 在等什么 |
|---|---|---|---|
| 经典壳 · 前 | 子代理卡片「执行中…」，停滞时无任何变化 | 无总览 | 无。`subagent_no_progress`／`adaptive_tool_budget`／`agent_resource` 全丢 |
| 经典壳 · 后 | 状态条 `班组在跑 · n/m 个成员在跑`；卡片状态行写「连续 N 轮没有新动作」（warn 档）与「工具步数 A→B」 | 成员数与在跑数 | 等资源时状态条升到 `卡在等资源`，并写出资源名与阻塞者 |
| Preview · 前 | 班组镜头挑一个当前节点 | 节点状态 | 无 |
| Preview · 后 | 等资源／压缩／跑工具三档由状态机接管（这三类轮询快照看不到），编排细节仍让给班组镜头 | 同上 | 同上 |

**场景 D · 待决（授权／提问／计划）**

| | 在干什么 | 干到哪 | 在等什么 |
|---|---|---|---|
| 经典壳 · 前 | 弹窗／卡片本身 | — | 弹窗关掉后回合看起来像卡死 |
| 经典壳 · 后 | 状态条置顶为 `等你拍板`（attention 档），回合收尾也不清 | — | 写明是「要不要允许 X」「计划等你批准」还是「有问题等你回答」 |
| Preview · 前 | 速报「等你拍板 · 待决 N 项」，可点开抽屉 | — | 只有件数 |
| Preview · 后 | **不变**（待决优先级最高，保持原样），状态机排在其后 | — | 同上 |

**两条不做**：仍不承诺 ETA（25 号 §2.3）；`112d` 长命令 stdout 直播与 `112f` Preview 编排全貌按 §2.5 并入 117d 线程抽屉，本波不做。

---

## 3. 第 113 波 · 记忆与会话搜索向量化

### 3.1 摸底结论（2026-09-03）
- 工作台记忆：文件型 `.md`＋frontmatter（`06d-memory-domain.js:1-33`），起草-确认双门写入；检索 `resolveMemoryPreflight`（`:1391-1442`）→ `rankRelevantMemories`（`:1334-1351`）纯词法（ASCII 词 ≥2 字符＋中文 2-gram 子串命中，命中长度加权 ×10 ＋类型加分），默认 Top-3（`MEMORY_RELEVANCE_MAX=3`），每轮 `loadMemoryRegistry` 重新 readdir＋读 16KB 文件头，无缓存，O(N)。核心胶囊（`resolveCoreMemoryState`，24 条／4200 字符）常驻不检索。R4 关系图为确定性连通分量，非语义。
- 会话搜索：纯前端子串过滤（`session-experience.js:62-79`）只查 title／summary／cwd，不查消息正文；`GET /api/sessions` 返回 7 字段元数据；`sessions/index.json` 只是元数据缓存；**无任何会话搜索 e2e**。
- embedding：全仓 NOT FOUND；provider／模型无 `caps` 字段（23 号 §7 的 `caps:['asr']` 提案未落地）；`PROVIDER_PRESETS`（`05-claude-engine.js:982`）无 embedding 模型。
- ACC `memory_*` 是独立 JSON 存储，迁移后对模型隐藏；无 sentence-transformers／embedding 依赖（numpy 仅用于视觉与图表）。
- 持久化清册已登记 memory-usage／meta／proposals／relations／session-*；**记忆正文 `.md` 本身未单独登记**（103c 缺口，本波顺带补登记）；`atomicWriteJson` 在 `01-config.js:1035`。

### 3.2 设计：三层检索＋排名融合
1. **L0 词法（现状）**：`rankRelevantMemories` 与前端子串过滤原样保留，作为基线与兜底。
2. **L1 离线向量（零依赖，永远可用）**：特征哈希（FNV-1a）把「中文 2-gram ＋ ASCII 3-gram／词」映射到 512 维带符号桶，TF-IDF 加权（IDF 按语料：记忆库或会话索引），L2 归一化为 `Float32Array`，余弦相似度；纯 Node 内建实现（`06d` 或新模块 `06h-retrieval-index.js`，落入 `0[56][a-z]?-` 层级正则）。索引文件：`<data>/memory/{global,project/<key>}/_index-v1.json`、`<data>/sessions/_search-index-v1.json`；条目键 = id＋内容哈希＋mtime，注册表加载时按 mtime 增量重建；写入走 `atomicWriteJson`；**登记持久化清册**（连同记忆正文 `.md` 缺口）。
3. **L2 provider embedding（可选，缺网／未配置即跳过）**：provider 配置新增 `embeddingModel`（可选 `embeddingBaseUrl`），模型条目引入 `caps:['embedding']`（与 23 号 §7 ASR 共用字段形状）；调用 OpenAI-compatible `/v1/embeddings`；向量按（providerId, model, 内容哈希）缓存于 `_embeddings-v1.json`；费用计 `kind:'aux', note:'embedding'`；任何失败降级为 L0＋L1，不阻塞回合。
4. **融合**：Reciprocal Rank Fusion（k=60）合并可用层，再叠加现有类型加分（project／preference／convention）；最低分阈值过滤噪声；Top-N、显式固定选择、排除项、冲突标记、核心胶囊语义全部不变。
5. **会话搜索**：新增 `GET /api/sessions/search?q=&limit=`（token 鉴权，进 `ROUTE_AUTH` 与 route-inventory）；索引单元 = title＋summary＋首条 user 消息＋末 N 条消息摘录（每会话 ≤ 4KB），从 `<id>.messages.ndjson` 在会话更新时增量刷新（或首次搜索时按 mtime 懒建）；返回 snippet＋score；前端侧栏在 q ≥ 2 字符时走 API（去抖 200ms），API 失败回退子串过滤。

### 3.3 切片
| 切片 | 开关 | 内容 | 门 |
|---|---|---|---|
| **113a · 记忆离线向量层＋融合** | `runtimeMemoryVectorRecallV1=false` | L1 索引、RRF 融合、注册表 mtime 缓存（顺带把每轮 readdir 改为 mtime 门控，开关关时也不改变结果集） | 新增 `memory-recall-quality.e2e.js`：40 条合成记忆 × 20 查询（含同义改写、跨语言、拼写差）Recall@3 词法 vs 融合，融合 ≥ 词法且 +10pp 才翻默认；9 件 `workbench-memory*`／`memory-*` e2e 只加；`durable-state-inventory --write` |
| **113b · 会话搜索索引＋API＋前端** | `sessionSearchIndexV1=true`（新增能力，旧路径保留为回退；显式 false 关闭） | 索引构建、`/api/sessions/search`、侧栏接入、无 e2e 的现状补第一件 `session-search.e2e.js` | route-inventory 重算、`facts` 不变、`repo-hygiene`（索引不含密钥：复用导出脱敏）、`capabilities.e2e` |
| **113c · provider embedding 层** | `runtimeProviderEmbeddingV1=false` | `caps` 字段、config schema（`CONFIG_SCHEMA` +1 与 normalize 回填）、`/v1/embeddings` 客户端（超时 10s、批量 ≤ 32）、向量缓存、aux 台账 | `provider-*` e2e 只加；fake-openai 增加 `/v1/embeddings` 桩；离线断网夹具必须回退 L0＋L1 |
| **113d · 维护面** | 无 | `POST /api/memory/reindex`、`doctor` 增加索引健康项、设置页显示 embedding 状态（未配置／已配置／上次失败） | `mcp-ops-gui.static`／`overlay-update-gui.static` 不受影响；新增静态锁 |

顺序：113a → 113b → 113c → 113d。

### 3.5 交付记录（113a／113b，2026-09-04）

> 本批只做 113a 与 113b（执行序拍板的范围）。113c（provider embedding，与 114a ASR 共用 `caps` 字段形状）与 113d（维护面）不在本批。

#### 113a · 记忆离线向量层＋融合（开关默认关）

| 项 | 落点 |
|---|---|
| 检索原语 | 新模块 `06h-retrieval-index.js`（特征哈希 512 维带符号桶＋TF-IDF＋余弦＋RRF；全自足，零跨模块引用） |
| 融合排序 | `rankMemoriesFused` / `rankMemoriesForRecall`（`06d-memory-domain.js`） |
| 开关 | `runtimeMemoryVectorRecallV1=false` → `memoryVectorRecallEnabled()`（`01c-runtime-flags.js`） |
| 注册表缓存 | 头部解析结果按 `size+mtime` 缓存（沿用 106 #2a 的失效键）；`readdir` 每轮照做，结果集逐字节不变 |
| 门 | 新增 `memory-recall-quality.e2e.js`（50 条合成记忆 × 20 条查询，四类：原词／同义／拼写漂移／跨语言） |
| 持久化清册 | 补登记 `memory-body`（`<data>/memory/{global,project/<key>}/<id>.md`）——103c 的真实缺口：五个 sidecar 都在表里，真正存用户内容的正文一直没登记 |

**实测结果（Recall@3）**：词法 18/20 = 90.0%，融合 19/20 = 95.0%，**+5.0pp**。25 号 §3.3 定的翻默认门槛是 +10pp，**未达到，开关保持默认关**。唯一剩下的未命中是纯英文查询对纯中文记忆（`how long are local logs kept` → `log-retention`）：离线层靠字符 gram 共现，中英之间没有共享特征，这类只有 113c 的 provider embedding 能解。

**过程中修掉一个自己引入的融合缺陷（值得记）**：第一版把词法层的完整名次表直接喂进 RRF，而 `convention`/`preference` 即使零命中也会进候选（今天的语义）。满库的零命中规则条目于是占满词法前几名，把向量层排第二的真命中挤出 Top-3 —— 实测例 `canry deployment` → `deploy-canary`：向量名次 2，融合后掉出 Top-3。改为两层：**命中层参与融合排名，零命中的规则类只在没填满时补位**。修完 90%→95%。诊断能力已固化进门里（未命中时逐条打印正解在词法／向量各自的名次，"向量根本没找到"与"融合把它挤出去了"是两回事）。

**与方案的一处偏离（已量化）**：§3.2 提出把记忆向量索引落盘到 `_index-v1.json`。**没有做**，理由是实测口径下它是负收益：记忆的检索单元就是注册表已经读进内存的头部字段（id/name/description/coreSummary/type），百到千级语料重算全部向量是微秒级；而读＋解一个几百 KB 的 JSON 索引更贵，还要多养一套损坏／过期处理。会话搜索那边正文提取才是真花钱的地方，索引落盘放在那边（见 113b）。

#### 113b · 会话搜索索引＋API＋前端（默认开）

| 项 | 落点 |
|---|---|
| 索引与检索 | `13d-core-domain-routes.js`（`buildSessionSearchUnit` / `refreshSessionSearchIndex` / `searchSessionsByContent`），复用 `06h` 原语 |
| 端点 | `GET /api/sessions/search?q=&limit=`，`ROUTE_AUTH` 记 `auth:'token'`（比 `/api/sessions` 的 `token-browser` 严一档：它返回的是正文摘录，不只是列表元数据）；须排在 `/api/sessions/` 前缀条之前 |
| 开关 | `sessionSearchIndexV1=true` → `sessionSearchIndexEnabled()`；显式 false 时端点回 `session_search.disabled`，前端回退旧子串过滤 |
| 索引单元 | 标题＋摘要＋工作目录＋首条 user 消息＋末尾 6 条消息摘录，去重后 ≤ 4KB；正文只读文件头 24KB 与尾 96KB 两段，不整体读入 |
| 失效键 | `updatedAt + messageCount`（两者都在 `listSessions` 的元数据里，判断失效零额外 IO）；损坏或版本不符即全量重建 |
| 脱敏 | 摘录出服务端前过 `redact()`（`04-permission-runtime.js:40`），与 `/api/audit` 同一条路径 |
| 前端 | 侧栏 q ≥ 2 字符时走 API（去抖 200ms、序号防乱序），命中时列表改为「搜到 N 条」＋每行一句正文摘录；请求失败／端点关闭／还没回来时自动回退到旧的子串过滤 |
| 门 | 新增 `session-search.e2e.js`（此前**这条路径一件测试都没有**）：鉴权、入参下限、正文命中、拼写漂移命中、脱敏、索引落盘／增量／损坏重建、limit、字段形状、开关关闭 |
| 持久化清册 | 新增 `session-search-index`（regenerable：每一字节都可从会话 NDJSON 正文重算） |

**踩到并修掉的一个老坑**：端点最初用 `json({ ok:false, error:'session_search.disabled' })`，被 `normalizeApiErrorPayload` 归结成 `api.request_failed`，真正的 code 降级成 message——调用方分不出「关了」和「坏了」。这与 118 波 `help.doc_missing` 是同一个坑，已改走 `apiFailure(code, {}, message, 200)`（状态码 200：它不是错误，只是能力关着）。

**真机走查**：`乱码`（只在消息正文里出现，标题/摘要/目录都没有）→ 搜到 1 条并带摘录；`powersell`（拼写漂移，旧子串过滤必然落空）→ 命中正确会话；清空搜索框 → 恢复按日期分组的完整列表。

#### 112／113 出门记录（2026-09-04）

**串行全量回归：269 pass / 0 fail / 1 flaky（269 跑 / 7 跳）**。唯一 flaky 是 `interventions-snapshot.e2e.js`（首跑失败、重跑通过）——该件自 109 波起就在偶发名单里，与本批改动无关，归 107 前置的偶发件治理。快通道 53/53。

**出门前又抳下三件（都是自己引入的）**：
1. `dom-contract.e2e.js` 的反向检查（所有字面量 `$()` 的 id 都要在 index.html 里）—— `turnActivityBar` 与 `compactIndicator` 一样是动态创建，按既有机制登记豁免并附理由。
2. 侧栏搜索清空时未推进请求序号，在飞的请求回来会把已清掉的搜索态写回去（渲染有 query 比对兑底，但状态不该脏）。
3. `tool_use` 缺 `id` 时原本会用合成键登记活动工具，而 `tool_result` 同样无 id 注销不掉 —— 阶段会卡在「正在调用工具」直到回合结束。改为只计步数不登记，并补单元用例。

**过程纪律上的两条教训**（已进记忆）：生成器链必须在**最后一次 src 改动之后**整条重跑（中途改了 13d 一行注释就让 route-inventory 判定点行号漂移、静态门恒红）；全量回归跑到一半改源码会污染证据（测试是 spawn 时读盘），改了就停跑、改完重跑。

### 3.4 红线与不做
- 纯离线：L1 必须在断网、无 provider 时给出与今天不差的结果；L2 只增强。
- 隐私：索引与向量缓存与会话／记忆同目录、同权属；不出数据目录；snippet 走导出同款脱敏。
- 不做 ANN／HNSW（N 为百至千级，暴力余弦足够）、不接外部向量库、不自动改写记忆、不用 embedding 做自动去重合并（仍走候选单槽＋用户确认）。

---

## 4. 排序建议与决策点（待用户拍板）
1. **建议执行序**：108 → 109 → 110 → 111 → 112 → 113 → 107 批准点。理由：111 直接服务 Pretender 3.0「更便宜、更快、更可控」，属于出门前引擎证据；112 解决用户最直接的黑盒感；113 独立性最强、可最后。
2. **备选**：若压缩痛点急迫，111 提前到 108 之后（109 顺延），110 对 `10-context-governance.js` 的拆分改排在 111 出门之后。
3. **107 冻结范围**须覆盖本文所有默认翻开的切片；全部默认关不冒充收益（22 号）。
4. 113c 的 `caps` 字段是 provider 配置 schema 变更（`CONFIG_SCHEMA` bump），与 [26 号 第 114 波 ASR](26-wave-114-asr.md) 的 114a 共用字段形状：先落者建字段、后者复用，请一并确认执行序（26 号 §6 建议 110 → 114a–114c → 111 → 112 → 113 → 114d/114e → 107）。
