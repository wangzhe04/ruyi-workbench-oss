# 39 · 桌面 MCP 探针的异步预热（123 波之后的独立一刀）

> **性质**：36 号文 §5.3、37 号文 §6 ①、34 号文 §14 清单 5 登记的同一条债——「`detectDesktopMcp` 改 async」。范围小但横跨四个源文件，独立编号是因为源码里十处注释指向它。做完接 35 号文 §2 的 **124 波 交办与交付贯通**。
>
> **纪律**：沿 32 号文 §4 纪律 1–16 全部。

## 1. 债的原文与现状

122 波 §2.5 把三处 fire-and-forget 与 `generateMcpConfig` 预热挪到 `listen()` 之后，冷启动 `/health` 从 3.3 s 降到 1.2 s，但当时就写了【诚实标注】：**只解决「起跑那一刻」，探针一开跑，那 2 s 里到达的请求照样等**。病根是 `detectDesktopMcp → pickPython → probeDesktopPython` 用 `cp.spawnSync`，一发把整个进程钉住。

本机（12 核）实测冷缓存一轮 **2 407 ms**，选中的是 `mcp/ai-computer-control/.venv/Scripts/python.exe`。它的两处后果：① 每件 e2e 的服务都要在首个 `/api/status` 上付一次，8 路全量里把 `steward-board` 这种「服务多、断言多」的件挤过 120 s 墙（37 号文 §5.5，那条 300 s 豁免就是为它开的）；② 用户真机上「打开工作台等半天」的剩余一半。

## 2. 派单稿被执行者改了：**签名不改，改预热**

登记原文写的是「`detectDesktopMcp`／`pickPython` 改成 async spawn」。照着做要连坐 `resolveExternalMcpServers`：**它有 12 处调用点，散在 8 个模块**（`01-config` ×3、`04-permission-runtime` ×4、`06-provider-engine` ×2、`12-tool-dispatch`、`13-http-router` ×2、`13b-api-domain-routes`），其中 `browser-mcp.static.e2e.js` 是**静态件里同步调**的。一路 async 化下去是跨模块大手术，而要治的病（探针占住事件循环）不需要它。

**本刀的形状**（纪律 1：执行者有权证伪派单稿）：

| 角色 | 谁 | 说明 |
|---|---|---|
| 兜底（保留同步） | `detectDesktopMcp`／`pickPython`／`probeDesktopPython` | 签名一字不改，12 处调用点零改动。冷缓存时它仍会同步探一轮——那是兜底路径，不是正常路径 |
| 正常路径（新） | `detectDesktopMcpAsync`／`pickPythonAsync`／`probeDesktopPythonAsync` | `cp.execFile`（同样不过 shell，与 `spawnSync` 同口径：Windows 上对 PATH 里的 `.cmd` 一样 ENOENT），每发探针都让出事件循环 |
| 会合点 | 进程内 `desktopPythonCache` ＋ `os.tmpdir()` 的跨进程 JSON | 异步那趟写进的，正是同步那支要读的。**预热跑完，同步调用者一发 `spawnSync` 都不用付** |
| 闸门 | `ensureDesktopMcpWarm()` | 唯一一处「主动去探」。在途时并发调用共用同一趟；缓存还热时连 spawn 都不发生，所以可以随手 `await` |

**去重**（33 号文的老主题：第二份实现迟早与第一份不一样）：两条路只在「怎么问那发 python」上分岔，其余全部抽成单一 owner——根目录清单 `desktopMcpRootPlan()`（(a)(b)(c) 三段的顺序）、控制台脚本段 `desktopMcpConsoleScript()`（(d)）、候选归一 `normalizeDesktopPythonCandidate()`、挑人规则 `desktopPythonPicker()`（优先 Full、core 兜底、拿到 Full 收工）、两张缓存的读写 `desktopPythonSelectionPlan/Store()`、环境与产出形状 `desktopMcpRepoEnv/InstalledEnv/EntryFor()`。**这一点是本刀能成立的前提**：预热那趟暖热的必须正好是同步那趟会问的那几把缓存键，两份 walk 一旦分家，预热就白做。

## 3. 落点

- `src/01-config.js`：异步孪生、闸门与它的自动检测门、六处共用件的抽出；`generateMcpConfig` 里 `await ensureDesktopMcpWarm(cfg)`（**排在 `readConfig()` 之后**——「该不该预热」要看 config）。
- `src/12-tool-dispatch.js`：`computeHealth(config)` 开头 `await ensureDesktopMcpWarm(config)`。
- `src/04-permission-runtime.js`：`buildMcpConnectorInventory(config)` 开头同上。
- `src/13-http-router.js`：boot 段三处 fire-and-forget 收进 `ensureDesktopMcpWarm(config).then()`；`/api/status` 的 `desktopMcp` 段先等预热。
- `src/14-main.js`：三个新符号导出给单测。
- 新件 `dev-harness/unit/desktop-mcp-warm.test.js`（5 组）；`dev-harness/boot-listen-budget.e2e.js` 加 1 条墙钟 ＋ 3 把形状锁；`dev-harness/run-all.js` 只改 `steward-board` 那条豁免的注释（§8 ①）。
- 生成物整条链重跑；`facts.unitSuites 44→45`，README 三处随之。

## 4. 三处 `await` 是量出来的，不是想出来的

第一版只在 `/api/status` 的 `desktopMcp` 那一段等预热，`boot-listen-budget` 却**时绿时红**。用 `--require` 预载把 `cp.spawnSync` 整个包起来（命令、耗时、12 层调用栈，只打 >150 ms 的）一跑就看见了：真正先撞上的是

```
probeDesktopPython <- pickPython <- desktopMcpFromRepo <- detectDesktopMcp
  <- resolveExternalMcpServers <- desktopControlState <- computeHealth <- async handleApi
```

**`health` 与 `mcpConfigPath` 这两个字段在响应体里排在 `desktopMcp` 【前面】**——同一个响应里谁先谁后，决定了你 patch 的那一处有没有用。补上 `computeHealth` 与 `generateMcpConfig` 两处之后，同一份追踪里 **boot ＋ 首个 `/api/status` 期间，python 同步探针 0 发**。

（方法本身值得复用：量「谁在阻塞事件循环」，`--require` 包 `spawnSync` 比读码快得多，也不会像读码那样漏掉排在前面的那一处。）

## 5. 判据与反向

**新件 `unit/desktop-mcp-warm.test.js`**（五组；前两组在子进程里跑，要证的正是「换一个进程也不用再探」与真实的事件循环占用）：

- ① **差分对照**：同一发慢探针（假 python 睡 900 ms 后以 1 退出），异步版最大计时器迟到 `< SLOW_MS/3`、同步版 `≥ SLOW_MS*0.6`，两边都真跑满 900 ms。**同步那一半是这条断言的尺子**——先写时量到 `maxDrift=0`，因为同步调用与 `clearInterval` 在同一跳里，计时器压根没机会打出那一跳；补上「前后各让两三跳」才量得出来。
- ② **跨进程**：异步预热那趟写进磁盘缓存（恰一条、`value:null`），**另一个进程**的同步 `pickPython` 拿到同一答案且 `< SLOW_MS/3`。
- ③ **挑人规则同形**：不存在的候选连探都不探；`core` 之后遇到 `full` 改选 `full`；`options.probe` 这个测试口在异步版里同样被 `await`。
- ④ **闸门**：在途时并发调用共用同一个 promise 对象；落定之后再叫是新的一趟。
- ⑤ **不该预热就一发都不放**：停用／显式 `command` 覆盖／`autodetect:false`／根本没给 config，四种都立刻返回 `null`（< 50 ms——真走一趟 walk 本机是 2.4 s）。

**`boot-listen-budget.e2e.js`**：新增「探针在飞时 `/health` 仍然秒答 ≤ 800 ms」，另加三把形状锁（异步孪生在、异步探针走 `execFile`、boot 段三处 fire-and-forget 排在 `ensureDesktopMcpWarm().then()` 里）。原来那条「`detectDesktopMcp` 保持同步签名」**留着并改了理由**——它从「本刀不改，已登记」变成本刀的拍板本身。

**反向（都真做了）**：
- 异步版偷偷换回 `probeDesktopPython` → 单测 ① 红（`最大迟到 995 ms < 300`）。
- 拔掉 `desktopMcpAutodetectWanted` 那道门 → 单测 ⑤ 四条全红（停用时也真走了 2.6 s 的 walk）。
- 拔掉 `/api/status` 那句 `await ensureDesktopMcpWarm()` → `boot-listen-budget` 红（`/health 实得 2 389 ms`）。
- 拔探针一律用带标记的行加删，不用 `git checkout --`（38 号文 §4 刚踩过）。

## 6. 实测

| 量 | 修前 | 修后 |
|---|---|---|
| 冷缓存一轮探针 | 2 407 ms（同步，钉住进程） | 2 4xx ms（异步，不钉） |
| 首个 `/api/status`（冷） | 2 594 ms | 2 544 ms（**没变，也不该变**：它要如实报 `desktopMcp`，就得等那趟探针出结果） |
| **同一时刻的 `/health`** | **2 389 ms** | **2 ms** |
| boot ＋ 首个 status 期间的同步 python 探针 | 1 发 | **0 发** |

**【诚实标注】**：本刀改善的是「别人不用陪等」，不是「首个 `/api/status` 变快」。首个 status 仍要付一趟探针的墙钟——真要让它也快，得让 UI 接受「桌面控制：正在探测」这种未定态，那是产品决定，登记。

## 7. 收尾

- **全量（4 路，本机 12 核）第一轮**（自动检测门那一处还没加时）：**343 pass／1 fail／6 flaky／344 ran，真回归 0**。唯一那一红 `mission-index-scale (a) 列表冷门 1921 ms > 1500` 是 4 路争抢：**串行复跑 3 次全绿**（1047／1088／1184 ms，另一条 `(e) 详情冷` 648／656／696 ms 对 800 ms 门）。6 件 flaky（`budget-guard`／`agent-deadlock-watchdog`／`dom-smoke`／`steward-board`／`event-stream-replay.browser`／`workbench-thread-head.browser`）都是首跑失败重跑通过。**realhist 三件在本机是绿的**——这台就是 35 号文 §4 ② 说的「有夹具的那台」。
- **全量第二轮（交付轮，加完自动检测门之后）：344 ran，344 pass／0 fail／7 flaky——`0 红`。** flaky 七件（`budget-guard`／`session-index`／`agent-deadlock-watchdog`／`dom-smoke`／`mission-start-race`／`steward-conversation`／`walkthrough-round1.browser`）全是首跑失败重跑通过，与本刀无关（两轮之间 flaky 名单只有 `budget-guard`／`agent-deadlock-watchdog`／`dom-smoke` 三件重合，其余各换各的，是典型的并行争抢）。本刀相关件：`boot-listen-budget` 5.5 s、`desktop-mcp-smoke` 16.6 s、`mission-index-scale` 18.4 s，**`steward-board` 首跑即过 6.9 s**（§8 ① 要用这个数）。
- `--fast` 71/71；`build --check`／依赖图 `--check`（53 模块／418 边／1 SCC）绿；单测 381/381（50 suite）；改动文件 0x00–0x1f／`\r` 扫描 0 命中。
- **一处自查修回来的洞**：第一版 `ensureDesktopMcpWarm()` **无条件**预热——而两条读路本来都有门（`resolveExternalMcpServers` 要 `dm.enabled`，`buildMcpConnectorInventory` 要 `dm.enabled !== false`，且都要 `autodetect` 且无显式 `command`；04 那句 55a 注释写着「禁用时不应阻塞 GET 清单」）。等于我给「用户明确关掉了桌面控制」的机器新加了一轮探针。修法：`desktopMcpAutodetectWanted(config)` 取两道门里松的那个，拿不到 config 一律不预热（退回旧的同步兜底）；五处调用点全部改成传 config。单测第 ⑤ 组四种配置各断言「立刻返回 null」，反向拔掉那一行 → 四条全红（实测走了 2.6 s 真 walk）。
- `facts.unitSuites 44→45`（`e2eCount` 不变：只扩了既有件，没新增 e2e 文件）；README 三处「44 组 unit suite／44 unit suites」同步。

## 8. 登记

1. **`steward-board` 那条 300 s 豁免**：撤销条件写的是「`detectDesktopMcp` async 化还完回来复测」。根因这一刀已经还上（每个 worker 首个 `/api/status` 不再钉住事件循环），本机 4 路两轮的实得也在往这个方向走——第一轮它还是 flaky（首跑失败重跑过），**第二轮首跑即过、6.9 s**（豁免值 300 s、默认门 120 s，都远得很）。**但豁免先不撤**：原始现象只在 24 核那台的 8 路下出现，本机 12 核跑 4 路复现不了原始故障，「没复现」不等于「治好了」（32 号文纪律 6 与 `falsify-race-shape-ladder` 那条记忆的同一条规矩）。撤销条件写进了 `run-all.js` 的注释：在 24 核机器上跑一轮 8 路全量，本件首跑即过且墙钟远在 120 s 内，那时连注释一起删。
2. **`listen()` 之前还有 1.19 s 的同步 spawn**：`normalizeConfig → defaultConfig → detectClaudePath／detectKimiPath`，实测三发（`cmd.exe /d /s /c` 189 ms ＋ `claude --version` 156 ms ＋ `kimi --version` **844 ms**）。这是「打开工作台等半天」剩下的大头，而且排在 listen 之前，谁都挡不住。同一套修法（异步预热 ＋ 缓存会合）可以照搬。
3. 冷缓存下首个 `/api/status` 仍 2.5 s（§6 的诚实标注）；要动得先定「未定态怎么显示」。
4. `ensureDesktopMcpWarm()` 没有自己的总超时：最坏情况等于旧的同步 walk 最坏情况（每个候选 5 s × 候选数），只是不再阻塞别人。真出现这种机器再谈，不预造。
