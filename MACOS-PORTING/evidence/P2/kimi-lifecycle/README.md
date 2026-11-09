# P2-01 增量：真实 Kimi 停止与原生会话恢复

2026-11-06，基线 `354dd5b1`，实现提交 `921e6a89`。复用原真实 CLI 探针，新增一个 lifecycle 场景，使用此前任务隔离安装的官方 Kimi 0.37.2 与本地确定性模型。无生产代码改动，没有新增测试文件或测试框架。

## 三回合证据

1. 真 Read 读取隔离文件，回合成功并持久化非空原生 session ID。
2. 同一如意会话继续。实际 Kimi 到达本地模型端点并保留上轮结构化工具调用/结果；读取活会话，确认 native ID 相同、execution 为 running、resumable.live 为真。带当前 expectedExecution 调用公共 stop，得到 stopped，流结果为 aborted，process 为 stopped，cleanupIncomplete 为 false。
3. 等待执行释放、模型连接关闭、assistant source=aborted 落盘后，再次续接同一原生 session。旧结构化工具上下文仍在，新的 Read 成功读取 second.txt，回合正常结束，没有 reset/recovery。

原生工具调用与 role=tool 结果从真实 CLI 的模型请求核对，不以模型最终回复代替工具成功。原生 ID 在三回合保持一致；此证据证明恢复行为，不声称直接捕获了出站 resume RPC。

现有引擎会在正常回合附带一份有界 continuity copy，因此 historyRecoveryInjected 可以为真。该副本是当前 user 文本，不能满足结构化历史 tool_calls 和工具结果的断言。初轮错误预期该字段为 false，失败见 lifecycle-first.txt / lifecycle-diagnostic.txt；已修正探针预期，没有把它归为产品缺陷或改变生产语义。

## 结果与复核

- 定向 lifecycle：19 pass / 0 fail / 0 skip。
- 完整真实 Kimi 探针：八场景 96 pass / 0 fail / 0 skip，本地模型 30 个请求。
- 当前修改文件 node --check 与构建新鲜度通过；生产树相对 `8ebb6638` 无变更，复用该提交的完整单元 2490 通过/18 跳过、80 静态通过证据，不重复运行无关套件。
- 独立复核 `/root/p2_cli_audit` 无剩余发现，见 [review.json](review.json)。命令、退出码、开发失败与复用门禁边界见 [validation.json](validation.json)。

本批验证 active prompt 取消与 native session 恢复，没有执行长 Bash 子进程，不能据此扩称其子孙回收通过；P1 已有统一进程治理证据另行适用。仍未验收真实 Kimi 账号服务、Claude CLI/账号、正式登录 Keychain 授权、机器人真实服务和 Windows 同 SHA 实机。P2 保持进行中。
