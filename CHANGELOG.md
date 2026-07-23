# 发行说明 · Changelog

本文件记录面向用户的重要发行变化，不替代完整的 Git 提交历史。版本遵循 `ruyi-workbench/package.json`。
This file records user-facing release highlights; it does not replace the complete Git history. Versions follow `ruyi-workbench/package.json`.

## v2.0.0 后续迭代 · 2026-07-21 ~ 07-23（47-52 波，未 bump 版本号）

封版后五个功能波（快赢/地基/生态/视觉/规范化），ACC 同步升至 **v1.9.0**（100→107 工具）。全部经"实现 → 对抗多 agent 审查 → 定向修复 → 离线 e2e 回归"循环。

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

## v2.0.0 · 2026-07-21

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

在 `v1.6.5` 之前的迭代记录、设计说明和验收材料见 [`docs/OPTIMIZATION-ROADMAP.md`](./docs/OPTIMIZATION-ROADMAP.md)。

### English

For iteration records, design notes, and acceptance material before `v1.6.5`, see [`docs/OPTIMIZATION-ROADMAP.md`](./docs/OPTIMIZATION-ROADMAP.md).
