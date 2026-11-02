# P1 Kimi 模型发现探针

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 实现

Mac 的 Kimi 模型发现先检查 helper 能力，再经 ProcessRuntime 启动 `provider list --json`。owner 记录 cli-model-discovery、kimi 类型及调用方上下文。

stdout 上限为 1MiB，stderr 上限为 64KiB，按字节计量并使用 StringDecoder 处理跨块 UTF-8。执行时间预算为 10 秒。超时和输出超限触发受管清理，并最多等待 1500ms 确认结果。返回对象包含清理范围和不完整标志。

正常退出后的模型 JSON 只有在清理确认后才作为成功发现返回。不完整清理、非法 JSON、启动错误、输出超限和超时均返回失败与回退模型列表。

收尾始终释放探针的 stdout/stderr。清理函数抛错也会结束请求并标记 incomplete；继承输出管道的未观察后代不会令请求无限等待。

## 验证

- 新 Mac CLI Models E2E 最终两轮各 13 项通过。首条经真实 Kimi adapter 的 modelCatalog.discover 入口，核对 agentCliType、proxyCount、Unicode 别名、上下文长度、目录语义、owner 和后代停止。
- 覆盖非法 JSON、非零退出、stdout/stderr 超限、真实 10 秒超时、helper 缺失、合法 JSON 与不完整清理、清理函数异常，以及完成控制帧后仍被后代占用的输出管道。
- 独立 reviewer 运行模型探针 13 项和进程 runtime 62 项，全部通过，并补审真实 adapter 入口断言。
- 完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1106 文件、0 失败，构建与 diff 检查通过。
- 测试使用隔离家目录、显式假 CLI 和有界生命周期后代。CLI 路径定位器在夹具中替换，避免调用环境中的真实 CLI；模型探针和清理使用真实子进程。
- 独立复核发现清理异常可能使请求悬挂，以及继承输出管道未销毁的问题，均已修复并覆盖。详情见 `review.json` 与 `summary.json`。

## 剩余审计

CLI 定位／版本和 Python 依赖探针、媒体与 rg 执行入口、裸 PID 兼容路径仍需继续审计。其它平台能力 ID、文件路径和生命周期组合、干净安装、Windows／macOS 14 同 SHA 与实际 Finder 验收继续待办。逃逸覆盖保持 observed-only。
