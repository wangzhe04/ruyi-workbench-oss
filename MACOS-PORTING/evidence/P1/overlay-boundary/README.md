# P1 Mac Windows-overlay 平台边界

2026-11-03，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交，P1 保持进行中。

## 审计发现与处理

剩余直接执行调用审计发现，Windows overlay 的预检、应用与回滚在 Mac 上仍可进入 PowerShell 和解压目录写入路径。P0 决策已明确 Mac 首发使用整包替换，Windows overlay 不复用。

Mac 三项 POST 在既有 HTTP 鉴权之后返回 501 与 overlay.platform_unsupported，执行前拒绝。GET status 继续要求 token，返回 supported:false、平台和空状态，不读取 Windows 更新状态。其他平台沿用既有执行路径，状态增加 supported:true。

更新中心等待状态确认后才启用操作。Mac 下选择包、预检、应用和回滚均禁用，处理器也拒绝程序触发，并显示中英文不可用说明。支持的平台仍需成功预检才启用应用按钮。

## 验证范围

实现者两轮各 15 项通过，独立复核另跑 15 项通过。真实服务 HTTP 验证未授权请求 403、授权请求 501、零 PowerShell 执行、零解压/工具缓存目录创建、状态鉴权与不可用字段，以及服务保持健康。

前端测试执行真实 ES 模块和真实 HTTP 状态，以最小 DOM 验证未知状态禁用、Mac 禁用与说明、程序触发守卫、英文提示和支持平台保留预检门。未进行浏览器截图或真实 Windows 更新操作。

最终完整单测 2509 项，2491 通过、0 失败、18 跳过；80 项静态检查通过。语法检查 1114 文件、0 失败，构建与 diff 检查通过。首轮门禁发现 locale 文档镜像未同步，后续静态发现新增隔离服务夹具计数未登记，均已按实际内容修正并经独立补审；原始日志保留。

## 其它直接执行边界

本轮扫描还识别出 ProcessRuntime 的 helper 启动/能力调用、所有权初始化的固定 /bin/pwd 与 lockf、非 Mac 兼容分支，以及有意交给宿主应用生命周期的分离式打开入口。后续继续核对分离式打开的完成语义和实际 Finder 行为。

P1 仍需补共享探针/JS worker 取消、实际 FFmpeg、剩余路径与生命周期、干净依赖布局、Windows、macOS 14、同 SHA 与 Finder 验收。此批只关闭 Mac 意外进入 Windows overlay 执行的问题。
