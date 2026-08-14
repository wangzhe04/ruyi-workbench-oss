# 18 · M5 实施文档 — debug-root-cause 二分复现记录器（候选 D 波第二个）

> 关联：`07-microagent-lessons.md` §4 M5 / §5 候选 D 波、`17-m5-methodology-tools.md`（M5 首个工具的入库/对抗范式）。
> 基线：2026-08-13 工作树（首个工具 `codebase_symbol_search` 已交付 `700b055`，Escapade 2.5.0 线）。**先落文档再动代码**；M5 纪律 =「一次只做一个 + 过第 49 波新工具入库全部门 + 用 M4 单轴消融验证收益再做下一个」。
> 性质：本文档覆盖 **M5 三个候选中的第二个**（debug-root-cause 二分复现记录器）；data-insights 数据画像摘要**本波不做**。

---

## 0. 一句话结论

调试的方法论核心是**证伪/排除法**（二分复现：排除一半假设，而非"找到第一条支持证据就停"）。Ruyi 现有的 loop guard（打转检测）与 M3 coverage（漏项检测）都是通用机制，缺「假设」这个调试特有概念。本工具 `debug_hypothesis` 把「假设 → 实验 → 证伪」落成确定性状态机：机器追踪每个假设的状态（pending/refuted/supported/confirmed）、检测重复实验、并在锁定根因时提醒「还有 N 个假设未排除」——对症 `07 §6` 记录的「loop 早停」前科。

---

## 1. 问题

- `debug-root-cause` 模板（`08-agent-runs.js`）的 `verify` 节点要求「对 hypo_a/hypo_b 的每个假设逐一验证、锁定最可能单一根因」，但没有任何工具帮模型追踪「哪些假设已验证、哪些已证伪、哪些还没碰」——模型靠自觉，容易**反复验证同一假设（loop）**或**只验证了第一条看似合理的就下结论（早停）**。
- 现有 loop guard 抓「完全相同调用 / 结果无进展」，M3 coverage 抓「输入项没覆盖」，但都没有「假设」概念——调试特有的"排除法"（二分）无法被机器显式追踪。

---

## 2. 工具契约

### 2.1 注册四元组

| 维度 | 值 |
|---|---|
| 工具名 | `debug_hypothesis` |
| pack | `code`（与 `code_review_scan`/`codebase_symbol_search` 同族） |
| tier | `read`（纯确定性计算，无文件/exec 副作用，同 `todo_write` 的「规划行为」口径） |
| paths | `null`（不触任意路径；`guardNote` 录在案） |

### 2.2 inputSchema

```json
{
  "type": "object",
  "properties": {
    "action": { "type": "string", "enum": ["init", "test", "conclude", "status"], "description": "状态机动作" },
    "hypotheses": { "type": "array", "items": { "type": "object" }, "description": "init: 假设数组 [{id, description, mechanism?, expectedEvidence?, verification?}]" },
    "ledger": { "type": "object", "description": "当前台账快照(上一轮返回的 ledger);test/conclude/status 必传,init 忽略" },
    "hypothesisId": { "type": "string", "description": "test/conclude: 目标假设 id" },
    "result": { "type": "string", "enum": ["supports", "refutes", "inconclusive"], "description": "test: 实验结果" },
    "evidence": { "type": "string", "description": "test: 实验描述+观察(what you did and what you saw)" }
  },
  "required": ["action"]
}
```

### 2.3 状态机语义（确定性）

| 转换 | 触发 | 结果 |
|---|---|---|
| 假设登记 | `init` | 每假设 → `status:'pending'` |
| 证伪 | `test(result:'refutes')` | 假设 → `status:'refuted'` |
| 支持 | `test(result:'supports')` | 假设 → `status:'supported'`（**不等于 confirmed**——多条假设可能都被部分支持，须 conclude 显式锁定） |
| 无结论 | `test(result:'inconclusive')` | 假设保持 `pending` |
| 锁定根因 | `conclude(hypothesisId)` | 该假设 → `status:'confirmed'`，台账 `concluded: hypothesisId` |

### 2.4 防 loop 早停（机器统计，非 LLM 判断）

- **重复实验检测**：某假设对同一 `result` 值有 ≥2 次实验 → `status` 返回 `duplicateWarning`（「假设 H1 已重复验证同一结论，请换策略或标记证伪」）。
- **早停完整性**：`conclude` 时若仍有 `pending` 假设 → 返回 `earlyStopWarning`（「仍有 N 个假设未排除」）+ `pendingHypotheses` 清单。**不阻止** conclude（模型可覆盖），但警告可见。
- `status` 始终返回 `stats = { total, pending, refuted, supported, confirmed }`。

---

## 3. 实现方案（纯函数，零依赖）

### 3.1 核心算法

`debugHypothesis(args)` 是纯函数：读 `action`，对传入的 `ledger` 做确定性变换，返回新 `ledger` + `stats` + 警告。无内部持久化状态——**台账快照由调用方（模型）在对话中自持**：每轮把上一轮返回的 `ledger` 原样传回。

### 3.2 代码切入点（共享作用域拼接，零 import）

| 文件 | 改动 |
|---|---|
| `app/src/11-native-tools.js` | 新增 `debugHypothesis(args)` 纯函数（紧邻 `codebaseSymbolSearch` 之后） |
| `app/src/12-tool-dispatch.js` | `CODE_TOOL_HANDLERS` 加 `debug_hypothesis`（`paths:null`，`guardNote:"纯确定性状态机计算,不触文件路径"`） |
| `app/src/07-autonomy.js` | `NATIVE_TOOL_PACKS` 加 `debug_hypothesis: 'code'`；`NATIVE_TOOL_TIER` 加 `debug_hypothesis: 'read'` |
| `app/src/13-http-router.js` | `MCP_TOOLS` 加 `debug_hypothesis` schema（§2.2） |

---

## 4. 入库全部门（第 49 波纪律）

| 门 | 落地 |
|---|---|
| **契约** | §2 schema/返回形状；e2e 逐条直调断言 |
| **fake 回归** | 新 e2e `debug-hypothesis.e2e.js` 直调 `/api/tools/debug_hypothesis`，覆盖 init/test(三种 result)/conclude/status + 重复实验 + 早停完整性 |
| **description 审计** | `MCP_TOOLS` description 遵守「何时用 + 何时别用 + 参数约定」（§2 实现时） |
| **行为锁** | `tool-dispatch.e2e.js` L1 工具数 `56 → 57`；L4 键集一致 |
| **门面数字** | `facts.json` `nativeTools 56 → 57`、`e2eCount 223 → 224`（跑 `facts-generate.js`） |
| **构建** | `node app/build.js` 重建 `app/server.js` |

---

## 5. 消融设计（M4 工具轴，后续执行）

同 `17 §5`：本工具落**工具轴**。debug-root-cause 模板「注入 `debug_hypothesis`」vs「不注入」跑 HB360 固定子集，记 outcome/process/cost 三指标单轴收益。**本波不跑**（需真实 provider + 固定 benchmark/holdout）。

---

## 6. 验收（本波）

1. 新 e2e `debug-hypothesis.e2e.js` 全绿：init 登记、test 三态转换、conclude 锁定 + earlyStopWarning、status 统计 + duplicateWarning。
2. `tool-dispatch.e2e.js`（L1=57）、`facts.static.e2e.js`（nativeTools=57、e2eCount=224）全绿。
3. `node app/build.js` 重建后 `facts.static` 产物断言通过。
4. 模板接入后 `agent-workflow-templates.e2e.js`、`prompt-snapshot.static.e2e.js` 回归绿。

---

## 6.1 对抗验证收口（2026-08-13）

首版提交后经 critic 子代理对抗审查（verdict unsafe，**非越权**——纯函数无 fs/exec/网络副作用，`tier=read`+`paths:null` 正确——而是**状态机逻辑缺陷**），亲验并修复：

1. **HIGH-1**：`conclude` 可把「已证伪」或「从未测试(pending)」的假设静默确认为根因。**修复**：仅 `supported` 且 `tests` 含 ≥1 条 `supports` 的假设可 conclude，否则拒绝。
2. **HIGH-2**：`test` 允许 `refuted → supported` 复活，且 supports↔refutes 矛盾无警示。**修复**：证伪是 sticky 终态（refuted 不可被 supports 复活，拒绝）；新增 `contradictionWarning`（同一假设 supports+refutes 并存）。
3. **MEDIUM-3**：`earlyStopWarning` 只统计 `pending`，漏掉「已 supported 但未排除」的竞争假设。**修复**：未排除集合 = `status ∈ {pending, supported}`（非 refuted、非 confirmed）。
4. **LOW-6**：`ledger.concluded` 只写不读 → 重复 conclude 覆盖、confirmed 后仍可 test。**修复**：conclude 已 concluded 拒绝；test confirmed 拒绝。
5. **LOW-7**：init 有假设数上限，重入 ledger 无上限。**修复**：重入 ledger 浅拷贝 + hypotheses≤50 + 每条 tests≤50 + 非法 status 回落 pending。
6. **LOW-8**：duplicateWarning 按 result 计数误报（两次独立 supports 被报成 loop）。**修复**：仅 supports/refutes ≥2 告警，inconclusive 不算重复；矛盾检测独立。
7. **LOW-9**：原地 mutate 入参 ledger，与「纯函数」声明相悖。**修复**：浅拷贝 `ledger2`，不原地改入参。

e2e 重写为 25 断言，覆盖上述全部边界（证伪 sticky、矛盾、conclude pending/refuted 拒绝、竞争假设告警、重复 conclude/confirmed 再测拒绝、非法参数）。

---

## 7. 本文档未做项（诚实性）

- **advisory 定位，非强制（MEDIUM-5）**：台账由模型在对话中自持（无服务端落盘/签名/复核），故「防 loop / 防早停」是**建议性**而非强制——模型可整体伪造 ledger 绕过。schema description 已按 advisory 措辞降级，不承诺确定性。若要真确定性，需服务端按 sessionId 落盘 ledger 并拒绝非本会话/被篡改台账（成本高，留待消融证明收益后再评估）。
- **台账不独立落盘文件**：跨 attempt 重试 / 跨节点的独立落盘（走 `propose_task` 的 run 级闭包注入模式）留待后续——`saveAgentRun` 的 `atomicWriteJson` 会整体序列化 run，届时落盘成本低。
- **不跑 HB360 消融**：§5 的收益验证留待后续真实 provider 回测。
- **data-insights 候选本波不做**：遵守「一次只做一个」。
