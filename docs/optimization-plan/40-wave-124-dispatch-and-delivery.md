# 40 · 第 124 波 · 交办与交付贯通（R2：T01／D01／D02／A01）

> **范围来源**：35 号文 §2 的 124 行 ＋ §1 对 [41 号方案](41-personal-workbench-iteration-plan.md) §5.1／§5.4 的裁决。**前置已满足**：写口竞争 122-L2 已修（37 号文／36 号文 §5.4），123 波定时任务已出门，39 号文那一刀已收。
>
> **纪律**：沿 32 号文 §4 纪律 1–16。派单稿里的每一处落点都在 `HEAD` 上 grep 过（下面标了行号的都是本文写作时的实得），**执行者有权证伪**。

## 0. 一句话

**今天「验收」有三套数据面，界面只画得到最外面那一套，于是「它到底做完了没有」这个问题，用户在普通线程里根本问不出答案。** 本波不新造一套，把三套接起来、把「谁说的」标出来。

## 1. 取证：三套「验收」

| # | 数据面 | 住在哪 | 形状 | 谁在写 | 谁在读 |
|---|---|---|---|---|---|
| ① | **事项容器验收项** | `02-session-store.js:3805 normalizeMissionAcceptance` | `{id, text, done, doneAt?}` | 用户 PATCH `/api/missions/:id`；`mission_update` 工具 | **界面唯一读的那一套**：`/api/missions/:id` 的 `acceptance.items`（`13d:718/740`）→ `thread-facts.js:63 acceptanceItems` → 焦点栏与看板 |
| ② | **会话账本里程碑** | `02-session-store.js:1591 normalizeMission` | `{id, desc, status:'pending\|done\|blocked', check:{type:'none\|command\|file_exists', …}}` | 模型 `mission_update`（**不可信一律降级 `check.type='none'`**，`:1584`）；用户经 UI token 的 `/api/mission`（trusted，可设机器检查） | 驱动器 `06e-mission-domain.js`、提示词、`buildMissionResult` |
| ③ | **结果快照** | `02-session-store.js:1726 buildMissionResult` | `{status, how, finishedAt, deliverableText, acceptance:{total,done,blocked,pending}, unfinished[], artifacts[], usage}` | 终态时 `maybeFinalizeMission` 盖章 | 收工卡；`/api/missions/:id` 详情 |

**三条结论**（本波要治的就是这三条）：

1. **① 里没有「谁勾的」**。`{id,text,done,doneAt}` 四个字段，答不了「这条是模型自报的，还是机器跑过命令，还是我自己勾的」。而 ② 里恰恰有这个信息（`check.type` 已经被 `trusted` 门严格分档），**只是没人把它接到界面上**。
2. **② 与 ① 各写各的**，没有任何一处把里程碑的 `status`／`check` 投影进容器验收项。于是界面上一条「已完成」的验收项，背后可能是模型自己说的，也可能是真跑过 `check.cmd`——看不出来。
3. **普通线程（无账本）今天诚实但空**：`steward-drawer.js:1010` 那段注释已经写明「普通会话没有事项／验收／未决，三问此前一律三个『暂无』——可那是『不知道』」。方向是对的，但还差最后一步：**要说「未记录验收」，不能说「0/0」**（0/0 会被读成「一条都没做完」）。

## 2. 三条产品缺口（用户触发 → 现状 → 期望）

**① 「这事儿到底办完了没有？」**
- 触发：用户在焦点栏／看板看一条线程的验收 a/b。
- 现状：`a/b` 两个数，不分来源；普通线程恒 `0/0`。
- 期望：每条验收项带一枚来源标签——**机器检查**（②里 `check.type !== 'none'` 且跑过，附最近一次结果）／**人工复核**（用户勾的）／**自报完成**（模型说的）；整条线程没有账本时显示**未记录验收**，不显示 `0/0`。

**② 「我当初交办的是什么？」**
- 触发：用户在工作台视角打开一条管家开的线程。
- 现状：34 号文 §7.2 表里「委托书」一行标的是「今天已在现场，只是 2.0 没画」——线程头下第一条系统消息位仍是空的。
- 期望：委托书＝线程头下第一条系统消息：目标（用户原话）、验收怎么算、谁在跑、什么时候开始的；**原件可跳**（`sessionId+turnSeq` 定位到管家那一回合的原文，35 号文 §1 对 C05 的抽查已确认这个定位口径在仓里成立）。

**③ 「它说已安排／已发送，真发了吗？」**（A01）
- 现状：这类完成时陈述今天由模型的 `say` 直出——38 号文那次真机 bug 的同一个模具（模型说做了、其实没做）。
- 期望：**用户可见的「已安排／已发送／已建立」只消费 handler 回执**，模型自己说的不算数；拿不到回执就说「我发起了，但没拿到回执」。**这条与 38 号文的契约兜底同源，是它的下一档**（38 号文 §7 ④ 登记的正是这个）。

## 3. 刀序与独占文件

> 每刀出门后主会话必做：`git show --stat` 逐提交读 diff；`build --check`／依赖图 `--check`／`--fast`；改动文件 0x00–0x1f／`\r` 扫描；新件与撞过的真浏览器件串行复跑；一处反向抽查；写 §x 交付记录；推进 32 号文 §6 地图。

| 刀 | 谁 | 范围 | 独占文件 | 绝不碰 |
|---|---|---|---|---|
| **P0 清障三小件**（123-M2 登记里够得着的那三条，与本波其余刀零文件重叠） | Sonnet／主树 | ①「立即运行」二次确认（`steward-settings.js:851` 那枚 `runNow` 今天点了就跑——`scheduleAction`（`:816`）里没有任何确认；**顺带把同一族的「删除」也补上**，`:858` 那枚 DELETE 同样是点了就没，比 runNow 更不可逆）；② `quietCardSnoozeMinutes` 设置入口（`01-config.js:352` 有出厂值与 [1,1440] 钳位、`quiet-card.js:63/81` 有客户端默认，**设置面没有入口**）；③ 设置块订阅 `schedule.changed`（`rail-pocket.js`／`steward-drawer.js` 都订了，`steward-settings.js` 没订，改完要手动刷新才看得见） | `public/js/steward-settings.js`、`index.html` 定时任务块、四份 locale、`steward-settings.static` | `src/` 一律不碰（三件都是前端）、`quiet-card.js` 逻辑 |
| **P1 四态标签与投影** | Opus／主树 | ②→① 的只读投影：`/api/missions/:id` 的 `acceptance.items` 每条带 `provenance:'machine'\|'human'\|'self'\|'unknown'` 与 `checkedAt`／`checkResult`（**全部现算，零新字段**，见 §4）；无账本线程给 `ledger:false`（界面据此说「未记录验收」）；渲染层出标签；**单写入口静态锁** | `src/02-session-store.js`（投影函数一处）、`src/13d-core-domain-routes.js`（详情投影）、`public/js/thread-facts.js`、`public/js/steward-drawer.js` 与 `steward-board.js` 的验收块、四份 locale、新 e2e | `06e-mission-domain.js` 的驱动器语义、`normalizeMissionCheck` 的 `trusted` 门（**一个字都不许松**）、`13g/13h/13q` 管家回合链 |
| **P2 委托书与原件** | Opus／主树 | 线程头下第一条系统消息＝委托书（目标／验收口径／执行者／起始时间）＋「看原件」跳 `sessionId+turnSeq` | `public/js/thread-head.js`、`public/js/steward-conversation.js` 的定位入口、CSS 一处、locale、新 e2e | `steward-drawer.js` 五态段落、`quiet-card.js`、P1 的投影文件 |
| **P3 回执才算数**（A01） | Opus／主树 | 「已安排／已发送／已建立」只由 handler 回执驱动；模型 `say` 里的完成时陈述不产出这些徽标；拿不到回执→「发起了，没拿到回执」 | `src/13p-steward-runner-actions.js`（回执白名单）、`src/13q-steward-runner-turn.js`（帧字段）、`public/js/steward-conversation.js` 的回执渲染、locale、扩 `steward-contract-guard.e2e.js` | 38 号文那三处判据（`contractIncomplete` 的判法不动）、`06b` 提示词（两边都没余量，见 38 号文 §3.1） |

**并行度**：P0 与 P1 文件不重叠可并行；P2／P3 都要碰 `steward-conversation.js`，**必须串行**。真浏览器件同一时刻只许一位执行者跑（纪律 16）。

## 4. 字段裁决：**一个都不加**（写这一节时我先想加 `doneBy`，取证之后自己否了）

第一版结论是「容器验收项加 `doneBy`，因为 `{id,text,done,doneAt}` 答不了『谁勾的』、审计里也没有 `mission_acceptance_*` 事件」。**继续 grep 之后这个结论不成立**——「谁勾的」今天就答得出来，只是答案不在字段里，在**哪一面承载了这个 done**：

| 事实 | 出处（HEAD 实得） |
|---|---|
| 容器验收项①的**唯一**写入口是 `PATCH /api/missions/:id`，注释自己写着「事项级字段的【唯一】写入口」 | `13d-core-domain-routes.js:888` |
| 那个入口是 `tokenOk(req)`＝**UI header token**（`x-wcw-token`），不是 body-token 那一档 | `13d:890`、`01-config.js:2863`、路由表 `01b:22` `auth:'token'` |
| 模型的 `mission_update` 只写会话账本②，且 `trusted=false`——不能设 `check.cmd`、不能把 done 退回 pending | `09-workflow.js:2830-2834` |
| 机器检查只有 trusted 来源设得了，模型一律降级 `'none'` | `02-session-store.js:1584` |

**于是四态是现算的，不落盘**：① 里 `done:true` ⇒ **人工复核**；② 里 `status:'done'` 且 `check.type==='none'` ⇒ **自报完成**；② 里 `check.type!=='none'` 且跑过 ⇒ **机器检查**（附最近一次结果）；两面都没有 ⇒ **未记录**。

**但这条推导是「靠单写入口撑着」的，会悄悄烂掉**——所以 P1 必须同时钉一把锁：**除 `13d:888` 那一处外，全仓零处写容器 `acceptance`**（静态锁，反向：在别处加一处写 → 红）。锁不住这条不变量，四态标签哪天就开始说谎，而没人会发现。（顺带登记一个边角：MCP 子进程手上有 runtime token，理论上能用通用 HTTP 工具打 loopback 去 PATCH；那是 SSRF 防线的地界，不在本波，但锁要按「谁写」而不是「谁应该写」来钉。）

## 5. 判据与反向（每刀至少一条真反向）

- **P1**：新件 `acceptance-provenance.e2e.js`——模型经 `mission_update` 勾一条 → 标签「自报完成」且 `check.type` 恒 `none`（`trusted` 门反向：让模型带 `check.cmd` → 仍是 `none`，标签不变）；用户经 `/api/mission` 设 `file_exists` 并跑过 → 「机器检查」＋ `checkedAt`；用户 PATCH 容器勾一条 → 「人工复核」；**无账本线程 → `ledger:false` 且界面逐字出现「未记录验收」、逐字不出现 `0/0`**；**单写入口锁**：全仓写容器 `acceptance` 的地方恰一处（`13d:888` 那条 PATCH）。反向：把 `provenance` 恒写 `'self'` → 三条红；把 `ledger:false` 去掉 → 「未记录验收」那条红；在 `13k` 里加一处容器 acceptance 写 → 单写入口锁红。
- **P2**：真浏览器件——工作台视角打开管家开的线程，线程头下第一条是委托书且目标逐字等于用户原话；点「看原件」落到那一回合。反向：把委托书插到第二条 → 红。
- **P3**：扩 `steward-contract-guard.e2e.js`——fake provider 只回 `{"say":"已经发给你同事了"}` → 界面零「已发送」徽标；handler 真回执 → 徽标出现。反向：让徽标读 `say` 文本 → 红。
- **P0**：`steward-settings.static` 加三条（确认框、入口键、订阅）；反向各拔一处。

## 6. 待对表（**开工前要拿到**）

35 号文 §2 给 124 的退出门是「J01／J06／J08／J15」，**这四条的原文在仓外那份方案 §9 里，本机没有这个文件**（`docs/` 与用户 Documents 下都搜过）。上面 §5 的判据是按本波的产品缺口自己写的，**编号对不对得上还没核**。开工前请用户把 §9 里 J01／J06／J08／J15 四条贴回来，对不上的以那四条为准（123 波对 J10／J11 就是这么钉的，37 号文 §3.2／§5.3）。

**6-bis-J. 四条 J 已对上（2026-09-14，41 号方案入库之后）**：`41-personal-workbench-iteration-plan.md` §9.3 就是那张「首批 16 条验收场景」表，四条原文逐字如下，右列是本波的落点与差额：

| 编号 | 原文场景 ／ 必须观察到的结果 | 本波落在哪 |
|---|---|---|
| **J01** | 三份本地资料比较，要求给结论 ／ 正确识别对象、**给出来源和可打开交付**，不无意义追问 | 「来源」这半句落在 P1（每条验收带来源）；「可打开交付」归 P2 的原件跳转与 D01 交付块 |
| **J06** | 任务进行中从「三份」改为「只看第二份」 ／ 新修订可见；**旧任务结果不作为新要求的完整交付** | 意图修订（T02）仍不立项（§7 ③）；本波只保证「旧的那条验收是谁判的、什么时候判的」说得出来，够不到「修订后旧结果不顶新交付」——**这条本波不宣称过门** |
| **J08** | 产物生成但测试失败／文件随后缺失 ／ **显示实际验证或可用性状态，不声称完成全部验收** | **P1 的正中靶心**，也是本刀证伪 §4 的理由：见 §6-ter 的 (b)(c) 两组判据与反向 R2 |
| **J15** | 长任务压缩后用户回来问「做到哪、还差什么」 ／ 从真实执行／交付记录答复，**不靠猜测恢复进展** | P1 的 `ledger:false` →「未记录验收」与「没有账本时退到事项级那一套」；余下「还差什么」的交付侧归 P2／P3 |

**对表结论**：§5 的判据编号对得上，**范围不缺**（35 号文 §2 那一行确实是从同一份文档抄的）；唯一要如实登记的差额是 **J06 本波不过门**——它要的是「修订之后旧结果不许冒充新交付」，那是 T02 的地界。

## 6-bis. P0 交付记录（2026-09-14，主树）

三件都落了，另外**修回来一个自己碰坏的东西**（见 ③）。

**① 两枚不可逆动作的二次确认**：`confirm-panel.js` 的登记表加 `scheduleRunNow`／`scheduleDelete` 两条（33 号文 §4「四套收一套」的纪律：文案键在表里，调用点不拼键、不用原生 `confirm`）；`steward-settings.js` 两枚按钮改成 `if (!await confirmDanger({...})) return false;`。派单稿只写了「立即运行」，**执行时把「删除」一起补了**——同一族、同一个 `scheduleAction`、比 runNow 更不可逆（`:858` 那枚 DELETE 今天也是点了就没）。文案说清后果：「不是预演：它会真的起一个回合，可能产生费用，也可能对外做事」。

**② `quietCardSnoozeMinutes` 设置入口**：放在定时任务组（按下「稍后」建的就是这张表里的东西）。与 `threadIndexRecent` 同一个模具——送原样数字、钳位 `[1,1440]` 只由服务端做、落盘之后把**服务端钳过的那个数**回填进框里。

**③ 定时任务块订阅 `schedule.changed`**：走 `settings.setEventStream(stream)` 迟绑定（构造那一行被 `steward-settings.static` F4 逐字钉着，与 `board`／`drawer` 同纪律）；只订这一帧、没打开过这一块就不刷、**仍然零计时器**。
- **它碰坏了一件事，被 `scheduler-ui.browser` 的 B3／B4 逮住**：整张表是重画的，用户展开着的「最近几次」会被推送刷新连根扔掉——**而且不只是测试问题**：真人展开着看，别处一有动静那一格就自己收起来。
- 两处都修：`refreshScheduleFromPush()` 记住展开的是哪一条、重画完展开回来；`toggleRuns` 取回 runs 之后**落点重新找一次**（`liveRunsHost`——手上那个 host 可能已经脱离文档，往里 append 等于画给空气看）。第二处才是真因：第一处只挡得住「推送在点击之前」那一半。
- 关掉订阅做过对照实验：B1b 红、B3 绿 → 订阅确实是那两条红的来源，不是环境。

**判据**：`steward-settings.static` 加 L1–L4f 共 14 条（登记表两条、两个调用点各先 await 确认、两条路各只有一处入口、入口与钳位回填、两条新键中英各一、订阅只一帧且有 `scheduleLoaded` 门、组合根递流、零计时器、runs 画进活落点）；`scheduler-ui.browser` 新增 B1b「不按刷新自己变」。**反向三处真做**（拔确认 → L2 红；拔输入框 → L3 红；拔 `settings.setEventStream` → L4c 红），逐条对上。

**新键四条**（`settings.steward.quietSnoozeMinutes`／`…Hint`／`schedule.runNowConfirm`／`schedule.deleteConfirm`），四份 locale 逐字节同步。**写这四条时踩了一次**：先写成 `{title}`，而本仓 `t()` 的插值是 `{{name}}`——单花括号会原样上屏。改的时候又用 `split("{title}").join("{{title}}")` 全文替换，把 18 处既有的 `{{title}}` 变成了 `{{{title}}}`（`{{title}}` 里含 `{title}`）；`git diff` 当场看见，四份文件回退重做。**教训**：locale 批量替换必须先看 `git diff --stat` 的行数对不对得上预期（预期 4 行，实得 40 行）。

**这一刀零 `src/` 改动**（纯前端），所以不跑生成器链；`--fast` 71/71、`steward-settings`／`steward-shell`／`steward-drawer`／`steward-board`／`quiet-card-snooze.browser`／`scheduler-ui.browser` 逐件串行绿（`scheduler-ui.browser` 连跑 10 次 9 绿 1 红，那一红没抓到失败行，留给全量定性）。

**全量（4 路）：344 ran，344 pass／0 fail／2 flaky —— 真回归 0，也是这三轮里最干净的一轮**（前两轮 6 与 7 件 flaky，本轮只剩 `agent-workflow-ui-progress`／`steward-conversation`）。本刀撞过的四件在全量里都是首跑即过：`steward-settings.static` 0.19 s、`steward-settings` 27.7 s、`quiet-card-snooze.browser` 9.1 s、**`scheduler-ui.browser` 10.8 s**（单跑那一次红没有在独占阶段复现，按 exclusive 件的既有抖动记，不改判据）。

## 6-ter. P1 交付记录（2026-09-14，主树）：四态标签与只读投影

**§4「一个字段都不加」被证伪了一处，本节先说这个。** 派单稿的推导是「② 里 `check.type!=='none'` 且跑过 ⇒ 机器检查」。取证之后，**「且跑过」这半句在仓里没有任何落点，而没有它，这块牌子会在最该说实话的那一格说谎**：

| 事实 | 出处（本刀写作时的 HEAD 实得） |
|---|---|
| 机器检查的**定义权**确实只属于可信来源（`normalizeMissionCheck` 的 `trusted` 门）——这一条派单稿说对了，本刀一个字没动 | `02-session-store.js:1584` |
| 但里程碑的 **`status` 模型改得动**：`applyMissionUpdate` 只挡 `done→pending`（对抗轮 P3），不挡 `pending→done` | `02-session-store.js:1663`（不可信分支只判 `existing.status === 'done' && uo.status !== 'done'`） |
| 于是「用户定义了 `check.cmd` / `file_exists` 的里程碑」被模型一句 `mission_update{status:'done'}` 标完成时，按 `check.type` 推出来的标签会写「机器检查」，**而机器一次都没跑过** | 本刀 e2e (b) 那两条；反向 R2 复现了这块假牌子（实得 `machine/never`） |
| 「跑过没有、结果是什么」**今天全仓不落盘**：驱动器（`06e:53`）与 `action:'check'`（`13-http-router:944`）都只把 pass 的结果写进 `evidence`（自由文本，模型同样写得动），HTTP 回执里那份 `results` 不落盘 | `06e:54`、`13:946` |

这正是 41 号方案 §9 **J08**（「产物生成但测试失败／文件随后缺失 → 显示实际验证或可用性状态，不声称完成全部验收」）要挡的那种谎。所以本刀在这一处按纪律 1 证伪派单稿，**补了一枚只有机器写得了的章**，其余三态仍然按 §4 现算、零新字段：

- `milestone.lastCheck = { at, pass, detail }`，写入口**只有** `recordMissionCheckResult` 一个函数（02），调用点**只有两处**——驱动器每轮那次检查（06e）与 `/api/mission action:'check'`（13）；
- **输入侧一律进不来**：`normalizeMission` 只从 prev 深拷里按 id 捞，`applyMissionUpdate` 不认 `uo.lastCheck`，`start` 全量新建一律清空（新账本没有旧章）。模型与 body-token loopback 都伪造不了；
- 于是四态是：**机器检查**＝有可信检查且落过通过的章｜**人工复核**＝事项容器里有一条逐字同文且用户勾过的验收项（那条勾只可能出自 `13d:888` 那条 UI token 的 PATCH）｜**自报完成**＝账本上标的 done（并带出「机器检查没跑过／没通过」两种实情）｜**open**＝还没完成。强弱序 `machine > human > self`，同一条上三样证据都在时只印最硬的那一份。

**另外两处按取证改了派单形状**（都在 §5 判据之内，不是扩围）：

1. **容器验收项不并进每条线程的清单**。派单稿写的是「②→① 的只读投影」，第一版实现把容器验收项直接接到抽屉清单后面 —— `steward-drawer.e2e` 的 B13 当场转红（实得 4 条：账本 2 条 ＋ 容器 2 条）。**那一红是对的**：事项级验收项属于**整个事项**，挂到每条线程上会把同一份账印好几遍。改成：有账本的线程只画自己的账本（「人工复核」靠**逐字同文 ＋ 用户勾过**接到对应里程碑上）；**没有账本的线程**才退到事项级那一套 —— 那正是 §1 结论 3 说的「普通线程问不出答案」的处境，此前它在这一块里只有「暂无」。`a/b` 跟着画出来的是哪几条走（`merged`）。
2. **详情 ETag 补上容器指纹**。详情自此带着容器那一套验收项，而容器是另一份文件，它变了不会动会话投影的 revision —— 不写进指纹，勾完验收项的下一拍就是 `304` ＋ 陈旧验收（与 `/api/missions` 列表当年那条教训同一个模具，`buildMissionAggregateRows` 的 stamp 注释里写着）。判据（`missionContainerAcceptanceStamp`）单点住在 02，路由只调用。

**落点**：`02-session-store.js`（章、四态判据、容器指纹、投影）、`06e`／`13`（各一行落章）、`13d`（详情路由：ETag ＋ 改走单点投影）、`public/js/thread-facts.js`（归一化＋`acceptanceRecorded`）、`public/js/steward-drawer.js`（徽标与「未记录验收」两处）、`css/views/steward-drawer.css`（两条规则：徽标 `inline-block` —— done 那一档的 `line-through` 会贯穿行内子节点，牌子上的字读不成；只有「机器检查」借 `--ok`）、四份 locale（七条新键，逐字节同步，`git diff --stat` 实得每份 +7 行 = 预期）、`dev-harness/read-frontend-css.js`（CSS 载荷哈希重钉，**先自证旧值再替换**：改 CSS 前在工作区重算 = `fdaa4646…` 与锁上的常量逐字相同，改完 = `c9f61a47…`）。

**派单稿列了、但本刀刻意没碰的一处**：`steward-board.js` 的验收块。它读的是①（容器验收项），而容器里的 `done` 按定义只可能是用户勾的——那条 a/b 本来就是单一来源、不会说谎；而「没有验收项就什么都不说」是左栏既有的纪律（§2.3「只在有话可说时出现」，逐行印一句「没有验收项」就是满栏等重灰字）。要让看板也说「未记录验收」，得先给列表路由同一套投影，那是独立一刀，登记在 §8.5。

**判据**：新件 `dev-harness/acceptance-provenance.e2e.js`，43 条。(a) 不可信来源标 done → 自报完成，且 `trusted` 门反向（带 `check.cmd` 来仍是 `none`）；**(b) 核心：有机器检查却一次没跑过 → 仍是自报完成，不冒充机器检查，也没有时间戳**；(c) 真跑过且通过 → 机器检查＋时间；产物随后删掉再跑一次 → `done` **不**自动回退（既有语义）但牌子落回自报完成并标 `fail`、带出机器给的实情；(d) 容器里用户勾的那条 → 人工复核，容器改了带 `If-None-Match` 来**不**拿 304；(d2) 逐字同文的接法与 `machine > human > self` 强弱序；(e)(e2) 无账本线程 `ledger:false`、挂在事项下时退到事项级那一套；(f) 五把静态锁——章只有一处写入口、落章调用点恰两处且都紧跟着真跑过的那次 `evaluateMissionCheck`、容器验收项的规范器只在 02 且三条 HTTP 写入口全在 `tokenOk` 门后、**模型工具面（09／11／12／13f／13j／13k／13l／13t）零处**、前端零处按 `checkType` 自己推来源、七条新键四份 locale 逐字齐备。

**反向四处真做**（每处都改源码、重建产物、跑完再还原）：

| 反向 | 实得 |
|---|---|
| `provenance` 恒写 `'self'` | (c) 两条红 |
| 「机器档」换回「有 `check.type` 就算」 | **(b)(c) 两条红，实得 `machine/never` 与 `machine/fail`** —— 假牌子当场现形 |
| ETag 拔掉容器指纹 | (d) 条件 GET 实得 `304` → 红 |
| 13k 里加一处 `patchMissionContainer` | f3 单写入口锁红（实得 `["13k-steward-threads.js"]`） |

**回归**：`build --check` 新鲜、依赖图 `--check` PASS（53 模块／418 边，新符号落在既有边内，边数不变）、`node --test dev-harness/unit/*.test.js` 390/390、`steward-drawer.static`／`missions-readmodel`／`i18n`／`eol-policy`／`frontend-domains.static`／`live-full-text.static` 逐件绿。

**顺带清掉一条 HEAD 上的既有红**：`copy-path-guard.static` 的「白名单零陈旧登记」——`589cdb1`（用户 2026-09-14 那四件走查）往 `chat-stream-runtime.js` 插了 10 行，十条登记行号整体 `+10` 却没跟着走。逐行 byte 比对过（位移前 325/1051/1365/1399/1409/1436/1440/1465/1498/1499 与位移后逐字相同，是位移不是新增），按 117s-G 那次 `+41` 的先例重钉，`p17FixedLines` 五条同 `+10`。修前 `--fast` 70/71，修后 71/71。

**再清掉两条 HEAD 上的既有红**：`steward-drawer.e2e` 的 **M5c／M6**（先用 `git worktree` 检出 HEAD 复现过，确认与本刀无关）。根因不是 `hiddenModels`，是 **124 走查②**（`589cdb1`，用户「模型菜单里选择的高亮和行没对上」）给普通 provider 分组补了「常用赢」去重——这条去重原来只落在折叠区头上，于是最近用过的模型在「常用」与分组里各画一行，当前项的描边画在上面那一份、指针停在下面同名那一行上。**实现是对的，红的是判据**：M5c／M6 还钉着旧的「各印一行」。两条按同一条去重规则重新派生（`BULK_GROUP_IDS` = 全部文本 id 去掉已在「常用」露面的那几个；`BULK_GROUP_USED_TEXT_IDS` 同理），不写死 22／7 这两个数。**反向**：把 `steward-chips.js:404` 那条去重拔掉 → M5c／M6 双双转红，还原后逐字节相同。

**另外四件收尾**：① 徽标上的时间改说人话（`stewardAgoLabel`），但**不是**加第二种时间写法——把抽屉里那一处调用收进 `agoLabel()` 一个出口，`lastTouchLabel` 与徽标共用，`steward-drawer.static` 的 J8「抽屉里只剩一种时间写法」那条计数锁因此仍然是 1、含义一个字没松（第一版实现直接调了第二次，J8 当场红——**那一红是对的**）；② 未归类线程（`missionId === sessionId`）天然没有事项文件，详情路由那一拍连读都不读（抽屉是轮询的，省的是每一拍一次 ENOENT）；③ 门面数字按 `facts-generate.js` 重算（e2e 351 → **352**，默认 344 → **345**），README 四处随之刷新；④ `route-inventory.json/md` 重新生成（本刀在 13d 插了行，清单里那些行号会漂）。

## 6-quater. P2 交付记录（2026-09-15，主树）：委托书与原件

**先说派单稿被证伪的那一处命名。** §3 的独占文件表把这一带叫「委托书」，实现时顺手把界面侧命名成 `#threadBrief`／`.thread-brief`／`threadBrief.*` —— **撞了**：仓里早有一族叫这个名字的东西，而且不是一回事。

| 名字 | 是什么 | 谁写的 | 现有的锁 |
|---|---|---|---|
| `session.brief` | **委托书**（本刀要画的） | 13k `steward_thread_new` | 本刀新加的单写入口锁 |
| `session.threadBrief` | 116-5b 的**线程自动摘要** `{title, gist}`（「自动给每条线程起名字」） | 06 摘要块经 `updateSessionMeta` | `thread-brief.static.e2e.js`、设置键 `settings.steward.threadBrief` |

02 的 `sessionBriefOf()` **两个都认**（先 `threadBrief` 后 `brief`），所以名字上再多一处含糊都是债。界面侧因此整族改名 **commission**（`#threadCommission` / `.thread-commission` / `threadCommission.*` / `thread-commission.static.e2e.js`），只有读那个字段时才写 `session.brief`。**改名时误伤了两处存量**（全局替换的老毛病，124-P0 那条 locale 教训的同一个模具）：`data-i18n="settings.steward.threadBrief*"` 与 `class="tb-left/mid/right"`（顶栏那三段）被一起改掉，`thread-brief.static` ⑤ 与 `steward-settings.static` E3 当场红 —— 两条红都是对的，逐处还原，并给新锁补了 ⑦a2「116-5b 那一族的控件与文案键原样还在（改名不许误伤它）」。

**这一刀零 `src/` 改动、零新字段、零新路由、零新请求。** 委托书早就在会话头上（13k 落的 `session.brief`，13d 的 `GET /api/sessions/:id` 一行 `json({ok:true, session, …})` 原样带出），缺的只是没人画。

**形状**：

- **位置即语义**：`#threadCommission` 排在 `#missionBar`／`#autonomyBar`／`#stepBar`／`#messages` **全部之前**（§5 的 P2 反向钉的就是位置）。**不做成流内第一条消息**——取证之后否掉的：中栏默认只画尾窗（`windowStartFor`／`MESSAGE_WINDOW_RENDER_BUDGET`），流内第一条在长会话里根本不画，而「我当初交办的是什么」恰恰是长任务才会问的问题（41 号方案 §9 的 **J15**）。
- **默认折叠**：一行「委托书 · 原话摘录 · 多久以前交办 · 看原件」。它排在所有进度条之前，默认展开等于每打开一条管家线程都要先翻过一屏交办书。
- **展开后三格**：目标＝`brief.userText` **逐字**（`textContent` 直赋，零改写）；管家补充＝`brief.supplement` **原样**（`<pre>`）；「谁在跑」＝管家交办 ＋ 这条线程**自己定过**的模型（`session.engineRoute` 在场时才印，跟随全局时不印——§11.15.2 病 3「印默认值等于没印」）。
- **「验收怎么算」不另起一份解析**：`supplement` 就是 06i `buildStewardBrief` 拼好的「目标：」「验收项：」「约束：」那几行，界面原样印。在前端拿正则把它拆回字段就是第二份解析器——本仓在「线程/会话」那条正则上已经记过这笔账（`steward-conversation.js` 的 `STEWARD_INBOX_*` 头注）；**那边是读历史不得不认，这边没有任何不得不**。
- **「看原件」＝ 跳这条线程的第一条消息**（管家真正递过去的那一整段：原话 ＋ `<steward-brief added-by="steward">` 围栏）。落点住 `session-experience.js` 的新函数 `revealOriginalMessage`，它是 `expandMessageWindowFully` 的**第一个真实调用方**——那个函数的头注早就写着自己是「jump-to-message／search 流的指定回落」，本刀不另造第二条到达路径。注入链：会话域冻结导出 → 组合根 1 行 → 管家壳 1 行转交 → 线程头；拿不到落点时按钮整枚 `hidden`，不画一枚点了没反应的。
- **班组视角一起收**：`data-main-view="canvas"` 时 `#messages` 是 `display:none`，留着带、藏着落点就是一枚死按钮。规则加在**主视图状态机那一处**（`workbench.css` 既有的那张选择器表），不在 `chat-shell.css` 开第二份。
- **换线程收回折叠态**：共用 `boundChipId` 这一个「换没换会话」的事实，不另记第二个游标。

**落点**：`index.html`（骨架 31 行）、`public/js/thread-head.js`（＋136 行：两个可单测的导出纯函数 `threadCommissionOf`／`threadCommissionGist` ＋ 渲染）、`public/js/session-experience.js`（＋30 行：`revealOriginalMessage` 与冻结导出一行）、`public/js/steward-shell.js`／`public/app.js`（各转交一行）、`css/views/chat-shell.css`（＋58 行：带 ＋ 落地那一下闪烁；闪烁用 CSS 动画 ＋ `animationend` 摘类，**零计时器**）、`css/views/workbench.css`（主视图状态机 ＋1 个选择器）、四份 locale（九条新键，`git diff --stat` 实得每份 +9 = 预期）。

**判据**：新件两个。`thread-commission.static.e2e.js` **25 条**（位置、班组一起收、零二次解析、原话逐字、单一时间出口、零请求、委托书写入口全仓恰一处、与 116-5b 那一族零交叉且不误伤、九键四 locale ＋ 插值一律 `{{name}}`、「看原件」注入链五段）；`thread-commission.browser.e2e.js` **34 条**真浏览器（B1–B8）。夹具：线程 S 走既有的 `POST /api/steward/act` → `steward_thread_new`（**不需要假管家模型**），线程 U 由用户自建作对照。

**反向三处真做**（每处都改源码、跑完再还原，还原后逐字节相同）：

| 反向 | 实得 |
|---|---|
| 把 `#threadCommission` 整段挪到 `#missionBar` 之后 | 静态 ①c ＋ 浏览器 B3 双红（实得「排在 #missionBar 之后」） |
| 目标那一格改印摘录 `threadCommissionGist(brief.userText)` | 静态 ③a ＋ B1 红（实得 44 字 / 期望 48），**连带 B8d 也红** |
| 拔掉 `revealOriginalMessage` 里的 `expandMessageWindowFully()` | 静态 ⑨a ＋ **B8 红，而 B5b 仍绿** —— 这一对正是 B8 存在的理由：短会话上第一条本来就画着，只有窗口真起作用时那一步才是必需的 |

**夹具上踩的两处（都记下来，下一个人别再踩）**：

1. **B2b 修前是「判据对、尺子错」**：原话里放了一个 `📊`，实现（`threadCommissionGist`）按**码点**切是对的，而断言用 `.length`（UTF-16 码元）量，42＋省略号被数成 44。改的是断言的尺子，不是实现。
2. **灌水那 8 发一开始全是 409 `session.turn_busy_elsewhere`**：线程 S 当时给的 `cwd` 是数据根 `home`，而**管家会话的 cwd 就是 `home`** —— cwd 写锁按目录串行，它的回合一直排在管家后面等锁。改成**省掉 cwd**（13k `stewardValidateCwd` 三态之①，在 Ruyi 根下派生子工作区）；不能自己编一个临时目录，表外的 cwd 会被直接拒。另补一条 A6b：开工前先等管家递的那一回合真跑完。

**连带重钉四处**（都是「加了件／改了名」引起的机械漂移，不是判据松动）：`read-frontend-css.js` 的 CSS 载荷哈希（**本刀动了三次**：`.thread-brief` 版 → 改名 commission → 班组那条选择器；每次都先自证旧值再替换，第一次自证 `c9f61a47…` 与锁上的值逐字相同）、`fixture-home.static` 的 `RUYI_HOME_SPAWN_SITES` 140→141（新浏览器件那一发起服务）、`route-inventory.json/md`（清册按文件名收录 harness 件）、`facts.json` 与 README 四处（e2e 352→**354**，默认 345→**347**）。

**J 对表**：本刀落在 **J01** 的「可打开交付」那半句（原件可跳）与 **J15** 的「回来问『做到哪、还差什么』」的前半（当初交办的是什么，长会话里也说得出）。**J08** 仍归 P1 那一刀，本刀不宣称。

**如实登记一处口径不确定**：派单稿 §2 ② 写的是「原件可跳（`sessionId+turnSeq` 定位到**管家那一回合**的原文）」。本刀按 41 号方案 §9 C05 的口径实现——那里 `sourceKey = sessionId + turnSeq` 指的是**线程**与**线程的回合**（既有的交付卡读的就是这一份），且 13k 自己的注释写着「新建会话 turnSeq 恒为 0，故委托书是第 1 回合」。**若用户本意是跳回管家对话里下单的那一轮**，那是另一件事（管家会话的 `turnSeq`，`session.brief` 今天不记它，得在 13k 落盘时补一笔），本刀不顺手扩围，登记在 §8.5。

## 7. 不做的（登记）

1. **不新造** `TaskIntentView`／`DeliverableView` 的持久层——它们在本波只是读投影的名字，不落盘（35 号文 §1 对 v1.1「撤回成只读投影」的裁决）。
2. **不碰** `normalizeMissionCheck` 的 `trusted` 门。那道门是防提示注入拿到无提示 shell 执行的唯一闸（`02-session-store.js:1577` 的头注），本波只**读**它的结论。
3. 「意图修订 intentRevision」（T02）仍不立项（35 号文 §1 对 §5.1 的裁决）。

## 8. 停点（2026-09-14 收工；下次从这里进）

**master `4060d77`，未推远端。** 工作树只剩一个本机杂物 `failed-c.txt`（48 行的失败件清单，某次跑批留下的），不入库、也没人读它——顺手删掉或加 `.gitignore` 都行，本刀不替用户决定。

### 8.0 P1 之后的状态（2026-09-14 夜）

| 提交 | 是什么 |
|---|---|
| `6a56808` | **清障**：HEAD 上两条既有红的判据漂移（`copy-path-guard` 白名单行号 +10；`steward-drawer` 的 M5c／M6 —— 124 走查②给分组补了「常用赢」去重之后，两条断言还钉着旧的「各印一行」）。两条都做了真反向 |
| `4060d77` | **124-P1 四态标签与只读投影**（§6-ter）。含对派单稿 §4 的一处证伪与那枚只有机器写得了的章 |

**本轮全量（12 核 / 34 GB，4 路）**：`345 ran / 342 pass / 3 fail / 2 flaky`。**三条红全是 realhist 夹具缺失那三件**（`observation-recall-realhistory`／`-replay`／`session-notes`）——用 `git worktree` 检出 HEAD 逐条复现过，与本刀无关，登记在 §8.4 ⑤；**真回归 0**。另有 `long-tool-liveness-steer` 在 4 路里红、串行复跑即过（并行争抢，不是回归），flaky 名单 `agent-deadlock-watchdog`／`steward-board`。

### 8.1 上一轮会话进了什么

| 提交 | 是什么 |
|---|---|
| `1b489d3` | **39 号刀 · 桌面 MCP 探针异步预热**（同步签名保留＋异步孪生＋预热闸门；同一时刻的 `/health` 2389 ms → **2 ms**；全量 344/0/7 真回归 0） |
| `2fcbb3c` | 39 号文交付记录 ＋ **本文（124 波派单稿）**；32 号文地图推进 |
| `fde1fc1` | **124-P0 三小件**（立即运行／删除二次确认、`quietCardSnoozeMinutes` 设置入口、定时任务块订阅 `schedule.changed`）＋ 连带修回「推送刷新把用户展开的那一格收起来」；全量 344/0/2 真回归 0 |
| `94d2978`／`56ef6dc` | §6-bis 交付记录、地图推进到 P1；后一笔是补回被反引号吃掉的提交号 |

**这台机器（12 核 / 34 GB）的三轮全量**：344/0/7 → 344/0/2 → （P0 轮）**344 pass / 0 fail / 2 flaky**。三轮 flaky 名单只有部分重合，都是并行争抢，不是回归。

### 8.2 ~~卡在哪（用户去找那份文件）~~ —— **已解除（2026-09-14）**

41 号方案已入库（`6aad25e`），§9.3 就是那张 16 条验收场景表，四条原文与本波的对应关系见 **§6-bis-J**：范围不缺，唯一差额是 **J06 本波不过门**（属 T02，35 号文已裁决不立项）。下面这段留着，是为了让下一个人看得见「当时不确定的是什么、按什么判断先开工的」。

<details><summary>当时的判断（原文保留）</summary>


**P1 开工前要拿到仓外 `ruyi-personal-workbench-iteration-plan.md` 的 §9 里 J01／J06／J08／J15 四条原文**（本机 `docs/` 与用户 Documents 下都搜过，没有；多半在另一台机器上，或当初贴在对话里）。

**它影响什么、不影响什么**（按 122 波的先例判断：36 号文 §2.2 那一行「触发：Codex 方案 §9 J04」，J 给的是**用户触发场景**，不是判据本身）：
- **不影响**：§1 的三套数据面取证、§4「一个字段都不加」的裁决、「单写入口」静态锁、P0（已出门）。这些是 grep 出来的事实。
- **真影响两件**：① 退出门的**逐字文案锁**写不准（123 波的 J10／J11 最后钉到了「原文不含『成功』」这种字面判据上）；② **可能漏一件**——四个 J 覆盖整波，若某条描述的处境本文没规划到，会一路建完到退出门才发现，返工落在 P1–P3。
- **拿不到怎么办**：按 §5 现有判据直接开 P1，号文里如实标「J 编号未核」。范围大概率不缺（35 号文 §2 那一行是从同一份文档抄的），缺的是场景措辞。

</details>

### 8.3 ~~下一刀 P2 的开工三步~~ → **下一刀 P3「回执才算数」（A01）的开工三步**

1. **核基线**：`node ruyi-workbench/app/build.js --check`、`node dev-harness/module-dependency-graph.js --check`（期望 53 模块／418 边）、`node dev-harness/run-all.js --fast`（**72/72**，P2 新加了一把静态锁）。
2. **重 grep 三处落点**（派单稿行号会过期，纪律 1）：`src/13p-steward-runner-actions.js` 的回执白名单、`src/13q-steward-runner-turn.js` 的帧字段（`reply` 那一坨的装配点在 `stewardRunClaimedTurn` 末段）、`public/js/steward-conversation.js` 里画回执的那一处。
3. **先把「什么算回执」写成一张表再写渲染**：§5 的 P3 反向是「让徽标读 `say` 文本 → 红」，所以锁要钉的是**徽标的数据源**（只认 handler 回执字段），不是文案。**P3 要碰 `src/`** —— 整条生成器链重跑（纪律 10），与 P2 那一刀「零 src 改动」不同。

**P2 留给 P3 的三件现成东西**：① 「拿不到落点就把控件整枚 `hidden`，不画一枚点了没反应的」这条做法（线程头那枚「看原件」），P3 的「我发起了，但没拿到回执」是同一族处境的另一半；② 真管家线程的确定性夹具口径 —— 走 `POST /api/steward/act` 的 `steward_thread_new`，**不需要假管家模型**，且 **cwd 要省掉**（给它自己的派生工作区，别与管家会话同目录，否则回合一直等 cwd 写锁，实测 409 `session.turn_busy_elsewhere`）；③ `thread-commission.browser` 里那套「先等管家递的那一回合真跑完（A6b）再往下做」的等法。

<details><summary>P2 当时的开工三步（原文保留）</summary>


1. **核基线**：`node ruyi-workbench/app/build.js --check`、`node dev-harness/module-dependency-graph.js --check`（期望 53 模块／418 边）、`node dev-harness/run-all.js --fast`（**71/71**，白名单那条红已在 `6a56808` 清掉）。
2. **重 grep 两处落点**（派单稿行号会过期，纪律 1）：`public/js/thread-head.js` 的线程头装配点、`public/js/steward-conversation.js` 里按 `sessionId+turnSeq` 定位的那个入口（35 号文 §1 对 C05 的抽查确认过这个口径在仓里成立）。
3. **先确定「第一条」的判据再写渲染**：§5 的 P2 反向是「把委托书插到第二条 → 红」，所以那条静态锁要钉的是**位置**，不是「存在」。

**P1 留给 P2 的两件现成东西**：① 详情快照的 `acceptance` 里已经有 `provenance`／`checkState`／`container`／`merged`，委托书要印「验收怎么算」时直接读，不要再去 `session.mission` 里自己算一遍；② 抽屉里 iso → 人话的唯一出口是 `agoLabel()`（`steward-drawer.static` 的 J8 按「只有一处调平台实现」计数，委托书要印时间就走它或同款收口，别再开第二处）。

**这两件里第二件用上了、第一件没用上**：委托书印的是「当初交办时验收怎么算」（`brief.supplement` 里那几行原话），而详情快照的 `acceptance` 说的是「现在判成什么样」—— 那是 P1 已经画在抽屉里的东西，两者不是一回事，委托书去读它反而会把「当初」说成「现在」。

<details><summary>P1 当时的开工三步（原文保留）</summary>


1. **核基线**：`git pull`（若换机器）；`node ruyi-workbench/app/build.js --check`、`node dev-harness/module-dependency-graph.js --check`（期望 53 模块／418 边／1 SCC）、`node dev-harness/run-all.js --fast`（71/71）。
2. **重 grep 一遍 §1 那张表的四条落点**（派单稿的行号会过期，纪律 1）：`02-session-store.js` 的 `normalizeMissionAcceptance`／`normalizeMission`／`buildMissionResult`、`13d-core-domain-routes.js` 的 `/api/missions/:id` 详情投影与那条「唯一写入口」PATCH。
3. **先写「单写入口」静态锁再写投影**（§4 末段）：那把锁是四态推导能成立的前提，先有锁，投影才不会哪天悄悄开始说谎。

</details>

</details>

**并行度**：本机 4 路（`node dev-harness/run-all.js --parallel 4 > log 2>&1`，别用 `| tail`，会吞退出码）。整台机器同一时刻只许一个回归在跑（纪律 14）。改了前端 JS 必须跑真浏览器件（纪律 13）；碰 `src/` 就**整条生成器链重跑**（纪律 10：`module-dependency-graph.js --write` → `build.js` → 动了件数还要 `facts-generate.js`、动了 13 系路由还要 `route-inventory.js`）。

### 8.4 队列里还压着的

1. **`listen()` 之前 1.19 s 的同步 spawn**：`normalizeConfig → defaultConfig → detectClaudePath／detectKimiPath`（实测 189＋156＋**844** ms）。这是「打开工作台等半天」剩下的大头，排在 listen 之前谁都挡不住；39 号刀那套修法（异步预热＋缓存会合）可以照搬。
2. **`steward-board` 的 300 s 豁免**：根因已还，撤销复测要在 24 核那台跑一轮 8 路全量（39 号文 §8 ①，`run-all.js` 注释里也写了）。
3. 127 波的 `playbook`／`workflow` 两类载荷与开机自启（37 号文 §6 ②）。
4. 38 号文 §7 的四条（同回合纠正重试要先有「不写会话正文」的旁路通道、`walkthrough-round1.browser` 抖动、13p／13q 每回合两次读同一份会话可合并、契约判据下一档结构化）。
5. **realhist 三件的可移植性**（2026-09-14 复查后新登记）。`dev-harness/realhist-fixtures/` 是 288 个文件、7.3 MB 的**真实会话 checkpoint**，`.gitignore:41` 早就按「含会话内容，不入库」拒了——这条**不翻案**：本仓是 `-oss` 且有远端，那等于把用户真实对话发出去。现状是 8 个夹具消费者里 5 个（`estimate-buckets`／`session-notes-inject`／`session-notes-merge`／`summary-fact-table`／…）都有 `existsSync` 守卫会 SKIP，**只有 realhist 三件**（`observation-recall-realhistory`／`-replay`／`session-notes`）没有守卫，于是在没夹具的机器上必红。**要还的话有两条路**：① 给那三件补同款 SKIP 守卫（小、立刻能做，代价是那三件在没夹具的机器上等于不跑）；② 造一份**形状等价的合成夹具**入库（真实历史值钱的是 token／段落分布这些形状，不是字面内容），三件从此人人可跑。推荐 ②，但它是独立一刀，不塞进 124 波。

### 8.5 本波自己欠下的（P1／P2 记进来的）

1. **看板也要说「未记录验收」**（P1 §6-ter 末段登记）。左栏看板的验收块今天读的是①（事项容器验收项），那条 a/b 单一来源、不会说谎，但它答不出「这条线程没有账本」。要让看板也说「未记录验收」，得先给 `/api/missions` **列表路由**同一套投影 —— 独立一刀，不塞进 124 波。
2. **「原件」的第二种口径**（P2 §6-quater 末段登记）。本刀的「看原件」跳的是**这条线程的第 1 回合**（管家真正递过去的那一整段，41 号方案 §9 C05 的 `sessionId+turnSeq` 口径）。若用户本意是**跳回管家对话里下单的那一轮**，那是另一件事：`session.brief` 今天不记管家会话的 `turnSeq`，要补得在 13k 落盘时多写一笔（`brief.origin = {sessionId, turnSeq}`）。**先问用户再动**——多一个字段就多一处会烂掉的地方，§4 的纪律在这儿同样适用。
3. **`session.brief` 与 `session.threadBrief` 的同名**（P2 §6-quater 开头那张表）。界面侧已经靠改名躲开了，但**服务端那两个字段仍然同名**，而 02 的 `sessionBriefOf()` 两个都认（先 `threadBrief` 后 `brief`）—— 今天不出事只是因为委托书那份没有 `title`／`gist` 两个键，于是 `sessionBriefOf` 回 null、索引条目里就没有它。**哪天谁给委托书加一个 `title`，线程列表的名字会突然变成委托书的一段。** 要还的话是给其中一个改名（`session.commission`），那是一次会动到落盘形状的迁移，单独一刀。
