# 37 · 第 123 波 · 定时任务与承诺（R3 基础：C01／C02／C04＋U03）

> **性质**：35 号文 §2 第 123 行的施工号文；设计权威仍是 **29 号文**（第 119 波方案：数据模型 §3、调度器 §4、载荷 §5、对外发送裁决 §6、红线 §10），本文只定本波**做到哪一步、拆几刀、怎么证伪**。摸底（2026-09-13）：全仓**零调度器代码**，`GET /api/scheduler/tasks` 今天 404；K7 前端（`rail-pocket.js`／`steward-drawer.js`「接下来」／`steward-settings.js` 只读列表）已前向兼容读 `{ok,tasks:[{id,title|name,nextRunAt,enabled}]}`。
>
> **派单纪律**：沿 36 号文头注全部纪律（一机一回归、真浏览器件跨树互斥＝纪律 16、新 e2e 首行 self-isolate、补丁不走 heredoc、控制字符扫描、改 `src/` 跑整条生成器链、新断言先红后绿）。行号以 `0bade1d` 为准会漂。

## 0. 一句话

**给管家一个能守时的身体**：用户一句「明天九点提醒我／每个工作日 18:00 生成周报草稿」→ 管家用人话回读确认 → 落成一条承诺（Commitment）→ 到点由调度器派一次执行（CommitmentRun）→ 结果回到收件箱、安静卡与「回来摘要」；休眠错过按约定补一次或跳过并**如实显示触发模式**；进程崩溃后结果记 **unknown**，不默认成功、不盲目重发；「主动提醒我」与「可以替我动手」分开（原则 6）。

## 1. 范围裁决

| 项 | 本波 | 不做（去向） |
|---|---|---|
| 载荷 | `reminder`（不调模型）＋`prompt`（新线程／既有线程跑一个回合） | `playbook`／`workflow` → 127 波（服务目录「定时两类接 123」） |
| 计划 | `once`／`daily`／`weekly`／`monthly`／`cron`（自写 5 字段） | 秒级、跨机 |
| 目标 | `new-session`（走 `createSession`＋`runSessionTurn`，与管家开线程同一条路）／`existing-session` | 对外发送（29 号文 §6：默认 reminder＋草稿，发送由人触发） |
| 无人值守权限 | 任务自带 `permissionMode`（天花板＝全局档，不含 bypass）；`ask` 不自动放行：等 `askWaitMinutes`（默认 30，配置项）后**拒**并把本次记 `needs_you`、任务置 `needs_you`、收件箱出 needs_you 行，用户回来「立即运行」重跑 | 任务级 `autonomy.grant` 物化（119c）→ 128+ E02（自动升档等预算与权限方案）；任务内**续跑**待决（回合中途挂起）→ 同去向 |
| 恢复 | 错过：启动时回算上一个应触发点，`graceMinutes` 内且 `onMissed:'run-once-late'` → 补一次（`mode:'late'`），否则 `skipped`＋提醒；崩溃：启动看见 `inFlightRunId` 无终态 → `outcome:'unknown'`，不重发 | 追赶多次；`maxCostPerRun` 中途止损（需回合内用量回传）→ 登记 |
| 承诺投影 | `tasks-v1.json` 即 Commitment（含 `revision`）；`fires-v1.ndjson` 即 CommitmentRun（`occurrenceKey`＋`executionGeneration`＋`phase`＋`outcome`）；重试引用同一 occurrence，「再跑一次」是新 occurrence（`manual`）；删除任务不删历史回执 | 与 124 波 `TaskIntentView`／`DeliverableView` 的关联（124 再接） |
| 管家 | `steward_schedule_{create,list,pause,resume,run_now,delete}` 六工具；对话里用 `describeSchedule` 回读确认才落库；无人值守（inbox 触发）只提议不建 | 开机自启（119f）→ 用户显式要时再做 |
| 界面 | 设置「管家」页签的定时任务块从只读改成可建可改；口袋计数与「接下来」吃真数据；安静卡「稍后」＝真 snooze（建一条 30 分钟后的 once reminder，`sourceRef` 指回那条收件箱行）；普通「×」关闭不进调度器 | 独立面板／表单向导 |

## 2. 刀序与独占文件

| 刀 | 执行者／树 | 范围 | 独占文件 | 绝不碰 |
|---|---|---|---|---|
| **M1 后端地基** | Opus，主树（唯一跑全量者） | §3.1 纯函数模块＋§3.2 调度器＋§3.3 API＋§3.4 假时钟与崩溃钩子＋持久化登记 | 新 `src/06j-scheduler-core.js`、新 `src/13s-scheduler.js`、`src/13-http-router.js`（只加路由分派与 boot 起停两处）、`src/01b-route-auth.js`、`src/01-config.js`（只加默认项与 sanitize）、`src/14-main.js`（导出）、`src/module-dependency-policy.json`（新模块边，附 note）、`dev-harness/durable-state-inventory.js`、生成物、新 unit ×1、新 e2e ×3 | 一切 `public/`、13f／13g／12／06i／13i／13m（管家面留给 M2）、`run-all.js`（`PARALLEL_EXCLUSIVE` 末尾追加除外） |
| **M3 顺带清障** | Sonnet，隔离 worktree（与 M1 并行；不跑真浏览器件全量，只单跑自己改的件） | §3.7：`model-menu.js MODEL_MENU_CLASSES` 的 `mc-*` 死字符串；`one-workbench-frame.browser` B0 先等 `data-shell-mode` 稳定；`subagent` (a5) 抖动定案；夹具 `LOCALAPPDATA`／`APPDATA` 隔离 | `public/js/model-menu.js`＋其静态锁、`dev-harness/one-workbench-frame.browser.e2e.js`、`dev-harness/subagent.e2e.js`、`dev-harness/lib/fixture-home.js`、`dev-harness/run-all.js`（夹具环境段）、`unit/fixture-home-per-test.test.js` | 一切 `src/`、其余 `public/`、`facts.json`、`LEGACY_STYLES_SHA256` |
| **M2 管家与界面接线**（M1 进 master 后） | Opus，主树 | §3.5 管家工具＋收件箱／摘要／安静卡＋§3.6 设置面与 K7 真数据＋J10／J11 界面呈现 | `src/13f-native-tool-schemas.js`、`13g-steward.js`、`12-tool-dispatch.js`（六条登记）、`06i-steward-core.js`（kinds＋白名单）、`13m-steward-runner-base.js`（digest 文案）、`13q-steward-runner-turn.js`（`stewardVisitDigest` 加承诺项）、`13i-steward-inbox.js`（reminder 行写口）、`13s-scheduler.js`（只加事件与 reminder 出箱回调）、`public/js/{quiet-card,rail-pocket,steward-drawer,steward-settings,event-stream}.js`、`index.html` 定时任务块、CSS 一处、四份 locale、生成物、新 e2e ×3、`LEGACY_STYLES_SHA256` 重钉 | `06j-scheduler-core.js` 的纯函数签名、M1 的账本格式 |

## 3. 规格

### 3.1 纯函数模块 `06j-scheduler-core.js`（M1）

- `normalizeSchedulerTask(raw, now)`：按 29 号文 §3 形状洗净；缺省 `policy = { onMissed:'run-once-late', graceMinutes:720, maxRunsPerDay:24, timeoutMinutes:30, onFailure:'notify' }`；`autonomy.permissionMode` 值域＝`PERMISSION_MODES` 去掉 `bypass`（越界回落全局默认档）；载荷禁止键（`localCommand`／`env`／`apiKey`／`dataRoot`／`cwd` 指向数据根）→ 整条拒；上限 200 条。
- `nextFireAt(schedule, fromMs)`：本地时区语义（`at:'HH:MM'`），每次触发后重算、不预缓存；`monthly` 的 `dayOfMonth` 超过当月天数 → **钳到月末**（31 → 2 月 28/29）；`once` 过期 → `null`；`cron` 5 字段（分 时 日 月 周，支持 `*`／`,`／`-`／`/`），日与周同时给时按 POSIX 取并集；跨 DST 由重算吸收（本地墙钟 09:00 就是 09:00，不存 UTC 偏移）。
- `parseCronExpr(expr)`、`describeSchedule(schedule, locale)`（「每个工作日 18:00」「每月最后一天 09:00」「9 月 14 日 09:00 一次」；zh/en 两套，键在 locale 里，纯函数只返回键与参数）。
- `occurrenceKey(taskId, dueMs)` ＝ `${taskId}@${dueIso}`；`missedOccurrence(task, nowMs)`：回算上一应触发点与是否在 grace 内。
- **判据**：`unit/scheduler-core.test.js` ≥30 条：月末（1/31→2/28、闰年 2/29、4/31 钳 4/30）、闰日 `once 2028-02-29`、DST 两向（`TZ=America/New_York` 子进程，3 月与 11 月切换日 02:30 不存在／重复各一）、cron 边界（`*/15`、`0 9 * * 1-5`、`0 0 29 2 *` 只在闰年）、once 过期 null、grace 内外、`describeSchedule` 中英各 6 句逐字。反向：把月末钳位注掉 → 至少 2 条红。

### 3.2 调度器 `13s-scheduler.js`（M1）

- 进程内 `setInterval` 30 s（`WCW_SCHEDULER_TICK_MS` 可缩短；**零任务不起 interval**，`schedulerEnabledV1:false` 一字节不写）；每 tick 取 `nextFireAt <= now && enabled && !inFlightRunId`，**全局并发 1** 串行触发。
- 触发四段（崩溃窗口即这四段的边界）：① 原子写 `inFlightRunId`＋`lastFiredAt`＋fires 行 `phase:'registered'`；② 派单（reminder → 直接出箱；prompt → `createSession({origin:'steward'})`＋`launchedBy/createdBy:'steward'`＋`runSessionTurn({ permissionMode: task.autonomy.permissionMode, source:'scheduler', requestMeta:{taskId,runId} })`，与 13k `stewardLaunchTurn` 同一条路以便 13i 第四源自动收 done/failed）→ fires 行 `phase:'dispatched'`；③ 回合中（`phase:'running'`，`timeoutMinutes` 到 → `stopSession`＋`outcome:'failed'`）；④ 收尾：`phase:'reconciled'`，`outcome ∈ succeeded|failed|needs_you|skipped|unknown`，清 `inFlightRunId`，重算 `nextFireAt`，`consecutiveFailures` 连 3 → `enabled:false`＋出箱（熔断）。fires 行带单调 `seq`（同 inbox 口径）、`mode ∈ ontime|late|manual`、`occurrenceKey`、`executionGeneration`（同 occurrence 的第 N 次尝试）、`sessionId`、`durationMs`、`costTokens`（从 usage 台账 `note:'scheduled'` 汇总）。
- **无人值守的 ask**：`runSessionTurn` 的回合内权限请求（07:847 `permission_request`）在 `source:'scheduler'` 时等待 `config.schedulerAskWaitMinutes`（默认 30，钳 [1,240]）而不是 120 s；到时**拒**，回合按既有语义收尾，`outcome:'needs_you'`，任务 `state.lastResult:'needs_you'`；收件箱一行 needs_you（ask 文案「定时任务《标题》要用工具 X，需要你批准后重跑」）。实现只在 07 的超时取值处认 `source`，不改 gate 语义（子集律：只能拒，永不放行）。
- **启动恢复**：读 tasks：有 `inFlightRunId` 且 fires 里该 run 无 `reconciled` → 补一条 `phase:'reconciled', outcome:'unknown', error:'interrupted'`（J11：不重发、不判成功）；对每个 enabled 任务算 `missedOccurrence` → grace 内且 run-once-late → 排队补跑一次 `mode:'late'`（只一次），否则 fires 一行 `outcome:'skipped', mode:'late'`＋出箱提醒。
- **上限**：全局每日 200、单任务 `maxRunsPerDay`；每次触发 `appendUsageLedger({kind:'aux', note:'scheduled', taskId})`。
- **事件**：任务或 fires 变化 → `RUYI_EVENTS.emit('schedule.changed', { taskId, phase, outcome })`（13r 只转发不承载正文；M2 前端据此刷口袋／接下来／设置块，零轮询）。
- **判据**：`scheduler.e2e.js`（假时钟）：once 到点触发一次且只一次；daily 连推两天两次；`*/1` cron 每分钟；并发 1（两任务同时到点串行，第二条 `phase:'registered'` 时第一条已 `reconciled`）；连败 3 熔断；上限；reminder 不起回合（`activeChildren` 零、usage 零）；prompt 起回合（fake 引擎）并 `outcome:'succeeded'`；ask 等待缩短为 `WCW_SCHEDULER_ASK_WAIT_MS` 后 needs_you。`scheduler-crash.e2e.js`：`WCW_SCHEDULER_CRASH_AT ∈ {after-register, after-dispatch, mid-run, before-reconcile}` 让服务在该点 `process.exit(3)`，重启后：不重复触发同一 occurrence（fires 里同 `occurrenceKey` 的 `registered` 只一条）、结果 `unknown`（J11）、`nextFireAt` 已推进；J10：把假时钟拨过一个 due（grace 内）重启 → 一条 `mode:'late'` 补跑；拨过 grace → `skipped`。反向：注掉启动恢复 → crash 件 ≥2 红；把 `late` 写成 `ontime` → J10 红。

### 3.3 API（M1）

`GET /api/scheduler/tasks`（`{ok, tasks:[…], nowMs}`，每条含 `title`／`nextRunAt`（ISO，K7 读它）／`enabled`／`schedule`／`payload`／`state`／`describeKey+params`）、`POST /api/scheduler/tasks`（建，回 `{ok, task}`）、`PATCH /api/scheduler/tasks/:id`（改，`revision+1`）、`DELETE`（删定义不删 fires）、`POST /api/scheduler/tasks/:id/run-now`（`mode:'manual'` 新 occurrence）、`GET /api/scheduler/tasks/:id/runs?limit=5`。`ROUTE_AUTH` 一律 `token`（body-token 永不能写任务，29 号文 §10）。`scheduler-api.e2e.js`：六路由正反各一（403 无 token；越权 `bypass` 回落；禁止键整条拒；200 条上限；删后 runs 仍可读）。`route-inventory.static` 绿。

### 3.4 假时钟与崩溃钩子（M1）

`WCW_SCHEDULER_CLOCK_FILE`（存在时每 tick 读其中 epoch ms 当 now，`nextFireAt` 同源）、`WCW_SCHEDULER_TICK_MS`、`WCW_SCHEDULER_ASK_WAIT_MS`、`WCW_SCHEDULER_CRASH_AT`。四个钩子只在 `01c-runtime-flags` 那套「测试旗」口径下认（生产零影响；静态锁钉「不带旗时读不到」）。

### 3.5 管家工具与收件箱（M2）

- 六工具进 13f（schema，`create` 的入参就是 29 号文 §3 的子集：`title, schedule, payload:{kind:'reminder'|'prompt', text}, target?, permissionMode?`；描述里写清「先用 describeSchedule 的人话回读、用户说对才调」）、13g handler、12 dispatch（`STEWARD_GUARD_NOTE`）、06i 白名单归「如意设置」族 edit 档；`stewardUnattendedByModel(ctx)` 为真时 `create/delete` 只回 `propose_required`。
- 收件箱新类 **`reminder`**（06i `STEWARD_EVENT_KINDS` 加一、13m `STEWARD_DIGEST_KIND_TEXT` 加一句、`quiet-card.js QUIET_CARD_KINDS` 加一、四份 locale）：reminder 到点、错过跳过、熔断三种事都走它（「一句事实，不需要回答」）；done/failed/needs_you 沿既有类（13i 第四源按 `launchedBy:'steward'` 自动收）。
- `stewardVisitDigest` 加「未来承诺／过期／失约」三项：24 h 内将触发 N 条、上次到访以来 `skipped`／`unknown` M 条、`needs_you` K 条（读 tasks＋fires since inboxSeq；文案键三条）。
- 安静卡「稍后」：`POST /api/scheduler/tasks` 建 `once` reminder（`now+config.quietCardSnoozeMinutes`，默认 30）带 `sourceRef:{inboxSeq, sessionId, kind}`，成功才收卡（失败 toast、卡不动）；reminder 到点出箱 → 卡再来一次并带「来自你 30 分钟前的稍后」。「×」照旧只收卡。
- 判据：`scheduler-steward.e2e.js`（直调 13g handler，与 `steward-tools.e2e` 同骨架）：create 回 describe 键与参数、unattended 只提议、list/pause/resume/run_now/delete 六路；`quiet-card-snooze.browser.e2e.js`：点「稍后」→ tasks 多一条 once reminder → 假时钟拨过 → 卡再现且文案带「稍后」；反向注掉 POST → 卡收了但 tasks 零条 → 红。

### 3.6 设置面与 K7 真数据（M2）

- `steward-settings.js` 定时任务块：列表（标题、`describeSchedule` 人话、下次倒计时、上次结果徽标含 **触发模式**「准时／补跑／手动」与 **unknown**「结果未知，先核对」）、行内 暂停／立即运行／删除、展开最近 5 次 runs（点 sessionId 在如意内打开线程）；「新建」表单（计划选择器四档＋cron 高级、载荷 reminder/prompt、目标新线程／既有线程、权限档下拉）。零 innerHTML、i18n 四文件、无「路径＋复制」反模式（`scheduler-ui.static.e2e.js`）。
- 口袋计数与「接下来」：订阅 `schedule.changed` 帧刷新（`rail-pocket.js`／`steward-drawer.js` 各一处 `stream.on`），零计时器锁不动。
- `scheduler.browser.e2e.js`：建两条 → 口袋角标 2、焦点栏「接下来」两行按时间升序、设置块两行；假时钟拨过第一条 → `schedule.changed` 到达后口袋 1、runs 展开一行「准时」；崩溃钩子造一条 unknown → 徽标「结果未知」而非「成功」（J11 界面侧）；补跑一条 → 「补跑」（J10 界面侧）。反向：把徽标文案换成成功 → 红。

### 3.7 顺带清障（M3）

- `model-menu.js MODEL_MENU_CLASSES` 里 `mc-*` 死字符串：先证明零消费（`grep -rn "mc-" public/css public/js` 只剩这张表）再删，静态锁钉「表里的类名每个都在 CSS 里有规则」。
- `one-workbench-frame.browser` B0 偶红：`before = await snap()` 前等 `data-shell-mode` 连续 10 次采样不变（同 L1a A0g2 写法）；单跑 5 次绿。
- `subagent.e2e` (a5)「same desktop resource serializes」抖动：单跑 5 次记红次数，读 06g 资源租约的等待事件时序，定案是夹具窗口还是产品竞态；夹具则修，产品则**只报告**。
- 夹具 `LOCALAPPDATA`／`APPDATA`：`fixtureChildEnv` 一并指到临时家下的 `AppData/Local`／`AppData/Roaming`；先核无头 Edge 的 `--user-data-dir` 是显式传的（是则不受影响），`index-dedup` 去掉 §5.1 那条临时 `WCW_DATA_DIR` 后仍绿即证毕；单测加两条。

### 3.8 插队刀 N1 · 管家话术分档＋开线程前澄清＋对话流重复渲染（用户 2026-09-13 真机走查；Opus 隔离 worktree，与 M1／M3 并行）

- **触发**：用户贴的对话流里「你好→四段汇报」「开线程的 350 字」各出现两遍；「话密」；「要不要先对话几轮再开线程」。
- **定案**：① 两遍＝真显示 bug：`appendSince` 的水位 `lastRenderedAt` 只在进壳画历史时推高，用户自己发的回合直接上屏不推水位，收件箱唤醒的增量从到访起点重拉 → 重画。修：回执带落盘 `createdAt`，前端收到即推水位，`renderHistorySince` 同 createdAt 只画一次。② 话密＝提示词没有按场景分档（stable 只有 ≤600 字总预算）：rules 层加「问候／答问 ≤2 段 ≤120 字；开线程 1–2 句不复述委托书；转述交付 ≤200 字四件套；追问 1 句＋2–3 选项」。布局只松段间距。③ 澄清＝只问一次：范围／时间窗／交付形式／花费档任一维度会改变结果且无先例才问，有先例（刚做过同类）／问题具体／用户说直接办 → 直接开。「下周美股」有 A 股先例，直接开是对的。
- **独占文件**：`06b`（rules）、`13q`（回执 createdAt）、`steward-conversation.js`／`.css`、`steward-conversation.e2e`、`steward-runner.static`、prompt 快照锁；生成物只提交 server.js／manifest，facts／route-inventory／README 数字与 `LEGACY_STYLES_SHA256` 由主会话合并时统一重生成。与 35 号文 125 波 T03（歧义追问的真实模型样本、成对盲评）的关系：本刀先落**规则**，T03 到时候只测样本不再改规则。

### 3.9 插队刀 N2 · 新线程默认引擎＝上次用的（用户 2026-09-13：「新开线程默认 Kimi code cli，希望改成上一次用的或别的方式，不要设定死」；Opus 隔离 worktree）

- **病根**：`createSession`（02:≈2813）缺省 `sessionEngineRouteFromConfig(config)`＝全局 `activeProvider`／`agentCliType`／`model`；管家开线程没配 `stewardThreadModels` 档时也跟它。用户机器全局是 kimi → 条条新线程 kimi。
- **修法**：配置项 `newThreadEngine:'last'|'global'`（默认 last）＋`lastUsedEngineRoute`；记录只认**用户自己的选择**（线程头 PATCH `engineRoute`）与**用户自己发起的回合**（`runSessionTurn source==='http'` 解析后的实际路由），管家／调度器派的不记；读时「显式入参 > 导入推断 > 上次用的（端点仍在／CLI 仍 detected）> 全局」，回落记审计 `new_thread_engine_fallback`。设置面加「新线程默认引擎」下拉与「上次用的是…」一行。
- **判据**：`new-thread-engine-default.e2e`（API 级七条：未记录跟全局／PATCH 后跟它／http 回合后跟它／steward 回合不记／global 档跟全局／端点删了回落＋审计／显式入参优先）；反向注掉 createSession 那一支与「不记 steward」各红。
- **独占文件**：01（默认＋sanitize）、02、10（只记录几行）、`index.html` 引擎块、`provider-settings.js`、四份 locale、新 e2e、静态锁；生成物只提交 server.js／manifest。

## 4. 退出门

1. 假时钟 e2e 覆盖月末／闰日／时区（DST 两向）／错过时点；崩溃窗口四段各一条不重复不误判；J10（补跑显示真实触发模式）／J11（unknown 不判成功不重发）各一件真浏览器或 API 级 e2e。
2. 口袋计数 ≠ 恒 0、「接下来」两行真数据、安静卡「稍后」真 snooze；`quiet-card.browser`／`rail-pocket.browser`／`focus-rail.browser` 既有锁仍绿。
3. 主会话 8 路全量真回归 0；`build --check`／依赖图 `--check`（新模块边进 policy 附 note）／`--fast`／控制字符零命中；`durable-state-inventory --check` 绿（两个新持久化面登记）。
4. 29 号文 §10 红线逐条有锁：无人值守 ask 不放行（反向放行 → 红）、body-token 不能写任务、禁止键拒、补跑只一次、零任务零开销（无任务时 `setInterval` 计数 0，静态或 e2e 钉）。

## 5. 交付记录

### 5.1 M3 · 顺带清障（Sonnet 隔离 worktree，`8007352`／`fa25959`／`158ee3c`；主会话复核 2026-09-13 晚，待 cherry-pick）

- **mc-\* 死串**：`grep -rn "mc-"` 证 18 项里只有 `del`（`mc-del`，chat-shell.css 267/269 还在画自定义模型行尾 ×）有 CSS；表压成 `{ rowActive:'active', del:'mc-del' }`，`buildModelMenuRow` 内部兜底空串，唯一调用方 steward-chips 逐字不变。新锁 `model-menu-classes.static` 动态 import 真模块逐类核 CSS 规则，自带反向（毒一份表 → 恰好抓到那一个）。`steward-model-menu.test` 47/47。
- **`one-workbench-frame.browser` B0**：等 `data-shell-mode` 10×50 ms 稳定再拍快照；**连带抓到 C1b 假红**——那点等待足够 `steward-board.js enterSteward()` 的 fire-and-forget（`loadMissions`＋`loadArbiter` 回来才 `syncNow`）把右栏填上；把 C1/C1b 的「空右栏」快照挪到等待之前（两个窗口互不相干）。5/5 绿；两向反证（原顺序 3/3 绿、只加等待 2/2 红，差的 392 px 正是右栏宽）。
- **`subagent` (a5)**：单跑 11 次 0 红，06g 租约纯事件驱动无墙钟窗口 → **不修**；同件 **(a4)「stop 请求被接受／stop 落盘 stopped」4/11 红**——级联重试与紧随的 stop 之间的编排层竞态，登记后续。
- **夹具 `LOCALAPPDATA`／`APPDATA`**：`fakeAppDataDirs(home)` 建 `<home>/AppData/{Local,Roaming}`，`fixtureChildEnv` 两支＋`self-isolate-home` 都换；14 件浏览器件的 `--user-data-dir` 全显式传，不受影响；`index-dedup` 去掉 36 号文 §5.1 那条临时 `WCW_DATA_DIR` 后 E3 仍绿（反向只退夹具改动 → E3 复现红）；单测 +2（376/376）。
- `--fast` 68/69：唯一红 `facts.static` e2eCount 340→341（新锁），主会话合数。

### 5.2 N1 · 管家话术分档＋澄清＋对话流重复（Opus 隔离 worktree，`e80fc09`／`bc8d6a3`；主会话复核 2026-09-13 晚，待 cherry-pick）

- **① 重复渲染（真 bug，反向复现了用户贴的那个病）**：`13q` 回执加 `createdAt`＝落盘那条助手消息的 createdAt（读不到时**不下发这个键**，静态锁钉）；前端 `finishReply` 推水位并给行盖 `data-created-at`，`renderHistorySince` 同身份跳过；缺键退到 `alignWatermark()`（`?since=` 只推水位不画）。新组 AB1–AB4：live 一回合后 `appendSince()` 实得 rendered 0、同文本用户气泡恰 1；按到访起点硬拉只补没盖身份的那条；再拉 0。反向去掉推水位 → `rendered 2／2 枚`（＝用户贴的现象）；去掉身份闸 → r2=3。
- **②③ 话术分档＋只问一次**：中英 rules 各两条（原文在 06b 与 N1 报告）；stable 一字未动。**证伪派单前提**：英文 rules 已 1974/2200（117z-E2 加的 226 字没回改注释），两条电报体仍需 470 → `RULES_BUDGET` 2200→2480，`< 2500` 结构不变量仍钉；注释写明英文包已满，下一条要先压缩英文行（普遍是中文 2.5–4 倍）或退役一条。派单稿里更细的口径（≤120 字、每条 ≤30 字、四件套拆行、追问一轮后一律直接开）落在 06b 注释，未进提示词。
- **④ CSS 不改**：`chat-narrative.css:40` 的 `.md p { margin:.72em 0 }` 已给段间 ≈10 px，补 `p + p` 8 px 反而变密；非 markdown 路径是单个 `<p>` pre-wrap，规则永不命中。**话密的真因是话术**。
- 生成物只提交 server.js／manifest，depgraph／contracts（+`stewardLastAssistantCreatedAt`）／route-inventory／facts 留主会话重生成；`--fast` 67/68 唯一红是产物新鲜度锁。
- **登记小债**：`13q stewardLastAssistantCreatedAt()` 与 13p `stewardLastAssistantContent()` 各读一次管家会话 → 每回合多一次 `loadSession`，合成一次读要动 13p。

### 5.3 N2 · 新线程默认引擎＝上次用的（Opus 隔离 worktree，`6c8968d`／`29ea483`；主会话复核 2026-09-13 夜，待 cherry-pick）

- **后端**：01 默认 `newThreadEngine:'last'`＋`lastUsedEngineRoute:null`（01 只做形状洗净，02 读侧再过真归一器——01 够不着 02，两处注释互指、02 为权威）；02 `rememberLastUsedEngineRoute`（与现值不同才 `mutateConfig`）挂在 `applySessionMetaPatch` 写 `engineRoute` 处与 10 `runSessionTurn` 的 `source==='http'`（两处 4xx 门之后，fire-and-forget）；`newSessionEngineRoute`：显式 > 导入推断 > 上次用的（openai 端点仍在 providers；agent 用 `selectedAgentCli(...).path`）> 全局，回落记 `new_thread_engine_fallback{reason:provider_missing|agent_cli_missing}`；`createSession` 多收 `engineRoute` 入参。依赖图零新边（只加宽 02→01、10→02 两条既有后向边）。
- **设置面**：`#cfgNewThreadEngine`「上次用的／跟随全局设置」＋「上次用的是 …」一行；5 键 × 4 份 locale 逐字节同步。
- **判据**：`new-thread-engine-default.e2e` 七条全绿（③ 显式带路由建的会话本身不记、只有回合才记；④ steward 回合 3 s 窗口后仍不记；⑥ 恰一条回落审计）；反向注掉「上次用的」那一支 → ②③ 红，把 `source==='http'` 门放开 → ①④ 红（管家自己的回合把记录弄脏，正是那道门挡的）。静态锁 18 条。`workbench-thread-head.browser`／`steward-settings`／`dom-contract`／9 件 `session-*` 全绿。
- **越界但必要**：`unit/steward-config-tier.test` 两个新键分级 **forbidden**（模型不得改下一条线程用什么引擎；`lastUsedEngineRoute` 是用户行为记录不是设置）；`fixture-home.static` 133→134。
- **登记缺口**：agent 路由的「CLI 仍 detected」那支没有 e2e（本机 Claude Code 在，断言会随环境抖）。生成物只提交 server.js／manifest。

### 5.4 M1 · 调度器后端地基（Opus 主树，`be45ab9`／`2b9812c`／`e1b0ddd`／`8541685`／`12ed1f8`／`c1b8ecd`；主会话复核 2026-09-13 夜）

- **§3.1**：`06j` 605 行纯函数（值域表全部冻结导出），unit 102 条：月末四例（长月不钳）、闰日合法／非法、DST 两向用 `TZ=America/New_York` 子进程且先验偏移证 TZ 生效（春季 02:30→03:30 EDT 且次日回 02:30；秋季重复只落第一个；墙钟不动跨 DST）、cron 并集、once 过期。反向注掉月末钳位 → 5 红（`实得 Wed Mar 03 2027`）。
- **§3.2**：`13s` 772 行：零开销（关着不建目录、零任务不起 timer）、四段触发、并发 1、熔断（`tripped`＋`enabled:false`）、上限（`skipped/task_daily_cap` 零 registered）、reminder 零回合零 usage、prompt 回合 `origin:'schedule'`／`launchedBy:'steward'`；启动恢复：unknown/interrupted（J11「不判成功」）＋ lateQueue 补一次 `mode:'late'`（J10）／`skipped/grace_expired`。崩溃四段 61 条 5 次连跑全绿（`registered 恒 1 条`）。反向注掉恢复 → 25 红；lateQueue 写成 ontime → J10a 单红。
- **无人值守 ask**：07 只加一张 `schedulerAskWaitSessions` 表（只由 13s 写）换等待窗，闸门语义不动；J2–J4 `needs_you/permission_denied`、被拒那次文件一个字节没写；`autonomy-pause.e2e` 源抽取补注入 + 四条「窗口变、判定不变」锁（`实测 1800000, 不是 120000`）。
- **§3.3**：六路由 token；带 body-token 也 403 且零副作用；bypass 回落；五禁止键各 400；PATCH `revision+1` 且只改标题时 `nextRunAt` 不动；run-now 是 manual 新 occurrence；**删定义后 runs 仍可读**；第 201 条 409；关着 409 且不建目录。52 条。
- **出入（四处，均采纳）**：① `origin:'schedule'`（02:2819 早为本波预留的第三值，用 steward 会让 UI 把定时线程说成管家开的）；② 不写 `aux/scheduled` 用量行（回合已记 `kind:'turn'`，再记等于同一笔钱两遍；零 token 行会被丢）→ `costTokens` 现场累计进 fires 行，台账打标登记后续；③ 不复用 13k `stewardRecordLaunchOutcome`（会把 13k/13j/13i 拽进 SCC，环边 29→7），就地 `updateSessionMeta` 同口径；④ `target` 不收 `cwd`（禁止键，显式 400）／`engineRoute`（127 波）。
- **施工中抓到的 4 个真 bug**：`/runs?limit` 缺省 `Number(null)===0` 被钳成 1；run-now 同毫秒撞 `occurrenceKey`；**真回归** `startScheduler` 放 listen 后关键路径让 `walkthrough-round2` B1 从基线 2/18 涨到 3/10 → 挪进 boot 探针段（`c1b8ecd`）；**真语义 bug** boot 前 500 ms 建的任务被恢复逻辑认成「错过」补跑 → `loadedFromDisk` 集合把恢复范围钉死在装载那一刻盘上就有的。
- **硬教训（补丁传输层把 `\uXXXX` 当转义解释）**：06j 第一版的控制字符类真被写成裸 NUL＋0x1F，`cat` 看不出来，commit message 同样中招（git 拒 NUL）。修法源码用 `charCodeAt` 逐码位判，全文件零转义序列。→ 32 号文纪律 7 再加一个样本。
- **全量（M1 收工时 `c1b8ecd`）**：336 ran，331/5/5 flaky；5 红＝realhist ×3（环境）＋`budget-guard`／`context-compact-v2`（串行 2/2、4/4 绿，并行抖动）；真回归 0。`walkthrough-round2` B1 既有抖动定案：判据 `waitForEval(mode ? {mode} : null)` 只等非空，预绘期写下的正是 classic；一行修法换成 `mode && !dataset.vt`（本刀不改，留 L1b 件的治抖动）。
- **给 M2 的接口清单**在 M1 报告原文（`06j` 导出签名、`SchedulerHooks.onReminderDue/onSchedulerNotice`、六路由形状、`schedule.changed {taskId,phase,outcome,at}`、`describeSchedule` 九键中英文案、fires 行字段）；两个新配置键当前 `forbidden`（M2 若放开须在 06i `STEWARD_CONFIG_TIERS` 登记）；调度器在 listen 后 500 ms 才起，六条 API 在 listen 即活，首屏空表不是「零任务」。

### 5.5 主会话合并（2026-09-13 夜）

- 顺序：M1（已在 master）→ N1 两笔（manifest 撞，以 HEAD 为准）→ N2 两笔（`fixture-home.static` 常量 136+1=137、`steward-config-tier` 两刀四键并存，manifest 同上）→ M3 三笔（无冲突）。
- 重生成：build 52551 行、依赖图 52 模块／408 边／1 SCC、契约快照、路由 135 判定点／123 鉴权行、facts 346 e2e／44 unit、README 三处门面；`build --check`／depgraph `--check` 绿；8 文件控制字符零命中；`--fast` **70/70**（`f66c690`）。
- **第一轮 8 路全量 302/37/7——级联，病根是 M3 的假 AppData**：签名「workbench listening」超时／ECONNRESET／`/api/status` 5 连发不全 200；串行 `perf-config-cache`／`onboard` 也红。手动起服务对照：`LOCALAPPDATA` 指每件新目录时首个 `/api/status` **6 s**，指真机时 **2.5 s**——桌面 MCP python 探针的磁盘缓存键（`desktopPythonDiskCacheId`）含 `%LOCALAPPDATA%` 派生的候选路径，每件一个新目录＝每件一个新键＝每件冷探针，凡给 `/api/status` 留 5 s 预算的件全部超时。修法 `c4fc46d`：假 AppData 改成**整机一份跨件共用**（`os.tmpdir()/ruyi-e2e-appdata`），隔离目标（不指回真机）不变，缓存键从第二个进程起命中；三件串行绿、`index-dedup` E3 仍绿、单测改钉「固定名＋不挂临时家下＋两次相同」。顺带记一条产品债：即便缓存命中，首个 `/api/status` 仍付 ≈2.5 s 同步探针——`detectDesktopMcp` async 化（36 号文 §5.3 已登记）的分量比想的重。
- **第二轮 333/6/4**：3 realhist（环境）＋`route-inventory.static`（「谁在测它」扫到新单测里写的 `/api/status` 字样，重生成 `86cdd4f`）＋`context-compact-v2`（串行绿，抖动）＋**`agent-team-mode` 串行必红**：它 `POST /api/config {activeProvider:''}` 切回 Claude 驱动后新开会话，而 N2 的「上次用的」里还记着上一轮的 fake 端点 → 新会话仍走 fake，假 claude 的 argv 文件从没被写出来。**这是 N2 的真缺口**：改全局引擎也是一次显式选择。修法 `4b42bd0`：`POST /api/config` 带 `activeProvider`／`agentCliType`／`model` 时 **await** 记一次（fire-and-forget 不够——改完全局马上开线程是常见序列）；N2 的 e2e 加 ⑧ 五条（改全局 → 记录跟着变 → 新线程跟它；改回来同理）。
- **第三轮 335/4/6**：4 红＝3 realhist（环境）＋`rail-pocket.browser` D1。D1 复现并定案（`5cf87d7`）：`data-shell-mode` 写下 ≠ 右栏 `#stewardSide` 已显示，`enterSteward()` 的 `loadMissions+loadArbiter` 两趟回来才 `syncNow()`；实测只差 `sideShown` 一项（直跑 3 红 1、run-all 3 红 2），加有界等待后 4/4 绿——与 122-M3 在 `one-workbench-frame` C1b 抓到的同一个模具。6 件 flaky（websearch／agent-deadlock-watchdog／dom-screenshot／steward-board／steward-settings／session-search）重跑即绿，主会话另单跑四件各 1/1 绿。**真回归 0。**
- **收官全量 335/4/5（`5cf87d7`）：真回归 0。** 4 红＝3 realhist（环境）＋`steward-board` **TIMEOUT**。串行两跑 22.9／23.1 s（默认 120 s 之内），三轮里两轮首跑失败、收官轮撞墙——8 路下每个 worker 的服务都要各付一次桌面 MCP 探针（首个 `/api/status` ≈2.5 s），八份叠起来把这类「服务多、断言多」的件挤过线。`24efb55` 给它 300 s 豁免并写明：`detectDesktopMcp` async 化之后回来复测撤销。5 件 flaky 全部重跑即绿。
- **本波合并阶段主会话自己修的四处**：`c4fc46d` 假 AppData 整机一份、`86cdd4f` route-inventory 重生成、`4b42bd0` 改全局引擎也记「上次用的」（await）、`5cf87d7` rail-pocket D1 等右栏、`24efb55` steward-board 超时豁免。**产品债提前**：`detectDesktopMcp` 同步探针的分量比 36 号文 §5.3 登记时估计的重——它同时是「首个 `/api/status` 2.5 s」与「8 路下的整体压舱石」，建议在 M2 之后单独一刀还掉。

### 5.6 M2 · 管家与界面接线（Opus 主树，`2ab76cd`／`e10fb91`／`cf2246e`／`2a86488`／`a1add96`＋合数三笔 `97c5a13`／`63e35c6`／`1193706`；主会话复核 2026-09-13 夜）

- **六工具落在新模块 `13t-steward-schedule.js`（出入①，采纳）**：放 13g 会新增前向边（13g 在 manifest 排在 13s 之前）并把一批引用变成新环边；放 13s 又要它反向引用 13j/13k/13i。13t 零入边，消费者只看两个 Hooks 命名空间——**forwardEdges 仍 68、`allowedCycleEdges` 一条没加、SCC 仍 1**；门控壳仍用 13g 的 `stewardToolHandler`（13h 早有先例）。71 条判据：关着六路全 `scheduler.disabled` 且不建目录；普通会话全 `steward.forbidden`；无人值守 create/delete 只 `propose_required` 且零写入，同 ctx 下 list/pause/resume 仍可做；pause 不动 `nextRunAt`；run-now 是 manual 新 occurrence；删定义不删回执（fires 15→15）；熔断出箱一句人话。
- **收件箱第七类 `reminder`＋两个回调**：`onReminderDue`／`onSchedulerNotice`（skipped／tripped／needs_you／unknown 四句），都带 `quiet:true` 走安静卡；13s 一个字未改（M1 已把调用点写好）。**故意不敲 `onInboxBatch`**——到点提醒不烧管家回合，只走安静卡＋下次到访摘要。
- **回来摘要承诺三项**：`upcoming`（24 h 内）／`missed`（上次到访以来 skipped＋unknown）／`needsYou`，走第二条 fires 水位；三行用 locale 键，代价是对话流加一行「有 key 用 key，否则照旧读 text」——既有七类仍是服务端中文，登记 i18n 债。
- **安静卡「稍后」＝真 snooze**：`POST /api/scheduler/tasks` 建 once reminder，带 `sourceRef{inboxSeq,sessionId,kind}`，**成功才收卡**，失败 toast 且卡不动；到点卡再现，文案实测「来自你 30 分钟前按的「稍后」：…」；「×」照旧不进调度器。**主会话反向抽查**（与 M2 六条不同的一处）：从 `QUIET_CARD_KINDS` 去掉 `reminder` → C1–C4 四红（`实得 undefined`），还原 ALL PASS。
- **设置面与 K7 真数据**：定时任务块改成可建可改（列表＋人话计划＋倒计时＋结果徽标＋行内暂停/立即运行/删除＋展开最近 5 次）；口袋与「接下来」订阅 `schedule.changed`，零计时器锁不动。**J11 界面侧**徽标 `data-outcome="unknown"`、原文「结果未知，先核对 · 补跑」且逐字不含「成功」；**J10 界面侧**徽标 `data-mode="late"`、原文「成功 · 补跑」且不含「准时」。静态锁 34 条（去注释后零 innerHTML、57 键四文件、与 06j 四张值域表逐字对账、零复制路径反模式）。
- **tier 登记落在 07 而不是 06i（出入②，采纳）**：`NATIVE_TOOL_TIER`／`NATIVE_TOOL_PACKS` 正身在 07，静态锁也按 07 对账；06i 只补契约注释。
- **合数**：facts `nativeTools 90→96`／`e2eCount 346→350`（默认 343）／`unitSuites 44`，README 五处（含英文段早已过时的 325/318/41）；`RUYI_HOME_SPAWN_SITES` 137→139；`LEGACY_STYLES_SHA256` `e586a9b3…→065948bd…`（只改 `steward-settings.css`，按纪律 4 从干净 HEAD 的 blob 逐层重算）；依赖图 52→53 模块、408→418 边。71 个新 i18n 键 × 4 文件。
- **全量两轮**：第一轮 337/6/5，三红是「27／90」工具数常量（`--fast` 够不着的运行时件），重钉后串行各绿；**第二轮（最终 HEAD `1193706`）338 pass／5 fail／6 flaky／343 ran，真回归 0**——5 红＝realhist ×3（环境，串行两跑同一句 ENOENT）＋`playbooks`（8 路下服务没起来的级联，串行绿）＋`subagent` (a4)（37 号文 §5.1 已登记的编排层竞态，非本波引入）。
- **主会话收尾核**：`--fast` 71/71；`build --check`／依赖图 `--check`（53/418）／`durable-state-inventory --check`（52 面）绿；53 个改动文件控制字符零命中；`steward-conversation`／`quiet-card.browser`／`rail-pocket.browser`／`ia` 串行各 1/1 绿。
- **M2 留下的登记项（九条，见其报告）**：摘要既有七类的 i18n 债；create 只回 `describeKey/params`；调度器开着而 `stewardEnabledV1` 关着时 reminder 无可见落点；`quietCardSnoozeMinutes` 无设置入口且与另两键同为 forbidden；设置块不订阅 `schedule.changed`；新建表单不暴露 `policy` 四项；「立即运行」无二次确认（prompt 任务会真花钱，建议后续补）；`subagent` (a4)／`playbooks` 的 8 路抖动；**`detectDesktopMcp` async 化仍未还**。

## 6. 停点

**2026-09-13 深夜 · 123 波后端与管家/界面接线全部出门，收工推送（用户「M2 回来就先收尾到此为止，commit push」）。**

- **进 master 的五刀**：M1 调度器地基（`06j` 纯函数＋`13s` 四段触发＋六路由＋四个测试旗）、N1（对话流重复渲染／话术分档／开线程前只问一次）、N2（新线程默认引擎＝上次用的）、M3（清障四件）、M2（六工具＋收件箱 reminder＋摘要承诺三项＋真 snooze＋设置面与 K7 真数据）。
- **主会话在合并阶段自修六处**：假 AppData 整机一份（`c4fc46d`，第一轮 37 级联红的病根）、route-inventory 重生成（`86cdd4f`）、改全局引擎也记「上次用的」且 await（`4b42bd0`，`agent-team-mode` 串行红的真因）、`rail-pocket` D1 等右栏露出（`5cf87d7`）、`steward-board` 超时豁免（`24efb55`）、以及本次的交付记录与停点。
- **最终账**：全量 338/5/6，**真回归 0**；5 红＝realhist ×3 环境（用户另机测）＋`playbooks` 级联＋`subagent` (a4) 既有抖动。
- **本波未做、下次从这里进**：① **`detectDesktopMcp` async 化**——它既是「首个 `/api/status` 2.5 s」也是 8 路全量的压舱石，还完要回来撤 `steward-board` 那条 300 s 豁免；② 37 号文 §1 里排给 127 波的 `playbook`／`workflow` 两类载荷与开机自启（119f）；③ M2 九条登记里够得着的几条（「立即运行」二次确认、`quietCardSnoozeMinutes` 设置入口、设置块订阅 `schedule.changed`）；④ 然后是 **124 波 交办与交付贯通**（35 号文 §2）。

（每次收工写在这里，并同步记忆 `ops-new-machine-wave121` 的停点行。）
