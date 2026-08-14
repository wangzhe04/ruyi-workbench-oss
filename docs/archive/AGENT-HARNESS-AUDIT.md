# Ruyi 作为 AI Agent Harness 的差距审计

日期：2026-07-31
结论：Ruyi 是“产品化、治理优先的 Agent Harness”，不是面向嵌入的库式 Harness。外部分析指出的方向总体有效，但其中两项关键现状已经过时；本次只落地证据仍成立且适合 Escapade 小迭代的缺口。

## 逐项核验

| 分析项 | 当前证据 | 判断 | 本次动作 |
| --- | --- | --- | --- |
| P0 工具 schema 成本 | `createToolLoadingState()` 已按意图/工具包裁剪首批 schema，并提供 `tool_search` / `tool_load`；Provider prompt 已拆稳定 system 前缀与易变 user 层 | 主要问题已解决，不重复建设 | 保留现有实现；继续由 `toolSchemaTokens` 和 prompt benchmark 守门 |
| P1 Agent Loop 生命周期扩展点 | Provider/Claude 两条路径此前只有散落事件与日志，没有稳定注册契约、顺序、超时和故障隔离 | 缺口成立 | 第75d波增加只读 Hook Spine |
| P2 Agentic Eval | `dev-harness/prompt-benchmark*`、fake provider 与大规模 e2e 已覆盖提示词/工具循环/恢复/干预等行为 | “完全没有”不成立；仍可扩展成跨模型质量矩阵 | 本次不复制评测框架，给 hooks/trace 增加现有门内回归 |
| P3 Checkpoint / replay | 已有文件 checkpoint journal、turn summary、Agent Run continuation 与恢复分级；尚无模型调用级确定性 replay | 部分成立，属于独立大切片 | 不塞进小迭代；trace spine 先补关联主键 |
| P4 Model adapter | 已有 OpenAI-compatible Provider 与 Claude CLI 两引擎，但还不是可插拔统一 adapter 接口 | 成立，但重构面大 | 延后到 adapter RFC/迁移切片 |
| P5 Tracing | 已有结构化 `logEvent`、usage、tool events，缺统一回合 trace 关联和 OTel exporter | 成立 | 本次先补轻量 trace ID；OTel 延后 |
| P6 Session 并发 | 单 session 活回合会串行/替换，若干磁盘写有 write-chain；仍没有完整乐观锁/多进程一致性协议 | 部分成立 | 保持挂账，需结合 session revision/CAS 专波处理 |

## 第75d波的边界

新增生命周期阶段：`onTurnStart`、`beforeModelCall`、`preToolCall`、`postToolCall`、`onTurnEnd`、`onError`。

- 注册顺序确定；上下文做有界复制并深冻结。
- 单 hook 默认 250ms 超时（可在 25–2000ms 内设置），异常/超时只记审计，不中断主回合，后续 hook 继续运行。
- hook 返回值被忽略，不能改参数、替换结果、提升权限或绕过既有 gate；本波不自动加载磁盘脚本和第三方包。
- Provider 原生循环覆盖模型与工具阶段；Claude CLI 内部工具循环不受 Workbench 控制，因此只发回合/模型边界，避免制造“可拦截内部工具”的假契约。
- 每个逻辑回合生成 `trace_<16 hex>`，贯穿流事件、活动回合登记、用户/助手消息与 turn start/end 审计日志；Claude resume recovery 复用原 trace。

这是一条“可观测扩展脊柱”，不是插件系统。下一步若要引入可变 middleware，必须单独冻结参数修改、阻断语义、权限不可提升和失败策略，不能在只读契约上悄悄加写能力。

## 后续建议顺序

1. 用现有 hooks 接内部 metrics sink，观察每阶段延迟和 hook 预算，不先引入外部依赖。
2. 为模型请求/工具结果建立可选择脱敏的 trace export，再评估 OpenTelemetry exporter。
3. 以 trace ID + checkpoint journal 做“诊断 replay”PoC，明确与“重新执行副作用”的安全边界。
4. 另立 ModelAdapter RFC；先统一能力声明、stream event 和错误枚举，再迁移现有两引擎。
5. Session 并发与多进程一致性用 revision/CAS 独立解决，不与 UI/Pretender 切片混改。
