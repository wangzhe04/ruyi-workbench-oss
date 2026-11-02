# P1 Mac 媒体与语法检查执行监督

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 实现

MediaInspection 的 Mac 子进程统一通过 ProcessRuntime.spawn 登记 media-inspection owner，继承工具、会话和调用身份。依赖版本探针、imageio-ffmpeg 定位、Python/Node 语法检查和 FFmpeg 音频测量使用这一入口。

stdout 和 stderr 继续保留有界尾部，分别为 262144 与 32768 个字符，StringDecoder 处理跨块 UTF-8。FFmpeg 测量继续按流送入 collector。执行预算依次为版本探针 5 秒、语法检查 10 秒、音频检测 60 秒。ctx.signal 从工具分派传到探针、音频、语法及写前校验。

取消和超时触发受管停止，并最多等待 1500ms 清理确认。根进程退出后输出管道仍未关闭时，500ms 后返回 process_output_incomplete 并释放流。成功必须同时满足退出码、输出收尾与清理确认。输出尾部预算保持原有截断语义，长流仍可持续处理测量数据。

locate 每次先确认 helper 能力，缓存的可执行文件状态也受撤销约束。Python → FFmpeg → ffprobe 的嵌套探针传播取消、清理不完整和输出管道不完整状态，停止候选回退；批量 media_probe 遇到这些错误后停止后续执行。清理范围、未确认数量和 observed-only 边界返回调用方。

## 验证

实现者两轮各 19 项通过。专项覆盖真实 toolCall 入口的音频流式测量、Unicode 版本、调用身份、根退出后写入后代停止、预取消、执行中取消、真实 60 秒音频超时、非零退出、Python stdin、写前取消与真实 10 秒语法超时保留原文件、真实 Node parse-only、helper 缺失撤销缓存、合法输出不能掩盖清理失败、嵌套错误传播、批量停止、继承输出管道有界失败。

独立复核媒体专项 19 项、进程 runtime 62 项通过。完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1108 文件、0 失败，构建与 diff 检查通过。具体日志与统计保存在本目录。

首轮专项的 owner 期望误用了外层 withOwner 值，真实 toolCall 按 ctx 登记身份。断言已改为核对真实调用会话；原始失败日志保留。独立复核发现的嵌套失败传播及输出管道错误回退问题已修复并加入回归。

## 限制与后续

FFmpeg 和 Python 音频/语法故障场景采用受控可执行替身，Node 语法检查使用真实 Node。真实 FFmpeg 安装与实际媒体分析仍需验收。Windows、macOS 14、干净依赖布局、同 SHA 与 Finder 实机验收继续待办。01-config 的 CLI/Python 探针和 rg 执行入口尚需接入审计。
