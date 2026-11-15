# Provider 工具意图与已取得结果的持久化

产品修复 `7f95d654`（独立工作树 `a3403e04`）已提交。普通 Provider 主回合在本地工具预执行和审批前保存原始请求的调用 ID、工具名、模型参数，并逐条保存已取得的结果。保存被删除、撤回、换回合或所有者替换等守卫丢弃时，严格屏障会阻止继续执行；原有非严格调用者的保存约定保持。

这修复了真实根进程强杀时只留下用户消息、无法关联待决工具的缺口。同一离线回归在旧主仓服务上实际完成文件写入后，缺失持久调用的断言失败；修复版保留写入结果及未完成的第二调用，GET 重启不发模型请求、不重放文件效果。[主执行报告](development/report-v1.json)。

| 验证 | 主执行 | 独立执行 |
|---|---|---|
| 新增严格保存/并行结果/图片单测 | 新9项与既有15项共24通过；完整单元2508通过/18既有跳过 | 新9项通过 |
| 真实文件前缀＋待决调用、根强杀、GET重启、默认审批拒绝 | 11通过 | 11通过 |
| Mac 零输入待决宏根强杀 | 12通过 | 12通过 |
| 既有普通会话入口：默认审批、受控输入、两图片writer检查点/回滚 | 31通过 | 31通过 |
| 相关只读岛/工具循环/停止与过期回合 | 14/31/32通过 | 按限定范围未重跑 |

各独立组均首跑，零fail/skip/retry；[独立报告](independent-v1/report.json)分列范围。GUI已释放，已观察出生身份全部退出；入口夹具确认输入法及剪贴板恢复。127来源和2实际产物、另3份未改入口夹具绑定[实施提交](commit-binding.json) · [独立提交绑定](independent-commit-binding.json)。实际 process-helper 使用独立工作树产物，不声称与主仓process-helper原始字节相同；production capture/input helper仍是已授权的1cc945…。

Mac校准原始provider正文在pre-kill/post-kill/GET重启后均为user＋assistant.tool_calls，精确保留 `call_neutral_abort / tool_invoke_exec / macro_run(wait30)`；没有role:tool结果或宏终态，GET识别 `dangling=true, kind=tool_calls`。这证明请求意图与结果缺失可以关联，**不能证明ACC实际派发、进入等待或执行参数/终局**。原始审批pending/allowed仍只是请求和允许意图。[独立原始意图核验](independent-v1/native-intent-review.json)。

异常收尾保留已经返回的并行结果，处理中的不确定结果标为unknown，确未开始的调用才标not_dispatched。恢复配对和系统提示明确说明“可能已有影响，请勿自动重放”。此处是普通主回合持久化与措辞修复；尚未独立保证后续模型/管家继续动作的防重发策略。

源码审查DHC1/DHC2均已闭合：中断分支的真实并行结果同样经过展示限制，history剥图而hook保留原结果；恢复说明不再假称已进入执行。实际PNG测试进一步发现既有展示helper未识别原生 `images:[{mimeType,data}]`，已补限定形状的附件处理，并验证附件实际字节。[源码审查](code-review-v1.json) · [设计审查](../hard-abort/durable-history-plan-review-v1.json)。

完整工程：最终语法1158、构建新鲜度通过、单元2508/18既有跳过、fast80/80、0flaky、7项集中live跳过。首次fast因saveSession普查表09旧11/实际12而79/80失败，内建重试仍失败；修正自存清册后重跑语法和完整fast。每次fast包含单元前置，独立按hash复用工程，未再全跑unit/fast。[清册补审](metadata-review-v1.json)。

保留开发历史：offline-v1监听了错误事件名；targeted-v1误读turn服务外层ok；targeted-v3误用附件字段；v4正确字段暴露原生图片数组支持缺口；v5修复后24项通过。旧服务反证和首次工程清册失败均保留原日志，不计入最终冻结候选的独立首跑。

P5保持in_progress。ACC单调用实际派发/修改后的执行参数/入口/终局关联、未知调用后续自动续跑与防重发、held-state根强杀与经资格验证的救援/产品释放、动作中锁屏/条件剪贴板恢复、TCC拒权/撤权、物理多屏/非Retina、macOS14、Windows同候选及正式发行身份仍开放。本轮未新构建/签名/通过LaunchServices验收Ruyi.app。
