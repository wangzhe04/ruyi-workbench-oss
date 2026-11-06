# P1 Mac 产品同步探针接入

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 实现

ProcessRuntime.probeSync 使用 native deadline v2 入口，经 spawnSync FD3 私有管道接收清理报告。异步和同步执行共用 acceptControlMessage 状态机。同步模式允许一个 deadline 帧，异步模式拒绝未启用的 deadline。

校验覆盖帧顺序、计数一致性、最终 guardian 确认、末换行、退出码/信号配对，以及 helper 实际退出与目标报告一致性。协议不完整、底层 spawnSync 错误、外层安全超时均保持清理不确定，禁止以成功或普通候选失败继续执行。

原生预算负责正常超时清理，Node 另有预算加 4000ms 的 SIGKILL 安全上限。stdout/stderr 独立检查字节预算，控制报告限 4096 字节。保留忽略输出、UTF-8/Buffer 捕获、cwd/env、非零退出、ENOENT 和自然信号语义。此适配器面向当前探针的 ignore/双流捕获布局；输入、任意 stdio 与 shell 执行不属于接口范围。

spawnProbeSync 在 Mac 接入该适配器。同步 Claude/Kimi 候选、existsExecutable、Git 能力、rg 冷缓存和 Python 导入探针均使用这一入口。清理不确定跨候选 catch 传播，停止后续候选和缓存写入。helper 暂时缺失或不支持 deadline 时，rg 返回未知结果并保留空缓存状态，恢复后可在同一进程重新探测。

## 验证与修正

实现者最终两轮各 27 项通过。专项覆盖实际调用入口、后代停止、UTF-8/退出状态、自然信号、ENOENT、真实原生超时、小输出超限、忽略输出、Python Full/Core、缺 helper、旧 v2 兼容、协议缺帧/重复/矛盾、同步与异步共用严格校验、CLI/rg/Python 候选停止及缓存保护、输出管道残留安全上限、helper 恢复。

独立复核最终 Sync 27 项、Runtime 62 项、异步 Executable 14 项及结果形状单测 14 项通过。

首轮完整门禁在实现者中途重建产物时触发两项 freshness 失败，随后冻结源码重跑。另发现旧 S4 测试受原生观察采样时序影响，后代可能已被及时清理而无需输出管道提示。Mac 夹具改为完整协议加真实、有界的管道占用者，原时限、ok、退出码、stdout、note 断言全部保留，并新增占用者实际启动、返回时仍存活、收尾等待退出的检查。其他平台继续用原夹具。原始失败证据保留。

最终完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1113 文件、0 失败，构建与 diff 检查通过。统计见 summary.json，复核范围见 review.json。

## 后续

继续扫描其余平台执行入口及生命周期组合，补共享探针和 JS 搜索 worker 取消、实际 FFmpeg、干净依赖布局、Windows、macOS 14、同 SHA 与实际 Finder 验收。逃逸覆盖保持 observed-only。
