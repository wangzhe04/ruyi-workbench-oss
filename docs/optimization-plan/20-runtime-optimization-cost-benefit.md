# 20 · 运行时优化性价比收敛方案——工具检索、上下文与失败恢复

> 状态：**shadow 总开关已默认启用；283/89/75 对抗审计仍判定“非纯收益”：shadow 可继续，C1 主动启用被阻断；F1 分类器已升至 deterministic-v2，但仍仅 telemetry**
> 决策日期：2026-08-15
> 最近修订：2026-08-17（F1 deterministic-v2）
> 目标：不扩张产品边界，以最少的新机制提升 Ruyi 在真实任务中的工具命中率、长程执行成本与失败后恢复能力。
> 约束：沿用 M4 单轴消融纪律；每项独立开关、独立回测、可随时回退。

> 边界补充（2026-08-17）：HB360 工具轮次事实源校准、只读批次调度、大动作参数历史、缓存前缀和元工具链已独立收敛到 [`21 · 工具调用经济性校准与收敛`](21-tool-call-economics-convergence.md)。这些项目不并入 20-T1/20-C1 的主动开关，避免绕过本文件的数据门和单轴纪律。

---

## 0. 决策摘要

本轮只准入 **2 个确定实施项 + 1 个条件项**：

为避免与历史波次里的 T1/C1 等切片重名，跨文档引用统一写作 **20-T1 / 20-C1 / 20-F1**；本文件内为简洁仍写 T1 / C1 / F1。

| 顺序 | 项目 | 决定 | 为什么现在做 |
|---|---|---|---|
| T1 | 确定性混合工具检索 v1 | **shadow 已启用，合成门通过** | 当前 `tool_search` 只是名称/包/描述上的子串命中计分；改进可复用现有 catalog、pack、tier、`tool_load`，无需新服务或模型 |
| C1 | 确定性工具观察瘦身 v1 | **shadow 已启用，合成门通过** | 已有蒸发与摘要内核，但旧工具结果主要被统一截成前 120 字符；按工具类型保留结构化证据可同时降低 token 和误删风险 |
| F1 | 失败分类 + Recovery Brief + 有界恢复 | **shadow 分类已启用，合成门通过** | 可复用现有 retry、watchdog、Evidence Graph、Replan Patch Ledger 和 Memory Graph；有界自动恢复仍须先通过真实失败样本数据门 |

以下方向本轮**不实现**：完整 AgentRx 诊断流水线、LLM 版 AgentDiet、向量库/embedding reranker、学习型模型路由、预算策略训练、学习型 DAG 调度、推测执行、跨工具语义事务、技能编译器、KV cache 服务、Windows 感知栈重构。

这不是永久否决；第 9 节给出重新评审的量化触发条件。没有触发条件，就不扩项。

### 0.1 开发上限

- 首期不得引入新常驻服务、数据库、训练任务、Python sidecar 或远程依赖；只用现有 Node.js 运行时和已有配置/事件体系。
- T1、C1 分两次单轴交付；F1 不得与它们捆绑。
- 新能力默认关闭或 shadow 运行，固定基准过门后才允许默认开启。
- 首期不新增 UI 页面；解释信息进入现有运行事件、日志或调试详情即可。
- 不修改 `06c-agent-loop-hooks.js` 的只读契约。若未来需要可变 middleware，必须另立安全设计，不借本方案夹带。
- 不自动确认记忆、不自动发布工作流、不在线学习、不扩大工具权限。

### 0.2 2026-08-15 实施快照

- **20-T1 已实现**：共享的确定性检索器覆盖 Provider 与 Claude/MCP；支持中英文词元、中文 2/3-gram、能力/别名/参数 schema/描述/pack 多字段 IDF 加权、精确名 boost、权限阻断解释、`matchedOn` 与进程级 HMAC 查询指纹。关闭开关时保留原两条路径各自的 legacy 计分行为。
- **20-C1 已实现**：只在现有压缩阈值触发后处理旧 observation；结构化采样或首尾保留，错误/验证/写操作证据受保护；压缩前快照改为内容哈希稳定文件，model view 携带 rawRef，内部还原原语会同时校验快照哈希和 observation 哈希。关闭时仍是原 `[已省略:前120字]` 行为。
- **20-F1 数据门已实现**：Provider post-tool 路径可选择性输出确定性 failure taxonomy；日志只含分类器版本、类别、tier、repair hint 和进程级 HMAC 证据指纹，不保存原错误/参数/路径。已提供离线汇总与只读历史重放脚本，**没有**实现 retry、Recovery Brief 执行器或记忆写入。
- 总开关 `runtimeOptimizationShadowV1` 默认 `true`：T1 同时计算 legacy/candidate 并只记脱敏 Top-K 差异；C1 只在原压缩阈值触发时复制 history 评估两种策略；F1 只分类失败。shadow 不改变工具返回、model context、retry、权限或记忆。
- 三项主动行为开关仍严格独立且默认 `false`：`runtimeToolRetrievalV1`、`runtimeObservationReducerV1`、`runtimeFailureTelemetryV1`。其中 F1 当前即使主动 flag 打开也仍只有 telemetry，没有恢复执行器。
- 数据门报表：`node dev-harness/runtime-failure-report.js <RUYI_HOME 或 logs 目录>`。至少 30 条 shadow 失败、可恢复占比 ≥15%、确定性分类占比 ≥50% 且可恢复样本 ≥5 才会建议进入 F1 有界恢复实现。报表只用最新分类器 cohort 过门，旧版本样本保留为 `totalSampleSize/excludedOlderSampleSize`，不与新行为混算。
- 分类器升级验证：`node dev-harness/runtime-failure-replay.js <RUYI_HOME>`。它按 `sessionId/toolCallId` 关联本地工具结果，只输出新旧类别、修复策略和安全计数，不输出原错误/参数/路径，也不写用户状态。
- 已增加纯逻辑/static、真实 Provider/MCP 工具加载、自动压缩/rawRef、checkpoint GC、pairing、上下文 v2 与 failure-report 单元回归。当前结论只是“代码/机制可运行”，不替代第 4–6 节的真实数据验收门。

### 0.3 2026-08-15 shadow 模拟结果

可重复命令：`node dev-harness/runtime-shadow-benchmark.js`；固定结果写入 `dev-harness/ab-results/runtime-shadow-latest.json`。本次不读取用户数据、不调用网络/模型/工具，也不打开任何主动行为开关。

| 轴 | 样本与结果 | 合成门结论 |
|---|---|---|
| 20-T1 | 真实 56 项 native catalog；60 条中/英/混合查询。Recall@5 `70% → 100%`，nDCG@5 `0.6692 → 0.9905`，Top-1 `61.67% → 98.33%`，候选 p95 `<1.6ms` | 通过 |
| 20-C1 | 20 条长 observation、441,849 chars；其中 4 条关键证据保护。候选压缩率 `83.71%`，关键证据丢失 `0`，单条 reducer p95 `<0.1ms`，live history 未变 | 通过 |
| 20-F1 | 30 条覆盖 8 类失败；分类准确率 `100%`，规则确定率 `100%`，23 条标记可恢复，2 条副作用未知均禁止重放 | 通过“继续收集真实 shadow 数据”，**不等于批准自动恢复** |

合成数据用于验证机制、门槛计算和安全不变量，不能代替真实 holdout。当前决策是 `keep_shadow_collect_real_runtime_data`：保留 shadow 默认开启，主动 T1/C1 与任何 retry/记忆闭环继续关闭。

### 0.4 更广对抗审计：不是纯收益（2026-08-15 v1 历史基线）

在基础 happy-path 门之后，新增 `node dev-harness/runtime-shadow-adversarial.js`，覆盖 283 条检索、89 条 observation、59 条失败分类、1,000 次失败指纹碰撞探针，并把 catalog 放大到 1,000 项。完整结果写入 `dev-harness/ab-results/runtime-shadow-adversarial-latest.json`。连续三轮的逻辑结果一致：**3 high / 4 medium / 1 low，shadow 安全门全绿，但不能把候选解释为纯收益。**

| 轴 | 更广测试中的收益 | 代价/反例 | 当前决定 |
|---|---|---|---|
| 20-T1 | 232 个正例 Recall@5 `84.48% → 100%`、Top-1 `74.14% → 99.14%`，候选退化 `0`；16 个歧义意图 Recall@5 `56.25% → 87.5%` | 23 个无关/攻击型 query 有 14 个返回非空，6 个攻击型样本全部召回了工具；56 项 catalog p95 `1.573ms`（legacy `0.211ms`），1,000 项 p95 `20.806ms`；约 `3.259 MiB/万次`本地 shadow 事件 | **继续真实 shadow**；正式替换前增加低覆盖/低分拒答门，并观察大 MCP catalog 成本 |
| 20-C1 | 64 条可压缩样本中位压缩率 `95.24%`，关键 marker 丢失 `0`；5 MiB JSON 约 `2.675ms`/`5.007MiB` 堆增量；shadow 测量不改 live history | **High×3**：19 条应保护错误漏掉 8 条纯文本 `ENOENT/Traceback/HTTP 500/...`；43 条结构化缩减里 2 条被最终字符串平切成非法 JSON；同一 observation 第二次仍被压缩，`5546 → 1555 chars`，非幂等。另有 4/6 普通成功文本因提到 checkpoint/journal/quality gate 被误保护 | **主动 C1 阻断**；先修保护规则、结构化钳制和幂等/rawRef 链，再重跑 |
| 20-F1 | 59 条下规则输出 100% 可重复，原错误泄漏 `0`，1,000 指纹碰撞 `0`；没有 edit/exec 被错误标为 `retry_once` | 扩展措辞分类准确率 `83.05%`；8 个写/执行类 `429/502/503/504/EAI_AGAIN/...` 被记为 `unknown` 而非 `side_effect_unknown`；`ok:true + error` 会产生假失败 telemetry | **只保留 telemetry**；当前仍 fail-safe，但统计口径未到自动恢复可用水平 |

对抗审计的总判断是 `mixed_benefit_with_identified_costs_and_blockers`：

- shadow 开启与关闭时，legacy 检索结果和 legacy evaporation 逐字节一致；C1 测量副本不修改 live history。
- query/error 原文均未进入 shadow 事件；权限解释、loaded 标记、排序确定性和 catalog 顺序不变量全部通过。
- 当前 shadow 可以保留，因为上述问题只发生在候选评估或分类口径，不会改变真实执行。
- **不得开启 `runtimeObservationReducerV1`，不得据此实现自动 retry/记忆闭环。** T1 也先收真实 negative-query 与大 catalog 数据，不把总体准确率提升当作无条件默认开启依据。

### 0.5 2026-08-17 F1 deterministic-v2：真实样本驱动修订

首批真实日志达到 32 条后，v1 有 30 条落入 `unknown`。离线关联确认并非真实错误不可判，而是 v1 漏读了工具结果的结构化字段：进程工具主要使用 `timedOut/interrupted/code/stderr`，策略守卫使用 `hint/code`；v1 只读取 `error/message/detail`。v2 改为“结构字段优先、错误文本兜底”，原文仅参与进程内规则与 HMAC 指纹，不进入事件。

新增/修正类别：

- `side_effect_unknown`：edit/exec 的结构化超时、连接不明或执行中断，必须先检查副作用，绝不映射 `retry_once`。
- `execution_failed`：非零进程退出、Traceback/ParserError 等确定性执行失败，只允许看错误后修改命令/脚本。
- `edit_conflict`：`oldText` 锚点过期，先刷新文件再修改。
- `policy_blocked`：内部数据边界、Office 专用工具规程等产品策略阻断，改走受支持工具。
- `resource_not_found`：shell/session 等短生命周期句柄已失效，先重新获取资源。
- `invalid_arguments` 补齐 `query is required` 等具名必填参数形态；`ok:true + error` 不再产生假失败。

对32条历史事件只读重放：`unknown 30 → 0`；重分类为 `side_effect_unknown 11`、`execution_failed 8`、`edit_conflict 6`、`invalid_arguments 2`、`policy_blocked 2`、`permission_denied 1`、`resource_not_found 1`、`tool_unavailable 1`，关联率 `32/32`，edit/exec 被映射为 `retry_once` 的数量为 `0`。扩展对抗集增至75条，分类与 repair policy 准确率均为 `100%`，原错误泄漏 `0`，1,000 指纹碰撞 `0`，全部 Shadow 安全门通过。

这次结果证明分类口径已显著改善，但**不批准自动恢复**：部署后 `deterministic-v2` 从零开始积累独立 cohort；达到30条新版真实样本后，再按第6.5节的数据门决定 Recovery Brief/有界修复是否值得实现。

---

## 1. 现状与去重结论

### 1.1 Ruyi 已有的能力

| 领域 | 已有实现 | 本方案不重复做什么 |
|---|---|---|
| 工具加载 | `07-autonomy.js` 已有 catalog、pack 分类、risk tier、`list_tools` / `tool_search` / `tool_load`，并在 auto 模式避免一次注入全部桥接 schema | 不再新建一套工具注册中心，不推翻 pack，不强制全量工具向量化 |
| 上下文治理 | `10-context-governance.js` 已有 `evaporateHistory`、结构化摘要、map-reduce、预算适配；工作流已有 global + per-node context | 不再造第二套 compact 流程，不重复做节点上下文分级 |
| 执行保护 | `09-workflow.js` 已有最大重试、空闲/无进展 watchdog、`progressFingerprint`、quality gate 与 Replan Patch Ledger | 不再造通用重试框架，不做无界自我反思循环 |
| 证据与记忆 | Evidence Graph、Local Memory Graph、提案/确认边界已落地 | 失败经验只生成提案；不绕过已有确认与证据门 |
| 可观测性 | Agent Loop Hooks 覆盖模型调用前后和工具调用前后，但契约是只读观察 | 优化逻辑放在明确的运行时模块，不让 hook 暗中改参数或结果 |

### 1.2 真正缺口

1. **检索排序过弱**：`createToolLoadingState().search()` 将 query 分词后，只按 `hay.includes(word)` 做名称 +3、其他字段 +1。中文复合意图、参数能力、同义表达、近似工具之间的区分均不足。
2. **旧观察压缩过于通用**：`evaporateHistory()` 对多数旧工具消息保留前 120 字符，无法区分“列表噪声”和“错误、命中行、退出码、验证结论”等关键字段。
3. **失败信号尚未形成紧凑恢复输入**：系统能检测 timeout/no-progress/quality failure，也能 replan，但缺少统一 `failureClass → retry policy → Recovery Brief → 验证结果 → 记忆提案` 契约。

因此，本方案是对现有原语的薄层升级，而不是引入新的 Agent 平台。

---

## 2. 性价比评估方法

### 2.1 评分口径

评分为 1–5 的规划估计，只用于排序，不伪装成实测结论。

**收益分 B**：任务成功率/恢复率 35%，token 或墙钟成本 25%，适用任务覆盖 20%，外部证据成熟度 20%。
**成本分 C**：实现量 35%，回归与安全风险 25%，新增运行时开销 20%，长期维护 20%。
**性价比 B/C**：大于 1.5 才可直接准入；1.2–1.5 必须有本地数据门；低于 1.2 默认暂缓。

### 2.2 六条硬准入规则

候选即使论文结果亮眼，也必须同时满足：

1. 有 Ruyi 当前代码或本地轨迹可证明的瓶颈，而非只因“论文新”。
2. 优先复用已有能力；首期不得新建服务、训练模型或引入运行时数据库。
3. 可以用独立 feature flag 完整关闭，关闭后存量行为不变。
4. 有固定 benchmark、holdout、成本与质量双指标。
5. 先做最简单的确定性版本；只有它撞到可测天花板，才评估学习型版本。
6. 未达到预设增益即删除或保持关闭，不因已经投入开发而继续加码。

---

## 3. 候选功能性价比矩阵

| 候选 | 外部启发 | B | C | B/C | 与现有能力重叠 | 决定 |
|---|---|---:|---:|---:|---|---|
| T1 确定性混合工具检索 | Tool-to-Agent Retrieval、ToolScope、LiveMCPBench | 4.7 | 1.9 | 2.47 | 低：只替换弱排序器 | **现在做** |
| C1 确定性观察瘦身 | AgentDiet、Complexity Trap | 4.5 | 2.5 | 1.80 | 中：扩展现有蒸发，不另建 compact | **T1 后做** |
| F1 轻量失败分类与恢复简报 | AgentRx、REFLECT | 3.9 | 2.8 | 1.39 | 中：复用 retry/replan/memory | **数据门后做** |
| 完整 AgentRx：IR + invariant checker + LLM judge | AgentRx | 3.4 | 4.2 | 0.81 | 高：Ruyi 已有 trace、gate、证据图 | 暂缓 |
| LLM 版 AgentDiet/学习型折叠 | AgentDiet、AgentFold | 3.8 | 3.5 | 1.09 | 中高：已有摘要内核 | 暂缓；C1 触顶再看 |
| 学习型实时失败检测/受控 replay | Real-Time Detection and Repair、REFLECT | 3.4 | 4.3 | 0.79 | 中 | 新论文且需校准/副作用隔离，暂缓 |
| RouteLLM / BEST-Route 模型路由 | RouteLLM、BEST-Route | 3.2 | 4.4 | 0.73 | 中：节点已有显式 model | 暂缓 |
| BudgetMem / BATS 预算策略 | BudgetMem、Budget-Aware Tool-Use | 3.0 | 4.5 | 0.67 | 高：已有 maxIters、成本面板、记忆图 | 暂缓 |
| 学习型 DAG 调度/剪枝 | LAMaS | 2.8 | 4.0 | 0.70 | 高：已有并行 DAG | 先测 critical path，不实现学习器 |
| 推测工具执行 | PASTE、Speculative Actions | 3.1 | 4.8 | 0.65 | 中：已有显式并行工具调用 | 暂缓 |
| 跨工具语义事务/回放分叉 | Cordon、ACRFence、Revisable by Design | 3.7 | 5.0 | 0.74 | 中：已有文件回滚和 checkpoint | 暂缓 |
| AgentSpec 全量 DSL | AgentSpec | 2.7 | 3.6 | 0.75 | 高：已有权限、gate、校验 | 不引入 DSL；只借鉴显式契约思想 |
| Skill compiler / learned skill selection | SkVM、SkillSmith、SkillsBench | 3.0 | 4.1 | 0.73 | 中：已有 progressive skills | 暂缓 |
| Windows 视觉/API 感知栈重构 | UFO2、OmniParser | 2.8 | 3.4 | 0.82 | 高：已有 ACC/UIA/OCR/截图 | 先看桌面失败占比 |
| 客户端内置 KV cache 服务 | LMCache、SGLang、KVFlow | 2.0 | 4.8 | 0.42 | 低但部署不匹配 | **排除出客户端核心** |

关键判断：AgentRx 和 AgentDiet 都值得借鉴，但“整仓接入”并不是最高性价比。Ruyi 需要的是它们的两个最小原理：**失败后把诊断变成结构化、可验证输入**，以及**延迟删除已过期观察，同时保留可追溯原始证据**。

---

## 4. T1：确定性混合工具检索 v1

### 4.1 目标与边界

目标是在不引入 embedding、向量库或额外 LLM 调用的前提下，提升中英文、多约束、隐式意图下的 Top-K 工具命中率，并继续控制注入模型的 schema token。

本期只改 `tool_search` 的 catalog 表达、召回/排序和解释结果；不改权限判定，不自动执行工具，不废弃 pack 和 `tool_load`。

### 4.2 最小数据结构

在现有 catalog 项上补充可静态生成的字段：

```js
{
  name, pack, tier, bridged, description,
  capabilities: ['file.search', 'code.symbol.lookup'],
  aliases: ['查找定义', '引用检索', 'find references'],
  paramTerms: ['query', 'path', 'include'],
  availability: { loaded, callable, reason }
}
```

- 原生工具的 `capabilities/aliases` 使用一份小型、代码审查可见的 manifest。
- 桥接工具先从名称、描述、JSON schema 参数名确定性推导；不要求 MCP 服务改协议。
- manifest 只描述检索，不复制权限 tier 的事实源。

### 4.3 召回与排序

第一版使用单一确定性管线：

1. Query 规范化：大小写、snake/kebab 拆分、英文词元、中文 2/3-gram；保留路径、扩展名和精确工具名。
2. 候选召回：exact name、alias/capability、pack、description、parameter terms 五路合并。
3. 硬约束：剔除当前 engine 不可调用或已失效工具；权限模式禁止的工具不偷偷提升，但可在结果中以 `blockedReason` 解释，而不是误报为可执行。
4. 排序：轻量 BM25 风格词频分 + exact-name/capability/pack boost + risk/availability tie-break；所有权重是常量、可快照测试。
5. 输出：受 `limit` 和 `schemaTokenBudget` 双重约束；返回 `matchedOn`、score components、是否已加载，便于调试误召回。

首期不做 MMR。只有 holdout 显示 Top-K 被同类工具挤满，才增加一个简单的 pack/capability 去重 tie-break；不先造通用多样性框架。

### 4.4 动态再检索

继续复用现有 `tool_search → tool_load → tool call`：

- 首次检索无高置信命中时，返回建议的改写 query，不自动调用 LLM。
- 工具调用出现 `unknown_tool` / schema mismatch 时，允许一次带失败字段名的再检索。
- 再检索最多 1 次；仍无结果则明确失败，不循环搜索。

### 4.5 T1 验收门

最小数据集：复用 HB360 任务，并新增不少于 60 条脱敏工具查询（中文、英文、中英混合和歧义意图各有覆盖）；ground truth 可包含多个等价工具。

| 指标 | 进入 shadow 的门 | 默认开启的门 |
|---|---:|---:|
| Recall@5 | 相对现状 +8 个百分点，或已达 95% | holdout 不低于 shadow |
| nDCG@5 | +8% | +8%，且三类语言切片均不退化 |
| 首次工具选错率 | 不上升 | 相对下降 ≥10% |
| 需工具发现任务的新增 schema tokens/run | 不上升 | 中位数下降 ≥15%，或在准确率显著提升时持平 |
| 检索本地开销 | p95 < 15 ms | p95 < 15 ms |
| 权限/不可用工具误报 | 0 个未解释案例 | 0 |
| 端到端 outcome | 非劣：下降不超过 1 个百分点 | 非劣且无 P0/P1 回归 |

若词法 v1 未过门，先修 manifest/数据，不以“上 embedding”掩盖标签或描述质量问题。

---

## 5. C1：确定性工具观察瘦身 v1

### 5.1 设计原则

AgentDiet 报告了显著的输入 token 和总计算成本下降，但其数字来自特定 coding agent、模型和 benchmark，不能直接当作 Ruyi 的承诺。Complexity Trap 进一步说明：简单 observation masking 在其 SWE-agent 实验中可与 LLM 摘要相当。因此 Ruyi 先做**无模型、延迟、可还原**的版本。

核心是“双轨迹”而非删除事实：

```text
canonical observation（原始工具结果，审计/恢复使用）
                 ↓ deterministic reducer
model view（模型下一轮看到的紧凑结果 + rawRef + omission metadata）
```

### 5.2 最小实现

1. 保持最近 2 个 assistant turn 的工具结果逐字不动，与现有 evaporation 窗口一致。
2. 只有在现有压缩阈值触发时才改写旧 observation，避免每轮破坏 provider prefix cache。
3. reducer 是纯函数，按工具类别保留：
   - shell/script：命令、exit code、stderr、错误邻域、stdout 首尾和省略行数；
   - file/code search：query、总命中数、每文件首批命中、命中行号与截断计数；
   - web/http：状态码、最终 URL、标题/关键字段、正文首尾与截断量；
   - list/JSON array：总数、稳定排序后的有限样本、字段集合；
   - 未识别工具：保守的首尾截断，不做语义猜测。
4. 下列内容一律保护：错误与验证失败、写操作 journal/checkpoint、用户明确 pin 的证据、quality gate 输入、Evidence Graph 已引用片段。
5. 改写前把原始内容放进 session 级有界 `rawObservationCache`，键为内容 hash；model view 带 `rawRef`、原始字节数、保留策略。缓存超限按 LRU 清理，但保护项不可被静默清理。
6. 本期只提供内部 rehydrate 原语和调试事件，不新增 UI。模型只有在确有缺失证据时才请求恢复；一次步骤最多恢复 1 个 observation。

`rawObservationCache` 不作为新长期数据库：随 session 生命周期存在，采用字节上限；持久审计仍使用现有轨迹/事件事实源。若实现勘察发现原始轨迹没有可靠持久事实源，则 C1 在补齐该前置前不得默认开启。

### 5.3 不做的内容

- 不在每一步调用 LLM 判断“哪些内容无用”。
- 不修改用户消息、assistant tool call 或 tool-call 配对结构。
- 不压缩刚产生的失败证据，不把摘要当 canonical truth。
- 不为 C1 新建向量索引或长期记忆。

### 5.4 C1 验收门

数据集：至少 20 条能触发压缩的长任务，覆盖代码、shell、web/HTTP、桌面或办公工具中的已有可回放类型；按短/中/长结果分层。

| 指标 | 默认开启门 |
|---|---:|
| 压缩后的模型输入 token | 长任务中位数相对 baseline 下降 ≥20% |
| 端到端 outcome | 下降不超过 1 个百分点；关键任务逐例复核 |
| 关键证据丢失 | 0；错误、exit code、引用行、写操作、验证结论必须保留 |
| reducer 本地开销 | p95 < 10 ms/observation |
| 被迫 rehydrate | ≤10% 的工具步骤；若更高说明 reducer 过激 |
| prefix cache | 可获得 provider 指标时命中率不退；不可获得时至少保证一次阈值一次改写 |
| 配对/协议错误 | 0 个 tool_call pairing 回归 |

任一 P0/P1 证据丢失或 pairing 回归，立即关闭 C1；不得靠继续加摘要 prompt 修补。

---

## 6. F1：条件式失败闭环

### 6.1 何时才启动

先从现有失败轨迹抽样不少于 30 条，按下列 taxonomy 人工复核。只有同时满足以下条件才实施 F1：

- 至少 15% 的失败属于“修正参数、换等价工具、等待后重试或补验证即可恢复”；
- 其中至少一半能由确定性信号可靠分类；
- 写入/执行类副作用可以明确判定是否已发生；无法判定的样本不允许自动 replay。

不满足则只保留失败报表，不开发闭环。

### 6.2 失败 taxonomy 与策略

| failureClass | 确定性信号 | 默认动作 |
|---|---|---|
| `invalid_arguments` | schema/参数校验失败 | 不同参重试；生成 Recovery Brief 让模型改参数，最多 1 次 |
| `edit_conflict` | `oldText`/编辑锚点与当前文件不一致 | 重新读取目标并生成新 patch；禁止原参数盲重试 |
| `execution_failed` | 非零退出码、Traceback、ParserError 等 | 读取脱敏错误摘要后修改命令/脚本；不原样重放 |
| `policy_blocked` | 内部数据边界、专用工具规程等产品硬规则 | 改走受支持工具或允许的作用域；不请求无效的权限升级 |
| `resource_not_found` | shell/session 等短生命周期句柄失效 | 重新列举或创建资源后再构造调用 |
| `tool_unavailable` | unknown tool、connector/offline | 触发一次 T1 再检索；不重复原调用 |
| `permission_denied` | permission gate/user deny | 不重试，不把拒绝写成“暂时错误” |
| `transient_read` | timeout、429/5xx、明确的临时连接错误，且工具为 read/idempotent | 指数退避后同参重试 1 次 |
| `no_progress` | 已有 fingerprint/watchdog | 禁止原样重试；交给现有 replan，提供差异摘要 |
| `verification_failed` | quality/coverage/schema gate | 保留验证证据，给出针对缺口的修改建议 |
| `side_effect_unknown` | exec/edit/desktop 调用无可靠 receipt | 停止自动恢复，要求确认或安全检查 |
| `unknown` | 无可靠规则 | 最多生成 1 次诊断建议，不自动执行 |

### 6.3 Recovery Brief 契约

```json
{
  "failureClass": "invalid_arguments",
  "failedStep": { "tool": "...", "attempt": 1 },
  "evidenceRefs": ["event:...", "observation:..."],
  "whatChanged": "...",
  "constraints": ["permission tier unchanged", "do not repeat side effects"],
  "allowedRepairs": ["modify_arguments", "retrieve_alternative_tool"],
  "retryBudget": { "remaining": 1 },
  "verificationRequired": "..."
}
```

AgentRx 的价值在“可审计地定位关键失败步骤”，不是让另一个 LLM 无界复盘整条轨迹。Ruyi v1 只对 `unknown` 或需要改参的失败允许一次 LLM 诊断，并把紧凑 Recovery Brief 而非整段日志交给模型。

### 6.4 自闭环，但不自我确认

```text
失败 → 确定性分类 → 策略允许？ → 有界修复/重试 → 原任务 gate 验证
                                                   ↓
                              失败：保留诊断，不写记忆
                              成功：生成 memory proposal，等待既有确认流程
```

- 原工具调用、修改建议、实际 patch/retry、验证结果全部分开记账。
- “模型认为修好了”不算成功；必须由原 gate、工具返回或外部 world-state 证据确认。
- 只有修复成功，且同类模式在独立任务中至少再次出现，才允许向 Local Memory Graph 生成经验提案；仍不得自动 confirmed。
- 失败闭环总预算：每个失败步骤最多 1 次自动同参 retry + 1 次修改后尝试；整个 run 最多新增 1 次诊断模型调用。

### 6.5 F1 验收门

| 指标 | 默认开启门 |
|---|---:|
| 目标可恢复失败的恢复率 | 相对 baseline +10 个百分点 |
| 成功 run 的额外模型调用 | 0 |
| 全量 run 平均额外模型调用 | ≤0.2 次 |
| 重复副作用/权限升级 | 0 |
| 无界循环 | 0；预算耗尽后确定停止 |
| 恢复后验证覆盖 | 100% 经过原 gate 或 world-state oracle |
| 错误记忆自动确认 | 0；只能产生 proposal |

---

## 7. 分期、变更预算与验证顺序

下表是单人有效工程日的粗估，包含代码、测试和文档，不包含发布观察等待；它用于控制投入上限，不作为排期承诺。进入各阶段前应依据 Phase 0 的真实数据重新估算，但不得借重估扩大功能边界。

| 阶段 | 粗估投入 | 产出上限 |
|---|---:|---|
| Phase 0 基线与 fixture | 2–4 人日 | 三组固定样本、telemetry、baseline 报告；不改行为 |
| Phase 1 T1 | 4–7 人日 | manifest + 确定性排序 + explain + 测试；不含 embedding |
| Phase 2 C1 | 6–10 人日 | reducer + 保护规则 + 有界 rawRef + 测试；不含 LLM 压缩器 |
| Phase 3 F1 数据门 | 1–2 人日 | 失败分类报告和 go/no-go 决定 |
| Phase 3 F1 实现（仅过门后） | 5–9 人日 | taxonomy、Recovery Brief、3 类安全恢复、验证与 proposal |

所以无条件准入部分（Phase 0 + T1 + C1）的投入上限约为 **12–21 人日**；F1 未过数据门时不消耗后续 5–9 人日。若实际勘察超过该上限，应缩小切片或重新评审，而不是默认追加预算。

### Phase 0：只补基线，不改行为

- 固化 T1 查询集、C1 长轨迹集和 F1 失败样本；记录任务版本、模型、工具 catalog hash、配置和随机性。
- 补齐现有 telemetry：检索候选/排名/命中字段/schema token；工具 observation 原始/模型可见字节；失败类、retry 原因、gate outcome、墙钟时间。
- 输出 baseline 报告。没有 baseline，Phase 1 不开始。

### Phase 1：T1 单轴

- 仅打开 `runtimeToolRetrievalV1`，C1/F1 关闭。
- 顺序：离线回放 → holdout → shadow → 小比例默认 → 全量默认。
- 未过门则回退；不在本阶段添加 embedding。

### Phase 2：C1 单轴

- 固定 Phase 1 的 T1 状态；baseline 与 candidate 只改变 `runtimeObservationReducerV1`。
- 先实现 reducer/保护规则与 cache，再接入现有 evaporation threshold。
- 经证据保真对抗测试后才 shadow；出现一次关键证据静默丢失即停止放量。

### Phase 3：F1 数据门与条件实现

- 先只分类并出报表；达到第 6.1 节门槛后，才实现 `runtimeRecoveryBriefV1`。
- 首轮仅启用 `invalid_arguments`、`tool_unavailable`、`transient_read`；`side_effect_unknown` 永远停在人工边界。
- 最后才允许成功经验生成 memory proposal。

### Phase 4：累进回归

按 M4 记录 `baseline → T1 → T1+C1 → T1+C1+F1（若准入）`。所有组合使用同一固定集和 holdout；报告 outcome、输入/输出 token、模型调用数、工具调用数、墙钟、权限提示、恢复次数和异常类型。

建议的代码变更预算：

- T1：集中在 `07-autonomy.js` 的 catalog/search 附近，加独立纯函数和测试 fixture；不触碰 dispatcher/permission gate。
- C1：集中在 `10-context-governance.js`，以及保存 session 级 rawRef 所必需的最小会话结构；不另写 compact 服务。
- F1：使用 `09-workflow.js` 既有 failure/retry/replan 路径和事件；不得通过只读 hook 注入行为。

---

## 8. 开关、事件与最小契约

以下名称是实施时的建议名，最终须沿用仓库现有配置命名风格：

| 开关 | 默认初值 | 关闭时 |
|---|---|---|
| `runtimeOptimizationShadowV1` | `true` | 不计算候选、不写三类 shadow telemetry；现有行为不变 |
| `runtimeToolRetrievalV1` | `false` | 恢复当前子串排序 |
| `runtimeObservationReducerV1` | `false` | 恢复当前 evaporation 行为 |
| `runtimeFailureTelemetryV1` | `false` | 总 shadow 也关闭时不输出失败分类 |
| `runtimeRecoveryBriefV1` | **未实现** | 保留现有 retry/replan，不生成新闭环 |

最小事件：

- `tool_retrieval_shadow`：query HMAC、legacy/candidate Top-K、overlap@5、候选耗时；不记录原始 query。
- `observation_reduction_shadow`：只记录汇总 count、raw/legacy/candidate chars、压缩率、protected count 与耗时；不记录 observation/rawRef。
- `runtime_failure_classified`：class、tier、allowed repair、进程级 HMAC evidence fingerprint；不记录原错误、参数或路径。
- `tool_retrieval_ranked` / `observation_reduced`：只在对应主动行为开关开启时产生。
- `recovery_attempted`：原调用 ref、修复差异、预算、结果、verification ref。
- `memory_proposal_created`：只引用已验证的 recovery，不复制敏感原文。

所有 telemetry 沿用本地优先、脱敏和 retention 规则；不得为论文式评估默认上传用户轨迹。

---

## 9. 暂缓项与重新评审触发器

| 暂缓方向 | 重新评审的必要条件 |
|---|---|
| embedding/向量工具检索 | T1 词法版在干净标注集上 Recall@5 仍低于 90%，且错误主要是语义同义而非 catalog/标签缺失 |
| 完整 AgentRx / LLM judge | F1 规则无法分类的高价值失败 ≥30%，并积累至少 100 条已标注失败轨迹；额外诊断成本有预算 |
| LLM AgentDiet / AgentFold | C1 已过安全门但 token 降幅仍 <20%，且剩余冗余无法由确定性 reducer 表达 |
| RouteLLM/BEST-Route | 至少 200 条同任务多模型对照数据；不同模型的质量/价格/时延差异足以覆盖路由误判成本 |
| BudgetMem/BATS | 现有 maxIters/成本阈值不能控制预算，且存在清晰的逐步预算决策标签；否则只显示预算，不训练策略 |
| LAMaS 式调度 | DAG telemetry 显示调度/排队造成关键路径 ≥15%，且任务存在稳定可预测的并发结构 |
| 推测执行 | 工具等待占墙钟 ≥30%，候选链预测命中 ≥70%，且限定为 read/idempotent 工具；否则浪费调用大于收益 |
| 语义事务/受控 replay | 非文件副作用失败成为主要恢复瓶颈，且先有统一 effect receipt、幂等键与隔离环境 |
| Skill compiler | T1/C1 稳定后仍证明 skill 描述或加载是主要瓶颈，并有负迁移 holdout；SkillsBench 已提示技能并非总是增益 |
| Windows 感知重构 | 桌面任务中 OCR/视觉调用占成本 ≥20% 或成为 ≥15% 失败根因，并完成 UFO2/OmniParser 与现有 ACC/UIA 的本机对照 |
| KV cache 服务 | Ruyi 控制自托管推理栈且 prefix/KV 传输成为已测瓶颈；托管 API 客户端不内置 LMCache |

---

## 10. 风险与停止条件

1. **基准过拟合**：工具查询集和长轨迹集必须留 holdout；manifest 修改后不能同步修改 holdout ground truth 来“追分”。
2. **成本转移**：token 降低但模型调用、rehydrate、retry 或墙钟上升，按总成本判定，不只看 input token。
3. **可观测性污染**：shadow 只记录候选结果，不改变模型上下文和工具执行。
4. **权限漂移**：检索排名、失败诊断和记忆提案均不得改变 tier 或 permission decision。
5. **副作用重放**：不能证明 idempotent/reversible 的调用，一律不自动 retry。
6. **自评幻觉**：模型自述不能作为恢复成功证据；必须有原 gate 或可观察 world-state。
7. **范围膨胀**：任一阶段若需要新服务、训练、UI 或跨平台基础设施，停止并重新立项，不在本方案内顺带实现。

全局停止条件：任一候选在两轮针对性修正后仍未过预设门，保持关闭并归档结果；不继续堆叠更复杂算法。

---

## 11. 外部研究与代码参考

以下结论只说明“可借鉴的机制”，不把论文环境中的收益数字外推为 Ruyi 的保证。

### 11.1 本轮直接采用其最小思想

- [AgentRx: Diagnosing AI Agent Failures from Execution Trajectories](https://arxiv.org/abs/2602.02475)；[GitHub（Microsoft，MIT）](https://github.com/microsoft/AgentRx)：失败轨迹结构化、约束检查与可审计归因。Ruyi 只采用 failure evidence/brief，不整合完整诊断栈。
- [Reducing Cost of LLM Agents with Trajectory Reduction（AgentDiet）](https://arxiv.org/abs/2509.23586)：论文报告在其两个模型/两个 benchmark 中减少 39.9%–59.7% input token、21.1%–35.9% 总计算成本。Ruyi 采用延迟、确定性 observation reduction，不预设同等收益。
- [The Complexity Trap](https://arxiv.org/abs/2508.21433)：在 SWE-agent 实验中，简单 observation masking 相对 raw agent 将成本约减半，并与 LLM summarization 解题率相当；支持“先确定性、后 LLM”的顺序。
- [Tool-to-Agent Retrieval](https://arxiv.org/abs/2511.01854)：强调 tool-level 表达优于粗粒度 agent 描述；其向量方案在 LiveMCPBench 报告 Recall@5/nDCG@5 增益。Ruyi v1 只采用细粒度 capability/metadata，不直接引入向量栈。
- [LiveMCPBench](https://github.com/icip-cas/LiveMCPBench)：可参考工具检索任务构造与指标，不直接复制为 Ruyi 唯一 benchmark。

### 11.2 保留观察、不进入首期

- [ToolScope](https://arxiv.org/abs/2510.20036)、[SWE-Pruner](https://arxiv.org/abs/2601.16746)、[AgentFold](https://arxiv.org/abs/2510.24699)、[BudgetMem](https://arxiv.org/abs/2602.06025) / [GitHub](https://github.com/ViktorAxelsen/BudgetMem)
- [AgentSpec](https://arxiv.org/abs/2503.18666) / [GitHub](https://github.com/haoyuwang99/AgentSpec)、[REFLECT](https://arxiv.org/abs/2606.09071)、[Real-Time Detection and Repair](https://arxiv.org/abs/2608.02464)
- [RouteLLM](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5503a7c69d48a2f86fc00b3dc09de686-Abstract-Conference.html) / [GitHub](https://github.com/lm-sys/RouteLLM)、[BEST-Route](https://proceedings.mlr.press/v267/ding25d.html) / [GitHub](https://github.com/microsoft/best-route-llm)、[Learning When to Plan](https://arxiv.org/abs/2509.03581)、[Budget-Aware Tool-Use](https://arxiv.org/abs/2511.17006)
- [LAMaS](https://arxiv.org/abs/2601.10560) / [GitHub](https://github.com/xishi404/LAMaS)、[PASTE](https://arxiv.org/abs/2603.18897)、[Speculative Actions](https://arxiv.org/abs/2510.04371)
- [Cordon](https://arxiv.org/abs/2606.17573)、[ACRFence](https://arxiv.org/abs/2603.20625)、[Revisable by Design](https://arxiv.org/abs/2604.23283) / [GitHub](https://github.com/zhiyuanZhai20/stream-agent)、[DeltaBox](https://arxiv.org/abs/2605.22781)
- [UFO2](https://arxiv.org/abs/2504.14603) / [GitHub](https://github.com/microsoft/UFO)、[OmniParser](https://github.com/microsoft/OmniParser)
- [SkVM](https://arxiv.org/abs/2604.03088) / [GitHub](https://github.com/SJTU-IPADS/SkVM)、[SkillSmith](https://arxiv.org/abs/2605.15215) / [GitHub](https://github.com/AetherHeart-AI/Aeloon)、[SkillsBench](https://arxiv.org/abs/2602.12670) / [GitHub](https://github.com/benchflow-ai/skillsbench)
- [LMCache](https://github.com/LMCache/LMCache)、[SGLang](https://github.com/sgl-project/sglang)、[KVFlow](https://arxiv.org/abs/2507.07400)

其中 2026 年的新预印本和低成熟度仓库只能作为设计线索；进入实现前必须再次检查版本、许可证、复现材料与本地适配性。

---

## 12. 最终 Definition of Done

本方案只有在以下条件全部满足时才算收口：

- T1、C1 各自完成 baseline、holdout、shadow、默认开关决策和可回退验证；
- F1 已依据失败样本门槛作出“实施或不实施”的书面决定，未达门时不留半成品框架；
- 累进实验能分离工具、上下文、恢复三轴贡献；
- 文档记录实际收益、失败案例、关闭条件和最终默认值；
- 没有新增常驻服务、在线学习、自动记忆确认、权限扩大或不可审计副作用重放。

若最终只交付 T1 和 C1，而 F1 因性价比门未通过被取消，这仍是本方案的成功结果。
