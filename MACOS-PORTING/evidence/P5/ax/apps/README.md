# P5-03 真实应用 AX 选定场景

2026-11-10，基线提交 `d1b01adb`，当前主机 macOS 27.0.1 arm64、Node 24.15.0、Python 3.12.10、SDK 15.2，原生目标 macOS 14.0。当前主机的应用切片功能独立验收与最终工程门通过，提交绑定待完成。P5 与 P5-03 保持进行中。

## 选定应用与限制

| 应用 | 实际版本 | 选定场景 | 已观察限制 |
|---|---|---|---|
| TextEdit | 1.21 | 独立新进程、自有 UTF-8 文档，AXTextArea 查询、中文与 emoji 多行 AXValue 赋值、正常 Cmd+S、磁盘逐字读回 | 仅覆盖本次纯文本文档场景 |
| Finder | 27.0 | 共享进程、自有文件夹，完整树查询、工具栏视图 AXPress、独立原生 AXValue 0→1 读回、只关闭已证明归属的窗口 | 夹具需显式开启，启动前无其他内容窗口。当前窗口 AXDocument 为 NoValue，以两项内容 AXURL 证明归属。当前完整树未观察到额外 tab 结构 |
| Google Chrome for Testing | 148.0.7778.96 | 隔离 profile，原生地址栏 AXValue 赋值和页面 URL 保持，默认页面树缺失提示；配置 renderer 后页面树观察及动作拒绝 | 默认未观察到 AXWebArea。官方参数开启后可观察页面，但 ScrollArea→Group 的父子关系不对称，页面 AXValue/AXPress 被现有成员校验拒绝 |

所有调用沿用真实 ACC MCP → 私有原生会话 → AXUIElement。Chromium 仍保留既有中文粘贴、可信原生点击、双向滚轮、同几何窗口歧义拒绝和进程/profile 清理场景。请求的可执行路径、实际启动路径、实际 bundle、运行 argv、浏览器协议版本与结果写入每次 `selected-apps.json`。

Chromium 的 `--force-renderer-accessibility=complete` 只用于夹具新建的专用实例。未对用户浏览器属性做写入。默认与配置模式分别记录。页面 AX 动作继续列为当前 provider/成员校验限制，页面内容可通过已连接浏览器 DOM 工具处理。参数依据 Chromium 官方文档。[Chromium accessibility overview](https://chromium.googlesource.com/chromium/src/+/main/docs/accessibility/overview.md)

## 限制结果字段

仅当实际 bundle 为三项已列 Chromium 身份、scope 为 window、本次遍历完整且全部访问节点均未发现 AXWebArea 时，返回 `accessibility_limited=true` 与 `reason_code=web_area_not_observed`。reason 陈述本次观察结果，hint 给出浏览器 DOM/截图和专用实例参数。该判断不依赖 selector 匹配结果，不额外遍历，不推断 renderer 的开关状态。

深度、节点或结果截断、菜单范围、非 Chromium，以及完整树已有 WebArea 时均不返回该 reason/hint。保留原单节点树的通用 limited 语义。成员关系仍逐边双向核验，`element_stale` 消息改为无法验证成员关系。

## Finder 归属与清理

夹具仅在 `RUYI_P5_FINDER_REQUIRED=1` 时运行。公共 AXWindows 与包含 offscreen 的 WindowServer 全量清单同时建立基线。允许当前系统的桌面 AXScrollArea 和五个隐藏空标题内部窗口，拒绝任何已有 AXWindow、非空标题或 onscreen 内容窗口。Finder 的 PID/出生身份始终核对，共享进程保持运行。

自有文件夹含一个目录和一个文本文件。公开 AXURL 的 file-reference URL 由 NSURL 解析为 filePathURL、消解符号链接，再经 Node fileURLToPath/realpath 与两个预期路径做精确集合比较。唯一新 CG handle、唯一 AXWindow、精确标题/几何、完整树及无 AXTabGroup/多项 AXTabs 同时成立才接受归属。关闭前重新读取全部证明，观察不确定时保留目录和窗口并报告未清理。

原生身份探针只读，要求每节点 role 为非空有界字符串，children/tabs 为数组或明确不支持。容量、深度、属性失败与类型错误拒绝归属证明。视图选中状态使用该 Finder 实际公开的 AXRadioButton AXValue 读取。

## 主执行与历史失败

- 默认 Chromium 模式 31 项、配置 renderer 模式 33 项通过，含 TextEdit。完整树、过滤后零匹配、三类截断与菜单范围的 metadata 判据均有断言。[默认模式](default-metadata/run.txt) [配置模式](renderer-metadata/run.txt)
- Finder 10 项通过，含精确 URL 集合、额外窗口、未知 tab group 和多 tab 的四项受控状态负例。真实视图动作由独立原生值读回确认。[Finder 主链](finder-strict-types/run.txt)
- Finder 归属观测后主动抛错，仅出现一项预期 FAIL，最终窗口清理和 MCP/helper 清理通过。[主动失败](finder-forced-failure/run.txt)
- 早期 Chromium 地址栏先 AXPress 会改变可见命中，后续动作被拒绝。夹具改为对原已确认可见地址栏直接赋值，默认主链通过。原失败保留。[先按地址栏](default-supported/run.txt) [直接赋值](default-direct/run.txt)
- 配置 renderer 的正向页面赋值尝试被 `element_stale` 拒绝。只读原生诊断确认 ScrollArea 的 parent 不在其 parent.children 中，改为明确限制和无副作用负向验收。原失败均保留。[初次配置](renderer-first/run.txt) [实际父子链](renderer-chain-actual/run.txt)
- Finder 首次身份探针对可选属性读取过严，未执行关闭并保留目录。修正后以两项真实内容 URL 重新证明归属，随后仅关闭该测试窗口并删除测试目录。后续常规夹具已验证自动清理。[首次失败](finder-first/run.txt) [恢复身份](finder-first/recovery-identity.json) [恢复清理](finder-first/recovery-cleanup.json)
- Finder 初始几何尚未稳定时拒绝 focus，后等待稳定观测。另一早期验证误用缺省 AXSelected，实际 AXPress 后读回等待超时，随后使用实际公开 AXValue。两次失败均完成自有窗口清理。[几何拒绝](finder-content-uri/run.txt) [原状态读回](finder-stable/run.txt)
- 首轮冻结独立执行的八项正向命令共 208 断言通过。renderer 经裸 executable symlink 启动时，在 CDP 发现前失败，验收随即停止。只读差异启动探针确认 CFT 依据 symlink 所在目录寻找 Frameworks，真实 binary 成功，裸 symlink 的 dlopen 报缺失。AX 夹具现先解析真实 executable 再启动。原冻结及失败报告保留，最终冻结仅该夹具改变，完整独立复验进行中。[首次独立执行](independent/review.json) [真实路径诊断](browser-path-diagnostic/binary.json) [symlink 诊断](browser-path-diagnostic/symlink.json) [最终源码](source-fingerprint-final.json)
- 第二轮独立执行在默认 wrapper 浏览器启动时遇到未响应调试端口，六项正向 158 断言已通过，该次失败实际耗时 421.527 秒。为保存仍在原生夹具内存中的剪贴板快照，验收代理暂停外层 recorder，仅核验并终止自有 CFT 主进程，随后原 JS finally 恢复剪贴板并退出。此项明确计为人工干预失败。CFT 启动挂起根因仍未确定。[第二轮报告](independent-final/review.json) [干预事实](independent-final/selected-apps/browser-stall-cancellation.json)

## 调试目标等待的有界修复

实际挂起揭示公共 `waitForTarget` 原先按 300 次轮询推算 15 秒，每次 HTTP 又可能等待 30 秒，实际没有 15 秒墙钟截止。现使用 monotonic 时间、全局 AbortController 截止及 await 后截止复核，HTTP 设置最多 500ms 空闲超时，trickle 响应仍受全局 15 秒取消约束。Windows 启动器先退出后的实际浏览器发布路径继续保留，退出后宽限按真实时间计。

`request` 仅在参数末尾增加可选 signal，既有调用参数保持兼容，已开始响应体的取消或错误结算为 null。截止后拒绝晚到成功数据，最终存活诊断同时检查 signalCode。应用夹具保留最多 8192 个 UTF-16 字符的 stderr，并在成功或失败时输出实际启动路径、等待耗时和结果。

8 项针对性单元通过，涵盖不发 headers、持续 trickle、headers 后取消、启动器退出后目标发布、延迟 listen、微任务阻塞后晚到目标拒绝、原 HTTP/目标清单诊断和信号退出诊断。真实非响应 CDP 端点负向夹具约 15003ms 后出现唯一预期 FAIL，所有自有进程/profile 和剪贴板清理通过。默认应用 19、AX 默认 31、配置 renderer 33 及既有无头浏览器 11 项主执行通过。独立复核三项意见均处理，61 源冻结后完整独立验收进行中。[单元](bounded-wait/unit-final.txt) [负向清理](bounded-wait/blocked-discovery/run.txt) [等待复核](bounded-wait/code-review.json) [当前冻结](source-fingerprint-bounded.json)

该修复限定等待截止与失败清理，CFT 的一次启动挂起继续作为根因未定的历史失败保留。

## 桌面截图标记的环境遮挡

第三轮独立执行的应用与截止场景通过后，截图回归四种桌面捕获均只有右上绿色标记失败，窗口独立捕获四点均通过。只读诊断取得该桌面点 `[13,174,10]`，窗口独立捕获为 `[3,255,0]`。公开 WindowServer 清单显示 UserNotificationCenter 的 layer 8 浮窗覆盖该点，其余三点未落入该浮窗范围，受控内容截图也显示浮窗底部覆盖绿色区域。[第三轮报告](independent-bounded/review.json) [点值与覆盖关系](marker-diagnostic/markers.json) [自有窗口内容截图](marker-diagnostic/fixture-overlap.png)

系统提示应用的 CUA 访问被工具安全规则拒绝。后续通过仅移动自有测试窗口选择测试区域，保留该系统提示。原生夹具新增 `place-low` 命令，将自身 frame origin 移至 `(160,80)`，300ms 后使用原 Report 获取实际 content 几何。只有截图 e2e 发出该命令，其他夹具调用继续采用原位置。后续全部像素坐标均来自移动后真实报告，原四点颜色、容差与各比例映射继续逐项断言。

低位夹具主执行 32 项通过，随后增补实际 primary display 边界断言。初始与移动后几何、选择位置的原因均落盘。当前 61 源候选重新冻结并进行完整独立验收，产品捕获代码沿用已验实现。[低位主执行](marker-diagnostic/lower-fixture/run.txt) [当前候选](source-fingerprint-selected-apps.json)

## Python 超时夹具的就绪条件

第四轮的全部 Node 正向共 350 条 E2E 断言及 8 项截止单元通过，包括低位截图 33 项。Python AX 8 项通过后，输入合约中一个 timeout 用例缺少 `sent` 文件。该用例在新建解释器后立即用 0.5 秒预算发送首个 mutation，未先证明进程已能消费帧。本次缺 marker 的具体原因无法回溯，失败继续保留。[该轮报告](independent-selected-apps/review.json)

该独立测试现通过同一 worker 的 window.list 正常 ACK 返回 PID，并与实际 child.pid 相等，再在 marker 尚未存在时开始原 0.5 秒 mutation 计时。单行 marker、SESSION 清空、两秒以内回收和后续禁止重放的全部断言保留，增补原 child 已回收断言。新增独立 case 让 worker 在读取前 sleep，验证帧写入 pipe 但尚未消费时仍返回 action_sent/unknown，marker 未建立且没有重放。主执行 18 项通过。[主执行](python-worker-ready/main-final.txt)

当前冻结与前轮只差 `smoke_macos_input.py`，其余 60 个源文件及生产二进制一致。旧 350 条 Node E2E 与 8 项 unit 绑定原 selected-apps manifest，最终五组 Python 和 App 强制退出负向绑定 worker-ready manifest，独立复核记录共同源码与测试依赖关系。最终增量验收进行中。[最终源码](source-fingerprint-worker-ready.json)

上述本轮应用夹具均成功恢复各自测试前剪贴板。更早 P5-02 的剪贴板丢失事故仍独立保留，后续恢复记录不代表找回事故前原内容。[历史事故](../../input/events/clipboard-test-incident.json)

## 保留项

真实权限撤销与动作中锁屏、物理多屏/非 Retina、输入法、Windows 同候选、实际 macOS 14 与正式签名身份仍待验。Chromium 页面 AX 动作限制保持开放，P5-04 OCR、P5-05 录制和组合动作继续推进。

## 当前主机交付验收

功能有效证据共 23 项独立命令，350 条 Node E2E、8 项 focused unit、62 项 Python 通过。三项负向各保留唯一预期 FAIL，正常执行自己的 finally。最终有效证据零意外失败、零自动重跑、零外部进程干预。原先四轮停止记录分别保留，历史失败不计入有效通过总数。[功能整合](independent-completion/review.json)

Node 的 350 条 E2E 与 8 项 unit 绑定 selected-apps 61 文件指纹，五组 Python 与 App 强制退出负向绑定 worker-ready 61 文件指纹，两者仅相差独立 Python 超时夹具。最后 63 文件交付集合增列两份 README，另将静态模块引用清册同步为 359。静态扫描规则及所有运行时源码、helper、App 和构建来源均分别核对，差异与各命令的原始指纹保留。[测试证据复用](source-reuse-review.json) [清册复核](inventory-sync/code-review.json) [交付指纹](source-fingerprint-final-delivery.json)

首轮工程完整单元 2499 通过、18 项既有跳过，静态 78/80 因清册未同步失败，统一 runner 的自带 retry 仍失败。修正清册后最终工程四门通过，语法 1146 文件、构建新鲜度、完整单元 2499 通过/18 项既有跳过、静态 80/80、零 flaky，测试浏览器残留 0。最终 63 文件逐门前后及末检指纹一致。[首轮工程](engineering.json) [最终工程](engineering-final.json)

默认 helper SHA-256 为 `a5d755f54b36c544b40e705faceaf9634ad2038d448a7cd5248e84104270f029`，全部验收与工程过程中保持同一二进制，helper 与如意 App 严格签名校验通过。最终只读状态为已授权、桌面解锁、截图/输入/AX 就绪。529 组独立观察到的自有进程身份末检均退出，共享 Finder 的原出生身份仍存活，测试窗口均已关闭。[运行状态](runtime-status-final.json) [进程清理](independent-completion/process-cleanup.json)

独立只读终审已核对最终工程、当前 63 文件、三层差异及 App 六项构建来源，无待修发现，当前主机应用切片准予提交。P5 与 P5-03 的其余范围继续登记。[交付终审](final-delivery-review.json)
