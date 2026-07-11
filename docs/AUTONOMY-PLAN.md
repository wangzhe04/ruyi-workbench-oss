# 长任务自主推进能力 · 合并施工方案(AUTONOMY-PLAN)

> 状态:**第25波(耐久基座)已交付**(25.1-25.6 全部落地,验收锁 `dev-harness/autonomy-durability.e2e.js` 43 断言全绿 + 29 件受影响面回归全绿,见路线图 §19);**第26波(调度与监督)待开工**。本稿由两份独立方案合并而成:方案甲(信任/授权 + 主会话侧驱动,五能力面 A–E)与方案乙(执行耐久性工程,问题 1–7 + P0–P3)。合并评审结论:互补大于重复——乙答「跑得久、跑得稳、跑得快」,甲答「敢不敢让它自己跑」;缺任何一半,长任务无人值守都不成立。
> 纪律沿用第23波:每一波「实现 → 多视角对抗验证 → 修复 → 独立回归」,验收一律主会话亲自工具核实,配机器断言护栏,全程离线可跑。

## 0. 一句话结论

如意今天的 agent 是回合制的:单回合内最多迭代 100 次工具,模型一停任务就停;DAG 有节点级循环但没有「跨回合朝目标推进」的驱动器;权限弹窗 120s 超时自动拒 = 无人值守必死;节点崩溃从头重跑 = 长节点不敢跑。本方案把「工作流运行」升级为三层——**Mission Supervisor(目标/验收/预算/重规划)· Durable Scheduler(事件日志/连续就绪队列/心跳/幂等恢复)· Node Runtime(步骤级断点/上下文治理/证据产物)**——并配一张**运行级自主性授权书**,让自主性是「授出来的」而不是「放开来的」。

## 1. 已核实的现状缺口(全部对到源码,2026-07-11)

| # | 缺口 | 证据(server.js,行号为当日快照) | 归属波 |
|---|---|---|---|
| 1 | 恢复粒度=节点级重跑:中断节点整节点从头再来,`subHistory`/已完成步骤/副作用状态全在内存 | `markInterruptedAgentRuns` ≈:6748;子代理历史无落盘 | 25 |
| 2 | 调度批次屏障:`ready.slice(0, concurrency)` + `Promise.all(batch)`,快节点下游等慢节点 | ≈:8025–8029 | 26 |
| 3 | 节点上下文单调增长 + 硬截断(结果 24k / 单前序 12k / 合计 32k 字符),关键证据可能被截 | v0.9 F6 注释自认 "documented leftover" ≈:6965;`slice(0,24000/12000/32000)` ≈:8030–8093 | 28 |
| 4 | 有执行 DAG,无 Mission Supervisor:无「目标—计划—执行—评价—重规划」持久闭环 | 任务池靠节点主动 `propose_task`;无验收判定循环 | 26 |
| 5 | 持久化失败被静默吞:`saveAgentRun(run).catch(() => {})`,磁盘异常时 UI 显示运行中但恢复用的是陈旧状态 | ≈:7844 及 onResourceWait 等多处 | 25 |
| 6 | 监控链路全量:后端逐个读完整 run JSON,前端 2s 全量轮询重建 | app.js ≈:3034;路线图 §18 旧账 | 29 |
| 7 | 预算是静态上限(角色默认 100 轮/并发 8),不是决策资源 | 无按收益分配/停止决策 | 26(硬预算)→ 后续(决策化) |
| 8 | **权限门=自主性天花板**:default 模式 exec 逐次弹窗,`permissionTimeoutMs` 120s 超时自动拒——无人值守第一杀手 | defaultConfig ≈:374 | 27 |
| 9 | 主会话(非 DAG)长任务无驱动:回合结束无人续跑;账本(todos)不带验收、压缩后不回注 | `todo_write` 仅驱动 UI 步骤条 | 26 |
| 10 | 无等待原语:等构建/下载只能烧 token 轮询或人肉盯 | 无 `wait_for` | 28 |

## 2. 目标架构

```
Mission Supervisor(第26波)
  MissionSpec:goal / acceptanceCriteria[](机器可判定优先) / constraints[] /
  budget(时间·token·费用·工具次数·失败次数)/ escalationPolicy / completionEvidence[]
  周期:Planner → Executor → Evaluator → Replanner → Escalator
  重规划硬限制:次数上限 / 新增节点上限 / 链深上限 / 预算阈值 / 不得自行提升工具权限
  覆盖两种载体:DAG 工作流运行 + 主会话 until-done 驱动(很多长任务不是 DAG)

Durable Scheduler(第25/26波)
  事件日志(run_<id>.events.ndjson,单调 seq,append-only)+ 快照(run_<id>.json)
  连续就绪队列(去批次屏障;保资源租约/watchdog 语义)
  attemptId / lastProgressAt / 幂等恢复 / persistence_degraded 可见化

Node Runtime(第25/28波)
  步骤级 continuation checkpoint(每次工具调用后落轻量续点)
  副作用 receipt(prepared/applied/verified;不可判定 → needs_attention,绝不盲目重放)
  输出四分:summary / evidence / artifacts / rawTranscript(默认不注入下游)
  子节点 token 触发自动压缩;预算化上下文构建取代固定 slice

自主性授权书(第27波,独立红队轮)
  运行级预授权:工具 × cwd 范围 × 次数上限 × TTL;所见即所授、可撤销、逐笔审计
  v1 不以命令正则为唯一闸门(必被绕);exec 永不全局持久放行
  权限超时 → 存档暂停(而非拒杀)+ Windows 通知(PowerShell 内建,零依赖)
```

## 3. 数据模型增量

**MissionSpec(run 级 / 会话级)**:`goal` · `acceptanceCriteria[]{desc, check:{type:'command'|'file_exists'|'e2e'|'gate', ...}}` · `constraints[]` · `budget` · `escalationPolicy` · `completionEvidence[]`。

**节点增量字段**:`attemptId`(复用 attempts)· `lastProgressAt` · `continuation{completedSteps[], sideEffects[]{tool,argsHash,resultDigest,state}, lastToolDigest, nextIntent}` · `failureClass` · `evidenceRefs[]`(正文进产物,不塞 run JSON)。

**事件**:`{seq, ts, runId, nodeId?, attemptId?, type, data?}`,append-only,快照仍为现有 run JSON;`listAgentRuns` 的 `^run_[a-f0-9]+\.json$` 过滤天然忽略 `.events.ndjson`。

## 4. 分波施工与验收锁

### 第25波 · 耐久基座(本波)

| 项 | 内容 | 验收锁(e2e) |
|---|---|---|
| 25.1 | `atomicWriteJson` 统一写链:唯一 tmp(pid+随机)+ Windows EPERM/EBUSY 重试 + 失败 unlink,收编 saveSession / config / saveAgentRun / memory 等全部 JSON 原子写 | 源码抽取单测:tmp 唯一性、rename 失败清理;全量 e2e 回归不红 |
| 25.2 | `persistence_degraded` 可见化:连续写失败计数 → run 标记 + 事件 + UI 明示「进度可能无法恢复」;GET /api/agent-runs 叠加**内存活跃 run** 兜底(磁盘坏了 UI 也不骗人) | 单测:计数/阈值/恢复清零;活跃叠加断言 |
| 25.3 | 事件日志+快照:每次状态迁移/进度 flush/门判定/重试/恢复追加 NDJSON 事件,单调 `seq` 持久于 run | 崩溃后事件文件完整可读;seq 单调;快照与事件尾一致 |
| 25.4 | 节点 continuation checkpoint:每次子代理工具调用落轻量续点(已完成步骤+副作用 receipt+下一步意图),随既有 1.5s 节流 flush 持久 | 杀进程→重启→relaunch:节点提示词含「已完成…从此继续」(经 FAKE_CAPTURE_DIR 断言) |
| 25.5 | 幂等语义 v1:`file_write` 内容相同 → 幂等跳过;续跑注入「以下副作用已执行勿重复」;不可判定副作用→ needs_attention 注记 | 同内容重写不产生新检查点条目;captured 提示词含副作用清单 |
| 25.6 | 崩溃注入 e2e:工具执行前/后未落盘/状态落盘后/节点完成前四个时点强杀,重启后断言不丢步骤、不重复已确认副作用 | 新 e2e 文件全绿;登记端口注册表 |

### 第26波 · 调度与监督

去批次屏障(连续就绪队列,调度核心 reducer 化 `state+event→nextState+commands`,保租约/watchdog)· MissionSpec×任务账本合并模型 · 主会话 until-done/监督式驱动 + 无进展检测(账本 K 轮无变化/同错 N 次 → 重规划或「卡住了」卡片)· 重规划硬限制 · 两引擎对称锁(meta-guard E 式)。
**验收锁**:fake-openai 脚本化 12 回合长任务基准无人值守跑通;快节点下游不等慢批(调度等待 P95 断言);`retry×loop×gate×pause×crash` reducer 组合单测。

### 第27波 · 自主性契约(独立红队轮)

运行级授权书(工具×cwd×次数×TTL,所见即所授、可撤、逐笔审计)· 权限超时→存档暂停 · Windows 通知 · 「需要你处理」收件箱(权限/不可逆确认/预算扩容/无法自动恢复/多方案裁决)· 拒绝→结构化换路引导。
**验收锁**:越界必弹窗;glob 逃逸/junction 绕路红队件;撤销即时生效;exec 全局持久放行不可能(断言);审计逐笔可查。

### 第28波 · 上下文与产物治理

子节点 token 触发自动压缩(对齐主回合两级压缩)· 节点输出四分 · 预算化上下文构建取代 `slice(0,32000)` · degraded 下游策略(accept/retry/request_review/fail)· `wait_for{timer|file|process|url}` 等待原语(waiting 态零 token)。
**验收锁**:8 小时级模拟任务上下文超限率断言;degraded 不再被当干净成功消费;wait_for 条件触发续跑。

### 第29波 · 监控与运营

`/api/agent-runs/:id/events?afterSeq=`(或 SSE)增量消费+断线 seq 补播,取代 2s 全量轮询 · 自动恢复分级(`auto_resumable` / `manual_resume_required`,涉外部副作用或权限变化只恢复到暂停态)· 运营指标(干预次数/失败分类/预算超支率)。
**验收锁**:传输量对比全量模式下降 ≥80% 断言;重启自动续跑安全节点、危险节点停在暂停态。

### 场外单列(不进本程序)

server.js 模块拆分+构建期拼接:动「源码=单文件=审计面」根契约(meta-guard 与多件静态 e2e 直接 grep 源文件),与自主性主线零依赖 → 单独立项评审。

## 5. 验收指标(程序级)

工程侧:任意工具边界崩溃后安全任务自动恢复成功率 ≥99%;已确认副作用重复执行率 =0;崩溃 MTTR <30s;8h 任务上下文超限 <1%;ready 调度等待 P95 <2s;持久化失败可见率 100%;事件接口传输量降 ≥80%。
产品侧:dev-harness 三个离线长任务基准(多文件重构/资料汇编/构建-失败-修复循环):无人值守完成率 ≥2/3;人工干预 ≤1 次/任务;无进展自动暂停触发率 100%;token 不破预算。

## 6. 红线

不做独立后台守护进程(驱动器进 server.js,守住单文件零依赖)· 不放宽任何全局默认权限(授权书只能是现有分级的子集,exec 永不全局持久)· 不做嵌套编排(动态扩展走任务池提案)· 崩溃恢复绝不盲目重放不可逆副作用(宁可 needs_attention 等人)。
