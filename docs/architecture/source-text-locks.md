# 源码文本锁清册(source-text locks)

架构还债批 3·D,2026-09-27。基线提交 `63317ac1`。

`dev-harness/` 里有一类测试不跑产品，只把 `app/src/*.js`、`public/js/*.js` 或 `tools/*.js` 当文本读进来，再用正则、`includes`
或 `indexOf` 切片做断言。如果被断言的东西本身就是一段源码形状，比如某个文件里不许出现 `innerHTML`，或者依赖只许往一个方向走，
这样写没有问题。问题出在另一种情况：断言的其实是一个**值**或一段**行为**，比如某张表里有哪些键、某个函数对某个输入返回什么，
却要靠切源码文本去拿。这种锁在纯重构时会误报，也可能悄悄失明。改名、合并常量表、换引号、在两段代码之间插一个 helper、
改缩进，都会让它红掉或切空，而行为其实一点没变。

本批的规矩：

1. **被断言的东西运行时拿得到，就断言运行时的值。** 能走的路有三条：`require(server.js)`，同时把
   `WIN_CLAUDE_WORKBENCH_HOME`/`RUYI_HOME` 指到临时目录，或者在文件头 `require('./lib/self-isolate-home.js')`；
   `import()` `public/js` 下的 ES 模块；`require` `tools/` 下的 CommonJS 模块。
2. **判据本身就是结构性的，才保留文本锁。** 保留时用 `dev-harness/lib/source-slice.js` 的
   `constBlock` / `functionBlock` / `bracedBlock` / `sliceBlock` 取片段。它们按括号配对切，会跳过字符串、模板、注释和正则里的括号，
   不要再手写 `/const X = \[([\s\S]*?)\n\];/` 这类正则。真值表在 `dev-harness/unit/source-slice.test.js`。
3. **转换时判据不许放松。** 每一处转换都做过反向验证：临时把不变式弄坏，确认测试变红，再恢复原样。证据见下面第 1 节。
   转换前后各件的 PASS 条数相同或更多（见第 1.2 节），没有删掉任何一条断言。

## 1. 已转成运行时断言(20 件)

| 文件 | 断言的不变式 | 修前怎么拿 | 现在从哪拿 |
|---|---|---|---|
| `overlay-payload-lock.static` | ① 页面引用的资源都在载荷表里；② 表里每一项都在磁盘上；③ 敏感目录下没有漏登记的文件；109a 可选载荷 | 用 `/const PAYLOAD_FILES = \[([\s\S]*?)\];/` 截出数组，再从里面正则取 `'app/…'` 字面量 | `require('tools/build-overlay.js')` 导出的 `PAYLOAD_FILES` / `OPTIONAL_PAYLOAD_FILES`。打包器被 require 时没有副作用，只有直接运行才会装配 |
| `frontend-domains.static` D15/D20/D26/D36/D37/D46/D49 | 领域模块、CSS 层都进了 overlay 载荷 | 在打包器源码里 `includes("'app/public/js/x.js'")` | `PAYLOAD_FILES`(同上) |
| `steward-shell.static` E4 | 管家壳的 JS/CSS 进了载荷 | 同上 | `PAYLOAD_FILES` |
| `steward-drawer.static` G3 | 117d 新增的三个文件进了载荷 | 同上 | `PAYLOAD_FILES` |
| `steward-settings.static` G3 | 117e 新增的两个文件进了载荷 | 同上 | `PAYLOAD_FILES` |
| `steward-avatar.static` H3 | avatar CSS 和 presence 模块进了载荷 | 同上 | `PAYLOAD_FILES` |
| `steward-conversation.static` H3 | 117c 新增的三个文件进了载荷 | 同上 | `PAYLOAD_FILES` |
| `copy-path-guard.static` ③ | help-menu.js 进了载荷 | 同上 | `PAYLOAD_FILES` |
| `health-i18n.static` G5、`onboarding.static` E8/G4、`steward-board.static` G3 | 映射模块、手册阅读器、向导与样式层、看板与线程头进了载荷；已退役的 2.0 视窗不再进载荷 | 同上(退役那条是 `!includes`,源码注释里提一句也会误红) | `PAYLOAD_FILES` |
| `mermaid-render.static` C6/C7 | 运行时模块进了必需载荷；vendor 登记在可选载荷 | 同上 | `PAYLOAD_FILES` / `OPTIONAL_PAYLOAD_FILES` |
| `desktop-dpi.static`(载荷两条) | 桌面壳两件随覆盖包发布 | 对打包器源码 `assert.match(/'RuyiDesktop\.exe'/)` | `PAYLOAD_FILES` |
| `tool-verb-coverage.static` | ① 每个原生工具都有人话动词；② 用到的动词键在两份语言包里都有 | 用正则切出 `TOOL_VERB_MAP` 和 `humanizeToolName` 函数体，再重建名单和前缀规则 | `import('public/js/interaction-prompts.js')`，调用工厂返回的真 `humanizeToolName`。没加载语言包时 `t(key)` 返回 `[key]`，从返回值就能读出落到了哪个键 |
| `steward-tools.static` ①c ①d ①e ①f ①f2 ①f3 ①g | 会降级成按钮的写类工具都在 `STEWARD_ACTION_HOOKS` 里；只读工具画不出按钮；按钮有人话标签 | 在 13m 源码里从 `const STEWARD_ACTION_HOOKS` 切到 `const STEWARD_DECIDE_LABELS`，再用 `tool:` 正则找 | 调用产物里的 `stewardNormalizeAct`（能不能画成按钮等价于表里有没有这个工具）和 `stewardActLabel`（不是兜底的「去做」） |
| `thinking-boundary.static` | 思考面板只在真正的叙事边界处分段 | 在 `const THINKING_…` 和 `\n\nexport function createChatStreamRuntime` 之间切一段源码，放进 vm 跑 | `import('public/js/chat-stream-runtime.js')` 的 `isThinkingNarrativeBoundary`。这个模块本来就没有 import，本批只给这个函数补了 `export` |
| `subagent-net-tools.e2e` ②⑤⑥ | explorer/reviewer/verifier 三个角色能联网；联网工具的档位不变；`bridgedToolTier` 的分级 | 逐行正则抠角色行；切 `const NATIVE_TOOL_TIER = {…};` 的文本；把函数和两张依赖表拼进 `new Function` | 产物导出的 `BUILTIN_AGENT_ROLES`、`NATIVE_TOOL_TIER`、`bridgedToolTier` |
| `autonomy-grant.e2e` S9 与 [P] 的三个依赖 | `AUTOEXEC_DENYLIST` 的九个条目都在，而且确实导出了；授权书块跑在真的 `hashArgs`/`pathWithinRoot`/`AUTOEXEC_DENYLIST` 上 | 在源码里 `includes` 正则字面量，再用 `/^  AUTOEXEC_DENYLIST,$/m` 查导出行；三个依赖都是正则抠出来再 `new Function` | 产物导出的 `AUTOEXEC_DENYLIST`（逐条比 `String(re)`）、`hashArgs`、`pathWithinRoot` |
| `start-experience.static` ①(前端那一半) | 服务端 keyOptional 预设和前端 `KEY_OPTIONAL_PRESET_IDS` 逐字一致 | 用正则抠 `Object.freeze([...])` 的内容 | `import('public/js/onboarding-wizard.js')` 的 `KEY_OPTIONAL_PRESET_IDS`。服务端那一半见第 3 节 |
| `turn-narrative.static` N1–N4d | 回合叙事分段器的顺序、批次、plan、权限、提问等行为 | 从 02c 的 `function createTurnSegmentBuilder()` 切到文件末尾，放进 vm 跑 | 产物导出的 `createTurnSegmentBuilder` |

### 1.1 反向验证记录

每一行的做法都一样：临时改一处产品代码，单独跑对应测试，确认 exit 1 并记下变红的那一条，然后恢复原样。
改到 `app/src` 的情况先重建 server.js，恢复后再重建一次。

| 临时改动 | 变红的断言 |
|---|---|
| `tools/dev-serve.cmd` 加回 `PAYLOAD_FILES` | overlay-payload-lock ①b |
| 从 `PAYLOAD_FILES` 删掉 `modal.js` | overlay-payload-lock ③(漏登记: app/public/js/modal.js) |
| 从 `OPTIONAL_PAYLOAD_FILES` 删掉 mermaid | overlay-payload-lock 109a 与 ③ |
| 可选载荷缺失时改成 `process.exit(1)` | overlay-payload-lock 109a(打包器存在性跳过) |
| 根目录多出一项 `Uninstall.exe` | overlay-payload-lock ②(根目录只许有桌面壳两件) |
| 从载荷里分别删掉 steward-shell.js / steward-drawer.js / steward-settings.css / steward-presence.js / steward-composer.js / help-menu.js / workbench.js | steward-shell E4 / steward-drawer G3 / steward-settings G3 / steward-avatar H3 / steward-conversation H3 / copy-path-guard ③ / frontend-domains D26 |
| 从载荷里分别删掉 health-i18n.js / help-viewer.js / steward-board.js / mermaid-runtime.js / WebView2Loader.dll | health-i18n G5 / onboarding E8 / steward-board G3 / mermaid-render C6 / desktop-dpi「overlay payload ships WebView2Loader.dll」 |
| 已退役的 steward-classic-window.js 重新加进载荷 | steward-board G3 |
| 从 `TOOL_VERB_MAP` 删掉 `glob` | tool-verb-coverage ①(没有的 1 个: glob) |
| 删掉 `steward_` 前缀规则 | tool-verb-coverage ①(42 个管家工具没有人话) |
| en-US 的 `tools.verb.web_search` 改成空白 | tool-verb-coverage ② |
| 从 `STEWARD_ACTION_HOOKS` 删掉 `steward_thread_stop` | steward-tools ①c |
| `steward_thread_stop` 的标签改成「停」 | steward-tools ①d |
| 从 act 表删掉 `steward_schedule_create` | steward-tools ①e 与 ①f |
| 把 `steward_schedule_list` 加进 act 表 | steward-tools ①f2 与 ①g |
| 删掉 `steward_schedule_pause` 的人话标签 | steward-tools ①f3 |
| `stewardNormalizeAct` 不再按表过滤 | steward-tools ①f2 与 ①g(漏网三个只读工具) |
| 从边界集合里删掉 `tool_use` | thinking-boundary「tool use remains a real chronological boundary」 |
| 把 `context_estimate` 加进边界集合 | thinking-boundary「telemetry between deltas keeps one thinking panel」 |
| `web_fetch` 的档位改成 `exec` | subagent-net-tools ⑤ |
| 从 `BRIDGED_READ_TOOLS` 删掉 `screenshot` | subagent-net-tools ⑥ |
| 内置角色的 claudeTools 删掉 `WebFetch` | subagent-net-tools ② |
| 从 `AUTOEXEC_DENYLIST` 删掉 Jenkinsfile 条目 | autonomy-grant S9(条目、长度)与 B2 |
| 前端 `KEY_OPTIONAL_PRESET_IDS` 删掉 lmstudio | start-experience ①(逐字一致) |
| 服务端预设的 `keyOptional` 改成 false | start-experience ①(两条) |
| 02c 的 plan 决定状态改成 `accepted` | turn-narrative N4b |
| 02c 的同响应批次不再共享 batchId | turn-narrative N3 |

纯重构下的对照：拿 HEAD 版本的旧测试和转换后的新测试跑同一处改动。

| 纯重构改动(行为不变) | 旧锁 | 新锁 |
|---|---|---|
| `TOOL_VERB_MAP` 改名为 `TOOL_VERB_KEYS`(声明和使用一起改) | exit 1 | exit 0 |
| 载荷表里的某一项改用双引号 | exit 1(frontend-domains D26) | exit 0 |

### 1.2 转换前后各件的 PASS 条数

两边都跑在同一份工作区上，「修前」用的是 HEAD 版本的测试文件。

| 文件 | 修前 | 修后 |
|---|---:|---:|
| overlay-payload-lock.static | 16 | 17 |
| frontend-domains.static | 136 | 136 |
| steward-shell.static | 51 | 51 |
| steward-drawer.static | 191 | 191 |
| steward-settings.static | 106 | 106 |
| steward-avatar.static | 47 | 47 |
| steward-conversation.static | 251 | 251 |
| copy-path-guard.static | 53 | 53 |
| tool-verb-coverage.static | 6 | 7 |
| steward-tools.static | 131 | 131 |
| subagent-net-tools | 24 | 24 |
| autonomy-grant | 119 | 119 |
| start-experience.static | 55 | 56 |
| turn-narrative.static | 36 | 36 |
| health-i18n.static | 39 | 39 |
| onboarding.static | 145 | 145 |
| steward-board.static | 183 | 183 |
| mermaid-render.static | 78 | 78 |

thinking-boundary 和 desktop-dpi 用的是 `assert`，不打 PASS 行。thinking-boundary 转换前后都是 8 条 assert 全过；desktop-dpi 的两条载荷断言一换一，也都通过。

**转换过程中顺带发现的问题**：overlay-payload-lock 旧的字面量正则只认 `app/`、`resources/`、`tools/` 开头的条目，
所以载荷表根目录下的 `RuyiDesktop.exe` 和 `WebView2Loader.dll` 从来不在 ② 的判据里。这两件是 Windows 上 build-desktop.ps1
的编译产物，源码树里本来就没有。现在它们登记在 `DESKTOP_BUILD_OUTPUTS` 里，并且新增一条断言：根目录下只许出现这两件。
这条判据比原来更严。

## 2. 刻意保留为文本锁(结构性判据)

下面这些锁要回答的问题是「源码里有没有、有几处、在哪个函数里、往哪个方向引用」，没有对应的运行时值可以断言。
其中本批改动过的文件，已经把手写切片换成了 `lib/source-slice.js`。

| 文件 | 断言什么 | 为什么保留文本 |
|---|---|---|
| `agent-workflows-polling-visibility.static` A/C | 全文件恰好一处 setInterval/clearInterval、一处 visibilitychange 监听 | 数调用点本身就是判据 |
| `copy-path-guard.static`(其余) | 前端不许出现「给路径/命令让用户自己去开」的出口；help-menu.js 零 import | 零出现、零 import 属于结构判据 |
| `copy-terms.static` | 禁用词零命中 | 文案扫描 |
| `cost-zero.static` | 管家视角、线程头不印金额 | 零出现 |
| `css-typography-debt.static`、`ui-v3-p1/p2/p3a/p3b/wave1.static`、`ui-v4-glass.static`、`ui-bugfix.static`、`workflow-editor-v2.static` | CSS token、DOM 骨架、类名契约 | 样式和标记的形状。真实渲染另有 `*.browser.e2e.js` 与像素基线兜着 |
| `desktop-shell.static`、`desktop-dpi.static`(C# 部分) | C# 原生壳的恢复路径和缩放逻辑 | C# 在 Node 里跑不了，编译在 release-dryrun 里做 |
| `process-safety.static` | 只杀自己的进程树，CDP socket 关闭后当场报错 | 禁止 `taskkill /T` 这类写法，属于调用点判据 |
| `ndjson-line-feeder.static` | 子进程的 NDJSON 一律经过 `createNdjsonLineFeeder` | 调用点普查 |
| `session-save-census.static` | 会话的读-改-写只走 `mutateSession` | 调用点普查 |
| `thread-brief.static` | 显示名只有一个出处 | 文件头自述「看住的是结构性约定，不是行为」。行为由 thread-brief.e2e 等件验 |
| `steward-runner.static`、`steward-events.static` D4/D5、`steward-tools.static` ②(handler 体)③⑤⑦–⑪ | 模块落点、manifest 顺序、handler 只调 StewardHooks、四个 offer 面各自有门、常量只定义一次、代码行里零裸字面量 | 依赖方向、落点、单一定义点都是结构。⑤ 另有一段真实回环 |
| `steward-events.static` D2/D3 | 每处 `appendAgentRunEvent(` 调用点的 type 都登记过 | 扫描调用点是为了发现「新增了一处调用」 |
| `autonomy-grant.e2e` S1–S8、S10 | 签发主权路由、子集律插桩、子代理不消耗、exec 不持久、授权书块里没有 CI 条目副本 | 「某函数体里没有某符号」属于结构。本批改用 `functionBlock`/`sliceBlock` |
| `subagent-net-tools.e2e` ③④ | runSubAgentCore / runClaudeSubAgentOnce 的桥接收集与 mcp-config 门 | 函数体里有没有某条调用。本批改用 `functionBlock`，修前按 5000/6000 字截断 |
| `overlay-payload-lock.static` 109a(循环体)、③b | 打包循环对可选载荷做存在性跳过；服务端每个 `resources/` 读口都有载荷覆盖 | 装配一次会写 dist/，不适合在静态件里跑。③b 扫的是读口调用点 |
| `start-experience.static` ②–⑥ | 启动器 `.cmd`、README-START-HERE、向导接线、手册小节 | 启动器和纯文本文件没有运行时可以调 |
| `live-full-text.static`、`streaming-responsiveness.static`、`resume-banner-dismiss.static`、`provider-reasoning-effort-ui.static`、`thread-commission.static`、`new-thread-engine-default.static`、`memory-toolbox.static`、`mcp-ops-gui.static`、`overlay-update-gui.static`、`action-feedback.static`、`scheduler-ui.static`①、`progress-events.static`(接线) | 前端接线：某处调了某个窄接口、某个 DOM 挂点存在、零 innerHTML、事件分支有人接 | 需要真实 DOM。行为另有对应的 `*.browser.e2e.js` |
| `health-i18n.static`(其余)、`i18n.static`、`onboarding.static`(其余)、`rail-pocket.static`、`tool-image-inline.static`、`model-menu-classes.static`、`net-token-replay.static`、`steward-board/conversation/drawer/settings/shell/avatar/walkthrough.static`(其余)、`mermaid-render.static`(其余) | 这些件已经 `import()` 真模块跑行为；剩下的正则锁 DOM 接线和 i18n 走 `t()` | 同上 |
| `ec-d-closure.static`、`c2-evidence-spawn-budget.static`、`agent-team-budget.static`、`agent-mode-v2.static`、`browser-mcp.static`、`software-engineering-prompt.static`、`engine-env-brief.static`、`prompt-snapshot.static`、`v17-review-fixes.static`、`steward-config.static` | 这些件已经 `require(server.js)` 做进程内白盒；剩下的文本断言锁提示词原文或接线点 | 提示词原文就是被测物；接线点属于结构判据 |

## 3. 暂未转换(运行时能拿到，但要先付一点代价)

| 文件 | 断言 | 缺什么 |
|---|---|---|
| `start-experience.static` ①(服务端那一半) | `PROVIDER_PRESETS` / `CLAUDE_ENDPOINT_PRESETS` 只有本机两条加「自定义」 | 这两张表只经 `/api/status` 下发，没有导出。要么加导出（会顶到 `unit/export-surface.test.js` 的上限），要么起服务。本批先改用 `constBlock` 按括号配对切，修前按「下一个 `\n];`」截 |
| `finalize-segments.static` F2–F7 | `healStalePendingSegments` 的修补行为；`bridgedToolTimeoutMs` 的超时表 | 两者都没有导出，而且依赖模块级的 pending Map，测试要往里注入。需要导出，或者提供一个接受注入的纯函数版本 |
| `runtime-optimization.static` [T1]/[C1] | 工具检索和观测裁剪的纯逻辑 | `searchToolCatalog` 等已经导出，但测试往里注入的是桩 `TOOL_PACK_DESCRIPTIONS` 和 `EVAPORATED_PREFIX`。换成真表要重算一遍期望值，需要单独核对，本批不动 |
| `steward-events.static` D1 | `MISSION_CHANGE_TYPES` 每一种都登记进了 `STEWARD_SOURCE_EVENT_MAP` | `MISSION_CHANGE_TYPES` 没有导出。另一边 `STEWARD_SOURCE_EVENT_MAP` 已经是运行时读取 |
| `asr-config-ui.static` | `keepModelCaps`、`asrCurrentPreset` 等前端纯函数的真值表 | 它们是 provider-settings.js 模块内部的函数，没有导出，而且模块顶层依赖 DOM 与 state。composer-voice.js 里的 `streamJoin` 等虽然已经导出，但模块会 import net/icons/util，需要 DOM 桩 |
| `agent-workflows-polling-visibility.static` B/D | `agentRunsPollWanted()` 接进了 `document.hidden` 判定 | 要搭 DOM 桩（`document.hidden`、`querySelector`）才能在 Node 里调 |
| `kimi-plan-ui.static`、`progress-events.static`(vm 段) | 两个渲染器 / 事件分派的行为 | 当前做法是用 vm 加小 DOM 桩跑切出来的源码。改成 import 需要给整个模块的依赖图都搭桩 |
| `steward-tools.static` ① schema 面 | 13f 的 `MCP_TOOLS` 恰好登记了 42 个 `steward_*` | `MCP_TOOLS` 没有导出。⑤b 已经用 `buildOpenAiTools({ stewardSession: true })` 逐名对账了 offer 出去的那一份，所以 schema 面的文本锁只剩「声明处」这一层 |

## 4. 不属于手写源码正则的静态件

以下各件不在本清册的转换范围内：

- 生成物对账（跑生成器再和提交物比较）：`route-inventory.static`、`module-dependency-graph.static`、
  `architecture-contract-snapshots.static`、`durable-state-inventory.static`、`facts.static`、`manifest-ranges.static`。
- 仓库卫生与数据文件：`eol-policy.static`、`i18n-en-terms.static`（扫语言包的值）、
  `acc-offline-installer.static`（发布契约）、`fixture-home.static`（扫 dev-harness 自己的 spawn 调用）。

## 5. 写新静态锁时

- 先问被断言的东西运行时拿不拿得到。拿得到就 require 或 import 它，这是首选。
- 拿不到、或判据本身就是结构性的，才读源码。读的时候用 `lib/source-slice.js`，并且先断言「切到了」
  （非空，或长度有下限），免得锁对着空串一直是绿的。
- `server.js` 加导出之前先看 `unit/export-surface.test.js`：导出总数只许减不许增，每个导出都要有测试或工具引用。
  只为一条静态锁去加导出，要和上限一起权衡。
