# 29 · 第 119 波实施方案（定时任务与触发器：管家可下单、到点自动执行）

> **状态（2026-09-04）**：用户 2026-09-03 立项——「希望加入 Cron／定时任务能力，用户可以和管家说『明天给 xxx 发条消息』，管家设置好会话与定时任务，第二天到点会话自动生成并执行」。编号 119 顺延自 28 号的 118。
> **性质**：新增引擎侧调度器、持久化面、路由、原生工具与 UI；含**无人值守自动执行**，是本项目迄今自治程度最高的功能，权限与费用纪律优先于功能完整度。
> **关联**：[27 号 工作台管家](27-waves-115-117-steward.md)（管家是定时任务的主要下单入口与结果播报者，§5 能力清单第 3 项）、[24 号 §0 统一纪律](24-waves-108-110-implementation.md)、[22 号 红线与发布门](22-agent-soc-microarchitecture.md)。
> **前置**：116（管家引擎侧，提供收件箱与决策日志）非强制但强烈建议先行——无管家时调度器仍可用，只是下单要走表单而非对话。

---

## 1. 摸底事实（已核实，2026-09-03）

| 事实 | 位置 | 含义 |
|---|---|---|
| 服务端可进程内发起完整回合 | `streamChat`（`10-context-governance.js:2129`）直接 `await runOpenAiTurn(...)`／`runClaudeTurn(...)`，`onEvent` 为单一 sink | 调度器到点即可自己跑一个回合，不必伪造 HTTP 客户端 |
| 无进程内事件总线 | 全仓无 EventEmitter／pub-sub；实时只有单回合 HTTP 流与前端 30s 轮询 | 调度器用自己的 tick，不依赖总线；结果经既有 Mission Change Ledger 与待决投影露出 |
| 启动时中断重连有先例 | `markInterruptedAgentRuns()`（`08-agent-runs.js:362`）、`autoResumeInterruptedRuns()`（`:322`，受 `autonomyAutoResume` 门控）、`classifyRunResumeTier` | 「错过的触发」在启动时按同一套分级重算，不发明第二套恢复协议 |
| 授权书是内存态、只认 UI token | `06f-autonomy-grants.js`（进程内 Map，重启即清；`issuedBy` 硬编码，签发只经 `POST /api/autonomy/grant` header token） | **无人值守任务不能依赖现有授权书**；需要持久化的、随任务定义的有界授权（§5） |
| 权限档位与判定 | `PERMISSION_MODES`=default／acceptEdits／plan／auto／bypass（`01-config.js:313`）；`nativeToolGate(mode,tier)` 纯函数（`07-autonomy.js:715-725`）；`streamChat` 可按请求临时覆盖 permissionMode 且不回写全局（`10:2135-2138`） | 定时任务自带 permissionMode，走既有闸门，不新增权限语义 |
| 待决机制成熟 | `decideIntervention()`（`13d-core-domain-routes.js:473`，`source` 无枚举白名单）＋ CAS ＋ 幂等键；`GET /api/interventions` 跨会话收件箱 | 无人值守遇到需要人拿主意的动作时，**挂起成待决**而不是自作主张 |
| 用量记账 | `appendUsageLedger(kind:'aux', note)`；`estimated:true` 先例 | 定时任务调用记 `note:'scheduled'`，与手动回合区分 |
| 持久化纪律 | 103c 清册 `dev-harness/durable-state-inventory.js`；`atomicWriteJson`（`01-config.js:1035`）；append-only NDJSON 先例（`session-changes`／`agent-run-events`） | 任务定义走 JSON 原子写，触发历史走 append-only |
| Windows 无常驻守护 | 启动器 `Start-Workbench.cmd`／`RuyiDesktop.exe`；工作台是前台进程 | **默认只在如意运行时调度**；开机自启是可选、显式、可撤销的一步（§7） |

**NOT FOUND**：任何既有 cron／schedule／timer 持久化能力（全仓无调度器代码）。

## 2. 目标与非目标

- **目标**：用户用一句话（对管家说或填表单）建立一次性或重复的定时任务；到点后如意自动开一个会话执行它；执行结果、失败与「需要你拿主意」都能被看到；全过程可暂停、可立即运行、可删除、可审计、可回滚。
- **非目标**：不做分布式调度、不做秒级精度（分钟级足够）、不做跨机同步、不做「如意没运行也能跑」（除非用户显式开启开机自启）、**不做替用户对外发送消息**（§6 裁决）。

## 3. 数据模型

**任务定义** `<data>/scheduler/tasks-v1.json`（`atomicWriteJson`，103c 登记；上限 200 条）：

```
{ id, title, createdAt, updatedAt, createdBy:'user'|'steward',
  schedule: { kind:'once'|'daily'|'weekly'|'monthly'|'cron', at:'HH:MM',
              date:'YYYY-MM-DD'?, days:[0-6]?, dayOfMonth:1-31?, expr:'* * * * *'?, tz:'系统本地' },
  payload:  { kind:'reminder'|'prompt'|'playbook'|'workflow', ... 见 §5 },
  target:   { mode:'new-session'|'existing-session', sessionId?, cwd, engineRoute? },
  autonomy: { permissionMode, grant?:{ tools:[], pathGlob:[], maxUses, expiresAt } },
  policy:   { onMissed:'run-once-late'|'skip', graceMinutes:720, maxRunsPerDay:24,
              maxCostPerRun?, timeoutMinutes:30, onFailure:'notify'|'retry-once' },
  state:    { enabled, lastFiredAt, lastResult:'ok'|'failed'|'needs_you'|'skipped',
              nextFireAt, inFlightRunId?, consecutiveFailures } }
```

**触发历史** `<data>/scheduler/fires-v1.ndjson`（append-only，带单调 `seq`）：每次触发一条 `{seq, taskId, firedAt, mode:'ontime'|'late'|'manual', sessionId, runId, result, error?, costTokens, durationMs}`。管家收件箱订阅这条日志（与 Mission Change Ledger 同款 seq 游标）。

**纯函数**（可单测、可被管家复用）：`nextFireAt(schedule, fromMs, tz)`、`parseCronExpr(expr)`（自写最小 5 字段解析，零依赖）、`describeSchedule(schedule, locale)`（把结构化计划翻成人话「每个工作日 18:00」，用于 UI 与管家确认话术）。

## 4. 调度器

- **tick**：进程内 `setInterval` 30s（不是每秒；任务精度分钟级），每次只做「取出 `nextFireAt <= now` 且 `enabled` 且无 `inFlightRunId` 的任务」，串行触发（同一时刻多任务排队，全局并发 1，避免几个任务同时开回合把机器打满）。
- **幂等**：触发前写 `inFlightRunId`＋`lastFiredAt`（原子写），执行完清空；进程崩溃后启动时看到 `inFlightRunId` 且对应 run 不存在 → 记一条 `result:'failed', error:'interrupted'`，按 `onFailure` 处理。
- **错过的触发**（关机、休眠、如意没开）：启动时对每个任务用 `nextFireAt` 回算上一个应触发点；若在 `graceMinutes` 内且 `onMissed==='run-once-late'` → 立即补跑一次（只补一次，不追赶多次），落 `mode:'late'`；否则记 `skipped` 并通知。这条纪律照抄 `autoResumeInterruptedRuns` 的「分级恢复而非无脑重放」。
- **时区与夏令时**：只存本地时区语义（`at:'09:00'` 表示本地 9 点），每次触发后重新计算下一次，不预先缓存多次；跨 DST 边界由重算自然吸收。
- **上限**：全局每日触发上限（默认 200）、单任务每日上限 `maxRunsPerDay`、连续失败 3 次自动 `enabled:false` 并通知（熔断）。
- **开关**：`schedulerEnabledV1`（默认 `true`，但**没有任何任务时零开销**：无任务则不起 interval）。

## 5. 载荷四类

| kind | 做什么 | 是否调用模型 | 默认自治 |
|---|---|---|---|
| `reminder` | 到点只生成一条通知／一张卡片（「该给 xxx 发消息了」，可带草稿文本） | 否 | 无需授权，永远安全 |
| `prompt` | 在目标会话发一条消息并跑完一个回合（`runOpenAiTurn`／`runClaudeTurn`） | 是 | 按 `autonomy.permissionMode` |
| `playbook` | 用指定 playbook ＋参数跑一次 | 是 | 同上 |
| `workflow` | 跑一个 DAG 编排（`BUILTIN_AGENT_WORKFLOWS` 或用户模板） | 是 | 同上，且受编排自身预算约束 |

**无人值守的权限**：任务执行时 `nativeToolGate` 照常判定。当判定为 `ask` 时——**不自动放行**，而是登记成待决（`decideIntervention` 的既有四类之一），任务状态置 `needs_you`，管家／通知把它推到用户面前；用户回来一键批准后继续或重跑。只有用户在建任务时显式配置了 `autonomy.grant`（工具白名单＋路径 glob＋次数＋有效期）时，落在白名单内的动作才自动放行；**该 grant 随任务持久化**（现有授权书是内存态，本波新增「任务级持久授权」并在触发时物化成一次性 grant，撤销任务即失效）。`grant` 永不包含 `bypass`／全局放行。

## 6. 裁决：对外发送类任务

用户例子「明天给 xxx 发条消息」在如意里**没有对外发送通道**（无邮件／IM 连接器；ACC 的桌面控制虽能操作 UI，但让 AI 无人值守地替人发消息属于高风险且不可撤销）。裁决：

1. 默认形态 = `reminder` ＋ 草稿：到点生成消息草稿并通知，用户一键复制或一键交给线程执行——**发送动作由人触发**。
2. 若用户配置了具备发送能力的 MCP 连接器，发送是 `exec` 档动作：在「只提议／有界自动」下必须挂起成待决等用户批准；只有「全自动」档且用户为该任务显式授权后才自动发送，并且发送前后各写一条审计与通知。
3. 任何情况下不得在用户不知情时以用户身份对外发送内容——写入 §10 红线，e2e 断言覆盖。

## 7. 开机自启（可选，默认关）

如意不运行则不调度。提供一个开关：「让如意随 Windows 登录自动启动」。实现走**当前用户级**注册（`schtasks /create /sc onlogon` 或启动文件夹快捷方式，二选一，实施前实测选更可撤销的一种），**必须由用户在设置里显式点击开启**，界面写明它会做什么、如何关闭；关闭即删除注册；卸载／`doctor` 提供检查与清理。默认关闭，不在安装时静默注册。

## 8. UI（不让用户离开如意）

- **定时任务面板**（设置内一个 Tab，管家壳内一张卡）：任务列表（标题、人话计划「每个工作日 18:00」、下次触发倒计时、上次结果徽标）、行内动作（暂停／立即运行一次／编辑／删除）、每条可展开看最近 5 次触发与产出会话链接（点击直接在如意内打开该会话，不给路径）。
- **创建**：① 管家对话（主路径）：用户说人话 → 管家用 `describeSchedule` 回读确认「我给你建一条：每个工作日 18:00，在『周报』会话里生成周报草稿，需要动文件时会先问你——对吗？」→ 用户确认才落库；② 表单（无管家时）：计划选择器（一次性／每天／每周／每月／高级 cron）＋载荷选择＋目标会话＋权限档＋错过策略。
- **到点后**：产出会话直接出现在会话列表并可点开；失败或 `needs_you` 走通知与待决抽屉。
- **UX 红线**：不出现「路径 ＋ 复制」这类让用户离开如意自己操作的交互（见 28 号 §2 与 27 号 §8.1）。

## 9. 切片

| 切片 | 内容 | 门 |
|---|---|---|
| **119a 数据模型与纯函数** | 任务 JSON schema ＋ `nextFireAt`／`parseCronExpr`／`describeSchedule`（新模块 `0?x-scheduler-core.js`，按 SPEC §1 命名与分层）；103c 登记两个持久化面 | `unit/scheduler-core.test.js`（跨 DST、月末、闰年、cron 边界、once 过期）；`durable-state-inventory --write` |
| **119b 调度器与触发** | tick、幂等、错过补跑、熔断、上限、`schedulerEnabledV1`；触发四类载荷；`fires-v1.ndjson` | 新 `scheduler.e2e.js`（假时钟推进：到点触发一次、崩溃后不重复、错过补跑一次、超 grace 跳过、连败熔断、并发 1） |
| **119c 权限与任务级授权** | `autonomy.grant` 持久化与触发时物化；`ask` → 待决挂起；`needs_you` 状态；审计 | `scheduler-permissions.e2e.js`（矩阵：四类载荷 × 三档 × 有／无 grant；越权不放行；撤销任务即失效） |
| **119d API 与工具** | `GET/POST/PATCH/DELETE /api/scheduler/tasks`、`POST /api/scheduler/tasks/:id/run-now`（`ROUTE_AUTH` `token`，`01b-route-auth.js` 登记，route-inventory 重算）；管家工具 `steward_schedule_*`（create／list／pause／run_now／delete，走第 49 波入库门；归入 27 号 §3.5「如意设置」族，edit/exec 档） | `route-inventory.static`；`tool-dispatch` 计数重钉；`steward-tools.e2e.js` 扩展 |
| **119e UI** | 定时任务面板、创建表单、人话计划描述、倒计时、产出会话直达；管家卡片 | `scheduler-ui.static.e2e.js`（零 innerHTML、i18n 四文件、无复制路径反模式）；真机走查双主题＋390px |
| **119f 开机自启（可选）** | 显式开关、注册／注销、`doctor` 检查项 | 静态锁＋人工走查；默认关的断言 |

顺序 119a → 119b → 119c → 119d → 119e →（119f 可后置）。

## 10. 红线与威胁模型

- 不得在用户不知情时对外发送内容或执行不可撤销的外部动作（§6）。
- 无人值守遇 `ask` 一律挂起为待决，绝不自动放行；任务级授权必须有工具白名单＋路径 glob＋次数＋有效期四重边界，且不含 `bypass`。
- 任务定义只能由 token 级 API 或管家工具写入；`localCommand`／密钥／数据目录等禁止键不得出现在任务载荷里。
- 补跑只补一次，永不追赶多次；熔断优先于重试。
- 每次触发计入用量台账（`note:'scheduled'`），面板显示单任务累计费用；超过 `maxCostPerRun` 立即停止该次执行。
- 开机自启默认关、用户显式开启、随时可关、卸载清理。
- 关闭调度或无任务时零后台开销、零持久化写入。

## 11. 排期建议
建议排在 **116（管家引擎侧）之后、117（管家壳）之前或并行**：调度器的下单与播报体验依赖管家，但引擎侧可独立开发与验收。若用户希望更早拿到，可先做 119a–119c（无 UI，用表单 API 驱动）作为独立可用能力。
