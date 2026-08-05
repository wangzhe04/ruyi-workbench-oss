# Documentation / 文档

Ruyi keeps user-facing and operational documentation in Chinese and English. The Chinese editions remain the
reference for China-specific deployment examples; the English editions carry the same product, safety, and
operational commitments.

| Audience | English | 中文 |
|---|---|---|
| Product overview and quick start | [Repository README](../README.md#english) | [仓库 README](../README.md) |
| Everyday users | [User Guide](../ruyi-workbench/docs/manuals/USER-GUIDE_EN.md) | [用户手册](../ruyi-workbench/docs/manuals/USER-GUIDE_CN.md) |
| Administrators | [Administrator Guide](../ruyi-workbench/docs/manuals/ADMIN-GUIDE_EN.md) | [管理员手册](../ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md) |
| Offline deployment | [Offline Deployment](../ruyi-workbench/docs/OFFLINE_DEPLOYMENT_EN.md) | [离线部署说明](../ruyi-workbench/docs/OFFLINE_DEPLOYMENT_CN.md) |
| Architecture | [Architecture](../ruyi-workbench/docs/ARCHITECTURE_EN.md) | [架构说明](../ruyi-workbench/docs/ARCHITECTURE_CN.md) |
| Clean-room source review | [Source Review](../ruyi-workbench/docs/SOURCE_REVIEW_EN.md) | [源码审阅结论](../ruyi-workbench/docs/SOURCE_REVIEW_CN.md) |
| Security policy | [Security Policy](../SECURITY.md) | [安全策略](../SECURITY.md) |
| Contributor guide | [Contributing](../CONTRIBUTING.md#english-summary) | [贡献指南](../CONTRIBUTING.md) |
| UI localization contract | [Localization Guide](i18n/README_EN.md) | [多语言兼容方案](i18n/README.md) |
| Built-in skills and quick tasks | — | [技能与一键任务目录](../ruyi-workbench/docs/SKILLS-CATALOG_CN.md) |
| MCP connector drop-ins | [MCP Connectors](../mcp/README_EN.md) | [MCP 连接器](../mcp/README.md) |
| Release lines and future roadmap | [Release & optimization roadmap](OPTIMIZATION-ROADMAP.md) | [发布线与优化路线图](OPTIMIZATION-ROADMAP.md) |

Historical roadmaps, acceptance notes, design explorations, and generated mockups are retained in their original
language. They are engineering records rather than normative user or deployment guides.

## Future product concepts / 未来产品概念

| Concept | Status | Scope |
|---|---|---|
| [Pretender 3.0](PRETENDER-PLAN.md) | **已立项 · 交付中（2026-08-05）** | 交办台新壳层；五层门 P1✅ / P2✅ / P3 工程✅（正式外部受试者人因验证待办），P4 第87波 3.0.0 默认切换与发布待办。规划见 [`PRETENDER-PLAN.md`](PRETENDER-PLAN.md) v4、门评审见 [`PRETENDER-GATE-REVIEW.md`](PRETENDER-GATE-REVIEW.md)、本机指标见 [`PRETENDER-METRICS.md`](PRETENDER-METRICS.md) |
| [Traveler 4.0](TRAVELER-CONCEPT.md) | **Concept v0.1 / 概念稿 v0.1** | Portable Missions：Task Capsule、安全续办、跨设备/接手者移交、执行权与证据回程；不是范围、版本或发布时间承诺 |

## UI 设计稿生命周期(第50波 D3 标注)

| 设计稿 | 状态 | 说明 |
|---|---|---|
| [UI-DESIGN-V4.md](UI-DESIGN-V4.md) | **定稿(现行基线)** | 现代毛玻璃质感；token 值与 `css/tokens.css`、`css/themes/color-schemes.css` 一致，`styles.css` 为兼容清单；mockup: `mockups/v4-glass-*.html` |
| [UI-ESCAPADE-TURN-NARRATIVE.md](UI-ESCAPADE-TURN-NARRATIVE.md) | **Escapade 提案(P1，建议前置)** | 一轮一个大框，文字/工具按真实顺序穿插；末尾保留完整工具、变更与产物复盘；Claude CLI/OpenAI 兼容共用协议与渲染器 |
| [UI-VNEXT-CONCEPT.md](UI-VNEXT-CONCEPT.md) | **已立项（Pretender 3.0 概念依据）** | 「交办台」概念稿；已按 `PRETENDER-PLAN.md` v4 立项推进（P1–P3 完成，P4 第87波 3.0.0 待办） |

## 归档区(`archive/`)

以下文档已竣工/已落地/已交付，移入 [`archive/`](archive/) 作为工程溯源档案。roadmap/ARCHITECTURE 仍按波次引用。

| 文档 | 对应波次 | 状态 |
|---|---|---|
| [OPTIMIZATION-ROADMAP-HISTORY-46-86.md](archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md) | 第46–86波 | 已归档（V2.0 封版、Escapade 2.x 交付详情、EC-A..EC-E 候选桶计划、第56波立项门计划与逐波交付记录） |
| [OPTIMIZATION-ROADMAP-HISTORY-V1-2.md](archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md) | 第1–45波 | 已归档（早期审计、v1.x 与 V2.0 立项/交付） |
| [AUTONOMY-PLAN.md](archive/AUTONOMY-PLAN.md) | 第25-26波 | 已落地(耐久基座 + 调度监督) |
| [TEAM-MODE-V2-DESIGN.md](archive/TEAM-MODE-V2-DESIGN.md) | 第8/9波后 | 已落地(团队模式 v2) |
| [WAVE31-ACCEPTANCE.md](archive/WAVE31-ACCEPTANCE.md) | 第31波 | 已交付(§5 工程7/7 + 产品4/4 达标) |
| [WAVE31-SHELL-SANDBOX-DESIGN.md](archive/WAVE31-SHELL-SANDBOX-DESIGN.md) | 第31波 | 已交付(shell 沙箱 edit guard) |
| [WAVE33-AUTH-DESIGN.md](archive/WAVE33-AUTH-DESIGN.md) | 第33波 | 已交付(声明式 auth deny-by-default + DNS-rebind 防护) |
| [STATIC-LOCK-AUDIT.md](archive/STATIC-LOCK-AUDIT.md) | 第43波 | 决策报告(构建期模块化 go/no-go,已执行 GO) |
| [UI-DESIGN-V3.md](archive/UI-DESIGN-V3.md) | — | 已竣工(V3 设计稿) |
| [UI-DESIGN-P3-WORKBENCH.md](archive/UI-DESIGN-P3-WORKBENCH.md) | — | 已竣工(P3 工作台) |
| [UI-DESIGN-R2-NOTES.md](archive/UI-DESIGN-R2-NOTES.md) | — | 已竣工(R2 视觉跃升) |
| [UI-ORCHESTRATION-REDESIGN.md](archive/UI-ORCHESTRATION-REDESIGN.md) | — | 已竣工(编排 redesign) |
| `archive/mockups/p2-refinements.html` | — | 旧版 mockup(R2 版在 `mockups/`) |
| `archive/mockups/p3-workbench.html` | — | 旧版 mockup(R2 版在 `mockups/`) |
