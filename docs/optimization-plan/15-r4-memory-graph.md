# R4 · Local Memory Graph（设计稿 + 威胁建模）

> 阶段 F 第一切片。路线依据见 `12-agent-architecture-research-roadmap.md` R4。
> 外部依据：[A-MEM](https://arxiv.org/abs/2502.12110)--记忆的价值在找到关联与冲突，而非只扩大召回。

## 1. 目标与切片边界

给已确认的工作台记忆加一层**关系边**，使检索能呈现冲突与来源，而不是把整库平铺注入。

**R4-S1（已完成）**：边存储 + 4 种关系 + scope 隔离 + 提议/确认分离 + 冲突感知检索 + 审计。
**R4-S2（已完成）**：模型自动提议接线（gate 节点结构化输出 `memoryRelations` → pending 边）+ evidenceRef 内存内校验（`run.evidence` 作 catalog，命中 → `evidenceRefVerified:true`）+ prompt section 暴露记忆 id。
**不在本切片**：记忆聚类/过期建议（R4-S3）、R5 重规划。

## 2. 数据模型

### 边（relation）

```js
{
  id: 'rel-<8hex>',            // SKILL_ID_RE 合规，crypto.randomBytes(4)
  type: 'supports' | 'contradicts' | 'supersedes' | 'derived_from',
  from: '<memoryId>',          // 源记忆 id（须同 scope 内已存在）
  to: '<memoryId>',            // 目标记忆 id（须同 scope 内已存在）
  scope: 'global' | 'project', // 与 from/to 的 scope 一致
  evidenceRef: '<eventId>',    // 可选；指向 Evidence Graph 的 eventId（evt_<runId>_<nodeId>_…）
  confirmed: false,            // false=模型提议；true=用户确认
  createdAt: '<iso>',
  sourceRunId: '',             // 提议来源 run（可空）
  note: '',                    // ≤200 字理由
}
```

### 存储

- `memory/global/_relations.json` 与 `memory/project/<projectKey>/_relations.json`。
- 文件名 `_relations.json` 以 `_` 起首且非 `.md`，`readMemoryDir` 天然跳过（不污染记忆列表）。
- 原子写：复用 `atomicWriteJson`（对象载荷，JSON.stringify）。
- 每条边单文件读写整个数组；per-scope 边数硬上限 **512**（防膨胀，见威胁 4）。

## 3. API

### 函数（07-autonomy.js，拼接进 server.js 共享作用域）

| 函数 | 签名 | 谁可调 |
|---|---|---|
| `listMemoryRelations(cwd, scope, opts)` | → `{ok, relations, pending, confirmed}` | 读 |
| `proposeMemoryRelation(rel, cwd)` | 创建 `confirmed:false` 边 | 模型/用户 |
| `confirmMemoryRelation(id, cwd)` | `confirmed:false→true` | **仅用户** |
| `deleteMemoryRelation(id, cwd)` | 删边 | 用户 |
| `buildMemoryConflictMap(cwd)` | → `Map<memoryId, Set<conflictId>>`（仅 confirmed contradicts） | 检索 |

`buildMemoryPromptSection` 增强：注入时查 conflict map，对处于 confirmed `contradicts` 关系的记忆追加 `[冲突:见 <id>]` 标记，**两条都注入，不静默择一**。

### HTTP 路由（13-http-router.js）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/memory/relations?cwd=&scope=&includePending=` | 列边 |
| POST | `/api/memory/relations/propose` | 提议（confirmed:false） |
| POST | `/api/memory/relations/confirm` | 确认（confirmed:true） |
| DELETE | `/api/memory/relations/<id>` | 删边（POST+x-http-method:DELETE 约定） |

所有路由走既有 token + same-origin 守卫（与 `/api/memory` 同档）。

## 4. scope 隔离规则（红线）

1. 边的 `from`/`to` 必须**同 scope** 且**同 projectKey**；跨 scope 边直接拒绝（防项目记忆经全局边泄漏）。
2. `confirm` 只改 `confirmed` 标志，不改 `from`/`to`/`scope`/`type`（防确认时偷换语义）。
3. `supersedes` 即便 confirmed 也**不删除**被超越的记忆，只在检索时标记 `[被超越:见 <id>]`；物理删除仍走 `deleteMemory` 人工路径。
4. `pending` 边（confirmed:false）**不进入** `buildMemoryPromptSection` 与 conflict map（防模型自提议矛盾来压制记忆）。

## 5. 威胁建模

| # | 威胁 | 触发 | 缓解 |
|---|---|---|---|
| 1 | 跨 scope 泄漏 | 模型提议 global 记忆 supports project 记忆，项目内容经全局图暴露 | from/to 同 scope 同 projectKey 校验；违例拒绝 |
| 2 | silent supersedes | 模型标 `A supersedes B` 让 B 静默失效 | confirmed:false 默认；confirmed 也不删 B，仅标记；删除走人工 |
| 3 | id 路径穿越 | relation id 含 `../` 用于文件路径 | id 过 SKILL_ID_RE（`[A-Za-z0-9_-]{1,64}`）；from/to 同样过 |
| 4 | 边膨胀 | 模型 spam 提议耗尽存储 | per-scope 512 上限；超限拒绝新提议并返回现有 pending 数 |
| 5 | evidenceRef 伪造 | 模型 cite 不存在的 eventId 装饰边 | evidenceRef 可选；自动提议路径传 `run.evidence` 作 catalog，命中真实 eventId 才置 `evidenceRefVerified:true`（R4-S2）；API 手动提议仍记 `false` 仅存档 |
| 6 | pending 注入 | 未确认边影响检索/压制记忆 | pending 不进 prompt section 与 conflict map |
| 7 | 确认时偷换 | confirm 调用改 type/from/to | confirm 只置 confirmed=true，其余字段忽略 |
| 8 | 跨工作区读 | A 项目的边出现在 B 项目 | 按 projectKey 隔离的独立文件；list 带 cwd |

## 6. 红线对齐（路线 §4）

- **可追溯**：每条边带 createdAt/sourceRunId/evidenceRef；propose/confirm/delete 入审计台账（note:'memory-relation'）。
- **人类控制**：模型只 propose；confirm/delete 仅用户（HTTP 路由不暴露为模型工具）。
- **隐私最小化**：不建全局跨项目索引；边按 scope/projectKey 隔离；evidenceRef 只存 eventId 不存原文。
- **反过拟合**：纯函数 e2e + 对抗边界（跨 scope / 膨胀 / pending / 偷换 / 伪造 ref）；M4 记录 evidenceRef 不跨 run 校验的已知限制。

## 7. 验收

1. 同 scope 内 confirmed contradicts 的两条记忆在 prompt section 中均带冲突标记且都被注入；
2. 跨 scope 边被拒绝；
3. pending 边不进入检索与 conflict map；
4. per-scope 512 上限生效；
5. confirm 不偷换字段；
6. 换工作区（cwd）不泄漏他项目边；
7. propose/confirm/delete 均有审计记录。

**R4-S2 追加验收**：

8. gate 节点结构化输出含 `memoryRelations` 时，自动落盘 pending 边（`confirmed:false`，用户确认前不生效）；
9. 自动提议的 `evidenceRef` 命中 `run.evidence` 时置 `evidenceRefVerified:true`，未命中或无 catalog 为 `false`；
10. from/to 不存在或提取异常仅跳过该提议，不翻转节点结果。

## 8. 测试计划

- `dev-harness/memory-graph-relations.e2e.js`：纯函数驱动（对齐 m4-benchmark 模式），覆盖验收 1-7 + 对抗边界。
- `dev-harness/memory-graph-auto-proposal.e2e.js`（R4-S2）：`extractMemoryRelationProposals` 提取与对抗过滤、`proposeMemoryRelation` 的 catalog 校验、端到端自动提议落盘 pending、向后兼容。
- 既有 `workbench-memory.e2e.js` 须保持绿（检索增强向后兼容：无边时行为不变）。

## 9. 已知限制（M4 记录）

- ~~evidenceRef 不跨 run 校验~~：R4-S2 已实现内存内校验——自动提议路径传 `run.evidence` 作 catalog，命中真实 eventId 才置 `evidenceRefVerified:true`；API 手动提议仍为 `false`（仅存档，提示用户手动核验）。
- ~~模型自动提议未接线~~：R4-S2 已在 `09-workflow.js` 节点收尾（R1 证据索引之后）接线——gate 节点结构化输出含 `memoryRelations` 时自动提取并 `proposeMemoryRelation(confirmed:false)`；from/to 不存在或异常仅跳过该提议，不翻转节点结果。
- 剩余限制：API 手动提议的 evidenceRef 不校验（无 catalog 上下文）；边确认仍须用户操作（模型只提议，符合红线）。
