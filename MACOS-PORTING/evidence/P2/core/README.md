# P2-03：核心业务与调度恢复

2026-11-06，基线 `ce5a7db3`，分支 `codex/p2-macos-agent-core`。实现提交 `dfa1b9d4`。本批复用核心业务链路，修正调度持久化边界；独立复核者 `/root/p2_cli_audit`。本记录仅覆盖当前 Mac 本地环境，不代表整个 P2 已验收。

## 实现与行为

- 启动恢复把错过任务放入内存补跑队列时，保留磁盘上的原到期时间；登记前再次重启仍能找到那一次任务。
- 执行终态先写入 fires 回执，再应用任务状态和保存任务表。另一个任务或用户设置保存整张表时，不能提前清掉在飞标记。重启优先使用已持久的真实终态；没有终态证据才记 unknown，不盲目重发。
- 空 runId 的计划跳过、宽限到期和日上限回执也按 occurrenceKey 恢复；跨午夜计数归零后，同一次已跳过任务不会重新执行。tick 跳过路径同样先写回执，再推进计划；任务结果同步为 skipped/late。
- 收尾补丁在终态持久化后读取当前计划与失败计数，保留期间用户的计划修改、暂停或失败计数重置。manual 运行不推进原计划。终态 at 固定为实际完成时刻，正常与重启恢复使用同一个时间。
- 终态行的 tripped 表示完成时观察到失败阈值的历史事实；持久化期间用户明确重置计数后，当前任务可保持启用，实际状态与通知按最新计数处理。

未新增调度服务、持久字段、运行时依赖或生产崩溃钩子。只在现有 scheduler-crash e2e 中增加冷进程边界验证，没有新增测试文件。

## 调度政策与验收边界

- 应用内 tick 默认 30 秒，5 分钟内迟到属于运行中的普通抖动；超过后按 missedOccurrence 策略处理。
- 默认 onMissed 为 run-once-late，宽限 720 分钟；在宽限内只补一次，超过宽限或显式 skip 就记录跳过，不逐次追补。
- 已登记而中断的执行没有终态时记 unknown 并消费该时点；不能把未知当成功，也不能自动重放可能已发生的文件/外部副作用。
- 不承诺设备睡眠时执行。时钟跳变、时区/DST与重启策略由既有测试验证；真实 OS 睡眠唤醒与桌面壳生命周期在 P4 复验。

## 验证

环境为 macOS 27.0.1 arm64 / Node 24.15.0。服务、冷进程和假端点使用隔离 HOME/AppData/RUYI_HOME，不访问真实账户。最终命令和退出码见 [validation.json](validation.json)，独立发现及处理见 [review.json](review.json)。

| 范围 | 采用的现有验证 |
|---|---|
| Provider 工具回合 | openai-engine、openai-tools、responses-fake、anthropic-fake |
| 会话、检查点与恢复 | session-storage-v2、checkpoint、autonomy-resume |
| 管家与交付 | steward-runner、steward-delivery |
| 多 Agent 与工作流 | agent-workflow-templates、agent-workflow-replan |
| 记忆 | workbench-memory-core、workbench-memory、memory-recall-injection |
| 用量 | usage-ledger、usage-subagent-ledger、usage-accum |
| 调度及崩溃恢复 | scheduler、scheduler-crash、scheduler-ready-queue；4 个既有调度单元文件 |

20 组端到端最终全部退出 0，调度专项 25 条单元通过。最终语法与构建新鲜度通过；全量单元 2489 通过、18 跳过，80 组静态通过。命令见 validation.json。run-all --fast 内含完整单元，不在其前重复运行完整单元。

scheduler-crash-red.txt 保留新增边界断言在旧实现上的失败证据。开发中跨午夜夹具曾使用不合法 once 形状、迟到未过 slack；已修正并保留严格结果断言。static-first.txt 保留最初 79/80 静态通过、隔离启动点计数未同步的失败；计数从 224 更新为 225 后最终整套门禁通过。最初 15 组基线记录见 validation.json 的 baselineChecks；其中原 scheduler-crash 输出在开发重跑时被覆盖，不能把 red 日志当作其原通过证据，当前最终日志已完整重跑。

## 待验收与后续

本批假 Provider 工具回合不替代真实 Claude/Kimi 联调。Windows 同 SHA 实机回归仍待验；正式 Keychain 授权/签名和真实机器人服务联调分别见 P2-01/P2-02/P2-04。实际工作量未核算。

回退本批实现前保留 scheduler 任务表和 fires 回执；格式未改变，回退会重新暴露已确认的恢复写序缺陷。
