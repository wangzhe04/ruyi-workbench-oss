# P5-01 屏幕、窗口捕获与坐标

2026-11-08，当前 macOS 27.0.1 arm64 开发环境，Node 24.15.0、Python 3.12.10、SDK 15.2。基线 `4e83cec4`，开发分支 `codex/p5-macos-automation`。本工作包已完成当前主机范围的实现与独立复核，完整验收状态继续登记为进行中。

## 已接入的入口

- 原生 ScreenCaptureKit helper 使用 macOS 14 可用接口，编译目标为 14.0。构建入口为 `node ruyi-workbench/tools/build-macos-automation-helper.js`，运行时读取预构建的开发签名 helper。
- ACC 的 `screenshot`、`screenshot_region`、`window_screenshot`、`get_screen_info`、`list_monitors`、`get_dpi_info` 已接入 Mac 后端。公开发现列表根据当前 helper、授权和桌面状态刷新，直接调用继续执行实际权限检查。
- 工作台 `desktop_screenshot` 复用原写入护栏、检查点路径登记、工具开关和图片附件机制。Provider、MCP、代理发现、状态目录和能力快照使用相同的截图就绪判据。
- 真实 LaunchServices 如意 App 已通过正常 HTTP 工具入口截图。Codex 启动链与如意 App 的屏幕录制授权分别取得实际证据。[App 证据](host.json)

## 坐标与图像契约

桌面坐标使用 Quartz 全局逻辑点，原点为主屏左上角，副屏允许负坐标。图像保留原生 backing 像素，可按请求缩小。`origin` 为逻辑点原点，实际返回尺寸分别定义 `scale` 和 `scale_y`，对应 `x = origin.x + imageX / scale`、`y = origin.y + imageY / scale_y`。`source_pixel_scale` 单独记录原生 Retina 比例。窗口及全屏结果统一转换为 sRGB。

混合比例显示器在全桌面捕获时使用统一画布比例。生产几何规划器具有独立编译的测试入口，覆盖负坐标、非 Retina 比例、区域裁剪和屏间空洞。当前真实硬件为一块内置屏，逻辑 1710×1107，backing 3420×2214。[当前真实布局及颜色映射](capture.json)

## 验证与修正

修正后主代理串行运行截图契约、真实截图、真实 App、两组既有能力回归和工具派发单元，六件均退出 0。真实截图在受控四色窗口中核对区域、主屏、全桌面、窗口及遮挡窗口的像素与坐标，也验证最小化失败、恢复和同名窗口拒绝。正式汇总继续以独立复跑及最终工程门为准。[修正后命令](corrected-runs.json)

独立代码审查提出并已修正以下问题。

- 将 Python stdin 写入纳入非阻塞 I/O 与同一截止时间，补充停滞读取者和大输入测试。
- Mac 原生截图明确使用本次 PNG，保留同路径的既有 `.vision.jpg` 文件。
- 窗口保存使用既有 `atomic_save`，注入保存失败时保留旧文件与清理临时文件。
- 捕获结束时复验显示器身份、布局和比例，窗口捕获同时核验所有者、可见性和几何。
- 对图像尺寸、逻辑坐标、有限数值、协议版本和结果形状进行检查，透传明确错误代码。
- 原生截图接入调用者的 `timeoutMs` 及取消信号，在自有 helper 退出后返回。
- Python 与 Node 对空显示器清单使用一致的未就绪判据，Mac 专项 Python 测试具有平台门。

首轮窗口颜色断言失败源于原始 Display P3 图像在重新编码时的色彩空间差异，统一 sRGB 后同一四色断言通过。纯规划器首发超时通过将协议解析及纯几何路径提前到 AppKit 初始化之前修正，原 3 秒测试截止保留。最小化夹具增加可最小化样式，并等待真实窗口通知后检查。

既有能力夹具曾在断言通过后留下自动发现的 ACC 进程。本次核对其父子和创建身份后停止自有 supervisor，并将运行时专项的无关桌面自动发现显式关闭。旧 MCP 初次就绪断言失败保留，修正后复跑通过，新增初始状态诊断便于复现。原失败日志继续保留。[首轮执行](main-runs.json) [原始契约失败](contract-final.txt) [原始最小化失败](live-final.txt)

## 待验范围

当前主机独立验收及完整单元、静态工程门已通过。双屏、非 Retina 的实际显示硬件，锁屏中输入动作、系统授权撤销、捕获过程中显示器布局变化，以及同候选 Windows 回归仍需取得各自证据。上述场景现有的夹具覆盖单独登记。最低 macOS 14 实际运行与正式 Developer ID、发行身份权限继续交接 O2/P6。

P5-02 输入、剪贴板与窗口动作，P5-03 AX、P5-04 OCR、P5-05 录制与组合验证继续按阶段计划推进。


## 2026-11-10 最终复验

当前候选完整单元 2491 项通过、18 项既有跳过，静态 80 组通过，语法与构建新鲜度通过。最终独立九件均自然退出 0，Node 166 项与 Python 21 项通过，31 项冻结指纹在逐件前后及最终核对中匹配。真实 LaunchServices App 与 Node 服务 PID 已实际消失。[工程门](resumed-2026-11-10/engineering-runs.json) [独立报告](independent-final-fixed/review.json) [最终指纹](source-fingerprint-final-fixed.json)

复核期间取得一次真实锁屏拒绝捕获证据，保留当次失败及 `session_locked` 状态；随后桌面已解锁时，真实截图和 App 链路重新通过。该证据覆盖截图拒绝及恢复。[真实锁屏](independent-final-fixed/locked-capture.json) [恢复后的实际截图](independent-final-fixed/capture.json)

旧能力专项中，Node shebang 假 helper 曾在 1000ms 截止前未执行主体，另一次 shell 假件也有失败。后续同型对照出现成功，底层时变原因尚未确认。假件已使用受控 POSIX shell 和原 150ms 延迟，保留原截止及断言；恢复后主代理连续三次各 25 项通过，最终独立再次 25 项通过。历史失败、分量诊断和反证继续保留。[连续复跑](resumed-2026-11-10/capabilities.json) [启动对照](independent-final/helper-startup-comparison.json) [后续对照](independent-final/helper-identity-comparison.json)

2026-11-10 用户要求设置不锁定，本任务启用 `caffeinate -d -i -u -t 14400` 临时保活，并实际核验显示器、系统空闲与用户活动断言。保活在开发验收期间按需续期，停止时释放本任务断言。

原始 `static.txt` 终端证据末尾有一个空行，作为原始输出保留。源码与撰写文档的空白检查通过，完整原始证据集合单独记录该告警。
