# 30 · 重复造轮子普查与收编（第 117 波 117q 批）

> 立项：2026-09-08。用户在第七轮走查中提出「感觉当前项目很多地方都重复造轮子，你派波 sonnet 去查查」，
> 随后拍板「把这些 audit 都落成文档，放进路线规划里，放到 117 波里一块处理」。
> 分工同 117l/117m：**Fable 设计与验收，Opus／Sonnet 实现**，每条落地都由主会话在真夹具上亲自复核。

## 0. 一句话

五路只读审查把 `src/` 后端域层、引擎/provider 层、`dev-harness/`、`public/js/` 前端、持久化与读模型
各扫了一遍，产出**可执行的收编清单**；本文是清单的收口文档：每条给「重复点 / 差异是真需求还是漂移 /
合并落到哪个编号文件 / 会撞哪些静态锁 / 工作量」，并给出**分批派单顺序**。

**这不是一份让代码更漂亮的清单。** 排序第一原则：先修**已经在真机上咬过人、或随时会咬人的判据分裂**
（同一件事两处各判一遍且已判出不同结果），再谈维护成本，最后才是洁癖。
本次普查最大的收获也确实不是「少写几行」——是三条**用普查方式才能发现的真缺陷**：
授权书层挡不住 CI/CD 文件、三条子进程主干道共享一个多字节中文断句 bug、五态判据两份抄写件都把
`turnSeq` 硬编码成 0。

## 1. 方法与口径

- **共同派单稿**：`scratchpad/brief-audit-wheels-common.md`。五路 scope 互不重叠，deliverable 格式统一。
- **四类**：**A** 同一件事写了两遍以上（纯复制）；**B** 同一事实两处各算一遍（**最危险**，会判出不同结果）；
  **C** 重新实现了 Node/平台已有的东西；**D** 同一套样板复制 N 份（测试脚手架多属此类）。
- **硬约束**（写进派单稿，方案不满足即作废）：
  1. **零运行时依赖**；
  2. `src/*.js` 按数字前缀拼接成 `app/server.js`，**只有后向边合法**——每条方案必须说清「抽到哪个编号文件」；
  3. **断言只加不改**——每条方案必须自己 grep 会打掉哪些静态锁，写明重钉理由与更强的伴随断言；
  4. **宁缺毋滥**——「看起来像重复、其实是真需求」的必须显式排除并写理由。
- **前置排除**（前两轮已修，不许重报）：待决决策端点合一、管家壳 DOM 助手六份、错误信封三份、
  看板圆点档位、`mcp_configure` 判据分裂、config 读改写竞态、README 门面数字漂移。

## 2. 主会话复核结论（子代理报告一律重验）

本仓有「并行子代理交付报告多次失实」的前科。以下是我**亲自 grep／读源码核过**的部分：

| 报告里的说法 | 复核结论 |
|---|---|
| `03-bridge-guard.js` 与 `06f-autonomy-grants.js` 两张 autoexec 黑名单已漂移 | **属实，且是双向漂移**。`03:503` 九条含 `.github/workflows/`、`.gitlab-ci.yml`、`Jenkinsfile`；`06f:29` 五条**没有**这三条，却**多一条** `(^\|[\\/])\.git[\\/]`（整个 `.git/`，比 03 更宽）。报告只说了一个方向。 |
| 三条子进程 NDJSON 主干道共享多字节断句 bug | **属实**。`05-claude-engine.js:799`、`07-autonomy.js:1920`、`05b-kimi-bridge.js:714` 三处都是 `chunk.toString('utf8')` 逐块解码后拼接；而 `00-boot.js:21` **已经 import 了 `StringDecoder`**，`05b:1567` 自己也在终端捕获里正确用了它。三条主干道独独没用。 |
| `previewShell.state.*` 与 `stewardShell.drawer.state.*` 两套 key 文案漂移 | **属实**（我直接读了两份 locale）：`quick_ask` = 「速问」/「Quick Ask」 vs 「速查」/「Lookup」；`done` = 「Done」 vs 「Wrapped up」。**并且报告漏了第三份**：`06i-steward-core.js:38-49` 的 `STEWARD_STATE_LABELS` 是服务端硬编码中文，`stateLabel` 随 API 下发——英文界面拿到的是中文。加上 `mission-state.js:23` 那份死代码，同一组人话**共四份**。 |
| `legacySingleSummaryCall` 是零调用点死代码 | **属实**。全仓（src + dev-harness）只有 `10-context-governance.js:1221` 的定义处。 |
| 10 个真浏览器 e2e 漏调 `stopRuyiTestBrowsers` | **属实**（报告中途自我更正过一次，那次更正是对的；我第一次 grep 因匹配到 `steward-shell.e2e.js:61` 的**注释**而少算一个，重核后确认 10 个）。**但严重性下调**：`run-all.js:115/140` 本来就在每件之后与收尾各扫一次，全量回归不漏；漏的是**手工单跑**——正是排查真红时最常走的那条路。与记忆「攒到 345 个 msedge 后冷启动 4s→86s，以『workbench started 超时』假红」对得上。 |
| `steward-board.js` 的裸 `fetch` 没有 token 失效重放 | **属实**（`steward-board.js:159`）。用裸 fetch 是为了读 `304`/`etag`，这个理由站得住；缺的是失败处理那一半。后端重启后看板会一直空转到用户手动刷新，而其余走 `api()` 的功能都能自愈。 |
| `repairInterventionTornTail` 与 `repairMissionChangeTornTail` 是同一算法两份 | **属实**，且真身已被三处共用（`02:189`、`13g:328`、`13i:628`），`02:370` 是**唯一没跟上的调用点**。 |
| `DurableJsonStore` 建好只有一个采用者 | **属实**（`01:1174` 定义、`10:225` 唯一采用、`14:278` 导出）。报告同时指出它是**同步读 + 异步写链**契约，硬套到异步读场景 = 把 I/O 变成阻塞事件循环。**这个判断对，采纳**：本批只登记不迁移。 |
| 184 处 HTTP 助手应统一 | **报告自己标了「不建议本轮合并」，我同意并否决进入本批**：签名顺序、超时、失败语义（reject / resolve(null) / resolve({status:0})）三重分叉，是「同名不同义」不是单纯复制。 |
| ~300 份 `ok()` 断言器应统一 | **降级到 P3**。收益只是一致性，风险是一次性大面积改测试面；必须每批 20–30 件逐批跑。 |
| 管家三件套轮询生命周期样板三连抄应合并 | **否决**。报告自己也标了「不建议本轮动」，理由成立：三份 `*.static.e2e.js` 用**函数体逐字正则**钉着（`steward-avatar.static:139-151`、`steward-board.static:212-217`、`steward-drawer.static:127-145`），合并等于一次性重钉三个高精度锁，收益不抵风险。 |

**我另外补一条审查没查到的**（这一轮真机排障撞上的，B 类最典型形态）：
`06i-steward-core.js:367 stewardThreadStateFromCard` 与前端抄写件 `public/js/mission-state.js fromCard`
**都把 `turnSeq` 硬编码成 0**，注释写着「卡片无 turnSeq；dispatching 判据由 runCount + milestonesDone 承担」。
这个假设对 2.0 任务单成立（一定有 mission 账本和 run），对**管家线程不成立**（`steward_thread_new` 只写
`kind:'mission'`，mission 容器要 `POST /api/missions` 才有）。后果：一条真跑完了的管家线程**永远显示「交办中」**。
`13d-core-domain-routes.js:609` 的注释**已经警告过这件事**（「少喂 turnSeq 会把一条跑过回合的线程说成交办中」），
但只修了没有卡片的那条分支。已并入 **117p-S2**（见 §6）。

## 3. 总表（跨五路统一排序）

批次口径：**P0 = 判据分裂且已产生错误结果 / 已知正确性缺陷**；**P1 = 会制造假红或掩盖真红**；
**P2 = 真重复、机械可合、有测试兜底**；**P3 = 一致性收益为主，量大需分批**。

| 批 | # | 路 | 类 | 一句话 | 副本 | 风险 | 工作量 |
|---|---|---|---|---|---|---|---|
| P0 | 1 | 引擎层 | A+C | 三条子进程 NDJSON 主干道逐块 `toString('utf8')`，中文被管道切两半就变 `�`；平台的 `StringDecoder` 本仓已 import、别处已正确用 | 3 | 低 | 中 |
| P0 | 2 | 后端域层 | B | 两张 autoexec 黑名单双向漂移：授权书层挡不住 `.github/workflows/`、`Jenkinsfile` | 2 | 低＋需拍板 | 小 |
| P0 | 3 | 读模型 | B | 五态判据两份抄写件都硬编码 `turnSeq: 0`，跑完的管家线程永远「交办中」（**117p-S2**） | 2 | 中 | 中 |
| P0 | 4 | 前端 | B | 任务五态人话**四份**（两套 locale key + 服务端硬编码中文 + 一份死代码），`quick_ask`/`done` 中英文都已判出不同结果 | 4 | 低＋需拍板文案 | 小 |
| P1 | 5 | dev-harness | D | 10 个真浏览器 e2e 漏调 `stopRuyiTestBrowsers`，手工单跑攒断头 Edge → 后续件以「workbench up 超时」假红 | 10 | 低 | 小 |
| P1 | 6 | 前端 | B | `steward-board.js` 裸 fetch 缺 token 失效重放，后端重启后看板空转到用户手动刷新 | 1 | 低 | 小 |
| P1 | 7 | 前端 | A | 「压缩」整片文案漏 `t()`：`beginCompactIndicator` 用了 `t()`，进度事件一来就把同一节点覆盖成硬编码中文——英文界面可复现回归 | ~13 处 | 低 | 中 |
| P2 | 8 | 后端域层 | A | 「中和伪造围栏标签」防注入判据手写 6 遍，标签名各写各的 | 6 | 低（有行为级 e2e 兜底） | 小 |
| P2 | 9 | 引擎层 | A | `{read:0,edit:1,exec:2}` 工具分级排序表独立声明 6 处（这是**权限升级判据**） | 6 | 低 | 小 |
| P2 | 10 | 持久化 | A/C | 「读文件末尾 N 字节」原语四份，其中两份**不查 `bytesRead`**（可能对未初始化内存算截断点） | 4 | 低中 | 中 |
| P2 | 11 | 持久化 | A | 撕裂尾修复两份（一份吞错一份不吞），真身已被 13g/13i 共用，02 自己那处没跟上 | 2 | 低 | 小 |
| P2 | 12 | dev-harness | A | `browserPath()` Edge/Chrome 发现函数 16 份逐字节相同 | 16 | 极低 | 小 |
| P2 | 13 | 后端域层 | A/D | `legacySingleSummaryCall` ~85 行死代码，零调用点 | 1 | 极低 | 小 |
| P2 | 14 | 引擎层 | A | 主回合/子代理死循环护栏常量各写一份（3/5/2 完全相同，注释互相点名「对称」） | 2 | 低 | 小 |
| P2 | 15 | 后端域层 | A | 短 id 生成绕开既有 `makeId()`（`06d` 内 5 处手写 `crypto.randomBytes`） | 5 | 低 | 小 |
| P2 | 16 | 后端域层 | A | `argsHash` 指纹算法两份字面相同 | 2 | 低 | 小 |
| P2 | 17 | 前端 | B | `agent-workflows.js` 是 5 个轮询循环里唯一没有 `document.hidden` 门控的 | 1/5 | 低 | 小 |
| P2 | 18 | 引擎层 | B | Claude 引擎两条路径从不写 `cachedInTok`，用量看板「缓存输入」对 Claude 会话恒为空（CLI 结果帧其实带这两个字段，`05:761` 已在读） | — | 低 | 小 |
| P3 | 19 | 引擎层 | A | 可中止有界退避 sleep 两份（300 vs 250 乘数） | 2 | 低 | 小 |
| P3 | 20 | 引擎层 | A | `05b` 内「按偏移量读 wire.jsonl 尾巴」三份（同文件内，零模块边） | 3 | 低 | 小 |
| P3 | 21 | 前端 | A | 「已运行多久」格式化两份，作者注释自认「两处若要改格式，一起改」 | 2 | 低中 | 小 |
| P3 | 22 | 前端 | A | `isChangeAct()` 把 locale 当前取值又抄了一遍（`\|\| '改一下' \|\| 'Change it'`） | 1 | 低 | 小 |
| P3 | 23 | dev-harness | A/D | fake provider 的 SSE **写帧**函数（`sse()` 41 份、`emitToolCall` 6+ 份）——只合电线，不碰剧本 | 47 | 低中 | 中 |
| P3 | 24 | 持久化 | A | 「按 key 序列化写链」骨架 9 处；两处已封装成 `withJournalWriteLock`/`withMissionContainerLock` | 9 | 中（触竞态防护） | 中大 |
| P3 | 25 | dev-harness | C/D | `unit/` 框架分裂：14/31 手搓 `ok()+exit`，17/31 用 `node:test` | 14 | 低 | 中 |
| P3 | 26 | dev-harness | D | `killTree`/`kill`/`killp` 收尸函数 140+ 份，SIGKILL 兜底有无不一 | 140+ | 中 | 中 |
| P3 | 27 | 后端域层 | A | 「折叠空白 + trim + 截断」一行式 ~20 处（截断长度是真需求，只合前半句） | ~20 | 低 | 小 |
| P3 | 28 | 前端 | A | 空态提示 CSS 三份逐字相同（改一行就要重钉 `LEGACY_STYLES_SHA256`） | 3 | 中 | 小 |
| P3 | 29 | dev-harness | D | `ok()` 断言打印器 ~300 份，15 种文本变体 | ~300 | 低 | 中（分 10+ 批） |
| P3 | 30 | dev-harness | D/B | `waitHealth`/`getToken` 起工作台样板 75+，重试预算已漂移（60×100 / 80×100 / 50×120 / 40×150 / 100×60） | 75+ | 中高（时序雷区） | 中 |

## 4. P0／P1 逐条（落点、撞锁、伴随断言）

### 4.1 [P0-1] 子进程 NDJSON 逐块解码（A+C，正确性）

- **三份**：`05-claude-engine.js:798-803`（主回合 Claude CLI / fake-Kimi 通道）、`07-autonomy.js:1919-1924`
  （Claude 子代理，与前者**逐字节相同**）、`05b-kimi-bridge.js:713-723`（Kimi ACP JSON-RPC，变量名叫 `buffer`）。
- **缺陷**：三处都对**每个 chunk 单独** `chunk.toString('utf8')` 再拼接。CJK 是 3 字节，一旦被 OS 管道切在两个
  `data` 事件之间，就会静默变 `U+FFFD`，后续续接字节也解码成垃圾。**这是一个以中文为主的产品的主干道。**
- **本仓已经知道正确做法**：`00-boot.js:21` 已 `require('string_decoder')`；`05b:1567` 的终端输出捕获
  正确用了 `new StringDecoder('utf8')`。三条主干道独独没用——教科书式的 C 类。
- **附带漂移**：05 与 07 都在子进程 close 后 flush 残留半行（`05:812`、`07:1926`），**05b 没有**——
  三者协议都是「一行一个 JSON」，没理由 ACP 单独不补尾。
- **落点**：`00-boot.js` 新增 `createNdjsonLineFeeder(onLine)`（内部持 `StringDecoder`，暴露 `push(chunk)` / `flush()`）。
  05（order10）、05b（order11）、07（order23）**已经**从 `00-boot.js`（order0）取符号，只新增符号不新增边方向。
- **撞锁**：`stdoutRemainder|consumeLine|createKimiAcpRpc` 在 `*.static.e2e.js` 零命中。
  但**必须**重跑 `node dev-harness/module-dependency-graph.js --write`（`00-boot` 的 `provides` 变了，
  `module-dependency-graph.static.e2e.js` 断言生成图与源码逐字节一致）。
- **伴随断言（新加，必须有）**：现有 e2e **没有一条**测试「CJK 被切在两个 chunk 之间」。
  加一条单测：把一个 3 字节汉字拆成两次 `push()`，断言拼出来的行里没有 `�`。

### 4.2 [P0-2] 两张 autoexec 黑名单（B，安全口径）

| 判据 | 03（工具层 sink，`guardFileToolPath`，工作台原生 `file_edit/file_write` 全走它） | 06f（授权书层，`consumeGrant`，Claude CLI 桥 `Edit/Write/MultiEdit/NotebookEdit` 专属） | 判定 |
|---|---|---|---|
| `.git/` 范围 | 只挡 `hooks/` 与 `config(.worktree)` | 挡**整个** `.git/` | 方向相反，需拍板 |
| `.github/workflows/` | 挡 | **不挡** | 漂移 |
| `.gitlab-ci.yml` | 挡 | **不挡** | 漂移 |
| `Jenkinsfile` | 挡 | **不挡** | 漂移 |

两条路径**不重叠**，所以后果是实的：一张无人值守 edit 授权书可以静默改 `.github/workflows/*.yml`，
同一次改动走工作台自己的 `file_edit` 会被挡。**同一个「自动执行入口 = 潜伏 RCE」的判断，一层挡住一层没挡。**

- **落点**：`03-bridge-guard.js`（编号更小，`06f → 03` 是既有合法后向边，`pathWithinRoot` 已这样用）。
- **拍板项**：**建议授权书层取并集（更严）；工具层保持现状，不扩到整个 `.git/`**——工具层是有人值守面，
  扩严会误伤 `.git/COMMIT_EDITMSG` 之类的日常写。即：`06f` 的值 = 03 那张表 + 它自己那条 `.git/` 整目录。
- **撞锁**：`*.static.e2e.js` 无任何断言钉这两个数组。
- **伴随断言（新加）**：授权书 edit 档下改 `.github/workflows/x.yml` 必须回落弹窗（行为级 e2e）。

### 4.3 [P0-3] 五态判据的 `turnSeq: 0`（B）→ 见 §6 的 117p-S2

本次普查里**唯一一条已经在用户真机上产生错误显示**的判据分裂。

### 4.4 [P0-4] 任务五态人话四份（B）

- **四份**：`previewShell.state.*`（交办台）、`stewardShell.drawer.state.*`（管家看板 + 抽屉，
  `steward-board.js:132` 与 `steward-drawer.js:297` 两个 `stateLabel()` 函数体逐字相同）、
  `06i-steward-core.js:38-49 STEWARD_STATE_LABELS`（**服务端硬编码中文**，随 API 下发 `stateLabel`）、
  `public/js/mission-state.js:23 LABELS`（**死代码**，`.label` 零调用点）。
- **已判出不同结果**（实测两份 locale）：`quick_ask` = 「速问」/「Quick Ask」 vs 「速查」/「Lookup」；
  `done` = 「Done」 vs 「Wrapped up」。另外服务端那份是中文单语——**英文界面拿到的 `stateLabel` 是中文**。
- **拍板项**：`done` 与 `quick_ask` 到底哪个措辞算数（文案决策，不由工程侧定）。
  语义上「速问」（快问）与「速查」（快查）不是同一个词——而这个功能的产品定义是
  「管家为了回答一个要读文件/联网/动手才能答的问题临时开的线程」，**「速查」更准**。建议统一到「速查 / Lookup」。
- **修法**：只留一套 key（建议保留 `stewardShell.drawer.state.*` 的措辞、把 key 改名成中性的
  `mission.state.*`，两个壳共用）；删 `mission-state.js` 的 `LABELS` 与 `.label` 死代码；
  服务端那份 `STEWARD_STATE_LABELS` **只用于工具返回给模型看的中文人话**，
  下发给前端的 `stateLabel` 应改成让前端自己按 `state` 走 `t()`（否则英文界面永远拿中文）。
- **撞锁（动手前必须先展开看）**：`steward-drawer.static.e2e.js`、`steward-board.static.e2e.js`、
  `steward-drawer.e2e.js`、`steward-board.e2e.js` 四件里出现过 `stewardShell.drawer.state`——
  要逐条确认是否有断言直接比对了中文/英文字面。
- **伴随断言（新加）**：断言两份 locale 里**不存在第二套** `*.state.*` 前缀（防止再长出一套）。

### 4.5 [P1-5] 浏览器 e2e 漏收尸（D）

- **缺 `stopRuyiTestBrowsers(` 实调用的 10 件**（逐件核实）：`live-full-text.browser`、`pretender-dispatch-home`、
  `pretender-shell`、`pretender-task-sheet`、`steward-board`、`steward-classic-window`、`steward-conversation`、
  `steward-drawer`、`steward-settings`、`steward-shell`（最后一件在**注释**里提过它，但没真调）。
- **对照组**（已做对）：`dom-smoke`、`ec-d-performance`、`pretender-crew-lens`、`pretender-needs-drawer`、
  `pretender-preview-performance`。
- **为什么全量回归看不出来**：`run-all.js:115`（每件之后）与 `:140`（收尾）各扫一次。受害的是**手工单跑**。
- **修法**：`finally` 补一行，不改任何时序。
- **撞锁**：`pretender-preview-ready.static.e2e.js:14-15` 读那两件全文做子串断言，但断言落在
  CDP 业务逻辑（`Network.setBlockedURLs` 等），不涉 `finally`。不撞。

### 4.6 [P1-6] `steward-board.js` 裸 fetch 缺 token 重放（B）

- `net.js:58-71` 的 `api()` 对 403 + `auth.token_invalid` 会 `initToken(true)` 换新 token 重放一次；
  `steward-board.js:159` 的裸 `fetch`（为读 `304`/`etag`，理由成立）`if (!response.ok) return false;` 直接放弃。
- **可复现**：后端重启导致旧 token 失效后，管家看板一直空转到用户手动刷新；其余走 `api()` 的功能都能自愈。
- **修法**：`net.js` 抽 `apiRaw(path, options)`——拼 `authHeaders` + 403 重放，但**返回原始 `Response`**；
  `api()` 改成 `apiRaw(...).then(r => r.json())` 复用它；看板换成 `apiRaw`，304/etag 判断不动。
- **伴随断言（新加）**：403 场景下 `loadMissions()` 应重放成功（当前无此回归测试）。

### 4.7 [P1-7] 「压缩」文案漏 `t()`（A，i18n）

- **真回归**：`chat-stream-runtime.js` 的 `beginCompactIndicator()`（约 388-397）用 `t('chat.compactHint')`
  正确初始化，但 `case 'compact'` 分支（1251/1255-1256/1260/1274）一来就把**同一个 DOM 节点**
  `textContent` 覆盖成硬编码中文——英文界面下先看到英文、一有进度就被中文替换。
- 另有 `navigation-controls.js:534-575`（压缩模型选择器整块）、`workbench.js:473-476`
  （`title` 走了 `t()`、紧挨着的 `aria-label` 硬编码「缩小/放大」）、`agent-roles.js:45`（三元里一半 `t()` 一半裸中文）。
- **四份 locale 必须同步**（`public/locales/{zh-CN,en-US}.json` + `docs/i18n/locales/{zh-CN,en-US}.json`），
  **扁平点号键**（`t()` 是 `catalog[key]`，嵌套会渲染成 `[key]`）。
- **撞锁**：逐条 grep 过，无断言按字面比对这些中文；`copy-path-guard.static.e2e.js` 目前**不读**这三个文件。
- **伴随断言（新加）**：把这几个文件纳入「硬编码中文扫描」名单。

## 5. 明确不做 / 存疑（附理由，防下一轮重复报）

- **51 个 fake provider 的对话剧本**：剧本是各测试的断言前提（如 `pretender-gate.e2e.js` 的「先问再答 Vue」），
  **只有底层写帧函数可合**（P3-23）。
- **`waitHealth` 的具体超时数字**：只能证明「不一致」，不能证明「哪个错」。合并时必须**逐件传回原
  attempts/intervalMs**，不许拍平成默认值——拍平会在偶尔卡顿的机器上制造新 flaky。
- **`reqJson`/`requestJson` 参数顺序与错误语义**：同名不同义的陷阱，本轮不合（见 §2）。
- **管家三件套轮询生命周期**：三份静态锁按**函数体逐字正则**钉着，合并=一次性重钉三个高精度锁。**不做**。
- **`openAiStreamOnce`（SSE 解析 + 工具调用分片装配）**：全仓**唯一**一份，主回合与子代理都调它。
  Claude CLI / Kimi ACP 的 `stream-json`/JSON-RPC 本来就给完整 `tool_use` 块，不需要增量拼装。**真差异。**
- **提示词拼装**：文本层已统一在 `06b-prompt-registry.js`；Claude 引擎的 `--append-system-prompt`
  只拼工具协议子集（`05:225` 注释「Claude 引擎不注入 provider 系统层(CLI 自建 prompt)」）。**文档化的真差异。**
- **`foldMissionChangeJournalText` vs `foldInterventionJournalText`**：一个是**序列 cursor 折叠**（检测缺号，
  服务 `/changes?after=` 分页），一个是**按 id 后写胜折叠**（无序列语义）。**合了会阉割缺号检测。不合。**
- **三套 cursor/分页**（`paginatePretenderProjection` / `/missions/:id/changes` / `readAgentRunEvents`）：
  语义差异由各自存储形状决定（可删物化索引 / 有序号 NDJSON / 大文件尾窗）。**真需求。**
- **`readSessionHeadResilient`（读侧重试）与 `atomicWriteJson`（写侧重试）**：错误码集合、退避参数、
  重试上限三处都不同，`02:2272` 注释已解释读写两侧风险预算不同。**刻意差异。**
- **`DurableJsonStore` 迁移 4 个 store**：**同步读 + 异步写链**契约（`10:253` 同步调 `readSync()` 是刻意设计）。
  硬套到异步读场景 = 把 I/O 变成阻塞事件循环。**本批只登记；真要做，先独立决策「加 `readAsync()` 变体」。**
- **`sessionEngineRouteOverrides` 与 `sessionPermissionModeOverrides` 应用点不对称**：**存疑**。
  权限那张表 load 时也应用且有 `liveSessionPermissionMode`（117m-A1 修的真 bug）；路由那张表只在 save 时用。
  可能是「路由切换要到下一回合才生效」的刻意语义。**没人确认之前不许顺手拉齐。**
- **`sessionWriteChains` / `configWriteChain` / `interventionTransitionLocks`**：被 `audit-w23.e2e.js:135-137`、
  `interventions-cas.e2e.js:172`、`unit/session-head-read.test.js:114-119` 按**变量名字面**钉住。
  P3-24 只做低风险档，**不许消灭这三个名字**——尤其 `session-head-read.test.js` 钉的那三行是 `loadSession`
  防「截断/隔离建在两次独立读之间」竞态的读侧探测（见记忆 `loadSession 的破坏性竞态`），一个字不许动。
- **`JSON.parse(JSON.stringify(x))` 深拷贝 3 处**：**存疑**。要先证明被 clone 的对象里出现过非 JSON-safe 值
  才能升级为发现；目前全仓时间戳统一走 `nowIso()` 产字符串。
- **前后端「双胞胎」**（`09d-token-estimation.js` 与前端 `util.js` 的 `fmtTokens`）：零构建架构下的语言边界，
  源码注释已承诺口径同步。**真需求。**
- **`renderMarkdown` / `escapeHtml`**：全仓各一份，靠依赖注入喂给六个消费面。**已经是干净状态。**
  「看全文」在管家壳里走 `steward-classic-window.js:81-90` 切到经典壳复用其渲染，**不是重复，是已经做对的设计。**
- **`turn-activity.js` / `preview-task-sheet.js` / `mission-state.js` 的「零 import」纪律**：
  P3-21 合并 `fmtDurationShort` 技术上不撞任何锁，但会打破这几个文件互不 import、各自可单测的设计初衷。
  **需要拍板才做**，不拍板就维持现状（靠现有注释提醒同步）。
- **`preview-lenses.js:8-11 defaultLensForState()`**：死代码（零调用点）且返回值与实际 lens id 对不上。
  **不构成重复造轮子**（没人在维护两份并行实现），走「清理死代码」单独工单。
- **`05d-kimi-prompt-parts.js` 的图片附件安全校验比 `04-visual-pipeline.js` 严格**：`04` 不在本次审查范围，
  未核实上传环节是否已有统一安全闸。**存疑，单独排查，不许在核实前合并或补齐。**

## 6. 与 117p（用户第七轮走查）的关系

第七轮走查的报告「2.0 回合已经跑完了，但是管家没有收到体现也没收工」在排障时正好落进本文档的 B 类，
故两件事**同批做**：

- **117p-S1（收件箱第四源基线 off-by-one）**：`13i-steward-inbox.js` 的 `stewardCollectSessionTurn`
  在「首见即活回合」时把基线记成了**正在跑的那一回合**的号。`turnSeq` 是回合**开始**时就 +1 落盘的
  （`05-claude-engine.js:88`、`09-workflow.js:1292`），于是回合真跑完时 `turnSeq` 没再前进，
  唯一那条 `done` 被**永久吞掉**。轮询 15 秒一轮而线程回合动辄几分钟 → 管家开的线程**第一回合几乎必然命中**。
  真机证据（2026-09-08）：`sess_e97b29759a586485` 头上 `turnSeq:1` + `stewardLastTurn{seq:1,ok:true}`，
  游标 `sessionTurns` 记着 `{turnSeq:1}`，inbox 里这条会话**零行**；`server_start` 在 02:18:46Z，排除冷启动路径。
  另修一处窄窗口：回合已起手、还没登记进 `activeChildren`（`09:1292` 与 `09:1381` 之间要跑
  `captureWorkspaceTurnBaseline`，大工作区好几秒）时首见，会当场报一条「跑完了」并把基线推到当前 turnSeq。
  **这条与「重复造轮子」无关，是纯 bug，随本批一起出门。**
- **117p-S2（五态判据 `turnSeq: 0`）**：即 §3 的 P0-3。修法：
  ① `13d buildMissionCard` 给卡片补 `turnSeq` 与 `lastTurn{seq,ok,aborted}`（都是会话头已有字段的投影，
  不新增持久化来源）；
  ② `06i deriveStewardThreadState` 与 `public/js/mission-state.js` 两份抄写件**同步**加一条「无账本线程」分支：
  没有里程碑、没有结果章、没有班组、跑过回合、此刻没在跑 → **已收工**（末回合 `ok:false` 或 `aborted` → 已停工；
  账缺席按成功算，与 13i 的 `@sessionTurn` 解析器「账缺席一律 done」同口径）；
  ③ `13e` 的 `PRETENDER_INDEX_SCHEMA` **3 → 4**（卡片形状变了，且**必须强制重建**——否则存量已跑完的线程
  旧卡片永远不会刷新，用户那条线程会一直卡在「交办中」），同步更新 `dev-harness/durable-state-inventory.js:75`
  与两份生成视图。先例：116-5b 的 2 → 3。

## 7. 派单顺序与并发约束

| 序 | 切片 | 覆盖 | 文件面 | 约束 |
|---|---|---|---|---|
| 1 | **117p-S1** | 收件箱基线 off-by-one | `13i` | 已派单；与其它切片零重叠 |
| 2 | **117p-S2** | 五态 `turnSeq: 0` | `13d` `06i` `13e` `mission-state.js` `durable-state-inventory.js` | **必须等 117o-A7 落地后再派**（A7 正在改 `13d` 的 `GET /api/sessions/:id`） |
| 3 | **117q-B1** | P0-1 NDJSON 解码 | `00` `05` `05b` `07` | 需重跑依赖图生成器；与 1/2 零重叠 |
| 4 | **117q-B2** | P0-2 autoexec 并集 | `03` `06f` | 需先拍板并集口径；零重叠 |
| 5 | **117q-B3** | P0-4 + P1-6 + P1-7 前端三条 | `net.js` `steward-board.js` `steward-drawer.js` `chat-stream-runtime.js` `navigation-controls.js` `workbench.js` `agent-roles.js` `06i` ×4 locale | 需先拍板文案；与 2 在 `06i`／`steward-board.js` 上**有重叠 → 排在 2 之后** |
| 6 | **117q-B4** | P1-5 + P2-12 | 10 件 e2e + `dev-harness/lib/browser-path.js` | 纯 dev-harness，零重叠，可与 3/4 并发 |
| 7 | **117q-B5** | P2-8/9/13/14/15/16/17/18 | `00` `06d` `06e` `06` `07` `08` `09` `10` `agent-workflows.js` | 与 3 在 `00`/`05`/`07` 上有重叠 → **排在 3 之后** |
| 8 | **117q-B6** | P2-10 + P2-11 | `01` `02` | **单独一批、串行做**：`02-session-store.js` 出过真数据事故（记忆 `loadSession 的破坏性竞态`），改完必须跑全部 session/intervention/mission 功能性 e2e，不能只看 static |
| 9 | P3 各条 | — | — | 本波**不排期**，登记在案；等前八批出门且回归干净后再逐条议 |

**所有切片共用的提交纪律**：`git archive HEAD` → 干净副本 → 只覆盖自己改过的文件 → 在那里
`node ruyi-workbench/app/build.js` → `git hash-object -w` + `git update-index --cacheinfo` 入索引 → commit。
**绝不 `git add -A`／`git commit -a`**。（117m 有过一个切片的首个 commit 把另一个切片整份回退掉的事故。）

**生成器链**（最后一次 `src/` 改动之后整条重跑）：
`node dev-harness/route-inventory.js` → `node dev-harness/module-dependency-graph.js --write` →
`node ruyi-workbench/tools/gen-manifest.js` → `node dev-harness/architecture-contract-snapshots.js` →
`node dev-harness/facts-generate.js`。

## 8. 交接状态（2026-09-08，用户额度将尽，换 agent 接手）

### 8.1 已入库

| commit | 内容 |
|---|---|
| `8b8bc21` | 117o 前置：流式回复只上屏 `say`，不再把 `{say:…}` 信封端给用户 |
| `e402eab` | **本文档立项** + 27 号文 §11.11（第七轮走查设计页） |
| `e60fda8` | **117o-A7**：「看全文」的在途回合改用经典壳同一个渲染器（`liveSnapshot()` / `liveTurn` 信封 / `renderStaticMessage` 复用 / 线程↔会话 1:1 断言）。主会话已复核：`git archive HEAD` 重建出的 `server.js` 与 `HEAD:server.js` **逐字节相同**，`live-full-text.static.e2e.js` 在干净树里 ALL PASS，18 个文件全是它自己的 |

> A7 中途独立踩到了本文档 P0-1 的**同一个失效模式**：`live-full-text.e2e.js` 的 HTTP 读法 `b += chunk`
> 逐块 `toString`，汉字被 chunk 边界劈开变 `U+FFFD`，长度断言假红（实测 12002 而非 12000）。
> 它改的是夹具读法。**这是 P0-1 在生产代码之外的第二次独立现形——不要再降级它的优先级。**

### 8.2 交接时仍在跑的三把刀（工作树里的改动都是它们的，别当成脏东西清掉）

| 切片 | 独占文件 | 状态 |
|---|---|---|
| **117p-S1** 收件箱第四源基线 off-by-one | `src/13i-steward-inbox.js`、`dev-harness/steward-events.static.e2e.js`、`dev-harness/steward-quick-ask.e2e.js` | 在途 |
| **117q-B2** autoexec 取并集 + 删死代码 + `makeId` | `src/03-bridge-guard.js`、`src/06f-autonomy-grants.js`、`src/10-context-governance.js`、`src/06d-memory-domain.js` | 在途 |
| **117q-B4** 浏览器 e2e 补收尸 + `browserPath` 收编 | `dev-harness/` 里 9 件浏览器 e2e ＋ 新建 `dev-harness/lib/browser-path.js` | 在途 |

**工作树里的 `ruyi-workbench/app/server.js` 与 `src/manifest.json` 现在是污染构建**（含 13i 的在途改动）。
任何人提交前都必须走干净副本法重新 build，不要直接提交工作树里的产物。

### 8.3 下一刀：117p-S2（规格完整，可直接开工）

**这是用户第七轮走查的另一半，优先级最高。** 前置依赖（A7 占着 `13d`）已解除，可以立刻做。
根因与证据见 27 号文 §11.11 与本文 §6。实现规格：

1. **`13d-core-domain-routes.js:493 buildMissionCard`** 给卡片补两个字段（都只是会话头已有字段的投影，
   不新增持久化来源，与 `lastSay` / `displayTitle` 同一条纪律）：
   `turnSeq: Math.max(0, Number(head.turnSeq) || 0)`；
   `lastTurn: head.stewardLastTurn ? { seq, ok: ok !== false, aborted: aborted === true } : null`。
2. **五态判据加一条分支，两份抄写件（`06i-steward-core.js deriveStewardThreadState` 与
   `public/js/mission-state.js deriveMissionState`）必须逐条同步**，位置在最后那条
   `else state = 'stopped'` **之前**（这样只有本来会落到「已停工」的线程才可能变，前四条判据一个字不动）：
   `else if (src.ledgerless && src.turnSeq > 0) state = src.lastTurnFailed ? 'stopped' : 'done';`
   归一化入参多两个键 `ledgerless` / `lastTurnFailed`（进 `src`，`sources` 证据里看得见）。
3. **`ledgerless` 的判据只能是 `card.status === 'none'`**——`13d` 的 `missionCardStatus(m)` 在 `m` 为 null 时
   就返回 `'none'`（`buildMissionCard` 头注释写着这件事）。**不许**用 `milestonesTotal === 0` 之类的近似判据：
   那会把「一个还没定里程碑的 2.0 任务单」也判成无账本线程，2.0 的语义就被改了。
   `lastTurnFailed = card.lastTurn && (ok === false || aborted === true)`。
4. **三个「没有卡片」的分支也要喂上**：`13d:615`、`13g:616`、`13h:290` 三处
   `deriveStewardThreadState({… turnSeq: head.turnSeq …})` 各补 `ledgerless: !head.mission` 与 `lastTurnFailed`。
   **它们与第 2 条是同一件事的三个投影面，漏一个就是把今天这个 bug 换个地方重演一遍。**
5. **`13e-pretender-index.js:9 PRETENDER_INDEX_SCHEMA` 3 → 4**，理由写进注释：卡片形状变了，
   且**必须强制整份重建**——否则存量那些已经跑完的线程的旧卡片永远不会再刷新（它们的会话文件不会再变），
   用户那条线程会一直卡在「交办中」。先例：116-5b 的 2 → 3。
   同步改 `dev-harness/durable-state-inventory.js:75` 那一行并重跑生成器刷新两份 docs 视图。

**断言（只加不改）**：
- 新单测 `dev-harness/unit/thread-state-ledgerless.test.js`（新文件 = 纯追加），**同时** require
  产物导出的 `deriveStewardThreadState` 与 `public/js/mission-state.js`（双导出，node 可直接 require），
  对同一组入参断言**两份结果逐字相等**，覆盖：无账本+turnSeq 1+账缺席 → `done`；`ok:false` → `stopped`；
  `aborted:true` → `stopped`；turnSeq 0 → `dispatching`；有待决 → `needs_you`（新分支不许抢第 2 条的优先级）；
  `activeTurn` → `running`；**有账本 + turnSeq 5 + 无结果章 + runCount 0 → 仍然是 `stopped`**
  （这条最重要：证明 2.0 任务单语义一个字没变）。
- 静态锁追加两条：两份抄写件里都不再出现硬编码 `turnSeq: 0` 且都出现 `ledgerless`；
  `buildMissionCard` 真的产出 `turnSeq` 与 `lastTurn`。
- **反向验证必做**：把第 1 条的两个新字段临时去掉重新 build，确认新单测真的红，再改回来。

**回归门**：`pretender-gate.e2e.js`（它有 `MissionState.fromCard` 的定点断言：`:107` 刚立单 → dispatching、
`:152` stop 章 → stopped）一条都不许红；`mission-threads.e2e.js`、
`node --test dev-harness/unit/mission-aggregate.test.js`、看板/抽屉件不得变红。

### 8.4 再往后的派单顺序（§7 那张表的执行态）

- **117q-B1**（P0-1 NDJSON 解码 → `00`/`05`/`05b`/`07`）：A7 已放开 `05`，**现在可以派**。
  必须重跑 `node dev-harness/module-dependency-graph.js --write`；伴随断言是「把一个 3 字节汉字拆成两次
  `push()`，断言拼出来的行里没有 `U+FFFD`」——现有 e2e 一条都没有测过这个。
- **117q-B3**（P0-4 五态人话四份 + P1-6 看板裸 fetch 缺 token 重放 + P1-7「压缩」文案漏 `t()`）：
  **需要用户先拍板文案**（见 §8.5），且与 S2 在 `06i` / `steward-board.js` 上重叠 → **排在 S2 之后**。
- **117q-B5**（P2 后端杂项：围栏标签中和 ×6、tier rank ×6、死循环护栏常量、`cachedInTok`、
  `agent-workflows.js` 可见性门控）：与 B1 在 `00`/`05`/`07` 上重叠 → **排在 B1 之后**。
- **117q-B6**（P2-10 尾窗读原语 + P2-11 撕裂尾 → `01`/`02`）：**单独一批、串行做**。
  `02-session-store.js` 出过真数据事故，改完必须跑全部 session/intervention/mission 功能性 e2e。
- **P3 各条**：本波不排期。

### 8.5 挂起：两个等用户拍板的决策

1. **`quick_ask` 的人话到底是「速问」还是「速查」**（英文 `Quick Ask` / `Lookup`）。
   工程侧建议**「速查 / Lookup」**——这个功能的定义是「为了回答一个要读文件/联网/动手才能答的问题
   临时开的线程」，「查」比「问」准。`done` 的英文同理要在 `Done` / `Wrapped up` 里定一个。
2. **autoexec 并集怎么取**。工程侧建议：**只让授权书层（`06f`）变严**，取
   `[/(^|[\/])\.git[\/]/i, ...AUTOEXEC_DENYLIST]`；**工具层（`03`）保持原样**，不扩到整个 `.git/`——
   它是有人值守面，扩严会误伤 `.git/COMMIT_EDITMSG` 这类日常写。
   （117q-B2 已按这个口径开工；若用户改口径，改的是 `06f` 那一行。）

### 8.6 还欠的两件事（不要忘）

- **干净的全量回归**：上一次 `run-all --parallel 4` 是在三个子代理同时跑 e2e 时做的，
  248/64 里那 64 条几乎全是 `FAIL workbench up` / ECONNREFUSED 的**假红**，已判定不可用。
  等本批全部出门、机器空下来之后**在隔离 worktree 里重跑一次**，再报真实门数字。
  注意有 4 件要回主树单跑（依赖主树未入库的 `dev-harness/realhist-fixtures`，或断言写死仓库目录名）。
- **`mission-result.e2e.js` 的回归**：已二分定位到 117m 区间内（在 `dd8f15f` 通过、在 `90691d3` 失败），
  **根因尚未查明**，仍然挂着。

### 8.7 全批共用的提交纪律（吃过亏，别省这一步）

`git archive HEAD` 解到临时目录 → **只**把自己改过的文件复制进去 → 在那里 `node ruyi-workbench/app/build.js`
→ `git hash-object -w` + `git update-index --cacheinfo` 逐个入索引 → `git commit`。
**绝不 `git add -A` / `git commit -a`，绝不 stash 别人的在途改动。**
117m 出过一次「后提交的切片把前一刀整份回退掉」的事故；A7 这次提交后还额外把主索引刷成了自己的新 blob，
防止下一个提交者把它的改动带回退——这个动作值得照抄。

**生成器链**（最后一次 `src/` 改动之后整条重跑）：
`node dev-harness/route-inventory.js` → `node dev-harness/module-dependency-graph.js --write` →
`node ruyi-workbench/tools/gen-manifest.js` → `node dev-harness/architecture-contract-snapshots.js` →
`node dev-harness/facts-generate.js`。
