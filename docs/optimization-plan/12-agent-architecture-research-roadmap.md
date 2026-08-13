# 12 · Agent 架构研究补充路线 — 从证据到学习闭环

> **当前进度（2026-08-11）**：阶段 C 全部完成——C1（Evidence Graph 证据目录 prompt 注入与 `evidenceRefs` 输出契约）、C2（M2/R1 确定性 gap 证据衔接）、C3（内置模板高风险门回填 `requireEvidence` + M4 固定 benchmark/holdout 回测，漏项率 0、伪造检出率 100%）。R2/R3 按当前产品优先级暂缓。R4-S1/S2 已完成关系存储、冲突检索、gate 自动提议与 evidenceRef 校验；本轮审查补齐真实 Provider/Claude/gate 提示链路与 GET 路由授权，并完成 R4-S3（confirmed 图确定性聚类 + review-only 过期建议 + 孤儿边提示）。R4 已收口，主线下一项为 R5；**R5 已收口（2026-08-13）**——数据契约+机器校验+触发点 `111723c`、apply/rollback 引擎 `6922e48`、审批路由+UI `26e1186`、review 自动生成 changes `40d0113`、越权对抗修复 `292cf29`，实现文档 [`16-r5-replan-ledger.md`](optimization-plan/16-r5-replan-ledger.md)。

> 关联：`06-hb360-cost-convergence.md`、`07-microagent-lessons.md`（M1–M6）、`09-m3-coverage-gate.md`、`10-m4-ablation.md`。立项日期：2026-08-10。性质：**路线规划，不代表已实现或自动启用**。

---

## 0. 结论与边界

Ruyi 已具备多 Agent DAG、角色/工具分级、可恢复的运行记录、任务账本、节点输出四分（summary/evidence/artifacts/raw transcript）、人工确认的记忆，以及 M1 上下文分层、M3 覆盖率提示和 M4 单轴消融纪律。下一阶段不应重复增加“再来一个 Reviewer”，而应补齐下列五段闭环：

```text
可引用的执行证据
        ↓
可信的成功轨迹 / 失败轨迹
        ↓
候选工作流（须人工发布）──→ 离线评测与对比
        ↓                              ↓
关系化项目记忆 ←────────────── 受控重规划提案
```

所有自动化都止于**候选/提案**：不得自动发布工作流、覆盖既有记忆、修改用户文件或扩大工具权限。模型从不因“自己说已经完成”而获得事实可信度；可信度来自可核查的事件、产物、验收与用户决定。

## 1. 纳入方向

| 编号 | 外部架构 | Ruyi 当前缺口 | 建议落点 | 优先级 |
|---|---|---|---|---|
| R1 | claim-level evidence provenance | 有审计、findings、artifact 摘要，但没有“最终断言 → 具体工具结果/文件/来源”的机器关系 | Evidence Graph + 引用契约 | **P0** |
| R2 | execution-to-workflow induction | 有静态模板/Playbook 和运行历史，但不会从已验收轨迹归纳候选流程 | Workflow Candidate Factory | **暂缓** |
| R3 | offline workflow evolution | M4 能测单轴收益，但没有系统地产生、筛选和保留候选变体 | Champion–Challenger Lab | **暂缓** |
| R4 | linked, conflict-aware memory | 有按项目隔离且需确认的记忆，但没有 supports/contradicts/supersedes 关系与冲突检索 | Local Memory Graph | **P1（S1–S3 已完成）** |
| R5 | task ledger + progress ledger + replan | 有 Mission、DAG、重试和任务池，但没有把偏离计划归并为可审的重规划 diff | Replan Patch Ledger | **P1（C3 后）** |

### R1 · Evidence Graph（P0，M6 的工程化落点）

外部依据：近期证据溯源研究将 tool output、memory、intermediate claim、action 和 final answer 串为 provenance；它解决的是“结果看似正确却无法复核或定位失败源”的问题，而非多调用一次模型。[From Agent Traces to Trust](https://arxiv.org/abs/2606.04990)

**数据契约**：

- `evidence`：稳定 `eventId`、来源类型（工具结果/文件区间/网页/产物/人工确认）、内容 digest、时间与脱敏等级；
- `claim`：节点或最终交付中的可核验断言，带 `evidenceRefs[]`；
- `relation`：`supports`、`contradicts`、`derived_from`、`verified_by`；运行时拒绝不存在或跨工作区越权的引用；
- 无证据断言不删文本，但标 `unverified`，在高风险研究/审计模板的交付前要求显式处理。

**与现有能力的衔接**：扩展当前 nodes 的 `findings`/`artifacts`，不复制原始工具返回；使用既有事件日志、文件检查点、工作区隔离和隐私遮罩。M3 的 `coverage` 仍只是先行提示；后续 M2 的确定性集合检查可把“项目是否都被处理”同样落入 Evidence Graph。

**验收**：构造一条声明能点击追至准确事件或文件片段；错误/过期/越权 `evidenceRef` 必须被机器拒绝；脱敏后 digest 可核验且不会把密钥写进 graph；证据有缺口的交付不允许伪装成已验证。

### R2 · Workflow Candidate Factory（P1）

外部依据：AWM 从过去任务中归纳可复用 workflow，并只在相关情境下提供给 agent；重点是“从经验中学习程序”，不只是存一段文本。[Agent Workflow Memory](https://arxiv.org/abs/2409.07429)

**流程**：

1. 只选取**已验收成功**、有足够 Evidence Graph 覆盖、且未含未决权限/失败副作用的运行；
2. 对轨迹做脱敏和规范化：保留角色、依赖、工具类别、前后置条件、验收项，移除密码、绝对用户数据和一次性文本；
3. 聚类相似任务，归纳为 `candidate` 状态的 Playbook 或 DAG；保留来源 runs、适用条件、未知前提和预计成本；
4. 在隔离/假环境回放或由用户指定的基准任务验证；只有用户显式批准才发布为项目模板，永不自动覆盖 builtin/已有模板。

**验收**：候选可追溯到来源 run；不可安全泛化的轨迹必须被拒绝；候选发布前无写入权限；发布后可一键回退；与手写模板对比时记录完成率、工具数、token、时延与安全事件。

### R3 · Champion–Challenger Lab（P1，M4 的生产者）

外部依据：AFlow 把 agent workflow 视为可搜索的程序，并以执行反馈迭代；其结果只说明这种机制值得实验，不能直接外推到 Ruyi。[AFlow](https://arxiv.org/abs/2410.10762)

**第一版刻意不做在线 MCTS**。它只在离线、可复现的基准环境中比较候选：

- 变体空间限定为 DAG 拓扑、角色/模型路由、context tier、工具包和 gate；不允许自动生成有外部副作用的新工具调用；
- 使用 HB360 子集 + 项目专属回归夹具；每次只改变 M4 定义的一轴；
- 输出 Pareto 表（outcome / process / security / efficiency / cost / latency）及置信区间，而非单一“最高分”；
- challenger 只能形成“建议替换模板”的 patch，需人工审查与回归后才成为 champion。

**验收**：候选、基准版本、模型版本、配置和结果可重放；不存在训练集泄漏到 holdout；收益未达到预先阈值或安全退化时不推荐发布；全量与单轴结果不得混报。

### R4 · Local Memory Graph（P1 · C3 后主线 · S1–S3 已完成）

外部依据：A-MEM 主张将记忆组织为带上下文、关键词和链接的网络，并随新记忆产生关联；价值在于找到关联与冲突，而不只是扩大召回。[A-MEM](https://arxiv.org/abs/2502.12110)

**Ruyi 版本的约束化实现**：

- 仅在当前项目的已确认记忆中建图；全局与项目记忆永不隐式混合；
- 新增 `supports` / `contradicts` / `supersedes` / `derived_from`，边必须附 evidenceRef 或用户确认；
- 模型可以提出记忆、摘要、链接和过期建议，不能静默写入、覆盖或删除；
- 检索结果须显示冲突和来源，模型收到的是最小相关子图而不是整库。

**验收**：换工作区不泄漏项目记忆；冲突项同时展示而不由模型静默裁决；拒绝的建议不再注入上下文；记忆链接和检索命中均有审计记录。

**实现状态（2026-08-11）**：R4-S1（边存储 + 4 种关系 + scope 隔离 + 提议/确认分离 + 冲突感知检索，`8effffc`）、R4-S2（gate 自动提议 + evidenceRef 内存内校验，`0b69856`）与 R4-S3（confirmed 图确定性聚类 + superseded / stale-isolated 的 review-only 建议 + 孤儿边提示）均已完成。S3 前置审查同时修复三条漏接：真实双引擎提示 conflict map、gate 子回合记忆索引、`GET /api/memory/relations` 声明式授权。设计与真实链路 e2e 见 `15-r4-memory-graph.md`。

### R5 · Replan Patch Ledger（P1 · C3 后主线）

外部依据：Magentic-One 以任务 ledger 管整体计划、以 progress ledger 管当前步骤，并用它们决定委派与错误恢复。它的消融说明结构化计划/进度管理值得保留，但不等价于应照搬其自治程度。[Magentic-One](https://arxiv.org/abs/2411.04468)

Ruyi 已有 Mission、持久 DAG、loop/stall guard、retry、任务池与人工插话，因此这里不是重做 orchestrator，而是补一个**可审查的变更提案层**：

- 触发：节点失败/质量拒绝、Evidence Graph 缺口、资源冲突或停滞；
- 输出：`replanPatch`，逐项列出新增/移除/重连节点、修改的工具 tier/资源、继承或废弃的证据、预期增量成本及回滚点；
- 应用：默认用户批准；低风险的只读补证据任务可沿用既有 task-pool 策略，写入/权限变更仍走现有审批；
- 结果：patch 的实际效果回写 R3 的离线评测数据，不能以 LLM 自评为成功。

**验收**：重规划前后图均可复现；拒绝 patch 不改变运行；修改依赖、权限或资源时可解释且重新经过守卫；恢复运行不会重复已确认副作用。

## 2. 分期与依赖

| 候选阶段 | 范围 | 前置 | 出门标准 |
|---|---|---|---|
| C | M2 确定性结构节点 + R1 Evidence Graph | M1、M3 | Evidence refs 可校验；coverage/propagate 等结构判断不额外调用 LLM；旧模板零迁移 |
| D（暂缓） | R2 Workflow Candidate Factory | C、已验收的可代表性 runs | 仅生成候选；来源、脱敏、回放与人工发布全链路可审计 |
| E（暂缓） | R3 Champion–Challenger Lab | D、M4、固定 benchmark/holdout | 单轴与全量结果独立；变体、模型、配置、结果可重放 |
| F（主线） | R4 Memory Graph（S1–S3 已完成）+ R5 Replan Patch Ledger | C；R3 可作为效果回流但非阻塞 | 关系/冲突/patch 都有来源、权限边界与拒绝路径 |

阶段 C 的 M2 只引入通用、确定性的集合/传播计算；不把 MicroAgent 的 Java 依赖分析或 DDD 阶段硬编码进 Ruyi。阶段 D–F 每阶段都必须先有设计文档、威胁建模、fake e2e 和 M4 记录，再进入实现。

## 3. 明确暂缓

### 相关性/可靠性校准后的投票

多数投票把相关或同源模型当独立样本，可能形成虚假的共识；更高阶聚合方法值得作为实验候选。[Beyond Majority Voting](https://arxiv.org/abs/2510.01499)

但 Ruyi 目前没有按任务类别、模型、角色和证据质量校准的历史可靠性数据。故先保留现有 vote 的阈值、弃权和证据契约；只有 R1/R3 已沉淀足够的 holdout 数据后，才评估加权或相关性惩罚，且不得把模型自报 confidence 直接当权重。

### RL 驱动的 agent 优化

训练/执行解耦可让复杂 agent 轨迹进入训练系统，但也会引入奖励投机、数据治理、可复现性和成本问题。[Agent Lightning](https://arxiv.org/abs/2508.03680)

Ruyi 不在近期路线引入在线 RL 或默认模型训练。远期若有明确的私有部署需求，只能把 R1/R3 产出的脱敏、人工筛选轨迹导出到**独立、可选、离线**的训练环境；训练系统不得读取工作区密钥、不得控制生产 Ruyi，也不得自动回灌模型或模板。

## 4. 总体验收纪律

除现有 build、双语、e2e、权限、审计与 M4 纪律外，本线新增四条红线：

1. **可追溯**：任何候选工作流、记忆关系、重规划或推荐冠军都必须能回溯到来源运行与证据；
2. **人类控制**：候选不自动发布，重规划不自动越权，记忆不静默改写；
3. **隐私最小化**：学习/聚类/导出只取脱敏的最小摘要，不把工具原文、凭据或工作区私有内容做全局索引；
4. **反过拟合**：HB360/项目夹具须有 holdout；不以一次成功或模型自评替代可复现验收。
