# 发行说明 · Changelog

本文件记录面向用户的重要发行变化，不替代完整的 Git 提交历史。版本遵循 `ruyi-workbench/package.json`。
This file records user-facing release highlights; it does not replace the complete Git history. Versions follow `ruyi-workbench/package.json`.

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
