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
- **117l 用户第四、五轮走查（2026-09-07 下午→晚，Fable 设计与验收，Opus／Sonnet 实现；设计页 §11.9）**：七条 + 一条桌面崩溃 + 追加四条视觉。九个 commit：`a910fcc`/`6723a35`（A2 桌面）、`3a78a9e`（A3 设置页）、`bdb554f`（A1 后端六件）、`56f8c2b`（A1-fix）、`eb3883a`（B1 前端）、`558a32a`（A1-fix2）、`f4f4593`/`9d4a3cd`（B2 视觉）。每条都按「先复现再修、断言只加不改」做；Fable 在真夹具（真 server.js + 假 provider，`scratchpad/steward-ux-launch.js`）上逐条亲自复核，报告里的「已验证」全部重跑过。
  - **①⑥ 待决问题被杀、「我正忙着上一件」（A1 `bdb554f` + B1）**：真机日志定案 —— 线程 `request_user_input` 挂起等答案时，一句新递进去的话经 `09-workflow.js:1343` `stopSession('superseded')` 把问题连回合一起杀掉；`steward_thread_continue` 只有一道 `activeChildren.has → steward.busy`，把「在等回答／在等批准／在跑」三种情形混成一个「忙」，且 errBusy 文案把线程忙说成管家忙。**修**：13h 新判定单点 `stewardRelayChannelFor`（answer > permission > queued > steer > turn）与执行单点 `stewardRelayDeliver`（answer 走 13d `decideIntervention` 同一核心；permission 不代答 `propose_required`；steer 走 `steerSessionCore`；只有「正忙且不能插话」才 busy，文案说清是线程），新路由 `POST /api/steward/relay`（判定点 127→128，鉴权表 115→116），抽屉「直接对这条线程说」与问答卡自由回答改走它，不再自己在 `/api/steer` 与 `/api/chat/stream` 之间猜。**A1-fix `56f8c2b`（Fable 验收撞出）**：线程在仲裁器里排队等 cwd 写锁时递话被判成「空闲」又开一个回合，锁一放两个回合抢同一条线程、`superseded` 把第一句连回合一起丢掉（真丢数据）→ 加第五通道 `queued`：`stewardArbiterWait` 非 null 就诚实回 409 `steward.queued`（带 `wait.label`），绝不双开；B2 补前端人话 `errQueued`。**锁**：新件 `steward-relay-channels.e2e`（A–J 段 61 条：四通道各一 + 每条「零 turn_kill」+ 排队只开 1 回合、第一句还在）；`steward-tools.e2e` E2 重钉（在途=插话不是拒绝）+ E2b/E2c。**Fable 实测**：挂在提问上的线程 relay → `channel:answer`、待决消失、回合 `aborted:false`、`turn_kill` 计数 0；在跑 → `steer queued:1`；空闲 → `turn`；排队 → 修前 `turn_start ×2 + superseded`、修后 1 个回合且第一句保住。
  - **② 关键词预判直递绕开管家（B1 `eb3883a` + A1）**：`steward-composer.js currentTarget()` 把 `routeHits[0]` 当目标、`submit()` 直接 `handOff`。**修**：自动预判降级为提示（chip「→ 如意 · 像是接着「X」」），一律 `sendToSteward(text, { routeHint })`；手选 @ 目标仍直递（用户明示）。服务端 `stewardNormalizeRouteHint` 只信 sessionId（≤3、`safeSessionId`、排除管家会话，标题按显示名重查，前端文字一字不进提示词），进 volatile 段 `routeHintBlock`（无 hint 整段不出现，老载荷零变化）；06b 加「预判只是提示，由我判断」。**锁**：`steward-conversation.e2e` F1/F2/F3 重钉 + F3b/F3c（请求体带 hint、用户话逐字不动、hint 无标题）+ P1–P3b（手选仍直递）。**Fable 实测**：夹具假管家从 volatile 里读到 hint 后自己调了 `steward_thread_continue`，走 answer 通道。
  - **③ 「它刚说」不及时、线程页太杂（A1 + B1）**：活回合文本只在发起那条流上可见，管家派出去的回合 `onEvent:()=>{}` 谁也看不见。**修**：04 `appendLiveTail`（600 字环、挂在 09/05 两个引擎的**本地** onEvent 包装上 —— 派单稿写的 `reg.onEvent` 只看得见桥接那一路，实做时踩到）；`GET /api/sessions/:id` 条件下发 `liveTail`（`thread-brief.static` ② 重钉 + 条件展开 companion）。抽屉：在跑时「它正在说」显示活回合**末尾** ≤3 句 + 正在用的工具人话（新表 `STEWARD_THREAD_TOOL_LABEL_KEYS`，表外「用一个工具」，提问中「等你回答」）；三问／验收／接力／现场折进默认收起的 `<details>`「更多」；「收工 · 用时 770h」改「已收工 · 最近动过 X 前」（锚点 `updatedAt`）。区块表 11→13（`steward-drawer.static` A1/A2 重钉 + A2b 四块顺序不变）。**A1-fix2 `558a32a`（B1 现场发现）**：`GET /api/sessions/:id` 活回合分支从不回 `resumable.live`，抽屉 `isLive()` 第一判据从未走通 → 补 `live:true`（H1b/H3b + 静态锁）。**Fable 实测**：`liveTail` 4s→7s 文本在长。
  - **① 没有问答框（A1 `asksYou` + B1 问答卡 + 看板 pill）**：线程行加 `asksYou: {kind:question|soft, text, questionId?}`（06i `stewardAsksYou` 三态单点，13g 线程行与 13e 活叠加层只加字段，`wait`／五态不动）。抽屉新块 ④「它在问你」（`index.html` 骨架 + `[hidden]` 守卫）：问题原文 + 选项按钮（复用 `quickRepliesFor` 口径）+ 自由回答框；正式待决走 `/api/chat/answer`（`content` + `otherText`），软问句走 relay；④ 出选项时 ⑦「你可以说」隐藏；`openThread` 读到数据那一帧 `focusAsk()`（H5 重钉 + H5d）。看板行「它在问你」pill（金色描边），点击=打开抽屉。**Fable 实测**：看板 pill → 抽屉置顶问答卡（「接着用哪个框架？」React/Vue/回答框，焦点在框里，「更多」收起）→ 点 Vue → 「已替你回复」、卡片消失、`intervention` 事件送达、回合 `aborted:false`、零 `turn_kill`。
  - **④ ※ 没标明标题（A1 + B1）**：用户真机 `why` 原文「线程 sess_a506… 有待决 question_77ef…」—— 收件箱事件行（13h:869）本来就是 `线程 ${sid}` 喂给模型。**修**：06i 纯函数 `stewardHumanizeIds`（`sess_` → 「显示名」，查不到原样保留；孤立 `question_/intv_/run_/…` 删除并收紧标点；**全角标点一律 `\uXXXX` 转义** —— 编辑器归一把「，」变「,」这条真踩过），只作用于 `say`/`why`（帧／落盘／`lastReply` 同一份，`acts[].sessionId`、`actions[].args` 不动）；收件箱行与自理 notes 改「线程「显示名」(id)」；总览行改显示名（`digest.title` 仍原话，preroute 打分要吃它）；06b 加「提线程一律用标题」（prompt-snapshot 重钉 steward 段，stable 层 zh 1148／en 2453 不变）。前端 ※ 分「依据」「已办」两段小标题。**A1-fix ②**：占位标题 `New session` 被当显示名 → `sessionDisplayTitle` 第四档：占位 + 拿得到首条 user 消息 → 前 24 字摘录（手改标题不动；只有会话头的调用面仍是占位 —— 收件箱行／总览行要吃到摘录得多读一次正文，**登记治理项**）。**锁**：`unit/steward-humanize.test`（34）、`thread-brief.e2e` (L) 段 9 条。**Fable 实测**：收件箱行「线程「华南报表对账」(sess_…)」、管家 say/why 零 `sess_`。
  - **⑤ 桌面壳崩溃「算术运算导致溢出」（A2 `a910fcc`，Sonnet）**：`RuyiDesktop.cs:1322/1339` `m.LParam.ToInt32()`，`/platform:x64` 下 LPARAM 高 32 位非零（y 为负：副屏在上／左上、窗口部分在屏外）即抛 `OverflowException`，WM_NCHITTEST 鼠标一动就来。**修**：`unchecked((int)(long)m.LParam)`，不加 try/catch 兜底；CLR 级最小复现（x=100,y=-50 零扩展 → 实抛同款异常）；重建两份 exe（71,680 B，Amd64，SHA256 `d5801669…`）。**锁**：`desktop-shell.static` 三条（禁 `LParam/WParam.ToInt32()`、钉 unchecked 写法、钉 x64 编译）。**补正 `6723a35`**：派单稿写错「exe 在 git 里」（`.gitignore` 3/45 行本就排除），子代理照稿 `-f` 强加，Fable 撤出版本库。**用户端要重启桌面壳**（它当时开着的进程跑的是旧二进制）。
  - **⑦ 新线程模型分档（A1 + A3 `3a78a9e` Sonnet）**：`stewardThreadModels: { strong:{providerId,model}, fast:{providerId,model} }`（01-config 归一，不校验 provider 存在 —— 可先配 id 后建端点）；06i `stewardThreadEngineRoute` 纯判定 + 13h `stewardApplyThreadTier` 写 `session.engineRoute`（provider 不存在回落全局 + 审计 `steward_thread_model_fallback`）；`steward_thread_new` 加 `tier`（缺省 strong），`steward_quick_ask` 恒 fast；`steward_config_set` 白名单**不加**这两个键。设置管家页新组「新开线程用什么模型」（`fillProviderOptions` 单点、三处调用；整对象合并上传；六个新 id、六个 locale 键；`steward-settings.static` A4 重钉六组→七组 + A4b）。**Fable 实测**：fast 档线程 `engineRoute` = `fake-fast/fake-fast-model`，缺省 = strong 档；设置页控件在管家页签可见、值从配置播种正确。
  - **⑥ 连发被静默吞掉（A1 D3 + B1）**：`steward-conversation.js` `if (streaming) return null` 不上屏、不排队、不报错；服务端 15s race 超时后不复查 inflight。**修**：前端队列（`STEWARD_SEND_QUEUE_MAX=5`，第二句立即上屏带真节点「排队中」，按序 `drainQueue`）；服务端 `while` 等在途 user 回合真正收尾（`STEWARD_USER_QUEUE_WAIT_MS` 5 分钟）、`entry` 同步认领、释放点推到 `stewardStampReply` 之后，真等过才记 `steward_user_turn_queued`。**Fable 实测**：两句 8.1s 内按序各得一条回复、审计 1 条；界面第二句带「排队中」。
  - **第五轮四条（B2 `f4f4593`/`9d4a3cd`）**：头像动效（只在 `trigger==='inbox'` 分支 `nudgeAvatar()`，600ms 光环 + 一次起伏，`animationend` 摘类、零计时器、reduced-motion 留光环；D3 重钉 + D3c/D3d）；菜单贴着头像开（117k 锚在顶栏而头像 W2-3 起跟着最新一条话走 → 按头像 rect `fixed` 定位，下方够放开下方否则上方，挂 `#stewardShell`，resize/scroll 即关；F1 选择器重钉 + F1b/F1c）；多轮对话流成组（删掉 `.steward-avslot:empty::before` 那个 8px 点，C5 翻钉 + C5b/C5c；`is-group-start/end` 组内紧组间松、多行组左侧 2px 竖线、头像所在组 `:has()` 排除；非最新行 act 降幽灵档但仍可点）；看板视觉（玻璃 toolbar、并发数胶囊、在跑／排队 pill、事项卡、线程行缩进 + 分隔 + hover、金色描边「它在问你」、空态；改前后截图 `scratchpad/shots/board-{before,after}-{1280,390}.png`；第一版 390px 线程名被挤没，补 `min-width:5em` + I7b/V4）。**Fable 实测**：菜单 top = 头像 bottom + 8、左缘对齐；空槽 `::before` 为 none；旧行按钮底色 `rgba(220,186,117,0.02)` 幽灵档、最新行金底。
  - **两条查了但不是 bug**：抽屉「看全文」看着被分隔线压半截 —— DOM 几何 261–277 vs 下一块 289，是滚动阴影；`resumable.live` 之外的「它刚说」在回合刚结束那一拍仍显示旧值是轮询节拍（5s），不是数据错。**夹具五个坑**记进记忆（客户端断流即 `turn_kill(disconnected)`、同 cwd 写锁串行、非 mission 会话不进 `/api/missions`、易变前缀拼在首条 user 消息前、假管家别在收件箱回合调工具）—— 三趟验收里两趟的红全是它们。
  - **门**：路由判定点 127→128、鉴权表 115→116、facts nativeTools 89 不变、e2e 315、unit 29；13g 1998 行（<2000 未放宽，靠把纯判定搬进 06i/13h 守住）；模块 41／边 319；CSS 载荷 SHA `bab77e27…` → `f4cce185…`（B1）→ `d2856ad3…`（B2①）→ `b345f06f…`（B2②）。**全量回归**（隔离 worktree，`--parallel 4`）：`558a32a` 上 299 pass／9 fail／9 flaky，9 条失败逐一复核 —— 5 条单跑绿（并行争抢），4 条是 worktree 缺本地未入库 fixture 目录（`realhist-fixtures`）或断言写死仓库目录名（`pretender-dispatch-home` C1），主树单跑全绿，**零确定性红**。**最终 HEAD `9d4a3cd`**：300 pass／8 fail／9 flaky／308 ran／7 skipped，8 条失败件逐一复核 —— `multi-session-parallel`、`responses-websearch-fake`、`budget-guard`、`perf` 在 worktree 单跑绿（并行争抢），`observation-recall` ×2、`session-notes`、`pretender-dispatch-home` 在主树单跑绿（worktree 缺本地 fixture／断言写死目录名），**零确定性红**；9 flaky 与既有时序名单重合。
  - **治理登记**：收件箱行／总览行的占位标题要吃到首条消息摘录得多读一次正文（每线程一次 I/O）；`steward-drawer.static` C2「零 setTimeout」与 `steward-shell` 的 setInterval 计数继续是硬约束（本波两处都靠 `animationend`／节拍闸绕开）；桌面壳 exe 不进 git，发版要单独重建。
#### 11.6.117m 117m + 117n 交付记录（2026-09-08，用户第六轮走查六条 + 熔断；Fable 设计与验收，Opus／Sonnet 实现）

设计页 §11.10。九个 commit，全部由 Fable 在主树逐条复核（子代理报告里的「已验证」一律重跑）。

| commit | 切片 | 根因 → 修法 |
| --- | --- | --- |
| `5566d89` | 设计页 | §11.10：真机日志证据、D1–D7 定案、切片表与验收口径 |
| `11d8a05` | A5 看全文 | 管家起的回合没有客户端挂在流上，正文要到回合结束才落盘（真机：53 次工具调用，messages.ndjson 只有 1 行）→ 04 的 liveTail 从「尾巴」扩成「本回合正文 + 最近工具名」（不落盘、不含工具参数与结果），经既有 `GET /api/sessions/:id` 下发；经典壳一张临时气泡 + 单点 3s 节拍 |
| `b7230d7` | A2 四类待决 | `stewardAsksYouForThread` 只认 question，而用户那条线程 14 条待决全是 permission → 扩到 question>permission>plan>pool，人话仍走 `stewardPendingOneLine` 单点；看板 pill 按类说话；抽屉问答卡吃下 permission（复用既有决策通道）；状态行「N 条等你」直达 |
| `b4325bb` | A1 权限档+熔断 | ① `auto` 档 exec 一律 ask 而三处界面都叫它「全自动」→ 高风险判据复用 `stewardToolPermanentlyExempt`，命中才问；② 回合中途改档对活回合无效（02 的覆盖表从没被闸门读过）→ 只在本回合被改过时接管；③ 小时窗把用户自己的话也挡了（真机两条 `trigger:'user'`）→ 只节流自主回合，默认 12→30；④ 收件箱合并窗口 5s→30s |
| `90691d3` | A3 交办台 | `kind:'mission'` 而 `mission:null` 是合法状态，`/changes` 对它 404 把整块面板换成错误卡 → 回 200 空清单；CLI 桥闸门补参同口径；`needsYouCount` 修前是死字段（声明了、presence 读了、全仓没人写）→ 看板只读句柄喂进 presence；06i 补第三道判据：结构化入参里的写型 HTTP 方法 + `mcp_configure`（A1 把这条判据接成原生闸门的免检线后，漏判的后果从「管家替你按」变成「根本不问就发出去」） |
| `adf1997` | A6 审查回补 | 四路只读审查报回：P0-1 请求级档被会话级中途改动静默顶掉；P0-2 惰性补的账本被中途重读吃掉（暂停正在跑的线程 → 回合真停了却报 500）；P1 交办台按钮判据侧没跟着修（七个按钮全灰、执行侧修复走不到）；P1 首屏刷新 Promise.all 一挂清空面板；P1 管家输入框漏 `isComposing`（中文候选词回车误发）；P2 活回合气泡首帧留白。另加 `unit/permission-ceiling.test.js` 把「管家能自动放行的、原生引擎也必须允许」这条只写在注释里的天花板不变量钉成红线 |
| `c87df6e` | A4 暂停线程 | `steward_run_action` 是班组动作（要 runId），普通线程没有 run，管家只能拿它凑 → 必然 `invalid_request` → 前端把机器码原样贴出 = 用户看到的「invalid」。新原语 `steward_thread_stop`（复用 stopSession + 出队 + 撤授权书三个既有核心），收紧类任何档都可直接执行，没在跑回 `not_running` + 人话；`run_action` 缺 runId 改成能自纠正的人话。工具数 89→90 |
| `bc2bbfd` | README 上锁 | 门面数字漂了好几波（89/243/15 vs 真值 90/318/30），因为没有任何机器在看 → 按 facts.json 刷新十二处 + 三条对账断言（只要求真值出现过，不钉句式） |
| `c469bdb` | 117n-M2 合并 | ① `mcp_configure` 工具面漏三项副作用（删连接器不记 `dismissedMcpIds`→重启被自动加回、不重生成 `.mcp.json`、没有 drop-in/内置护栏）→ 护栏下沉到 04 + 新内核 `mutateMcpConnector`，HTTP 面与工具面同走一条路；② 配置「读-改-写」被 9 处绕过，锁只保护物理写 → `mutateConfig` 全程持锁，裸 `writeConfig` 调用点 10→1。修前实测 5 路并发只活 1 个（丢失更新真身），修后 5/5 |
| `6155e92` | 生成器链收口 | 两片各自在干净副本 build，共享再生物没人提交 → 依赖图 41 模块 320 边、路由清册 128 判定点双向无漂移 |

**并发施工的教训（记进纪律）**：这一波六个切片并行跑在同一棵主树上，出过一次真实事故 —— 某片用底层
命令提交时基线与父提交对不上，**把上一个 commit 整个回退了**（当事片自己发现并 CAS 回滚重做）。
此后各片一律「`git archive HEAD` 出干净副本 → 只覆盖自己的文件 → 在副本里 build → 用 `hash-object`
+ `update-index` 把干净产物入索引」，共享再生物（`server.js`／`manifest.json`／依赖图／路由清册／
`facts.json`）由主会话最后统一重跑一次收口。**并行派单前先把文件白名单切干净，是这条流水线的前提。**

### 11.7 停点与待派清单（2026-09-06 夜，用户额度将尽，明日续；Fable 写）

**2026-09-07 下午追加**：用户第四轮走查（七条 + 一条桌面崩溃）立项 **117l**，设计页与派单见 §11.9（Fable 设计与验收，Opus／Sonnet 实现）。**当晚已全部入库**（九个 commit，交付记录见 §11.6「117l」）；挂起两条治理项：收件箱行／总览行的占位标题摘录（要多读一次正文）、桌面壳 exe 发版单独重建。

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

### 11.10 117m 设计页 · 用户第六轮走查（2026-09-08 上午，三张截图 + 一张追加，六条 + 熔断；Fable 设计与验收，Opus／Sonnet 实现）

**这一轮的证据全部来自用户真机**，不是从截图推的：日志 `~/.win-claude-workbench/logs/workbench-2026-09-08.ndjson`、
会话 `sessions/sess_8bb0dd55d35045b0.{json,messages.ndjson,interventions.ndjson}`、`config.json`。
服务端 02:18:46 起（v2.6.2，node 直起），用户 02:21 让管家开了「博纳影业怎么看怎么操作」这条线程，
之后 15 分钟里发生的事就是这七条 bug 的全部现场。

#### 11.10.1 用户原话与现场证据

| # | 用户原话 | 现场证据（真机） |
| --- | --- | --- |
| ① | 点开线程的「看全文」，还是啥也看不到 | 该线程 55 条 `model_call_completed`／53 条 `tool_call_completed`，`messages.ndjson` **只有 1 行**（那条 user 消息） |
| ② | 已经默认线程全自动了，还是很多要求权限，管家还是一条条汇报，费 Token | 会话头 `permissionMode:"auto"`、引擎 `openai-compatible/qwen3.8-flash`；11 条 `intervention source:"steward_decision" action:"allow"`，两分钟一条 |
| ③ | 暂停这个线程，会显示 invalid | 管家降级出的按钮打的是 `steward_run_action`，而该工具 `sessionId && runId` 缺一即 `invalid_request`；这条线程根本没有班组 run |
| ④ | 交办台点开，显示报错 | 截图里的信封就是 `GET /api/missions/:id/changes` 的 404 `mission not found`：会话 `kind:'mission'` 但 `mission:null` |
| ⑤ | 系统提示的「需要我」通知，在管家界面也点不开 | `stewardAsksYouForThread` 只认 `question` 一类；托盘气泡点击只 `ActivateShellWindow()`，不带线程 |
| ⑥ | 需要我允许的也没在线程中 | 同 ⑤：该线程 14 条待决全是 `perm_*`，最后一条 02:36:57 `decidedBy:"timeout"` 自己超时被拒 |
| ⑦ | 这个熔断也不对吧 | `{"kind":"steward_circuit","circuit":"turns_per_hour","trigger":"user"}` ×2（02:31:33、02:33:25）——被挡的是**用户自己那两句话** |

#### 11.10.2 定案（D1–D7）

- **D1「全自动」要真的不问。** `nativeToolGate`（07:771）的 `auto` 档在原生引擎里对 exec **一律 ask**，
  而 `auto` 在三处界面（onboarding、管家壳档位、06i 标签表）都叫「全自动」，经典壳自己的说明写的是
  「低风险自动执行，高风险仍会问你」——**那个风险判据从来没有被实现**。修法不是改标签，是把承诺兑现成
  确定性判据：复用既有单点 `stewardToolPermanentlyExempt(toolName, input)`（工具名正则 + 命令文本正则，
  覆盖对外发送／支付／安装卸载／系统设置注册表／关机格式化／`rm -rf`／`git push`）——命中才问，
  其余放行。`bypass`／`read`／`plan`／`acceptEdits` 五条分支一行不动，缺工具名时保守回落 `ask`。
- **D2 回合中途改档要立刻生效。** 档位在回合开始时被解析成快照（10:2230），闸门全程读它；
  02-session-store 那张会话级覆盖表（`sessionPermissionModeOverrides`）的头注自称「对所有读者立刻是新值」，
  **但 09 的闸门根本不读它**。加一个只读访问器让闸门取活档——放宽与**收紧**都立刻生效，后者比前者更要紧。
- **D3 熔断只节流自主回合。** `turns_per_hour` 不看 trigger，与同一函数里 `no_progress` 那句
  「用户消息永远优先」自相矛盾。改成只对 `trigger !== 'user'` 生效；默认 12 → 30（**不迁移存量配置**：
  静默抬高别人的花钱上限不合适）；被挡时那句话要说清去哪调。收件箱合并窗口 5s → 30s。
- **D4 四类待决都要能点。** `asksYou` 只认 `question`，于是挂着 `permission` 的线程「等你」却无处可点。
  扩到 `question > permission > plan > pool` 固定优先级，人话仍走既有 `stewardPendingOneLine` 单点；
  看板 pill 按类说话；抽屉问答卡吃下 permission（复用既有 `/api/permission/decision`，不新起路径）；
  状态行「N 条等你」做成直达（恰好 1 条就开那条线程并聚焦问答卡）。
- **D5 在途回合要看得见。** 管家起的回合没有客户端挂在流上，正文要到回合结束才落盘，全仓也没有
  「事后挂载」的通道。把 04 的 `appendLiveTail` 从「尾巴」扩成「本回合正文 + 最近工具名」
  （不落盘、不含工具参数与结果），经既有 `GET /api/sessions/:id` 信封下发；经典壳渲染一张临时
  「它正在跑」气泡（不进 messages 数据面），单点 3s 节拍，回合一结束换成真消息。
- **D6 交办台不许被一个空账本打死。** 线程 `kind:'mission'` 而 `mission:null` 是合法状态（还没有变更账本），
  `/changes` 对它 404 是把「还没有变更」说成「找不到事项」，而 `preview-shell` 的 `Promise.all` 一挂就整页
  换成错误卡。服务端改成 200 空账本；客户端顺带做一道降级（单个子请求失败不许清空整块面板）。
- **D7 线程级「暂停」要有自己的原语。** `steward_run_action` 是**班组**动作（要 runId）；普通线程没有 run，
  管家却只有这一个「暂停」可提，于是必然 `invalid_request`。给管家一个线程级停止工具（走 `/api/stop`
  同一语义，收紧类动作任何权限档都可直接执行），并让「没有在跑的回合」返回一句人话而不是 invalid。

#### 11.10.3 切片与分工

| 切片 | 内容 | 谁 | 文件面 |
| --- | --- | --- | --- |
| A1 | D1 + D2 + D3 | Opus（并行） | 07 / 08 / 09 / 02 / 14 / 13h（仅熔断）/ 01-config / 13i |
| A2 | D4 | Opus（并行） | 06i / 13g（仅 status）/ 13e / 管家壳前端 / index.html / locale ×4 |
| A5 | D5 | Opus（并行） | 04 / 13d（仅 GET session 段）/ session-experience / 经典壳样式 |
| A3 | D6 | Fable 亲自 | 13d（`/changes` 与 1557 行闸门补参）/ preview-shell |
| A4 | D7 | 待 A1／A2 落地后串行 | 13f / 13g / 13h（hook 表）/ 06b |
| A6 | 托盘气泡带 sessionId、点击直达线程 | 待定（要重建 exe） | desktop/RuyiDesktop.cs + 前端监听 |

三片并行的前提是**文件面不相交**：13d 的其它部分归主会话，13g／13h 各自只碰点名的那一个函数。

#### 11.10.4 验收口径（Fable 亲自复核，子代理报告里的「已验证」一律重跑）

- ② 全自动线程跑 `script_run`（普通命令）零权限弹窗；换成 `git push`／`winget install` 仍然弹。
- ② 回合跑到一半把档从「每步都问」切到「全自动」→ **同一个回合**的下一个工具不再弹；反向切回立刻重新弹。
- ⑦ 小时窗打满后用户说话仍有回复，收件箱回合被挡且那句话告诉你去哪调。
- ①「看全文」切过去能看到正在产生的正文与「正在用 X」，回合结束后换成真消息、不留残影。
- ⑤⑥ 一条挂着 permission 的线程：看板行有 pill、抽屉顶部有卡、点「允许」后待决消失、线程继续跑。
- ③ 对没有班组的线程按「暂停这条线程」→ 真的停，或给一句人话，绝不出现 `invalid`。
- ④ 交办台打开一条 `mission:null` 的线程不报错。
- 门：`run-all --parallel 4` 无新增确定性红；工具数与路由判定点变化在交付记录里写明。

### 11.11 117p 设计页 · 用户第七轮走查（2026-09-08，一张截图；Fable 设计与验收，Sonnet 实现）

**用户原话**：「其实 2.0 回合已经跑完了，但是管家没有收到体现也没收工。」

截图里那条线程「大A接下来的走势会怎么样」抽屉顶部标着「交办中」，管家侧「它刚说」停在半路，
用户问「现在呢」时管家只能说「一直在跑、没卡住也没在问你」。**实际上这条线程 11 分钟前就跑完了。**

#### 证据（用户真机数据目录，2026-09-08，不看截图看账）

| 事实 | 出处 |
|---|---|
| 会话真的跑完了：`turnSeq: 1`、`launchedBy: "steward"`、`stewardLastTurn: {seq:1, ok:true, aborted:false, at:"2026-09-08T05:11:29.172Z"}`、`messages.ndjson` 两行（user + assistant） | `sessions/sess_e97b29759a586485.json` |
| 收件箱游标却记着 `sessionTurns["sess_e97b29759a586485"] = {turnSeq:1, stamp:"249228…"}` | `steward/cursor-v1.json` |
| 箱子里这条会话**零行**（最后一行是 02:41 的 needs_you） | `steward/inbox-v1.ndjson` |
| `server_start` 在 02:18:46Z，会话建于 05:00:37Z —— 首见时 `stewardRuntime.cold` 早已 false，排除「冷启动只建基线」 | `logs/workbench-2026-09-08.ndjson` |
| 这条线程 `mission` 为 **null**（`kind:'mission'` 但没有账本容器）——三条源日志一个字都不会写 | 同会话头 |

#### 两处根因（都不是「没实现」，是判据用错了字段）

**S1 · 收件箱第四源的基线 off-by-one。** `13i-steward-inbox.js` 的 `stewardCollectSessionTurn`
在「首见就撞上活回合」时写 `{ turnSeq: known ? known.turnSeq : turnSeq }`。
而 `turnSeq` 是在回合**开始**那一刻就 +1 落盘的（`05-claude-engine.js:88`、`09-workflow.js:1292`，
两处都紧跟 `saveSession`），**不是**「已经跑完的回合数」。于是首见时基线被记成**正在跑的那一回合**，
回合真结束后 `turnSeq` 没再前进 → `turnSeq <= baseline` → 唯一那条 `done` 被**永久吞掉**。
轮询 15 秒一轮而线程回合动辄几分钟 → **管家自己开的线程第一回合几乎必然命中**，
也就是说「管家派出去的线程跑完了」这件事在真机上一次也没报出来过。
另有一处窄窗口：`09:1292` 落盘 turnSeq 之后还要跑 `captureWorkspaceTurnBaseline`（大工作区好几秒）
才 `activeChildren.set`（`09:1381`），首见落进这个窗口会当场报一条「跑完了」（其实还在跑）
并把基线推到当前 turnSeq——真跑完时反而再也报不出来。
判据用确定性落盘证据（13g 在 settle 之后写的 `stewardLastTurn.seq` 追平 `turnSeq`），**且只在首见那一次用**——
否则用户在 2.0 视窗里自己接着聊的回合（它们不写 `stewardLastTurn`）会被永久判成「还没结束」，
那是把一个洞换成另一个洞。

**S2 · 五态判据把 `turnSeq` 硬编码成 0。** `06i-steward-core.js:367 stewardThreadStateFromCard`
与它的前端抄写件 `public/js/mission-state.js fromCard` **都写死 `turnSeq: 0`**，注释理由是
「卡片无 turnSeq；dispatching 判据由 runCount + milestonesDone 承担（卡片语义足够）」。
这个假设对 2.0 任务单成立（一定有 mission 账本和 run），对管家线程**不成立**：
`steward_thread_new` 只写 `kind:'mission'`，mission 容器要 `POST /api/missions` 才有。
于是 `runCount===0 && turnSeq===0 && milestonesDone===0` 恒真 → **永远「交办中」**。
`13d-core-domain-routes.js:609` 的注释**已经警告过这件事**（「少喂 turnSeq 会把一条跑过回合的线程说成交办中，
和 thread_status 的『已停工』打架」），但当时只修了没有卡片的那条分支，有卡片那条（也就是真实路径）没修。

#### 修法与验收判据

- **S1**：活回合分支基线取 `Math.max(0, turnSeq - 1)`；首见分支对「管家发起、`stewardLastTurn` 还没追平」
  的线程延后一轮再报。回归 e2e 必须复现「回合还在跑时轮询器第一次看见它」这个时序，
  并做**反向验证**（把那一行改回旧写法，确认新测试真的红）。
- **S2**：`13d buildMissionCard` 给卡片补 `turnSeq` 与 `lastTurn{seq,ok,aborted}`（都是会话头已有字段的投影，
  不新增持久化来源）；两份五态抄写件同步加一条**无账本线程**分支：没有里程碑、没有结果章、没有班组、
  跑过回合、此刻没在跑 → **已收工**；末回合 `ok:false` 或 `aborted` → **已停工**；
  账缺席按成功算（与 13i 的 `@sessionTurn` 解析器「账缺席一律 done」同口径）。
  `13e` 的 `PRETENDER_INDEX_SCHEMA` **3 → 4**（卡片形状变了，且必须强制重建——
  否则存量已跑完的线程旧卡片永远不刷新，用户那条线程会一直卡在「交办中」），
  同步更新 `dev-harness/durable-state-inventory.js:75` 与两份生成视图。先例：116-5b 的 2 → 3。
- **走查判据**：管家开一条线程 → 线程跑完 → **管家在一个轮询周期内主动转述结论**；
  抽屉与看板上那条线程从「交办中」变成「已收工」；用户主动停掉的线程显示「已停工」。

#### 与 117q（重复造轮子普查）的关系

S2 属于普查里的 B 类（同一事实两处各算一遍），故与 117q 同批做。
普查的完整清单、分批派单顺序与每条的撞锁分析见
[`30-dedup-audit-wave-117.md`](30-dedup-audit-wave-117.md)。

### 11.12 117r 设计页 · 用户第八轮走查（2026-09-08 夜，四张截图，四条；Fable 设计与验收，Opus／Sonnet 实现）

**用户开场**：「似乎整体好很多了，但是改出了几个问题」——四条里有两条确实是本波改出来的，
另外两条是一直存在、这一轮才被撞见（下面逐条注明是哪种）。

| # | 用户原话 | 定性 | 刀 |
|---|---|---|---|
| ① | 管家新开线程等不会自动打开线程详情页了 | 时序洞，一直存在；③ 落地后才会彻底好 | 117r-D2 |
| ② | 关键词匹配这个，最好不要和输入框放同一行，会把输入框内容挤没…而且匹配的没法删掉/关掉 | 117l D1 新面遗留 | 117r-D3 |
| ③ | 管家线程下拉，并没有正确同步显示 | 一直存在（116 波起） | 117r-D1 |
| ④ | 2.0 视窗，为啥在运行时会显示这段对话是在一个框里，而不是普通 2.0 一样 | 117o-A7 之后过期的设计 | 117r-D4 |

#### ③ 的根因：看板上那两个数字来自两个对「线程」定义不同的源

截图里看板顶部说「同时最多 5 · **在跑 1** · 排队 0」，正下方的列表说「**还没有任务**，直接说你想做什么」。

- 顶部两个数来自 `GET /api/steward/arbiter`（`13h-steward-runner.js:2101`），
  数的是 `stewardArbiter.running` —— 内存里此刻占着并发位的**管家派出去的回合**；
- 列表来自 `GET /api/missions`（`steward-board.js:163`），而 `13d-core-domain-routes.js` 把行集过滤成
  `index.sessions.filter(row => row.card)`，卡片只在 `13e-pretender-index.js:145` 的
  `kind === 'mission'` 分支才造。

`steward_quick_ask` 建的线程（`13g-steward.js:1844`）显式写 `kind = 'quick_ask'`，
**于是恒无卡片 → 恒不进 `/api/missions` → 看板永远看不见它**，而它照常占仲裁器的并发位、照常被计数。

**实测**（主会话，真服务器，临时 HOME，两条会话头：一条 `kind:'mission'`、一条 `kind:'quick_ask'`＋`stewardQuick` 标）：

```
GET /api/sessions  -> 200 count: 2  sess_probe0000000001(mission), sess_probe0000000002(quick_ask)
GET /api/missions  -> 200 rows: 1   sess_probe0000000001(kind=mission state=none)
```

`13g-steward.js:1852` 的注释写着「速查线程…GET /api/missions 里它就是一条『未归类』的派生行」——
**这句话是假的**，它根本不在那份行里。设计意图写在注释里，代码从来没实现过。

**修法**：「管家关心这条会话吗」这条判据**已经有唯一实现**——`13i-steward-inbox.js:691`
的 `stewardWatchedThread`（速查线程／管家发起过回合的线程／别人事项里的线程；用户自己在经典壳里
聊的普通会话**不**算）。把它搬到 `06i-steward-core.js`（06i < 13e 且 06i < 13i，两条都是合法后向边），
13e 用同一份实现决定要不要造卡片。**不新造判据**，也不能简单地「所有 quick_ask 都放进来」——
`sessionKind()` 对任何没有 mission 容器的会话都回 `quick_ask`，那会把用户几百条 2.0 对话全灌进看板，
而这正是那个 `filter(row => row.card)` 当初存在的理由。

#### ① 的根因：「行里没有它」被当成了「它不存在」

`steward-conversation.js:704` 在回合收尾时派 `steward:focus-thread`，两个模块各自听。
看板那一路（`steward-board.js:719`）是本模块自己 `focusThread()`（`:552`）的一个**弱化抄写件**——
把 `if (!syncNow()) drawer.openThread(...)` 那条回退整个丢了。更要命的是第二层：

```js
function currentFocusId() {                                    // steward-board.js:584
  if (pinnedId && rows.some(row => String(row.sessionId) === pinnedId)) return pinnedId;
  ...
}
```

**刚建出来的线程还不在 `rows` 里**（`rows` 是上一趟 `/api/missions` 的快照），于是这一钉被否掉，
回落去自动挑一条别的；挑不出来 `syncNow()` 就 `show=false` → `#stewardNow` 整块 hidden，
并且 `if (drawer.mountMode() === 'docked') drawer.closeDrawer()` —— **把抽屉刚打开的那一份关掉**。

而 `steward-board.js:37` 的文件头自己写着「行数据在进壳／开看板／**焦点事件**／写动作／页面重新可见
这五个确定性时刻各刷一次」——**「焦点事件」这一刷从来没实现过**。

**修法**：焦点事件改调既有的 `focusThread()`（删掉抄写件），并加一个**有界**的「这一钉还没被行核实过」
状态位：未核实期间 `currentFocusId()` 无条件认这一钉，同一个处理器随即刷一次行，刷完（无论成败）
交回原判据。不许「一钉就永久信任」——那样一条真的不存在的线程会把右栏永远占着。

#### ② 的根因：三条各自独立

1. **标题没截短**：`steward-composer.js:94 hintedThread()` 返回的是标题**原话**，
   `:125` 直接套进「像是接着『X』」。全仓别处都过 `stewardShortTitle`（`STEWARD_TITLE_MAX = 24`），
   只有这一处（和手选那一支）漏了——而线程标题常常就是用户说的一整句话。
2. **chip 不缩**：`.steward-composer` 是单行 flex，`.steward-target` 是 `flex:0 0 auto; white-space:nowrap`，
   有多长吃多长；`.steward-composer-input` 的 `min-width:0` 被压到零宽也不吭声。
   （`max-width:45vw` 只在 620px 那个媒体查询里有，宽屏没有。）
3. **自动命中没有关闭出口**：`:122` 的 `clear.hidden = !picked` —— 那枚 `×` 只在**手选过**时出现。

**修法**：截短走既有实现；chip 挪到输入框上面自成一行（位置恒定，不许短的时候在行内、长的时候跳上去）；
自动命中也给 `×`，撤掉之后这一次预判不再随后续输入回来（发送／清空即复位）。
**递送语义一个字不改**：117l D1 的铁律「无论关键词匹配到什么，都要发给管家让它决定」仍然成立，
撤掉提示的效果只是这一次 `routeHint` 不带 hits —— 那本来就是用户在说「这不是接着那条」。

#### ④ 的根因：一条「刻意做得不一样」的设计，在后续改动之后过期了

`chat-live.css:255` 那圈虚线框是 117m-A5 的**刻意设计**，注释写着「它长得就该和落盘消息不一样，
用户一眼看出『这还没定稿』」。**这个判断在 117o-A7 之后就过期了**——A7 把这张卡的正文改成由
`renderStaticMessage()`（画落盘助手消息的同一个渲染器）生成，思考块／工具卡／过程记录／完成徽章
已经逐像素同源。**于是框成了唯一的差别**，它不再读作「草稿」，而读作「一个嵌在页面里的窗口」；
`max-height + overflow:auto` 那条内滚动条更把它坐实成子窗口。

**修法**：去掉边框／底色／内边距与两处 `max-height`，标题行降成状态行的样子；
那行「它正在跑（这一回合是在别处起的）」与「停止」键**都留着**——它们是用户判断
「这一段还在跑、而且不是我在这个窗口里起的」的唯一凭据。
**本刀真正的风险不是删 CSS**：`paintLiveTurnCard` 每 3 秒把正文整份 `replaceChildren` 换一次，
修前那个 `max-height` 把高度变化关在盒子里、页面高度不变；去掉之后每一拍都会改变页面总高。
必须用既有的 `captureScrollAnchor` / `restoreScrollAnchor`（`turn-narrative.js:133/146`）把那次替换包起来，
与它旁边已有的 `captureOpenDetails` / `restoreOpenDetails` 同一条纪律。

#### 本轮的横向账：注释写了纪律，代码没照做

四条里有**三条**是同一个形状——**注释是设计意图的存档，代码漂移之后没人回头对账**：

| 注释说 | 代码实际 |
|---|---|
| `steward-board.js:37`「行数据在…焦点事件…各刷一次」 | 焦点事件那一刷从来没有 |
| `13g-steward.js:1852`「`/api/missions` 里它就是一条派生行」 | 它根本不在那份行里 |
| `chat-live.css:255`「虚线框是刻意的，一眼看出还没定稿」 | A7 之后正文已同源，框只剩「窗中窗」这一个读法 |

**可以直接用的纪律**：注释里凡是出现「唯一判据／恒／一定／就是」这类**断言式**说法的，
都应该有一条真断言钉着它；**没有钉着的，就是下一个洞**——它坏掉的时候不会有任何人发现。
（同一条纪律的另一面见 30 号文 §8.13：锁不要钉「文本长什么样」，要钉「哪件事必须成立」。）

#### 派单（四刀并行，文件互斥）

| 刀 | 面 | 独占文件 |
|---|---|---|
| 117r-D1 | 速查线程进不了看板 | `src/06i` `src/13e` `src/13i`（＋build 产物与生成器链产物） |
| 117r-D2 | 焦点事件不刷行 | `public/js/steward-board.js` ＋ 它的两件 e2e |
| 117r-D3 | 预判 chip | `public/js/steward-composer.js` ＋ `css/views/steward-*.css` ＋ 四份 locale |
| 117r-D4 | 在途回合的框 | `public/js/session-experience.js` ＋ `css/states/chat-live.css` |

D3 与 D4 都改 CSS，而 `dev-harness/read-frontend-css.js` 的 `LEGACY_STYLES_SHA256` 是**全部 CSS 层的
载荷哈希**——两刀都去重钉必然撞车。**两刀一律不碰它**，由主会话在两刀都落地之后统一重钉一次，
理由一并写在那里（先例：117n-M1③ 与 117o-A7 各自重钉时的写法）。
在这两次提交与重钉之间，`live-full-text.static.e2e.js` 的 F3 与 `frontend-domains.static.e2e.js`
的同款锁**预期为红**——这是已知且有界的，不是新债。

#### 交付记录（2026-09-08 夜 → 09-09；主会话逐条亲验，不采信执行者自述）

| commit | 刀 | 主会话怎么核的 |
|---|---|---|
| `3143101` | D1 速查线程进看板 | 自己起真服务器跑它新加的 `steward-quickask-board.e2e.js`：两个方向都钉（速查线程**在**、用户自己的普通会话**不在**）。依赖图 `forwardEdges 67 → 67`。 |
| `5500028` | D2 焦点事件 | 读 diff 确认弱化抄写件已删、「未核实」是**有界**的（一次刷新后交回原判据）。 |
| `5a3521a` | D4 去框 | 亲看两张截图：在跑中与跑完后除那一行状态字／停止键／`◐` 头像外看不出是两种东西。`live-full-text.static` 除预期的 F3 外全绿。 |
| `925ad12` | D3 预判 chip | 亲看宽屏与窄屏两张截图：chip 独占一行、省略号截断、`×` 在、输入框内容完整。`steward-conversation.static` ALL PASS。 |
| `f9718fd` | D5 速查是 kind 不是 state | 亲跑真值表与真服务器件；实测三支入参出参对照表（普通会话逐字节不变）。 |
| `21ffcb2` | 主会话收尾 | 13g 兜底支补 `factsUnknown`、重钉计数锁并补真伴随、README 门面数字回真值。 |
| `72873e4` | 主会话 | 统一重钉经典样式载荷锁（D3／D4 同波各改一个所有权层，联合哈希两边各钉必撞车）。**反向验证**：往 `chat-live.css` 追加一条无关规则 → F3 当场红；还原后字节相同、两个消费者都 ALL PASS。 |

##### 一条决定性的证据（值得单独记）

我诊断 ③ 时断言「你截图里那条在跑却不显示的线程是 `steward_quick_ask` 开的速查线程」。
证据不是推理，是**数出来的**：截图标题栏那串被截断的问题**正好 80 个字符**，
而 `13g-steward.js:1841` 就是 `title: question.slice(0, STEWARD_TITLE_MAX)`、`STEWARD_TITLE_MAX = 80`。
（同名常量在前端 `steward-conversation.js` 是 24 —— 两个不同的 80/24 同名常量本身也是一笔待还的账。）

##### 派单稿被执行者证伪的一处（记下来，是我的错）

D4 的派单稿里我指定把滚动锚点包在 `paintLiveTurnNarrative()` 那次 `replaceChildren` 上。
**执行者拒绝了并给了理由**：同一拍还会改 `cut/body/tool/iter` 四处文本，而**没有账本时
`paintLiveTurnNarrative` 根本不会被调用**（`segments.length > 0` 短路），那时 `body` 就是全部正文 ——
括号开在 narrative 那一层盖不住 A5 这条回落路径。它把括号开在 `paintLiveTurnCard()` 外层。
**它是对的。** 这是本波第二次「执行者顶回派单稿的事实断言」（第一次是 117q-B5 拒跑
`tools/gen-manifest.js`），与 30 号文 §8.12 第 3 条记的是同一件事：**执行者拒绝执行比完成度值钱。**

##### 一处如实记下的「我的断言没能证明我想证的」

D4 的反向验证里，S3（滚到中间等两拍、视口原地不动）在今天的 Chromium 上**不区分** ——
新正文全长在视口下方，`replaceChildren` 一次性替换、中途不强制布局，`scrollTop` 不会被 clamp，
所以「中间」这个姿势本来就不动。真正咬住「缺锚点」的是 S4（在底部要继续跟随）。
执行者把这一点写进了断言旁的注释并保留 S3 作将来的回归门。**这种「我的断言没能证明我想证的」
如实说出来，比让四条都绿有用。**

##### 本波自己又制造了三条「钉字面量」的锁（登记，待还）

30 号文 §8.13 刚写完「锁不要钉『文本长什么样』，要钉『哪件事必须成立』」，
本波新加的断言里就有三条是钉源码行的（`steward-conversation.static.e2e.js` 的 D9b／D9c，
以及既有的 D6b）。更值得记的是**因果方向**：D6b 逐字钉死了
`label.textContent = t('stewardShell.compose.targetSteward.hint', { title: hint.title });` 这一行，
于是 D3 为了不改它，把截短写成了「先 mutate `hint.title` 再渲染」——
**代码的形状是被一条测试字面量决定的**。行为层的那条真断言（真浏览器里 chip 文本必须等于
`stewardShortTitle(长标题)`）已经在，所以这三条源码锁是冗余的。
本波不动它们（断言只加不改，且 D5 在途），**登记为下一批的清理项**。


##### ⑤ 这一条是 ③ 的第二半，D1 落地之后才露出来（117r-D5）

D1 让速查线程进了看板，**露面之后它不会说话**：`quick_ask` 是「这条线程是什么」（kind），
却被当成「它在干什么」（state）塞进五态 —— 一条速查线程在跑、在等你、还是三小时前就跑完了，
**永远只说「速查中」**。三条后果：状态行数不到它（「0 条在跑」对「在跑 1」——**用户报的那个打脸还在**）、
组标题写「已停工」而组内行写「速查中」、一条**正在问你**的速查线程既不进「N 条等你」也不会被选成
「现在这一件」。

修法（不是删逃生舱）：**守卫从「是不是速查」换成「调用方有没有事实」**（默认「有事实」）。
有卡片的线程走完整五态；13d 那条**刻意不读会话头**以省 I/O 的兜底支显式说「我没有事实」，
输出逐字节不变（否则用户 96 条普通会话全被说成「交办中」，那是把一个谎换成另一个谎）。
速查身份降成看板行上的一枚徽标，复用既有键 `mission.state.quick_ask`，零新 locale 键。

**收尾时补了 D5 自己如实报上来的残留**：`13g-steward.js` 的 `steward_threads_search` 还有一条
同形的兜底支（没有卡片、一个事实都不喂），改完会说出「交办中」。已补 `factsUnknown: true`。

##### 一条我自己写出来的假绿断言，被反向验证当场抓住

收尾时我给「明说没事实的调用面」补了一条更强的伴随断言（不许一边说没事实、一边把真事实喂进来）。
**第一版是假绿的**：补丁脚本把正则里的 `\b` 写成了**字面退格符 0x08**，
`/\b(activeTurn|turnSeq)\b/` 实际是 `/^H(activeTurn|turnSeq)^H/`（`^H` 就是那个退格符）—— 永远匹配不上任何东西，
而 `sed`／`grep` 把它显示成空白，**肉眼看源码完全正常**。
是反向验证（故意塞一处违规、确认它真的红）把它抓出来的：它纹丝不动。

> 这条比它守护的那个 bug 更值得记：**一条不会红的断言，比没有断言更糟** ——
> 没有断言至少没人以为这里有人看着。所有「新加断言必须反向验证」的纪律，
> 挡住的正是这一类：写的时候以为在守门，实际上门是画上去的。

##### 计数锁又一次把正确的修改判成违规

D5 那条「`factsUnknown: true` 在 `src/` 里有且仅有 13d 一处」的锁，在我给 13g 补上同形兜底支时红了。
它钉的是「今天有几处」，而不是「什么必须成立」—— 与 §8.13 记的是同一个模具（那里钉的是文本，这里钉的是计数）。
已改成白名单 ＋ 那条真正的伴随断言。**本波第三次遇到同类**（前两次：D3 被字面量锁逼成
「先 mutate 再渲染」、两条钉死用户可见文案／变量名的断言）。

### 11.13 117s 设计页 · 用户第九轮走查（2026-09-09 上午，五张截图，七条；Fable 设计与验收，Opus 实现）

| # | 用户原话（编号沿用） | 定性 | 刀 |
|---|---|---|---|
| ① | 递话给已有线程也不会自动打开线程详情页 | 一直存在；117r-D2 只修了「新线程」那一半 | 117s-B |
| ② | 管家开的线程，打开 2.0 详情页能正常打开到这个会话线程吗，能正常插话吗 | 验证题，不是 bug 报告 | 117s-D（只验不改） |
| ③ | 在运行中的线程，最好能自动排到最前面 | 一直存在（服务端只按 `updatedAt` 排） | 117s-A |
| ④ | 给已收工的线程重新递话，「它刚说」更新不够及时 | 与 ① 同根 + 空闲节拍 15 s | 117s-B |
| ⑤ | 线程标题概括就是管家发的提示词本身，太长了，根本不对 | 116-5 的一条设计假设在真机上不成立 | 117s-A |
| ⑥ | 管家权限想进一步拓展，比如由管家判断线程任务的工作区 | 设计题，撞 §3.5 禁区，**要拍板** | 117s-E（待拍板） |
| ⑦ | 管家交互界面优化；返回消息没有区分、有点长；输出要支持 markdown、制图 | 一半是缺一个已有渲染器，一半是设计题 | 117s-C（markdown＋来源区分）＋ 117s-F（待拍板） |

#### 证据（读用户真机 `~/.win-claude-workbench`，不看截图猜）

- **决策账本** `steward/decisions-v1.ndjson` 最后四条：`02:17`／`02:18` 两次 `steward_thread_continue → sess_8bb0…`（博纳影业）、
  `02:21` 一次 `→ sess_d9de…`（你帮我看看当前进度）、`02:26` 一次 `steward_quick_ask → sess_23ed…`。递话**确实执行了**，且
  `stewardImplThreadContinue` 的回执带 `sessionId`（`13g:1084`），前端 `executedThreadSessionId()` 的开线程工具表里也**有**
  `steward_thread_continue`（`steward-conversation.js:58`）—— 所以 ① 不是「没发焦点」，是焦点落到了一个**已经开着同一条线程**的抽屉上。
- **会话头**：管家开的四条线程里，`steward_thread_new` 开的两条（大A、博纳）**`titleSource:'user'` 且 `threadBrief:null`**；
  `steward_quick_ask` 开的 `sess_23ed…` **有** `threadBrief`（「Ruyi 工作台推进状态盘点」），但 `title` 是提示词前 80 字，
  截图里看板显示的正是那 80 字。四条线程的 `cwd` **全部**是 `defaultWorkspace`（`ruyi-workbench-oss`），包括两条股票问题。
- **配置**：`stewardProviderId=deepseek`、`stewardThreadBriefV1=true`、`stewardPollMs=15000`；`workspaces` 4 条、`recentWorkspaces` 7 条
  （里面有 `stock-monitor`、`free-stockdb`）。日志里**零** `thread_brief_failed`。

#### 根因（逐条）

**① ④ 同根：焦点落在「已经是当前线程」上时什么都不做。** `steward-board.js:609 syncNow()` 的最后一行是
`if (drawer.currentSessionId() !== focusId) drawer.openThread(focusId)` —— 相等时**跳过**，没有任何刷新。
而 117r-D2 修的是「行里还没有它」那一半（新线程）。递话给已有线程时：焦点事件到了、`pinnedId` 设了、`rows` 刷了、
抽屉却原样不动，用户看到的还是「已收工」与旧的「它刚说」。接着抽屉自己的轮询（`steward-drawer.js:939`）按 `isLive()`
判节拍：线程刚收工时它不 live → 走 `stewardPollMs`（用户是 15 s）→ 递话之后第一拍最长要等 15 s 才发现它又活了，
之后才切到 5 s。抽屉 API 上**已经有** `refreshOnce()`（117m-A2 加的，`:922`，正是「右栏已经开着同一条线程」那种情形）。

**③：`/api/missions` 的行与组只按 `updatedAt` 排。** `13d:678`（组内线程）与 `13d:705`（组）都是
`String(b.updatedAt).localeCompare(a.updatedAt)`；看板只在从「N 条等你」跳过来时临时把等你的行提前（`steward-board.js:474-480`）。
一条在跑的线程只要 `updatedAt` 比一条刚收工的旧，就排在下面 —— 截图 1 正是这样（「已收工」在上、「进行中」在下，都是 20 s 前有动静）。

**⑤ 有两个子根因，一个是设计假设错了，一个要复核：**
- 5a `steward_thread_new`：`13g:974` 把模型给的 `args.title` 交给 `createSession`，`02:2581` 见非占位标题即写 `titleSource:'user'`，
  于是 116-5 的自动摘要**永远不跑**。§11.8.4 写的是「thread_new 那边不清：args.title 是管家【有意】起的名字，与改名同一性质」——
  **真机证明这条假设不成立**：模型并不是在起名，它把用户那句话原样抄进 `title`（「大A接下来的走势会怎么样」）。
  工具 schema 还在鼓励它这么做（`13f`：「可选。线程标题；省略则由首条消息自动命名」）。
- 5b `steward_quick_ask`：摘要**生成了**，看板却显示 80 字原话。`displayTitle` 的装配链（02 `sessionDisplayTitle` → 13d `buildMissionCard`
  → 13e 卡片索引 → 看板 `row.displayTitle || row.title`）**要逐段复核是哪一段没把摘要带出来**——候选：13e 的派生索引在摘要落盘
  （`updateSessionMeta`）后没有重算；或看板那一拍取的是摘要落盘前的快照且之后没再刷。不许猜，用真服务器 + 假端点回固定 JSON 复现。
- 另：速查线程的 `title` 是**管家写给线程的提示词**（`question`）前 80 字，本来就不是给人看的；`STEWARD_TITLE_MAX` 后端 80 / 前端 24 两个同名常量（§11.12 已登记）。

**⑦（可以直接做的那一半）：管家壳没有 markdown 渲染器。** `steward-conversation.js:20` 的纪律是「零 innerHTML，全部 textContent」，
于是模型写的 `## 结论先行`、`**偏空**` 原样上屏（截图 2、4）。全仓**唯一**的 markdown＋XSS 净化路径是
`chat-render-primitives.js` 的 `renderMarkdownInto(container, text)`（`:175`，innerHTML 赋值**只**在它里面）＋ `highlightIn()`
（代码高亮＋mermaid 懒加载 —— 用户说的「制图显示」它已经会）。组合根 `app.js:244/235` 手里就有这两个函数，
经典壳的六个消费面都是注入拿到的（§5「renderMarkdown／escapeHtml」行）。管家壳要的不是新渲染器，是**同一条注入线再接一根**。
静态锁不挡：`steward-conversation.static` A2 只要求 import 是 `./` 相对路径，注入不是 import；「零 innerHTML」扫的是管家文件自己的源码。

**⑥ 撞的是 §3.5 的禁区，不是一个开关的事。** `06i:721` 把 `defaultWorkspace / workspaces / recentWorkspaces / additionalDirectories /
allowOutsideWorkspace` 列在管家配置的 **forbidden** 档（数据根／围栏）—— 管家既读不到工作区清单，也不该能改围栏。
今天 `steward_thread_new.cwd` 的 schema 只说「省略则用全局默认工作区」，模型没有任何可选项，于是**四条线程全落在代码仓库里**。
「由管家判断工作区」正确的形状是：**管家在服务端给的候选里选，服务端校验；管家永远碰不到围栏本身**。这条要拍板（见 §11.13.E）。

#### 定案（D1–D5，本轮直接做）

- **D1（③，服务端单点）**：`/api/missions` 的行与组改成「**状态优先、其次 `updatedAt`**」的稳定排序，秩为
  `needs_you > running > dispatching > done/stopped`（`quick_ask` 是 kind 不是 state，按其真实五态归位，117r-D5 已经这么做了）。
  组的秩取组内最高秩；组内线程同规则。**只在 13d 一处排**，看板／抽屉页签／「现在这一件」全部消费同一份行序；
  `steward-board.js:474-480` 那段「等你优先」的临时排序保留不动（它是用户点了「N 条等你」的即时意图，与常态行序是两件事）。
  行指纹（`13d:709-711`）要把秩纳进去，否则状态变了而 `updatedAt` 没变时 ETag 不失效。
- **D2（⑤a）**：`steward_thread_new` 传进来的 `title` **不再**算作用户起的名字。写成 `titleSource:'steward'`（02 白名单加这个字面量；
  `sessionDisplayTitle` 的优先级改为 **user > threadBrief > steward > 原话**），摘要照常生成（`threadBrief` 的跳过判据只认 `'user'`）。
  13f 的 `title` 描述改成「可选。你给线程起的**短名**（≤24 字），**不要**把用户的话或委托书抄进来；不确定就省略，工作台会自动起名」。
  `steward_thread_rename` 与用户手改仍写 `'user'`，一字不动。
- **D3（⑤b）**：先复现，后修。修在**装配链上那一段**（02／13d／13e 之一），不在前端补第二份判据（§11.8.5 的纪律）。
  速查线程的 `title` 维持「问题原话」（管家和搜索要认它），只保证 `displayTitle` 在摘要落盘后**下一次读**就是摘要。
- **D4（① ④）**：`syncNow()` 的相等分支改调 `drawer.refreshOnce()`；`refreshOnce` 里把 `lastPollAt` 归零而不是设成 now
  （现在是 `= Date.now()`，等于把下一拍又推后一个节拍）。抽屉那一拍若发现 `resumable.live` 由假变真，同拍重拉事项切片
  （与已有的「真→假」那条对称，`:946`）。**不改轮询表**（C1/C3b 锁死一处 `setInterval`），只改「这一拍拉不拉」的判据。
- **D5（⑦ 前半）**：`app.js` 把 `renderMarkdownInto`／`highlightIn` 注入 `createStewardShellDomain`，shell 转注入 `createStewardConversation`；
  管家的 `say` 用它渲染（缺席时回落 `textContent`，Node 里的静态锁 `await import` 因此照常通过）。
  `※` 里的 `why` 与行动行**仍是纯文本**（它们是机器回执，不该被 markdown 吃掉）。
  **来源区分**：`message.steward.trigger` 已经落盘（13h 的 `stewardStampReply`）—— 收件箱触发（线程 done／needs_you／failed）
  的那条回复，在气泡顶加一枚「来自线程『X』」的小头（`displayTitle`，点它 = `steward:focus-thread`），
  用户自己问的那条不加。这就是用户说的「没有任何区分」。**不做**长度压缩（那是提示词层的事，进 F）。
  CSS：`.steward-msg-ruyi` 内的标题／列表／表格／代码块／mermaid 容器样式，跟 `chat-*.css` 的同名规则**同源取值**，不新配色。
  `LEGACY_STYLES_SHA256` 由本刀自己重钉（本波只有它改 CSS，不撞车），写明理由。

#### 派单（四刀，文件互斥；与在途的 117q-§8.14 那刀（41 件 e2e 的 `timeout:` 行）互不相交）

| 刀 | 面 | 独占文件 |
|---|---|---|
| 117s-A | D1＋D2＋D3 | `src/02` `src/13d` `src/13e`（若 D3 落在它）`src/13f` `src/13g`（＋build 产物、生成器链产物、durable-state 清册）；**新建** e2e `dev-harness/steward-thread-order.e2e.js`、`steward-thread-title.e2e.js` |
| 117s-B | D4 | `public/js/steward-board.js` `public/js/steward-drawer.js` ＋ `steward-board.e2e.js` `steward-drawer.e2e.js` |
| 117s-C | D5 | `public/app.js` `public/js/steward-shell.js` `public/js/steward-conversation.js` `public/css/views/steward-conversation.css` 两份 locale ＋ `steward-conversation.static.e2e.js` `steward-conversation.e2e.js` ＋ 重钉 `read-frontend-css.js` |
| 117s-D | ② 验证 | 不改代码；真浏览器复现并交截图与结论 |

顺序：A／B／C 并行（文件互斥），D 与 A 并行。**A 改 `src/`，生成器链由 A 在最后一次 `src/` 改动后整条重跑**（§8.7）。

#### 验收口径（Fable 亲自复核，报告里的「已验证」全部重跑）

- D1：真服务器、两条会话头（一条旧 `updatedAt` 在跑、一条新 `updatedAt` 已收工）→ `/api/missions` 在跑的在前；ETag 随状态变化失效。
- D2：真服务器、假 OpenAI 端点回固定 JSON → `steward_thread_new` 带 `title` 开的线程 `titleSource==='steward'` 且 `threadBrief` 落盘；
  `displayTitle` 是摘要；`steward_thread_rename` 之后变 `'user'` 且摘要不再覆盖。
- D3：速查线程摘要落盘后，`GET /api/missions` 的那一行 `displayTitle` 是摘要（不是 80 字原话）。
- D4：夹具里递话给「抽屉正开着的、已收工的」线程 → 5 s 内「它刚说」换成新一回合的话、状态行由「已收工」变「在跑」。
- D5：`say` 里的 `## / ** / 列表 / 代码围栏 / mermaid` 真浏览器截图；`<script>`／`onerror=` 注入被净化（复用经典壳同一条断言的写法）；
  收件箱触发的回复带「来自线程」小头且点击聚焦。

#### E／F 两条要拍板的（不拍不做）

**E（⑥ 管家判断工作区）**——建议形状，三条一起拍：
1. **管家只能选，不能改围栏**：每个管家回合的上下文里给一张只读的「可用工作区」表（`config.workspaces` 的路径＋末段名＋一句用途
   —— 用途来自一个新的可选字段 `workspaces[].note`，用户在设置里写「股票资料」「小说」之类；没写就只有路径）。
   `steward_thread_new` / `steward_quick_ask` 的 `cwd` schema 改成「必须是上表之一；与任何工作区都不相关的问题（行情、写作、闲聊）
   用 `~`」。**13g 校验 `cwd ∈ workspaces ∪ {homedir}`，不在表里的一律拒绝**（`invalid_request`，不静默回落）。
   `recentWorkspaces` **不**进表（它是用户打开过的目录，不是授权过的目录）。
2. `defaultWorkspace / workspaces / recentWorkspaces / allowOutsideWorkspace` **继续留在 §3.5 forbidden 档**，一个字不动。
3. 「进一步扩展管家的能力面」这句话太大，本波只做工作区这一件；别的（比如让管家改线程的模型档、改权限档）**今天已经有**
   （`steward_thread_permission`、`tier` 入参），先看用户用起来缺什么再加，不预铺。

**F（⑦ 后半：界面整体优化＋回复太长）**——建议先做三件小的，再决定要不要大改：
1. 管家回复的**长度**是提示词层的事：06b 的管家系统层加一条「先一句结论，再最多三条要点；细节交给线程页」的写法约束，
   ＋ `STEWARD_SAY_MAX` 从现在的值再压一档（要先量真机最近 30 条回复的长度分布再定数）。
2. 气泡**分层**：结论句加粗成首行（模型已经在这么写，D5 渲染出来就有了）；行动行折进 `※`（今天已是）；线程转述带「来自线程」小头（D5）。
3. 不在本波重排整个对话区的布局（头像／输入区／看板三栏）——用户第五轮（117l-B2）刚拍过一次，没有新证据说明它错了。

拍板项：E 的三条按建议做不做；F 只做 1、2 还是要一次大改。

#### 11.13.1 用户第二轮回话（2026-09-09 上午）：E 要想得更宽，F 要大改

**用户原话**：「E 其实我指的不只是这一方面，还有没有别的方面可以给管家放权的……甚至不必只限制在管理 Ruyi 上」；
「F 我觉得这个要大改出设计，可能最好不同线程的可以临时区分一下」。

##### E · 放权矩阵（八根轴，每轴推一格；两条不放）

前提：管家自己**没有**文件/shell/桌面/联网工具，唯一「动世界」出口是开线程（`13f` 里 `steward_thread_new` 的 schema 原话）。
所以放权不是加工具，是沿八根轴各推一格：

| 轴 | 今天 | 放一格 | 红线／档位 |
|---|---|---|---|
| 时间（主动性） | 只在用户说话或收件箱来事时醒 | `steward_schedule`：定时与守望（「每天 9:25 跑 A 股计划」「博纳那条跑完叫我」）；接 119 波 Cron | 全自动档才能自建定时项；进决策账本、可整单撤 |
| 眼睛（只读世界） | 查任何东西都要开速查线程等一回合 | 一小组只读工具直接给管家：`web_search`／`web_fetch`／工作区内 `file_read` | **污染规则**：一回合里读过外界内容，本回合所有写动作降级为提议——防网页里的指令借管家的配置权做事 |
| 手（动世界） | 经线程；cwd 恒为默认工作区 | 工作区在只读候选表里选（13g 校验）；按任务给线程开桌面权限（`steward_thread_permission` 已能改档） | 围栏字段留 forbidden；管家永远不直接拿桌面工具 |
| 嘴（外联） | 只在壳里说 | 叫用户：系统通知／IM 渠道（relay channel 基座）；反向：IM 上回一句等于在壳里说了 | 只在等你／失败／完工三类事上叫；沿用 12/小时熔断 |
| 代答 | 问题一律转用户；等批准绝不代答 | 半自动：答案在记忆/委托书里的**问题**可代答留痕；全自动：白名单内的权限可代批 | 白名单为空＝不代批；必留痕、必可撤 |
| 钱 | 管家有日熔断；线程按档选模型 | 给管家一个日信封：信封内可给线程升档/续跑 | 与自身熔断分开记账（116-5 纪律） |
| 记忆（关于人） | 有写/搜/否决 | 主动记偏好与固定资产（持仓、常用目录、常用网站） | 只记用户看得见的条目；不记密钥类 |
| 编排 | 一条条开线程 | 沉淀 playbook 并自己触发；线程接力（A 完自动喂 B） | 自动触发只在全自动档 |

**不放**：管家自己不碰世界（手永远经线程）；围栏与密钥永远 forbidden。
**按该用户实际用法先放三格**：时间 → 嘴 → 眼睛（带污染规则）。工作区选择随「手」顺带。

##### F · 界面方向：「线程即频道」

设计稿（三块画板：宽屏 1440 / 窄屏 390 / 一条回复的解剖）：<https://claude.ai/code/artifact/5a93ce50-f92e-4200-947b-7bb20dbea57d>
取值全部来自 `tokens.css` 与 `color-schemes.css` 浅色档；线程色卡是新加的四色（同明度同饱和度只换色相）。

- 每条管家消息归属一条线程（或「管家本人」）：左侧色条 + 线程名；连续同一线程的话合成一张**线程卡**（头：名、五态、最后动静、模型）。
- 顶部**频道条**：点一条＝只看这条（临时过滤，再点取消）——这就是用户说的「临时区分」；输入框目标 chip 跟着切。
- 右栏从「现在这一件」变成「现在这几件」：按 D1 的服务端序叠小卡；等你的可**就地回答**；已收工折成一行；看板退成「全部线程」。
- 回复定型：结论首句抬成标题 → 正文 markdown（117s-C）→ 超 8 行折叠 → `※` 纯文本默认折叠 → 动作按钮。
- 头像、状态行、盾牌保留（9-03 拍板）。

**实施切片（待用户看稿后再派）**：F1 线程卡＋色条＋来源头（在 117s-C 的小头之上）；F2 频道条过滤＋目标 chip 联动；F3 右栏线程叠＋就地回答；F4 折叠与首句抬题。四片都只动前端。

##### ② 的验证结果：真 bug，登记为 117s-G（待 A 出门后派）

真浏览器复现（HEAD `97d072c`，两次结果字节相同）：**2.0 视窗能正确打开管家开的线程**（壳切经典、会话对、返回带在、活回合卡在），
**但在它跑着的时候插话会静默杀掉正在跑的回合**：`turn_start seq=1 → turn_kill reason:"superseded" → turn_start seq=2`，
第一回合只剩用户消息、没有助手消息，界面零提示。根因两处：`chat-stream-runtime.js:529/537` 只认本页自己起的流（`activeTurns`），
管家起的回合不在里面，于是不走 `steerPrompt`，按钮也还写「发送」；`09-workflow.js:1347` 对任何在跑回合无条件 `stopSession('superseded')`。
另：`/api/sessions/:id` 信封里**没有** `steerable/steerReason`（那两个在事项节点上，§11.13 表里写错了）。

修法（执行者提的，我认可）：不新造判据——`13h stewardRelayChannelFor`（answer > permission > queued > steer > turn）已是唯一判据，
让会话信封带出 `relay:{channel, wait?}`，经典壳按它路由（steer → `steerPrompt`；queued/permission → 提示不发；idle → 正常回合），
`updateSendBtn` 读同一字段（卡在屏上时按钮写「插话」）；`09-workflow.js:1347` 作后备：不是同一客户端起的回合一律回 busy 信封而不是杀。

##### F 追加（用户看稿后，2026-09-09）：图标重设计 + 撤回文字的显示问题 → 切片 F5

用户原话：「设计稿挺不错的……图标 icon 什么的也可以重新设计一下，尤其是那个权限管理和停止，包括撤回现在文字的显示似乎也有点问题」。

**证据**：头部两枚常驻控件是 `index.html:612` 的盾牌（`stewardShieldBtn`，新线程默认权限档，点开四档菜单）与 `:615` 的停机键
（`stewardStopBtn`，`steward-settings.js:95 ICON_STOP = 圆 + 方块`）—— 后者读作「录制／靶心」，与线程「停止」（`icons.js:37` 实心方块）
同形不同义。撤回按钮（`steward-conversation.js:871` `button('steward-act', …)`）**没有任何专属样式**（`css/` 里零 `.steward-undo` 规则），
倒计时靠每秒把整段文字换成「撤回 9」「撤回 8」…（`:830/:834`，locale `stewardShell.chat.undoCountdown = "撤回 {{seconds}}"`），
数字跳、按钮宽度跟着跳，到期又无声地变成「换一条」（`:883`）—— 三个状态之间没有任何视觉过渡。
（用户没给撤回状态的截图，这条是从代码推的；F5 派单前请用户确认「显示有问题」指的是不是这个。）

**定案（进设计稿「图标集」画板）**：
- 权限：盾牌保留为家族标，**四档画在盾里**（问号／铅笔／清单线／闪电），头部控件改成「盾＋档位名＋▾」的胶囊——图标不再要求人猜。
- 停机 ≠ 停止：**电源符号**只给「管家停机／唤醒」（已停机＝加一道斜杠），线程「停止」沿用 `icons.js` 的实心方块。
- 撤回：倒计时画成**环**（SVG 弧随秒数消退），文字固定「撤回」；到期变「⇄ 换一条」；成功退成「✓ 已撤回」一句灰字。
- 五态各配一枚图标进状态药丸（在跑／等你／已收工／失败／排队）；线程色条只表示「是哪条」，不表示状态——两套信号不混用。
- 抽屉与线程叠的动作全部配图标（发给它／插话／暂停／继续／停止／整单回退／交回管家／2.0 视窗／看全文／看改动／打开／只看这条），
  全部 24px 网格、1.75px 线、`currentColor`，与 `icons.js` 的单线语言同构；**落地时进 `icons.js` 的 `ICONS` 表**，管家壳从那里取，
  不在 `steward-settings.js` 里再写第二份路径常量（今天的 `ICON_STOP` 就是一份孤本）。

**切片 F5**（只动前端）：`icons.js` 加图标 → `steward-settings.js` 头部两键改用 `icon()` ＋ 档位名 → `steward-conversation.js` 撤回三态 ＋
`steward-conversation.css` 新增 `.steward-undo-*` → 抽屉／线程叠按钮加图标。静态锁：`steward-settings.static` 若钉了 `ICON_STOP` 字面量要重钉为
「停机键与线程停止用的不是同一枚图标」这种可成立的事实。

#### 11.13.2 交付记录（2026-09-09；主会话逐条亲验，不采信执行者自述）

| commit | 刀 | 主会话怎么核的 |
|---|---|---|
| `d096cef` | 117s-A（D1 行序、D2 管家标题、D3 复现） | 亲跑两件新 e2e：`steward-thread-order` 24/24、`steward-thread-title` 26/26（**第一次并跑两遍时 D2b/D3 红，单跑全绿**——它等摘要异步落盘，对负载敏感，先登记为抖动候选）；`build --check` 新鲜；`forwardEdges 67 → 67`；13d 的 diff 亲看：三处排序全改、指纹纳秩。 |
| `fe67ea3` | 117s-B（D4 焦点刷新与节拍） | 亲跑 `steward-board.e2e` 69 PASS，新加的 R4/R4b/R8/R8b 逐条绿（实测 3492 ms / 118 ms）；五个文件与它自述一致。 |

##### 两处派单稿被执行者证伪（记下来，都是我的错）

1. **D1 我只指了 `13d:678/705` 两行**——那是 `buildMissionAggregateRows`，喂的是 `steward_missions` **工具面**；看板真正吃的是
   `handleMissionsApiRoutes` 里 `13d:772` 那次 `missions.sort`。只改我指的两行，「在跑的排前面」在工具面成立、在用户屏幕上仍不成立。
   执行者三处都改了，并把秩写进 ETag 指纹。
2. **D4 我说「①④ 同根：`syncNow()` 相等分支什么都不做」——只对了一半。** `steward-drawer.js:1107` 抽屉自己也听 `steward:focus-thread`
   并无条件 `openThread`，所以递话触发的焦点事件抽屉**是**会重读的。执行者把只改相等分支的第一版测试跑出**假绿**后重写了根因：
   真正过期的是 ㈠ 强刷读得太早（回合还没登记）且 `refreshOnce` 把 `lastPollAt` 记成当下、把下一拍推走整个空闲节拍；
   ㈡ 看板行「打开」那一路**不派事件**，右栏已开着同一条时抽屉一次都不刷。修法相应改成：相等分支只在 `focusRequest` 时强刷
   （无条件会把抽屉拉取率绑到看板节拍）、强刷后 `lastPollAt = 0`、live 假→真同拍重拉事项切片（与既有真→假对称）。

##### D3 的复现结论（A 刀）

**服务端不 stale。** 真服务器种一条 80 字速查头 → `PATCH threadBrief` → 下一次 `GET /api/missions` 的 `displayTitle` 就是摘要
（`updateSessionMeta → saveSession → markPretenderIndexDirty`，02:2537）。用户真机那条头 `threadBrief.at 02:27:09` 早于 `updatedAt 02:29:11`
且没有 `titleSource`——服务端读回来一定是摘要。**屏幕上的 80 字是客户端刷新问题**，B 刀的强刷与 5 s 复核覆盖它；
A 仍加了服务端回归锁（title e2e 的 D 段）。

##### 登记

- `steward-runner.static.e2e.js` ① 「13g ≤ 2000 行」在 HEAD 上已红（2005），A 的 3 行到 2008。拆 13g 是另一刀，本波不动。
- `steward-thread-title.e2e.js` 对负载敏感（见上表），进 30 号文 §8.13 ④ 的抖动候选，治理时先跑带完整输出的采样。

#### 11.13.3 用户第三轮回话：「线程的交付管家能不能看全、时机对不对，这个很重要」→ 117s-H

用户拍板设计稿（「设计就这样吧」），并点出一条比界面更要紧的事。先把这条链逐段摸清，再定刀。

##### 链路（读代码 + 读真机 `steward.messages.ndjson` 28 行）

| 段 | 事实 | 位置 |
|---|---|---|
| 何时报「跑完」 | 会话头 `turnSeq` 前进 + 不在 `activeChildren` + 管家发起的线程还要 `stewardLastTurn.seq >= turnSeq`（13g 在 settle 之后落的账）。117p 修过两个吞事件的窗口。**时机是对的**。 | `13i:680-745` |
| `done` 事件带什么 | `payload.summary` = 「线程第 N 回合跑完了」——**不带任何正文**；只有速查线程由 `enrichInboxRows` 补 `answer`（最后一条助手话 ≤1200 字） | `13i:360-385`、`13g:1906-1921` |
| 事件怎么进提示词 | 一行 `- [seq] done · 线程「X」(id) · 摘要`，整行 ≤400 字；`payload.answer` **没有任何渲染点**（13h 里零引用）——速查答案其实也是靠模型再去读 | `13h:922-931` |
| 管家怎么看正文 | `steward_thread_read`：最近 6 回合、≤12000 字、每回合 ≤6 次；行 = 用户/助手正文 + 工具**调用行**（不含工具结果）；超预算从最早的行整行丢 | `13g:712-772` |
| 管家转述上限 | `say` **硬切 600 字**（`String(value.say).slice(0, 600)`，无标记） | `13h:544` |
| 提示词的规则 | 只有「速查答案用我自己的话转述,不复述系统字段」与「更多细节用 steward_thread_read」；**没有「交付」这个概念**，也没有「转述时数字与结论不得改写」 | `06b:152/186` |

**真机（今天上午「A股每日分析」那条线）**：三次 `done` 管家都是 `steward_thread_status` + `steward_thread_read` 之后才转述——**它读了，时机也对**。
但线程第 4 回合的交付 **2687 字**，管家的转述 **407 字**；交付里写着「今日完整快照已落盘到 A股日计…」——那个文件管家**读不到**
（它没有文件工具，`thread_read` 也不带工具结果）。`thread_read` 在真机上零次 `truncated`，`say` 也没撞到 600。

**所以「看不全」不是一个 bug，是三件结构性的事**：① 交付只以「一行摘要」进箱，正文全靠模型自觉去读；② 转述是模型的**改写**，
上限 600 字，用户看到的是二手货；③ 线程产出的**文件**对管家是黑洞。另有一个真 bug：④ `thread_read` 从最早行整行丢，
**最新那一条助手话单独超过 12000 字时 `rows` 直接为空**（`13g:754-758`：循环第一步就 `used > maxChars`，`cut = rows.length`）。

##### 定案（H1–H4）

- **H1 交付进箱（13i/13g/13h/06b）**：管家发起或关心的线程，`done` 事件的 `payload.deliverable = { text: 最后一条助手话 ≤4000 字, chars: 全长, truncated, files: 本回合写过的文件路径 }`
  （文件来自本回合的改动账——13d 已有 `/changes` 与检查点 diff，不新造）。收件箱回合里事件行仍是那 400 字的标题行，
  **正文另起一个受预算的引用块**跟在后面，模型不必再花 `thread_read` 配额。06b 加一条规则：
  「转述交付：一句结论 + 明说『原文见线程卡』；数字、结论、文件名逐字，不改写；有文件就列出来」。速查线程的 `answer` 并入同一形状（今天那份没人渲染）。
- **H2 交付卡（前端，线程即频道的 F1 一部分）**：收件箱触发的那条管家回复，线程卡正文里**嵌线程自己的交付**（该回合最后一条助手话，
  走 117s-C 那条渲染器，超 8 行折叠，「看全文」= 2.0 视窗），管家的话退成交付上方的一两句按语。用户看**原件**，管家只加批注——
  「看不全」从此不依赖模型自觉。数据从 `GET /api/sessions/:id` 现有信封取，**零新增路由**。
- **H3 `thread_read` 整行丢（13g）**：最新一行单独超预算时**截它的尾巴**而不是丢掉；返回加 `clippedRows`；反向验证：种一条 13000 字的助手话。
- **H4 回执带来源（13h + 前端）**：`stewardStampReply` 的 `trigger` 从字符串改成 `{ kind:'inbox'|'user', sessionId?, title?, turnSeq? }`
  （117s-C 发现今天只有两个字，来源小头是从中文事件行里抠出来的）；前端先读回执，抠行法留作老回合的回落。老回合的 `trigger:'inbox'` 字符串仍要认。

**不做**：不放宽 600 字——转述本来就该短，长的是交付本身，交付由 H2 原件呈现。**不给管家文件工具**（E 矩阵「手」那一轴的红线）。

##### 派单（G 出门后；H1/H3/H4 都动 13g/13h，串行一刀，H2 与之并行）

| 刀 | 面 | 独占文件 |
|---|---|---|
| 117s-H-后端 | H1 + H3 + H4 | `src/06b` `src/13g` `src/13h` `src/13i`（＋build、生成器链）；新建 e2e `steward-deliverable.e2e.js` |
| 117s-H-前端 | H2 + H4 前端 | `public/js/steward-conversation.js` `css/views/steward-conversation.css` 两份 locale ＋ 它的两件 e2e（CSS 锁自己重钉） |

验收（主会话亲验）：真服务器 + 假端点，线程回合产出 3000 字并写一个文件 → 收件箱事件 `deliverable.text` 长度与 `files` 对；管家回合的提示词里能 grep 到正文引用块；
前端线程卡里出现原件（h2/li 成 DOM）且折叠；13000 字单条 `thread_read` 返回非空 tail；老回合字符串 `trigger` 仍出小头。

##### C 刀交付记录（补 §11.13.2 的表）

| commit | 刀 | 主会话怎么核的 |
|---|---|---|
| `b134e2a` | 117s-C（markdown ＋ 来源小头） | 亲跑 `steward-conversation.e2e` 83 PASS，S0–S4、T0–T6 全绿；唯一红 **R7** 是 §8.13 ④ 记的那件「3 绿 1 红没抓到断言名」——**名字抓到了：R7**（117l-B2 的分组规则断言，执行者用 HEAD 版原件复现同红，与本刀无关）。`app.js` 1279 行，离 D45 的 1280 上限只剩 1 行。CSS 载荷锁重钉带反向验证。 |

派单稿被证伪第三处：D5 说「`message.steward.trigger` 已经落盘…加『来自线程』小头」——`trigger` 只是 `'user'|'inbox'`，不带线程 id。→ H4。

##### G 刀与 H 前端交付记录（补 §11.13.2 的表；2026-09-09 下午，主会话亲验）

| commit | 刀 | 主会话怎么核的 |
|---|---|---|
| `6990c82` + `7d38ce2` | 117s-H 前端（交付卡 + `trigger` 双形状） | 亲跑 `steward-conversation.e2e` 96 PASS（唯一红 R7）；三件静态锁全绿；`steward-shell.e2e` 全绿；亲看截图：来源小头 → 按语 → 「它交付的原文 · 第 N 回合」卡 → ※ → 动作。它不能碰 `steward-shell.js`，「看全文」直跳 2.0 视窗那一根注入线由主会话补（`7d38ce2`）。 |
| `0530d12` | 117s-G（别处起的回合正在跑时，2.0 视窗里说一句话不许杀掉它） | 亲跑两件新 e2e：`foreign-turn-busy-guard` 20/20（服务端 409 后备）、`classic-window-live-steer` 23/23（真浏览器：按钮写「插话」、走 steer、审计里零 `superseded`）；`build --check` 新鲜；`forwardEdges 67 → 67`；22 个路径与它自述一致，且与 H 前端零交集。 |

##### 派单稿又被证伪三处（G 刀）

1. **`09-workflow.js:1347` 答不了 409**——到那里用户消息已落盘、响应头已出；且它还有一个我没提的孪生 `05-claude-engine.js:139`。
   真正的唯一咽喉是 `10 runSessionTurn`（两引擎共用），后备就放在它 `onStart` 之前：用**既有**的 `turnSettlers[sid].source` 认「是不是同一个客户端」，
   同源照常 supersede（经典壳自己重发那条路一字不动），异源抛 `SESSION_TURN_BUSY_ELSEWHERE` → 13 路由层映成 `session.turn_busy_elsewhere` 409。
2. **「把纯的 state→channel 阶梯挪到 06i」不可达**——阶梯要读 04 的待决、13h 的仲裁队列、09 的 `activeChildren`，06i 一个都看不到（103b 的依赖债上限）。
   仓里已有正确机制：13d 经 `StewardHooks` 迟绑定读 13h 的 `arbiterWait`（`13d:665`），`relayChannel` 是第五个这样的键，零新边，阶梯仍只有一份。
3. **`facts.static` 的「README e2e 总数」在 HEAD 上就红**（325 vs 327），不在任何抖动名单里——G 把它抬到真值 329。

##### 差点重演 117m 事故的一次（记下来）

G 第一次 `git commit` 因参数笔误中止，那一瞬间 HEAD 已从 `fe67ea3` 走到 `7d38ce2`；它的索引是按旧 HEAD 建的，
那次提交若成功会把 H 前端整份回退。执行者自己发现、reset、按新 HEAD 重建索引。**§8.7 的「提交前核 HEAD」不是仪式。**

##### H 后端交付记录（补 §11.13.2 的表）

| commit | 刀 | 主会话怎么核的 |
|---|---|---|
| `4c0c071` | 117s-H 后端（交付进箱 `deliverable{text≤4000,chars,truncated,turnSeq,files}`、`thread_read` 整行丢改截尾、回执 `trigger` 落盘为对象） | 亲跑 `steward-deliverable.e2e` ALL PASS、`steward-inbox.e2e` ALL PASS；`build --check` 新鲜；`forwardEdges 67 → 67`；`files` 来自 02 `foldTurnSummaries`（与 13d 「看改动」同一份折叠，按 `turnSeq` 过滤，零新追踪器）。 |

三处如实记：① 06b 那条「转述交付」规则进了 `rules`（易变补充表）而不是 1–6 稳定表——英文稳定表 2453/2500 只剩 47 字，静态锁 ③ 钉着 ≤2500；
② 内存态 `lastReply.trigger` **仍是字符串**（`steward-shell.js:277` 靠 `=== 'inbox'` 判要不要追加到对话流），只有落盘回执是对象——改内存态会是无声回归；
③ 服务端本来没有任何读 `message.steward.trigger` 的地方，所以「两种形状都认」在后端是空操作，只钉了新旧回执并存不互相破坏。
13g 到 2088 行（锁 ① 红得更深）；R7 执行者用 `git archive HEAD` 干净副本复现同红，DOM 逐字节相同——是夹具形状前提，不是竖线规则。

#### 11.13.4 117s 收口：全量回归与合并（2026-09-09 下午，主会话亲跑）

隔离 worktree、`--parallel 4`：**311 pass / 12 fail / 11 flaky / 323 ran / 7 skipped**。12 条红逐条串行复验后的真相：

| 类 | 件 | 处置 |
|---|---|---|
| 主树才有的 fixture（`realhist-fixtures`），worktree 预期红 | `observation-recall-realhistory`、`observation-recall-replay`、`session-notes` | 合并后在主树单跑（117l 记忆里那条纪律） |
| 4 路负载起不来服务的级联 | `tools-v3`、`perm-v2` | 单跑 ALL PASS |
| 钉字面量／行号／行数的锁被合法改动挪走 | `copy-path-guard.static`（行号 +41）、`steward-walkthrough.static`（E1c 旧行、F1f 1277 行）、`steering-claude` S12（`streaming &&` 字面量）、`i18n.static`（文档目录漏 9 键） | 重钉为「哪件事必须成立」并单跑绿（`a142311`、`61a2126`） |
| 已登记、本波不动 | `steward-runner.static` ①（13g 2088 行）、`perf` ②（冷启动 5 s 断言，30 号文 §8.13 ③ 挂起等拍板） | — |
| 环境 | `eol-policy.static`（`.gitignore` CRLF 是本 worktree autocrlf checkout 产物，master 里的 blob 是 LF） | 主树不受影响 |

11 个抖动件里本波相关的两个（`steward-board`、`steward-conversation`）单跑全绿；`steward-conversation` 的 R7 已定名。

**合并**：分支 `claude/suspicious-cartwright-0bef9d` 全部为线性提交，master 未动，主树 `git merge --ff-only claude/suspicious-cartwright-0bef9d` 即可；
合并后主树跑 `node dev-harness/observation-recall-realhistory.e2e.js` 等三件 realhist 件补验。

### 11.14 117t 交付记录 · 「线程即频道」落地与拆 13g（2026-09-09 下午起，三刀并行）

分工与共享资源归属见 32 号文 §2.2.1。逐刀记录（主会话亲验，不采信执行者自述）：

| commit | 刀 | 主会话怎么核的 |
|---|---|---|
| `242373a` | **F1+F4** 线程卡与回复定型 | 亲跑 `steward-conversation.static` **199 PASS ALL PASS**；提交只含 4 个文件（零 locale、零 `read-frontend-css.js`）；把它新引入的每个 `t()` 键与两份 locale 逐个比对——**全部可解析、零新键**；亲看截图：绿条「大A」卡（五态药丸＋`20秒钟前 · gpt-5-mini`＋打开）、无色条的管家自述（粗体首句＋折叠体＋展开）、珊瑚条「博纳」卡。 |

#### F1 的三处设计取舍（执行者如实报上来的，我认可，登记）

1. **卡与既有分组不冲突，因为它不建新容器**：`markThread` 与既有 `markGroup` 用同一套「只看上一行」的追加式判据，stamp 出 `is-thread/-start/-end`；一段线程 run 恒落在一个说话人组之内，两者撕不开。唯一交互是一行 CSS：有色条的行让出那条淡分组线（与「头像所在那组不画线」同一个理由）。`is-group-start/end` 与间距规则**逐字节未动**。
2. **五态只能给出四态**：卡头的状态来自 `GET /api/sessions/:id` 信封（`relay.channel` > `resumable.live` > 头上的 `stewardLastTurn/turnSeq`），因此能说 needs_you／queued／running／stopped／done，**永远说不出「交办中」**——那要 `mission-state.js` 的判据，而它要事项账本与待决计数，只在 `/api/missions` 的卡上有，那条路由归 F3 的看板。信封没说的时候**药丸整个不画**，不猜。这是对的：宁可少说一态，也不要在对话区造第二份五态判据。
3. **正文折叠会把 `※` 一起折进去**（`※` 挂在 say 尾段的 `<p>` 里，117s-C 的 S3c 钉着这一点）。点一次展开即露出。把 `※` 挪出正文会破 S3c，未改，登记。

#### 顺带记的一笔债

`deliverableCache` 按 `sessionId|turnSeq` 缓存，同一条线程跨 3 个回合出现就取 3 次同一个信封（117s-H 引入，本刀只是让它显形）。改成会话级缓存是干净的下一刀，但会动 117s-H 的 P9 锁。**未改，登记。**

| `c5287ba` | **T1** 拆 13g（纯搬家） | 主会话**独立复算了它的纯搬家证明**，不采信自述：`server.js` 顶层函数名 **1471 == 1471，diff 0**；非注释行多重集 **37551 == 37551，diff 0**；`build --check` 新鲜；`forwardEdges 67 → 67`；13g **2088 → 358**，13j/13k/13l 分别 407/754/635（全部 < 2000）。五件静态锁（`steward-runner`／`steward-tools`／`steward-events`／`module-dependency-graph`／`facts`）亲跑全绿。 |

#### T1 的两处合理偏离（我认可）

1. **拆成四个文件而不是三个**：拼接顺序就是依赖方向且不许新增前向边——注册表引用所有 `stewardImpl*` 故必须在最后，共享常量被两族工具引用故必须在最前，**二者不能同居一个文件**，于是多出一个 base 层 `13j`。
2. **命名 `13j/13k/13l` 而不是 `13g1/13g2`**：`moduleLayer()` 的 `^13[a-z]?-`（SPEC §1）会把 `13g1-` 判成 `unclassified`；单字母后缀才留在传输层。

#### 一次由我造成的提交事故（记下来，比它修的 bug 更值得记）

T1 把 24 个文件入索引、正要提交时，**主会话的一次 docs 提交把它们一起扫走了**——`git add <doc> && git commit` 提交的是**整个索引**，而同一个 worktree 里的索引是**所有 agent 共享**的。
T1 的「提交前再核一次 HEAD」当场发现 HEAD 变了并中止，所以没有回退任何东西，但它那条提交信息永远没落地。
主会话随后把那次提交拆回两条（`c5287ba` ＋ `2a0af71`），并验证**树逐字节相同**。

> **纪律（补进 32 号文 §4）**：多 agent 共用一个 worktree 时，提交必须写成 `git commit -- <显式路径>`（只提交这些路径，无视索引里别人的东西），
> **绝不能**用 `git add <路径> && git commit`。§8.7 那套「clean copy → hash-object → update-index」防的是「索引建在旧 HEAD 上」，
> 防不住「别人把我的索引一起提交了」——这是同一个模具的第三种变体。

| `f3287dd` ＋ `aece591` | **F3** 右栏「现在这几件」 | 提交只含它那 7 个文件（零 locale、零 CSS 载荷锁，与分工一致）；亲跑 `steward-board.static` ALL PASS（补键之前只红 H2「answerHere 缺失」这一条）、`i18n.static` ALL PASS、四份 locale 3028 键逐字节一致；亲看截图：焦点线程仍是抽屉本体（完整「它在问你」＋回答框），下面四条紧凑行——等你的带回答入口、在跑的带「它刚说」、两条已收工各一行。 |
| `b922f33` | 主会话收尾 | 统一重钉经典样式载荷锁（F1+F4 与 F3 同波各改一个 CSS 层，联合哈希两边各钉必撞车；先例 117r `72873e4`）。**反向验证**：往 `steward-board.css` 追加一条无关规则 → `frontend-domains` D51 当场红；还原后文件 sha256 逐字节相同、两个消费者都 ALL PASS。顺带按 HEAD 全量重跑生成器补 route-inventory 的一行覆盖增量。 |

#### F3 的一处设计冲突（执行者顶回了设计稿，它是对的）

设计稿右栏画的是 **N 张各自完整的卡**（每张自带「回答它…」输入框、chip 行、停止／2.0／插话动作）—— 那等于 **N 个抽屉**。
执行者**没有照做**，建的是「焦点那条＝抽屉本体 ＋ 其余紧凑行」，理由：右栏再放第二个输入框，要么复制递话逻辑、要么把发送口暴露给看板，
而**递话原语必须单点**。就地回答因此走「聚焦交接」：点回答 = `openThread(id)` + `drawer.focusAsk()`，答案仍从抽屉那一个口出去。
实测结果：看板零 relay 端点、零输入框 id；抽屉仍然只有 1 处 `api('/api/steward/relay')` 调用点。**设计稿在这一点上要按实现修，不是反过来。**

#### F3 抓到的一条自己写的假绿断言（值得单独记）

它的第一版 S8「点就地回答后光标落在抽屉输入框里」**删掉被测的两行仍然全绿** —— 因为抽屉自己的 `openThread` 末尾本来就会 `focusAsk`。
它重写成「在同一次 evaluate 里点击并读 `activeElement`」，钉的是**看板这一步的同步贡献**：破坏时 `activeElement=stewardDrawerTitle`（红），还原后是 `stewardDrawerInput`（绿）。
> 与 117r 那条「补丁脚本把 `\b` 写成退格符」是同一个模具：**一条不会红的断言，比没有断言更糟**。

#### F3 报上来的三件待办（未修，登记）

1. **看板关着时紧凑行会陈旧**：看板的行只在五个确定性时刻刷新，它那唯一的 `setInterval` 门控在 `isBoardOpen()` 上。执行者**没有**顺手放宽这道门（那是 §3.4「看板关着时零后台活动」的决定，不该由本刀夹带）。
2. **刚起跑的线程没有「它刚说」**：行上的 `lastSay` 取自回合结束时写的 `head.summary`，抽屉的 `liveTail` 不在行上；所以一条刚跑起来的线程要等第一个回合跑完才有话可显。未加第二个数据源。
3. `13h-steward-runner.js` **2523 行**（T1 报的），同样超 SPEC 2000 行目标，在 T1 职责之外。

| `bd52e5a` | **F5a** 图标集（基座＋头部＋抽屉＋看板） | 亲验：`ICON_STOP` 的路径字面量在 `public/` 下**零命中**（残留 3 处是注释里的说明）；`ICONS` 键 51 → **68**；`icons.js` 里五态/档位字面量**只出现在注释**——`permissionIconName`／`missionStateIconName` 是真·纯派生（`default → shieldDefault`、`needs_you → stateNeedsYou`，`icons.js` 不认识任何档位名或态名，加一档只要补一枚同名字形，派不出来就退回家族标／干脆不画）；六件静态锁亲跑全绿；亲看截图：盾牌胶囊（闪电入盾＋「全自动」＋插入符）与电源符分列、五态各有独立字形、抽屉四动作配图标。 |

#### F5a 纠正了我派单稿里的三处（都对）

1. **我给的验收判据不可满足**：`grep "M12 3a9 9" public/js/` 永远会命中 `icons.js:64` 的 `theme` 半月形（本刀之前就在）。可证伪的判据是 `ICON_STOP` 那条**完整**路径字面量，它按这个重写了锁。
2. **「~1.75px 描边」做不到**：`icon()` 写死 `stroke-width 1.5`，且 `ui-v3-p1.static.e2e.js:53` 逐字钉着这个字面量；改它等于给全应用重新描边。新字形一律 1.5。
3. **停机键的 Esc 行为**：Esc 栈监听门控在 `isStewardMode()` 上，设置弹窗（经典壳）那一段 Esc 本来就不该有反应；它第一版断言假设反了、当场红，于是改成「再点一次关闭」并另加静态锁钉 Esc／外部点击／ARIA 的接线。

#### F5a 自己抓到的一处

第一版给「＋ 线程」配了 `plus` 字形，而那条 locale 串本身就以「＋」开头 —— 界面上出现「＋ ＋ 线程」。截图当场看见，两个调用点都撤掉并加锁钉住「这一枚刻意不配字形」。

| `f621288` | **F2** 频道条：点一条只看这条 | 亲验：提交只含它那 10 个文件；CSS 载荷锁**钉的与实算一致**（`275e775e…`）、两个消费者亲跑绿；`steward-conversation.static` **224 PASS**、`i18n.static` 3033 键四份目录逐字节一致、`steward-shell.e2e` 全绿；`steward-conversation.e2e` 我自己跑 **128 PASS，唯一红是 R7**（每组判定仍全是 `ok`，落在夹具形状前提上）。亲看截图：滤到一条线程时四条消息共一条连续色条＝**一张卡**、卡头只有一个、输入框目标 chip 跟着切成「→ 影视板块那件事 ×」。 |

#### F2 的两个设计判断（都记下来）

1. **频道 chip 走既有的 `picked`，不造第二个「目标」**：点 chip 是**用户显式选**，与候选列表手选同一条路（实底 chip 带 `×`，回车直递）；117l-D1 那条铁律管的是**自动预判**不许当目标（它仍只随 `routeHint` 走），两者不冲突。顺带改了一处既有行为并写进提交：`submit()` 的 `finally` 原本把手选清回「→ 如意」，现在清回**当前频道**的选择——屏幕还滤在一条线程上、输入框却说「如意」，是自相矛盾的画面；没有频道时与旧行为逐字相同。
2. **过滤只 toggle 一个类，绝不动 DOM**：`is-channel-out` + 一条 `display:none`；行数与卡头节点数前后逐字节相同（实测 8→8 / 5→5）。因为 `is-thread-start/-end` 是「只看上一行」的印记，隐藏行会让一条线程裂成三张卡——它加了 `resealThreads()`，**复用 markThread 那条一模一样的判据**，只把「上一行」换成「上一个可见兄弟」；清除过滤后重跑，印记与原始逐字节相同（X5c 钉住）。

#### 一处设计稿被实现顶回

稿子把频道条画在滚动区**外面**（与时间线并列）。实现把它做成 `#stewardFeed` 的第一个子元素 + `position: sticky`：视觉一样，但避免覆写 `steward-shell.css` 里 `.steward-stage` 的 `grid-template-rows`——那是「4 行对 4 个在流子元素」，而 `display:none` 的条根本不是网格项，覆写等于把整张卡的布局押在「条永远在流里」上。代价是它落在 `role="log"` 内，用 `aria-live="off"` + 「chip 集合没变就不重绘」兜住。

#### 我的一次调度失误（比它修的东西更值得记）

我给 F2 的派单稿写了「现在没有别的 agent 在改代码」「你是唯一动 CSS 的」——**两句都是假的**：我在 F2 跑起来之后又派了 F5a，两刀都改 CSS。
F2 第一次重钉时按**工作区**算哈希，把 F5a**尚未提交**的 settings/drawer/board CSS 一起钉了进去；它自己 `git status` 发现不对，改成按 `git show HEAD:` 逐层重算，并用「能否从 HEAD 逐字节复现出上一枚 pin」验证了方法，才敢下手。
（结果那个值恰好是对的，因为 F5a 随后就提交了——但**理由是错的**，这种「碰巧对」最危险。）

> **纪律（补进 32 号文 §4）**：派单稿里关于并发的陈述**必须在派出的那一刻重新核**，而不是照抄上一封；
> 算 CSS 载荷哈希**一律从 `HEAD` 算**，绝不从工作区算——工作区会把别人在途的改动悄悄钉进锁里。

| `2505acc` ＋ `9fd7628` ＋ `bf3cf42` | **F5b** 撤回三态 ＋ 两处收尾 | 亲验：`paintUndoRing` 函数体里 `textContent` 出现 **0 次**——按钮文字一辈子只在建它时写过一次，每拍只 `setProperty('--steward-undo-left', ratio)`，环怎么画全在 CSS；CSS 载荷锁钉的与实算一致；三件静态锁亲跑绿。 |
| `fda4e83` | **工具参数不是合法 JSON 会永久卡死会话**（用户报的 Qwen 400） | 亲验：`build --check` 新鲜、`forwardEdges 67 → 67`、`provider-pairing-repair.e2e` **35/35 ALL PASS**；并用**我自己的判据**直接打那个导出函数：空串／截断／非 JSON／`[1,2]`（合法 JSON 但不是对象）四种畸形全部改成 `{}` 且计数准确，良性历史 `repaired=0` 且序列化**逐字节零改动**。 |

#### 这个 bug 的形状（值得单独记，它不是一次报错，是会话永久卡死）

工具调用回放进 `providerHistory` 时 `arguments: tc.rawArgs` 是**原样写的**（`09:2307/:2363`、`08:824`）。三个生产点只挡空值（`|| '{}'`），
挡不住「非空但畸形」；而流式是**拼接**攒参数的（`07:1389`），流在工具调用中途被切断就留下半截 JSON —— 非空、逃过默认值、原样落盘。
**执行侧与历史侧本就不一致**：十几处执行点都是 `JSON.parse(rawArgs) catch → {}`，工具其实拿 `{}` 跑了，历史却声称是那半截片段。
毒消息一旦持久化，此后**每一次请求都重发它**，严格校验的供应商每次 400 —— 与 `02:2186` 那段注释记的孤儿 tool_calls 是同一个模具、同一句话：「会话永久卡死」。

#### 执行者的一处判断比派单稿更好（记下来）

我建议「在三个 `rawArgs` 生产点立不变量」，它**没有照做**，改在**三个写历史的点**立，理由是 `rawArgs` 还有三个**非请求体**的读者，在生产点归一会静默弄坏它们：
`09:1911` 的循环护栏指纹 `sha1(name + '\0' + rawArgs)`（两段**不同**的截断会塌成同一个指纹，误触发「同签名连击」中止）、
`09:1749` 的 `econArgsBytes`（真实字节数会变成 2）、`07:1042` 的动作信封投影（它**刻意**拒绝投影畸形参数）。
不变量说的是「到达供应商的东西」，就该立在 `arguments` 产出的地方。**它是对的。**

#### 顺带

- **频道条是半透明的**（`9fd7628`）：我看 F5b 截图时发现滚动正文从条背后透出来。`--glass-bg-1` 是「框架族」token，暗色档仅 6.5% 不透明度，blur 只抹糊不遮挡；仓里其余 `position:sticky` 表头一律用不透明面 token。改 `var(--panel)`。
- **`swap` 字形与两把锁重钉**（`bf3cf42`）：F5b 报「换一条」用 `refresh`（循环箭头）读作**重试**，语义不对；它没有 `icons.js` 所有权，只报路径。收尾加 `swap` 并换过去，顺带把 Y7（钉 `icon('refresh', 12)` 整句）与 Y9（钉写稿时挑的两个名字）重钉成「从源码取出模块**实际用**的每一枚字形名再去词汇表核」——因为 `icon()` 对未知名字只 warn 后返回 null，界面会**静默**少一枚图标。两种取件写法都抓（直接调用 ＋ 名字当字符串传给 `settleRow` 第三参间接取），反向验证过。

#### 11.14.1 117t 收口：全量回归（2026-09-09 夜，主会话亲跑）

隔离 worktree、`--parallel 4`：**317 pass / 6 fail / 6 flaky / 323 ran / 7 skipped**（上一波是 311/12/11，抖动件减半）。
6 条红逐条定性后 **真回归 0 条**：

| 件 | 定性 |
|---|---|
| `observation-recall-realhistory` / `-replay` / `session-notes` | 主树才有的 `realhist-fixtures`，隔离 worktree 里预期红（合并后主树补跑） |
| `mcp-ops-closure` | 4 路负载的假红，单跑 **101 PASS ALL PASS** |
| `steward-conversation` | R7 抖动，单跑 **140 PASS ALL PASS** |
| **`ui-v4-glass.static` G2** | **真红，已修（`6437fa3`）** —— 见下 |

##### 唯一那条真红，以及它为什么此前没人发现

`ui-v4-glass.static` G2 把 `backdrop-filter` 的使用点锁成一张**封闭白名单**（经典框架 4 ＋ 浮层 4 ＋ Preview 互斥壳 ＋ 管家互斥壳 ＋ 降级块）。
F2 给频道条写 `backdrop-filter: var(--glass-blur-2)` 时越了这张名单 —— 而 F2 与 F5b 各自跑的清单里都**没有这件锁**：
它们跑的 `live-full-text` / `frontend-domains` 钉的是 **CSS 载荷哈希**（内容变没变），G2 钉的是**玻璃族规**（谁有资格用这个属性），
两者是不同的判据。**是全量把它翻出来的** —— 这正是「每刀只跑自己那几件、收口必须跑全量」的价值。

修法不是给白名单开口子：上一刀（`9fd7628`）已把底色从 `--glass-bg-1`（框架族，暗色档 6.5% 不透明度）改成 `var(--panel)`，
背后一个像素都透不过来，这层 blur 本来就什么都不模糊了，纯属白付一层合成。**删掉即可**，两件事同时收敛。

### 11.15 117u 设计页 · 端到端走查结论 ＋ 看板重设计与线程详情栏统一（2026-09-09 夜；Fable 设计与验收）

#### 11.15.0 先说验证：117t 那六片，真机端到端全过

夹具走的是**真路径、真端点**（用户 2026-09-09：「可以直接用当前本机配置好的端点」）：把 `~/.win-claude-workbench/config.json`
复制进临时 HOME 只借 provider 与密钥（用户那 102 条真会话一条没碰），线程回合与管家回合都是真模型
（线程 qwen3.8-flash / 管家 deepseek-v4-flash）。**没有造假 DOM、没有直写 `steward.messages.ndjson`** ——
线程卡与频道条只在「收件箱触发的管家回合」上长出来，所以只能走真路径把它逼出来。

| 片 | 判据 | 亲验证据 |
|---|---|---|
| **F1 线程卡** | 连续同线程合成一张卡 | 重进壳后历史重画：三行 `data-thread=…13f6db`／`hue=1`，`is-thread-start` 只在首行、`is-thread-end` 只在尾行、`.steward-thread-head` 只有一个。**中间隔了别的话时各自成段**（3 张卡）——判据是「相邻」，不是「同 id」，行为正确 |
| | 卡头四件事从信封读 | 卡头实测：名「周报-W36」· 药丸「需要你」(`data-state=needs_you`) · 「1分钟前 · qwen3.8-flash」· 「打开」 |
| **F2 频道条** | 过滤是呈现不是数据 | 点「管家本人」→ 线程行加 `is-channel-out`、可见 0；点「周报-W36」→ 可见 1、隐藏 0；`is-on`＋`aria-pressed="true"` 只在被点那枚上 |
| | 不建第二个「目标」 | 点 chip 后输入区目标 chip 变「→ 周报-W36 ×」 |
| | （我上一刀的两处收尾） | 粘条 `backgroundColor: rgb(21,29,43)`（**不透明**）、`backdropFilter: none`、`position: sticky` |
| **F3 右栏** | 「现在这几件」＋就地回答 | 抽屉标题「现在这几件 · 3 条线程」；展开那件带「它要你做」＋两枚候选答案＋「你的回答」输入框＋「回答」键；其余两条折成一行（「登录重构 ⚡交办中」「周报-W36 ✓已收工」） |
| **F4 回复定型** | 首句抬引子 | 4 个 `p.is-lead`，`font-weight: 600` |
| | 超 8 行折叠、一处实现 | `.steward-say.md.is-clamped`（管家正文）与 `.steward-deliverable-body.md.is-clamped`（交付原文）**同一个类**，印证「一处实现两个调用方」 |
| **F5a 图标** | 停机 ≠ 停止 | `.steward-shield`（3 path，`aria-label`「新线程默认权限：全自动」）与 `.steward-stop-btn`（2 path，「一键停机」）是两枚不同字形，可访问名完好 |
| **F5b 撤回三态** | 环退＋文字不跳 | **带真绘制证据**：`conic-gradient(… 360deg → 324deg → 288deg …)` 逐秒后退，同时按钮文字恒为「撤回」（秒数挪进 `title`），12px 环 |
| | 到期换一条 | 到期换 `swap` 字形＋「换一条」 |
| | 成功退成一句话 | 点撤回 →「递给了「周报-W36」。※ …已撤回；改动请看 2.0 视窗。」＋管家追问「那递给谁？」 |
| **117s-B** | 递话后自动开详情 | 递话完成后右栏**自动打开该线程详情页**（用户第九轮走查①，已修） |
| **117s-C** | markdown 渲染 | `.steward-say.md`；模型自己发的 ``` 围栏渲染成 `<pre>`＋复制键，围栏后的散文渲染成 `<p>`（**不是 bug**：核过原文确实是围栏） |
| **117s-H4** | 回执 trigger 是对象 | 落盘 `{"kind":"inbox","sessionIds":[…],"sessionId":…}` |

一处**不是 bug 的观察**记下来免得后人再查：全新浏览器首次打开落在**经典壳**而不是管家壳 ——
`wcw.shellMode` 是 localStorage 的每人偏好，新 profile 读不到就回落经典。

#### 11.15.1 用户第十轮反馈（两条）

> 「此外看板也重新设计改一下吧，然后线程详情栏也改成和对话中卡片类似的风格语言吧」

#### 11.15.2 今天的病（对着真机截图数的，不是推的）

1. **同一条线程有三副面孔**：对话流是「3px 色条＋卡头」；抽屉是无色条的大面板；看板是「状态点＋标题＋右侧三段灰字」。
   F1 自己立的纪律是「同一条线程在所有面恒用同一色」——今天这条只在对话流与频道条兑现，**抽屉与看板没有**。
2. **看板把 mission 与 thread 各画一遍**：真机三条全是「1 事项 = 1 线程」，标题字面重复两次（「季度复盘 / 季度复盘」）。
3. **元信息是一串等重灰字**：「权限 跟随全局 · 模型 qwen3.8-flash」每行都印一遍 —— 信息量低、墨量高，而且「跟随全局」是默认值，印它等于没印。
4. **三个数字挤在标题右侧**：「1 条线程 · 没有验收线 · 已花 CNY 0.0015」三件不相干的事连成一行，与标题争重心。
5. **抽屉四个底部动作等宽等重**：破坏性最强的「整单回退」和最常用的「递给它」一样显眼。

#### 11.15.3 设计：一枚线程卡，三种密度

**基元**＝对话流那张卡的骨架：`3px 色条(--thread-color)` ＋ 卡头`(色点 · 线程名 · 五态药丸 · 最后动静 · 主动作)`。
三种密度**只改卡头下面装什么**，骨架、色号表、五态词表、`stewardThreadFacts` 全仓仍各只有一份：

| 面 | 密度 | 卡头下面装 |
|---|---|---|
| 对话流 | 转述 | 管家的话 ＋ 交付卡 |
| 线程详情栏 | 工作 | 它刚说 / 就地回答 / 直接说 / 动作区 |
| 看板 | 清点 | 一行事实（等什么 · 花了多少 · **只在异常时**显示权限与模型） |

**看板（G2）**
- **B1 合并层级**：事项只有 1 条线程时**不画事项层**，直接画线程卡；≥2 条时事项退成一行小标题「事项名 · N 条」＋缩进的线程卡组。
- **B2 色条上板**：看板卡左侧同一根 3px 色条，色号来自同一张 hue 表（同 sessionId 同色）。**状态只由药丸表达 —— 色 ≠ 态**（F1 已立）。
- **B3 事实降级**：权限与模型**只在与全局不同时**出现；相同就不印。
- **B4 钱与验收线**移到卡尾一行，标题右侧只留「最后动静」。
- **B5 「＋线程」**从每张卡右上角收进卡尾的次级动作。

**线程详情栏（G1）**
- **D1** 详情头换成同一枚卡头（色条＋色点＋名＋五态药丸＋最后动静＋「2.0 视窗」）。
- **D2** 「它要你做」改成**卡内 callout**（左侧 2px 强调边＋`--panel` 面色），不再是独立黄框。
- **D3** 底部动作分级：主＝「递给它」；次＝「停止」；破坏性的「整单回退／交回管家」收进「更多」。
- **D4** 折成一行的其余线程＝同一枚卡的最紧密度（色条＋点＋名＋药丸），**就地展开**，不跳走。

#### 11.15.4 不做

不新增第二份 hue 表、第二份五态枚举、第二处 `stewardThreadFacts`；不改后端、不新增路由；不动 `app.js`（1279/1280 只剩 1 行）。

#### 11.15.5 切法与共享资源归属

| 刀 | 独占文件 | 绝不碰 |
|---|---|---|
| **G1** 基元上提 ＋ 线程详情栏 | `js/steward-drawer.js`、`css/views/steward-drawer.css`、`js/steward-conversation.js`（**只加导出，不改行为**）、`css/views/steward-conversation.css`（只把 hue 令牌提到与面无关的选择器） | 看板两文件 |
| **G2** 看板 | `js/steward-board.js`、`css/views/steward-board.css` | 抽屉与对话区 |

**两刀都不许碰 `LEGACY_STYLES_SHA256`**（各自的 `live-full-text.static` F3 与 `frontend-domains.static` D51 预期红），
主会话在两刀都落地之后**统一重钉一次**（先例：117r `72873e4`、117t `b922f33`）。依赖方向：`board → drawer → conversation` 已经是既有方向
（`steward-board.js:12` 引 drawer、`:17` 引 conversation），G1 让 drawer 也引 conversation 不成环。

#### 11.15.6 验收（三条可证伪的）

1. 同一条线程在 feed / drawer / board 三处的 `data-thread-hue` **相同**（真夹具跑起来，DOM 断言＋截图）。
2. **没有第二份色表**：`grep -c "thread-hue-1"` 在 `css/views/` 下的**定义**处仍只有 `steward-conversation.css` 一处。
3. 五态药丸文案三处一致，来源仍是 `STEWARD_THREAD_STATE_KEYS` 那一份（改名它，三处同时变）。

#### 11.15.7 B3 扩到线程详情栏（用户 2026-09-09 追加：「这个也不印默认值吧」）

G2 把「权限与模型只在与全局不同时才印」落在了看板那一面，详情栏那行 `权限 跟随全局 · 模型 …` 照旧印默认值。
用户看到后要求一并收掉。**口径自此统一**：`§11.15.2 病 3`（元信息是一串等重灰字）对**所有三面**成立。

**做法的要害是不要写第二份判据。** G2 的 `chipsWorthPrinting` 长在 `steward-board.js` 的闭包里，
而抽屉**不能** import 看板（`steward-board.js:12` 已经 import 抽屉，反向引用即成环）。所以：

- 把那份判据搬进 **`js/steward-chips.js`**（`resolveEngineRoute` —— 全仓唯一那份「会话级 ＞ 全局回落」——
  本来就住在这里，chips 工厂也在这里），导出给两面共用；
- `steward-board.js` 改成 import 它，**行为零改变**（同一段逻辑换了住处，要有自证）；
- `steward-drawer.js` import 同一个，元信息行按它决定印不印。

**判据两条（与看板逐字同源，不新增第三条）**：
① 模型 —— `resolveEngineRoute(这条会话, cfg)` 与 `resolveEngineRoute(null, cfg)` 的 JSON 不等；
② 权限 —— chips 自己 `render()` 出来的 `.steward-chip.is-pinned` 存在（即真定过会话级档位）。

**留一条明写的取舍**：会话元数据在静息态不带 `engineRoute`（要等 `hydrate`／`onChanged` 补齐），
所以判据①在补齐之前必然回落成「与全局相同」。这只会让它**少说**，不会让它**说错**——
与 G2 在看板那面记下的是同一笔账，不是新债。

#### 11.15.8 主会话裁决：详情栏「只收值，不收控件」（G3b）

G3 按 §11.15.7 的派单稿把详情栏那一行**整行**藏了，与看板逐字同法，并在交付报告里如实写出代价：
跟随全局时那一行看不见，于是「给这条线程单独定一档」在管家壳里只剩卡头那枚「2.0 视窗」一条路。

**它做得对，错在派单稿。** §11.15.7 把两件不同的东西写成了一件：

| 面 | 那一行是什么 | 该怎么做 |
|---|---|---|
| 看板 | **信息**——多行并列，「跟随全局」重复 N 遍是纯噪音（§11.15.2 病 3 的原文场景） | 整条不印（G2／G3 的做法**保留**） |
| 线程详情栏 | **控件／入口**——只有一条线程，这是管家壳里唯一能给它单独定档的地方 | **只不复述默认值**，控件留着 |

用户说的是「这个也不印默认值吧」，不是「收掉入口」。所以详情栏改成只收 `.steward-chip-value` 那半个节点
（chip 本就是「键 ＋ 值」两个节点，见 `steward-chips.js` 的 `buildChip`）：样式层一条
`.steward-drawer-chips.is-default .steward-chip-value { display: none; }` 即可，**零 JS 分叉、不动 `valueFor`、
不碰看板与 2.0 顶栏那两面**，判据仍然只有 `chipsWorthPrinting` 一份 —— 两面拿同一个答案做不同的事，
这不是两份判据。（G3 报告里说这条要动 `valueFor`，不必：值本来就是独立节点。）

**锁跟着翻面，都改成量真绘制而不是读属性**：`E4b` 不再钉 `host.hidden = !…` 的字面写法，改钉
「判据答案落在 class 上、控件没被摘掉」；新增 `E4d` 钉「收的是值那半，键与按钮都在」——**这条才是
守住「没把能力删掉」的那一把**；`B14b`／`C3b` 的探针改量 `valuesPainted`／`keysPainted`：
跟随全局 → 值 0 个、键 3 个；定过会话级档 → 值 3 个。反向验证两个方向各自独立打红
（判据恒真 → 只有 `C3b` 红；删掉那条 CSS → 只有 `B14b` 与 `E4d` 红）。

**退路留着**：`.steward-drawer-chips[hidden]` 那条守卫没删，要回到「整行都不印」只需把 `renderChips`
里那一行换回 `host.hidden = !worth`（注释里写了）。

**顺带纠正 §11.15.7 的一处**：那里让执行者照抄 G2 的账「会话元数据不带 `engineRoute`，判据必然回落」。
G3 核过 `13d-core-domain-routes.js:343`（`GET /api/sessions/:id` 原样回整个会话头，`engineRoute` 在里面）
与 `02-session-store.js:2653`（`createSession` 恒写一个），**那笔账只对看板成立，对详情栏不成立**——
它没照抄，注释里写成了「看板那面有这个洞、抽屉没有」。以此处为准。

### 11.16 117v 设计页 · 用户第十轮走查（2026-09-09 夜，四张截图，九条；Fable 设计与验收）

#### 11.16.0 用户原话（两条消息，合并列条）

> ① 为啥这个会同一个文件夹被占着？② 在会话中点开这些线程后，那个按钮就失效了，但是从 2.0 返回又会出现，我觉得最好不要这样；
> ③ 为啥最上面那不像设计图那样，一个一个小胶囊代表一个个线程呢？④ 这个模型选择做的也很一般，
> ⑤ 而且进行中切换模型和引擎不会打断任务吗？
> ⑥ 其实我觉的要能运行一个文件夹里开多个线程，但是管家要能知晓并在同文件夹里的线程优化提示词告知存在，
> 此外两个线程中间要能 agent 相互通信，应该有现有的功能，你可以看下能不能复用一下；
> ⑦ 我觉以后 Ruyi 可以自带一个默认的文件夹工作区，然后如果新开线程不知道分到什么工作区里，就可以在这个默认工作区下分子工作区作为工作区；
> ⑧ 这两点开成单独的波次也可以；
> ⑨ 这里管家的回复看全文是打开 2.0，看英伟达分析全文是打开线程，但是线程也的「它刚说」并没有正确的输出，这个 UX 体验就很迷。

#### 11.16.1 逐条查证（都落到行，不是推测）

| # | 结论 | 证据 |
|---|---|---|
| ① | **不是 UI 问题，是能力缺口。** 线程写盘锁粒度是 `cwdKey`，同一工作目录**硬互斥**；而管家今天没有选工作区的能力，开的每条线程 cwd 恒为默认工作区，于是两件不相干的事被判成抢同一个文件夹 | `13h:1833 stewardArbiterCwdLock`；`01-config.js:8` `defaultWorkspace: os.homedir()` |
| ② | **真 bug。** `renderActs` 对**每一种** act 都执行 `settleRow(actsRow, receiptFor(act))`，整行按钮换成灰字回执，**然后**才 `openThread`。从 2.0 返回时历史重画，按钮从 stamp 里长回来 | `steward-conversation.js:703-704` |
| ③ | **真 bug。** 线程卡（频道条 chip 的唯一来源）只在 `trigger.kind === 'inbox'` 那一支里挂。用户问、管家开线程那一轮是 `kind:'user'`，长不出 chip。**而该分支里现成的兜底 `executedThreadSessionId(stamp.actions)` 正好能认出这一回合真开的线程，却被关在 inbox 分支内** | `steward-conversation.js` `trigger.kind === 'inbox'` 那个 if |
| ④ | 属实。30 余项扁平裸列表，无搜索无分组，直接印原始 id，且混入 audio-realtime / image / ocr / livetranslate 等**与文本任务无关**的端点 | 真机截图 |
| ⑤ | **虚惊：不会打断。** provider 在**回合入口**绑定，`09-workflow.js:2068` 的 `for (let iter…)` 循环体内**没有**重新取 config/provider，所以在跑的回合用旧模型跑完，新模型下一回合生效。PATCH 那条路径只有两道门（会话级档位、切全自动要 `confirm:true`），**没有「有活回合就拒」**。真正的问题是**界面让人以为「现在就换了」** | `13d:345`；`09-workflow.js:2068` |
| ⑥ | **两块料都是现成的。**（a）「同 cwd 并发 + 告诉你还有谁」已经实现在待决豁免那一支：不占并发位、不挡别人，并发一条带 `rivals`（同 cwd 其他线程标题）的事件；（b）**agent 邮箱已存在**（`sendToAgent` / `getMail`，工具已进 tier 表），今天作用域是「同一回合内的子代理之间」 | `13h:1922 stewardArbiterGrantPending`；`08-agent-runs.js:466` |
| ⑦ | 出厂 `defaultWorkspace` 就是**用户主目录**，所以什么都堆在同一个文件夹里、写锁天天撞 | `01-config.js:8` |
| ⑨ | **病根不在按钮，在「取哪一段」。** 两枚「看全文」共用**同一个 i18n 键** `stewardShell.drawer.fullText`（代码注释还写着「同一个词、同一个动作」——今天已不成立）：交付卡那枚 `fullTextOf()` 跳 2.0，琥珀色那枚 `open_thread` 打开线程。而「它刚说」的规则是「在跑时取末尾 ≤3 句，收工后取落盘原话的**开头** ≤3 句」——**正好反了**：回合收工后结论在尾巴，取开头必然取到开场白（该线程模型把过程叙述写在最前面） | `steward-conversation.js:1141`；`steward-drawer.js` ⑤ 段头注 |

**⑨ 的连带结论**：交付卡顶部显示的也是那三句开场白，与「它刚说」同一个根因。除了改取段规则，还要在 06b 给线程加一条**结论先行**的提示词规则 —— 它对四个显示面（它刚说／交付卡／管家转述／看板最后动静）**同时生效**，是本轮性价比最高的一改。

#### 11.16.2 117v 切法（三刀，文件互斥，可并行）

| 刀 | 做什么 | 独占文件 |
|---|---|---|
| **V1** 对话区三处 | ② `open_thread` **不消费按钮行**（导航 ≠ 表态：「知道了」是一次性的，「打开线程」没有副作用、本就该反复点）；③ 把 `executedThreadSessionId` 兜底**从 inbox 分支里放出来**，管家自己开的线程当场上频道条；⑨ 两枚「看全文」**拆词拆键**（交付卡那枚说清「到 2.0 看」，act 那枚说清「打开线程」） | `js/steward-conversation.js`、它的两件 e2e、**两份 locale ＋ `docs/i18n/locales`（本轮 locale 归 V1）** |
| **V2** 抽屉与快切 | ⑨ 「它刚说」**收工后也取尾巴**（在跑取尾、收工取头是反的）；⑤ 在跑时切模型/引擎要**说清「本回合跑完后生效」** | `js/steward-drawer.js`、`js/steward-chips.js`、它们的锁 |
| **V3** 提示词 | ⑨ 06b 给线程加**结论先行**规则（首段就是结论，过程叙述往后放） | `app/src/06b-*.js`、`prompt-snapshot.static.e2e.js` 等钉提示词的锁 |

**共享资源先定死**（117s/117t 的教训）：locale 本轮**只有 V1 能写**，V2/V3 需要的新键在报告里给出 key ＋ 中英文，主会话补；**V3 是唯一动 `src/` 的**，它必须跑 `build.js` 并核 `--check` 新鲜（V1/V2 不碰 `src/`，也就不需要生成器链）；三刀都不许碰 `LEGACY_STYLES_SHA256`，若有 CSS 改动由主会话统一重钉。

④ **模型选择器**独立成一块设计（分组／搜索／常用置顶／过滤非文本端点），不塞进本波——它是一块完整的交互设计，与上面三刀的判据无关。

#### 11.16.3 117w 规划 · 工作区与线程协作（用户 ⑧「开成单独的波次也可以」）

**顺序：⑦ 先于 ⑥**（先有得可选，才谈选得对）。

**W1 · 默认工作区（⑦）**：Ruyi 自带一个默认工作区根目录（不再是 `os.homedir()`）；管家开线程时认不出归属，就在这个根下**开子工作区**（按事项名派生目录名）。与 31 号文 **E-手** 是同一件事的两半 —— E-手负责**选**，W1 负责**有得可选**。红线不变：围栏与密钥仍是 `06i` 的 forbidden 档。

**W2 · 同文件夹多线程（⑥ 前半）**：把 `13h:1833` 那条注释自己登记的债还掉 —— 「只读回合的识别与放宽留后续波」。放行只读回合，并把 `stewardArbiterGrantPending` 已经在算的 `rivals` 名单**喂进提示词**：同一文件夹里还有谁在干什么，线程自己要知道。**不新造名单，用现成那一份。**

**W3 · 线程间通信（⑥ 后半）**：把 `08-agent-runs.js` 的邮箱（`sendToAgent`／`getMail`）**从「同一回合内的子代理之间」抬到「线程之间」**，不新造一套。与 31 号文 **E-编排** 的「线程接力」重叠，两者应合并设计：接力是「A 完工把交付喂给 B」，邮箱是「A 与 B 同时在跑时互相说话」。

**先决**：W2 放宽的是一条**安全边界**（两条线程真的一起改同一棵树），必须先有 W1 把「本来就该分开的事」分开，剩下的才是「确实该共处一室」的情形。
