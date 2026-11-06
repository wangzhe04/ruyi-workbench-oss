# P1 Mac 异步可执行文件探针

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 实现

spawnProbeAsync 的 Mac 分支通过 ProcessRuntime.probe 启动，登记 executable-probe owner 并继承调用身份。入口覆盖异步 Claude/Kimi 启动器发现、existsExecutableAsync 和 Git 版本能力探测。stdio 继续忽略，版本输出大小不改变可用判据。

探针保留 error/status 契约。正常退出使用目标退出码，信号退出保留 null status，确认清理后的超时保留原有 slow 判据。ProcessRuntime completion 增加目标退出码和信号字段，使 helper 的退出码不会替代目标信号语义。

超时经受管停止，最多等待 1500ms 确认清理。清理不完整返回明确 error，禁止解释为 ok 或 slow，并从 CLI 候选扫描传播出去，停止本轮后续探测。timeout 为零时禁用预算，spawnOptions.timeout 可覆盖默认预算，非法预算在启动前拒绝。

## 验证

实现者最终两轮各 14 项通过，独立复核另跑探针 14 项和运行时 62 项。断言包括正常 CLI verdict、写入后代停止、调用身份、非零退出、ENOENT、目标信号、短预算超时、忽略大输出、cwd/env、零超时覆盖、非法预算、helper 缺失、清理不完整及两类 CLI 候选停止。

初轮实现误判 manifest 加载顺序导致初始化 TDZ，已改为先加载的 ProcessRuntime 方法；第二轮 cwd 断言混用了 /var 与真实 /private 路径，已按实际 cwd 的 realpath 核对。原始失败日志保留。完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1110 文件、0 失败，构建与 diff 检查通过。最终门禁统计见 summary.json。

## 剩余范围

同步版本探针与 Python 导入探针继续审计。共享探针取消、JS 搜索 worker 取消、实际 FFmpeg、干净依赖布局、Windows、macOS 14、同 SHA 与 Finder 验收仍待完成。逃逸覆盖保持 observed-only。
