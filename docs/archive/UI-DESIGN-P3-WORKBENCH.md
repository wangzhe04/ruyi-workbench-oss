# P3「工作台」视图设计稿:全宽多 Agent 监控画布

状态:设计稿(2026-07-10)。对接 `UI-DESIGN-V3.md` §2.7 步骤 3(P3 旗舰)与 §4 波次表 P3;衔接 `UI-ORCHESTRATION-REDESIGN.md` §2「统一实时 DAG 画布」愿景。
配套设计图:`docs/mockups/p3-workbench.html`(满血态主件)、`docs/mockups/p2-refinements.html`(降噪监控卡 + 技能库两列,P2 辅件)。
数据契约:100% 复用现有 `renderAgentRuns` 的数据管线(`/api/agent-runs` 2s 轮询,协议不变)与 `nodeDisplayStatus`,不新增后端字段。

---

## 0. 一句话定位与设计前提

**工作台 = 中栏可切换的全宽多 Agent 监控视图**。用户在中栏顶部两个主 Tab「对话 ↔ 工作台」之间切换:对话是既有消息流;工作台把右栏那张挤在 312px 里的 `agent-runs` 监控升格为**占满中栏的 DAG 画布**,一眼看清「谁在跑、跑到哪、卡在哪、为什么」。

三条硬前提(继承全局约束,不可违反):
- **零运行时依赖**:纯原生 JS,无 dagre/无框架/无构建。分层布局是本稿给出的手写算法(§5.2)。
- **数据零改后端**:画布消费的字段(`run.nodes[]` / `run.taskPool[]` / `run.messages[]` / `nodeDisplayStatus`)当前已全部持久化并经 2s 轮询下发。P3 是纯前端渲染层升格。
- **离线 + 双主题 + AA + XSS 纪律**:视觉资源内联 SVG(复用 `ruyi-mark.svg` 云头);所有不可信文本走 `el()/textContent`,画布节点标题/任务/消息一律不 `innerHTML`。

与右栏 `agent-runs` tab 的关系:**同源不同布局**。右栏保留紧凑列表(窄屏/简单模式默认、快速一瞥);工作台是同一份 run 数据的「大舞台」呈现。两者共用 `nodeDisplayStatus`、`agentRunStatusLabel`、`agentStatusIcon`、`agentEngineBadge`、`runCostLabel` 等纯函数,不复制语义。

---

## 1. 信息架构

中栏工作台自上而下四区,外加左侧全局壳层不变(288 侧栏 + 中栏 + 右栏在工作台态可让位,见 §4):

```
┌ 主 Tab: [ 对话 ]  [ 工作台 ● ]                                    〔run 有活动时亮点标 ●〕
├───────────────────────────────────────────────────────────────────────────────┐
│ ① Run 选择器:  ( ◐ 辩论评审 run-a2f · 运行中 )  ( ✓ 重构 run-91c )  ( ✗ 导出 run-3d )│
├───────────────────────────────────────────┬───────────────────────────────────┤
│ ② 主画布 (DAG · 分层纵向泳道)              │ ③ 右侧上下文板(三段折叠)         │
│                                            │  ▸ 选中节点详情(judge)           │
│    ┌ pro ✓ ┐   ┌ con ⚑ ┐   ← Layer 0      │     引擎/模型/进度/门/插话/重试     │
│         └──┬──────┘                        │  ▸ 任务池审批(待批准 1)          │
│         ┌ judge ◐ ┐        ← Layer 1(选中)│     三行人话卡 + 同意/不用了       │
│              │                             │  ▸ 邮箱消息流(2)                 │
│         ┌ fix ⏸ ┐          ← Layer 2       │     sender → target · 摘要        │
│              │                             │                                   │
│         ┌ verify ○ ┐       ← Layer 3       │                                   │
├───────────────────────────────────────────┴───────────────────────────────────┤
│ ④ 底部用量迷你条:  本 run  18.2k tok · $0.42 · 已运行 04:12         [查看用量 →]│
└───────────────────────────────────────────────────────────────────────────────┘
```

### ① Run 选择器(顶部 run chips)
- 一行横向可滚 chip,每 chip = 状态徽标 + run 名 + 状态词(运行中/已完成/失败…)。活动 run(`AGENT_RUN_ACTIVE`)排在前、脉冲点标记;历史 run 灰化。
- 选中态 chip 走 `--accent-soft` 底 + `--accent` 描边;数据源即 `loadAgentRuns()` 返回的 `runs[]`,选中项决定画布渲染哪一个 run。
- 空态(本会话无 run):选择器隐藏,画布区显示空态卡(§3.4)。

### ② 主画布(DAG 图布局)
- **分层自动排布**:按 `node.dependsOn` 做拓扑分层(§5.2 算法),层号纵向递增(Layer 0 在上),层内节点沿横轴均布——即「纵向泳道 / dagre 纵向」布局。手写零依赖。
- 画布支持缩放(滚轮 / `+ −` 按钮)与平移(拖拽空白);「适应窗口 ⤢」一键 fit。运行态禁编辑(只观测)。
- 节点卡见 §2;边为三次贝塞尔曲线,按连线状态着色(§2.3)。

### ③ 右侧上下文板(三段折叠)
一栏 `<details>` 式三段手风琴,任一时刻可全展开:
1. **选中节点详情**:点画布节点即填充。含引擎徽标 + 模型名(`node.model`,如 `claude-opus-4`)+ 状态 + 计时 + 迭代/预算条 + 门 verdict/置信度环 + 完整 `progressLog` 时间线 + 结果/错误全文 + **操作区**(插话入口 / 重试此节点 / 重试及下游 / 查看错误 / worktree 应用)。操作按可用性显隐,复用 `steerAgentNode` / `agentRunAction` 逻辑。
2. **任务池审批**:`run.taskPool` 的 `proposed` 项浮出三行人话卡(谁提议 / 做什么≤60字 / 预计消耗)+「同意添加 / 不用了」→ `poolDecide`。`waiting_pool` 宽限窗显示倒计时细进度条。
3. **邮箱消息流**:`run.messages[]` 时间线,每条 `sender → target · 摘要`,`dropped` 项灰化标「未送达」。

### ④ 底部用量迷你条
- 贴底常驻:本 run 的累计 `tokens · $成本 · 已运行时长`(`runCostLabel` + `runElapsedMs`)。字段缺失时该段不渲染(防御,后端并行落地中)。
- 整条可点 →跳右栏用量看板(`switchTab('usage')`)对应会话过滤。

---

## 2. 节点卡视觉(画布态)

复用监控卡的**语义**(状态徽标 / 引擎徽标 / 模型名 / 进度活动行 / 门 verdict),但换**画布态视觉尺寸**:固定 **220×88px**。

```
┌───────────────────────────────────────┐  220×88
│ ◐  judge · 裁决评审        [Claude]    │  ← 状态徽标 + id·角色 + 引擎徽标
│    claude-opus-4                        │  ← 模型名(muted, --fs-xs)
│    思考中… 已产出 1.2k 字 · 迭代 3/24  │  ← 活动行(运行态,shimmer)
│    ▓▓▓▓▓░░░░░  门:通过 · 92%           │  ← 迭代条 / 门 verdict(按节点类型二选一显)
└───────────────────────────────────────┘
```

字段映射(全部已有,见 `renderAgentRuns`):

| 卡区 | 内容 | 字段 |
|---|---|---|
| 状态徽标 | `agentStatusIcon(nodeDisplayStatus(node))`,色由 `.st-<status>` 语义 token 驱动 | `status`+`gateVerdict`+`degraded` |
| 标题行 | `node.id` · `roleLabel`,右侧 `agentEngineBadge(engine)` | `id/roleLabel/engine` |
| 模型名 | `node.model` 单行 muted;无则省 | `model` |
| 活动行 | `progressLog` 末条(运行/等待态显,succeeded/skipped 不显) | `progressLog[last].text` |
| 底行(择一) | 迭代/循环条 `iters/maxIters` 或 loop `loopIteration/maxIterations`;门节点显 verdict+置信度 | `iters/maxIters/loop/gateVerdict/confidence` |

### 2.1 状态着色(卡)
一律引语义 token,不硬编码:
- **运行中** `running`:左缘 `--accent` 色条 + **脉动呼吸**(`box-shadow` 2s 循环,`prefers-reduced-motion` 下停),卡 **elev-2 浮起**。
- **失败** `failed`:`--danger` 左缘 + `--danger-bg` 极淡底。
- **等待资源** `waiting_resource`:`--warn`(琥珀)左缘,活动行显 blocker「等待 worktree:main」。
- **质量门判否** `rejected`:`--warn` 琥珀(语义=「发现问题 ≠ 崩了」),徽标 `⚑`。
- **已完成** `succeeded`:`--ok` 徽标,卡回落 elev-1、常态底。
- **排队** `queued`:`--muted` 徽标 `○`,卡降透明度 .85。
- **选中**:任意状态叠加 `--accent` 2px 描边 + elev-2。

### 2.2 引擎徽标
沿用 `agentEngineBadge`:`claude` → 青花蓝 `--wf-claude`(=`--accent`)pill;`openai` → 釉里红/赭 `--wf-provider`(=`--eng-claude`)pill。这是「双引擎」一眼区分,与消息区引擎色统一(§UI-DESIGN-V3 §2.9 已修自相矛盾)。

### 2.3 边(贝塞尔曲线,状态着色)
- 形状:三次贝塞尔,从源节点底缘中点 → 目标节点顶缘中点,控制点落在中垂线(呼应云纹曲率,非直角折线)。
- 着色按**源节点显示状态**:源运行中 → `--accent` + 流动虚线(`stroke-dasharray` 动画,reduced-motion 停);源判否/等待 → `--warn` 琥珀;源失败 → `--danger`;源完成 → `--line-2` 静态实线。
- 悬停节点时高亮其入边/出边与整条依赖链(其余边降透明度)。

---

## 3. 交互

### 3.1 选中与详情
- **点节点** → 右板「选中节点详情」段展开并滚入,卡加选中描边。含:
  - **插话入口**:节点为 live run 中 `running/queued/waiting_resource` + 非 Claude 引擎 + 非确定性门 → 显插话输入框(内联,回车提交)→ `steerAgentNode`。Claude/-p 单发节点与 vote/dedupe 门不显(与后端 `steer_node` 拒绝一致)。
  - **重试**:非 live run 显「仅重试此节点 / 重试此节点及下游」→ `agentRunAction('retry_node', {nodeId, cascade})`;失败/判否且有错误显「查看错误」。
- **点池徽标**(选择器或右板「任务池」段的「待批准 N」)→ 展开审批卡段;`poolDecide(runId, poolId, approve)`。

### 3.2 实时性
- 沿用 **2s 轮询**(`updateAgentRunsPolling` 同款 `setInterval(loadAgentRuns, 2000)`),工作台激活时启动、离开时清。画布做**增量 diff 重排**:节点位置按 id 记忆,仅状态/进度变化的卡重绘,避免整树闪烁(参照 `renderAgentRuns` 已有的 `knownRuns/openRuns/knownNodes` 保存展开态思路)。
- 状态跳变 `◐→✓` 用 200ms 缩放+色过渡(`--dur-base`),不闪。

### 3.3 三态(空 / 单 run / 多 run)
- **空态**:无 run → 画布区居中空态卡(云纹水印 opacity .07 + 「本会话还没有 Agent 工作流」+ 引导「去对话里发起一个多 Agent 任务」)。
- **单 run**:run 选择器仍显(单 chip,选中),画布直接铺该 run。
- **多 run**:选择器多 chip,活动优先排序;切 chip 换画布(带 120ms 淡入)。历史 run 只读回看。

### 3.4 模式默认
- **简单模式**:主 Tab 默认落「对话」;「工作台」Tab 有活动 run 时显亮点标 `●`(`AGENT_RUN_ACTIVE` 命中即亮),引导主画像发现。工作台内简单模式仍可只读观测 + 审批池 + 插话(人话操作),但隐藏「重试及下游」等专家动作到「⋯」。
- **专家模式**:两 Tab 平权,工作台可为默认(记忆上次选择)。

---

## 4. 响应式

| 断点 | 布局 |
|---|---|
| ≥1180px | 三区并列:画布主区 + 右板固定 340/480px(用量/监控态建议 480,§UI-DESIGN-V3 §2.1 宽度三档) |
| <1180px | 右板收为**抽屉**:画布占满,点节点/池徽标从右侧滑出抽屉;底部用量条保留 |
| ≤760px(移动) | 工作台**只读**:画布支持缩放/平移(pinch + 拖拽),节点卡收缩为紧凑态;所有操作(插话/审批/重试)收进**节点详情抽屉**(点节点全屏抽屉弹出)。run 选择器横滑。主 Tab 降为顶部分段控件。 |

移动端不提供画布编辑(与 §UI-ORCHESTRATION §1.1 分级表「简易=只读监控」一致)。

---

## 5. 实现架构

### 5.1 复用与新增边界
**复用(不改)**:`loadAgentRuns` / `renderAgentRuns` 的数据管线、`nodeDisplayStatus` / `agentRunStatusLabel` / `agentStatusIcon` / `agentEngineBadge` / `runCostLabel` / `runElapsedMs` / `fmtDuration` 纯函数、`poolDecide` / `steerAgentNode` / `agentRunAction` / `deleteAgentRun` 动作、`updateAgentRunsPolling` 轮询骨架。

**新增(纯前端)**:
- `renderWorkbenchCanvas(run)`:分层布局 + SVG 边 + 节点卡渲染(SVG `<foreignObject>` 承 DOM 卡,或绝对定位 `<div>` 叠 `<svg>` 连线层——推荐后者,DOM 卡便于事件与无障碍)。
- `layoutDAG(nodes)`:§5.2 分层算法,返回 `{id: {x,y,layer}}`。
- `viewSwitch` 状态机(§5.3)。
- 右板三段渲染 `renderNodeDetail(node)` / `renderPoolPanel(run)` / `renderMailbox(run)`(内容与右栏 tab 同源,抽公共构造函数)。

### 5.2 分层布局算法(零依赖,伪码)
```
NODE_W=220, NODE_H=88, H_GAP=48, V_GAP=64, PAD=32
function layoutDAG(nodes):
  byId = index nodes by id
  layer = {}                              // id -> 层号
  // 记忆化 DFS:层号 = 1 + max(依赖层号),无依赖=0
  function computeLayer(id, visiting):
    if id in layer: return layer[id]
    if id in visiting: return 0           // 环保护(编辑器已禁环,防御成环)
    visiting.add(id)
    deps = (byId[id].dependsOn or []) ∩ byId.keys   // 只认存在的依赖
    L = deps.empty ? 0 : 1 + max(computeLayer(d, visiting) for d in deps)
    visiting.remove(id)
    layer[id] = L; return L
  for n in nodes: computeLayer(n.id, {})
  // 层内分组(保持 nodes 原序 → 稳定,不抖动)
  byLayer = groupBy(nodes, n => layer[n.id])
  maxWidth = max over layers of (count * NODE_W + (count-1) * H_GAP)
  centerX = PAD + maxWidth / 2
  pos = {}
  for Ly in sorted(byLayer.keys):
    list = byLayer[Ly]; n = list.length
    rowW = n*NODE_W + (n-1)*H_GAP
    x0 = centerX - rowW/2
    y  = PAD + Ly*(NODE_H + V_GAP)
    for i, node in list:
      pos[node.id] = { x: x0 + i*(NODE_W+H_GAP), y: y, layer: Ly }
  return pos
// 边:from(pos[a].cx, pos[a].y+NODE_H) → to(pos[b].cx, pos[b].y)
//   三次贝塞尔:C1=(fx, fy+dy), C2=(tx, ty-dy),  dy=(ty-(fy+NODE_H))*0.5
```
复杂度 O(V+E),记忆化后每节点算一次。层内交叉最小化(barycenter 重排序)为**可选增强**,首版不做——层内按原序均布已足够(典型 run ≤8 节点)。

### 5.3 view-switch 状态机
```
state.workbench = { view: 'chat'|'canvas', selectedRunId, selectedNodeId,
                    zoom, pan, panelOpen: {detail, pool, mail} }
switchMainView(v):
  state.workbench.view = v
  toggle 中栏 [data-main-view=v]
  if v==='canvas':
     updateAgentRunsPolling('workbench')   // 复用轮询,tab 名换成 workbench
     if !selectedRunId: selectedRunId = firstActiveRun ?? firstRun
     renderWorkbenchCanvas(currentRun)
  else:
     updateAgentRunsPolling(null)          // 停画布轮询(对话回合自有事件流)
// 亮点标:主 Tab「工作台」在 runs.some(r=>AGENT_RUN_ACTIVE.has(r.status)) 时加 .has-activity
```
`data-main-view` 与现有 `data-ui-mode` / `data-theme` 同为根/中栏级属性,一处切换全局响应,零 DOM 重建。

### 5.4 预估改动面 + 波次拆分
改动集中在 `app.js`(新增 ~400 行画布模块)+ `styles.css`(新增 `.wb-*` 画布类,~200 行)+ `index.html`(中栏加 Tab 切换 + `.wb-canvas` 容器,~20 行)。不碰 `server.js`。

**建议 2 步走**(降风险,每步独立可验收):
- **P3a 画布只读版**:主 Tab 切换 + run 选择器 + 分层布局 + SVG 边 + 节点卡渲染 + 2s 轮询增量重排 + 空/单/多三态 + 底部用量条。右板只做「选中节点详情」只读段。验收 = 画布画对拓扑、状态着色、实时刷新。
- **P3b 交互完整版**:右板三段折叠齐全(池审批 + 邮箱)、插话/重试/应用 worktree 操作接线、缩放平移 + 适应窗口、悬停依赖链高亮、响应式抽屉 + 移动只读、简单/专家默认与亮点标。验收 = 全交互 e2e。

---

## 6. 验收标准(e2e 可断言,8–10 条)

1. **Tab 切换**:点「工作台」主 Tab,中栏 `data-main-view` 变 `canvas`,`.wb-canvas` 可见、消息流隐藏;点「对话」还原。切换零 DOM 重建报错。
2. **拓扑正确**:给定 `pro,con → judge → fix → verify` 的 run,`layoutDAG` 输出 4 层,`pro/con` 同层(layer 0)、`judge` layer 1、`fix` layer 2、`verify` layer 3;层内 `pro/con` x 坐标不重叠、居中对称。
3. **状态着色**:running 节点卡有脉动类 + elev-2;rejected/waiting_resource 卡为琥珀(`--warn` 家族);failed 为红;succeeded 为 `--ok` 徽标——全部读 `nodeDisplayStatus` 而非硬编码。
4. **边着色**:源节点 running 的边带流动虚线类;源 rejected/waiting 的边为琥珀;贝塞尔路径 `d` 属性从源底缘中点连到目标顶缘中点。
5. **选中详情**:点 judge 节点,右板详情段渲染其 `model`(claude-opus)、门 verdict + 置信度、`progressLog` 全量时间线;非选中节点详情不串。
6. **插话资格**:选中 openai 引擎 running 节点显插话框;选中 Claude 引擎节点**不显**插话框(与 `steer_node` 后端拒绝一致)。
7. **任务池审批**:有 `proposed` 池项时,run 选择器显「待批准 1」徽标,右板池段渲染三行人话卡;点「同意添加」调 `poolDecide(runId, poolId, true)`。
8. **邮箱**:`run.messages` 有 2 条时右板邮箱段渲染 2 行 `sender→target·摘要`;`dropped` 项带「未送达」灰标。
9. **实时性**:轮询在工作台激活时以 2s 间隔跑;某节点 `status` 由 running→succeeded 后一个轮询周期内卡徽标更新为 ✓ 且脉动类移除,节点位置不抖动(id 记忆稳定)。
10. **响应式**:视口 <1180px 右板变抽屉(默认收起、点节点滑出);≤760px 节点卡进只读紧凑态、操作收进详情抽屉。空态(0 run)画布显空态卡 + 云纹水印。

---

## 7. 与既有波次的衔接

- **前置依赖**:P2 已完成「监控卡降噪」(node 去外框改分隔线、状态徽标缩色点)与「右栏宽度三档」——工作台节点卡直接沿用降噪语义;右板 480px 档是工作台右侧上下文板的宽度基线。
- **数据前置**:`UI-ORCHESTRATION §4` 的 CLI 进度节流落盘 + 状态语义拆分(rejected/failed/skipped)已落地,画布的活动行与三色状态才有真数据可画。
- **后续**:时间轴/泳道视图(甘特态,`UI-ORCHESTRATION §2.6`)可作为工作台内第二子视图,P3 之后独立小迭代接入,不阻塞本稿。
