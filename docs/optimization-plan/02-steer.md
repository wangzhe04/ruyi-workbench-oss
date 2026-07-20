# 02 · 对话中 Steer（类 Codex 中途引导）方案

> 对应所有者确定方向 2。核心判断：**这是四大方向中性价比最高的一项**。provider 引擎链路已完整，Claude 引擎的 stdin 注入通道已被 AskUser 应答实战验证，缺口只在"路由放行 + 注入纪律 + 打断语义"。建议 W45 首发。

---

## 1. 现状盘点

### 1.1 已有地基（比预想完整得多）

| 层 | 现状 | 证据 |
|----|------|------|
| Provider 引擎对话 steer | 完整：`POST /api/steer` → `drainSteerQueue` 迭代边界注入 `[用户插话]`，队列上限 3，配对安全，`steered:true` 标记，IME 输入法守卫已修 | `13-http-router.js:1219-1233`、`07-autonomy.js:1226-1236`、`STEER_QUEUE_MAX=3` |
| DAG 节点定向插话 | 完整：`steer_node` 含资格判定/禁用原因/失败回填；邮箱与 steer 分池 | `13-http-router.js:865`、`09-workflow.js:172/523`、TEAM-MODE-V2-DESIGN.md:65 |
| 前端交互 | `steerPrompt` 乐观渲染 + `steered` 事件 15s 去重；工作台插话框完整 | `app.js:2262-2274`、`2501-2509`、`4195-4229` |
| 测试 | `steering.e2e.js`（会话级 + 并行批次不劈 tool 块回归钉）、`agent-steer-node.e2e.js`（10 组场景含 409/404/400 负路径） | dev-harness |
| 安全 | 伪造插话前缀中和（防工具结果伪造 `[用户插话]`） | `07-autonomy.js:1276` |

### 1.2 核心缺口

1. **Claude 引擎对话 steer 被显式拒绝**：`/api/steer` 对 `reg.kind !== 'openai'` 直接 409 "仅 provider 引擎支持插话"（`13-http-router.js:1227`）；前端对应位置静默 return（`app.js:2170`）。DAG 的 Claude 节点是 `-p` 单发进程、无迭代边界（`13-http-router.js:854` 注释），属另一档问题。
2. **打断语义不对齐 Codex**：现行实现是"迭代边界 drain"（`09-workflow.js:1548-1551`），即当前工具批次跑完才注入；Codex 体验是"立即打断当前执行、注入新指令"。
3. **打断不伤工具只是幻想**：即便立即打断模型回合，执行中的 MCP/桥接工具仍在跑——桥 `McpStdioClient.callTool` 120s 超时后 ACC 侧进程继续僵尸执行（`04-permission-runtime.js:432`，桥从不发送 `notifications/cancelled`）。用户"纠偏"后旧命令仍在后台写文件，这比"不能 steer"更危险。
4. **插话的持久呈现缺失**：插话消息在会话静态重渲染（`renderCurrentSession`）中的呈现依赖 `steeredSeen` 内存去重，刷新后历史插话的可视化链路需核实补齐。
5. **文档与文案写死旧口径**：README:164、ARCHITECTURE_CN.md:72 与错误码契约均写"仅 provider 引擎支持"，全引擎化后需同步。

## 2. 目标体验（对标 Codex）

1. 任意引擎对话进行中，用户随时输入插话，**立即生效**：当前工具批次被打断（或安全地完成当前单个工具后中断批次），插话作为最高优先级指令进入下一轮模型输入。
2. 插话有清晰的队列可视化（待生效/已生效/被合并），多条插话可排队（cap 3 可保留）。
3. 打断时执行中的工具被真正取消：桥接 MCP 发 `notifications/cancelled`，本地子进程 kill 进程树，不留僵尸写入。
4. DAG 编排中：provider 节点维持现有 steer_node；Claude 节点至少支持"落盘等下一轮注入"语义，UI 明示差异。
5. 双引擎行为对齐到"能对齐的对齐、差异处 UI 明示"（沿用项目双引擎哲学）。

## 3. 实施方案（分四阶段）

### Phase A · Claude 引擎对话 steer 打通（W45 主打）

**技术关键**：Claude interactive 模式的 stdin 在回合末才关闭（`05-claude-engine.js:421`），且 AskUser 答案正是经 `writeToChild(session.id, buildUserEnvelope(...))` 写入 stdin 的 stream-json user 消息并被 CLI 接受（`05-claude-engine.js:387-389`）——即"回合内交错 user 输入"通道已存在且实战在用。

1. **探针先行**（e2e 前置）：扩展 `tools/fake-claude.js` 支持交互剧本——收到 stdin 第二条 user 消息时按剧本响应，验证 CLI 真实行为（真实 Claude CLI live 探针件走 `claude-*-live.e2e.js` 既有模式，不进 CI 默认集）。
2. **后端放行 + 注入**：
   - `/api/steer` handler 移除 kind 判定（`13-http-router.js:1227`），按引擎分派：provider 走现有队列；claude 走 `writeToChild` + `buildUserEnvelope` 注入 `[用户插话]` 前缀消息；
   - 保持两引擎一致语义：`[用户插话]` 前缀、`steered:true` 事件标记、队列上限 3、伪造前缀中和（`07-autonomy.js:1276` 的逻辑推广到 Claude 侧入站消息）；
   - 与 permission 桥（`12-tool-dispatch.js:57-78`）的相互作用须明确：permission_prompt 等待期间收到 steer 的优先级与串扰防护（AskUser 应答与 steer 同走 stdin，需按消息类型分流，勿把 steer 当 AskUser 答案）。
3. **前端**：移除静默 return（`app.js:2170`）；Claude 流式中 composer 的插话输入态与"已注入"反馈；`steered` 事件渲染复用现有去重。
4. **测试**：`steering.e2e.js` 扩展双引擎参数化；fake-claude 捕获 stdin 落盘断言注入内容与格式。

### Phase B · 打断语义（Codex 级"立即生效"）

1. **中断当前工具批次**：provider 引擎在 drain 点之外增加"批次边界检查"——单个工具完成后、下一工具发起前检查 steer 队列，有则中断剩余批次立即注入（现行是整批跑完）。注意 `steering.e2e.js` 的"并行批次不劈 tool 块"回归钉：tool_calls 配对的 tool 块不可劈开，中断点必须在配对块边界。
2. **执行中工具的取消（与 03 方案的桥修复同做）**：
   - 桥 `McpStdioClient` 实现 cancellation：超时/打断时发送 `notifications/cancelled`（当前通知被整体忽略，`04-permission-runtime.js:356`）；
   - 原生工具：exec/shell 类工具打断时 kill 子进程树（Windows 需杀孙进程，`taskkill /T` 或 Job Object）；
   - ACC 侧响应取消（见 03 §3）；不可取消工具（如已完成的文件写）依赖检查点/回溯兜底——这正是差异化卖点"操作级撤销"的天然搭档，文案上应明示"打断 + 回溯"组合。
3. **plan 模式相互作用**：plan 等待批准期间 steer 的语义定义（视为修改 brief 重规划 vs 解除 plan），写清文档与测试。

### Phase C · DAG 节点 steer 对齐

- provider 节点：维持现状（已完整）。
- Claude 节点（`-p` 单发）：产品决策二选一——
  - A（推荐先做）：维持"不支持中途插话"，但 UI 禁用原因文案人话化 + 提供"等当前节点结束后向父回合/后续节点注入补充指令"的替代路径（steer 落盘，节点结束时注入 DAG 上下文）；
  - B：Claude 节点改 interactive 模式长跑（架构变动大，影响成本与归因，需单独评估，不建议本轮做）。
- `agent-steer-node.e2e.js` 补充新语义场景。

### Phase D · 体验与呈现打磨

1. 插话队列可视化：composer 上方 chip 展示待生效插话（可撤回），生效后转为消息流中的"插话卡"（区别于普通用户消息）。
2. 插话持久呈现：`renderCurrentSession` 重渲染时从会话正文恢复插话卡（核实 `steeredSeen` 之外的静态路径，补缺）。
3. i18n：`workflow.steer/steerAria` 键已有，新增文案遵守"双语键同交" lint。
4. 文档同步：README §1、ARCHITECTURE_CN 引擎能力表、错误码契约、营销 COPYBOOK 痛点表升级"随时纠偏"为独立卖点。

## 4. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Claude CLI 对回合内非 AskUser 的 user 消息行为未定义（忽略/报错/打乱上下文） | Phase A 探针先行；fake-claude 剧本 + 真实 CLI live 探针双验证；失败则降级为"回合末注入"并 UI 明示 |
| steer 与 AskUser 应答同走 stdin 串扰 | 按 stream-json 消息类型分流；e2e 覆盖"permission 等待中 steer"场景 |
| 打断工具导致半成品写入 | 取消优先 + 检查点回溯兜底；不可取消工具列表明示 |
| tool 块被劈开破坏配对 | 沿用"并行批次不劈 tool 块"回归钉，中断点只在配对块边界 |
| 双引擎语义漂移 | 对齐表写进 ARCHITECTURE 文档；UI 明示差异而非强行拉平 |

## 5. 验收清单

- [ ] 双引擎对话中 steer 全路径 e2e（注入/队列/上限/伪造前缀/IME 守卫）
- [ ] 批次边界中断 + 不劈 tool 块回归
- [ ] 执行中桥接工具收到 `notifications/cancelled`；exec 类子进程树被杀
- [ ] permission 等待中 steer 无串扰
- [ ] DAG Claude 节点 steer 的 UI 明示/落盘注入语义测试
- [ ] 插话卡静态重渲染恢复
- [ ] README/ARCHITECTURE/营销口径同步
