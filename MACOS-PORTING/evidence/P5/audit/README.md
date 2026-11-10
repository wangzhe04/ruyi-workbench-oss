# P5 取消后的动作审计修复

2026-11-11，当前 macOS 27.0.1 arm64、Python 3.12.10、Node 24.15.0。此切片修复异步工具取消时跳过 ACC 审计的问题，当前主机冻结候选的工程和独立验收已通过。P5 继续进行中，手动示范录制、正常审批与真实检查点回滚、输入源、撤权及动作中锁屏等剩余项分别登记。[剩余需求审计](../remaining-audit.json)

## 已发生动作与取消

共享异步工具封装显式捕获 asyncio.CancelledError，按原工具审计策略追加一次记录，然后继续抛出取消。取消未转成普通返回值。普通同步/异步成功与失败入口继续沿用原封装。审计失败维持 best-effort，不覆盖取消信号。

Mac act_and_verify 在收到外部取消时，以 ToolCancelled 携带该工具已经保存的原生动作结果。派发前取消记 action_sent=false、outcome=not_dispatched，派发后记 action_sent=true、outcome=unconfirmed，原生通信结果未知时记 outcome=unknown。confirmed 保持 null。普通原生失败早退和验证超时也携带同一派发状态。

精确取消结果绑定其所属工具名。内层步骤的状态只由该步骤自身采用。宏或 batch 外层收到内层取消时记 outcome=unknown，避免已经完成前序点击的宏被后续步骤的 not_dispatched 覆盖。

审计记录新增 typed cancelled、action_sent、confirmed 及固定 outcome 词汇。图像、完整结果、私有动作对象和其他自由字段不写入 outcome 摘要。参数与错误继续使用原脱敏与大小上限。原 log_action 的五个位置参数仍可调用。工作台桌面审计映射原样保留这些已验证字段。

## 执行与取消范围

MCP E2E 运行真实 ACC stdio 和真实原生输入，对自有窗口进行点击。独立的测试 bootstrap 只在观察函数前后增加最长十秒的文件 barrier，实际原生输入和审计代码保持产品路径。通过标准 notifications/cancelled 和对应 requestId 触发协作取消，保留服务进程以读取真实 audit_tail。

三种场景分别为派发后取消、捕获前取消、宏完成一次点击后在第二动作捕获前取消。断言接收计数、审计派发状态、时间线字段、单次记录、后台观察门保留与释放，以及没有晚到第二次点击。最终23条断言通过。[主执行](development/live-reviewed.txt)

本组证明协作式 MCP 取消。Workbench AbortSignal 路径还会立即停止桥接进程树，其收尾审计需另行验证。审计沿用 best-effort，进程被立即终止时的子进程日志落盘保证继续单列。

## 纯合约与审查

当前12项纯合约通过，覆盖通用取消透传、非审计工具、嵌套工具所有者、错误成功状态、脱敏与字段白名单、旧调用形状、日志写失败、Mac 派发前/后取消、原生未知结果与验证超时。[纯合约](development/pure-final.txt)

独立源码审查指出两项缺口。内层未派发状态曾被外层宏误用，原生失败早退曾丢失顶层未知派发字段。两项均已修复并加入纯合约及真实宏取消用例。[源码审查](code-review.json)

初轮纯测试有两项夹具失败，原因是未替换模拟帧的原生 freshness 查询；初版测试类继承也重复运行了通用用例。修正 freshness 假件与类布局后，9项通过，再加入发现回归后11项通过，最终增加取消状态一致性后12项通过。原失败记录保留。[首轮纯测](development/pure-first.txt) [夹具修正](development/pure-corrected.txt)

## 当前主机独立验收

二十四条测试命令各执行一次，十四组 Node 共 326 项、十组 Python 共 147 项通过，零失败、零跳过、零自动重跑。新增取消用例 23 项，纯取消 12 项，原录制回归 303/127 与浏览器受控启动取消 8 项通过。100 份源码文档与 3 份产物每件前后及最终无漂移。五组 App 观察的 38、46、45、27、30 个创建身份均确认退出，额外受控路径残留为空，相关夹具均通过恢复测试前剪贴板快照的断言。默认 helper/App 的严格签名和 helper 状态检查通过。[独立报告](independent/report.json)

工程四门通过，语法 1150 文件、构建新鲜度、完整单元 2499 通过和 18 项既有跳过、静态 80/80、零 flaky、测试浏览器残留零。每门前后完整103项指纹一致。[工程记录](acceptance/engineering/results.json)

验收后仅收口 TASKS、阶段文档和跟踪记录三份状态文档，97份其余源码文档及3份运行产物沿用冻结执行候选。[最终交付指纹](source-fingerprint-final-delivery.json)

Rich 日志的行尾填充空格经规范化供 Git 存档，原始 pure-first 与浏览器启动取消日志完整保存为 Base64，可逐字节恢复。浏览器日志中的 0.209 秒事件循环启动警告及子进程退出 INFO 记录均保留，八项用例继续自然退出通过。[日志规范化](log-normalization.json)

最终交付独立核验确认，100 份 Git index 原始源码 blob 共 10,990,280 字节，逐项匹配磁盘与交付指纹，3 份产物亦匹配。两份规范化日志的 Base64 均可逐字节往返恢复，分别只删除 6 行与 79 行末 ASCII 空格，其他字节保持一致。该切片可按上述协作取消范围提交，P5 继续进行中。[交付终审](final-delivery-review.json)

## 实施提交绑定

实施提交 `280d148b92f0dd9fe7b2151b73ff6b5866183a0f` 的 100 份完整原始 Git blob 共 10,990,280 字节，在提交后首次绑定快照中全部匹配最终交付指纹和当前工作区。3 份运行产物指纹一致。[提交绑定](commit-binding.json)

独立复核再次读取该提交的 100 份原始 blob，核对当前工作区、3 份运行产物和 63 份审计证据均一致。[独立提交绑定](independent-commit-binding.json)
