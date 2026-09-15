# 42 · 第 125 波 · 说得准与失败恢复（A02／E01／T03）

> **范围来源**：35 号文 §2 的 125 行 ＋ §1 对 [41 号方案](41-personal-workbench-iteration-plan.md) §5.3／§5.7 的裁决。**前置已满足**：124 波四刀全收，§8.5 两笔债（看板「未记录验收」、焦点线程两处口径）已还清（40 号文 §6-nonies／§6-septies）。
>
> **纪律**：沿 32 号文 §4 纪律 1–16。下面每一处落点都是本文写作时在 `4543510` 上 grep 的实得行号，**执行者有权证伪**（纪律 1）；行号会过期，开工前重 grep。

## 0. 一句话

**工作台知道的比它说出来的多。** 「为什么挂的」有两套词汇三张表、「这份资料是哪天抓的」写在工具返回值里、「用户刚按过停」记在会话头和班组快照上 —— 这三样今天没有一样走到用户眼前；更糟的是**管家会拿着看不见的那一半去做相反的动作**：用户按了停，它能自动把事情重开。

本波不新造任何一张表、不加任何一个持久字段，只做三件事：**让已经存在的事实走到可见层，并让管家的动作先读一眼它们。**

## 1. 取证（四块，全部在 `4543510` 上读过）

### ① 「用户刚按过停」这件事，自理闸门根本没问

管家的确定性自理路径（116-2b）有六道闸，`13p-steward-runner-actions.js:226 stewardSelfServeGate` 里逐条写着：

| 闸 | 判什么 | 落点 |
|---|---|---|
| ① 停机／熔断 | 管家自己歇不歇 | 更外层 `stewardCircuitCheck` |
| ② 小时窗 | 本小时动作到没到上限 | `13p:234` |
| ③ 无进展 | 同一目标连着自理两次还在报问题 | `13p:239` |
| ④ 自理清单 | 用户在设置里勾没勾 | `13p:243`／`13p:256` |
| ⑤ 目标线程权限 | `stewardMayAct(mode,'failed','exec')` | `13p:249`／`13p:258` |
| ⑥ 续跑分级 | `stewardRunResumeTier !== 'auto_resumable'` 不自动 | `13p:259` |

**六道闸里没有一道问「这条线程／这条班组是不是刚被人按停的」。** 而处置意图表（`13p:196 stewardSelfServePlan`）对 `failed` 事件的默认处置就是重开：

- run 类（事件带 `runId`＋`nodeId`）→ `steward_run_action{action:'retry_node'}`；
- 回合类 → `steward_thread_continue{message:'继续'}`（原话写死在 `13p:208`）。

工具侧的权威判据同样不问。`13l-steward-ops.js:263 stewardImplRunAction` 对推进类动作只判两件事：权限档（`:277`）与**仅对 resume 生效**的续跑分级（`:285`）—— `retry_node` 连第二道都没有。再往下 `13d-core-domain-routes.js:1954`：

```js
if (action === 'retry_node') {
  if (live) return { status: 409, body: { ok: false, error: '请先等待或停止当前运行' } };
  ...
  return { status: 200, body: await launchPersistedAgentRun({ sessionId, runId, retryNodeId: nodeId, ... }) };
}
```

**「run 还活着就拒绝」的另一面，就是「run 刚被停掉时恰好允许」** —— 而「刚被停掉」正是用户按下停止之后的那个状态（`09-workflow.js:1005` 把 `run.status` 写成 `'stopped'`）。

**能走到 `failed` 事件的路不止一条**（所以补丁不能只堵事件分类那一处）：

- `09-workflow.js:469`：停止时未终态的节点标 `cancelled`；但**已经在飞**的节点会带着中断错误落成 `failed`，并在 `:950` 发出 `node_settled{status:'failed'}` → `13i:116` 判 `failed`；
- `13i:171`：结果章 `stopped` **且带错误** → `failed`（用户停掉一条跑了一半的事项，`failed>0` 很常见）；
- `13i:180`：`run_end` 的 `failed`／`partial` → `failed`。

**已经做对的那一条要记下来，别改坏**：`13i:191 stewardResolveSessionTurnKind` 把「用户主动停」判成 `done`（`last.ok === false && last.aborted !== true` 才算 failed），而三个引擎都如实给了 `aborted`（`05-claude-engine.js:1020`／`05b-kimi-bridge.js:2762`／`09-workflow.js:3207`），`13k-steward-threads.js:516` 也如实落了盘。**所以洞不在「事件算不算失败」，在「算失败之后要不要动手」。**

### ② 「为什么挂了」有三张表、两套词汇，管家一张都不用

| # | 表 | 住哪 | 规模 | 谁在读 |
|---|---|---|---|---|
| ① | `ERROR_CLASSES`（机器类 → 中文人话 ＋ 下一步） | `06-provider-engine.js:62` | 12 条 | `13-http-router.js:349` 挂在 `/api/status` 上 → 2.0 线程的错误卡 |
| ② | 前端本地目录 `ERROR_CLASS_I18N` | `public/js/session-experience.js:541` | **6 条**（＋`:566` 的三个「下一步」按钮） | 只服务 2.0 线程卡；未命中才回落 ① |
| ③ | `classifyRuntimeToolFailure`（工具调用失败 → 12 类 ＋ `allowedRepair`） | `07-autonomy.js:642` | 12 类 | **默认关**（`01-config.js:201 runtimeFailureTelemetryV1:false`），唯一调用点 `09-workflow.js:1725`，函数头注自己写着「contains no retry or repair path」 |

**管家侧一处都不消费**：`errorClass` 在 `13o`（提示词）、`13p`（动作）、`13m`（共享面）与整个管家前端里 **grep 零命中**。它唯一的去处是收件箱事件的一句话摘要 —— `13i:439`：

```js
payload.summary = ... `会话第 ${seq} 回合失败${payload.errorClass ? '(' + payload.errorClass + ')' : ''}`
```

再由 `13p:402 stewardEventLine` 原样拼进模型的回合层。**于是模型看见的是 `会话第 3 回合失败(idle_timeout)` 这一串原始机器词，「这是什么意思、该怎么办」全靠它自己编** —— 而工作台自己有一张写好了「下一步」的表，就在隔壁。

**这正是 41 号方案 §5.7「查现有分类到管家反馈的消费链」说的那条链：分类有，链断了。**

### ③ 「这是哪天抓的资料」只活在工具返回值里

`11-native-tools.js:1550 webFetch` 抓不到时回落磁盘缓存（缓存形状 `{url,title,text,ts}`，`:1398`）：

```js
if (cached) return { ok: true, url: ..., text: ..., fromCache: true, ts: cached.ts || null, staleReason: mapped.error };
```

**`ok: true`。** 也就是说：断网时问「最新进展」，工具**成功**返回一份可能是三个月前的正文，`fromCache`／`ts`／`staleReason` 三个字段老老实实摆在那儿 —— **然后没有任何一处可见层读它们**（`fetchedAt`／`observedAt`／`asOf` 全仓零命中；`fromCache` 只在本函数内出现）。用户看见的是一段读起来像今天的结论。

做对了的一半也要记：`:1588 webFetchFailMessage` 已经不再张口就说「离线」（按 `failClass` 分七种人话），`:1578` 还会真探一次网才敢说离线。**缺的只有最后一步：把「旧」这个事实印出来。**

### ④ 自动付费升档：**不存在**（现状即过门，本波只钉住「不许长出来」）

`升档`／`escalat` 在 `ruyi-workbench/app/src` 下 **grep 零命中**；自理意图表只产出 `retry`／`resume` 两种（`13p:196-220`），没有任何「换个更贵的模型再试一次」的路径。35 号文给 125 的退出门「网络失败零自动付费升档」**今天靠「压根没实现」满足** —— 那不是保证，是巧合。本波把它变成保证：一条静态锁钉住自理意图表的值域。

## 2. 三条产品缺口（用户触发 → 现状 → 期望）

**① 「我明明按了停，它自己又跑起来了。」**（J07 / E01）
- 触发：用户按停一条正在跑的线程或班组；几秒后那条线程里在飞的节点带着中断错误落成 `failed`。
- 现状：收件箱判 `failed` → 自理六道闸全过（勾了「失败自动重试」＋目标是「全自动」是常见配置）→ `retry_node`／「继续」发出去 → **用户按下的停，被管家撤销了**。
- 期望：**喊停就是喊停。** 目标最近被人按停过 → 管家一律不自动动手，降级成一枚按钮（既有 `propose_required` 路径，`13p:283`）。**用户自己按那枚按钮仍然照做** —— 这条是「不自动重启」，不是「不许重启」。

**② 「它说挂了，可它说不出为什么，也说不出我该干嘛。」**（E01）
- 触发：任一线程回合失败，管家在总览里报这件事。
- 现状：模型拿到的是 `会话第 3 回合失败(idle_timeout)`，它转述出来的「原因」是它自己编的；工作台那张带「下一步」的 12 条表（`06:62`）它看不见。
- 期望：**失败原因与下一步由工作台给，模型只负责说人话。** 事件行消费既有 `ERROR_CLASSES`；表里没有的类如实说「未知类别」，不许模型补空。

**③ 「它拿三个月前的东西当今天的答案。」**（A02 / J02）
- 触发：断网（或站点反爬），用户问「最新进展」。
- 现状：`web_fetch` 回 `ok:true` ＋ 旧正文，`ts` 写在返回值里没人读；用户看不出这是缓存。
- 期望：**「旧」这件事由工作台印，不靠模型自觉。** 可见层出现「缓存 · N 天前抓的」的机器徽标（与 124-P3 的回执徽标同一个模具：数据源只有结构化字段，一个 `say` 字样都不许有）。

## 3. 刀序与独占文件

> 每刀出门后主会话必做：`git show --stat` 逐提交读 diff；`build --check`／依赖图 `--check`／`--fast`；改动文件 0x00–0x1f／`\r` 扫描；新件与撞过的真浏览器件串行复跑；**一处真反向**；写 §6-x 交付记录；推进 32 号文 §6 地图。

| 刀 | 范围 | 独占文件 | 绝不碰 |
|---|---|---|---|
| **P0 喊停就是喊停**（J07／E01 的恢复门） | 纯函数判据「这个目标最近被人按停了吗」落在 `06i-steward-core.js`（与 `:404` 那段 `lastTurn` 口径同屋）；`13l` 的 run 推进类动作与 `13k` 的线程递话在**发出去之前**各调它一次（权威点仍在各自工具内，判据只有一份）；`13p` 自理预闸同样调它，拿到拒绝就走既有 `propose_required` 降级 | `src/06i-steward-core.js`、`src/13k-steward-threads.js`、`src/13l-steward-ops.js`、`src/13p-steward-runner-actions.js`、新件 `dev-harness/steward-stop-respected.e2e.js` | `13i` 的事件分类口径（**一个字不动**：洞不在那儿）、`13d:1954` 的 HTTP 面语义（用户自己按重试必须照旧能用）、`09-workflow.js` 的停止收尾 |
| **P1 失败说得出原因**（E01 的消费链） | 收件箱事件行消费既有 `ERROR_CLASSES`：`失败 · 回合空闲超时，已中止 · 下一步：重新发送，或缩小单步任务范围`；表里没有的类如实标「未知类别（`<原词>`）」；自理拒绝理由沿用同一份人话 | `src/13i-steward-inbox.js`（摘要装配一处）、`src/13p-steward-runner-actions.js`（事件行一处）、扩 `dev-harness/steward-inbox*` 既有件 | `06-provider-engine.js:62` 那张表本身（**只读不改，改了 2.0 错误卡跟着动**）、前端 `ERROR_CLASS_I18N`（本刀不碰前端）、`07-autonomy.js` 的遥测分类器（另一层词汇，见 §7 ②） |
| **P2 拿旧的当新的**（A02／J02） | `webFetch` 把既有 `ts` 折成结构化时效（`fromCache` ＋ `ageDays`，**缓存里已经有 `ts`，零新字段**）；可见层印机器徽标「缓存 · N 天前」；徽标数据源只有结构化字段 | `src/11-native-tools.js`（返回值一处）、2.0 工具卡渲染一处（开工前 grep 定位）、四份 locale、新件 `dev-harness/stale-source-badge.e2e.js` | SSRF 判据（`ssrfCheck`／`httpGetGuarded` 一个字不动）、`webFetchFailMessage` 的七种人话、缓存写入路径 |
| **P3 分歧不许被抹平**（J09） | **开工前先取证**：摘要五节（`context-governance-rules.json`）＋ `checkSummaryEntities` 修补环 ＋ `rehydrateObservation` 原件回查，这三样加起来离 J09 还差多少，读完再定范围 —— 够不到就如实不过门（照 124 对 J06 的办法） | 待定 | 待定 |

**并行度**：P0／P1 都碰 `13p`，**必须串行**（P0 先，P1 跟）。P2 与前两刀零文件重叠，可另开一路。碰 `src/` 的每一刀出门前**整条生成器链重跑**（纪律 10：`module-dependency-graph.js --write` → `build.js` → 动了件数再 `facts-generate.js`、动了 13 系路由再 `route-inventory.js`）。**一机一回归**（纪律 14）、新 e2e 首行 `self-isolate-home`（纪律 15）。

## 4. 字段裁决：**一个都不加**（三刀逐条对过）

| 要说的事 | 本来以为要加 | 实得：已经有 | 出处 |
|---|---|---|---|
| 这条线程刚被人按停 | `stoppedByUserAt` | 会话头 `stewardLastTurn.aborted` | `13k:516` 写、`13i:429` 读、`06i:434` 已经在用同一口径 |
| 这条班组刚被人按停 | 同上 | 班组快照 `run.status === 'stopped'` ＋ `pauseRequestedAt`／干预计数 | `09-workflow.js:1005`、`13d:1947` |
| 为什么挂的、该干嘛 | 管家自己的一张表 | `ERROR_CLASSES` 12 条，已经导出、已经上 `/api/status` | `06:62`、`13-http-router.js:349`、`14-main.js:460` |
| 这份资料哪天抓的 | `fetchedAt` | 缓存条目 `ts`，`webFetch` 已经回给调用方 | `11-native-tools.js:1398`／`:1576` |

**四条都不落新盘，但都靠既有不变量撑着，所以三把锁要跟着立**（否则哪天悄悄烂掉没人发现）：

1. **判据唯一**：「被人按停了吗」全仓只有一处函数体，三个调用点零复制（静态锁）；
2. **表唯一**：管家侧零第二张 `errorClass` → 人话表（本文件零机器类字面量，除引用既有表，静态锁）；
3. **值域唯一**：自理意图表只产出 `retry`／`resume`，**不许出现任何换模型／升档意图**（静态锁，替 §1 ④ 那条「靠没实现」的巧合上保险）。

## 5. 判据与反向（每刀至少一条真反向）

- **P0**：新件 `steward-stop-respected.e2e.js`。(a) 落一条 `failed` 收件箱事件，目标班组快照写 `status:'stopped'` → 自理结果必须是 `propose_required`，理由里出现「停」，且**班组没有被重新拉起**（快照 `status` 不变、无新 attempt）；(b) 目标线程头 `stewardLastTurn.aborted:true` → 自理不发「继续」，降级成按钮；(c) **模型自己在 `actions` 里声明** `retry_node` → 工具层同样回 `propose_required`（走的是 `13l` 那条权威路，证明两条路一个口径）；(d) 用户自己经 HTTP 打 `retry_node` → **照常 200**（这条是反向的反向：别把用户一起挡了）。**真反向**：把 `06i` 那个判据恒回 `false` → (a)(b)(c) 三条转红、(d) 仍绿。
- **P1**：扩既有收件箱件。事件带 `errorClass:'idle_timeout'` → 事件行逐字含 `ERROR_CLASSES.idle_timeout.zh` 与 `.next`，且**不再**逐字含裸 `idle_timeout`；带一个表里没有的类 → 逐字出现「未知类别」＋原词。**真反向**：把消费改回原样（直接拼原词）→ 两条转红。
- **P2**：新件 `stale-source-badge.e2e.js`。预置一条 `ts` 为 30 天前的 webcache 条目 → 抓一个连不上的 host → 工具返回 `fromCache:true` 且可见层徽标逐字含「30 天」；在线抓取成功 → **零徽标**（别把每次抓取都染成「旧」）。**真反向**：把徽标数据源换成正文关键词匹配 → 红（同 124-P3 的 AB 组纪律：判回执的那几段里一个 `say` 字样都不许有）。
- **三把静态锁**各自反向拔一处。

## 5-bis. P0 交付记录（2026-09-15，主树）：喊停就是喊停

**落点四处，零新字段、零新模块边（53 模块 418 边不变）：**

| 处 | 干了什么 |
|---|---|
| `06i-steward-core.js`（`stewardMayAct` 之后） | 新判据 `stewardStoppedTarget(head, run)` → `'' \| 'run' \| 'thread'`，只读两处既有落盘事实；同屋一张两句话的表 `STEWARD_STOPPED_SAY` ＋ 取话口 `stewardStoppedRefusal()` |
| `13l-steward-ops.js` | 新读点 `stewardReadRunSnapshot()`（与续跑分级读同一份文件，但那一处的 `missing`／`unknown` 语义一个字节没动）；`stewardImplRunAction` 里推进类动作在 `mayAct` 之后、续跑分级之前加一道闸 |
| `13k-steward-threads.js` | `stewardImplThreadContinue` 在权限闸之前加同一道闸（自动递话那条路） |
| `13p-steward-runner-actions.js` | 自理闸门加 ③b，排在配额与计数之前 |

**三处调用点的条件都是 `stewardTriggerOf(ctx) !== 'user'`** —— `POST /api/steward/act`（用户亲手按按钮）与 `POST /api/steward/relay`（抽屉里直接说）都给 `trigger:'user'`，所以**降级成按钮、用户自己按那条路照旧走得通**。没有 trigger 的调用面（工具循环里模型直接调、进程内直调）按 fail-closed 一并拦下 —— 那些面上做决定的仍然是模型，不是人。

**判据：新件 `dev-harness/steward-stop-respected.e2e.js`（20 条，纯进程内直调，不起服务、不开浏览器）** ＋ `steward-runner.static.e2e.js` 新增 ⑦ 组（判据唯一／表唯一／值域唯一，含切函数体判顺序），全件读数 128 PASS。

**四处真反向（每一处都改源码、确认转红、再逐字节还原）：**

| # | 反向 | 实得 |
|---|---|---|
| 1 | 把 06i 的判据恒回 `''` | **9 条行为断言转红**（A1／A1b／A2／B1／B1b／E1／E2／E4／E5），而「用户自己按仍然照做」「自己挂了照旧能自理」那 6 条**全绿** —— 证明这道闸只拦自动、不拦人 |
| 2 | **只**拔掉 13p 那道预闸（工具层两道留着） | **恰 1 条红：E2**（被停的目标白占了一个小时窗名额）。E1／E3／E4／E5 仍绿 —— 两层防御各有各的用：工具层保证「不会真动手」，预闸保证「连配额都不该花」 |
| 3 | 把 ③b 整块移到自理清单那道闸【之后】（仍在同一个函数体内） | **恰 ⑦e2 红**（935 > 835）—— 顺序锁是紧的，不是「这几个字出现过就算数」 |
| 4 | 自理意图表里加一个 `intent:'upgrade'`；同时把那句话抄进 13k | **⑦f2／⑦c2／⑦c3 三条红** |

**如实登记三处：**

1. **「被停」不等于「用户按的停」。** `aborted` 是 `stopSession()` 的共同产物，`superseded`（用户在同一条线程里又发了一句）、`disconnected`、`steward-stop`（管家自己按优先级停的）、`scheduler_timeout` 都会落它。判据**刻意**不去分辨是谁停的 —— 它要分的是**「自己挂了」与「被停下来」**：前者可以自理重试，后者一律只提议。谁停的都一样，停是一次明确的意思表示。
2. **账过期不算数。** 头上那条 `stewardLastTurn` 只在管家发起的回合 settle 时才翻新，用户自己跑的回合不写它。所以判据加了一道 `last.seq >= head.turnSeq`（与 13i 收集第四源时「账盖不住当前回合就当它还没结束」同一条纪律）—— 否则一条很久以前被停过的线程会被**永久**挡住自理。夹具 C1 钉着这一条。
3. **我自己的第一次反向做错了，而它看起来是绿的。** 反向 3 第一版用 4 个空格的 `if (auto.retry !== true)` 当锚点做字符串替换，结果匹配进了另一个函数里 6 个空格那一行（`String.replace` 找的是子串，不认行首），代码块落到了 `stewardSelfServeAllows` 里 —— 锁照样红，但红的**理由是错的**（块离开了闸门，而不是顺序变了）。改成先切出闸门函数体、只在体内替换，才真正证到「块还在闸门里、只是排到了 ④ 后面」。**做错的反向会给你一个假的安心**，与 124-P3 那次「锁写松了」同族。

**这一刀没碰的**：13i 的事件分类口径（洞不在那儿）、`13d:1954` 的 HTTP 面（用户自己打 `retry_node` 照旧）、09-workflow 的停止收尾。

## 5-ter. P1 开工前的覆盖率实测（2026-09-15，P0 回归等待期做的只读取证）

把**能走到管家面前**的 `errorClass` 全表数了一遍（`08-agent-runs.js:180 classifyNodeErrorText` 的四个 ＋ `src/` 里所有 `errorClass = '...'` 赋值 ＋ 三个引擎的回合级类）：

| 覆盖状况 | 机器类 |
|---|---|
| **表里有**（12 条，`06:62`） | `provider_misconfigured`／`network_down`／`permission_denied`／`tool_error`／`idle_timeout`／`tool_loop`／`plan_rejected`／`schema_failed`／`evidence_missing`／`vote_contract_failed`／`dependency_cycle`／`gate_rejected` |
| **表里没有**（实得 15 条以上） | `timeout`／`network`／`subagent_failed`（`classifyNodeErrorText` 的三个默认出口，**最常见的那几类反而不在表里**）／`no_progress`／`semantic_stall`／`node_exception`／`scheduler_error`／`degraded_fail`／`worktree_error`／`blocked`／`cancelled`／`interrupted`／`propagate_cycle`／`gate_uncovered`／`gate_unverified`／`gate_unpropagated`／`claude_cli_error`／`kimi_acp_error`／`cli_missing`／`launch_error` |

**于是 P1 的范围要改一处**：§3 原写「`06:62` 那张表只读不改」。**实测不成立** —— 光接消费链、不补表，用户会看到一大片「未知类别（subagent_failed）」，那不比现在的裸机器词好多少。P1 改成：**表按缺口补全（只加键，既有 12 条一个字节不动）**，补的每条都要有「这是什么」与「下一步」两句；2.0 线程错误卡跟着白捡覆盖（它未命中本地 i18n 时就回落这张服务端表，见 `session-experience.js:560`）。

## 5-quater. P1 交付记录（2026-09-15，主树）：失败说得出原因

**落点四处：**

| 处 | 干了什么 |
|---|---|
| `06-provider-engine.js` | `ERROR_CLASSES` 从 12 条补到 **32 条**（既有 12 条一个字节不动）。补的是 §5-ter 数出来的缺口，其中 `timeout`／`network`／`subagent_failed` 是 `classifyNodeErrorText` 的三个默认出口 —— **最常见的那几类，修前一条都不在表里** |
| `13m-steward-runner-base.js` | 管家侧唯一的取话口 `stewardFailureExplain(errorClass)`：查既有表 → `人话 · 下一步:…`；查不到 → `未知类别(原词)`；没带类别 → 空串 |
| `13i-steward-inbox.js` | 三处 `failed` 摘要不再把机器词拼进括号（机器词仍原样落在 `payload.errorClass` 上：去重、取证、前端都要它） |
| `13p-steward-runner-actions.js` | `stewardEventLine` 补上原因与下一步 —— 这是**真的喂进模型的那一行** |

**一处落点被依赖图证伪。** 判据本想放 `06i`（管家纯函数都住那儿），`--check` 当场报了 **7 条循环边**：`06/07/09/10/13/13d/13e` 都依赖 `06i`，让 `06i` 反过来读 `06` 的表就成环。改落 `13m`（管家运行器共享面，本来就是回合层文本表的家），读 `06` 是干净的后向边；模块数不变、边 418 → 419。

**判据：** `unit/steward-inbox-core.test.js` 新增两组（P0 判据真值表 8 条 ＋ P1 取话口 7 条，全件 115 PASS）；`steward-runner.e2e.js` 新增 **(L) 段 E6–E11**，判的是**真的喂进模型的那条消息正文**（`origin:'inbox'` 那条 user 消息），不是某个中间函数的返回值；`steward-runner.static` 新增 ⑧ 组（一张表、一个口、三处摘要不拼机器词）。

**两处真反向：** ① 取话口恒回空 → **E7／E8／E11 红**，而 E9（裸机器词不进回合层）**仍绿** —— 两件事各自独立，没有互相掩护；② 在 13p 里另写一张小表 ＋ 把括号拼回 13i → **⑧c／⑧e 红**。

**如实登记两处：**

1. **第一版把断言插在 (E) 段中间，E 全绿、后面的 F2／F3／D11／D12 无辜转红。** 收件箱回合会动无进展计数、小时窗与该目标的自理 `attempts` —— 我那两发额外回合把后面几段的前提悄悄改掉了。改成排到**所有段之后**的 (L) 段。教训写进夹具注释：**夹具里「我这一段借了全局状态」这件事，要么还回去，要么排到没人再用它之后。**
2. **`(errorClass)` 那个括号是故意去掉的。** 留着它，模型会照抄那串机器词给用户看（「失败(idle_timeout)」）；现在它只留在 `payload` 里给机器用。**2.0 的错误卡不受影响** —— 它读的是同一张表的 `zh`／`next`，补表只让它多认识 20 个类。

## 5-quinquies. P2 交付记录（2026-09-15，主树）：拿旧的当新的

**落点全在前端，`src/` 零改动**（与 124-P2 同一种结局：要说的事实后端早就回了，缺的只是有人把它印出来）：

| 处 | 干了什么 |
|---|---|
| `chat-render-primitives.js` | 判据 `staleCacheDays(name, result)`（只读 `fromCache` 与 `ts` 两个结构化字段）＋ 幂等渲染 `renderStaleBadgeInto`；工具卡摘要行上新增徽标位 `.tc-stale`，**回放路径**在 `toolCard()` 里就填 |
| `chat-stream-runtime.js` | **live 路径**：`tool_result` 到达时补渲染一次。**刻意不按 `isError` 分叉** —— 回落缓存时 `web_fetch` 回的正是 `ok:true` |
| `app.js` | 两处注入口接线 |
| `css/states/chat-live.css` | 没有 `data-stale` 时整枚 `display:none`，其余工具卡逐像素不变；有徽标时用告警色（它要说的是「这不是刚抓的」，不是一句补充说明） |
| 四份 locale | `tool.staleCache` ／ `.unknown` ／ `.hint` 三个键 |

**零新字段**：缓存条目里本来就有 `ts`（`11-native-tools.js:1398`），天数按**渲染时刻**算 —— 回放一条三个月前的回合，那份缓存确实就是三个月前抓的，两条路上这句话都成立。

**取证里最扎眼的一句**，就写在生产代码的头注里：`web_fetch` 的缓存回落注释说「stored ts is returned **so the model can judge freshness**」。把「这是不是旧的」交给模型自己判断 —— 这一刀收回来的正是这半句。

**判据：新件 `dev-harness/stale-source-badge.browser.e2e.js`（真浏览器，16 条）**。它不碰网：目标域名是 `.invalid`（RFC 2606 保留，DNS 必然失败），缓存条目由夹具按 `<data>/webcache/<sha256(url)>.json` 预置成 30 天前。一个回合里连开三张卡：**回落了缓存的 `web_fetch`**、`file_read`、**连缓存都没有的 `web_fetch`**（loopback 被 SSRF 前置拒掉）。live 与刷新后的回放各判一遍。静态面在 `live-full-text.static` 新增 J 组 8 条（判据只读结构化字段、两条路都画、不按 `isError` 分叉、样式落在已注册层）。

**三处真反向：**

| # | 反向 | 实得 |
|---|---|---|
| 1 | 去掉 `r.fromCache !== true` 那道门 | **B4b／B5 红** —— 那张连缓存都没回落的卡也被印上徽标 |
| 2 | 判据改成读正文关键词（`result.text` 里找「缓存」） | **J2 当场红**（那一组不许判据里出现 `.text`／`includes(`／`match(`） |
| 3 | 拔掉 live 那一行补渲染 | **B2a/b/c 与 B4b 红、C1 仍绿** —— live 与回放两条路各证各的 |

**如实登记一处（第二次踩同一个模具）：** 反向 1 的第一版**照样全绿**。原因是夹具里只有一张 `web_fetch` 卡，而它本来就是从缓存来的 —— 把门拿掉也没有东西会变。**对照组不在屏上时，「只有真回落缓存的才印」根本没被证过。** 补上第三张卡（连缓存都没有的那一发）之后，反向才咬得住。这与本波 P0 那次「做错的反向给假安心」是同一族：**先问「这个反向如果没被实现拦住，屏上会有什么不同」，答不上来就说明对照组还没摆。**

**顺带还的两笔机械债**：① `read-frontend-css.js` 的经典样式载荷哈希按本刀有意新增重钉（第 ⑤ 条，注释写明原因）；② `copy-path-guard.static` 的中文白名单行号整体位移（`chat-stream-runtime.js` 插了两处共 6 行）—— **十条逐行 byte 比对过**与 `git show HEAD:` 的原行逐字相同，是位移不是新增。

## 5-sexies. P3／P4 交付记录（2026-09-15）：J09 用真模型量过了 —— 结论是**不改 prompt**

**P3 的取证结论**：摘要五节（`context-governance-rules.json` 的 `summary.prompt`）里**没有「来源与分歧」那一格**，但「保真要求」那段已经写明关键名词（数字、日期、人名、路径、禁令）一律原样保留。**「分歧会不会被压没」这件事，读码读不出来** —— 它只能量。于是 P3 与 P4 合流：**先量，再决定要不要动 prompt。**

**P4 的评测件：`dev-harness/truthfulness-eval-live.js`**（用户 2026-09-15 拍板走本机 `deepseek` 端点、模型 `deepseek-flash`）。三条纪律写进了文件头：**不带 `.e2e.js`，不进默认回归**（它要花钱要联网，量的是语义质量而不是确定性正确性）；密钥从本机 `config.json` 现读现用、不落盘不打印；用的是**产品真正在用**的那份压缩提示词，不是为评测另写一句。

### 读数（`--repeats 2`，J09 有效样本 18 发、unknown 0；T03 样本 12 发）

| 档 | 关键实体全留 | 分歧仍可辨认 |
|---|---|---|
| explicit-short（历史里有人点破冲突） | 6/6 | 6/6 |
| implicit-short（没人点破，要自己看出来） | 5/6 | 6/6 |
| implicit-padded（＋28 轮灌水，真有取舍压力） | 6/6 | 5/6 |
| **合计** | **17/18** | **17/18** |

T03（成对，1:1）：**判对 12/12**，多余追问 0，该问没问 0。

**结论：不动 prompt。** 证据不支持「分歧被系统性抹平」这个假设 —— 两次失败各是一种形状（一次丢了两个日期，一次没把冲突说破），是随机性不是结构性。41 号方案 §7.4 注也写着：验证型条目允许以「现有行为满足要求、无新增代码」收口，**不该为了填满刀序而制造改动**。如实登记两件：① 样本量 18，17/18 ≈ 94%，**够不到「零违例」那条线**，所以 J09 标**部分过门**而不是过门；② 评测件留在仓里可随时复跑，将来若实测掉到 90% 以下再回来动 prompt。

### 三个量具 bug —— 全都会把「工具的毛病」算成「产品的毛病」

这一段比读数本身更值钱。**第一版评测给出的结论是「压缩一上压力，分歧 0/6 全丢」。那个结论是假的，三处都是我自己的量具坏了：**

| # | 毛病 | 假读数 | 真相 |
|---|---|---|---|
| 1 | **题目把答案抄在题面上**：历史里助手自己就写着「两份对不上」 | 3/3、6/6 全绿 | 加 `implicit` 轴（把点破冲突的那几句摘掉）才开始有区分度 |
| 2 | **预算触顶被当成产品失败**：`deepseek-flash` 是带思维链的模型，`max_tokens: 3000` 在灌水历史下被思维链吃光，`content` 是**空串** | implicit-padded **0/6** | 抬到 12000 后同一档是 **6/6 实体、5/6 分歧**。空答复必须记 **unknown 不进分母**（41 §9.4） |
| 3 | **要求模型保住输入里没有的词**：`在册` 只出现在 `implicit` 变体删掉的那一行里 | 4 次「实体丢失」 | 判据改成「这一变体输入里真的有的那些词」，4 次全是栽赃 |

**一句话纪律**：**先分类，再算比例。** 一发调用的结局至少有四种 —— 拿到正文／正文空／触顶／调用失败，把它们混在一个分母里，得到的不是产品的读数，是量具的读数。

## 5-septies. 收波读数与两件 flaky 的**第一份病历**（2026-09-15）

**本波收尾全量：349 pass / 0 fail / 0 known-fail / 349 ran / 7 skipped —— 真回归 0**，2 件 flaky。

而这 2 件 flaky 第一次**留下了首跑的失败行**（本波顺带还的那两笔 harness 债，`08dd129`／`e5a7c27`），40 号文 §8.4 ⓪ 想要的「先把失败行落盘」到手了：

| 件 | 首跑红在哪 | 读出来的形状 |
|---|---|---|
| `dom-screenshot.e2e.js` | `FAIL dark screenshot captured` | **截图这一步本身没成**（文件没落地），不是像素比对不过 —— 与「浏览器 e2e 漏 Edge 进程」那条记忆对得上：攒下的 Edge 进程把冷启动拖过了捕获窗口 |
| `quiet-card-typing.browser.e2e.js` | 从 `B1b 对话区真的能滚` 起整条链红；`D4 没被切视角：data-shell-mode 仍是 classic（实得 steward）`；焦点在 `stewardDrawerTitle` 而不是 `promptInput` | **首跑时页面压根不在经典视角**：夹具把 shell mode 切过去的那一发落在应用装配完成之前（或被随后的默认值盖回），于是后面每一条都在错的壳里判 —— 是**夹具起步竞态**，不是产品行为 |

**两件的形状都不是「产品偶发」，是「夹具起步没等稳」。** 治法方向因此清楚了（留给下一波，本波不顺手改）：① `dom-screenshot` 在捕获前加一道「Edge 真的起来了」的判据，并把捕获失败与比对失败分成两种红；② `quiet-card-typing` 把「切到经典视角」改成**有判据的等待**（等 `data-shell-mode === 'classic'` 真的落定再往下走），而不是发一发就继续。

**这一条本身就是那两笔 harness 债的回报**：修前这两件每次上榜都只留下一串 PASS 加一行 `FAIL (1)`，连「红在哪一条」都说不出，自然也就永远迈不出「定机制」那一步。

## 5-octies. flaky 治理第一批（2026-09-15，用户「你先治 flaky 吧」）

**只治拿到病历的那两件** —— 另外几件还没自己说出红在哪一条，不猜着改。

### `dom-screenshot.e2e.js`：四类结局压成了一行，且它是全仓唯一不收尸的浏览器夹具

修前那一行是 `ok(result.status === 0 && fs.existsSync(output) && fs.statSync(output).size > 10000, '<theme> screenshot captured')` —— **「浏览器起不来」「90 s 超时」「PNG 没落地」「PNG 太小」四种完全不同的结局，压成同一句 FAIL**。于是它每次上榜都只留下这一句。

治法两处：① `captureVerdict()` 把四类分开并把证据带出来（退出码、信号、stderr 末两行、实际字节数）；② 只对「启动期抢占」那三类**换一个全新 profile 重来一发** —— 拿到 PNG 之后的像素比对**一次都不重试**（那是产品信号，重试就是掩盖）。

**更要紧的是第二个发现**：我顺手做了一次机械核查 —— 「所有开浏览器的夹具是不是都调了 `stopRuyiTestBrowsers`」 —— **全仓 27 件里，唯一漏的就是 `dom-screenshot`**。它走 `spawnSync`，「同步返回了就没了」的直觉是错的：Chromium 的 renderer／GPU／crashpad 会活过父进程。而它一趟开两个 profile（dark／light），攒下的断头 Edge 正是记忆里「冷启动 4 s → 86 s」那条老账的病因 —— **也正好解释了它的症状恰恰是「截图这一步没成」**。两件事在这里对上了，所以补收尸不是顺手，是对因下药。

**并补一把机械锁**（`fixture-home.static`）：凡是命令行里有 `--user-data-dir` 的夹具，必须调 `stopRuyiTestBrowsers(`。117q 那次普查补完 10 件却没留锁，于是这件一直漏着。

**反向做了两轮，第一轮暴露我的锁是松的**：第一版写成 `text.includes('stopRuyiTestBrowsers')`，把调用改名成 `stopRuyiTestBrowsersXX(` 之后**锁照样绿**（原串仍是子串）。收紧成「必须是调用」`/\bstopRuyiTestBrowsers\s*\(/` 之后，反向如期红并点名 `dom-screenshot.e2e.js`。**这是本会话第三次同一族错误** —— 锁要钉行为，不钉「这几个字出现过」。顺带还逮到本件自己：静态件的注释里写着 `--user-data-dir`，不剔掉 `.static.` 就把自己算成「开了浏览器没收尸」。

### `quiet-card-typing.browser.e2e.js`：切过去了，但没待住

首跑病历说得很清楚：B0「切到工作台视角」**过了**，随后 B1b／B2／B2b 全红，D4 明说 `data-shell-mode` 实得 `steward`、焦点在 `stewardDrawerTitle` —— 视角在 B0 之后被翻回了管家，于是后面每一条都在错的壳里判（点「线程行」在管家壳里打开的是抽屉，不是经典会话）。

治法两处：① 装**视角翻转记录仪**（`MutationObserver` 记下每一次 `data-shell-mode` 变化的时刻），B0 与 D4 的断言里原样打出来 —— 与 124 走查④ 那次 CDP setter 探针同一个手法：**先让现场自己说话**；② `setLens` 从「看见属性等于目标就返回」改成「切到之后还要**待得住 700 ms**」，中途被翻走就当没切成、接着点。

**这不是加 sleep 掩盖**：翻转本身仍被记录仪记下来并打进失败输出，下次再翻我们就知道是谁在第几毫秒翻的。本次跑下来记录是干净的：`[{at:0,to:"steward",note:"初始"},{at:25,to:"classic"}]`。

**还没治的几件**：本波给 `run-all` 补的两笔诊断已经就位，下次它们再红会自己说出红在哪一条。**在那之前不动它们** —— 没有机制就改，是把抖动换个地方抖。（→ 收波那一轮全量立刻兑现了这笔诊断，第二批见 §5-nonies。）

## 5-nonies. flaky 治理第二批（2026-09-15 晚，收波全量的读数直接兑现了那两笔诊断）

治完第一批后跑的那轮全量：**348 pass / 1 fail / 2 flaky / 349 ran**。三件全部**自己说出了红在哪一条** —— 这正是 §5-septies 那两笔 harness 债的回报。三件都拿到病历才动手，三件都做了反向。

### 一个机制解释了其中两件：`PARALLEL_EXCLUSIVE` 这张名单漏了「自己算 P95」的两件

`run-all` 的独占桶是**逐件按事故补起来的**（16 个成员，每个都带着自己那次事故的注释），16 件**全是真浏览器件**。于是两件**自己算百分位的墙钟性能门**一直留在并行桶里 —— 而它们恰好就是这一轮唯二上榜的：

| 件 | 病历 | 空闲单跑对照 |
|---|---|---|
| `mission-index-scale.e2e.js`（唯一的红） | `FAIL (e) 详情冷P95≤800ms(实 1101ms)`，**其余 23 条全绿** —— 包括同件的「低配×2 余量」判据（`detailCold P95≤1600ms`）。产品没退化，是闸在负载下量不准 | 同机空闲跑三次：**617／535／538 ms** |
| `ec-d-performance.e2e.js`（flaky） | 首跑 `FAIL CDP page target available` —— **连浏览器都没挂上**，与 `dom-screenshot` 同一族的启动期抢占 | 它量的是视图切换 P95＜200 ms，全仓余量最窄的硬节拍 |

**为什么只有 (e) 越线**：并行负载把每一条都抬高了（列表冷 878→1023、收件箱冷 446→570、列表热 77→92），但 (e) 是全文件五条墙钟判据里余量最窄的一条 —— 空闲 617／闸 800 ≈ **1.3 倍**，其余三条是 1.7／2.7／13 倍。**余量最窄的那条先断**，这就是全部机制。

**治法**：两件补进 `PARALLEL_EXCLUSIVE`，理由与桶里那 16 件逐字同一条（判据是墙钟，与别的服务／Edge 抢 CPU 时量不准）。**不放宽闸** —— 这两道闸真要抓的是「详情走没走索引」「切视图有没有重排」，那种退化是数量级的，不会被 2 倍调度噪声淹没；把闸放宽才是掩盖。

**外加一把机械锁**（同 §5-octies 那条的教训，第二次）：凡是**自己算 percentile** 的夹具，必须在 `PARALLEL_EXCLUSIVE` 名单里。判据取机械形状，今天实得 **2 件、零误报**。反向：从名单里拿掉 `ec-d-performance` → 锁如期红**并点名它**（不是别的理由）；还原后 sha256 逐字节相同。屏上的差别也当场验了：`[B2] ([main]) mission-index-scale` → **`[exclusive] ([performance]) mission-index-scale`**，独占跑 9.2 s，并行桶里 23 s。

### `agent-deadlock-watchdog.e2e.js`：那个「同时」从来没有人保证

首跑病历是两条：`FAIL a node recorded a resource wait (the cross-access actually contended)` ＋ `FAIL a node recorded a failed tool result`，而「跑到终态」那条**是绿的**。

Section 2 要的是两条节点**同时**各握着自己的节点级租约、再去写对方的资源 —— 只有这样才形成等待环。而**节点级租约是在调 provider 之前拿的**：只要 beta 还没起跑，alpha 写 `fileB` 就畅通无阻，两次写都不撞，于是那两条落空、「跑到终态」照样绿。**修前没有任何东西保证那个「同时」**，它一直是碰运气。

**治法**：在假 provider 里装一个**会合点** —— round-0 的两发请求都到齐了才一起放行。一发 round-0 请求到达，就蕴含发它的那条节点已经握住了自己的租约，所以「都到齐」＝「两把租约都握住」，跨访问必撞。**这不是 sleep**：等的是【事件】不是时间；真的只等到一发时按 1200 ms 回落放行，并把这件事记进 `fellBack`，断言标签里原样打出来 —— **绝不假装撞上过**。

**反向反的是诊断本身**（这件没法靠改实现反向：它几乎总是过）：把 `subagentMaxConcurrent` 强行改成 1 让两条节点不重叠 —— **恰好只有那两条红，其余全绿**，连「跑到终态」都照旧，与全量里观察到的首跑签名一字不差；标签同时如实报出「会合点回落:alpha+0ms／beta+1233ms」。还原后 sha256 逐字节相同。

**一个顺带的读数**：空闲时会合点的实得间隔是 **alpha+0ms／beta+1ms** —— 窗口只有 1 毫秒宽。这解释了它为什么「几乎总是过、只在负载下红」，也说明这一类抖动**不可能靠多跑几次证伪**（121-K1 那次「串行跑 4 次全绿就撤种子、随后并行全量真红」是同一条纪律的老账，见 `dev-harness/mission-index-scale.e2e.js` 文件头注）。

### 第二批的收口全量：**349 pass / 0 fail / 349 ran，真回归 0**

三件治的全部转绿（`mission-index-scale` 由红转绿并改在独占桶里跑，9.2 s；`agent-deadlock-watchdog` 与 `ec-d-performance` 不再上榜）。**新上榜两件，而且两件都自己说出了红在哪一条** —— 诊断继续兑现，**第三批的病历已经到手**：

| 件 | 首跑病历（原样） | 读出来的机制 |
|---|---|---|
| `dom-screenshot.e2e.js` | `FAIL dark screenshot captured（退出码 4294967295；stderr 为空；首发没成:退出码 4294967295…换新 profile 重来一发）` | **两发都是 Edge 启动直接退 -1（0xFFFFFFFF）**。本波新装的四类结局分类正常工作，而且**换新 profile 那一发也没救回来** —— 排除了「这个 profile 坏了」，指向机器级启动抢占。补收尸治的是它**自己**的泄漏，治不了别人在同一时刻留下的。→ 第三批候选治法：**进独占桶**（它一趟开两个无头 Edge，判据是截图，与桶里那批同一条理由） |
| `walkthrough-round2.browser.e2e.js` | `FAIL B1 全新 HOME（没存过视角偏好）启动落【管家视角】—— 这枚入口要救的就是这批人（实得 classic）` | **这件此前从没留下过「红在哪一条」**，这是它的第一份病历。视角**还没落定**就被读了（默认 classic → config 到达后 `syncStewardShellAvailability()` 才翻成 steward）—— 与 `quiet-card-typing` 那件是同一个模具的**镜像**（那件是切过去又被翻回来，这件是还没翻过来）。它已经在独占桶里，所以独占治不了它：要治的是判据本身「读得太早」。→ 第三批候选治法：等**落定**再判，并把落定耗时打进标签 |

## 5-decies. flaky 治理第三批（同日，126 波第一刀的收口全量把这一族又顶出来了）

126-111a 的收口全量：**348 pass / 1 fail / 3 flaky**。唯一的红是 `dom-smoke.e2e.js`，红在 `B1 dump-dom 完成 (0B, status=4294967295)` —— 下游 18 条全是「DOM 里没有这个节点」的连坐。**和同一轮里 `dom-screenshot` 的 flaky 退出码一模一样**：`4294967295`（-1），`result.signal` 为空（**不是** spawnSync 那 90 s 超时，是 Edge 自己退的），stderr 只有 Chromium 的 task-provider 噪声。两件分别单跑各两次全绿（7.0 s / 14.7 s）。

**判据形状又是干净的**：全仓非 static 的夹具里，同时满足「用 `spawnSync`」＋「命令行带 `--dump-dom` 或 `--screenshot=`」的，**正好 2 件，正好就是这两件**。它们把**启动结果本身**当断言，没有 CDP 那条「连不上就重连」的重试面 —— 是全仓对启动期抢占最敏感的形状。两件补进独占桶，并把这条判据钉成 `fixture-home.static` 里同一把锁的第二条。反向：从名单里拿掉 `dom-smoke` → 锁如期红并点名它；还原后 sha256 逐字节相同。

**顺带排除掉一个诱人的错理论**（写下来，免得下一个人再走一遍）：当时机器上确实残留着 7 个 `msedge.exe`，很容易归到「夹具没收尸」那条老账上。逐个看命令行才发现 —— **全是用户自己的 Edge 后台进程**（真机 profile `…\Microsoft\Edge\User Data` ＋ `--no-startup-window --win-session-start`），一个测试 profile 都没有。§5-octies 补的那把收尸锁治的是另一件事，治不了这一条。

**同轮另外两件 flaky 的病历也留下了**（**不在本批治** —— 记着，下次它们再红就有两份病历可对）：

| 件 | 首跑病历 | 读出来的方向 |
|---|---|---|
| `scheduler-ui.browser.e2e.js` | `B3 展开「最近几次」出恰好一行` ＋ `B4 那一行的触发模式是「准时」（实得 mode=undefined 文案「undefined」）` | **不是时序抖动那么简单**：`mode` 实得 `undefined` 且文案直接印出 `"undefined"` —— 要么那一拍的数据还没到就渲染了，要么这条路本来就会渲染 `undefined`。后者是产品 bug，不是 flaky。下次再红先分清这两种 |
| `steer-interrupt.e2e.js` | `(没抓到 FAIL 行:多半是超时或进程被杀,不是断言红)` | 诊断如实说了「它没留下断言红」。超时/被杀要靠墙钟读数定，不是靠猜 |

**治后收口全量：349 pass / 0 fail / 349 ran，真回归 0** —— `dom-smoke` 与 `dom-screenshot` 这一轮都干净了；唯一 flaky 是 `steward-board`（没留下断言红，属 `TIMEOUT_OVERRIDES` 里已登记 300 s 豁免的那条超时族，39 号文 §8 ① 记着撤销条件要在 24 核机器上复测）。

**125 波到此收口**：三刀出门、两笔 harness 债还清、flaky 三批七件治完（五件已转绿、两件留下病历不猜着改）。

## 6. 三件要用户拍板的（**推荐已写在括号里，不回也按推荐走**）

1. **P0 的「最近」有多近**：`aborted`／`stopped` 是终态标记，不带「多久以前」。要么**只要目标处在停止终态就一律不自动动手**（推荐：简单、没有时间窗要调、也符合「停了就是停了」的直觉），要么加一个时间窗（比如 10 分钟内按停才拦）—— 后者需要一个「什么时候停的」的时间戳，班组有（`pauseRequestedAt`），线程头没有，就要加字段，与 §4 冲突。
2. **P2 的徽标印在哪**：2.0 线程的工具卡（推荐：用户最常看见的地方，且 124-P3 的徽标模具现成）／管家转述里也印一份（推荐：**本波只钉负向锁**「管家转述不许把缓存说成最新」，正向徽标等 P2 落稳再说）／两处都做完整版（费两倍，不推荐）。
3. **J09 与 T03 本波做到哪** —— ~~推荐本波只做确定性那一半、真模型样本另立一刀~~ → **用户 2026-09-15 拍板：真模型盲评就在本波做，直接调本机已配好的端点 —— provider `deepseek`（`https://api.deepseek.com`）、模型 `deepseek-flash`。** 于是 T03 与 J09 的真模型那一半回到本波范围，成为 **P4**：成对任务、重复运行、盲评；密钥从本机 `config.json` 现读现用（不落进夹具、不进日志、不进提交），夹具仍走 `self-isolate-home` 的临时家。

**P4 的端点已当场探过（2026-09-15，两发实调，密钥不落盘不入日志）**：`POST https://api.deepseek.com/chat/completions`，`model: "deepseek-flash"` → HTTP 200、595 ms。**一个坑先记下来：它是带思维链的模型** —— 第一发给 `max_tokens: 16`，16 个 token 全进了 `reasoning_tokens`，`content` **恒为空字符串**；给到 600 才拿到正文，返回体里 `content` 与 `reasoning_content` 两个字段并存。P4 的盲评夹具据此定两条：① 每发预算按「思维链 ＋ 正文」给，不按正文长度给；② 判分只读 `content`，`reasoning_content` 一律不入盲评样本（它是过程，不是答案）。

**前两条按推荐落定**（用户同上「按你推荐的来」）：① 停止判据**不加时间窗** —— 只要目标处在停止终态就不自动动手；线程侧那条账随下一回合落定自然翻新、班组侧随重新拉起翻新，都不粘手（已由 P0 的 C1 钉住）；② 时效徽标先印 2.0 线程工具卡，管家转述面本波只钉负向锁。

## 7. 不做的（登记，别在本波长出来）

1. ~~**T03 歧义追问的真实模型样本** ＋ **J09 的真模型那一半** —— 独立一刀~~ → **已作废（用户 2026-09-15 拍板本波就做，走 `deepseek-flash`，见 §6 ③）**，落成 P4。
2. **三张失败表收成一张** —— `ERROR_CLASSES`（回合／节点层）与 `classifyRuntimeToolFailure`（单次工具调用层）是**两个层的两套词汇**，不是重复造轮子；前端那 6 条是 `ERROR_CLASSES` 的子集。本波只接管家这条断链，**统一词汇是另一件事**，要先有「同一次失败被两套词各叫一次」的真样本再说。
3. **`runtimeFailureTelemetryV1` 翻默认** —— 那是遥测开关，翻它要有本机样本与费用读数（20 号文那套证据门），不搭本波便车。
4. **自动升档／自动切模型**（E02）—— 35 号文已排到 128+，本波只加锁不开路。
5. **`web_search` 面的时效** —— P2 只做 `web_fetch` 的缓存面（那里有 `ts`）；搜索结果今天没有可信的抓取时间，要补得先定来源，**开工前 grep 一遍再决定要不要并进 P2**。

## 8. 退出门（35 号文 §2 给 125 的是 J02／J07／J09，逐条如实口径）

| 编号 | 原文（41 §9.3） | 本波落点与预判 |
|---|---|---|
| **J07** | 用户停止任务，恢复逻辑随后收到失败事件 ／ 不自动重启；明确保持停止 | **P0 正中靶心**，判据见 §5(a)(b)(c)；「网络失败零自动付费升档」那半句由 §4 第三把锁钉住 |
| **J02** | 无网时要求「最新进展」 ／ 清楚说明时效能力，提供本地结果或待查选项，不伪装联网 | **P2 覆盖 `web_fetch` 缓存面**（「不伪装联网」那半句 `:1578` 的真探针已经在做）；`web_search` 面见 §7 ⑤ —— **覆盖不全就如实标「部分过门」** |
| **J09** | 两个来源互相矛盾，摘要器压缩历史 ／ 分歧及关键来源仍可回查 | **部分过门（§5-sexies）**：真模型 18 发里 17 发分歧仍可辨认、17 发关键实体全留 —— 但 17/18 ≈ 94% 够不到「零违例」，故如实标部分。**零代码改动**（证据不支持「系统性抹平」）；「关键来源可回查」那半句由既有 `rehydrateObservation`／rawRef 承担 |

## 9. 开工三步

1. **核基线**：`node ruyi-workbench/app/build.js --check`、`node dev-harness/module-dependency-graph.js --check`、`node dev-harness/run-all.js --fast`。
2. **重 grep 四处落点**（本文行号会过期，纪律 1）：`13p:226 stewardSelfServeGate` 的闸门清单、`13l:263 stewardImplRunAction` 的两道判定、`13i:439` 那句摘要、`11-native-tools.js:1576` 的缓存回落。
3. **先立锁再改码**（§4 三把）：判据唯一、表唯一、值域唯一 —— 三把锁是这三刀「零新字段」能成立的前提，**先有锁，实现才不会哪天悄悄开始说谎**（124-P1 的单写入口锁就是这么用的）。
