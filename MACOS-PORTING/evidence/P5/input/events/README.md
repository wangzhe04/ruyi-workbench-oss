# P5-02 键鼠、文本输入与应用启动开发记录

2026-11-10，基线 `af7485ce`。本切片已完成当前 macOS 27 arm64 主机范围的独立代码复核、执行验收与工程检查，实现已提交。最终提交候选含 51 项源文件，末尾空行差异单独精确绑定。P5-02 整体仍进行中。

## 实现与主执行验证

| 场景 | 主执行结果 | 证据 |
|---|---:|---|
| 受控真实 ACC 键鼠、粘贴与应用启动 | 42 项通过 | [主链](events-final.txt) |
| TextEdit 与 Chromium 选定场景，含浏览器子孙身份与配置清理 | 19 项通过 | [应用场景](apps/cleanup-fixed.txt) |
| LaunchServices 如意 App 的正常 HTTP 工具入口，直接 Unicode | 13 项通过 | [App 输入](app/final-unicode.txt) |
| 同一 App 入口，真实 Cmd+V 与全格式剪贴板恢复 | 16 项通过 | [App 粘贴](app/final-paste/run.txt) |
| 既有窗口与剪贴板回归，增加写入副作用标记 | 37 项通过 | [窗口回归](window-clipboard-final.txt) |

主链覆盖中文及代理对 Unicode、短文本、Cmd+A、真实 Cmd+V、多行文本、尾随 Enter、图片与自定义格式剪贴板恢复、并发剪贴板修改保留、实际 SIGTERM 粘贴恢复、watchdog 主线程阻塞恢复、逻辑点鼠标移动、左/右/中键、双击、双轴滚轮、拖动、焦点中途变化、SIGTERM 按钮释放、失效焦点与遮挡拒绝、LaunchServices 实际路径、PID/启动身份与窗口就绪。

TextEdit 使用提前登记身份的独立新实例与临时 UTF-8 文档，实际输入中文并经 Cmd+S 核对磁盘内容，再验证窗口关闭与自有进程清理。Chromium 148.0.7778.96 使用隔离配置与本地页面，验证中文多行粘贴、可信 DOM 点击、纵向与正向横向滚动、装饰 AX 标题的活动窗口查询。两个同标题同几何窗口由全新会话观察时，绑定在任何 focus 动作前拒绝歧义。[选定应用观测](apps/selected-apps.json)

如意 App 已经用户开启屏幕录制及辅助功能，实际 App → 自有 Node → 正常 HTTP tool_invoke_exec → ACC → 原生 worker 链验证通过。保留授权前拒绝记录。最初授权后的一次指针末位置失败原因未查明，后续完整通过，阈值保持原值。[授权前观测](app/input-host.json) [授权后观测](app/final-paste/input-host.json)

## 关键行为

鼠标命中用公开 `NSWindow.windowNumberAtPoint:belowWindowWithWindowNumber:` 查询 WindowServer 的实际 mouseDown 接收窗口，再核对精确 AX 命中。包含 AX 隐藏的同进程高层非激活 NSPanel 拒绝路径。缺失或装饰标题的窗口绑定须有唯一同 PID/几何 CG 窗口与同点 WindowServer/AX 关联，枚举未完整或超时即拒绝。键盘事件经 CGEventPostToPid 发往已观察 PID，并持续检查窗口、焦点与几何。

原生会话通过 CFRunLoopPerformBlock 派发串行单帧，保留 12 秒 watchdog，同步 AppKit 等待期间处理 LaunchServices 回调及停止通知。临时剪贴板事务在清空前登记完整快照，同一锁拒绝停止后的新写入，写入期间保留快照，恢复遵守变更计数。watchdog 的恢复线程最多等待 0.5 秒。系统剪贴板调用自身阻塞的场景仍待验证。

最终结果返回前重新检查锁屏与所需 AX/事件权限。已发送动作的失败保留副作用不确定性与恢复状态，显式文本及图片剪贴板写入也带完成改动标记。NaN 指针观测被拒绝。

## 独立复核与失败注入

代码复核闭合临时剪贴板停止恢复、LaunchServices 实际路径与新实例身份、高层 AX 隐藏窗口、停止后临时写入准入、App 退出后残留身份、watchdog 清理顺序、TextEdit 观察前身份登记及最终就绪检查的剪贴板副作用标记问题。[代码复核](code-review.json) [首轮 50 项冻结指纹](source-fingerprint.json) [最终 51 项冻结指纹](source-fingerprint-final.json)

故意失败的用例保留失败结果，单独核验清理断言。它们不计入功能成功项。

- watchdog 临时写入后注入失败，唯一预期失败，writer 退出、最终所有权观察及测试前剪贴板恢复通过。[负向记录](watchdog-negative-final.txt)
- TextEdit 启动后、窗口观察前注入失败，唯一预期失败，提前登记进程身份全部清理通过。[负向记录](apps/negative-final.txt)
- App 强制退出的开发与冻结源独立执行均保留唯一预期失败，并确认记录到的子孙身份清理。[开发记录](app/forced-exit/run.txt) [独立记录](independent/negative-app-exit/run.txt)

## 工程检查与增量复验

首轮冻结源码独立执行 11 个正常命令，209 条 Node 断言与 44 项 Python 检查通过、零跳过。另有 3 个故意失败命令均按预期自然退出 1，各仅一个注入失败，清理与恢复检查通过。50 项指纹逐命令前后匹配，自有进程身份最终归零。如意 App 构建记录中的 6 项源指纹与工作树一致。[独立报告](independent/review.json) [逐命令记录](independent/runs.json) [App 新鲜度](independent/app-build-freshness.json)

首轮完整单元 2491 通过、18 项既有跳过，语法 1143 项与构建新鲜度通过。静态门 79/80，应用场景夹具只复用 CDP 观察器并直接拥有浏览器，触发了公共完整浏览器夹具的关闭规则。现已补充浏览器及后代的 PID/创建身份观察、退出确认、失败保留证据、进程退出后删除隔离配置，并在静态门保留 Mac 等价清理契约。产品源码与首轮冻结一致，最终 51 项清单仅改变该夹具并新增其静态契约文件，增量独立复验首跑的应用场景在首个输入护栏返回 focus_changed，未发送输入。原样复跑 19 项通过，原因仍未确定，原失败保留。TextEdit 故意失败清理及 33 项夹具静态契约通过，51 项指纹逐轮匹配，相关进程归零。最终 51 项源码的完整工程门已通过，语法 1143 项、构建新鲜度、单元 2491 通过/18 项既有跳过、静态 80/80，逐命令前后指纹零漂移。默认原生 helper 已按冻结源码重建，签名验证通过，屏幕录制、辅助功能与事件授权实际状态均为 granted，截图/窗口/输入均就绪。[最终工程与运行时指纹](engineering.json) [运行时状态](runtime-status.json)[原静态失败](static-final.txt) [主执行修正验证](fixture-home-fixed.txt) [增量独立执行](independent/final-incremental/runs.json)

提交前检查覆盖新文件后，清理了测试夹具头文件的 1 个额外末尾 LF 与纯 Python 路由文件的 2 个额外末尾 LF。将对应 LF 追加回当前文件即可精确重建已执行候选的 SHA-256，其余 49 项完全一致。执行证据保留原指纹，提交候选单独记录。[提交源码指纹](source-fingerprint-commit.json) [末尾空行精确绑定](whitespace-only-binding.json)

## 剪贴板测试事故

首轮中断测试查找 worker 失败后，在粘贴请求尚未结束时清理 MCP 子树，夹具未能恢复测试前的剪贴板。原内容只存在于已退出夹具内存，无法从该次运行恢复。用户已被明确告知。

测试改为按创建身份与精确启动参数确认自有子孙，finally 等待待决输入结束、writer 实际退出并观察剪贴板最终版本后，才退出持有原快照的夹具。后续恢复成功不代表该次丢失内容已恢复。[事故记录](clipboard-test-incident.json) [原失败](cancellation-first.txt) [修正恢复](cancellation-descendants.txt) [真实中断通过](cancellation-command.txt)

## 保留项

- Finder 选定场景随 P5-03 AX 元素后端推进。
- 实际撤权、动作中锁屏、物理多屏/非 Retina、实际输入法配置、Windows 同候选、实际 macOS 14 与正式签名发行身份继续待验。
- P5-03 AX、P5-04 OCR、P5-05 录制与组合验证继续按原计划推进。

当前切片实现提交 `508174dc2ba77c930cadb7b5a5d5b784e17a72d9`，提交内51项源码与已独立确认的提交候选逐项一致。[提交绑定](commit-binding.json)
