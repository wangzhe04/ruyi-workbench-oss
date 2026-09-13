# 32 · 交接单与下一批刀（2026-09-09 出稿；117s 收口之后）

> **这份文档是下一个 agent 的入口。** 先读 §0，再按 §2 的顺序取刀。
> 每把刀都写了：面、独占文件、判据、验收、以及**已知会撞的锁**。派单前必须按 §4 的纪律核一遍行号。

---

## 0. 合并与补跑：**已完成**（2026-09-09，主会话亲做）

> ### 0-bis 二次收口（2026-09-09 夜，117t 之后）——**读这一段，上面那段是 117s 那次的记录**
>
> 117t（T1 拆 13g ＋ F1/F4/F2/F3/F5a/F5b「线程即频道」＋ 工具参数 bug）已全部入库并合并，
> **master HEAD = `7740ffd`**，`build --check` 新鲜，主树 `git status --porcelain` 仅两个一贯不入库的本地产物。
>
> - **全量回归（隔离 worktree，`--parallel 4`）**：**317 pass / 6 fail / 6 flaky**（上一波 311/12/11，抖动件减半），
>   六条红逐条串行复验，**真回归 0 条**；定性见 27 号文 §11.14.1。
> - **唯一那条真红**是 `ui-v4-glass.static` G2（`backdrop-filter` 封闭白名单），F2 和 F5b 各自跑的清单里都没有这件锁——
>   它们跑的是 CSS**载荷**哈希（内容变没变），G2 钉的是**族规**（谁有资格用这个属性），判据不同。**是全量把它翻出来的。**
>   修法不是开口子：底色已改不透明，那层 blur 本就什么都不模糊，删掉即可（`6437fa3`）。
> - **主树三件 realhist 补跑**：74 / 14 / 26，**全 ALL PASS**。
> - **另一会话的在途成果已保住**：主树曾有一份未提交的 T1 侦察稿（逐行归属表 ＋ 9 处撞锁重钉方案），
>   原样提交为 `6911930` 后做真合并（`7740ffd`）：§4 纪律两边条目**全保留**（它那条编为第 9 条），
>   §2.1 原稿原样留下并加作废横幅。**若那个会话还在跑，它手上的 13g 基线已经变了，先 `git pull`。**

117s 全波 22 个 commit 已 `--ff-only` 快进进 `master`，主树 HEAD = **`4e7f73b`**（**已被 0-bis 推进**），工作区干净
（只剩两个一贯不入库的本地产物：`.ruyi-runtime/`、`dev-harness/summary-provider-matrix-live.js`）。
`node ruyi-workbench/app/build.js --check`：**产物与 src 一致（新鲜）**。

合并后在主树补跑的三件 realhist（它们依赖主树本地未入库的 `dev-harness/realhist-fixtures`，
在隔离 worktree 里必红，这也是分支收口那次回归里那三条红的全部原因）：

| 件 | 结果 |
|---|---|
| `observation-recall-realhistory.e2e.js` | **74 PASS · ALL PASS** |
| `observation-recall-replay.e2e.js` | **14 PASS · ALL PASS** |
| `session-notes.e2e.js` | **26 PASS · ALL PASS** |

**下一个 agent 从 §2 开始取刀，不必再做合并。** 若要推远端，`git push` 由用户决定（本会话未推）。

分支收口时的全量回归（隔离 worktree、`--parallel 4`）：**311 pass / 12 fail / 11 flaky / 323 ran / 7 skipped**，12 条红逐条串行复验后**真回归 0 条**，定性见 27 号文 §11.13.4。

---

## 1. 117s 这一波交付了什么（一句话一条，细节见 27 号文 §11.13–§11.13.4）

| 刀 | commit | 做了什么 |
|---|---|---|
| 117q-§8.14 | `01cc904` `0100950` | 43 件 e2e 抓 token 的 `GET /` 预算 1500→5000（**不是竞态**，是重载下 p90=2083ms 击穿预算；30 号文 §8.14 有形状阶梯与同时刻双读的完整证据） |
| 117s-A | `d096cef` | `/api/missions` 行序改「状态优先、其次 updatedAt」（**看板真正吃的是 `13d:772`**，不是聚合那两处）；`steward_thread_new` 给的 title 记 `titleSource:'steward'` 而非 `'user'`，自动摘要因此能跑 |
| 117s-B | `fe67ea3` | 递话后详情页当拍强刷（`syncNow` 相等分支 + `refreshOnce` 归零 `lastPollAt` + live 边沿对称重拉），5 s 内看到「它正在说」 |
| 117s-C | `b134e2a` `7d38ce2` | 管家的话走全仓唯一那条 markdown＋XSS 净化渲染器（注入，非 import）；收件箱触发的回复带「来自线程」小头 |
| 117s-G | `0530d12` | **2.0 视窗里插话不再杀掉别处起的回合**：经典壳复用 13h 那条唯一判据（answer>permission>queued>steer>turn），`10 runSessionTurn` 加 409 后备 |
| 117s-H | `6990c82` `4c0c071` | 交付卡（收件箱那条回复里嵌线程原件，折叠＋看全文）；`done` 事件带 `deliverable{text,chars,truncated,turnSeq,files}` 进提示词；`thread_read` 整行丢改截尾；落盘回执 `trigger` 带来源 |
| 收口 | `a142311` `61a2126` `4221944` | 重钉四把被合法改动挪走的锁 + 同步 9 个新 locale 键进文档目录 |

**用户已拍板的两件设计**：
- 界面方向「**线程即频道**」——设计稿（四块画板：宽屏／窄屏／一条回复的解剖／图标集）<https://claude.ai/code/artifact/5a93ce50-f92e-4200-947b-7bb20dbea57d>，落地切片见 §2.2。
- 管家放权「**除钱之外全放**」——七轴方案见 **31 号文**，落地批次见 §2.3。

## 1-bis. 117t 这一波交付了什么（细节见 27 号文 §11.14–§11.14.1）

| 刀 | commit | 做了什么 |
|---|---|---|
| **T1** | `c5287ba` | `13g-steward.js` **2088 → 358 行**，拆成 `13j`(407)＋`13k`(754)＋`13l`(635)。纯搬家已独立复算：顶层函数名 1471==1471、非注释行多重集 37551==37551、`forwardEdges 67→67` |
| **F1+F4** | `242373a` | 线程卡（色条＋线程名＋五态＋最后动静）＋ 回复定型（首句抬标题、正文折叠、`※` 默认折叠） |
| **F3** | `f3287dd` `aece591` | 右栏「现在这一件」→「现在这几件」，含「就地回答」键 |
| **F5a** | `bd52e5a` | 图标集：权限四档入盾、**停机≠停止**、动作与五态药丸配图标；收编 `ICON_STOP` 孤本（51→68 个字形） |
| **F2** | `f621288` `9fd7628` | 频道条：点一条只看这条；收尾把粘条从半透明玻璃改成**不透明面** |
| **F5b** | `2505acc` `bf3cf42` | 撤回三态（环形倒计时＋固定文字→「⇄ 换一条」→「✓ 已撤回」）；新加 `swap` 字形，两把钉字面量的锁重钉成可证伪的事实 |
| 顺带修 | `fda4e83` | **工具调用参数不是合法 JSON 时会把会话永久卡死**（用户真机 Qwen HTTP 400）：`02` 加三个自愈函数，历史写入点统一过 `providerHistoryToolCalls`；四种畸形（空串/截断/非 JSON/`[1,2]`）验过，良性历史零改动 |
| 收口 | `b922f33` `6437fa3` | 统一重钉经典样式载荷锁（两刀同波各改一个 CSS 层）；删越界的 `backdrop-filter` |

**这一波的两处「执行者比派单稿更好」**（记在 27 号文 §11.14）：T1 的命名与文件数（`13g1-` 会被 `moduleLayer()` 判成 unclassified；注册表必须最后、共享常量必须最前，故必须四份）；工具参数不变量的落点（应在**写历史**处，不在 `rawArgs` 生产处——`rawArgs` 还有三个非请求体读者）。

---

## 2. 下一批刀（按执行顺序；每一刀出门再开下一刀）

### 2.0 前置：合并（§0）—— **已完成，跳过**

### 2.1 刀 T1 · 拆 `13g-steward.js`（**第一刀，必须先做**）

> ## ⚠ 本节已作废：T1 **已经落地**（`c5287ba`，2026-09-09 夜）
>
> `13g-steward.js` 已 **2088 → 358 行**，拆成 `13j-steward-tool-base.js`(407) ＋ `13k-steward-threads.js`(754) ＋
> `13l-steward-ops.js`(635)。纯搬家已由主会话**独立复算**证明：`server.js` 顶层函数名 1471==1471 diff 0、
> 非注释行多重集 37551==37551 diff 0；`forwardEdges 67 → 67`。交付记录见 27 号文 §11.14。
>
> **与下面这份侦察稿的两处实质分歧**（实现方胜出，理由已验证）：
> ① **命名**：稿子用 `13g1-`/`13g2-`，但 SPEC §1 的 `moduleLayer()` 正则 `^13[a-z]?-` 会把 `13g1-` 判成
> `unclassified`；单字母后缀（`13j/13k/13l`）才留在传输层。
> ② **文件数**：稿子分三份，实际必须**四份**——拼接顺序即依赖方向，注册表引用所有 `stewardImpl*` 故必须在最后，
> 共享常量被两族工具引用故必须在最前，二者不能同居一个文件，于是多出 base 层 `13j`。
>
> 下面的原稿**原样保留**：它的逐行归属表与 9 处撞锁清单是那次侦察的真实产出，将来若要再拆
> （如 `13h-steward-runner.js` 2522 行同样超标）仍是可直接照抄的方法样板。**但不要照它动手拆 13g。**
>
> ——以下为第二会话原稿——
>
> **状态（2026-09-09，第二会话）：方案已完整侦察并交叉验证，代码零改动（13g 仍 2088 行原样）。**
> 本节已把「面」落到逐行行号与逐键归属；派单前仍须按 §4.1 核一遍行号（HEAD 若已前进，行号会漂）。
> 该会话未执行的原因是它的长文本写入通道故障（heredoc 在 10 KB 处截断），与方案本身无关。

**为什么先做**：它已 2088 行，`steward-runner.static.e2e.js` ① 「13g ≤ 2000 行」**在 HEAD 上就是红的**（117s 之前就红，本波又加深）。31 号文七轴要往管家里加 8–12 个工具，没地方放。

- **面**：`13g-steward.js`（域路由＋决策日志＋记忆存储＋共享基础设施＋四键注册）＋ `13g1-steward-threads.js`（线程族 11 键）＋ `13g2-steward-ops.js`（观察/决策/记忆/设置/内容族 17 键）。**纯搬家**，零行为改动；新写内容仅限三个文件头、13g 内三条指路注释、13g1/13g2 各自的注册段包装。
- **命名与 manifest**：新顺序 `… 13i, 13g, 13g1, 13g2, 13h, 14 …`（字母序≠manifest 序，13i 仍在 13g 前）。`13g1-`/`13g2-` 不匹配 `dev-harness/module-dependency-graph.js:45` 的 `/^13[a-z]?-/`，须把 transport 行扩为 `/^13[a-z]?[0-9]?-/`（先例：SPEC §1 110-2-pre 扩字母后缀），否则两文件落 unclassified。
- **归属原则**：共享基础设施全部留 13g——门控壳（stewardFail/stewardToolHandler/stewardCtxIsSteward）、小工具、深读预算、回合配额桶（13g1 与 13g2 都引用它，放任何一侧都与 13g2→13g1 的速查判据边成环）、常量块、决策日志写读面、记忆存储、记忆面板六函数、域路由。**stewardImplMemoryVeto 也留 13g**：路由表（POST /api/steward/memory/veto）直调它，搬走会把路由变成前向边；13g2 经后向边注册它的工具键。
- **注册模式**：13g 的 `Object.assign(StewardHooks, …)` 只留四键（handleApiRoutes/stopInbox/inboxRead/inboxState）；13g1/13g2 各自用自己的 `Object.assign` 自注册（13g 对新文件零引用）。每个实现仍经 13g 的 stewardToolHandler 包门控壳（开关→身份→实现），键名与 06i 契约逐条对应。
- **依赖侦察（已验证，勿重开）**：13g 的 95 个 requires 全部来自更早模块；**唯一外部消费者是 13h-steward-runner.js**（11 个符号全后向：`_stewardReadBudget, stewardAppendDecision, stewardBasisOf, stewardFail, stewardQuickThread, stewardRawKind, stewardReadMemoryStore, stewardReadSessionHead, stewardRunResumeTier, stewardThreadPermissionMode, stewardToolHandler`）。拆分后 stewardQuickThread→13g1、stewardRunResumeTier→13g2、其余 9 个留 13g，13h 三条边全后向。13g 对 13h **零符号引用**（逐 token 扫）；13g1 对 13g2 的唯一「引用」是一行注释（stewardImplDecide/stewardImplRunAction）；其余疑似缺失符号全是属性访问（`config.stewardAutoActions` 等）或来自 06i/13i。边统计口径为模块对级（`from->to`）：全部新边后向，**forwardEdges 必须仍是 67，SCC 仍是 1，重复导出仍是 0**；13g 不在现有 SCC 内。policy 的 67 条 allowedForwardEdges 无一涉及 13g/13h，**`module-dependency-policy.json` 不用动**；route-inventory / durable-state-inventory / architecture-contract-snapshots 也不用改（路由全留 13g；决策日志与记忆存储的 owner 仍 13g）。
- **分块映射**（1-based 行号，锚点已抽验；装配脚本必须内置：锚点断言＋「1–2088 每行恰好一个归属」全覆盖校验＋段序无缝拼合校验，任一不符即 abort）：

| 目的地 | 段（闭区间） |
|---|---|
| 13g 保留 | 20–539（路由/基础设施/小工具/决策日志/记忆存储/深读预算）、1529–1544（memoryVeto）、1605–1717（116-2e 横幅＋记忆面板）、1821–1834（回合配额桶）、2046–2053（延迟绑定注释＋四键）＋原 2088 `});` |
| 13g1 | 647–825（threadStatus/threadRead）、928–1223（线程族横幅/recordLaunchOutcome/launchTurn/触发闸/threadNew/Continue/Rename/Permission）、1393–1436（threadNote）、1890–2045（quickAsk/enrichInboxRows/quickClose/quickClosed/quickThread）＋键行 2060–2061、2068–2072、2084–2087 |
| 13g2 | 540–646（观察族横幅/selfStatus/threadsSearch）、826–927（runsStatus/inboxRead/usage/health/auditTail）、1224–1392（决策族横幅/decide/runAction 含 STEWARD_RUN_* 与 stewardRunResumeTier）、1437–1528（记忆族横幅/memoryWrite）、1545–1604（memorySearch/missions）、1718–1820（设置族横幅/configGet/configSet＋内容管理横幅）、1835–1889（playbookDraft/skillToggle）＋键行 2058–2059、2062–2067、2073–2083（2078–2079 注释随 configGet） |
| 丢弃 | 1–19（旧头，改写）、2054–2057（116c 旧注册注释，实质写进 13g1/13g2 注册段包装） |

  13g 三处空洞插指路注释：539 后（总括＋veto 为何留下）、1717 后（配额桶为何留 13g）、2053 后（28 键去了哪）。
- **撞锁（9 处重钉；断言期望值一律不变，只改读取来源）**：
  1. `steward-runner.static.e2e.js`：L47「13h 紧跟 13g」**重钉为 13g→13g1→13g2→13h 链**（保留 L48 13h 在 14 前）；L127 `consumedText` 必须拼 src13g1＋src13g2（否则 relayDeliver/applyThreadTier 被判无人消费而红）；L68-70 consumers 加 13g1/13g2。① 的 2000 行闸拆完**自然绿**。
  2. `steward-tools.static.e2e.js` ⑦：L261 ALLOWED 加 `'13g2-steward-ops.js'`（config_set/skill_toggle 两处 ctx.userPressed 读在 13g2；13g 门控壳剥字段仍在 13g）；L276-278 readers 计数改从 src13g2 数，期望值仍 2；L254-257 注释同步。③ L153 Object.assign 在 13g 仍在 ✓。
  3. `steward-events.static.e2e.js`：D4 L141 重钉为 `files[i+1..i+3] === 13g1/13g2/13h`；D7 L253 改读 13g1（stewardRecordLaunchOutcome、launchedBy×2 在 13g1）。
  4. `steward-guardrails.e2e.js` L737：src13g 改为三文件拼接读取（739 定义在 13g1、740 否定断言、742 计数 ≥3 跨拼接仍成立）。
  5. `thread-arbiter.e2e.js` L634 改读 13g1（threadStatus 的 waitReasonFor）；L638 列表把 '13g-steward.js' 换成 '13g1-steward-threads.js'。
  6. `steward-config-tools.e2e.js` L195 改读 13g2（applyConfigPatch(patch)）。
  7. `steward-content-tools.e2e.js` L177 改读 13g2（setSessionSkillsCore）。
  8. `unit/thread-state-quick-kind.test.js` L143 ALLOWED_NO_FACTS 把 '13g-steward.js' 换成 '13g2-steward-ops.js'，L147 读取同步换（factsUnknown 兜底支在 threadsSearch→13g2）。
  9. `thread-brief.static.e2e.js` L44 steward 变量改读 13g2（只用于 L96 threadsSearch 的 brief 断言）。
- **执行序**：装配脚本（锚点断言→切段→组装→写盘；放 `.ruyi-runtime/` 下一次性产物，跑完删）→ manifest 插两条（note 写「T1(32号文§2.1) 纯搬家」）＋改 13g note → 依赖图正则扩展 → 生成器链整条重跑（30 号文 §8.7）：`build.js` → `module-dependency-graph.js --write` → `--check`（核 67/0/1）→ `route-inventory.js`（产物应零变化）→ `architecture-contract-snapshots.js --write` → `durable-state-inventory.js --write` → `facts-generate.js`（模块数 41→43）→ `build.js --check` 新鲜 → 9 处锁重钉（文件互不重叠，**可并行派单**）→ `run-all.js --fast` → 验收集。
- **验收**：函数体 diff——`git show HEAD:.../13g-steward.js` 与新三文件抽取顶层 function/const 逐个比对，除文件头/指路注释/注册包装外**逐字节一致**；`steward-tools.e2e`、`steward-runner.e2e`、`steward-inbox.e2e`、`steward-deliverable.e2e`、`steward-quick-ask.e2e` 全绿；`run-all.js --parallel 4` 全量回归（3 件 realhist 在主树应绿，红逐条串行复验）。
- **反向验证**：① 从 13g2 注册表注释掉一个键（如 memorySearch）→ `steward-tools.static` ③ 必须红 → 还原；② 两处重钉锁（steward-runner 的链条、steward-events D4）各做「破坏→红→还原」。
- **提交**：commit 由用户拍板（SPEC §4）。用 30 号文 §8.7 的 `git archive HEAD` 干净副本法，不用 `git add -A`；建议信息 `refactor(structure): T1 split 13g-steward.js -> 13g1-steward-threads.js + 13g2-steward-ops.js (pure move, zero behavior)`。2078–2079 注释提到的基础设施键已搬 13g1，属可容忍的历史表述，在 commit 信息里交代。

### 2.2 刀 F1–F5 · 「线程即频道」落地（只动前端，五片可串可并）

> ## ✅ 本节已完成：F1／F4／F2／F3／F5a／F5b **六片全部出门**（2026-09-09 夜，见 §1-bis 与 27 号文 §11.14）
>
> 下面的派单口径原样保留（并行分工表、共享资源归属、共用纪律都是可复用的样板），**但不要再照它派 F 批**。
> 本节唯一还没做的是登记的三笔小债（见 §5）：`deliverableCache` 每回合重复取、看板紧凑行在看板关着时会陈旧、
> 刚起的线程没有「它刚说」。
>
> ——以下为原派单稿——

设计稿是唯一口径。**F1 与 117s-H 的交付卡同一块地**（`steward-conversation.js` 的气泡结构），所以 F1 必须在 H 之上做增量，不许重写。

| 片 | 做什么 | 独占文件 |
|---|---|---|
| **F1** | 线程卡：同一线程连续几条管家的话合成一张卡（头：色条＋线程名＋五态＋最后动静＋模型）；色条四色按线程顺序循环分配，同一线程在所有面恒用同一色；「管家本人」的话无色条 | `public/js/steward-conversation.js`＋`css/views/steward-conversation.css`＋两份 locale＋它的两件 e2e |
| **F2** | 频道条：顶部一排线程 chip，点一条＝只看这条（临时过滤，再点取消）；输入框的目标 chip 跟着切；「全部线程」入口进看板 | 同上（与 F1 串行） |
| **F3** | 右栏从「现在这一件」变成「现在这几件」：按 `/api/missions` 的服务端序（117s-A 已改好）叠小卡；等你的那张可**就地回答**；已收工折成一行 | `public/js/steward-board.js`＋`steward-drawer.js`＋`css/views/steward-board.css` |
| **F4** | 回复定型：首句结论抬成标题；正文超 8 行折叠（交付卡已有折叠，复用同一实现）；`※` 默认折叠 | 与 F1 同文件（F1 之后） |
| **F5** | 图标集：权限四档画进盾牌＋头部改「盾＋档位名＋▾」胶囊；**电源符只给管家停机／唤醒**，线程「停止」用实心方块（今天两处同形不同义）；**撤回三态**（倒计时画成环、文字固定「撤回」；到期「⇄ 换一条」；成功「✓ 已撤回」）；五态各一枚图标进状态药丸；抽屉与线程叠动作全部配图标 | `public/js/icons.js`（图标全部进 `ICONS` 表，**不许再在 `steward-settings.js` 里写第二份路径常量**——今天的 `ICON_STOP` 就是一份孤本）＋`steward-settings.js`＋`steward-conversation.js`＋`steward-drawer.js`＋相关 CSS |

**共用纪律**：
- `app.js` **1279 行，硬顶 1280**（`frontend-domains.static` D45）。再要往组合根加东西，先拆 `app.js`。
- 管家壳「零 `innerHTML`」纪律仍在；markdown 只走注入的 `renderMarkdownInto`（117s-C 建好的那条线）。
- 改任何 CSS 层都会红 `read-frontend-css.js` 的 `LEGACY_STYLES_SHA256`——**同一波只让一片改 CSS**，由它自己重钉并做反向验证（先追加一条无关规则确认消费者真红，再还原确认字节相同）。
- F5 若撞 `steward-settings.static` 里钉 `ICON_STOP` 字面量的锁，**重钉为「停机键与线程停止用的不是同一枚图标」**这种可证伪的事实，不要钉新的字面量。

### 2.2.1 本批并行分工（2026-09-09 派出，三刀同时在跑）

三刀**文件互斥**，同一个 worktree 里并行。互斥表就是它们各自的「独占文件」：

| 刀 | 独占 | 绝不碰 |
|---|---|---|
| **T1** 拆 13g | `src/13g*.js`、`manifest.json`、`module-contracts.json`、`server.js`、生成器链产物（`docs/architecture/*`、`facts.json`）、它要重钉的 `*.static` 锁 | `public/` 一律不碰 |
| **F1+F4** 线程卡与回复定型 | `public/js/steward-conversation.js`、`css/views/steward-conversation.css`、四份 locale（含 `docs/i18n/locales`）、`steward-conversation.{e2e,static.e2e}.js` | 看板／抽屉；`read-frontend-css.js` |
| **F3** 右栏「现在这几件」 | `public/js/steward-board.js`、`steward-drawer.js`、两份对应 CSS、它们的四件 e2e | 对话区；locale（本轮归 F1）；`read-frontend-css.js` |

三条**共享资源**的归属，派单时就定死，否则必撞：
1. **CSS 载荷锁 `LEGACY_STYLES_SHA256`**：F1 与 F3 都改 CSS，**两刀都不许碰它**，各自的 `live-full-text.static` F3 与 `frontend-domains.static` D51 预期红；**主会话在两刀都落地之后统一重钉一次**（先例：117r 的 `72873e4`）。
2. **`facts.json` 的 e2eCount**：只有 T1 会跑生成器链，所以**这一轮谁都不许新建 e2e 文件**，前端两刀只准扩既有件。
3. **locale**：本轮只有 F1 能写；F3 需要的新键由它在报告里给出 key＋中英文，主会话补。

**教训来源**：117s 那波三刀并行时，G 与 H 前端同时往两份 locale 里写键，H 只能用 `git apply --cached` 挑出自己那一半才提交得成——归属先定死，比事后拆干净。

### 2.2.2 F5 拆成两半（2026-09-09，用户已确认撤回那条）

用户对着「现在每秒把整段文字换成『撤回 9』『撤回 8』、到期又无声变成『换一条』」确认了**「对，就是这个」**，
所以 F5 的撤回三态按设计稿做：**环形进度随秒消退 ＋ 文字固定「撤回」**（宽度不跳）→ 到期「⇄ 换一条」（图标变化即过渡）→ 成功退成灰字「✓ 已撤回」。

F5 与 F2 在 `steward-conversation.js` 上撞车，故拆两半：

| 半 | 面 | 何时派 |
|---|---|---|
| **F5a** | `icons.js` 词汇表（**收编 `steward-settings.js:95` 那份孤本 `ICON_STOP`**）＋头部盾牌四档胶囊＋停机改电源符＋抽屉／看板动作与五态药丸配图标 | 已派（与 F2 并行，文件互斥） |
| **F5b** | **撤回三态**（`steward-conversation.js` ＋ 它的 CSS ＋ locale） | F2 出门后派 |

F5a 的三条硬约束：① 一份词汇表，`grep "M12 3a9 9" public/js/` 事后必须零命中；② 图标**不是唯一信号**，档位名永远同时在场，
`#stewardStopBtn` 的可访问名一字不动；③ 五态图标由**既有**状态值派生，不许出现第二份五态枚举（这个模具本仓已经栽过四次）。

### 2.3 刀 E 批 · 管家放权（**31 号文**是完整方案，这里只给执行序）

三批，每批出门再开下一批。**第一批**（用户当下用得上）：

1. **E-手**（31 号文 §2.3）：工作区候选表（只读，`config.workspaces[].path` ＋ 新可选 `note`）进管家上下文；`steward_thread_new/quick_ask` 的 `cwd` 必须是表内之一或 `~`，**13g 校验，表外直接 `invalid_request`**；`recentWorkspaces` 不进表。顺带：按任务给线程开桌面权限（`steward_thread_permission` 加 `capabilities:{desktop}`）。
2. **E-嘴**（§2.4）：`steward_notify` → 桌面桥 `show_notification`；只在 `needs_you`／`failed`／`done` 且**用户不在壳里**时叫；`stewardNotifyPerHour` 默认 6 熔断；点通知＝回壳并聚焦那条线程。**IM／邮件本波不做。**
3. **E-时间**（§2.1）：与 **29 号文 119a–119d** 合并推进（119d 切片里本来就有 `steward_schedule_*` 工具面）；补「守望」型任务（线程进某五态即触发，触发源就是 13i 事件流）与提示词规则。

**第二批**：E-眼睛（§2.2，含**污染规则**——它是第三批的前提）→ E-代答（§2.5）。
**第三批**：E-记忆（§2.6）→ E-编排（§2.7）。

**四条红线**（31 号文 §1，任何一轴不许越）：手永远经线程；围栏与密钥永远 forbidden；钱不放；**读过外界内容的那一回合，所有写动作降级为提议**。

### 2.4 其它排队中的波次

29 号文 119（Cron，与 E-时间合并）→ 28 号文 118（新手引导）→ 26 号文 114（ASR）→ 25 号文 111（压缩策略 v2）→ 23 号文 107（发布批准点）。

**另立一把小刀（用户拍板①的另一半）：「冷启动为什么要 6 秒」。** 闸已抬到 7500（`perf.e2e.js:22`，带实测范围注释），但本机 `/health ready` 实测 5506–6282 ms，5 秒的承诺没有兑现。**起点是这条事实**：机器空闲时 `perf.e2e` 单跑实测 **4229 ms**（在原闸 5000 之内），5506–6282 只出现在 `--parallel 4` 全量回归里——所以「6 秒」至少一半是回归负载，不是纯冷启动。先分清「负载下变慢」与「真慢」：空闲重复 5 次取分布，再量启动各阶段耗时（`ensureDirs` → 读 config → 模块加载 → 监听）找大头。查清后若回到 5 秒内，把闸改回去。

---

## 3. 拍板记录（2026-09-09 六条已拍完；2026-09-10 新增第 7 条，**待拍板**）

1. ~~**撤回按钮「显示有点问题」具体指什么**~~ —— **已解决**：用户对着「每秒把整段文字换成『撤回 9』『撤回 8』、到期又无声变成『换一条』」确认了「对，就是这个」，F5b（`2505acc` `bf3cf42`）已按三态做完。<br>原文留档：`steward-conversation.js:830/834` 每秒换整段文字（locale `stewardShell.chat.undoCountdown`），数字跳、按钮宽度跟着跳；到期无声变「换一条」（`:883`）。
2. ~~**冷启动 5 秒断言**~~ —— **已拍板（2026-09-09）：抬到 7500 ms ＋ 立一刀去查。** `perf.e2e.js` ② 本机实测 5735–6282 ms，阈值骑在真实耗时上、时红时绿。抬闸时须在断言旁把「2026-09-09 实测 5735–6282 ms」写成注释。**抬闸不是承认变慢可以接受**，是把守不住的闸换成守得住的闸 ＋ 一笔记在账上的债；一道时红时绿的闸只会训练所有人忽略红。「冷启动为什么要 6 秒」单独立刀。
3. ~~**管家回复长度**~~ —— **已拍板（2026-09-09），但结论不是我建议的那个。** 我建议「结掉，不动数字」；用户接受不压数字，同时指出我没看的那一半：**问题不在长度定多少，在于「怎么变短」**。今天是两种最差做法各占一处 —— 后端 `13h:536/548` **裸 slice 硬切字符**（连省略号都没有），前端 `finishSay()` **折起来让用户再点一次**。两者都把「让它少说」的责任推给了运行期和用户，而那本该是提示词的事。
   落成 **117y**（27 号文 §11.18，三刀）：S1 后端拆 `STEWARD_SAY_TARGET=600`（提示词请求）与 `STEWARD_SAY_CEILING=4000`（病态载荷天花板），触顶也只在句末标点处切并明说；S2 提示词加「把话说完整，宁可少说一件事，也不要说半句」，并顺手给 `steward.rules` 补上它一直没有的字数闸；S3 管家正文不再折叠（**交付卡的折叠保留** —— 那是线程的交付原文，实测能到 2687 字）。
   注：`STEWARD_SAY_MAX` 在 `13h:49` 不是本文原写的 `13h:45`（行号已漂）。

---

4. **117w-W1 与 31 号文 E-手** —— **已拍板（2026-09-09）：合成一刀。** 两者是同一件事的两半（E-手负责「选」，W1 负责「有得可选」）。分开做会先落地一个「候选表里只有主目录一项」的 E-手，空转一轮还要回来改。合并后这一刀直接解掉用户最早报的「同一个文件夹被占着」。

5. **`head.summary` 结构修** —— **已拍板（2026-09-09）：排，但排在 P3 之后，不插队。** 看板「它最后说」／管家总览行／管家转述走的是 `13d:539 -> 13h:262/345 -> 06i:143`，完全不过 `segments`；117v-V3 的提示词规则只是**概率修**。结构修动的是落盘数据的生成口径，风险面比 UI 改动大，值得单独一刀。V4 已把提取规则写成纯函数，搬过去有现成的一份。

6. **CLI 引擎拿不到「结论先行」层** —— 用户「不反对就照办」：折进拆 13h 那一刀顺手还掉（`05-claude-engine.js:234` 只拼四层进 `--append-system-prompt`），补一条两引擎对称的锁。

7. **桥接桌面工具经不经 `allowDesktopTools` 闸的修法判据** —— **待拍板（2026-09-10，E-手②b③ 登记）**。核锁已钉死事实（27 号文 §11.21.8）：桥接工具没有 desktop 档，full 模式注入与 auto `tool_load` 显式拉入都**可达且不看闸**（已知洞，guardrails R4/R5 反向钉住，谁修好当场红）。修法三选一：① 按包名 `desktop` 滤（`07:375`，会把所有未知外部工具一起滤掉）；② 按账本 kind（`02:2070` 只盖写族，漏 screenshot/ocr）；③ 按服务器身份 `ai-computer-control`（最贴产品口径，但是一份新判据）。**不拍就维持「已知洞」现状。**

8. ~~**第 121 波「一台两视」五条拍板**~~ —— **已拍板（2026-09-10 晚，用户「其余按你推荐的来」）**：① 视角命名「管家｜工作台」；② 线程索引口径「在途∪今天∪最近 30∪管家盯的」；③ `stewardEnabledV1` 默认 `true`；④ 交办台通知策略层改名 `notify-policy.js` 保留；⑤ `13e-pretender-index.js` 本波不改名。同轮追加四条设计修订（34 号文 §0.1）：管家视角以**任务**为单位、文字预算、费用只在「用量」页、切换动效走 View Transitions；「＋」两视角两义（管家＝新任务、工作台＝新线程）。**可开工**，入口 34 号文 §9 K0。

---

## 4. 纪律（本波用事故换来的，派单前必读）

1. **派单稿写的行号会过期，而且本波被执行者证伪了 8 处。** 全部是「我指的落点不是真正生效的那处」或「那一行已经被别的刀挪走」。**派单前 grep 当前 HEAD 核一遍**；派单稿里写「我认为在 X:123」，执行者有权证伪并改对——**执行者拒绝执行比完成度值钱**（30 号文 §8.12）。
   典型三例：看板吃的排序在 `13d:772` 不是聚合那两处；`09-workflow.js:1347` 答不了 409（真咽喉是 `10 runSessionTurn`，且有个孪生 `05-claude-engine.js:139`）；「把纯判据挪到 06i」不可达（06i 看不到 04/09/13h 的状态，正解是 `StewardHooks` 迟绑定）。
2. **多 agent 共用一个 worktree 时，索引是共享的：提交必须写 `git commit -- <显式路径>`**（只提交这些路径，无视索引里别人已 `add` 的东西），**绝不能** `git add <路径> && git commit`——后者提交的是整个索引，会把别的 agent 正要提交的文件一起扫走（2026-09-09 主会话就这么把 T1 的 24 个文件扫进了一次 docs 提交；内容没坏，但那条刀的提交信息永远没落地，事后要拆提交才修得回来）。
3. **提交前核 HEAD。** 本波一个执行者的 `git commit` 因参数笔误中止，那一瞬间 HEAD 已被别人推进；它的索引建在旧 HEAD 上，若提交成功会把上一刀整份回退（117m 那次事故的同一个模具）。用 30 号文 §8.7 的 `git archive HEAD` → 只复制自己的文件 → 构建 → `hash-object`/`update-index` 流程，**并在 `update-index` 前再核一次 `git rev-parse HEAD`**。
4. **派单稿里关于并发的陈述，派出那一刻要重新核；CSS 载荷哈希一律从 `HEAD` 算，绝不从工作区算。** 2026-09-09 主会话给 F2 写了「现在没有别的 agent 在改代码／你是唯一动 CSS 的」，然后又派了 F5a，两刀都改 CSS——F2 第一次按工作区算哈希，把 F5a 尚未提交的三个 CSS 层一起钉进了锁。它自己 `git status` 发现、改成按 `git show HEAD:` 逐层重算、并用「能否从 HEAD 逐字节复现出上一枚 pin」验证方法之后才下手。那个值最后碰巧是对的（F5a 随即提交），**而「碰巧对」比错更危险**。
5. **锁不要钉「文本长什么样」，要钉「哪件事必须成立」。** 本波又有四把锁因为合法改动而假红（钉行号、钉一行的写法、钉行数、钉字面量）。新加断言**必须反向验证**（故意破坏 → 确认真红 → 还原）：本波出过一条「写的时候以为在守门，其实门是画上去的」假绿断言。
6. **回归的红要逐条串行复验。** `--parallel 4` 下大量红是「起不来服务」的级联；`run-all` 日志是交错的，真红只看结尾「失败件 tail」的标题。**别用 8 路。**
7. **补丁脚本吃反斜杠**：heredoc → python/node 里写正则时 `\b`／`\(` 会被吞或告警，断言可能永远为真且肉眼看不出。改文件优先用 Edit 工具；非用脚本不可时，写完 `cat -A` 验字节 ＋ 反向验证。**第四个样本（K8，2026-09-12）**：后果不止「正则不对」——`\b` 经 heredoc 变成**裸 0x08 写进源码**，`sed -n` 打出来长得一模一样（终端把退格渲染掉），只有 `cat -A` 看得见 `^H`。主会话每刀复核现在固定做一遍「改动文件 0x00–0x1f（除 \n \t）与 \r 扫描」（`node -e` 逐字节），执行者交付前也要做。
8. **隔离 worktree 跑回归**：3 件 realhist 件必红（fixture 只在主树），`.gitignore` 的 CRLF 是 autocrlf checkout 产物（master 里是 LF），都不是回归。
9. **长文本写入会截断（2026-09-09 事故）**：一次 ~12 KB 的 heredoc 在 10 KB 处无声截断，装配脚本残件差点入库。生成/装配类脚本：优先 Write 工具一次落盘（无 shell 传输层）；非用 heredoc 不可时切块 < 4 KB 追加、每块 `wc -c` 核累积字节，跑之前先验语法（`node --check`）。

10. **改了 `src/` 就跑整条生成器链，不要自己判断「这次应该只需 build」。** 依赖图产物记的是**每条边所在的行号**，
    所以**在 src 里加减任何一行（哪怕只是一行注释）**都会让 `module-dependency-graph.json` 过期，
    不止于增删模块或改路由。两次实测：117x-M1 只在 `buildUsageSummary` 上方加了一行注释，三条边行号整体 +1
    （`465→466`／`471→472`／`474→475`），`--check` 当场 FAIL；主会话随后给兜底分支加了三行注释，同样 FAIL。
    **这条是用两次真红换来的，而第二次犯的人正是刚写下第一条的人。**

11. **补丁脚本与 Edit 参数里的转义，是本仓第三类静默损坏（前两类：吃反斜杠、吃长文本）。** 三个已实测的样本：
    ① 117x-M1 想用一个 NUL 当 Map 键分隔符，Edit 参数被当 JSON 转义解释，**真往 `src/00-boot.js` 写进了 4 个裸 NUL 字节**
    （`cat -A` 显示 `^@`，而且此后再也 Edit 不中那两行）；它改用 `JSON.stringify([a,b,c])` 做键绕开。
    ② 主会话用 Python `io.open(path,"w")` 改文档，Windows 下 `newline=None` 把整份 2000 行从 LF 翻成 CRLF，`eol-policy.static` 当场红。
    ③ 主会话用 heredoc 写**上面这条纪律本身**时，heredoc 吃掉一层反斜杠，把 `x00` 前面那个反斜杠序列变成了真 NUL 写进文档。
    **结论**：写文件优先用 Write／Edit 工具（不经 shell 传输层）；非用脚本不可就用 node（`fs.writeFileSync` 按字节写，
    不像 Python 会翻行尾），并且**写完逐字节核一遍**（NUL 用 node 扫，别用 `grep`——空模式会把每一行都算成命中，那个数字是假的）。

12. **06i 里新增带参数的纯函数，参数名不能与更早模块的顶层符号同名。** `module-dependency-graph.js` 把裸参数名当跨模块符号：
    117y-A 给 `stewardTrimSayAtSentence` 起参数名 `text`，命中 `00-boot` 的顶层 `text`，生成 `06i → 00-boot` 一条边并把 06i 拽进 SCC，
    `--check` 红，而错误信息是「新增循环边」——**指不到参数名**。改名 `value` 后恢复。加一个纯函数这种最无害的改动也能红，记住这条能省一次排查。

13. **搬/改任何符号之后，必须逐一 grep 该文件里所有引用点，确认符号仍有来源。** 本波实测事故：把 `buildModal` 一族从
    `interaction-prompts.js` 搬进新叶子 `js/modal.js` 后，**返回面里仍引用 `focusFirstInteractive` 却忘了加进 import** →
    调用 `createInteractionPromptsDomain()` 当场抛 `ReferenceError` → **整个前端不初始化**，`steward-drawer`/`steward-board`/
    `steward-settings` 三件真浏览器 e2e 全崩。**而 `run-all --fast` 是 70/70 全绿**——因为 `--fast` 全是静态件，一件运行时都不跑。
    两条结论：① 搬符号后用 `grep -n '<符号名>'` 数一遍引用点；② **改了前端 JS 就必须跑真浏览器 e2e**（`steward-*.e2e.js`／
    `dom-contract.e2e.js`），`--fast` 绿不等于没坏。修复 `a1c7289`。

14. **整台机器同一时刻只许一个回归在跑；两棵树更不行**（2026-09-12 凌晨，K5 ∥ 治抖动批实测）。e2e 端口是**按件固定**的
    （run-all 的「端口审计：跨文件零撞车」只保证同一棵树内不撞），主树的 Opus 全量与 worktree 里的 Sonnet 全量同时跑，同一件在两边
    撞同一端口 → 大面积 `workbench listening`／`ECONNREFUSED` 级联（执行者报 74 红并归因 TIME_WAIT，其实是这个），**两边结果全作废**；
    同一棵树里「串行单跑一件」与「全量并跑」重叠也一样。并行派两位 agent 时：主树那位跑全量，worktree 那位只跑静态件与自己改的件，
    全量留到 cherry-pick 之后在 master 跑一次。纪律 6 的「别用 8 路」是老机器的经验：24 核机器 8 路可用（用户拍板），红件仍逐条串行复验。

15. **换机器第一件事核 `git config core.autocrlf` 与 `git ls-files --eol`**（2026-09-11 晚实测）。新机器 `autocrlf=true` 把 118 个文件
    检出成 CRLF/mixed（索引仍 LF），`eol-policy.static` 红、`--fast` 62/63，而 `git status` 全程干净。修法：`git config core.autocrlf false`
    → `git ls-files --eol | grep -E 'w/(crlf|mixed)' | grep -v eol=crlf` 列出 → **先 `rm` 再 `git checkout --`**（不删的话 checkout 认为
    没变不会重写）；9 个 `eol=crlf` 属性文件（.cmd/.ps1/.bat）本来就该 CRLF，其中 mixed 的同法重检出。另：直跑 `node dev-harness/x.e2e.js`
    不经 `fixture-home-guard`，读写的是真机家目录——**病根已查明**（2026-09-12）：产品启动期把 `externalMcpServers` 同步进用户全局
    CLI 配置（`syncMcpServersToClaude` 走 `claude mcp add-json` 写 `~/.claude.json`；`syncMcpServersToKimi` 改 `~/.kimi-code/mcp.json`），
    凡直跑过注册 fake-mcp 夹具的件（`mcp-ops-closure`／`mcp-config`／`capabilities`…）都会把 `stdio-hang`／`dummy-tool`／`confl-mcp` 这些写进
    真机配置——本机清出 14＋9 条（各留 `.bak-<时间>` 备份）。**修法**：`dev-harness/lib/self-isolate-home.js`——直跑时若家目录还是真机家，
    先把本进程 USERPROFILE／HOME 换成 run-all 同款的临时家；起初只给 29 件会注册 MCP 的件装，K8 复核发现**导入方向同样污染**（直跑 `websearch` 时服务把真机 `~/.claude.json` 里剩下的 `loca_*`／`godot-ai` 导进来，工具清单被拖坏，执行者据此误判「基线红」）——于是**全部 262 件运行时 e2e 第一行都 `require` 它**（shebang 文件放第二行；run-all 跑时零动作）。新建 e2e 也要带这一行。
    全新 HOME 首启被 `detectDesktopMcp` 的 python 探针拖到 6.5 s 那笔已用磁盘缓存修掉（34 号文 §13.10）；量启动慢用 `--require`
    预载把 `spawnSync` 逐条计时，比猜快。
16. **真浏览器件跨树也互斥；语法检查只用 `node --check`**（2026-09-13 122 波合并实测）。① `lib/browser-cleanup.js stopRuyiTestBrowsers()` 不传 profile 时按 `--user-data-dir=…ruyi-` 正则**杀全机所有测试浏览器**（`focus-rail.browser`／`rail-pocket.browser`／`walkthrough-round1.browser`／run-all 每件收尾都这么调）——另一棵树里正在跑的浏览器件会被连带杀掉，`cdp.evaluate` 从此永久挂住（L2 在主树跑 `steward-conversation` 时被 L1a 的件杀了 Edge，20 min 无输出）。纪律 14 的浏览器版：**并行派刀时只允许一位执行者跑真浏览器件**，其余留给主会话合并后跑。② `node -e "require('./dev-harness/run-all.js')"` 等于把全量跑起来（run-all 加载即执行）；冲突解完只用 `node --check <file>`。36 号文 §5.2／§5.4 各记了一次。

---

## 5. 已登记、本波明确不动的债

| 债 | 现状 | 何时还 |
|---|---|---|
| ~~`13g-steward.js` 2088 行~~ | **已还**：T1 拆成 358＋407＋754＋635（`c5287ba`） | ✅ |
| ~~`13h-steward-runner.js` 2522 行~~ | **已还**：T2 拆成 13m 218 ＋ 13n 556 ＋ 13o 353 ＋ 13p 549 ＋ 13q 626 ＋ 13h 376（`9593b82`）。纯搬家由主会话独立复算：1753==1753 非注释行多重集相同、129==129 顶层名、forwardEdges 67→67。交付记录 27 号文 §11.20 | ✅ |
| ~~`01-config` 对 `workspaces` 的 20 行帽子吞掉派生行~~ | **已还** W1④ `b9453c7`：帽 64、派生超帽 fail-closed；交付记录 §11.19.9 | ✅ |
| ~~`STEWARD_ACTION_HOOKS` 没有 `steward_thread_permission`~~ | **已还**：E-手②b ① `d3ceccf`（挂钩＋人话标签＋前端 `STEWARD_TOOL_LABEL_KEYS`＋两个 locale 键）；交付记录 27 号文 §11.21.8 | ✅ |
| ~~PATCH `desktopTools:true` 不要 `confirm:true`~~ | **已还**：E-手②b ② `0af605a`（与切全自动同一个 409 `permission.confirm_required`；清除与 false 不要确认）；交付记录 27 号文 §11.21.8 | ✅ |
| **`allowDesktopTools` 只滤两个原生工具，桥接工具不经它** | **已核**（E-手②b ③ `392f82a`）：桥接工具没有 desktop 档；full 注入与 auto `tool_load` 拉入都**可达且不看闸**——已知洞被 R4/R5 反向钉住，谁修好当场红 | 修法判据（按包名／按账本／按服务器身份）是**拍板项**，见 §3 第 7 条；拍完后按判据滤并翻转 R4/R5 |
| ~~夹具设 `RUYI_HOME` 不设 `USERPROFILE` 会摸真机主目录~~ | E-手② 执行者的夹具在真机 `~/Ruyi/` 建过一条测试目录（已清）。**已还**：A 刀 `37011b5`——run-all 单点注入临时 HOME/USERPROFILE（真机家走 `RUYI_REAL_HOME`）、`--require` 守卫装进每件夹具、静态钉 120 处 spawn 判据＋4 个真子进程探针；反向验证（不 spread → 真红 → 逐字节还原） | ✅（残余：直跑单件不经 run-all 守卫不生效，另立刀） |
| ~~派生的「占位＋建目录」不是原子的~~ | W1④ 登记：两条线程同时过预检 → 行被截；且 `stewardRegisterDerivedWorkspace` 吞掉写失败。**已还**：A 刀 `88d63ac`——`stewardClaimDerivedWorkspace` 把帽检查＋建目录＋append＋落盘坐进一次 `mutateConfig` 临界区，`landed` 后置校验，失败回滚本次新建目录；P7（并发）/P8（落盘失败）锁＋静态 ⑪ 重钉 | ✅（登记：单摘帽复检时 P7/P8 仍绿——`landed` 兜底，只被静态 ⑪ 钉住） |
| ~~（原行保留供回看）~~ **`01-config` 对 `workspaces` 的 20 行帽子吞掉派生行** | `if (clean.length >= 20) break;` 两处；用户已有 20 个工作区时 W1 派生的那一行下次 normalize 被截掉，线程 cwd 指向表外目录、再用被拒；候选表折叠句生产不可达 | **W1④，合并后第一刀**：帽子抬 64、派生超帽 fail-closed 拒开并明说，锁「要么行落盘要么拒」 |
| 「真回合请求体里含 X」类锁缺一个捕获面 | 117y-A 与 W1③ 都登记：`steward-runner.e2e`／`capabilities.e2e` 没有现成的请求体捕获，只能钉装配函数 | 下一把动 steward-runner.e2e 的刀补一个捕获面，两条并案 |
| Windows 保留名（`CON`/`NUL`）做标题时派生目录带 `-2` | `mkdir` 失败 → 撞名循环换后缀，结果对、名字怪 | 登记，不是 bug |
| `03-bridge-guard:122 normalizeCwd` 成了第二份 cwd 归一化口径 | 它自带 `os.homedir()` 兜底（既有语义），W1① 刻意没用它 | 不在本波合并 |
| `appendMemorySection` 传空 section 反而把 base 硬截到 limit | T2 登记；当前不可达（调用点有 `if (misSec)`），是「传空毁数据」的形状 | 下一把动 05 的刀 |
| `meta-guard` E/F 组沿用 `runClaudeTurn → runOpenAiTurn` 整段区间 | 横跨 05..09，同模具已让 G 组假绿过一次；目前安全是巧合 | 下一把动 meta-guard 的刀 |
| `README.md:483`「325 e2e (318 default)」陈旧 | facts 是 330/323；meta-guard B 组判据 ≤ actual 故绿 | 下一次动 README 顺手 |
| `app.js` 1279 / 硬顶 1280 | 只剩 1 行余量（F 批六片都绕开了它） | 下一个要往组合根加东西的刀先拆 |
| `deliverableCache` 每回合重复取同一份交付 | F1 登记；正确性无碍，是次数问题 | 顺手还 |
| 看板紧凑行在看板关着时会陈旧 | F3 登记 | 顺手还 |
| 刚起的线程没有「它刚说」 | F1 登记；首回合前无内容可摘 | 顺手还 |
| 重启点补抓 token 未比对 `overlayId` | 30 号文 §8.14 登记：`/health` 已带 `overlayId`＋`x-overlay-id`，抓 token 时没用它判是不是同一个进程 | 治抖动那批 |
| 抖动件 `steward-conversation.e2e` **R7** | 已定名：117l-B2 的分组规则断言，失败的是**夹具形状前提**（缺第二个多行组），不是竖线规则；执行者用 `git archive HEAD` 干净副本复现同红 | 治理抖动那一批 |
| 抖动件 `steward-thread-title.e2e` | 等摘要异步落盘，对负载敏感；单跑绿 | 同上 |
| 30 号文 §8.13 ④ 的 19 个抖动件 | 未治理 | 单独一批；**抖动只能比通过率，不能比单次采样** |
| `steward_thread_read` 不带工具**结果**（只有调用行） | 管家看不到线程跑出来的工具输出 | 若 E-眼睛做了 `steward_thread_artifact_read` 可部分覆盖 |
| 内存态 `lastReply.trigger` 仍是字符串 | `steward-shell.js:277` 靠 `=== 'inbox'` 判要不要追加；只有落盘回执是对象 | 改它要连 `steward-shell.js` 一起改，属 F 批 |
| 06b「转述交付」规则进了 `rules`（易变表）而非 1–6 稳定表 | 英文稳定表 2453/2500 只剩 47 字，静态锁 ③ 钉 ≤2500 | 稳定表要扩容得另立一刀 |
| `steward-board.static` D4 逐字钉 import 行写法 | 33 §4 收编两次撞红：第 4 项用「同一模块两条 import 行」绕开（`8dd4beb`）；第 8/9 项对同形态的 D1/D2 改「并进原 import 行＋重钉名字集」并反向验证（`3312582`/`b41c089`） | 口径统一为后者；D4 本体下一把动看板的刀重钉 |
| `chat-stream-runtime.js`「全篇零 import」纪律＋`copy-path-guard` 两张行号键控表（`ALLOWED_CJK_CODE`/`p17FixedLines`） | 第 6 项 2.0 侧豁免根因（`46e2800`）：vm 直跑单测（`unit/context-compact-trigger.test.js:182`）加 import 即 SyntaxError；行号表双向红。该文件无法参与任何跨文件去重 | 要动它先立专项刀：行号表换内容键 |
| `chat-stream-runtime.js:751/1430` 两处 UTF-16 切半 | 第 7 项（`8fe851a`）只修得 2.0 四处中的两处（agent-workflows/chat-static-renderer）；这两处同根因：零 import＋vm 直跑＋`app.js` 1280 行顶无注入余量 | 随上行同刀 |
| 2.0 侧仍有 12 处原生 `confirm()` | 本波 §11.25 把 **3.0 内**原生 `confirm` 清零（看板／抽屉改走 `js/confirm-panel.js`），但 2.0 侧 `session-experience.js`（5 处）、`agent-workflows.js`（3 处）、`provider-settings.js`、`skills-memory.js`（2 处）、`settings-operations.js`、`app.js` 等仍在用浏览器原生对话框——同一个「危险操作要再点一次」在两壳仍是两种观感 | 下一把前端刀：`confirm-panel` 已备好，逐个改（同步变异步，逐个跑真浏览器 e2e） |
| `buildModal` 有两个形状 | `js/modal.js` 是**对象形**（`{title,body,foot,onCancel}`），`interaction-prompts.js:21` 是**位置形**本地包装（薄壳转调）。两者同名不同签名，新人极易接错 | 下次动 `interaction-prompts.js` 时统一为对象形（调用点约 3 处） |
| `permissionSwitchNeedsConfirm` 无应用代码调用点 | `steward-chips.js` 定义并 export，但 `app/public/js` 内无人调用（chips/settings 都直接读 `STEWARD_PERMISSION_CONFIRM_MODES`）——是「收编未收干净」的残留 | 下一把动 chips 的刀顺手删或接线 |
| 3.0 模型菜单的**视觉容器**仍与 2.0 不同 | 本波统一了「菜单内容构造」（`model-menu.js`）与「开合行为」（`popover.js`），但受「不碰 .css」约束，3.0 仍用就地 `.steward-chip-menu`、2.0 用 body 挂载 `.popover`；两者 CSS 类名与定位方式不同 | 视觉完全一致需一把 CSS 刀（要重钉 `LEGACY_STYLES_SHA256` 载荷锁） |
| `steward-settings.js` 的盾牌菜单尚未收编 | 本波收编了 3.0 的 4 处浮层（模型 chip／头像／※／递送目标），盾牌菜单因与确认机制刀撞文件而留在原地 | 下一把动 settings 的刀 |

---

## 6. 一句话地图

~~（合并已完成）~~ → ~~拆 13g~~ → ~~F1–F5~~ → ~~117v~~ → ~~117x M1/M2~~ → ~~T2 拆 `13h`~~ → ~~117y~~ → ~~W1＋E-手① ①②③（§11.19）~~ → ~~W1④~~ → ~~E-手②（§11.21，全档只提议）~~ → ~~E-手②b（§11.21.8）~~ → **【118 波已收】小刀「先占位再建目录」（§11.19.9 ＋ §11.21.7 ④ 夹具 HOME 守卫：`88d63ac`＋`37011b5`）∥ 33 号文 §4 前端债（`8dd4beb`→`5bdbf93` 共 8 提交；第 11 项 i18n 别名有据跳过——真阻断是非 static 夹具钉死别名键＋动态拼键，实测口径 63/49/33 非 68）**
→ **【119 波已收】2.0/3.0 前端统一（27 号文 §11.25：`9ed054b`→`ee6ee5b`；模型菜单内容＋开合行为共享、3.0 native confirm 清零、术语两壳归一、暂停判据共享件）** → E-嘴（§11.23，通道走已通着的 WebView2 托盘气泡；新建最小在场信号；本仓第一条桌面→页面回话）→ **W2（§11.22，放宽安全边界，不拍不做）** →
→ **【121 波已收（34 号文 §13.15／§13.16，走查第一轮 §13.17）】~~K0 默认入口翻转（`effd3cd`，34 号文 §13.1）~~ → ~~K0b 投影索引空目录守卫（`826504c`，§13.2）~~ → ~~K1 交办台删除＋壳模式搬家（`df4c9cf`→`3e8e65e`，§13.3）~~ → ~~K2a 事件流后端（`e3acedf`→`c215c06`，§13.4）~~ → ~~K3 索引口径＋在场门＋交接（`f0fd655`→`768040b`，§13.5）~~ → ~~K2b 事件流前端（`3c15b97`→`56997a2`，§13.6）~~ → ~~K4 外框＋左栏＋动效（`69a505b`→`2a69a7b`，§13.7）~~ → ~~K5 工作台线程头＋管家条（`630ed97`→`53b43c3`＋复核 `dab5c30`，§13.8）~~ → ~~治抖动批（`af87c79`→`984623c`，§13.9）~~ → ~~K6a 安静卡＋委托一句（`8df45d5`→`c6896f2`，§13.11）~~ → ~~K6b 焦点栏＋任务卡四密度（`19f57e4`→`fc47dd6`，§13.12）~~ → ~~K8 视觉与文案刷新（`7f27792`→`89c6425`，§13.13）~~ → ~~K7 口袋＋接下来（`6109aa1`→`8ac79d2`，§13.14）~~ → ~~整波验收 §13.15~~；**121 波收口，下一波从 34 号文 §14 末的「清障与产品债」清单进**；一台两视（34 号文：K0 壳模式搬家＋默认入口 → K1 交办台删除 → K2a 事件流后端 ∥ K3 索引口径＋在场 → K2b 事件流前端 → K4 外框＋左栏 → K5 工作台线程头 → K6 焦点栏＋安静卡 → K7 口袋）——用户 2026-09-10 六条诉求的整波答复；交办台退役与「2.0 视窗」删除在此波**
→ **【122 波已收（36 号文 §5，master `6b112c5`，2026-09-13）】** ~~L1a 现场保护（J04／J05／J16：applyShellMode 意图序号＋SSE 补发段去重；quiet-card 那 1/3 真相是 setLens 同值早退）~~ ∥ ~~L2 后端三件（mission 起跑存写链内合并／探针挪 listen 后 500 ms／导入 origin 标记）~~ ∥ ~~L3（run-all 每件独立临时家／E3・B-g1 定案／fs-xl・letter-spacing・en-US）~~ → ~~L1b（chip 折行／齿轮一层七项／管家视角向导入口／setLens 早退／U05 跳转链接）~~ → ~~发布 A 打包 v2.7.0（`eac1424`，已推送 `0bade1d`）~~ → **【123 波实施中（37 号文）】M1 后端地基（06j 纯函数／13s 调度器／六路由／测试旗，Opus 主树）∥ M3 顺带清障（Sonnet worktree）→ M2 管家与界面接线 → 全量 → 124 交办与交付贯通（35 号文 §2）**。
**31 号文第一批（手／嘴／时间＋119）** → 第二批（眼睛／代答）→ 第三批（记忆／编排）。

挂起等用户：**冷启动阈值**（放宽＝放宽一道门，产品决定）、**回复长度**（要先量真机 30 条的分布）。撤回显示那条已解决。
