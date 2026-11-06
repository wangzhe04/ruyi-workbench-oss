# P1 Mac 宿主打开完成语义

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 实现

Mac /usr/bin/open 交接等待退出码零才返回成功，非零退出、信号和启动错误返回失败。5 秒超时停止持有真实 ChildProcess 的 launcher。目标应用由 LaunchServices 管理其生命周期。

buildOpenSpawn 和默认浏览器构造器已接入 Mac 平台层，固定目录 reveal 也统一调用此完成语义。其他平台保留原 spawn-event 成功行为。Windows 纯 argv 测试显式指定 win32，保留原有参数与防注入断言。

office_open 在 Mac 先 realpath 再按类型处理，脚本和应用包别名只定位。browser_open 将本地 file URL 转路径并 realpath 后再校验，拒绝伪装为 HTML 的脚本别名；应用目录仅定位。通过验证的 HTML URL 恢复 query/hash 后交接。Mac 默认浏览器由系统关联选择，preservedWorkbench 返回 null 表达标签页保留状态未知。

## 验证

实现者最终两轮各 18 项通过。专项覆盖实际工具入口、等待成功交接、字面 argv、脚本/bundle/HTML 别名、file URL 与 query/hash、非零退出/信号/ENOENT、真实 5 秒超时、非 Mac 分支兼容，以及真实 /usr/bin/open 对不存在文件的失败。

独立复核 Opener 18 项、启动回归 26 项、HTTP hardening 单测 16 项通过，相关 file-guard 端到端通过。完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1115 文件、0 失败，构建与 diff 检查通过。最终统计见 summary.json。

## Finder 实机状态与夹具修正

非交互预检 AEDeterminePermissionToAutomateTarget 返回 -1744，Finder 自动化尚需用户同意。已异步询问是否弹出系统授权请求，未获回复前未请求系统弹窗。

首轮旧启动夹具只拦截直接 open，而固定目录路径通过 native supervisor 启动，漏拦了临时目录定位。旧 HTTP 失败夹具依赖非 Windows 下 Explorer 不存在，移植后也触发过临时目录打开。已向用户披露。固定目录调用已统一，HTTP 失败夹具在 Mac 显式注入不存在的 opener，保留全部原错误与服务健康断言；最终复测均拦截成功。

这些系统请求不计为 Finder 可见验收，尚未核对真实窗口、选择状态或自动关闭测试窗口。预检日志位于 ../finder/automation-preflight.txt。

## 后续

Finder 可见验收继续等待 macOS 自动化授权。共享探针/JS worker 取消、实际 FFmpeg、剩余路径与生命周期、干净依赖布局、Windows、macOS 14 和同 SHA 验收继续待办。
