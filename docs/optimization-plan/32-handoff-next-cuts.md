# 32 · 交接单与下一批刀（2026-09-09 出稿；117s 收口之后）

> **这份文档是下一个 agent 的入口。** 先读 §0，再按 §2 的顺序取刀。
> 每把刀都写了：面、独占文件、判据、验收、以及**已知会撞的锁**。派单前必须按 §4 的纪律核一遍行号。

---

## 0. 合并与补跑：**已完成**（2026-09-09，主会话亲做）

117s 全波 22 个 commit 已 `--ff-only` 快进进 `master`，主树 HEAD = **`4e7f73b`**，工作区干净
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
> （如 `13h-steward-runner.js` 2523 行同样超标）仍是可直接照抄的方法样板。**但不要照它动手拆 13g。**
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

---

## 3. 挂起：等用户拍板的三条（**不拍不做**）

1. **撤回按钮「显示有点问题」具体指什么**（用户第九轮走查原话）。我从代码推的是：`steward-conversation.js:830/834` 每秒把整段文字换成「撤回 9」「撤回 8」…（locale `stewardShell.chat.undoCountdown = "撤回 {{seconds}}"`），数字跳、按钮宽度跟着跳；到期又无声变成「换一条」（`:883`）。**F5 已按这个理解出了设计（环＋固定文字＋三态）**，但没有用户确认；派 F5 前先问一句，或让用户给一张撤回按钮出现时的截图。
2. **冷启动 5 秒断言**（30 号文 §8.13 ③）：`perf.e2e.js` ② `cold start /health ready < 5000ms`，本机实测 5735–6282 ms，**阈值骑在真实耗时上**。放宽＝放宽一道门（产品决定），不放宽＝承认冷启动变慢了该去查。**挂起，等拍板。**
3. **管家回复长度**（31 号文之外的 F 小项）：`STEWARD_SAY_MAX = 600`（`13h:45`）要不要再压一档，需先量真机最近 30 条回复的长度分布再定数。117s-H 的结论是**不动它**（转述本来该短，长的是交付本身，交付由交付卡呈现原件）。

---

## 4. 纪律（本波用事故换来的，派单前必读）

1. **派单稿写的行号会过期，而且本波被执行者证伪了 8 处。** 全部是「我指的落点不是真正生效的那处」或「那一行已经被别的刀挪走」。**派单前 grep 当前 HEAD 核一遍**；派单稿里写「我认为在 X:123」，执行者有权证伪并改对——**执行者拒绝执行比完成度值钱**（30 号文 §8.12）。
   典型三例：看板吃的排序在 `13d:772` 不是聚合那两处；`09-workflow.js:1347` 答不了 409（真咽喉是 `10 runSessionTurn`，且有个孪生 `05-claude-engine.js:139`）；「把纯判据挪到 06i」不可达（06i 看不到 04/09/13h 的状态，正解是 `StewardHooks` 迟绑定）。
2. **多 agent 共用一个 worktree 时，索引是共享的：提交必须写 `git commit -- <显式路径>`**（只提交这些路径，无视索引里别人已 `add` 的东西），**绝不能** `git add <路径> && git commit`——后者提交的是整个索引，会把别的 agent 正要提交的文件一起扫走（2026-09-09 主会话就这么把 T1 的 24 个文件扫进了一次 docs 提交；内容没坏，但那条刀的提交信息永远没落地，事后要拆提交才修得回来）。
3. **提交前核 HEAD。** 本波一个执行者的 `git commit` 因参数笔误中止，那一瞬间 HEAD 已被别人推进；它的索引建在旧 HEAD 上，若提交成功会把上一刀整份回退（117m 那次事故的同一个模具）。用 30 号文 §8.7 的 `git archive HEAD` → 只复制自己的文件 → 构建 → `hash-object`/`update-index` 流程，**并在 `update-index` 前再核一次 `git rev-parse HEAD`**。
4. **派单稿里关于并发的陈述，派出那一刻要重新核；CSS 载荷哈希一律从 `HEAD` 算，绝不从工作区算。** 2026-09-09 主会话给 F2 写了「现在没有别的 agent 在改代码／你是唯一动 CSS 的」，然后又派了 F5a，两刀都改 CSS——F2 第一次按工作区算哈希，把 F5a 尚未提交的三个 CSS 层一起钉进了锁。它自己 `git status` 发现、改成按 `git show HEAD:` 逐层重算、并用「能否从 HEAD 逐字节复现出上一枚 pin」验证方法之后才下手。那个值最后碰巧是对的（F5a 随即提交），**而「碰巧对」比错更危险**。
5. **锁不要钉「文本长什么样」，要钉「哪件事必须成立」。** 本波又有四把锁因为合法改动而假红（钉行号、钉一行的写法、钉行数、钉字面量）。新加断言**必须反向验证**（故意破坏 → 确认真红 → 还原）：本波出过一条「写的时候以为在守门，其实门是画上去的」假绿断言。
6. **回归的红要逐条串行复验。** `--parallel 4` 下大量红是「起不来服务」的级联；`run-all` 日志是交错的，真红只看结尾「失败件 tail」的标题。**别用 8 路。**
7. **补丁脚本吃反斜杠**：heredoc → python/node 里写正则时 `\b`／`\(` 会被吞或告警，断言可能永远为真且肉眼看不出。改文件优先用 Edit 工具；非用脚本不可时，写完 `cat -A` 验字节 ＋ 反向验证。
8. **隔离 worktree 跑回归**：3 件 realhist 件必红（fixture 只在主树），`.gitignore` 的 CRLF 是 autocrlf checkout 产物（master 里是 LF），都不是回归。
9. **长文本写入会截断（2026-09-09 事故）**：一次 ~12 KB 的 heredoc 在 10 KB 处无声截断，装配脚本残件差点入库。生成/装配类脚本：优先 Write 工具一次落盘（无 shell 传输层）；非用 heredoc 不可时切块 < 4 KB 追加、每块 `wc -c` 核累积字节，跑之前先验语法（`node --check`）。

---

## 5. 已登记、本波明确不动的债

| 债 | 现状 | 何时还 |
|---|---|---|
| `13g-steward.js` 2088 行 | `steward-runner.static` ① 红（HEAD 上就红） | **刀 T1**（§2.1） |
| `app.js` 1279 / 硬顶 1280 | 只剩 1 行余量 | 下一个要往组合根加东西的刀先拆 |
| 抖动件 `steward-conversation.e2e` **R7** | 已定名：117l-B2 的分组规则断言，失败的是**夹具形状前提**（缺第二个多行组），不是竖线规则；执行者用 `git archive HEAD` 干净副本复现同红 | 治理抖动那一批 |
| 抖动件 `steward-thread-title.e2e` | 等摘要异步落盘，对负载敏感；单跑绿 | 同上 |
| 30 号文 §8.13 ④ 的 19 个抖动件 | 未治理 | 单独一批；**抖动只能比通过率，不能比单次采样** |
| `steward_thread_read` 不带工具**结果**（只有调用行） | 管家看不到线程跑出来的工具输出 | 若 E-眼睛做了 `steward_thread_artifact_read` 可部分覆盖 |
| 内存态 `lastReply.trigger` 仍是字符串 | `steward-shell.js:277` 靠 `=== 'inbox'` 判要不要追加；只有落盘回执是对象 | 改它要连 `steward-shell.js` 一起改，属 F 批 |
| 06b「转述交付」规则进了 `rules`（易变表）而非 1–6 稳定表 | 英文稳定表 2453/2500 只剩 47 字，静态锁 ③ 钉 ≤2500 | 稳定表要扩容得另立一刀 |

---

## 6. 一句话地图

**（合并已完成）** → **拆 13g** → **F1–F5 把设计稿落地** → **31 号文第一批（手／嘴／时间＋119）** → 第二批（眼睛／代答）→ 第三批（记忆／编排）。
挂起三条等用户：撤回显示、冷启动阈值、回复长度。
