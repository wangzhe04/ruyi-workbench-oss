# P1-04 CLI、MCP 与 toolbox 监督接入

2026-11-02，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，交付尚未提交，P1-04 保持进行中。

## 实现范围

- `ProcessRuntime.spawn` 保留现有 ChildProcess 调用形状，内部登记不透明 handle。MCP、toolbox 服务、Claude/Kimi 主 CLI、Kimi web 与 terminal、autonomy 子 CLI 已接入，owner 记录连接器/组件或会话、trace、turn、subagent 信息。
- `ready(child)` 在原生目标 exec 成功后确认启动。Kimi terminal/create 等待真实目标就绪，缺目标保留 ENOENT 行为。
- MCP 超时/取消等待有界 cleanup 确认，结果传播监督范围、逃逸观察限制和未确认数。并发取消不会因为另一条调用已清空 this.child 而丢失范围或退回全树终止文案。
- toolbox 停止期间保留 stopping 状态，完成后确认 stopped 或 failed，并对外提供 cleanup 字段。旧 child 的回调不能覆盖重启后的状态。
- Kimi terminal/kill 和 release 在清理未确认时返回错误，即使 terminal 已收到 close。内部终端收尾使用 allSettled 记录失败，主 CLI 关闭与 activeChildren 移除由 finally 保证。主回合也等待其监督清理，最终结果保留不完整状态。
- 原生外部清理器仅在已核创建身份、PGID 与 SID 证明存活 session leader 时，收集其锚定组内已成为孤儿的成员。回归冻结监督器后让目标主进程退出，验证外部清理仍能停止孤儿心跳。

## 随接入发现的 Mac 路径问题

Kimi 计划文件的同步词法预检查把 `/var` 与 `/private/var` 别名视为不同工作区，首次读取缺失计划文件因此落入普通文件不存在错误。异步处理现共享文件名限制，在 canonical 路径上核验 native/legacy 根、已知计划文件与直接子路径。外跳目录、悬空链接和不在计划根下的文件继续拒绝。

该修正完成了本处路径判断，完整 P1-02 系统写保护、大小写敏感卷、普通文件与原子回退验证继续待办。

## 验证记录

- Runtime 集成 e2e 两轮各 34 项通过，最终重复结果见 `e2e-1.txt`、`e2e-2.txt`。
- 清理基础回归见 `cleanup.txt`。
- Claude 工作流 53 项通过，见 `claude.txt`。
- Kimi 完整适配器 127 项通过，见 `kimi-final.txt`。原路径失败及诊断保留于 `kimi.txt`、`kimi-diagnostic.txt`。
- Toolbox 41 项通过，见 `toolbox-final.txt`。
- MCP 专项包括新增并发取消用例，21/21 通过，见 `mcp-unit.txt`。
- 最终全量单测 2508 项，2490 通过、0 失败、18 跳过，见 [日志](unit-final.txt)。静态检查 80/80，残留测试浏览器 0，见 [快速检查](fast-final.txt)。独立复核通过，记录见 [review.json](review.json)，汇总见 [summary.json](summary.json)。

## 剩余范围

常驻 shell、git 与其他 exec 入口仍需贯通监督启动和具体工具 owner。测试清理器的锚定组回收已接入，未观察到的快速会话逃逸仍仅能报告 `observed-only` 限制。helper 缺失/中途失效的能力门、所有权登记与关闭组合验收、Windows 与 macOS 14 实测继续保留。

完整 P1 的文件与系统路径策略、shell 语义及启动/Finder 剩余验收均未完成。
