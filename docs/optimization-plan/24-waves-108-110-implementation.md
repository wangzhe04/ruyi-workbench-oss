# 24 · 第 108–110 波实施方案（提示词自我认知／制图与交互／结构精简）

> **状态（2026-09-03）**：由 [`../OPTIMIZATION-ROADMAP.md`](../OPTIMIZATION-ROADMAP.md)「第 108–110 波」立项段（2026-09-02）派生的实施依据。本文只回答「怎么做、改哪里、怎么过门、怎么回退」；范围边界与执行序（108 → 109 → 110 → 107 批准点）以路线图为准，不在本文扩围。
> **摸底方法**：2026-09-03 对主树 HEAD `b80e36b` 逐行复核（`build --check` 新鲜；`prompt-snapshot.static` / `meta-guard` / `software-engineering-prompt.static` 三件当前全绿）。路线图立项段的行号与缺口清单全部核实成立，仅三处修正，见各波「摸底修正」表。
> **关联**：[23 号 架构偿还与上下文演进序列](23-architecture-repayment-sequence.md)（生成器链、零行为纪律、106 #1 前缀缓存 G1–G6 差距）、[22 号 Agent SoC](22-agent-soc-microarchitecture.md)（红线与发布门、Release Brief 四项）、`CONTRIBUTING.md` 五条红线。

---

## 0. 统一纪律（三波共用）

1. **红线不动**：纯离线、`server.js` 零 npm 运行时依赖、clean-room、Windows 一等、行为变更带 e2e 且断言只加不改语义（`CONTRIBUTING.md:5-11`）。
2. **切片分两类**：不改默认行为的切片（纯搬家、文档、只读工具补齐）**不设开关、无回退面**，回退＝还原该切片文件；改变默认行为的切片沿用 22 号纪律——独立开关、显式 `false` 回退、先单轴后组合。
3. **先锁现状再改**：每切片开工前跑对应静态锁与 `--before` 基线；改后必须重跑同一组门。旧端点、错误信封、鉴权、配对、审计、回滚与构建新鲜度不得漂移（23 号 §1）。
4. **生成器链固定顺序**（任何触碰 `app/src/` 的切片收尾必跑）：
   `node ruyi-workbench/app/build.js` → `node dev-harness/module-dependency-graph.js --write` 再 `--check`（出现新前向边／环边即停，人工评审后才能改 `module-dependency-policy.json`）→ `node dev-harness/route-inventory.js` → `node dev-harness/architecture-contract-snapshots.js --write` → `node dev-harness/durable-state-inventory.js --write` → `node dev-harness/facts-generate.js`（仅门面数字变化时）→ `node ruyi-workbench/app/build.js --check` → `node dev-harness/run-all.js --fast` → `node dev-harness/run-all.js --parallel 4`。没有一键脚本，必须按序手跑。
5. **提示词文本纪律**：任何提示词文本改动同步 bump `PROMPT_PACK_VERSION`（`06b-prompt-registry.js:10`，当前 `2026-w86-7`，格式 `20YY-wNN-K`），中英双包同改；只进 `06b` registry，不在 `06`/`09` 硬编码新文案。
6. **文件编码**：UTF-8 无 BOM、全 LF（`.gitattributes` 钉死；`build.js` 遇 `\r` 直接报错）；`server.js` 侧注释避免 U+2014 等易被编辑工具改写的标点。
7. **不夹带**：dev-harness 瘦身、realhist-fixtures 环境缺口、旧壳 P4／人因验证、ASR 均不进本三波。
8. **提交边界**：每切片一个 commit（110 波每个被拆文件一个 commit），信息格式 `feat|refactor|docs(scope): <切片编号> <一句话>`；commit 由用户拍板执行，实施代理只负责把工作树推进到「门全绿、边界清晰」。
9. **核验归属**：只读摸底由 haiku／sonnet 子代理完成，实现由 sonnet／opus 子代理完成，**主会话逐项用工具亲核**（本仓库子代理交付报告曾多次失实），门的 `ALL PASS` 输出必须由主会话复跑取得。

---

## 1. 第 108 波 · 系统提示词「自我认知」

### 1.1 摸底修正（相对路线图立项段）

| 路线图原文 | 主树事实 | 影响 |
|---|---|---|
| VERSION「仅进 config/日志/`/api/health`」 | 不存在 `/api/health`；实际是 `GET /health`（`13-http-router.js:1379-1381`）与信息更全的 `GET /api/status`（`:22-64`，含 version/overlayId/launchMode/dataRoot/exePath/isPkg） | 108c 自状态工具直接复用 `/api/status` 的数据装配，不新造事实源 |
| 工具 schema 在 `11-native-tools.js`/`12-tool-dispatch.js` | 单一真源是 `MCP_TOOLS`（`13-http-router.js:1685` 起）；`12` 是派发表、`11` 是实现体 | 新工具落点见 1.4 |
| `LAUNCH_MODE` 可直接读 | 声明在 `12-tool-dispatch.js:1284`、赋值在 `13:1340`，对 `06` 是前向边 | 身份块改用 `isPkg()`（`00-boot.js:36`）自行推导，不引入新前向边 |

已确认的注入现状：stable 层 1304–1325 字符（D3 闸 `<1500`）；volatile 在最小夹具 799 字符（D6 闸 `100–5000`）；`turnVolatile` 不进 system 通道而是注入 user 消息（G1 开关默认关＝前插历史首条 user）；无任何 `cache_control` 标记，前缀缓存完全依赖「system 逐字节不变 + 历史不改写」。子代理经 `buildProviderSystemPrompt`（`08-agent-runs.js:510`）取得 stable+volatile 但不含技能／工作台记忆／任务账本／模板清单。

### 1.2 逐项裁决表（进提示词 stable ／进提示词 volatile ／进工具 ／不进）

| 信息项 | 来源 | 裁决 | 理由 |
|---|---|---|---|
| 产品名＋版本号 | `APP_NAME`、`VERSION`（`00-boot.js:25-26`） | **stable** | 进程内恒定；「我是哪个版本」是最高频自答项 |
| 启动模式（exe／node） | `isPkg()`（`00-boot.js:36`） | **stable** | 恒定；区分打包版与源码版 |
| 安装位置 | `externalRoot()`（`00-boot.js:58`） | **stable** | 多版本共存时唯一可区分的位置事实 |
| 数据目录 | `dataRoot()`（`00-boot.js:48`） | **stable** | agent 需知道 skills／playbooks／会话落在哪 |
| 服务端口 | `RUNTIME.port`（`01-config.js:2042`，`13:1393` 赋值） | **stable** | 进程内恒定；用户问「哪个端口」可自答 |
| 实例标识 OVERLAY_ID | `00-boot.js:29` | **stable（短形式）** | 进程内恒定；重启后变化只造成一次前缀缓存 miss，可接受 |
| 当前时间、在线状态、会话 id | 各处 | **不进 stable**（在线状态已在 volatile 能力层） | 易变，破坏前缀缓存（106 #1 结论） |
| Playbook 清单 | `loadAllPlaybooks()`（`06-provider-engine.js:850`），当前被 `06:1489-1491` 过滤 | **volatile（精简索引）** | agent 至少要知道有哪些 playbook 并能建议用户在「技能库」运行；无运行工具，所以只给名称＋一句话＋入口说明，上限 12 条／600 字符 |
| 斜杠命令（kind:'command'） | `12-tool-dispatch.js:1465-1475` | **不进** | 供输入框补全的 UI 模板，agent 无法调用 |
| 技能索引 | 已有 `<skill-index>` | 维持 | 已覆盖 |
| 工作流模板、工作台记忆指引、mission | 已有 | 维持 | 已覆盖 |
| 「可改哪些设置」 | `mcp_configure` 实际只写 MCP 连接器与浏览器目标（`12:1260` guardNote、`06:1125-1127` 英文硬编码） | **volatile，改写为 registry 双语文案并说清边界** | 现文案是纯英文且未说明「provider／模型／权限模式／输出风格不能由 agent 改，请引导用户去设置面板」，这是「不太能自己改设置」的直接来源 |
| 全量工具清单 | `MCP_TOOLS` | **不进提示词，进工具**（已有 `list_tools`／`tool_search`） | 长度与缓存代价不可接受 |
| 自身运行时详情（健康项、config 掩码、启用技能／playbook 数、路由端口、数据目录布局） | `/api/status` 装配 | **进工具**：新增只读原生工具 `workbench_self_status` | 长尾信息按需取，不占提示词 |
| 子代理身份 | 经 `buildStableSystemPrompt` 自动获得 | **同步（自动）** | 子代理不加 playbook 索引与设置指引（它不与用户对话） |

### 1.3 切片

**108a · stable 层身份块**（opus）
- 落点：`06b-prompt-registry.js` 新增 `identity.runtime({ appName, version, launchMode, installDir, dataDir, port, instanceId })` 中英双包；`06-provider-engine.js:1343-1369` 在身份层之后、工具协议层之前拼入。数据全部来自 `00-boot.js`／`01-config.js`（后向边），**不得读取 `LAUNCH_MODE`**。
- 文案要点（zh）：运行在「如意 Ruyi」本地 AI 工作台 vX.Y.Z（exe／源码 模式）；安装位置；数据目录；服务地址 `http://127.0.0.1:<port>`；实例标识；「同一台机器可能装有多个版本，回答自身版本／位置时以此为准，不要猜测」。控制在 ≤ 260 字符（zh）。
- 非目标：不改 `identity()` 既有句子（D1 锁 `/本地 AI 工作台/`），不动工具协议层措辞，不动子代理路径。
- 过门：`prompt-snapshot.static` 全绿（若 D3 `<1500` 被 1325+260 突破，按其注释「intentional snapshot 上调」把阈值调至 `<1800`，并在断言文案写明 108a 原因——这是唯一允许改动的阈值）；新增断言（只加）：`D11 stable 含 VERSION 与服务地址`、`D11b stable 无 Claude/Workbench 字面量`、`D12 同进程两次构建逐字节相同`；`meta-guard`、`software-engineering-prompt.static`、**`capabilities.e2e.js`（身份泄漏守卫，108a-fix 后固定纳入）**、`build --check`；prompt-benchmark `--before`（改前）／`--after`（改后）diff=0。
- 红线（108a-fix 后补）：stable 层不得出现任何真实文件系统路径与含 "workbench"／"Claude" 的字面量（含工具名）；此类信息一律走 `workbench_self_status`。
- 回退：删除 registry 条目与拼入两行，重建 `server.js`。

**108b · volatile 能力层：Playbook 精简索引＋设置边界双语指引**（opus）
- 落点：`06-provider-engine.js:1372-1477` 能力层内。① 新增 `buildPlaybookIndexSection(playbooks, config)`：`<playbook-index>` 围栏，每行 `- 标题 [id]：一句话`（沿用技能索引的尖括号中和与 160 字裁剪），最多 12 条、整段硬顶 600 字符，尾行固定说明「由用户在技能库面板运行；你可以建议但不能直接执行」；playbook 列表由主回合调用方传入（与 `skillEntries` 同路径，`12-tool-dispatch.js:1477-1485` 已有 `pb:` 条目可复用），子代理不传。② `buildToolCustomizationHint()` 文案迁入 `06b` registry（zh／en），明确「可通过 mcp_configure 改的：MCP 连接器、浏览器目标；不可由 agent 改的：模型端点／模型／权限模式／输出风格／界面语言——请引导用户到设置面板，或用 workbench_self_status 读取当前值」。
- 非目标：不给 agent 任何写设置的新能力。
- 过门：`prompt-snapshot.static`（新增只加断言：volatile 含 `<playbook-index>` 开闭标签成对、600 上限静态存在性、D6 仍 `<5000`）；`skills-registry.e2e.js`、`meta-guard`；prompt-benchmark diff=0；`build --check`。
- 回退：删除两段注入与 registry 条目。

**108c · 只读原生工具 `workbench_self_status`**（sonnet，走第 49 波入库全部门）
- 返回：`{ app, version, launchMode, installDir, dataDir, port, instanceId, health[], counts:{ nativeTools, accTools, skillsEnabled, playbooks, workflows }, configMasked:{ provider, model, permissionMode, outputStyle, language } }`；数据装配复用 `/api/status` 使用的同一组函数（`computeHealth`、`maskProviders`），**不新造事实源**。
- 四处同步：`12-tool-dispatch.js` CORE 组条目 `{ paths: null, guardNote: '只读自状态,不触文件路径', handler }`；`13-http-router.js:1685` `MCP_TOOLS` schema（description 含「何时用／何时别用」）；`07-autonomy.js:193` tier `'read'`；`:275` pack `'core'`。
- 过门：`tool-dispatch.e2e.js:44` 工具数 62→63（数字断言按纪律更新）、L4/L5 自洽；`tools-v3` 安全模板不适用（无路径、无网络）；`facts-generate.js` 重算 `nativeTools`；`meta-guard` 门面数字；README 中「62 个原生工具」文案同步；`capabilities.e2e.js` 不受影响。
- 回退：删四处条目与 e2e 数字，重算 facts。

**108d · A/B 收口与记录**（主会话）
- `PROMPT_PACK_VERSION` → `2026-w108-1`；`CHANGELOG.md` Unreleased 补两条（中英）；路线图「第 108 波」段追加交付记录；prompt-benchmark `--after` 与 `--before` 比对 diff=0 作为证据；stable 层新增字符数与 D3 实测值入记录。
- 前缀缓存计量：以 `prefix-layout.e2e.js` 既有 `layout_shadow` 事件确认两回合 `stablePrefixChars` 不因 108a/108b 下降（108b 注入在 volatile，不影响 system 前缀）。

**108e · 候选（需用户拍板，本波不实施）**：`workbench_config_set` 白名单写设置工具（outputStyle／responseLanguage 两键，edit tier）。涉及权限面，需另写威胁模型与 Release Brief。

#### 交付记录

- **108-0 · 门修复（2026-09-03，主会话）**：开工前快通道实测 HEAD 有 3 件静态锁已红，均为上两次提交遗留漂移、与本波无关：① `facts.static` e2eCount 260 vs 目录重算 262 → `facts-generate.js` 重算；② `route-inventory.static` 行号漂移（`e08137d` 改 `13-http-router.js` 后未重算）→ `route-inventory.js` 重算，判定点仍 101／ROUTE_AUTH 92；③ `runtime-optimization.static` S 段钉 `expectedOutputTokens: 2048`，而 `c7d2507` 已把规则 JSON 与内嵌 fallback 同改为 6144 → 按同值重钉并在断言文案注明。修后 `run-all.js --fast` 46/46 全绿。
- **prompt-benchmark 基线校准（2026-09-03）**：`--before` 重算得 3/4 通过（2 跳过），`lsr-01` 由旧 baseline 的 pass 变为 fail——根因是 `99f3a9a` 的 loop-guard 分层（读工具第 3 次只警告、不再第 5 次中止，`07-autonomy.js:228` `loopWarnOnly`、`09-workflow.js:2646`），种子判定过时而非回归；108d 收口时新增写工具种子 `lsr-02`（`file_edit`×5 应中止）并把 `lsr-01` 判定改为分层语义。
- **108a（2026-09-03，opus 实现／主会话亲核）**：`06b-prompt-registry.js` 新增 `runtimeIdentity` 中英双包；`06-provider-engine.js` 新增 `buildRuntimeIdentityFacts()`（只读 `00-boot`／`01-config` 恒定量，`exe/node` 由 `isPkg()` 推导，不读 `LAUNCH_MODE`），`buildStableSystemPrompt` 在身份层后、工具协议层前注入，`identityOnly` 不注入；`14-main.js` 导出。stable 长度夹具实测 1324 → 1568（+244），D3 阈值按注释纪律上调至 `<1800`；新增 D11（含版本／数据目录／实例标识）、D12（同进程两次构建逐字节相同）、D13（identityOnly 不含）。门：`build --check` 新鲜；依赖图 30 模块／240 边／65 前向边零新增（只新增对 `00-boot`／`01-config` 的后向 requires）；`prompt-snapshot`／`software-engineering-prompt`／`meta-guard`／`subagent`／`agent-loop` 全绿；`run-all --fast` 46/46；`prompt-benchmark --after` 与基线 0 差异。未 bump `PROMPT_PACK_VERSION`（108d 统一）。
- **108b（2026-09-03，opus 实现／主会话亲核）**：① `buildPlaybookIndexSection(playbooks, config)`（`06-provider-engine.js`）生成 `<playbook-index>` 段：尖括号全部中和为方括号、描述裁 160 字、最多 12 条、整段硬顶 600 字符、整行装箱＋省略行、`available:false` 后置并标「（当前不可用）」，空列表零注入；`buildVolatileParts`／`buildProviderSystemPrompt` 末位新增可选 `playbookEntries`，主回合（`09-workflow.js`）用 `loadAllPlaybooks()`＋本回合 `caps` 现算可用性（不重扫技能四源）；Claude 引擎路径（`05-claude-engine.js`）与技能索引同信道 stdin 对称注入；子代理 7 参数形态不注入（实测 false）。② `buildToolCustomizationHint(config)` 文案迁入 registry 双语：中文 297 字符保留原六条安全句并新增边界「可改：MCP 连接器、浏览器目标；不可改：模型端点／模型／权限模式／输出风格／界面语言 → 引导用户去设置面板」；英文包原句逐字保留＋追加边界句；`browser-mcp.static` 既有断言文字未改，取值改为显式 `{locale:'en-US'}`（该锁本就锁英文原文），另只加一条中文默认包断言。夹具实测：volatile 无 playbook 799（与改前逐字节一致）、内置 15 条 playbook 时 +553。新增 D14–D17 共 13 条只加断言。门：构建新鲜；依赖图 30／240／65 零新增；`prompt-snapshot`（55 PASS）／`software-engineering-prompt`／`meta-guard`／`skills-registry`／`subagent`／`browser-mcp.static`／`index-dedup`／`claude-cmdline-guard` 全绿；`run-all --fast` 46/46；`prompt-benchmark --after` 0 差异。
- **108a-fix（2026-09-03，用户发现／主会话裁决／随 108c 落地）**：`capabilities.e2e.js` 的身份泄漏守卫（`/Claude/i`、`/Workbench/i`，扫整段 stable 与实况 system 前 800 字符）被 108a 的 `installDir`／`dataDir` 触发——默认数据目录 `.win-claude-workbench` 与源码目录 `ruyi-workbench` 必含 "workbench"，是默认安装即触发的真回归，根因是 108a 门清单漏了 `capabilities.e2e.js`。修法取 (b)：stable 层 `runtimeIdentity` 只保留产品名／版本／启动模式／服务地址／实例标识，末句改为「安装位置与数据目录不在此处，需要时用自状态查询工具获取」（stable 文字不得含 `workbench_self_status` 字面量）；`buildRuntimeIdentityFacts()` 仍返回两个路径供 108c 工具使用。D11 改为断言服务地址，新增 D11b 镜像守卫。修后 `capabilities.e2e.js` ALL PASS。**教训入纪律**：提示词切片门清单固定加入 `capabilities.e2e.js`。
- **108c（2026-09-03，sonnet 实现／主会话亲核）**：`workbench_self_status` 只读工具四处登记（`12-tool-dispatch.js` CORE 组 `paths:null`；`13-http-router.js` `MCP_TOOLS` schema 含「何时用／何时别用」；`07-autonomy.js` tier `read`、pack `core`），身份字段复用 `buildRuntimeIdentityFacts()`，`health` 复用 `computeHealth`，`counts` 取 `TOOL_HANDLERS`／`caps.desktopMcp.toolCount`／`loadSkillRegistry` 分类计数／`getAgentWorkflows`，`config` 只输出白名单标量（engine／providerId／providerLabel／model／permissionMode／outputStyle／locale），`section` 参数控量；`06b` 新增 `capability.selfStatus` 一句话，按 offered 注入 volatile。门：`tool-dispatch.e2e` L1 62→63 重钉；新增 `workbench-self-status.e2e.js`（版本三角、密钥黑名单扫描、四种 section 键集、tier/pack，跑两遍）；`facts-generate.js` nativeTools 63；README 三处「62 个原生工具」＋两处锚点同步 63；依赖图 30 模块／242 边、零新增前向边；`capabilities`／`prompt-snapshot`（D18/D18b）／`meta-guard`／`facts.static`／`subagent` 全绿；`run-all --fast` 46/46；`prompt-benchmark --after` 0 差异。
- **108d（2026-09-03，sonnet 代码部分／主会话文档与出门）**：`PROMPT_PACK_VERSION` `2026-w86-7` → `2026-w108-1`（D9 锁通过）；prompt-benchmark 种子分层化——`lsr-01` 判定改为 `tool_count:5 + loop_warning_at:3 + no_loop_abort + not_budget_exhausted`（只读工具第 3 次带 `loopWarning`、不中止），新增 `lsr-02`（`file_edit`×5，真实 schema 键 `oldText/newText`，第 5 次 `loopAborted:true` 且含「连续 5 次相同工具调用」），`run.js` judge 只加 `loop_warning_at`／`no_loop_abort` 两判据，README 列全 7 个种子；重基线 `--before`×2 与 `--after`×2 均 `5/5 seeds pass (2 skipped)`、0 差异、两次逐字节一致。A/B 证据链：108a/108b/108c 各自对**改前基线**（pre-108，含旧 lsr-01 fail）`--after` 0 差异；108d 重基线后 0 差异。`CHANGELOG.md` Unreleased 已补中英三条；路线图 108 段已补交付记录。**出门门**：`run-all.js --parallel 4` 全量回归（结果见下一条）。
- **108 出门回归第一轮（2026-09-03）**：`run-all.js --parallel 4` = 251 pass／5 fail／4 flaky（256 ran／7 skipped；端口审计零撞车、unit 全过、构建新鲜）。五败串行单跑定性：`context-compact-v2`／`perf`（冷启动 5.3s>5s）／`mission-result` 为并行负载偶发，单跑全过；`budget-guard` E4/E30 与 `steering-claude`（10 项）确定性失败，且在干净 HEAD 短路径 worktree 上均 ALL PASS → **两者均为第 108 波引入**。归因：budget-guard 比较两套独立拉起（随机端口、不同进程）工作台的请求体，108a stable 层的服务地址与实例标识跨进程必不同 → 裁决 stable 身份块只保留产品名／版本／启动模式（进程不变量），端口／安装位置／数据目录／实例标识全部走 `workbench_self_status`（顺带消除重启后一次前缀缓存失效）；steering-claude 疑为 108b 在 Claude 引擎路径新增的 playbook 注入引入了一次冷缓存 `getCapabilities` 网络探测等待，使插话先于回合登记到达——以 bisect 定性后修（改用不探测的缓存读取）。4 件 flaky（`e2-append-system-prompt`／`semantic-loop-guard`／`orchestration-blindspots`／`rewind`）首跑失败重跑通过，记入后续治理清单，不阻塞出门。
- **108-fix2（2026-09-03，opus 实现／主会话亲核）**：① budget-guard：`runtimeIdentity` 签名收窄为 `{appName, version, launchMode}`，ZH/EN 同改，末句改为「服务端口、安装位置、数据目录与实例标识不在此处，需要时用自状态查询工具获取」；`buildRuntimeIdentityFacts()` 七字段不变（供 `workbench_self_status`）；D11 改为断言版本＋「运行环境」，新增 D11a 断言 stable 不含 `http://127.0.0.1` 与 instanceId。② steering-claude：二分决定性——整块禁用或仅把 `await getCapabilities(config)` 换成 `null` 均转绿，根因是冷缓存 `probeAny(targets, 3000ms)`＋桌面 MCP 探测在 CLI spawn 前阻塞数秒，回合登记晚于测试 500ms 时发出的 `/api/steer`；修法新增 `peekCapabilities()`（纯读 `_capCache`，`06-provider-engine.js:239`，`14-main.js` 导出），Claude 路径缓存冷时跳过可用性标注（不标「当前不可用」）、缓存热时与 108b 原设计一致，spawn 前不再有任何探测等待。门：构建新鲜；依赖图 30／242 零新增前向边；契约快照 current；`budget-guard`／`steering-claude`×2／`capabilities`／`prompt-snapshot`／`workbench-self-status`／`index-dedup`／`skills-registry`／`claude-cmdline-guard`／`e2-append-system-prompt`／`interactive-question`／`meta-guard` 全绿；`run-all --fast` 46/46；`prompt-benchmark --after` 0 差异。遗留：`06b:60` 设置指引字符串内含 2 个 U+2014（字符串非注释，功能无影响，110 SPEC 编码节处理口径）。
- **108 出门回归第二轮（2026-09-03）✅**：`run-all.js --parallel 4` = **256 pass／0 fail／4 flaky**（256 ran／7 skipped；端口审计零撞车、unit 全过、构建新鲜）。4 件 flaky（`perf-config-cache`／`pretender-gate`／`reject-attribution`／`summary-parallel-cap`）与第一轮名单完全不同，属并行负载时序，记入治理清单。**第 108 波宣告出门**。**已分批提交（2026-09-03，用户授权）**：`6ce2dc2` 108-0 静态锁重钉 → `0830379` 第 108 波后端（108a–108d，含 fix／fix2；生成物共享故合为一批，12-tool-dispatch 的 vendor-libs 文案顺带）→ `4603848` 第 109 波前端（109a＋109b，同文件强耦合）→ `006c3b8` 109c ACC＋facts／README 门面数字 → `0c4831e` 规划文档与 CHANGELOG。

### 1.4 风险
- stable 层加长 ≈ 260 字符，每回合固定成本增加但落在缓存前缀内，费用影响可忽略；真正的风险是把易变值误放 stable，108a 过门加了「同进程两次构建逐字节相同」断言防呆。
- playbook 索引来自用户可写的 `dataRoot/playbooks/*.json`，标题与描述是不可信文本，必须复用技能索引的围栏字符中和。

---

## 2. 第 109 波 · 制图与日常交互（ACC／原生工具／前端）

### 2.1 摸底修正与选型裁决

| 事实 | 位置 | 裁决 |
|---|---|---|
| 前端 vendor 范式已存在：`app/public/vendor/` 放预编译 min.js，`index.html:1127-1128` 引用，`THIRD-PARTY-NOTICES.md:12-21` 逐条记名／版本／许可 | 同左 | Mermaid 走同一范式（MIT，合规）；CSP `script-src 'self'` 天然要求自托管 |
| 拦截钩子：`highlightIn()`（`chat-render-primitives.js:136-167`）逐 `pre code` 调 hljs | 同左 | `code.language-mermaid` 在此分流，不碰 marked |
| ACC 侧 0 mermaid／graphviz／pydot；mermaid-cli 需 puppeteer | `requirements_offline.txt` | **不做 ACC 侧 Mermaid 出图**（离线红线＋重依赖） |
| 工具产出图片无聊天内联展示，只有侧栏「预览」经 `GET /api/file/preview`（`file-browser.js:134-198`、`03-bridge-guard.js:902-917`，含大小上限） | 同左 | 109b 在工具卡内复用该端点做缩略图，零后端改动 |
| `chart_image` 仅 bar/line/pie/scatter（`office_chart.py:124-125`）；`excel_chart` 无 scatter（`office_excel.py:366-408`） | 同左 | 109c 补型，工具名不变，不触发工具数同步面 |
| `BRIDGED_WRITE_PATH_ARGS` 实际在 `02-session-store.js:3103-3139`（路线图行号旧） | 同左 | 109 不新增写族工具，此表不动 |
| 本机仅有他人产品打包 chunk 形式的 mermaid | 本机搜索 | 不得取用；须从上游正式发布物获取 |

**Mermaid 渲染选型**：前端 vendor `mermaid.min.js`（11.x，约 2.7–2.9 MB），**按需懒加载**（首次遇到 mermaid 围栏才注入 `<script src="/vendor/mermaid.min.js">`），`securityLevel: 'strict'`，主题随亮／暗切换，渲染失败或 vendor 缺失时**优雅降级为普通代码块＋一行提示**（满足离线红线的降级要求）。

**决策点（用户）**：vendoring 需要一次下载上游发布物 `mermaid@11.x` 的 `dist/mermaid.min.js`（npm registry／jsDelivr，约 2.8 MB）。实施代理不执行下载；109a 的代码路径以 e2e 桩（假 `window.mermaid`）验证，真实文件由用户放入 `app/public/vendor/` 后再跑一次真实浏览器走查。包体影响：Full／Slim 均增加约 2.8 MB 静态文件，建议接受（懒加载，不影响首屏）。

### 2.2 切片

**109a · Mermaid 渲染链路＋降级**（opus）
- 落点：`chat-render-primitives.js` 新增 `renderMermaidBlocks(container)`（在 `highlightIn()` 前分流 `code.language-mermaid`）；新文件 `js/mermaid-runtime.js`（懒加载器、单例初始化、主题映射、失败降级、「查看源码／复制／导出 SVG／PNG」四个动作）；`index.html` 不预加载（懒注入）；`12-tool-dispatch.js:1347` 健康项 `vendor-libs` 文案追加 mermaid 存在与否（缺失不降级健康等级）；`THIRD-PARTY-NOTICES.md` 补 mermaid 行；`overlay-payload-lock.static.e2e.js` 的 `PAYLOAD_FILES` 若列举 vendor 文件则补登记；`frontend-domains.static.e2e.js` 若锁 js 域清单则补新文件。
- 安全：mermaid 输出 SVG 插入发生在 `sanitizeNode()` 之后，必须在容器上禁止 `<foreignObject>` 内脚本（strict 已禁）、禁 `click` 回调；流式增量重渲染路径（`renderMarkdownInto` 复用）要确认不会反复销毁已渲染 SVG（按源码文本做键缓存）。
- 过门：新增 `mermaid-render.static.e2e.js`（懒加载契约、降级路径、CSP 未改、THIRD-PARTY 条目、无 CDN 字符串）；`ui-bugfix.static`、`frontend-domains.static`、`overlay-payload-lock.static`、`eol-policy.static`；有真实 vendor 文件后做双主题＋390px 走查截图入记录。
- 回退：删 `mermaid-runtime.js`、分流两行、通知条目与 vendor 文件。

**109b · 工具结果图片内联缩略图**（sonnet）
- 落点：`toolCard()`（`chat-render-primitives.js:361-410`）对结果对象中的 `path`／`output_path`／`save_path` 且扩展名 ∈ png/jpg/jpeg/gif/webp/bmp 的工具（`chart_image`、`desktop_screenshot`、`window_screenshot`、`screenshot_full`、`get_clipboard_image`、`image_resize`）追加「缩略图」区：懒请求 `GET /api/file/preview?path=`，`kind:'image'` 时显示 `<img>`（受既有 `PREVIEW_IMAGE_MAX` 约束），`image-toobig` 时显示按钮跳侧栏预览。零后端改动。
- 过门：新增静态断言并入 `ui-bugfix.static.e2e.js` 或新建 `tool-image-inline.static.e2e.js`（工具名白名单、扩展名白名单、只用既有 token 端点）；`capabilities.e2e.js` 不受影响。
- 回退：删该区块。

**109c · ACC 出图补型**（sonnet）
- `chart_image` 新增 `hbar`、`stacked_bar`、`area`（复用现有 series 结构，matplotlib 可选依赖降级路径不变）；`excel_chart` 新增 `scatter`（openpyxl `ScatterChart`）。工具名与数量不变 → `smoke_registry.py` 108 断言不动；更新 docstring「Args」段（`smoke_descriptions.py` 规则）；补 `smoke_v19x.py` 或在既有 smoke 内加型别断言；`dev-harness/fake-mcp.js:210-211` 的 chart_image 契约字段若新增（如 `chart_type` 回显已有）保持形状不变。
- 过门：`python -X utf8 mcp/ai-computer-control/tests/smoke_registry.py`、`smoke_toolsets.py`、`smoke_descriptions.py`、新增型别 smoke；`fake-mcp-contract.e2e.js`、`checkpoint-coverage.e2e.js`（不新增写族名，零漂移）。
- 回退：还原两个 py 文件与 smoke。

**109d · 日常交互不爽点（dogfood 主渠道）**：本波仅立收录位（本文 §2.4），逐条以「复现路径／分级／修法／验收」补录，冻结前可追加；不预写内容。

#### 交付记录

- **109a（2026-09-03，opus 实现／主会话亲核）**：新增 `js/mermaid-runtime.js`（懒注入 `/vendor/mermaid.min.js`、单飞、8s 超时、失败恒解析 `null` 且不重试；`securityLevel:'strict'`、`startOnLoad:false`、不调 `bindFunctions`；零外链字符串；导出 `ensureMermaid`／`renderMermaidBlocks`／`mermaidSourceHash`／`mermaidThemeFor`）；`chat-render-primitives.js` 以依赖注入方式接入（顶部 ESM import 会让 vm 直跑该文件的 unit 测试编译失败），`highlightIn` 同趟分流并把 `language-mermaid` 排除出 hljs；`app.js` 组合根注入；工具条「源码／复制／导出 SVG／导出 PNG」；包裹节点 `data-mermaid-hash`＋`data-mermaid-theme` 双键防重渲染（本仓库流式期间正文为纯文本节点，只有 `sealLiveTextSegment` 与整会话重绘走 Markdown，不存在半截围栏）；CSS 落 `css/views/chat-narrative.css`，D51 SHA 重钉（`read-frontend-css.js:92` 加 109a 注释）；`computeHealth` `vendor-libs` 详情追加 mermaid present/absent（ok 语义不变）；`THIRD-PARTY-NOTICES.md` 补 mermaid 行；`build-overlay.js` 新增 `OPTIONAL_PAYLOAD_FILES`（存在才复制，缺失打日志），`overlay-payload-lock.static` ③ 判定扩为「必需或可选登记」并加 3 条只加断言（**裁决：接受**——登记语义不弱化，只新增「可选载荷」类别，且文件缺失必须降级是离线红线的正式路径）。真机走查发现并修掉一处双重点击回归（`makeButton` 同时挂 `addEventListener` 与 `onclick`），补 3 条断言。门：新增 `mermaid-render.static.e2e.js` 57 条全过；`ui-bugfix.static`／`frontend-domains.static`／`overlay-payload-lock.static`／`i18n.static`／`eol-policy.static` 全绿；`run-all --fast` 47/47；`capabilities`／`facts.static`（e2eCount 重算）／`meta-guard` 全绿。**vendor 文件未下载（用户决策点）**：从 npm 发布物 `mermaid@11.x` 取 `dist/mermaid.min.js`（约 2.7–2.9 MB）放入 `ruyi-workbench/app/public/vendor/`，用 `node dev-harness/mermaid-render.static.e2e.js` 与一段 ```mermaid 围栏验证；未放入时功能按设计降级为带提示的代码块。
- **109b（2026-09-03，sonnet 实现／主会话亲核）**：`chat-render-primitives.js` 新增纯函数 `detectToolImagePath(toolName, result)`（8 个白名单工具、剥 `serverId__` 前缀、5 个路径键、6 种扩展名、`success:false`／`ok:false` 拒绝）与 `renderToolImageInto(host, name, result)`（dataset 标志在首个 `await` 前置位，双调不双取；复用 `api()` 走既有 `GET /api/file/preview`，`kind:'image'` 出 `<img>` 可展开／收起，`image-toobig` 出「在侧栏预览」按钮复用 `openToolPane`＋`renderFilePreviewInto`，其余静默）；`toolCard()` 只在结果最终且非错误时触发；`chat-stream-runtime.js` 在 `tool_result` 到达时与 `renderGitDiffInto` 并列调用；`app.js` 组合根注入 `openFilePreview`。CSS 落 `css/states/chat-live.css`，D51 SHA 再次重钉；i18n 三键四文件同步。门：新增 `tool-image-inline.static.e2e.js` 41 条全过；`ui-bugfix`／`frontend-domains`／`mermaid-render`／`i18n`／`eol-policy` 静态全绿；`run-all --fast` 48/48；`capabilities`／`facts.static`（e2eCount 265）／`meta-guard` 全绿；零后端改动。
- **109c（2026-09-03，sonnet 实现／主会话亲核）**：`chart_image` 新增 `hbar`／`stacked_bar`／`area`（共 7 型；hbar 标签落纵轴、stacked_bar 柱顶标总和、area 叠加透明填充），`excel_chart` 新增 `scatter`（openpyxl `ScatterChart`，首列为数值 X、其余列为 Y 系列），工具签名、返回契约、工具数 108 与 ACC 版本 1.9.1 均不变；docstring 补「何时用／何时别用」与 Args；新增 `tests/smoke_v192_chart_types.py`（7 型渲染＋非法型＋excel scatter/bar 结构断言，无依赖 SKIP）。门：`smoke_registry`／`smoke_toolsets`／`smoke_descriptions`／`smoke_v192`×2／`smoke_v16`／`smoke_v171` 全过（venv＋`PYTHONPATH=src`，未安装任何包）；`fake-mcp-contract`／`checkpoint-coverage`／`capabilities`／`facts.static`／`meta-guard` 全绿；`facts.json` accSmokes 15→16，README 两处同步。

- **109 出门回归（2026-09-03）**：`run-all.js --parallel 4` = 256 pass／2 fail／9 flaky（258 ran／7 skipped）；两败（`interventions-persist` 12 项、`context-compact-v2` D6）与两件可疑（`interventions-snapshot`／`claude-resume-recovery`）串行单跑全部 ALL PASS，属并行负载偶发；本轮偶发 9 件（`failover`／`metrics-panel`／`orchestrate-model-select`／`observation-recall-replay`／`rewind`／`playbooks`／`provider-compact`／`read-pool`／`source-fields`）明显多于 108 两轮（各 4 件），已追加一轮**串行**全量作为确定性证据：**`run-all.js`（串行）= 258 pass／0 fail／1 flaky（`subagent` 首跑失败重跑通过）**，**第 109 波宣告出门**（2026-09-03）。三波累计的 flaky 名单并集交 112/110 治理：`--parallel 4` 在本机 4 核负载下时序敏感件的 120s 超时与健康轮询阈值需要评审。

### 2.3 新增 ACC 工具时的机械同步面（本波未触发，备查）
`smoke_registry.py:65-66`（总数 108）、`smoke_toolsets.py:57`、`smoke_descriptions.py`、`BRIDGED_WRITE_PATH_ARGS`（`02:3103-3139`，写族必登记）、`fake-mcp.js` TOOLS＋分支双侧、`fake-mcp-contract.e2e.js:197-205` 名集逐字符锁、`checkpoint-coverage.e2e.js` `ACC_TOOL_NAMES_FROZEN`（只 WARN）、`facts-generate.js` accTools 探针、README 多处「108 个 ACC 工具」文案。

### 2.4 dogfood 不爽点收录位
（待补；每条格式：`编号 | 复现路径 | P0/P1/P2 | 建议修法 | 验收标准`）

---

## 3. 第 110 波 · 结构化重构与代码精简（先规范、后拆分）

### 3.1 摸底修正
- 实际 >2000 行后端模块为 **8 件**（路线图列 5 件）：`09-workflow` 3370、`02-session-store` 3176、`05b-kimi-bridge` 2752、`13-http-router` 2603、`01-config` 2423、`10-context-governance` 2249、`08-agent-runs` 2219、`11-native-tools` 2057（SPEC 起草时复核补入）；前端 `preview-shell.js` 3557、`preview-shell.css` 1982。
- 46 件 static e2e 的锁均为 `read(path.join(SRC,'<file>'))` ＋ 正则／字面量断言，**无绝对行号断言**；风险只在文件名硬编码。按文件名精确命中：`09` 6 件、`02` 5 件、`13` 4 件、`01` 2 件、`05b` 1 件、`preview-shell.js` 7 件。`finalize-segments.static` 用 `vm` 加载 `02` 片段、`ec-d-closure.static` 有组合根行数护栏（1240）需按搬家结果重钉。
- 兼容技巧先例：`pretender-task-sheet.static.e2e.js:13` 把单文件读取改为「多文件字符串拼接读取」，断言内容不变。
- `facts.json` 不含模块数／行数，与拆分脱钩；`manifest-ranges.static` 完全由 manifest 驱动，对新增模块最鲁棒；`moduleLayer()` 正则（`module-dependency-graph.js:38-47`）只允许 `05/06/13` 层带字母后缀，其他层新增 `NNx-` 文件会落 `unclassified`，须先扩正则（dev-harness 改动，非运行时）。
- 唯一隔离样本：`06c-agent-loop-hooks.js`（IIFE 命名空间＋注入依赖＋冻结导出），被 `module-dependency-graph.static.e2e.js:52-61` 锁定，可作 SPEC 的「良好隔离模块」范式。

### 3.2 阶段 ①：SPEC 先行（新建 `docs/ENGINEERING-SPEC.md`，sonnet 起草、主会话定稿）
大纲（须尊重五条红线与 23 号裁决）：
1. 适用范围与红线引用（不复述，链接 CONTRIBUTING／23 号 §1）。
2. 后端模块分层与命名：`NN[x]-domain.js` 前缀＝拼接顺序＝层级；层级表沿用 `moduleLayer()`；新模块名必须落入正则（本波把正则扩为所有层允许字母后缀）。
3. 规模上限：`app/src` 单模块目标 ≤ 2000 行、硬上限 2500（新文件）；前端单 js ≤ 1500、单 css ≤ 1200；超限文件登记「拆分待办表」而非立即违规。
4. 模块边界：`provides/requires` 由生成器机器化；新增前向边／环边需架构评审并写入 policy；新建独立模块优先 06c 式 IIFE 命名空间＋注入依赖；**不做全树 IIFE 化**。
5. 纯搬家拆分 SOP（见 3.4）与 commit 格式。
6. 注释与编码：UTF-8 无 BOM／LF；`server.js` 侧注释避免 U+2014 等；中文注释允许，标点用 ASCII 或中文全角但不混用破折号。
7. 测试断言纪律：只加不改；静态锁用正则与多文件拼接读取，不写绝对行号；门面数字只经生成器；新 e2e 自查清单（临时 HOME、健康轮询、taskkill 清理、PASS/FAIL 逐条、跑两遍）。
8. 前端：原生 ES Modules、无 bundler；CSS 载荷分组变更必须同 commit 重钉 `LEGACY_STYLES_SHA256`（`read-frontend-css.js:90`）。
9. 明确不做：不改运行时行为、不设开关、不动 session v2／Intervention／权限门／checkpoint 协议、不夹带 dev-harness 瘦身。

### 3.3 阶段 ②：拆分顺序表（每文件一个 commit，纯搬家）

| 序 | 源文件 | 搬出内容 → 目标模块（拼接位置） | 需同步的锁 |
|---|---|---|---|
| 1 | `13-http-router.js` | `MCP_TOOLS` schema 数组（`:1685-~2470`）→ `13f-native-tool-schemas.js`，manifest 放在 `13-http-router.js` **之前**（使 13→13f 为后向边；`04-permission-runtime.js:1604`、`11-native-tools.js:2050` 的引用须核实为运行时读取） | route-inventory（判定点数不变）、`memory-toolbox.static`、`pretender-*.static` 4 件改拼接读取、architecture-contract-snapshots |
| 2 | `01-config.js` | `ROUTE_AUTH` 表（`:2290-2380` 附近）→ `01b-route-auth.js`；运行时开关默认值＋sanitize 表 → `01c-runtime-flags.js` | `route-inventory.js` 读 ROUTE_AUTH 的路径、`acc-offline-installer.static`、`runtime-optimization.static` 的 sanitize 邻接断言（改拼接读取）、moduleLayer 正则扩展 |
| 3 | `02-session-store.js` | `BRIDGED_WRITE_PATH_ARGS` 表 → `02b-bridged-write-args.js`；turn segment builder（`createTurnSegmentBuilder`）→ `02c-turn-segments.js` | `finalize-segments.static`（vm 片段来源）、`ec-d-closure`／`turn-narrative`／`resume-banner-dismiss`／`pretender-return-archive` 改拼接读取、fake-mcp-contract（导出名不变） |
| 4 | `09-workflow.js` | 回合提示词装配（`volatileExtras`、`buildBodyWithLayout`、`appendPromptToLastUserMessage`）→ `09b-turn-prompt-assembly.js`；模型调用与流事件 → `09c-model-call.js`（视依赖图结果决定是否合并为一个） | 6 件 static 改拼接读取；`prompt-snapshot.static` D8–D10 的 `src` 来源；`software-engineering-prompt.static`；meta-guard 引用计数 |
| 5 | `05b-kimi-bridge.js` | 流解析／事件归一 → `05e-kimi-stream.js` | `module-dependency-graph.static:57` 文件名列表 |
| 6 | `10-context-governance.js`、`08-agent-runs.js` | 候选：压缩执行体／子代理运行记录持久化 | 按 4 的同法 |
| 7 | `preview-shell.js` | 把第 100 波五域骨架填实：任务单／镜头／收工／交办台首页各自搬出主体 | 7 件 `pretender-*.static` 全部改拼接读取（task-sheet 已是） |
| 8 | `preview-shell.css` | 按视图区块拆 3–4 文件，同 commit 更新 `CSS_PAYLOAD_GROUPS` 并重钉 SHA | `frontend-domains.static` D51 |

顺序理由：1／2 触碰最少的 static 锁且收益立竿见影；4 排在 108 之后（108 改动 06/09 的提示词装配，先完成行为切片再搬家，避免搬家与行为改动交叉）；7／8 独立于后端，可与后端拆分交替进行但不并行提交。

#### 交付记录

- **110-0 SPEC（2026-09-03）**：`docs/ENGINEERING-SPEC.md` 由 sonnet 起草、主会话定稿（含 §3 搬家端点重归属特例），随 `0c4831e` 入库；起草基线含 108 在途改动，行数表在各拆分步骤 1 重测。
- **110-1（2026-09-03，opus 实现／主会话亲核／`commit` 单独成批）**：`MCP_TOOLS`（`13-http-router.js:1685-2439`，755 行）逐字节搬入 `13f-native-tool-schemas.js`（manifest 插在 13 之前，13→13f 后向边）；13 号 2615→1861 行；`server.js` 多重集差分新增 3 行注释／空行、删除 0 行；依赖图 30/242/65 → 31/243/65，符号集合增删为空；policy 按 SPEC §3 特例把 `04→13`、`07→13` 两条边的 provider 改为 13f（消费者与符号不变，两数组长度不变）；预警的 `11→13f` 与 `13f→07` 均未出现（扫描器对顶层 const 初始化表达式与 `11:2050` 的既有缺口，前后一致，未夹带修复）。锁：只有 `memory-toolbox.static` 的三个 memory 工具 schema 随之搬走，改为拼接读取；其余三把锁与 `missions-readmodel`／`interventions-persist` 断言均不在区间。门：`--fast` 48/48；`tool-dispatch`／`capabilities`／`meta-guard`／`workbench-self-status`／`missions-readmodel`／`interventions-persist`／`tools-v2` 全绿；全量 `--parallel 4` 257/1/2，唯一 FAIL `pretender-needs-drawer` 为临时 HOME `runtime.json` 启动竞态超时，串行复跑与两件 flaky（`interventions-c4`／`session-index`）串行复跑均 ALL PASS。`facts.json` 重算只漂 `generatedAt`，已还原不入库。提交 `b689a37`。
- **110-2 摸底裁决（2026-09-03）**：`ROUTE_AUTH`（`01-config.js:2272-2389`，118 行纯字面量）与 23 个运行时开关判定函数（`:893-1024`，连续自足）可纯搬家；**默认值块嵌在 `defaultConfig()` 返回对象内、sanitize 表是 `normalizeConfig()` 循环里的内联数组字面量，都不是顶层声明，不能纯搬**（需引入展开／引用语法＝行为中性重构而非搬家），划出 110-2 范围、登记待办。新模块放在 `01-config.js` **之前**以避免 `01→01b` 真正的新前向边（放后面会因 `authorizeRoute` 引用产生，不在搬家特例内）。拆成三批：110-2-pre 扩 `moduleLayer()` 正则（dev-harness）→ 110-2a `01b-route-auth.js` → 110-2b `01c-runtime-flags.js`。
- **110-2-pre（2026-09-03，opus）**：六层正则统一允许 `NN[a-z]?-`，生成物零变化，`--check` PASS，静态锁 13 条全过。
- **110-2a（2026-09-03，opus 实现／主会话亲核）**：`01-config.js` 2423→2306，新建 `01b-route-auth.js` 119 行；`Buffer.compare` 逐字节相等（8304 字节）；`server.js` 差分新增 3／删除 0；依赖图 31/243/65 → 32/245/65，新增 `01→01b`、`14→01b` 均为后向，policy 未改；`route-inventory.js` `ROUTE_AUTH_FILE` 指向 01b 且清册 `sources.routeAuth` 改为随常量（原硬编码，顺带修正）；101 判定点／92 鉴权行不变；`missions-readmodel.e2e` 拼接读取。门：`--fast` 48/48、七件定向 e2e 全绿、全量 `--parallel 4` 257/1/10（唯一 FAIL `budget-guard` E30 为并发墙钟抖动，串行全过；该件补入并行易抖名单）。提交 `4437abf`（前置正则 `30dab47`）。
- **110-2b（2026-09-03，opus 实现／主会话亲核）**：23 个运行时开关判定函数（`01-config.js:893-1024`，132 行，块内零 01 内部标识符）→ `01c-runtime-flags.js`（放 01 之前，方案 A：未来 01 若引用仍为后向边）；`01-config.js` 2306→2175；逐字节相等（7204 字节）；`server.js` 差分新增 3／删除 0；依赖图 32/245/65 → 33/252/65，provides/requires 零增删，新增 7 条边全后向，policy 未改，逐消费者重归属 1:1 守恒（共 50 条）；零锁文件改动。门：`--fast` 48/48、九件定向全绿、全量 `--parallel 4` 256/2/5（perf 冷启动 5.3s 与 interventions-persist 均串行复跑通过，后者以干净 HEAD worktree 三次对照一致）。提交 `feb078c`。**遗留**：`01-config.js` 仍 2175 行；默认值块（`defaultConfig()` 返回对象内）与 sanitize 表（`normalizeConfig()` 内联数组）须先提炼为顶层 const（行为中性重构，另立切片）才能继续拆。
- **110-3 摸底裁决（2026-09-03）**：`02-session-store.js`（3176 行）三候选——(a) `BRIDGED_WRITE_PATH_ARGS` 块（`:3090-3176` 至文件尾，87 行）：最干净，零新前向边、消费者经 `require(server.js)` 取导出，零锁改动；(b) `createTurnSegmentBuilder`（`:1540-1773`，234 行）：函数自足，但 `finalize-segments.static`／`turn-narrative.static`／`ec-d-closure.static` E5 用 `vm` 从 02 源码切片，须同步改片段来源（断言不改）；(c) Mission Change Ledger（`:86-227`，142 行）：会产生**真正的新前向边**（消费者变化，不在搬家特例内），且触及 `pretender-return-archive.static` 与 `durable-state-inventory` 的 `session-changes` owner——**需架构评审，待用户拍板**；journal/checkpoint 块（约 700 行）与会话索引缓存（129 行）符号纠缠重，不作候选。三者全做 02 也只降到约 2713 行，仍超 2000 目标，后续需先做行为中性提炼再拆。顺序 3a → 3b → 3c（评审后）。
- **110-3a 裁决：不做（2026-09-03）**。实施时发现块内引用 `unprefixedBridgedName`（定义在 `02:1819`），搬出后原文件内调用变成跨模块边 `02b→02`，把 02b 拉进强连通分量，`--check` 报 7 条新增环边（任何 manifest 位置都躲不掉；连带搬 helper 又会两向出前向边且非连续）。这违反纯搬家「零新边」纪律，已整体回退；候选 (a) 改记为「helper 归属需架构评审」待用户拍板。**教训入摸底流程**：搬家前必须先做自由标识符扫描（剥注释／字符串／属性访问后的标识符全集），凡引用源模块内部符号的块一律不作纯搬家候选——按此标准 (b) 自由标识符只有内建对象，风险实际低于 (a)，顺序改为 3b 先行。
- **110-3b（2026-09-03，opus 实现／主会话裁决）**：`createTurnSegmentBuilder`（`02:1540-1773`，234 行，块内唯一顶层声明，自由标识符仅 Array/Map/Number/Object/String）→ `02c-turn-segments.js`（放 02 之前）；02 3176→2943（首次低于 2500 硬上限）；逐字节相等（11939 字节）且 02 余下部分＝HEAD 首尾拼接；`server.js` 差分 +3／−0；三把 vm 锁（`finalize-segments.static`／`turn-narrative.static`／`ec-d-closure.static` E5）只改片段来源，新旧 vm 片段逐字节相同（11461 字节），正则与断言文案未改；生成器链零变化（facts／route-inventory 只漂时间戳已还原）。依赖图 forward 65 不变，出现 3 条环边：`05→02c`、`09→02c` 为搬家重归属；**`02c→00-boot`（符号 `text`）是扫描器假阳性**——`00-boot.js:156` 顶层 `function text` 与 02c 箭头函数形参 `text` 同名，扫描器不识别箭头形参绑定，HEAD 上 `02→00-boot` 已带同一误判、搬家后仍在（被复制而非迁移）。裁决：三条均登记入 `allowedCycleEdges`，note 注明假阳性待扫描器修复后移除。门：`--fast` 48/0（policy 前 47/1）、全量 `--parallel 4` 256/2/7（perf 冷启动抖动串行通过；另一件即 policy 项）。**新增待办 110-h1**：修 `module-dependency-graph.js` 的箭头函数形参绑定缺口（dev-harness 侧），并复核既有 209 条 `allowedCycleEdges` 中的同类虚增——单独切片、单独评审。提交 `e762a82`。
- **110 剩余刀数修订（2026-09-03，用户授权主会话按收益取舍）**：① **取消 §3.3 第 7／8 项**（`preview-shell.js`／`preview-shell.css`）——交办台已由 27 号管家壳继任、停止独立演进，拆它无收益；② 第 5 项（`05b-kimi-bridge`）延后至有需要时；③ 优先第 4 项 `09-workflow.js`（111/112 热点）与第 6 项中的 `10-context-governance.js`（111 直接改它），只做自由标识符扫描判定为自足的块，摸底后定刀数；④ **110-3c′（架构评审结论，主会话）**：110-3a 与 3c 失败原因同类——块引用 02 内部 helper（`unprefixedBridgedName`、账本路径等）。正解不是登记环边，而是先把这些 helper 纯搬到更早的小模块（如 `02a-session-paths.js`；helper 若自足则仍是零新边搬家），再搬写族登记表与 Mission Change Ledger。列为 110-3c′，排在 110-4 之后视余力执行。⑤ **并行回归偶发治理**列为 107 前置项（见 §4）。
- **110-h1（2026-09-03，sonnet 实现／主会话亲核）**：扫描器新增箭头函数形参局部绑定识别（单参／括号列表／async／默认值／rest／递归解构），重生成后全图仅消失 `02c→00-boot(text)` 一条假阳性边（256→255，无新边），policy 删该条并更新 note；02c 退出主 SCC；新增 unit 套（14→15，facts／README 同步）。**诊断额外发现**：扫描器对**普通函数形参与嵌套 `const/let/var`** 同样不识别为局部绑定（`02→00-boot` 的 `text` 边来自 `02:1018/1665` 嵌套 `const text`），既有 212 条环边白名单里可能有更多此类虚增——列为 **待办 110-h2**（dev-harness 侧，修后须重评 policy 债务上限并逐条盘点白名单）。提交 `e67f8fa`。
- **110-4 摸底裁决（2026-09-03）**：`09-workflow.js`（3375 行）顶层地图显示两个巨型函数占 2911 行（`runAgentWorkflow` 176-1198 共 1023 行、`runOpenAiTurn` 1362-3249 共 1888 行）；**原 §3.3 第 4 项点名的 `volatileExtras`／`buildBodyWithLayout`／`appendPromptToLastUserMessage` 均为 `runOpenAiTurn` 内部闭包局部量，不是顶层声明——原定 `09b-turn-prompt-assembly.js`／`09c-model-call.js` 不成立，作废**。自由标识符扫描后的纯搬家候选：**110-4a** 重规划账本簇（`:7-174`，168 行：`recordNodeContinuation`／`REPLAN_*`／`validateReplanPatch`／`proposeReplanPatch`／`applyReplanPatch`／`rollbackReplanPatch`）→ `09b-replan-ledger.js`，零锁命中；**110-4b** token 估算簇（`:3250-3375`，126 行：`fmtTokensServer`／`CJK_RE`／估算分桶开关／`estimateTextTokens`／`classifyTextForEstimate`／`estimateContentTokens`／`estimateHistoryTokens`／`CONTEXT_WINDOW_FALLBACK`／`EVAPORATED_PREFIX`）→ `09d-token-estimation.js`（111 压缩 v2 的直接工作面），涉及 consumer 侧端点重归属（`09→10` 的 `ESTIMATION_RULES` 变 `09d→10`，SPEC §3 已扩为双向）；**110-4c（可选）** `waitForAgentRunResults`（52 行）与 history 同步＋plan 门（78 行）两小块。三者合计 −424 行仍超 2500 硬上限；两个巨型函数只能走**行为中性闭包提炼**（显式传参、逐轮验证，估计 4–6 轮），登记为独立待办 **110-r1**，不在纯搬家范围。
- **110-4a（2026-09-03，opus 实现／主会话亲核）**：边界修正为 `09:1-174`（文件无模块头，1-6 是块首注释）；09 3375→3202；`09b-replan-ledger.js` 175 行；逐字节相等（11785 字节）且程序化重建的 `server.js` 与产物逐字节相等（代码零位移）；自由标识符与 09 其余顶层符号交集为空；图 34/255/65 → 35/259/65，provides 总集合不变；policy 环边 +3（`09b→00-boot` consumer 侧、`13d→09b` provider 侧、`09→09b` 原文件内调用随 provider 搬家——三者均非新依赖，裁决通过）；静态锁零改动；门：`--fast` 48/48、10 件定向全绿、全量 257/1/2（`mcp-ops-closure` 与两件 flaky 串行通过，`mcp-ops-closure` 补入偶发名单）。

### 3.4 单次拆分 SOP（每个 commit 必走）
1. 记录 `wc -l` 与 `node app/build.js --check` 新鲜。
2. 新建目标模块（首行顶格、全 LF），剪切代码块**逐字节**搬入，不改任何标识符、注释与顺序；源文件留下一行注释指向新模块。
3. `manifest.json` 插入条目（位置决定前向／后向边）；`node app/build.js` 重建并回填行区间。
4. `module-dependency-graph.js --write` → `--check`：零新增前向边／环边；若不可避免，停下评审，不在同一 commit 内改 policy。
5. 其余生成器按 §0 第 4 条顺序跑；`git diff docs/architecture/` 只允许出现文件归属变化，不允许出现符号增减。
6. 改静态锁：把 `read('<源文件>')` 改为「源＋目标拼接」；只改读取来源，不改断言。
7. `run-all.js --fast` → `--parallel 4` 全绿；`git diff --stat` 确认只有源／目标／manifest／生成物／锁文件。
8. 提交信息：`refactor(structure): 110-<序> split <源> -> <目标> (pure move, zero behavior)`。

### 3.5 明确不做与风险
- 不做：任何行为改动、开关、dev-harness 瘦身（须先单列「断言只加不改」破例评审）、realhist-fixtures 修复、全树 IIFE。
- 风险：拆分与 108/109 交叉——**硬序** 108 → 109 → 110；生成物 diff 噪音大——每步只看 `docs/architecture/*.json` 的符号集合是否不变；`ec-d-closure` 行数护栏——搬家后按实际值重钉并在断言文案注明 110-N。

---

## 4. 与第 107 波的衔接
- **107 前置：并行回归偶发治理（2026-09-03 用户拍板）**。108–110 各轮 `--parallel 4` 的偶发并集：`perf`（冷启动 >5s）、`context-compact-v2` D6、`mission-result`、`interventions-persist`、`budget-guard` E30、`subagent`、`pretender-needs-drawer`（临时 HOME `runtime.json` 竞态）、`failover`、`metrics-panel`、`orchestrate-model-select`、`observation-recall-replay`、`rewind`、`playbooks`、`provider-compact`、`read-pool`、`source-fields`、`e2-append-system-prompt`、`semantic-loop-guard`、`orchestration-blindspots`、`perf-config-cache`、`pretender-gate`、`reject-attribution`、`summary-parallel-cap`、`interventions-c4`、`session-index`。治理方向：健康轮询阈值与 120s 超时按 `--parallel` 档位放宽、临时 HOME 启动竞态修复、墙钟归一化覆盖 E30、冷启动断言在并行时降级为 WARN；出门证据在治理完成前一律以串行全量为准。
- 107 冻结范围须覆盖 108b（playbook 索引与设置指引，默认行为变化）、108c（新工具）、109a/109b（新前端能力）、109c（ACC 型别扩展）；108a 与 110 为零行为／纯结构，随任意版本交付。
- 版本归属由实际行为决定：108/109 含默认行为与 UI 变化，走功能版本评估；不在本文预写版本号。品牌冻结继续：任何新文案不出现 Pretender／3.0。
- Release Brief 四项（22 号 §8）在 107 填写：服务范围、验证集与结果（prompt-benchmark 6 seed、mermaid 走查、ACC smoke）、默认启用范围与回退、发布门与未完成项。

---

## 5. 执行编排与核验清单
- **分工**：只读摸底＝haiku／sonnet；实现＝sonnet（108c／109b／109c／SPEC 起草）与 opus（108a／108b／109a／110 拆分）；设计、裁决、核验＝主会话。
- **串行**：三波串行；波内切片串行（同一工作树，避免 `app/src` 合并冲突）。
- **主会话核验清单（每切片）**：① `git status` 只含预期文件；② 复跑该切片声明的每个门并留存 `ALL PASS` 尾行；③ 抽读改动 diff 核对与本文落点一致；④ 生成器链 diff 只含预期变化；⑤ 记录到本文对应切片的「交付记录」小节。

## 6. 停止条件
- 任一门红且原因是行为漂移（而非锁的读取来源）：停止该切片、回退、另立行为项。
- `module-dependency-graph --check` 出现新前向边：停止，评审后单独 commit 改 policy。
- prompt-benchmark `--after` diff≠0：不得以「改断言」通过，回退文案重做。
- vendor 文件缺失时 109a 必须仍全绿（降级路径即正式路径之一）。
