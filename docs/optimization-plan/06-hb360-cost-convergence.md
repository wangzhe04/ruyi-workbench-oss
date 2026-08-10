# 06 · HB360 成本与收敛优化规划

> 基线：harness-bench-360 对比测试（2026-08-08），106 任务 × 4 Harness（OpenClaw / Hermes / Ruyi / Codex），底层模型 deepseek-v4-flash。
> 本文档由 HB360 实测数据 + 双向代码核查（benchmark 侧 `Harnessbench-compare` + Ruyi 侧 `ruyi-workbench/app/src`）汇总而成。
> 行号对应分析时的 `app/src/*.js` 当前版本，改动后会漂移，请以就近搜索为准。

---

## 0. 一句话结论

Ruyi 在 HB360 的表现是「快但糙、烧 token、细节失守」：速度第二快、从不彻底失败，但**成本是 Hermes 的 3.95 倍**（$3.47 vs $0.89），且在「穷尽核验 + 精确产物」类任务上系统性输给 Hermes/Codex。根因不在「按需加载没了」，而在 **OpenAI 引擎路径漏了对齐 Claude 引擎的桥接工具裁剪策略**，叠加分类器正则过宽 + 缺收敛止损 + 缺产物自检。四件事修齐，性价比可从倒数第一跃至前二。

---

## 1. 表现定位（106 任务 × 4 Harness）

| 指标 | OpenClaw | Hermes | **Ruyi** | Codex | Ruyi 排名 |
|---|---|---|---|---|---|
| Outcome（客观完成度） | 0.632 | 0.813 | **0.786** | 0.791 | 第 3 |
| Combined（综合） | 0.230 | 0.436 | **0.406** | 0.379 | 第 2 |
| Efficiency（效率） | 0.501 | 0.528 | **0.510** | 0.636 | 第 3 |
| 总成本 | $1.18 | $0.89 | **$3.47** | $1.58 | 倒数 1 |
| 平均耗时 | 156s | 152s | **98s** | 92s | 第 2（快） |
| 成功率 | 92.9% | 94.0% | 91.8% | 95.0% | 倒数 1 |

Ruyi 的 Outcome 仅比 Hermes 低 2.7 个百分点，成本却是其 3.95 倍——**性价比最差**。

### 1.1 Token 与成本根因（聚合 99 个 Ruyi 任务）

| Harness | 平均 input_tokens | 平均 cache_read | 总成本 | 成本来源 |
|---|---|---|---|---|
| hermes | 24,372 | 331,704 | $0.89 | calculated |
| openclaw | 37,462 | 569,952 | $1.18 | calculated |
| codex | 141,254 | 137,124 | $1.58 | calculated |
| **ruyi** | **303,317** | 270,245 | **$3.50** | calculated |

Ruyi 每任务平均 input 303K tokens，是 Hermes 的 **12.4 倍**。成本口径一致（均 `calculated` 统一定价），差距是真实 token 量级差异。

### 1.2 「原地打转不收敛」——失败任务反而更烧

| Outcome 区间 | 任务数 | 平均 calls | 平均 input_tok | 平均成本 | 平均耗时 |
|---|---|---|---|---|---|
| ≥0.9（成功） | 39 | 8.3 | 292K | $0.034 | 93s |
| 0.6–0.9 | 40 | 7.5 | 264K | $0.031 | 96s |
| **<0.6（失败）** | 20 | **10.2** | **405K** | **$0.047** | **115s** |

失败任务比成功任务调用更多、烧更多 token、耗时更长。典型：`087-cli-parser-bug-tests` 27 calls / 192 万 input tokens / $0.217 / outcome 0.55。Ruyi 的 `outcome==0` 任务数为 0——从不彻底崩溃，低分全是「做出了东西但不够准/不够全」。

### 1.3 细节精度失守——产物框架对、关键 check 挂掉

| 任务 | outcome | 失败的高权重 check | 根因 |
|---|---|---|---|
| 073-research-repro-package | 0.42 | `missing_expectation_coverage`(w=0.4)、`no_false_repro` | CSV 没覆盖全部 4 类 gap；错误宣称复现成功 |
| 077-archive-manifest-defense | 0.34 | `manifest_required`(w=6)、`safe_files_required`(w=4)、`reject_core_required`(w=4) | 把 q2.csv / Q2.csv 当重复，漏文件，6 接受/8 拒绝（应 7/7） |
| 092-schema-drift-audit | 0.33 | `drift_identity`(w=0.18)、`rejects_parseable`(w=0.12) | 产物结构对，但 drift 标识/严重度/数值算错 |
| 091-financial-reconciliation | 0.48 | `recon_amounts`(w=0.3)、`rejects_exact`(w=0.14) | 把金额放进 invoice_usd 而非 payment_usd，CSV 与摘要不一致 |

Ruyi 输给 Hermes 最多的任务（073 -0.48、077 -0.38、091 -0.30、050 -0.28、029 -0.23）几乎全是「逐项核验 + 精确数值/清单」类。Ruyi 赢 Hermes 的任务则集中在确定性强的执行类（001/002/005/009/011/045/052/106）。

---

## 2. P0 真相核查：按需加载是有的，没被迭代掉，桥接也没配错

双向代码核查结论（benchmark 侧 `adapters/ruyi.py:53-58` + Ruyi 侧 `app/src/*.js`）：

1. **benchmark 请求体只有 4 个字段**（message/cwd/title/permissionMode），无任何工具参数；Ruyi 的 `/api/chat/stream` 也不从请求体读工具参数。**不是桥接配错。**
2. **`toolLoadingMode: 'auto'` 是 Ruyi 内置默认**（`01-config.js:83`），校验仅允许 `'auto'`/`'full'`（`01-config.js:400`）。**没被迭代掉，auto 就是「按需加载」模式。**
3. **`classifyToolPacks`**（`07-autonomy.js:603`）按 prompt 关键词正则选包，从 375 筛到 105-284，**机制在工作**。
4. **关键发现：同一个 auto 模式，两条引擎路径策略完全不同——**

| 引擎路径 | 桥接工具处理 | 实际注入 | 代码位置 |
|---|---|---|---|
| **Claude 引擎** | 桥接工具**全部隐藏**在 `tool_invoke_read/edit/exec` 代理后，不注入 schema | ~15 个 | `01-config.js:1405` |
| **OpenAI 引擎**（测试用 deepseek 走这条） | 桥接工具**按包整组注入完整 schema** | 105-284 个 | `09-workflow.js:1194` |

**根因不是「按需加载没了」，而是 OpenAI 引擎路径漏了对齐 Claude 路径的裁剪策略**，叠加 `classifyToolPacks` 正则过宽（任何编程任务激活 4-6 个包，ACC 的 100+ 工具名带 `get_/list_/read_`，一旦 `files_read` 激活就全进）。

**附带 bug**：benchmark 传的 `permissionMode: "full"` 不在合法值列表（`['default','acceptEdits','plan','auto','bypass']`）里，被静默回落（`10-context-governance.js:700-703`）。与工具数无关，建议顺手修。

---

## 3. 优化项矩阵

| 编号 | 优化项 | 优先级 | 预期收益 | 工作量 | 风险 |
|---|---|---|---|---|---|
| **O1** | OpenAI 引擎对齐 Claude 路径（桥接工具走代理） | **P0** | 成本 ↓60-70% | 中 | 调用轮次略增 |
| **O2** | 收敛/止损看门狗（软硬两级） | **P0** | 失败任务成本 ↓40%+，部分 outcome ↑ | 中 | 阈值需调参 |
| **O3** | 产物落盘前「逐项自检」收尾步骤 | P1 | 弱任务 outcome ↑0.15-0.25 | 小 | 偶尔多一轮 |
| **O4** | 收紧 classifyToolPacks 正则 + 高频白名单 | P1 | O1 之外再 ↓10-15% | 小 | 误裁高风险工具 |
| **O5** | 修复工具层精度 bug（case-variant 去重等） | P1 | 消除系统性失分 | 小 | 低 |
| **O6** | 子代理最小工具集（分治场景） | P2 | 长任务成本 ↓ | 小 | 低 |

---

## 4. 各项详细方案

### O1｜OpenAI 引擎对齐 Claude 路径（P0，核心）

**问题**：`09-workflow.js:1194` 把 `bridged.tools`（328 个）直接 concat 进 `allTools` 并按包注入完整 schema；Claude 引擎 `01-config.js:1405` 则把桥接工具藏在 `tool_invoke_*` 代理后。

**方案**：OpenAI 引擎 auto 模式下，桥接工具不注入完整 schema，只保留 `tool_search`/`tool_load`/`list_tools`/`tool_invoke_read`/`tool_invoke_edit`/`tool_invoke_exec` 元工具 + 原生高频工具。桥接工具仍注册到 catalog 供 `list_tools`/`tool_search` 发现。

**代码切入点**：`09-workflow.js:1188-1196`
```js
// 现状
const ownTools = buildOpenAiTools(config, caps, {...});
const bridged = await collectBridgedTools(config);
const allTools = ownTools.concat(bridged.tools);   // 桥接全量进 catalog
const toolLoading = createToolLoadingState(config, fullPrompt, attachments, allTools, bridgedRoute);
const initialTools = toolLoading.current();         // current() 按包过滤，但包太宽
// 改为：auto 模式下 current() 不返回 bridged.tools 的 schema，只返回 ownTools + 元工具
//       bridged.tools 仅留在 catalog 供 tool_search/tool_load 显式拉入
```

**前置确认**：OpenAI 引擎是否已具备 `tool_invoke_read/edit/exec`（Claude 路径的代理工具）。若已具备，O1 仅改 `current()` 过滤逻辑；若无，需先补元工具的 OpenAI 引擎注册。

**模型调用流程变化**：直接调桥接工具 → `list_tools`(紧凑目录，便宜) → `tool_search` → `tool_invoke_xxx`。多 1-2 轮，但每轮 input 从 303K 降到 ~50-70K。

**预期**：input_tokens 303K → ~60-80K，总成本 $3.50 → ~$1.0-1.3（逼近 Codex）。轮次 +10-15%，净成本仍降 60%+。

**验收**：重跑 HB360 固定子集（20 弱 + 10 强 + 10 中），对比 input_tokens / cost_total / outcome，确认 outcome 不退步。

**风险与缓解**：模型可能不熟「先 search 再 invoke」流程 → 系统提示强化示例（Ruyi 已有 `tool_search` 引导语）；保留 `full` 模式兜底。

---

### O2｜收敛/止损看门狗（P0，阈值重设）

纯「连续 3 次未改 workspace」会误杀正常的读文件/搜索探索。改为**软硬两级 + 区分调用类型 + 重复检测**。

**判定信号**（Ruyi 事件流均可拿到）：
- 探索性调用：`file_read`/`file_search`/`glob`/`tool_search`/`list_tools`/只读 shell
- 改变性调用：`file_write`/`file_edit`/写 shell/`tool_invoke_exec`
- 进展信号：workspace 新增/修改产物文件、命令 exit=0、测试通过

**阈值设计（均可配，默认值如下）：**

| 层级 | 触发条件 | 动作 |
|---|---|---|
| **L1 软提醒** | 滑动窗口 `K=6` 步内：① 无新增/修改产物文件 且 ② 无新成功信号 | 注入系统提示：「已连续 6 步无新进展，下一步请明确：完成产物落盘，或换一个完全不同的策略。」给 1 次自纠机会 |
| **L1 重复检测** | 窗口 `K=6` 内出现 ≥2 次高度相似调用（相同命令/相同文件路径/相同 tool+args 哈希） | 提示：「检测到重复调用 `<x>`，已尝试过此路径，请换策略。」 |
| **L2 强制收尾** | L1 提醒后再观察 `J=4` 步仍无进展 | 强制收尾：立即落当前最佳产物 + 写未决事项，结束本轮 |
| **L3 硬上限** | 单任务：`max_calls=20` / `max_input_tokens=1.5M` / `max_time=300s`（三选一触发） | 同 L2 强制收尾 |

**为什么 K=6 合理**：正常多步调试 = 读 2-3 文件 + 跑 1-2 次测试 + 改 1 处 ≈ 5-6 步会有一次产物变化。6 步还零进展大概率在打转。087 的 27 calls 会在第 6 步触发 L1、第 10 步触发 L2，省掉后 17 calls（约 $0.14）。

**代码切入点**：OpenAI 引擎 turn 循环（`09-workflow.js` 工具调用循环），维护滑动窗口状态对象，每次工具调用后更新并判定。复用 Ruyi 已有 `runtime_state` 与事件流机制。

**预期**：失败任务平均 calls 10.2 → ~7，成本 $0.047 → ~$0.028；部分任务因提前止损避免越改越乱，outcome 反升。

**风险与缓解**：阈值误判 → 全部阈值做成 session 级可配置，初版偏保守（K=6/J=4），用 HB360 回测调参。

---

### O3｜产物落盘前「逐项自检」收尾（P1）

**问题**：073/077/091/092 全是「框架对、漏项/精度错」。Ruyi 已有 `completeness critic` 工作流模式，但单 agent 默认不跑。

**方案**：agent 即将结束（模型输出最终回复、无后续工具调用）时，自动插入自检：
1. 从任务 prompt 提取所有显式要求项（「必须包含 X」「列出所有 Y」「核对 Z」）
2. 逐项核对当前 workspace 产物是否覆盖、数值是否自洽
3. 发现漏项 → 自动追加一轮补全（受 O2 止损约束）

**代码切入点**：turn 循环检测到「模型无 tool_use 且声明完成」的分支，注入自检提示词。复用 Ruyi 已有 prompt 工程基础设施。

**适用范围**：产物为清单/CSV/报告类任务（oracle 多 check）。代码调试类不强制（已有运行反馈）。

**预期**：弱任务 outcome 0.33-0.48 → 0.6+。077 的大小写重复、091 的列错位会被自检抓住。

---

### O4｜收紧 classifyToolPacks + 高频白名单（P1）

**问题**：`classifyToolPacks`（`07-autonomy.js:603`）正则过宽，「代码/file/读取」等词激活整包。

**方案**：
- 收紧正则：`files_read` 只在明确「读取/查看/搜索文件」时激活，而非任何含「file」的消息
- 高频白名单（`07-autonomy.js:662` 的 `current()` 过滤）：无论激活哪些包，`file_read/write/edit/search`、`powershell_run`、`glob`、`todo_write`、`web_search` 等 ~10 个高频工具始终注入，其余按需
- O1 的补充（O1 后原生工具仍按包注入，白名单确保高频不漏）

**预期**：O1 基础上再降 10-15% input。

**风险**：误裁高频工具 → 白名单保守，保留 `full` 模式兜底。

---

### O5｜case-variant 精度缺陷（P1，已核实定性）

**问题**：077 的 q2.csv/Q2.csv 被当重复（Windows 大小写不敏感陷阱），导致 manifest 漏文件。

**核实结论（第 1 波）**：经查 oracle notes（「wrongly treats both q2.csv case-variants as duplicates」），这是**模型生成 manifest 时的认知偏差**，非 Ruyi 文件工具的 case-folding bug--Ruyi 的 `file_list`/`archive_unzip` 保留原始文件名，不做大小写规整。因此 O5 不改工具代码，而是：
- 归入 O3 自检：产物落盘前自检「清单是否区分了大小写不同的文件名」
- 可选：在 archive/manifest 类任务的系统提示里加一句「Windows 文件系统大小写不敏感，但清单须按精确路径字符串区分 case-variant」

**预期**：消除 077 类系统性失分。

---

### O6｜子代理最小工具集（P2）

**问题**：`orchestrate_agents` 子代理若继承全量工具注入，分治反而更烧。

**方案**：分治时子代理强制 `toolLoadingMode='minimal'`（O1 落地后可加此模式）或只传 `core` 包 + 子任务所需包。

---

## 5. 实施路线图（三波）

| 波次 | 内容 | 验收 |
|---|---|---|
| **第 1 波** | O1（OpenAI 引擎对齐）+ O5（bug 核实/修复） | 重跑 HB360 全量，cost 降到 ~$1.5，outcome 不降 |
| **第 2 波** | O2（止损看门狗）+ O4（正则收紧+白名单） | 弱任务 cost ↓40%，087/077 类打转 calls 显著下降 |
| **第 3 波** | O3（逐项自检）+ O6（子代理最小集） | 弱任务 outcome ↑0.15+，长任务成本 ↓ |

每波落地后用 HB360 固定子集回测（20 弱 + 10 强 + 10 中），对比 cost/outcome/combined 三指标，不退步再进下一波。

### 5.1 单轴消融纪律（M4，2026-08-10 并入，见 [`10-m4-ablation.md`](10-m4-ablation.md)）

上表按「波次打包」上开关（如第 1 波 O1+O5），同一波内多项同上时无法归因收益。**M4 强制单轴消融**：

- **独立开关**：每个优化项具备独立开关（行为开关优先，最低「评测开关」——回测脚本能按项标注结果是否受该项影响）。
- **两步回测**：① 单轴——只开该项对比基线，记独立三指标收益；② 全量——开全部项对比上一态，记累进收益，验证无回退。
- **归因轴对齐**（工作流 / 工具 / 上下文三轴）：工作流=编排结构（gate 判定、watchdog/loop）；工具=注入工具集（toolTier/白名单）；上下文=压缩与注入（contextGovernance、coverage 注入）。
- **记账**：每项回测结果记入下表，缺归因条目的优化不得宣称已验收。

**消融记账表**（随每次回测填充）：

| 优化项 | 轴 | 单轴收益 (cost/outcome/combined) | 全量累进 | 是否回退 | 证据文件 |
|---|---|---|---|---|---|
| （待回测项） | | | | | |

---

## 6. 预期终态

| 指标 | 现状 | 目标 | 对标 |
|---|---|---|---|
| 总成本 | $3.47 | ~$1.2-1.5 | 接近 Codex($1.58) |
| 平均 input_tokens | 303K | ~70K | 接近 Hermes(24K) 量级 |
| Outcome | 0.786 | ~0.82-0.84 | 追平 Hermes(0.813) |
| 失败任务 calls | 10.2 | ~7 | 消除打转 |
| 性价比排名 | 倒数 1 | 前 2 | — |

---

## 7. 数据局限说明（诚实性）

- `hermes-local` 目录混入早期失败运行（001/002/005/011 出现 outcome=0，与详细报告 1.000 不符），「Ruyi vs Hermes 任务级差值」赢家侧有噪声；但 Ruyi 弱任务的 oracle 明细是程序化客观检查，结论可靠。
- Hermes/OpenClaw/Codex 的 `api_calls` 字段缺失（source 不同），无法直接对比调用次数；input_tokens 量级差距（12×）足以解释成本。
- Codex 跑了 202 个结果文件（多轮），效率分 0.636 第一可信。
