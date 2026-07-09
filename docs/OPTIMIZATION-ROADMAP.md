# 如意 Ruyi 工作台 · 迭代与优化路线图

> 本文档由 5 路并行深度审计（编排引擎 / 双引擎驱动 / 后端性能与安全 / 前端 UI-UX / 测试与产品）汇总而成。
> 审计全程只读，未改动代码。行号对应审计时的 `server.js`（11418 行）/ `app.js`（5056 行）当前版本，改动后会漂移，请以就近搜索为准。
> 优先级：**P0 立即修（安全/数据外泄）** → **P1 核心可用性（编排卡死、双引擎 bug）** → **P2 体验与性能** → **P3 结构性演进与产品扩展**。
>
> **配套设计规格**：UI 重设计 + 多 Agent 编排实时监控 + 青花视觉系统 + CLI 进度修复的**落地级设计**见
> [UI-ORCHESTRATION-REDESIGN.md](UI-ORCHESTRATION-REDESIGN.md)（本轮新增）。本文是"改什么"，那份是"设计成什么样"。

---

## 本轮补充（在原 5 路审计之外新确认的方向）

**W1 · CLI/异步 Workflow 无进度显示（P1，根因已定位）** — 聊天流 `emit`(server.js:7146) 转发所有事件，故模型在对话中主动编排时两引擎都实时显示；但 **UI 按钮启动(async)/resume 路径 `onEvent=()=>{}`**(6024/10051 无活跃聊天时)，且 `recordAgentNodeProgress`(5735) 只在内存累积、`saveAgentRun` 只在节点状态跳变时落盘 → 长节点执行期轮询读到陈旧状态；Claude 节点又只发 tool_use/tool_result、不发文本进度(5104)。**修法**：节点执行期节流落盘 progressLog（A）+ 可选 run 级独立事件流 `/api/agent-runs/:id/stream`（B）+ Claude 节点补 `subagent_progress` 里程碑事件（C）。详见设计文档 §4。

**W2 · 编排展示重设计（P1）** — 统一"实时 DAG 画布"取代现有纵向 `<details>` 列表，节点显示状态/引擎徽标/实时进度/预算/资源锁；停滞与死锁可视化（对齐 B1/B10）；状态语义拆 `failed`/`rejected`/`skipped`（对齐 B8）。详见设计文档 §2。

**W3 · 分级 UI 一致性 + 青花视觉系统（P2）** — 简易/专家模式在设置弹窗/体检/错误文案全线一致（修当前漏收敛）；补全设计 token、修 `--success/--warning` bug、density 分级、如意云纹克制运用。详见设计文档 §1、§3。

---

## 0. 一句话结论

三条主线：

1. **先堵安全洞。** 后端审计意外挖出 3 个 P0：DNS rebinding 绕过 CSRF（自动权限模式下≈远程 RCE）、`browser_open/office_open` 命令注入（已实测复现）、原生文件工具无边界（远程 provider 可读走任意本机文件）。对一个主打"政企可审计、气隙优先"的产品，这几条与定位直接冲突，必须排在所有功能迭代之前。
2. **"编排老有 bug"有明确根因，不是玄学。** 三大结构性根因：① 资源租约嵌套死锁 + UI 异步启动的 DAG 无 watchdog 兜底（永久卡死）；② 子 agent 循环缺"连续相同调用"死循环保护（父回合有、子回合没有）；③ 双引擎子代理执行语义只做到"大致对齐"而非契约级等价（degraded 脏结果、tier 收口、预算语义各写一套）。**当前未提交的"预算全面上调到 100"改动是治标不治本，且会把根因②的最坏成本放大 5 倍，建议先修根因再谈预算。**
3. **双引擎的正确目标是"对齐能对齐的、明示差异的"。** Provider 引擎是重实现（压缩/failover/loop-guard/plan/steer/vision 全自研且更细），Claude CLI 是薄封装（能力委托给 CLI 黑盒）。多数不对齐是架构必然，值得修的是少数几个真 bug（并行 tool_calls 缺 index、换引擎上下文断片、usage/thinking 显示缺失、SSE 多行解析）。

---

## 1. P0 · 安全（立即修，建议派 Opus 逐条验证后再改）

> 这三条都涉及"模型/网页 → 本机任意副作用/数据外泄"，且与产品安全定位正面冲突。改动前建议先各自写一个复现用例（当前测试盲区，见 §7）。

| 编号 | 问题 | 位置 | 触发/后果 | 修法要点 |
|---|---|---|---|---|
| **S1** | DNS rebinding 绕过 CSRF 闸门；且 `/api/chat/stream`、`/api/upload`、`/api/sessions`、`/api/stop`、`/api/permission/decision`、`/api/provider/compact` 等 mutating 路由**只靠 originOk、不校验 token** | `originOk` server.js:1056-1061；`needsToken` 白名单 9689 | `originOk` 只验证 Origin↔Host 自洽，从不验证 Host 是否是 `127.0.0.1:<port>`。恶意网页完成 rebinding 后可无 token 直接驱动本地 Agent；若权限模式为 bypass/auto ≈ 远程 RCE | ① `originOk` 显式校验 `Host === 127.0.0.1:port / localhost:port`，拒绝其它 Host；② 把上述 mutating 路由全部纳入 token 强校验 |
| **S2** | `browser_open` / `office_open` Windows 命令注入（**已实测复现**） | server.js:9426-9436 | `cmd.exe /c start '' <target>`，target 模型可控；含 `&` 且无空格时 cmd 按 `&` 拆成链式命令，`http://x&whoami>marker` 实测执行了 whoami | 学同文件 `buildRevealSpawn`(2147-2170) 的教训：改 `cp.spawn('explorer.exe',[target])` 直接绕开 cmd.exe，或用 `batchSafeSpawn`/`quoteWinArg` |
| **S3** | 原生文件工具全族无 `guardWorkspacePath`；`read` 档在 `nativeToolGate` 无条件 allow → 远程 provider 可读走本机任意文件 | `toolCall` file_* 9118-9424；`nativeToolGate` 4441-4451 | 接了公网 DeepSeek 等 provider 时，模型可不经审批 `file_read` 读 SSH 私钥/凭据库，结果原样进下一轮请求体发往远程 | ① file_* 补 `guardWorkspacePath` 包含性检查（默认开、可关）；② 非本地/非白名单 provider 时越界 `file_read` 走审批 + 审计日志 |

**次高（P1 安全）**：
- **S4** `ssrfCheck` 是纯字符串判定、无"解析后复核"（8283-8316，注释已自承）。C1 证实 rebinding 是现实攻击面后，应把 resolve-then-recheck 提上日程（`dns.lookup` 后用 `isPrivateIpv4` 复核并把连接 pin 在已验证 IP）。
- **S5** 无顶层 `uncaughtException`/`unhandledRejection` 兜底（仅启动阶段 `main().catch`）。任一遗漏的定时器/未 await Promise 抛错即整进程崩溃、杀掉所有会话与 MCP 子进程，无自动重启。至少加两个 handler + `logEvent` 记录。
- **S6** 前端无 CSP/X-Frame-Options 等响应头；markdown `<img>` 自动加载任意 http(s) 外链 → 提示注入下的数据渗出通道。加 CSP 纵深防御，评估图片改按需点击加载或经服务端代理去查询串。

---

## 2. P1 · 多 agent 编排（核心痛点，派 Opus 主刀 + Sonnet 补测试）

> 用户反馈"编排老卡死/子代理经常失败"的三大根因，按修复顺序排列。**建议先修 B1/B3 再决定预算策略。**

### 2.1 结构性根因（必修）
- **B1 资源租约嵌套死锁 + 异步启动无 watchdog（P1，最可能就是"卡死"元凶）** — `runSubAgent`(5448-5468) 持节点级长租约，内部 `runSubAgentCore`(5399-5419) 又申请工具级细租约，无加锁顺序、无超时；两个并发节点交叉访问对方独占资源即死锁，`Promise.all` 永不 resolve，主循环停摆。UI 异步启动路径 `parentCtrl` 为 undefined、无 idle watchdog，只能手动停止。
  **修法**：`acquireResourceLease` 加超时+死锁回退（超时释放并让节点失败）；或一个 group 两阶段全序申请全部资源；**无论同步/异步都给 `runAgentWorkflow` 装 idle watchdog**，空闲超 `turnIdleTimeoutMs` 就 abort。
- **B3 子回合缺死循环保护（P2，被 WIP 放大）** — 父回合有 `loopSig/loopCount/LOOP_ABORT_AT`(6474-6499)，`runSubAgentCore` 子回合(5289-5433)完全没有。卡住的子代理会重复调同一失败工具直到烧完 budget；预算从 20→100 后浪费放大 5 倍。**修法**：把父回合的 loop-guard 移植到子回合。
- **B4/B7 双引擎行为漂移 + degraded 脏结果（P2）** — 同一节点在两引擎下 tier 收口点不同（OpenAI 执行期二次校验 vs Claude 靠 `--allowed-tools`）、exec 权限模式不同、Claude "degraded 成功"(5144-5147，非零退出但产出≥80 字即判 ok:true)会把残缺结果当成功注入下游。**修法**：抽一份"子代理执行契约"（超时/tier 收口/失败分类/结果 ok 判定）两引擎共同遵守；degraded 标记 `degraded:true` 并对有下游依赖的节点默认视为失败。

### 2.2 状态机/预算耦合（P2-P3）
- **B2** loop 迭代污染 retry 预算：`node.attempts` 每批次派发自增，loop 成功重排队又 +1，导致"自动重试 1 次"实际从未生效（5885/5971/5985）。→ retry 用独立计数器。
- **B8** 质量门 verdict=fail 与"节点执行失败"共用 `failed` 状态(5954)，condition 又自动并入 dependsOn(5631)，导致"仅当 review=fail 时执行 fix"的条件下游被误判 blocked。→ 区分 `failed`(错误)/`rejected`(门否)/`skipped`(条件)。
- **B9** `startedCount` 把 loop/retry 计入 per-turn 子代理预算(5885→6522)，带 5 轮循环的节点占 5 个扇出名额。→ 只按不同节点数计。
- **B5** 显式 `maxIters===6` 被当哨兵值静默丢弃(5620)，用户真想设 6 轮做不到。→ 用 `maxItersExplicit` 标志或一次性迁移旧模板。
- **B12** 停止后节点状态割裂（一部分 failed 一部分 cancelled）。→ abort 统一映射 `cancelled`。
- **B10** 工具级资源等待不更新 `node.status`，UI 显示"运行中"实则阻塞(5402/5415)。→ 工具级等待也回调更新状态。
- **B6** 并发 resume 的 TOCTOU（双击"继续"可对同一 worktree 双重清理，6012→5837）。→ 入口即占位或 per-runId 互斥。
- **B11** 大量 `saveAgentRun().catch(()=>{})` 静默吞写盘失败，崩溃恢复据陈旧磁盘状态错乱。→ 至少计数+告警。
- **B13/B14** 前后端状态标签两处独立不一致(5709 vs 2524)；`inferToolResources` 对桥接工具(带 `serverId__` 前缀)读类分类失效(4806)。

### 2.3 设计层建议
- 资源模型改两阶段加锁/全序+超时回退（B1/B10 根因）。
- 调度器 `runAgentWorkflow`(5753-6009, 250+ 行巨函数) 拆出纯函数"状态转移 reducer"，把 I/O 与状态推进分离，便于穷举 loop×retry×gate×isolation 组合测试。
- UI 异步启动与 in-turn 同步启动统一由后台 runner + 统一 watchdog 执行，聊天回合只订阅进度。

---

## 3. P1-P2 · 双引擎能力对齐（派 Opus 修协议 bug + Sonnet 补 fake 夹具）

### 3.1 值得修的真 bug（投入产出比高）
- **E1（P1）** 并行 `tool_calls` 流式增量缺 `index` 时串槽损坏 — `openAiStreamOnce` server.js:4622-4628，`tc.index??0` 把多个 call 全落 acc[0]，工具名/参数拼成乱码。直接影响宣称支持的 vLLM/Ollama/自建端点。→ 按 `tc.id` 聚合，或"遇非空 id 即开新槽"状态机。**当前 fake-openai 始终带 index，无覆盖。**
- **E2（P1）** `appendSystemPrompt` 双通道 — 既作 `--append-system-prompt`(3068) 又写入 `~/.claude/settings.json` 非标准键(569)。要么被忽略(死配置)要么双重注入。→ 确认 CLI 行为后收敛为单通道。
- **E3（P2）** Provider↔Claude 换引擎时 Claude 侧静默丢中间上下文 — 恢复历史门控 `!seen.has(sid)`(2998) 使二次切回不再注入，`--resume` 又只连 CLI 原生 transcript（无 Provider 轮次）。→ 检测到上条 assistant `engine!=='claude'` 时强制补注入近端 Provider 轮次。
- **E4（P2）** Provider 不返回 usage 时用量统计永远空白（Ollama 默认/部分 vLLM）— `markUsage`(6206) 只认 `prompt_tokens/completion_tokens`。→ 无 usage 帧时回退 `estimateHistoryTokens` 产出 `estimated:true` 用量事件；兼容 `input_tokens/output_tokens` 别名。
- **E5（P2）** SSE 解析假设"一行一 JSON"，标准多行 `data:` event 会丢帧(4604-4611)。→ 按空行分割 event、合并多条 data 再 parse（向后兼容单行）。
- **E6（P2）** 非流式回退分支不发 `thinking_delta`(4586-4593)，前端看不到推理。→ 补发一次。
- **E7（P3）** Claude 子代理 `runClaudeSubAgentOnce` cwd 缺省回退 `process.cwd()`(5067)，无主回合的 cwdWarning 护栏，异常时可能在服务进程 CWD 跑 exec。→ 对齐 `normalizeCwd` + 用户根告警。
- **E8（P3）** DeepSeek-reasoner 类模型 400 归因、模型名→窗口子串匹配脆弱、CLI 缺 loop-guard 等一致性隐患。

### 3.2 应保留差异、只需在 UI/文档明示（不强行对齐）
- 压缩机制（CLI 内建 autocompact vs Provider 蒸发+摘要重播种）：对 Claude 引擎灰化"手动压缩"按钮，帮助里写"由 CLI 自动管理，可发 `/compact`"。
- failover / loop-guard / steer / plan 真流程 / tier 执行点硬闸：定位为 Provider 引擎增强项，CLI 黑盒无钩子。用一张"引擎能力对照表"给用户交代（可直接用审计的能力矩阵）。
- 检查点/回撤：CLI 原生 Edit/Write/Bash 天然不进 journal(3262-3269)，UI 标注"CLI 原生编辑不可自动撤销，建议配合 Git"。

---

## 4. P2 · 性能（"随使用时长恶化"的热点，派 Sonnet）

- **PF1（高）** 检查点 GC 全局扫描挂在每次文件写工具的关键路径 — `journalGc`(1521-1562) 每次 `file_write` 都 `await` 一遍全会话目录递归 stat 求总字节。单次工具调用延迟随**应用总使用时长/历史会话数**单调增长；一次 workflow 50 次编辑=50 次全量扫描。→ 全局体积维护增量缓存（写时 `+=`、GC 时 `-=`）或降频。
- **PF2（高）** 会话文件全量读写且无索引 — `saveSession`(1376) 每次整份 `JSON.stringify` 落盘且同轮每次工具调用都重写(6662)；`listSessions`(1078) 为显示 7 个字段把每个会话文件完整读入。成本随会话规模/历史会话数恶化。→ 独立轻量元数据索引 `sessions/index.json`（增量更新）；单轮多工具的中间保存降频。
- **PF3（中高）** `/api/workspace/resolve` 全同步扫描阻塞事件循环 — `resolveWorkspace`(2019) 用 `readdirSync` 遍历 A-Z 盘符(2043)，预算只管打分不管候选构建；慢速/掉线网络映射盘会冻结整个进程（含正在推流的 chat/stream）。→ 迁 `fs.promises` + 硬超时 + 让出事件循环。
- **PF4/PF5（低）** `/api/status` 的 `verifyManifest` 每次全包 SHA-256(9549)；`readConfig`(524) 无内存缓存、几乎每请求读盘一次（配合 1.5-2s 前端轮询放大）→ 加"内存缓存+写时失效"。
- **前端 PF6** 超长流式回复每帧全量重解析 markdown — `scheduleRender`(app.js:1861) 每 rAF 帧对累计全文跑 `marked.parse`+`sanitizeNode`。长输出越到后段单帧越贵。→ 增量渲染（稳定前缀锁定+尾部重解析）。

**正面记录**：Map 类结构均有清理路径，未发现真正无界内存泄漏；`detectClaudePath`(60s 缓存)/`scanMcpDropIns`(2s 缓存) 是值得复用的"请求路径同步 I/O 加缓存"范式；原子写(tmp+rename)纪律扎实。

---

## 5. P1-P2 · UI/UX（派 Sonnet，含可直接落地的快赢）

### 5.1 快赢（1 天内，风险低）
1. `styles.css:1165/1172/1176/1180` 把从未定义的 `var(--success,...)`/`var(--warning,...)` 改回 `var(--ok,...)`/`var(--warn,...)`——Agent 节点状态色脱离主题系统的命名笔误。
2. `index.html:630` 给 `#toastTray` 加 `aria-live="polite" role="status"`——全站 ~95 处 toast 反馈屏幕阅读器目前完全接收不到。
3. 统一错误展示：app.js 约 30 处 catch 直出 `e.message` 改用已有的 `apiErrText(e)`（纯替换）。
4. 破坏性操作确认强度统一：DAG"删除节点/删除模板"(2508/2517)、"撤销整轮/撤销"(347-368) 补确认，对齐"删除会话"。
5. 修"体检"死链：简易模式下 `openDoctorBtn` 点击静默跳去"文件"面板(switchTab 4830 强制改写)——要么隐藏按钮，要么弹"仅专家模式"提示。
6. 术语去英：`Agents`→`Agent 工作流`、`Providers`→`服务商`、裸 `Base URL` 补前缀。

### 5.2 小白劝退点（主画像，中期重点）
- **首次连接失败=死路**：`boot()`(5036) 失败只塞英文 `err.message` 进状态行，无重试无排障，三栏渲成空壳。→ 重设计成占满对话区的显式故障页（原因清单+重试+日志入口）。
- **设置弹窗对简易模式零收敛**：一点开就是 `MAX_THINKING_TOKENS`/`--max-turns`/`Overlay ID` 天书。→ 简易模式隐藏或折叠"Claude CLI/高级/集成 MCP"tab（对主画像影响最大的单项）。
- **权限弹窗甩原始 JSON**(2263)：加人话摘要（文件路径/内容长度），原始 JSON 收进默认折叠 `<details>`。
- **服务端 ~93 处英文 error 文案**透传到 toast，双语混杂。→ 高频路径(session/config/workflow/provider)逐步中文化，接入 `errorClasses` 体系。
- 大文件上传(≤90MB base64)无进度反馈(1492)，易被误判卡死。

### 5.3 进阶用户痛点
- **DAG 编辑器**：画布固定 1400×1000 无缩放/小地图(2396-2519)；纯 pointer 事件键盘不可用；**运行监控视图(纵向 details 列表 2540)与编辑器空间图(2439)是两套皮**，失败节点定位要在文本列表脑内重建拓扑。→ 补缩放/适应窗口；运行态复用编辑器空间图渲染节点状态色（重设计项，收益最高）。
- 长回复流式渲染卡顿(见 PF6)；会话列表/命令面板缺键盘上下导航；快捷键帮助只列 6 条。

### 5.4 无障碍
- Toast 无 `aria-live`（见快赢2）；模态无 Tab focus-trap、背景无 `inert`；DAG 编辑器对屏幕阅读器不可用。
- 正面：`:focus-visible`、`prefers-reduced-motion`、图标 `aria-label`、`role=dialog aria-modal` 齐全。

---

## 6. P3 · 系统逻辑迭代 / 结构性演进

- **单文件 11418 行可维护性**：推荐"构建期拼接、运行时仍单文件"——按模块边界拆 `app/src/*.js`（config/session-store/checkpoint-journal/workspace-guard/mcp-bridge/claude-engine/openai-engine/tool-dispatcher/http-router），零依赖 `build.js` 拼成分发用 `server.js`。最小改进：文件顶部加"目录索引"注释块 + dev-harness 加"体积预算"护栏。
- `toolCall()` 40+ 分支 switch(9035-9545) 拆成 6 个表驱动子分发器（file/shell/script/desktop/network/archive），顺带一次性修掉 S3 的"文件工具缺 guardWorkspacePath"。
- 编排调度器 reducer 化（见 §2.3）。
- 双引擎抽"子代理执行契约"（见 §2.1 B4）。

---

## 7. P2 · 测试与文档（派 Sonnet）

### 7.1 测试盲区（按风险）
1. **无 CI、无一键 runner**，71 个 e2e 全靠手工按文档串行跑。→ 加一个零依赖串行 runner + GitHub Actions（Windows runner）。
2. **Claude CLI 引擎从未用真实二进制测过**（只有 fake 重放器），反而 DeepSeek 有实弹测试——主打双引擎的产品这是不对称风险。
3. **零真实浏览器/DOM 测试**，6 个 UI e2e 全是源码字符串断言；图形 DAG 编辑器从未被真实渲染/点击验证。→ 引入一个轻量 headless 冒烟（可用已捆绑的 Playwright）。
4. **99 工具桌面 MCP 离线回归覆盖≈0**（fake-mcp 只有 4 个占位工具，真 ACC 用例缺依赖时静默 SKIP）。
5. **overlay 升级机制无测试**（apply/rollback/verify + sha256）。
6. 编排相关缺口：**跨节点资源死锁(B1)、异步启动挂起、loop×retry 相互作用(B2)、子回合死循环(B3)、质量门 verdict=fail 条件下游(B8)、degraded 成功(B7)、两引擎 tier 等价性(B4)、并发 resume(B6)** 全部无测试——这些正是编排"老有 bug"的盲区。
7. 补 fake-openai 三个变体：并行 tool_calls **不带 index**(E1) / **不发 usage 帧**(E4) / **多行 data SSE**(E5)。

### 7.2 文档
- **最大问题**：DAG 多 agent 编排是近期主力特性，但 `USER-GUIDE_CN` 通篇零提及、`ARCHITECTURE_CN` 漏了全部 `/api/agent-*` 路由。功能做了测了、文档完全没跟上。→ 两本手册各补一章。
- `ADMIN-GUIDE_CN` §2.3 版本过时（写 ACC v1.5/89 工具，实际 v1.8.1/99 工具）；`manuals.e2e.js` 只挡删词/密钥/旧品牌，挡不住"数字过时"。→ 加版本号一致性守护。
- `ARCHITECTURE_CN`(~40KB) 把"当前状态"与"逐版本 changelog"揉在一起，越滚越难维护。→ 拆分。

---

## 8. 竞品差距 / 产品功能扩展（P3，按非程序员中文用户价值排序）

| 优先 | 差距 | 现状 | 难度 |
|---|---|---|---|
| 1 | 语音输入/输出 | 完全没有 | 中低（浏览器 Web Speech API，零后端依赖，不违反零 npm 约束） |
| 2 | 应用内自动更新 GUI | overlay 机制成熟但只有 PowerShell CLI 入口 | 中（底层已具备，只需包 UI） |
| 3 | 跨会话持久记忆 | 只有只读 CLAUDE.md 注入，无可写个人记忆 | 中 |
| 4 | 成本/用量看板 | usage 数据已在事件流，无汇总视图/预算告警 | 低（数据已有，缺持久化聚合+图表） |
| 5 | 定时/周期性任务 | 无 cron/schedule | 中 |
| 6 | Skills/插件体系（超越 Playbooks） | Playbooks 仅提示词模板，不支持捆绑脚本/资源 | 中高 |
| 7 | 后台任务通用化 + 桌面通知 | 仅 DAG 异步启动支持，主对话仍同步阻塞 | 中 |
| 8 | Hooks（可编程钩子） | 无用户可配 pre/post-tool hook | 中 |
| 9 | 移动端/远程查看进度 | 严格 127.0.0.1 绑定 | 高（与本地安全模型冲突） |
| 10 | 团队协作/多用户 | 明确非多租户 | 高 |

**已具备、勿误判为差距**：计划模式（完整）、子 agent 定义文件（角色库+与 CLI 互通）、命令面板/斜杠命令。

---

## 9. 建议执行顺序与派工

> 我（Fable 5）负责设计与验收；执行按下表派 Opus（高风险/协议/编排/安全）或 Sonnet（体验/性能/测试/文档）。

**第 1 波 · 止血（本周）**
- Opus：S1 / S2 / S3（三个 P0 安全，各带复现用例）；S5（进程崩溃兜底）。
- Sonnet：UI 快赢 §5.1 全部 6 项。

**第 2 波 · 编排稳定 + 进度可见（1-2 周）**
- Opus：B1（死锁+watchdog）→ B3（子回合 loop-guard）→ **W1 CLI/异步进度修复（节流落盘 + Claude 里程碑事件）** → B8 状态语义拆分（failed/rejected/skipped）→ B4/B7（执行契约+degraded）。**先修这几项再重新评估"预算调 100"的 WIP。**
- Sonnet 5：为 B1/B2/B3/B8/W1 各补 e2e（§7.1 第 6 条 + "async 启动能看到中间进度"）；补 fake-openai 三变体。

**第 2.5 波 · 编排展示重设计（W2，紧接第 2 波数据层就绪后）**
- Opus：统一实时 DAG 画布（编辑/运行同一 `wf-canvas`，`data-mode` 切换）、节点卡组件、停滞横幅、失败一键处置。依赖第 2 波的进度数据与状态语义。
- Sonnet 5：泳道/列表视图、成本聚合头、缩放/适应窗口。

**第 3 波 · 双引擎对齐（1-2 周）**
- Opus：E1 / E2 / E3 / E5（协议 bug）。
- Sonnet：E4 / E6（usage/thinking 显示）；引擎能力对照表 UI + 文档明示差异。

**第 4 波 · 性能与体验（2-3 周）**
- Sonnet：PF1 / PF2 / PF3（随时长恶化的三热点）；PF6 增量渲染；§5.2 设置弹窗简易模式收敛 + 首次连接失败引导页。

**第 5 波 · 结构演进与产品扩展（滚动）**
- Opus：构建期拼接模块化（§6）；编排调度器 reducer 化。
- Sonnet：CI + 一键 runner；成本看板（差距4，数据已有）；语音（差距1）；文档补 DAG 章节。

---

### 附：本次审计确信度
- P0 安全 S1/S2/S3 为代码路径静态确证，S2 审计员称已实测复现——**改动前请各自先跑一遍复现**。
- 编排 B1/B3/B4/B7、双引擎 E1/E3/E4/E5 为静态确证 + "fake 夹具未覆盖此路径"交叉验证。
- 未发现编排层 P0（撕裂写/越权）——进程生命周期(taskkill /T、AbortController、supersede 串行化)与配对铁律(assistant.tool_calls↔role:tool)处理扎实。
