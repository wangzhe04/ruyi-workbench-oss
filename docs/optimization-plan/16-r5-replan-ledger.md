# 16 · R5 实施文档 — Replan Patch Ledger（可审查重规划提案层）

> 关联：`12-agent-architecture-research-roadmap.md` §1 R5（P1，C3 后主线）、`07-microagent-lessons.md`、`06-hb360-cost-convergence.md` O6。本文档把 R5 细化到可执行：现状、数据契约、触发与应用、威胁建模、fake e2e、验收与未做项。
> 基线：2026-08-12 工作树（阶段 C 全完成、R4 已收口 S1/S2/S3、M1/M3/M4 已交付）。**先落文档再动代码**（沿用 M1/M3 约定）。
> 代码锚点为 `app/src/*.js`（`app/server.js` 是 build.js 拼接产物）。

---

## 0. 一句话结论

Ruyi 已具备节点失败处置（`failurePolicy`/`degradedPolicy`/`maxRetries`/`retryFallback`）、loop/stall guard、任务池 `taskPool`、Mission 任务账本、R1 Evidence Graph（`requireEvidence` 证据缺口）。R5 **不重做 orchestrator**，而是在这些触发点之上补一个**结构化的可审查变更提案层** `replanPatch`：当节点失败/质量拒绝/证据缺口/停滞/资源冲突发生时，不直接永久阻塞，而是生成一份「新增/移除/重连节点、改工具 tier、继承或废弃证据、预期增量成本、回滚点」的 patch 提案，**默认用户批准后才应用**；低风险只读补证据任务沿用既有 task-pool 策略，写入/权限变更走现有审批。旧模板零迁移（未声明重规划意图时行为逐字节不变）。

---

## 1. 问题与目标

**问题**（12 §1 R5）：Ruyi 已有 Mission、持久 DAG、loop/stall guard、retry、任务池与人工插话，但这些机制各自为政——节点失败后要么按 `failurePolicy` 机械 retry/block，要么 `degradedPolicy=request_review` 时**暂停等人工**却**不给一份可执行的修复建议**。用户面对「卡住了」没有结构化的「改哪里、代价多少、怎么回退」的选择。

**目标**：
1. 把「偏离计划」归并为一份**可审查的 `replanPatch` diff**，逐项列出图变更与理由；
2. 应用默认用户批准；低风险只读补证据沿用 task-pool 的 auto 策略；写入/权限变更走现有审批；
3. patch 应用前可回滚，拒绝不改变运行；
4. 旧模板不声明重规划意图时行为不变——零迁移。

---

## 2. 现状（已主会话核实）

### 2.1 节点失败与降级处置（`09-workflow.js`）

- 节点字段（`09-workflow.js:89/165` 归一化）：`failurePolicy ∈ {block,continue,retry}`、`degradedPolicy ∈ {accept,retry,request_review,fail}`、`maxRetries(0..5)`、`retryFallback ∈ {continue,block}`。
- **降级处置块**（`09-workflow.js` 约 L70194，`pol = node.degradedPolicy`）：
  - `fail` → 置 `failed`（`errorClass='degraded_fail'`）；
  - `retry` → `purgeNodeEvidence` 后重新入队；
  - `request_review` → `runtime.paused=true` + `run.pendingReview={nodeId,warning,at}`，**仅暂停，不生成修复提案**（R5 落点）；
  - `accept` → no-op（保持 succeeded + degraded 元数据）。
- **loop/stall guard**：`loopIteration` / `noProgressCount` / `progressFingerprint`；`NODE_NO_PROGRESS_ABORT_AT=40` → 归因 `semantic_stall`（区别于 `idle_timeout`）。
- **错误归类**：`errorClass ∈ {idle_timeout, semantic_stall, gate_rejected, degraded_fail, unclassified}`，`gate_rejected` 对应质量门拒绝。

### 2.2 任务池 taskPool（`09-workflow.js`）

- `poolPolicy ∈ {manual, auto-capped, off}`，`proposeTaskImpl` 供节点主动提案新任务；`POOL_MAX_TOTAL` 上限；auto 策略下由运行时决定 `decidedBy:'auto'`。
- 收尾 `closing` 态后提案/审批入口一律 409——**已有「提案-决定」分离的先例**，R5 的 patch 审批可复用同一语义。

### 2.3 Mission 任务账本（`07-autonomy.js` / `13d-core-domain-routes.js`）

- `mission = { goal, milestones:[{id,desc,status:pending|done|blocked}], autoMode, budget/spent, budgetExhaustedAt }`。
- `mission_update` 工具 tier=`read`（`07-autonomy.js:1484`，规划/元数据写，auto-allow）；`buildMissionPromptSection` 注入 `<mission-ledger>` 围栏。
- **缺口**：Mission 记录「目标+里程碑进度」，但**没有把偏离计划的补救动作（改图/改 tier/补证据）结构化为可审 diff**（R5 落点）。

### 2.4 R1 Evidence Graph（已完成，`935ad73`）

- 节点输出含 `evidenceRefs`；高风险门 `requireEvidence` 强制证据覆盖；运行时拒绝不存在/越权引用；无证据断言标 `unverified`。→ R5 的「evidence_gap」触发点直接复用其缺口判定。

---

## 3. 变更方案

### 3.1 `replanPatch` 数据契约

```js
run.replanPatches = [{
  id: 'replan-<random>', runId, sessionId,
  trigger: { type: 'node_failed'|'gate_rejected'|'evidence_gap'|'stall'|'resource_conflict',
             nodeId: '...', errorClass: '...', detail: '...' },
  changes: [{
    op: 'add_node'|'remove_node'|'rewire'|'change_tier'|'change_engine'|'change_role'
       |'inherit_evidence'|'drop_evidence',
    target: 'nodeId', from: '...', to: '...', reason: '...',
  }],
  expected: { costDelta: 0, riskLevel: 'low'|'medium'|'high', rollbackPoint: 'run.nodes snapshot seq' },
  status: 'pending'|'approved'|'rejected'|'applied'|'rolled_back',
  createdAt: '...', decidedAt: '...', appliedAt: '...',
}]
```

约束（机器校验，不靠模型自觉）：
- `target` 必须是本 run 现存节点 id（`add_node` 允许新 id，但须经 `SKILL_ID_RE` 类校验）；
- `change_tier`/`change_engine`/`change_role` 不得把节点从低 tier 抬到高 tier（防越权），且目标值须在合法枚举内；
- `inherit_evidence` 引用的事件/文件必须仍在 run.evidence 内（复用 R1 越权拒绝）；`drop_evidence` 不删除原文、只改引用；
- patch 含 `change_tier`/写入/权限类变更时 `riskLevel` 强制 ≥ `medium`，走用户审批，不进 auto。

### 3.2 触发点映射

| 现有信号 | patch trigger.type |
|---|---|
| 节点 `failurePolicy=block` 且重试耗尽 / `degraded_fail` | `node_failed` |
| `gate_rejected` / `degradedPolicy=request_review` | `gate_rejected` |
| `requireEvidence` 未满足（R1 缺口） | `evidence_gap` |
| `semantic_stall` / `idle_timeout` | `stall` |
| `waiting` 节点超时 / 资源等待 | `resource_conflict` |

### 3.3 生成与应用流程

```
触发信号 → 生成 replanPatch 提案（模型 review 角色 / 确定性规则）
        → 机器校验（§3.1 约束，非法即拒）
        → 呈现：riskLevel=low 且只读 → 沿用 taskPool auto 策略（decidedBy:'auto'，不逐条弹窗）
                其余 → runtime.paused + pendingReview（request_user_input 弹窗，用户批准/拒绝）
        → 应用（approved）：snapshot run.nodes → 改写图 → 重跑受影响节点
        → 回滚（rolled_back）：恢复 snapshot；拒绝（rejected）：不改变运行
```

关键决策：
- **生成者双轨**：`evidence_gap`（确定性，缺啥补啥）走确定性规则生成；`node_failed`/`gate_rejected`/`stall`/`resource_conflict` 走模型 review 角色生成，但都过 §3.1 机器校验。
- **应用前 snapshot**：`run.replanBaseline = deep-copy(run.nodes)`，回滚点即此快照；patch 应用后 `run.metrics` 记 `replanApplied` 计数。
- **拒绝/回滚不改运行**：与 taskPool 的 409-closing 语义一致。

### 3.4 兼容性

- 旧模板节点无重规划意图字段 → 不生成 patch，行为与现状逐字节一致；
- 不新增必填字段到节点 schema（`replanPatches` 是 run 级数组，默认 `[]`）；
- 后端 gate/vote/loop 判定不受影响，patch 纯上游注入 + 审批。

---

## 4. 构建纪律

改 `09-workflow.js`（run 结构 + 触发/应用逻辑）+ `07-autonomy.js`（若涉及 mission 关联）后运行 `node app/build.js` 重建 `server.js`，再 `node app/build.js --check` 校验 manifest 行区间。src 与产物同 commit。

---

## 5. 验收 e2e（fake e2e，先于实现写）

### 5.1 新增行为断言（`agent-workflow-replan.e2e.js`）

- **触发→生成→校验→呈现**：构造一个 `failurePolicy=block` 节点并注入确定性失败；断言 run 落一条 `replanPatches`，`status='pending'`，且 `changes` 全部过 §3.1 校验。
- **非法 patch 被机器拒**：patch 含不存在的 `target` 或 `change_tier` 抬 tier → 校验拒绝，不呈现、不改运行。
- **拒绝不改运行**：用户拒绝 → `status='rejected'`，`run.nodes` 与 patch 前逐字节一致。
- **批准应用 + 回滚**：用户批准 → `status='applied'`、图变更生效、受影响节点重跑；回滚 → 恢复 `replanBaseline`。
- **低风险只读走 auto**：`evidence_gap` 补只读证据节点 → `decidedBy:'auto'`，不弹窗、不 `runtime.paused`。
- **旧模板零迁移**：不触发重规划时 `run.replanPatches` 为空数组，节点行为与基线一致。

### 5.2 回归面

- 全体 `agent-workflow-*.e2e.js`、`agent-quality-*.e2e.js`——存量节点不生成 patch、不 reject、不改变行为；
- `prompt-snapshot.static.e2e.js`——若 E 段锁到 run 结构变化，按 intentional 流程更新快照（§6）。

---

## 6. 威胁建模与护栏

| 项 | 处置 |
|---|---|
| **模型自批自用** | patch 必须过 §3.1 机器校验（引用存在、tier 不越权、枚举合法）；应用效果回写不得以 LLM 自评为成功 |
| **越权变更** | `change_tier`/写入/权限变更强制 `riskLevel≥medium` 走用户审批，不进 auto |
| **拒绝/回滚语义** | 拒绝不改变运行；应用前 snapshot，回滚恢复基线；与 taskPool closing-409 同语义 |
| **图爆炸** | `replanPatches` 数组设上限（沿用 taskPool `POOL_MAX_TOTAL` 的防膨胀思路）；单 patch `changes` 设上限 |
| **恢复不对称** | 与 M1 同源问题：patch 应用后 run 持久化须含 `replanBaseline`，续跑时基线缺失则禁止再回滚（明示 degraded），不静默 |
| **结果回写 R3** | R3（Champion–Challenger Lab）当前暂缓；本波只记录 patch 的 `appliedAt`/效果摘要到 run 记录，**不写回 R3**（R3 立项后再接） |

---

## 7. 验收标准（✅ 已实现 2026-08-13）

实现 commit 的验收标准：
1. `node app/build.js --check` 无 manifest 过期红；
2. §5.1 六条新增断言绿；
3. 相关 `agent-workflow-*.e2e.js` / `agent-quality-*.e2e.js` 回归绿，存量节点不 reject、行为不变；
4. `prompt-snapshot.static.e2e.js` 绿（或快照 intentional 更新）；
5. 主会话亲自跑验收，不用子代理报告。

---

## 8. 实现状态与诚实性（2026-08-13 收口）

**已完整实现**（端到端闭环：触发→提案→review 生成 changes→审批→apply/rollback）：

- 数据契约 + 机器校验 + 触发点 `111723c`
- apply/rollback 引擎（change_tier 仅降级 + add_node）`6922e48`
- 审批路由 + UI 卡片 + i18n `26e1186`
- review 子代理自动生成 changes `40d0113`
- 越权对抗修复（add_node 强制 read tier + review 子代理工具面收紧）`292cf29`

**诚实性说明（已知限制，非缺陷）**：

- **apply 改图后重跑依赖 resume**：审批发生在节点终态后，run 通常已收尾离开调度器。apply 把失败节点置 `queued`/新增 `queued` 节点，但**不会自动执行**——需用户 resume run 才会重跑受影响节点。改图即时生效，重跑是显式续跑动作。
- **add_node 固定 read tier**：补节点强制 `toolTier='read'`、不继承失败节点的 role/tier（防 review 只读建议越权生成 exec 节点）；未来需更高 tier 的补节点走 `change_tier`（仅降级，无法抬级）另议。
- **其余图操作暂缓**：remove_node / rewire / change_engine / change_role / inherit_evidence / drop_evidence 涉及下游一致性、角色引擎解析、证据图变更，未实现（apply 时诚实拒绝）。
- **未接 R3 效果回流**：R3 暂缓，本波只落 run 记录，不写回离线评测数据。
- **未回填模板的重规划策略**：8 个内置模板未声明 `replan`（零迁移），按需声明触发/生成策略是后续单独立项。
