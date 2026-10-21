# 如意文档导航

现行已发布基线为 3.0.1。PR #58 已合入；3.1 暂不发布，先完成 [86 号补完与隐私路线](optimization-plan/86-3.1-completion-and-privacy-roadmap.md) 纳入的原未完成范围。阅读顺序按使用目的划分；历史审计、旧方案和测试读数均保留其原始日期，不能作为当前版本已通过的证明。

Ruyi ships Chinese and English user and deployment guides. Historical design and audit records remain in their original language. 3.1 remains unreleased while the completion and privacy roadmap is implemented; 4.0 is not scheduled.

## 使用与部署

| 用途 | 中文 | English |
|---|---|---|
| 产品与快速上手 | [项目介绍](../README.md) | [Product overview](../README_EN.md) |
| 日常使用 | [用户手册](../ruyi-workbench/docs/manuals/USER-GUIDE_CN.md) | [User Guide](../ruyi-workbench/docs/manuals/USER-GUIDE_EN.md) |
| 管理与配置 | [管理员手册](../ruyi-workbench/docs/manuals/ADMIN-GUIDE_CN.md) | [Administrator Guide](../ruyi-workbench/docs/manuals/ADMIN-GUIDE_EN.md) |
| 离线部署 | [部署说明](../ruyi-workbench/docs/OFFLINE_DEPLOYMENT_CN.md) | [Offline Deployment](../ruyi-workbench/docs/OFFLINE_DEPLOYMENT_EN.md) |
| 更新发布包 | [增量升级说明](../ruyi-workbench/tools/APPLY-OVERLAY.md) | 同一文档含操作说明 |
| 问题与安全报告 | [支持渠道](../SUPPORT.md) · [安全策略](../SECURITY.md) | [Support](../SUPPORT.md) · [Security](../SECURITY.md) |

## 当前规划与版本

| 入口 | 状态与用途 |
|---|---|
| [发布与迭代路线](OPTIMIZATION-ROADMAP.md) | 当前发布基线、未发布内容和下一步范围 |
| [3.1 补完与隐私路线](optimization-plan/86-3.1-completion-and-privacy-roadmap.md) | 当前执行入口；范围、隐私支持边界、依赖与发布门 |
| [代码规模与合理精简审计](optimization-plan/87-code-size-and-simplification-audit.md) | 当前基线统计、重复机制与精简候选；实施安排见 86 |
| [M1 隐私边界原型](optimization-plan/88-privacy-m1-prototypes.md) | 外发清册、CLI 隔离与本地媒体实验；已验证与未完成分别记录 |
| [音频修复与 CLI 隔离续验](optimization-plan/89-audio-and-cli-isolation-followup.md) | 音频发送和配置竞态、LPAC/网关验证、ASR 可选范围 |
| [独立命名空间与成本裁决](optimization-plan/91-independent-namespace-cost-decision.md) | VM 依赖、实现/部署成本、暂缓边界与 Claude HTTP 基线 |
| [Claude 与严格文件边界验证](optimization-plan/90-claude-and-filesystem-feasibility.md) | 原生 Claude 启动障碍、LPAC 文件反例、受限令牌及进程回收调查 |
| [3.x 管家分轮设计](optimization-plan/62-steward-3x-iterations.md) | 既有旅程与采用门来源；旧版本归属和候选排期由 86 更新 |
| [优化方案目录](optimization-plan/README.md) | 当前方案、候选研究、历史设计分别列出 |
| [CHANGELOG](../CHANGELOG.md) | 面向用户的发布与未发布变化 |
| [3.0.1 发布说明](release-notes/v3.0.1.md) | 2026-10-16 发布基线；[HARD-51 实测与逐题数据](benchmarks/hard51-2026-10-15/README.md) · [English report](benchmarks/hard51-2026-10-15/README_EN.md) |
| [3.0 正式版](release-notes/v3.0.0.md) | 2026-10-08 发布范围；[预览一](release-notes/v3.0.0-preview.1.md)、[预览二](release-notes/v3.0.0-preview.2.md)、[预览三](release-notes/v3.0.0-preview.3.md)保留原发布口径 |
| [Traveler 概念](archive/TRAVELER-CONCEPT.md) | 历史探索，4.0 暂缓定案；不属于当前承诺 |

## 开发与扩展

| 用途 | 入口 |
|---|---|
| 开发约定 | [贡献指南](../CONTRIBUTING.md) · [代理工作说明](../CLAUDE.md) · [工程规范](ENGINEERING-SPEC.md) |
| 架构 | [中文](../ruyi-workbench/docs/ARCHITECTURE_CN.md) · [English](../ruyi-workbench/docs/ARCHITECTURE_EN.md) |
| 应用目录与运行 | [工作台本体](../ruyi-workbench/README.md) |
| 任务与干预数据契约 | [Mission Schema](MISSION-SCHEMA.md)，保留版本及后续兼容约定 |
| 工作流模型规范 | [中文](../ruyi-workbench/docs/MODEL-WORKFLOW-SPEC_CN.md) · [English](../ruyi-workbench/docs/MODEL-WORKFLOW-SPEC_EN.md) |
| 子代理协作与媒体工具 | [协作协议](agent-coordination.md) · [媒体任务验收](media-harness.md) |
| MCP 扩展 | [中文](../mcp/README.md) · [English](../mcp/README_EN.md) · [桌面控制 ACC](../mcp/ai-computer-control/README.md) |
| 技能与一键任务 | [技能目录](../ruyi-workbench/docs/SKILLS-CATALOG_CN.md)；随包技能正文属于运行时资源，按功能变更维护 |
| 测试 | [离线 harness](../dev-harness/README.md) · [提示词评测](../dev-harness/prompt-benchmark/README.md) · [语音评测](../dev-harness/bench-voice/README.md) |
| 多语言 | [中文约定](i18n/README.md) · [English](i18n/README_EN.md) · [字符串目录](i18n/STRING-CATALOG.md) |
| 视觉语言 | [V4 设计基线](UI-DESIGN-V4.md) · [原型与历史夹具](mockups/README.md)，现行交互形态以产品和浏览器测试为准 |
| 文档维护 | [文档分类与维护规则](DOCUMENTATION-GUIDE.md) |

## 架构清册

以下清册应与源码一起维护。机器生成文件不手改数字或内容：

| 清册 | 维护方式 |
|---|---|
| [路由](architecture/route-inventory.md) | node dev-harness/route-inventory.js |
| [模块依赖](architecture/module-dependency-graph.md) | node dev-harness/module-dependency-graph.js --write |
| [架构契约快照](architecture/architecture-contract-snapshots.md) | 生成命令见该文页首 |
| [持久化状态](architecture/durable-state-inventory.md) | 随存储生命周期改动登记，对应静态门核对 |
| [源码文本锁](architecture/source-text-locks.md) | 随测试锁分类维护 |
| [产品数字](../facts.json) | node dev-harness/facts-generate.js |

## 历史记录

[归档目录](archive/README.md)收录旧路线、退役界面和历次决策；[69 篇历史方案](archive/optimization-plan/README.md)与现行规划分开存放。[旧交办台概念](archive/UI-VNEXT-CONCEPT.md)已经由管家与工作台两视角替代，其数据契约仍有沿用；不能将旧壳层的搁置误读为 3.0 产品尚未发布。

[2026-09-23 审计](archive/RELEASE-3.0-AUDIT-2026-09-23.md)、[2026-10-08 审计](archive/RELEASE-3.0-AUDIT-2026-10-08.md)、[源码阅读记录](archive/SOURCE_REVIEW_CN.md)和[视觉审阅记录](archive/VISUAL-REVIEW.md)均是带基线的历史证据。已修复与尚未验证的项目按原文及后续提交核对，不按文档存在与否判定完成。
