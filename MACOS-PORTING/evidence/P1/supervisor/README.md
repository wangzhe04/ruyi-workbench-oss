# P1-04 启动身份与监督进程

2026-11-02，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作区尚未提交。P1-04 保持进行中。

## 本轮实现

`01h-process-runtime.js` 提供不透明 handle、冻结 owner 与启动身份、重复停止和 completion 接口。模块通过 hooks 接入平台路径与现有非监督停止器，未扩大依赖环上限。一次性 `DesktopShell.runProcess` 已接入，现有 Windows spawn 参数与停止实现继续由对应分支处理。

原生 helper 的 `--supervise` 在独立 session 中保留进程组锚点。子进程等待私有 admission pipe，supervisor 核验创建身份后才放行 exec。目标程序执行前关闭控制 fd，stdout/stderr 与控制协议分离。主命令自然退出、取消、服务正常退出或 SIGKILL 导致控制通道 EOF，均触发自有进程组及已观察后代清理。

冻结后等待身份进入 SSTOP 或退出，再采集下一轮快照。冻结、收集与退出确认均有时间预算，异常保守记录不完整。退出结果保留目标退出码或信号，并报告已终止、已退出、未确认数量。完成协议要求有效的阶段顺序、完整帧和一致的有界计数。异常帧与不支持的 stdio 布局有独立回归。

## 验证

- 新 runtime e2e 两轮各 20 项通过，见 [第一轮](e2e-1.txt)和[第二轮](e2e-2.txt)。覆盖主命令先退、孤儿心跳停止、取消、重复停止、伪造 handle、退出码、信号、stdout 帧伪造、ENOENT、畸形控制帧、owner 退出与 SIGKILL、已观察 detached 后代。
- 原清理 e2e 33 项通过，见 [回归日志](cleanup-regression.txt)。缺 helper 夹具同时模拟新启动依赖检查，原直接子进程兜底与诚实文案断言保留。
- 专项 exec-result 与 script-run 单测 20/20 通过。
- 最终全量单测 2507 项，2489 通过、0 失败、18 跳过，见 [单测日志](unit-final.txt)。静态检查 80/80，残留测试浏览器 0，见 [快速检查](fast-final.txt)。独立复核本轮 20/20、33/33 通过，范围与发现见 [review.json](review.json)，汇总见 [summary.json](summary.json)。`fast.txt` 保留最初清册与依赖环检查失败，随后按现有 hooks 架构消除新增环并同步清册。

## 剩余范围

当前生产接入为一次性执行，CLI、MCP、常驻 shell、toolbox 仍需统一 start/stop，并传递具体会话、运行和工具 owner。测试清理器的监督模式、helper 能力/可用性门与中途失效组合验收尚待完成。

`owned-group-and-observed` 仅表示自有进程组与已观察身份。`cleanupEscapeCoverage=observed-only` 明确快速脱离会话且未被观察到的后代覆盖限制，`cleanupUnconfirmed` 统计已观察身份。缺 helper 或 shell 选项暂走现有直接启动分支并保守报告不完整。完整逃逸治理仍属 P1-04 待办。

Windows 实机、macOS 14 和同 SHA 跨平台证据尚未取得。完整 P1 另包含文件/系统路径策略、一次性与常驻 shell、启动和实际 Finder 验收。
