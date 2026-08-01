# 发行说明 · Changelog

本文件记录面向用户的重要发行变化，不替代完整的 Git 提交历史。版本遵循 `ruyi-workbench/package.json`。
This file records user-facing release highlights; it does not replace the complete Git history. Versions follow `ruyi-workbench/package.json`.

## 如意 Ruyi Escapade 2.4 · v2.4.0 · 2026-07-30

### 中文

- **可追溯现场纪要与可选本机提醒**：任务单新增现场纪要/班组工序/原始记录三镜头。现场纪要按 Mission 变化流水增量追加人话时间线，每句话可展开原始类型、时间、游标与事实；常态只维护 160 行 DOM，长历史可分批向前展开。设置中可显式开启默认关闭的“需要你”本机通知，支持免打扰、同事项去重、终态撤回、拒权/静默不补发和重启不补炸历史。
- **多 Agent 班组工序图与正确的案头按钮**：新任务台会把队员、依赖工序、实时状态和最新进展放在同一张有界班组图中，工头摘要不额外调用模型；待审批的帮手提案以虚线鎏金工序出现，点击即定位到全局“需要你”，运行中的队员可原位递话并明确显示送达或排队。工作圈、安全档和引擎按钮现在分别打开工作区、安全模式和模型控制，只有设置按钮进入设置页。
- **新任务台公开预览门通过**：设置中的布局切换只改变本机界面，不迁移任务或会话。投影载入失败时可直接重试或返回完整经典布局；损坏的预览偏好只会重置已读、置顶与归档位置。真实 Edge 在 300 个任务、200 张可见任务卡下通过首屏 <1.5s、视图切换 P95 <200ms 与长输出增量门，并完成 1440/768/390 三档走查。
- **任务台全局待决闭环**：案头条与任务收活台的“需要你”现在打开同一个跨任务抽屉，可直接处理权限、问题、计划和帮手提案；允许/批准必须二次确认，问题默认不选答案，成功决定会同步关闭经典提示且不触发取消。停止任务会列出未完成项，并可在经典输入框准备未发送的再试/换法子草稿。
- **任务回来摘要与档案**：Preview 任务单会按持久单调的 Mission 变更流水，确定性列出离开期间的进展、失败、用量、待决变化、结果、回退与运行删除；每条保留原始来源游标，不调用模型二次概括。已读位置、置顶与归档只存本机 UI-state，渲染失败或流水缺号不会误标已读。新增已收工/已停工档案，可搜索、筛选、置顶、归档，并按工作圈或状态分组。

- **工具合批与依赖分阶段**：Provider 与 Claude CLI 现在都会收到同一份双语工具批次协议。参数已确定且互不依赖的调用会被明确引导在一条助手消息中合批，结果仍按列出顺序进入既有配对链；后一步依赖前一步结果时，模型必须等待当前 `tool_result` 后再进入下一阶段。权限确认、先读后改、检查点、loop guard 与 between-tools 插话边界全部保持原语义，不新增可绕过分发层的通用批处理工具。
- **结构化交互提问**：`request_user_input` 新增稳定 question/option ID、`single|multiple|text` 模式及 `allowOther` 自填答案，同时兼容旧 `multiSelect`/`answer[]`。新版提问卡显示选项说明，支持单选、多选、自由文本和“选项＋其他回答”，不再默认勾选第一项；全部问题回答完整后才可提交，并保留双引擎送达确认、后台提问即时浮出与重复回答 409 语义。
- **下一代任务台契约前置对齐**：Schema 文书升至 v1.1，冻结 question typed payload 与完整状态行保留要求，使 Escapade 的提问组件可在后续全局“需要你”收件箱直接复用。

### English

- **Traceable worksite log and optional local alerts**: Task sheets add Worksite log, Crew stages, and Raw record lenses. The log incrementally folds the Mission change journal into a plain-language timeline; every sentence expands to its original type, time, cursor, and facts, while a normal 160-row DOM window keeps long histories responsive. An explicit, off-by-default Needs you notification setting adds quiet hours, per-item deduplication, terminal withdrawal, no replay after denial/quiet time, and no historical burst after restart.
- **Multi-agent crew stage map and correctly routed desk controls**: The new task desk presents members, dependency stages, live status, and latest progress in one bounded crew map without calling another model for the foreman summary. Proposed helper work appears as a dotted gold stage that opens its exact Needs you decision, and a note can be passed directly to a running member with explicit delivered/queued feedback. Workspace, Safety, and Engine now open their respective controls; only Settings opens the full Settings page.
- **New task desk public-preview gate passed**: The layout setting changes only this device's interface and never migrates tasks or chats. A projection failure now offers Retry and Return to classic layout; damaged preview preferences reset only read, pin, and archive positions. Real Edge passes the <1.5s first-interactive, <200ms view-switch P95, and incremental long-output gates with 300 tasks and 200 visible task cards, plus 1440/768/390 responsive walkthroughs.
- **Global decisions in the task desk**: Needs you now opens one cross-task drawer for permissions, questions, plans, and helper proposals. Allow/Approve require a second confirmation, questions start with no selected answer, and successful decisions retire matching classic prompts without cancellation. Stopped tasks now explain unfinished work and can prepare an unsent retry/change-approach draft in the classic composer.
- **Return summaries and task archive**: Preview task sheets now deterministically replay progress, failures, usage, intervention changes, results, rewinds, and run deletion from a persistent monotonic Mission change journal. Every row keeps its raw source cursor and no model is called for summarization. Read position, pinning, and archiving remain device-local; failed rendering or sequence gaps never mark changes as read. A completed/stopped task archive adds search, filters, pin/archive controls, and grouping by workspace or state.

- **Tool batching with staged dependencies**: Provider and Claude CLI turns now receive the same bilingual batching contract. Calls with fixed arguments and no dependencies are explicitly grouped into one assistant response, while result-dependent work waits for the current `tool_result` before the next stage. Existing permission, read-before-edit, checkpoint, loop-guard, and between-tools steering semantics remain intact; no generic batch tool bypasses the dispatcher.
- **Structured interactive questions**: `request_user_input` adds stable question/option IDs, `single|multiple|text` modes, and `allowOther` custom responses while preserving legacy `multiSelect`/`answer[]` compatibility. The redesigned question sheet shows option descriptions, supports choices plus typed input, never preselects the first choice, validates every question before submission, and retains delivery acknowledgement, immediate background surfacing, and stale-answer 409 behavior across both engines.
- **Next task-desk contract alignment**: the Schema document advances to v1.1, freezing the typed question payload and full-state retention requirement so the same renderer can later power a global “needs you” inbox.

## 如意 Ruyi Escapade 2.3 · v2.3.0 · 2026-07-30

### 中文

- **未决事项重启不丢失**:权限请求、提问、计划审批三类未决事项此前是纯内存状态,进程重启即消失(用户看到的待决卡片无响应,且无审计痕迹)。现旁路持久化为 Intervention 记录(append-only 日志):注册时落盘 pending,决策/超时/清理时落盘终态,重启后仍 pending 的自动标记为「已取消(重启)」而非永挂。**执行语义完全不变**--超时仍自动拒绝、权限仍默认不放宽,Intervention 只是审计/读模型/重启终态化的旁路记录,不参与决策执行。重复决策不重复执行(第二次返回 409),过期/取消/已处理状态可区分。
- **`/api/interventions/:sessionId` 只读派生**:列出会话的全部 Intervention 记录与待决计数,鉴权同 `/api/missions`。`/api/missions` 的未决计数改从 Intervention 日志现算(此前读空内存 Map,重启后归零)。
- **任务池与待决叙事收口**：任务池统一进入 Intervention 读模型，清理残留 pending 叙事段，避免同一待决事项在不同入口重复展示。
- **任务结果与不可逆正向账**：新增任务结果模型和不可逆操作正向账，为完成态、失败态与可审计的已执行动作提供稳定投影。
- **全局“需要你”聚合**：新增跨会话只读聚合入口，集中展示待处理事项，不绕过既有决策端点的鉴权、幂等和安全语义。

### English

- **Pending interventions survive restart**: permission prompts, questions, and plan approvals were previously in-memory only, vanishing on restart (the pending card stopped responding, with no audit trail). They're now mirrored as Intervention records (append-only log): pending on register, terminal state on decision/timeout/clear, and anything still pending at restart is marked "cancelled (restart)" instead of hanging forever. **Execution semantics are unchanged** - timeouts still auto-deny, permissions still default-closed; Intervention is a sidecar for audit/read-model/restart-finalization only, never participating in decision execution. Duplicate decisions don't re-execute (second attempt returns 409); expired/cancelled/resolved states are distinguishable.
- **`/api/interventions/:sessionId` read projection**: lists a session's Intervention records and pending counts, gated like `/api/missions`. The pending counts in `/api/missions` now derive from the Intervention log (previously read an empty in-memory Map after restart).
- **Task-pool and pending-narrative closure**: task-pool items now share the Intervention read model and stale pending narrative segments are removed, preventing duplicate presentation across entry points.
- **Task results and irreversible-action ledger**: adds stable projections for completed/failed task outcomes and an auditable positive ledger of irreversible actions.
- **Global “needs you” aggregation**: adds a cross-session read-only inbox without bypassing the existing decision endpoints' authorization, idempotency, or safety semantics.

## 如意 Ruyi Escapade 2.2 · v2.2.0 · 2026-07-28

### 中文

- **插话落在插入时机点（流式 + 刷新一致）**：流式中插话（Steer）不再追加到对话框最底部钉死，而是作为回合叙事内的内嵌片段，落在它真正被插入的位置--助手先输出的文字 -> 插话 -> 后续文字，顺序与实际发生一致。插话同时持久化为助手回合的 `steer` segment，**刷新或重进会话后仍内嵌在原位**，不再回退为独立行（消除流式↔刷新的视觉差异）。旧会话（无 steer segment）保持既有独立行展示，不伪造历史过程。
- **粘性自动滚动**：助手输出时页面自动跟随最新内容；当你上滑阅读历史时，跟随自动暂停（新输出不会把你拽回底部，底部会出现「↓ 回到最新」按钮）；滚回接近底部时自动恢复跟随。工具卡、错误、计划、提问、Mission 等所有流式增长内容都遵守同一粘性规则，不再因任一输出把你从阅读中拉走。

### English

- **Steer interjections land at their insertion point (consistent across refresh)**: a steer sent mid-stream is no longer pinned to the very bottom of the chat. It renders as an inline segment inside the turn narrative at the point it was actually injected - assistant text A -> interjection -> text B - matching the real chronological order. The interjection is also persisted as a `steer` segment on the assistant turn, so **after refresh or re-entry it stays inline at the same position** instead of falling back to a standalone row (eliminating the streaming-vs-refresh visual gap). Legacy sessions without the segment keep their standalone-row rendering; no history is fabricated.
- **Sticky auto-scroll**: the page follows the latest output while you're at the bottom; scroll up to read history and following pauses (new output no longer yanks you back - a "↓ jump to latest" button appears instead); scroll back near the bottom and following resumes. Tool cards, errors, plans, questions, mission cards and every streaming-growth path now obey the same sticky rule, so no single output pulls you away mid-read.

- **Claude resume recovery and Mission projection**: native Claude runs recover their resume linkage after connection interruptions, while the new read-only Mission projection gives the workbench a compact, trustworthy view of active goals without fabricating execution progress.

## 如意 Ruyi Escapade 2.1 · v2.1.0 · 2026-07-27

汇总 v2.0.1 之后的三个功能波：第53波 EC-B 安全更新中心、第54波回合叙事化对话、第55波 EC-C MCP 运维闭环。发布验证为 **158 pass / 0 fail**（串行默认门），另有 6 项真实外部环境探针按需启用。

### 中文

- **MCP 运维闭环（第55波 EC-C）**：设置面板新增「MCP 运维」页签——不用编辑 JSON 即可看到全部连接器（内置桌面 / 用户导入 / drop-in 目录）的来源、传输方式、连接状态与失败原因（鉴权失败、进程启动失败、网络不可达等 8 类人话归类），并可重测、启停、移除；启停与删除立即生效且重启后保持一致，不影响其它连接器；同 id 的 drop-in 接管会明确提示而非静默生效。stdio / SSE / Streamable HTTP 三种传输的能力与限制在连接前明示。
- **安全更新中心（第53波 EC-B）**：设置面板「更新中心」支持选 zip → 预检（完整性 / 路径穿越 / 版本兼容 / 幂等）→ 应用 → 失败可回滚；全部更新写入本地审计，apply 中断、校验失败、重启失败均可恢复原版本；GUI 只编排同一份受测 PowerShell 核心，CLI 保留为救援路径。
- **回合叙事化对话（第54波 EC-D 前置）**：一次助手回合中的文字、工具调用、后续文字、计划/询问与错误按真实发生顺序放进同一个回合容器；并行工具共享批次；旧会话保持原有展示，不伪造历史过程。
- 修复首次解压/启动链之外的若干测试基建问题（端口审计误报、旧静态锁锚点漂移），发布门回到全绿。

### English

- **MCP operations closure (wave 55, EC-C)**: a new "MCP Ops" settings tab shows every connector (built-in desktop / user-imported / drop-in folder) with its source, transport, health and human-readable failure category (auth, startup, network, …) — no JSON editing required. Retest, enable/disable and remove take effect immediately, stay consistent after restart, never affect unrelated connectors, and honestly warn when a same-id drop-in takes over. stdio / SSE / Streamable HTTP capabilities and limits are stated before connecting.
- **Safe update center (wave 53, EC-B)**: the "Update Center" settings tab flows zip → precheck (integrity / path-traversal / version compatibility / idempotency) → apply → rollback; every update is audited locally, and interrupted applies, verification failures and restart failures all recover the original version. The GUI orchestrates the same tested PowerShell core; the CLI remains the rescue path.
- **Turn-narrative chat (wave 54, EC-D groundwork)**: text, tool calls, follow-up text, plans/questions and errors within one assistant turn now render in true chronological order inside a single turn container; parallel calls share a batch; old sessions keep their legacy rendering without fabricated history.
- Fixes several test-infrastructure issues (port-audit false positive, stale static-lock anchors), bringing the release gate back to all-green.

## 如意 Ruyi Escapade 2.0.1 · v2.0.1 · 2026-07-24

### 中文

- 修复新用户直接在 ZIP 预览中运行启动脚本时出现 `The system cannot find the path specified` 与笼统 `Installation Failed` 的问题。Full 与 Slim 现在会在启动前检查关键文件，并明确提示“完整解压到 `C:\Ruyi` 等短路径”，不再把缺文件误报成安装器故障。
- Full 包对不完整解压、长路径跳过文件与校验损坏给出具体文件名、恢复方式和持久诊断日志；校验期间持续显示进度，避免首次启动看似卡死。
- ACC 桌面控制准备失败时不再阻断整个产品，基础工作台会继续启动；修复后重新运行即可恢复桌面控制。
- 打包门新增双包共用的 Node 运行时强校验，并在包根目录加入双语 `README-START-HERE.txt`，防止发布出“能下载但无法启动”的离线包。
- Full 包将 `winsdk==1.0.0b10`、CPython 3.12 wheel、Windows.Media.Ocr 实际导入和 manifest 完整性覆盖升级为硬发布契约；打包器与目标机安装器都会拒绝缺 OCR 的伪 Full 运行时。
- 修复 Claude CLI 原生子 Agent 长期停在“运行中”、完成结果丢失及父对话无法自动续接的问题：识别后台启动回执与 `<task-notification>` 完成通知，必要时自动阻塞等待 `TaskOutput`，并在 CLI 异常结束时明确标为中断而非伪完成。
- 工作台 DAG 新增 Claude 原生 Agent 的只读观测图，显示“主对话 → 子 Agent”的真实启动、等待与完成状态；Claude CLI 未暴露的内部步骤不会被伪造。

### English

- Fixes first-run `The system cannot find the path specified` / generic `Installation Failed` errors when a user launches from the ZIP preview or Windows skips files during extraction. Full and Slim now preflight required files and direct users to fully extract to a short path such as `C:\Ruyi`.
- Full now identifies the missing or damaged payload file, prints verification progress, and persists an installation diagnostic log.
- A desktop-control setup failure no longer blocks the base Workbench from starting; users can correct extraction or permissions and retry later.
- Packaging now refuses to emit either variant without its bundled Node runtime and includes a bilingual `README-START-HERE.txt`.
- Full now treats the pinned CPython 3.12 `winsdk==1.0.0b10` wheel, real Windows.Media.Ocr imports, and manifest coverage as mandatory release gates; packaging and target installation reject a Full runtime without OCR.
- Fixes Claude CLI native Agents remaining stuck at “running,” losing completion output, or leaving the parent unable to resume. Ruyi now recognizes launch receipts and string-valued `<task-notification>` completions, performs a bounded blocking `TaskOutput` recovery when needed, and marks unobserved exits as interrupted instead of completed.
- Adds a read-only Claude-native parent→child projection to the Workbench DAG. It shows the lifecycle Ruyi can actually observe without fabricating internal CLI steps.

## 如意 Ruyi Escapade 2.0 · v2.0.0 · 2026-07-24

这是 2.x 产品代号 **Escapade** 的首个公开版本。它汇总 v2.0 基座（第 44–46 波）及其后的五个功能波（第 47–52 波）；ACC 同步升至 **v1.9.0**（100→107 工具）。全部经“实现 → 对抗多 agent 审查 → 定向修复 → 离线 e2e 回归”循环。发布验证为 **151 pass / 0 fail**，另有 6 项真实外部环境探针按需启用。

This is the first public release of the 2.x product line, **Escapade**. It combines the v2.0 foundation (waves 44–46) with five follow-through waves (47–52), raises ACC to **v1.9.0** (100→107 tools), and passed **151 / 151** default offline checks; six probes requiring real external environments remain opt-in.

### 中文

**第47波 · 快赢波**：Steer 双引擎（Claude 对话引擎 stdin 即时注入 + provider 引擎队列迭代边界 drain）；桥 cancel/超时契约（声明式按工具超时表 + `notifications/cancelled` + 杀进程树 + 惰性重 spawn 自愈）；token Bootstrap + CSP（HTML 不再明文下发 token，浏览器走 `POST /api/bootstrap` 握手）；overlay 载荷锁。47e：流式中发送按钮三态（发送/插话/停止，ChatGPT 同款）。

**第48波 · 地基波**：提示词护栏 04 Phase A（分层快照测试 + A/B 夹具骨架 + 预算断言）；MCP 配置导入器 v1（.mcp.json / ~/.claude.json / Codex config.toml，TOML 行级状态机零依赖）；P2 verifyManifest mtime 缓存（P1 readConfig 缓存经对抗验证回退）；FE testid 契约铺路。

**第49波 · 生态工具波**：ACC v1.9.0 七新工具（edit_file 局部精确替换 + fetch SSRF 防护 + memory×4 + sequential_thinking）；远程 MCP transport（McpHttpClient 双 transport：streamable-HTTP 2025-03-26 + legacy SSE，headers `${VAR}` 连接时展开密钥不落盘）；ACC 质量战役（读取栈收敛 + TOOLSETS 子集注册 + pyproject extras）；E4 CI（钉 SHA + linux-static + release-dryrun）；A1 后端拆分首批。

**第50波 · UI 视觉焕新波**：V4 毛玻璃定稿（scene-bg 微渐变 + 噪点 + 三档玻璃 + 黛紫/香槟 + 主题三态 light/dark/system）；i18n 清零（95 处 toast codemod + TOOL_VERB_MAP + 工作台节点/Pool/Mail）；a11y P0（installFocusTrap 焦点循环，role="log" 评估为 P2 联动不强行加）；02 Phase D 插话可视化（插话卡静态重渲染 + 队列可视化）；热修（标题卡死「新对话」+ Steer 双消息）。对抗验证修复：`_rpcHttp` 超时补发 `notifications/cancelled` + 7 处 i18n 遗漏。

**第51波 · 提示词与工作流规范化波**：04 Phase D 语义 loop-guard（主回合结果指纹无进展判定，与同签名连击互补，探索工具宽阈值，warn 先行不 abort）+ 《模型工作流规范》双语文档；02 Phase B 打断语义（between-tools 批次边界中断，配对安全补 refusal，Codex 级立即生效）；前端 i18n 清零（50 波遗留 3 处硬编码 map）；51c‑b 提示词外置 i18n 骨架（`06b-prompt-registry.js`，PROMPT_PACK_VERSION='2026-w51-1'，中英双语系统提示词按 UI 语言从 `i18n/prompt-packs/` 按需加载）；51d 系统提示词 stable/volatile 分层注入（provider 引擎 system prompt 拆为逐字节稳定的锚点层 + volatile 层注入第一条 user 消息，prefix-cache 友好，多轮 token 节省显著）。

**第52波 · 发布与范式收尾**：补齐离线 A/B 提示词基准运行器与基线；将所有动态角色、编排、模型和策略提示稳定地置于 OpenAI 首条 user 消息，system 层保持字节稳定以提高 prefix-cache 命中；新增 `PROMPT_EN` 与 locale 感知选择；设置中可为子代理独立选择优先 endpoint 与模型（可跨 provider）；并收紧插话队列的可见、撤回、注入确认与跨会话隔离行为。收尾 UX 修复将子代理 endpoint/model 改为联动下拉，移除权限模式的重复选择器，把体检收入设置，重绘深浅主题 Steer 队列，修正 Claude 后台 Agent 启动回执被误标“完成”，并让“查看改动”在独立窗口展示、可调用本机应用打开文件。

### English

**Wave 47 · Quick wins**: Dual-engine steer (Claude chat engine injects via stdin on the fly + provider engine drains the queue at iteration boundaries); bridge cancel/timeout contract (declarative per-tool timeout table + `notifications/cancelled` + kill process tree + lazy re-spawn self-heal); token Bootstrap + CSP (HTML no longer ships the token in plaintext; browsers handshake via `POST /api/bootstrap`); overlay payload lock. 47e: three-state send button while streaming (send/steer/stop, ChatGPT-style).

**Wave 48 · Foundation**: Prompt guardrails 04 Phase A (layered snapshot tests + A/B fixture scaffold + budget asserts); MCP config importer v1 (.mcp.json / ~/.claude.json / Codex config.toml, zero-dep TOML state machine); P2 verifyManifest mtime cache (P1 readConfig cache reverted after adversarial review); FE testid contract groundwork.

**Wave 49 · Ecosystem tooling**: ACC v1.9.0 seven new tools (edit_file precise in-place replace + fetch SSRF defenses + memory×4 + sequential_thinking); remote MCP transport (McpHttpClient dual transport: streamable-HTTP 2025-03-26 + legacy SSE, headers `${VAR}` expanded at connect, keys never persisted); ACC quality campaign (read-stack convergence + TOOLSETS subset registration + pyproject extras); E4 CI (pinned SHA + linux-static + release-dryrun); A1 backend split batch 1.

**Wave 50 · UI visual refresh**: V4 glassmorphism finalized (scene-bg micro-gradient + noise + three glass tiers + purple/champagne + theme tri-state light/dark/system); i18n cleanup (95 toast codemod + TOOL_VERB_MAP + workbench node/Pool/Mail); a11y P0 (installFocusTrap focus cycling, role="log" deferred to P2 incremental-render); 02 Phase D steer visualization (steer-card static re-render + queue viz); hotfixes (title stuck at "New chat" + Steer double-message). Adversarial-review fixes: `_rpcHttp` timeout now sends `notifications/cancelled` + 7 i18n omissions.

**Wave 51 · Prompt & workflow normalization**: 04 Phase D semantic loop-guard (main-turn result-fingerprint no-progress detection, complementary to identical-signature runs, lenient threshold for exploratory tools, warn-first no-abort) + bilingual Model Workflow Spec doc; 02 Phase B interrupt semantics (between-tools batch-boundary interrupt, pairing-safe refusal, Codex-grade immediate effect); frontend i18n cleanup (3 hardcoded maps left over from wave 50); 51c-b prompt externalization i18n skeleton (`06b-prompt-registry.js`, PROMPT_PACK_VERSION='2026-w51-1', bilingual system prompts loaded on-demand from `i18n/prompt-packs/` per UI language); 51d stable/volatile system prompt layering (provider system prompt split into byte-stable anchor layer + volatile layer injected into first user message, prefix-cache friendly, significant multi-turn token savings).

**Wave 52 · Release-pattern follow-through**: adds an offline A/B prompt benchmark runner and baseline; keeps dynamic role, orchestration, model, and policy text in the OpenAI user-side volatile prefix while the system layer stays byte-stable for prefix-cache reuse; adds `PROMPT_EN` with locale-aware selection; lets users choose a preferred provider and model for sub-agents, including cross-provider routing; and hardens steer queue visibility, cancellation, injection confirmation, and session isolation. Final UX fixes replace free-text sub-agent provider/model IDs with linked dropdowns, remove the duplicate permission selector, move diagnostics into Settings, restyle the Steer queue for both themes, avoid labeling Claude background-agent launch receipts as completed work, and open change diffs in a dedicated window with a local-app action.

## v2.0.0 基座（第 44–46 波，已包含在 Escapade 2.0）· 2026-07-21

### 中文

- **Claude CLI 模型列表彻底 API 化**：删除全部硬编码型号与 opus/sonnet/haiku 别名，模型菜单只显示「默认（CLI 配置）+ 代理 `/v1/models` 实际返回的模型 + 你的自定义标注」；代理发现的模型会缓存到本地，代理或网络不可用时依然可选；自定义模型在模型弹层行尾 × 一键删除。
- **上下文压缩 v2**：摘要生成预算化并在上下文爆满（400）时强压重试，子代理超窗有独立兜底，上下文估算随校准数据自我纠偏，长会话不再因压缩失败而慢性死亡。
- **编排可靠性**：修复「双冷恢复窄窗」——两次近同时手动恢复同一工作流不再重复写事件日志；补齐跨节点资源死锁（三节点传递环）、循环保护×节点重试收敛、双引擎模型档位等价等编排盲区的回归测试。
- **测试基建封版**：单元测试接入统一 runner 与 CI；失败用例自动重试一次并标记 `[flaky]`；新增真实浏览器 DOM 冒烟（系统 Edge/Chrome 无头渲染，零新增依赖）；fake-mcp 从 7 件扩到 20 件关键 ACC 工具契约，快照/回撤全操作形离线回归；ACC 11 个冒烟脚本收拢为统一入口并接入 CI。
- **门面数字单一事实源**：`facts.json` 机械生成工具数/版本号/测试数（当前：原生工具 50、ACC 100、e2e 146 件），静态锁重算比对防漂移。
- 本次发布前全量结果：146 pass / 0 fail（另 6 件 live 手工件除外）。

### English

- **Claude CLI model list is now fully API-driven**: all hard-coded model names and the opus/sonnet/haiku aliases are gone; the model menu shows only "default (CLI config)" + models actually returned by the proxy `/v1/models` + your custom entries; discovered models are cached locally so they remain selectable offline; custom models can be deleted inline (×) in the model popover.
- **Context compaction v2**: budgeted summarization with forced compaction retry on context-overflow (400), an independent fallback for sub-agent overflow, and self-calibrating context estimates — long sessions no longer decay when compaction fails.
- **Orchestration reliability**: fixed the dual-cold resume narrow window (two near-simultaneous manual resumes no longer duplicate the run event log); added regression coverage for cross-node resource deadlocks (three-node transitive rings), loop-guard × node-retry convergence, and dual-engine model-tier equivalence.
- **Test infrastructure finalization**: unit tests wired into the unified runner and CI; failed cases auto-retry once and are flagged `[flaky]`; new real-browser DOM smoke (headless system Edge/Chrome, zero new dependencies); fake-mcp expanded from 7 to 20 key ACC tool contracts with full create/modify/delete/move/copy snapshot-rollback regression; the 11 ACC smoke scripts now have a unified runner wired into CI.
- **Single source of truth for headline numbers**: `facts.json` is machine-generated (native tools 50, ACC 100, 146 e2e pieces) with a static lock that recomputes and compares.
- Full suite before this release: 146 pass / 0 fail (excluding 6 manual live probes).

## v1.6.7 · 2026-07-20

### 中文

- 修复 Claude CLI 原生子 Agent 结果展示与生命周期归因，避免子 Agent 刚创建就显示完成、结果不可见；同时强化父回合心跳、瞬态失败恢复与上下文连续性。
- 增加 Kimi Coding Plan 配置支持，并保持与 Ark 等多套 Claude CLI Coding Plan 的切换兼容；配置会覆盖陈旧的进程环境变量，不污染用户的其它计划。
- 根治 Windows `cmd.exe` 8191 字符命令行上限：解析 npm `claude.cmd` shim 到真实 `claude.exe`，稳定索引改走一次性 stdin 通道，技能索引不再把启动参数撑爆。
- 引入数据管家、会话存储 v2、引擎转录 GC 与 `/api/metrics`：会话正文改为增量 NDJSON，支持保留策略、压缩、统计和可观测性，降低长期运行的写放大与磁盘堆积。
- 后端工具分发改为表驱动，并将约 1.8 万行服务端按 15 个有序源码片段进行构建期拼接；运行时仍是零 npm 依赖的单文件 `app/server.js`，CI、打包和开发启动均校验产物新鲜度与语法。
- 修复 Windows 8.3 短路径与目录联接下的新文件路径误判：护栏会规范化最近的现存父目录，允许工作区内创建文件，同时继续拒绝经联接逃逸到工作区外的目标。
- 测试与供应链继续加固：动态端口、并行测试、真实 Claude CLI 手工探针、前端 ES Module 语法门、离线包完整性校验；本次发布前全量结果为 134 pass / 0 fail。

### English

- Restores Claude CLI native sub-agent results and lifecycle attribution so newly spawned agents no longer appear instantly completed with hidden output; parent heartbeats, transient recovery, and context continuity are hardened as well.
- Adds Kimi Coding Plan support while preserving clean switching with Ark and other Claude CLI plans. Explicit configuration overrides stale inherited environment variables without contaminating other plans.
- Removes the Windows `cmd.exe` 8191-character launch limit by resolving npm `claude.cmd` shims to the real `claude.exe` and moving stable index injection to one-time stdin input.
- Adds Storage Steward, session storage v2, engine transcript GC, and `/api/metrics`. Session bodies use incremental NDJSON with retention, compression, statistics, and lower long-running write amplification.
- Converts native tool dispatch to a table-driven registry and splits the roughly 18k-line backend into 15 ordered build-time source slices. Runtime remains a zero-npm-dependency single-file `app/server.js`, with freshness and syntax gates across CI, packaging, and developer startup.
- Fixes new-file containment checks under Windows 8.3 short paths and directory junctions by canonicalizing the nearest existing parent, while preserving denial of junction escapes outside the workspace.
- Hardens tests and supply-chain checks with dynamic ports, parallel execution, real-Claude manual probes, an ES Module syntax gate, and offline archive integrity validation. The release suite completed with 134 pass / 0 fail.

## v1.6.6 · 2026-07-16

### 中文

- 修复完整 ACC 离线包的部署链路：打包时会将当前 ACC 源码覆盖到嵌入式 Python 运行时，并重新生成完整性清单；首次启动的 `--ensure` 因此能真正安装本次修复，而不会继续运行旧缓存代码。
- 修复 Windows.Media.Ocr 与不同 `winsdk` 投影之间的字节传递兼容性，OCR 现接受 `bytes`、`bytearray`、`memoryview` 和二进制流，避免 `bytes-like object` 错误。
- 完整包继续固定使用已验证的 CPython 3.12、`winsdk` wheel-only 离线缓存和匹配的 Chromium；ZIP 打包会校验 Explorer 路径预算与归档完整性。
- 改进浏览器/桌面自动化、技能库、文档工作流，以及多 Agent 编排的可靠性与可观测性。

### English

- Fixes the Full ACC offline deployment path: packaging now overlays the current ACC source into the embedded Python runtime and regenerates its integrity manifest, so first-launch `--ensure` installs this release's fixes instead of cached code.
- Fixes byte-transfer compatibility between Windows.Media.Ocr and differing `winsdk` projections. OCR now accepts `bytes`, `bytearray`, `memoryview`, and binary streams, avoiding `bytes-like object` failures.
- The Full package remains pinned to a verified CPython 3.12 runtime, a wheel-only `winsdk` cache, and matching Chromium; packaging validates Explorer path budget and archive integrity.
- Improves browser/desktop automation, the skills library, document workflows, and multi-agent orchestration reliability and observability.

## v1.6.5 · 2026-07-15

### 中文

- 首次公开发布：如意 Ruyi 作为 Apache-2.0 开源的、Windows 原生、离线优先本地 AI 工作台发布。
- 支持任意 OpenAI 兼容端点与本机 Claude CLI 的双引擎对话；保留工作区约束、检查点、回溯、分级权限和审计时间线。
- 内置文件、终端、Git、联网搜索、MCP、桌面与 Office 协作能力；可选 ACC 桌面控制组件保持独立、可审计的安装边界。
- 多 Agent DAG、任务池、Agent 邮箱、质量门与单回合 Agent team 开关可用于有明确可并行职责的任务。
- 新增面向开源协作的双语社区行为准则、支持说明、Issue 表单和 PR 模板。

### English

- First public release: Ruyi is published as an Apache-2.0, Windows-native, offline-first local AI workbench.
- Supports dual-engine chat through any OpenAI-compatible endpoint and a local Claude CLI, while retaining workspace guards, checkpoints, rewind, tiered permissions, and an audit timeline.
- Includes file, terminal, Git, web-search, MCP, desktop, and Office handoff capabilities; the optional ACC desktop-control component remains separately installable and auditable.
- Multi-agent DAG workflows, a task pool, agent mailbox, quality gates, and the one-turn Agent team switch support tasks with genuinely separable responsibilities.
- Adds bilingual open-source community guidance, support information, Issue forms, and a Pull Request template.

## Earlier development

### 中文

在 `v1.6.5` 之前的迭代记录、设计说明和验收材料见 [`docs/archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md`](./docs/archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)。

### English

For iteration records, design notes, and acceptance material before `v1.6.5`, see [`docs/archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md`](./docs/archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md).
