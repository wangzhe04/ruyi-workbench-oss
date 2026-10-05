# 61 · 模型自评「harness 不足」的核实与收敛

> 状态：**A/B/C 三批已实现（2026-10-04）**；C5 按用户拍板不做（用户常会打字指定工作区外的路径让写）。实施结果与遗留缺口见 §3。
>
> 起因（2026-10-04）：工作台里一个 provider 会话的模型以只读方式自查了一遍 harness，交出一份「我在这套 harness 里干活最别扭的地方」
> 报告（8 条 + 「只改三件事」）。用户原话：「这是当前 agent 自己探索出来的工作台的不足，你看看验证一下，或者派波 sonnet 走查一下，然后出方案优化」。
> 走查分四路：工具发现/调用链路、重复能力与编码、记忆/失败/技能/缓存、本机日志实测（`~/.ruyi-workbench/logs` 5 天 1837 条事件 + 会话工具结果回联）。

## §0 一句话

**报告的方向大体对，但证据有一半是旧构建的：日志里多数 `tool_invoke_*` 失败发生在 10-03 两笔代理修复（4e34d6d5 壳还原 / 0887100a 参数骨架）之前。
真正要修的反而是报告没看到的几处：非中文代码页机器上 `powershell_run` 的中文全变 `?`、「能力总闸」关不住桌面 MCP 的同类工具、provider 引擎根本不知道现在几点。**

## §1 逐条核实

| # | 报告说法 | 结论 | 纠偏 / 补充 |
|---|---|---|---|
| 1 | 166 个工具只认识 17 个，`tool_search` 参数摘要截断，搜→调吃轮次 | **部分属实** | 常驻 17 属实；`args` 骨架规则是必填≤6＋可选≤2、≤140 字，实测 41% 被截（尾注带剩余必填数）。`tool_load` 不回 schema，下一次模型调用才进表。经代理调**原生**工具会自动整包装载（`proxy_promote`），摩擦主要在**桥接**目标。新发现：`tool_load({packs:['desktop']})` 对桥接工具是静默空操作（`ok:true, loaded:[]`，无提示）。「搜索批很窄」不成立：含 `tool_search` 的批均宽 2.45 |
| 2 | 三个 `tool_invoke_*` 逼模型猜 tier；`list_tools` 不给 tier | **属实但代价被夸大** | 拆三个是有意的：权限闸、auto 扫描、授权书、子代理 tierFilter、CLI 权限桥（`mcp__ruyi__tool_invoke_*` 规则）都按名字定档；高档代理调低档已放行。日志里 tier-mismatch 仅 2 次（其一是元会话的故意探针），自然失败的大头是 10-02 旧构建里「漏写顶层 `name`」×8 —— 已由 `toolInvokeMissingNameResult` 修。`proxyTargetTier` 是遥测字段，模型实际收到 `{code,error,hint}` |
| 3 | 同一能力多份实现、tier 不一致 | **部分属实，方向有误** | 24 个 ACC 工具与内置重叠（强重叠 9）。桥接 `fetch` 反而更严（exec，`web_fetch` 是 read）。真正的缺口不在 tier 数字：①**「能力总闸」`allowCommandTools` / `allowDesktopTools` / 会话级桌面开关只拦原生工具**，ACC 的 `run_command`、`screenshot`、`mouse_click`、`type_text` 照常提供、照常执行，与设置页「关掉后在所有线程里既不提供给模型也不会执行」的承诺不符；②桥接写族不过工作区写闸（只有绝对路径检查＋写前快照，越界静默不快照）；③目录里没有「首选」标注 |
| 4 | GBK 文件 `Get-Content` 乱码、文件名成 `?????` | **属实，根因不同** | 本机 en-US（OEM 437 / ANSI 1252）。PowerShell 把输出按控制台代码页编码，**所有中文在源头就变成 `0x3f`**，Node 侧 `decodeConsoleText` 无从还原 —— 不只是 `Get-Content`，`Write-Output '中文'`、`Get-ChildItem`、ACC `run_command` 的 `dir` 全中。现有注释「`[Console]::OutputEncoding` 在无窗口 spawn 下无效」在本机不成立（`windowsHide` 子进程有自己的隐藏控制台；已复现修前 `????` / 修后正确）。另：`file_edit` 两条 hint 让模型「用 powershell_run 按原编码读写」，现状下会把它引向乱码 |
| 5 | 记忆通道太礼貌，库是空的 | **属实且更紧** | 每会话一个候选槽，`propose/relation_propose/revise/relation_revoke` 四个工具共用，新候选顶掉旧 pending。没有模型可写、即时生效的草稿本（session-notes 由运行时在压缩后写）。ACC `no-source` 是「标准位置没有旧文件」的正常空跑，不是故障 |
| 6 | 失败反馈不足以自愈，unknown 占 54% | **对遥测属实，对模型基本不成立** | `classifyRuntimeToolFailure` 是 shadow 遥测，不进模型上下文。`web_fetch` 失败信封本就带 `failClass`（dns/connect/tls/reset/timeout/http/…）＋`statusCode`＋`hint`，「分不清 403/反爬/超时」不成立（19 次失败里只有 2 次「request error」不透明）。但分类器确有规则缺口：没读 `failClass/statusCode/code`，13 条网络失败与 7 条代理/参数错落 unknown；**403「网站拒绝了请求」被 `/拒绝/` 误判为 `permission_denied`** |
| 7 | 技能/Playbook 够不着，`orchestrate_agents` 起不来 | **部分属实** | 内置 20 技能、16 Playbook 在安装目录 `resources/`（`dataDir/skills|playbooks` 是用户自装层，空是正常的；「找不到」不成立）。Playbook 确无工具，且**提示词索引 600 字只放得下 16 个里的前 6 个**；技能 `residentSkills` 默认空，新会话看不到。工作流**可以**经 `orchestrate_agents{workflowId}` 执行；provider 会话的子代理走 HTTP，不依赖 `claude.cmd`（本机确实没装 Claude CLI，失败文案也不给修法） |
| 8a | 没有 checkpoint 列表/撤销工具 | **属实** | 回滚只在 UI/HTTP（`/api/checkpoints/rollback`）；写成功信封不带 turnSeq/entrySeq；用户撤销后模型不知道 |
| 8b | 检索噪音 | **属实** | 根因是「撤销」能力对模型不存在＋`file_move/file_copy/http_download` 描述里有「可一键撤销」被 bigram 命中＋无低分阈值、空命中不给任何提示 |
| 8c | 幂等缓存结果不可见 | **不成立** | 命中带 `cacheHit:{cachedAt,ageMs}`（只缓存 `file_read`，命中前重 stat，内容必新鲜）；实测 14 条全是 miss/store，0 命中。只是字段没说明 |
| 8d | 描述太长 | **属实** | 原生描述有字符预算棘轮；桥接描述原样透传 ACC docstring（含 Args/Returns）。默认桥接工具不进工具表，只在精确名装载后才占上下文 |
| 8e | 时间口径 UTC vs 本地 | **比报告更严重** | provider 引擎与管家的提示里**根本没有当前时间**（06 注释为保前缀缓存刻意排除）；模型只能靠 `powershell_run` 取时 |

报告数字的口径问题（不影响结论，记下免得以后再被引用）：`tool_call_completed` 是采样明细（前 12 次模型调用全采、之后每 4 采 1），
真实总量看回合末 `econ_call_totals`；失败率 39/256 的分母不可复现（真实 52/411≈12.7%）；`web_fetch` 失败真实 19 次；`file_reed` 是元会话里的故意探针。

## §2 方案

### A 批 · 缺陷（直接修）

- **A1 PowerShell 中文输出**：`04-desktop-shell` 的脚本前导（`powershell_run`、`script_run` 的 PS 分支共用）与 `shell_start` 脚本头加
  `try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)}catch{};$OutputEncoding=[Console]::OutputEncoding;`（无 BOM 变体；同一行不加换行，报错行号不漂；
  `param()`/`using`/`#requires` 开头的脚本沿用豁免）。设不上时退回现状，Node 侧按行 UTF-8→GB18030 仍兜底。订正两处过时注释；改写 `file_edit` 两条 hint
  （给出 `[IO.File]::ReadAllText(p,[Text.Encoding]::GetEncoding(936))` 配方，或直接指回 `file_read`/`file_edit`）。补 win32 真 PowerShell 的中文输出断言。
- **A2 能力总闸覆盖桌面 MCP**：`allowCommandTools=false` 时桌面 MCP 的命令/进程类工具、`allowDesktopTools=false`（或会话级桌面关）时桌面 MCP 的屏幕/键鼠/窗口类工具，
  与原生同名族一样**不提供、不执行**。名单住 07 `nativeToolDisabledByPolicy` 旁（按桥接裸名，仅对内置桌面 MCP 生效），offer 面与 09/08/12 三个分发点共用一个判据。
- **A3 provider 引擎知道现在几点**：每个 user 回合在**落历史时**带一行本地时间（含星期与 UTC 偏移）。写进历史而不是易变层／尾部临时注入：历史只追加、字节不变，
  前缀缓存零损失；跨天续聊时模型也能看到每轮的时间线。只发给模型，界面不显示。
- **A4 发现链路的如实回执**：`tool_load` 的包里全是桥接工具时说明「桥接工具要按精确名装载」并列出名字；`tool_search` 空命中给 `note`（没有匹配的专用工具 → 用 `list_tools` 浏览，
  或改用命令／脚本），CLI 路径空命中不再说「调用找到的工具」。
- **A5 失败分类器 v3（遥测）**：先读 `failClass/statusCode/code`（http 404/410 → resource_not_found；dns/connect/tls/reset → transient_read；403/反爬 → 新类 `remote_blocked`，
  建议换源而不是「请求授权」）；`tier-mismatch`、代理套代理、「参数不是完整的 JSON 对象」→ invalid_arguments；预算耗尽、计划模式 → policy_blocked；ENOENT/not_found → resource_not_found。
  换版本号即换 cohort，用 `dev-harness/runtime-failure-replay.js` 重放验证。
- **A6 小错**：`TOOL_NAME_ALIASES` 把 `fetch` 指向 `http_request`（原始 HTTP、exec 档），改指 `web_fetch`。（走查提到的 `BRIDGED_WRITE_PATH_ARGS` 里的 `write_docx` 不是幽灵名：02f 注明它是给「常见 office bridge」预留的写族名，保留。）

### B 批 · 降低发现成本（直接做）

- **B1 搜到即会调**：`tool_search` 对前 3 个**未装载**命中直接给完整参数骨架（复用 `toolArgsSkeleton(…,'full')`）＋调用示例。文本落在 tool_result，不动工具表，缓存中性；
  CLI 路径（只能走代理）收益最大。
- **B2 tier 低报自动改道（仅 provider 路径）**：在 09 入批处（`canonicalToolInvokeCall` 同位置）把低档代理改写成目标档代理，**只升不降**、发生在权限闸之前（等价于模型一次猜对，
  闸照常按真实档判，无新旁路），埋点 `proxyRepair:'retier'`；12 的检查保留作纵深防御。CLI/MCP 路径不改道（审批已在 CLI 侧按低档名发生，升档即提权），错误里给可复制的重试形状。
  `list_tools` 增量字段 `tiers`（只列非 read 的名字）。
- **B3 冗余桥接标「首选」**：07 新表 `BRIDGED_SHADOWED_BY_NATIVE`（`read_file→file_read`、`write_file→file_write`、`edit_file→file_edit`、`delete_file/move_file/copy_file`、
  `list_directory→file_list`、`fetch→web_fetch`、`run_command→powershell_run`）。仅当对应原生工具在本会话可用时：目录卡带 `preferred`、排序排到未遮蔽项之后、描述前缀 `[首选 file_read]`。
  不隐藏、不改 tier/闸/分发（桥接版有 `append`、目录级 move/copy、cmd 语义等内置没有的能力）。
- **B4 结果自解释**：`cacheHit` 旁加一句说明（同会话读过、文件没变，不是旧快照）。原计划的「写信封回检查点坐标」并入 C4 一起拍板（单独做价值有限，要动七个写工具的信封）。
- **B5 Playbook 索引不再丢条目**：超预算时降级成只列 id＋标题，16 个全可见（现状字母序前 6 个之后永不可见）。

### C 批 · 新能力（2026-10-04 用户拍板：C5 不做，其余都做；结果见 §3）

| 项 | 内容 | 主要风险 |
|---|---|---|
| C1 Playbook / 技能只读工具 | `playbook_list`、`playbook_read`（返回填好参数的模板）、`skill_list`；执行仍须用户点名或确认，模型在本线程照做。06b「你没有执行它的工具」同改 | 用户可写模板是不可信文本，要围栏；`available=false` 不得执行 |
| C2 会话草稿本 | 模型写即生效、不进长期库的 `scratchpad`（`sessions/<id>.scratchpad.json`，`DurableJsonStore`），有界回注 | 被注入的指令可经草稿持久回注，需围栏＋「非授权」声明 |
| C3 记忆提案批量 | `workbench_memory_propose` 收 `items[≤3]`，一张批量卡 | 提案状态文件 64KB 判空上限；卡片 UI 要改 |
| C4 检查点可见 | 只读 `checkpoint_list`；用户在界面撤销后，下一回合告诉模型「某文件已被撤销」 | 低；不给模型回滚（二次写盘、与活回合竞态、绕过用户决定） |
| C5 桥接写族补工作区写闸 | 与读闸对称：`workspaceWriteRoots`、敏感路径、`.git/hooks` 等自动执行面 | **行为变化**：桌面/Office 写到工作区外会被拦或要问 |
| C6 依赖缺失给修法 | Claude CLI 缺失时 `orchestrate_agents` 的报错带「配 claudePath / 改 engine」；健康异常同步给模型 | 低 |

### 不做

- 合并三个 `tool_invoke_*`：权限闸、auto 扫描、授权书、子代理过滤、CLI 权限桥与用户 `~/.claude/settings.json` 里的规则都按名字定档，合并＝重做这些＋全局缓存断裂；B2 拿到它的大部分收益。
- 默认隐藏冗余桥接工具；`desktop_screenshot` 降为 read（产品决策，且要动不可逆账）；给模型回滚检查点。
- 日志采样：明细采样是 22 号文的既定口径，真实总量已有 `econ_call_totals`，失败分类事件本就不采样。

## §3 实施结果（2026-10-04）

| 项 | 结果 | 钉住它的测试 |
|---|---|---|
| A1 PowerShell 中文 | 00-boot `PS_UTF8_OUTPUT_PREAMBLE`（`[Console]::OutputEncoding` 设成无 BOM 的 UTF-8，try/catch 包住）进 `withQuietProgress`、`shell_start` 后台命令脚本头、交互式 shell（`-NoExit -Command <前导>`；不能用 `-EncodedCommand`，它往 stderr 写 CLIXML）、选文件夹/文件弹窗。本机 en-US 修前 `????`、修后正确。共享控制台：windowsHide＋管道 stdio 的子进程拿自己的隐藏控制台，不改父控制台代码页（哨兵 850 实测）；三种启动路径都不共享 | `unit/console-output-decoding` [E5]（真 PowerShell，仅 win32）[E6]、`unit/exec-result-shape` S8 |
| A2 能力总闸 | 07 `toolDisabledByPolicy` 唯一判据：ACC 命令族 3、桌面族 50、转调器 `batch_actions` / `macro_run`（任一开关关掉都关，否则是另一族的后门）；只认 serverId `ai-computer-control`。offer 面（09/07/08/11）与分发面（09/08/12/13d）共用；CLI 直挂面经 ACC 新增的 `ACC_HIDE_TOOLS` 在注册表里摘掉 | `acc-capability-gates.e2e`、`unit/acc-capability-gates`、`steward-guardrails` R3–R5（原「已知洞」翻成反向断言）、ACC `smoke_toolsets` ⑦ |
| A3 当前时间 | 00-boot `localTurnTimeParts` ＋ 06b `turnTime`，09 落历史时追加 | `harness-friction.e2e` [T] |
| A4 / A6 | 零命中 `note`；`tool_load` 回 `bridgedNotLoaded`＋hint；CLI 零命中不带 `next`；`fetch → web_fetch` | `harness-friction.e2e` [E][L] |
| A5 分类器 v3 | 新类 `remote_blocked`；读 `failClass` / `statusCode` / `blocked` / `argsInvalid`；真机 49 条可配对失败重放 unknown 25（51%）→ 0，permission_denied 4 → 0（全是 403 误判），改动类 `retry_once` 仍为 0 —— **样本内结果**，泛化要看 v3 cohort 积累后的 unknown 占比 | `unit/runtime-failure-classifier`、`runtime-optimization.static`、对抗集 88 条 |
| B1–B5 | 见 §2 | `harness-friction.e2e` [S][K][R][C]、`tool-invoke-promote` P8、`unit/tool-invoke-args-guide` G2、`prompt-snapshot.static` D15–D15d |
| C1 Playbook / 技能只读工具（已实现） | 13f 三个 schema（`playbook_list` / `playbook_read` / `skill_list`，read 档、`skills` 包、不进起手工具）；12 `INTEGRATION_TOOL_HANDLERS` 里的 handler：`playbook_read` 复用 06i 的 `stewardAssemblePlaybookPrompt` / `stewardPlaybookMissingInputs` 填参与缺参判定（缺参回 `playbook_inputs_missing`+缺哪些，不可用回 `playbook_unavailable` 且不给步骤，未知 id 回 `playbook_not_found`），正文包 `<playbook-reference>` 围栏、尖括号经 06 `neutralizeAuthoredText` 中和（与索引段同一函数），结果 note 明说「只在用户点名或明确同意后照做」；`classifyToolPacks` 在 Playbook / 预置流程 / 流程模板等说法时带 skills 包；06b 两包 `playbookIndex.trailer` 改指向 `playbook_read`。**`skill_read` 不放开**：仍只读已启用技能、仍只在有启用技能时才 offer —— `skills-registry.e2e` (d)(f) 钉着这两条语义，且「启用」是用户对技能（含 `<cwd>/.ruyi/skills`、`~/.claude/skills` 等来源）的信任动作并带来源锁，放开等于让 read 档工具绕过它；`skill_list` 因此只列、并把 `enabled` 标出来 | `playbook-skill-tools.e2e`、`unit/playbook-skill-tools`、`prompt-snapshot.static` D14e–D14g、`unit/tool-schema-budget`（offeredDefault 一次性 +1483） |
| C2 会话草稿本 | `scratchpad_write`（read 档、core 常驻，只发给模型服务商普通会话主回合；不进 MCP_TOOLS，CLI / 管家 / 子代理都没有）：按 key 写/覆盖，text 空即删，`op:"list"` 列全部；限额 20 条 × 500 字、总 3000 字，超限拒绝。存 `sessions/<id>.scratchpad.json`（DurableJsonStore + runKeyedChain，删会话同删）。回注贴末条 user 尾部、非持久、全角中和尖括号、声明「不是用户指令、不构成授权」；快照按回合取，只在压缩后重读（回合中途写不刷新，免得把本回合累积的往返打成未缓存） | `session-scratchpad.e2e` [W][N][O][L][H][R][S][D][C][P]、`unit/tool-schema-budget` C2、`prompt-snapshot.static` C2-1–C2-6 |
| C3 记忆批量提议 | `workbench_memory_propose` 可选 `items`（≤3 条，每条与单条同形；单条旧形式与卡片逐字不变）；一张批量卡逐条勾选，「保存选中」只存勾上的、其余记 dismissed；仍占同一个候选槽、同回合先到者胜；写槽／确认／忽略按会话串行（顺带修掉并行派发时 propose 覆盖 relation_propose 的竞态）；状态文件判空阈值 64KB → 256KB（3 条 × 4760 字 × 6 字节 ＋ 历史的最坏情况约 195KB） | `memory-batch-proposal.e2e`、`memory-batch-card.browser.e2e`、`unit/frontend-failure-paths` ⑬ |
| C4 检查点可见 | 只读 `checkpoint_list {turnSeq?, limit?}`（files_write 包；会话只取 ctx；按回合／工具／op 分组，标 undoable／reverted）；用户经 `/api/checkpoints/rollback` 撤销后，02 在检查点目录的 `reverts.json` 记待告知，下一个 provider 回合在时间行后追加一行告知（落历史、字节不变；先落盘再 ack，只会多说不会漏说）；rewind 截掉的回合不告知并清掉悬空记录。不给模型回滚 | `checkpoint-visibility.e2e`、`unit/checkpoint-list-tool` |
| C5 桥接写族补工作区写闸 | **不做**（用户拍板：用户常会打字指定工作区外的路径让写） | — |
| C6 依赖缺失给修法 | 节点报错带找过的路径与修法（去掉 `engine:'claude'` / 配 `claudePath` / 安装）；根因修掉：`.cmd`/`.bat` 启动器经 `cmd.exe /c` 探测时 cmd 总能起来，修前 `existsExecutable(Async)` 只看 spawn、`detectClaudePath` 有退出码就算探到 —— 没装 Claude Code 的机器也报「Claude Code: claude.cmd」；批处理启动器改为要求退出码 0（与 agent CLI 探测同口径） | `agent-workflow-claude-engine.e2e` D1／D2 |

遗留缺口：

- **Kimi 直挂 ACC 只跟全局闸**：Kimi 的 mcp.json 全局共享，会话级桌面开关管不到它直挂的 ACC（经如意 MCP 代理的那条路按会话判）。
- **用户自装的旧版 ACC 不认 `ACC_HIDE_TOOLS`**：工作台优先用随包新版；若落到旧版，bypass/auto 档下 CLI 直挂面没有兜底（default 档有 13d 权限桥同判兜住）。
- **ACC `run_command` 的中文同样会变 `?`**（Python 子进程走 cmd.exe，同一个控制台代码页问题）：只能靠 Windows CI 验证，本批未动。
- **`withQuietProgress` 的豁免规则偏宽**：任意行首出现 `param(` 等就整段不加前导（含函数内缩进的 `param(`），这类脚本的中文输出仍可能是 `?`。
- **分类器 v3 的 `recoverableHint` 占比从 35% 升到 92%**：评估 6.5 门时要把「换源/换参」与「同参重试」分开算（20 号文 §0.6 已注明）；SSRF 拦截与 http_request 的 401 也归进了 `remote_blocked`，严格说一个是本地策略、一个是凭据问题。
- **C 批的边界**：草稿本、撤销告知只在模型服务商回合生效（会话中途切到 Claude/Kimi 引擎时不注入、不消费，记录留到下一次 provider 回合）；rewind 不清草稿本；`scratchpad_write` 常驻 core，老会话升级后第一回合工具表与稳定层各多一项，前缀缓存断一次；批量记忆卡与单条卡一样，用户最终存了哪几条不回给模型；`playbook_list/read`、`skill_list` 的结果说明只有中文；Claude CLI 引擎注入同一条 Playbook 索引，`playbook_read` 经 MCP 暴露，auto 模式下说到 Playbook 等词才出现。
- **本机测试环境**：`unit/steward-runner-races` 用未改动的 HEAD 跑也挂住不退出；`unit/security-audit-fixes` [B] 的前置检查（裸 `git status` 会执行 clean 过滤器）在本机不成立。两者与本批无关，以 Windows CI 为准。
