# P1 隔离工作树 Git 执行与失败恢复

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 执行入口

Mac 的 `gitExec` 通过 `AgentWorktreeHooks` 接入既有受管 `runGit`，保留 16MiB 输出预算、字符串 trim 和 gitStderr 错误字段，并设置 agent-worktree owner。Hooks 在 Git 模块完成初始化后绑定，模块依赖检查通过。

工作树创建、快照、应用和清理由此获得同一监督器、超时及清理结果。清理未确认或输出管道未关闭时，错误带 cleanupIncomplete，调用方据此停止后续文件删除、prune、abort 或自动重试。

## 状态与重试

- 创建工作树时出现未确认清理，错误携带已分配的隔离路径。调度器保存路径和 process_cleanup_incomplete 分类。
- 子任务、finalize、普通失败重试或 degraded 重试遇到清理不确定时，节点进入 failed，保留隔离目录，阻止自动重排和静默恢复。子任务清理未确认时不再生成快照。
- 应用隔离提交按仓库目录身份在本服务内串行，取得锁后重读持久记录。目录身份不可取得时使用保守的共享锁键。互斥范围为当前服务进程。
- Git 变更前先保存 applying 意图，并重读确认。意图保存失败时不运行 cherry-pick。cherry-pick 普通失败只有在 abort 已成功且清理确认后才恢复原状态。
- cherry-pick 成功后先保存 applied，再清理工作树。清理失败返回 applied 与 cleanupIncomplete，保存待清理路径。重载或并发请求识别已应用状态，避免重复提交。
- 应用结果保存失败时保留 applicationUnconfirmed。持久 applying 记录阻止自动再次应用或恢复工作流，需要先核对仓库状态。

## 验证

- Mac Git Runtime 40 项通过，覆盖真实 Git、hook 后代停止、owner、工作树失败保留、并发应用、应用成功后的清理失败、两处持久化失败和重载防重放。
- 新工作流重试 E2E 18 项通过，通过真实 runAgentWorkflow 入口和受控执行故障覆盖 degraded、failed、finalize、create、子任务 cleanup 五种情形，以及 applying 恢复门。
- 既有 Agent Worktree 9 项、快照提交单测 2 项通过。
- 独立复核发现并修复应用状态在清理前未落盘、自动重试吞掉清理错误、上游清理未确认仍 finalize、持久化失败重放及并发旧快照等问题。补充记录见 `review.json`。
- 最终单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过；语法检查 1105 文件、0 失败。源码哈希与汇总见 `summary.json`。首次依赖图门失败日志保留，最终采用 Hooks 消除了新增前向循环边，依赖债务上限未增加。

## 剩余入口审计

本批完成隔离工作树入口，剩余原始调用按函数继续追踪。

| 入口 | 当前分类与下一步 |
|---|---|
| discoverKimiModels | 已接入监督、预算和失败收尾，见 [后续记录](../cli-model-probe/README.md) |
| spawnProbeAsync 与 CLI/Python 同步探针 | 区分启动期依赖定位和已启动服务中的探测，核对超时后代及 helper 引导依赖 |
| FileVisualIo / MediaInspection | Python、ffprobe/ffmpeg 辅助进程需核对统一执行与取消 |
| rg 搜索两条入口 | 核对输入、输出预算、取消和后代清理 |
| spawnDetachedChecked | 宿主打开的独立生命周期，需结合 Finder 实际验收确认 |
| killChildTree 的裸 PID 兼容路径 | 继续审查身份授权，区别 Windows 兼容和 Mac 不透明句柄要求 |

完整 P1 还需文件路径与生命周期剩余覆盖、干净安装、Windows／macOS 14 同 SHA 和实际 Finder 验收。进程逃逸仍为 observed-only。
