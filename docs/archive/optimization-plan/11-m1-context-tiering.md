# 11 · M1 实施文档 — 编排上下文分级注入（候选 B 波前半）

> 关联：`07-microagent-lessons.md` §4 M1（**唯一 P0**）、`06-hb360-cost-convergence.md` O6。本文档把 M1 细化到可执行：现状、变更 diff、构建纪律、验收 e2e、护栏与风险。
> 基线：2026-08-10 工作树（M3 `9696483`、M4 `bcd8fa7` 已交付）。**先落文档再动代码**（沿用 M3 约定）。
> 代码锚点为 `app/src/*.js`（`app/server.js` 是 build.js 拼接产物，见 §4）。

---

## 0. 一句话结论

把 `runAgentWorkflow` 的**单一** `contextText`（`09-workflow.js:647`，所有节点同一份、截 4000 字符）升级为**两层**：全局层（现有 `contextText`，所有节点可见）+ **节点层**（节点定义新增可选 `context` 字段，仅该节点可见，追加在全局层之后）。节点无 `context` 时行为与现状完全一致——**旧模板零迁移**。这是论文「多粒度上下文、按角色暴露」对 Ruyi 编排层的落地，也是 06-O6「子代理最小工具集」在**上下文**维度的同构补全（工具最小集已有，上下文最小集还没有）。

---

## 1. 问题与目标

**问题**（07 §4 M1）：`09-workflow.js:647` 把 `contextText` 截 4000 字符后拼进**每个节点**的 prompt——领域探索节点和终局 verify 节点拿到同一份。论文证明「按角色暴露不同粒度」对准确率有实质贡献；对 Ruyi 则直接省 token（长编排把全局背景灌给每个节点是浪费）。

**目标**：
1. 节点可声明**专属上下文**（`node.context`），仅注入到该节点；
2. 未声明时行为不变（只发全局层）——存量模板零迁移；
3. 为模板编排器铺路：探索节点给结构摘要、执行节点给具体片段、verify 节点给产物清单。

---

## 2. 现状（已主会话核实）

### 2.1 全局 context 构造（`09-workflow.js:647-648`）
```js
const contextPrefix = contextText ? `任务背景（本次运行时提供）：\n${String(contextText).slice(0, 4000)}\n\n` : '';
const effectiveTask = contextPrefix + (priorText ? ... : node.task) + ...;
```
`contextText` 来自 `runAgentWorkflow` 入参（L40），由调用方（`13-http-router.js:2008` 的 `contextText: String(args.context || '')`）注入——即顶层 `args.context`。

### 2.2 节点对象构造（`09-workflow.js:173`）
节点是**显式对象字面量**，只保留固定字段（id/task/dependsOn/role/engine/outputSchema/gate/...）。**`raw.context` 不会自动透传**——M1 必须在这里显式加 `context` 字段。

### 2.3 节点 schema（`13-http-router.js:1868-1900`）
`nodes.items.properties` 无 `context` 字段；该 schema 块**未设 `additionalProperties:false`**（L1900 直接 `required:['id','task']`），所以即使不加 schema 描述，`raw.context` 也能传入 `runAgentWorkflow`（但会被 L173 清洗丢弃）。M1 应补 schema 描述以便模型了解该字段存在。

---

## 3. 变更方案

### 3.1 节点对象加 `context` 字段（`09-workflow.js:173`）
在节点对象字面量里追加（放在 `position` 附近）：
```js
context: (raw && raw.context) ? String(raw.context).trim().slice(0, 4000) : '',
```

### 3.2 节点级 context 拼接（`09-workflow.js:647-648`）
在 `contextPrefix` 之后、`effectiveTask` 拼接处追加节点层：
```js
const contextPrefix = contextText ? `任务背景（本次运行时提供）：\n${String(contextText).slice(0, 4000)}\n\n` : '';
const nodeContextPrefix = node.context ? `本节点专属资料：\n${node.context}\n\n` : '';
const effectiveTask = contextPrefix + nodeContextPrefix + (priorText ? ... : node.task) + ...;
```
节点无 `context` 时 `nodeContextPrefix` 为空——行为与现状完全一致。

### 3.3 节点 schema 加 `context` 描述（`13-http-router.js:1883` 后）
```js
context: { type: 'string', description: 'optional node-level context injected ONLY into this node (appended after the run-wide context). Use for per-node specifics (structure summary for exploration, concrete fragment for execution, artifact list for verify); omit to inherit only the run-wide context.' },
```

### 3.4 兼容性
- 节点无 `context` → `node.context=''` → `nodeContextPrefix=''` → effectiveTask 与现状逐字节一致；
- 8 个模板（`orchestrate_agents` 工作流模板）不声名 context → 零迁移；
- 后端判定（gate/vote/loop）不受影响，`context` 纯上游注入。

---

## 4. 构建纪律

改 `09-workflow.js` + `13-http-router.js` 后运行 `node app/build.js` 重建 `server.js`，再 `node app/build.js --check` 校验 manifest 行区间。src 与产物同 commit。

---

## 5. 验收 e2e

### 5.1 新增行为断言（`agent-workflow-*.e2e.js` 或 `agent-quality-workflow.e2e.js` 追加）
- **节点级 context 只注入目标节点**：构造两个节点，A 声明 `context:'专有资料X'`、B 不声明；fake-openai 落盘断言——A 的请求体含「X」、B 不含「X」、两者都含全局 contextText。
- **节点无 context 时全局层不受影响**：所有节点仍收到全局 context，且 B 的 effectiveTask == 未加 context 时基线。

### 5.2 回归面
- 全体 `agent-workflow-*.e2e.js`、`agent-quality-*.e2e.js`——存量节点不声名 context，确认不 reject、不改变行为；
- `prompt-snapshot.static.e2e.js`——`effectiveTask` 的 E 段（节流/证据注入）应仍绿；若快照门捕捉到 context 结构变化，需 intentional 更新快照（见 §6）。

---

## 6. 护栏与风险

| 项 | 处置 |
|---|---|
| **存量节点不声名 context** | 兼容设计（§3.4），零迁移 |
| **节点级 context 过大** | 节点层同样截 4000（§3.1），文档注明「节点层只放指针/摘要，不放全文」 |
| **上下文节流冲突** | 10-context-governance 的时间维度压缩不受影响；节点层是空间维度注入，两者正交。节点层 context 注入后仍受 effectiveTask 总量与 throttlingInstruction 约束 |
| **prompt 快照门** | `prompt-snapshot.static.e2e.js` E 段锁 effectiveTask 的节流/证据注入。若 M1 改动被快照门捕捉，需按 intentional 流程更新快照（改动可见、review 确认） |
| **模板作者滥用** | 节点层 context 与全局层重复 → 文档强调「节点层放该节点独有信息」，避免把全局背景重复塞进每个节点（那正是要消除的浪费） |

| **恢复不对称性（对抗验证发现，非阻断）** | 全局 `contextText` 原本就未持久化进 run 记录（原有问题）；M1 后 `node.context` 会持久化 -> 续跑时节点有节点上下文、缺全局上下文。不比改前更差（改前两者都丢），但 M1 让该限制可见。处置：本波文档记录，后续单独修（持久化 `run.contextText` 并在 resume 路径回传 `runAgentWorkflow`）；当前不阻塞 |

---

## 7. 验收（文档层面先行）

实现 commit 的验收标准：
1. `node app/build.js --check` 无 manifest 过期红；
2. 新增节点级 context 断言 e2e 绿（§5.1 两条）；
3. 相关 `agent-workflow-*.e2e.js` / `agent-quality-*.e2e.js` 回归绿，存量节点不 reject；
4. `prompt-snapshot.static.e2e.js` 绿（或快照 intentional 更新）；
5. 主会话亲自跑验收，不用子代理报告。

---

## 8. 本文档未做项（诚实性）

- **未动代码**：按「先落文档再动代码」约定，代码改动待确认后独立 commit。
- **未回填 8 个模板的节点级 context**：M1 只改引擎能力；模板按需回填是后续（B 波后半或单独立项），避免本波把「能力 + 模板填充」混在一起难回归。
- **M6（O3 证据回溯）**：候选 B 波后半，并入 06-O3，不并入本波。