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
