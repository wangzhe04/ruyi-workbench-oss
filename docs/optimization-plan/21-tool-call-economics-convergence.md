# 21 · 工具调用经济性校准与收敛——真实轮次、批次调度、参数历史与元工具链

> 状态（2026-08-27 同步）：**E0/E1、E2a/E2c、E3/E5 已有实现，主动优化开关仍关闭，E2b/E4 延后；E0/E1 抽样→总量口径待修，尚不能视为完整可信基线**。下列 2026-08-17 记录保留为实现与历史测试证据，不等于默认启用或总体收益已证明。
> **22 号线衔接**：第 0 步先修计量口径；A 类确定性／本地基准与 B 类固定真实模型／后端任务可验证限定范围，不统一等待长期用户数据。改变模型输入的 E3/E4/E5 提示部分仍须真实模型 A/B；HB360 历史对账、20-T1 真实 search 数据门与 20-C1 High 阻断不被合成测试替代。详见 [22 号方案](22-agent-soc-microarchitecture.md) §4／§6。
> 决策日期：2026-08-17
> 实施记录（2026-08-17）：
> - **E0**：三层账本 shadow 已上线 —— `toolEconomicsShadowV1` 默认 `true`（带采样与每回合 400 条事件上限），在 provider 工具循环落地 `model_call_started/completed`、`assistant_tool_batch`、`tool_call_completed`、`tool_phase_completed` 五类脱敏事件，`modelCallId → assistantBatchId → toolCallId` 三层关联可对账；`openAiStreamOnce` 增补 `providerResponseId` 辅助字段；`dev-harness/economics-shadow.e2e.js` 离线假 provider 全链路验证通过（含并行 read 批 strategy/criticalPath 断言）。
> - **E1**：`dev-harness/economics-report.js` 基线报表上线 —— 只读脱敏账本事件，输出六类报表：模型调用（calls/task、tool-bearing ratio、usage source、cached share、pairing 对账）、批次形态（width 分布、并行/只读/混合占比、>8 纯 read 候选岛）、工具阶段（toolsMs/criticalPath/serialEstimate/speedup）、参数历史（argsBytes/resultBytes 分布与 Top-N 工具）、元工具链（孤立 meta 批、search→load→invoke 三跳链、重复 search）、缓存稳定性（schema fingerprint 翻转、historyBytes 趋势）。参数"后续重复携带次数"标注待 E3 双视图、"stable prefix bytes"标注待 E4 shadow。CLI：`node dev-harness/economics-report.js [logDir]`；单元测试 `dev-harness/unit/economics-report.test.js` 与 e2e 集成断言全部通过。
> - **E2**：E2a 已实施 —— `boundedReadSchedulerV1` 默认 `false`（严格布尔归一化 + `boundedReadConcurrencyV1` clamp 1..8）；>8 纯 read 批走 worker pool（并发公式 `min(8, max(4, width))`，≤8 保持现状全量 = 决策 B），`tool_phase_completed` 扩展 `pool_read` strategy 与 `queueWaitMs`；`dev-harness/read-pool.e2e.js` 14 断言（12 read pool / 开关 off 回退串行 / 混合批串行）全过。E2c 离线重放 `read-pool-replay.js` 上线：254 真实批 / 597 调用，pool vs serial p95 -26%，legacy==pool（决策 B 零回归证据），但 >8 批样本为 0 → 维持开关关闭等数据积累。E2b（混合批岛）因样本不足延后。详见 [`21-E2-bounded-read-scheduler.md`](21-E2-bounded-read-scheduler.md)。
> - **E5**：元工具链收敛三块已实施 —— ① `tool_search` 紧凑调用提示（`metaToolHintsV1` 默认 `false`，开启后每个 Top-K 候选附 `requiredArgs`/`argTypes`/`callHint`(direct|tool_load|tool_invoke_*)/`state`(loaded|callable|blocked)+原因码，只加字段不改排序）；② `discoverySeq` 链路关联（纯观测随 `toolEconomicsShadowV1`：tool_search 开链带 `searchSeq`，60s 内 tool_load/tool_invoke_*/load 后直调的具体工具继承 `discoverySeq`，`awaitingOutcome` 标记链终点）；③ `todo_write` 内容哈希去重（`metaToolHintsV1` 开启后相同 normalize 内容返回 `unchanged:true` 并跳过落盘，账本记 `deduped:true`，配对铁律不变）。`dev-harness/meta-tools.e2e.js` 14 断言全过（含开关 off 零回归：search 形状不变、todo 照常重复写）。
> - **E3**：参数历史双视图已实施 —— `actionArgumentModelViewV1` 默认 `false`。大参数写动作（`ACTION_VIEW_TOOLS`：file_write/edit/delete/move/copy、archive_zip/unzip、http_download、script_run、powershell_run、tool_invoke_edit/exec，阈值 ≥512B）执行后落 `session.actionAudit`（随会话头持久化，上限 200 条；只存元数据+sha256，原始 arguments 保留在 providerHistory 原消息可还原）；`buildBody`（chat 与 responses 两路径共用）把命中且 `status=completed`、sha256 校验通过的 actions 投影为紧凑 envelope（`_ruyiActionRef/target/payload/status`），失败/中断/malformed/白名单外不投影。e2e：5000B 参数 → 后续请求 arguments 260B（−95%），providerHistory 原文零损失，开关 off 逐字节不变。**对抗验证 8 项全过**（pairing id 保留、sha256 篡改拦截、幂等、无命中零拷贝、malformed args 拒投影、路径穿越 basename 净化、audit 200 上限、failed 不瘦身）。
> - **HB360 对账门**：因本机无 HB360 数据标记为 **blocked/deferred**，出门改用本地脱敏日志重放（见 §3.3）。
> 证据范围：当前 Ruyi Provider 工具循环、本机脱敏聚合日志、HB360 101 条任务结果及原始 SSE。外部分析附件只作为问题清单和待验证假设，不作为实现指令或事实源。
> 目标：先把“真实模型调用、一次响应内工具批次、工具执行耗时、历史参数成本”拆开计量，再以单轴实验收敛成本和时延，同时守住权限、配对、checkpoint 与任务结果。

---

## 0. 决策摘要

本轮不接受“Ruyi 不支持批量工具调用，所以 1,636 次工具调用等于 1,636 个模型轮次”的结论。当前代码已经支持模型在一次响应中给出多个 tool call，也能并发执行一部分纯原生只读批次；HB360 适配层会把同一模型响应中的多个工具结果展平为多个合成响应，不能直接拿合成轮次计算 API 调用数、逐轮 token 或逐轮成本。

本方案按以下顺序推进：

1. **E0 修正事实源**：建立 `modelCallId → assistantBatchId → toolCallId` 三层账本，停止用代理展平轮次代替真实模型调用。
2. **E1 建立经济性 shadow**：统一记录模型阶段、工具阶段、批次宽度、元工具链、大参数历史和缓存前缀变化，先找真实损耗来源。
3. **E2 优化安全只读调度**：把 `2–8 个且全为安全原生 read` 的全有或全无并发，升级为有界 worker pool 和可证明无依赖的只读并行岛。
4. **E3 缩减已执行动作的历史视图**：执行与审计仍保留完整参数，后续模型历史只保留可核验的紧凑 action envelope，优先处理 `file_write`、`file_edit`、脚本与嵌套代理参数。
5. **E4 稳定缓存前缀与工具 schema**：易变内容移到当前回合尾部，已加载工具顺序保持 append-only，减少跨回合前缀失配。
6. **E5 收敛元工具链**：减少孤立 `todo_write`，让 `tool_search` 返回足够的紧凑调用提示，并用可关联事件验证 search/load/invoke 是否真的减少模型调用。

20-T1 工具检索与 20-C1 observation 瘦身继续遵循各自的数据门。本方案不会借“工具成本优化”绕过它们的主动启用阻断，也不把多个改动捆成一次无法归因的上线。

### 0.1 第一阶段目标，不作收益承诺

| 指标 | 当前可用基线 | 第一目标 | 说明 |
|---|---:|---:|---|
| 真实模型调用/任务 | 约 `10.1–10.4` | `8.5–9.2` | 基线来自两种覆盖范围不同的信号，E0 后冻结 |
| 孤立元工具批次 | E1 重放后冻结 | 降低 `≥30%` | 不以删除必要计划或权限步骤换取 |
| 大动作参数历史字符数 | E1 重放后冻结 | 降低 `≥70%` | 只缩后续 model view，不改实际执行参数 |
| read-heavy 工具阶段 p95 | E1 重放后冻结 | 降低 `≥20%` | 主要是 wall-clock 收益，不等同于模型调用下降 |
| non-cached input tokens | E1 重放后冻结 | 降低 `15–30%` | 需 provider usage/cache 证据支持 |
| 总成本 | HB360 校准后冻结 | 首期降低 `15–25%`，stretch `30%` | 不承诺从 `$0.77` 直接降至 `$0.35–0.45` |

任务结果总通过率相对下降不得超过 `1pp`，任一关键切片不得超过 `2pp`；tool-call/result 配对、权限、checkpoint、回滚与审计证据回归必须为零。

---

## 1. 事实校准：先区分四个“轮次”

工具经济性至少包含四种不同单位，后续报表不得混写为“调用轮次”：

| 单位 | 定义 | 可回答的问题 |
|---|---|---|
| `model_call` | 一次真实上游 API 请求/响应 | 固定输入、推理与网络成本发生了几次 |
| `assistant_batch` | 一条模型响应中给出的本地 function calls 集合 | 模型是否已经批量规划、批次宽度是多少 |
| `tool_call` | 一个具体工具动作 | 工具使用频率、成功率和参数规模 |
| `tool_phase` | 一批工具从可执行到结果全部配对完成的阶段 | 并发调度实际节省了多少 wall-clock |

### 1.1 HB360 复核结果

对 101 条 HB360 结果重新按 adapter metadata 与原始 SSE 复核，得到：

| 信号 | 总量 | 每任务均值 | 限制 |
|---|---:|---:|---|
| 适配器合成轮次 | `1,739` | `17.22` | 同一 assistant batch 会按 tool result 展平，不能视为 API 调用 |
| 适配器 usage/request 元数据 | `1,022` | `10.12` | 个别任务 usage 缺失，覆盖不完整 |
| 原始 SSE `response.created` | `1,051` | `10.41` | 原始行存在截断，需 E0 与请求侧 ID 对账 |
| 展平记录里的工具调用 | `1,636` | `16.20` | 适合算工具量，不适合算模型量 |
| 原始 SSE 可恢复的 function calls | `1,593` | `15.77` | 少于展平记录，主要受原始行截断影响 |

原始 SSE 中可识别出 `871` 个带工具的 assistant batch，其中 `348` 个包含多个工具调用，占约 `40%`；平均每个带工具 batch 为 `1.829` 个工具，最大宽度 `16`。这直接证明“每轮只能调一个工具”不是当前实现事实。

可识别批次宽度分布如下；`0` 表示模型直接输出文本、没有本地 function call：

| 宽度 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12 | 16 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 批次数 | 180 | 523 | 198 | 61 | 35 | 22 | 12 | 11 | 2 | 4 | 2 | 1 |

任务 `002` 是最小反例：真实上游调用约 3 次，但适配器生成了 5 个合成轮次；第二次模型响应同时发出 3 个 `file_read`，原始 SSE 分别位于不同 `output_index`。因此，旧的“17.2 轮降到 9 轮”应改写为两个独立目标：**真实模型调用约 10.1–10.4 次/任务，争取降到 8.5–9.2；工具阶段时延另行优化。**

### 1.2 旧成本推导的可用与不可用边界

- 总账单、整任务总 token 和整任务结果仍可用于任务级对比，前提是 provider usage 完整。
- 任何按 `1,739` 合成轮次分摊的单轮成本、单轮 token、缓存命中和“每工具必触发一次模型”的推导全部暂停使用。
- `$0.77 → $0.35–0.45` 只能保留为待验证 stretch 假设，不能进入 roadmap 承诺。
- E0 完成前，真实调用基线使用 `10.1–10.4` 区间，不在两个覆盖不同的信号中择一包装成精确真值。

---

## 2. 当前代码事实与真正缺口

### 2.1 已经具备的能力

1. [`06b-prompt-registry.js`](../../ruyi-workbench/app/src/06b-prompt-registry.js) 的 batching 规则已经要求参数确定、互不依赖的调用在同一助手消息中发出。
2. [`07-autonomy.js`](../../ruyi-workbench/app/src/07-autonomy.js) 的 Responses SSE 解析器按 `call_id/item_id` 维护多个 function-call 槽，能接收交错到达的参数 delta；Chat Completions 也保留完整 `tool_calls` 数组。
3. [`09-workflow.js`](../../ruyi-workbench/app/src/09-workflow.js) 将一条 assistant batch 作为一个带多个 `tool_calls` 的历史消息写入，再按原顺序补齐对应 tool result，保证 strict provider pairing。
4. 现有执行器已对 `2–8` 个、全部属于安全原生 read、没有控制面工具的批次使用 `Promise.all`，并在消费结果时恢复原顺序。
5. `iter_timing` 已记录 `llmMs/toolsMs/nTools/parallelBatch`，可作为 E1 的兼容起点。
6. `createToolLoadingState` 已经是按需装载：auto 模式保留完整 catalog，但不会仅因 pack 命中就注入全部桥接 schema。这里不需要再做一次“把所有 ACC 工具从初始上下文砍掉”的重复优化。

### 2.2 当前缺口

| 缺口 | 当前行为 | 影响 |
|---|---|---|
| 并发是全有或全无 | 纯 read 批次只在宽度 `2–8` 时并发；`>8` 或混合批次整体回退串行 | 大只读批次和混合批次的安全并行机会丢失 |
| 工具参数原样进入历史 | assistant `tool_calls[].function.arguments` 保存完整 `rawArgs` | 大文件写入、patch、脚本和嵌套代理任务在每次后续模型调用重复付费 |
| 结果瘦身不处理参数 | `truncateToolResult` 只处理 tool result | 20-C1 即使完善，也不解决 action argument 重复成本 |
| 易变层插入第一条 user | 每次 build body 都把 `turnVolatile` 前置到最早 user 消息 | 易变内容靠近历史开头，可能破坏跨回合 prefix cache |
| 工具 schema 顺序可能变化 | 新装载工具按 catalog/current 重建 | 新 schema 可能插到旧 schema 前，扩大缓存首个变化位置 |
| 检索 shadow 只在实际 search 时发生 | 只有模型调用 `tool_search` 才产生 `tool_retrieval_shadow` | 看不到“本应 search 但没 search”及初始工具注入是否过宽 |
| 检索结果调用提示不足 | 主要返回 name/pack/tier/description | 模型可能多走一次 `tool_load`，或猜错代理参数 |
| 元工具链无关联 ID | search/load/invoke/todo 只能靠时序猜测 | 无法证明三跳链、重复搜索或孤立 todo 是否造成额外 model call |

本机现有日志的脱敏聚合进一步说明：`874` 条 `iter_timing` 中有 `219` 个多工具 batch、`96` 个并行 read batch，平均 batch 宽度 `1.396`、最大 `12`。这说明批量能力实际在用，但执行并发覆盖仍有限。与此同时只有 `4` 条 20-T1 shadow 事件，远不足以做主动启用决策。

---

## 3. E0：建立不可混淆的调用账本

> **2026-08-27 核查／待修复**：运行时前 12 次调用全采，之后每 4 次采 1 次，每回合最多 400 条 economics 事件；economics-report 仍直接按 started 条数算 callsPerTask。按该规则构造 40 次调用只报 19 次，且 1:1 配对检查仍通过。因此下文“请求总量可对账”是待实现的目标，不是现有抽样日志已经满足的事实。轻量精确总量须与可抽样明细分开；记录采样／截断／缺失覆盖，区分 turn/task、逻辑调用／HTTP attempt 及子节点／摘要费用。修复验收可用已知答案的合成长短任务，不等待长期用户数据。

### 3.1 事件模型

为每个 provider turn 增加以下关联键，全部为本地随机/单调 ID，不记录原始提示词或参数：

```text
traceId
└─ modelCallId                 一次真实 HTTP 请求
   └─ assistantBatchId         一条模型响应
      ├─ toolCallId            一个本地 function call
      ├─ toolCallId
      └─ toolCallId
```

建议事件：

| 事件 | 必需字段 |
|---|---|
| `model_call_started` | `traceId/modelCallId/turnSeq/iter/apiStyle/toolSchemaFingerprint/historyBytes/estimatedInputTokens` |
| `model_call_completed` | `modelCallId/providerResponseId/usageSource/input/output/cache tokens/llmMs/finishReason` |
| `assistant_tool_batch` | `modelCallId/assistantBatchId/nTools/toolNamesHash/batchWidth/rawArgsBytes` |
| `tool_call_completed` | `assistantBatchId/toolCallId/name/tier/status/toolMs/argsBytes/resultBytes` |
| `tool_phase_completed` | `assistantBatchId/strategy/maxConcurrency/toolsMs/criticalPathMs/serialEstimateMs` |

`toolNamesHash` 只用于聚合批次形态；调试模式如需具体工具名，应沿用当前本地日志的权限和保留策略，不进入默认 telemetry。

### 3.2 对账规则

- 请求侧 `model_call_started` 与终止事件必须一一配对；流中断可用 `state=incomplete/failed` 结束，不能漏记。
- `providerResponseId` 仅作辅助，Responses 与 Chat Completions 都以请求侧 `modelCallId` 为主键。
- 一个 assistant batch 可以有 0、1 或多个 tool call；一个 tool call 只属于一个 batch。
- 展平代理输出只能作为导出视图，必须携带原始三层 ID；导出条数不得反推真实模型调用数。
- usage 缺失时明确标 `usageSource=estimated`，不得与 provider-reported usage 混求精确均值。

### 3.3 E0 出门门槛

- HB360 101 条任务中，请求侧 model-call 数与 SSE 响应起始数差异可解释；无静默漏记。**【blocked/deferred —— 本机无 HB360 数据；改由本地脱敏日志重放对账（`model_call_started` 与 `model_call_completed` 必须一一配对），门槛验收随真实使用积累推进】**
- 任取 20 条多工具任务，`assistantBatchId`、tool-call 顺序和 provider pairing 人工抽查一致。**【blocked —— 待本地真实多工具会话积累后抽查；离线 e2e 已覆盖并行 read 批的批次/顺序/配对一致性】**
- 报表同时输出 `model calls / assistant batches / tool calls / tool phases`，禁止只显示一个模糊的 rounds。**【部分满足 —— 事件层已落账；报表生成器随 E1 上线】**
- 给 06-HB360 历史报表增加口径版本；旧结果不删除，但明确标为 `synthetic_round_v0`。**【blocked —— 依赖 HB360 报表数据源】**

---

## 4. E1：工具调用经济性 shadow

E1 只增加观测和离线报表，不改 prompt、工具 schema、调度和 provider history。它是后续所有主动实验的共同基线，但每个主动改动仍必须单轴运行。

### 4.1 核心报表

| 报表 | 指标 |
|---|---|
| 模型调用 | calls/task、tool-bearing ratio、calls after final artifact、usage source、cached/non-cached input |
| 批次形态 | batch width、可并行 read 比例、`>8` 纯 read、混合批次、声明/推断依赖 |
| 工具阶段 | toolsMs、critical path、串行估算、队列等待、资源锁等待、provider/UI bridge 等待 |
| 参数历史 | argsBytes/tool、后续重复携带次数、估算 input tokens、Top-N 大参数工具 |
| 元工具链 | solo todo/search/load/invoke、三跳链、重复 search、首次有效工具耗时 |
| 缓存稳定性 | stable prefix bytes、first changed segment、tool schema fingerprint/order delta |

### 4.2 HB360 元工具复核只作线索

原始 SSE 可恢复样本中：

| 工具 | 调用数 | 所在 batch | 孤立 batch | 与其他工具同批 | 最大 batch |
|---|---:|---:|---:|---:|---:|
| `todo_write` | 134 | 134 | 65 | 69 | 7 |
| `tool_search` | 30 | 26 | 15 | 11 | — |
| `tool_load` | 16 | 16 | 15 | 1 | — |
| `tool_invoke_exec` | 34 | 34 | 33 | 1 | — |
| `file_read` | 619 | 219 | 33 | 186 | 16 |
| `file_write` | 255 | 151 | 81 | 70 | 6 |
| `file_edit` | 47 | 36 | 31 | 5 | 7 |

因此“134 次 todo 等于 134 个模型轮次”以及简单把 search/load/invoke 调用数相加推导三跳链都不成立。E1 必须用关联 ID 识别真实链路，再判断哪些步骤是必要控制面、哪些是可减少的孤立模型往返。

### 4.3 隐私与保留

- 默认事件不记录 raw query、raw args、文件内容、脚本正文或路径。
- 原始工具调用参数已存在本机会话；离线重放可就地读取，只输出计数、分桶、HMAC 指纹和人工确认后的脱敏标签，不复制成新日志。
- query/args 的字符数、语言类别、字段数和大小桶可记录；需要跨事件 join 时优先使用 `toolCallId/searchSeq`，HMAC 只用于内容去重。
- shadow 保留期沿用现有本地日志策略；任何上传或跨机器汇总另行授权。

---

## 5. E2：有界只读批次调度器

### 5.1 第一版范围

只优化已被模型放进同一 assistant batch、且参数已经确定的调用，不自动把不同模型轮次的动作重排到一起。

1. **纯 read 批次改为 worker pool**：宽度超过 8 时不再整体串行；按默认并发 4、上限 8 分波执行。
2. **混合批次提取只读并行岛**：在不跨越显式依赖、权限决策或资源冲突的前提下，同一连续安全 read 段可并发；edit/exec/control 仍按原顺序串行。
3. **结果顺序不变**：执行完成顺序可以不同，写入 provider history 和发送 `tool_result` 的顺序必须与 assistant tool_calls 一致。
4. **bridge 默认不并发**：只有 connector 显式声明 thread-safe、无共享 UI/文档会话副作用，才进入 read pool。
5. **资源锁仍优先**：worker 获得 lease 后才执行；排队时间单独计量，不能用高并发绕过资源互斥。

### 5.2 禁止并发的第一版集合

- 所有 write/edit/exec、permission、plan、todo、mission、steer、spawn/orchestrate/wait 控制面工具。
- 任何读取结果会决定同 batch 后续调用参数或授权范围的链路。
- 同一 Office 文档、桌面窗口、浏览器 profile 或未声明 thread-safe 的 MCP/ACC connector。
- loop guard 已触发、批次内存在非法参数、或任一调用需先审批的批次。

### 5.3 Provider 能力处理

- Ruyi 接收端继续无条件兼容多 function calls。
- Chat Completions 可增加 provider capability：`parallelToolCalls = auto | enabled | disabled`；只有 provider 明确兼容时才发送相应请求参数。
- Responses 路径当前已经按多调用事件解析，不为追求形式一致盲目添加 provider 不支持的字段。

### 5.4 E2 验收

- `>8` 纯 read、混合 read/edit、权限拒绝、loop abort、steer 中断、bridge 资源冲突均有 pairing 回归。
- 任意失败/中断后，每个 tool call 恰有一个 result 或显式 skipped/refused result。
- read-heavy `tool_phase p95` 相对同任务串行基线下降 `≥20%`；模型调用数不作为 E2 强制收益，因为调度只改变工具阶段。
- 默认并发 4 与 8 做压力对照；CPU、句柄、provider 限流或 UI 争用恶化即回退 4。

---

## 6. E3：已执行动作的参数历史视图

### 6.1 问题

当前 `providerHistory` 保存 assistant tool call 的完整 `rawArgs`，Responses 转换时再原样输出为 `function_call.arguments`。如果 `file_write` 写入几十 KB 内容，后续每次模型调用都会再次携带这段内容；`truncateToolResult` 只缩结果，无法消除这部分重复输入。

“先把内容写临时文件再传引用”并不能消除模型第一次生成内容的成本，还会增加文件生命周期、权限和失败恢复复杂度。第一选择应是：**完整参数只用于执行与审计；动作成功后，在后续模型视图中替换为可核验的紧凑 envelope。**

### 6.2 双视图设计

| 视图 | 内容 | 用途 |
|---|---|---|
| execution/audit view | 原始 `rawArgs`、内容哈希、checkpoint/rawRef | 执行、撤销、审计、本地恢复；不丢数据 |
| provider model view | 工具名、关键非敏感字段、目标 basename/hash、操作大小、结果状态、rawRef/hash | 告诉模型“做了什么、是否成功”，避免重复传完整 payload |

候选 envelope 示例：

```json
{
  "_ruyiActionRef": "action-v1:…",
  "target": { "kind": "path", "basename": "report.md", "pathHash": "…" },
  "operation": "file_write",
  "payload": { "chars": 48231, "sha256": "…" },
  "status": "completed"
}
```

优先工具：`file_write`、`file_edit`、`script_run`、`powershell_run`、`tool_invoke_edit/exec` 及含嵌套大 JSON 的代理调用。read 参数通常很小，不在首期处理。

### 6.3 时序与兼容性

- 工具执行前必须保留原始 arguments，provider 要求的 assistant/function_call 与 tool result pairing 在当次迭代中不得改形。
- 工具执行并持久化 audit view 后，**仅在下一次请求构建 model view 时**投影成 envelope，不就地破坏会话原始记录。
- Responses 与 Chat Completions 分别做协议回归；如果 provider 对历史 function_call arguments 做严格一致性校验，则该 provider 保持原样并记录 `reducerUnsupported`。
- 失败、部分写入、checkpoint 未完成、待审批和恢复中的动作不得过早瘦身。
- 与 20-C1 分开：E3 处理 action arguments，20-C1 处理旧 observation/result；两者不得同批主动实验。

### 6.4 E3 数据门

- 先用保存的本机会话离线投影，不对每次线上请求做双份大 JSON 测量。
- 至少覆盖 50 个大参数动作、20 个失败/中断动作、Responses/Chat 两类 provider。
- model-view 参数字符数下降 `≥70%`；原始 audit/checkpoint 证据零损失。
- pairing、继续对话、失败恢复、回滚和会话重载全部通过；任何 provider 400 增加即阻断主动启用。

---

## 7. E4：稳定前缀与工具 schema 顺序

### 7.1 易变层位置

当前 `turnVolatile` 在构建每次请求时插入**历史中第一条 user 消息**。这虽然不持久化，但只要易变内容变化，缓存前缀的首个差异就出现在很早的位置，可能使后面稳定历史无法复用。

候选改法：

- stable system prompt 保持首部不变。
- 历史消息保持 append-only，不重写最早 user。
- 本回合易变能力、memory/skill 索引和任务策略放到**当前最新 user 消息的尾部或独立的当前回合 context item**。
- 对 Chat 与 Responses 分别选择 provider 支持且不破坏语义的位置；不得假设所有 provider 都有同样的 cache 规则。

### 7.2 工具 schema append-only

- 会话首次建立时冻结初始 schema 顺序和 fingerprint。
- `tool_load` 新增 schema 只追加，不按完整 catalog 重新排序。
- 卸载/权限阻断优先保留位置并改变可调用状态；若 provider 不支持禁用标记，则在下一自然回合重建并记录 cache break 原因。
- 相同 schema 采用规范化 JSON 后计算 fingerprint，避免对象键顺序造成伪变化。

### 7.3 E4 shadow 指标与门槛

- 对同一请求同时计算 current/candidate 的 `stablePrefixBytes`、`firstChangedSegment`、schema order delta 与估算可缓存 input，不发送 candidate。
- 只有 provider usage 明确返回 cache token，或固定重放能稳定测得延迟/费用差异时，才主张真实缓存收益。
- 当前回合指令、图片、权限提示、steer 与 compaction 摘要的语义必须保持；任务结果非劣。
- 若 candidate 只是把动态内容移后、却因 provider cache 边界导致无收益，停止该 provider 上的主动实现。

---

## 8. E5：元工具链与控制面收敛

### 8.1 `todo_write`

保留重要或多步骤任务先计划的规则，但把更新频率从“每个动作”收敛到“阶段变化”：

- 初始 todo 可与第一批互不依赖的读取同一 assistant batch 发出；执行器仍按控制面安全顺序处理。
- 相同内容哈希、没有状态变化的重复 todo 拒绝写入并返回 `unchanged`。
- 完成态优先由最终结果/阶段完成事件表达，不要求为了形式再单独产生一个模型调用。
- 指标：`soloTodoBatches/task`、重复内容率、todo 后无实际工具动作比例、因删减 todo 导致的遗漏/返工。

### 8.2 `tool_search` 返回紧凑调用提示

每个 Top-K 候选除 name/pack/tier/description 外，增加有界字段：

- `requiredArgs`：必填参数名、基础类型、最多一个短示例；禁止回传完整大 schema。
- `callHint`：`direct`、`tool_load` 或 `tool_invoke_read/edit/exec`。
- `state`：`loaded/callable/blocked`，blocked 必须包含不泄漏敏感信息的原因码。
- `score/coverage/margin/reject/rejectReason`：供模型判断置信度，也供 shadow 对账。

高置信、单一、简单 schema 的候选可以从 search 直接进入 `tool_invoke_*`；复杂 schema、低置信或需要多工具包时仍先 `tool_load`。不做不可解释的自动调用。

### 8.3 链路关联

新增 `discoverySeq`，关联一次发现过程中的：

```text
search → repeat_search? → load? → invoke/direct_call → invalid_args? → outcome
```

记录 `selectedRank`、meta hops、schema bytes delta、time-to-first-valid-use、abandoned、最终工具结果和任务结果弱标签。只有这样才能判断“少一次 load”是否真的少了一次 model call，而不是把错误推迟到 invoke。

---

## 9. 20-T1 工具检索的数据规划

20-T1 当前只能在模型实际调用 `tool_search` 时比较 legacy/candidate，且本机只有 4 条真实 shadow，不能主动启用。下一阶段需要两条数据线：

1. **离线 HB360 重放**：从本地会话/原始 SSE 提取已发生的 search、最终选择和后续工具结果，重放 legacy/candidate；输出脱敏标签，不复制 raw query。
2. **organic shadow**：继续收集真实 `tool_search`，补齐中英混合、负例、大 catalog、权限阻断和真实后续选择。

### 9.1 shadow 事件扩展

| 类别 | 字段 |
|---|---|
| 关联 | `toolCallId/searchSeq/discoverySeq/traceId/turnSeq` |
| catalog | `catalogSize/catalogFingerprint/loadedCount/callableCount/blockedCount` |
| query 特征 | `charCount/tokenCount/zhCount/enCount/symbolCount`，不记 raw query |
| baseline/candidate | `topK nameHash/score/coverage/margin/reject/reason/elapsedMs` |
| 下游弱监督 | 未来 1–3 个调用是否选择候选、两侧 rank、repeat/load/invoke/invalid/abandoned/outcome |
| 成本 | `schemaBytesDelta/metaHops/timeToFirstValidUse/modelCallsToUse` |

仅靠 actual-search shadow 仍看不到两类问题：模型本应 search 却没 search，以及初始注入是否过宽。它们需要独立的 **initial tool routing shadow**，输入只用任务特征和初始工具集合，不能与 T1 主动开关捆绑。

### 9.2 主动启用门槛

- 至少 `200` 次真实 search，其中负例/无需工具 query `≥50`；中文、英文、混合语种均有覆盖。
- catalog `>200` 的样本 `≥50`；另保留 1,000 catalog 性能探针。
- 已选择工具的 Recall@5 不低于 baseline，MRR 有统计上可复现的提升。
- 负例 non-empty rate `≤5%`；blocked 工具不得被标成 callable。
- p95：catalog `≤200` 时 `<15ms`，catalog `1000` 时 `<25ms`。
- meta hops、invalid args、time-to-first-valid-use 与任务结果非劣。

在达到这些门槛前，20-T1 继续 shadow。现有 23 条无关/攻击 query 中 candidate 有 14 条返回非空，以及 1,000 catalog p95 约 `20.806ms` 的结果，说明正例收益不能替代负例拒绝门。

---

## 10. 20-C1 边界

20-C1 继续保持主动启用阻断，必须先修复并重放验证：

- 纯文本失败漏保护；
- 超宽结构化结果产生非法 JSON；
- 重复压缩非幂等；
- checkpoint/写操作证据误压缩风险；
- `rawRef`/marker 的可验证、可还原与幂等契约。

C1 数据收集优先离线读取保存的 session history，不在每次 live call 复制整段 history 造成新的性能税。C1 与 E3 都通过后，仍要先分别单轴开启；最后才允许做组合实验，验证双 reducer 没有互相隐藏证据。

---

## 11. 开关与实验纪律

建议开关均默认 `false`；shadow 可以默认开启，但必须有采样和上限：

| 开关 | 阶段 | 默认 | 作用 |
|---|---|---|---|
| `toolEconomicsShadowV1` | E0/E1 | `true`（采样） | 三层账本与成本聚合，不改行为 |
| `boundedReadSchedulerV1` | E2 | `false` | worker pool 与安全 read islands |
| `actionArgumentModelViewV1` | E3 | `false` | 后续请求使用 action envelope |
| `volatileTailLayoutV1` | E4 | `false` | 易变层移至当前回合尾部 |
| `appendOnlyToolSchemasV1` | E4 | `false` | 新工具 schema 稳定追加 |
| `metaToolHintsV1` | E5 | `false` | search 调用提示与链路关联 |

实验使用 session-sticky 分桶，确保同一长会话不在中途切换历史布局。**2026-08-27 排序衔接**：原 E2 → E3 → E4 → E5 仅保留为旧候选顺序，当前首批按 22 号方案 §4.3 先校准计量，再验证 E4 缓存与 E2 增量，E3/E5 不因关联自动启用。先通过 A／B 类限定范围证据，再申请显式 opt-in 或受控 canary；有代表性流量时按 5% → 25% 扩围，默认启用另评估，不把等待自然流量设为工程验证的统一前置。E3 与 E4 都会改变后续模型输入，shadow 只能验证确定性投影和协议兼容，**不能**估计模型行为变化；固定任务集上的真实模型 A/B 不可省略。

---

## 12. 实施切片与工作量

| 阶段 | 产出 | 预计工作量 | 前置/出门 |
|---|---|---:|---|
| E0 | 三层 ID、真实 model-call 报表、HB360 口径迁移 | 2–3 天 | 101 条对账、20 条人工抽查 |
| E1 | economics shadow、离线 session/HB360 重放、基线报告 | 3–5 天 | 指标覆盖和隐私审计通过 |
| E2 | bounded read worker pool、安全并行岛、pairing/资源测试 | 4–6 天 | tool-phase p95 与零配对回归 |
| E3 | 双视图 action envelope、协议兼容矩阵、恢复/审计测试 | 5–8 天 | 参数历史 -70%、证据零损失 |
| E4 | volatile tail、schema append-only、cache shadow/A-B | 3–5 天 | non-cached input/延迟有证据改善 |
| E5 | todo 去重、search hint、discovery chain 报表 | 3–5 天 | solo meta -30%、invalid/outcome 非劣 |
| T1/C1 follow-up | 按各自门槛修复、小流量与组合实验 | 数据驱动 | 不预排默认启用日期 |

阶段可以并行开发测试夹具，但主动实验必须串行，确保收益和退化可归因。

---

## 13. 完成定义（DoD）

### 13.1 正确性与安全

- 每个 assistant tool call 在所有完成、失败、拒绝、中断路径都有且只有一个配对 result。
- permission、read-before-edit、checkpoint、undo、steer、loop guard 与 agent resource lock 行为逐字节或语义等价。
- 完整参数和原始结果仍可在本地 audit/recovery 路径验证；model view 的缩减不能成为数据删除。
- 不新增远程 telemetry、常驻服务、数据库或在线学习。

### 13.2 效果

**2026-08-27 口径限定**：下列目标保留为本线候选门，不是 22 号线全部必交项或已取得收益。正式实验须用校准后的计量，对当前实现、指定任务族／模型冻结阈值；E2 的串行对照只作诊断，新增收益须对比当前 legacy。固定构造任务可形成限定范围证据，不冒称日常总体收益；质量实验采用配对重复并报告置信区间，证据不足不宣告非劣（22 号方案 §6.4）。

- E0 后所有成本报告明确区分 model call、assistant batch、tool call、tool phase。
- 第一阶段至少满足：真实模型调用 `8.5–9.2/task` 或解释为何 meta 不是主因；大动作参数历史 `-70%`；read-heavy tool phase p95 `-20%`；solo meta batch `-30%`。
- 总成本先以 `-15–25%` 为成功区间；stretch `-30%` 只有在任务结果、缓存 usage 和账单同时支持时才对外表述。
- overall outcome 相对下降 `≤1pp`，关键切片 `≤2pp`；安全/审计类回归为零。

### 13.3 停止条件

- 如果 E0 证明模型调用并非主要成本，不再以“减少轮次”为主叙事，转向 args/history 或 provider 定价优化。
- 如果 E2 的工具阶段占总时长过低，保留简单 worker pool，不继续扩大 bridge 并发面。
- 如果 provider 不允许历史 arguments 投影，E3 对该 provider 停用，不用破坏 pairing 的兼容 hack 强推。
- 如果 E4 没有 provider cache usage 或稳定延迟证据，不以估算 prefix bytes 宣称省钱。
- 如果 T1 负例拒绝、C1 证据保护或任务结果未过门，保持 shadow，不因其他阶段有收益而联带开启。

---

## 14. 与现有方案的关系

- [`06 · HB360 成本收敛`](06-hb360-cost-convergence.md)：继续承载 benchmark 总体收敛；本方案补充真实调用口径和工具经济性。旧合成轮次保留但必须标版本。
- [`20 · 运行时优化性价比`](20-runtime-optimization-cost-benefit.md)：继续负责 20-T1 检索、20-C1 observation reducer、20-F1 failure telemetry；本方案负责调用账本、执行调度、action arguments、cache layout 与元工具链。
- [`12 · Agent 架构研究`](12-agent-architecture-research-roadmap.md)：本方案不引入学习型路由、在线训练或新 runtime service；未来如需学习型调度，必须回到 R3/M4 的离线 champion–challenger 门。

这条线的核心不是“再造一套工具系统”，而是先把已有多工具能力正确计量，再从执行、历史和控制面三个真实成本源逐项收敛。
