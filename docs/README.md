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

Historical roadmaps, acceptance notes, design explorations, and generated mockups are retained in their original
language. They are engineering records rather than normative user or deployment guides.

## UI 设计稿生命周期(第50波 D3 标注)

| 设计稿 | 状态 | 说明 |
|---|---|---|
| [UI-DESIGN-V4.md](UI-DESIGN-V4.md) | **定稿(现行基线)** | 现代毛玻璃质感;token 值与 styles.css 一致(第50波落地),mockup: `mockups/v4-glass-*.html` |
| [UI-VNEXT-CONCEPT.md](UI-VNEXT-CONCEPT.md) | 概念待立项 | 唯一未落地概念稿(「交办台」);vNext 立项决策列第52波+,双壳并存死线 ≤2 release |

## 归档区(`archive/`)

以下文档已竣工/已落地/已交付，移入 [`archive/`](archive/) 作为工程溯源档案。roadmap/ARCHITECTURE 仍按波次引用。

| 文档 | 对应波次 | 状态 |
|---|---|---|
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

