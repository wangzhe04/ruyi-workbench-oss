# P1 CLI/MCP 发现与能力弹层

2026-11-02，macOS 27.0.1 arm64、Node 24.15.0、Chrome 156.0.8078.79。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 本批实现

- 原生 provider、MCP `tools/list`、按需 MCP 工具目录共用 `runtimeToolRequirementsMet`。Mac 缺少就绪监督器时隐藏新的受管执行与 git 入口，保留已有 shell 的查询和停止工具。再次请求列表可立即看到移除或恢复结果。
- 旧目录发起的 adaptive proxy 调用返回明确的 runtime 不可用代码，控制面、tier 和既有授权检查继续执行各自职责，实际启动仍由底层 gate 再检查。
- 能力弹层显示监督器、一次性 shell 和常驻 shell。异步响应更新已打开的弹层，请求进行中显示检查中，失败显示未知。序号防止较旧响应覆盖较新结果。
- 内容更新保留原 dialog 容器并重新定位。关闭弹层清除轮询；共享 popover 原语增加可选调用的 reposition 方法。
- 两语言文案与 docs 镜像同步。

## 浏览器夹具修复

本机 Chrome 的独立测试 profile 最初停在 about:blank，Page.navigate 同样超时。启用 Mac 测试专用 `--use-mock-keychain` 与 `--password-store=basic` 后，原首屏 READY 断言正常通过。公共夹具仅在 Mac 的独立测试 profile 使用这两个参数。显式导航尝试和诊断参数已移除。

另外修复了启动过程中抛错时，调用方尚未收到 fx 而无法清理进程的问题。夹具自身在失败路径调用既有 close，收回已创建的浏览器、服务和假 provider。首次泄漏的本批进程在复核其父子关系与创建身份后收回；后续失败已验证自动清理。失败日志保留，最终 owned profile 进程检查为 0，见 `cleanup-check.txt`。

## 验证

- 真实 MCP 子进程两轮各 7 项通过，覆盖 helper 移除／恢复、完整列表、adaptive 搜索、旧 proxy 调用拒绝及 fixture 清理确认。
- 真实 Chrome 弹层最终两轮各 14 项通过，覆盖 API 就绪状态、刷新中、不可用、失败未知、乱序响应、视口定位、底层控件遮挡、关闭与零未捕获异常。
- 独立 reviewer 另验证能力状态 16 项、原主题浏览器回归 11 项。共 48 项独立断言通过。
- 完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1104 文件、0 失败，构建一致性与 diff 检查通过。
- 已等待入场动画完成并人工检查 ready／unavailable 截图，见 `ready.png`、`unavailable.png`。不可用 UI 响应为受控夹具，MCP 另使用真实 helper 文件移除验证服务端行为。
- 独立复核与源码哈希见 `review.json`、`summary.json`。

## 剩余验收

MCP 列表变化按客户端重新请求返回，当前未新增服务端 list_changed 推送。其它 CLI／桌面平台能力 ID、剩余执行／裸 PID 路径与文件边界审计、生命周期组合、干净安装、Windows／macOS 14 同 SHA 和实际 Finder 验收继续待办。进程逃逸保持 observed-only，单 helper 故障恢复范围沿用此前记录。
