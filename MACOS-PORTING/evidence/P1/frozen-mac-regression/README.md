# P1 冻结源码 Mac 回归

2026-11-03，macOS 27.0.1 arm64，Node 24.15.0。当前产品源码指纹见 source-hashes.json，测试结束后逐项复核一致。

## 最终结果

- 29 件相关 e2e，818 条断言通过。逐件件名、断言数和日志见 selected-results.json。
- 完整单元测试 2509 项，2491 通过、18 跳过、0 失败。
- 静态 e2e 80 组通过，语法检查 1120 文件通过。
- build.js --check 和 git diff --check 通过。
- 最新独立代码复核见 ../final-review.json，主回合 Stop 复核见 ../provider-stop/review.json。

29 件覆盖启动所有权与重定位布局、宿主打开完成语义、进程树/同步和异步监督、shell、Git/worktree、CLI 模型发现、文档/媒体/rg/Python 探针、能力发现及 overlay 边界、文件策略/检查点/原子写和变更恢复、内容/路径搜索，以及真实 Provider 回合 Stop。Windows 原语参数夹具在各件中保留。

## 失败历史与限制

初轮 27 件相关专项通过，静态门禁因新增启动夹具的路由覆盖清册未重生成而失败。已重生成。该轮日志和旧源码指纹保留在 initial/。最终复核随后发现主 Provider Stop 未传至非 shell 工具，已修复并增补正常入口测试，最终重新执行相关集合。

修复后的复跑中，媒体专项的语法超时断言曾单次失败，原日志没有结果字段。增加失败诊断后，两次完整媒体专项和八次独立语法超时实验均通过，目标原字节保留、后代写入停止、清理完成。原失败日志与调查结果完整保留在 macos-media-runtime-failed.txt、media-diagnostic-1.txt、media-timeout-probe.txt 和 media-timeout-investigation.json。根因尚未确认，断言未放宽，生产媒体代码未为此修改。

本集合是 P1 相关专项，仓库现有 557 件默认 e2e 尚未全部在 Mac 执行。Windows 实机、Finder 可见窗口/选中对象仍待验收，macOS 14 按 P3/P6 关口追踪。P1 继续进行中。

候选提交整理时，部分历史控制台日志仅移除了行尾空白和多余空尾行，以通过提交差异检查；测试判定、错误信息与源码指纹保持。
