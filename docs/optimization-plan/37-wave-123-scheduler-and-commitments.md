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

## 4. 退出门

1. 假时钟 e2e 覆盖月末／闰日／时区（DST 两向）／错过时点；崩溃窗口四段各一条不重复不误判；J10（补跑显示真实触发模式）／J11（unknown 不判成功不重发）各一件真浏览器或 API 级 e2e。
2. 口袋计数 ≠ 恒 0、「接下来」两行真数据、安静卡「稍后」真 snooze；`quiet-card.browser`／`rail-pocket.browser`／`focus-rail.browser` 既有锁仍绿。
3. 主会话 8 路全量真回归 0；`build --check`／依赖图 `--check`（新模块边进 policy 附 note）／`--fast`／控制字符零命中；`durable-state-inventory --check` 绿（两个新持久化面登记）。
4. 29 号文 §10 红线逐条有锁：无人值守 ask 不放行（反向放行 → 红）、body-token 不能写任务、禁止键拒、补跑只一次、零任务零开销（无任务时 `setInterval` 计数 0，静态或 e2e 钉）。

## 5. 交付记录

（每刀出门后主会话补。）

## 6. 停点

（每次收工写在这里，并同步记忆 `ops-new-machine-wave121` 的停点行。）
