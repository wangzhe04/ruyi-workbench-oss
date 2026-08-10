# 14 · M2 实施文档 - 确定性节点扩展 + vote 门防误杀（阶段 C 后半）

> 关联：`12-agent-architecture-research-roadmap.md` §1（阶段 C = M2 + R1）、`07-microagent-lessons.md` §4 M2、`09-m3-coverage-gate.md`（M3 coverage 是模型自报先行版，M2 coverage 是机器版）、`13-r1-evidence-graph.md`（M2 coverage 产出的未覆盖清单落入 R1 evidence）。
> 立项：2026-08-10。状态：**已实现（2026-08-10）**。基线：M1/M3/M4 已交付。

---

## 0. 一句话结论

两半：① **vote 门防误杀**--低置信的反对票降级为弃权（可配 `abstainThreshold`，默认 0 不启用，存量零迁移），对症「vote 误杀正确结果」前科；② **确定性节点扩展**--在 vote/dedupe 之外新增 `coverage`（机器计算未覆盖清单，不调模型，是 M3 coverage 的确定性版 + R1 evidence 数据源）与 `propagate`（按依赖边传播赋值，论文拓扑传播的通用化）。两者都是确定性聚合节点，复用现有 vote/dedupe 的短路机制。

---

## 1. 现状（已主会话核实）

### 1.1 vote 实现与误杀根因（`08-agent-runs.js:1169-1190`）
```js
const abstain = new Set(['uncertain', 'abstain', 'unknown']);  // L1172
// L1186: decided = approvals + rejections;  score = approvals / decided
// L1188: pass = contractValid && approvals>=minApprovals && score>=threshold && confidence>=minConfidence
```
- abstain 票已存在且不计入 decided--但**低置信的 negative 票仍计入 rejections**，拉低 score -> 误杀正确结果。
- 阈值已可配：`threshold` / `minApprovals` / `minConfidence`（L1158 normalizeAgentGate）。

### 1.2 deterministic 标记与短路
- `13d-core-domain-routes.js:128`：`deterministic: ['vote','dedupe'].includes(node.gate.mode)`--M2 新 mode 需加入此数组。
- `09-workflow.js:655-671`：vote/dedupe 在 effectiveTask 构造前短路，不调模型--M2 coverage/propagate 同款短路。
- `13-http-router.js:1888`：`gate.mode enum: ['review','verify','vote','cross_review','dedupe']`--M2 新 mode 需加入。

---

## 2. 变更方案

### 2.1 vote 门防误杀（`08-agent-runs.js` aggregateAgentVote）
新增可配 `abstainThreshold`（0..1，默认 0）：
- 投票解析时，若一张票 verdict=negative **且** confidence < abstainThreshold -> 降级为 abstain（不计入 rejections/decided）；
- abstainThreshold=0 时（默认），无任何票降级，行为与现状逐字节一致（存量零迁移）；
- abstain 票在结果里标 `abstained:true` + reason `'low_confidence_demoted'`，可审计。

**对症**：正确结果被低置信反对误杀--降级后该票不拉低 score。

### 2.2 coverage 确定性节点（`gate.mode='coverage'`）
**语义**：对照「输入项清单」与上游节点已处理项，机器计算未覆盖清单，不调模型。

- **输入**：`gate.inputSet`（字符串数组，由模板显式提供，如文件列表/任务子项）+ 上游节点产物中已处理的项（从 `structuredResult.findings`/`claims` 的 evidenceRefs 或专用 `handledItems` 字段聚合）；
- **输出**（`structuredResult`）：`{ total, handled, unhandled[], coverageRatio }`；
- **判定**：`unhandled` 非空 -> 节点 status=rejected（`gate_uncovered`，与 M3 同 errorClass 复用），除非 `gate.allowPartialCoverage`；
- **不调模型**：走 vote/dedupe 同款短路（`09-workflow.js:655` 分支扩展）。

**与 M3/R1 的关系**：
- M3 coverage 是质量门内模型自报（先行提示）；
- M2 coverage 是确定性机器计算（不调模型）--可作 M3 coverage 的校验源；
- M2 coverage 产出的 `unhandled[]` 落入 R1 evidence（kind='artifact' 或专用 kind，见 13 文档 §2.1）。

### 2.3 propagate 确定性节点（`gate.mode='propagate'`）
**语义**：按依赖边传播赋值（论文拓扑传播的通用化）。

- **输入**：上游节点的 `structuredResult.assignments`（如 `{item -> category}`）+ `gate.propagateKey`（传播依据的键）；
- **输出**：传播后的完整 `assignments`，未传播项列入 `unpropagated[]`；
- **判定**：`unpropagated` 非空 -> 节点 status=rejected（`gate_unpropagated`），除非 `gate.allowPartial`；
- **不调模型**：同款短路。

**用例**：上游确定某分类后，下游同类项继承该分类（论文公共类分配的 Ruyi 通用版）；不硬编码 DDD 阶段。

### 2.4 schema / 短路 / 标记三处同步
- `13-http-router.js:1888` gate.mode enum 加 `'coverage','propagate'`；
- `13d-core-domain-routes.js:128` deterministic 数组加 `'coverage','propagate'`；
- `09-workflow.js:655-671` 短路分支加 coverage/propagate 两个 else-if，调用 `aggregateCoverage(depNodes, node.gate)` / `propagateAssignments(depNodes, node.gate)`。

---

## 3. 威胁建模

| 威胁 | 场景 | 缓解 |
|---|---|---|
| abstainThreshold 误配 | 设过高 -> 大量反对票被弃权 -> 假通过 | 默认 0（不启用）；模板配置时文档强调「只对已知低置信噪声场景启用」 |
| coverage inputSet 不全 | 模板提供的 inputSet 漏项 -> unhandled 假阳/假阴 | inputSet 来源成文（模板显式，非推断）；unhandled 项可追溯 |
| coverage 机器判定与 M3 模型自报冲突 | M3 说 handled、M2 说 unhandled | M2 机器版优先（13 文档：机器数据 > 模型自报）；冲突记入 R1 evidence 的 contradicts 关系 |
| propagate 循环依赖 | 依赖边成环 -> 死循环 | propagate 前拓扑排序检测环，有环 -> 节点 failed（`propagate_cycle`） |
| 确定性节点被当模型节点插话 | 13d:1158 已对 deterministic 拒绝插话 | coverage/propagate 加入 deterministic 标记即继承此保护 |

---

## 4. 验收（fake e2e）

### 4.1 vote 防误杀（扩展 `agent-quality-gates.e2e.js`）
- abstainThreshold=0（默认）：低置信反对票仍计入 rejections（行为不变）；
- abstainThreshold=0.6：confidence=0.5 的反对票降级为 abstain，不拉低 score，原本误杀的用例通过；
- 降级票 `abstained:true` + reason 可审计。

### 4.2 coverage/propagate 节点（扩展 `agent-quality-workflow.e2e.js`）
- coverage 节点：inputSet 3 项、上游 handled 2 项 -> unhandled 1 项 -> rejected（`gate_uncovered`）；
- coverage allowPartialCoverage -> 警告不 reject；
- coverage inputSet 全覆盖 -> succeeded；
- propagate 节点：上游赋值传播 -> 完整 assignments；有环 -> failed（`propagate_cycle`）。

### 4.3 回归
- 全体 `agent-workflow-*.e2e.js` / `agent-quality-*.e2e.js`：vote/dedupe 存量行为不变（abstainThreshold 默认 0）；
- M3 coverage 场景仍绿（M2 在 M3 之后判定，不干扰）。

---

## 5. M4 记账

- 轴：工作流轴（确定性节点是编排结构）；
- 单轴收益：vote 防误杀的误杀率↓ / coverage 机器检出的漏项率（非 token）；
- 全量累进：与 M1/M3/R1 同开，验证无回退；
- holdout：audit/vote 类任务分 train/holdout。

---

## 6. 与 R1 的衔接（阶段 C 闭环）

- R1（13 文档）定义证据契约；M2 coverage/propagate 产出的 `unhandled[]`/`unpropagated[]` 是 R1 evidence 的数据源（kind='artifact'）；
- M2 实现时调用 R1 的 evidence 写入接口（若 R1 已实现）；若 R1 未实现，M2 先输出结构化字段，R1 实现时回填引用；
- 阶段 C 实现顺序：R1 先（证据契约）-> M2 后（消费契约），或并行设计、R1 先合。

---

## 7. 实现状态

- **已完成**：vote `abstainThreshold`、确定性 `coverage` / `propagate`、Schema/短路/插话与恢复风险标记同步。
- **已验证**：直接聚合测试、fake workflow e2e、M3/R1 相关回归均通过；`coverage` / `propagate` 不调用模型。
- **后续模板工作**：各模板（audit/insight）如何提供完整 `inputSet`，仍按具体模板单独回填。
- **传播语义边界**：初版实现按 `propagateKey` 继承上游赋值，并支持显式传播边与环检测；不硬编码业务阶段。
- **vote 高阶聚合（相关性校准）**：12 文档 §3 明确暂缓，M2 只做 `abstainThreshold` 防误杀，不做加权/相关性惩罚。