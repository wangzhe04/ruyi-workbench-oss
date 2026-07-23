# 如意 Ruyi · UI 重设计 + 多 Agent 编排展示 设计规格

> 本文是给实现者（Opus/Sonnet）的**可直接落地设计规格**，非泛泛而谈。所有类名/事件类型/字段名均对齐现有代码
> （`app.js` / `server.js` 当前实现），新增项标注 `[新增]`。配套可视化 mockup 见本轮 Artifact。
> 三块内容：**① 分级用户 UI 重设计　② 多 Agent 编排实时监控（重点）　③ 青花视觉系统**。附 CLI 进度修复技术设计。

---

## 0. 设计目标与硬约束

**目标**
1. **分级清晰**：非程序员（主画像）看到的是"任务 + 结果 + 可反悔"，开发者才看到引擎/工具/DAG 内部。当前简易/专家模式收敛不彻底（设置弹窗、体检死链、错误文案都漏了），要做到"一个 `data-ui-mode` 切换、全站一致"。
2. **编排可观测**：多 Agent 跑起来能一眼看到"谁在跑、跑到哪、卡在哪、为什么失败"——当前是纵向 `<details>` 列表、CLI 引擎还没进度，等于黑盒。
3. **美**：把已有的青花瓷/藏蓝墨品牌提炼成一套克制、专业、中文优先的设计系统，而不是堆装饰。

**硬约束（不可违反）**
- 零 npm 运行时依赖、原生 JS 无框架无构建（`app.js` 直接改）。
- 离线优先：不引外部字体/CDN/图片，视觉资源用内联 SVG（复用 `docs/branding/*.svg` 的如意云纹）。
- 深浅双主题 + WCAG AA 对比度红线。
- 向后兼容现有会话数据与事件协议（新增事件字段而非改名）。

---

## 1. 分级用户 UI 重设计

### 1.1 三层而非两层
现有 `data-ui-mode` 是 `simple|pro` 二元。保留属性但明确**三种呈现态**（`simple` 再按是否首跑细分）：

| 态 | 触发 | 心智 | 顶栏 | 工具面板 | 设置 | 错误文案 | DAG |
|---|---|---|---|---|---|---|---|
| **首跑引导** | `isFirstRun()` | "我该干嘛" | 极简（仅品牌+主题） | 隐藏 | 隐藏 | — | 隐藏 |
| **简易（知识工作者）** | `ui-mode=simple` | "交任务、看结果、能反悔" | 标题/工作夹/安全chip/模型chip/主题/更多 | 文件·产物·变更（`agent-runs` 改叫"任务进度"，见 §2） | 仅"基础/服务商/联网搜索" | 全中文人话 | 只读监控视图，不给编辑器 |
| **专家（开发者）** | `ui-mode=pro` | "看内部、可调参、可编排" | 全部 + 能力矩阵 + 🧰 | 全 7+5 tab | 全 7 tab | 可含技术细节 | 完整图形编辑器 |

### 1.2 一致性矩阵（修掉当前漏收敛）
实现者按这张表逐条对齐——**同一个 `ui-mode` 判定要贯穿所有入口**：

- `switchSettingsTab`（app.js:4815）**[新增]** 按 `state.uiMode` 过滤 tab：简易模式只渲染 `basic/providers/search`，其余 `display:none`。
- `openDoctorBtn`（index.html:66）：简易模式**隐藏**该按钮（对齐 `.tool-tabs` 里 doctor 的隐藏规则），消除 `switchTab('doctor')` 静默跳文件页的死链。
- 错误展示：简易模式一律走 `apiErrText(e)` + 中文人话；专家模式可追加原始 `.detail`（默认折叠）。
- 权限弹窗：简易模式默认折叠原始 JSON、只显示人话摘要；专家模式默认展开（见 §3.5）。
- 帮助面板：按模式给不同快捷键清单。

### 1.3 首跑引导升级
- `boot()` 失败（app.js:5036）**[新增]** 不再只塞英文进状态行——渲染**占满对话区的故障卡**：大标题「无法连接本地服务」+ 三条可能原因（端口被占/服务未启动/被安全软件拦截）+「重试连接」按钮 +「查看日志」入口。这是主画像第一次翻车最狠的点。
- 首跑"你是谁"二选一卡片：`[我主要处理文档/表格/资料 → 简易]` `[我会写代码，要完整能力 → 专家]`，落定 `ui-mode`，可随时在顶栏切换。

---

## 2. 多 Agent 编排实时监控（重点）

### 2.1 现状问题（要一次性解决）
- 编辑视图（`.workflow-graph` 空间图，1400×1000 固定）与运行视图（`renderAgentRuns` 纵向 `<details>` 列表）**是两套皮**，失败节点定位要在文本里脑内重建拓扑。
- **CLI 引擎/异步启动/resume 无进度**（详见 §4 技术设计）。
- 无缩放/小地图、纯指针事件、无死锁/等待资源的可视化、状态语义混（失败/门否/跳过都显示得含糊）。

### 2.2 核心决策：统一"实时 DAG 画布"
**运行监控复用编辑器的空间图**，不再维护第二套 DOM。一个 `<div class="wf-canvas">` 同时承载编辑态与运行态，靠 `data-mode="edit|run"` 切换交互（运行态禁编辑、开实时着色）。

```
┌─ 任务进度  [运行中 · 3/8 节点 · 04:12 · ~18k tok]      [暂停][停止][适应窗口 ⤢][切列表视图]┐
│                                                                                          │
│    ┌──────────────┐            ┌──────────────┐                                          │
│    │● explorer    │──┐     ┌──▶│◐ reviewer    │   ← 运行中节点脉冲呼吸 + 进度条           │
│    │  Explorer·CLI│  │     │   │  Reviewer·CLI│      「思考中… 已产出 1.2k 字 · 迭代 3/24」│
│    │  ✓ 8.1k字    │  ├─────┤   └──────────────┘                                          │
│    └──────────────┘  │     │   ┌──────────────┐                                          │
│    ┌──────────────┐  │     └──▶│⏸ fixer       │   ← 等待资源（黄）「等待 worktree:main」  │
│    │● worker      │──┘         │  Worker·Prov │                                          │
│    │  ✓ 已改3文件 │            └──────────────┘                                          │
│    └──────────────┘                                                                      │
│                                                                                          │
│  [小地图▫]                                                          [时间轴泳道 ⇅]        │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 节点卡组件规格 `.wf-node`
每个节点卡显示（数据全部来自持久化 `run.nodes[i]`，字段已存在）：

| 区 | 内容 | 数据源字段 |
|---|---|---|
| 状态徽标 | ● 队列 / ◐ 运行(脉冲) / ✓ 成功 / ✗ 失败 / ⏸ 等资源 / ⊘ 跳过 / ⛔ 阻塞 / ⏹ 取消 / ⚠ 降级 | `status` + `degraded` |
| 标题行 | 节点 id · 角色 label · **引擎徽标**（Claude/Provider 不同色） | `id/roleLabel/engine` |
| 活动行（运行态） | 「调用工具 file_read」/「思考中…」/「已产出 N 字」 | `progressLog` 末条（见 §4） |
| 预算/迭代 | 迷你环形或条：`iters/maxIters`、loop `loopIteration/maxIterations`、`noProgressCount` 警示 | `iters/maxIters/loopIteration` |
| 计时 | 已运行 `now-startedAt` | `startedAt/completedAt` |
| 结果/错误摘要 | 成功=`structuredResult.summary` 或 `result` 截断；失败=`error` | `result/error/structuredResult` |
| 门/置信度 | 质量门节点显示 verdict + confidence 环 | `gateVerdict/confidence` |
| 资源锁 | 持有/等待的资源 chip（等待时高亮 blocker） | `acquiredResources/waitingForResources/resourceBlockers` |

**交互**：hover 高亮其入边/出边与依赖链；点击展开右侧详情抽屉（完整 progressLog 时间线 + 结果全文 + 该节点的 tool_use/tool_result 卡）。

### 2.4 状态语义分离（对齐编排引擎 B8 修复）
当前"节点执行失败"与"质量门判否/条件不满足"共用 `failed`，导致条件下游被误阻塞。展示层**必须区分三种非成功终态**，且颜色/图标/文案不同：

- `failed`（执行错误，红）——真的报错了。
- `rejected` **[新增状态或用 `gateVerdict='fail'` 派生]**（质量门判否，琥珀）——"发现了问题"，不是坏事，条件下游应据此评估而非阻塞。
- `skipped`（条件不满足，灰）——正常跳过。

> 这一条与后端 §2.2/B8 是同一件事的两面：后端把状态拆开，前端才能正确着色 + 正确画"仅当 review=fail 才跑 fix"这类条件边。

### 2.5 死锁/停滞可视化（对齐 B1/B10）
- 节点在**工具级资源**上等待时也要更新卡片状态为 ⏸ 并显示 blocker（当前 B10：工具级等待不更新 `node.status`，卡片显示"运行中"骗人）。
- 整个 run 空闲超过 watchdog 阈值 **[新增]** 顶部横幅：「疑似停滞：X 节点互相等待资源 [查看] [强制停止]」——把 B1 的死锁从"永久转圈"变成可见、可干预。

### 2.6 两个视图（画布默认，列表可切）
- **画布视图**（默认）：上面的空间图，一眼看拓扑与卡点。
- **时间轴/泳道视图**（可切）：每个并发节点一条泳道（类甘特），横轴时间，直观看"哪些真并行了、关键路径在哪、谁拖长了整体"。对调优并发很有用。
- 保留**紧凑列表**（现有 `renderAgentRuns` 升级版）给窄屏/简易模式。

### 2.7 聚合头 + 成本
run 头部显示：状态、已运行时长、节点 done/total、**累计 token/成本**（`usage` 数据已在事件流，这里顺带落地竞品差距#4 的成本可见性）、关键路径提示。历史 run 进「任务进度」tab 列表，可回看。

---

## 3. 青花视觉系统（美观优化）

### 3.1 设计 token（先立规矩，修掉硬编码）
在 `styles.css :root` 补全语义 token，**并修掉 `--success/--warning` 未定义 bug**（§5.1 快赢1）。建立：

- **间距**：`--sp-1..8`（4/8/12/16/24/32/48/64），全站 padding/gap 只用 token。
- **圆角**：`--r-sm/md/lg/pill`（6/10/16/999）。
- **投影**：`--elev-1/2/3`（卡/浮层/模态，暗色降不透明度）。
- **动效**：`--ease-out`、`--dur-fast(120ms)/base(200ms)/slow(320ms)`，全部受 `prefers-reduced-motion` 收敛。
- **语义色**：`--ok/--warn/--danger/--info` + 各自 `-bg`/`-fg` 变体，两主题都过 AA。节点状态色一律引这些，不再硬编码。

### 3.2 青花主色与层次
- 主色保留青花蓝（`--accent`），定义 `--accent-1..5` 由浅到深的青花梯度，用于：运行态脉冲、主按钮、选中态、引擎徽标（Claude=青花蓝，Provider=釉里红/赭，形成"双引擎"视觉区分）。
- 背景：藏蓝墨（暗）/ 素白釉（亮），层次用 `--surface-0/1/2`（底/卡/浮）。

### 3.3 如意云纹的克制运用
- 复用 `docs/branding/ruyi-mark.svg` 云纹作**空状态与 run 头部的极淡水印纹理**（opacity ≤ 0.04），不进正文、不干扰阅读。
- 节点连线用**云纹曲率**（贝塞尔曲线而非直角折线），呼应品牌又提升 DAG 可读性。

### 3.4 排版与密度
- 中文优先字号阶梯：`--fs-11/12/13/14/16/20/24`，正文 14、次要 12。行高 1.6（中文）。
- **密度随分级**：简易=舒适（`--density: comfortable`，更大点击区/留白），专家=紧凑（`--density: compact`，信息密度高）。用一个 `data-density` 属性驱动间距 token 缩放。

### 3.5 关键组件微交互
- 节点状态跳变：`◐→✓` 用 200ms 缩放+色过渡，不闪。
- 流式活动行：轻微 shimmer（`prefers-reduced-motion` 下关）。
- **权限弹窗**：人话摘要卡（工具动词 + 文件路径 + 内容长度）在上，原始 JSON 折进 `<details>`（简易折叠/专家展开）——修掉当前 2263 甩原始 JSON 的问题。
- 破坏性操作：统一 `confirmDanger(title, consequence, confirmLabel)` 组件替换所有原生 `confirm()`（原生框不跟主题、是全站唯一跳出式元素）。

---

## 4. CLI/异步 Workflow 进度修复（技术设计，喂给 Opus）

**根因（已定位）**：
1. UI 按钮启动（`async`）与 resume 路径 `onEvent=()=>{}`（server.js:6024 及 10051 无活跃聊天时）→ 无实时事件。
2. `recordAgentNodeProgress`（5735）只在内存累积 `node.progressLog`；`saveAgentRun` 只在节点状态跳变时落盘（5927/5938/5939）→ 长节点执行期，2s 轮询读到陈旧状态。
3. Claude 节点 `runClaudeSubAgentOnce` 只发 `tool_use`/`tool_result`（5105-5106），`assistantText` 只累加不发事件（5104）→ 读/审型节点几乎无进度事件。

**修法（三选一优先做 A+C，B 视投入）**：
- **A. 节点执行期节流落盘**：`nodeEvent`（5929）里对 `recordAgentNodeProgress` 之后加**节流 `saveAgentRun`**（如每 ≥1.5s 或每积累 N 条 progress 落一次盘），让轮询能读到进行中进度。改动小、对两引擎和 async/resume 全覆盖。
- **B. run 级独立事件流 [新增]** `GET /api/agent-runs/:id/stream`（NDJSON/SSE）：面板订阅它拿实时进度，彻底摆脱"必须有活跃聊天回合"的耦合。体验最好，改动中等。
- **C. Claude 节点补里程碑进度**：`runClaudeSubAgentOnce` 在 `ev.kind==='text'` 累计到阈值时发一个轻量 `subagent_progress` 事件（"已产出 N 字"）；`result` 事件里带最终字数。让 `recordAgentNodeProgress` 认这个新类型。
- 落地后补 e2e：`agent-workflow-ui-progress` 扩展一个"async 启动 + 轮询能看到中间 progressLog"的断言；`agent-workflow-claude-engine` 加"CLI 节点执行期有 ≥1 条进度落盘"。

---

## 5. 其他迭代方向（本轮设计新识别）

1. **「任务进度」升为右栏一等公民**：`agent-runs` tab 改名，简易模式也常驻可见，含历史 run 列表 + 成本汇总。让"我交给 AI 的活儿"有稳定的去处。
2. **成本/用量看板**（竞品差距#4，数据已在）：run 头 + 独立小面板，按会话/引擎/日聚合，加预算软告警。低成本高感知。
3. **失败一键处置**：节点卡右键/悬浮菜单直接「重试此节点」「从此处继续」「查看错误」，对齐后端已有的 `retry_node`/`resume` 动作（10099/10110），省去现在要去列表里找。
4. **DAG 编辑器可用性**：缩放/适应窗口/小地图 + 键盘可达（节点 Enter 进编辑、方向键微调位置），修掉纯指针依赖。
5. **语音输入**（竞品差距#1，Web Speech API 零后端）：composer 加麦克风按钮，对主画像免打字，与零依赖约束不冲突——可作为独立小迭代。

---

## 6. 实现者交接清单（改动落点速查）

| 模块 | 文件:锚点 | 动作 |
|---|---|---|
| 分级一致性 | `switchSettingsTab` app.js:4815、`switchTab` 4830、`openDoctorBtn` index.html:66 | 按 uiMode 过滤/隐藏 |
| 统一 DAG 画布 | `openWorkflowEditor` app.js:2396、`renderAgentRuns` 2540、`.workflow-graph` styles.css:1135 | `data-mode=edit|run` 复用同一画布；节点卡组件化 |
| 事件消费 | `handleAgentWorkflowEvent` app.js:2318、`loadAgentRuns` 2620 | 消费新 `subagent_progress`；订阅 run 级 stream（若做 B） |
| 进度修复 | `recordAgentNodeProgress` server.js:5735、`nodeEvent` 5929、`runClaudeSubAgentOnce` 5104 | 节流落盘 + Claude 里程碑事件 + 可选 run stream 端点 |
| 状态语义 | 节点 `status` 赋值点 server.js:5914/5920/5941/5957、`agentRunStatusLabel` app.js:2524 | 拆 `rejected`/`failed`/`skipped`，前端分色 |
| 视觉 token | `styles.css :root` + `[data-theme]` | 补全 token、修 `--success/--warning`、加 density |
| 视觉资源 | `docs/branding/*.svg` | 内联云纹水印 + 曲线连线 |

> **顺序建议**：进度修复(§4 A+C)与状态语义拆分是"数据层"，必须先于或同步于画布重设计——否则新画布还是没数据可画。视觉 token 可并行先行（纯 CSS，零风险）。
