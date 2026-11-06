# P1-04 Git 监督捕获与工具 owner

2026-11-02，macOS 27.0.1 arm64、Node 24.15.0，基线 `0a430880`。工作区尚未提交，P1 保持进行中。

## 实现

Mac `runGit` 使用 `ProcessRuntime.capture`，保留 stdout/stderr 原字节，结束时按 buffer 或 UTF-8 返回。双流分别遵守 maxBuffer，超额停止已登记进程，并保留有界的部分输出。进程退出后仍被后代持有的输出管道有 500ms 排空上限，超限返回明确传输错误。

git 超时使用监督控制通道，保留退出码、清理范围、已观察逃逸限制与未确认数。清理未确认优先于普通非零退出、空提交提示、钩子拒绝和 code 1 正常降级。diff 的 stat、未跟踪文件、cached 检查及 commit 后的 HEAD 查询也会传播清理失败。原命令可能已经产生提交变化，错误结果保留 commandExitCode 并要求核验仓库状态。

工具分发在既有校验之后使用 AsyncLocalStorage 绑定冻结的会话、turn、工具名、toolCallId 和 invocationId。git 与一次性执行显式继承该上下文，并保留自身的进程 kind。共享 MCP 的显式 owner 继续表示连接器归属。并发测试核验会话/调用隔离和调用结束后的上下文恢复。

## 证据

- 新 git runtime E2E 两轮各 28 项通过，见 [第一轮](e2e-1.txt)和[第二轮](e2e-2.txt)。覆盖原字节、分块 UTF-8、输出上限、非零状态、真实 git blob、正常提交后后台 hook 子进程停止、超时、故障输出管道及各层清理失败传播。
- 原 git 工具单测 11/11，见 [专项](git-unit.txt)。原 8MB 大 diff 截断、钩子拒绝及超时整树清理语义保留。
- 进程 runtime 回归 34/34，见 [回归](process-regression.txt)。
- 全量单测 2508 项，2490 通过、0 失败、18 跳过，见 [日志](unit-final.txt)。静态检查 80/80，残留测试浏览器 0，见 [快速检查](fast-final.txt)。
- 构建一致性、语法与模块依赖契约通过。依赖图 89 模块、633 边，无新增依赖债务。
- 独立复核通过，见 [review.json](review.json)，当前源码哈希和汇总见 [summary.json](summary.json)。

## 剩余要求

常驻 shell、剩余执行入口和裸 PID 兼容路径仍需审计与接入。helper 能力/可用性门、中途失效及未观察逃逸的生命周期边界继续待验收。Windows 与 macOS 14 尚未实测。

P1-02 文件/系统路径策略、P1-03 shell 语义，以及 P1-01 剩余启动与 Finder 验收继续保留。
