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

### 2.4 走查表与映射表
（112a 交付时填写）

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
