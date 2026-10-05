# 模型工作流规范

> 第51波（04 Phase D）入库。面向用户与贡献者，写清工作台模型回合「规划-执行-检查-循环保护-预算-压缩」的工作方式与各档预算语义。规范即营销素材——可审计的工作方式。双语见 `MODEL-WORKFLOW-SPEC_EN.md`。

## 1. 总则

工作台对模型回合施加结构化约束，每一步可观测、可回溯、可撤销。六个环节：**规划 → 执行 → 检查 → 循环保护 → 预算 → 压缩**。本规范描述 provider 引擎（OpenAI 兼容链路）的机制；Claude CLI 引擎是薄封装，能力委托 CLI 黑盒，差异见引擎能力对照表。

## 2. 规划（plan mode）

- **PLAN: 前缀**：回合首条 assistant 消息若以 `PLAN:` 开头，回合暂停等待用户批准。
- **批准闭包**：批准标志是本回合闭包内的，**不写入** `config.permissionMode`——一次批准不永久放权，回合结束即失效。
- **拒绝重提**：模型被拒后可重新提交 `PLAN:`（防 consumed-planPhase 回归）。
- **steer 与 plan**：plan 等待期间 steer 的语义（修改 brief 重规划 vs 解除 plan）见 Steer 文档（02 方案）。

## 3. 执行

### 3.1 工具协议守则
先读后改（编辑前先读该文件）；最小、精准的改动；`found:false`/未命中是正常语义非错误；多步操作先 `todo_write` 列计划再执行；完成给一段简洁变更摘要。

### 3.2 按需装载
`tool_search` 发现能力 → `tool_load` 装载返回的 pack 或精确工具名 → 调用具体工具。不要用终端重造一个可按需装载的现成工具。

### 3.3 工具选用优先级
内置工具与桌面/文档工具优先（受权限确认 + 一键撤销保护）；终端脚本兜底（不可自动撤销，现场发挥易出编码/兼容坑）。

### 3.4 子代理编排
- `orchestrate_agents` 是唯一的启动入口：一次提交全依赖图（`nodes`，依赖用 `dependsOn`），或用 `workflowId` 复用模板（内置模板必须带 `context` 写清这次的主题，否则不启动；同时给了 `nodes` 时以 `nodes` 为准、模板被忽略）；单代理写顶层简写 `{task, role?, toolTier?, background?}`。运行时自动并行就绪节点（同阶段上限 `subagentMaxConcurrent`）、等待依赖、把前序结论注入后续节点、持久化进度。旧的 `spawn_agent` 已并入，仍调它的模型由运行时翻译成单节点。
- **权限**：节点按所在线程的生效权限档运行（请求级 > 会话级 > 全局）。两种引擎同一判据：每步都问只放只读，改文件不问再放改文件，跑命令与桥接 MCP 被拒；智能自动、全自动、只做计划照常。角色自带的档（如只做计划）优先。
- **资源感知**：操作同一文件/浏览器 Profile/桌面/Office 文档的节点须声明 `resources`（如 `desktop`、`browser:default`、`file:C:\项目\a.js`、`workspace:C:\项目`；只读共享加 `read:` 前缀）；冲突节点自动排队，工具参数调用时自动加锁兜底。

## 4. 检查

### 4.1 质量门（DAG 节点级）
节点可配 `outputSchema`（结构化校验）+ `gate`（通过条件）；失败策略 `failurePolicy`（block/continue/retry）；降级策略 `degradedPolicy`（accept/fail/retry/request_review）。reviewer / verifier 角色的节点不写 `gate` 时自动加 review / verify 门（输出 verdict，不是 pass 就判驳回）；只产出发现、不该做通过/驳回判定的节点写 `gate: false`（内置模板里的三路审计与复现节点即如此）。

### 4.1a 内置模板与角色
内置 8 套模板（`08-agent-runs.js` 的 `BUILTIN_AGENT_WORKFLOWS`）：debate-and-judge、implement-review-fix-test、deep-research、design-and-decide、codebase-audit、debug-root-cause、doc-from-scratch、data-insights。节点任务是通用写法，不含主题，主题来自启动时的 `context`。内置 10 种角色（`01e-permission-modes.js` 的 `BUILTIN_AGENT_ROLES`）：explorer、worker、coder、reviewer、verifier、planner、researcher、critic、synthesizer、analyst；角色提示词在两种引擎下都进系统提示（Claude 引擎经 `--append-system-prompt`，命令行超长时改进首条消息）。个人模板与项目模板（`.ruyi/workflows.json`）同 id 时按 项目 > 个人 > 内置 覆盖；保存时拒绝环形依赖与不存在的角色。

### 4.2 回合级输出契约（规划中）
长任务收尾输出「完成声明：做了什么/没做什么/验证方式」。先提示词约定，后机械校验（04 Phase D 规划项，未实现）。

## 5. 循环保护（双判定）

工作台对死循环双重防护，互补不重叠。

### 5.1 同签名连击（签名级）
`sig = 工具名 + 原始参数`。连续相同 sig 累积：
- 第 3 次 → `loopWarning` nudge（提示模型改变策略）；
- 第 5 次 → **拒绝执行 + 中止回合**（`errorClass=tool_loop`）。

抓「完全相同调用」。

### 5.2 结果指纹无进展（语义级，04 Phase D 第51波）
工具结果内容摘要指纹（**不含**调用参数——「换参数但结果相同」正是要抓的语义死循环；若含参数则换路径自动 reset，退化为同签名连击的重复）。连续 N 次指纹相同（无新信息）→ `loopWarning` nudge。
- **普通工具阈值 4**；**探索类工具宽阈值 8**（`file_read`/`read_file`/`list_directory`/`grep`/`glob`/`find_template`/`web_search`/`ocr_screen`/`ocr_find_text`/`ocr_image`/`ui_find`/`ui_inspect`/`screenshot`/`find_on_screen`/`find_all_templates` 等——换路径读不同内容是正常进展，结果内容变即指纹变即 reset，只有真反复得到相同结果才 warn）。
- **warn 先行不 abort**：语义死循环证据弱于签名死循环，只 nudge 让模型自救（与同签名连击第 5 次 abort 不同）。
- **错误/空结果视为有新信息**（错误本身是信息），reset 计数。

抓「换参数但结果无进展」（如换路径反复读同类文件、`grep` 不同 pattern 都返回空）。

### 5.3 两判定关系
同签名连击先判定；若已 warn，语义判定跳过（`!loopWarning` 守卫，避免双 warn）。语义判定补盲区：sig 不同但结果内容相同。两者计数均 turn-local，不跨回合泄漏。

## 6. 预算

### 6.1 迭代预算档（`TOOL_ITERATION_BUDGETS`）
| 档 | 上限 | 语义 |
|---|---|---|
| standard | 100 | 默认档，多数任务 |
| long | 200 | 长任务（`isLongToolTask` 关键词启发式判定：首轮含大量 exec/read 自动升档） |
| standardHard | 300 | 标准任务的硬上限（`hardLimit`），不可超 |
| hard | 1000 | 长任务或代理团队（agent-team）回合的硬上限 |
| extension | 50 | 动态扩展增量（`shouldExtendToolIterationBudget`：有进展时按需追加，封顶该回合的 `hardLimit`） |

### 6.2 子代理预算
`subagentMaxConcurrent`（同阶段并行上限）、`subagentMaxPerTurn`（回合累计上限，0=禁用，工具不进 schema）。

### 6.3 预算口径统一（04 Phase D 规划项）
用户钳与 hardLimit 拉齐；`isLongToolTask` 升级「首轮工具使用模式再判定」（减少开局误判）。规划中，未实现。

## 7. 压缩

`context-compact-v2`：超窗时压缩历史，事实保留率 ≥80%（9/10 测试）。压缩事件 UI 可见（🗜 族）。摘要调用永不因自身超窗失败（预算化 + 动态截断）；超窗 400 不终结回合（e2e B 段回合 ok）。

## 8. 检查点与撤销

写族工具入快照表（`BRIDGED_WRITE_PATH_ARGS`）：create/modify/delete/move/copy 全操作形。整轮回撤工作区归零。这是「打断 + 回溯」组合的兜底——不可取消工具（如已完成文件写）依赖检查点/回溯，文案明示「打断 + 回溯」组合（差异化卖点：操作级撤销）。
