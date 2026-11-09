# P1 Mac 异步 Python 导入探针

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 实现

probeDesktopPythonAsync 的 Mac 分支通过 ProcessRuntime.capture 启动 Python，登记 desktop-python-probe owner 并继承调用身份。保留候选前置参数、工作目录、合并后的环境、原导入脚本及 Full/Core 判据。

stdout/stderr 各 64KiB 字节预算，执行预算 5 秒。超时触发受管停止，最多等待 1500ms 清理确认并释放管道。确认清理后的普通失败返回空结果，允许沿用候选选择规则。

清理不完整与输出管道不完整抛出明确错误，使 pickPythonAsync 停止后续候选与缓存写入。此前找到的 Core 也不能掩盖后续不完整清理。恢复后可重新探测，只有确认的选择才写入缓存。

## 验证范围

实现者最终两轮各 15 项通过，独立复核另跑 Python 15 项与 runtime 62 项通过。专项覆盖 Full 标记分块输出、Core、非零退出、ENOENT、argv/cwd/env、调用身份、根退出后后代停止、stdout/stderr 超限、真实 5 秒超时、Full 优先、helper 缺失、合法 Full 标记与不完整清理、候选和缓存停止、早期 Core 后失败、恢复重探、继承输出管道有界失败。

使用受控 Python 可执行替身验证执行与选择协议。真实 ACC/Python 依赖安装继续按对应工作包验收。同步 probeDesktopPython 仍待接入；本批的保证限于异步路径。

完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1111 文件、0 失败，构建与 diff 检查通过。详见 summary.json 与 review.json。

## 后续

同步 CLI/rg/Python 探针、共享探针和 JS 搜索 worker 取消、实际 FFmpeg、干净依赖布局、Windows、macOS 14、同 SHA 与 Finder 验收继续待办。逃逸覆盖保持 observed-only。
