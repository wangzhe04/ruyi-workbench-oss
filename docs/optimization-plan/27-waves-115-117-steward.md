# 27 · 第 115–117 波实施方案（工作台管家 Steward：概念／引擎侧／壳层）

> **状态（2026-09-03）**：Pretender 3.0 壳层线重新立项（用户 2026-09-03 拍板）。原交办台（Preview 壳，P1–P3 已交付、P4 默认切换搁置）**停止独立演进**，由管家壳继任；经典壳保留为专家模式。编号 115–117 顺延自 26 号的 114；执行序建议见 §7。
> **用户决定（2026-09-03）**：① 自治边界三档都要（只提议／有界自动／全自动）；② 管家壳是交办台继任者；③ 管家模型单独配置；④ avatar 用 2D 状态动效、简单图形但要合理；⑤ 管家有独立记忆层，自主决定保存关于用户的信息与偏好并在能力上活用；⑥ 管家交互显示以简洁对话为主，默认不展示思维链与工具调用。
> **关联**：[25 号 第 112 波过程可见性](25-waves-111-113-compaction-visibility-memory.md)（事件管线与 `turnActivity` 状态机是管家前置）、[25 号 第 113 波会话搜索索引](25-waves-111-113-compaction-visibility-memory.md)（路由依据）、[23 号 §2 103a 命令核心](23-architecture-repayment-sequence.md)、[22 号 红线与发布门](22-agent-soc-microarchitecture.md)、`docs/PRETENDER-PLAN.md` v4（旧壳层线，仅作历史）。

---

## 0. 定位与一句话

用户打开如意，看到的是一个管家：一个对话框、一个会呼吸的 2D 形象。用户说话，管家判断该交给哪个线程（或新开一个），用户确认后线程在旁边打开；线程停了、到节点了、卡在待决、班组出问题了，管家先知道，按用户设定的自治档位要么提议下一步、要么在授权范围内直接推进、要么全权处理，事后能解释、能撤销。管家记得用户是谁、喜欢怎么做事，并把这些用在路由、默认选项、语气与主动提醒上。

## 1. 摸底结论（2026-09-03，HEAD `feb078c`）

| 项 | 现状 | 对设计的影响 |
|---|---|---|
| 服务端内发起回合 | `streamChat`（`10-context-governance.js:2129`）直接 `await runOpenAiTurn(...)`／`runClaudeTurn(...)`，`onEvent` 为单一回调 | 管家后台回合不经 HTTP，自带 sink |
| 决策核心 | `decideIntervention()`（`13d-core-domain-routes.js:473`）`source` 无枚举白名单；CAS＋幂等键复用；审计标签 switch（`:745-751`）未知来源落回通用标签 | 新增 `source:'steward'` 与审计分支即可；四类待决（permission／question／plan／pool）统一走此处 |
| 事件总线 | **不存在**进程内 pub/sub；实时只有单回合 HTTP 流与前端 30s 轮询 `/api/interventions` | 管家收件箱 = 进程内轮询三条现成 seq 日志：Mission Change Ledger（`readMissionChangesWithMeta`）、agent-run 事件（`readAgentRunEvents`）、待决投影（`getPretenderProjectionIndex`）；即时推送作为后续可选（`onEvent` 改多订阅者） |
| 角色专属模型 | 先例 `subagentPreferredProvider/Model`（`01-config.js:269-270`，UI `agent-roles.js:122-163`）；不存在 `summaryProviderId` | `stewardProviderId/stewardModel` 完全照抄 |
| 权限轴 | `PERMISSION_MODES` = default／acceptEdits／plan／auto／bypass；`nativeToolGate(mode,tier)` 纯函数；`streamChat` 可按请求临时覆盖 permissionMode 不回写 | 三档自治映射到既有原语（§3.3） |
| 授权书 | `06f-autonomy-grants.js`：按会话内存 Map，scope run／session，工具×路径 glob×命令白名单×次数×时长；**签发只认 UI header token，`issuedBy` 固定** | 「有界自动」的边界原语现成；签发主体需显式设计（§3.3） |
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

## 3. 第 116 波 · 管家引擎侧（默认关，`stewardEnabledV1=false`）

### 3.1 切片
| 切片 | 内容 | 门 |
|---|---|---|
| **116a 配置与模型** | `stewardEnabledV1`、`stewardProviderId`／`stewardModel`（照抄 subagentPreferred*，缺省跟随主端点）、`stewardAutonomyTier`（`propose`／`bounded`／`full`，默认 `propose`）、`stewardPollMs`（默认 15s）、费用与频率上限（`stewardMaxTurnsPerHour`、`stewardMaxCostPerDay`）；设置页「管家」分区 | config normalize 只加断言；`provider-settings` 静态锁 |
| **116b 收件箱与游标** | 后台轮询器（仅开关开时启动）：三条 seq 日志增量 → 归一化事件 `{kind, sessionId, missionId, seq, at, payload}` → `<data>/steward/inbox-v1.ndjson`（append-only）＋ `cursor-v1.json`；去重（sessionId+kind+seq）；重启续游标；103c 登记 | 新增 `steward-inbox.e2e.js`（合成三源事件→收件箱顺序与去重；重启续游标）；`durable-state-inventory --write` |
| **116c 管家工具集** | 只读：`steward_threads_search`（113b 索引；缺席退化词法）、`steward_thread_status`（mission 五态＋最近一步＋待决摘要）、`steward_runs_status`（班组 digest）、`steward_inbox_read`；写：`steward_thread_open`（返回候选，不自动切换）、`steward_thread_continue`（在目标线程发起回合，`runOpenAiTurn`/`runClaudeTurn` 进程内、自带 sink、可临时覆盖 permissionMode）、`steward_thread_new`、`steward_decide`（经 `decideIntervention({source:'steward', decidedBy:'steward:<id>', contractRequest:true})`）、`steward_run_action`（pause／resume／stop／retry_node）；全部走第 49 波入库门，tier 按写读分档 | `tool-dispatch` 计数重钉；新增 `steward-tools.e2e.js`；`interventions-cas`／`-snapshot` 只加 `steward` 来源用例；13d 审计标签加 `steward` 分支 |
| **116d 管家记忆层** | 见 §4 | `steward-memory.e2e.js`；敏感过滤复用 |
| **116e 三档自治与熔断** | 见 §3.3；熔断：每小时回合上限、日费用上限、无进展熔断（连续 N 次收件箱无新事件却仍行动）、单线程并发 1、一键停机（`POST /api/steward/stop` 即刻停轮询与在途回合）；所有行动写 `<data>/steward/decisions-v1.ndjson`（含依据事件 seq、使用的记忆条目 id、档位、可撤销指针） | `steward-autonomy.e2e.js`（三档矩阵×四类待决×熔断）；`autonomy-grant.e2e.js` 只加 |
| **116f 管家回合运行器** | 管家自身是 `kind:'steward'` 的特殊会话（不在普通会话列表展示，`sessionMeta.kind` 已有字段）；系统提示词独立包（`06b` 新增 `steward.*`，含记忆块与工具协议，不含普通会话的技能／playbook 索引）；每次被唤醒（用户消息或收件箱新事件）跑一回合；输出结构化：`say`（给用户的话）＋ `cards`（候选线程／提议／通知）＋ `actions`（按档位执行或待批） | `prompt-snapshot.static` 只加 `steward` 段；`usage-ledger` 记 `kind:'aux', note:'steward'` |

### 3.2 数据流
用户消息 → 管家回合（路由工具）→ 候选卡 → 用户确认 → 目标线程回合（普通会话，正常权限门）。收件箱事件 → 管家回合（判断）→ 按档位：提议卡／有界动作／全权动作 → 决策日志 → 用户可见（通知摘要）。用户已在线程抽屉内对话时直连该线程，不经管家。

### 3.3 三档自治的映射
| 档位 | 允许的动作 | 原语 |
|---|---|---|
| 只提议（默认） | 生成提议卡；所有写动作等用户一键批准 | 相当于 `ask`；批准即执行 `steward_decide`／`steward_thread_continue` |
| 有界自动 | 只对白名单动作自动：瞬时失败重试 ≤1 次、预算暂停后按用户预设上限加一次、按用户预设默认选项答复 question／plan、重启后 `resumeTier` 为可自动的 run 续跑；其余仍提议 | 白名单为持久化策略文件 `<data>/steward/policy-v1.json`（用户在设置页勾选＋从批准记录学习出的建议项须用户确认）；授权书：**管家不自签**，改为「管家提议授权书 → 用户一键签发」（零改动兼容 `normalizeGrant`）；permission 类待决在有界档**永不自动放行 edit／exec**，只可放行 read |
| 全自动 | 所有动作直接执行（含 permission 放行），但受熔断与费用上限约束，且每个动作可撤销（checkpoint／rewind 既有机制） | 相当于 `bypass`；启用需二次确认并显示风险说明；一键停机常驻 |

### 3.4 红线
不引入运行时 npm 依赖；不绕过 `nativeToolGate`；管家不得替用户签发授权书（有界档）；全部行动经命令核心与审计；开关关闭时零轮询、零持久化写入、提示词与路由清册零变化。

### 3.5 管家工具面设计（用户 2026-09-03 决定：管家须能完全操控如意；评估是否与会话工具集分离）

**裁决：分离。管家「动如意」，线程「动世界」。** 管家拥有对如意自身的完整操控面，但**不持有**作用于外部世界的工具（文件读写、shell／PowerShell、桌面控制 ACC、浏览器、Office、联网抓取、git 写操作）。需要动手时，管家把任务委派给线程（新开或续办），由线程在其权限模式与授权书约束下执行。理由：① 管家常在用户不在场时自主运行（有界／全自动档），把「能改电脑」的能力留在有人审批链路的线程里，是最小权限；② 管家提示词不含技能／playbook 索引与项目记忆，缺少执行真实任务的上下文，直接动手质量差；③ 工具面小，管家的工具 schema 稳定，前缀缓存友好，路由回合便宜。

管家工具族（全部走第 49 波入库门；名称前缀 `steward_`；tier 与档位见下）：

| 族 | 工具 | tier | 说明 |
|---|---|---|---|
| **观察（只读）** | `steward_self_status`（复用 `workbench_self_status` 装配并加管家段）、`steward_threads_search`／`steward_thread_status`／`steward_runs_status`／`steward_inbox_read`、`steward_usage`（用量与费用，按会话／日）、`steward_health`（doctor 项）、`steward_audit_tail`（最近审计） | read | 任何档位可用 |
| **线程** | `steward_thread_new`、`steward_thread_open`（只返回候选，切换由 UI 完成）、`steward_thread_continue`（在目标线程发起回合；可附「委派说明」与临时 permissionMode 收紧，不可放宽）、`steward_thread_rename`／`pin`／`archive` | edit | 只提议档需批准；有界档白名单内自动；全自动直接 |
| **决策** | `steward_decide`（question／plan／pool 经命令核心；permission 类见档位表）、`steward_run_action`（pause／resume／stop／retry_node／steer_node） | exec | 有界档：question／plan 只在用户预设默认选项时自动；permission 类 read 可放行、edit／exec 永不自动；全自动：全部 |
| **如意设置** | `steward_config_get`（掩码）、`steward_config_set` | exec | 按键分级：**自由**（`locale`、`outputStyle`、主题、壳模式、管家自身设置除档位外）；**须确认**（主端点／模型选择、`subagentPreferred*`、MCP 连接器启停与浏览器目标（经 `mcp_configure` 同款审批）、自治档位、通知设置）；**禁止经管家**（任何 `apiKey`／token 值、`RUYI_HOME`／数据目录、`localCommand`、线程 `permissionMode` 放宽到 `bypass`、授权书签发） |
| **内容管理** | `steward_playbook_draft`（起草用户 playbook，走既有 draft→保存 UI）、`steward_skill_toggle`（启停会话技能，须确认）、`steward_workbench_memory_propose`（只提议）、`steward_memory_*`（管家自身记忆：写／改／否决／检索，见 §4） | edit | 管家记忆自由；其余按档位 |
| **委派** | `steward_delegate`（把一段自然语言任务＋上下文摘要交给指定线程或新线程，内部即 `steward_thread_continue`；可指定 playbook） | exec | 这是管家唯一的「动世界」出口 |

约束：管家工具的 `paths:null`（不触任何文件路径，`guardNote` 写明）；所有写工具返回 `undoRef`（会话 rewind／checkpoint 或配置快照 id），决策日志记录；`steward_config_set` 的禁止键在 handler 内硬编码黑名单并有 e2e 矩阵；管家会话的 `nativeToolGate` 用独立模式 `steward`（映射表：read→allow，edit／exec 按档位），不复用线程的 permissionMode。

## 4. 管家记忆层（116d，独立于工作台记忆）

- **目的**：记住用户是谁、偏好什么、习惯怎样，并在路由、默认选项、语气、主动建议中使用；不是项目知识库（那是工作台记忆）。
- **存储**：`<data>/steward/memory-v1.json`（`atomicWriteJson`，103c 登记）；条目 `{id, kind, text, confidence, sourceSessionId, sourceSeq, createdAt, updatedAt, lastUsedAt, useCount, state:'active'|'vetoed'}`；`kind` 白名单：`profile`（身份／角色）、`preference`（格式／语言／风格）、`habit`（时间与流程习惯）、`focus`（当前关注的线程／项目）、`policy`（决策倾向，只作为白名单**建议**来源）。
- **自主写入的边界**：管家可无需确认写入，但必须：① 过敏感过滤（复用 `memoryProposalLooksSensitive`：密钥／口令／JWT／连接串一律拒绝）；② 只记用户本人陈述或用户确认过的事实，不记第三方个人信息；③ 单条 ≤ 300 字符、总量 ≤ 200 条、活跃注入 ≤ 3000 字符；④ 每条带来源（会话与 seq）与置信度；⑤ 新写入 24 小时内在面板带「新」标记，用户可一键否决（`vetoed`，且同义内容不再自动写回）；⑥ 去重合并（词项 Jaccard，113a 落地后加向量）。
- **活用**：路由（`focus`／`habit` 提升候选权重）；待决默认选项（`policy` 只在有界／全自动档且用户已确认为白名单时生效）；语气与格式（`preference`）；主动建议（`habit`，如「你通常周一整理上周任务」，一天最多一条，可关闭）。每次使用在回复里可解释（「因为你上次说…」悬停显示来源）。
- **隔离**：只注入管家提示词，绝不进普通会话；管家可**提议**工作台记忆但不能确认。
- **面板**：设置页「管家记得的关于你」：按 kind 分组、可编辑、可否决、可清空；导出为 JSON。

## 5. 第 117 波 · 管家壳层（开关默认关，经典壳仍默认）

| 切片 | 内容 | 门 |
|---|---|---|
| **117a 壳模式** | `SHELL_MODES` 加 `steward`；`normalizeShellMode` 改显式白名单（未知值回 classic）；`index.html:64` 预绘同步；`recoverStewardShell()` fail-closed（依赖缺失或开关关时回经典）；设置页三选一 | `pretender-shell.static` 新增同构断言（同级容器、默认 classic、单一状态源、零 innerHTML、零默认轮询税） |
| **117b avatar** | 2D 简单图形（圆＋环＋一对眼睛级别），状态：idle／listening／thinking／working／waiting_you／error／sleeping（开关关或停机）；数据源 = 112c `turnActivity` ＋ 管家阶段；动效只用 `--dur-*`／`--ease-out` token 与 CSS 变量，`prefers-reduced-motion` 下退化为静态色块＋文字；`aria-live="polite"` 文字等价（「正在查看线程 X」）；不用 canvas／WebGL | 新增 `steward-avatar.static.e2e.js`（状态枚举与 CSS 类一一对应、reduced-motion 分支、aria-live）；双主题截图 |
| **117c 对话区** | 简洁对话：管家的 `say` 为主；**默认不展示思维链与工具调用**；卡片三类（候选线程：标题＋最近一步＋置信度＋「打开」；提议：动作＋依据＋「批准／驳回」；通知摘要：合并同线程事件）；「细节」开关展开本回合工具轨迹（专家） | 静态锁（零 innerHTML、卡片契约）；真实浏览器 e2e（提议→批准→线程回合启动） |
| **117d 线程抽屉** | 「打开」在右侧抽屉复用任务单组件（现状头／五态／验收项／现场镜头），用户可直接对话（直连线程）；可钉住多个 | `pretender-task-sheet` 静态锁改拼接读取（组件被复用而非复制） |
| **117e 设置** | 管家模型、自治档位（切全自动二次确认）、轮询周期、费用上限、记忆面板、一键停机 | `provider-settings` 静态锁只加 |
| **117f dogfood 与门** | 用户连续使用两周；指标见 §2；记录误自动率与撤销次数；达标后才讨论默认壳切换（不自动恢复原 P4） | Release Brief |

## 6. 与 112 的关系与不做
- 112a（诊断）与 112b（事件消费补齐）**保留并前置**：管家的「三问」数据就是这些事件；112c 状态机是 avatar 的数据源；112d（长命令输出直播）与 112f（编排全貌）并入 117d 线程抽屉。
- 不做：ETA；在线学习／自动训练；管家自签授权书；把管家记忆混入普通会话提示词；三维或视频形象；在开关关时留下任何后台活动。

## 7. 排期（用户 2026-09-03 拍板，2026-09-04 补入 118／119）
110（结构）✅ → **118 新手引导**（28 号，改动面小、零风险，且 118a 的步骤定义被管家复用）→ 112a/112b/112c（事件管线＋状态机）→ 113a/113b（记忆向量与会话索引）→ **115 → 116 →（119 定时任务，29 号，可与 117 并行）→ 117** → 114（ASR）→ 111（压缩 v2）→ 107 批准点（并行回归偶发治理为 107 前置项）。理由：管家是 Pretender 3.0 的产品形态，应先于发布批准点闭环；压缩 v2 是引擎证据，可后置但不能缺席 107 的 Release Brief。

---

## 8. 管家 UX/UI 详细设计（用户 2026-09-03 要求「功能与 UX/UI 都要详细设计」）

### 8.1 设计原则与 UX 红线
1. **一个对话框就是主界面**：默认视图没有侧栏、没有标签页、没有工具栏矩阵；一切从对话与卡片展开。
2. **诚实优先于流畅**：管家说「我在做什么」必须来自真实事件（112b 补齐的事件流），不得靠文案猜测；不知道就说不知道。
3. **提议默认、执行需据**：任何写动作先有卡片、有依据、有撤销入口（27 §3.5 的 `undoRef`）。
4. **不让用户离开如意**（用户 2026-09-03 拍板）：**禁止「给你一个路径／命令，你自己去打开」这类交互**。手册在应用内阅读，文件夹在应用内打开，日志在应用内查看，配置在应用内改。凡是只能给路径的地方，先补一个真正能点的动作，再谈文案。
5. **可退化**：`prefers-reduced-motion` 下动效全关但信息不减；avatar 不可用时状态条文字仍在；管家不可用时经典壳仍能工作。
6. **不造未知**：不显示 ETA、不显示假进度条百分比；用「已运行 3 分 12 秒 · 第 7 次工具调用 · 上次输出 8 秒前」这类可验证事实。

### 8.2 信息架构（三层，逐层展开）
- **L1 管家页（默认）**：顶部 avatar ＋ 一行状态；中部对话流（消息与卡片）；底部输入框（附件、语音见 114、发送）。右上角只有两个常驻控件：自治档位指示（点开可改）与一键停机。
- **L2 线程抽屉**（右侧滑出，可钉住多个）：复用任务单组件（现状头／五态／可解释进度／现场镜头／台账），顶部有「在此线程直接对话」输入框（直连，不经管家）与「交回管家」按钮。
- **L3 面板**（模态或全宽页）：设置、记忆、定时任务、体检、审计流水。均可从管家对话里的卡片一键直达对应位置（deep link 到具体项，不是只打开面板首页）。

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

规则：同一时刻只有一个状态；状态切换有 120ms 交叉淡入避免闪烁；`waiting_you` 优先级最高（与 `mission-state.js` 的 `needs_you` 同源，不另起状态机）。

### 8.4 对话与卡片语法
管家的输出只有两种：**话**（一段简洁中文／英文）与**卡片**。默认不展示思维链与工具调用（用户 2026-09-03 决定）；对话区右上「细节」开关可展开本回合的工具轨迹（专家模式，状态记在本地不同步）。

| 卡片 | 何时出现 | 必备字段 | 动作 |
|---|---|---|---|
| **候选线程** | 用户说了一件事，管家判断可能属于既有线程 | 线程标题、最近一步（人话）、上次活动时间、匹配理由一句话 | 「在这个线程里说」／「新开一个」 |
| **提议** | 收件箱事件触发，或用户请求 | 要做什么、为什么（依据事件与记忆条目）、影响范围、档位说明 | 「批准」「改一下」「不用了」 |
| **通知摘要** | 后台事件合并 | 线程名、事件类型、发生时间、合并计数 | 「打开线程」「知道了」 |
| **定时任务** | 建立／即将触发／触发结果（见 29 号） | 人话计划、下次触发、上次结果 | 「暂停」「立即运行」「打开产出」 |
| **行动回执** | 管家执行完写动作（有界／全自动档） | 做了什么、依据、`undoRef` | 「撤销」「查看详情」 |

卡片纪律：一次回合最多 3 张卡片，多余的折叠成「还有 N 条」；卡片可键盘聚焦与操作；零 `innerHTML`（沿用 `pretender-shell.static` C8 口径）。

### 8.5 通知与打扰纪律
- 只有两类事件配得上系统级通知：**等你拿主意**（待决）与**失败**。进度、成功、心跳一律只在应用内。
- 同一线程 5 分钟内的同类事件合并成一条；静默时段（用户可设，默认 22:00–08:00）内只累积不弹窗，次日首次打开时给「你不在的时候」摘要。
- 管家自身的主动建议（来自记忆的 `habit`）**每天最多一条**，可永久关闭。

### 8.6 自治档位的界面表达
- 档位指示常驻右上：只提议（盾形）／有界自动（盾形＋齿轮）／全自动（实心圆）；hover 显示一句话含义。
- 切到「全自动」需二次确认，弹窗写明：它可以在你不在时改文件、跑命令、答复待决；每个动作都会记账并可撤销；随时可一键停机。
- **一键停机**常驻且永远可点：立即停轮询与在途管家回合，切到 `sleeping`，不影响已在跑的线程回合（那些由线程自己的权限门管）。
- 「行动流水」页按时间列出管家做过的每件事（依据、档位、`undoRef`、费用），支持按线程与按日期过滤。

### 8.7 记忆面板（对应 §4）
- 分组展示：关于你／偏好／习惯／当前关注／决策倾向；每条显示「来源」（哪次会话）与「用过 N 次」。
- 新写入 24 小时内带「新」角标；每条可编辑、可否决（否决后同义内容不再自动写回）、可删除；顶部「清空全部」。
- 使用可解释：管家在回复里用到某条记忆时，该句尾有一个可点的小标记，点开显示「因为你在 X 时说过 Y」。

### 8.8 键盘与无障碍
- 全流程键盘可达：`Tab` 循环在 输入框 → 卡片动作 → 档位 → 停机；`Esc` 关抽屉／面板；`Ctrl+K` 打开线程搜索；`Ctrl+Enter` 发送。
- 焦点可见（不移除 outline）；模态有焦点陷阱与还原；`aria-live="polite"` 播报 avatar 状态与卡片新增；对比度双主题均达 WCAG AA。

### 8.9 空状态与首次
- 首次进入管家页：一句话自我介绍 ＋ 三个可点的例子（「看看我有哪些线程」「明天 9 点提醒我交周报」「把下载文件夹整理一下」），不做教程弹窗（教程属 118 波向导）。
- 无线程时不显示空列表，显示「还没有任务，直接说你想做什么」。

### 8.10 明确不做
不做多窗口平铺、不做可拖拽仪表盘、不做主题自定义器、不做 avatar 换肤商店、不做 3D／视频形象、不做游戏化积分。

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
| 跨线程并行监督（多线程同时跑时的统一看板） | 候选 | 依赖 112f 编排全貌 |
| 交接摘要（把一个线程的上下文交给另一个线程） | 候选 | 依赖 113a 记忆向量与 111 压缩摘要质量 |
| 其它能力 | **待用户补充** | 用户 2026-09-03 提到「以及一些其它能力」，尚未具体化；提出后按本表登记编号 |
