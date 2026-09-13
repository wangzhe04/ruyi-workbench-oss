# 36 · 第 122 波 · 清障与走查（发布 A 收口）

> **性质**：35 号文 §2 第 122 行的施工号文。本波不加新功能面；吃 34 号文 §14 末「清障与产品债」清单 1–10（除 119 定时任务后端 → 123 波、realhist → 用户另机测）、走查第二轮、U05 验证型走查，并钉 J04／J05／J16 三个场景。出门后按 107 批准点打包发布 A（35 号文 §4 ③）。
>
> **派单纪律**（沿 34 号文 §14 与 32 号文 §4 全部纪律）：主会话规划＋亲核；Opus／Sonnet 实现；每刀独占文件；按路径提交；**整台机器同一时刻只许一个回归在跑**（纪律 14）——主树那位跑全量，worktree 那位只跑静态件＋自己改的件（逐件单跑）；新 e2e 首行 `require('./lib/self-isolate-home.js')`（纪律 15）；补丁不走 heredoc（纪律 7），所有改动文件做 0x00–0x1f／`\r` 扫描；改了 `src/` 就整条生成器链（build → depgraph → route-inventory → facts-generate）；每把新断言先弄红再还原（纪律 5）。行号一律「以 `f517958` 为准，会漂」。

## 0. 一句话

**121 波把两视角立起来了，122 波把它站稳**：先修「现场会被翻掉」的三处真根（视角切换的过渡乱序、任务账本被首回合盖掉、导入→同步回路复活已删条目），再把启动阻塞、齿轮重复入口、管家视角没向导、样式与文案的尾巴一次清完，最后按用户走查第二轮与 U05 走一遍，全绿即打包发布 A。

## 1. 刀序与独占文件

| 刀 | 执行者／树 | 范围 | 独占文件 | 绝不碰 |
|---|---|---|---|---|
| **L1a 现场保护**（J04／J05／J16） | Opus，隔离 worktree | §2.1 视角切换过渡乱序（真根）＋拆掉 quiet-card「按住 2 s」绕过；§2.2 J04 长输入不被抢焦点；§2.3 J16 SSE 重放去重 | `public/js/shell-mode.js`、`public/js/steward-shell.js`（只动 `syncStewardShellAvailability` 一带）、`public/js/event-stream.js`（K2b 的 SSE 消费者）、`public/js/quiet-card.js`、`dev-harness/quiet-card.browser.e2e.js`、新 e2e ×3、`dev-harness/unit/` 新单测；`run-all.js` 只许在 `PARALLEL_EXCLUSIVE` 集合**末尾追加** | 一切 `src/`、`server.js`、`facts.json`、CSS、`navigation-controls.js`、`steward-conversation.js`、`LEGACY_STYLES_SHA256` |
| **L2 后端三件＋导入来源标记** | Opus，主树 | §2.4 mission start 写口竞争；§2.5 启动探针挪到 `listen()` 后；§2.6 导入→同步回路来源标记 | `src/01-config.js`、`src/13-http-router.js`（boot 段＋`/api/mission`）、`src/09-workflow.js`／`src/05-claude-engine.js`／`src/05b-kimi-bridge.js`（回合收尾落盘那一处）、生成物（`server.js`、`module-dependency-graph`、`route-inventory`、`facts.json`）、新 e2e ×3、`unit/desktop-python-miss-cache.test.js` 若需 | 一切 `public/`、`dev-harness/run-all.js`、`dev-harness/lib/` |
| **L3 测试基建与样式清障** | Sonnet，隔离 worktree | §2.7 run-all 每件独立临时家；§2.8 三件锁定案（index-dedup E3／event-stream B-g1／classic-window-live-steer 独占）；§2.9 `--fs-xl` 退役＋非独占层 letter-spacing／uppercase；§2.10 en-US 归一 | `dev-harness/lib/fixture-home.js`、`run-all.js`（夹具环境段＋`PARALLEL_EXCLUSIVE` 末尾追加＋`TIMEOUT_OVERRIDES`）、`index-dedup.e2e.js`、`event-stream.e2e.js`、`css/tokens.css`、`css/components/{onboarding,tool-pane,chat-primitives}.css`、`css/views/{workbench,workspace}.css`、`css/layout.css`、`css/states/chat-live.css`、`css/themes/ui-modes.css`、`locales/en-US.json`、`ui-v3-p1.static.e2e.js`、`ui-v3-p3a.static.e2e.js`、`read-frontend-css.js`（注释）、新静态锁 ×2 | 一切 `src/`、`public/js/`、`steward-*.css`、`chat-shell.css`、`zh-CN.json`、`facts.json`、`LEGACY_STYLES_SHA256`（**不重钉**，主会话 cherry-pick 后统一重钉） |
| **L1b 走查第二轮＋U05**（L1a／L2／L3 全部进 master 之后） | Opus，主树 | §2.11 chip 菜单文字裁切；§2.12 `#moreMenuBtn` 与齿轮去重；§2.13 管家视角向导入口；§2.14 U05 200% 字体／键盘／窄屏走查（验证型，只修走查抓到的） | `index.html`（齿轮菜单块）、`navigation-controls.js`、`steward-conversation.js`（`renderDigest` 一带＋依赖注入）、`steward-shell.js`（只加一条注入）、组合根一行、`css/views/chat-shell.css`、`css/layout.css`／`css/views/*.css` 中走查抓到的规则、`ia.e2e.js ⑥`、`locales/*.json`（新键＋`common.more` 去留）、新 e2e ×2、`LEGACY_STYLES_SHA256` 重钉 | 一切 `src/`、L1a 三个文件的已改段 |

**并行**：L1a ∥ L2 ∥ L3 同时派；L2 在主树跑全量（8 路），L1a／L3 只单跑自己的件。主会话 cherry-pick L1a／L3 → 重跑生成器链＋重钉 CSS 哈希 → 全量一次 → 再派 L1b。

## 2. 每刀规格（用户触发 → 现状 → 期望 → 修法 → 可证伪判据 → 反向验证）

### 2.1 视角切换过渡乱序（L1a；34 号文 §13.11 产品债①；J05 的真根）

- **用户触发**：quiet-card.browser 约 1/3 概率「刚点好的工作台视角被翻回管家」；真人场景＝开机那两秒里点了分段钮。
- **现状（主会话读码定案）**：`shell-mode.js applyShellMode`（≈130–152）：真换视角时走 `runShellTransition(write)`，`write` 被 `document.startViewTransition` **异步**调用；同值再写走同步 `write()`。boot 末尾 `fillSettings()` → `syncStewardShellAvailability()`（steward-shell.js ≈386）在 `!prefersClassic && !isStewardMode()` 时 `applyShellMode('steward', {persist:false})` → 过渡排队（写回调未落）；此刻用户点 classic → `mode === currentShellMode()`（属性还是 classic）→ **同步写** classic 并持久化；随后排队的 `write_steward` 才落 → 属性翻成 steward。**不是** 34 号文登记时猜的「sync 无条件覆盖」——`prefersClassic` 判据本身没错，错在两次写回调乱序。
- **期望**：最后一次意图赢；任何一次 `applyShellMode` 的写回调在被更新的意图取代后成为空操作。
- **修法**：`applyShellMode` 内置意图序号（`++intentSeq`），`write` 开头 `if (seq !== intentSeq) return;`。不加「用户切过」旗子（已证与 `storedMode()` 判据冗余）。`syncStewardShellAvailability` 条件不动。
- **可证伪判据**：① 新单测 `unit/shell-mode-intent-order.test.js`（沿 `unit/steward-focus-thread.test.js` 的 `pathToFileURL` + `import()` 方式加载 ESM）：假 `documentRef.startViewTransition` 只收集回调，测试先 `applyShellMode('steward',{persist:false})` 再 `applyShellMode('classic')`，然后**倒序**执行收集到的回调 → 属性必须是 classic；② `quiet-card.browser.e2e.js` 删掉 A0g-hold 那段 25×80 ms 循环，A0g 之后直接断言「1 s 内属性稳定为 classic」；③ 新真浏览器件 `shell-mode-late-config.browser.e2e.js`（J05）：CDP `Fetch.enable` 拦 `*/api/config*` 延迟 1500 ms 放行，期间点分段钮 steward→classic→steward→classic、在 `#promptInput` 打一段草稿、把对话区滚到中段；放行后 2 s：`data-shell-mode` 与 localStorage 都是最后一次显式选择、草稿逐字相等、`document.activeElement` 未变、`scrollTop` 差 ≤2 px。
- **反向验证**：把 `seq` 守卫注掉 → ① 必红；③ 与 quiet-card A0g 各单跑 10 次记红次数（预期 ≥1）；还原后 10/10 绿。

### 2.2 J04 长输入时别的线程失败（L1a）

- **触发**：Codex 方案 §9 J04；34 号文 §14 ⑧ 说 quiet-card ①② 两句在单连接夹具下拦不到东西。
- **期望**：安静卡出现；焦点不动、输入目标不变、不切视角、不切会话、不开弹层、对话区不滚。
- **修法**：先测；只修测出来的。
- **判据**：新件 `quiet-card-typing.browser.e2e.js`：焦点在 `#promptInput` 且已输入 40 字；另一条线程（fake 引擎失败剧本）失败 → 等到安静卡；断言 `activeElement.id==='promptInput'`、value 逐字相等、`state.currentSession.id` 不变、`data-shell-mode` 不变、无 `.popover`／`.modal:not(.hidden)` 新增、`#chatScroll`（或等价容器）`scrollTop` 不变。
- **反向**：临时在 quiet-card 渲染处加 `.focus()` → 红；还原绿。

### 2.3 J16 SSE 重连重放去重（L1a）

- **触发**：Codex §9 J16；K2b 前端消费 `Last-Event-ID` 补发（34 号文 §13.6）。
- **期望**：重放已见帧不制造第二张安静卡、不复活已处理的 needs_you、不重复提醒；UI 对齐当前状态。
- **修法**：客户端按帧 id 去重（`id <= lastSeenId` 丢弃），若已有则只补锁。
- **判据**：新件 `event-stream-replay.browser.e2e.js`：先让一条线程失败并**关掉**安静卡，再用 CDP `Fetch` 拦下一次 `/api/events/stream` 重连请求，把 `Last-Event-ID` 改写成失败帧之前的 id 放行（服务端会重放）→ 3 s 内安静卡数量仍为 0、通知计数不增；第二组：needs_you 已回复后同法重放 → 不复活。
- **反向**：注掉 id 去重 → 两组红。

### 2.4 mission start 与首回合写口竞争（L2；34 号文 §13.12 产品债①）

- **触发**：管家开线程后立刻派第一回合，再 `POST /api/mission {action:'start'}`；里程碑账本被回合收尾的 `saveSession` 盖掉（K6b 同件两跑一红一绿；前端用回读＋有界重试兜着）。
- **现状**：`13-http-router.js /api/mission`（≈937–990）落盘后只在 `activeChildren.get(sessionId)` 命中时把 mission 同步进活回合内存；`09-workflow.js` 把 turnSeq 落盘（≈1292）到 `activeChildren.set`（≈1391）之间隔着 `captureWorkspaceTurnBaseline`（13i:889 那段注释正是这个窗口）——窗口里到达的 start 落盘了，回合内存里的 session 没有 mission，收尾一存就盖掉。
- **期望**：无论 start 落在回合的哪一拍，回合结束后磁盘上的 mission 都在，且回合内 `mission_update` 的增量不丢。
- **修法**：回合收尾 `saveSession` 之前做**落盘前合并**（沿 P2-3「skills 的 pre-save disk-merge」同一形状）：重读磁盘 session，若磁盘 `mission.changeSeq` 更高或内存 mission 为空而磁盘有 → 以磁盘 mission 为底，把本回合内存里的增量（里程碑 status／result）用 `applyMissionUpdate` 语义重放到它上面。三个引擎（09／05／05b）收尾处都要，找共用函数落一处。C4 同步保留。
- **判据**：新件 `mission-start-race.e2e.js`：fake 引擎慢回合（`WCW_FAKE_SLOW_MS` 一类既有钩子，执行者按 `agent-node-wrapup.e2e.js:119` 找）；`POST /api/chat/stream` 后 0／50／200 ms 三个时点各发一次 start，回合结束后 `GET /api/sessions/:id` 的 `mission.milestones` 非空且 `startedTurnSeq` 正确；每时点跑 5 轮全绿。
- **反向**：注掉合并 → 0 ms 与 50 ms 组至少一红。

### 2.5 启动探针挪到 `listen()` 后（L2；34 号文 §13.10 产品债）

- **现状**：boot（`13-http-router.js` ≈1745–1770）里 `void syncMcpServersToClaude(config)`／`syncMcpServersToKimi`／`getCapabilities` 虽是 fire-and-forget，但各自函数体在**第一个 `await` 之前**同步跑 `resolveExternalMcpServers` → `detectDesktopMcp` → `pickPython`（三个候选各 spawnSync ≈1.7 s）；`autoImportClaudeCodeMcp` 之后的 `generateMcpConfig` 同理。磁盘缓存（`eb93c02`）只救第二个进程，第一个进程冷启动仍 ≈6 s 才 `listen`。
- **期望**：`listen` 不等任何探针；探针在 listen 之后的 `setImmediate` 里预热同一份进程内缓存；`/api/status` 首次调用最多等一次探针（不改它的同步签名）。
- **修法**：把上述三处 fire-and-forget 与探针预热移到 `listenWithFallback` 之后 `setImmediate` 内；`autoImportClaudeCodeMcp` 留在 listen 前（它只读 `~/.claude.json`，快），但它触发的 `generateMcpConfig` 也挪后。`detectDesktopMcp` 保持同步实现，不在本刀改成 async（登记）。
- **判据**：新件 `boot-listen-budget.e2e.js`：全新 HOME、`TEMP`/`TMP` 指向全新目录（磁盘缓存冷）、PATH 前插一个垫片目录（`python.cmd`／`python3.cmd`／`py.cmd` 各 `ping -n 3 127.0.0.1 >nul` ≈2 s 后退出 1）；从 spawn 到 `/health` 200 ≤ 2.5 s（修前 ≥6 s）；随后 `/api/status` 在 15 s 内返回且 `desktopMcp` 字段形状不变。`unit/desktop-python-miss-cache.test.js` 八条照旧。
- **反向**：把 `setImmediate` 段挪回 listen 前 → 第一条红。

### 2.6 导入→同步回路来源标记（L2；34 号文 §14 ⑩②）

- **触发**：真机 `~/.claude.json` 第三次被夹具污染（§13.17）：直跑期把夹具 MCP 写进 `~/.claude.json` → 真机 app 启动 `autoImportClaudeCodeMcp` 拉进数据根 config → 用户从 Claude 删掉 → 下次启动 `syncMcpServersToClaude` 又 `claude mcp add-json` 写回去。
- **期望**：从 Claude Code 导入的条目**不再同步回 Claude Code**；用户在 Ruyi 里显式 upsert 过的条目才算 Ruyi 所有、才同步。Kimi 同步不变（它不是来源，且有 sidecar 所有权表可干净撤回）——登记为裁决。
- **修法**：`autoImportClaudeCodeMcp` 给新导入条目打 `origin: 'claude-code'`；`sanitizeExternalMcpServer` 放行 `origin ∈ {'claude-code','ruyi'}`（其他值丢弃，缺省视为 `'ruyi'`＝存量条目保持现状）；`syncMcpServersToClaude` 跳过 `origin==='claude-code'`；`/api/mcp` upsert（04:≈1400）落盘时清掉 `origin`（用户接管）。`import-folder`／`import-config` 路径不打标（那是用户主动导）。
- **判据**：新件 `mcp-import-origin.e2e.js`（可借 `mcp-import-config.e2e.js` 的骨架）：夹具家 `.claude.json` 放 `X`；`config.claudePath` 指向一个把 argv 追加写进日志文件的假 `claude`；启动 → config 里 `X.origin==='claude-code'`；再启动 → 日志里**没有** `mcp add-json X`；对 `X` 做一次 upsert → 第三次启动日志里**有** `mcp add-json X`。
- **反向**：去掉 `syncMcpServersToClaude` 的跳过 → 第二条红。

### 2.7 run-all 每件独立临时家（L3；34 号文 §14 ⑩③）

- **现状**：`lib/fixture-home.js fixtureHomeDir()` 每个 runner 进程一份（`cachedFixtureHome`），`run-all.js:169 fixtureChildEnv()` 全轮共用；先跑的件让服务往临时家写 `.claude.json`，后跑的件又导入 → 8 路下 `websearch` 红。
- **期望**：每件一份 mkdtemp，跑完即删（失败件保留并在输出里打印路径，便于取证）。`self-isolate-home.js`（直跑）不变。
- **修法**：`fixtureChildEnv({ perTest: true })` 返回 `{ env, home }`；`run-all` 在 `close` 后 `fs.rmSync(home,{recursive:true,force:true,maxRetries:3})`，仅 ok 件删。
- **判据**：新单测 `unit/fixture-home-per-test.test.js`：两次 `perTest` 调用 USERPROFILE 不同、都在 `os.tmpdir()` 下、都 ≠ `REAL_HOME`；`fixture-home.static.e2e.js` 既有断言照旧。真证据：主会话 cherry-pick 后 8 路全量里 `websearch` 绿（报告里记）。
- **反向**：`perTest` 分支返回同一目录 → 单测红。

### 2.8 三件锁定案（L3）

- **`index-dedup` E3**：先单跑一次把 `t6.meta` 整个打印出来，读 `10-context-governance` 里去重标记在 `/compact` 之后怎么处理；若「compact 之后下一轮重注」是对的，把 E3 改成「t6 重注（`indexInjected===true`）且 hash 不变，t7 再跳过」；若不该重注则是产品红，**只报告不修**（登记 L2 追加或 123 波）。判据必须写清是哪一种，附打印原文。
- **`event-stream` B-g1**：等 `inbox.appended` 60 s 不到。读 13i 收件箱写口的触发节拍（轮询周期／冷启动 `stewardRuntime.cold` 门）与该件的时序；定案「夹具没给足条件」→ 修夹具；「本机固有」→ 写出**具体是哪个条件在本机不成立**，不许只写「固有」。
- **`classic-window-live-steer`**：进 `PARALLEL_EXCLUSIVE`（保留 300 s 覆盖），在集合末尾追加并附实测理由。

### 2.9 `--fs-xl`／`--fs-2xl` 退役＋非独占层 letter-spacing／uppercase（L3；34 号文 §14 ⑦）

- **现状**：`tokens.css:32` 两个别名；消费点 5 处（`chat-primitives.css:19/107`、`onboarding.css:134`、`tool-pane.css:165`、`workbench.css:128`）；`ui-v3-p1.static 1.1` 与 `ui-v3-p3a.static F` 钉着旧名。非独占层 `letter-spacing` 计 onboarding 1／tool-pane 9／layout 1／chat-live 6／ui-modes 1／workbench 1／workspace 3，`text-transform: uppercase` tool-pane 2／chat-live 3／ui-modes 1／workspace 1（`steward-*.css` 的 2+2 是 K8 独占层「三处各有理由」，不动）。
- **期望**：仓里没有 `--fs-xl`／`--fs-2xl` 这两个名字；非独占层 letter-spacing／uppercase 归零，除非能写出理由（等宽代码、kbd、≥17 px 标题的负字距三类可留），留下的逐条列在报告里。
- **修法**：消费点改 `--fs-lg`，删别名与 tokens 注释；两把旧锁改成「全仓零命中」；新静态锁 `css-typography-debt.static.e2e.js` 钉允许名单。
- **判据**：`grep -rn "fs-xl\|fs-2xl" public/ dev-harness/` 只剩注释里的历史记录（或零）；新锁绿；`--fast` 全绿（`LEGACY_STYLES_SHA256` 红是预期，主会话重钉）。
- **反向**：在 workbench.css 加回一处 `letter-spacing` → 新锁红。

### 2.10 en-US「chat／session」→「thread」归一（L3；34 号文 §14 ⑦）

- **现状**：`locales/en-US.json` 值里含 `chat`／`session` 的行 ≈143。
- **期望**：用户可见的英文里线程只叫 thread；**键名不动**；允许名单：`session token`（安全用语）、引用引擎原生概念的句子（如 Claude CLI session id）、`chat` 作动词（"chat with"）。
- **修法**：只改 `en-US.json` 值；新静态锁 `i18n-en-terms.static.e2e.js`：除允许名单键外，值里零 `\b(chat|chats|session|sessions)\b`（大小写不敏感）；允许名单写在锁文件里逐键附理由。
- **判据**：锁绿；`i18n.static`／`health-i18n.static` 等既有锁绿；zh-CN 零改动。
- **反向**：把一条值改回 "chat" → 锁红。

### 2.11 chip 菜单文字横向裁切（L1b；§13.17 ①）

`.steward-chip-option`（`steward-chips.js:441` 命名；规则住 `css/views/chat-shell.css` 一带）加 `white-space: normal`，选项标签与提示各自折行。判据：新件 `walkthrough-round2.browser.e2e.js` 一组：打开权限 chip 菜单，每个 `.steward-chip-option-label`／`-hint` 的 `scrollWidth <= clientWidth`；反向删规则 → 红。

### 2.12 `#moreMenuBtn` 与齿轮去重（L1b；34 号文 §13.14 ⑥）

- **现状**：`index.html:154` 齿轮菜单里 `#moreMenuBtn`「更多」再开一层 `openMoreMenu()`（`navigation-controls.js:643`）：主题／界面／能力矩阵／快捷键——而 `#themeToggle`／`#uiModeToggle`／`#capBadge` 本来就以隐藏态住在同一个齿轮菜单里，快捷键就是旁边的 `#helpBtn`。
- **期望**：齿轮菜单一层：设置／帮助／快捷键／清理历史／主题／界面／能力矩阵，每项一枚。
- **修法**：删 `#moreMenuBtn` 与 `openMoreMenu`；`#themeToggle`／`#uiModeToggle` 去隐藏、文案用既有 `themeMenuLabel()`／`uiModeMenuLabel()` 同步；`#capBadge` 改成菜单项形态（保留 id：它是 `renderCapBadge` 状态载体与 `openCapPopover` 锚点，锚点回退改 `#capBadge`→`#appGearBtn`）；`common.more` 键若无他处引用则删。`ia.e2e ⑥` 改成「`moreMenuBtn` 零枚、齿轮菜单七项各一枚」；`rail-pocket.static D3/D4`「口袋 ∩ 齿轮 = ∅」与 `steward-settings.static E5b` 必须仍绿。
- **判据**：`walkthrough-round2.browser` 一组：打开齿轮菜单，`role=menuitem` 恰七枚且各可见；点主题项主题真变；键盘 Tab 能遍历七项。反向：把 `#moreMenuBtn` 加回 → ia ⑥ 红。

### 2.13 管家视角向导入口（L1b；34 号文 §13.14 遗留②）

- **现状**：首跑「开始引导」只画在工作台空态；新装默认落管家视角，新用户只能齿轮→帮助→重新打开引导。
- **修法**：`steward-conversation.js renderDigest`（≈1667）：`config.onboarding` 未完成时，在问候行下加一枚 `.steward-act`「开始引导」（沿 K6b `.steward-acts ≤2` 预算，它算一枚），调用组合根注入的 `openOnboardingWizard`（`session-experience.js:102` 那一个；经 `createStewardShell` → conversation deps 注入一行，不新开 import）。完成向导后（`onFinished` 已落管家视角）重画 digest 不再显示。
- **判据**：`walkthrough-round2.browser` 一组：全新 HOME 启动落管家视角，问候行下有「开始引导」；点它向导打开；把 `config.onboarding` 写成完成后刷新，按钮消失。反向：注掉那枚 → 红。

### 2.14 U05 200% 字体／键盘／窄屏走查（L1b；验证型）

新件 `a11y-walkthrough.browser.e2e.js`：① 视口 640×480（等效 200%）：`document.documentElement.scrollWidth <= clientWidth`（无横向滚动）、顶栏分段钮／盾牌／齿轮三枚 `getBoundingClientRect` 全在视口内；② 键盘：从 `body` 连按 Tab ≤25 次能到达分段钮、`#promptInput`、左栏第一行；③ 窄屏 800×900：左栏折叠规则生效（按 `layout.css` 既有断点），对话区宽度 ≥ 视口 60%。**只修走查抓到的**；抓到零条也如实收口（Codex 方案「验证型条目允许无新增代码收口」）。

## 3. 退出门

1. J04／J05／J16 各一件真浏览器 e2e 在 master 上绿（§2.1–2.3）。
2. 主会话在 master 上 8 路全量：真回归 0（本机环境红只剩 realhist 三件；`websearch` 8 路必须绿——§2.7 的真证据）。
3. `build --check`／依赖图 `--check`／`--fast` 全绿；`LEGACY_STYLES_SHA256` 重钉一次；所有改动文件控制字符扫描零命中。
4. 34 号文 §14 末清单 1–10 逐条有去向（本波做了／123 波／用户侧）。
5. 发布 A 打包：`tools/package-offline.ps1` 精简＋完整两变体（记忆 `ops-push-and-package`），产物大小与启动冒烟记进 §5；版本号按 107 §6「由实际行为决定」——本波无默认行为改变，走 `2.6.x` 补丁号。**不推送**，等用户拍板。

## 4. 主会话每刀出门后必做

同 34 号文 §14：读 diff 与提交清单 → 控制字符扫描 → 生成器链 `--check` → 串行复跑共享框架件（`one-workbench-frame.browser`、`steward-shell`、`event-stream-client.browser`、`quiet-card.browser`、`ia`）→ 一处反向抽查 → 执行者报「基线红／抖动件」的红**自己单跑一次核** → §5 记录。

## 5. 交付记录

（每刀出门后由主会话补：提交清单、逐条判据实得、反向抽查、串行数、登记项。）

## 6. 停点

（每次收工写在这里，并同步记忆 `ops-new-machine-wave121` 的停点行。）
