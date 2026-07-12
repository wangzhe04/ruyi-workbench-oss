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

**26a(已交付,§20)**:连续就绪队列去批次屏障 + 对抗轮三铁律(判环=零派发且在飞空 / 收尾=全终态且在飞空 / 防双派发+身份守卫)。验收 `scheduler-ready-queue.e2e.js`。

**26b 实施规格(下一施工单元)**:
- **数据模型**:`session.mission = { goal, milestones[]{id, desc, status:'pending'|'done'|'blocked', check?:{type:'command'|'file_exists'|'none', cmd?, path?, expect?}}, constraints[], budget:{maxAutoTurns(默认12), maxTokens?}, spent:{autoTurns, tokens}, autoMode:'off'|'until-done'|'supervised', stall:{lastDigest, sameCount}, replans, createdAt }`。存 session(随会话走,saveSession 已有写链);账本摘要 builder 输出 ≤1200 字围栏块(`<mission-ledger>`,中和纪律同 workbench-memory 的伪闭合围栏处理)。
- **驱动器**:挂在 `/api/chat/stream` 回合收尾处(provider 引擎先行):回合 result 后,若 `mission.autoMode==='until-done'` → ①跑各里程碑 `check`(command 用现有 runProcess 基建、file_exists 用 fsp.access;机器可判定优先,'none' 型由模型在账本工具里自报并要求证据);②全 done → 停,发 `mission_complete` 事件;③未 done 且 `spent.autoTurns < maxAutoTurns` 且无停滞 → 以「继续推进任务账本,当前状态:<digest>」自动发起下一回合(内部调用与用户消息同路,消息标 `source:'mission-driver'`);④停滞判定:digest K=3 轮不变或同错 N=3 次 → `autoMode='supervised'` + 会话内「卡住了」卡片(复用 plan/permission 卡片事件通道)+ 可选一次重规划(spawn planner 子代理改 milestones,`replans<=2` 硬限)。
- **账本工具**:`todo_write` 扩展或新 `mission_update` 工具(read tier):模型更新里程碑状态/新增(≤16 条硬限)/登记证据;两引擎对称——claude 侧走 `--append-system-prompt` 注入 digest + 现有 MCP 工具面,meta-guard 加 E 式对称锁。
- **注入点**:provider `buildProviderSystemPrompt` 合成串(优先级:用户 append < 技能 < 记忆 < 账本,8000 预算沿用三段式);压缩(两级 autoCompact)后 digest 必存活——账本在 session 对象非 messages,天然免疫。
- **验收锁**(`mission-driver.e2e.js`,端口取 9113+):①fake 脚本 12 回合长任务(每回合推进一个里程碑)无人值守跑完,`mission_complete`;②机器 check:file_exists 未满足则驱动继续、满足即停;③停滞:fake 连续 3 轮同错 → 自动降级 supervised + 卡片事件;④预算:maxAutoTurns 耗尽 → 存档暂停非报错;⑤压缩后 digest 仍注入(复用 autocompact e2e 的 fake 序列);⑥meta-guard E 式两引擎对称锁。
- **红线**:驱动器不放宽任何权限(遇 exec 弹窗照旧等人/超时存档暂停——第27波授权书才解这个);`source:'mission-driver'` 的自动回合全额记入用量台账。

**26c**:调度核心 reducer 化 `state+event→nextState+commands` + `retry×loop×gate×pause×crash` 组合单测(26a 三铁律的组合空间目前靠 e2e 实弹覆盖,reducer 化后可穷举)。

### 第27波 · 自主性授权书(Autonomy Grant)—— **核心已交付(27a–27e + 27g),对抗验证通过;27f 延后**

> **实施状态(2026-07-12,用户明示「继续推进27波」后)**:授权书核心引擎已落地并经 7 镜头对抗验证轮(2 P1/P2 当轮修复 + 1 既有安全漏洞附带修复)。
> - **已交付**:27a 数据模型 + `/api/autonomy/{grant,revoke,grants}`(header-token 白名单,无 body-token 兜底)· 27b `resolveToolPermissionContext`+`consumeGrant`(同步原子)+ provider 主 gate 插桩(仅 `gate==='ask' && !bridge`)· 27c CLI 桥收口(entrypoint 感知 + **天花板对称复检**)· 27d exec 约束(**field-exact 取命令** + cmdAllow 锚定 + 元字符拒 + 默认禁网 + exec 工具白名单仅 powershell_run/Bash)· 27e 撤销(单撤/全撤/scope:run 随 run 蒸发/stop 全撤/delete 全撤)· 27g 审计(issued/consume/revoked NDJSON + 中文映射 + 不进 digest)。前端授权书抽屉(签发/预览 dry-run/撤销,exec 高危样式 + 二次确认)。e2e `dev-harness/autonomy-grant.e2e.js`(9116;静态锁 + 纯逻辑源抽取 + Live HTTP)。
> - **对抗轮修复(全部并入 e2e 锁)**:①**P1 field-shadow**——`script_run` 执行 `args.code` 但若按 OR-merge 校验 `command` = 绕 cmdAllow 的 RCE → 改 field-exact 取命令 + exec 白名单排除 script_run;②**P3 CLI 天花板对称**——CLI 桥消耗前补 `nativeToolGate(permissionMode,tier)==='ask'` 复检;③**P2 + 既有 Gap B**——`archive_zip`/`archive_unzip` 处理体**此前从不对源/目标调 guardFileToolPath**(独立于授权书就存在的凭据外泄:可打包 `.ssh`/`config.json` 明文密钥/`runtime.json` token)→ 工具层补源(读)+ 目标(写)护栏,授权书层补数组源 `paths[]` 取值;④**P3**——`file_move/copy`(`from/to`)、`archive_unzip`(`src/destDir`)取键补全(此前永不可消耗);⑤**P3**——`.git` denylist 组件尾点/尾空格归一。
> - **27f 权限超时→存档暂停 已交付**(独立增量,4 镜头对抗轮):**opt-in**(`config.autonomyPauseOnTimeout`,默认 false=保持"超时即拒杀"安全默认,零行为变化)。开启且**无人值守(driverAuto)**回合内:权限弹窗基础超时不立即拒杀,而是打检查点(`logEvent`+`saveSession`)+ 发 `permission_paused` 事件 + 把决定窗口延长到有界 TTL(`autonomyPauseTtlMs`,clamp [5min,6h] 默认 45min);窗口内经 `/api/permission/decision` 决定,TTL 到点无人应答则回落 deny(fail-closed,防僵尸挂起)。两引擎对称:provider 用闭包 `driverAuto`、CLI 桥用 `driverAutoSessions`(runTurn 进出维护);两处同款两段定时器 + fail-closed。**对抗轮 5 条(同一根因)全修**:idle 看门狗此前不识暂停 → 在 TTL(45min)内先按 `turnIdleTimeoutMs`(默认 10min)杀回合/子进程(provider 还 abort 中毒 ctrl 令窗口内批准失效)→ feature 默认配置下失效;修:两引擎看门狗加 `reg.pausePending` 豁免(仿 agent-workflow 的 `runtime.paused` 豁免)+ 暂停结束重置看门狗时钟。e2e `dev-harness/autonomy-pause.e2e.js`(注入 fake 定时器实跑两段 + 静态锁)。**诚实交代**:跨进程重启的暂停不续(pending 权限纯内存);TTL 到点 deny 后驱动器把它当普通拒绝继续(靠停滞检测收敛),非立即终止——"整夜挂起可恢复"的完整形态待 29 波自动恢复分级。
> - **诚实结论仍成立**:授权书让 exec 自主性有界/可撤/可审/模型永远签不出,但不能让一张 exec 授权书对已被注入的模型「安全」——只能变小、变短、可观测。edit→exec 本地载荷根治仍需 shell 沙箱化(下一波专项)。

> 本节为**原设计规格**(多方案设计→3 评委→综合→2 镜头红队 得出,2026-07-11)。下述红队修正已并入实现,是**硬约束**。

**定位(一句话)**:授权书 = 现有权限系统的**严格子集缓存**,不是新权限来源。它只把用户**预先经 UI 明示**的「工具×路径×命令×次数×时长」笼子内的 `gate:'ask'` 就地降为 `'allow'` 并计数;范围外一切照旧弹窗。解决第25/26波痛点:until-done 长任务一遇 exec 弹窗(120s 超时自动拒)就死。

**三条子集不变式(写死在码)**:
1. **子集律**:只 `ask→allow`,**永不** `block→allow`。plan 的 block、越界写 DENY(`guardFileToolPath`)、`isSensitiveDataPath` 二次拒绝全在其上。permissionMode 恒为天花板。
2. **签发主权律**:签发/扩大/续期唯一入口 = UI header token(`tokenOk`);body-token(MCP child loopback,模型可间接触达)`trusted=false` **永无签发能力**(沿用第26波b `check.cmd` 门教训)。
3. **exec 永不全局持久**:授权书**纯进程内存态**(独立模块级 `autonomyGrants` Map,仿 `pendingPermissions`,不挂 session→避 `saveSession` 全量落盘,不进 `config.toolAllowRules`,无侧车文件)。进程重启即全清——这本身是安全属性。

**数据模型**:`Grant{ grantId, sessionId, scope:'run'|'session', runId, tool(精确名,禁通配), tier(签发快照,消耗点重算不信), grantRoot(冻结绝对根), pathGlob[], cmdAllow[](exec 必填,否则整张作废), netAllowed:false, maxUses, usedCount, issuedAt, expiresAt, issuedBy:'ui-token', revoked }`。

**统一收口**:抽 `resolveToolPermissionContext(name, args, entrypoint)`→`{tier, pathArgs[], cmdArg}` + 单一 `consumeGrant()`(全程同步无 await → Node 单线程原子;usedCount++ 不退还)。插三处 `ask` 决策点见下红队修正。

**红队修正(实现前必补,4 结构性 + 5 可用性,全部并入验收)**:
- **【R-P1-1 第三门】子代理 gate(`runSubAgent` 内 `nativeToolGate`)是第三个 ask 点,且子代理共用 `parentSession.id` → 父授权会被子代理**自动共享消耗**(注入最富集面)。**第4条红线**:子代理 gate **永不调用 consumeGrant**;子代理若要无人值守须单独设计**独立更窄、显式下发**的授权句柄(不靠共享 sessionId 继承)。
- **【R-P1-2 取参器异形状 fail-open】**`resolveToolPermissionContext` 若复用原生参数键(path/source/dest)喂 CLI 形状(`file_path`/`command`)会抽不到路径 → pathGlob **真空满足** → 越 grantRoot 放行。**必须**:按 entrypoint 感知参数形状(CLI/bridged/native 各自键)+ tier 用对应 `nativeToolTier`/`bridgedToolTier` 同源;**文件族授权无法解析出任一受控路径 → fail-closed 回落弹窗,绝不真空放行**。
- **【R-P2-1 edit→.git/hooks 延迟 RCE】**纯 `file_edit@工作区` 授权即可写 `.git/hooks/pre-commit`、`.vscode/tasks.json`、`package.json` postinstall 等**工作区内但会被自动执行**的文件 = 潜伏 RCE,不需 exec 授权。**edit 档增设工作区内二级 denylist**(`.git/`/`.githooks/`/`.husky/`/`.vscode/tasks.json` 等),命中回落弹窗;签发 dry-run 红字高亮"本次 glob 命中自动执行文件"。
- **【R-P2-2 签发主权双点约定】**签发 handler **必须只** `if (!tokenOk(req)) 403`(**绝不**带 `bodyTokenOk` 兜底),且**不得**进 mutating 豁免名单。e2e 除"body-token 被 403"外须断言"即便 `body.token===RUNTIME.token` 也 403"。
- **【R2/R3/R4 无人值守失效】**存档暂停在真无人值守下会变**整夜僵尸挂起**(watchdog 结构上不回收 paused run)+ 撤销对 in-flight exec 无 kill 能力 + exec 上限(≤5次/≤30min)与长任务时长对冲。**修正**:§6 默认从"无限暂停"改为 **checkpoint + 短 TTL(30–60min)终止 + 晨间可续**(严格优于 6h 僵尸);exec 授权与子进程句柄绑定,撤销/run-abort 时 SIGTERM;exec TTL 改绑 run-scope 活跃度(总次数 + 空闲超时,非绝对墙钟);签发 UI 给"同类历史 run 约用 N 次"校准提示。
- **【R1/R5 疲劳面转移】**exec **禁止在 pending 弹窗上下文内联签发**(just-in-time consent 是疲劳制造机),须未阻塞时从独立抽屉起草、最好 run 启动前预承诺 + 每会话活跃 exec 授权张数硬上限;暂停-恢复审批须带与签发同等摩擦(展示 args + dry-run,移动端禁一键批准)。
- **【R-P3-2 审计回读】**grant 明细审计 sink 必须落在 `dataRoot/logs`(已在 denylist)——否则模型 `file_read` 自己的审计行即可重建"我被授了什么",绕过"不进上下文"。

**施工单元 27a–27g**(各配 e2e,见综合稿):27a 模型+API+签发门 / 27b consumeGrant+provider 插桩 / 27c CLI 桥收口(entrypoint 感知取参 + 零路径 fail-closed)/ 27d exec 约束(cmdAllow 锚定+元字符拒+禁网)/ 27e 撤销+in-flight kill / 27f 超时→checkpoint 终止+晨间续 / 27g 审计+不进 digest。新建 `dev-harness/autonomy-grant.e2e.js`。
**验收锁**:body-token(含 `body.token===RUNTIME.token`)签发必 403;子代理 gate 不消耗父授权(断言 consumeGrant 不在 runSubAgent 调用);CLI 形状零路径 fail-closed 回落弹窗;`.git/hooks` 命中 edit 授权回落弹窗;越界/junction 逃逸红队件;exec 无 cmdAllow 拒收 + 元字符失配 + 默认禁网;撤销后下次必失配 + in-flight 有 kill 通道;block 永不被提升(断言);exec 不落 config/session/侧车(进程重启即清);grant 字段不出现在 prompt digest。

**诚实结论(写进文档知情条款)**:授权书能让 exec 自主性**有界、可撤、可审、模型自己永远签不出**,但**不能让一张 exec 授权书对已被注入的模型变"安全"**——只能让它变小、变短、可观测。对**范围完全可预测**的短任务是净收益;对**开放范围 exec 长任务**,首次越笼仍全局停摆——这是"授出自主权"的定义代价,由持 header token 的用户知情承担。真正根治 edit→exec 本地载荷需 **shell 沙箱化**(授权书层无解,单独立项)。

### 第28波 · 上下文与产物治理 —— **4/5 单元已交付(28a–28d),对抗验证通过;28e 延后**

> **实施状态(2026-07-12)**:多 agent 测绘设计(5 单元并行读真实代码)→ 实施 → 5 镜头对抗验证轮(5 条 → 复核确认 4 条全修)。
> - **已交付**:**28c 预算化上下文** `buildUpstreamContext`(取代两处 `slice(0,12000)`+`slice(0,32000)` 定长:DAG runNode + spawn_agent 扇出;按下游模型窗口 35% 均分预算,逐依赖降级 全文→摘要→二分截断,放得下给全文不丢证据,靠后依赖不被挤掉,**总量硬钳制**防击穿)· **28b 节点输出四分** `deriveNodeOutputs`(summary 下游默认消费 / evidence=findings / artifacts 两引擎写族 / rawTranscript=result 存档不灌下游)· **28a 子节点两级压缩** `maybeCompactSubHistory`(对齐主回合,复用 evaporateHistory/providerSummaryCall/recentTurnsBoundary;**const 原地 splice** + 并入原始 task 防跑偏;Claude 引擎声明不适用;保留 400 超窗兜底)· **28d degraded 下游策略** `degradedPolicy`(accept/retry/request_review/fail,4 处归一 + resume 回填零回归 + 翻译接缝复用 failurePolicy/pause 机器)。
> - **对抗轮修复(全并入 e2e)**:①**P2 注入**——结构化 summary 未扁平化空白 → 上游可伪造下游 `### 节点(succeeded)` 小标题;修:summary 派生 + buildUpstreamContext 双重扁平化;②**P3 预算击穿**——移除旧 32000 总截断后无总量钳制 + 200/依赖下限 + 未计 header,高扇入/小窗口超预算;修:拼接结果按总预算硬钳一刀;③**P3 重跑残留**——reset 未清 §28 新字段(degradedRetried 残留使重跑不再享降级重试);修:清 degradedRetried/degraded/warning/summary/evidence/artifacts(**但绝不清 continuation/interruptedAttempt——那是 25.4 崩溃续跑靠的字段**);④**P3 两引擎 artifacts 不对称**——`NODE_WRITE_FAMILY` 只含 OpenAI 名,Claude 节点 artifacts 恒空;修:补 Write/Edit/MultiEdit/NotebookEdit。
> - **28e wait_for 等待原语已交付**(独立增量,单独 5 镜头对抗轮):调度 reducer 新增 `toArm` 桶(就绪 wait 节点不占并发槽)+ `waiting` 态 + 重定义 `cycleDead`(计入 `anyWaiting`/`toArm`,**有等待节点绝不误判环整批 failed**);外壳 arm(queued→waiting,零副作用)/poll(并发探测,满足→succeeded/超时→failed/护栏拒→failed)/tick(仅 waiting 时可中断 `abortableSleep`,防 busy-spin + 保 Stop 响应)。四模式:timer / file(过 `guardWorkspacePath`)/ process(**仅信号 0**)/ url(过 `ssrfCheck`+`httpGetGuarded`)。**waiting 态零 token**。对抗轮 13→复核 11(去重 7 独立)全修:**P2** timer `durationMs>timeoutMs` 必超时失败(修:normalizeWaitSpec 抬 timeoutMs≥durationMs+pollMs)· **P2** 暂停/崩溃墙钟吃掉等待预算(修:pause 补偿 + resume 重置等待窗)· **P3** per-node pollMs 节流(url 超频外呼)· **P3** poll 与 abort 竞速 + url 探测收紧(Stop 时延)· **P3** file 相对路径按 ctx.cwd 解析 · **P3** wait×worktree 两归一器降级 none。e2e `dev-harness/wait-primitive.e2e.js`(9118;静态锁 + normalizeWaitSpec/evalWaitCondition 纯逻辑 + Live arm→waiting→succeeded/中途建文件/超时 failed)+ scheduler-reducer §16 六条组合锁。**至此第28波五单元全交付。**
> - 验收 e2e `dev-harness/context-governance.e2e.js`(无端口;静态锁 + 纯逻辑源抽取 + `maybeCompactSubHistory` 实跑[含原地 splice/配对/L2-fail 兜底/总量钳制])。全量回归(DAG/子代理/压缩/崩溃续跑/调度)全绿。

**原规格**:子节点 token 触发自动压缩(对齐主回合两级压缩)· 节点输出四分 · 预算化上下文构建取代 `slice(0,32000)` · degraded 下游策略(accept/retry/request_review/fail)· `wait_for{timer|file|process|url}` 等待原语(waiting 态零 token)。
**验收锁**:8 小时级模拟任务上下文超限率断言;degraded 不再被当干净成功消费;wait_for 条件触发续跑。

### 第29波 · 监控与运营 ✅ 已交付(2026-07-12)

> **状态:三单元全交付 + 5 镜头对抗轮(21 发现→20 独立复核:12 CONFIRMED/6 DOWNGRADED/2 REFUTED)→ 逐条修复。**
> - **29a 增量事件消费**:`GET /api/agent-runs/:id/events?afterSeq=`(记住 lastSeq 重发即断线补播,seq 单调保无重无漏)+ `?view=digest` 轻量视图(run 级标量,~百字节/run)+ 单 run GET 对 live 以内存对象下发(快照节流恒旧)。前端 `loadAgentRuns(force)` 改增量缓存(digest 探测→eventSeq 前进拉 events 轻应用 progressLog/node_start→settle 类拉单 run 快照);保住乱序守卫/live 旗标叠加/断连清空三防线 + 事件僵局自愈 + `config.monitorIncremental=false` 回落全量。补 `node_progress`(gen 跳过)/`run_pool` 事件。**验收锁达成**:忠实模拟客户端算法 20 tick(中途触发 settle 制真实事件流)增量传输 ≤ 全量 20%(实测 ~11%)。
> - **29b 自动恢复分级**:纯函数 `classifyNodeResumeRisk`/`classifyRunResumeTier`(wait/gate/纯读=safe;exec 一律 + edit 有写证据 + **Claude 引擎可写/可 exec** = manual)。`config.autonomyAutoResume`(opt-in,默认 false=零行为变化);开启后 boot 在诚实标死【之后】fire-and-forget 续跑安全 run、危险 run 停 paused + `run_resume_deferred`,崩溃环 `autoResumeCount≥2` 降 manual。**验收锁达成**:重启自动续跑安全 run、危险 run 停暂停态。
> - **29c 运营指标**:`node.errorClass`(~14 设置点显式标注)+ run 收尾聚合 `run.metrics.failuresByClass`;`run.metrics.interventions` 干预计数(pause/resume/stop/steer/池/retry,按状态迁移幂等 + 兼落 `logEvent`)+ 会话级(permission/plan/steer)审计账;`mission_start`/`mission_budget_exhausted` 落账(超支率分子只在转入时记一次);`GET /api/ops/metrics`(干预次数/失败分类/预算超支率,读日志聚合)。两引擎子代理 `subagent_usage` 事件 → `accumulateRunUsage` 累进 `run.usageTotals/totalTokens/costUsd`(点亮前端预订字段)。
> - **对抗轮修复(全并入 e2e)**:**P1(#17,与第27波 field-shadow 同类根因)**——`classifyNodeResumeRisk` 只看 `node.toolTier`,但 Claude 引擎真实工具面是 `role.claudeTools`(非空则无视 toolTier),`toolTier:'edit'` 携 `Bash` 的节点会以 bypass 跑 shell 却被判 safe → 自动续跑重放不可逆 shell 副作用(击穿红线)。修:按真实执行能力判,Claude 可写/可 exec 一律 manual(CLI 写无 journal/幂等兜底,edit-重放-安全假设只对 OpenAI 进程内 toolCall 成立)。**P2**:①#2 boot 自动恢复 vs 用户手动 resume 竞态(陈旧对象 append=seq 重号破坏严格单调 + saveAgentRun 覆盖 live 快照)→ append/save 前后双复检 `activeAgentRuns.has`;②#18 崩溃在途写停在 `continuation.pending` 未晋升 steps → edit 证据也扫 pending;③#19 缺 `permissionModeAtLaunch` 的旧 run 权限拓宽护栏失效 → 有副作用面则 fail-safe manual;④#14 刷新按钮把 MouseEvent 当 force → 显式 `loadAgentRuns(true)`;⑤#6 预算超支率 >100%(update 再武装每次驱动器再入重复落 exhausted)→ 只在转入时落一次 + `budgetExhaustedAt` 经 update 保留;⑥#7 `failuresByClass` 与 run 总态口径矛盾(fromPool+continue 被排除却计入失败漏斗)→ 对齐排除。**P3**:#8 干预计数非幂等→按状态迁移守卫;#10 vote 门 rejected 无 errorClass→补;#12 ops 头条漏 run 级干预→`bumpRunIntervention` 兼落 logEvent;#13/#15/#16 前端一致性(冷路径 apply_isolation 缓存陈旧无自愈 / live run status 迁移盲 10s / 旗标只置不清)→ status 漂移去 `!dg.live` 门 + updatedAt 兜底刷新 + 旗标对称覆写。
> - **对抗轮硬教训(改任何"按声明分级/放行"的判定务必记牢)**:分级/危险度必须按【真正决定执行能力的字段】判,不是声明字段(`toolTier`)—— Claude 引擎的 `role.claudeTools` 完全覆盖 toolTier,与第27波 `script_run` 执行 `args.code` 非 `command` 是同一类 field-shadow;上任何"按 X 判危险度/放行"前,必须核对 X 是不是执行体真正读的字段。
> - e2e:`dev-harness/monitor-incremental.e2e.js`(9120,含传输 ≥80% 验收锁 + 对抗修复静态锁)· `dev-harness/autonomy-resume.e2e.js`(9121,三次 boot + P1 Claude-Bash-伪装-edit 端到端 + 分级纯函数穷举)。全量回归全绿。
> - **未修入 backlog(DOWNGRADED/既有/跨切面,记入 [[wave23-audit-backlog]])**:#0 DNS-rebind 对只读 GET(既有架构:token 随 HTML 明文下发 + hostAllowed 只覆盖写,非本波引入,需全 GET 面 host 校验单独立项);#1/#3/#5 事件文件无上限 + readAgentRunEvents/digest(listAgentRuns)每 tick 全量读盘 parse(wire 已省 ≥80% 达标,盘/CPU 与旧端点同量,长事件史下需字节偏移续读/mtime 缓存优化);#20 autoResume 顺序恢复 + 每 run 全量扫事件文件(fail-safe 方向,不误跑,仅批量恢复尾延迟);双冷 resume 窄窗(既有,`runAgentWorkflow` existingRun 分支 `run_resumed` append 早于 `activeAgentRuns.has` 守卫,需两次近同时手动点恢复,非本波引入)。

**原规格**:`/api/agent-runs/:id/events?afterSeq=`(或 SSE)增量消费+断线 seq 补播,取代 2s 全量轮询 · 自动恢复分级(`auto_resumable` / `manual_resume_required`,涉外部副作用或权限变化只恢复到暂停态)· 运营指标(干预次数/失败分类/预算超支率)。
**验收锁**:传输量对比全量模式下降 ≥80% 断言;重启自动续跑安全节点、危险节点停在暂停态。

### 场外单列(不进本程序)

server.js 模块拆分+构建期拼接:动「源码=单文件=审计面」根契约(meta-guard 与多件静态 e2e 直接 grep 源文件),与自主性主线零依赖 → 单独立项评审。

## 5. 验收指标(程序级)

工程侧:任意工具边界崩溃后安全任务自动恢复成功率 ≥99%;已确认副作用重复执行率 =0;崩溃 MTTR <30s;8h 任务上下文超限 <1%;ready 调度等待 P95 <2s;持久化失败可见率 100%;事件接口传输量降 ≥80%。
产品侧:dev-harness 三个离线长任务基准(多文件重构/资料汇编/构建-失败-修复循环):无人值守完成率 ≥2/3;人工干预 ≤1 次/任务;无进展自动暂停触发率 100%;token 不破预算。

## 6. 红线

不做独立后台守护进程(驱动器进 server.js,守住单文件零依赖)· 不放宽任何全局默认权限(授权书只能是现有分级的子集,exec 永不全局持久)· 不做嵌套编排(动态扩展走任务池提案)· 崩溃恢复绝不盲目重放不可逆副作用(宁可 needs_attention 等人)。
