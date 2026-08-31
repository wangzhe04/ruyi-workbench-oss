# 如意 Ruyi 工作台 · 优化方案索引（当前活跃）

`docs/optimization-plan/` 子目录的活跃方案索引。编号 04–07、12、20–23 为当前仍活跃的方案；其余编号（01–03、08–19）的方案已交付并归档。

## 状态说明

- 已交付/已归档的 01/02/03/08–19 号方案文档已移入 [`../archive/optimization-plan/`](../archive/optimization-plan/)（归档明细见其 [`README.md`](../archive/optimization-plan/README.md)），本文档不再收录其正文。
- 本文档只列出当前仍活跃的方案（04/05/06/07/12/20/21/22/23）。
- 全局路线图与后续计划以 [`../OPTIMIZATION-ROADMAP.md`](../OPTIMIZATION-ROADMAP.md) 为准。

## 当前活跃方案

| 编号 | 方案 | 一句话状态 |
|---|---|---|
| 04 | [提示词规范化](04-prompts-workflow.md) | 部分交付：提示词护栏已建、外置提示词未做 |
| 05 | [安全/性能/架构/测试等附加方向](05-other-directions.md) | 部分交付：各附加方向按需推进中 |
| 06 | [HB360 成本收敛](06-hb360-cost-convergence.md) | 部分交付：O1–O6 各目标部分落地 |
| 07 | [MicroAgent 方法论](07-microagent-lessons.md) | M1–M6 多数已交付；data-insights 候选待启动 |
| 12 | [Agent 架构研究路线](12-agent-architecture-research-roadmap.md) | R2/R3 暂缓；R4/R5 已收口 |
| 20 | [运行时优化性价比收敛](20-runtime-optimization-cost-benefit.md) | shadow 安全门通过，但 283/89/59 对抗审计确认非纯收益：T1 继续 shadow，C1 主动启用阻断，F1 仅 telemetry |
| 21 | [工具调用经济性校准与收敛](21-tool-call-economics-convergence.md) | E0/E1、E2a/E2c、E3/E5 已有实现，主动优化开关仍关；E0/E1 抽样→总量口径修复已随 22-S0 交付，基线自此可信；E2b/E4 延后，HB360 历史对账 blocked/deferred |
| 22 | [Agent SoC 微架构收敛（Pretender 3.0 核心）](22-agent-soc-microarchitecture.md) | 2026-08-27 评审修订：15 项方向／4 项排除；**第 0 步计量校准核心已交付**（econ_call_totals/econ_summary_call/报表 schema 2）；首批其余五项待实施／验证 |
| 23 | [架构偿还与上下文演进序列（第 103–107 波）](23-architecture-repayment-sequence.md) | 2026-08-30 revise-major 后纳入：command core 已交付不重做；103 路由／依赖／持久化地基 → 104 上下文结构 → 105 行为证据 → 106 Agent SoC 收敛 → 107 发布批准点。**第 103、104 波已交付**：路由／依赖／持久化契约与零行为职责内聚均已落地；当前进入 105 |

## 当前实施入口（2026-08-31）

- 当前下一实施入口为 **23 号第 105 波上下文缓存与摘要保真行为实验**：第 103、104 波已交付；沿用依赖图、持久化清册、`CompactionPlan` 与契约快照，先做默认关闭／受控 canary 的证据实验。
- 22 号线已交付 **第 0 步✅** 与 **#1 provider 层验证✅**；#6 继续按数据触发挂起。#13a(+t) 仍优先于 #2a，但按唯一波次排期进入 106；如需因热点提前，只能在 103 出门后成文重排。
- 结果缓存／观察去重、预算保护／自动降级分别立项；观察引用先有按需回载，模型降档必配升级／暂停路径。长期使用数据用于扩围，不替代或阻塞可构造的限定范围证据。
- 新引擎版 3.0 的范围与发布门见 22 号线 §8；旧壳层 P4 与正式人因门不自动恢复或豁免。

## 编号空缺说明

编号 01–03、08–19 对应已交付并归档至 `../archive/optimization-plan/` 的方案（01 UI 现代化、02 steer、03 tools/MCP、08 任务单 UX 审计、09 M3 覆盖率门、10 M4 消融、11 M1 上下文分层、13 R1 证据图、14 M2 确定性节点、15 R4 记忆图、16 R5 重规划台账、17–19 M5 方法论工具/调试记录器/数据画像），明细见 [`../archive/optimization-plan/README.md`](../archive/optimization-plan/README.md)。
