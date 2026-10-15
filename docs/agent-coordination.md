# 代理协作动作

`send_to_agent({action:"list",runId?})` 查询当前会话的活跃运行，或指定运行的节点快照。子节点只能查询所属运行及不透明的 `parent`。`queued` 表示节点已接纳、可排队收件，不表示正在执行。`canReceive` 与 `reason` 来自发送使用的资格判定；快照不保证稍后发送仍能送达。历史运行显示 `live:false`，所有节点不可接收。消息不会复活已结束节点；父会话空闲时消息等待下次模型调用，不自动唤醒。

`orchestrate_agents({followup:{previousRunId,previousNodeId,task},background?,poolPolicy?})` 对当前会话同工作目录的终态模型节点明确续派。旧运行仍可有其他节点在执行。每次续派创建独立运行，复用原角色 ID、引擎、模型、工具档、资源锁及迭代预算，并由当前角色库与当前权限重新校验。旧结果仅注入有界参考摘要及产物引用，完整文本用 `agent_result` 获取；不复制旧对话、邮箱、依赖或重试状态。`retry_node` 仍用于修复原工作流。

模型启动的任务池默认 `off`；显式 `poolPolicy:"manual"` 开放 `propose_task`，提案须用户审批，不自动扩展。初始节点和以后审批物化节点共享原发起回合的节点预算，重试不重复计数。后台运行跨后续回合审批仍扣原预算。模型发起且有原回合限额的 manual 任务池冷恢复后无法恢复原计数器时，新增物化返回 `turn_budget_unavailable`，已接纳节点照常恢复；HTTP 发起、未绑定模型原回合预算的运行不要求该计数器。配置 `subagentMaxPerTurn:0` 仍表示关闭模型编排工具，不是无限预算。工具注册与能否继续物化是不同能力，名单/信封分别报告。
