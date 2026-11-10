# P5-03 AX 核心后端与如意 App 入口

2026-11-10，开发基线 `c1b90ad2`。当前核心切片已通过最终独立执行与工程终审，实现已提交，P5-03 与 P5 整体仍进行中。开发主机为 macOS 27.0.1 arm64，Node 24.15.0、Python 3.12.10、SDK 15.2，原生编译目标为 macOS 14.0。

## 入口与行为

Mac ACC 接入 `ui_inspect`、`ui_find`、`ui_invoke`，通过现有每 MCP 私有的串行原生会话访问 AXUIElement。工具目录按 AX 支持、辅助功能授权及锁屏状态刷新，诊断单列 `desktop.accessibility`。Windows 继续加载原 `uia` 模块，Mac 加载 `macos_ax`。原有输入和截图分族状态继续保留。

观察要求完整窗口 target，作用域为窗口树或该进程菜单栏树，输出原生 AX role、标识、名称、状态、动作及全局逻辑点几何。元素 ref 属于当前原生会话，空闲 60 秒过期，缓存上限 2048。动作重新核对进程启动身份、窗口、当前树、每条 parent/children 双向成员关系、签名、可见性和前台窗口。

- 查询深度为 0–20，节点数为 1–1000，查找结果数为 1–100，元数据字符串每项最多 2048 个 UTF-16 码元。达到节点、深度或结果上限时返回截断原因。
- AX 操作采用 4 秒业务截止，单次属性读取预算 100ms，单次动作最多 750ms。原生会话 watchdog 为 12 秒，Python 会话截止为 15 秒。超时不自动重放动作。
- 默认观察区分几何可见与已确认可见。窗口与 AXScrollArea 的祖先裁剪、hidden 状态约束可见区域。`visible_only` 及动作需要当前 AX hit 证明，窗口作用域同时使用 WindowServer/AX 命中保护。
- 支持 AXPress、focus、set_value、二态 checkbox/switch toggle，以及可设置的 expanded 属性。属性动作须读回匹配。AXPress 报告系统接受，`confirmed=null`、`outcome=unconfirmed`，实际效果由后续观察确认。
- 标准 NSTextView 缺少 AXEnabled/AXIsEditable 时，使用公开 AXValue 可写能力判断赋值支持。已知 enabled=false、editable=false 或不可写仍拒绝。观察不读取文本值。
- 查询失败保持只读语义，已发送动作失败保留副作用与读回信息。helper 替换或会话不确定时回收工作进程，失效 ref 需要重新观察。

## 主执行结果

| 场景 | 已执行结果 | 证据 |
|---|---:|---|
| 真实 ACC → AX → 受控 AppKit 控件，含生命周期受控状态合约 | 36 项通过 | [核心链](lifecycle-fixed/run.txt) |
| LaunchServices 如意 App → 正常 HTTP → ACC → AX | 12 项通过 | [App AX](app-writable-capability/run.txt) |
| 纯 Python AX 工具、目录与失败合约 | 8 项通过 | [AX 合约](python-ax-first.txt) |
| 会话合约，含 AX 读失败与动作不确定分类 | 17 项通过 | [会话合约](python-input-first.txt) |
| Mac 共享工具与真实 APFSX 路径 | 8 项通过 | [共享工具](python-shared-first.txt) |
| 既有输入合约与截图合约 | 15 + 13 项通过 | [输入](python-events-first.txt) [截图](python-capture-first.txt) |

核心链覆盖中文及代理对赋值、NSTextField/NSTextView、只读拒绝、同名控件精确 ref、disabled、focus、checkbox、expand/collapse、菜单回调、移除与替换、保留旧对象但从当前 children 移除、视口外控件过滤与动作拒绝、跨会话引用拒绝、焦点变化拒绝和真实 provider 阻塞。App AX 模式验证 AXValue 改写与恢复，默认 Unicode、Cmd+V 和指针入口继续各自回归。

## 独立复核与历史失败

初审要求补齐当前双向成员关系与滚动视口可见证据。已加入有界双向成员核验、祖先裁剪及当前命中核验，并用保留旧 parent 的对象、NSScrollView 外的屏内控件验证拒绝。新增 NSTextView 缺省 enabled、可写性签名、动作预算与 App 模式亦经独立只读复核。实施者运行与独立执行分别记录。[代码复核](code-review.json)

首次 AXPress 在 100ms 读取预算下返回不确定失败，动作未自动重发，后续采用独立动作预算。窗口切换或布局变更后的早期 AXWindows 枚举也曾超时，随后独立只读 getter 35ms 成功。夹具现等待 AX 几何观测满足条件后检查旧引用，菜单回调等待实际接收状态。原失败保留。[首次调用](main-first/run.txt) [动作预算](action-timeout/run.txt) [枚举诊断](provider-diagnostic.txt) [布局观测](layout-observed/run.txt)

另一次核心链在动作前返回 `focus_changed`，该动作在发送前被拒绝，原因仍未确定。同源后续完整主链通过，原失败保留。[原焦点拒绝](textview-expanded/run.txt) [后续完整通过](focus-observation/run.txt)

App 初次组合探针中，AXTextArea 缺省 enabled 被错误当作不可操作，已改用公开可写能力，并验证只读 NSTextView 拒绝。该次指针末位置与文本结果也未匹配，原因未查明，原结果保留。App AX 独立模式随后通过，默认事件模式仍需冻结回归。[最初 App 结果](app-first/run.txt) [缺省状态观测](app-text-state/input-host.json)

## 冻结与保留范围

首轮 56 项源码独立执行 261 条 Node 与 61 项 Python 通过，原工程四门也通过。提交前补查发现，AX 早期或中途返回锁屏/拒绝后，缓存清理曾依赖定时器。现已将明确的拒绝、锁屏及 APIDisabled 出口同步清空窗口与元素引用，并保留原权限错误码。新增受控状态合约验证双类引用即时失效、恢复后重新观察、2048 容量及内存 TTL，生产 helper 排除测试入口。实际 TCC 与锁屏仍各自待验。[原冻结源码](source-fingerprint.json) [原独立执行](independent/review.json) [原工程](engineering.json)

最终 56 项源码、配置及构建文件已重新冻结，与原候选仅有 5 项已复核变更。最终独立执行逐命令记录前后指纹、自然退出、实际二进制与自有进程清理，包含真实等待 62 秒的 AX 引用过期，以及既有输入、窗口、截图和共享 ACC 回归。[最终源码指纹](source-fingerprint-final.json)

- 核心切片冻结时保留的 TextEdit、Finder、Chromium 实际 AX 选定场景已由后续应用切片补齐当前主机证据，应用版本与限制分别记录。[应用切片](apps/README.md)
- 真实撤权、动作中锁屏、物理多屏/非 Retina、输入法配置、Windows 同候选、实际 macOS 14 与正式签名身份继续待验。
- P5-04 OCR、P5-05 录制和组合动作继续按原计划推进。

## 最终独立验收与工程结果

最终候选的 10 项 Node 命令共 263 条断言、5 项 Python 命令共 61 项测试全部自然退出 0，零失败、零跳过。AX 主链 38 项包含真实 62 秒等待的过期验证、受控拒绝/锁屏生命周期与生产测试入口隔离。如意 App AX、Unicode、Cmd+V、既有键鼠、窗口、选定应用输入、截图与共享工具均通过。额外 AX App 强制退出命令保留唯一预期失败，清理检查通过，单独计为负向证据。[最终独立报告](independent-final/review.json) [逐命令指纹](independent-final/runs.json)

56 项源码逐命令前后及最终匹配，366 组观察到的 PID/出生身份末检均退出。App 六项构建源指纹匹配，helper 与 App 的严格签名验证通过。[进程清理](independent-final/process-cleanup.json)

最终工程门通过。语法检查 1144 文件、构建新鲜度、单元 2491 通过/18 项既有跳过，以及静态 80/80、零 flaky、测试浏览器残留 0。56 项源码指纹全程一致。默认 helper 的最终 SHA-256 为 `04fe4308080fd8b3acd59118301be48c0ace3e51faf1f56349d0821c60a638bf`，最终独立执行与工程期间保持同一二进制，实际 AX 与相关授权均就绪。首轮候选的不同重建指纹分别保留在原记录中。[最终工程](engineering-final.json) [独立工程终审](independent-final/engineering-review.json) [运行状态](runtime-status-final.json)

核心切片实现提交 `66edbf8bcf51d4c7c1a0433dce7ecc2f4eda77ee`，提交内56项源码逐项匹配最终独立验收候选。[提交绑定](commit-binding.json)

## 真实应用后续切片

2026-11-10 TextEdit、Finder 和 Chromium 选定 AX 场景完成当前主机功能独立验收，有效 350 条 E2E、8 项 focused unit、62 项 Python 及三项负向清理通过。Chromium 默认页面树缺失与配置后页面动作的成员关系限制分别列证。最终工程门与独立终审通过，提交绑定待完成。[应用场景](apps/README.md)
