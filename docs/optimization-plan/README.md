# 如意 Ruyi 工作台 · 优化方案索引（当前活跃）

`docs/optimization-plan/` 子目录的活跃方案索引。编号 04–07、12、20–21 为当前仍活跃的方案；其余编号（01–03、08–19）的方案已交付并归档。

## 状态说明

- 已交付/已归档的 01/02/03/08–19 号方案文档已移入 [`../archive/optimization-plan/`](../archive/optimization-plan/)（归档明细见其 [`README.md`](../archive/optimization-plan/README.md)），本文档不再收录其正文。
- 本文档只列出当前仍活跃的方案（04/05/06/07/12/20/21）。
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
| 21 | [工具调用经济性校准与收敛](21-tool-call-economics-convergence.md) | E0 三层账本 shadow ✅；E1 基线报表 ✅；E2a worker pool（开关关）+ E2c 重放 ✅；E3 参数双视图 ✅（`actionArgumentModelViewV1` 默认关，对抗验证 8 项过）；E5 元工具链 ✅（`metaToolHintsV1` 默认关）；E2b/E4 延后；HB360 对账门 blocked/deferred |

## 编号空缺说明

编号 01–03、08–19 对应已交付并归档至 `../archive/optimization-plan/` 的方案（01 UI 现代化、02 steer、03 tools/MCP、08 任务单 UX 审计、09 M3 覆盖率门、10 M4 消融、11 M1 上下文分层、13 R1 证据图、14 M2 确定性节点、15 R4 记忆图、16 R5 重规划台账、17–19 M5 方法论工具/调试记录器/数据画像），明细见 [`../archive/optimization-plan/README.md`](../archive/optimization-plan/README.md)。
