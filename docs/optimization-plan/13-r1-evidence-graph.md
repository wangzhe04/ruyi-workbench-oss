# 13 · R1 实施文档 - Evidence Graph（阶段 C，P0）

> 关联：`12-agent-architecture-research-roadmap.md` §1 R1、`07-microagent-lessons.md` M6（R1 是 M6 的工程化落点）、`09-m3-coverage-gate.md`（M3 coverage 是先行提示，R1 把它落入证据图）。
> 立项：2026-08-10。性质：**设计文档，不动代码**--遵循 12 文档 §2 纪律（先设计 + 威胁建模 + fake e2e + M4 记录再实现）。
> 基线：M1（`0b3100d`）、M3（`9696483`）已交付。代码锚点为 `app/src/*.js`。

---

## 0. 一句话结论

把节点已有的 `evidence`/`artifacts`（散装 findings + continuation 步骤）升级为**可校验的证据图**：每条 claim 带 `evidenceRefs[]` 指向稳定 `eventId` 的证据（工具结果/文件区间/产物/人工确认），运行时拒绝不存在或跨工作区越权的引用，无证据断言标 `unverified` 但不删文本。**不复制原始工具返回**，只建引用关系；复用现有事件日志、文件检查点、`redact()` 脱敏与 `crypto` digest。这是 R2/R3/R4/R5 的共同证据契约基础。

---

## 1. 现状（已主会话核实）

| 能力 | 现状 | 锚点 | R1 缺口 |
|---|---|---|---|
| 节点证据 | `node.evidence = structuredResult.findings.slice(0,50)` | `08-agent-runs.js:1572` | findings 是散装对象，无 `evidenceRef` 指向具体事件/文件 |
| 节点产物 | `node.artifacts` 从 continuation.steps 取 | `08-agent-runs.js:1575` | 产物无 digest、无来源事件绑定 |
| 事件日志 | `recordAgentNodeProgress` 折叠进 `node.progressLog` | `09-workflow.js:316/687` 等 | 事件无稳定 `eventId`，无法被 claim 引用 |
| 脱敏 | `redact()` 已有 | `04-permission-runtime.js:137` | 可复用，但需扩展到 evidence 内容 |
| digest | `crypto.createHash('sha1')` 已用于 session | `02-session-store.js:513` | 可复用做 evidence content digest |
| M3 coverage | 质量门 coverage.unhandled 是先行提示 | `09-m3-coverage-gate.md` | R1 把「未覆盖项」也落入证据图（12 文档 R1 末段） |

---

## 2. 数据契约

### 2.1 evidence（证据节点）
```js
{
  eventId: 'evt_<runId>_<seq>',        // 稳定唯一，单调递增 seq
  kind: 'tool_result' | 'file_span' | 'web' | 'artifact' | 'human_confirm',
  digest: 'sha256:...',                 // 内容 digest（脱敏后计算），可核验不可逆
  ref: { /* 按 kind */ },               // 工具事件 id / 文件路径+行区间 / URL / artifactId / 确认记录
  workspace: '<cwd hash>',              // 归属工作区，防跨工作区越权引用
  ts: iso,                              // 时间
  redaction: 'none' | 'masked' | 'summary_only',  // 脱敏等级
}
```

### 2.2 claim（可核验断言）
```js
{
  text: '...',                          // 断言文本（不删）
  evidenceRefs: ['evt_..._1', 'evt_..._2'],  // 指向 evidence.eventId
  status: 'verified' | 'unverified' | 'contradicted',
}
```
节点 `structuredResult.findings` 与最终交付的断言都带 `evidenceRefs`。**无 evidenceRefs 的断言 status='unverified'**，文本保留但标记。

### 2.3 relation（关系，初版最小集）
`supports` / `contradicts` / `derived_from` / `verified_by`。运行时校验：引用的 eventId 必须存在、同工作区、未过期；跨工作区或不存在 -> 拒绝并标 `unverified`。

---

## 3. 引用校验（运行时）

在节点收尾（`09-workflow.js` gate 判定附近，M3 coverage 判定之后）追加 evidence 校验：
1. 解析 `structuredResult.claims`（或 findings 带 evidenceRefs）；
2. 对每个 evidenceRef 查当前 run 的 evidence 索引--不存在/跨工作区/过期 -> 该 claim status='unverified'，记录拒绝原因；
3. 高风险模板（audit/research 类，由模板配置 `requireEvidence:true`）的交付前：unverified claim 非空时门不通过（`gate_unverified`），与 M3 的 `gate_uncovered` 并列；
4. 非高风险模板：unverified 仅标记，不阻断（兼容存量）。

**不复制原始工具返回**：evidence.ref 指向事件日志/文件检查点，按需展开，不进 graph 全文。

---

## 4. 脱敏与隐私（12 文档红线 3）

- evidence 内容计算 digest 前先过 `redact()`（复用 04-permission-runtime）；
- `redaction='summary_only'` 时 graph 只存摘要 + digest，不存原文（工具原文仍在事件日志，按工作区隔离）；
- digest 不可逆，不会把密钥/凭据写进 graph；
- 跨工作区引用拒绝（`workspace` 字段校验），防项目记忆泄漏（与 R4 呼应）。

---

## 5. 威胁建模

| 威胁 | 场景 | 缓解 |
|---|---|---|
| 伪造证据 | 模型编造不存在的 eventId | 运行时查索引，不存在即 unverified + 拒绝 |
| 跨工作区越权 | 引用别的工作区的证据 | workspace 字段校验，拒绝 |
| 密钥进 graph | evidence 含凭据 | redact + summary_only + digest 不可逆 |
| 过期引用 | 引用已被回滚/删除的检查点 | eventId 带版本/时效，过期标 unverified |
| 自评可信 | 模型自报 verified | status 由机器校验决定，非模型自填 |
| 全局索引泄漏 | 跨项目聚合证据 | evidence 按 run/workspace 隔离，不建全局索引（R4 同纪律） |

---

## 6. 验收（fake e2e）

### 6.1 引用校验
- 构造 claim 带 `evidenceRefs` 指向真实事件 -> status='verified'；
- 指向不存在 eventId -> status='unverified' + 拒绝原因记录；
- 指向跨工作区证据 -> 拒绝；
- 无 evidenceRefs -> status='unverified'，文本保留。

### 6.2 高风险模板门
- `requireEvidence:true` 模板，unverified claim 非空 -> 节点 rejected（`gate_unverified`）；
- 非高风险模板 -> unverified 仅标记，不阻断。

### 6.3 脱敏
- evidence 含凭据 -> digest 计算前已 redact，graph 不含明文凭据；
- summary_only 模式 -> graph 只存摘要 + digest。

### 6.4 回归
- 全体 `agent-workflow-*.e2e.js` / `agent-quality-*.e2e.js`--存量节点不声明 claims/evidenceRefs，确认不 reject、不改变行为（兼容）；
- M3 coverage 场景仍绿（R1 判定在 coverage 之后，不干扰）。

---

## 7. M4 记账（12 文档红线 4）

R1 落地后按 M4 纪律单轴回测：
- 轴：上下文轴（证据注入是上下文维度）；
- 单轴收益：高风险模板的漏项率 / 伪造证据检出率（非 token，是质量指标）；
- 全量累进：与 M1/M3 同开，验证无回退；
- holdout：audit/research 类任务分 train/holdout，防过拟合。

---

## 8. 分期与依赖（12 文档 §2 阶段 C）

阶段 C = M2 确定性结构节点 + R1 Evidence Graph。
- **R1 先行**：证据契约是 M2 coverage/propagate 节点产出的「未覆盖清单」的归宿（12 文档 R1 末段）；
- **M2 随后**：coverage/propagate 节点产出的结构判断落入 R1 evidence（kind='artifact' 或专用 kind）；
- 本文档只设计 R1；M2 设计文档另立（阶段 C 后半）。

---

## 9. 本文档未做项（诚实性）

- **未动代码**：按 12 文档 §2 纪律，先设计 + 威胁建模 + fake e2e 设计，实现待设计确认后独立 commit。
- **未设计 M2**：M2 确定性节点另立文档，本波只定 R1 证据契约。
- **未设计 R2–R5**：依赖 R1 契约，阶段 D–F 各自先设计文档。
- **eventId 稳定性**：当前 progressLog 无稳定 eventId，R1 实现需先给事件加稳定 id（这是 R1 实现的前置工作，非独立项）。
- **外部论文引用**：12 文档已列 arXiv 依据，本文档不重复引用，只落地 Ruyi 版本契约。