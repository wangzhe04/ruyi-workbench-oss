# 09 · M3 实施文档 — verify 节点「输入覆盖率」职责（候选 A 波）

> 关联：`07-microagent-lessons.md` §4 M3（候选 A 波前半）。本文档把 M3 细化到可执行：schema 变更 diff、prompt diff、后端判定、验收 e2e、护栏与风险。
> 基线：2026-08-10 工作树（Escapade 2.5.0 后）。**本文档只落方案，不动代码**——代码改动待本方案确认后另一独立 commit 实施。
> 代码锚点为 `app/src/*.js`（`app/server.js` 是 build.js 拼接产物，见 §4）。

---

## 0. 一句话结论

给质量门（review/verify 类 gate 节点）增加**输入覆盖率**职责：质量门输出新增可选 `coverage` 字段（`total` / `handled` / `unhandled[]`），prompt 引导 verify 节点「对照输入项逐项核验而非只看产物好坏」，后端在 `unhandled` 非空时把 verdict 降为 fail。**coverage 为可选字段、不塞进 schema required**——因为 `QUALITY_GATE_OUTPUT_SCHEMA` 被所有 gate 节点共享，做成 required 会破坏全部存量 verify 节点。未处理项判定由代码做，不依赖模型自报自律。

---

## 1. 问题与目标

**问题**（07 §4 M3）：论文 MicroAgent 的 Review agent 核心价值是处理**未分配项**（unassigned classes），不只是质量判断。Ruyi 的 verify/review 门（`09-workflow.js:617` 的 `QUALITY_GATE_OUTPUT_SCHEMA`）只问「产物好不好」，不问「输入全不全」——正是 06 文档「细节精度失守——产物框架对、关键 check 挂掉」的编排层对应。

**目标**：
1. verify 节点除质量判断外，还显式输出「输入项总数 / 已处理数 / 未处理项清单」；
2. 未处理项非空时质量门不通过（或按模板配置降级为警告）；
3. 与 06-O3（单 agent 逐项自检）形成「单 agent 查产物、编排层查分工」的双层覆盖。

---

## 2. 现状（已主会话核实）

### 2.1 schema（双份）
`src/08-agent-runs.js:984` 定义，经 build.js 拼接进产物 `server.js:13896`：

```js
const QUALITY_GATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['verdict', 'confidence', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object' } },
  },
});
```

### 2.2 质量门 prompt
`src/09-workflow.js:618-620`（产物 `server.js:15349` 附近）：

```js
const qualityInstruction = node.gate && !['vote', 'dedupe'].includes(node.gate.mode)
  ? `\n\n你是质量门节点(${node.gate.mode})。必须逐项核验所有前序结果；只输出 JSON，字段 verdict 只能是 pass/fail/uncertain，confidence 为 0..1，summary 为结论，findings 为证据数组。`
  : '';
```

### 2.3 后端判定位置
质量门节点的 verdict/status 归属在 `09-workflow.js` 的 `runNode`（gate 处理分支，约 :655 起 vote/dedupe 之后）——verify 类 gate 走 `effectiveSchema = QUALITY_GATE_OUTPUT_SCHEMA` + 子代理执行，节点 status 由子代理返回的 `verdict` 决定。后端 coverage 判定需在这个分支补一段「unhandled 非空 → 视为 fail」。

### 2.4 既有测试
- `dev-harness/agent-quality-gates.e2e.js`：单元级，断言 `validateAgentJsonSchema` 对 `{verdict:'maybe',confidence:2}` 报 enum/range/required 失败（:15）。**加可选 coverage 字段不影响它**（它不是 required，坏输入仍报 ≥2 错）。
- `dev-harness/prompt-snapshot.static.e2e.js`：只锁 `buildProviderSystemPrompt`（单 agent 系统提示），**不锁 qualityInstruction**——M3 改质量门 prompt 不直接触碰快照门（见 §6 护栏评估）。

---

## 3. 变更方案

### 3.1 schema 增加可选 `coverage` 字段（`src/08-agent-runs.js:984` + 产物）

```js
const QUALITY_GATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['verdict', 'confidence', 'summary'],   // 不变——coverage 有意放在 required 之外
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'object' } },
    // == M3 新增（可选）==
    coverage: {
      type: 'object',
      required: ['total', 'handled', 'unhandled'],
      properties: {
        total:    { type: 'integer', minimum: 0 },          // 输入项总数
        handled:  { type: 'integer', minimum: 0 },          // 已处理数
        unhandled:{ type: 'array', items: { type: 'string' } }, // 未处理项清单（描述）
      },
    },
  },
});
```

**设计要点**：`coverage` 是**可选**（不在顶层 `required`）。理由：该 schema 被所有 gate 节点共享，若 required 则存量 verify 节点（不输出 coverage）全部 reject。可选 + prompt 引导 + 后端判定，既给足新能力，又不破坏存量。

### 3.2 质量门 prompt 增加覆盖率引导（`src/09-workflow.js:618`）

```js
const qualityInstruction = node.gate && !['vote', 'dedupe'].includes(node.gate.mode)
  ? `\n\n你是质量门节点(${node.gate.mode})。必须逐项核验所有前序结果；只输出 JSON，字段 verdict 只能是 pass/fail/uncertain，confidence 为 0..1，summary 为结论，findings 为证据数组。
质量门必须覆盖到每个输入项，不能只看产物整体好坏。请额外输出 coverage 字段：total=输入项总数，handled=已核验项数，unhandled=未核验/未覆盖项清单（如某个文件、数据行、子任务未处理，明确列出）。若存在未覆盖项，verdict 应为 fail（或按模板要求降级为警告并说明）。`
  : '';
```

### 3.3 后端判定（`09-workflow.js` gate 分支，verify 类）

在验证类 gate 节点收尾处追加：若子代理返回的 `coverage` 存在且 `unhandled` 非空，则把节点 status 置为 fail（或按模板配置 `gate.allowPartialCoverage` 降级为警告），并在 `summary`/`error` 里固化未覆盖项清单。**判定看机器数据（unhandled 数组），不依赖模型自报 pitch。**

---

## 4. 改造面与构建纪律

- 改 `src/08-agent-runs.js` + `src/09-workflow.js` 后，运行 `node app/build.js` 重建 `server.js`，再 `node app/build.js --check` 校验 manifest 行区间（build.js:88-91 机制）。
- `server.js` 是 git 跟踪的拼接产物：**src 与产物必须同 commit**，否则运行时（只跑产物）不生效。改后 diff 应同时含 src 变更与产物对应行段。

---

## 5. 验收 e2e（新增 + 回归）

### 5.1 `agent-quality-gates.e2e.js` 追加 coverage 断言
- schema 含可选 coverage：`validateAgentJsonSchema({ verdict:'pass', confidence:0.9, summary:'ok', coverage:{ total:2, handled:1, unhandled:['b.js'] } }, QUALITY_GATE_OUTPUT_SCHEMA).ok === true`
- 缺 coverage 依然合法（存量兼容）：`{ verdict:'pass', confidence:0.9, summary:'ok' }` 通过
- coverage 缺子字段不合法：`{ ..., coverage:{ total:2 } }` 报 required 失败

### 5.2 新增后端判定 e2e（可选，视 3.3 实现层级）
- 构造 verify 节点返回 `coverage.unhandled=['x']` → 节点 status 为 fail 且 error 含 'x'；`unhandled=[]` → 正常 pass
- 构造 `allowPartialCoverage` 模板 → 未覆盖降为警告而非 fail

### 5.3 回归面
- `agent-quality-gates.e2e.js`（既有断言不破坏，见 §2.4）
- 全体编排/工作流 e2e（`agent-workflow-*.e2e.js`、`agent-quality-workflow.e2e.js`）——verify 节点现在不返回 coverage，确认不 reject
- 提示词快照门 `prompt-snapshot.static.e2e.js`（见 §6 是否触及）

---

## 6. 护栏与风险

| 项 | 处置 |
|---|---|
| **存量 verify 不输出 coverage** | coverage 设计为可选 + 后端容错（缺失=不判 fail），存量零迁移 |
| **模型自报 coverage 可能幻觉** | 判定看机器数据 `unhandled[]`；7-07 文档已说明「有 M2 的 coverage 节点后切换为机器数据，prompt 版作为先行」——本波是先行版 |
| **prompt 改动走过快照门？** | `prompt-snapshot.static.e2e.js` 当前只锁 `buildProviderSystemPrompt`，不锁 qualityInstruction。本波改 qualityInstruction：**建议顺带把 qualityInstruction 纳入快照锁**（新增一层断言），否则后续 prompt 改动无护栏。若评估成本高，可先记入风险、本波只改不锁（诚实标注） |
| **误裁：未覆盖误判为 fail** | 提供 `gate.allowPartialCoverage` 降级位；默认对 P0 类模板（audit/insight）收紧，对探索类放宽 |
| **改动面** | `src/` 双文件 + 产物重建，主树串行改（记忆：server.js 是拼接产物，不派 worktree 并行） |

---

## 7. 验收（文档层面先行）

本文档确认后，实施 commit 的验收标准：
1. `node dev-harness/agent-quality-gates.e2e.js` 全绿（含新增 coverage 5.1 断言）
2. `node app/build.js --check` 无 manifest 过期红
3. 相关 `agent-workflow-*.e2e.js` 回归全绿，存量 verify 节点不 reject
4. 若 §6 纳入快照锁：`node dev-harness/prompt-snapshot.static.e2e.js` 绿且快照 diff 可见
5. 主会话亲自跑验收，不用子代理报告（记忆：本仓子代理报告多次失实）

---

## 8. 本文档未做项（诚实性）

- **未动代码**：按用户选定「先落 M3 实施文档再动代码」，本波只出方案；代码改动待确认后独立 commit。
- **未触碰 M2 的 coverage 确定性节点**：本波是 prompt+schema 版（先行）；机器版 coverage 节点属候选 C 波（M2）。
- **M4（单轴消融纪律）**：流程项，不涉及代码，可与会文档并行推进，不并入本波实施。