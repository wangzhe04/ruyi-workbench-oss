# Pretender Schema 冻结文书 v1(2026-07-30,第74波交付,对齐 PLAN v4)

状态:**冻结 v1**。本文件是 Pretender 3.0 全部读/写模型的**字段级权威定义**,与 `docs/PRETENDER-PLAN.md` **v4** 配套:
- 文书内每个字段标注**类型 / 权威来源 / 可变性 / 写入方**;P1 出门后,任何 UI 不得引入文书外字段(PLAN §4 P1 出门闸)。
- 修改程序:新增字段 = 小版本(v1.x),只增不改;改字段语义/枚举值/错误码 = 大版本(v2),必须成文修订理由并经拍板——与 PLAN §6 拍板项同级。
- 字段形状均亲验自代码现状(引用 file:line);标注 **〔v4 新增〕** 的条目是第74波成文、第75a/75b/75c 波落码的设计冻结,现状代码尚无,红绿双证随对应波次交付。
- 决策契约语义以 PLAN v4 第四轮拍板为准:**S1**(权威键 `(missionId,interventionId)`+`interventionVersion` CAS,覆盖 T1 的 idempotencyKey 地基提案)、**S2**(单一 command core)、**S3**(`mission.changeSeq` 取代复合 lastSeenCursor)。

依据:`docs/PRETENDER-PLAN.md` v4 §4 第74波;`docs/PRETENDER-GATE-REVIEW.md`;`docs/UI-VNEXT-CONCEPT.md` §8–§11。

---

## 1. 标识与主键

| 标识 | 形状 | 权威来源 | 说明 |
|---|---|---|---|
| `sessionId` | `sess_[A-Za-z0-9_-]+` | 会话创建 | 存储主键:头文件 `<sessionId>.json`、正文/Intervention/run 文件均按 sessionId 分片(02-session-store.js:37)。URL 一律经 `safeSessionId`  basename 挡穿越(13d:143)。 |
| `missionId` | 同 sessionId 字符集 | **D1 拍板(方案 B)**:新会话 `missionId = sessionId` 派生写入头文件;存量会话 `normalizeSession` 只读派生,**绝不回写磁盘**(70 波 kind 同款纪律) | 对外 API 从第一天以 missionId 命名。3.0 只保证**存量 Mission 身份无需重映射**(S5 收紧:不得宣称 3.1 结构零升级——届时仍需 Mission→sessions 解析、共享边界与存储升级)。3.0 内 missionId ≡ sessionId,代码内部沿用 sessionId 分片不动。 |
| `runId` | 08 注册表 id | Agent Run 注册 | 一个 mission 关联多 run(1:N 已存在)。 |
| `turnSeq` | 非负整数,会话级单调不回绕 | `session.turnSeq`(02:412) | 检查点/回溯/摘要主键。〔v4 S3〕降为**溯源证据**,不再是用户已读位置的权威游标(权威 = §8 lastSeenRevision)。 |
| `eventSeq` | 非负整数,run 内严格单调 | run 对象(内存权威) | 增量消费位置令牌(afterSeq 补播)。取内存权威口径,不取节流 1.5s 的磁盘快照(13d:416 注释自认磁盘快照恒旧)。〔v4 S3〕同源 cursor 只作溯源证据。 |
| `mission.changeSeq` | 非负整数,**Mission 级持久单调** | mission 账本(75a 落码) | **〔v4 新增,S3 拍板〕**统一变化时间线:turn/run/Intervention/预算/result/rewind/删除等影响任务事实的变化均推进同一序列;回来摘要、**ETag/分页 projectionRevision**、索引失效全部以此为权威。 |
| `interventionId` | 字符串(类型前缀+随机) | 各生产者注册时 | sessionId 分片内唯一;跨会话不保证唯一——**决策权威键是 `(missionId, interventionId)` 二元组**(S1),路由必须带 missionId 段(T2)。 |
| `interventionVersion` | 非负整数,单调 | Intervention 权威 journal(75a 落码) | **〔v4 新增,S1〕**CAS 版本:每次状态转换推进;`expectedVersion` 不匹配 = 版本冲突。 |
| `idempotencyKey` | 客户端生成字符串 ≤128 | 决策请求体 | **〔v4 S1 收紧〕**只标识**同一请求重试**(相同 key 重放返回已存响应),不是业务唯一键——业务唯一性是 `(missionId,interventionId)`+版本 CAS。 |

## 2. Mission 账本(`session.mission`,02:514–552 normalizeMission)

权威存储:会话头文件,随会话走、免疫压缩。写入口径:`/api/mission`(trusted)+ `mission_update` 工具/API update(不可信,经 `applyMissionUpdate` 门控)。

| 字段 | 类型 | 可变性 | 说明 |
|---|---|---|---|
| `goal` | string ≤2000 | start 设定;update 提供才改 | 任务目标。 |
| `milestones[]` | ≤16 项 | 按 id 合并(02:559,不整表替换) | 见下行。 |
| `milestones[].id` | string ≤64 | 不可变 | 缺省 `m{i+1}`,重复补 `_`。 |
| `milestones[].desc` | string ≤400 | 可改 | |
| `milestones[].status` | `pending\|done\|blocked` | 单向约束 | **不可信来源不得把 done 回退**(02:574,防抖动拖住 until-done 循环)。 |
| `milestones[].check` | `{type:'none'}` \| `{type:'command',cmd≤500,expect?≤200}` \| `{type:'file_exists',path≤500}` | **仅 trusted 可设/改**(02:506) | 模型注入 check.cmd = 绕过权限系统的任意命令执行,故不可信一律降级 `'none'`。`file_exists` 判定限定工作区内(02:689,防越界存在性探测)。 |
| `milestones[].evidence` | string ≤400 | 可改 | 验收证据(自报或机器验收 detail)。 |
| `constraints[]` | ≤12 × string ≤400 | start 设定 | |
| `budget.maxAutoTurns` | int 1–50,缺省 12 | **update 不可抬**(02:545 注释) | 无人值守硬上限。 |
| `budget.maxTokens` | int ≥0(0=不限) | 同上 | |
| `spent.autoTurns` / `spent.tokens` | number ≥0 | 驱动器累计 | prev 深拷保留。 |
| `autoMode` | `off\|until-done\|supervised` | 用户/驱动器 | off=手动;until-done=自动续跑;supervised=待命(预算耗尽/停滞/接管后)。 |
| `stall.lastDigest` / `stall.sameCount` | string / int ≥0 | 驱动器内部 | 停滞检测:指纹(02:592,status+evidence 长度桶)连续 3 轮不变触发降级(MISSION_STALL_LIMIT=3)。 |
| `replans` | int ≥0,硬限 2 | 驱动器 | |
| `budgetExhaustedAt` | ISO string \| '' | 驱动器记账 | 持久「已耗尽记过账」标记,防二次落账使超支率 >100%(02:542)。 |
| `result` | object \| null | **仅终态盖章/再武装清理**(02:667) | §3。深拷必须携带(02:548)。 |
| `changeSeq` | int ≥0,**持久单调** | 75a 起随一切任务事实变化推进 | **〔v4 新增,S3〕**见 §1;turn/run/Intervention/预算/result/rewind/删除均推进;轻量 change record 随行(回来摘要的播种源)。存量会话只读派生起步值,不回写。 |
| `createdAt` / `updatedAt` | ISO string | createdAt 不变 | |

## 3. Mission 结果快照(`mission.result`,02:633 buildMissionResult)

终态(`complete` 全里程碑 done / `stopped` 用户停止)时现算并持久化;**盖章定格,不随后续回合漂移**;再武装(里程碑回非全 done)清章(02:677)。

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | `complete\|stopped` | |
| `how` | string ≤32 | 盖章路径(check/update/mission_update/stop)。 |
| `finishedAt` | ISO | |
| `acceptance` | `{total,done,blocked,pending}` | 里程碑计数。 |
| `unfinished[]` | `{id,desc≤200,status}` | 非 done 项。 |
| `todosOpen` | int | 未结 todo 数。 |
| `artifacts[]` | ≤50 × `{path,kind,turnSeq}` | 成果引用(跨回合 fold,首次产出记回合,02:613)。 |
| `changes` | `{filesChanged,byOp,irreversibleFiles,commands}` | 变更摘要;`byOp` 按 create/modify/delete/unknown 计数。 |
| `checkpoints` | `{entries,turnSeqs≤50,rollbackAvailable}` | **真实回滚能力引用**(journal 索引;回滚入口 `POST /api/checkpoints/rollback {sessionId,turnSeq,entrySeq?}`)。 |
| `irreversible` | `{total,byKind,items≤30,legacyCommands}` | 不可逆正向账(§4);`legacyCommands` = 第72波前旧回合只有计数没有明细,诚实单列(02:600)。 |

## 4. turnSummary(回合级账,挂在 message 上;02:1032 buildTurnSummary)

| 字段 | 类型 | 说明 |
|---|---|---|
| `turnSeq` | int | |
| `filesChanged[]` | `{path,op,revertible,entrySeq?}` | journal 条目覆盖工具记录(02:1077):`revertible=true` 当且仅当 journal 有 before 快照;`entrySeq` 支持单文件回滚。失败/幂等 skip 不入账(02:1053/1059)。 |
| `artifacts[]` | `{path,kind}` | op=create 必入;op=modify 仅已知产物类型(img/md/csv/html/xlsx/docx/pdf,02:1098)。 |
| `commands` | int | 命令类工具计数(未知 claude 原生工具也计,02:1066)。 |
| `irreversible[]` | ≤200 × `{kind,name,detail,ok}` | **第72波正向账**:kind ∈ `exec\|desktop\|network`(与权限 tier 同源);**exec 失败也记账**(命令已跑副作用可能已发生,02:1040 `ok` 标记成败);未知桥接工具不记账——不谎称账全。 |

跨回合折叠 `foldTurnSummaries`(02:602,13d 详情与 buildMissionResult 共用单一实现):filesChanged 按 path 后写胜、artifacts 按 path 首见、irreversible 逐条拼接。

## 5. Intervention(未决事项统一持久化,02:34–110)

存储:`<sessionId>.interventions.ndjson`(append-only,按 id **后写胜**折叠,02:75;按 requestedAt 稳定排序)。每行一条记录:

| 字段 | 类型 | 写入方 | 说明 |
|---|---|---|---|
| `id` | string | 注册 | |
| `type` | **枚举冻结**:`permission\|question\|plan\|pool`(3.0 有生产者)+ `conflict\|stall\|budget`(**仅保留名字**:3.0 无生产者、任何 UI/文档不得暗示可用、**消费者必须容忍未知类型**(读到保留位/未知 type 跳过不炸)、**不预冻结未来 payload**——PLAN §2.2/v4 第74波;stall 处置见 §9 T3) | 注册 | |
| `sessionId` | string | 注册 | |
| `status` | **状态机冻结(S1)**:`pending → applying → terminal`;terminal = `allowed\|denied\|answered\|cancelled\|approved\|rejected`;崩溃恢复态 = `indeterminate\|cancelled_restart` | 注册/转换 | `applying` = 决策已受理、执行中的崩溃中间态;重启遇到 `applying` **不自动重放**批准/工具/池物化,对照执行审计后进入诚实终态。**不承诺无法证明的跨崩溃 exactly-once**。 |
| `requestedAt` | ISO | 注册 | |
| `decidedAt` / `decidedBy` | ISO / string | 终态转换 | |
| `interventionVersion` | int ≥0,单调 | 每次状态转换推进 | **〔v4 新增,S1〕**CAS 版本(§1)。 |
| 完整状态记录 | — | 75a 起每次转换落**完整状态行** | **〔v4 新增〕**现状 settle 整行只写 `{id,status,decidedAt,...}`(02:61),后写胜整行覆盖后 resolved 记录丢 type/requestedAt/toolName,排序还把 resolved 顶前——75a 起 journal 记录完整状态,不再后写整行丢字段(PLAN 75a 交付项);75a 前的存量记录仍按后写胜折叠兼容读取。 |
| 类型附加字段 | | | permission:`toolName,tier,revertible`;pool:`runId,proposedBy,task`;71b 对账补登记:`backfilled:true`。 |

**账本权威级别(v4 收紧成文)**:现状 Intervention NDJSON 是 **append-only 旁路账,fire-and-forget**——落盘失败静默吞掉(02:43/50 注释自认),**执行权威源仍是内存 Map**(02:28);boot 终态化(`markInterruptedInterventions`,02:86)据此判 pending 存在「settle 行丢失+重启 → 已决策事项被误标 cancelled_restart」的漂移窗口。**75a 起 Intervention journal 升级为权威存储**(PLAN 75a):同 Mission 写链串行;每次状态转换同步落盘后再推进内存态;转换同时推进 `interventionVersion` 与 `mission.changeSeq`——契约 409/404/410/版本冲突的判定**只以权威 journal + CAS 为准**(§7),漂移窗随之关闭。pool 型例外保持:paused run 的提案重启后**保留 pending**(02:97,恢复后可审批),不一刀切 cancelled_restart。

**撕裂尾行自愈(前移到 75a)**:会话正文文件发现撕裂尾行物理截断自愈(02:144);Intervention NDJSON 此前只在读时跳过坏行——崩溃留无 `\n` 终结尾行后,后续 append 会把新记录**焊进坏行**永久静默丢失。75a 起**先物理截断撕裂尾行再 append**(与正文同纪律);75a 前已在场的焊行记录按坏行跳过处理,不幻想找回。

## 6. Run 摘要投影(13d:80 missionRunDigest,live 以内存为准)

`{id,status,eventSeq,createdAt,updatedAt,completedAt,nodeCount,poolPending,live,paused,resumeTier,totalTokens,costUsd}`。taskPool 提案项:`{id,status:'proposed'|...,proposedBy,task}`;池审批走 run action(13d:553,`!live → 409`)。

## 7. 统一决策契约(S1+S2+T2 拍板,75b 波落码)

**路由**:`POST /api/missions/:missionId/interventions/:id/decision`(T2:带 missionId 段——`:id` 在分片存储下无法全局解析,且与 D1 对外名一致)。

**请求体**:信封 `{expectedVersion, idempotencyKey}` + **按 type/action 区分的联合 payload**(禁止一个松散 action 对象吞掉类型差异):
- permission:`{action:'allow'|'deny', updatedInput?}`(updatedInput = 用户改后放行);
- question:`{action:'answer', answer}`;
- plan:`{action:'approve'|'reject', feedback?}`;
- pool:`{action:'approve'|'reject'}`(目标 run 由 Intervention 的 runId 锁定)。

**权威模型(S1)**:业务唯一键 = **`(missionId, interventionId)`**;`expectedVersion` 对权威状态做 **`pending → applying → terminal` CAS**;`idempotencyKey` **只标识同一请求重试**——相同 key 重放返回已存响应(不重复执行),不同 key 命中已终态返回 409。

**统一错误码**(全类型一致,替换现状 question 409 / permission 404 / plan 200+ok:false / pool 409 四制):

| 码 | 语义 | 判定权威源 |
|---|---|---|
| 200 | 受理;**相同 idempotencyKey 重放返回已存响应,不重复执行** | 权威 journal + 重试键存根 |
| 409 | 不同 key 命中已终态(不重复执行);或 `expectedVersion` 版本冲突 `{reason:'version_conflict'}` | **权威 journal CAS** |
| 410 | 已过期(权限超时自动拒后) | 权威 journal 终态 + 过期记录 |
| 404 | missionId / intervention id 不存在,或 **id 归属不符**(不属于该 missionId) | 分片存储 + 归属校验 |
| 409 + `{reason}` | 不可送达(如 pool 目标 run 非 live:`run_not_live` / `run_paused`) | live 注册表 |

**单一 command core(S2)**:全部决策经唯一 `decideIntervention()` 核心执行——**经典四端点是兼容参数适配器,不是第二条执行路径**;新契约与旧端点不得各自执行后再补账。混合路径(经典壳旧端点 + 新壳契约)并发决策同一 Intervention 时,由 command core 的 CAS 保证**只发生一次状态转换与一次实际动作**;75b 混合路径 e2e 验证的是同一实现的原子性,而非两套补丁碰运气。

**崩溃语义(75a 失败注入矩阵成文)**:状态转换、审计和响应的**落盘顺序**在 74 波冻结(先落 applying → 执行 → 落 terminal + 审计 → 清内存条目);失败注入覆盖「写 applying 前/后、resolve 前/后、terminal 前/后」六个窗口;重启遇到 `applying` 不自动重放高风险动作,对照执行审计后进入 `indeterminate/cancelled_restart` 诚实终态。

**审计字段**:`decidedAt, decidedBy, source('contract'|legacy 端点), idempotencyKey, interventionVersion`。

**pool paused-pending 语义(v3 成文,v4 沿用)**:重启后 run 未恢复前的 pool 提案(§5 保留 pending 的那批),经契约决策返回 `409 {reason:'run_paused'}`;run 恢复(live)后可正常决策。「四类全通」出门闸的 pool 分支在 live run 下构造。

## 8. 聚合读模型投影(13d,只读派生,禁止第二状态机)

- **列表卡片** `GET /api/missions`(13d:95 buildMissionCard):`{sessionId(对外名 missionId),title,cwd,kind,createdAt,updatedAt,status,activeTurn,mission{goal,createdAt,updatedAt,autoMode,milestonesTotal,done,blocked,pending,budget,spent,budgetExhausted,result{status,finishedAt}|null},pending{permissions,questions,plans,pool},runCount,lastRun}`。
- **详情快照** `GET /api/missions/:id`(13d:198):卡片全集 + `acceptance{...,items[]}` + `runs[]`(§6)+ `changes{filesChanged,artifacts,commands}` + `irreversible` + `result` + `checkpoints{entries,turnSeqs,totalBytes,rollbackAvailable}` + `usage{inTok,outTok,turns,subagentTurns,costsByCurrency}` + `pending` + `cursor`。
- **卡片状态派生**(13d:48):`complete > active(until-done) > paused(supervised) > idle`;无 mission = `'none'` 不入列表。
- **五态派生**(56 波,`public/js/mission-state.js` `deriveMissionState`,浏览器/node 双导出):交办中/进行中/需要你/已收工/已停工 + quick_ask 逃生舱,全部从权威字段派生,每条带 `sources` 证据,不读模型文本猜。
- **全局收件箱** `GET /api/interventions`(13d:228):`{pending[{id,type,sessionId,requestedAt,toolName,tier,revertible,runId,proposedBy,task,live}],counts{permission,question,plan,pool,total}}`,FIFO(requestedAt 升序);`live` = 决策可送达性提示。
- **cursor**(13d:191):现状 `{turnSeq, runs{runId:eventSeq}, snapshotAt}`。〔v4 S3〕**Mission 变化时间线的权威 = `mission.changeSeq`**(§1/§2,持久单调);turn/run/Intervention 源 cursor 降为**溯源证据**;**lastSeenRevision**(79 波)= 用户已读位置,按 missionId 存**本机 UI-state store**,不写回 Mission 事实或 Session——任务视图/回来摘要成功呈现后才推进至当前 changeSeq;拉取失败、页面未完成渲染或 changeSeq 间断**不得误标已读**;changeSeq 缺口显式 degraded/重建而非静默漏项。回来摘要 = changeSeq-diff 投影(change record 播种源),纯事件零模型。

## 9. Mission 控制面语义(74 波冻结;动作落 84 波)

逐动作界定作用域,新壳 UI 不得产生歧义:

| 动作 | 作用域 | 现有机制 | 语义冻结 |
|---|---|---|---|
| **暂停** | 当前回合 + 驱动 | 停回合(activeChildren)+ `autoMode→supervised` | 当前回合中止、自动续跑挂起;mission 非终态,无结果章。 |
| **继续** | 驱动 | `autoMode→until-done` | 预算内恢复自动续跑。 |
| **停止** | **整张 Mission** | stop 路径盖 stopped 章(13-http-router) | 终态;`result.status='stopped'`,定格。 |
| **重试** | **整张 Mission** | 再武装(maybeFinalizeMission 清章,02:677)+ 可选重置 blocked 里程碑 | 终态 → 进行态;清章是显式动作。 |
| **人工接管** | 当前回合 + 驱动 | 停回合 + `autoMode→off` | 用户手动驱动,无自动续跑。 |
| Run 级 | 单个 Run | 池审批(13d:553)/ run pause-resume-stop(08) | 只作用于该 run,不动 mission 状态。 |
| 回合级 | 当前回合 | 停回合 | 只中止当前回合,驱动按 autoMode 决策后续。 |

**stall 类型处置(T3 拍板,2026-07-29)**:3.0 确认**无 stall 生产者**——停滞检测目前只有驱动器内部降级信号(§2 stall 字段),尚无足以投影为「需要你」的权威信号源,造出来的 stall 是猜测不是事实(no-go #3)。枚举保留位不变;「是否立项 stall 检测」作为 **P3 显式决策点**保留,不在 74 波静默关闭。

## 10. 跨会话决策 threat model(C3 前置,74 波成文;对策落 75/81)

| # | 威胁 | 现有机制 | 75/81 波对策落点 |
|---|---|---|---|
| 1 | **伪造**(伪造决策请求) | 全部决策端点 `tokenOk` header token + ROUTE_AUTH deny-by-default;body-token loopback 不可信(trusted=false,02:556) | 契约同权鉴权;`source` 审计字段区分契约/旧端点;81 波批准动作带上下文+作用域+二次确认策略。 |
| 2 | **重放**(同一决策重复提交/并发双击) | question 409(13d:285);其余三类各异构 | **权威 journal + CAS + 重试键存根**(§7):相同 idempotencyKey 重放返回原结果,不同 key 命中终态统一 409,混合路径同一 command core 只发生一次转换。 |
| 3 | **跨会话越权**(会话 A 的 token/路由决策会话 B 的事项) | `safeSessionId` basename 挡穿越;Intervention 按 sessionId 分片 | 契约路由 missionId 与 intervention.sessionId **一致性校验**(不匹配 404);决策不落账到错误分片。 |
| 4 | **过期竞态**(权限超时自动拒 vs 用户同时批准) | 超时自动拒(04-permission-runtime);71 波决策幂等 e2e 基线 | 状态转换同步落盘后再推进内存态(§5 权威级别),消灭「内存已删/账上 pending」窗口;410 与 409 经权威 journal 终态可区分。 |
| 5 | **不可送达**(决策到了但没有消费者) | 收件箱 `live` 标志;pool `!live→409`(13d:556) | 统一 `409 {reason}`;pool paused-pending 语义(§7);UI 按 live/reason 给「恢复后可决策」人话提示。 |

## 11. 第75c波规模门阈值(74 波成文;实测只许收紧,放宽须回本节改数值并成文理由)

**硬件与口径冻结**:性能测量在本机开发机执行 + 低配模拟复核;**冷** = 进程重启后首请求(索引未驻留),**热** = 索引驻留后稳态请求。

**标准数据集**:300 个 mission 会话头文件;30,000 行 Intervention(分布全会话);100,000 行 usage;单 run 最大 5,000 事件行。

| 端点 | 冷启动 P95 | 热缓存(索引) P95 |
|---|---|---|
| `GET /api/missions` 列表 | ≤1500ms | ≤300ms |
| `GET /api/missions/:id` 详情 | ≤800ms | ≤200ms |
| `GET /api/interventions` 全局 | ≤1200ms | ≤250ms |

低配模拟(限单核 CPU/IO 节流):上述 ×2 余量。索引常驻内存 ≤50MB。阈值标定依据:与 EC-D 性能门同量级(首屏 <1.5s/切换 P95 <200ms),列表取首屏预算、详情取切换预算,冷启动按 300 头文件 + 30k NDJSON 行顺序读的小数据集实测外推 + ≥2× 余量。

**测试矩阵剪枝标准**:全组合(索引三态 × 冷热 × 3 端点 × 数据档 × 配置)爆炸,剪为 ~24 格:①热路径全格(索引完好 × 冷热 × 3 端点 × 标准档)= 6;②降级格(索引损坏→自动重建 × 冷 × 3 端点 × 标准档)= 3;③规模梯度格(标准/2 倍档 × 列表端点 × 冷热,验证线性度)= 4;④低配格(标准档 × 3 端点 × 低配 × 冷热)= 6;⑤索引重建一致性 e2e(删索引→重建→与全量扫描一致)+ 坏尾恢复 e2e = 2(功能格不占性能矩阵)。**注意**:重建与全量扫描读同一本账,对「账本本身有损」无感——账本完整性由 §5 撕裂尾行自愈与权威 journal 承担,不在本矩阵。

## 12. schema version 与迁移契约

- 会话级:`session.schemaVersion`(SESSION_SCHEMA,02:409)既有机制不动;本文件为 **Pretender schema v1**。
- 新增字段 = v1.x:只增不改,旧数据只读派生(70 波 kind / 75a 波 missionId、changeSeq 同款纪律),**绝不批量回写**。
- 改语义/枚举/错误码 = v2:成文修订 + 拍板 + 迁移说明(受影响旧数据的读时适配规则)。
- 旧会话适配红线:第70波前会话(无 kind/missionId/seq)必须**无损可读**,只读派生结果与显式写入结果逐字段一致(e2e 双方向断言沿用 70 波先例)。

## 13. 文书 ↔ e2e 对照表(74 波退出条件:逐条可对照)

| 本文件条目 | 既有测试锚点(dev-harness/) |
|---|---|
| §2 mission 账本字段/门控 | `mission-driver.e2e.js`(until-done/预算/停滞)、`missions-readmodel.e2e.js`(快照投影) |
| §3 结果快照定格/再武装 | `mission-result.e2e.js`(第72波,盖章/清章/幂等/commands NaN 回归) |
| §4 turnSummary/不可逆账 | `mission-result.e2e.js`、`checkpoint.e2e.js`(revertible/journal)、`artifacts.e2e.js` |
| §5 Intervention 现状(注册/决策/重启终态化/幂等) | `interventions-persist.e2e.js`(34 断言:注册落盘/重复决策 409/重启 cancelled_restart)、`interventions-pool.e2e.js`(71b:池提案注册/审批/paused 保留) |
| §6 run 投影/池审批 409 | `interventions-pool.e2e.js`、`team-pool-mailbox.e2e.js`、`agent-deadlock-watchdog.e2e.js` |
| §8 投影/五态/全局收件箱/cursor | `missions-readmodel.e2e.js`(41 断言)、`pretender-gate.e2e.js`(31 断言:收件箱/五态/四旅程) |
| §5/§7〔v4 新增〕权威 journal/CAS/applying 崩溃恢复/changeSeq/单一 command core/混合路径 | **75a/75b 波新件红绿双证**(本文件即其断言基准;红跑 = 现状无 version CAS/权威 journal/applying 态即 FAIL;失败注入矩阵六窗口逐一断言) |
| §8 changeSeq/lastSeenRevision | 75a 新件(changeSeq 推进/缺口 degraded)+ 79 波新件(摘要覆盖 100%/无误标已读) |
| §10 threat model 逐条 | 威胁1:`interventions-persist.e2e.js` 403 断言;威胁2:同件 409 断言;威胁3–5:75b 波契约 e2e 新增 |
| §11 规模门阈值 | 75c 波新件(阈值=本节数值,红跑 = 无索引全量扫描超时 FAIL) |
