# 优化方案索引

> 更新：2026-10-21。3.1 暂不发布：先完成 [86 号补完与隐私路线](86-3.1-completion-and-privacy-roadmap.md) 的全部范围，再冻结候选并重新验收。4.0 暂不确定方向或排期。旧编号是文档身份，不是执行顺序。

## 当前实施入口

- [86 · 3.1 补完与隐私路线](86-3.1-completion-and-privacy-roadmap.md)：唯一当前范围和执行顺序入口。QQ／飞书真平台联调、投递管理、进度与远程待决，全链路隐私的明确边界与实现、工作数据加密、全文分片索引、跨既有线程接力和定时模板全部纳入 3.1 发布前范围。
- [87 · 代码规模与合理精简审计](87-code-size-and-simplification-audit.md)：当前基线的代码统计与共用机制候选；只读审计不代表改造已实施，安排由 86 统一维护。
- [88 · M1 外发边界与本地处理原型](88-privacy-m1-prototypes.md)：外发清册、Windows CLI 隔离与媒体原型的设计、实验证据及未解决条件。
- [89 · 音频修复与 CLI 隔离续验](89-audio-and-cli-isolation-followup.md)：发送边界与配置发布竞态修复、LPAC/网关后续实验，以及本地 ASR 改为可选组件的评估。
- [90 · Claude 与严格文件边界验证](90-claude-and-filesystem-feasibility.md)：原生 Claude 初始化与网关候选、LPAC 文件视图反例、额外受限令牌，以及进程回收测试的调查与观测修正。
- [全局路线图](../OPTIMIZATION-ROADMAP.md)：已发布基线、已合入状态和发布规则。
- [文档总索引](../README.md)：使用、开发、发布和历史证据导航。

PR #58 已合入 `f5223548`；现有隐私候选 ux15 完成源码及实际包验收，应用版本仍为 3.0.1，未发布。该结果只覆盖已验收字节，不覆盖 86 号新增工作。原始证据及独立复核见 [85 号归档](../archive/optimization-plan/85-privacy-rule-and-settings-regression-31.md)。

## 继续维护的设计与规范

| 文档 | 当前用途与边界 |
|---|---|
| [62 · 管家分轮设计](62-steward-3x-iterations.md) | 保留用户旅程、验收约束和采用决策来源；旧版号归属与“后续候选”不再决定 3.1 范围，按 86 执行。 |
| [66 · 外部机器人](66-external-bots-and-steward-channels.md) | 已有 A 批为基座；QQ／飞书真平台、投递、进度与远程待决由 86 补完。 |
| [67 · 代办机器人配置](67-steward-assisted-bot-setup.md) | 本机配置、秘密录入、配对和本人授权契约继续维护；真实平台仍需验收。 |
| [68 · 飞书身份发现](68-external-bot-identity-discovery.md) | 固定官方 API 探测和禁用连接准备契约；真实响应核对纳入 3.1。 |
| [81 · 隐私原设计](81-privacy-vault-and-tokenization-31.md) | 凭据库、恢复与双向转译设计来源；代码已随 PR #58 合入，新增范围以 86 为准。 |
| [83 · 隐私规则规范](83-privacy-rule-catalog.md) | 规则分类、识别依据、维护及反例边界；不将识别器描述成任意语义／编码的绝对保护。 |
| [84 · 工具转译与档位](84-privacy-tool-transport-and-profiles-31.md) | 默认关闭、配置原子性、工具传输与已有覆盖边界；媒体、CLI 和独立 MCP 的新设计与支持门见 86。 |

“已实现”“验证通过”“已合入”“默认启用”和“已发布”分别判断。历史授权、模型分工和分支名不自动成为下一轮指令；旧事实不因移动文档改写。

## 候选研究与早期方向（10 份）

保留研究与证据价值，不自动纳入 3.1 或 4.0。与 86 明确纳入的范围发生冲突时，以 86 为准。

| 编号 | 文档 | 阅读边界 |
|---|---|---|
| 04 | [提示词规范化](04-prompts-workflow.md) | 护栏已有交付记录；外置等剩余方向仍是候选，不能照原波次直接开工。 |
| 05 | [安全、稳定性与工程化方向](05-other-directions.md) | 保留早期问题清单；部分结构工作已由后续波次实施，逐项复核后再选题。 |
| 06 | [HB360 成本与收敛](06-hb360-cost-convergence.md) | 历史基准与部分实现依据；旧费用、模型、样本与收益结论仅适用于原测试条件。 |
| 07 | [MicroAgent 方法论](07-microagent-lessons.md) | 已有方法论工具和独立批次交付；未完成候选仍需单独验证，不重新认领已交付能力。 |
| 12 | [Agent 架构研究](12-agent-architecture-research-roadmap.md) | R4/R5 有收口记录，R2/R3 暂缓；其余研究不自动进入当前版本承诺。 |
| 20 | [运行时优化性价比](20-runtime-optimization-cost-benefit.md) | shadow、主动启用和 telemetry 必须分开；保留 C1 阻断与 F1 仅观测的证据边界。 |
| 21-E2 | [有界只读批次调度器](21-E2-bounded-read-scheduler.md) | E2a/E2c 有实现与重放记录，E2b 待实施；本文不授权改变主动开关默认值。 |
| 21 | [工具调用经济性](21-tool-call-economics-convergence.md) | 保留计量修复、已有实现与受限实验；E2b/E4 延后及历史数据不足不等于已通过。 |
| 22 | [Agent SoC 微架构](22-agent-soc-microarchitecture.md) | 早期方向池；后续实施和启用裁决已写入 [23 号](../archive/optimization-plan/23-architecture-repayment-sequence.md)，本页最初的“未实施”不是当前状态。 |
| 41 | [个人工作台综合研究与旅程](41-personal-workbench-iteration-plan.md) | 2026-09-12 的代码核查快照与候选库；16 条 J 旅程可复用，附录 C15 等“尚未实现”结论须结合后续交付重新核查。 |

## 已归档的设计与验收

[历史方案索引](../archive/optimization-plan/README.md)收录 69 篇方案，包括本轮迁入的 23–61（41 研究除外）、63–65、69–80、82、85。原有交付记录、未通过、flaky、跳过及未覆盖边界均保留；[80](../archive/optimization-plan/80-steward-31-release-acceptance.md)、[82](../archive/optimization-plan/82-privacy-31-implementation.md) 的旧包验收不替代 [85](../archive/optimization-plan/85-privacy-rule-and-settings-regression-31.md) 最终字节，更不替代 86 新范围的发布门。

本目录 `105*`、`106*`、`107*` JSON 是历史测量附件，相关 live harness 仍以此为默认输出路径，因此保留原地；不是本轮新测试或当前配置承诺。

## 查阅规则

1. 找当前要做什么先读 86；找来源沿现行规范进入归档记录。
2. 判断能力是否已有，核对当前源码、消费者与行为测试；旧方案开头的“未做”可能已被后续实现覆盖。
3. 历史源码行号可能漂移；重新实施时按符号名和原始 commit 核对。
4. 移动文档先查文档、源码、测试和脚本引用，再修正文内相对链接。固定消费的生成或运行时路径保留稳定。
