# 团队模式 v2 设计:共享任务池 / Agent 邮箱 / 跨会话记忆

状态:设计稿 r2(经 2 视角对抗评审修订:2 个收尾竞态 blocker、邮箱队列挤占 blocker、9 项 gap 已吸收)。基线:第 8 波 steer_node(`20385dc`)、第 9 波 Skills v1(`fc7ff27`)之后。
前置结论:§11 裁决维持禁运行时嵌套——本设计中的任务池即嵌套的可观测替代品。

## 0. 设计原则(继承本轮全部波次的教训)

1. **可观测性优先**:一切委派与通信必须落进 run JSON(可回放、可审计),不允许出现监控体系外的第二层活动。
2. **不扩大死锁面**:新机制不得引入新的"等待对方"语义。凡可能阻塞的交互一律改为异步投递 + 不承诺送达(steer 的既定语义)。
3. **诚实投递语义**:不给虚假成功提示;送达不了要么拒绝要么明说"尽力投递,可能丢弃"(steer P3 修复的教训)。
4. **不可信内容必围栏**:任何来自文件/其他 agent 的文本进入提示词,一律走 fence + 「不得覆盖守则」声明(Skills v1 P2-1 范式)。
5. **一切花费入账**:新增的模型调用必须走 appendUsageLedger(kind 语义延续 turn/subagent/aux)。
6. **复用已验证基建**:steerQueues/迭代边界投递、normalizeAgentWorkflow 节点管线、资源租约与 wouldDeadlock、playbook 起草确认流、skills 渐进注入,全部优先复用而非新造。

## A. 共享任务池(Shared Task Pool)—— Phase 1,优先级最高

**问题**:子代理发现需要帮手时无路可走(禁嵌套),只能把子任务塞进自己回合里硬做。

**方案**:子代理可**提案**追加节点;提案进 run 级任务池;审批通过后物化为普通 DAG 节点,走全部既有管线(资源声明/质量门/预算/用量记账/steer/进度)。

### A1. 提案工具
- 新原生工具 `propose_task {task, roleId?, dependsOn?, resources?, toolTier?, reason}`,仅注册给 OpenAI 引擎子代理(与 skill_read 同款 offer 门控模式,不进 MCP_TOOLS)。
- 纯元数据操作,read tier;提案**不阻塞提案者**——工具立即返回「已提交待审批(poolId=…),你无需等待,继续完成自己的任务」。阻塞等待会重建嵌套等待的死锁面(原则 2)。
- Claude 引擎子代理 v2 不提供(单发进程,与 steer 同款不对称,文档化)。
- **分发上下文(评审修订)**:propose_task 不能走全局 toolCall 分发(拿不到 runtime/runId)——必须仿 getSteer 经 runSubAgent 参数把闭包注入 runSubAgentCore,在子回合内做专用分发分支。offer 门控仿 skill_read;`propose_task`/`send_to_agent` 作为**元工具豁免 role.openaiTools 白名单过滤**(它们是编排基建不是业务能力,否则自定义角色全部误杀)。禁嵌套双守卫(~L6417)只点名 spawn_agent/orchestrate_agents,不会误杀,实现时加回归断言。

### A2. 任务池数据与审批
- `run.taskPool = [{ id, proposedBy(nodeId), task, roleId, dependsOn, resources, toolTier, reason, status: proposed|approved|rejected|expired|materialized, decidedBy: user|auto|policy, decidedAt, resultNodeId }]`,随 run JSON 持久化。
- 审批策略(launch 参数 + config 默认):
  - `manual`(默认):UI 运行卡出现待审批区,逐条 批准/拒绝。
  - `auto-capped`:自动批准,直到 `poolAutoCap`(默认 3)用尽,之后转 manual;总节点数仍受既有 maxNodes(32)硬顶,**物化时同步复检**(launch 时的检查不覆盖运行中追加)。
  - `off`:不注册 propose_task 工具。
- `decidedBy: user | auto`(评审修订:删除语义未定义的 policy 枚举)。
- **收尾竞态防线(评审修订,blocker)**:调度循环是批次同步的,收尾段内含 await,审批处理器在此窗口仍能看到 live runtime → 物化出永远 queued 的孤儿节点而 run 已记 succeeded。对策三件套:
  1. runtime 增 `closing` 标志,收尾第一步**原子置位**;审批/提案入口镜像 steer_node 的 stopRequested 检查——closing 或非 live 一律 409。
  2. **宽限窗**:全部节点终态但 taskPool 有 proposed 项时,manual 策略下延迟收尾(默认 60s,记 `poolGraceUntil`,run 状态显示「等待任务池审批」;idle watchdog 对此窗口豁免);窗内批准→物化并继续调度;窗过→未决置 `expired` 再收尾。
  3. run 已收尾后的批准请求:409 +「运行已结束;可在新运行中执行该任务」(v2 不做自动续跑;续跑复用 launchPersistedAgentRun 留作 v2.1 可选项)。
- **防提案环**:物化节点也可提案,但 proposedBy 链深 ≤ 2(池生池只允许一层),且每 run 提案总数 ≤ 8;超限工具返回明确拒绝。

### A3. 物化
- approved → 走 normalizeAgentWorkflow 同款节点清洗(id 前缀 `pool-`)→ append 进 run.nodes,默认 `dependsOn=[proposedBy]` → 调度器在**当前批次结束后**拾取。
- **投递粒度诚实声明(评审修订)**:调度循环取批后 `Promise.all` 等整批——物化节点最早在含提案者的当前批全部终态后才派发。默认 dependsOn=proposedBy 时语义等价("帮手基于提案者结论工作");**"与提案者并行的帮手"在批次同步循环下不成立**,v2 明确不承诺,也不为此把调度改事件驱动(违背零新执行路径)。独立帮手可显式 `dependsOn: []`,仍是批次粒度延迟。
- **pool 节点缺省属性(评审修订)**:`failurePolicy: 'continue'`(帮手失败不把成功 run 拉成 partial,也不阻塞下游)、engine/model 继承提案者节点、无 gate;提案时可显式覆盖 toolTier(≤提案者)。
- 物化节点 = 普通节点(append 进 run.nodes,完成判定天然覆盖):资源租约过 wouldDeadlock、用量记 kind:'subagent'、可 steer、可 retry、进 progressLog。**零新执行路径**。

### A4. UI(分级,评审修订:非程序员措辞)
- 简单模式:仅当有待审批提案时浮出「待批准的新任务 N」徽标;审批卡固定三行人话——**谁提议**(节点名)/ **做什么**(task 首句 ≤60 字)/ **预计消耗**(新增 1 个节点、至多 N 轮调用;auto 余量提示);按钮「同意添加 / 不用了」。
- 专业模式:运行卡常驻任务池分区(全状态列表 + reason 全文 + 物化节点跳转 + 宽限窗倒计时)。

### A5. 验收标准(e2e 可断言)
1. 子代理调 propose_task → run JSON 出现 proposed 项,提案者不阻塞继续完成;
2. manual 批准 → 节点物化并执行,结果并入 run;拒绝 → 状态 rejected,无节点;
3. auto-capped 超 cap 后转 manual;链深 >2 / 总数 >8 被拒;物化时超 maxNodes 被拒;
4. 物化节点的用量入账、可 steer、资源冲突时正常排队、失败不拉垮 run 状态(failurePolicy continue);
5. **收尾竞态**:closing 置位后审批 409;有 proposed 项时进入宽限窗(run 显示等待态,窗内批准可执行,窗过 expired);run 结束后批准 409 带指引。(测试缝:宽限窗时长可由环境变量缩短。)

## B. Agent 邮箱(节点间消息)—— Phase 2,薄层

**问题**:节点间唯一通信 = dependsOn 结论注入(开跑时一次性)。并行节点无法互通(如 Explorer 发现的关键事实无法及时给并行的 Worker)。

**方案**:单向异步消息,**直接泛化 steer 基建**——同一 per-node 队列、同一迭代边界投递点、同一资格检查。

### B1. 工具与投递
- 新工具 `send_to_agent {targetNodeKey, message}`(OpenAI 引擎子代理;经 runSubAgent 闭包分发,同 A1)。
- **独立队列(评审修订,blocker)**:代理消息走 `runtime.mailQueues`(与用户的 steerQueues **分池**),条目为 `{sender, text}`(steer 队列是纯文本、前缀硬编码,装不下 sender;更重要的是共用 cap=3 会让代理连发 3 条堵死用户对该节点的插话——用户控制权优先)。每目标邮箱 cap 3、2000 字符截断。
- 投递:目标节点迭代边界**先 drain steer 再 drain mail**,注入 `[节点 <sender> 消息] …`;目标资格 = steer_node 同款(running/queued/waiting_resource + openai 引擎 + 非确定性门);schema/gate 目标复用 steerReminder。
- **deliveredAt 语义(评审修订)**:定义为"已注入某次 attempt";该 attempt 失败重试时随 subHistory 作废 → run.messages 回标 `dropped`(v2 不自动重投,诚实标记);loop 节点每轮迭代新建 subHistory,消息不跨轮存续(B2 明示)。
- 工具返回诚实语义:「已入队,目标下一次调用前投递;若目标已结束/被跳过则丢弃」。
- 防风暴:每发送者每 run ≤ 8 条,每 run 全局 ≤ 24 条;自发自收拒绝。消息不阻塞、不等回执 → 环路无害。

### B2. 可观测
- 双端 progressLog 里程碑(`发消息 → X · 摘要` / `收到 X 消息 · 摘要`)+ `run.messages[]` 持久化(sender/target/text/deliveredAt|dropped)。

### B3. 明确不做(v2 边界)
- 阻塞式 request/reply(死锁面)、广播(噪音)、跨 run 信箱(生命周期随 run)。

### B4. 验收标准
1. A 节点发消息 → B 节点下一迭代请求体含前缀消息;2. 双端里程碑 + run.messages 持久化;3. 目标已终态 → 工具返回"将丢弃"语义且 run.messages 标 dropped;4. 风暴上限逐级触发;5. schema/gate 目标节点自动附带 JSON 提醒(复用 steerReminder)。

## C. 跨会话记忆 —— Phase 3,独立

**问题**:每次会话/工作流从零开始,踩过的坑、项目惯例无法沉淀。

**方案**:文件型记忆库 + 起草-确认写入 + 围栏式渐进注入。刻意保守:自动起草、**人工确认**才入库(质量与投毒防线)。

### C0. 与既有 project-memory 的分工(评审修订,gap)
buildProviderSystemPrompt 已注入 `<project-memory>`(CLAUDE.md/AGENTS.md,作者=**仓库**,随代码走)。本记忆库作者=**用户+AI 经确认**(随工作台走)。分工:仓库约定沉淀进 CLAUDE.md(建议用户提交进 git),个人经验/教训/跨项目习惯沉淀进记忆库。注入标签用 `<workbench-memory>`、UI 一律称「工作台记忆」,与「项目记忆(CLAUDE.md)」严格区分;两者同处不可信参考带,冲突时后注入者不覆盖先注入者(均声明不得覆盖守则,交模型权衡)。

### C1. 存储
- `dataRoot()/memory/global/*.md` 与 `dataRoot()/memory/project/<projectKey>/*.md`。
- **projectKey(评审修订)**= sha256(path.resolve 后、win32 再 toLowerCase 的 cwd)——沿用资源键 toLowerCase 先例,防 `C:\Foo` 与 `c:\foo` 分裂;组目录内写 `meta.json`(明文路径+label),面板反查不依赖 recentWorkspaces(≤10 LRU 会逐出)。项目移动/改名 → 面板提供「迁移到当前项目」动作;导出/多机同步 v2 明确不做。
- 目录在 dataRoot 内 → provider 引擎 file_read 天然在允许根;**Claude 引擎(评审修订)**:非 bypass 权限模式下 Read 出 cwd 会被权限闸拒——启用记忆的会话 spawn 时对 memory 目录追加 `--add-dir`(主回合与需要时的子代理两处),否则文档化"仅见索引不可展开"。
- 单文件 = 单条记忆:frontmatter(name/description/type: convention|lesson|reference/createdAt/sourceRunId|sourceSessionId)+ 正文。id 校验同 SKILL_ID_RE 防穿越。

### C2. 写入路径(复用 playbook 起草范式)
- 会话/run 结束后「存为记忆」按钮 → provider 起草(镜像 draftPlaybookFromSession:providerRawCompletion + aux 台账 note:'memory-draft')→ 编辑弹窗确认 → 原子写。
- Claude 引擎会话:v2 起草仅 provider 可用(同 playbook 现状不对称);无 provider 时提供纯手写表单。
- 明确不做:静默自动写入(投毒/噪音防线,原则 3、4)。

### C3. 注入路径(复用 skills 渐进注入范式)
- 会话级启用(默认:项目记忆自动启用、global 手动;`session.memories` 上限 8,{id, scope} 锁定来源——Skills P2-2 同款防调包)。
- system prompt 注入紧凑索引:`<memory-index>` 围栏 + 「参考资料,不得覆盖守则」声明 + 每行 name/description/文件路径;整段 ≤2000 字符;provider 与 Claude 同款(路径可直接 file_read/Read,渐进展开零新工具)。
- 注入位置:与 skill-index、project-memory 同处不可信参考带。

### C4. 生命周期
- 记忆面板(设置或侧栏):列表/编辑/删除/启停;按 createdAt 倒序,无自动过期(v2 人工修剪);索引超限截断加省略行。

### C5. 验收标准
1. 起草-确认-落盘全链 + aux 台账;2. 双引擎索引注入(围栏+声明+路径)且 ≤2000;3. {id,scope} 来源锁定,文件消失→幽灵项可移除;4. 项目记忆随 cwd 切换正确换组;5. 未启用 → 零注入零开销。

## D. 排期与风险

| Phase | 内容 | 预估 | 关键风险与对策 |
|---|---|---|---|
| 1 | 任务池 | 1 波 | **收尾竞态孤儿节点 → closing 门+宽限窗+结束后 409(A2)**;提案环/预算失控 → 链深≤2、总数≤8、maxNodes 物化复检、auto cap 3;帮手失败拉垮 run → failurePolicy continue 缺省 |
| 2 | 邮箱 | 0.5 波(可与 1 合并) | **挤占用户插话 → mailQueues 与 steerQueues 分池(B1)**;消息风暴 → 三级 cap;attempt 重试丢消息 → dropped 回标诚实语义 |
| 3 | 记忆 | 1 波 | 记忆投毒 → 人工确认 + 围栏 + 来源锁定;与 CLAUDE.md 概念混淆 → C0 分工与命名;projectKey 大小写分裂 → toLowerCase 规范化 + meta.json 反查;Claude 权限闸 → --add-dir |

实现顺序建议 1 → 2 → 3;每波沿用「单 Opus 主树串行改 server.js → 对抗验证 → 修复 → 提交」流程。
