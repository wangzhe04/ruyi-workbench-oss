# 发行说明 · Changelog

本文件记录面向用户的重要发行变化，不替代完整的 Git 提交历史。版本遵循 `ruyi-workbench/package.json`。
This file records user-facing release highlights; it does not replace the complete Git history. Versions follow `ruyi-workbench/package.json`.

## v1.6.7 · 2026-07-20

### 中文

- 修复 Claude CLI 原生子 Agent 结果展示与生命周期归因，避免子 Agent 刚创建就显示完成、结果不可见；同时强化父回合心跳、瞬态失败恢复与上下文连续性。
- 增加 Kimi Coding Plan 配置支持，并保持与 Ark 等多套 Claude CLI Coding Plan 的切换兼容；配置会覆盖陈旧的进程环境变量，不污染用户的其它计划。
- 根治 Windows `cmd.exe` 8191 字符命令行上限：解析 npm `claude.cmd` shim 到真实 `claude.exe`，稳定索引改走一次性 stdin 通道，技能索引不再把启动参数撑爆。
- 引入数据管家、会话存储 v2、引擎转录 GC 与 `/api/metrics`：会话正文改为增量 NDJSON，支持保留策略、压缩、统计和可观测性，降低长期运行的写放大与磁盘堆积。
- 后端工具分发改为表驱动，并将约 1.8 万行服务端按 15 个有序源码片段进行构建期拼接；运行时仍是零 npm 依赖的单文件 `app/server.js`，CI、打包和开发启动均校验产物新鲜度与语法。
- 测试与供应链继续加固：动态端口、并行测试、真实 Claude CLI 手工探针、前端 ES Module 语法门、离线包完整性校验；本次发布前全量结果为 134 pass / 0 fail。

### English

- Restores Claude CLI native sub-agent results and lifecycle attribution so newly spawned agents no longer appear instantly completed with hidden output; parent heartbeats, transient recovery, and context continuity are hardened as well.
- Adds Kimi Coding Plan support while preserving clean switching with Ark and other Claude CLI plans. Explicit configuration overrides stale inherited environment variables without contaminating other plans.
- Removes the Windows `cmd.exe` 8191-character launch limit by resolving npm `claude.cmd` shims to the real `claude.exe` and moving stable index injection to one-time stdin input.
- Adds Storage Steward, session storage v2, engine transcript GC, and `/api/metrics`. Session bodies use incremental NDJSON with retention, compression, statistics, and lower long-running write amplification.
- Converts native tool dispatch to a table-driven registry and splits the roughly 18k-line backend into 15 ordered build-time source slices. Runtime remains a zero-npm-dependency single-file `app/server.js`, with freshness and syntax gates across CI, packaging, and developer startup.
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
