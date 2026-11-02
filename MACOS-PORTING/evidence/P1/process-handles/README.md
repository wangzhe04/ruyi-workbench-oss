# P1 Mac 清理入口句柄校验

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 实现与边界

Mac 旧式进程清理入口要求 ChildProcess 实例及匹配 PID。数字、字符串与普通 PID 对象返回 process-handle-required，并标记 incomplete。已登记的 ProcessRuntime 进程继续经其句柄登记执行停止。

旧式 ChildProcess 校验限制调用形状，原生 helper 继续通过内核身份和直接父子关系确认目标。JavaScript 中可构造 ChildProcess 并改写 pid，因此这层检查的保证限于拒绝裸 PID 形状。ProcessRuntime 的不透明登记与创建身份仍承担受管启动授权。

调用审计确认现有 Mac 产品路径传入 child。CLI watchdog 的 reg.child || reg.pid 分支中，当前记录始终保存 child；缺少 child 的记录将拒绝清理并返回 incomplete。

## 测试范围

新增五项真实进程断言，覆盖数字、字符串、普通对象、PID 与句柄不匹配，以及原始 ChildProcess 正常清理。既有 malformed helper 报告夹具改用真实子进程，并要求 helper 调用恰好一次，确保计数解析检查仍执行。

实现者 cleanup 两轮各 37 项通过，runtime 62 项通过。独立复核另跑 cleanup 37 项与 runtime 62 项，全部通过。完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1106 文件、0 失败，构建与 diff 检查通过。详情见本目录日志与 summary.json、review.json。

## 后续

继续审计 CLI 定位与版本、Python 依赖、媒体与 rg 执行入口。逃逸覆盖保持 observed-only。Windows、macOS 14、同 SHA 跨平台与实际 Finder 验收仍待完成。
