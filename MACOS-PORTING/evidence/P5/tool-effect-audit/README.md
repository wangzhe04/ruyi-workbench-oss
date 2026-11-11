# P5 宏内部动作摘要与不可逆分类

本切片独立验收通过；P5 整体仍为 `in_progress`。实现提交为主分支 `75c593e3`，测试工作树提交 `5db13873`。最终 208 份来源逐项匹配两个提交及当前主树；实际运行产物为原主树 automation helper `1cc945…` 和测试工作树 process helper `402d56…`，路径与完整摘要见 [双提交绑定](commit-binding.json)。没有重签或新验收安装的如意 App。

## 原问题与修复范围

两份原始真实入口结果均完成了 focus_window/input_sequence，接收窗口与 ACC 审计通过，但同 trace 的 `turn_summary.irreversible=[]`。原 31 项入口测试没有断言这个原阶段要求，问题早于上一项历史持久化修复。[原始定位](current-entry-gap-v1.json) [独立确认](independent-gap-review-v1.json)。

现在在展示压缩前提取小型结果投影：宏只读取实际返回步骤，不从请求步骤或保存录制推断已执行后缀；直接/代理已知副作用工具按返回契约分类。`reported` 仅表示工具回报副作用，`unknown` 表示无法确定，不等于应用状态成功。等待、只读、明确本地拒绝及 not_dispatched 不虚报已执行。外层失败不抹去已返回的已执行前缀；条件点击、无动作凭据、矛盾结果、缺号和限额均保留诚实状态。跨回合折叠、任务 API 和结果快照保留状态、call/step 与遗漏信息。长调用 ID 使用完整 ID 的 SHA-256，避免制造截断后的假 ID。

Python batch 的 schema1 `invocation_attempted` 只区分 Python 调用尝试与明确预校验拒绝。它和 Node 本地 MCP 边界回调都不是 native 派发、函数体入口或终局回执。

## 验证与失败历史

| 范围 | 结果 |
|---|---|
| 独立新增单元 | 13 通过 |
| 独立 Python 调用边界契约 | 5 通过 |
| 独立完整 HTTP/stdio/磁盘/API 离线入口 | 16 通过 |
| 独立真实 Mac 普通会话入口 | 34 通过：原 31 项加 allow/deny/cancel 各一项摘要断言 |
| 最终工程检查 | 语法 1161、构建新鲜度通过；单元 2521 通过/18 既有跳过；fast 80/80、零 flaky、7 项集中 live 跳过 |
| 相关主执行回归 | mission-result 62、provider-turnloop 31、stop/supersede 32 通过 |

独立有效测试各执行一次，但并非所有命令首次启动成功：Python 首次因运行器漏掉已知 DYLD 加载环境，在进入测试前退出；原日志保留，环境核验后另一次启动完成 5 项测试。十次命令前后检查点均匹配 208 来源及两个产物。实际入口允许执行时，同一回合列出 focus_window(step0) 与 input_sequence(step1)，callId 正确；拒绝和待审批取消为空账。接收窗口事件、审计、检查点/回滚、原输入法与剪贴板恢复仍通过。[独立报告](independent-report-v1.json)。

开发失败与修正均有记录（[尝试索引](development-history.json)，首次单元失败仅有会话原工具输出，未重建原日志）：初版单元测试曾因测试数据构造器读取 null 失败；首次离线入口因新工作树未建 process helper 而未获得桥接能力，清理准备也失败，随后核验自有身份终止无子进程服务并确认退出。第一轮 fast 79/80，README 数量落后，内置重试仍失败；同步数量后最终通过。相关 mission-result 的一个旧源码形状锁不接受新增字段，改为真实函数返回值断言，其余断言保留。所有原始 `.log/.ndjson` 均未清洗空白。主执行早期真实入口属于开发版本；最终候选的真实入口证明来自独立冻结复跑，不借用旧来源冒充新候选。

独立源码复核 EFA1–5 全部闭合，保留初审及纯函数反例；补审仅涉及旧文本锁的运行时替换。[闭合报告](code-review-closed-v1.json) [最终冻结补记](code-review-freeze208-addendum-v1.json)。工程门运行于未变的 207 份来源；最终冻结额外绑定了修正的 mission-result 测试，语法重跑、该测试及独立验收均在最终来源上完成。[工程复用](engineering-reuse.json)。

## 继续开放的阶段要求

本切片不关闭实际 ACC/native 每调用派发及终局持久关联、未知调用续跑/防重放、held-state 强杀释放、实际撤权/动作中锁屏、物理多屏与混合缩放、macOS14、同候选 Windows、正式发布身份及干净机器验收。原来的全部 10 项本地和 4 项外部要求保留在[最新剩余映射](../remaining-resolution-2026-11-11-effects.json)，旧审计及分辨记录未覆盖。

按用户新指令继续无人值守。只在 P5 **整体验收**完成后恢复自动锁屏，不因本切片通过提前恢复。先前屏保闲置值 300 秒的来源及当前保持唤醒状态见[执行与恢复记录](../unattended-instruction-2026-11-11.json)。
