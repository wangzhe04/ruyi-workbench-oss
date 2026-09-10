# 33 号文 · 2.0 与 3.0 重复造轮子审计（2026-09-10）

> 起因：用户走查两处——「3.0 的线程模型选择为什么不复用 2.0 的服务商/模型选择」「从线程切到 2.0 为什么还有单独的停止按钮，不复用 2.0 的插话/停止」——并判断「类似的重复还有很多」。
> 四个只读审计（模型选择器 / 停止与插话 / 前端全面清扫 / 后端与既有原语）并行做，主会话逐条把关键行号对回源码后成文。
> 行号按 `c4a620f`。本文只记事实与裁决选项；拍板结果记 32 号文 §3。

## 0. 两个原问题的直接回答

**模型选择器：是重复，但不是整段。** 2.0 顶栏（`navigation-controls.js:268-322 setEngineModel`、`:351-484 openModelChipPopover`）与 3.0 线程 chip（`steward-chips.js:227-364` 纯函数、`:600-691` 渲染、`:436-456` 写回）**数据源同一份、写回同一条 `PATCH /api/sessions/:id` 同一个 `engineRoute.model`**；候选装配／按 provider 分组／当前项／↑↓Enter／写回这五块是语义重复（约占 M2 那 309 行的三分之一，加 117d 的 chip 基础约 120 行）。搜索／常用（账本 `byModel`）／非文本折叠／用量副行是 3.0 独有；思考强度／删自定义模型／刷新／管理 Providers 是 2.0 独有。
27 号文当时**明确写了「只记录不合并」**（§11.17.4 `:1825-1827`、§11.17.8 `:2203-2205`），给的是切法纪律（别在那一刀顺手做），**没有给技术理由**。而 §11.17.4 `:1825` 原本写 chips 工厂「同时服务 2.0 顶栏／线程详情栏／看板三处」——**顶栏那一处没做到**：今天「2.0 视窗」同屏挂着两枚模型选择器与两枚权限选择器（返回带 `index.html:128-136` ＋ 顶栏 `#modelChip` `index.html:166`），没有任何隐藏规则。更要紧的是两枚**语义不同**：2.0 那枚切会话模型**顺带改全局默认**（`navigation-controls.js:275-296` 同时 `POST /api/config`），3.0 那枚只改本会话。

**停止/插话：后端没有重复，前端有。** 全仓只有一个停止原语 `stopSession`（`04:1768`）与一个插话核心 `steerSessionCore`（`13b:247`）；2.0 的 `/api/stop`、`/api/steer` 与 3.0 的 `steward_thread_stop`（`13h:119-146`，头注自述「不是第二条停机路径」）、`steward_thread_note`、`/api/steward/relay` 全落到这两个函数。前端：用户手按的「停止」在 2.0 有两枚（`#sendBtn` 三态 ＋ 117m-A5「它正在跑」卡上的 `.live-turn-stop` `session-experience.js:909-911`），在 3.0 有三处（抽屉、看板行、停掉占用者，都走 `steward-drawer.js:269-275` 直打 `/api/stop`）。「从线程切到 2.0」后 3.0 的 DOM 全部不可见，屏上剩的正是 2.0 那两枚；`#sendBtn` 被**刻意**写成对别处起的回合不显示「停止」（`chat-stream-runtime.js:376-379`「composer 不去抢那个语义」）——用户看到的那枚单独的停止键就是这句注释的产物。文档只解释了「管家模型为什么需要 `steward_thread_stop` 工具」（§3.5 ＋ 117m-A4），**没有任何一处解释「用户手按的停止为什么不复用 `#sendBtn`」**。
一个真实不对称：用户手按的 3.0 停止不进决策日志，模型停的进；116-3 P1-13 曾以「全部行动经命令核心与审计」为由把「提升优先级」改走工具实现，「停止」没照做。

## 1. 前端重复总表（117n-M1 已合并的 DOM 基础件与 30 号文已登记项不再报）

| # | 功能 | 2.0 | 3.0 | 类型 | 行数 | 难度 | 文档理由 |
|---|---|---|---|---|---|---|---|
| 1 | 模型选择器 | `navigation-controls.js:351-484` | `steward-chips.js:227-364,600-691` | 语义重复＋写回语义分歧 | ~100 | 中 | 只记不合，无技术理由 |
| 2 | 停止键 | `#sendBtn` ＋ `.live-turn-stop` | 抽屉/看板/占用者三处 | 前端重复，后端单原语 | ~40 | 低 | 无 |
| 3 | 路由判据 | `provider-settings.js:97-118`（含消息推断） | `steward-chips.js:126-141`（无） | 三份（服务端 `inferSessionEngineRoute` 第三份） | ~30 | 低 | 无 |
| 4 | 待决/提问 UI | `interaction-prompts.js:73-289`、`preview-shell.js:602-825` | `steward-drawer.js:146-183,667-768,997-1046` | 第三份渲染器，且功能是子集（只答 `questions[0]`、无带意见批准、replan 直接 null） | ~180 | 高 | 只承诺端点复用 |
| 5 | 权限档人话 | `permission.mode.*.short` | `stewardShell.permission.*.label` ＋ `onboarding.wizard.safety.*` | 同 4 档三套词；**「全自动」在 2.0 指 bypass（zh-CN:713）、在 3.0 指 auto（zh-CN:2852）** | ~25 | 低 | 无 |
| 6 | 轮询生命周期 | `preview-shell.js:357-375`、`agent-workflows.js:827-836`、`session-experience.js:832-867` | `steward-shell.js:238-303`、`steward-board.js:961-994`、`steward-drawer.js:1127-1167` | ×7，三把逐字锁钉着 | ~90 | 高 | 30 号文「否决」 |
| 7 | `/api/missions?limit=200` | `preview-shell.js:3447` | `steward-board.js:210` ＋ `steward-drawer.js:390` | 同一份 200 行三处独立拉 | ~15 | 中 | 无 |
| 8 | 通知 | `preview-shell.js:242-346` ＋ `preview-notifications.js` 策略层（去重/免打扰/基线） | 无；E-嘴计划走服务端→托盘 | 未来第二套策略层 | 0 今天 | 中 | 31 号文写了通道没写与策略层的关系 |
| 9 | 壳模式本机偏好 | `preview-shell.js:39 SHELL_MODE_STORAGE_KEY` | `steward-shell.js:105,108` 硬编码 ＋ `:92` 本地 `byId` | 逐字重复 | ~10 | 低 | 无 |
| 10 | 看板 vs 码头 | `preview-shell.js:449-540` | `steward-board.js:329-618` | 两套渲染，3.0 反向 import 了 `dockToneForMissionState` | ~300 | 高 | 27 号文 :108 两壳并存；:363 登记②未做 |
| 11 | 「最后动静」时间 | `elapsedLabel`「3m 20s」 | `stewardAgoLabel`「3 分钟前」；**同一抽屉两种**（`steward-drawer.js:530` vs `:866`） | 已判出不同结果，两把锁各钉一种 | ~25 | 中 | 无 |
| 12 | 3.0 内部逐字件 | — | `costText/acceptanceText/threadStateOf/failNote` 看板与抽屉各一份；抽屉 `failNote:313-328` 还是 117n-M1② 之前的弱化版 | 逐字 | ~45 | 低 | M1② 只修了看板 |
| 13 | 输入框 | Enter/isComposing 守卫 | ×3（`steward-composer.js:441`、`steward-drawer.js:1296,1305`）；`steward-composer.js:63-73,384` 自带图标构造器、path 与 `icons.js:67` 逐字同（F5a 漏网） | 逐字 | ~25 | 低 | 无 |
| 14 | 3.0 输入框缺附件/草稿/autoGrow | `state.attachments`、`wcw.draft`、`util.js:58` | 无 | W2/E-手迟早要 | 0 今天 | 中 | composer:381「归后续波」 |
| 15 | i18n 同义不同键 | — | 395 个 steward 键里 68 个值与既有键逐字相同（`stewardShell.board.stop`=`common.stop` 等） | 逐字 | 68 键×4 份 | 低 | 无 |
| 16 | CSS 按钮/圆点/note/浮层 | `base.css:38`、`chat-shell.css:196 .popover` | 11 条按钮各自重写 `:focus-visible`、6 条圆点、3 条 note、5 条浮层 | 语义重复 | ~250 | 中（载荷锁） | 无 |
| 17 | 浮层关闭原语 | `navigation-controls.js:153-196 popover()` 44 行 | `stewardEscapeStack` ＋ 各菜单手工接线 ~150 行 | 语义重复 | ~150 | 高 | chips:18-27 说了为何要栈，没说为何不用 popover |
| 18 | NDJSON 读流 | `chat-stream-runtime.js:647-656` | `steward-conversation.js:1370-1394`（自述「照抄」） | 逐字 | ~12 | 低 | 无 |

## 2. 后端：22/27 个管家工具落到既有原语，真重复五处

管家自写的多是「门」（mayAct／豁免／自理清单／undoRef／决策日志），不是「动作」——这一层是 §3.5 要求的。**代码侧真重复**：

| # | 重复 | 位置 | 文档理由 |
|---|---|---|---|
| B1 | 会话头读取器 | `13j:86-95 stewardReadSessionHead`、`13i:683 stewardReadTurnHead` vs `02:2399 readSessionHeadResilient`、`02:3827 readMissionSessionHead`——管家两份裸读暴露在「回合写头瞬间 404」竞态里（13d:1191 已改 resilient） | 无 |
| B2 | 五态「有卡片 fromCard／无卡片按头派生」选择块 | `13d:642-658`、`13k:246-249`、`13k:282-292`、`13o:91-105` 四份 | 30 号文只登记了函数两份 |
| B3 | 小时滑窗计数 | `13p:364-368` 与 `13n:164-171` 逐行同形，管家抄自己 | `13n:162` 只陈述 |
| B4 | 今日费用扫描 | `13p:350`、`13n:146`、`13l:85-125 steward_usage` vs `00:465 buildUsageSummary` | 无 |
| B5 | cwd 规范化 | `03:122 normalizeCwd`（兜底）、`13k:42-54`（校验）、`13n:93-105`（身份，多 realpath）、01 去重键 | 32 号文登记未合 |
| B6 | 决策日志 vs 审计流 | `13j:182 stewardAppendDecision` 不调 `logEvent`（13j 全文 0 次）——写工具动作不进 `collectAudit` | 无 |
| B7 | 档位常量集合写了 4 次 | `01:403`、`06i:81`、`06i:135`、`07:807-808` | — |
| B8 | 自理清单判定三份 | `13k:522-525`、`13p:46-81`、`13p:223-263` | — |

刻意分叉且有理由的：管家记忆独立存储（27 §4）、`stewardMayAct` 真值表（§3.3「管家自身不设档位」）、管家会话固定 id 不走 `createSession`（`13m:187`）、`stewardLastTurn` 新头字段（`13k:455-458`）。manifest 顺序**没有**造成上面任何一处（2.0 原语都排在管家模块前）；它造成的只是 `13o` 总览行不能被 `13k` 复用（可搬到 13d 解决）。真正把实现打散的是 `steward-runner.static` 的 2000 行闸。

## 3. 拍板项（推荐＋代价；结果记 32 号文 §3）

见 32 号文 §3 第 8–17 条。

## 4. 不拍板、直接还的技术债（按撞锁少→多）

前端：F5a 漏网图标（`steward-composer.js:63-73,384`）；`steward-shell.js:92,105,108`；抽屉 `failNote` 对齐看板；`costText/acceptanceText/threadStateOf` 三对收进 drawer 导出；i18n 纯别名收编（不改措辞）；Enter 守卫抽 `bindEnterToSubmit`；NDJSON 读器抽 `net.js`（重钉 `steward-conversation.static:264`）；`stewardShortTitle` 搬叶子并修 2.0 四处 UTF-16 切半；`note()`×5；轮询常量收进叶子（不动三把逐字锁钉的函数体）；抽屉 `/api/missions` 改经看板 rows（setter 注入）。
后端：B1 改调 resilient；B2 抽 `threadStateFor` 到 13d；B3 抽 `countInWindow`；B4 抽 `usageCostToday(pred)`；B5 合 `canonWorkspacePath(p,{realpath})`（`normalizeCwd` 不动）；B7 引 `01:403`；B8 抽一张表；`13l:59-71` 等待原因改走 `waitReasonFor`；`13i:517-532` 尾窗读改 `readFileTail`；`13k:343-349` 改用 `sessionMeta`。

未核项：运行期「chip 显示与实跑不一致」是否真出现；`steward-settings.js:781-793 autoPatch` 的「未填充即回写」能否在真机触发；`i18n.static`/`copy-path-guard.static` 对 68 个别名键的钉法；full 模式桥接 desktop 档（E-手②b 在核）。
