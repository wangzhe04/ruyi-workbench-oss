# 40 · 第 124 波 · 交办与交付贯通（R2：T01／D01／D02／A01）

> **范围来源**：35 号文 §2 的 124 行 ＋ §1 对仓外方案 §5.1／§5.4 的裁决。**前置已满足**：写口竞争 122-L2 已修（37 号文／36 号文 §5.4），123 波定时任务已出门，39 号文那一刀已收。
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

## 7. 不做的（登记）

1. **不新造** `TaskIntentView`／`DeliverableView` 的持久层——它们在本波只是读投影的名字，不落盘（35 号文 §1 对 v1.1「撤回成只读投影」的裁决）。
2. **不碰** `normalizeMissionCheck` 的 `trusted` 门。那道门是防提示注入拿到无提示 shell 执行的唯一闸（`02-session-store.js:1577` 的头注），本波只**读**它的结论。
3. 「意图修订 intentRevision」（T02）仍不立项（35 号文 §1 对 §5.1 的裁决）。
