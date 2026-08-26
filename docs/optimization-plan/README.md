# 如意 Ruyi 工作台 · 优化方案索引（当前活跃）

`docs/optimization-plan/` 子目录的活跃方案索引。编号 04–07、12、20–22 为当前仍活跃的方案；其余编号（01–03、08–19）的方案已交付并归档。

## 状态说明

- 已交付/已归档的 01/02/03/08–19 号方案文档已移入 [`../archive/optimization-plan/`](../archive/optimization-plan/)（归档明细见其 [`README.md`](../archive/optimization-plan/README.md)），本文档不再收录其正文。
- 本文档只列出当前仍活跃的方案（04/05/06/07/12/20/21/22）。
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
| 21 | [工具调用经济性校准与收敛](21-tool-call-economics-convergence.md) | E0/E1、E2a/E2c、E3/E5 已有实现，主动优化开关仍关；E0/E1 抽样→总量口径待修，不能视为完整可信基线；E2b/E4 延后，HB360 历史对账 blocked/deferred；限定范围验证与 22 共用证据分类 |
| 22 | [Agent SoC 微架构收敛（Pretender 3.0 核心）](22-agent-soc-microarchitecture.md) | 2026-08-27 评审修订：15 项方向／4 项排除，A 确定性与本地基准、B 固定真实模型／后端、C 收益边界验证；首批六项待实施／验证，不以长期用户数据为统一前置；新旧 3.0 边界与发布门已明确 |

## 当前实施入口（2026-08-27）

- 22 号线 §4：计量校准 → Prompt Cache 验证 → 已有只读并行增量验证 → 受限执行结果缓存 → 预算保护基础层 → 一个批量输出／宏融合场景；每项独立验收，不是一次全部启用。
- 结果缓存／观察去重、预算保护／自动降级分别立项；观察引用先有按需回载，模型降档必配升级／暂停路径。长期使用数据用于扩围，不替代或阻塞可构造的限定范围证据。
- 新引擎版 3.0 的范围与发布门见 22 号线 §8；旧壳层 P4 与正式人因门不自动恢复或豁免。本次仅更新规划，未改代码、开关或版本号。

## 编号空缺说明

编号 01–03、08–19 对应已交付并归档至 `../archive/optimization-plan/` 的方案（01 UI 现代化、02 steer、03 tools/MCP、08 任务单 UX 审计、09 M3 覆盖率门、10 M4 消融、11 M1 上下文分层、13 R1 证据图、14 M2 确定性节点、15 R4 记忆图、16 R5 重规划台账、17–19 M5 方法论工具/调试记录器/数据画像），明细见 [`../archive/optimization-plan/README.md`](../archive/optimization-plan/README.md)。
