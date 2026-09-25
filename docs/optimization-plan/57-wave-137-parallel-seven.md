# 57 号文 · 第 137 波：七路并行（子代理新模式 / 迁移中心 / 分引擎提示词 / 管家界面 / 线程视图 / 设置重组 / 工作区）

> 2026-09-24 夜 → 09-25。起点 master `f8aecfcf`（56 号文那批，全量当时没跑完）。用户一次提出九件事、中途补三件，
> 授权「多派子 agent 并行，Sonnet/Opus/Fable 按难度分配」。本文件记：需求原话与裁决（§1）、每路交付与根因（§2）、
> 替用户做的默认决定（§3）、集成过程与硬教训（§4）、验证读数（§5）、未做与用户侧注意（§6）。

## §1 需求（用户原话摘）与分路

| 路 | 模型 | 原话 | 范围 |
|---|---|---|---|
| W1 | Fable | 子代理的上下文压缩/工具调用的记录不要带进主会话中，最好新设计一套代理模式；Spawn Agent 和 Orchestrate Agent 是不是有点重复……agent 在后台跑的时候主会话也可以继续跑 | 代理模式 v2 |
| W2 | Opus | 本机上有 claude code、claude.md、agents.md 等，同步进如意原生的全局记忆/核心记忆……迁移 claude code、codex 的技能 mcp……包括把老的如意迁移到新的如意里；安装包可能在电脑里的任意位置 | 迁移中心 |
| W3 | Opus | 根据不同引擎的线程设计不同的提示词，让 claude code 知道它是在如意工作台中、有什么能力；RipGrep 和 Mermaid 在如意启动后会自动注册吗，疑似至少 ripgrep 不会 | 引擎运行环境说明＋rg/mermaid |
| W4 | Fable | 管家界面右边的线程永远收不起来，打开线程点击了会像没有反应一样，帮忙重新设计管家界面的 UI/UX，或许默认直接打开工作台里的对应线程 | 管家壳功能＋W4b 视觉 |
| W5 | Sonnet | 管家开的线程在运行中显示本轮所有工具记录总结，看起来像回合结束；运行中的回合左下角加小动效；左侧线程里工具显示让线程变大变小 | 线程视图三处 |
| W6 | Opus | 设置里的内容有点乱，把重复/类似的设置统一成公用的设置 | 设置重组 |
| W7 | Opus | 如意自己开的工作区默认不显示在常用工作区中；管家需要把工作区和任务联系起来，很多任务应该在特定工作区开，管家会新开工作区 | 工作区 |

并行纪律：每路一个 `isolation: worktree`（**注意：永远从 master 建**），文件归属互斥；运行时/浏览器件一律经全机互斥锁
（scratchpad `ruyi-e2e-lock.js`，锁目录 `%TEMP%\ruyi-e2e-machine.lock`，按 PID 判活，忙返回 75）；全量只由主会话在集成分支跑。

## §2 交付与根因

### W1 代理模式 v2
- **单一入口**：`spawn_agent` 从 schema／offer／提示词／MCP 面删除；`orchestrate_agents` 加顶层单代理简写 `{task, role?, toolTier?, model?, resources?, background?}`。
  旧模型仍调 `spawn_agent` → 翻译成单节点并附提示（兼容口留在 `TOOL_HANDLERS`，档位 exec、包 agents——集成期补回，见 §4）。
- **交付信封**（08 `buildAgentRunEnvelope`）：每节点 summary 按句截 ≤1500、总量 ≤9k，不带 toolEvidence／progressLog；provider tool_result、持久化 toolCalls、MCP 回环、wait_agents 一律只给信封。新工具 `agent_result` 有界分页取全文。
- **后台**：`background:true` 立即回执；run 不挂父回合 abort；完成走后台任务账本、下一迭代边界或下一回合开头只投递一次；后台任务条可停，停止能中断子代理在跑的长命令。
- **五条泄漏全堵**：子代理 compact 不改父电量表/叙事/活动条；`appendLiveTail` 与顶层工具卡不收 subagentId 事件；编排原文不进 providerHistory 与消息；finalizeAll 不再把后台段标 cancelled；账本 aux 行带 subagentId/runId。
- **窗口一致**：工作流 Claude 节点窗口走与主会话同一条链（手填→名称表→1M），不再 200K 兜底（56 号文 ② 收口）。

### W2 迁移中心（新模块 `13u-migration-center.js`，零入边经 00-boot MigrationHooks）
- 指令文件 → 核心记忆：`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`（有 override 优先）、`~/.kimi-code/AGENTS.md` 启动期自动导；Gemini 只列可导入。按标题拆块，源变则未改过的条目自动同步、改过的只标「来源已更新」；删掉即记忽略。**去重**：Claude CLI 回合不注入 CLAUDE.md 那份、Kimi 不注入它自己那份（集成期把工作流 Claude 节点也接上同一去重）。
- MCP 自动导入扩到 Claude Code／Codex／Kimi 三家（沿用 `autoImportClaudeCodeMcp` 开关），导入条目不回写任何 CLI 配置。
- 技能活读新增 `~/.codex/skills`、`~/.kimi-code/skills`、Claude Code 已安装插件技能。
- 老版本：数据根 `install-registry.json`；从登记表＋几处配置里的绝对路径识别老包（不全盘扫）；预览逐项勾选 → 备份后改写 → 迁移日志可撤销；「移到回收站」只进回收站，拒绝当前包/运行中/仍被引用/装着数据的目录。
- 界面：设置「集成与 MCP」页签末尾的迁移区块；两种视角一次性首启卡「查看并迁移／以后再说」。路由 `/api/migration/{scan,apply,undo,recycle}`。

### W3 引擎运行环境说明＋ripgrep／Mermaid
- **ripgrep 根因**：`probeRg` 找的是 `appRoot()/vendor-bin`，而 `appRoot()` 是 server.js 的上一级（产品根），随包 `app/vendor-bin/rg.exe` **从来没被认出过**；「有 ripgrep」全靠用户 PATH 上碰巧有 rg。05c Kimi 搜索策略的信任锚点同病。修：00-boot 把锚定的 `app/vendor-bin`（真目录、拒链接）前置进进程 PATH，所有子进程继承；probeRg 异步化，`/api/status` 不再同步 spawn；05c 锚点改到真实位置并加严两条判据；体检新增「快速搜索」「图表渲染」两项。
- **引擎说明**：06 `buildEngineEnvBrief` 单一事实源，Claude Code／Kimi Code 各一版 `<ruyi-environment>`（身份版本、原生工具与如意 MCP 工具分工、桌面控制、终端 rg、mermaid 成图、工作区、权限档、管家看管/代开），只随能力集合变、同能力集逐字节稳定（meta.envBrief 指纹）；provider 不重复身份层，只补差。
- `PROMPT_PACK_VERSION` 2026-w108-1 → **2026-w137-1**（集成期统一 bump）。

### W4 管家壳（功能）＋ W4b（视觉第二轮）
- 右栏可收起：栏头开关；×/Esc/交回管家在常驻栏＝收起，不再被 `syncNow` 自动挑选顶回；偏好本机持久；收起态 44px 窄条（在跑/等你计数、新动静点）；管家自己换焦点不顶开，用户明示要看才展开。
- 「打开」一律去工作台（`openInWorkbench`），右栏预览退给点行；工作台线程头「回到管家」。
- W4 功能对但视觉几乎没变（前后截图对照），主会话挑出八条问题派 W4b（Fable）。W4b 总则「缺省值不当信息印」：右栏标题程序性聚焦不画环；左栏收工行一行「色点 · 名 · 刚刚」；中栏展开/收起两态同一条 720 居中列；右栏单线程不印页签、元信息「刚刚 · 工作区名 · 验收 a/b」、跟全局的 chip 收成无边小字、已收工不印「停止」、动作行只剩金色「在工作台打开」＋次动作＋「更多」；头部只剩一颗状态点＋「空闲」，有事才说几条在跑/等你；递话 chip 缺省态为「@」圆键（读屏仍是「→ 如意」）；工作区名安静印出（如意自建的不印、不印路径）；390px 顶栏不再重叠。像素基线重录。

### W5 线程视图
- 运行中回合（管家开的 live 卡）不画「本轮记录 · N 次工具调用」，结束后才画（`renderStaticMessage` 的 `running` 门）。
- 运行中回合左下角呼吸点（两种来源共用 `.live-turn` CSS，reduced-motion 静止）；全程未改 chat-stream-runtime.js。
- 左栏行高：在跑期间副标题行恒在（工具间隙显示「运行中…」），只在开始/结束各变一次；数字 tabular-nums。

### W6 设置重组
- 新结构：通用（基础／**权限与安全**／**用量与限额**）· 管家 · 模型与服务（**模型分配**一张表八行／服务商／Agent CLI／Agent 角色）· 工具与集成（联网搜索／集成与 MCP）· 系统（体检／高级／更新）。简易模式 9 页。
- 模型分配表共用一个「服务商＋跟随主模型」构建器（替掉四份重复实现）；引擎三处合一（主模型下拉含 Claude Code／Kimi Code）；全局权限从管家页移到「权限与安全」，切「智能自动」就地确认且带 confirm；权限/提问等待时限（0＝不限时）首次有界面。
- 除服务商卡片外全部即改即存；服务商卡片「保存服务商／放弃修改」＋未存标记。
- 三缺陷：旧草稿回滚（草稿与最新配置三方合并＋保存前复核，并修掉慢状态刷新把旧配置盖回的竞态）、向导选「智能自动」409、保存提示文案不准。

### W7 工作区
- **管家乱开工作区的根因**：管家上下文里只列工作区的**目录名**，而 cwd 校验只认绝对路径 → 它填的名字全被拒、拒绝文案又叫它省略 cwd → 每件事落进新的 `~/Ruyi/<标题>`；新目录还被追加进 `workspaces[]`（就是「常用工作区」），前端保存又会剥掉「如意自动开的」标注。用户真机上的「下周A股走势分析」「下周美股走势分析」即此。
- 如意自建目录改记 `stewardManagedWorkspaces`，读配置时把遗留行迁过去（默认工作区永不迁）；用户自己加回常用的以用户为准；前端列表另有数据目录与自建目录的兜底过滤；无任何「托管」字样。
- cwd 选择：用户点名（短名或全路径）＞事项记录的工作区＞相关线程/同事项最近线程的目录＞新建 `~/Ruyi/…` 并记为自建（隐藏）。事项首个有工作区的线程落地时记下工作区。管家上下文「已知工作区」清单 ≤20 行／2400 字。读模型新增 `missionWorkspace`、`workspace`、`cwdSource` 等字段。

## §3 替用户做的默认决定（可推翻）

1. 子代理默认仍前台等待，`background:true` 才后台（同 Claude Code 的 Task 工具）。
2. CLAUDE.md 等导入的是如意**核心记忆**，不是服务商系统提示词；Claude/Kimi 引擎按来源去重。
3. 老版本迁移（56 号文 §3.3 三条）：一键全改但预览可逐项取消；只进回收站；老包一次列全；旧名 MCP 条目在新包有对应文件就改路径、否则提议移除。`desktopMcp`/`claudePath`/`kimiPath` 只报告不自动改。
4. 管家兜底新建目录放 `~/Ruyi/…` 并隐藏，而不是用户默认工作区——用户真机默认工作区是家目录，是风险最高的工作目录，且会让所有管家线程挤在同一把 cwd 锁后。
5. 「打开线程」默认去工作台；右栏只做预览。

## §4 集成过程与硬教训

合并顺序 W3 → W4 → W5 → W7 → W6 → W1 → W2 → 集成收尾 → 第一轮全量修补 → W1 补刀（快进）→ W4b → 第二轮全量修补，均进本地分支 `wave137`（cherry-pick；W1 补刀建在 wave137 上故快进），最后快进 master；生成物（server.js、manifest 行区间、module-contracts、依赖图、route-inventory、contract snapshots、durable inventory、facts、README 计数、LEGACY_STYLES_SHA256、process-safety／fixture-home 计数）冲突一律取一边后整条生成器链重算。

1. **对 `manifest.json` 取「ours」会把别人新增的模块从构建清单里丢掉，而 `build --check` 仍然绿**（它只核 manifest 自洽）。W2 的 `13u-migration-center.js` 就这样差点整个没进 server.js——靠「模块数 54 ≠ 执行者报的 55」发现。**合并后必核模块数/边数与执行者报告一致。**
2. 执行者在自己分支上漏跑的锁会在合并后才暴露：W1 的新件含 `Date.now() - stopAt < 20000` 没写墙钟豁免（fixture-home 墙钟窗口锁）；W3 在 06b 注释里提到 spawn_agent 撞了 W1 的「06b 不再提 spawn_agent」锁。
3. **两个执行者的锁可以互相矛盾**：W1 的静态锁要求 tier 表里没有 spawn_agent，tool-dispatch L4 要求每个注册工具都有 tier——W1 留了兼容口却删了声明。按安全不变量裁决（缺 tier 会落默认低档），改写 W1 的锁并反向验证。
4. **`isolation: worktree` 永远从 master 建**，不从当前分支；派基于集成分支的刀要让执行者先 `git merge --ff-only wave137`。
5. 额度两次截断全体代理；`SendMessage` 能原样续上，但要让它们阶段性 wip 提交。Sonnet 仍有「停下等后台通知」的老毛病，这次它自己被唤醒续上了。
6. 辅助脚本（scratchpad）：`resolve-css-pin.js`（合 CSS 锁冲突并按工作树重算）、`readme-counts.js`（README 五处计数）。

## §5 验证读数

- 集成分支第一轮全量（`run-all --parallel 8`，经锁）：**395 pass / 6 fail / 3 flaky / 401 ran**。
  - 6 红：3 件为本机缺 `realhist-fixtures` 的既有环境红（observation-recall-realhistory／-replay、session-notes）；3 件真红均为合并面问题——tool-dispatch（注册表 106→107＋spawn_agent 缺 tier/pack）、workbench-self-status（107）、kimi-prompt-parts（抽源注入缺 EventStreamHooks）。修后经锁串行全绿（`177f2467`）。
  - 3 flaky（model-menu-no-shift.browser、steward-memory、summary-single-shot）：8 路满载下首跑红，经锁串行首跑即绿，登记观察。
  - 复验中发现 agent-mode-v2 F 段首跑红：后台 run 若在模型调 wait_agents **之前**跑完，迭代边界先注入一次、wait_agents 再返回一次——「恰好一次」只覆盖了一种先后顺序。交回 W1 修（见下方补记）。
- **W1 补刀（`65dcad5d`）**：根因如上；另查出测试侧 needle `CMD_WAIT6B` 含子串 `CMD_WAIT6` 被 fake 抢配，「通知先到」场景其实从没跑到。修：`wait_agents`（provider 与 MCP 回环两面）经 `settleWaitEnvelopes` 结算——已被通知送达的 run 只回短回执 `agent_envelope_receipt`，否则登记已读；F 段拆成 F1（wait 先到）/F2（通知先到）两种确定性时序各断言「恰好一次」，反向验证过；连跑 3 次绿。
- 集成分支第二轮全量（W4b 与 W1 补刀合入后）：**397 pass / 5 fail / 4 flaky / 402 ran**。
  - 5 红：3 件既有环境红同上；2 件真红——composer-voice.browser G5（W4b 让「@」与输入行同行后，390px 录音态输入框被挤到 106px < 120px 下限；修：≤480px 录音/预热期间让出「+」）、subagent-net-tools ⑤（与 agent-mode-v2.static ① 同一处 spawn_agent tier 矛盾）。修后（`b708c449`）经锁串行全绿。
  - flaky（summary-call-policy、summary-refine、summary-single-shot、usage-claude-cached、workbench-memory）经锁串行首跑即绿。summary-single-shot 两轮都抖，挂进「并行回归偶发治理」。
- `run-all --fast` 79/79；依赖图 55 模块 / 440 边 / 1 SCC；`build --check` 新鲜；e2e 409（默认 402）、unit 76、原生工具 107；app.js 1265/1280。
- **结论：真回归 0**（每一件红都已定位到合并面或本机环境并修掉/说明）。

## §6 未做与用户侧注意

- **真机要重新打包才有这些改动**（用户日常跑的是 dist 打包副本）。
- `~/.win-claude-workbench/config.json` 的 `permissionTimeoutMs` 仍是显式 300000（56 号文已记），新设置页「权限与安全」可直接改成「不限时」。
- 未经真机验证：回收站 PowerShell 路径（测试里换成挪进临时目录）、Claude Code 插件技能读取（本机没装插件）、Kimi 全局 AGENTS.md 与技能目录位置（从 kimi.exe 字符串核实，无官方文档）。
- 未扫：桌面/开始菜单快捷方式、定时任务命令、toolbox 登记里的老包路径。
- 不做：`agent_stop` 工具（后台任务条已能停）；W6 未删的无用 locale 键（减少冲突，后续清）。
- 3.0 正式版的门（50/55 号文）不因本波改变。

## §7 发布：v3.0.0-preview.2（2026-09-25）

- 用户 2026-09-25「commit push、重新打包、端到端验证、发布 3.0 preview 的 GitHub Release」。经 API 核实 **v3.0.0-preview.1 只推了标签、从没建出 Release**（最新 Release 仍是 v2.6.2）；远端标签不挪动，改发 **v3.0.0-preview.2**，Release 覆盖自 v2.6.2 以来全部变化。
- 发布提交：版本三角 3.0.0-preview.2、CHANGELOG 新节、README 横幅、`docs/release-notes/v3.0.0-preview.2.md`。`release-dryrun` ALL PASS（212 载荷 sha256 0 差、桌面壳编译）；`--fast` 79/79。
- 打包（原生 PowerShell）：Slim 78.11 MB；Full 775.52 MB（ACC 17,588 文件完整性全过）。**坑**：Full 带 `-SkipExeBuild` 会少 Ruyi.exe（737 MB），须不带该开关重打。
- SHA256SUMS：full `286c800ba3f5a68b71c6bd2f4140570856073eb48492b7847873808d8ed6dcee`、slim `911749e4b3c9d15cf335702f349d20b5e760281b6474755716d6a413e2c431d2`（sha256sum -c 过）。
- 全新目录冒烟（系统 tar.exe 解包；USERPROFILE/HOME/RUYI_HOME 全隔离、随机端口、只停自己的进程；不跑 Start-Workbench.cmd）：slim/full × 自带 node/Ruyi.exe 四种 1.8–3.1 s 起来，版本均为 3.0.0-preview.2，`binaries.rgSource=bundled`。
