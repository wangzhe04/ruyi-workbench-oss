# 27 · 第 115–117 波实施方案（工作台管家 Steward：概念／引擎侧／壳层）

> **状态（2026-09-03）**：Pretender 3.0 壳层线重新立项（用户 2026-09-03 拍板）。原交办台（Preview 壳，P1–P3 已交付、P4 默认切换搁置）**停止独立演进**，由管家壳继任；经典壳保留为专家模式。编号 115–117 顺延自 26 号的 114；执行序建议见 §7。
> **用户决定（2026-09-03）**：① 自治边界三档都要（只提议／有界自动／全自动）（**2026-09-05 已撤销，见下**）；② 管家壳是交办台继任者；③ 管家模型单独配置；④ avatar 用 2D 状态动效、简单图形但要合理；⑤ 管家有独立记忆层，自主决定保存关于用户的信息与偏好并在能力上活用；⑥ 管家交互显示以简洁对话为主，默认不展示思维链与工具调用。
> **用户决定（2026-09-05，115 原型三轮走查后定稿）**：① **两壳长期并存**：管家壳为默认任务层，经典壳不退役，作为「2.0 视窗」按会话打开（路线图 post-3.0 双壳退出时钟作废）；② **权限与档位合一**：撤销线程级自治三档，每条线程只有一个「权限」四档（每步都问／改文件不问／只做计划／全自动），管家替用户答复的范围由线程权限决定，管家的主动行为收成设置页「管家可以自己做的事」勾选清单（§3.3）；③ **管家对话只保留本次打开期间**，关掉即归档进行动流水，下次打开只汇报（§8.9）；④ **avatar 固定顶部**（试过「跟话走」后否决）；⑤ **递话**：交给线程的交互改为「输入即预判」（§8.12）；⑥ 管家自己判断问句并直接作答，界面不出现「速问」之类系统标签；⑦ 每条线程的权限／模型／引擎在看板、抽屉、2.0 视窗顶栏就地快切；⑧ 极简：默认视图只有头像、一行状态、对话、输入框，卡片退化为「话＋一行按钮」，依据收进 ※（§8.4）。原型：`docs/mockups/steward-shell.html`。
> **关联**：[25 号 第 112 波过程可见性](25-waves-111-113-compaction-visibility-memory.md)（事件管线与 `turnActivity` 状态机是管家前置）、[25 号 第 113 波会话搜索索引](25-waves-111-113-compaction-visibility-memory.md)（路由依据）、[23 号 §2 103a 命令核心](23-architecture-repayment-sequence.md)、[22 号 红线与发布门](22-agent-soc-microarchitecture.md)、`docs/PRETENDER-PLAN.md` v4（旧壳层线，仅作历史）。

---

## 0. 定位与一句话

用户打开如意，看到的是一个管家：一个对话框、一个会呼吸的 2D 形象。用户说话，管家判断该交给哪个线程（或新开一个），用户确认后线程在旁边打开；线程停了、到节点了、卡在待决、班组出问题了，管家先知道，按该线程的权限要么提议下一步、要么直接推进并给回执，事后能解释、能撤销。管家记得用户是谁、喜欢怎么做事，并把这些用在路由、默认选项、语气与主动提醒上。

## 1. 摸底结论（2026-09-03，HEAD `feb078c`）

| 项 | 现状 | 对设计的影响 |
|---|---|---|
| 服务端内发起回合 | `streamChat`（`10-context-governance.js:2129`）直接 `await runOpenAiTurn(...)`／`runClaudeTurn(...)`，`onEvent` 为单一回调 | 管家后台回合不经 HTTP，自带 sink |
| 决策核心 | `decideIntervention()`（`13d-core-domain-routes.js:473`）`source` 无枚举白名单；CAS＋幂等键复用；审计标签 switch（`:745-751`）未知来源落回通用标签 | 新增 `source:'steward'` 与审计分支即可；四类待决（permission／question／plan／pool）统一走此处 |
| 事件总线 | **不存在**进程内 pub/sub；实时只有单回合 HTTP 流与前端 30s 轮询 `/api/interventions` | 管家收件箱 = 进程内轮询三条现成 seq 日志：Mission Change Ledger（`readMissionChangesWithMeta`）、agent-run 事件（`readAgentRunEvents`）、待决投影（`getPretenderProjectionIndex`）；即时推送作为后续可选（`onEvent` 改多订阅者） |
| 角色专属模型 | 先例 `subagentPreferredProvider/Model`（`01-config.js:269-270`，UI `agent-roles.js:122-163`）；不存在 `summaryProviderId` | `stewardProviderId/stewardModel` 完全照抄 |
| 权限轴 | `PERMISSION_MODES` = default／acceptEdits／plan／auto／bypass；`nativeToolGate(mode,tier)` 纯函数；`streamChat` 可按请求临时覆盖 permissionMode 不回写 | 线程权限即管家边界，管家不另设档位（§3.3） |
| 授权书 | `06f-autonomy-grants.js`：按会话内存 Map，scope run／session，工具×路径 glob×命令白名单×次数×时长；**签发只认 UI header token，`issuedBy` 固定** | 「管家提议、用户一键签发」的边界原语现成（§3.3） |
| agent runs | 重启 `interrupted` 分级（`resumeTier`）、`autonomyAutoResume` 门控、统一 action 端点 pause／resume／stop／retry_node／steer_node／pool_* | 管家「续跑」信号源与操作面现成 |
| 壳切换 | `SHELL_MODES` 冻结 `[classic, preview]`；`normalizeShellMode` 二值；`index.html:64` 预绘；`recoverClassicShell()` fail-closed；`pretender-shell.static` 锁 A1–C9 | 新增第三态 `steward`，同构断言，未知值回经典 |
| UI 令牌 | `base.css:6-9` reduced-motion 全局熔断；`--dur-fast/base/slow`；glass token；`mission-state.js` 五态纯函数（C2 禁止另起状态机） | avatar 与卡片只用 token；五态复用 |
| 持久化 | 103c 清册 `durable-state-inventory.js`；`atomicWriteJson`；append-only 先例 `session-changes` | 管家收件箱游标／决策日志／记忆按此登记 |
| 记忆 | 工作台记忆 draft→confirm、词法 Top-3、核心胶囊常驻、敏感过滤 `memoryProposalLooksSensitive` | 管家记忆另建存储与纪律（§4），复用敏感过滤与围栏中和 |
| 会话检索 | 无跨会话语义检索（113b 待做） | 路由先用 113b 索引，缺席时退化为标题／摘要词法 |

## 2. 第 115 波 · 概念与纸面原型（零代码）

- **产出**：概念稿（本文 §0–§6 定稿）＋ 纸面原型（管家首页、候选线程卡、提议卡、通知摘要、线程抽屉、设置页、记忆面板各一屏，双主题＋390px）＋ avatar 状态语义表 ＋ 事件→管家收件箱映射表 ＋ 三档自治白名单初稿 ＋ 验收指标。
- **走查**：以用户本人为受试者，四场景（长命令、工具循环、多子代理、待决）各录一段，记录「三问」（在干什么／干到哪／在等什么）能否 10 秒内从管家界面答出；不爽点冻结成 116/117 范围。
- **指标（验收用）**：路由候选 Top-1 命中率（用户确认即命中）≥ 80%；管家每回合额外费用 ≤ 主会话平均 10%；提议卡从事件发生到出现 ≤ 30s（轮询周期内）；「等你」原因在首屏可见率 100%；误自动率（有界／全自动下用户事后撤销的比例）≤ 5%。
- 出门：概念稿与原型经用户确认；不改代码。
- **交付记录（2026-09-04 → 09-05，已出门）**：可交互原型 `docs/mockups/steward-shell.html`（零依赖、零 innerHTML、dark-first 双主题、390px、reduced-motion 降级、演示条可模拟七类收件箱事件）经用户三轮走查：第一轮「不够简洁」→ 去掉线程摘要条与卡片盒子，改为「话＋一行按钮」；第二轮「与 2.0 长期并存、每条会话可快切、看不出单任务多会话」→ 按事项分组的看板、快切 chip、2.0 视窗；第三轮「看不到会话在说什么、去掉『速问』标签、权限档位合一、全屏太空、交给线程不美观、头像位置、上下文清理」→ 「它刚说／你可以说」、管家自答、单一权限、宽屏「现在这一件」、递话「输入即预判」、头像固定顶部、每次打开只汇报。§3.3／§5／§8 按定稿修订。验收指标补三项：提议到批准点击数恒为 1；路由预判 p50 延迟 ≤ 50ms（词法先出，模型只补理由）；首屏「三问」10 秒可答率。

## 3. 第 116 波 · 管家引擎侧（默认关，`stewardEnabledV1=false`）

### 3.1 切片
| 切片 | 内容 | 门 |
|---|---|---|
| **116a 配置与模型** | `stewardEnabledV1`、`stewardProviderId`／`stewardModel`（照抄 subagentPreferred*，缺省跟随主端点）、`stewardAutoActions`（`retry`／`resume`／`relay`／`newThread` 四个布尔，默认 retry=true、resume 跟随 `autonomyAutoResume`、relay=true、newThread=true；**不设** `stewardAutonomyTier`，新线程默认权限沿用全局 `permissionMode`，见 §3.3）、`stewardPollMs`（默认 15s）、费用与频率上限（`stewardMaxTurnsPerHour`、`stewardMaxCostPerDay`）；设置页「管家」分区 | config normalize 只加断言；`provider-settings` 静态锁 |
| **116b 收件箱与游标** | 后台轮询器（仅开关开时启动）：三条 seq 日志增量 → 归一化事件 `{kind, sessionId, missionId, seq, at, payload}` → `<data>/steward/inbox-v1.ndjson`（append-only）＋ `cursor-v1.json`；去重（sessionId+kind+seq）；重启续游标；103c 登记 | 新增 `steward-inbox.e2e.js`（合成三源事件→收件箱顺序与去重；重启续游标）；`durable-state-inventory --write` |
| **116c 管家工具集** | 只读：`steward_threads_search`（113b 索引；缺席退化词法）、`steward_thread_status`（mission 五态＋最近一步＋待决摘要）、`steward_runs_status`（班组 digest）、`steward_inbox_read`；写：`steward_thread_open`（返回候选，不自动切换）、`steward_thread_continue`（在目标线程发起回合，`runOpenAiTurn`/`runClaudeTurn` 进程内、自带 sink、可临时覆盖 permissionMode）、`steward_thread_new`、`steward_decide`（经 `decideIntervention({source:'steward', decidedBy:'steward:<id>', contractRequest:true})`）、`steward_run_action`（pause／resume／stop／retry_node）；全部走第 49 波入库门，tier 按写读分档 | `tool-dispatch` 计数重钉；新增 `steward-tools.e2e.js`；`interventions-cas`／`-snapshot` 只加 `steward` 来源用例；13d 审计标签加 `steward` 分支 |
| **116d 管家记忆层** | 见 §4 | `steward-memory.e2e.js`；敏感过滤复用 |
| **116e 线程权限映射与熔断** | 见 §3.3：管家替线程答复的范围是该线程 `permissionMode` 的纯函数 `stewardMayAct(permissionMode, eventKind, toolTier)`，不另设档位；熔断：每小时回合上限、日费用上限、无进展熔断（连续 N 次收件箱无新事件却仍行动）、单线程并发 1、一键停机（`POST /api/steward/stop` 即刻停轮询与在途回合）；所有行动写 `<data>/steward/decisions-v1.ndjson`（含依据事件 seq、使用的记忆条目 id、目标线程 permissionMode、可撤销指针） | `steward-autonomy.e2e.js`（四档权限矩阵×四类待决×熔断）；`autonomy-grant.e2e.js` 只加 |
| **116g 事项跨会话升格**（用户 2026-09-03 拍板：现在做） | 把 mission 从「会话内任务账本」升格为**跨会话容器**：`sessionMeta.missionId` 字段已存在（`02-session-store.js:653`），本切片补齐反向索引（missionId → 线程列表）、事项级目标／验收项／预算的唯一归属、**事项级聚合状态**（由子线程五态确定性聚合：任一 `needs_you` 则事项为 `needs_you`，全 `done` 才 `done`；写成纯函数并复用 `mission-state.js`，禁止另起状态机）、线程加入／移出事项、事项合并与拆分；迁移：存量无 `missionId` 的会话归入「未归类」，不改写历史 | 新增 `mission-threads.e2e.js`（归属增删、聚合状态真值表、合并拆分幂等、存量会话零迁移）；`interventions-changeseq`／`pretender-*.static` 只加；反向索引若落盘则 `durable-state-inventory --write` 登记 |
| **116h 线程间仲裁**（用户 2026-09-03 拍板：默认 5，设置可调） | 全局并发上限 `stewardMaxParallelThreads`（**默认 5**）；同一工作文件夹的写操作互斥排队（把 `06g-resource-leases.js` 的租约语义扩到线程粒度，不新建系统）；全局费用与回合上限；**可解释的排队**——每条等待线程给出单一原因（等你／等锁／等预算／等并发位），供 UI 与管家直接引用 | 新增 `thread-arbiter.e2e.js`（并发上限、同 cwd 写互斥、饥饿避免、原因单一性、上限改动即时生效）；`agent-*`／`autonomy-grant` 只加 |
| **116f 管家回合运行器** | 管家自身是 `kind:'steward'` 的特殊会话（不在普通会话列表展示，`sessionMeta.kind` 已有字段）；系统提示词独立包（`06b` 新增 `steward.*`，含记忆块与工具协议，不含普通会话的技能／playbook 索引）；每次被唤醒（用户消息或收件箱新事件）跑一回合；输出结构化：`say`（给用户的话）＋ `acts`（跟在话后的一行按钮，≤3 个）＋ `actions`（按目标线程权限执行或待批）＋ `why`（依据、影响范围、来源，UI 收进 ※） | `prompt-snapshot.static` 只加 `steward` 段；`usage-ledger` 记 `kind:'aux', note:'steward'` |

### 3.2 数据流
用户消息 → 输入时词法预判递送目标（113b 索引＋记忆加权，零模型，§8.12）→ Enter 直接进入目标线程回合（普通会话，正常权限门；10 秒内可撤回并回退检查点）；两条候选分不出高下时才由管家回合出一句二选一。收件箱事件 → 管家回合（判断）→ 按目标线程权限：提议／直接执行并回执 → 决策日志 → 用户可见（一行话＋按钮）。用户已在线程抽屉内对话时直连该线程，不经管家。

### 3.3 线程权限即管家边界（2026-09-05 合一，取代原「三档自治」）
每条线程只有一个「权限」，沿用第 118 波向导的人话四档，与 `PERMISSION_MODES` 一一映射；管家替用户答复该线程待决的范围由这一档决定，**管家自身不设档位**（用户 2026-09-05：「权限和档位很难分清，最好只有一个」）：

| 线程权限 | 线程自己能做什么 | 管家替你答什么 | 映射 |
|---|---|---|---|
| 每步都问（默认） | 读、改、跑命令都先问 | 只提议，一律等你点 | `default` |
| 改文件不问 | 读、改文件不问；跑命令与对外动作才问 | 可放行 read／edit 类 permission；exec 类只提议；question／plan 只提议 | `acceptEdits` |
| 只做计划 | 只出计划不动手 | 只提议 | `plan` |
| 全自动 | 不问，做完给回执 | 全部替你答（永久豁免除外）；启用需二次确认 | `auto`（与 118 向导四档同源：`ONBOARDING_SAFETY_MODES = default／acceptEdits／plan／auto`；`nativeToolGate` 下 `auto` 对 exec 仍会问，由管家替答，因此每个 exec 都留决策日志；`bypass`／`bypassPermissions` 为 CLI 原生内部值，按全自动处理；仍受熔断、并发与费用上限约束，每个动作可撤销） |

**管家的主动行为**不再是档位，而是设置页「管家可以自己做的事」勾选清单（`stewardAutoActions`）：失败自动重试 1 次、重启后自动续跑能续的线程、事项内自动交接（上一条结论给下一条，120d）、需要时自己新开线程。清单**只对「改文件不问」以上的线程生效**，「每步都问」的线程一律只提议。从批准记录归纳的建议项仍须用户确认一次才进清单；授权书**管家不自签**，改为「管家提议授权书 → 用户一键签发」。

**继承与改动**：新线程用全局默认权限（右上盾牌可改，切到全自动须二次确认）；每条线程可在看板行、抽屉、2.0 视窗顶栏就地改，立即生效；**管家只能收紧线程权限，不能放宽**；行动流水记「线程权限」列而非档位。

**永久豁免清单（任何权限都不自动执行，主会话 2026-09-03 裁决并经用户确认）**：
1. **不可撤销且外溢的动作**：以用户身份对外发送内容（邮件／IM／发帖）、支付与交易、删除工作文件夹之外的数据、安装卸载软件、修改系统设置。这类动作没有 checkpoint 可回滚，一律降级为提议等用户按。
2. **管家不得自我扩权**：放宽任一线程的 `permissionMode`、签发授权书、关闭审计或停机开关、修改本清单。允许自我扩权的自治系统没有底线可言。
3. 提交／推送到远程仓库默认须确认，可在设置里按仓库放行（不属于绝对豁免，但默认站在保守一侧）。

### 3.4 红线
不引入运行时 npm 依赖；不绕过 `nativeToolGate`；管家不得替用户签发授权书、不得放宽任一线程权限；全部行动经命令核心与审计；开关关闭时零轮询、零持久化写入、提示词与路由清册零变化。

### 3.5 管家工具面设计（用户 2026-09-03 决定：管家须能完全操控如意；评估是否与会话工具集分离）

**裁决：分离。管家「动如意」，线程「动世界」。** 管家拥有对如意自身的完整操控面，但**不持有**作用于外部世界的工具（文件读写、shell／PowerShell、桌面控制 ACC、浏览器、Office、联网抓取、git 写操作）。需要动手时，管家把任务委派给线程（新开或续办），由线程在其权限模式与授权书约束下执行。理由：① 管家常在用户不在场时自主运行（有界／全自动档），把「能改电脑」的能力留在有人审批链路的线程里，是最小权限；② 管家提示词不含技能／playbook 索引与项目记忆，缺少执行真实任务的上下文，直接动手质量差；③ 工具面小，管家的工具 schema 稳定，前缀缓存友好，路由回合便宜。

管家工具族（全部走第 49 波入库门；名称前缀 `steward_`；tier 与档位见下）：

| 族 | 工具 | tier | 说明 |
|---|---|---|---|
| **观察（只读）** | `steward_self_status`（复用 `workbench_self_status` 装配并加管家段）、`steward_threads_search`／`steward_thread_status`／`steward_runs_status`／`steward_inbox_read`、`steward_usage`（用量与费用，按会话／日）、`steward_health`（doctor 项）、`steward_audit_tail`（最近审计） | read | 任何档位可用 |
| **线程** | `steward_thread_new`、`steward_thread_open`（只返回候选，切换由 UI 完成）、`steward_thread_continue`（在目标线程发起回合；可附「委派说明」与临时 permissionMode 收紧，不可放宽）、`steward_thread_rename`／`pin`／`archive` | edit | 按目标线程权限：每步都问／只做计划→提议；改文件不问→自动；全自动→自动 |
| **决策** | `steward_decide`（question／plan／pool 经命令核心；permission 类见档位表）、`steward_run_action`（pause／resume／stop／retry_node／steer_node） | exec | 每步都问／只做计划→提议；改文件不问→permission 的 read／edit 可放行，exec 与 question／plan 提议；全自动→全部 |
| **如意设置** | `steward_config_get`（掩码）、`steward_config_set` | exec | 按键分级：**自由**（`locale`、`outputStyle`、主题、壳模式、管家自身设置除默认权限与自理清单外）；**须确认**（主端点／模型选择、`subagentPreferred*`、MCP 连接器启停与浏览器目标（经 `mcp_configure` 同款审批）、新线程默认权限、「管家可以自己做的事」清单、通知设置）；**禁止经管家**（任何 `apiKey`／token 值、`RUYI_HOME`／数据目录、`localCommand`、放宽任一线程 `permissionMode`、授权书签发） |
| **内容管理** | `steward_playbook_draft`（起草用户 playbook，走既有 draft→保存 UI）、`steward_skill_toggle`（启停会话技能，须确认）、`steward_workbench_memory_propose`（只提议）、`steward_memory_*`（管家自身记忆：写／改／否决／检索，见 §4） | edit | 管家记忆自由；其余按目标线程权限 |
| **委派** | `steward_delegate`（把用户原话＋管家补充组成的「委托书」交给指定线程或新线程，内部即 `steward_thread_new`／`steward_thread_continue`；可指定 playbook）。**委托书**（用户 2026-09-05 追加）：管家对用户需求的理解比单句多，新开线程或接力时可自行优化交给线程的提示——结构固定为「原话（逐字，放最前）＋管家补充（目标／验收项／相关文件／偏好与约束，≤1200 字，引用的记忆条目记 id）」；补充对用户可见、可改、可删，不得改写用户意图，进线程前经尖括号中和并标为管家所加。既有线程的递话走原话直递（§8.12），管家如有补充以插话（`/api/steer`）追加，不阻塞线程启动 | exec | 这是管家唯一的「动世界」出口 |

约束：管家工具的 `paths:null`（不触任何文件路径，`guardNote` 写明）；所有写工具返回 `undoRef`（会话 rewind／checkpoint 或配置快照 id），决策日志记录；`steward_config_set` 的禁止键在 handler 内硬编码黑名单并有 e2e 矩阵；管家会话的 `nativeToolGate` 用独立模式 `steward`（映射表：read→allow，edit／exec 按**目标线程**的 permissionMode 经 `stewardMayAct` 判定），管家自身没有档位。

## 4. 管家记忆层（116d，独立于工作台记忆）

- **目的**：记住用户是谁、偏好什么、习惯怎样，并在路由、默认选项、语气、主动建议中使用；不是项目知识库（那是工作台记忆）。
- **存储**：`<data>/steward/memory-v1.json`（`atomicWriteJson`，103c 登记）；条目 `{id, kind, text, confidence, sourceSessionId, sourceSeq, createdAt, updatedAt, lastUsedAt, useCount, state:'active'|'vetoed'}`；`kind` 白名单：`profile`（身份／角色）、`preference`（格式／语言／风格）、`habit`（时间与流程习惯）、`focus`（当前关注的线程／项目）、`policy`（决策倾向，只作为「管家可以自己做的事」与默认答复的**建议**来源）。
- **自主写入的边界**：管家可无需确认写入，但必须：① 过敏感过滤（复用 `memoryProposalLooksSensitive`：密钥／口令／JWT／连接串一律拒绝）；② 只记用户本人陈述或用户确认过的事实，不记第三方个人信息；③ 单条 ≤ 300 字符、总量 ≤ 200 条、活跃注入 ≤ 3000 字符；④ 每条带来源（会话与 seq）与置信度；⑤ 新写入 24 小时内在面板带「新」标记，用户可一键否决（`vetoed`，且同义内容不再自动写回）；⑥ 去重合并（词项 Jaccard，113a 落地后加向量）。
- **活用**：路由（`focus`／`habit` 提升候选权重）；待决默认选项（`policy` 只在线程权限为全自动且用户已确认时生效）；语气与格式（`preference`）；主动建议（`habit`，如「你通常周一整理上周任务」，一天最多一条，可关闭）。每次使用在回复里可解释（「因为你上次说…」悬停显示来源）。
- **隔离**：只注入管家提示词，绝不进普通会话；管家可**提议**工作台记忆但不能确认。
- **面板**：设置页「管家记得的关于你」：按 kind 分组、可编辑、可否决、可清空；导出为 JSON。

## 5. 第 117 波 · 管家壳层（开关默认关，经典壳仍默认）

| 切片 | 内容 | 门 |
|---|---|---|
| **117a 壳模式** | `SHELL_MODES` 加 `steward`；`normalizeShellMode` 改显式白名单（未知值回 classic）；`index.html:64` 预绘同步；`recoverStewardShell()` fail-closed（依赖缺失或开关关时回经典）；设置页「壳模式」二选一（管家／经典）。**两壳长期并存**（用户 2026-09-05）：经典壳不退役，读同一份数据；管家壳内任何线程可在「2.0 视窗」打开（117g），经典壳顶部常驻「回到管家」 | `pretender-shell.static` 新增同构断言（同级容器、默认 classic、单一状态源、零 innerHTML、零默认轮询税） |
| **117b avatar** | 2D 简单图形（圆＋环＋一对眼睛级别），**位置固定顶部**（用户 2026-09-05：试过「跟话走」后否决）；状态：idle／listening／thinking／working／waiting_you／error／sleeping（开关关或停机），由纯投影 `derivePresence()` 派生（§8.3）；数据源 = 112c `turnActivity` ＋ 管家阶段；动效只用 `--dur-*`／`--ease-out` token 与 CSS 变量，`prefers-reduced-motion` 下退化为静态色块＋文字；`aria-live="polite"` 文字等价（「正在看『X』」）；不用 canvas／WebGL | 新增 `steward-avatar.static.e2e.js`（状态枚举与 CSS 类一一对应、reduced-motion 分支、aria-live）；双主题截图 |
| **117c 对话区** | 管家的 `say` 为主，**默认不展示思维链与工具调用**；没有卡片盒子，只有「话＋一行按钮」（§8.4）；依据、影响范围、来源收进句尾 ※；管家自己判断问句并直接作答，界面不出现「速问」等系统标签；每次打开只汇报本次（§8.9）；「细节」开关（头像菜单内）展开本回合工具轨迹（专家） | 静态锁（零 innerHTML、按钮行契约 ≤3）；真实浏览器 e2e（提议→批准→线程回合启动；递话→撤回→线程回退检查点） |
| **117d 线程抽屉** | 区块顺序固定（§8.13）：事项行（标题／验收／预算）→ 线程页签（同事项兄弟线程＋「+ 线程」）→ 线程标题＋五态＋「2.0 视窗」→ 快切 chip（权限／模型／引擎）→ **「它刚说」**（线程最后一句原话，「看全文」进 2.0 视窗）→ **「你可以说」**（≤3 条快捷回复）→ 接力关系 → 三问 → 验收项 → 现场；底部直连输入框（不经管家）、暂停／继续、整单回退、交回管家 | `pretender-task-sheet` 静态锁改拼接读取（组件被复用而非复制）；新增 `steward-drawer.static.e2e.js`（区块顺序、快捷回复来源为确定性字段） |
| **117e 设置** | 壳模式、新线程默认权限（切全自动二次确认）、「管家可以自己做的事」勾选清单、管家模型、轮询周期、费用上限、并发上限、**对话保留**（默认只保留本次打开期间）、记忆面板、一键停机 | `provider-settings` 静态锁只加 |
| **117g 2.0 视窗** | 看板每行与抽屉标题旁的「2.0」把经典壳按该会话打开，顶部一条带子：「回到管家」＋会话名＋事项名＋同一组快切 chip；整体切壳走设置或头像菜单；两壳读同一份数据，不复制状态 | `pretender-shell.static` 加「2.0 视窗零第二套状态」断言；真实浏览器 e2e（改 chip 后两壳一致） |
| **117h 看板与「现在这一件」** | 看板从状态行下拉，按事项分组（§8.10）；并发上限就地可调；宽屏（≥1000px）右侧常驻「现在这一件」= 焦点线程抽屉（等你＞在跑＞失败），关掉即回单列，390px 不常驻 | 新增 `steward-board.static.e2e.js`（事项聚合真值表复用 `mission-state.js`、等待原因单一性、焦点线程优先级） |
| **117f dogfood 与门** | 用户连续使用两周；指标见 §2；记录误自动率与撤销次数；达标后才讨论默认壳切换（不自动恢复原 P4） | Release Brief |

## 6. 与 112 的关系与不做
- 112a（诊断）与 112b（事件消费补齐）**保留并前置**：管家的「三问」数据就是这些事件；112c 状态机是 avatar 的数据源；112d（长命令输出直播）与 112f（编排全貌）并入 117d 线程抽屉。
- 不做：ETA；在线学习／自动训练；管家自签授权书；把管家记忆混入普通会话提示词；三维或视频形象；在开关关时留下任何后台活动；线程级管家自治档位（已合一到线程权限）；管家对话的长期保存（对话不是档案，行动流水才是）；头像跟随消息移动；经典壳退役时钟。

## 7. 排期（用户 2026-09-03 拍板，2026-09-04 补入 118／119）
110（结构）✅ → **118 新手引导**（28 号，改动面小、零风险，且 118a 的步骤定义被管家复用）→ 112a/112b/112c（事件管线＋状态机）→ 113a/113b（记忆向量与会话索引）→ **115 → 116 →（119 定时任务，29 号，可与 117 并行）→ 117** → 114（ASR）→ 111（压缩 v2）→（120 组合编排与轨迹复用，§10 候选）→ 107 批准点（并行回归偶发治理为 107 前置项）。理由：管家是 Pretender 3.0 的产品形态，应先于发布批准点闭环；压缩 v2 是引擎证据，可后置但不能缺席 107 的 Release Brief。

---

## 8. 管家 UX/UI 详细设计（用户 2026-09-03 要求「功能与 UX/UI 都要详细设计」）

### 8.1 设计原则与 UX 红线
1. **一个对话框就是主界面**：默认视图没有侧栏、没有标签页、没有工具栏矩阵；一切从对话与卡片展开。
2. **诚实优先于流畅**：管家说「我在做什么」必须来自真实事件（112b 补齐的事件流），不得靠文案猜测；不知道就说不知道。
3. **提议默认、执行需据**：任何写动作先有卡片、有依据、有撤销入口（27 §3.5 的 `undoRef`）。
4. **不让用户离开如意**（用户 2026-09-03 拍板）：**禁止「给你一个路径／命令，你自己去打开」这类交互**。手册在应用内阅读，文件夹在应用内打开，日志在应用内查看，配置在应用内改。凡是只能给路径的地方，先补一个真正能点的动作，再谈文案。
5. **可退化**：`prefers-reduced-motion` 下动效全关但信息不减；avatar 不可用时状态条文字仍在；管家不可用时经典壳仍能工作。
6. **不造未知**：不显示 ETA、不显示假进度条百分比；用「已运行 3 分 12 秒 · 第 7 次工具调用 · 上次输出 8 秒前」这类可验证事实。
7. **管家自己判断，不让用户打暗号**（2026-09-05）：问句直接答，任务才递给线程，定时意图回读确认；界面不出现「速问」「不立单」这类系统标签，也不要求用户加前缀。
8. **对话不是档案**（2026-09-05）：管家对话只保留本次打开期间；关掉如意即归档进行动流水，下次打开只汇报「你不在的时候」；记忆与待决另存不丢。
9. **输入即预判**（2026-09-05）：递送目标在输入时就看得见，Enter 直接递，事后可撤回；不用「交给谁？」的确认卡拦路（§8.12）。

### 8.2 信息架构（三层，逐层展开）
- **L1 管家页（默认）**：只有四样——顶部 avatar（固定位置）＋名字＋一行状态（点开即看板）；对话流（话＋一行按钮）；底部输入框（左侧「递给谁」预判 chip，右侧「+」收附件／语音／指定线程）。右上角只有两个常驻图标：新线程默认权限（盾牌，点开可改）与一键停机。头像本身是「管家的口袋」：设置、记得的关于你、行动流水、定时任务、体检、找线程（Ctrl+K）、切到经典壳、细节开关。宽屏（≥1000px）右侧常驻「现在这一件」（117h）。
- **L2 线程抽屉**（右侧，390px 下全屏覆盖）：事项行 → 线程页签 → 线程头（五态、2.0 视窗）→ 快切 chip → 它刚说 → 你可以说 → 接力 → 三问 → 验收项 → 现场；底部直连输入框（不经管家）、暂停／继续、整单回退、交回管家（§8.13）。
- **L2′ 2.0 视窗**：经典壳按会话打开，顶部返回带（117g）。
- **L3 面板**（模态）：设置、记得的关于你、行动流水、定时任务、体检。均可从对话里的按钮一键直达对应位置（deep link 到具体项，不是只打开面板首页）。

### 8.3 avatar 状态与动效规格
简单 2D 图形（圆形主体＋一个环＋一对眼睛级别的抽象度），**状态即语义**，全部用既有 token（`--dur-fast/base/slow`、`--ease-out`、主题色变量），不用 canvas／WebGL／第三方动画库：

| 状态 | 触发 | 视觉 | 动效 | aria-live 文案示例 |
|---|---|---|---|---|
| `idle` | 无在途工作 | 常态色，环静止 | 呼吸 4s 循环，幅度极小 | 「空闲」 |
| `listening` | 用户正在输入／语音录制中 | 环随输入轻微扩张 | 200ms 缓入 | 「在听」 |
| `thinking` | 管家回合进行中，未调工具 | 环点状流动 | 1.2s 循环 | 「正在思考」 |
| `working` | 在调管家工具或线程回合进行中 | 环转动＋主体轻微起伏 | 900ms 循环 | 「正在查看线程 X」 |
| `waiting_you` | 有待决或提议待批 | 主体偏暖色，环停在缺口位 | 停止循环，一次性 300ms 提示脉冲 | 「等你确认：是否允许改写 3 个文件」 |
| `error` | 上一动作失败 | 主体偏警示色 | 一次性摆动 400ms | 「上一步失败：端点连不上」 |
| `sleeping` | 管家关闭或已停机 | 去饱和，环消失 | 无 | 「管家已停机」 |

规则：同一时刻只有一个状态；状态切换有 120ms 交叉淡入避免闪烁；状态是纯投影 `derivePresence()`——停机覆盖一切，其余按 在途回合（working／thinking）＞ 出错 ＞ 等你 ＞ 在听 ＞ 空闲：管家正在回话时先显示在途，回完再回到等你（`waiting_you` 与 `mission-state.js` 的 `needs_you` 同源，不另起状态机）；头像位置固定顶部，不随消息移动（2026-09-05 试过「跟话走」后否决）；环外可选一圈线程小点（默认关）。

### 8.4 对话语法：话＋一行按钮（2026-09-05 修订，取代卡片）
管家的输出只有两种：**话**（一段简洁中文／英文）与跟在话后面的**一行按钮**。没有卡片盒子；依据、影响范围、来源、权限说明全部收进句尾的 ※（点开浮层）。默认不展示思维链与工具调用（用户 2026-09-03 决定）；头像菜单里的「细节」开关可展开本回合工具轨迹（专家模式，状态记在本地不同步）。

| 场景 | 话 | 一行按钮 | 按钮落定后 |
|---|---|---|---|
| **递话回执**（用户的话递给了线程，§8.12） | 「递给了『周报-W36』。它昨天停在等华南的表，我让它接着做。」 | 10 秒内「撤回」；之后「换一条 ▾」 | 灰字「已撤回」并追问「那递给谁？」／「改递给了『X』」 |
| **二选一**（两条线程分不出高下） | 「这像『A』也像『B』的活，接着哪条做？」 | 「接着『A』」「接着『B』」「另起一件」 | 灰字「递给了『A』」 |
| **另起一件** | 「我另起一件『X』来做，权限『每步都问』。」 | 10 秒内「撤回」；之后「换个事项 ▾」 | — |
| **提议**（线程待决、失败、接力、习惯建议、定时任务回读） | 一句话说清线程在问什么、我建议怎么答 | 「允许／好／重试／交接／就这样」（金色）「不用了」「改一下」 | 「改一下」只把焦点交回输入框（placeholder「告诉我怎么改…」），不出表单 |
| **收工／通知摘要** | 一句话＋要点列表（≤5 条） | 「打开『X』」「知道了」 | — |
| **行动回执**（线程权限允许管家直接做了） | 「已放行『X』读取…」 | 「撤销」（可撤销／可回退）或「详情」（不可撤销） | — |
| **记忆写入** | 灰色一行「记下了：…」 | 「别记」 | 「不记这条，同义的也不再自动写回」 |
| **直接回答**（问句） | 一段话，无按钮 | — | — |

纪律：一次回合按钮 ≤3 个；主动作只有一个（金色或主色），其余安静；按钮可键盘聚焦与操作；零 `innerHTML`（沿用 `pretender-shell.static` C8 口径）；不出现「速问」「不立单」「已切到档位」等系统标签；管家思考时在对话流末尾出「···」占位而不是转圈。

### 8.5 通知与打扰纪律
- 只有两类事件配得上系统级通知：**等你拿主意**（待决）与**失败**。进度、成功、心跳一律只在应用内。
- 同一线程 5 分钟内的同类事件合并成一条；静默时段（用户可设，默认 22:00–08:00）内只累积不弹窗，次日首次打开时给「你不在的时候」摘要。
- 管家自身的主动建议（来自记忆的 `habit`）**每天最多一条**，可永久关闭。

### 8.6 权限的界面表达（2026-09-05 修订：只有一个「权限」）
- 右上盾牌 = **新线程默认权限**：每步都问（灰）／改文件不问（青花蓝）／全自动（金底）；点开四档菜单，每档一句人话；只做计划不改盾牌色。
- **每条线程一个「权限」chip**，在看板行、抽屉、2.0 视窗顶栏三处是同一控件，点开即换、立即生效；旁边是「模型」「引擎」chip。没有第二个档位。
- 任何地方切到「全自动」都要二次确认，弹窗写明：它可以在你不在时改文件、跑命令，管家会替你答复它的提问；永久豁免仍不做；每个动作记账并可撤销；停机键常驻。
- **一键停机**常驻且永远可点：立即停轮询与在途管家回合，切到 `sleeping`，不影响已在跑的线程回合（那些由线程自己的权限门管）。
- 「行动流水」页按时间列出管家做过的每件事（依据、**线程权限**、`undoRef`、费用），支持按线程与按日期过滤。

### 8.7 记忆面板（对应 §4）
- 分组展示：关于你／偏好／习惯／当前关注／决策倾向；每条显示「来源」（哪次会话）与「用过 N 次」。
- 新写入 24 小时内带「新」角标；每条可编辑、可否决（否决后同义内容不再自动写回）、可删除；顶部「清空全部」。
- 使用可解释：管家在回复里用到某条记忆时，该句尾有一个可点的小标记，点开显示「因为你在 X 时说过 Y」。

### 8.8 键盘与无障碍
- 全流程键盘可达：输入框内 `Tab` 切换递送目标（如意 → 候选线程…），输入 `@` 打开线程挑选；`Esc` 逐层关（浮层 → 2.0 视窗 → 看板 → 抽屉）；`Ctrl+K` 找线程；`Enter` 发送、`Shift+Enter` 换行。
- 焦点可见（不移除 outline）；模态有焦点陷阱与还原；`aria-live="polite"` 播报 avatar 状态与卡片新增；对比度双主题均达 WCAG AA。

### 8.9 空状态与首次
- 首次进入管家页：一句话自我介绍 ＋ 三个可点的例子（「看看我有哪些线程」「明天 9 点提醒我交周报」「把下载文件夹整理一下」），不做教程弹窗（教程属 118 波向导）。
- 无线程时不显示空列表，显示「还没有任务，直接说你想做什么」。
- **每次打开**（2026-09-05）：一句问候＋「你不在的 N 小时里有 M 件事」要点列表（≤5 条）＋「打开『焦点线程』／知道了」＋仍待决的提议（待决持久化，重开必现）；上次对话不显示，已归档进行动流水；设置「对话保留」可改为 24 小时／一直保留。

### 8.10 多线程看板与注意力预算（117 切片，对应 116g/116h）
- **默认不给全貌**：首屏只有状态行一句「N 个事项 · 2 条在跑，1 条等你」；宽屏右侧常驻「现在这一件」（焦点线程：等你＞在跑＞失败）。多线程的真实痛点是焦虑而不是看不见，全貌是按需展开的第二层。
- **看板**从状态行下拉，**按事项分组**：事项行 = 标题、聚合状态（由子线程五态确定性聚合，复用 `mission-state.js`）、线程数、验收 a/b、费用/预算、「+ 线程」；线程行 = 五态点、标题、耗时与费用、权限／模型快切 chip、当前动作或等待原因、悬停操作（暂停／继续／优先／停止／打开／2.0）。不做自定义列。
- **排队可解释**：等待中的线程必须显示为什么在等（等你／等锁：被谁占着／等接力：要谁的草稿／等并发位：前面还有几条）。
- **一键操作**：每行可暂停、停止、提升优先级（插队即占用下一个并发位）、打开抽屉、开 2.0 视窗；批量操作只提供「全部暂停」；顶部另有「整体切到 2.0」。
- **并发上限就地可调**：看板顶部显示「同时最多 5 条」，点开即改，改完立即生效（不需重启）。

### 8.11 明确不做
不做多窗口平铺、不做可拖拽仪表盘、不做主题自定义器、不做 avatar 换肤商店、不做 3D／视频形象、不做游戏化积分、不做头像跟随消息、不做线程级第二档位、不做管家对话长期保存、不做「交给谁？」确认卡。

### 8.12 递话：交给线程的交互（2026-09-05 定稿）
把路由从「发出后再确认」改成「输入时就看得见」，像邮件的收件人栏：

1. **输入即预判**：输入框左侧常驻一个递送目标 chip，默认「→ 如意」。边打字边做零模型的词法预判（113b 索引＋记忆 `focus`／`habit` 加权，目标 ≤50ms）：命中一条线程即变为「→ 周报-W36」（青花蓝）；命中定时意图显示「→ 如意 · 定时」；两条线程分不出高下显示「→ 如意 · 会问你」；什么都不像显示「→ 如意 · 另起一件」；问句显示「→ 如意」。
2. **Enter 直接递**：目标是线程时，这句话原样进入该线程回合（`steward_thread_continue`），管家只回一行「递给了『周报-W36』。它昨天停在等华南的表，我让它接着做。」，※ 里给理由与该事项的其它线程；「现在这一件」切到该线程。
3. **10 秒撤回，之后换一条**：回执按钮 10 秒内是「撤回」（取消线程回合并回退到递话前的检查点，这句话视为没发出去，管家追问「那递给谁？」）；10 秒后变成「换一条 ▾」（同事项兄弟线程、其它候选、在事项下新开、另起一件），改递时同样先回退再递。
4. **用户随时可指定**：点 chip 或输入 `@` 挑线程，`Tab` 在「如意 → 候选线程…」间循环；指定后 chip 变实底并带 ×，本次发送后自动恢复「→ 如意」。
5. **只在真分不出时才问**：两条候选得分相同，管家出一句「这像『A』也像『B』的活，接着哪条做？」加「接着『A』」「接着『B』」「另起一件」；这是唯一的确认场景。
6. **管家可以事后改判**：管家回合看到更多上下文认为预判错了，可改递并说明「我改递给『X』了，因为…」，同样带「撤回」；预判层与管家层的分歧计入路由指标。
7. **指标**：预判 Top-1 命中率（用户未撤回未改递即命中）≥ 80%；预判延迟 p50 ≤ 50ms；撤回率 ≤ 10%。

### 8.13 线程抽屉里的「话」（2026-09-05 定稿）
用户不看 2.0 消息流也要知道线程在说什么、该对它说什么，否则线程仍是黑盒：
- **它刚说／它在问／它最后说**：线程最后一条助手消息的原话（≤3 句，来自 `session.lastAssistantText`，不是模型另写的摘要），「看全文」进 2.0 视窗。
- **你可以说**：≤3 条快捷回复，来源确定性优先：待决的选项（question 的候选答案、permission 的「允许」）＞ 线程最后一句里的问句 ＞ 五态默认（停了→「继续」「换个法子」；在跑→「先停一下」）；点一下直接发给线程，不经管家。
- 三问、验收项、现场保留在其后；直连输入框在底部。
- 抽屉、看板行、2.0 视窗顶栏共用同一组快切 chip（权限／模型／引擎），改哪里都是同一份数据。
- **委托书**（2026-09-05 追加）：管家新开的线程或接力线程，现场第一条是「委托书」，原话与「管家补充」分栏显示；「改一下」可编辑补充部分后再发，补充引用的记忆条目可点开看来源。

---

## 9. 管家能力清单（含后续候选）

已在 §3.5 定稿工具面（管家「动如意」、线程「动世界」）。按能力族登记路线，便于逐个立项：

| 能力 | 状态 | 去处 |
|---|---|---|
| 线程路由与打开、续办、新建 | 116 范围 | §3.5 线程族 |
| 待决答复与班组控制 | 116 范围 | §3.5 决策族 |
| 如意设置读写（三级分级） | 116 范围 | §3.5 设置族 |
| 独立记忆层 | 116 范围 | §4 |
| **定时任务与触发器（Cron）** | **立项（第 119 波）** | [29 号](29-wave-119-scheduler.md)，管家工具族 `steward_schedule_*` |
| 语音输入下单 | 立项（第 114 波） | [26 号](26-wave-114-asr.md) |
| 新手引导以对话形式进行 | 118 交付后复用其步骤定义 | [28 号](28-wave-118-onboarding.md) §4 |
| 每日／每周摘要（你不在时发生了什么） | 候选 | 依赖 116 收件箱＋119 定时任务，二者就绪后即可低成本实现 |
| 文件／仓库变化触发器（不是定时，是条件） | 候选 | 与 119 共用任务模型，触发源换成 watcher；需先评估轮询成本 |
| **多会话线程整合（事项跨会话升格）** | **116 范围（用户 2026-09-03 拍板现在做）** | §3.1 切片 116g |
| **线程并行与仲裁（默认 5 条，设置可调）** | **116 范围** | §3.1 切片 116h |
| **多线程看板与注意力预算** | **117 范围** | §8.10 |
| **组合编排与轨迹复用（计划卡、模板归纳、线程接力）** | **立项候选：第 120 波** | §10 |
| 交接摘要（把一个线程的上下文交给另一个线程） | 并入 120 | 依赖 113a 记忆向量与 111 压缩摘要质量 |
| **委托书：管家按对用户的理解优化交给线程的提示**（用户 2026-09-05 追加） | **116 范围**（116c 新开线程与接力；116-2 既有线程插话补充） | §3.5 委派、§8.13、§11.3 |
| 多读线程但有预算的上下文管理 | **116 范围**（116c `steward_thread_read`、116f 预算与到访重置） | §11.2 |
| 其它能力 | **待用户补充** | 用户 2026-09-03 提到「以及一些其它能力」，尚未具体化；提出后按本表登记编号 |

---

## 10. 第 120 波候选 · 组合编排与轨迹复用（2026-09-03 讨论定形）

> 定位：**管家侧的「编排」是组词，不是画图**。现有 DAG 图形编辑器（`workflow-editor-v2`）与班组监控画布留给专家模式；管家只负责把用户的一句话变成一张可预览、可执行、可复用的计划。排在 117 之后；若届时 12 号方案的 R2 轨迹归纳仍暂缓，本波即为其唯一落点（仍守「禁止自动发布模板、候选须人工确认」的红线）。

- **120a 计划卡**：把用户的一句话（或收件箱事件）映射成结构化计划——节点、角色、模型、并行度、预算、预计花费、验收项。计划卡在「只提议」档需批准；在有界／全自动档**直接开跑**（用户 2026-09-03 决定），但计划内容仍完整落进行动流水以便事后追溯与撤销。复用既有 8 套模板与 9 种节点角色，不新增编排语义。
- **120b 三段式意图映射**：「先调研、再实施、最后验收」这类常见意图直接映射到既有模板；映射表可解释（告诉用户选了哪个模板、为什么）。
- **120c 轨迹复用**：「像上次那样再做一遍」——从**已验收**且脱敏的历史轨迹归纳候选计划；候选只在隔离回放通过并经用户确认后才可存为项目模板（12 号 R2 纪律）。
- **120d 线程接力**：把线程 A 的结论作为线程 B 的输入，自动生成交接摘要（依赖 111 压缩保真与 113a 记忆检索）；接力关系进事项的关系图，可视化为「A → B」。
- **门**：不新增编排引擎；所有计划执行仍走既有 run 状态机与资源租约；模板发布须人工确认；计划卡预算超限直接拒绝而不是静默截断。

---

## 11. 第 116 波实施计划（2026-09-05 拍板；Fable 设计与验收，Opus／Sonnet 实现）

### 11.1 开工前八项拍板（用户 2026-09-05）
1. **管家可以多读线程**（默认模型多为大上下文），但上下文管理与记忆要控制好：读多条线程时不得超出管家预算，同时对全部线程保持足够熟悉——见 §11.2。
2. **自答边界**：关于如意、事项、费用、设置的问题直接答；要读文件、联网或动手才能答的问题，管家开一条「速查」线程（`kind:'quick_ask'`，不进事项、自动收工、答案回填对话）；长篇创作走线程。
3. **预判路由在服务端**：只读端点做词法索引加记忆加权，前端 120ms 去抖，模型不参与预判。
4. **撤回语义**：立即递；撤回 = 停回合 + 回退到递话前的检查点。Claude／Kimi CLI 引擎无检查点时只停不回退，并如实标注「已停止，改动请看 2.0 视窗」。
5. **管家模型默认跟随主端点**，设置里可换便宜模型。
6. **自理清单默认**：失败重试 1 次开；重启续跑跟随既有 `autonomyAutoResume`；事项内交接先关（只提议，dogfood 一周后再定）；自己新开线程只在定时任务与接力时发生。
7. **一次到访** = 页面重开，或静默 60 分钟。
8. **116 分两半**：前半「能对话的管家」先 dogfood，后半再做事项升格、仲裁、记忆完整版、自理动作与设置写入；117 壳层可在前半出门后并行起。
9. **委托书**（追加）：管家新开线程或接力时可按对用户的理解优化交给线程的提示，结构与纪律见 §3.5 委派。

### 11.2 管家上下文管理（拍板第 1 项的设计）
分层布局，服从 22 号 #1 前缀缓存纪律（易变内容后置）：

| 层 | 内容 | 变化频率 | 上限 |
|---|---|---|---|
| 稳定层 | 身份、工具协议、纪律（永久豁免、不放宽权限、不自签授权书、原话逐字） | 版本级 | `06b` 独立包，≤ 2500 字符 |
| 半稳定层 | 管家记忆块（§4，按 kind 分组） | 用户确认或管家写入时 | ≤ 3000 字符 |
| 到访层 | **事项与线程总览**：每条未收工线程（＋24 小时内收工的）一行：id、事项、五态、当前动作、最后一句助手原话（≤200 字）、等待原因、权限、费用；超过 40 条时按事项折叠为计数 | 每回合重建 | ≤ 12K 字符 |
| 回合层 | 本回合收件箱事件（≤30 条，每条 ≤400 字）＋用户消息＋本次到访的历史回合 | 每回合 | 见预算 |
| 按需层 | `steward_thread_read(threadId, {tail, maxChars})`：该线程最近 N 回合的用户／助手原话与工具调用一行摘要（工具输出经既有 observation reducer，只给 rawRef 不给全文）；`steward_thread_search(threadId, q)` 走 113b 内容索引 | 管家自行调用 | 单次 ≤ 12K 字符；每回合 ≤ 6 次、合计 ≤ `stewardReadBudgetChars`（默认 48K） |

- **预算**：`stewardContextBudgetTokens` 默认 200K，且不高于管家模型的 `conversationWindow`；一次到访内历史超过预算 60% 即对管家会话跑既有 `CompactionPlan`（L2），摘要 prompt 用 `steward.visitNotes` 独立包（只留：已做的决定、递出去的话、未完成事项）。
- **到访重置**：新到访清空管家历史（归档进行动流水），只重建总览与待决；记忆与待决另存不受影响。
- **熟悉度**：总览每回合都在，管家对所有线程「在哪一步、在等谁」永远知道；深读按需且记账，读的内容不进记忆层（记忆只记用户本人陈述）。
- **诚实**：总览里的「最后一句」取 `session.lastAssistantText` 原话，不用模型改写。

### 11.3 切片与分工（前半 116-1，串行，每片独立 commit）

模块落点纪律：新增 `06i-steward-core.js`（engine 层，放在 `06h` 之后）承载纯函数与延迟绑定的 `StewardHooks` 命名空间（先例 `06c` `AgentLoopHooks`）；新增 `13g-steward.js`（transport 层，放在 `13e` 之后、`14` 之前）承载收件箱轮询、回合运行器、路由，并在加载时填充 `StewardHooks`。`12-tool-dispatch` 的管家工具 handler 只调用 `StewardHooks.*`，`13-http-router` 以既有 `handleXxxApiRoutes(req,res,pathname)` 形态挂接 `handleStewardApiRoutes`。**不得新增前向边**；若无法避免，停下报告而不是改 `module-dependency-policy.json`。管家工具只在 `session.kind==='steward'` 时被 offer（新 pack `steward`，普通会话永不进入该 pack）。

| 切片 | 执行 | 内容 | 门 |
|---|---|---|---|
| **116a 配置与纯函数** | Sonnet | `01-config.js` 新键（normalize 默认值＋sanitize，不 bump `CONFIG_SCHEMA`）：`stewardEnabledV1=false`、`stewardProviderId=''`／`stewardModel=''`（空＝跟随主端点）、`stewardPollMs=15000`（夹 5000–120000）、`stewardMaxTurnsPerHour=12`、`stewardMaxCostPerDay=1`、`stewardAutoActions={retry:true,resume:null,relay:false,newThread:true}`（`resume:null` 表示跟随 `autonomyAutoResume`）、`stewardContextBudgetTokens=200000`、`stewardReadBudgetChars=48000`、`stewardVisitIdleMinutes=60`、`stewardConversationRetention='visit'`（`visit`／`24h`／`forever`）。`06i-steward-core.js` 首版：`stewardMayAct(permissionMode, eventKind, toolTier)` 真值表（§3.3）、`StewardHooks` 空命名空间、`buildStewardDigestLine(thread)` 纯函数。**不做 UI** | 新增 `dev-harness/unit/steward-core.test.js`（`stewardMayAct` 4 档 × permission(read/edit/exec)／question／plan／pool／failed／relay 全表；digest 行长度上限）；新增 `steward-config.static.e2e.js`（默认值、sanitize 夹取、开关关时 config 零新增键写盘）；manifest／依赖图／契约快照重跑；`--fast` 全绿 |
| **116b 收件箱与游标** | Opus | `13g-steward.js`：仅 `stewardEnabledV1` 开时启动轮询器；三源增量（`readMissionChangesWithMeta`、`readAgentRunEvents`、`getPretenderProjectionIndex`）→ 归一化 `{kind, sessionId, missionId, seq, at, payload}`；**五类白名单**（等你／失败／收工／停滞／预算）才入箱，心跳丢弃；同线程 5 秒合并；`<data>/steward/inbox-v1.ndjson`（append-only）＋`cursor-v1.json`（`atomicWriteJson`）；去重键 sessionId+kind+seq；重启续游标；开关关时零轮询零写入；`POST /api/steward/stop`／`start` | 新增 `steward-inbox.e2e.js`（合成三源→顺序与去重、五类过滤、合并、重启续游标、关时零文件）；`durable-state-inventory --write` 登记两个面；`route-inventory` 重算；`01b` ROUTE_AUTH token 级 |
| **116c 工具集与委托书** | Opus | 观察族：`steward_self_status`、`steward_threads_search`、`steward_thread_status`、`steward_thread_read`（§11.2 预算与配额）、`steward_runs_status`、`steward_inbox_read`、`steward_usage`、`steward_health`、`steward_audit_tail`；线程族：`steward_thread_new`（接收委托书 `{userText, goal, acceptance[], context[], preferences[], constraints[], playbookId?, missionId?}`，原话逐字在前、管家补充中和后围栏标注，`sessionMeta.brief` 落盘）、`steward_thread_continue`（原话直递，返回 `undoRef`＝递话前检查点）、`steward_thread_rename`；决策族：`steward_decide`（经 `decideIntervention({source:'steward', decidedBy:'steward', contractRequest:true})`，`13d` 审计标签加 `steward` 分支；放行范围经 `stewardMayAct`）、`steward_run_action`；记忆最小版：`steward_memory_write`／`veto`／`search`（`<data>/steward/memory-v1.json`，复用 `memoryProposalLooksSensitive`，来源必须是用户消息 seq，工具输出来源确定性拒绝）。全部 `paths:null`、写工具返回 `undoRef`、决策日志 `<data>/steward/decisions-v1.ndjson` | 第 49 波入库门：`13f` schema（含何时用／何时别用）、`12` handler、`07` tier 与新 pack `steward`、`tool-dispatch.e2e` 计数重钉、`facts-generate`、README 工具数、`capabilities.e2e` 身份守卫；新增 `steward-tools.e2e.js`（每个工具至少一条正向＋一条越权／禁止键；读预算超限稳定信封；委托书原话逐字断言）；`interventions-cas`／`-snapshot` 只加 `steward` 来源用例；`durable-state-inventory --write` |
| **116f 回合运行器与到访** | Opus | 管家会话 `kind:'steward'`（单例 id `steward`，不进会话列表与 113b 索引）；`06b` 新增 `steward.*` 中英包（稳定层／到访层模板／`visitNotes` 摘要 prompt／输出契约）；`runStewardTurn({trigger:'user'\|'inbox', message?, events?})`：组装 §11.2 各层→按管家端点走 `runOpenAiTurn`（Claude／Kimi CLI 主端点时走对应 runner，fake 只测 openai 路径）→ 解析输出契约 `{say, acts[≤3], actions[], why}`（复用 json-repair）→ `actions` 经 `stewardMayAct` 执行或转为提议 → 决策日志、`appendUsageLedger(kind:'aux', note:'steward')`；问句直接作答，不加任何标签；熔断（每小时回合、日费用、单管家并发 1、无进展）；到访：`POST /api/steward/visit`（归档历史、重建总览、返回摘要与待决）、`POST /api/steward/message`（SSE，复用 `streamChat` 的 sink 形态）、`GET /api/steward/state`；用户消息抢占在途收件箱回合（事件持久，重排） | 新增 `steward-runner.e2e.js`（fake-openai：用户消息→契约解析→acts≤3；收件箱事件→按四档权限提议或执行；到访重置清空历史但待决仍在；熔断触发；开关关时 404 且零写入）；`prompt-snapshot.static` 只加 `steward` 段；`usage-ledger.e2e` 只加；`capabilities.e2e` |
| **116-pre 预判端点** | Sonnet | `06i` 纯函数 `prerouteText(q, index, memory)`：词法（113b 索引＋标题／摘要）＋记忆 `focus`／`habit` 加权，返回 `{kind:'thread'\|'unsure'\|'question'\|'schedule'\|'new', hits:[{sessionId, missionId, title, score, reason}]}`，两名分差小于阈值即 `unsure`；`GET /api/steward/preroute?q=`（token 级，不写盘，p50 ≤ 50ms） | 新增 `unit/steward-preroute.test.js`（命中／并列／问句／定时／空）；`steward-preroute.e2e.js`（真服务 ≤50ms、鉴权 401）；`route-inventory` 重算 |

顺序：116a → 116b → 116c → 116f → 116-pre；116-pre 与 116f 无依赖，可在 116c 后由 Sonnet 先做。每片出门：`build` → 生成器链（SPEC §8 固定顺序）→ `run-all --fast` 全绿 → 定向 e2e 跑两遍 → Fable 验收（读 diff、跑门、核对纪律）→ commit。116-1 整体出门：串行全量 `run-all.js` 零确定性失败，Release Brief 记入本节交付记录。

### 11.4 后半 116-2（前半出门后排）
116g 事项跨会话升格、116h 线程间仲裁、116d 记忆完整版（去重合并、面板 API、24 小时「新」标）、自理动作执行（重试／续跑／接力／新开，含既有线程的插话补充）、`steward_config_get`／`set` 三级分级、`steward_playbook_draft`／`steward_skill_toggle`、速查线程自动收工、119 定时工具接入。

### 11.5 实现纪律（写给执行者）
- 改 `app/src/`，跑 `node ruyi-workbench/app/build.js` 重建，不手改 `server.js`；不引入运行时 npm 依赖；纯离线。
- 断言只加不改；门面数字只经生成器；重钉必须同 commit 并写来源。
- 开关关闭时零轮询、零持久化写入、提示词与路由清册零变化（`prompt-snapshot`／`route-inventory` 用现有断言证明）。
- 不改 `docs/*.md`（生成器产物除外）；交付记录由验收人写入本节。
- 测试 `require server.js` 前必须把数据根覆盖到临时目录（`WIN_CLAUDE_WORKBENCH_HOME` 为系统级环境变量，曾污染真实数据）。
- 遇到需要新增前向边、放宽断言、改 policy 或触碰永久豁免清单的情况，停下报告。

### 11.6 交付记录
- **116a（2026-09-05，sonnet 实现／Fable 验收，`189d987`）**：`01-config.js` 新增 11 个管家键（默认值＋sanitize，`stewardAutoActions` 三态 `resume`、未知键丢弃、整体非对象回默认；normalize 幂等），`CONFIG_SCHEMA` 不变；新模块 `06i-steward-core.js`（manifest 置于 `06h` 后、`06d` 前）承载 `stewardMayAct` 真值表（auto／bypass／bypassPermissions 全自动、acceptEdits 放行 read／edit 与 failed／relay、其余一律提议）、`buildStewardDigestLine`（lastSay 200 字加省略号、整行 320 硬顶、尖括号中和、换行折叠、缺段跳过）、`STEWARD_EVENT_KINDS` 五类、`STEWARD_DIGEST_LIMITS`、空 `StewardHooks` 命名空间（契约注释列出观察／线程／决策／记忆四族预留键）；`14-main` 导出五项；零 `require`、零外部符号引用。测试：`unit/steward-core.test.js`（真值表穷举＋总览行边界）、`steward-config.static.e2e.js`（源码正则锁＋manifest 落点＋真实 normalize 幂等回环）各跑两遍全过。门：依赖图 37→38 模块、269→270 边、**前向边 67 不变**、1 SCC；facts e2e 277／unit 17；`prompt-snapshot` 零变化；`capabilities` 通过；`build --check` 新鲜；`run-all --fast` 53/54（唯一红为既有 `eol-policy`，163 个存量漂移，不在范围）。验收人复跑 unit／static／依赖图 check／契约快照／facts.static 全过。偏差：AutoActions 的 sanitize 未抽 helper（内联于 normalize，零跨模块引用），可接受。
- **116b（2026-09-05，opus 实现／Fable 验收，`c74458d`＋验收修正）**：新模块 `13g-steward.js`（manifest 置于 `13e` 后、`14` 前，776 行）；三源真实形状摸清并全部登记进 `STEWARD_SOURCE_EVENT_MAP`（Mission Change Ledger 9 种、agent-run 事件 22 种、投影 5 种待决＋1 条派生，共 37 条，静态锁机械对账）：`failure`／`node_settled` 失败／`run_end` 失败／`persistence_degraded` → failed；`result` 按状态解析 → done 或 failed；`node_idle_aborted`／`node_no_progress_aborted`／`run_interrupted`／`run_resume_deferred` → stalled；四类待决由投影产出 → needs_you；`card.mission.budgetExhausted` 派生 → budget（**发现** change ledger 的 `budget` 是每回合入账心跳，不是触顶，已按事实改源）。轮询成本：以投影 `changeSeq` 判变、只对活跃会话（有待决或 24 小时内变更）做增量读；冷启动只建基线不倒灌；去重键 `sessionId|kind|runId|seq`，5 秒合并回填 `mergedSeqs`，重启从 inbox 尾部 2000 行重建去重集合。持久化 `<data>/steward/inbox-v1.ndjson`＋`cursor-v1.json`（清册 42→44 面）。路由经 `StewardHooks.handleApiRoutes` 挂接（13 → 06i 后向边），`/api/steward/{start,stop,state,inbox}` token 级，`start` 同步跑一轮 tick；停机钩子 `StewardHooks.stopInbox` 挂进既有收尾。开关关：不建目录、不起 timer、`start` 409 `steward.disabled`、e2e 断言关后新变更 inbox 字节数不变。门：依赖图 38→39 模块、270→279 边、**前向边 67 不变**；路由清册 105→109 判定点、鉴权 96→100、0 漂移；facts e2e 279／unit 18；`prompt-snapshot` 零变化；`run-all --fast` 54/55（唯一红为既有 eol-policy，实测 165）；新增三件各两遍全过。**验收修正**：源码里 3 处去重键分隔符写成了裸 NUL 字节（grep 视为二进制），改为 `\u0000` 转义，运行值不变，重建后门复跑全过。**登记到 116-2**：`subagent_no_progress`／`loop_recovery`／`budget_guard` 只走 SSE 与审计日志、不落三条 seq 日志，收件箱本波拿不到这三类停滞／预算信号，116-2 需把它们补进 agent-run 事件或会话变更账本；`replan` 待决暂不入箱；`route-inventory.js` 的 `blockText()` 对无花括号单行 `if` 会吃到文件尾（既有扫描器缺陷，写守卫时避开）；投影对 `quick_ask` 会话无 `card.updatedAt`。
- **116c-0（2026-09-05，opus 实现／Fable 验收，`e7ea5cf`）**：从 `streamChat` 抽出 `runSessionTurn(input)`（同模块 `10-context-governance.js`，零行为搬家）：入参 `{sessionId, title, message, attachments, cwd, agentTeam, permissionMode, engineRoute?, source, requestMeta?, onEvent, onFlush?, onStart?, signal?}`，返回 `{ok, sessionId, turnSeq, result, usage, stopped, disconnected, source}`；权限档临时覆盖、会话装载／新建、路由派生、引擎分派、driverAuto、授权书回收、settler、mission driver、断线语义（AbortSignal）与错误收尾全部进核心，壳只剩 body 解析、SSE 写出与 50ms delta 合批、abort 翻译（121 → 69 行）。`onStart` 放在会话装载后首事件前（对应原 `writeHead` 位置，保证装载抛错仍走标准错误信封）、`onFlush` 在 finally 首行（对应原 `flushDeltas`，保证 rewind 拿到 settle 前尾部 delta 已写出）——两个钩子是行为等价的关键。保留局部名 `body`（`agent-team-mode.e2e.js` 源码锁锁着 `body.agentTeam` 字面量）。新增 `session-turn-core.e2e.js`（HTTP 与进程内两路径事件序列、持久化形状、用量台账等价；abort 收尾；显式与推断路由等价）。门：依赖图 39／279／前向边 67 不变；路由清册 109／100 零漂移；facts e2e 280；`prompt-snapshot` 零变化；`run-all --fast` 54/55（eol-policy 既有）；全量 `--parallel 4` 266/7/1，7 红全部经干净 HEAD 对照确认既有（`observation-recall-replay`／`-realhistory` 缺 `realhist-fixtures` 夹具、`index-dedup`／`session-notes`／`websearch` 干净 HEAD 同红、`eol-policy`、`steward-inbox` 并行重启时序单跑两遍全过），flaky `subagent` a5 干净 HEAD 三跑两红既有。验收人复跑 `session-turn-core`、`agent-team-mode`、`agent-loop`、`steering-claude`、`interactive-question`、`usage-ledger`、`budget-guard` 全过。**发现**：`streamChat` 从无会话忙锁（并发第二次是 `superseded` 顶替），若要真忙锁须另立行为项；`realhist-fixtures` 缺失使两件回放 e2e 在本仓库稳定计红且不在 SKIP 名单（治理项）；`route-inventory.json` 含触碰路由的 e2e 文件清单，新增 e2e 后必须重跑生成器链。
- **116c（2026-09-05，opus 实现／Fable 验收，`ac80edd`）**：17 个 `steward_*` 工具（观察 9／线程 3／决策 2／记忆 3）经第 49 波入库门：`13f` schema 含何时用／何时别用与稳定信封说明，`12` 单列 `STEWARD_TOOL_HANDLERS` 组只调 `StewardHooks.*`，`07` tier 与 `steward` pack；**四门隔离**：`buildOpenAiTools` 缺省不 offer（`opts.stewardSession===true` 才给）、adaptive 目录同门（顺带收口 `list_tools`／`tool_search`／`tool_invoke_*` 控制面）、Claude／Kimi CLI 桥 `tools/list` 以注入的 `WCW_SESSION_KIND==='steward'` 判定、`/api/status` 无条件排除；handler 内双重 fail-closed（开关关 → `steward.disabled` 零写入；`session.kind!=='steward'` → `steward.forbidden`，只认原始 kind 不经 `sessionKind()` 归一）。`thread_read` 每回合 6 次／`stewardReadBudgetChars` 字符预算桶（照 105a 桶键），工具输出只给一行摘要与字符数；`thread_new` 用 `buildStewardBrief` 组委托书（原话逐字最前、补充经中和进 `<steward-brief added-by="steward">` 围栏、≤1200 字、`sessionMeta.brief` 分开落盘）后 `runSessionTurn(source:'steward')` 不 await；`thread_continue` 原话直递、`undoRef` 为递话前 `turnSeq`、在途回合 → `steward.busy`；`decide` 先按 `stewardMayAct` 与永久豁免正则（`06i` `STEWARD_EXEMPT_TOOL_PATTERNS`）裁决，`propose_required` 不落决策，放行经 `decideIntervention({source:'steward', decidedBy:'steward'})`，`13d` 审计标签 `steward_decision`；`run_action` 零行为抽出 `agentRunActionCommand`，pause／stop 任何权限可做，推进类需 `auto`；记忆最小版 `<data>/steward/memory-v1.json`（来源必须指向用户消息回合 → 否则 `source_not_user`；敏感过滤；≤200 条；词项 Jaccard ≥0.8 合并；vetoed 同义拒写）；决策日志 `<data>/steward/decisions-v1.ndjson`（清册 44→46 面）。`13d` test-hook 端点加 `source` 入参（默认不变）供黑盒件验证管家来源。门：依赖图 39／290 边／**前向边 67 不变**；路由零漂移；facts nativeTools 63→80、e2e 282；`prompt-snapshot` 零变化；`run-all --fast` 55/56（eol-policy 既有）；全量 `--parallel 4` 269/6/1，6 红均为既有名单；验收人复跑 build／依赖图／路由／清册／facts／两件新测试／tool-dispatch／prompt-snapshot 全过。偏差可接受：handler 单列分组、`memory_search` 按族定 edit tier、`inboxReadTool` 另起键、`thread_rename` 加忙锁（对抗轮实测活回合期间读改写会盖掉回合刚写的消息，改为 `updateSessionMeta` 并拒绝在途）。**登记到 116-2／117**：`session.permissionMode` 尚不存在于会话头，线程级权限只能回落全局——§3.3「每条线程一个权限、就地快切」需先落线程级字段与快切 API（116-2 首项）；`sessionKind()` 只归一为 mission／quick_ask，管家会话须按原始 kind 排除；`updateSessionMeta` 读改写与活回合收尾 save 的竞态是既有根因；`missionRunDigest` 缺节点级「最近一步」；依赖图扫描器对函数内 `const text` 局部绑定误报为 `00-boot` 的 `text()`。13g 已 1710 行，116f 运行器另起 `13h`。
- **116f（2026-09-05，opus 实现／Fable 验收，`a470128`）**：新模块 `13h-steward-runner.js`（1046 行，manifest 置于 `13g` 后、`14` 前，零入边）。管家会话单例（`06i` `STEWARD_SESSION_ID/TITLE/PERMISSION_MODE`，独立模式 `steward`，`nativeToolGate` 对 `steward_*` read/edit/exec 皆 allow、普通工具 block），四个排除面：会话列表两条返回路径按原始 kind 过滤（`sessionMeta` 带 `rawKind`）、113b 索引、13e 投影（扫描器只认 `sess_` 前缀）、116b 收件箱（按固定 id）。提示词独立包 `06b.steward` 中英：稳定层实测中 1107／英 2388 字符（闸 2500）进 system；记忆块 ≤3000 按 kind 分组、总览行走 `buildStewardDigestLine`（40 条／12K 折叠计数）、收件箱 ≤30×400 进第一条 user 前缀；`PROMPT_PACK_VERSION` 未 bump（普通包未变，`prompt-snapshot` 只加 S 段 4 条）。运行器：`runStewardTurn` 走 `runSessionTurn(source:'steward')`，07 的管家工具面唯一出口收口为只返回 `steward_*`（管家零动世界工具，e2e 断言）；用户回合抢占在途收件箱回合（signal 取消＋事件重排）；收件箱消息带 `origin:'inbox'` 落盘，记忆来源校验确定性拒绝；契约解析复用 08 `parseStructuredAgentOutput`，失败 say 取原文；`stewardDowngradeActions` 把任何 `propose_required` 降级为一条 act，回合不失败；自理清单按 §11.1 第 6 项；熔断（小时回合、日费用、连续 5 次零动作退避、停机）；预算分叉在 `maybeAutoCompact`（`min(stewardContextBudgetTokens, conversationWindow)×60%`，L2 用 `steward.visitNotes` 经 `budgetOverride/promptOverride`）。到访：`POST /api/steward/visit` 确定性摘要（≤5 条）＋待决＋焦点，按 `stewardConversationRetention` 归档到 `<data>/steward/visits/`（清册 46→47）；`POST /api/steward/message`（SSE，末尾 `steward_reply`，不入 112b 事件登记表——它是通道载荷非回合事件）、`POST /api/steward/act`、`state` 扩展。fake-openai 只加 `FAKE_REPLY_SEQUENCE`。门：依赖图 39→40 模块、290→303 边、**前向边 67 不变**；路由 109→112／鉴权 100→103 零漂移；facts e2e 284；`run-all --fast` 56/57（eol-policy 既有）；全量 271/6/4（6 红为既有名单，4 flaky 非本波件重跑即过）；验收人复跑 build／依赖图／路由／清册／facts／prompt-snapshot／两件新测试／steward-tools／capabilities 全过。偏差可接受：契约矩阵用固定线程 id；auto 权限线程的 decide 断言拆成过档位门＋同回合 rename 真执行；到访状态只在内存（重启即新到访，符合第 7 项）；`visitNotes` 覆盖摘要 prompt 时跳过五节结构校验并落入 repair 档位（登记备查）。**登记到 116-2**：CLI 引擎主端点下管家返回 `steward.unsupported_engine`；管家回合装配仍跑一遍 `memoryPreflight`／`loadAllPlaybooks`／项目记忆再丢弃（可短路）；`run-all --parallel` 日志桶交织导致肉眼归因易错（建议报告行带文件名）。
- **116-pre（2026-09-05，sonnet 实现／Fable 验收，`adca05a`）**：`06i` 纯函数 `prerouteText(q, index, memory, opts)`：空 → steward；定时正则优先 → schedule（「明天 9 点提醒我交周报」不再误命中周报线程）；词法打分 title×3＋事项×2＋摘要×1（ASCII 词＋CJK 二元组，与记忆词项同一 tokenizer）＋短语整段 +3＋记忆 `focus`／`habit` +2＋24 小时内 +0.5＋needs_you／stopped +0.5；最高分 <2 → 问句判定（问号或疑问词，不锚定句首）→ question 否则 new；第二名 ≥ 最高分×0.85 → unsure；否则 thread；q 夹 500 字，`title`／`reason` 尖括号中和。端点 `GET /api/steward/preroute?q=`（token；缺 token 403 与同族一致；开关关 → `steward.disabled`；零模型零写盘）：索引复用 13h 的 `stewardThreadDigestRows`（加 `missionId`），缓存键取投影 `revision`，命中零磁盘读，实测 20 次缓存命中 p50 0ms；`StewardHooks.preroute` 供 117。门：依赖图 40／303／**前向边 67 不变**；路由 112→113／鉴权 103→104 零漂移；清册不变；facts e2e 285／unit 19；`prompt-snapshot` 零变化；`run-all --fast` 56/57（eol-policy 既有）；验收人复跑 build／依赖图／路由／facts／两件新测试／runner.static／prompt-snapshot 全过。偏差可接受：`steward-runner.static` 的 StewardHooks 键数 8→9 重钉并注明。发现：`steward-inbox.e2e` 的「重启后轮询器自动起来」断言有时序偶发（116c-0 全量已见，登记治理）。**116-1 五片全部入库**：189d987 → c74458d／ca584e4 → e7ea5cf → ac80edd → a470128 → adca05a。
- **116-1 出门（2026-09-05，Fable）Release Brief**：
  - **问题**：管家壳需要一个「能对话的管家」引擎侧地基——能看全部线程、能把用户的话递给线程、能替用户按线程权限答复待决、能记用户本人说过的事、每次打开只汇报本次。
  - **非目标（留 116-2／117）**：事项跨会话升格与线程仲裁；线程级权限字段与快切（当前回落全局 `permissionMode`）；自理动作的真实执行（重试／续跑／接力／新开）；`steward_config_*`／playbook／技能工具；速查线程；CLI 引擎主端点下的管家（`steward.unsupported_engine`）；任何 UI；停滞／预算类信号入箱（三条持久日志里没有）。
  - **交付**：配置 11 键（默认关）；`06i` 纯函数层（真值表、总览行、委托书、记忆、预判）；`13g` 收件箱＋17 个工具；`13h` 回合运行器＋到访＋预判端点；`runSessionTurn` 零行为抽取；7 条 `/api/steward/*` token 级路由；5 个持久化面（inbox／cursor／decisions／memory／visits）全部登记；原生工具 63→80。
  - **证据**：串行全量 `run-all.js` = **272 pass／6 fail／3 flaky／278 ran／7 skipped**；6 红逐件为既有名单（`eol-policy.static` 165 存量 CRLF、`observation-recall-replay`／`-realhistory` 缺 `realhist-fixtures`、`index-dedup`／`session-notes`／`websearch` 干净 HEAD 同红），3 flaky（`pretender-mission-control`／`pretender-needs-drawer`／`subagent`）均为历史偶发名单且重跑通过；新增 12 件测试（5 e2e＋2 static＋3 unit＋2 只加）各两遍全过；依赖图 36→40 模块、**前向边 67 全程不变**、1 SCC；`prompt-snapshot` 普通会话零变化；`capabilities` 身份守卫通过。
  - **默认启用范围与回退**：`stewardEnabledV1=false` 默认关，关时零轮询、零写入、普通会话提示词与工具面逐字节不变、所有管家路由 404／409；回退 = 显式 false；彻底回退 = 逆序 revert 6 个 commit（生成器产物随之重算），无数据迁移（`<data>/steward/` 可整目录删除）。
  - **发布判断**：不随 Escapade 补丁发布默认行为；可随后续版本作为默认关的引擎侧能力入库；用户可见形态待 117。
  - **治理清单**（不阻塞出门）：`realhist-fixtures` 缺失的两件回放 e2e 应进 `run-all` SKIP 或改为条件跳过；
- **116-2a（2026-09-05，opus 实现／Fable 验收，`41a4b4c`）**：会话头可选 `permissionMode`（缺省 null＝跟随全局，存量零迁移；`sessionMeta` 无条件输出 `permissionMode`，传 `config` 时另给派生 `effectivePermissionMode`）；`01-config` 纯函数 `resolvePermissionMode({request, session, config})` 请求级＞会话级＞全局，三层各自只认 `PERMISSION_MODES`、非法静默回落；`runSessionTurn` 与 13g `stewardThreadPermissionMode` 同调此函数，回合执行与管家判定不可能各算各的；解析结果等于全局时 `permissionConfig` 仍是同一对象，存量会话逐字节零变化（`prompt-snapshot` 零变化、`session-turn-core`／`budget-guard`／`autonomy-*` 全过）。`PATCH /api/sessions/:id {permissionMode}`（null 清除；非白名单 400；`auto`／`bypass` 须 `confirm:true` 否则 409 `permission.confirm_required`；审计 `source:'permission_mode'`）。新工具 `steward_thread_permission`（tier edit，`06i` `STEWARD_PERMISSION_RANK` plan0<default1<acceptEdits2<auto3<bypass4，目标 rank 必须小于当前生效 rank 否则 `steward.widen_forbidden`；工具数 80→81）。竞态：选「延后落盘」——`permissionMode` 先进内存覆盖表 `sessionPermissionModeOverrides`（与 `sessionEngineRouteOverrides` 同款 stale-save guard），`loadSession`／`saveSession` 两侧应用即刻生效，活回合 settle 后重新 `loadSession` 再应用 patch（180s 兜底 `session_meta_defer_timeout`），不用陈旧正文覆盖；`thread_rename` 忙锁保留（自动改名立刻失败比静默延后诚实）。门：依赖图 40／303／**前向边 67 不变**；路由 113／104 零漂移；契约快照 nativeToolCount 82→83；facts nativeTools 81、e2e 286、unit 20；`run-all --fast` 56/57；全量 273/6/2（6 红既有名单；flaky `failover`／`repo-hygiene` 重跑过）；验收人复跑 build／依赖图／路由／facts／两件新测试／perm-v2／prompt-snapshot／steward-tools 全过。偏差可接受：`steward_thread_status.permissionMode` 语义不改、只加 `effectivePermissionMode`／`sessionPermissionMode`；`pretender-dispatch-home.static` D2 源码锁随第 78 波内联收进纯函数而重钉并更严一格（同 commit 注明）；`perm-v2` 新增独立场景④（会话级 plan 硬阻断）替代 `autonomy-grant` 落点。**登记**：`normalizeSession` 对 `permissionMode` 刻意零归一（管家会话头的 `'steward'` 不在白名单，日后清洗须先豁免）；`title`／`cwd`／`pinned` 在回合楔死超 180s 的极端窗口仍可能被在飞副本覆盖（无覆盖表）；`sessions/index.json` 每条多 `permissionMode:null` 键（纯缓存，预期形状扩张）。
- **116-2b（2026-09-05，opus 实现／Fable 验收，`89ceadd`＋验收对齐）**：停滞与预算信号落持久日志——Mission Change Ledger 新增 `stalled`（主回合 `loop_recovery`，同会话 5 分钟一条）与 `budget_tripped`（`budget_guard` tripped，每回合一条）；agent-run 事件新增 `run_stalled`（节点壳的 `subagent_no_progress`／`loop_recovery`，同 run 5 分钟一条）与 `run_budget_tripped`（子代理迭代预算耗尽，新增 `onBudgetTripped` 回调）；`STEWARD_SOURCE_EVENT_MAP` 登记为 stalled／budget，`adaptive_tool_budget` 另起 `sseOnly` 子表登记为 null（避免 116b 双向等集锁误判僵尸）。自理动作确定性执行（13h，先于模型回合）：七道闸——停机／熔断 → 小时窗（计入 `stewardMaxTurnsPerHour`）→ 同目标连续 2 次熔断 → 同目标本小时一次 → 自理清单 → `stewardMayAct(mode,'failed','exec')` → 13g 权威判据；`failed` 回合类 → `steward_thread_continue{'继续'}`（`origin:'steward-retry'`）、run 类 → `retry_node`；`run_interrupted`／`run_resume_deferred` → `resume:null` 跟随 `autonomyAutoResume`；`node_no_progress_aborted`／`run_stalled` 不自动；`relay` 只提议、`newThread` 无自动路径；`steward_reply.actions` 带 `auto:true`。新工具 `steward_thread_note`（tier edit，工具数 81→82）：`13b` 零行为抽出 `steerSessionCore`，插话前缀「（管家补充）」≤600 字中和，无在途回合 → `steward.no_active_turn`，`undoRef` 用文本匹配（既有插话通道无 id）。管家回合装配短路 `readProjectMemory`／`resolveMemoryPreflight`／`loadAllPlaybooks`（`prompt-snapshot` 零变化）。门：依赖图 40／305／**前向边 67 不变**；路由零漂移；契约快照 nativeToolCount 84；facts nativeTools 82、e2e 287；`run-all --fast` 56/57；全量 272/8/4——6 红既有名单，`steering-claude` 为本波真红（S10 顺序锁锚点随抽出重钉，同 commit 注明）已修，`ec-d-performance` 并行偶发单跑过；新件 `steward-signals`（55 条）三遍全过。**验收对齐**：`steward_run_action` 原借 `plan` 档把 resume／retry_node 限定为只有全自动，与 §3.3 自理清单及 13h 预闸不一致，统一为 `failed` 档（改文件不问即可，线程自己的权限门仍逐条问 exec），`steer_node` 仍 `plan` 档；同 commit 改同波新增的 H1 并加 H1b／H1c 锁两档口径。**登记**：`bumpMissionChangeSeq` 对无 `mission` 的会话静默 no-op，速查线程的停滞／预算信号进不了账本（后续波）；`run-all --parallel` 进度行张冠李戴已连续三波误判，治理项提级。
- **116g（2026-09-05，opus 实现／Fable 验收，`87c94da`）**：事项容器新持久化面 `<data>/missions/<missionId>.json`（schema 1：title／goal／acceptance[{id,text,done,doneAt}]／budget／cwd／sessionIds 反向索引／archivedAt；清册 47→48，容量 2000 超出稳定信封，损坏隔离后按会话头派生恢复），落点 `02-session-store.js`（放 06e 会新增两条循环边，落 02 零新增边）；`aggregateMissionState` 纯函数落 `06i`（与五态判据同屋；13d 与 13g 调它，13e 不另写）；反向索引维护点：attach／detach（会话头经 `updateSessionMeta`，白拿 116-2a 竞态防护）、merge／split、`steward_thread_new` 显式 `missionId`、`deleteSession`；`createSession` 不建事项文件，未归类按需派生 `derived:true`；`head.mission` 会话内账本不动（权威在事项文件）。路由 +5（`POST /api/missions`、`PATCH /:id`、`/threads` attach|detach、`/merge`、`/split`，全 token 级），幂等靠子操作各自幂等（attach 判当前态、验收项按文本去重、archive 判已归档、split 幂等键「同组 sessionIds 已在同名未归档事项」），`GET /api/missions` 只加 `aggregateState`／`threadCount`／`acceptance{done,total}`／`cost`／`budget`／`derived`；`MISSION_CHANGE_TYPES` 加 `mission_membership`（登记为 null）。新工具 `steward_missions`（tier read，工具数 82→83）；`thread_status.mission`、总览行与搜索结果带事项标题。门：依赖图 40／306／**前向边 67 不变**／零新增循环边；路由 113→118／鉴权 104→106 零漂移；facts nativeTools 83、e2e 288、unit 21；`prompt-snapshot` 零变化；全量 267/14/10——6 红既有名单，其余 8 件（`git`／`interventions-cas`／`summary-parallel-cap`／`claude-resume-recovery`／`judge-json-repair`／`interventions-persist`／`summary-fact-table`／`ec-d-performance`）串行全绿为并发争用；验收人复跑 build／依赖图／路由／清册／facts／两件新测试／steward-tools／pretender-mission-control／prompt-snapshot 全过。**硬教训入纪律**：跑全量期间不得改 `app/src/`（`readServerSource()` 新鲜度自检会把几十件判红）；域层 `{ok:false,error}` 送进 `json()` 会被 `normalizeApiErrorPayload` 归一成 `api.request_failed`，稳定信封必须在路由层转成 `apiFailure(code,…)`；两处派生同一线程五态时缺卡片兜底入参必须逐字相同（13d 曾少喂 `turnSeq` 导致看板与 `thread_status` 各说各话）。**登记**：`stewardImplThreadsSearch` 无卡片兜底只喂 `kind`，与 `thread_status` 口径不一致（116c 既有）；工具总数硬编码于五处测试，建议统一读 `facts.json`。`eol-policy` 165 处存量漂移单独立 hygiene 切片（含 CSS SHA 重钉）；`steward-inbox.e2e` 重启轮询断言时序偶发；`run-all --parallel` 报告行带文件名；依赖图扫描器对函数内 `const text` 误报；`updateSessionMeta` 与活回合收尾 save 的竞态。
- **116h（2026-09-05，opus 实现／Fable 验收，`5cef226`）**：仲裁器并入 `13h-steward-runner.js`（1305→1839 行；不新建 13i，因 `steward-runner.static` 有「13h 紧跟 13g」结构断言且断言只加不改），`13g` 只加 8 行（`thread_status` 的 `wait` 与 missions 透传）。配置 3 键 `stewardMaxParallelThreads=5`[1,32]／`stewardGlobalMaxTurnsPerHour=120`／`stewardGlobalMaxCostPerDay=20`，`CONFIG_SCHEMA` 不变。入口在 `runSessionTurn` 的 `session` 事件后、引擎分派前：`config.stewardEnabledV1 === true && session.kind !== 'steward'` 才调 `StewardHooks.acquireTurnSlot`（验收核对 `10-context-governance.js:2272`），关时回合路径逐字节不变（`multi-session-parallel`／`e1-parallel-noindex` 另加「零 agent_resource」断言）；释放点唯一：`finally` 无条件 `release()`（:2320），幂等，释放即唤醒队列。阻塞判定顺序即优先级：同 cwd 写互斥（含队列里排在前面的同 cwd，保 FIFO 公平）→ 全局预算 → 并发位；`waitReasonFor(thread, ctx)` 为 `06i` 唯一判据（验收：全仓仅一处定义，13g×1／13h×3／13d×3 调用），四个展示面同形状 `{reason,label,blockedBy?,ahead?}`，e2e ⑪ 实测三处 HTTP 面键集与人话逐字相同。事件复用 `agent_resource`（资源名 `steward:slot`／`cwd-write:<hash>`／`steward:budget`，`blockers` 给占用者人话名，112c 状态条原样可用，事件枚举零新增），只有真等过的回合才发 acquired/released；排队取消经哨兵 `STEWARD_TURN_CANCELLED` → `process/stopped`，`/api/stop` 经 `cancelQueuedTurn` 出队；`POST /api/config` 经 `arbiterRefresh` 即时生效（仲裁器每次唤醒重读配置）；预算触顶是排队不是拒绝。饥饿避免：等待超 `max(60s, 平均回合×3)` 提到队首一次，插队只能插到饥饿保护段之后（否则被提上来的立刻被反超，反而饿得更彻底）；`WCW_STEWARD_ARBITER_STARVE_MS` 整个覆盖阈值（测试接缝）。路由 `GET /api/steward/arbiter`、`POST /api/steward/arbiter/prioritize`，工具 `steward_thread_prioritize`（83→84，实现住 13h，门控壳仍是 13g 的 `stewardToolHandler`）。仲裁状态只在内存，清册 48 面不变。**偏差**：`arbiterState`／`arbiterPrioritize` 不上 `StewardHooks`（消费者全在 13h 内，挂上即死钩子），13h 钩子键 9→14；`steward-signals` (G) 相位被 (D) 相位还持有 HOME 写锁的回合挡住，改给那个回合单独工作夹（不改断言）。**重钉（同 commit 注明来源）**：工具数 20→21 五处、`TOOL_HANDLERS` 83→84 两处（`tool-dispatch`／`workbench-self-status`）、钩子键 9→14、消费者样本扩到 06/09/10/12/13/13d/13g、README 两处。**门（验收复跑）**：`build --check` 新鲜；依赖图 40／306／前向边 67 不变；路由 118→120／106→108 零漂移；契约快照 nativeToolCount 85→86；facts nativeTools 84／e2e 289／unit 22；`prompt-snapshot` 零变化；`thread-arbiter`（11 组）、`unit/steward-wait-reason`、`steward-tools(.static)`、`steward-runner(.static)`、`steward-signals`、`session-turn-core`、`multi-session-parallel`、`progress-events.static`（新增 D10~D10d）、`facts.static` 全过；实现侧全量 `--parallel 4` 271/11/6，6 红为既有名单，其余 5 件串行绿为并发争用。**登记（未修）**：① 停在「等你」的线程，其在跑回合仍持 cwd 写锁，会挡同目录所有线程——§8.10「等锁：被谁占着」把它暴露给用户后，需要「看到就能一键停占用者」的动作（归 117d）；② 有待决的回合不占并发位、不入 running，同 cwd 可能与排队条目并发（刻意如此，交界记一笔）；③ `stewardGlobalMaxTurnsPerHour` 只计经仲裁放行的回合，待决直放行与管家自身回合不计；④ 工具总数硬编码扩至七处测试，建议统一读 `facts.json`；⑤ **13g 已 1993 行（SPEC 上限 2000），116-2e 必须先拆 13g 再加工具**；⑥ `steward-preroute.e2e` 连跑序列偶发全红、单跑过（新 flaky 观察）；⑦ 本文 116b 记录里的「反斜杠 u0000」转义曾被写成真 NUL 字节（grep 判整文二进制，已随 HEAD 入库），本次改回字面量。
- **116-2e-0 拆 13g（2026-09-06，opus 实现／Fable 验收，`12beb86`）**：13g 触顶（1993 行）后把第 1–778 行的收件箱轮询与游标（inbox／cursor 常量、`STEWARD_SOURCE_EVENT_MAP`、kind 解析器、四个归一化器、合并／去重、目录与路径、运行态、load／read／append／saveCursor、collect、tick、start／stop、`stewardInboxRead`、`stewardInboxState`）零行为搬到新模块 `13i-steward-inbox.js`，manifest 落点 **`13e` 之后、`13g` 之前**——`steward-runner.static` 同时锁「13h 紧跟 13g」与「13h 紧邻 14-main」，新模块只能前置，前置模块只能承载上游部分才不出前向边（Fable 设计）。验收用去注释比对：拆分 commit 的 13i 与拆前 13g 头部逐字相等、拆分 commit 的 13g 尾部与拆前尾部逐字相等；行数 1993 → 13g 1234 ＋ 13i 784；13g→13i 全部后向，前向边 67 不变，清册 48 面不变（inbox／cursor 两面 owner 改指 13i，decisions／memory 仍在 13g）。**重钉（同 commit 注明来源，只改路径不改语义）**：`durable-state-inventory` 第 61–62 行；`steward-events.static` D5 四条读收件箱符号的断言改读 13i，D4 落点重钉为「13g 紧跟 13i」＋「13i 紧跟 13e」＋「13i 存在」（同 116f 先例）；`steward-runner.static` ⑤ 改读 13i、② 消费者样本加 13i、`consumedText` 加 13i 源（否则 `onInboxBatch`／`stopRunner`／`resumeRunner` 会被误判死代码）；`route-inventory` 只有行号漂移。
- **116-2e（2026-09-06，opus 实现／Fable 验收，`0842fbd`）**：**A 记忆完整版（§4）**：写入去重合并——同 kind 词项 Jaccard ≥ 0.8 并入旧条目（保留旧 id、text 取新、`confidence=min(1,max(old,new)+0.1)`、`mergedFrom` 封顶 5，老条目读成空数组零迁移），命中 `vetoed` 条目拒写（沿用 116c 既有信封 `vetoed_duplicate`，未改成设计写的 `steward.memory_vetoed`——改它要动 `steward-tools.e2e` I8 既有断言与 13f 文案，语义已落，Fable 接受）；面板六条 token 级路由 `GET /api/steward/memory?kind=`（按 kind 分组，`isNew`＝`createdAt` 距今 < 24h 纯派生不落盘）、`POST …/edit`（乐观锁 `version_conflict`，面板改的条目 `confidence:1` 来源 `user_panel`）、`…/veto`、`…/restore`、`…/clear`（`confirm==='clear'` 逐字）、`GET …/export`（只含 active）；`uiMutatingRoute` 门已于第 33 波被 01b 声明式 `ROUTE_AUTH` deny-by-default 取代，按同族登记 token 级。**B 设置读写三级（§3.5）**：`06i` 新增 `STEWARD_CONFIG_TIERS`＋`stewardConfigTierFor(key)`，allowlist＋fail-closed：密钥正则 `/apiKey|token|secret|password/i` 第一道闸压过两张表，free 15 键（`locale`／`outputStyle`／`theme`／`uiMode`／管家自身设置）、confirm 16 键（主端点与模型族、`subagentPreferred*`、MCP 与浏览器目标、`permissionMode`、`stewardEnabledV1`、`stewardAutoActions`）、其余 107 键 forbidden；单测遍历 01-config 默认表全键无遗漏。`steward_config_get` 复用 `/api/config` 既有掩码，forbidden 键连掩码值都不回只列 `omitted[]`；`steward_config_set` 整份原子：任一 forbidden → `steward.forbidden` 零写入，任一 confirm 且非用户亲按 → `propose_required {reason:'confirm_required', keys}`（13h 既有降级路径变按钮），通过则经与 `POST /api/config` 同一条 sanitize 与同一个落盘函数（零行为抽出 `applyConfigPatch`，116h `arbiterRefresh` 自然生效），`undoRef` 内联决策日志。**`ctx.userPressed` 规矩**（06i 契约注释＋`steward-tools.static ⑦` 全仓白名单锁）：唯一来源 13h `POST /api/steward/act` 执行路径；13g 门控壳剥 args 同名字段；只有 config_set 与 skill_toggle 读它，`stewardMayAct`／永久豁免／线程权限判定零出现（验收 grep：06i 注释、13g 剥字段＋两处消费、13h 一处置位，别无他处）。**C** `steward_playbook_draft`：调既有 `draftPlaybookFromSession` 只起草不保存（`saveVia:'POST /api/playbooks'`），每回合 1 次。**D** `steward_skill_toggle`：零行为抽出 `setSessionSkillsCore` 与 `POST /api/session/skills` 共用，须确认，不可对管家会话自己用。**E** `steward_quick_ask {question, cwd?}`：`kind:'quick_ask'` 会话头标 `stewardQuick{askedAt,question,stewardTurnKey,closedAt}`，不进事项，每回合 2 次；13i 落盘前经 `StewardHooks.enrichInboxRows` 给 done 行补 `quick`／`answer`（≤1200 字符），13h 在事件进过回合**之后**写 `closedAt`；总览与 `steward_threads_search` 默认排除已收工速查（`includeClosed:true` 要得回）；管家提示词包加「速查答案用自己的话转述」，普通会话 prompt 零变化。**119 定时工具接入延期**（119 未开工）。**门（验收复跑）**：`build --check` 新鲜；依赖图 41 模块／317 边／前向边 67 不变／1 SCC；路由 126 判定点／114 鉴权行零漂移；清册 48 面不变；facts nativeTools 89（+5）／e2e 293／unit 23；行数 13g 1686／13h 1861（闸 1900）；`facts.static`、`steward-tools.static`、`steward-runner.static`、`steward-events.static`、`prompt-snapshot.static`、`unit/steward-config-tier` 全过；`steward-memory`、`steward-config-tools`、`steward-content-tools`、`steward-quick-ask`、`steward-tools`、`steward-runner`、`thread-arbiter`、`repo-hygiene` 全过；`steward-inbox` 首跑 2 红复跑全过（既有 flaky）。实现侧 `--parallel 4` 279/7/2：6 红既有名单，`repo-hygiene` 为本波真红（新测试假密钥样本 `sk-…` 命中 `SECRET_RE`，已换样本）。**偏差（Fable 接受）**：① 否决拒写信封沿用 `vetoed_duplicate`；② `stewardContextBudgetTokens` 因键名含 Tokens 被密钥正则压成 forbidden，不给正则开例外（一个例外就是下次真密钥溜出去的口子），管家改不了自己的上下文预算，用户在设置页照常能改，单测钉成期望值；③ 01-config 默认表无通知类键，confirm 表相应空缺。**登记（未修）**：README 的 e2e／unit 口径（243／15）与 facts（293／23）存量漂移，`facts.static` 只软锁 ACC 工具数；`run-all --parallel` 进度行串桶第五波登记；后台任务输出只留末尾几 KB，长跑全量须自己重定向到文件。
- **116-2 出门（2026-09-06，Fable）Release Brief**：
  - **问题**：前半给了管家「能对话」的地基，后半要让它「替你看着多条线程」：线程各自有权限且管家只能收紧；停滞／预算信号可见可自理；一件事跨多条会话有容器；多线程同时跑有仲裁且排队可解释；记忆有面板可管；管家能读改如意设置但有铁栏；能起草 playbook、启停技能、开速查线程。
  - **非目标（留 117／119）**：任何 UI（117a–h）；119 定时工具接入（119 未开工）；等你线程持锁的「一键停占用者」动作（117d）；CLI 引擎主端点下的管家（`steward.unsupported_engine`）；否决拒写信封改名（沿用 `vetoed_duplicate`）。
  - **交付**：116-2a `41a4b4c`（线程级 `permissionMode` 三层解析、PATCH 快切须 confirm、管家只降不升）→ 116-2b `89ceadd`＋`7539c90`（stalled／budget_tripped 落三条持久日志、自理动作七道闸、`steward_thread_note` 插话、`run_action` 口径统一）→ 116g `87c94da`（事项容器 `<data>/missions/`、`aggregateMissionState` 单点、attach／detach／merge／split）→ 116h `5cef226`（仲裁并入 13h：并发位默认 5、同 cwd 写互斥、全局回合／费用上限、`waitReasonFor` 单点、复用 `agent_resource`、`steward_thread_prioritize`）→ 116-2e `12beb86`（拆 13g → `13i-steward-inbox.js` 前置）＋`0842fbd`（记忆完整版与面板六路由、设置三级分级与 `ctx.userPressed` 规矩、`steward_playbook_draft`／`steward_skill_toggle`／`steward_quick_ask`）；docs `1a1173f` 与本条。配置新增 3 键（仲裁），`steward_*` 工具 17→26，原生工具 80→89，路由 `/api/steward/*` 7→约 20 条（全部 token 级），持久化面 47→48（missions），依赖图 41 模块／317 边／前向边 67（全程不变）。
  - **证据**：串行全量 `run-all.js` = **280 pass／6 fail／4 flaky／286 ran／7 skipped**；6 红逐件为既有名单（`eol-policy.static` 165 存量、`observation-recall-replay`／`-realhistory` 缺 `realhist-fixtures`、`index-dedup`／`session-notes`／`websearch` 干净 HEAD 同红），零新增确定性红；4 flaky 首跑失败重跑过（`interventions-persist`、`steward-inbox`、`steward-tools`、`subagent`——前两者与 `subagent` 为历史名单，`steward-tools` 为本次新观察，与 `steward-inbox` 同属收件箱轮询时序）。每片验收另有独立门复跑记录见上。
  - **默认启用范围与回退**：`stewardEnabledV1=false` 默认关：仲裁分支根本不进（`multi-session-parallel`／`e1-parallel-noindex` 锁「零 agent_resource」）、无轮询无写入、普通会话提示词与工具面逐字节不变、管家路由 404／409；线程级 `permissionMode` 字段缺省 null＝跟随全局，存量零迁移；事项容器无则按会话头派生。回退 = 显式 false；彻底回退 = 逆序 revert 上述 commit（生成器产物随之重算），`<data>/steward/` 与 `<data>/missions/` 可整目录删除。
  - **发布判断**：与前半一致——不随 Escapade 补丁发布默认行为；可随后续版本作为默认关的引擎侧能力入库；CHANGELOG Unreleased 已加 116 后半中英条目；用户可见形态待 117。
  - **治理清单**（不阻塞出门，累计）：`realhist-fixtures` 缺失两件回放 e2e 应进 SKIP；`run-all --parallel` 进度行串桶（第五波登记，只信末尾「失败件 tail」）；工具总数硬编码七处测试应统一读 `facts.json`；README 的 e2e／unit 口径（243／15）与 facts（293／23）漂移，`facts.static` 只软锁 ACC 数；收件箱轮询时序类 flaky（`steward-inbox`／`steward-tools`／`steward-preroute` 连跑）应在 117 前定位；等你线程持 cwd 写锁需一键停占用者（117d）。
  - **停点（用户 2026-09-06「跑完 116 就先停止」）**：116 全部收口，117 未派单；下次入口 = 117a 壳模式（设计要点已备：`SHELL_MODES` 加 `steward` 三态、`normalizeShellMode` 改显式白名单并重钉 `pretender-shell.static` 第 66 行同构断言、`index.html` 预绘同步、`#stewardShell` 为 `.app-shell`／`#previewShell` 的同级容器、`recoverStewardShell()` fail-closed 复用 `recoverClassicShell` 形状、设置页 `cfgShellMode` 加第三项）。
- **117a 壳模式并存（2026-09-06，opus 实现／Fable 验收，`ab4fb9e`）**：`SHELL_MODES` 冻结三态 `['classic','preview','steward']`，`normalizeShellMode` 改显式白名单 `SHELL_MODES.includes(value) ? value : 'classic'`，`index.html` 预绘脚本同构（只认 preview／steward，其余回 classic）；`#stewardShell` 为 `.app-shell`／`#previewShell` 的 body 直系同级容器，骨架四空位 `#stewardHeader`／`#stewardFeed`（`role="log" aria-live="polite"`）／`#stewardComposer`／`#stewardStatus`（`role="status"`）＋「回到经典」；新模块 `js/steward-shell.js`（138 行，IIFE 命名空间＋注入依赖＋冻结导出）与 `css/views/steward-shell.css`（132 行，经 `styles.css` `@import`，零硬编码色、reduced-motion、390px），三态显隐全部走 `data-shell-mode` 属性选择器，**状态源单点**：验收 grep 全仓写入点只有预绘脚本、`applyShellMode` 与两处 fail-closed 回退。`recoverStewardShell({persist})` fail-closed 三分支：开关关（`state.config.stewardEnabledV1 !== true`）／容器或空位缺失／依赖缺失，回 classic 并在 `#stewardStatus` 给 i18n 原因；管家壳模块零 `setInterval`／`setTimeout`／`fetch`（验收 grep 零命中）。设置页 `cfgShellMode` 加第三项「管家（预览）」，开关关时 `disabled` 并加提示。后端零改动（`stewardEnabledV1` 本就在 `GET /api/status` 掩码输出里）。**偏差（Fable 接受）**：① 文案去掉「3.0」——既有 D2／D1 锁的 forbidden 正则作用于 index.html 全文与两份 locale 全部 value；② 多导出 `syncStewardShellAvailability`，因 `bindEvents()` 早于 `bootData()`，bind 期 `state.config` 为空必判否，若那时落盘会把开关开着的用户偏好每次刷新抹回 classic——bind 期回退 `persist:false` 只钉画面，config 到达后（`provider-settings.js` `fillSettings()` 末尾注入调用）再真正落盘，e2e E1 锁这条；③ `recoverStewardShell` 因此收 `{persist}` 选项；④ 组合根用迟绑定句柄打开预览壳↔管家壳互依赖的环（`previewStreamSink` 先例）。顺带修正：`refreshPreviewShellLabels()` 原来切语言时会把停在管家壳的选择器写回 classic，改为跟随 `data-shell-mode`。**重钉（同 commit 注明）**：`pretender-shell.static` A2 预绘表达式与 C6 归一化表达式改为白名单形态（语义不变）；`read-frontend-css.js` `CSS_PAYLOAD_GROUPS` 加 steward-shell.css 且 `LEGACY_STYLES_SHA256` 重钉（SPEC §6 说明）；`facts.json` e2eCount 293→295；离线包清单 `tools/build-overlay.js` 收录两文件。**门（验收复跑）**：`build --check` 新鲜；依赖图 41／317 零漂移；路由 126／114 零漂移；清册 48 面不变；`steward-shell.static`、`pretender-shell.static`、`pretender-preview-ready.static`、`frontend-domains`、`facts.static` 全过；浏览器 e2e `steward-shell`（开关关写 steward→classic 且 option disabled／开关开切 steward 三容器显隐与获焦／全链路 localStorage 一致／未知值回 classic）与 `pretender-shell` 背靠背全过。实现侧 `--parallel 4` 281/7/3：6 红既有名单＋`interventions-persist`（并行下必红、串行必绿）。**登记（未修）**：① `route-inventory` 的「测试覆盖」列会被任何含 `/api/status` 字面量的新 e2e 拉动，与「后端零改动＝零差异」门约冲突（本波改为读 `window.state.config` 规避）；② `app.js` 组合根 1274／1280（`frontend-domains` D45），117b 接线须尽量住在 `steward-shell.js` 内；③ `preview-shell.js` 3627 行／`preview-shell.css` 1982 行远超前端上限（既有），`applyShellMode` 单点仍住预览壳文件，117g 前应把壳模式函数组抽层；④ `eol-policy.static` 存量实测 160 条（非 165），全在 `resources/plugins/win-workbench-offline/`；⑤ `interventions-persist.e2e` 并行必红串行必绿，比 flaky 更硬一档，建议给独立工作夹或列 `PARALLEL_EXCLUSIVE`。
- **117b avatar（2026-09-06，sonnet 实现／Fable 验收并代提交，`2e61cb6`）**：纯函数模块 `js/steward-presence.js`（78 行，Node 可 import）：`STEWARD_PRESENCE_STATES` 七态与 `derivePresence(input)`，优先级按 §8.3——sleeping（开关关或已停机）覆盖一切 → 在途（`streaming`／`inflight`：phase 为 calling_tool／orchestrating／waiting_resource／compacting → working，否则 thinking）→ error → waiting_you → listening → idle；`presenceLabelKey` 给 aria-live 文案键；单测 14 例全过。头像 DOM 住 `#stewardHeader`（`#stewardAvatar` button＋SVG 环 r44／主体 r31／一对椭圆眼＋`#stewardPresenceText aria-live="polite"`），**位置固定顶部**；新样式层 `css/views/steward-avatar.css`（114 行）七态一一对应（验收统计每态 ≥1 条规则、无枚举外状态）、120ms 交叉淡入、waiting_you／error 一次性 pulse／shake、reduced-motion 关全部 animation、零硬编码色、不用 canvas／WebGL／第三方库；i18n `stewardShell.presence.*` 七键中英对称。接线全部住在 `steward-shell.js`（138→258 行，**app.js 仍 1274 行**，D45 余量未动）：presence 子域 `setPresenceInputs`；typing 由 composer textarea 的 input／focus／blur 驱动；enabled 跟随 `state.config.stewardEnabledV1`；stopped／inflight／circuit／lastReply 来自 `GET /api/steward/state`。**轮询纪律**：全文件恰好一处 `setInterval`（startPolling）与一处 `clearInterval`（stopPolling），唯一入口 `syncPolling` 先判 `isStewardMode()`，非管家模式恒停；触发点为 `data-shell-mode` 的 MutationObserver（谁改的都算，零遗漏）、`visibilitychange`（隐藏即停）与 bind 完成时；周期 `stewardPollMs` 下限 5000。**重钉（语义收紧）**：`steward-shell.static` C2「零 timer」／C3「零请求」→「timer 与请求只能活在模式门控里且各自全文件恰好一处、锁死在 startPolling／stopPolling／pollStewardState」；`read-frontend-css.js` 清单加 steward-avatar.css 并重钉 SHA；`build-overlay.js` 收录两文件；route-inventory 只有「测试覆盖」列变动（判定点／鉴权行不变，`--check` 零漂移）；facts e2e 295→296、unit 23→24。**过程偏差**：代理在等自己的全量回归时停机未回传汇总，Fable 接手验收（`build --check`、依赖图 41／317、route-inventory、六件静态锁、两件浏览器 e2e、`run-all --fast` 58/59 唯一红为既有 eol-policy）并代提交；代理随后回传完整报告：改动与代提交内容逐字节一致，实现侧 `run-all --parallel 4` 281 pass／8 fail／4 flaky／289 ran——8 红为既有名单 6 件＋`subagent`（已知 flaky）＋`interventions-changeseq`（新观察，并行独有），二者串行全过；代理侧另有三条自主取舍：textarea 保留源码 `disabled` 以满足 117a B6 锁而在运行时清除、`stewardShell.name` 由「管家」改为「如意」（§8.2 与原型的称呼）、`derivePresence` 全空入参按 §8.3 字面回 sleeping（fail-closed，`{enabled:true}` 回 idle），Fable 接受。**登记（未修）**：`pending` 待决计数目前以 `lastReply.acts.length>0` 近似「提议待批」，117c 接真值（`GET /api/steward/state` 无 pending 字段）；无 SendMessage 工具时子代理中途停机只能由主会话接手。
- **117c 对话区与递话（2026-09-06，opus 实现／Fable 验收，`76d7999`）**：新模块 `js/steward-conversation.js`（654 行：对话流「话＋一行按钮」、※ 依据浮层、按钮落定经 `POST /api/steward/act` 换灰字回执、稳定信封人话表、到访渲染、撤回倒计时）与 `js/steward-composer.js`（294 行：递送目标 chip、150ms 去抖＋序号丢弃的 `GET /api/steward/preroute`、`@`／`Tab` 候选 listbox、Enter 直递）、`css/views/steward-conversation.css`（231 行）；两子域在 `steward-shell.js`（258→294）内组装注入，**app.js 仍 1274 行**。**每次打开只汇报本次**：进壳调 `POST /api/steward/visit`，`newVisit` 时清屏渲染问候＋要点（≤5，确定性文案）＋「打开焦点线程／知道了」＋仍待决提议；否则从 `GET /api/sessions/steward` 只渲染本次到访起的回合；`pendingCount` 真值改自 `visit.pending[]`（117b 的 `lastReply.acts` 近似已删）。**递话**：目标为线程时不经管家回合，直接 act `steward_thread_continue`，回执「递给了『X』」，10 秒「撤回 N」到点变「换一条」；撤回＝`POST /api/stop` → `POST /api/session/rewind`，rewind 回 `ok:false` 时不许说「已撤回」（诚实分支）。派发 `steward:open-thread`／`steward:focus-thread` 事件供 117d／117h。头像菜单「细节」开关（localStorage）折叠本回合工具轨迹；思考占位「···」。**偏差（Fable 接受）**：①「换一条」无下拉菜单——到点即撤回＋追问「那递给谁？」＋就地打开候选 listbox（「在事项下新开／另起一件」两项要委托书表单与事项视图，归 117d／117e）；② `@` 候选的「最近线程」用本次会话回忆池（预判 hits LRU≤8），无服务端只读路由；③ 禁词的 locale 检查限定 `stewardShell.*` 命名空间（`速问` 是交办台既有产品词，全局扫会连坐既有件）；④ 问候与要点分两段渲染（中英标点空格规则不同）；⑤ `stewardShell.composerPlaceholder` 退役改指 `stewardShell.compose.placeholder`；⑥ 头像菜单只有「细节」一项（设置／记忆／行动流水归 117e）。**重钉（同 commit 注明）**：`steward-avatar.static` D2 import 由 1 条变 3 条（仍相对路径、零第三方）；`read-frontend-css.js` 清单加 steward-conversation.css 并重钉 SHA；`steward-shell.static` C2a／C3a 原样通过（倒计时住 conversation、去抖住 composer、NDJSON fetch 住 conversation）；route-inventory 只有「测试覆盖」列变动；facts e2e 296→298。**门（验收复跑）**：`build --check` 新鲜；依赖图 41／317、路由 126／114 零漂移；清册 48；七件静态锁与 `steward-conversation`（32 条）／`steward-shell` 浏览器 e2e 全过；`pretender-shell` 在管家浏览器件之后背靠背两次红 D7（`previewErrorClassicBtn` 未出现），切回 117c 之前一次绿、HEAD 单跑与调试副本共四次连绿——判为已知 flaky（浏览器件连跑时序），非 117c 引入。实现侧 `run-all --fast` 59/60、`--parallel 4` 284/7/2，7 红全在既有名单，零非名单红。**登记**：①（Fable 拍板，纳入 117d 第 0 步）`steward_thread_continue` 的 `undoRef.turnSeq` 是递话**前**的 seq，而 `rewindSession` 按「要删的那一回合的第一条用户消息」（`plannedTurnSeq = turnSeq + 1`）定位，按字面传会得 `target turn not found`（HTTP 200，`ok:false`）——本波前端 `+1` 规避，后端应补明确的 `rewindTargetTurnSeq` 字段；② `pretender-shell` D7 连跑时序 flaky 加入名单；③ `interventions-persist` 并行必红仍未治理。
- **117d-0 撤回锚点（2026-09-06，opus 实现／Fable 验收，`bff3f6d`）**：13g `steward_thread_continue`／`steward_thread_new` 的 `undoRef` 增 `rewindTargetTurnSeq`（＝`head.turnSeq + 1`，与 09 `plannedTurnSeq` 同口径；既有 `turnSeq` 语义「递话前」不变），13f 描述补句，`steward-tools.e2e` 只加 D1b／E1b；前端撤回优先读新字段、缺省回落 `+1`。**计划外后端改动（Fable 复核后接受）**：`02-session-store.js` `rewindSession` 首读撞上回合收尾的原子头文件换名窗口会回 null 而直接吐 `session not found`（撤回序「先 stop 再 rewind」，stop 已删 `activeChildren`、收尾 save 刚开始写；实测约五成命中，117d 抽屉在递话后多打四条只读请求把它放大到 `steward-conversation.e2e` G 段必红）——修法只挪结论位置：先照常停回合与等 settle，再以重读为准，并用活回合注册表兜底；真正不存在的会话两处 await 皆 no-op 仍回 404。`rewind`／`session-turn-core`／`steward-tools` 验收复跑全过。
- **117d 线程抽屉（2026-09-06，opus 实现／Fable 验收，`f633790`）**：新模块 `js/steward-drawer.js`（680 行）、**`js/steward-chips.js`（331 行，权限／模型／引擎快切 chip 控件，抽屉、117g 顶栏、117h 看板行三处共用一份数据，抽屉不自己实现 PATCH）**、`css/views/steward-drawer.css`（368 行）；`index.html` 骨架 100 行，十一区块 DOM 定序即锁（事项行 → 线程页签 → 线程头＋五态＋等待原因＋「2.0 视窗」→ 快切 chip → 它刚说 → 你可以说 → 接力（同事项其它线程）→ 三问 → 验收项 → 现场 → 底部直连输入框／暂停继续／停止／整单回退／交回管家）；`role="dialog"`＋`aria-labelledby`＋tablist；≥1000px 右栏 390px、<1000px 全屏 `aria-modal`；`Esc`／×／交回管家关闭；打开入口 `steward:open-thread`／`steward:focus-thread` 与导出 `openThread`。**它刚说**＝`GET /api/sessions/<id>` 最后一条助手原话前 ≤3 句；**你可以说**＝纯函数 `quickRepliesFor`（待决选项 ＞ 问句 ＞ 五态默认，≤3，单测 19 例），点击直发线程不经管家（待决走决定路由；在途插话 `/api/steer`、空闲开回合 `/api/chat/stream`）。权限 chip 切全自动弹 §8.6 文案二次确认后 `confirm:true`。轮询只刷本线程的 `GET /api/sessions/<id>`＋`GET /api/interventions` 切片，本模块恰好一处 `setInterval`／`clearInterval`，关闭或切离即清。复用（拼接读取非复制）：`preview-task-sheet.js`／`turn-activity.js`／`mission-state.js`；`pretender-task-sheet.static` W100-3 改为拼接读法（既有本文件读法，其余不动）。**app.js 1275／1280**。**偏差（Fable 拍板）**：① `GET /api/missions` 返回的是线程行而非容器（116g 只追加聚合字段），容器 `title`／`acceptance.items` 不在里面——事项行按确定性顺序回落（自成事项线程标题 → 本线程标题 →「未归事项」），验收项改读 `GET /api/missions/<sessionId>` 快照；**拍板：117h 第 0 步在 `/api/missions` 行上只加 `missionTitle`／`goal`／`acceptanceItems`，不加新路由**；② `session.resumable` 无 `live` 字段，在途判定改用 missions 行 `activeTurn` 与五态 `running`（接受）；③ 五态标签如实照搬 `mission-state.js`（跑过 chat 回合但无 run 的会话显示「交办中」，不另编判据）；④ 三问无 HTTP 快照，抽屉用权威字段拼最小快照喂同一个 `describeTurnActivity`（未决→waiting_you、`wait`→waiting_resource、其余「暂无」，不因「在跑」编 thinking）；⑤ 快捷回复不含 plan（§8.13 只点名 question／permission）；⑥ 暂停／继续按快照活 run 二选一；⑦「＋ 线程」只派 `steward:new-thread` 并置 chip「→ 如意 · 在事项下新开」；⑧「看全文」「看改动」「2.0 视窗」本波同一动作（切经典壳＋选中会话，返回带归 117g）；⑨ 事项聚合与验收只在打开／切线程／写动作后刷新。**重钉（同 commit 注明）**：`steward-avatar.static` D2 import 白名单 3→4；`pretender-task-sheet.static` W100-3；`steward-conversation.static` E3（锚优先新字段）；`read-frontend-css.js` SHA；`build-overlay.js` 三文件；facts e2e 298→300、unit 24→25。**门（验收复跑）**：`build --check` 新鲜；依赖图 41／317／前向边 67；路由 126／114 零漂移；清册 48；九件静态锁与 `steward-drawer`（55 条）／`steward-conversation`／`steward-shell` 浏览器 e2e、`steward-tools`／`rewind`／`session-turn-core` 全过；实现侧 `--fast` 60/61、`--parallel 4` 287/6/2，6 红既有名单、2 flaky（pretender-shell／subagent）在名单，零非名单红。**登记**：①（**116g 引入的真 bug，归 117e 第 0 步**）线程经 `missionAttachThread` 挂进显式容器后 `session.missionId` 变成容器 id，而 `/api/chat/answer`／`/api/permission/decision`／`/api/plan/decision` 三条兼容适配器仍传 `missionId: sessionId`，`decideIntervention` 的 `sessionMissionId(head) !== missionId` 门判 `not_found` → 前端得 `question.delivery_failed`，凡进了多线程事项的线程问题／权限／计划都答不进去（经典壳同样受影响）；② `steward-conversation.js` 错误文案对结构化 `error` 做 `String()` 显示「[object Object]」（117e 修）；③ `steward_quick_ask` 的 `undoRef` 未加 `rewindTargetTurnSeq`（117e 第 0 步）；④ 116h 登记项「等你线程持 cwd 写锁需一键停占用者」本波未做，抽屉只显示 `wait.label`／`blockedBy`（117h）。
- **117e-0 四处修补（2026-09-06，opus 实现／Fable 验收，`2245606`）**：① 116g 真 bug——`decideIntervention` 的 `sessionMissionId(head) !== missionId` 门在 116g 前是恒等式，`missionAttachThread` 把 `session.missionId` 改成容器 id 后，三条兼容适配器与 `steward_decide` 传的 `missionId: sessionId` 恒判 `not_found`，凡进了多线程事项的线程问题／权限／计划都答不进去（经典壳同样受影响）。修法选「门接受会话自身 id 为别名」而非「适配器改传容器 id」（后者会把容器 id 送进 `sessionPath()`／`readInterventions()`，容器无会话文件只是换一种 not_found）；**未放宽跨会话答别人的待决**（待决本体仍从会话自己旁路账取，`current.sessionId === missionId` 判定原样），Fable 复核 diff 接受；新增 `intervention-mission-gate.e2e.js`。② `steward_quick_ask` 的 `undoRef` 补 `rewindTargetTurnSeq`。③ 新增只读路由 `GET /api/steward/decisions?limit=&sessionId=&since=`（token 级，limit 缺省 50 上限 200，NDJSON 尾窗坏行跳过，args 掩码复用 06i `STEWARD_CONFIG_SECRET_PATTERN`）；路由 126→127 判定点／114→115 鉴权行；新增 `steward-decisions.e2e.js`。④ `steward-conversation.js` 错误文案改 `stewardErrorCode`／`stewardErrorText`（取 `message||error||code`），不再 `String(obj)`；静态锁只加。
- **117e 设置（2026-09-06，opus 实现／Fable 验收，`894930c`）**：设置弹窗新页签「管家」（基础之后、Agent CLI 之前），六组 section（总开关与壳／新线程默认权限／管家可以自己做的事／模型与预算／管家记得的关于你／行动流水）：总开关打开＝`saveConfigPartial` 成功后 `POST /api/steward/start`，关闭＝先 `stop` 再存 false（任一失败回滚 UI）；一键停机／唤醒按 `GET /api/steward/state.stopped` 显示并即时喂 presence（`{enabled,stopped}`，头像立刻 sleeping）；默认权限四档表与全自动确认文案**从 `steward-chips.js` 导出复用**（静态锁「settings 不定义第二份四档表」）；自理清单四项（resume 三态）；模型与预算八个数字键＋对话保留三档＋到访静默；记忆面板按 kind 分组、就地编辑带 `version`、「新」标、否决／恢复、导出（`<a download>`）、清空须输入 `clear`；行动流水读新路由，列时间／做了什么／目标线程／线程权限／依据／费用／`undoRef`（有 `rewindTargetTurnSeq` 给「撤销」），客户端按线程与日期过滤，「加载更多」按 limit 递进（decisions 的 `seq` 是 per-process 计数器当不了游标，`since` 留给增量刷新）。管家壳头部加常驻停机键 `#stewardStopBtn` 与盾牌 `#stewardShieldBtn`（写全局 `permissionMode`，复用 chips 的档位表与确认）；头像菜单加「设置／记忆／行动流水」三项。新模块 `js/steward-settings.js`（794 行）、`css/views/steward-settings.css`（269 行）；**app.js 1275→1277（护栏 1280，余 3 行）**、`provider-settings.js` +2。**偏差（Fable 接受）**：设计「五组」实为六件事→六组；provider 选项无可复用函数（`populateSubagentPreferenceSelects` 硬绑两个 id）→本模块按同一份 `state.config.providers` 渲染；掩码用 06i 密钥判据而非 `maskProviders`。**重钉（同 commit 注明）**：`steward-avatar.static` D2 白名单 4→5；`read-frontend-css.js` SHA；`build-overlay.js` 两文件；`help-menu.js` `SETTINGS_TAB_HELP_ANCHORS` 加 `steward`（`copy-path-guard.static` ③b 要求每页签有锚点）；`index.html` 多行注释拆逐行（`i18n.static` 只放行含 `<!--` 的中文行）；`docs/i18n/locales/*` 同步；facts e2e 300→304。**门（验收复跑）**：`build --check` 新鲜；依赖图 41／317／前向边 67；路由 127／115 零漂移；清册 48；十二件静态锁（含 `copy-path-guard`、`i18n`、`prompt-snapshot`）全过；`intervention-mission-gate`／`steward-decisions`／`steward-quick-ask`／`mission-threads`／`interventions-persist`（串行）与 `steward-settings`／`steward-shell`／`steward-conversation`／`steward-drawer` 浏览器 e2e 全过；实现侧 `--fast` 61/62、`--parallel 4` 290/7/2，7 红＝既有名单 6 件＋`ec-d-performance`（干净 HEAD 与带改动各连跑 3 次均 2 过 1 红，同一条时序 flaky），零非名单红；全量耗时约 4 小时。**登记（未修）**：① `ec-d-performance` 本机约 1/3 概率红，进 flaky 治理；② 记忆面板与行动流水懒加载只挂在「点页签」时刻，从命令面板等入口切到该页签需先按「刷新」；③ 改全局默认权限后经典壳顶栏安全 chip 重绘等下一次 `refreshStatus`；④ 行动流水「目标线程」列显示 sessionId 原文，无便宜的 id→标题只读面；⑤ app.js 余量仅 3 行，117g／h 若不够须先做零行为抽层而不是抬护栏。
- **117h-0 事项接口只加字段（2026-09-06，opus 实现／Fable 验收，`aed8b8f`）**：`GET /api/missions` 每行只加 `missionTitle`（有容器＝容器标题，derived 行＝本行标题）、`goal`（无容器空串，不拿线程摘要冒充）、`acceptanceItems`（容器验收项整表）；ETag 指纹由 3 元组扩到 5 元组纳入容器 `title`／`goal`（写进指纹才自证，不依赖「每次改都动 updatedAt」的隐含约定）；`mission-threads`／`pretender-mission-control` 只加断言；Fable 复核 diff 只加不改。路由零变化，前向边 67，清册 48。
- **117g 2.0 视窗＋117h 看板与「现在这一件」（2026-09-06，opus 实现／Fable 验收，`0c5b6d8`＋时序修复 `7af8dff`）**：新模块 `js/steward-classic-window.js`（146 行）：`openClassicWindow(sessionId)`＝`applyShellMode('classic')`＋注入的 `openSession`＋返回带 `#stewardReturnBand`（静态写在 `main.chat-pane` 首位、默认 hidden；「回到管家」→ 切回并派发 `steward:focus-thread`；会话名＋事项名＋**同一组快切 chip**）；只在从管家壳进入时显示（`sessionStorage['wcw.stewardReturn']`），整体切壳清标记；`pretender-shell.static` 只加「2.0 视窗零第二套状态」断言（该模块无 `api(`／`fetch(`，只读 `state` 与 chips）；头像菜单加「整体切到 2.0」；抽屉的「2.0 视窗／看全文／看改动」统一改调它。新模块 `js/steward-board.js`（629 行）：状态行 `#stewardStatusLine`「N 个事项 · A 条在跑，B 条等你」（无线程→§8.9 空状态文案），点开看板 `#stewardBoard`（`role="region"`，Esc 关）：顶部「同时最多 N 条」就地改（`saveConfigPartial({stewardMaxParallelThreads})` 后读 `GET /api/steward/arbiter` 回填）、在跑／排队计数、「全部暂停」、「整体切到 2.0」；正文按事项分组，事项行＝`missionTitle`／聚合态（只读行上 `aggregateState`，人话经 `mission-state.js`，**不另写聚合判据**，静态锁）／线程数／验收 a/b／费用／预算／「+ 线程」，线程行＝五态点／标题／耗时／快切 chip（紧凑模式）／当前动作或等待原因（`wait.label`＋`blockedBy`／`ahead`；**等锁时给「停掉占用者」**＝对 `blockedBy` 会话 `POST /api/stop` 二次确认，116h 登记项①落点）／悬停操作（暂停继续／优先／停止／打开／2.0）。「现在这一件」`#stewardNow`：≥1000px 右侧常驻，内容＝抽屉本体以 `docked` 模式挂载（一份实现两种挂法，静态锁「不存在第二份抽屉区块渲染」）；焦点＝纯函数 `focusThreadFor(rows)`（等你＞在跑＞失败＞最近，单测 10 例），`steward:focus-thread` 覆盖；「关掉」回单列记 localStorage，看板行「打开」可请回来；<1000px 不常驻。`css/views/steward-board.css`（270 行）。**app.js 仍 1277／1280，未做抽层**。**偏差（Fable 接受）**：① 刷新纪律收紧——只有看板打开时才起计时器，docked 的「现在这一件」由抽屉自己那份轮询刷新，行数据在进壳／开看板／焦点事件／写动作／页面重新可见五个时刻各刷一次（按字面「看板打开或现在这一件可见」会给管家壳常驻第三条计时器，既顶 §3.4 零后台活动，也把 `steward-drawer.e2e` B15「抽屉与 avatar 轮询各一」由 2 顶成 3）；代价是只挂 docked 时状态行数字与仲裁计数不自己 tick；② `/api/missions` 行是任务卡不带 `permissionMode`／`engineRoute`，看板行 chip 先用组合根已持有的 `state.sessions` 元数据渲染，`steward-chips.js` 加 `hydrate`（打开菜单前按需补一次 `GET /api/sessions/<id>`，每会话一次），无第 0 步之外后端改动；③ 线程行不显示费用（行上只有事项级聚合费用桶，无 per-thread 金额，§8.1 原则 2 只报可核验的耗时）；④「关掉」可逆（看板行「打开」清偏好重新 dock；docked 下 Esc／× 也等于关掉）。`7af8dff`：返回带的事项名等看板那批行到手再画（并行全量暴露的时序，`onRowsChanged`），两件新浏览器 e2e 等待预算 400→800。**重钉（同 commit 注明）**：`steward-avatar.static` D2 白名单 5→7；`read-frontend-css.js` SHA；facts e2e 304→307、unit 25→26。**门（验收复跑）**：`build --check` 新鲜；依赖图 41／317／前向边 67；路由 127／115 零漂移；清册 48；十四件静态锁与 `unit/steward-focus-thread` 全过；`steward-board`（44 条）／`steward-classic-window`（26 条）／`steward-drawer`／`steward-conversation`／`steward-shell`／`steward-settings` 浏览器 e2e 与 `mission-threads`／`pretender-mission-control` 全过。实现侧 `--fast` 62/63、`--parallel 4` 两遍均 293/7，第二遍 2 flaky（`memory-auto-proposal-api`／`steward-classic-window`），7 红全在既有名单（`interventions-persist` 本次并行绿），零非名单红。**登记（未修）**：① `/api/missions` 行是任务卡而非线程行（缺 `permissionMode`／`engineRoute`／`state`／`lastAssistantText`），117d 记录与任务书按线程行描述它是错的，根治要么加字段要么给会话元数据开便宜只读面；② `dockToneForMissionState` 住 3629 行的 `preview-shell.js`，import 它经 `state.js` 触到 `window.state` 兼容层，两件 Node 测试各需 `globalThis.window = globalThis` 垫片——与 117a 登记③同一件事，应把壳无关纯函数抽小模块；③ `steward-chips.js` 的 `note()` 硬编码落 `#stewardDrawerNote`，看板行 chip 改完的回执在 overlay 关着时看不见，宿主应能注入提示落点；④ `chipsBySession` 缓存只增不减（未做 LRU）；⑤ `steward-classic-window.e2e` 并行下偶发慢（预算 32s），与 `pretender-shell` D7／`subagent`／`ec-d-performance` 同进「浏览器件连跑时序 flaky」治理；⑥ `run-all --parallel` 进度行串桶第六波登记。
- **117 出门（2026-09-06，Fable）Release Brief**：
  - **问题**：116 给了管家「能看、能递、能答、能记」的引擎侧，用户仍只能经工具面碰它。117 要让 115 原型里拍板的那套体验真实可用：两壳长期并存、默认视图只有四样东西、话＋一行按钮、每次打开只汇报本次、输入即预判的递话、抽屉里看得见线程在说什么与该对它说什么、单一权限四档三处同一控件、看板按事项分组且排队可解释、宽屏「现在这一件」。
  - **非目标（留后续）**：117f dogfood 与默认壳切换（用户连续使用两周后再议，不自动恢复原 P4）；「换一条」的「在事项下新开／另起一件」菜单项与委托书编辑表单（需事项视图，归 120／后续）；线程行 per-thread 费用（行上只有事项级费用桶）；`/api/missions` 行升格为线程行或会话元数据只读面；壳无关纯函数从 `preview-shell.js` 抽小模块；119 定时任务接入；语音／附件（114）。
  - **交付（11 个实现 commit，串行、每片独立验收）**：117a `ab4fb9e`（三态壳模式、`#stewardShell` 同级容器、fail-closed）→ 117b `2e61cb6`（七态 avatar 纯投影、轮询只在管家模式）→ 117c `76d7999`（对话区、到访、预判递话与 10 秒撤回）→ 117d-0 `bff3f6d`（`rewindTargetTurnSeq`、rewind 首读竞态）＋117d `f633790`（十一区块抽屉、三处共用快切 chip、`quickRepliesFor`）→ 117e-0 `2245606`（116g 待决门真 bug、`GET /api/steward/decisions`、速查回退锚、错误文案）＋117e `894930c`（设置页签六组、记忆面板、行动流水、盾牌与停机键）→ 117h-0 `aed8b8f`（`/api/missions` 行只加三字段）＋117g/h `0c5b6d8`＋`7af8dff`（2.0 视窗返回带零第二套状态、看板与「现在这一件」、等锁停占用者）。前端新增 10 个模块（`steward-shell/presence/conversation/composer/drawer/chips/settings/board/classic-window` 与样式层）、7 件浏览器 e2e、11 件静态锁、4 件单测；后端只加 1 条路由（决策日志只读）与 3 个字段，路由 127 判定点／115 鉴权行，前向边 67 全程不变，清册 48 面不变，**app.js 1274→1277（护栏 1280����**。
  - **证据**：串行全量 `run-all.js` = **294 pass／6 fail／0 flaky／300 ran／7 skipped**（2026-09-06，HEAD `7af8dff`）；6 红逐件为既有名单（`eol-policy.static` 160 存量、`observation-recall-replay`／`-realhistory` 缺 `realhist-fixtures`、`index-dedup`／`session-notes`／`websearch` 干净 HEAD 同红），**零新增确定性红、零 flaky**；各片验收另有静态锁、浏览器 e2e 与相关后端 e2e 复跑记录见上；实现侧每片 `--parallel 4` 均零非名单红。
  - **默认启用范围与回退**：壳模式默认 `classic`，管家开关默认关；`localStorage` 里残留 `steward` 时若开关关或依赖缺失，预绘与运行时双重回退到经典并把偏好改回（bind 期只钉画面、config 到达后才落盘，不抹掉开关开着的用户偏好）；非管家模式下管家壳零定时器零请求（静态锁）；经典壳与预览壳的既有断言一条未改。回退 = 设置里切回经典（或删 `localStorage['wcw.shellMode']`）；彻底回退 = 逆序 revert 11 个 commit（生成器产物随之重算），无数据迁移。
  - **发布判断**：可随下一版本作为「默认关、需手动切换」的界面模式入库；CHANGELOG Unreleased 已加 117 中英条目；README 截图与用户指南待 117f dogfood 后补。
  - **治理清单（累计，不阻塞出门）**：① `/api/missions` 行是任务卡而非线程行（缺 `permissionMode`／`engineRoute`／`state`／`lastAssistantText`），117d 记录与任务书描述有误，应加字段或开会话元数据只读面；② `dockToneForMissionState`／`normalizeShellMode`／`applyShellMode` 仍住 3629 行的 `preview-shell.js`，import 触到 `window.state` 兼容层，应抽壳无关小模块；③ 浏览器件连跑时序 flaky 名单（`pretender-shell` D7、`steward-classic-window`、`subagent`、`ec-d-performance` 约 1/3）需治理，`interventions-persist` 并行必红应列 `PARALLEL_EXCLUSIVE`；④ `run-all --parallel` 进度行串桶第六波登记；⑤ `route-inventory`「测试覆盖」列被新 e2e 拉动；⑥ `steward-chips.js` 的 `note()` 落点硬编码、`chipsBySession` 无 LRU；⑦ 记忆面板／行动流水懒加载只挂在点页签时刻；⑧ 改全局默认权限后经典壳顶栏 chip 等下一次 `refreshStatus`；⑨ 行动流水「目标线程」列显示 sessionId；⑩ 工具总数硬编码七处测试、README e2e／unit 口径漂移、`realhist-fixtures` 缺失、`eol-policy` 160 存量（116 已登记）。
  - **停点**：117 全部收口，按用户 2026-09-06「继续」指令推进至此；117f dogfood 留用户，后续实施入口见方案索引「当前实施入口」。
- **117 用户走查与对抗审查波（2026-09-06，Fable 设计验收，Opus／Sonnet 实现）**：
  - **用户反馈**（原话「用户体验很烂、界面也丑、管家不能自由对话、弹出的线程标题太长」「界面比原型差好多」「新版本之后原先的模型列表都没了」）逐条根因与处置：
    ① 头像撑到 326px：`steward-avatar.css`／`steward-settings.css` 头注释里的「--dur-*/--ease-out」把注释提前关掉、吞掉各自第一条规则（浏览器 cssRules 首条直接是 `:focus-visible` 可证，静态锁读源码看不出）——`a5a0679` 改写注释并留警示；**CSS 注释里绝不能出现星号紧跟斜杠**。
    ② 管家不能对话：用户主端点是 Kimi CLI、管家「跟随主端点」，每句被 `steward.unsupported_engine` 拒；回合层失败经 200 流回来（`say` 空、`error` 带码）只画空行，另一路径把 `api()` 的 JSON 信封原样打出。`a5a0679`／`7245d71`／`3fecc43`：`stewardErrorCode/Text` 对 Error 先经 `apiErrorInfo` 解开；到访与流式两处识别该码给一句人话＋「改用『第一个 OpenAI 兼容 Provider』」（经注入回调走设置域 `saveConfigPartial`，J1 锁只许调 116 六条路由）＋「去设置」并自动重发；i18n 插值是 `{{name}}`。
    ③ 标题整句：按钮与候选项一行截断（117i 再在文案层截 24 字）。117a 遗留占位文案删除。
    ④ **界面比原型差好多 → 117i `96a834e`（opus）**：场景背景＋居中玻璃卡片、56px 头像、无盒对话流、右侧浅色用户气泡、药丸按钮（主动作金底）、胶囊输入区内嵌递送 chip＋圆形发送键、看板／抽屉／设置同套样式，双主题与 390px 对照截图存 scratchpad/shots；DOM 顺序与 id 零改动、app.js 1277 不动；重钉 `ui-v4-glass.static` G2 白名单（三壳互斥，模糊预算轴不变）与 `read-frontend-css` SHA；与原型残留差异：抽屉 390px（既有锁）、`.is-primary` 金底（派单要求）、伴卡为 fixed 而非卡内右栏（DOM 位置）。**它顺手抓到一条真安全回归**（见 ⑥）。
    ⑤ **数据事故**：19:36:49 一次整份 `POST /api/config` 把五个 Provider 连密钥写成 `[]`。根因链（对抗审查 P0-1 实测）：`navigation-controls.openModal` 先摘 hidden 再调 `fillSettings`，「弹窗隐藏才播种」守卫在用户点开设置那一刻恒假，`providersDraft` 停在初始 `[]`，`saveSettings` 无条件上传。恢复：从 `config.json.bak-20260809` 找回 deepseek／openai-compatible 含密钥，重建本机 Ollama 条目，glm／dashscope 只能重建条目（密钥无副本，用户重填）；被清空版本另存 `config.json.bak-20260906-wiped`。修复 `ed2dd19`（前端 `providersDraftSeeded` 守门；服务端清空前备份 `config.json.bak-providers-<ts>`＋审计）、`c214f3f`（从未播种时无论弹窗开合都播种；**P0-2** `readConfig` 把任何读失败当全新安装并写回默认→只 ENOENT 且无 `.prev` 才落默认，损坏／读失败先从每次覆盖前留的 `config.json.prev` 恢复，否则用本进程上一次好副本自愈，没有就降级拒写 `config.read_degraded`；清册 48→49 config-backups）、`0ad3a32`（**`.prev` 含明文密钥而 `isSensitiveDataPath` 只认精确名，audit-w23 P1#2 实测 file_search 能搜出**→ dataRoot 直系 `config.json*` 一律敏感；providers 任何缩水都备份并记 `config_providers_shrunk`；`addProviderFromPreset` 未播种先播种；补 c214f3f 漏跑的 manifest／module-contracts）。e2e：`config-providers-guard`、`config-read-safety`。
    ⑥ 管家把普通会话的 `kind:'quick_ask'` 说成「速查线程在跑」（提示词口径，116-3 P1-5）。
  - **对抗审查波（用户 2026-09-06 要求，五个 Sonnet 只读，报告 scratchpad/review-*.md）**：数据安全 2 P0（已修）＋3 P1；管家后端 6 P0＋9 P1＋5 P2（线程族工具回合内直调无目标权限门且 ctx 无 trigger、收件箱 slice(0,200) 后游标照推、resume 绕过安全档、cwd 互斥 TOCTOU、到访归档与在途回合并发写、永久豁免只认工具名不看命令内容；会话/权限子审查另加：管家会话可被 `/api/chat/stream` 当普通会话跑回合绕开 13h、`POST /api/config` 切 auto 无服务端门）；管家壳 UX 走查 0 P0／2 P1（关总开关后壳仍在却谎称已回经典、引擎问题文案写死原因）／3 P2（Esc 层级、※ 浮层 Esc、回执套娃）；经典壳回归 2 P1（顶栏权限 chip 切 auto 无确认、`fillStewardSettings` 无 try/catch 挡在播种前）＋返回带残留、进壳必打 404、经典壳首屏加载全部管家资源（治理）；文案可达性 1 P1（※ 里工具 id 泄漏）＋读屏刷屏／aria-controls／Esc。**派单**：116-3（后端，Opus，三 commit：P0 安全／P1／P2，派单稿 brief-116-3.md）→ 117j（前端，派单稿 brief-117j.md，等 116-3 入库后串行）。**治理登记**：经典壳首屏动态 import 管家模块另立切片；帮助手册滚动定位竞态；`USER-GUIDE_CN.md` §5 补管家页签；`run-all --parallel` 在同时跑无头 Edge 截图时 fail 数飙到 38（全为并行争抢）。
- **116-3 管家引擎侧对抗修复（2026-09-06→09-07 入库，opus 实现，三 commit：`e520428`／`013d274`／`2b334b9`）**：审查 22 条（6 P0＋9 P1＋4 P2＋追加 A2/B1/A4）逐条「先复现再修、断言只加不改」，**零复现不出而跳过**。**第一批（P0 六条＋A2＋B1）**：P0-1 永久豁免加内容层判据（26 条命令文本正则覆盖 §3.3 五类，exec 与档位缺失才扫，read/edit 档不扫）；P0-2 线程族三工具补权限门（13h 两个执行点 ctx 带 trigger，13g `stewardUnattendedByModel` 单点判定，决策日志 mayAct 写真实判定值）；P0-3 收件箱截断改到合并之前、超出进 carry 结转（硬顶 5000，真丢落 `steward_inbox_deferred`）；P0-4 resume 安全档判据搬进 13g `stewardRunResumeTier` 单点（13h 预闸改调它，模块边 317→316）；P0-5 仲裁 TOCTOU——全新 entry 也走入队→drain 单飞路径；P0-6 到访归档与在途回合互斥（在途则 `steward.busy`）；A2 管家会话只许 `source:'steward'` 发起回合（直跑 `/api/chat/stream` 得 403 `steward.forbidden`，GET 保留、PATCH 拒绝）；B1 `applyConfigPatch` 顶部共享校验（同一张 `PERMISSION_MODES_REQUIRING_CONFIRM`、同一个 `permission.confirm_required` 409），前端四处写口在既有确认弹窗后补 `confirm:true`（经典壳 permSelect 兼覆盖预览壳顶栏、`steward-settings.setDefaultPermission` 兼覆盖管家盾牌与设置页；app.js 1277/1280 不变）。**第二批（P1 九条＋数据安全两条＋copy P1-1）**：P1-5 「速问」误标根因是两个概念撞名，判据单点 `stewardQuickThread`，06i 标签改「速查中」、06b 管家包中英同改（prompt-snapshot 只 steward 段变）；P1-6 速查收工记 `closedTurnSeq`，继续对话即重开；P1-7 合并窗口分组键补 runId、nodeId/errorClass 累加列表；P1-8 游标损坏区分 ENOENT 与读失败，损坏走「从零开始、seen 兜底」＋审计；P1-9 `budgetSeen` 持久去重键进 cursor；P1-10 抽出 `stewardScheduleInboxDrain` 周期排空＋用户回合收尾顺带踢一次；P1-11 cwd 锁键先 realpath（同步段，ENOENT/EPERM 回退 resolve）；P1-12 队列溢出逃生舱只对预算与并发位开、同 cwd 写互斥不放行；P1-13 看板插队改调 `stewardImplThreadPrioritize`（校验＋审计）；data-safety P1-3 强制写落 `session_meta_defer_forced` 审计、P1-4 `rewindSession` 返回 `turnsWithoutCheckpoint`；copy P1-1 actions 三条出口带人话 label、前端优先读 label（前端只动一行）。**第三批（P2 四条＋A4）**：P2-11 每回合目标上限合并计数（确定性自理与模型 actions 合数同一个 3，超出降级 `per_turn_target_max`）；P2-12 config_set 切全自动走专门口径 `permission.confirm_required`（外层仍 propose_required 保按钮路径，收紧不套吓人话术）；P2-14 归档失败不推进到访时间戳、`archive.error` 入响应、落 `steward_visit_archive_failed`；P2-15 待决豁免登记 `pendingRuns`（刻意不进 running，116h 语义不动）、读模型加 `pendingWriters`、撞上同 cwd 活跃写者发 `agent_resource(state:'acquired')`、入队→drain 窗口补同步临时等待原因；A4 `missionCardSignature` 补 missionTitle/goal/acceptance.done/total 四维。顺带修正：熔断时 drain 不再自排下一轮（退回队列的事件不再 5 秒空转）；P0-1 信封拆 `exemptBy:'tool_name'|'command_text'`。**测试**：新增 `steward-guardrails.e2e.js`（A–J 组）、`steward-inbox-integrity.e2e.js`、`unit/steward-exempt.test.js`；`thread-arbiter`（⑫⑬⑭⑮）／`steward-runner`（G-3/G-4）／`rewind` 只加；各跑两遍全过。夹具改动仅一处：guardrails 的 fake provider 回复改可读 `providerReply` 变量（P2-11 需模型真声明 5 条 actions）；B1 经全仓 grep 确认无既有夹具带 auto/bypass，零夹具改动。**门**：前向边 67 全程不变；模块 41／边 316；路由 127 判定点／115 鉴权行零新增；清册 49 面不变；facts nativeTools 89 不变；`run-all --fast` 62/63（唯一红既有 eol-policy）；全量 `--parallel 8`（本机 24 核首次 8 路）**297 pass／7 fail／5 flaky／304 ran，约 9 分钟**（对照昨夜 `--parallel 4` 受污染轮 25–50 分钟）——6 红既有名单，唯一非名单红 `steward-board` 为浏览器件 120s 超时、串行两度全过（约 45s，归因争抢），5 flaky 重跑全过（subagent／steward-inbox／steward-tools 为历史时序名单），零新增确定性红。`app/server.js` 已 cp 进 `dist/Ruyi-full/app/`（**桌面端需重启生效**）。**回归提速结论**：`--parallel 8` 在 24 核机上失败谱与 4 路一致、无新增确定性红，可作为本机默认；浏览器重件在高并行下会撞 120s 超时，归因纪律照旧（非名单红串行复跑）。**治理登记**：`steward-board` 级浏览器重件宜入 `PARALLEL_EXCLUSIVE` 或提件级超时；116-4／116-5／117j 派单稿在 §11.7 待派。
- **116-4 引擎侧收件箱第四源与唤醒链（2026-09-07 入库，opus 实现，`3df47d3`）**：派单稿的两条前提在实测里都不成立，故全程「先复现、再按事实改」。
  - **复现**（进程内真服务＋fake-openai＋临时 HOME）：管家开一条速查线程 + 一条委托线程，两条都真跑完 → `inbox-v1.ndjson` **从未被写过**，`state.lastError` 是 `Cannot read properties of null (reading 'goal')`。与用户机器上的证据（各会话 missionChanges 全 0、箱子空、`stewardQuick.closedAt` 恒 null）逐条对上，且挖出比派单稿预想更深的一层。
  - **第 0 步（P0，派单稿没有这一条）**：`buildMissionCard`（13d）对 `head.mission === null` 直接读 `m.goal`。「`kind:'mission'` 但头上没有 mission 容器」是**真实形状** —— `steward_thread_new` 建线程时就显式写 `kind='mission'`，容器要等 `/api/mission start` 才有。`buildPretenderSessionSlice` 没有 try、`rebuildPretenderIndexFull` 的 `Promise.all` 整份 reject，于是**只要管家开过一条线程，`GET /api/missions`、`/api/missions/<id>`、`GET /api/interventions` 一起 500，收件箱每轮 tick 抛错、三个源一起停摆**。修：`mm = m || {}` 只用于 `mission:{}` 那一段；`status: missionCardStatus(m)` **仍收 `m`**（null → 'none'，收 `{}` 会变成 'idle'，那是行为改变）。回归钉在 `missions-readmodel.e2e` (g) 六条。
  - **第 1 步 先造账、再读账（派单稿两条假设不成立）**：① 会话头上**没有** `lastError`／`resumable.dangling` —— 实测一条 HTTP 500 的回合，头上只有 `summary` 里那句人话，那是渲染不是信号；② 前三源全挂在事项上：`bumpMissionChangeSeq` 读会话头，`!head.mission` 就直接 no-op，而管家开的线程恰恰没有容器，所以它们跑完之后三条源日志一个字都不写。故：13g 的 `stewardLaunchTurn` 在回合 settle 之后经 `updateSessionMeta` 落 `stewardLastTurn{seq, ok, aborted, errorClass, at}`（成败取**内层** `result.result.ok` —— 外层 `ok` 只表示「这次调用完成了」，一条 HTTP 500 的回合外层仍是 `ok:true`，拿外层判会把每条失败回合都说成收工）；`launchedBy:'steward'` 由 quick_ask／thread_new 建会话时就地写进内存副本（跟着既有那次 saveSession 落盘，零额外写），递话给用户自己会话的那条路由 settle 时补写。02 的元数据白名单加这两个键并严格归一（`launchedBy` 只认 `'steward'` 一个字面量 —— 这条通道也接 `PATCH /api/sessions/:id`，不能让调用方给自己的普通会话挂上管家的注意力）。
  - **第 2 步 第四源 `sessionTurns`（13i）**：登记进 `STEWARD_SOURCE_EVENT_MAP.sessionTurn`（`turn_settled → '@sessionTurn'`；它没有「源码写入端 type 字面量」可对账，与 projection 派生组同样不参与 116b 静态锁的三条双向等集，另由 D7 单独钉一遍）。判据「turnSeq 前进 + 当前无活回合」；「管家关心哪些会话」三条判据单点在 `stewardWatchedThread`：`stewardQuick` ／ `launchedBy==='steward'` ／ `missionId !== sessionId`（别人事项里的线程）—— **用户自己在经典壳里聊的普通会话不入箱**（他就坐在那条线程前面）。去重键 `sid|kind|''|turnSeq`。成本：先比投影免费给的 `sourceStamp`（会话文件 size:mtime 指纹），没变连会话头都不读。
    · **位置纪律**：收集点必须排在「不活跃且账本没新版本就 continue」**之前** —— 速查线程没有 mission 卡片，`card.updatedAt` 空 → `recent` 恒 false → 第二轮起就会被那条 continue 跳过，放在后面等于第四源只在会话首见那一轮生效。已由 D7 钉住。
    · **首见纪律**：**不能**一律「基线＝当前 turnSeq」—— 速查线程从建到跑完只要几秒而轮询 15 秒一轮，第一次看见它时回合早就结束了，那样等于把唯一那条 done 永久吞掉（这正是这个洞的另一半）。故「管家关心的 ＋ 24 小时内动过的 ＋ 回合数 ≤50 的」线程首见即补一条；冷启动（本次装载没有可用游标）与存量老线程仍然只建基线。
    · 游标加 `sources.sessionTurns`（sid → `{turnSeq, stamp}`），**schema 号不变**：老游标缺这段＝每条会话都算首见，由首见纪律兜住。回合在跑时**不记指纹**（记了下一轮就会跳过这个头，等它跑完再也没人看它一眼）。
  - **第 3 步 速查闭环**：13h 的去抖时长改由**队列内容**决定 —— 带 `quick:true` 的 done 行压到 0 秒、其余仍 5 秒，且已排着的慢定时器会被重排（否则一条先到的普通通知把用户正等着的答案一起按住 5 秒）。五个调用点一行未改。既有的「收工在拿到模型回复之后」顺序纪律不动。116-2e 那条「速查 done 行补 answer」的增强本来就挂在 `kind==='done'` 上，第四源的行天然享受到它 —— 之前它建立在一条永远不会来的 done 行上。
  - **第 4 步 唤醒链诚实**：`GET /api/steward/state` 加 `lastInboxAt`（箱子最后一次真的收到东西）与 `sourcesSeen.sessionTurns`（第四源本进程入箱条数）—— 修前只有 `lastTickAt`，一个每 15 秒空转的收件箱和一个真在干活的长得一模一样。`GET /api/sessions/steward?since=<ISO>` 只回该时刻之后的消息（117j W2-4 用它把收件箱触发的回复追加进对话流，不必整份重拉）：只对管家会话生效、不带 `since` 的旧调用逐字节不变（载荷里连 `since` 键都不出现）、解析不了当没给。**路由零新增**。
  - 测试（**只加不改**）：`steward-quick-ask.e2e` (G) 第四源 17 条（冷启动只建基线／速查跑完入箱一条且带 quick+answer／普通会话不入箱／被递话过的会话入箱／幂等／state 三个诚实字段）＋ (H) 闭环 3 条（入箱 → 管家收件箱回合 → `closedAt` 落盘）；`steward-guardrails.e2e` (K) `?since=` 7 条；`missions-readmodel.e2e` (g) 第 0 步回归 6 条；`steward-events.static` D7 第四源登记 14 条。
  - 门：依赖图 **41 模块／316 边／前向边 67 不变／1 SCC**（13i 新增引用 `sessionPath`(01)、`activeChildren`(04) 全是后向边）；路由清册 **127 判定点、ROUTE_AUTH 115 条均不变**（`since` 是既有路由的 query，不是新判定点）；durable-state 清册 steward-cursor 行补第四源字段；`build --check` 新鲜；全量回归 `--parallel 4` **298 pass / 6 fail / 9 flaky / 304 ran / 7 skipped**，6 条失败（plan-mode／interventions-cas／multi-session-parallel／perf／context-compact-v2／steward-inbox 的 (H) 重启段）**逐条单跑全部 ALL PASS** —— 是并行下起服务的时序抖动，不是回归。另注：`--parallel 8` 在本次会话的机器状态下大面积 `ECONNREFUSED`（100 fail，服务起不来而非断言失败），本波结论改为**用 4 路**，覆盖 §11.7 里那条「用 8 路约 9 分钟」。
- **116-5a 线程自动摘要 · 引擎侧（2026-09-07 入库，opus 实现，`e893252`）**：设计页 §11.8 的三条拍板全按建议落地（开关独立默认开、端点回落到线程自己的 provider、加 `titleSource`）。实测又改了三处设计，逐条记在下面。
  - **落点**：新原语住 `06-provider-engine.js`，紧邻 `providerRawCompletion` —— 它就是那个非流式一次性补全原语的第三个消费者（前两个是 playbook 起草与 JSON 修复），连记账口径都照抄（`kind:'aux'` + `note`）。**零新增模块边**。
  - **两个 hook 点，不是六个**：三引擎共用 `runSessionTurn`（10-context-governance），首回合发起前一个、`finally` 里一个。对比既有的自动命名 `isUntitledSessionTitle` —— 它在 05／05b／09 各写了一遍，那是这次刻意避开的前例。
  - **数据形状**：`session.threadBrief = {schema:1, title≤24, gist≤80, at, model, stage}` 与 `session.titleSource:'user'`，都进 02 的元数据白名单并严格归一（`titleSource` 只认 `'user'` 一个字面量 —— 这条通道也接 `PATCH /api/sessions/:id`）。**字数上限在落盘时就夹死**，不是显示时才截：上限将来一调，存量数据仍是按当时上限存的，显示层再截一次只会掩盖这件事。
  - **显示优先级单点**：`sessionDisplayTitle(o)` —— 人给的名字 > 生成的名字 > 原话。两种入参形态都认（会话头的 `threadBrief` / 索引条目的 `brief`），因为 `listSessions` 的快路径会把索引条目再喂一次 `sessionMeta`（116f 的 `rawKind` 就在这里栽过一次）。`sessionMeta` 只在**有** brief 时才多带那两个键，存量会话的 `/api/sessions` 载荷逐字节不变。
  - **实测改动一 · 丢写（最花时间的一条）**：首回合那次的落盘与回合自己的收尾整份 `saveSession` 抢同一个文件 —— 回合手里那份内存副本【不含】 brief，谁后写谁赢，而回合几乎总是后写。`updateSessionMeta` 的活回合延后防护挡不住它（brief 的写可能恰好落在 `turnSettlers` 已清、回合收尾 save 还没落地的那个窗口里）。**症状很隐蔽**：第一版验证脚本靠时序侥幸通过了，正式 e2e 才稳定复现（A1／A7／A9 红而 A5 绿）。修法：收工那一刻先做一次**补写**（`reassertThreadBrief`：用本进程已算出的结果再写一遍，幂等、**不再调模型**），补写没东西可写才走第二次机会；同一条会话还做在途合流（`threadBriefInflight`），否则首回合与收工两条路会各调一次模型（实测 `briefHits=2`）。
  - **实测改动二 · 尝试预算 1+3 而不是 3+3**：原设计「两次机会、各自 2 次退避重试」在端点全挂时是 6 次调用。改成 **首回合 1 发（机会性，端点正常时一发就中）+ 收工 3 发（首发 + 1s/4s 两次退避）**，常见路径 1 次、最坏 4 次。首回合那一发是在回合刚起跑时发的，不该为了一个名字连打三次；退避留给真正的兜底那次（此刻还有助手回复，概括也更准）。
  - **实测改动三 · 「已经有名字就不起名」**：`createSession` 收到一个**非占位**标题（判据复用既有的 `isUntitledSessionTitle`，中英占位集）时就写 `titleSource:'user'`，摘要直接跳过。这既是产品上更对的规则（生成的名字本来就排在人给的名字后面，再花一次调用去起一个永远不显示的名字是纯浪费），也是**全量回归那批红的根因**：默认开之后每一条首轮都多打一发，把各 e2e 假端点的计数、剧本序列与台账行数全打乱了（24 件红 vs 基线 6 件）。收窄之后仍有一批测「回合／工具面／台账」本身的 e2e 会看见那一发，**在夹具里显式关掉**（`stewardThreadBriefV1:false`，25 个文件 30 处 config 字面量，只加一行不改任何断言）—— 它们测的不是摘要，摘要有自己的 `thread-brief.e2e.js`。速查线程那边要**反着来**：它建出来时 title 是问题原话的前 N 个字，那不是「人给的名字」而恰恰是本波要替换的东西，故 `steward_quick_ask` 建完显式 `delete session.titleSource`。
  - **配置分级**：`stewardThreadBriefV1` 登记进 06i 的 **confirm** 档（不是 free）。它开着就会在每一条新线程上花一次钱，而按 §11.8.7 记的是 `aux`、**不进 `stewardMaxCostPerDay`** —— 管家自己把它打开等于给自己开一条不受管家日预算约束的花钱通道，正落在该档「改动会花钱」那条判据上。（同族的 `stewardProviderId`／`stewardModel` 仍是 free：那两个只换管家自己用哪个端点，花的还是管家那份预算。）单测 `unit/steward-config-tier.test.js` 的期望表同步 —— 那道门本来就是为「新增键必须回来做一次分级判断」设的，这次正常报红、正常判定。
  - **红线**：不改写 `session.title`（原话是权威，也是 brief 缺席时的回退与 hover 全文）；不给存量会话补账；不进 `providerHistory`；不新增路由；**摘要的任何环节都不阻塞回合**（整段包 try + 调用方一律 `void`）。限流每进程每分钟 20 条。
  - 测试：新增 `dev-harness/thread-brief.e2e.js`（进程内真回合 + 假 OpenAI 端点按系统提示词口令把「起名字那一发」与真回合分开计数，所以每条断言的调用次数都可判定），A–J 十组 35 条：正常路径只调一次、原话不被改写、`sessionMeta` 带出、显示优先级两种形态、第二回合零调用、用户改名压过生成名、模型吐非 JSON 时 4 次后放弃且**回合照常收工**、开关关零调用零字段、管家会话不起名、端点解析（跟 `stewardModel`／配错了 fail-closed）、aux 台账口径、解析器边界、上限落盘即夹死。
  - 门：依赖图 **41 模块／316 边／前向边 67 不变／1 SCC**；路由清册 **127 判定点、ROUTE_AUTH 115 条均不变**（零新增路由）；durable-state 清册 `session-head` 行补 116-4／116-5 的四个新字段（全部 additive、不动 storageVersion）；`facts.json` 的 e2e 计数随新件重算；`build --check` 新鲜；全量回归 `--parallel 4` **300 pass / 5 fail / 6 flaky / 305 ran / 7 skipped**。5 条失败:`module-dependency-graph.static` 是生成器链没跟上最后一次 src 改动（重跑生成器链后 ALL PASS —— 又一次印证「生成器链必须在最后一次 src 改动之后整条重跑」）；其余 4 条（interventions-cas／mcp-ops-closure／pretender-needs-drawer／steward-board）**逐条单跑全部 ALL PASS**，是并行下起服务的时序抖动。
  - **116-5b（消费面）已于同日入库**，交付记录见上一条。
- **116-5b 线程自动摘要 · 消费面（2026-09-07 入库，opus 实现，`398a2ed`）**：§11.8.5 那张表的五个面全部接上，外加设置页开关、中英文案与一条新静态锁。**零新增路由**（127 判定点 / ROUTE_AUTH 115 条不变）、**前向边 67 不变**。
  - **一条贯穿全片的定则**：**「哪个名字该显示」只允许有一个判据**。它住 02 的 `sessionDisplayTitle`（人起的 > 生成的 > 原话），各读模型只把**算好的结果**带出去，壳层一律 `displayTitle || title` 直读——不是回落判据，只是老载荷的兜底。这与本行早就有的 `stateLabel` / `missionTitle` / `wait.label` 是同一条纪律：这些读模型里本来就装着服务端算好的显示串。反面教材是 112 波摸底那条「服务端发 54 种、前端认 34 种」。
  - **六个装配点**（全部 additive，缺摘要时逐字节不变）：① 13d `buildMissionCard` 加 `displayTitle` + `brief` → 13e 投影 → `GET /api/missions` → 看板行 / 抽屉页签 / 「现在这一件」/ `steward_missions`；② 13d `searchSessionsByContent` 结果加 `briefTitle` / `briefGist`；③ 13d `GET /api/sessions/:id` **信封**加 `displayTitle`（不塞进 `session` —— 那是会话头本身，路由不许改写它的形状，与 116-4 `?since=` 分支同一条纪律）；④ 13g `steward_threads_search` 结果加 `brief`；⑤ 13h 总览行顶层加 `displayTitle`（放顶层不放 `digest` 里的理由与 116-pre 的 `missionId` 相同：`buildStewardDigestLine` 的 lead 段只吃三键）；⑥ 06i `stewardPrerouteHit` 加 `displayTitle`。
  - **打分那一侧一个字没动**（本片最容易做错、也最该写下来的一条）：`prerouteText` 的词法打分吃的是 `row.title`，而 `title` 仍是**原话**。如果图省事把 `title` 直接换成压过的名字，用户当时打的那些词（截图里的「超威半导体」）就从递送索引里消失了 —— 名字是**多**给的一个键，不是替换。单测 ⑪ 用「超威半导体」这个只在原话里出现的词把它钉住。
  - **摘要进检索单元（顺带提召回，不只是显示）**：13b 的 `buildSessionSearchUnit` 把 `brief.title` / `brief.gist` 也收进去。它们常常用了用户原话里没打出来的词（原话「帮我分析一下AMD」/ 概括「拉 AMD 最新行情与新闻」）。索引失效判据不用另加：摘要落盘走 `saveSession`（推 `updatedAt`），而单元指纹就是 `updatedAt|messageCount`。e2e G2 用一个**只在摘要里出现**的词（「字节序标记」）证明它真的进了单元。
  - **前端只有一处算判据，且是既有的那一处**：经典壳 `session-experience.js` 的 `sessionDisplayTitle` —— 它本来就是那一面唯一的显示名判据（「未命名 → 本地化占位」那条规则依赖 `t()`，服务端不认识它），这次只是给它补上前两级优先级。管家壳四个消费点（看板 / 抽屉 / 递送候选 / 递话回执）一律只读服务端算好的值。静态锁 ③ 机械对账：`public/` 下出现 `titleSource` 的文件**有且只有** `session-experience.js`。
  - **原话是权威，也是 hover 全文**：侧栏条目、看板行、抽屉页签、抽屉标题在显示名与原话不同时把原话挂 `title` 属性；相同就不挂（悬浮提示与正文一字不差地重复一遍是噪音）。经典壳侧栏的副行也改成「有 gist 就先说 gist」（它答的是「这条线程要干什么」，比末句摘要更能让人认出是哪条），没有摘要时逐字还是老样子。
  - **设置开关**：`cfgStewardThreadBrief` 放在**「模型与预算」**段而不是「自治」段 —— 它不是一项管家的自治权，是一笔钱。填充判 `!== false`（默认开，缺字段不等于关），文案按 §11.8.6 写明「经典壳的会话列表和搜索结果也用它」（它不随 `stewardEnabledV1`）。设置页那几个组在管家关着时**不隐藏**（只有「去管家壳」按钮 disabled），所以这个开关在管家关着时照样够得着 —— 这一点是本片实测确认过的，不是假设。
  - **本片实现时自己挖出并修掉的两条（都不在派单范围里，但不修就等于这一波白做）**：
    - **① 投影 schema 2 → 3**。卡片的形状变了（加了 `displayTitle`／`brief`），而 13e 只在 `sourceStamp` 变过的会话上重建切片 —— 不升号的话，盘上那些没再动过的会话会一直带着缺这两个键的旧卡片，壳层那句 `displayTitle || title` 于是一直回落到原话，**而摘要明明已经写在会话头上了**。索引是纯派生物（durable-state 清册记的就是 fully regenerable），升号的代价只是升级后第一次读时全量重建一次。清册那一行同步改写。
    - **② 递送预判的缓存键漏了速查线程**（116-pre 遗留）。`stewardPrerouteIndexRows` 拿 `index.revision` 当 memo 键，而 `revision` 只由**有卡片的**会话算出（13e `finalizePretenderIndex` 的 `missionRows` 把 `card === null` 的会话过滤掉了）—— 一条**速查线程**的会话头改了（比如摘要刚落盘），revision 一个字节都不会变，候选列表于是永远显示它的原话。而速查线程恰恰是本波最该起名字的那种（13g 建完显式清 `titleSource` 就是为了让它拿到摘要）。改成 `revision + builtAt`：`builtAt` 只在投影**真的重建过**时才变，连续敲字那段快路径一次没丢；ETag 那一侧完全不受影响 —— 这是 13h 自己的进程内 memo 键，不是 `revision` 的定义。
  - 测试：新增静态锁 `dev-harness/thread-brief.static.e2e.js`（33 条：判据单点、六个装配点齐、`public/` 下判据唯一、红线「摘要块里没有任何给 title 赋值的语句」、开关三件套 + 中英文案、confirm 档）；`thread-brief.e2e.js` 加 (K) 消费面 6 条（**用 `kind:'mission'` 的会话**——投影只给它建卡片，前面几组的 `quick_ask` 会话测不到这一面）；`session-search.e2e.js` 加 (G) 4 条；`unit/steward-preroute.test.js` 加 ⑪ 4 条。三件都是只加不改。
  - 门：依赖图 **41 模块／316 边／前向边 67 不变／1 SCC**；路由清册 **127 判定点、ROUTE_AUTH 115 条均不变**（零新增路由）；`build --check` 新鲜；全量回归 `--parallel 4` **299 pass / 7 fail / 9 flaky / 306 ran / 7 skipped**。
  - **那 7 条里只有 1 条是真的**：`steward-runner.static` 的 ① 「13g 不超过 SPEC 目标 2000 行」—— 本片给 13g 加的两处 `brief` 把它顶到 2004 行。修法是把**本片自己写的那两段注释**折回代码行（不删既有内容、不为了过门去拆别人的模块），13g 现在 1998 行。**这条守卫值得记一笔：13g 已经贴着上限了，下一次往它里面加逻辑就该按 116f 另起 13h 的先例拆文件，而不是再折一次注释。**其余 6 条（`context-compact-v2`／`kimi-agent-cli`／`interventions-cas`／`mcp-ops-closure`／`perf`／`tools-v2`）逐条单跑**全部 exit 0**，是 4 路并行的资源竞争（`interventions-cas`／`mcp-ops-closure` 两条在 116-4／116-5a 的回归里也是同样的表现）。
  - **排错时自己踩的一个坑，记下来免得下次再花时间**：`run-all` 的进度行是**交错**的 —— `[B1] ([fast]) X.e2e.js ... [B2] FAIL exit=1` 里那个 FAIL 属于 **B2 车道刚跑完的那一件**，不是行首那个正在启动的 X。照字面读会得出「X 红了」的错误结论（本片就为此白查了两轮 `steward-tools.static`，它一直是绿的）。**要看谁真的红了，只看结尾那段「失败件 tail」的 `=== 文件名 (exit=1) ===` 标题。**
- **117j 管家壳前端走查修复（2026-09-07 入库，opus 实现，三批：`56e8c6f` / `bcc4a5a` / `81e19b4`）**：派单稿列的 P1／P2／P3 ＋ 经典壳回归四条 ＋ 用户第二轮走查 W2-1～W2-5，除下面明说的两条外全部落地。**零后端改动**（本片一行 `app/src/` 都没动，`server.js` 逐字节不变）。
  - **W2-2 的根因值得单独记一笔，它不是逻辑错**：`.steward-target-picker` 那条 `display:flex` 是作者样式，**压过了 UA 表里的 `[hidden]{display:none}`** —— JS 写的 `picker.hidden = true` 只改了 DOM、没改屏幕。所以候选列表「进壳就自己弹出来」「点 chip 关不掉」，而 `chip.click` 里那个 toggle 从头到尾是对的。本仓已经有四处同款守卫（`.steward-drawer` / `.steward-chip-menu` / `.steward-shield-menu` / `.steward-now`），漏的就是这第五处。静态锁把五处一起看住，防止将来又删掉一处。
  - **W2-3 头像跟着话走（推翻 2026-09-05 §8.x「固定顶部」的拍板）**：搬的是**同一个** `#stewardAvatar` 节点，不复制 SVG —— 117b 那套 presence 渲染（`data-state` ＋ `.pulse/.shake` ＋ aria-live 文字）因此一个字都不用改，它写的还是同一个元素。**唯一的真陷阱**：`clearFeed` 与两处 `removeChild(row)` 必须先把头像送回头部，否则它跟着那一行一起被销毁，之后 `byId('stewardAvatar')` 恒 null、presence 再也画不出来。静态锁按 `parkAvatar()` 的**调用次数**（恰好 3）看住这一条，浏览器 e2e 另有一条「回经典之后头像仍然只有一个、且还活着」。头部补一枚 6px 状态点，与 avatar 读同一处算出来的 `next`。
  - **W2-5／W2-4 的节拍：表按 5s 下限起，真要不要拉由每一拍自己判**。三个管家计时器（avatar 状态／抽屉切片／看板行）统一这条纪律。**为什么不动态换表**：`steward-avatar.static` C2a 与 `steward-drawer.static` C1/C3b 钉死了每个模块只有一处 `setInterval`／一处 `clearInterval`、`start/stop` 的**调用点个数**也是定值 —— 换表要么多一处 `clearInterval`，要么多一个调用点，两者都会撞上既有断言。空闲时的请求数与今天一样（due 门挡住），有回合在跑时反应从 15 秒降到 5 秒；回合结束（live 真→假）当拍把事项行与快照一并重拉。**后端的 `stewardPollMs` 下限一个字没动**。
  - **改了 8 条既有断言（本片唯一一批，逐条列在这里）**：它们全部用 `ms === config.stewardPollMs`(=120000) 当「这是管家的计时器」的身份判据。节拍改了之后那个判据恒为假 —— **留着不动会让它们全部空转通过**，尤其 `G1`/`H1`「切回经典壳后管家侧零残留定时器」会变成永远绿的假门。身份重钉到 5s tick，**计数一个没动**：`steward-drawer.e2e` B15/F2/G1、`steward-board.e2e` B2d/C11/H1、`steward-conversation.e2e` H1、`steward-shell.e2e` D8。另有四条**形状锁**因为源码形状变了而重钉，契约本身逐字未变，且各补了一条把新形状钉住的姐妹断言：`steward-shell.static` C2b（`setInterval` 的两个参数）、C9 与 `steward-settings.static` F3（那两条管家旁路外面多了一层 try/catch）、F4（设置域注入表多了一个键）。
  - **UX-F3/F4 Esc 逐层的设计**：栈住 `steward-chips.js`（零 import 的叶子），四个子域直接 import，不必从组合根一路注入五份回调；`steward-shell.js` 出**那一处** keydown。**抽屉与看板原有的两处 document keydown 保留不动** —— 它们天然是最底层，而栈的监听**注册在它们之前**，同型监听按注册顺序触发，于是「栈顶先关」自然成立（栈里有浮层／菜单就关栈顶并 `stopPropagation`，栈空了才轮到它们）。既拿到逐层语义，又不必去动它们被逐字钉住的形状。栈本身是纯内存的，静态锁直接在 Node 里跑真值表（栈顶先关、注销后下移、返回 `false` 表示「我没开着」、抛错的层不吃掉 Esc）。
  - **两条读屏噪音（copy-P2-2/P2-3）都是同一个成因**：那两块文字都在 `aria-live` 区里（feed 是 `role="log" aria-live="polite"`），而 `textContent` 只要被赋值——哪怕值一模一样——读屏就再念一遍。撤回倒计时每秒改一次，于是「撤回（9）」「撤回（8）」…把真正的新消息全淹掉；presence 则是空闲时每一拍念一次「空闲」。修法各是「数字进 `aria-hidden` 的 span ＋ 按钮 `aria-label` 固定」与「先比再写」。
  - **UX-F6 复核结论：不是 bug。** 派单稿标的是「待复核」。用 `GET /api/interventions` **真实回的那一行**（13d 的 pending 行形状全带上：`id/type/sessionId/missionId/requestedAt/interventionVersion/toolName/tier/revertible/input/deliverable/live`）跑 `quickRepliesFor`，照常给「允许／拒绝」—— 判据读的是 `pending.type` 与 `pending.id`，真实形状上本来就成立。结论钉成一条单测，免得下次又靠读代码推一遍。**copy-P2-7 同样查证为已完成**：圆形发送键与 `aria-label` 117i 就已经在了。
  - **本片没做的两条，理由写在这里**：
    - **copy-P2-1「`quick_ask` 不进五态槽位」**：要做对得先有一个服务端字段。`/api/missions` 的行里 `kind` 对「用户自己的普通对话」与「管家用 `steward_quick_ask` 开的速查线程」**都是 `quick_ask`**（`sessionKind()` 归一的结果），前端分不出来 —— 而 116-3 P1-5 恰恰是为了把这两者分开才在服务端引入 `stewardQuickThread(head)` 的。只按前端能看见的东西改（「没有事项卡片就显示『对话』」）会把管家的速查线程也一起说成「对话」。正确的做法是把那个已经存在的服务端判据在读模型里露出来（一个只加的布尔字段），归下一片。
    - **classic-5「经典壳首屏无条件加载 9 个管家 JS 与 6 个 CSS」**：派单稿本来就写了「治理登记（不在本片做）」，要重钉 `steward-avatar.static` D2 的白名单形态与 `read-frontend-css` 的载荷组，另立切片。
  - 测试：新增 `dev-harness/steward-walkthrough.static.e2e.js`（A–G 七组 73 条）；`steward-conversation.e2e` 加 W2-3 的七条浏览器断言；`unit/steward-quick-replies.test.js` 加 UX-F6 的复核用例。**三件都是只加不改**（上面那 12 条重钉是另一回事，已逐条列明）。手册 §5 补「管家」页签一节。
  - **顺手修的一条与本片无关但挡住验证的夹具问题**：`steward-shell.e2e` 的启动预算是这一族里唯一的 6 秒（其余五件 12 秒），机器一忙 `A1 workbench started` 就随机红；顺带补上 `autoImportClaudeCodeMcp:false`（临时 HOME 的 e2e 不该去读开发机真实的 `~/.claude.json`）。断言没放宽。
  - **两条排错教训，写下来免得下次再花时间**：① `run-all` 的进度行是**交错**的 —— `[B1] X.e2e.js ... [B2] FAIL` 里那个 FAIL 属于 **B2 车道刚跑完的那一件**，不是行首那个正在启动的 X；要看谁真的红了只看结尾「失败件 tail」里的 `=== 文件名 (exit=1) ===`。本片为此白查了两轮 `steward-tools.static`（它一直是绿的）。② **手工单跑浏览器 e2e 会漏 Edge 进程**（`run-all` 每件跑完会调 `lib/browser-cleanup.js` 的 `stopRuyiTestBrowsers` 收尸，手工不会）：攒到 345 个之后工作台冷启动从 4 秒涨到 24～86 秒，一批件以「服务起不来」的形式假红，差点被当成本片改坏了服务端去二分。两条都进了本会话的记忆。
  - **另外定位到一条老 flake 的根因（不是本片引入，已单独登记）**：`steward-drawer.e2e` 的 `E4b`「抽屉给出『已替你回复』的回执」失败率约 1/3（117j 改动前后各跑三次都是 1/3）。打点抓到调用栈：线程 C 那个 `POST /api/chat/stream` 起的回合**问完问题会自己跑完**，收尾时 `clearPendingQuestions(sessionId, 'turn ended')` 把那条 question 以 `ok:false` 结掉；浏览器那边的点击若晚于回合收尾，`POST /api/chat/answer` 就拿到 409 `question.delivery_failed` —— 待决确实没了（E4 绿），但回执是失败的（E4b 红）。修法应是让夹具的假 provider 在提问之后保持回合挂起（那才是真实场景：AskUser 期间回合是阻塞的），不能把断言改宽。
  - 门：**零后端改动** —— `app/src/` 一行未动，依赖图（41 模块／316 边／前向边 67）与路由清册（127 判定点、ROUTE_AUTH 115 条）逐字节不变，`build --check` 新鲜；`app.js` 1277 → **1276 行**（纪律「不增行」，classic-1 那一块换成调用单点反而净减一行）；D51 CSS 载荷 SHA 按既有先例重钉一次（改动只落在管家壳自己的两个所有权层）。
  - 全量回归 `--parallel 4` **304 pass / 3 fail / 9 flaky / 307 ran / 7 skipped**；三条失败（`perf`／`context-compact-v2`／`mcp-ops-closure`）逐条单跑**全部 exit 0**，是 4 路并行的资源竞争（`perf` 那条本来就是「冷启动 < 5000ms」的时间门，实测 5324ms）。
  - **上一轮全量跑出 7 条红，值得记一笔**：3 条是同款资源竞争，4 条是真的、且全部属于「契约没变、源码形状变了」——`route-inventory.json` 漂移（本片的 e2e 改动给 `/api/interventions` 那一行多带了一个消费者，12 件 → 13 件，跑一遍生成器即可）、`steward-avatar.static` D2（壳层 import 白名单 7 → 8）、`pretender-shell.static` W117g-7（判据随 classic-3 放宽）、`steward-guardrails` I2（copy-P1-1 的回落多了一级）。**加上前面那 12 条，本片一共重钉 15 条既有断言**，每一条的理由都写在改动点旁边。
- **117j 收尾 · E4b flake 的真根因（2026-09-07 入库，opus 实现）：一条会【删数据】的产品 bug，不是测试问题**
  - 起点是 `steward-drawer.e2e` 的 `E4b` 约 1/3 概率红。**我上一版给出的根因是错的**（当时写「回合问完问题会自己跑完、收尾把待决结掉」）—— 那一版打点记的是 `clearPendingQuestions` 的**每一次调用**，不是「真的清掉了一条」，据此下的结论不成立。重新打点后事实完全相反：答案到达时 `pendingQuestions.has(qid)` **仍为 true**，待决好端端在那儿。
  - **实际链条**（逐层打点抓出来的，每一步都有实证）：
    1. `POST /api/chat/answer` 拿到的是 `decideIntervention` 的 **404 `intervention.not_found`**，而不是「待决没了」；
    2. 404 出在第一道门：`readFile(sessionPath(missionId))` 抛 **ENOENT** —— 会话头文件在那一瞬**不存在**；
    3. 为什么不存在：`loadSession` 把它**隔离**成了 `.corrupt`。打点原文：`TRUNCATE id=… file=…messages.ndjson from=1 to=0` 紧跟着 `QUARANTINE id=… headMsg=1 body=0`。
  - **真正的 bug 在 `loadSession`**：它的两个动作是**破坏性**的 —— 截断「未提交尾巴」、把头与正文一起隔离成 `.corrupt`；而判据「头声明的行数 vs 正文实际行数」建立在**先后两次读**上（先读头、再读两个正文）。`saveSession` 的写链里**正文先落、头后落**，一次并发的 `loadSession` 正好落在中间，就会拿【旧头】去量【新正文】：多出来的那一行被当成崩溃残留**物理截断**（`from=1 to=0`），下一次 load 再看到「头说 1、正文 0」，**整条会话被隔离，会话消失**。真机上同样成立：谁恰好在回合写盘的那一瞬触发一次 `loadSession`（打开会话、改元数据、投影重建都会），谁就中招。
  - **修法两道守卫**（都在 `02-session-store.js`）：
    - **① 写链在跑就别动手**（真正起作用的那一道）：破坏性动作之前先看 `sessionWriteChains.get(id)` —— 链在跑说明「正文已落、头未落」是**预期内的中间态**，不是崩溃残留；`await` 它跑完再重跑一次 load（有界一次），一个字都不用删。
    - **② 动手前把头再读一遍**：头的 `updatedAt` ＋ 两个计数当指纹，变了就重来。**单靠这一道不够** —— 实测仍会 TRUNCATE+QUARANTINE，因为写链里头还没落，重读拿到的仍是那份旧头。这一条留着是为了覆盖「写者不在本进程写链里」的情形。
    - 顺带把 `decideIntervention` 的头读换成新加的 `readSessionHeadResilient`（对 ENOENT/EPERM/EBUSY/EACCES 有界退避重试，解析失败**不**重试——那归隔离路径管）。它是用户动作的判定入口：读空一次就等于把「允许／回答」当场判成 404「会话不存在」。
  - **验证**：带打点连跑 —— 修前 `TRUNCATE`/`QUARANTINE` 必现（一次跑里三条会话全中招），修后 5 连跑**一次都没有**；`steward-drawer.e2e` 连跑 5 次全绿（此前 1/3 红）。
  - **测试的诚实说明**：新增 `dev-harness/unit/session-head-read.test.js`。其中那条「并发 save 期间读同一条会话」**不是那条竞态的可靠复现** —— 实测把守卫①关掉它照样绿（要精确卡进 `saveSession` 内部「正文已落、头未落」那一格，从外部 API 命不中）。它断言的是不变量本身，有价值但没牙；真正防回改的是同文件里那四条**源码锁**（两道守卫的形状 + `decideIntervention` 不再直读 + 重试只认瞬时错误）。
  - **上一版那条错误结论已作废**：不需要改夹具的假 provider（回合本来就挂着等答案），也不需要在点击前查 `live`。派单稿给的两条修法方向都不对症 —— 因为它们建立在同一个错误根因上。

- **117k 管家壳真机端到端走查（2026-09-07，用户「你先端到端验证一下」）**：起真工作台（真 `server.js` ＋ 真前端 ＋ 确定性假模型 ＋ 一个显式事项两条线程、一条挂待决、两条无名等自动摘要起名），从出厂默认（管家关、`uiMode=simple`）一路走到底。**查出七条，全部已修**；下面每条都写「怎么看见的 → 根因 → 修法 → 怎么验的」。
  - **① 简易模式下「管家」设置页签是死键（最严重：第一次开管家无路可走）**。出厂默认 `uiMode: 'simple'`（`01-config.js` 的 DEFAULTS），而 `navigation-controls.js` 的 `SETTINGS_SIMPLE_TABS` 白名单只有 `basic/providers/network/doctor`；`ui-modes.css` 只隐藏 `claude/agents/integrations/mcp/advanced`。两张表**不互补**，于是 `steward` 与 `update` 两枚按钮**看得见、点了静默落回「基础」**。而管家总开关（`cfgStewardEnabled`）只住在管家页 —— 基础页那个「管家（预览）」是灰的，配一句「要用管家壳，先在设置里打开管家」，指向一个到不了的地方（唯一能开那一页的是管家壳自己的头像菜单，`app.js:1003` 传了 `force:true`，可你得先把管家打开才进得去）。附带：「自动给每条线程起名字」默认开且**不随** `stewardEnabledV1`，它的开关也在这一页 —— 一个默认开、要花钱的功能，默认模式的用户关不掉。**修**：白名单补 `steward` 与 `update`。**锁**：`steward-walkthrough.static` H1/H1b/H1c —— 直接从 `index.html` 抓所有 `data-stab`，要求每一枚**要么在白名单里、要么被 CSS 藏起来**（新增页签时忘了改白名单，这条会红）。
  - **② 进壳后底部长期挂着一句假话**：「管家还没打开，已回到经典布局；在设置里打开管家后可以再选。」开机 `config` 到达前 fail-closed 写进 `#stewardStatus`（`recoverStewardShell`），而 `setStatusText` **只写不清** —— 管家开着、壳已经是管家壳，实测 12 秒后那句话还在，且它是 `role="status" aria-live`，读屏也会念。**修**：`syncStewardShellAvailability` 的准入通过分支加 `clearStatusText()`。**锁**：H2。
  - **③ 递送 chip 与递话回执用整句原话**。服务端 preroute 命中里 `displayTitle` 是有的（116-5b 加在 06i），候选列表与回忆池也早就在用，只有**自动选中的那个目标**（`steward-composer.js` 的 `routeHits[0]`）还取 `title`。屏幕上：chip 变成「→ 把华南那张报表和另外三个区的汇总一下」把输入框挤成一条缝，回执写「递给了『前端框架你帮我挑一个吧 ASKME』。」——而同屏的候选列表与抽屉标题写的是「华南报表对账」「选前端框架」。**修**：`displayTitle || title`。**锁**：H3。**实测**：修后 chip = 「→ 华南报表对账」。
  - **④ 抽屉的事项行显示线程原话标题**。`renderMission()` 的回落注释还停在「容器标题不在 `GET /api/missions` 的行里」的旧世界 —— 116-5b 已经把 `missionTitle`（显式容器＝用户起的名，派生事项＝那条线程的显示名）加进每一行。于是同一块面板上三个名字指同一件事，最上面那个恰好是 116-5b 要换掉的那个。**修**：`root.missionTitle || root.displayTitle || root.title`。**锁**：H4；`steward-drawer.e2e` 的 B6 **重钉**（此前钉的是「回落到本线程标题」，那是 116-5b 之前的契约）并加 B6b companion：同一帧里线程头仍是线程自己的名字。
  - **⑤ 抽屉打开的第一帧是三句假话**：标题回落成**内部 id**（`sess_f4cd853a7be7b61e`）、事项行说「未归事项」、「它刚说」说「它还没说过话。」——`openThread` 先 `renderAll()` 再 `await refreshOnce()`，那一帧手里什么都没有。实测本机约 200ms，每次开抽屉都有。**修**：加一道 `loading` 闸，读到之前一律说「读取中…」（新键 `stewardShell.drawer.loading`，四份 locale）。**锁**：H5/H5b/H5c。
  - **⑥ 答完待决，「等你(1 条待决)」还挂在屏幕上**。`runQuickReply` 当场那一发 `refreshOnce()` 常常还读到旧值（服务端要等回合真的接住答案才清待决）。**修**：把节拍闸清零（`lastPollAt = 0`），让**已经在跑**的那张表下一拍真去拉一次 —— **不加新计时器**（`steward-drawer.static` C2 的契约是抽屉零 `setTimeout`；第一版正是撞在这条上）。**锁**：H6。
  - **⑦（用户当场追加）所有菜单／浮层，点界面别的地方要自动收回**。修前只有递送候选列表有这条（117j W2-2 加的 document 监听），chip 菜单／※ 浮层／头像菜单／盾牌菜单都没有。**修**：`stewardEscapeStack.push(close, owns)` 加第二个参数 `owns(node)`＝「这次点击落在我自己身上吗」，新增 `handleOutsideClick(node)` 从栈顶往下把「不属于我」的层都关掉；`steward-shell.js` 那**一处** document `click`（**捕获阶段**，理由与 W2-2 同：同一次点击里另一颗键可能正要打开一个菜单）统一派发。判据抛错一律当【点在里面】—— 一个坏掉的判据可以让菜单关不掉，但绝不能让它把用户正在点的菜单关掉。五处浮层各自给 `owns`。**锁**：H7/H7b/H7c。**实测**：五处逐一「开 → 点别处 → 关」，且点菜单项本身仍正常生效（盾牌切「改文件不问」当场落盘）。
  - **⑧ 走查途中撞出来的一条数据丢失（与管家无关，但更严重）**：`config` 还没到达时打开设置弹窗 → 点保存 → **用户的整份 Provider 连同 API 密钥被写成 `[]`**，`activeProvider` 清空，引擎退回 Claude Code。这是 2026-09-06 那起事故**没补完的另一半**：`fillSettings` 的守卫只问「播种过没有」，没问「播种的是不是真的 config」—— 弹窗开着时 `fillSettings` 拿着空 `state.config` 跑一次，草稿播成 `[]` 并被标成**已播种**；config 随后到了，可「弹窗开着」分支跳过重播，草稿就一直空着。**证据**：本次走查的临时 HOME 里有服务端保险留下的 `config.json.bak-providers-2026-09-07T09-31-41-251Z`（里面 provider 完好）与审计事件 `config_providers_cleared`；随后**真机复现**：页面加载后 2ms 打开设置 → 5s 后 config 到齐、草稿仍是 `[]` → 一次保存清空。**修**：`state.providersDraftSeeded = Array.isArray(c.providers)` —— 没真拿到 config 就不声称播过种（`saveSettings` 因此省略该键，服务端 `{...current, ...body}` 保留现值），下一次 `fillSettings` 还会补播。**锁**：`config-providers-guard.e2e` D2/D2b/D2c（D2 重钉：旧断言钉的是「两处都无条件标 true」，那正是这个洞）。**修后实测**：同样的时序，草稿在 config 到达后被补播成 `['fake']`，保存后 provider 完好。
  - **另外两条查了但不是 bug，如实记下**：`/api/sessions/steward` 的 404 只有**一发**（第一次进壳、管家会话还没落盘），不是我一开始以为的「刷控制台」；抽屉的「事项内只列出有卡片的线程」是投影口径（`GET /api/missions` 只返回 `kind==="mission"` 的会话），不是抽屉丢了兄弟线程。
  - **头像菜单那条单独先修的**（用户走查原话：「每次切管家，会冒出那个有设置的二级窗口」）：`.steward-menu` 那条 `display:flex` 是作者样式，压过 UA 表的 `[hidden]{display:none}` —— 菜单建出来就 `menu.hidden = true`，可它一直画在屏幕上盖住问候语与头像，Esc 与点菜单项都「关不掉」（只改了 DOM）。这是本仓同款守卫的**第六处**（前五处：drawer / chip-menu / shield-menu / now / target-picker）。顺带修位置：它只有 `position:absolute` 没有 `top/left`，用的是静态位置，实测落在 **y = −20px**，首项「细节」被窗口上沿切掉、点不着 —— 给 `.steward-header` 加 `position:relative` 作锚，改为贴顶栏下沿展开。提交 `8096ad5`，静态锁 B1b 第六处 ＋ CSS 载荷 SHA 重钉。
### 11.7 停点与待派清单（2026-09-06 夜，用户额度将尽，明日续；Fable 写）

**2026-09-07 下午追加**：用户第四轮走查（七条 + 一条桌面崩溃）立项 **117l**，设计页与派单见 §11.9（Fable 设计与验收，Opus／Sonnet 实现）。

**现状（2026-09-07 续）**：116-4 已入库（引擎侧收件箱第四源 `sessionTurns` ＋ 速查闭环 ＋ 唤醒链诚实字段 ＋ `?since=`，外加复现时挖出的 P0「管家开过线程就把整份投影打崩」；交付记录见 §11.6）。116-5 的设计页见 §11.8（三条拍板已定），**116-5a 引擎侧与 116-5b 消费面均已入库**（交付记录见 §11.6）。**117j 也已入库**（三批，交付记录见 §11.6）。管家线（115→116→117）到此收口；剩下两条明确挂起：**copy-P2-1**（要先在读模型里露出「这条是不是管家开的速查线程」，116-3 P1-5 的服务端判据已有）与 **classic-5**（经典壳首屏动态 `import()` 九个管家 JS，派单稿本来就写了「不在本片做」）。

**现状**：116-3（后端对抗修复）三批全部入库——`e520428`（P0 六条＋A2＋B1）、`013d274`（P1 九条＋数据安全两条＋※ 脚注人话）、`2b334b9`（P2 四条＋A4），交付记录见 §11.6；`server.js` 已 cp 进 `dist/Ruyi-full/app/`，**桌面端重启后服务端守卫才生效**。全量回归提速已有结论：本机 24 核用 `--parallel 8`，约 9 分钟、失败谱与 4 路一致。

**用户第二轮走查（2026-09-06 晚，两张截图）五条定案**：① 管家开了线程不直接展示（前端 W2-1）；② 候选列表关不掉（前端 W2-2）；③ 头像应跟着话走、在管家的话前面（前端 W2-3，**推翻 2026-09-05 §8.x「固定顶部」拍板**）；④ 抽屉里线程跑完显示不及时（前端 W2-5）；⑤ **线程跑完管家没被唤醒——引擎侧真缺口**（116-4）：收件箱三源＝事项账本／班组 run 事件／待决投影，速查线程与 `steward_thread_new` 开的普通会话跑完不产生任何入箱事件；用户机器证据：`<data>/steward/` 只有游标且各会话 missionChanges 全 0、`inbox-v1.ndjson` 从未写过、管家会话只有两次用户触发回合、速查 `sess_06466e02a6d0f5e8` 的 `stewardQuick.closedAt` 仍为 null。116-2e 的「速查 done 行补 answer」建立在永远不会来的 done 行上。

**⚠️ 116-5 的设计页在 §11.8**（2026-09-07 出稿）。它逐条核过下面这段需求稿，列出四处修正：「班组子线程」不是会话（全仓只有三个 `createSession` 来源，班组跑在父会话里）、三引擎共用 `runSessionTurn` 一个 hook 点（不必在 05／05b／09 各钉一遍）、`session.brief` 已被 `steward_thread_new` 的委托书占用（定案改叫 `session.threadBrief`）、会话头是扁平的没有 `meta` 这一层。**开工前需要用户拍板三条**，见 §11.8.10。另：`launchedBy` 与 `stewardLastTurn` 已由 116-4 占用并进了 02 的元数据白名单，116-5 加字段按同一条纪律（严格归一 + 只认白名单值）。下面这段需求稿原样保留备查。

**用户第三条新需求（2026-09-06 夜，截图：搜索结果整段是用户原话「帮我分析一下AMD——按美股超威半导体…」）→ 116-5 线程自动摘要**：每开一个线程（任何来源：经典壳新会话、管家 `steward_thread_new`／`steward_quick_ask`／递话新开、事项内线程、班组子线程）在第一条用户消息落盘后**自动调一次 LLM**生成两样东西写进会话头 `meta.brief = {title ≤ 24 字, gist ≤ 80 字, at, model}`：`title` 是任务的名（「AMD 收盘分析」），`gist` 是一句人话概括（「拉 AMD 最新行情与新闻，给博物影业格式的结论」）。用途：线程搜索结果（`steward_thread_search`／`06h` 检索、经典壳会话列表搜索）显示 title＋gist 而不是原话整段；抽屉／看板／递送 chip 候选／「现在这一件」标题全部改用 `brief.title`，原话保留在 `meta.title`（不改写，作为回退与 hover 全文）。实现要点（派 Opus，先设计再派）：走管家端点（`stewardProviderId`，OpenAI 兼容）而非主引擎，避免占用 Kimi CLI 与工具循环；单次 1 短提示词、`max_tokens` ≤ 120、失败静默留空并 2 次退避重试后放弃（不阻塞回合）；在回合收工时若 `brief` 仍空再补一次（此时有助手回复，概括更准）；线程改名（用户手改 `meta.title`）后不再覆盖 `brief.title`；配置键 `stewardThreadBriefV1`（默认开、随 `stewardEnabledV1`）；清册 durable-state 加 `session.meta.brief` 行；e2e：假 OpenAI 端点回固定 JSON → 新会话首轮后 `brief` 落盘、搜索结果用 brief、失败不阻塞。与 117i 已做的「文案层截 24 字」并存（brief 缺席时仍截原话）。

**派单顺序**：116-3 已收口（2026-09-07，三 commit 全入库）→ ~~116-4~~ **已收口（2026-09-07，见 §11.6）** → ~~116-5a~~ **已收口（2026-09-07，见 §11.6）** → ~~116-5b~~ **已收口（2026-09-07，见 §11.6）** → ~~117j~~ **已收口（2026-09-07，三批全入库，见 §11.6）**。**派单清单到此走完**；下面的派单稿全文保留备查，实现与它的出入逐条记在 §11.6 的交付记录里（其中 copy-P2-1 与 classic-5 两条明确挂起，理由同样记在那里）。

#### 116-4 派单稿（引擎侧收件箱第四源与唤醒链）—— **已完成，保留原稿备查；实测与它有三处出入，最终实现以 §11.6 交付记录为准**
> ① 会话头上**没有** `lastError`／`resumable.dangling`（实测：一条 HTTP 500 的回合，头上只有 `summary` 里那句人话，那是渲染不是信号）→ 改为先由 13g 在回合 settle 之后落 `stewardLastTurn` 这本账，第四源再读它；
> ② 会话索引 `sessions/index.json` 的条目里**没有** `turnSeq`／`activeTurn`（`sessionMeta` 只带 7 个侧栏字段）→ 改为拿投影行免费给的 `sourceStamp` 当「文件动没动」的指纹，只对动过的会话读一次会话头；
> ③ 「首见基线＝当前 turnSeq（不补账历史）」会把速查线程唯一那条 done 永久吞掉（它从建到跑完只要几秒，轮询 15 秒一轮，首见时回合早结束了）→ 改为「管家关心的＋24 小时内动过的＋回合数 ≤50 的」首见即补一条，冷启动仍只建基线。
##### 修法
1. **第四源 sessionTurns**（13i）：对 `sessions/index.json` 里每条**非管家**会话，用 `turnSeq`＋`updatedAt`＋`activeTurn`（activeChildren）做游标 `cursor.sources.sessionTurns[sid] = {turnSeq, settledAt}`；当某会话 `turnSeq` 比游标大且当前无活回合 → 入箱一条 `done`（payload：`turnSeq`、`lastAssistantText`≤200、`quick:true/answer`（有 `stewardQuick` 时）、`launchedBy:'steward'|'user'`），回合以错误结束（会话头 `lastError`／`resumable.dangling`）→ `failed`。只对「管家关心的会话」入箱以免噪音：`stewardQuick`、`requestMeta.tool` 为 steward_thread_*（记在会话头 `launchedBy`，13g `stewardLaunchTurn` 顺手写）、或事项内线程；**用户自己在经典壳里聊的普通会话不入箱**（除非它被递话过）。首见基线＝当前 turnSeq（不补账历史）。
2. **速查闭环**：done 行带 `quick:true`＋`answer` 时 13h 立即（不等 5s 合并窗口）起一次 inbox 回合，提示词包让管家用自己的话转述答案；回合结束写 `stewardQuick.closedAt`（既有逻辑）。用户在 2.0 视窗继续对话 → 清 `closedAt`（116-3 P1-6）。
3. **唤醒链诚实**：`GET /api/steward/state` 增 `lastInboxAt`／`inboxSeq`／`sourcesSeen`（sessionTurns 计数）供前端判断收件箱活着；`GET /api/sessions/steward?since=<ISO>` 只回该时刻之后的消息（13d 只加 query 处理，旧调用零变化），前端 117j W2-4 用它追加收件箱触发的回复。
4. **清册**：cursor 文件字段新增不改 schema 号（向后兼容：缺字段＝首见）；durable-state 行文案补一句。
5. **测试**：`steward-inbox.e2e` 只加（速查线程跑完 → 一轮 tick 后箱里有 `done{quick:true, answer}` → 管家 inbox 回合 → 管家会话多一条 `trigger:'inbox'` 助手消息 → `closedAt` 已写；普通经典壳会话跑完不入箱；被递话过的普通会话跑完入箱一条）；`steward-quick-ask.e2e` 只加闭环断言；`steward-events.static` 登记第四源。
6. 纪律同 116-3：先复现（用 dist 副本＋临时 HOME 跑一条真速查），断言只加不改，前向边 67，路由零新增（`since` 是既有路由的 query），跑完全量自己 commit 回传数字，cp server.js 进 dist。

#### 117j 派单稿（管家壳前端走查修复，含 W2-1～W2-5）
输入：review-steward-ux.md（F1–F6）、review-copy-a11y.md（P1-1、P2-1～P2-7、P3-1～P3-4）、review-classic-regressions.md（待回）。
纪律：断言只加不改；零 innerHTML；app.js 不增行；每条修完有静态锁或浏览器 e2e 断言。

##### P1
- UX-F1 总开关关掉时若当前在管家壳：立即 `recoverStewardShell()` 回经典（persist 真值），状态行不得说「已回到经典」却仍显示管家壳；settings 的开关 handler 与 `syncStewardShellAvailability` 同一节拍。
- UX-F2 引擎问题文案不写死：`showEngineProblem` 用后端 `info.message`（有则原文）＋按 `info.params.engine`/`stewardProviderId` 是否存在分两种人话：「主端点是命令行引擎」vs「管家端点『X』不在 Provider 列表里」；按钮按情形给（改用第一个可用 Provider／去设置）。i18n 两键。
- copy-P1-1 ※ 里的 `actionWhyLines` 用工具人话表（与 13h `STEWARD_TOOL_LABELS` 同表，前端 i18n `stewardShell.tools.<name>`），不再出现 `steward_thread_continue` 之类 id。
- UX-F5 `receiptFor()`：open_thread 回执用 `stewardShortTitle(act.sessionTitle||…)` 而不是按钮全文，杜绝「打开了「打开「X」」」。

##### P2
- UX-F3 Esc 逐层：抽屉／看板／浮层／菜单统一走一个栈式 `stewardEscapeStack`（steward-shell.js 一处 keydown 监听，栈顶先关），各模块只注册/注销自己的关闭器；去掉各自的 document keydown。
- UX-F4 ※ 浮层 Esc：监听挂在触发按钮与浮层的共同祖先（或走上面的栈）。
- copy-P2-2 撤回倒计时不在 aria-live 区刷屏：倒计时数字放在 `aria-hidden` 的 span，按钮 `aria-label` 固定「撤回」。
- copy-P2-3 presence 文案未变不重写 `#stewardPresenceText`。
- copy-P2-4/5 chips 菜单、盾牌菜单、头像菜单加 Esc 与 `aria-controls`/焦点返回。
- copy-P2-7 输入区加可聚焦的发送键（117i 原型本就有圆形发送键，若已加则只补 aria-label）。
- copy-P2-1 `quick_ask` 不进五态槽位：抽屉/看板对普通会话显示「对话」而非五态。
- UX-F6 待复核：抽屉挂 permission 待决时「你可以说」应给「允许/拒绝」——按真实 `GET /api/interventions` 形状写 e2e 复核，若确为 bug 则修 `quickRepliesFor` 的 pending 判读。

##### P3
- copy-P3-1 `others.join('、')` 分隔符走 i18n。
- copy-P3-3 引擎问题两个按钮：主动作（改用端点）用 `STEWARD_PRIMARY_CLASS`（仍只一处字面量，用常量）。
- copy-P3-4 抽屉页签方向键。

##### 来自经典壳回归审查（review-classic-regressions.md）
- P1 classic-1 顶栏权限 chip（app.js ~1027-1036，专家模式）切 `auto` 无二次确认：复用 `steward-chips.js` 导出的确认文案与流程（同 §8.6），确认后再 `saveConfigPartial({permissionMode:'auto'})`；服务端不设门是 117e 有意决定（steward-settings.js 第 28 行注释），不改后端。
- P1 classic-2 `fillSettings()` 里 `syncStewardShellAvailability()`／`fillStewardSettings()` 各自 try/catch 包住并 console.warn，任何抛错不得阻断其后的草稿播种与 `renderProviders()`；静态锁一条。
- P2 classic-3 返回带残留：`steward-classic-window.js` 在离开经典壳的任何路径（切到 preview、整体切壳、刷新非从管家进入）都清 `sessionStorage['wcw.stewardReturn']` 并隐藏 `#stewardReturnBand`；只有 `openClassicWindow` 才置标。
- P3 classic-4 进管家壳必打 `GET /api/sessions/steward` 404（管家会话尚未落盘）：前端在 `visit.newVisit===true` 或 visit 返回无历史标记时不再请求；若后端 visit 结果里能带 `hasSession`（13h 一行只加字段）则用它。
- 治理登记（不在本片做）classic-5 经典壳首屏无条件加载 9 个管家 JS 与 6 个 CSS：改为进入管家模式时动态 `import()`，需重钉 `steward-avatar.static` D2 白名单形态与 `read-frontend-css` 载荷组，另立切片。

##### 追加（会话/权限口径子审查）
- （B1 的四处前端 `confirm:true` 由 116-3 一并落地，117j 不碰那四行；117j 只负责确认弹窗与文案统一复用 `steward-chips.js` 导出——classic-1。）
- P1 B2 权限口径同步：`setDefaultPermission` 写完补调 `renderPermChip()`；预览壳 30s 轮询顺带刷新 `state.config.permissionMode`（或独立轻端点）；删除过期注释「A8 background refreshStatus on a timer」。
- P2 classic-6（设置子审查发现 5）帮助手册 `scrollToNode` 定位不稳定（同锚点三次三种落点，`help-viewer.js:198-230` 与弹窗布局时序竞态）——单独排查，不在本片。
- P3 手册 `docs/manuals/USER-GUIDE_CN.md` §5 补「管家」页签说明。

##### 用户第二轮走查（2026-09-06 晚，截图两张）— 前端部分，Fable 拍板
- P1 W2-1 **管家开了线程就直接展示**：`steward_reply.actions[]` 里 executed 的 `steward_thread_new`／`steward_quick_ask`／`steward_thread_continue`（`result.sessionId`）→ 回合结束即派发 `steward:focus-thread`（宽屏「现在这一件」立刻切到它；窄屏打开抽屉），不用用户再说「帮我打开」也不用再点按钮；管家的话后仍可保留「打开」按钮但默认已展示。
- P1 W2-2 **候选列表开合**：点递送 chip 再点一次必须收起（现有 toggle 在 `chip.click`，但实测关不掉——复现并修，怀疑是 `conversation.setPickTargetHandler`／`openPicker` 在 focus/click 链路里被二次触发）；点列表外任意处、Esc、发送后都关；列表条目按标题去重（同标题多会话合并显示最近一条）；不得在进壳时自动弹出。
- P1 W2-3 **头像跟着话走（用户改口，推翻 2026-09-05「固定顶部」）**：默认 follow 模式——头部只留名字＋状态行（带 6px 状态点）与右侧两枚图标键；`#stewardAvatar` 节点（同一 SVG、同一 presence 状态）移到**最新一条管家的话**左侧的 `.steward-avslot`（36px），思考占位「···」出现时先移到占位旁；历史管家消息左侧留一个 36px 的静态小圆点（不复制 SVG，`::before` 圆点即可）；390px 下同。`steward-avatar.static` 只加断言（follow 模式源码锚、头部无 SVG 时状态点仍在）。设置项不做开关（用户已拍板）。
- P1 W2-4 **收件箱触发的回复要实时进对话流**：117b 的 15s 轮询已拿 `GET /api/steward/state.lastReply.at`；变化且 `trigger==='inbox'` 时拉 `GET /api/sessions/steward`（或 116-4 新加的 `?since=`）把新回合追加到 feed（去重按 `at`）；管家壳可见时轮询降到 5s（`stewardPollMs` 下限仍由后端定，前端取 min(配置, 5000)？——不改后端下限，前端只在壳可见且有在跑线程时用 5s）。
- P1 W2-5 **抽屉／现在这一件刷新不及时**：有在跑线程（`activeTurn`）时抽屉轮询 5s，回合结束（`activeTurn` 由真变假）当轮立即重拉 `GET /api/sessions/<id>` 与 missions 行；「三问」对普通会话至少显示「已收工 · 用时 X」而不是三个「暂无」。

### 11.8 116-5 设计页 · 线程自动摘要（`threadBrief`）

> 2026-09-07 出稿。派单前先摸底，四处与 §11.7 需求稿不符，逐条在下面标了「**修正**」。
> 决定项集中在 §11.8.10，**开工前需要用户拍板的只有三条**。

#### 11.8.1 一句话与用户证据
每条线程在第一条用户消息之后自动生成**一个名字（≤24 字）与一句人话概括（≤80 字）**，让线程搜索结果、抽屉、看板、递送候选、「现在这一件」不再拿用户原话整段去充标题。
用户证据（2026-09-06 夜截图）：线程搜索结果里整条是原话「帮我分析一下AMD——按美股超威半导体…」，一屏放不下三条，看不出哪条是哪件事。

#### 11.8.2 摸底结论（实测，不是推测）
1. **「班组子线程」不存在 —— 修正**。全仓 `createSession(` 的调用面只有四处：02（定义）、13d 的 `POST /api/sessions`（经典壳新会话）、13g 的 `steward_thread_new`／`steward_quick_ask`、10 的 `runSessionTurn` 兜底新建。班组（agent run）**跑在父会话里**，不建会话。所以需求稿里的「任何来源」实际只有**三个真实来源**，「事项内线程」只是一条 `missionId !== sessionId` 的普通会话，不是第四种建法。
2. **只有一个 hook 点，不是三个 —— 修正**。三引擎（Provider／Claude CLI／Kimi CLI）共用 `runSessionTurn`（10-context-governance.js:2188）这一个入口，引擎分叉在它内部的 `runTurn`。故生成时机与补写时机各只需要**一处**代码，不必在 05／05b／09 各钉一遍（对比：自动命名 `isUntitledSessionTitle` 就是在三处各写了一遍，那是要避开的前例）。
3. **一次性补全调用已有现成原语**：`providerRawCompletion(provider, history)`（06-provider-engine.js:983）—— 非流式、identity-only 系统层、60s 超时、返回 `{ok, content, usage, model}`。playbook 起草与 JSON 修复都用它，并按 `kind:'aux'` + `note:` 记进用量台账。116-5 复用它，不新写 HTTP。
4. **`session.brief` 已被占用 —— 修正**。`steward_thread_new` 把「委托书」写在 `session.brief = {schema, by:'steward', userText, supplement, truncated, memoryIds, playbookId}`（13g:985）。需求稿的 `meta.brief` 与它正面撞车。
5. **会话头是扁平的，没有 `meta` 这一层**。需求稿写的 `meta.brief`／`meta.title` 实际就是 `session.brief`／`session.title`。
6. **显示层拿不到「这个标题是不是用户自己起的」**。`session.title` 既可能是自动派生（首条消息前 60 字），也可能是用户手改或 `steward_thread_rename` 改的，两者在会话头上长得一模一样。需求稿「线程改名后不再覆盖 `brief.title`」在当前数据形状下**无法实现**（解法见 §11.8.3 的 `titleSource`）。

#### 11.8.3 数据形状与命名（定案）
会话头新增**两个**字段，都进 02 `applySessionMetaPatch` 的白名单并严格归一（与 `stewardQuick`／116-4 的 `stewardLastTurn` 同纪律 —— 这条通道也接 `PATCH /api/sessions/:id`）：

```
session.threadBrief = {          // ← 不叫 brief:那个名字是「委托书」
  schema: 1,
  title: '',                     // ≤24 字,任务的名,例:「AMD 收盘分析」
  gist:  '',                     // ≤80 字,一句人话,例:「拉 AMD 最新行情与新闻,给博物影业格式的结论」
  at:    '',                     // ISO
  model: '',                     // 实际用的模型(事后对账「这条摘要是谁写的」)
  stage: 'first_turn'|'settled', // 首回合发起的那次 / 收工补写的那次
}
session.titleSource = 'user'     // 只认这一个字面量;由「用户手改标题」与 steward_thread_rename 写
```

**显示优先级（唯一判据，服务端一处装配）**：`titleSource === 'user'` → 用 `session.title`；否则 `threadBrief.title || session.title`。原话**永远**留在 `session.title` 不被改写（回退 + hover 全文），与 117i 已做的「文案层截 24 字」并存 —— brief 缺席时仍走截断。

#### 11.8.4 何时调、调谁
- **触发**：`runSessionTurn` 里，`session.turnSeq === 0`（首回合）且 `threadBrief` 缺席时，在把回合交给引擎**之前** fire-and-forget 一次（此刻 `body.message` 就在手上，不必等消息落盘；brief 描述的是**任务**不是答案）。回合与摘要并行跑，摘要通常 1–2 秒回来，真回合可能要一分钟。
- **补写**：`runSessionTurn` 的 `finally` 里，若 `threadBrief` 仍空则再来一次，这次带上助手回复首 400 字（`stage:'settled'`，概括更准）。**最多两次机会**，之后这条线程永远不再试。
- **端点（修正）**：`stewardProviderId` 优先 → 未设时**回落到这条线程自己的 OpenAI 兼容 provider** → 两者都不可用（主引擎是 CLI 且没配管家端点）则**不生成**，静默。
  需求稿写「走管家端点而非主引擎，避免占用 Kimi CLI 与工具循环」——要避开的是 **CLI 进程与工具循环**，不是「同一个 provider」；一次独立的非流式 HTTP 调用不占 CLI。不回落的话，Kimi CLI 用户只要没单独配管家端点就永远没有 brief，而消费面一半在经典壳。
- **提示词**：一条 system（「你给对话线程起名字。只输出一个 JSON 对象，不要解释、不要代码围栏」）+ 一条 user（原话 ≤1200 字，`stage:'settled'` 时再附助手回复 ≤400 字）。`max_tokens: 120`，语言跟 `config.locale`。要求输出 `{"title":"…","gist":"…"}`；解析失败按失败处理。
- **失败**：静默留空，落一条 `logEvent({kind:'thread_brief_failed', …})`。**任何环节抛错都不得影响回合**（整段包在 try 里，与 13i 调 `enrichInboxRows` 同一条旁路纪律）。
  **（116-5a 实测修正 ①）尝试预算是 1+3，不是 3+3**：首回合那一发是机会性的（端点正常时一发就中，不该为了一个名字在回合刚起跑时连打三次），退避重试留给收工那次兜底。常见路径 1 次调用、最坏 4 次 —— 原写法在端点全挂时是 6 次。
  **（116-5a 实测修正 ②）收工那一刻要先补写**：首回合那次的落盘与回合自己的收尾整份 `saveSession` 抢同一个文件，回合手里那份内存副本不含 brief，谁后写谁赢而回合几乎总是后写。故收工先用本进程已算出的结果**再写一遍**（幂等、不调模型），补写没东西可写才走第二次机会；同一条会话还要做在途合流，否则两条路会各调一次模型。
  **（116-5a 实测修正 ③）已经有名字的线程不起名**：`createSession` 收到非占位标题（判据复用 `isUntitledSessionTitle`）即写 `titleSource:'user'`，摘要跳过 —— 生成的名字本来就排在人给的名字后面，再花一次调用去起一个永远不显示的名字是纯浪费。速查线程反着来（它的 title 是问题原话，不是名字），`steward_quick_ask` 建完显式清掉该标记。
- **限流**：每进程每分钟至多 20 条（防批量导入会话把端点打爆），超出的直接跳过不排队。

#### 11.8.5 消费面（改哪些地方）
服务端**一处装配、多处消费**（判据不许在前端各算一遍）：
| 面 | 现状 | 改法 |
|---|---|---|
| `sessionMeta`（02） | 7 个侧栏字段 | 有 `threadBrief` 时带出 `brief:{title,gist}` 与 `titleSource`；**缺席时逐字节不变**（存量会话零影响） |
| `GET /api/sessions`（经典壳侧栏） | `title` 原话 | 走 `sessionMeta`，自动带上 |
| `searchSessionsByContent`（113b 会话搜索） | `title` + `snippet` | 结果加 `briefTitle`／`briefGist`；`buildSessionSearchUnit` 把 brief 也拼进检索单元（顺带提召回） |
| `steward_threads_search`（13g） | `title` 原话 | 结果加 `brief`，`title` 仍是原话 |
| `steward_missions`／看板／抽屉／递送 chip／「现在这一件」（117） | `stewardShortTitle(原话)` | 改读 brief 的显示优先级；brief 缺席时仍走 `stewardShortTitle` |

**116-5b 实测落地形状（本表的最终口径）**：判据不在前端各算一遍的办法是**服务端把算好的结果一并带出**——各读模型加一个 `displayTitle`（`buildMissionCard` / 总览行 / preroute hit / `GET /api/sessions/:id` 信封），壳层只写 `displayTitle || title`。两个例外都有理由：① `steward_threads_search` 与 `searchSessionsByContent` 是**给管家和搜索 UI 读的数据面**，那里 `title` 必须留原话（管家要认出用户当时的说法），故只**加** `brief` / `briefTitle`+`briefGist`；② 经典壳 `session-experience.js` 仍自己算，因为「未命名 → 本地化占位」那条规则依赖 `t()`，服务端不认识它 —— 那本来就是经典壳唯一的显示名判据，不是新增的分叉点（静态锁 ③ 看住 `public/` 下只有它读 `titleSource`）。**打分面一律不换**：`prerouteText` 的词法命中吃的仍是原话 `title`。

#### 11.8.6 配置
`stewardThreadBriefV1`（boolean，**默认 true**）。**不随 `stewardEnabledV1`（修正，待拍板）**：消费面一半在经典壳（侧栏、会话搜索），管家关着也该有名字。设置界面放管家页签下，文案注明「经典壳的会话列表也用它」。开关关 → 零调用、零字段、零记账。

#### 11.8.7 成本与记账
每条**新**线程一次调用，输出 ≤120 token，输入是首条消息（多数 <500 token）。按 `appendUsageLedger({kind:'aux', note:'thread-brief'})` 记账（与 playbook-draft／json-repair 同款）。
**不计入** `stewardMaxCostPerDay` 那条管家日费用熔断 —— 它不是管家回合，混进去会让管家因为用户开了几条新线程而提前停机。

#### 11.8.8 红线与不做
- **不改写 `session.title`**：原话是权威，brief 只是显示层的另一份数据。
- **不给存量会话补账**：只对新线程生效，没有批量回填（与 116-4 的首见纪律同立场）。
- **不进 `providerHistory`**：brief 调用与会话上下文完全隔离，不污染下一回合。
- **不做第三次尝试**、不做后台重扫、不做「用户改了标题就重算」。
- **不新增路由**。

#### 11.8.9 切片、验收与门
- **116-5a 引擎侧**（生成 + 落盘 + 配置 + 记账 + 显示优先级判据）：`01-config` 加一键；`02` 白名单加两字段 + `sessionMeta` 带出 + 显示优先级纯函数；新原语住 `06-provider-engine`（紧邻 `providerRawCompletion`）或 `10`；`runSessionTurn` 两个 hook 点。
  e2e（假 OpenAI 端点回固定 JSON）：新会话首轮后 `threadBrief` 落盘且 ≤24／≤80；第二回合不再调；开关关零调用；端点不可用时静默且回合照常收工；JSON 解析失败 → 重试两次后留空且回合不受影响；改过名的线程显示用用户的名字；`kind:'aux'/note:'thread-brief'` 进了台账。
- **116-5b 消费面**：上表五个面 + i18n + 静态锁（判据单点）。**已交付**，交付记录见 §11.6；与本行的出入只有一处：静态锁不止钉「判据单点」，还机械对账六个装配点与「摘要块里没有任何给 title 赋值的语句」这条红线。
- 门：前向边 67 不变；路由零新增；durable-state 清册 `session-head` 行补 `threadBrief`／`titleSource`；`build --check` 新鲜；全量回归 `--parallel 4`（8 路会大面积起不来服务，见 §11.6 116-4）。
- **顺序**：116-5a → 116-5b → 117j（117j 里「线程标题改用 brief.title」的措辞要同步改成 `threadBrief`；5b 没出门时 117j 按 `stewardShortTitle` 截断先行）。

#### 11.8.10 拍板结果（用户 2026-09-07，三条全按建议）
1. **开关独立、默认开**（不随 `stewardEnabledV1`）——✅ 定案。理由见 §11.8.6：消费面一半在经典壳。
2. **端点回落到线程自己的 OpenAI 兼容 provider**——✅ 定案。优先 `stewardProviderId`，其次线程自己的 provider，两者都不可用则静默不生成。
3. **加 `session.titleSource`**——✅ 定案。显示优先级：用户起的名字 > 生成的名字 > 原话。


### 11.9 117l 设计页 · 用户第四轮走查（2026-09-07 下午，三张截图，七条 + 一条崩溃；Fable 设计与验收，Opus／Sonnet 实现）

> 派单稿全文在会话 scratchpad：`brief-117l-common.md`（纪律）、`brief-117l-A1-backend.md`、`brief-117l-A2-desktop.md`、`brief-117l-A3-settings.md`、`brief-117l-B1-frontend.md`。本节记的是**证据、拍板与验收口径**；与派单稿有出入时以本节拍板为准、以派单稿细节为准。

#### 11.9.1 用户原话（编号沿用）

1. 线程里的提问出来时，虽然会弹出「打开线程回答」，但并没有 2.0 的那种问答框，导致没法正常地回复。
2. 无论关键词匹配到什么，都要发给管家让它决定是哪个线程、是否是新线程。
3. 「它刚说」更新不够及时；线程页内容太多太杂。
4. 管家回复的 ※ 没有正确标明标题。
5. 直接卡死崩溃了（截图：「应用程序中发生了未经处理的异常 … 算术运算导致溢出」）。
6. 为啥输出完了还显示「在忙上一件」；要能让用户连续发消息。
7. 设置的管家页里可以默认配置新开线程的端点和模型：一个针对复杂任务的强模型、一个简单任务的快速模型。

#### 11.9.2 证据（读用户真机 `~/.win-claude-workbench` 的日志与管家会话，不是推测）

- **①⑥ 是同一起事故**。10:31:06 线程「帮我预判一下美股今晚走势」(`sess_a506…`) 调 `request_user_input` 挂起等答案（正式待决 `question_77ef…`）；10:31:16 收件箱 needs_you → 管家：「美股那条线程刚问到你了…」，act = open_thread「打开线程回答」。**10:32:34 该线程 `turn_kill reason:superseded`**，`request_user_input` 工具调用 `status:failed`，回合 5 aborted；同一毫秒 `steward_turn_done tool:steward_thread_continue`；10:32:38 回合 6 以一句新话开跑。也就是说：**用户还没回答的问题，被一句新递进去的话杀掉了**（`09-workflow.js:1343` `if (activeChildren.has) stopSession('superseded')` 是 2.0 主输入框的既有语义；管家递话与抽屉「直接对这条线程说」两条路都不该走到它——抽屉那条在不 live 时直打 `/api/chat/stream`，管家那条 `steward_thread_continue` 只有一道 `activeChildren.has → steward.busy`）。截图 2 里「0 条等你 / 在等什么 暂无」不是抽屉撒谎——那一刻问题已经没了；截图 3 的「我正忙着上一件」= `stewardShell.chat.errBusy` ← `steward.busy`（**线程**忙），文案却说成管家忙。用户输入区的关键词预判（「走势」命中美股线程）把「大A这周走势会怎么样」直递给了那条线程，这就是 ② 的由来。
- **④** 管家落盘的 `why` 原文：「收件箱事件 [1] needs_you:线程 sess_a50604717960006a 有待决 question_77ef30898760f07a,…」——收件箱事件行（13h:869）本来就是 `线程 ${sid}` 喂给模型的，模型照抄。总览行还在用原话 `title`，用户机器上十几条无名线程被管家叫成「**New session**」。
- **⑤** `desktop/RuyiDesktop.cs:1322` 与 `:1339`：`m.LParam.ToInt32()`（WM_MOUSEWHEEL／WM_NCHITTEST）；`build-desktop.ps1` 用 `/platform:x64`。x64 下 `IntPtr.ToInt32()` 超 int32 即抛 `OverflowException`；LPARAM 打包屏幕坐标，y 为负（副屏在上／左上、窗口部分在屏外）时高字 0xFFxx 被符号扩展成 64 位 → 抛。WM_NCHITTEST 鼠标一动就来，所以是「直接卡死」。
- **③** 「它刚说」= 最后一条**落盘**助手消息的前 ≤3 句；回合跑几分钟期间它纹丝不动（活回合的文本只在发起那条 `/api/chat/stream` 连接上流，管家派出去的回合 `onEvent: () => {}` 谁也看不见）。抽屉 11 个区块全部常驻。「收工 · 用时 770h 35m」是从建会话算起的。
- **⑦** `stewardImplThreadNew` → `createSession` → `engineRoute = sessionEngineRouteFromConfig(config)`（全局主端点）；会话级 `engineRoute` 是既有先例（02:1197），只差一个来源。

#### 11.9.3 拍板

- **D1（②）用户每句话都到管家**。输入区预判降级为「提示」：chip 显示「→ 如意 · 像是接着『X』」，随请求带 `routeHint` 进管家回合的 volatile 段（服务端只信 sessionId，标题自己重查；用户消息逐字不动），由管家决定接着办／新开／直接答。**手选 @ 目标仍直递**（那是用户明示）。
- **D2（①⑥）`steward_thread_continue` 按目标状态选通道，永不 supersede 一个等回答的回合**：在等回答 → 当作答案（`decideIntervention` answer 通道；permission 待决不代答，propose_required）；在跑 → 插话（`steerSessionCore`）；空闲 → 新回合；只有「正忙且不能插话」才 busy，文案说清是线程忙。新 `POST /api/steward/relay` 单口，抽屉「直接对这条线程说」与问答卡自由回答都走它，不再自己在 `/api/steer` 与 `/api/chat/stream` 之间猜。
- **D3（⑥）用户连发**：前端队列（第二句立即上屏、标「排队中」、按序发）；服务端「用户撞用户」真串行（循环等在途回合收尾，5 分钟上限，不双跑）；收件箱回合照旧被用户抢占。
- **D4（①③）抽屉重排**：③ 之下新增「它在问你」卡（正式待决的问题原文 + 选项按钮 + 自由回答框；软问句——原话末尾是问号——也算）；「打开线程回答」落到这张卡上并给焦点。在跑时「它正在说」显示活回合尾巴（服务端 `liveTail`，随既有 `GET /api/sessions/:id` 下发，零新请求）。三问／验收／接力／现场折进默认收起的「更多」。「收工 · 用时」改「已收工 · 最近动过 X 前」。看板行加「它在问你」pill。线程行加 `asksYou` 字段（不改 `wait`／五态）。
- **D5（④）id 人话化**：服务端确定性把 `say`／`why` 里的 `sess_…` 换成「显示名」、删掉孤立的 `question_…` 等内部 id；收件箱事件行与自理 notes 改成「线程『显示名』(id)」；总览行用显示名；06b 加规则。※ 浮层加「依据／已办」小标题。
- **D6（⑤）** 两处 `ToInt32()` 改 64 位安全截取；重建两份 exe；静态锁禁止 `LParam/WParam.ToInt32()`。
- **D7（⑦）** `stewardThreadModels: { strong:{providerId,model}, fast:{providerId,model} }`；`steward_thread_new` 加 `tier`（缺省 strong），`steward_quick_ask` 恒 fast；provider 不存在回落全局 + 审计；模型不能经 `steward_config_set` 改这两个键；设置管家页新组「新开线程用什么模型」。

#### 11.9.4 切片、分工与顺序

| 片 | 谁 | 动哪 | 内容 |
|---|---|---|---|
| A1 | Opus | `app/src` + 后端测试 | D2 通道、D3 服务端、D5 服务端、D1 服务端（routeHint）、D7 服务端、`liveTail`、`asksYou`、`/api/steward/relay` |
| A2 | Sonnet | `desktop/` + exe + 静态锁 | D6 |
| A3 | Sonnet | `index.html`／`steward-settings.js`／locale／设置测试 | D7 前端 |
| B1 | Opus（等 A1） | `app/public` 其余 + 前端测试 | D1 前端、D3 前端、D4、D5 前端 |

A1／A2／A3 并行（文件不相交，各自显式路径提交）；B1 串行在 A1 之后。全量回归与真机走查由 Fable 亲自做。

#### 11.9.5 验收口径（Fable 亲自复核，报告里的「已验证」全部重跑）

- 夹具：线程挂在 `request_user_input` 上 → 管家递话／抽屉直说 → **待决被回答、无 turn_kill**；线程在跑 → 插话入队；空闲 → 新回合。
- 输入区：关键词命中线程时请求仍打 `/api/steward/message`（带 hint），管家的 volatile 里有标题无 id。
- 连发两句：两句都上屏、按序两条回复、服务端零并跑。
- 抽屉：问答卡可见且有焦点、答完卡消失；在跑时「它正在说」每 5s 变；「更多」默认收起。
- ※：`why` 无 `sess_`／`question_`。
- 桌面：静态锁绿、exe 重建为 Amd64；用户端需重启桌面壳。
- 设置：strong／fast 各配一个 provider 后管家开的线程 `engineRoute` 对得上；速查线程用 fast。
- 门：`run-all --parallel 4` 无新增确定性红；prompt-snapshot 只 steward 段变；facts 工具数不变；路由判定点数变化在报告里写明。

#### 11.9.6 用户第五轮（2026-09-07 晚，对着 117l 夹具截图提的四条）→ 切片 B2（Opus，B1 入库后串行；派单稿 `brief-117l-B2-visual.md`）

1. 线程回报、管家自己开口时给头像一个小动效 → 只在 `trigger==='inbox'` 那一分支发一次 nudge：600ms 光环 + 轻微起伏，reduced-motion 只留光环，`animationend` 摘类、零计时器。
2. 看板（用户叫「限制界面」）美观 → 玻璃 toolbar（并发数胶囊、在跑／排队 pill、幽灵动作键）+ 事项卡（卡头名与 meta 分层、线程行缩进 + 分隔线 + hover）+ 空态；DOM id／chips 组件不动；改前后截图入档。
3. 点头像菜单出现在最顶上 → 117k 把菜单锚在顶栏，可头像 W2-3 起跟着最新一条话走。改按头像 rect 定位（下方够放开下方，否则开上方），`fixed`，resize／scroll 即关；`[hidden]`／Esc 栈／owns 原样。
4. 管家多轮的话左边一列小圆点看着怪 → 历史行不再画点；连续管家消息成组（组内紧、组间松、组首一道淡竖线，头像所在组不画线）；非最新行的 act 按钮降为幽灵样式但仍可点。
