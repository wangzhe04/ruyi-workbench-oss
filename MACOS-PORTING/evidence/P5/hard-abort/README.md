# 根进程强制退出：零输入校准

测试已提交到 `96db15f6`（独立工作树提交 `97e389b3`）。本轮仅新增测试、观察窗口和清册，产品运行时未变。P5 与完整 hard-abort 门仍开放。

普通默认会话申请 `macro_run(wait30)` 并获得允许后，在调用仍待决时仅向已核对出生身份的测试 Workbench 根进程发送 SIGKILL。自有 Cocoa 窗口只观察状态，宏没有键鼠、聚焦或剪贴板步骤。主执行与独立执行各12项通过，各一次，0fail/skip/retry；[独立报告](independent-v1/report.json)保留确切范围。39来源与2实际产物已绑定两份实施提交。[提交绑定](commit-binding.json) · [独立绑定](independent-commit-binding.json)。

主执行中原根/guardian/primary/ACC/native 五个已观察身份在故障后57ms内均已退出，没有额外向子进程发信号；这是单次外部观测，不是产品时限承诺。键鼠计数和收据均为零，HID/combined状态中性。使用同一隔离数据重启，只GET会话，没有新增模型请求或自动重放。

持久记录**保留了权限请求意图**：interventions 的 pending 记录含 macro_run 名称和 wait30 参数，随后记录 applying/allowed。它不能证明已派发或进入 ACC 等待。messages/provider 两正文只保留用户消息，ACC没有审计行，重启只报告 `dangling=true, kind=user`；尚缺派发/进入等待的确认及执行终局归属。因此不能从12项校准通过声称完整强杀审计门通过。

工程语法1156、构建新鲜度、单元2499/18既有跳过通过。首次fast因新测试未进入生成路由清册而79/80失败，内建重试也失败；补生成清册后fast80/80、0flaky、7项集中live跳过。每次fast包含单元前置，原失败日志保留。运行时/测试源码未改的语法、构建和独立单元按hash复用；两份新生成清册已另行独立复核。

[主执行记录](development/report-v1.json) · [零输入源码审查](neutral-code-review-v2.json) · [清册增补审查](neutral-metadata-review-v1.json) · [冻结39来源/2产物](freeze-v4.json)。v1七项发现、v2尚未闭合的终局归档问题以及v3修正均保留在审查记录；v1/v2候选未执行真实故障。

下一步先核实并修复执行/终局持久归属。鼠标按住期间的根强杀仍需独立审查并实际验证的救援机制后才能测试；本轮没有输入、救援、锁屏、TCC变更或App LaunchServices新验收，也不关闭原物理多屏、macOS14、Windows和正式身份等环境门。
