# P1 Mac 文档读取进程监督

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 实现

Mac 的 FileVisualIo.document 使用 ProcessRuntime.capture 执行 Python worker，登记 document-reader owner 并继承调用上下文。stdout 与 stderr 分别保留 16MiB 字节预算，UTF-8 在完整字节捕获后解码。

执行预算 30 秒。取消和超时经受管停止，最多等待 1500ms 清理确认后释放管道与请求。预先取消时跳过启动。正常退出同样确认清理，清理不完整时返回 process_cleanup_incomplete，停止 JSON 成功解析与后续 Python 候选回退。返回清理范围、不完整状态、逃逸覆盖和未确认数量。

ENOENT 仅在清理确认后尝试下一 Python 候选。图像原始读取、文档参数和路径权限继续通过既有 file_read 调用链。

## 验证

- 实现者两轮各 14 项通过，独立复核另跑文档读取 14 项、进程 runtime 62 项通过。
- 专项从真实 toolCall/file_read 入口覆盖分块 Unicode、元数据、登记身份、根退出后后代停止、非法 JSON、非零退出、预取消、执行中取消、双流超限、真实 30 秒超时、ENOENT 回退、helper 缺失、合法 JSON 与不完整清理、继承输出管道有界失败。
- 真实 native-file-read.py 经 file_read 读取中文 DOCX，通过 Python 3.14.7 与 3.12.10 冒烟。3.12 使用显式 framework 二进制和 DYLD 路径，家目录保持隔离。
- 首轮专项的异常注入试图赋值 const，测试失败。已改为假 helper 协议帧验证清理不完整。首轮静态门发现新增测试使 killOwnTree 使用者从 335 增至 336，已按实际文件清册更新计数并重跑。原始失败日志保留。
- 本机 python3.12 shim 使用 HOME 定位 framework，在隔离家目录退出 126。显式二进制验证通过，shim 的干净环境依赖定位继续属于 P1 待办。

完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1107 文件、0 失败，构建与 diff 检查通过。统计见 summary.json，独立复核见 review.json。

## 剩余范围

CLI 定位与版本、Python 依赖探针、媒体及 rg 执行入口继续审计。逃逸覆盖保持 observed-only。Windows 实机、macOS 14、干净依赖布局、同 SHA 跨平台与实际 Finder 验收仍待完成。
