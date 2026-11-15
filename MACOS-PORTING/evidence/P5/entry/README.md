# P5 正常会话审批与图片检查点

实现 `5e24634307e2b5a3301409e5c8a1f2efa670cbe0` 已提交并通过当前主机独立验收；P5 保持 `in_progress`。源码由 [freeze-v4.json](freeze-v4.json) 绑定，[实施者提交绑定](commit-binding.json)与[独立提交绑定](independent-commit-binding.json)核对原始 Git blob。此切片沿用已验的手动录制原生 helper 和 Python 后端，仅修复工作台代理分发时的检查点会话上下文，并新增回归。

普通 provider 回合通过 `tool_invoke_exec` 调用实际 ACC 的 `macro_run`，内部先聚焦自有窗口，再用 `input_sequence` 做平衡点击。默认审批下分别允许、拒绝和取消：允许后接收窗口收到一次 down/up，实际 audit 包含 macro、focus 与 sequence；拒绝与待审批取消没有接收副作用或 ACC mutation，待决请求被清空。该取消发生在审批期间，不能代替动作执行中取消或工作台硬杀的验收。

`window_screenshot(output_path)` 和 `get_clipboard_image(save_path)` 各自通过独立真实 session/turn 新建及覆盖 PNG。断言检查点的正整数 `turnSeq` 与本回合 `turn_summary` 相同，并实际回滚：删除新文件或恢复覆盖前完全相同的字节。宏及其他应用内部数据目录的既有存储边界未在本切片扩大。

发现的产品缺陷：代理桥接工具在落盘前仅按 CLI 环境变量 `WCW_SESSION_ID` 加载会话并快照，普通 provider 已提供的 `ctx.session/sessionId/turnSeq` 被漏用，导致图片能保存但无检查点。修复后优先使用当前会话上下文；无上下文的 CLI MCP 子进程保留环境加载的回退。离线回归使用实际工作台回合与 fake image writer，修复前四次写入成功、四个检查点断言全部失败，修复后覆盖精确字节、同回合 journal 与真实回滚。

真实桌面测试仅替换模型 provider 为离线假件；工作台、ACC、PNG、剪贴板和 Cocoa 接收窗口均为实际组件。启动方式是 Node 服务，不能称为新如意 App 启动或正式身份验收。两件新测试均隔离家目录/AppData/data，按 `killOwnTree` 完整收据及已观察到的 PID/出生身份确认收尾；收据不完整或无法证明退出时保留测试目录并失败。原生 worker 先合作退出再收服务树，receiver 退出时恢复原输入源与剪贴板。

| 开发证据 | 结果与边界 |
|---|---|
| [v1](development/v1.txt) | 使用 port 0 后服务启动握手失败，未进入原生回合；测试改用项目 getFreePort，保留失败及清理诊断。没有在本切片修改产品 port 0 行为。 |
| [v2](development/v2.txt) | 测试误将工作台 NDJSON 当成 SSE，遗漏全部事件；修正解析并保留日志。 |
| [v3](development/v3.txt) | 审批三路径通过，真实截图保存后无 checkpoint，暴露本次产品缺陷。 |
| [v4](development/v4.txt) | 修复后 29 项通过；后续独立审查要求更严格的回合/字节/进程清理断言。 |
| [离线旧代码负控](development/offline-before.txt) | 四次实际 fixture 写入成功，四项 journal 失败。不是最终通过证据。 |
| [最终离线](development/offline-reviewed-v1.txt) / [最终真实桌面](development/reviewed-v1.txt) | 最终冻结候选分别 13、31 项通过；独立验收另列，不能用实施者运行代替。 |
| [工程 v1](development/engineering-v1/results.json) / [v2](development/engineering-v2/results.json) / [v3](development/engineering-v3/results.json) | 首轮 fast 76/80，README/facts、fixture-home、进程清理计数及路由引用清册未同步；第二轮 78/80；最终 80/80。统一 runner 对失败件内建自动 retry，均保留原日志，不能称开发全过程零重跑。v3运行中另有审查要求的测试断言/README修改；最终冻结的独立工程验证另列。 |

实际 TCC 撤权/恢复、动作中系统锁屏、依赖/隐藏工具真实路径、当前候选选定应用，以及物理显示器、macOS 14、Windows 同候选和正式身份仍需各自验收。用户要求不自动锁屏，本切片没有锁屏。历史清单见 [剩余范围映射](../remaining-resolution-2026-11-11.json)，该映射创建时 entry 仍待独立验收。

独立最终冻结复验见 [报告](independent-v1/report.json)：离线 13、真实桌面 31、静态 80/80（7 项集中实弹跳过），快通道内单元 2499 通过/18 项既有跳过。三组各执行一次，无手动或内建自动 retry；15 份源码与 3 份产物在八个检查点全部匹配，helper/App/本件进程 helper 前后严格签名通过。App 在本次仅作签名与字节保持核验，未启动、重建或重签。CLI MCP checkpoint 与工具装载兼容件在主执行工程 v3 通过，绑定记录明确复用，不冒充独立重跑。15 份冻结文件在提交前合入文档/手动证据提交 `d42bba09` 后仍逐字一致，实际功能提交含 12 个变更文件。
