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
| ~~Pretender 3.0~~ | **⛔ 已退役（2026-09-11，第 121 波 K1）** | 交办台壳层已整层删除（8 个 js/preview-*.js、preview-shell.css、505 个 previewShell.* 键、16 件 pretender-*.e2e.js），视角收成「管家 / 工作台」两视，见 [`optimization-plan/34-wave-121-one-workbench-two-views.md`](optimization-plan/34-wave-121-one-workbench-two-views.md) §8。它的数据契约仍在用，已改名 [`MISSION-SCHEMA.md`](MISSION-SCHEMA.md)；规划与本机指标归档为 [`archive/PRETENDER-PLAN.md`](./archive/PRETENDER-PLAN.md) v4、[`archive/PRETENDER-METRICS.md`](./archive/PRETENDER-METRICS.md)，门评审见 [`archive/PRETENDER-GATE-REVIEW.md`](archive/PRETENDER-GATE-REVIEW.md) |
| [Traveler 4.0](TRAVELER-CONCEPT.md) | **Concept v0.1 / 概念稿 v0.1** | Portable Missions：Task Capsule、安全续办、跨设备/接手者移交、执行权与证据回程；不是范围、版本或发布时间承诺 |

## UI 设计稿生命周期(第50波 D3 标注)

| 设计稿 | 状态 | 说明 |
|---|---|---|
| [UI-DESIGN-V4.md](UI-DESIGN-V4.md) | **定稿(现行基线)** | 现代毛玻璃质感；token 值与 `css/tokens.css`、`css/themes/color-schemes.css` 一致，`styles.css` 为兼容清单；mockup: `mockups/v4-glass-*.html` |
| [UI-VNEXT-CONCEPT.md](UI-VNEXT-CONCEPT.md) | **概念稿（Pretender 3.0 依据，3.0 已搁置）** | 「交办台」概念稿；已按 `./archive/PRETENDER-PLAN.md` v4 立项推进（P1–P3 完成，P4 3.0.0 默认切换暂缓；2026-08-10 用户决定跳过人因验证、3.0 收口线整体搁置，第87–91波成果已随 2.4.1/2.5.0 交付）；2026-09-03 壳层线由管家壳继任，双壳退出时钟 2026-09-05 作废 |
| [optimization-plan/27-waves-115-117-steward.md](optimization-plan/27-waves-115-117-steward.md) §8 | **定稿（管家壳 3.0，2026-09-05）；第 117 波已实现（2026-09-06，默认仍是经典布局，见 §11.6）** | 管家壳 UX/UI 详细设计：话＋一行按钮、递话「输入即预判」、线程单一权限四档、事项/线程抽屉「它刚说／你可以说」、2.0 视窗与两壳长期并存；mockup: `mockups/steward-shell.html`（可交互，零依赖） |

## 归档区(`archive/`)

以下文档已竣工/已落地/已交付，移入 [`archive/`](archive/) 作为工程溯源档案。roadmap/ARCHITECTURE 仍按波次引用。`optimization-plan/` 子目录索引已收窄：已交付的 01/02/03/08–19 号方案已归档至 [`archive/optimization-plan/`](archive/optimization-plan/)，当前活跃方案仅 04/05/06/07/12（活跃索引见 [`optimization-plan/README.md`](optimization-plan/README.md)，归档明细见 [`archive/optimization-plan/README.md`](archive/optimization-plan/README.md)）。

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
| `archive/mockups-v1/p2-refinements.html` | — | 旧版 mockup(R2 版在 `mockups/`) |
| `archive/mockups-v1/p3-workbench.html` | — | 旧版 mockup(R2 版在 `mockups/`) |
| [AGENT-HARNESS-AUDIT.md](archive/AGENT-HARNESS-AUDIT.md) | — | 已归档(2026-07-31 差距审计) |
| [UI-ESCAPADE-TURN-NARRATIVE.md](archive/UI-ESCAPADE-TURN-NARRATIVE.md) | 第54波 | 已落地(回合叙事化) |
| [PRETENDER-GATE-REVIEW.md](archive/PRETENDER-GATE-REVIEW.md) | 第56波 | 已归档(立项门评审) |
| [PRETENDER-PLAN.md](archive/PRETENDER-PLAN.md) | 第74–91波 | 已归档(121-K1 交办台退役；数据契约另见 MISSION-SCHEMA.md) |
| [PRETENDER-METRICS.md](archive/PRETENDER-METRICS.md) | 第79–86波 | 已归档(交办台本机系统测量) |
| [optimization-plan 已交付 14 份](archive/optimization-plan/README.md) | — | 已归档(01/02/03/08–19 已交付方案；见 archive/optimization-plan/README.md) |
