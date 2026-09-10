# 34 · 第 121 波 · 一台两视：管家视角与工作台视角共用一台（设计稿；交办台退役；即时推送）

> **状态**：设计稿（2026-09-10，Fable 设计与验收；Opus／Sonnet 实现）。行号按 master `e2ebf42`。
> **交互原型**：<https://claude.ai/code/artifact/f389c702-7b7b-4eae-85f6-54108caee4e9>（可点、可切视角、可模拟线程提问／收工／开新线程、带 ①…⑫ 标注）；仓内副本 `docs/mockups/one-workbench-two-views.html`。
> **与前文的关系**：本文接替 27 号文 §8.2 的信息架构（「三壳互斥＋2.0 视窗」），§8.1／§8.3–§8.13 的原则、avatar、对话语法、递话、抽屉里的「话」**全部沿用**；§11.15 的「一枚线程卡三种密度」沿用并扩到左栏。33 号文的重复审计是本文 §3 的依据。
> **波次编号**：120 仍留给「组合编排与轨迹复用」（27 号文 §10），本波取 121。

---

## 0. 用户原话与一句话

用户（2026-09-10）六条：① 从 3.0 打开 2.0 显示很复杂，顶上一套 3.0 的配置和下面 2.0 的配置矛盾，认知成本高；② 交办台／任务台取缔，代码删掉，默认入口改成 3.0 管家；③ 设计一套 3.0／2.0 并存的交互，用户能随意切换——管家开了线程，用户能到 2.0 里随意开线程、插话，管家也能感知；④ 3.0 全屏太稀疏，把后续规划的功能点加进来；⑤ 3.0 的线程和看板体验差、更新不及时；⑥ 先出设计与原型，实现交给 Opus／Sonnet。

**一句话**：不再是三个互斥的壳，而是**一台工作台的两种视角**——顶栏一个切换钮，左栏线程索引两边共用，切换只换中间与右栏；管家开的线程你能在工作台里直接接手，你在工作台开的线程管家看得见、不插手；「更新及时」靠一条服务端推送替代 5／15 秒轮询；交办台整体删除，管家视角成为默认入口。

---

## 1. 摸底结论（对着源码数的，不是推的）

### 1.1 三个壳今天怎么切
- 唯一状态源是 `<html data-shell-mode>`，三值白名单 `['classic','preview','steward']`（`js/preview-shell.js:41`），未知值回落 `classic`。预绘制脚本 `index.html:71-78` 只认 `'preview'|'steward'`，**默认 `classic`**。
- 后端门 `stewardEnabledV1: false`（`src/01-config.js:295`）：即使本机偏好存了 `steward`，配置没到之前也先起经典壳（`js/steward-shell.js:159-166` 准入，`:341-356` 配置到达后复核并 fail-closed）。
- **`applyShellMode` 住在 `js/preview-shell.js:379-401`**，是 `data-shell-mode` 的唯一常规写者；`app.js:995` 把它注入管家壳。所以**交办台今天是管家壳的启动依赖**——删交办台必须先把它搬走（§8.2）。
- 用户能切壳的入口有 8 处：设置下拉 `#cfgShellMode`（`index.html:891-899`）、侧栏「交办台」`#openPreviewBtn`（`:103`）、预览「返回经典」、3.0 输入区「经典模式」`#stewardClassicBtn`（`:623`）、头像菜单「整体切到 2.0」（`js/steward-conversation.js:1923-1930`）、看板顶「整体切到 2.0」（`:653`）、看板行／抽屉「2.0 视窗」（`js/steward-board.js:698`、`js/steward-drawer.js:1088-1093`）、管家总开关关闭强制回经典（`js/steward-settings.js:173-186`）。**八个入口，三种语义**（整体切／按会话切／被迫切），这就是「认知成本高」的结构原因。

### 1.2 「2.0 视窗」为什么显示矛盾（用户第 ① 条）
- `js/steward-classic-window.js`（148 行）：`openClassicWindow(sessionId)`（`:82-90`）＝写 `sessionStorage['wcw.stewardReturn']` → `applyShellMode('classic')` → `openSession(id)` → 画返回带。
- 返回带 `#stewardReturnBand`（`index.html:128-136`）挂在 `main.chat-pane` 第一个子节点，里面 `#stewardReturnChips` 用 `createQuickSwitchChips` 造 **权限＋模型＋引擎** 三枚 chip（`js/steward-chips.js:908-909`，`compact` 默认 false `:455`）。
- 它下面的 2.0 顶栏（`index.html:137-179`）**原样全画**：`#permChip`（`:159`）、`#modelChip`（`:166`）、`#workspacePicker`、`#contextMeter`……没有任何隐藏规则。
- 两套 chip 不只是重复，**语义不同**：返回带那枚直接 `PATCH /api/sessions/:id`（只改本会话）；2.0 顶栏那枚 `setEngineModel` 在改会话的同时 `POST /api/config` 改全局默认（`js/navigation-controls.js:275-296`；119 波给它加了 `opts.scope`，2.0 不传时行为未变）。同屏两枚控件、两种写法、一份数据——这是 33 号文 §0 记下、本波必须收掉的账。

### 1.3 管家为什么看不见你在 2.0 开的线程（用户第 ③ 条）
- `/api/missions` 的行＝`index.sessions.filter(row => row.card)`（`src/13d-core-domain-routes.js:821`；`src/13e-pretender-index.js:208`）。
- card 只在 `kind === 'mission' || stewardWatchedThread(head, sid, missionId)` 时生成（`13e:158-161`）；`stewardWatchedThread`（`src/06i-steward-core.js:823-828`）只认 `head.stewardQuick`、`head.launchedBy === 'steward'`、`missionId !== sessionId` 三种。
- 所以**用户在 2.0 里开的普通会话（无 mission 账本、`missionId === sessionId`、非管家起）没有 card，永远不进 `/api/missions`，永远不上看板**。`13e:150-157` 的注释写明这是刻意的（「用户自己在 2.0 里聊的几百条普通会话一律不进」）——理由是噪音，不是能力。
- 收件箱（`src/13i-steward-inbox.js`）五种事件 `needs_you | failed | done | stalled | budget`（`:76`）。回合结束事件在 `:714/:746` 按 `watched` 过滤——2.0 会话跑完一回合管家收不到；但**待决不过滤**（`:784-796` 走遍所有索引会话）——2.0 会话弹出的权限／提问**已经**会进收件箱成 `needs_you`。也就是说管家今天「半看得见」：它会替你操心 2.0 线程的提问，却在界面上找不到那条线程。
- 认领路径服务端有（`missionAttachThread`，`src/02-session-store.js:3851,:3906,:3950`；`POST /api/missions/:id/...` `13d:897`），**前端没有任何入口**；抽屉的「交回管家」只是 `closeDrawer()`（`js/steward-drawer.js:1272-1280`）。

### 1.4 为什么更新不及时（用户第 ⑤ 条）
- **没有任何服务端推送**。全仓只有两条 NDJSON 写流，都是「谁起的回合谁收」：`src/10-context-governance.js:2333-2399`（`POST /api/chat/stream`）与 `src/13h-steward-runner.js:246-309`（管家自己的回合）。没有 SSE、EventSource、WebSocket、long-poll。27 号文 `:20` 早写了「不存在进程内 pub/sub」。
- 唯一的扇出点是 `activeChildren`（`src/04-permission-runtime.js:95`）——`sessionId → {…, onEvent}`，**单订阅者**（`src/05-claude-engine.js:493` 装、`:841-842` 卸）。这是加多订阅者最自然的钩子。
- 前端三条轮询（常量 `js/steward-chips.js:253-255`：最小 5000、默认 15000）：壳（`js/steward-shell.js:300`，打 `/api/steward/state`）、看板（`js/steward-board.js:1011`，打 `/api/missions?limit=200`＋`/api/steward/arbiter`，**看板关着不跑** `:1014-1017`）、抽屉（`js/steward-drawer.js:1203`，打 `/api/sessions/:id`＋`/api/interventions`，抽屉关着不跑）。2.0 那边非发起端也是 3 秒轮询（`js/session-experience.js:815,866`）。
- 中途动作**有**，但只在一个端点上：`reg.liveTail = {text, tool, updatedAt, iterations, tools[]}`（`04:121`）经 `GET /api/sessions/:id` 出（`13d:275-289`）；**`/api/missions` 行里没有**，看板行天生画不出「正在调什么工具」。
- 五态服务端是即时的（`13d:660-677` 每次请求派生，`activeTurn` 读内存 `13e:414,425`），慢的全在客户端轮询与开关门。
- 今天事件到看板的最坏延迟：

| 事件 | 延迟 | 原因 |
|---|---|---|
| a. 线程开始跑 | ~15 s（看板关着 ∞） | 起跑前一拍 `anyThreadRunning()` 还是 false，走 15 s 档（`steward-board.js:997`） |
| b. 线程收工 | ~5 s；标题／摘要再滞后数分钟 | 五态与 `lastSay` 快档；`threadBrief` 异步限流（`src/06-provider-engine.js:1196`） |
| c. 线程提问 | 5–15 s（看板关着 ∞） | avatar 的「等你」计数是看板的透传（`steward-shell.js:267`） |
| d. 中途工具调用 | **永远看不到** | `/api/missions` 无 `liveTail`；只有打开的那一条抽屉 5 s 一刷 |
| e. 管家新开线程 | 最长 ~30 s | 收件箱 tick 15 s（`13i:967`）＋看板闲档 15 s |

- 三把逐字锁钉着这些 `setInterval`：`dev-harness/steward-walkthrough.static.e2e.js:195-212`、`steward-avatar.static.e2e.js:99,150-155`、`live-full-text.static.e2e.js:90-101`。换推送要重钉（§6.6）。

### 1.5 宽屏为什么稀疏（用户第 ④ 条）
`css/views/steward-shell.css:37-56`：舞台是 `width: min(1280px, 100%)` 的玻璃卡片，卡片里头部／对话／输入又钉 `max-width: 800px`（`:60-66`），右栏 390px（`steward-board.css:477-484`）。1920 宽下两侧各空 300 多像素，卡片里再空 240。这是 115 波纸面原型（`docs/mockups/steward-shell.html`）的「居中一张卡」被 117i 原样搬进产品的结果，当时只做了 1000–1280 宽的验证。

### 1.6 交办台今天占多少
8 个 `js/preview-*.js` 共 4,075 行、`css/views/preview-shell.css` 1,985 行、`previewShell.*` 508 键 × 4 份目录、18 件 `dev-harness/pretender-*.e2e.js` 共 4,123 行、`index.html` 约 90 行、`app.js` 约 120 行；**合计约 12,400 行**。后端**一行不用删**：`src/13e-pretender-index.js` 是 Mission／Intervention 投影索引，`/api/missions`、`/api/interventions` 的靠山，管家壳全靠它。细目见 §8。

---

## 2. 设计：一台两视（信息架构）

### 2.1 原则
沿用 27 号文 §8.1 全部九条，另加三条：
10. **一份数据一处控件**：同一条线程的权限／模型／引擎在任一视角只画一次；不存在「上面一套下面一套」。
11. **视角切换不丢现场**：切回管家视角时对话流、焦点线程、滚动位置原样；切到工作台时上次选中的会话仍选中。视角是投影，不是导航。
12. **看得见 ≠ 插手**：管家对索引里的每条线程都看得见（状态、最后动静、是否在问你），但只对「管家开的」和「你交给它的」线程动手；你正坐着的那条它绝不代答、不递话。

### 2.2 顶栏（两视角同一条，46px）
左：品牌标＋「如意」。中：**视角切换**分段钮「管家 ｜ 工作台」（快捷键 Ctrl+`）。右：全局状态胶囊「N 在跑 · M 等你」（点开＝左栏滚到该组）、盾牌「新线程默认权限」（§8.6 不变）、**一键停机**（电源符，管家专用；线程停止仍是实心方块——F5a 已立）、设置。
- 3.0 头部今天的「细节」开关移到管家视角中栏头部右侧（只影响对话流，不该在全局顶栏）。
- 2.0 顶栏今天的 `#uiModeToggle`／`#themeToggle`／`#moreMenuBtn` 收进设置齿轮菜单；`#toggleToolsBtn`（收起右栏）保留为右栏自己的折叠钮。

### 2.3 左栏：线程索引（两视角共用，268px；「看板」密度 452px；≤980 折成 56px 图标栏）
- 头：「线程 · N」＋「看板」密度切换（图标）；搜索框（Ctrl+K）；「＋ 新线程」。
- **按状态分组**：等你 ／ 在跑 ／ 排队（含暂停）／ 今天收工 ／ 更早（默认折叠）。组头带计数，「等你」金色、「在跑」青花蓝。**不按事项分组**，事项只在同组内 ≥2 条线程同属一个事项时退成一行小标题＋缩进（§11.15.3 B1 的口径搬到左栏）。
- **行＝线程卡最紧密度**：3px 色条（同一张 hue 表）＋标题＋五态药丸；第二行：来源标记（管家开的／我开的／定时）＋「一句事实」——在跑：`工具 · N 秒前有输出`；等你：`在问你 · 时间`；排队：等待原因（等你／等锁：被谁占着／等并发位：前面还有几条）；收工：相对时间。
- **「看板」密度**：栏加宽到 452px，每行多一行事实（费用 · 验收 a/b · **只在与全局不同时**印权限与模型——§11.15.7 判据 `chipsWorthPrinting` 不新增第二份）；悬停出一行动作（暂停／继续／停止／插队／在工作台打开）。今天的看板浮层 `#stewardBoard`（`index.html:632-658`）**退役**，它的并发上限「同时最多 5」与「全部暂停」搬到看板密度的栏头。
- **口袋**（栏底，常驻，取代头像菜单）：定时任务（带数量）、行动流水、记得的关于你（新写入 24h 带「新」）、体检 · 用量（今天花费）。这四样今天藏在 `steward-conversation.js:69-73` 的头像菜单里，用户找不到——这就是「稀疏但没功能」的另一半。
- 2.0 侧栏（`index.html:90-118`）**就是这一栏**：`#sessionList` 由线程索引取代，`#newSessionBtn` 成「＋ 新线程」，`#openPreviewBtn` 删除，`#sessionSearch` 成 Ctrl+K，栏底四个按钮（清理历史／设置／帮助菜单／帮助）合并进设置齿轮与口袋。

### 2.4 中栏：管家视角
- 头：avatar（§8.3 七态不变）＋名字＋一行状态「正在看着 2 条线程跑 · 6 条线程」＋右侧「细节」开关。**不再有**「整体切到 2.0」「经典模式」两个钮——视角切换只在顶栏一处。
- 频道条（F2）、对话流（F1／F4／117y）、输入框（§8.12 递送目标 chip）**不动**。线程卡头部的「打开」改为「在工作台打开」（＝切视角＋选中，§2.7）。
- 中栏读宽 `max-width: 880px`，随窗口铺满，不再是居中玻璃卡（§7.1）。

### 2.5 中栏：工作台视角（原经典壳 `main.chat-pane`）
- **线程头一套 chip**：色条＋标题＋五态药丸＋来源标记＋工作区路径；第二行：权限／模型／引擎／上下文四枚 chip——**用 `steward-chips.js` 那一份工厂**（`createQuickSwitchChips`，`compact:false`），取代 `#permChip`＋`#modelChip`（§3.1）。
- **管家条**（同一行右侧）：小 avatar（同源七态）＋一句「如意盯着这条」或「如意看得见、不插手」＋开关「交给管家盯」。这是工作台里管家在场的唯一表达（§4）。
- 返回带 `#stewardReturnBand` **删除**；`steward-classic-window.js` **删除**（§3.1）。
- 消息流、工具卡、「它正在跑」卡（117m-A5）、composer（Agent 团队／技能／附件／发送三态）**不动**。117s-G 的插话判据（answer > permission > queued > steer > turn）不动。

### 2.6 右栏（392px；≤1240 变抽屉）
- **管家视角＝「焦点」**（取代「现在这几件」`#stewardNow`＋停靠的抽屉）：
  - 焦点线程＝等你 ＞ 在跑 ＞ 失败 ＞ 最近动静；点左栏任一行可换焦点。
  - 焦点卡＝线程卡「工作」密度（§11.15.3 D1–D4）：卡头 → 元信息（来源／最后动静／模型／只在定过时印权限）→ **按五态一段**：等你→「它在问你」callout＋候选答案＋直接回答框；在跑→「它正在说」（**流式**，来自推送 `thread.live`，非 5 s 一刷）＋当前动作行 `工具 · 第 N 次调用 · N 秒前有输出`＋「递给它一句」框；排队→在等什么＋「插队」「改并发上限」；收工→「它最后说」＋接着说框 → 动作行：主＝「在工作台打开」，次＝暂停／停止或继续，破坏性收进「更多」。
  - 其它在途：其余非收工线程的最紧密度行，点击换焦点。
  - 「今天」四格：线程／回合／花费／待决。
  - 「接下来」：定时任务最近两条（119 波 `steward_schedule_*` 的读面）。
- **工作台视角＝「项目与进度」**（`#toolPane`，`index.html:350-366`）七页签不动；顶部加「这条线程」三格（回合／花费／验收项）。

### 2.7 视角切换语义
- 切换是**全局**的：`data-shell-mode` 只剩 `steward | classic` 两值（`preview` 删除），左栏不重画。
- 从任何线程卡／焦点卡「在工作台打开」＝`applyShellMode('classic')`＋`openSession(id)`；从工作台切回管家＝`applyShellMode('steward')`＋派 `steward:focus-thread`（今天 `backToSteward` 的后半 `steward-classic-window.js:101-109` 保留这一行为，前半的 sessionStorage 标记与返回带整段删）。
- 每个视角记住自己的现场（管家：焦点线程、滚动；工作台：选中会话）——都已有各自的状态，只是不再互相清空。
- 设置里的 `#cfgShellMode` 保留两项「管家（默认）／经典」，含义变为**启动默认视角**，不再是「壳」。

### 2.8 明确不做
不做第三种视角；不做每线程独立窗口；不做视角级不同的线程列表（左栏必须同一份）；不做「管家视角里也开 2.0 右栏」；不把交办台任何界面搬进管家（码头／任务单／收工页全部退役，它们的**数据**——验收里程碑、通知策略——另行归位，§8.3）。

---

## 3. 线程配置去重（用户第 ① 条）

### 3.1 一套 chip、一种语义
- `createQuickSwitchChips`（`js/steward-chips.js:600-691` 渲染、`:436-456` 写回）成为**唯一**的线程配置控件，服务：左栏看板密度（只读值，`chipsWorthPrinting` 决定印不印）、焦点卡、工作台线程头。
- 2.0 的 `openModelChipPopover`（`js/navigation-controls.js:351-484`）与 `#permChip` 弹层退役；119 波已把菜单内容（`js/model-menu.js`）与开合（`js/popover.js`）共用，剩下的只是**换掉容器与写回路径**。2.0 独有的三项（思考强度／删自定义模型／刷新与管理 Providers）进 chips 的模型菜单尾部（「管理服务商…」直达设置）。
- **写回恒为会话级**：`setEngineModel(…, {scope:'session'})`。「设为新线程默认」是模型菜单里的显式一项（写 `POST /api/config`），盾牌管权限默认——两个默认都只在这两处改。
- 术语：权限四档人话只剩 `stewardShell.permission.*.label` 一份（119 波已把 3.0 的 auto 改「智能自动」，2.0 的 `permission.mode.*.short` 收编成别名）。

### 3.2 删除清单（本节）
`js/steward-classic-window.js`（148）、`index.html:128-136` 返回带、`css/views/steward-board.css:511-521` 返回带样式、`index.html:159-170` 的 `#permChip`／`#permSelect`／`#modelChip`、`navigation-controls.js:351-484`。锁：`steward-board.static` 里钉 `openClassicWindow` 的条目、`dom-contract.e2e.js` 对 `#modelChip` 的契约（改钉「线程头恰有一组 `.steward-chip`」）。

---

## 4. 感知与交接（用户第 ③ 条）

### 4.1 线程＝会话；来源三值
- 每个会话头新增 `origin: 'steward' | 'user' | 'schedule'`（写在 `createSession`，`02:2708` 附近；管家起的已有 `launchedBy:'steward'`，定时起的由 119 波 `stewardLaunchTurn` 写；其余默认 `'user'`）。
- **两个判据取代一个**：`visible`（进索引）与 `watched`（管家动手）。`stewardWatchedThread`（`06i:823-828`）**保留原语义作为 `watched`**；新增 `threadVisible(head)`＝在途 ∪ 今天有动静 ∪ 最近 N 条（N 默认 30，设置可调）∪ watched。
- 「交给管家」＝`PATCH /api/sessions/:id {stewardWatch:true}` → `watched` 为真；反向「别盯了」写 false。`stewardWatchedThread` 多认一个 `head.stewardWatch === true`；写 false 时对管家开的线程也生效（用户接手）。

### 4.2 索引口径
- `13e-pretender-index.js:158-161` 的 card 生成条件改成 `visible`；行加 `origin`、`watched`、`liveTail` 摘要（`tool`、`updatedAt`、`iterations`，**不带正文**）。`/api/missions` 的消费者（看板→左栏、焦点）零改动即能画来源标记与「正在调什么」。
- 收件箱 `13i:714/:746` 的 `watched` 过滤**保留**（管家不为你 2.0 里的每一回合写回执）；待决不过滤（`:784-796`）也保留，但**新增在场过滤**（§4.3）。
- 噪音担忧（`13e:150-157` 注释）用**窗口**解决：几百条旧会话在「更早」组默认折叠、只进搜索，不进「在途」与「今天」。

### 4.3 在场信号与打扰纪律
- 客户端随推送连接（§6.1）报告 `presence = {lens:'steward'|'classic', sessionId, at}`；断连即视为「不在壳里」。这是 31 号文 E-嘴要的「最小在场信号」，本波先落，E-嘴直接用。
- 收件箱对每条候选事件加一道**在场门**：
  - 用户在工作台且正坐在该线程上 → 事件只更新索引与徽标，**不生成管家回合、不出安静卡**（他自己看得见）。
  - 用户在工作台但坐在别的线程 → 生成 `needs_you`／`failed` 的**安静卡**（右下角一张，可就地回答：候选答案／去看／稍后），不弹窗、不切视角、不抢焦点；`done` 只更新左栏。
  - 用户在管家视角 → 今天的行为（收件箱触发管家回合 → 线程卡）。
  - 用户不在壳里 → 累积进「你不在的时候」；E-嘴落地后走托盘。
- 安静卡是工作台里管家的**唯一**打扰形态；5 分钟同线程同类合并、静默时段规则沿用 §8.5；交办台的策略层（去重／免打扰／基线，`js/preview-notifications.js`）**搬到这里复用**，不写第二份（§8.3）。

### 4.4 交接
- 工作台 → 管家：「交给管家盯」（管家条开关）＝写 `stewardWatch:true` ＋ 向管家会话追加一条系统事件 `thread.adopted`，管家在下一回合回一句「好，『X』我盯着」；用户可附一句委托（输入框回车即带上）。
- 管家 → 工作台：「在工作台打开」只是视角切换；线程的 `watched` 不变——管家仍盯，但按 §2.1 第 12 条，用户坐着时它不动手；用户离开（presence 变化）后恢复。
- 线程回合互斥：两视角都走 117s-G 那一份判据（`10 runSessionTurn` 409 后备），插话进 `steerSessionCore`（`13b:247`），停止进 `stopSession`（`04:1768`）。**用户手按的停止也进决策日志**（33 号文 §0 记的不对称，本波一并还）。

### 4.5 管家对「你正坐着的线程」
不代答它的提问（权限门不变，只是不主动 `steward_thread_continue`）、不递话、不改它的权限与模型；可以读（`steward_thread_read`）用于回答你的问题。索引行带 `seatedBy:'user'` 供提示词与工具门判断。

---

## 5. 线程索引与线程卡（用户第 ⑤ 条的 UX 半）

- **一枚卡，四种密度**：对话流（转述）／焦点（工作）／左栏（清点，一行事实）／左栏看板密度（清点＋事实行＋悬停动作）。骨架、hue 表、五态词表、`stewardThreadFacts` 仍各一份（§11.15.4 纪律不变）。
- 排队必须可解释（§8.10）；来源标记三值；「最后动静」统一用 `stewardAgoLabel`（33 号文第 11 项：抽屉里两种时间写法收成一种）。
- 焦点卡「它正在说」只显示最近 ≤3 句（`liveTail.text` 尾窗），带光标；「当前动作」一行等宽字体：`web_fetch · 第 7 次调用 · 3 秒前有输出`。不显示百分比、不显示 ETA（§8.1 第 6 条）。
- 左栏「在跑」组每行的第二行也是这一句事实（来自索引行的 `liveTail` 摘要，§4.2）。

---

## 6. 即时更新（用户第 ⑤ 条的数据半）

### 6.1 一条推送：`GET /api/events/stream`（SSE）
- 服务端新增模块 `src/13r-event-stream.js`（传输层，排在 `13q` 后、`14` 前；文件名按 SPEC §1 的 `^13[a-z]?-` 正则）。职责只有一件：**把已有的四个事件源扇出到所有连接**。
- 四个事件源与钩子：
  1. `activeChildren[sid].onEvent`（`04:95`）改成**多订阅者**（数组）：引擎原有订阅者不动，事件流模块追加一个只做「节流转发」的订阅——这是 27 号文 `:20` 预告过的那一步。
  2. 会话头写入（`02-session-store.js` 的 `patchSessionHead`／`stewardLaunchTurn` settle）：写完派 `thread.state`。
  3. 收件箱 append（`13i`）：派 `inbox.appended`；管家回合 say 落盘（`13h`）：派 `steward.say`。
  4. `createSession`／`missionAttachThread`：派 `thread.created`／`thread.adopted`。
- 事件表（`event:` 名 ＋ `data:` JSON）：

| 事件 | 载荷 | 节流 |
|---|---|---|
| `thread.state` | `{sessionId, state, updatedAt, wait, origin, watched}` | 即时 |
| `thread.live` | `{sessionId, tool, textTail(≤240), iterations, updatedAt}` | 每会话 ≥500 ms 一条 |
| `thread.needs_you` | `{sessionId, interventionId, kind, question, options}` | 即时 |
| `thread.done` | `{sessionId, summary(≤160), deliverable?}` | 即时 |
| `thread.created` / `thread.adopted` | `{sessionId, origin, title}` | 即时 |
| `steward.say` | `{turnSeq, trigger}`（正文仍走 `/api/steward/messages` 拉，避免双写） | 即时 |
| `presence.ack` | `{lens, sessionId}` | 连接时 |

- 连接参数 `?lens=&sessionId=` 即在场信号（§4.3）；心跳 `: ping` 每 25 s；`Last-Event-ID` 支持断线补发最近 200 条（内存环）。鉴权沿用 `01b-route-auth.js` 的 token 规则。
- 红线：事件流**不承载工具输出正文**（`steward_thread_read` 的债不在这里还）；不改任何写路径的语义，只是多一个观察者。

### 6.2 客户端
- 组合根持**一条** `EventSource`（新叶子 `js/event-stream.js`，注入到管家壳与工作台）；三个消费者：左栏索引（`thread.*` 就地改行，不重拉）、焦点卡（`thread.live` 直接写「它正在说」）、对话流（`steward.say` 时拉一次消息）。2.0 的「它正在跑」卡（`session-experience.js:832-911`）也改吃 `thread.live`，3 s 轮询降为兜底。
- 三条轮询**保留为兜底**：连接断开时恢复今天的节奏；连接正常时统一降到 30 s 心跳（ETag 保留）。看板关着不刷的门（`steward-board.js:1014-1017`）删除——左栏永远开着。
- `app.js` 今天 1279/1280 行：本波 K1 先删交办台接线（约 120 行）腾出余量，事件流的注入才放得下。

### 6.3 验收指标（可证伪）

| 事件 | 今天 | 目标 |
|---|---|---|
| a. 线程开始跑 → 左栏药丸变「在跑」 | ~15 s／∞ | ≤1 s |
| b. 线程收工 → 药丸＋「它最后说」 | ~5 s | ≤1 s（摘要仍异步，但 `summary` 即时） |
| c. 线程提问 → 左栏「等你」计数＋焦点卡 callout | 5–15 s／∞ | ≤1 s |
| d. 中途工具调用 → 焦点卡当前动作行 | 永远不 | ≤1 s |
| e. 管家新开线程 → 左栏出现 | ~30 s | ≤1 s（收件箱触发管家回合的 15 s 是另一件事，不在本指标里） |

真夹具：起一条真线程（真端点，同 §11.15.0 口径），用 `EventSource` 客户端记事件到达时刻，与服务端写头时刻比对。

### 6.4 撞锁
`steward-walkthrough.static:195-212`、`steward-avatar.static:99,150-155`、`live-full-text.static:90-101` 三把钉 `setInterval` 字面量的锁，**重钉为事实**：「兜底轮询存在且间隔 ≥30 s」「事件流连接时不发起 `/api/missions` 轮询」（反向验证：把兜底改回 5 s → 红）。`route-inventory` 加新路由；`durable-state-inventory` 不变（事件流无落盘）。

---

## 7. 宽屏密度与功能点（用户第 ④ 条）

### 7.1 铺满，不再居中卡片
`.steward-shell` 的场景层＋玻璃舞台（`steward-shell.css:20-56`）退役；两视角共用同一个应用外框：顶栏 46px ＋ 三栏 `268px | minmax(0,1fr) | 392px`（看板密度时左栏 452px）。中栏内容读宽 `max-width: 880px` 居中；≥1600 宽时右栏放宽到 440px。`--glass-*` token 只留给浮层与安静卡。

### 7.2 带进来的功能点（都是既有或已立项能力，只补入口）
| 功能 | 来源 | 位置 |
|---|---|---|
| 定时任务列表＋最近两条 | 119 波（29 号文）`steward_schedule_*` | 口袋 ＋ 焦点栏「接下来」 |
| 行动流水 | 116-3 决策日志（`/api/steward/decisions`） | 口袋 |
| 记得的关于你 | 116d 记忆面板 | 口袋（新写入带「新」） |
| 体检 · 用量 | `/health`、`buildUsageSummary`（`00:465`） | 口袋（今天花费）＋焦点栏「今天」四格 |
| 并发上限与全部暂停 | 116h | 左栏看板密度栏头 |
| 委托书 | §8.13 | 工作台线程头下第一条系统消息（今天已在现场，只是 2.0 没画） |
| 全局状态胶囊 | 今天的状态行 | 顶栏 |

### 7.3 响应式断点（容器查询以外框为准）
≤1240：右栏成抽屉（顶栏出「右栏」钮）；≤980：左栏成 56px 图标栏（色点＝线程，图标＝口袋）；≤390 的手机断点沿用今天各层的规则。内容一件不少，只改容器。

---

## 8. 交办台退役（用户第 ② 条）

### 8.1 删除清单
| 类别 | 内容 | 行数 |
|---|---|---|
| 前端 JS | `js/preview-shell.js`(3657)、`preview-notifications.js`(117)、`preview-task-sheet.js`(91)、`preview-narrative.js`(75)、`preview-finish.js`(56)、`preview-store.js`(45)、`preview-dock-home.js`(23)、`preview-lenses.js`(11) | 4,075 |
| CSS | `css/views/preview-shell.css`；`css/components/onboarding.css:83` 那条孤儿规则 | 1,986 |
| locale | `previewShell.*` 508 键 × 4 份（`public/locales/*.json`、`docs/i18n/locales/*.json`）；**留 4 键改名**：`settingLabel/settingClassic/settingHint` 与新加的 `settingSteward` 搬到 `shell.*` | ~2,032 |
| index.html | `:30` 样式链接、`:67-78` 预绘制白名单去 `preview`、`:103` 侧栏「交办台」、`:508-553` `#previewShell` 子树、`:893` 设置项、`:901-920` 通知设置块 | ~90 |
| app.js | `:38,41` import、`:44-45`、`:325`、`:616`、`:869-935` 三个 preview 专用 helper、`:936-992` 领域构造、`:1012`、`:1252-1272` `previewFirst` 分支 | ~120 |
| 构建 | `tools/build-overlay.js:84-93,132` 九条清单；`styles.css:20` `@import`；`steward-shell.css:10` | ~12 |
| 测试 | 18 件 `dev-harness/pretender-*.e2e.js`；**但 `pretender-gate.e2e.js`(245) 与 `pretender-index-scale.e2e.js`(190) 测的是后端投影索引，改名保留**（→ `mission-index-*.e2e.js`） | 4,123（保留 435） |
| 文档 | `docs/PRETENDER-PLAN.md`、`PRETENDER-METRICS.md` 归档到 `docs/archive/`；`PRETENDER-SCHEMA.md` 是仍在用的数据契约，**改名 `MISSION-SCHEMA.md` 保留** | — |
| 后端 | **零删除**。`13e-pretender-index.js` 保留（可改名 `13e-mission-index.js`，但改名会漂 `durable-state-inventory` 与 route 产物，本波不做） | 0 |

### 8.2 先搬后删（否则管家壳启动即崩）
| 符号 | 今天 | 去处 |
|---|---|---|
| `applyShellMode`＋`recoverClassicShell`＋`cfgShellMode` 同步 | `preview-shell.js:379-401,107-119,238,3561-3568` | **新叶子 `js/shell-mode.js`**（两值白名单、预绘制同步、唯一写者） |
| `SHELL_MODE_STORAGE_KEY`／`SHELL_MODES`／`normalizeShellMode` | `preview-shell.js:39,41,46` | `js/shell-mode.js`；`steward-shell.js:14` 改 import |
| `dockToneForMissionState` | `preview-shell.js:54` | `js/mission-state.js`（它本来就是五态→色调的映射） |
| `elapsedLabel`／`acceptanceItems`／`activeAcceptanceIndex`／`taskProgress` | `preview-task-sheet.js:82,20,32,8` | 新叶子 `js/thread-facts.js`（与 33 号文第 12 项「`costText/acceptanceText/threadStateOf` 收进一处」同刀） |
| `missionCardSignature` | `preview-dock-home.js:7` | `js/mission-state.js`；`steward-guardrails.e2e.js:780-786` A4 改 import |

### 8.3 两处行为缺口（删掉就丢功能，必须归位）
1. **`dispatchAcceptanceMilestones`**（`preview-task-sheet.js:39`，唯一调用点 `app.js:887` 在交办台派单路径里）是前端**唯一**的 mission `milestones` 生产者。删了它，抽屉验收块（`steward-drawer.js:315-316`）与看板验收计数（`steward-board.js:366`）对新事项永远为空。**归位**：搬进 `js/thread-facts.js`，由管家「另起一件」与工作台「＋ 新线程」两条路径都调用（服务端 `13k stewardImplThreadNew` 已写 mission 账本，前端只补里程碑）。
2. **`PreviewNotifications` 策略层**（`preview-notifications.js`：去重、免打扰时段、基线）——管家今天没有本地通知策略。**归位**：改名 `js/notify-policy.js`，安静卡（§4.3）与 E-嘴的托盘通道共用；设置块 `index.html:901-920` 改名为「提醒」保留，键改 `notify.*`。

### 8.4 默认入口
- 预绘制默认 `steward`（`index.html:71-78`）；`stewardEnabledV1` 默认 `true`（`01-config.js:295`）——**拍板项 ③**。本机偏好里存着 `preview` 的老用户回落 `steward`。
- 管家不可用（DOM 未就绪／配置关闭）仍 fail-closed 到 classic（`steward-shell.js:341-356` 不动）。
- 新手向导（118a）的完成页落在管家视角。

### 8.5 锁与产物
重钉／改写：`read-frontend-css.js:25,400,430`（路由表、`LEGACY_STYLES_SHA256` 从 HEAD 重算、载荷分组）；`steward-shell.static:18,34,38,67,70-84,162`（改钉 `shell-mode.js`、两值、写者表 `['index.html',2],['js/shell-mode.js',1],['js/steward-shell.js',1]`）；`steward-board.static:71-72,116,121-122,142-145,335,376-387,664`；`steward-drawer.static:180-181,185,349,376`；`steward-avatar.static:101-105`；`steward-conversation.static:114-115,735-736`；`steward-shell.e2e.js:6-11,149,270,293`（去掉 `#previewShell` 与 30 s 轮询停止断言）；`i18n.static:31-42,223-228`（`stateLabel()` 三份→两份）；`progress-events.static:74,149-155,180`；`onboarding.static:36`；`mission-result.e2e.js:251-258`；`copy-path-guard.static:103`；`agent-workflows-polling-visibility.static:8`；`run-all.js:26`。产物：`facts.json` e2eCount（331→约 315）、`route-inventory.json`、`module-dependency-graph.json`、`architecture-contract-snapshots.json`、`durable-state-inventory.json`（去 `wcw.previewUiState.v1`／`wcw.previewNeedsNotifications.v1`）、`docs/i18n/STRING-CATALOG.md`。

---

## 9. 切片与分工（Opus／Sonnet；每刀独占文件；一刀出门再开下一刀）

| 刀 | 做什么 | 独占文件 | 绝不碰 | 判据／验收 |
|---|---|---|---|---|
| **K0** 壳模式搬家＋默认入口 | §8.2 前两行＋§8.4；`data-shell-mode` 两值 | 新 `js/shell-mode.js`、`index.html:67-78,889-900`、`app.js:995`、`steward-shell.js:14,105-112`、`01-config.js:295`、`steward-shell.static`、`steward-avatar.static:101-105` | `preview-shell.js` 本体（K1 删） | 全新 profile 首开落管家视角；存 `preview` 的 profile 落管家；`stewardEnabledV1:false` 时落经典；三件真浏览器 e2e 绿 |
| **K1** 交办台删除 | §8.1／§8.2 后三行／§8.3／§8.5 | 全部 `preview-*`、`preview-shell.css`、4 份 locale、`index.html` 相关段、`app.js` 相关段、`tools/build-overlay.js`、18 件测试、新 `js/thread-facts.js`、`js/notify-policy.js`、`js/mission-state.js` | `steward-*.js` 行为（只改 import 行） | `git grep -i 'preview-shell\|previewShell\|pretender'` 在 `public/`、`app.js`、`dev-harness/`（保留的两件除外）零命中；`build --check` 新鲜；生成器链整条重跑；`run-all --parallel 4` 真红 0；**里程碑不丢**：新开事项后 `/api/missions/:id` 的 `milestones` 非空（反向：注释掉 `thread-facts.js` 的调用→红） |
| **K2a** 事件流后端 | §6.1 | 新 `src/13r-event-stream.js`、`04-permission-runtime.js:95-125`（`onEvent` 多订阅）、`02-session-store.js` 写头钩子（各一行）、`13i` append 钩子、`13h` say 钩子、`01b-route-auth.js`、manifest、生成器链产物 | `public/` | 新 e2e `event-stream.e2e.js`：真线程跑一回合，客户端收到 a–e 五类事件且 ≤1 s；断线 `Last-Event-ID` 补发；`forwardEdges` 不增；引擎单订阅者行为逐字节不变（`05:493` 的那一个仍第一个收到） |
| **K2b** 事件流前端 | §6.2／§6.4 | 新 `js/event-stream.js`、`steward-shell.js:238-303`、`steward-board.js:961-1017`、`steward-drawer.js:1127-1209`、`session-experience.js:815-889`、`steward-chips.js:253-255`、三把静态锁 | 视觉层 CSS | §6.3 五指标真夹具；断连后兜底轮询恢复；连接时 `/api/missions` 请求数在 60 s 内 ≤2 |
| **K3** 索引口径＋在场＋交接 | §4.1–§4.5 | `13e-pretender-index.js:150-215`、`06i-steward-core.js:823-828`、`13i:700-800`（在场门）、`02-session-store.js`（`origin`、`stewardWatch` 白名单）、`13d` 行字段、`13k`（`seatedBy` 进提示词）、`13r`（presence）、相关 unit／e2e | 前端 | 2.0 新开的会话出现在 `/api/missions`（`origin:'user'`、`watched:false`）；用户坐在 X 上时 X 的 `needs_you` 不触发管家回合（反向：拔掉在场门→触发）；`stewardWatch:true` 后回合结束事件进收件箱；「更早」窗口默认 30 |
| **K4** 外框＋顶栏＋视角切换＋左栏 | §2.2／§2.3／§2.7／§7.1／§7.3 | `index.html`（顶栏、左栏、`#stewardBoard`／`#stewardNow` 删）、`app.js`（注入）、`steward-shell.js`、`steward-board.js`（改成左栏索引，去浮层）、`css/views/steward-shell.css`、`steward-board.css`、`layout.css`、`workbench.css`、`chat-shell.css`（侧栏部分） | 对话流、抽屉、chips | 两视角切换左栏 DOM 节点同一（`isSameNode`）；1920 宽三栏铺满、中栏 ≤880；容器查询两档断点各一张截图；`LEGACY_STYLES_SHA256` 本刀独占重钉 |
| **K5** 工作台线程头＋管家条 | §2.5／§3 | `index.html:120-180`、`navigation-controls.js:268-484`、`steward-chips.js`（`compact` 与「设为默认」菜单项）、`steward-classic-window.js`（删）、`dom-contract.e2e.js` | 左栏、焦点 | 工作台里 `.steward-chip` 恰一组、`#modelChip`／`#permChip`／`#stewardReturnBand` 不存在；切模型只改本会话（`/api/config` 零请求，反向：菜单项「设为默认」→ 恰一次）；管家条随 presence 变态 |
| **K6** 焦点栏＋线程卡四密度＋安静卡 | §2.6／§5／§4.3 前端 | `steward-drawer.js`（改造为焦点栏）、`steward-conversation.js`（只加导出）、`css/views/steward-drawer.css`、`steward-conversation.css`（hue 令牌）、新 `js/quiet-card.js`、`js/notify-policy.js` 接线 | 左栏 | 同一线程四面 `data-thread-hue` 相同；焦点卡「它正在说」在 `thread.live` 到达后 ≤100 ms 更新（DOM 断言）；安静卡只在「工作台且非当前会话」出现（三种在场状态各一断言）；`chipsWorthPrinting` 仍只有一份 |
| **K7** 口袋＋今天＋接下来 | §7.2 | `index.html`（口袋、右栏两块）、`steward-settings.js`（记忆／流水面板入口改从口袋进）、`usage-dashboard.js`（今天花费读面）、119 波 schedule 读面 | 其余 | 头像菜单只剩「细节」「设置」；口袋四项各可达且 deep link 到具体面板 |

顺序：**K0 → K1 → K2a ∥ K3（后端两刀文件互斥可并行）→ K2b → K4 → K5 → K6 → K7**。K4 之前，管家视角仍是今天的样子但已经吃推送（用户能先感受到「及时」）。每刀出门都跑真浏览器 e2e（32 号文 §4 纪律 13）；改了 `src/` 就整条生成器链（纪律 10）；共享资源归属：CSS 载荷锁归 K4（K5／K6 预期红、K4 之后主会话统一重钉一次）、locale 归 K1（其余刀在报告里给键，主会话补）、`facts.json` 归 K1。

---

## 10. 验收（整波，可证伪）
1. `git grep -il 'preview-shell\|previewShell\|pretender' -- ruyi-workbench/app/public app.js dev-harness` 只剩改名保留的两件测试与 `13e` 文件名。
2. 全新 profile 首开落管家视角；顶栏一钮切到工作台，左栏 DOM 同一节点；工作台里同一条线程只有一组配置 chip。
3. 在工作台新开一条会话 → 1 s 内出现在左栏「在跑」组，来源「我开的」；切回管家视角，管家没有为它生成任何回合（决策日志零条）；点「交给管家盯」→ 管家回一句。
4. 管家开的线程提问时：用户在管家视角 → 线程卡；用户在工作台别的会话 → 安静卡可就地回答；用户正坐在该会话 → 什么都不弹。
5. §6.3 五指标全部 ≤1 s（真夹具）。
6. 1920×1080 下三栏铺满、无 300px 空白；1180 宽右栏成抽屉；900 宽左栏成图标栏。
7. `run-all --parallel 4` 真回归 0；`build --check` 新鲜；`forwardEdges` 不增、SCC 仍 1。

---

## 11. 拍板项（推荐＋代价；结果记 32 号文 §3）

1. **视角命名**——推荐「管家 ｜ 工作台」（原型用的）。代价：产品名「如意工作台」与「工作台」视角同词；备选「管家 ｜ 线程」更准但对新手更冷。
2. **线程索引口径**——推荐「在途 ∪ 今天 ∪ 最近 30 ∪ 管家盯的」，其余进搜索。代价：老用户几百条旧会话不再在侧栏一屏可见（Ctrl+K 可找）。备选「全部会话」＝今天 2.0 侧栏的口径，但管家索引会被噪音淹。
3. **管家默认开**——推荐 `stewardEnabledV1` 默认 `true`。代价：没配管家模型的机器上，管家视角会用会话默认模型跑管家回合，费用口径变了；118 波向导要多一步「管家用哪个模型」。
4. **交办台通知策略层去留**——推荐保留并改名 `notify-policy.js`（安静卡与 E-嘴共用）。代价：K1 多约 150 行搬家；备选删掉，则 E-嘴要重写一份去重／免打扰。
5. **`13e-pretender-index.js` 改名**——推荐本波不改（产物漂移）。代价：文件名继续叫「pretender」，与「交办台已删」不符，记债。

---

## 12. 与既有账目的关系
- 33 号文第 1／2／3／5／6／7／9／10／11／13／17 项在本波各归其刀（K5：1、3、5；K4：2、9、10；K2b：6、7；K6：11、13；K1：17 的一半）。
- 32 号文 §5 的「看板紧凑行在看板关着时会陈旧」「刚起的线程没有它刚说」由 K2b 自然还清（左栏常开、`thread.live` 首字即到）。
- E-嘴（§11.23）的「最小在场信号」由 K3 先落；E-嘴改为只做托盘通道。
- W2（同文件夹多线程）不受影响；119 波定时任务的读面被 K7 消费。
