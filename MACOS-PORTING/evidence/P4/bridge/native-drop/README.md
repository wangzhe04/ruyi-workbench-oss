# V10真实原生拖放验收

2026-11-08，当前macOS27.0.1 arm64冻结开发App。CUA跨窗口拖动未送达事件后，由用户辅助Finder拖放，主代理核对最终确认框并执行“切换”。只读观察器未派发或替换拖放，原始导出包含6个isTrusted为true的Files事件，文件和目录各3个。[完整轨迹](trace.json) [导出来源](trace-provenance.json)

三个文件上传均返回200，31字节与源文件逐字节SHA匹配，实际页面显示附件。目录经webkitGetAsEntry/readEntries取得“P4 选择验收文件.txt”，三次指纹解析均唯一score1；两次selectedPath解析均返回目标路径。用户报告其中一次取消，事件/提交数量与源码只关闭确认框的处理一致。取消前当前会话cwd快照未采集，原快照仅涵盖seed会话和config，作为范围局限保留。[附件和目标目录](after-confirm-page.png) [完整文字](export-text-ax.txt) [判定](validation.json)

用户交互期间已存在当前会话sess_7376a723d5813c9d，最终确认后该会话cwd、近期目录与目标一致。确认框默认工作区复选框为未勾选，config默认路径仍为初始工作区。seed会话的快照单独标注。[确认框](confirmation.png) [确认后持久化](after-confirm.json) [原快照范围](after-cancel-before-confirm.json)

正常quit文件触发退出，探针自然退出0，App8477、Node8480、探针8474均已消失。测试Finder窗口和TextEdit已关闭，用户Code恢复空窗口。临时保活按用户无人值守要求保留至当前Codex退出。[清理](cleanup.json) [独立复核](review.json)
