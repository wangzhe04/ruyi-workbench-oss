# P1 主 Provider 回合 Stop 贯通

2026-11-03，macOS 27.0.1 arm64，Node 24.15.0，HEAD 0a430880 的未提交工作区。

## 最终复核发现

主回合 awaitProviderTool 为 shell 集合以外的工具执行 runner(null)。底层文件、搜索、文档和媒体工具即使支持 ctx.signal，也收不到普通主回合的 Stop。此前专项直接传入 signal，覆盖范围不足以证明主回合行为。

当前改为传递回合 turnSignal。保留原 Stop race 与迟到结果丢弃行为，用户插话及时间预算中断仍由原有 INTERRUPTIBLE_NATIVE_TOOLS 集合控制。停止文案说明已请求取消且未完成操作可能继续收尾。

## 验证

provider-tool-stop 使用本地假 Provider、真实 runOpenAiTurn、stopSession 和原工具 handler。观察 ctx.signal，同时验证真实 path worker 退出、排队写未改变文件/检查点，以及已提交写入和原字节快照保持一致。9 条断言通过。

反向实验只将新产物中的 runner(turnSignal) 恢复为 runner(null)，同一件在 worker 信号与排队写两条断言失败，退出码 1。日志见 before-signal-fix.txt，临时反向产物已删除。

同轮修正 atomic-write-cancellation 的 Windows 夹具可运行性。当创建符号链接明确返回 Windows EPERM 时，仅该子场景显式 skip，其余错误继续失败，硬链接及后续公开入口用例持续执行。当前 Mac 的真实符号链接断言仍执行。

## 边界

Stop 返回时，无法立即中断的底层操作可能继续收尾，迟到结果继续被丢弃。已经进入文件提交段的操作按既定一致性语义完成。真实 Windows 回归仍待执行。
