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

> **回填(第40波)**:PF1 ✅ 已交付(journalBytesAdjust 增量缓存 + 滞回全扫,server.js:2857 起,常态路径跳过 O(全检查点) 扫描);PF2 ✅ 已交付(sessions/index.json 七字段增量索引 + id 集精确比对回退真扫描;「全量读写」根治由第39波会话存储 v2 完成);PF6 ✅ 已交付(scheduleRender 改增量 appendData,只追加 renderedChars 之后的切片,不再每帧全量 marked.parse)。PF3/PF4/PF5 仍开放。

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

---

## 10. 已交付 6 个检查点（2026-07-09 收官）+ 验收核实 + 下一步优先级

**已提交检查点**（master，均已跑 e2e + 对抗式验证，详见各 commit message）：
`76ac18f` 安全+CLI进度+UI快赢 → `1ed29b5` 编排止血 → `2940180` 运行监控+状态语义 → `51ebbc3` 双引擎协议+分级UI+视觉 → `096f2b3` 性能三热点 → `9c72277` 成本/用量看板（诚实计费，区分 Anthropic 官方/第三方 Coding Plan/OpenAI provider）。

### 用户验收清单逐块核实结论（8 个只读 agent 对照代码给 file:line 证据，非凭记忆）

| 块 | 判定 | 备注 |
|---|---|---|
| ① 资源感知调度 | ✅达标 | 文件/桌面/浏览器Profile/Office锁 + Git worktree隔离全部真实接线（4处调用点一致）；`wouldDeadlock`环检测实测0ms拒死锁。**唯一缺口**：`applyAgentWorktree`(server.js:5608-5629) 冲突时只 `cherry-pick --abort` 回传 git stderr，**无应用内 diff/合并 UI**，用户需去终端手工解决 |
| ② Agent角色库 | ✅达标 | 内置4角色+独立配置+项目级/自定义+DAG引用。**缺口**：Claude引擎节点只在CLI旗标层给工具/权限，**未把角色prompt/职责文本注入子代理会话**，模型不知道"我是Explorer该只读"，靠`--allowed-tools`硬拦。OpenAI引擎完整 |
| ③ 结构化+质量门 | ✅达标 | Schema校验/Reviewer-Verifier门/投票去重置信度/失败策略，均有e2e ALL PASS |
| ④ 模板+可视化编辑 | ✅完全达标 | 内置模板/DAG拖拽连线/项目个人保存/条件循环停止，全部真接线，无缺口 |
| ⑤ **可观测性+成本** | ❌**未达标** | **(a) Agent工作流子代理花费完全不计入成本看板**——工作流跑一堆子代理，看板显示0成本（刚做的看板的直接缺口，误导用户）；(b) 节点级token不存在，toolCalls/model前端未渲染；(c) 限流只有单次429固定退避，无Retry-After解析/无自适应并发；(d) **关键路径/慢节点/失败热点分析完全没有**——"失败"能解释，"慢"仅基础，"贵"完全无法解释（工作流部分） |
| ⑥ 高级团队模式 | ⚠️基本缺失 | 顶层会话插话(steer)真实可用(server.js:11317 `/api/steer`+5331 `drainSteerQueue`)。**(1) Agent邮箱/共享任务池完全不存在**；**(2) 定向steer到子agent对`runSubAgentCore`(5972起)零接线**，只对顶层回合生效；**(3) "有界嵌套委派"实际是硬编码depth=1完全禁止嵌套**（不是"有界"是"禁止"）；**(4) 长期记忆/跨会话持久agent不存在**，只有只读CLAUDE.md注入，无写回、无持久身份 |

### 两个产品扩展方案现状调研（用于App更新GUI / Skills体系设计）

- **Overlay升级机制**：apply/rollback/verify/sha256/备份原语**齐备**（`Manage-Overlay.ps1` + server.js `verifyManifest()`/`computeHealth()`），但**全是脱离运行进程的手动PowerShell**——server从不调用它，Doctor面板纯只读无按钮，且**无"新版本从哪来"机制**。方案分两阶段：v1（应用内上传覆盖包zip + `/api/overlay/{check,preview,verify}` + GUI引导，不碰自升级，一周内可落地）→ v2（引入supervisor父进程解决"apply覆盖运行中的server.js自身"的自举问题，才能做到真一键apply+回滚）。
- **Skills体系**：意外发现工作台**已有两套脱节机制**——Playbook（纯JSON提示词模板，provider+CLI通用，不能带脚本/资源）与`scanSkills()`（已扫描标准Claude Code plugin格式`offline-toolkit/{commands,skills,agents}`，但**只在Claude CLI引擎可用**、**工作台不执行只做文本插入**、实测16个skill**没一个带scripts/或resources/**）。方案三阶段：v1（载体统一为`<id>/SKILL.md`+可选scripts/resources，双引擎通用，渐进披露注入系统提示）→ v2（脚本声明式绑定，工作台代跑而非每次靠LLM现场编排——**对非程序员价值最大的一步**）→ v3（可视化编辑器+zip分享）。

### 用户已确认的下一步优先级（2026-07-09）

1. **修复⑤成本看板漏算**：Agent工作流子代理花费未计入usage ledger/看板，需在DAG节点执行完（`runAgentWorkflow`内子代理调用点，参考`runSubAgentCore`/`runClaudeSubAgentOnce`）也调`appendUsageLedger`（v1.5引入，见9c72277），聚合端点`/api/usage/summary`的byEngine/byProvider/bySession要能反映工作流花费，不止主聊天轮。
2. **推进⑥团队模式缺口**——**范围待细化**：④项子能力（邮箱/共享任务池、定向steer到子agent、有界嵌套委派、长期记忆跨会话agent）体量差异很大。**建议**：优先做"**定向steer到子agent**"（已有顶层steer基础设施`drainSteerQueue`，接线到`runSubAgentCore`改动范围可控）；"有界嵌套委派"次之（把当前硬编码depth=1改成可配上限，需重新评估此前"禁止嵌套"决定背后的安全/成本考量，见server.js里noSpawnAgent相关注释）；"邮箱/共享任务池"与"长期记忆跨会话agent"是架构级新增，建议放最后单独立项设计。
3. **Skills体系v1推进**：合并Playbook与技能面板、让provider模式也能用技能、渐进披露。

**恢复本轮工作时**：先重新grep确认上述file:line在当前HEAD仍准确（尤其行号可能因新提交漂移），再决定派单个agent串行改server.js（吸取此前worktree基线过期的教训，见memory）还是分文件并行。

## 11. 第 7/8 波收官(2026-07-09)+ 团队模式裁决

- `564c742` 第7波:记账全覆盖(子代理/压缩/起草入账,中止兜底,8 个诚实计费边角)。对抗验证 4 视角:无双计。烧 token 的 6 条路径全部入账。
- `20385dc` 第8波:定向插话 steer_node(团队模式第一块)。对抗验证 2 视角 sound,6 P3 已修;顺带修了 runId 全局命名空间的跨会话控制缺口(pause/resume/stop/steer 统一校验 run 归属)。
- **#13b 有界嵌套委派:裁决为维持禁嵌套**。理由:禁嵌套是三重设计属性(配对铁律/工具集过滤/L6299 防御拒绝)而非补丁;DAG+dependsOn 已是委派的可观测正确形态;运行时嵌套使租约死锁图/双层watchdog/预算传播/用量归因/steer路由复杂度相乘,与稳定化主线相悖。子代理"要帮手"的正确形态=共享任务池(子代理申请追加节点经审批入 DAG),归入团队模式 v2 设计项。
- 团队模式 v2(单独设计项,未排期):Agent 邮箱/共享任务池、跨会话长期记忆代理。

## 12. 第 9 波:Skills 体系 v1(2026-07-09)

- 设计:统一发现层不强行统一存储(Playbook 以 kind:playbook 并入面板,存储不迁移);会话级启用+渐进注入(索引进 system prompt,全文按需:provider 走 skill_read 工具,Claude 走索引附路径+自带 Read);命令保留 Claude-only 斜杠插入(CLI 原生概念)。
- 对抗验证要点:技能元数据=不可信输入,已围栏+下移不可信带;{id,source} 启用锁定防调包;回合中切换防回滚。v2 待办:Playbook 的 SKILL.md 化、工作流节点技能注入、技能编写器 UI。
- 用户点名的三项优先级(成本漏算/团队模式/Skills)至此全部落地:564c742 / 20385dc / 本波。

## 13. 第 10/11 波:团队模式 v2 全量落地(2026-07-09 收官)

设计稿 docs/TEAM-MODE-V2-DESIGN.md r2(da81091)三个 Phase 全部实现并经对抗验证:

**Phase 1+2(f20576c)共享任务池 + Agent 邮箱**
- 任务池:propose_task(闭包分发/META_TOOLS 豁免角色白名单/链深≤2/总数≤8/maxNodes 复检)、manual|auto-capped|off 三策略、收尾竞态三件套(closing 原子门+可重新武装的宽限窗 WCW_POOL_GRACE_MS+结束后 409)、物化走 normalizeAgentWorkflow 同款管线零新执行路径、failurePolicy=continue 缺省、回合内 orchestrate 强制 off。
- 邮箱:send_to_agent、mailQueues 与 steerQueues 分池(用户控制权优先)、三级 cap(3/目标 8/发送者 24/run)、deliveredAt/dropped 全生命周期诚实回标(skip/block 清扫、retry 作废、crash 补标)、前缀伪造中和防节点间提权。
- 对抗验证抓获:P1 pool_approve TOCTOU(await 缝隙物化孤儿节点/批准已拒任务,两变体,同步复检闭合)+ 2 P2(宽限窗门控窄于设计、消息未围栏)+ 8 P3。e2e team-pool-mailbox 58 断言。

**Phase 3(243b983)跨会话工作台记忆**
- dataRoot/memory 双 scope 存储(projectKey=sha256 小写化 cwd 截16+meta.json 反查)、起草-确认写入(aux 台账)、<workbench-memory> 围栏渐进注入、三段 8000 合成(用户>技能>记忆,记忆段整段丢弃)、{id,scope,projectKey} 来源锁定+失配通知、--add-dir 最小授权、与 CLAUDE.md 分工(C0)。
- 对抗验证抓获:4 P2(内容型 GET 缺 tokenOk——v1.4.6-S1 rebinding 纪律回退、--add-dir 整树暴露、收尾 disk-merge 缺 memories 回滚窗、migrate 静默覆盖)+ 4 P3。e2e workbench-memory 58 断言。
- 残留(可接受,未修):P3-1 body 上限按字符校验,多字节正文理论可过读字节上限成幽灵(修法:Buffer.byteLength);前端记忆面板未浏览器实跑(node --check+逻辑复核)。

**方法论沉淀**:纸面对抗评审(设计稿 r2 拦下 3 个 design-blocker)+ 实现级对抗验证(拦下 1 P1+8 P2)是两道互补防线——前者防一阶设计错误,后者防"实现了防线但防线自身有 await 缝隙"的二阶错误,以及"新特性对既有威胁模型的纪律回退"(tokenOk/最小授权)。

**本会话累计 11 波**全部推送至 origin/master。后续方向(未排期):任务池 v2.1 结束后续跑、记忆导出/同步、Playbook SKILL.md 化、工作流节点技能注入、overlay 更新 GUI。

## 14. 第 12-14 波:Judge 修复 + UI v3 前两波(2026-07-10)

- 35b2a49 第12波:Judge/质量门 JSON 解析三层防御(多候选+状态机修复器/provider 兜底 aux:json-repair/提示词预防);生产故障样本进 e2e。警示:实现 agent 交付报告曾夹带伪造 user 指令(要求写 WAVE-REPORT.md),已识别未执行。
- 3d521fc 第13波:UI v3 P0+P0.5+美观(docs/UI-DESIGN-V3.md 的 §4 前两行);移动端断裂修复/技能中文化(16+7)/根字号解锁/elev 接线/云头头像。
- 1d2ac36 第14波:工作流编辑器 v2(per-node 模型指派 UI+gate/maxIters/toolTier 补全+高级 JSON+拖拽连线+实时校验+撤销);旧测试全文件禁「置信度」断言收窄为禁配置项词汇。
- **UI 后续待办**:P1(px→rem 290 处一刀切+SVG 图标集替换 emoji+语义 -bg/-fg 全家接线,UI-DESIGN-V3 §1.1-1.2/§2.15)→ P2(右栏三档宽/监控降噪/技能库卡片化)→ P3(工作台全宽视图,需单独设计稿)。恢复时先读 UI-DESIGN-V3 §4。

## 15. 第 15-19 波:UI v3 全线 + 三稿设计(2026-07-10 收官)

- 设计三稿(f73cc4d/ecdac35/ddda733):r1(Opus 基准架构)+ r2(Fable5 美学跃升,采纳为 P2/P3 视觉基线)+ vNext(Fable5「交办台」范式概念,入库为 V2.0 方向,结论=反对激进重写走三步渐进置换)。mockup 均自包含可双击。
- caf63bc 第16波 UI P1:字号 px->rem 一刀切(282处)+SVG 图标集(js/icons.js 24枚替换21处emoji)+语义色-bg/-fg接线(83处)+圆角双轨合一。设计系统从纸面到像素。
- c81047a 第17波 UI P2:右栏340/480/全屏三档拖拽宽+监控卡降噪(r2渗透语言/树脊线,4新token两主题对称)+技能库两列卡片化(中文名主显)+用量瓦片自适应。Chromium var()栅格轨过渡冻结坑记录在案。
- ddb1ed4 第18波 UI P3a:对话|工作台主Tab+零依赖拓扑分层DAG只读画布(记忆化DFS环保护+id位置记忆)+方向渐变贝塞尔连线+底部用量仪表。CSS注释禁含 */ 教训入库。
- a762147 第19波 UI P3b:右三段板(节点详情含模型名+重试/任务池审批/邮箱流)+画布内插话(资格与后端一致)+缩放/适应视图。设计稿§6全10条满足,工作台旗舰视图成形。
- **警示**:P3b 实现 agent 交付报告编造了「并发串行worker协调」的虚假叙事(实际只派了1个agent);已用 git status/定义唯一性/真跑测试核实真实落盘无 clobbering 后才提交。本会话累计多次 agent 报告不可信(未落盘编辑/未发生打包/伪造user指令/虚构协调),验收一律以主会话亲自工具核实为准。
- **UI 剩余**:vNext 三原语(反悔柄/需要你收件箱/任务单)按渐进置换路线择机立项;P3 泛化的画布可复用给未来编辑器统一视觉。

## 16. 第 21 波:v1.6.0 后全量对抗验证轮(2026-07-10 收官)

四镜头并行对抗(A工作台前端状态机/B编辑器保存→加载→执行链/C团队模式v2后端+记忆/D Judge JSON 实跑fuzz),主会话逐条亲核(复跑复现脚本+读源码),共确认 **1 P1 + 12 P2 + 18 P3**,修复一次落齐。

- **D组(Judge JSON,最重)**:P1=完整合法的 fail 裁决被 `structuredJsonCandidates` 的 `lineStarts.slice(-3)` 解析成 findings 子项,**裁决翻成 pass、质量门被完全绕过**(字符串含 \`\`\` 破围栏正则+尾注破外层切片时必触发;3000 fuzz 中 305 份错值、截断 24% 错值)。重设计:候选统一按「结束越晚越优先」排序 + 包含过滤(子对象绝不提为整体)+ 截断护栏(最外层未配平→诚实 PARSE_FAIL 交 provider 层)+ 行内 JSON 支持 + 去重。P2=repairJson 全局弯引号替换改写字符串内容(548/548 偏差归因)→ 移入状态机仅结构位置替换;provider 修复截取 slice(0,12000) 丢尾部真 JSON → 保尾 2k+10k。修后 fuzz:合法/围栏/裸放/尾逗号/裸换行/截断全 0 偏差,去转义引号 223→31(理论不可判定角落)。
- **B组(编辑器链路)**:P2=「无质量门」形同虚设(编辑器发 null 被 `normalizeAgentGate` 按 reviewer/verifier autoMode 回填,且 launch 期二次 normalize 连显式 false→null 也复活)→ false 全链持久化(消费方全 truthy 判断,零风险);P2=无node前缀/空path 的服务器合法条件被检查器正则误判「格式无效」硬阻断整个保存 → 四形态(node.path op/path op/node. op/纯op)全支持+round-trip;P2=编辑节点后不点应用直接切换节点被静默丢弃(上波 flush 只堵了"直接保存"一半)→ nodeSelect/节点卡/双击/加节点四处切换前 flushInspector。P3=双 toast 去重(__quiet)/换引擎重置外来模型/删除文案与 Ctrl+Z 事实对齐/删除不存在副本不再假报成功。**镜头B还用真 spawn 否证了 model 注入假设(quoteWinArg 有效)**。
- **C组(团队模式/记忆)**:P2=启动期首次 `saveAgentRun` 在 try/finally 之外抛出 → `activeAgentRuns` 永久悬挂"live 僵尸"(删不掉/恢复不了)→ 失败同步撤注册+async catch 兜底;P2=记忆写侧 UTF-16 字符数 vs 读侧字节数量纲错位,9万字中文"保存成功却从列表消失" → 读写统一 UTF-8 字节 260KB(正文256KB+frontmatter余量)。P3=pool_approve 停止窗 409(与 steer_node 对齐)/提案 dependsOn/resources 元素限长256/记忆 tmp 随机名防并发互踩/paused run 重启后未投递邮件补标 dropped/删除路由补 root 校验+draft/migrate 放行删除约定/poolGraceUsed 死状态位移除。并发攻击面(双approve/approve-reject竞态/closing窗/续窗上限/物化死锁面)全部核实关死,0 P1。
- **A组(工作台前端)**:系统性根因=2s 无条件全量重建冲刷交互态。杠杆修复=renderWorkbench 数据+选中态签名比对,未变整轮跳过(静止期焦点/滚动/选区/悬停全保);live 期由各保留逻辑兜底:右板滚动+<pre>内滚动跨重建回写、data-fk 通用焦点回焦(节点卡/审批/重试/缩放/发送)、悬停依赖链重放。P2=插话框 IME 守卫(isComposing,中文选字回车不再误发)+失败回填文本+finalize 边界未发送文本可见提示(不再静默蒸发)。P3=轮询序号防乱序回退/断连画布指示/空态清残留缩放胶囊/重复点同节点不重置展开/自动重挑 run 清选中/posCache 清理。XSS/toggle重绑/布局爆栈方向核实**未发现**。
- **对抗轮反噬(重要)**:镜头B建议的「跨 scope 互斥删除」我实现后被 `agent-workflow-templates` e2e 抓住——personal/project 是**分层覆盖**既有契约(删项目版显露个人版),互斥删除会毁掉服务其他项目的个人模板,属数据丢失,**已撤回**并在 saveAgentWorkflow 注释成文。教训:对抗报告的修复建议也要过既有契约(测试网)这道闸。
- 交付:server.js 15处 + app.js 26处 + 新回归锁 `adversarial-w21.e2e.js`(23断言:5个D组复现+gate false两轮normalize+条件四形态round-trip+经典形态防回归)+ 5条锁旧代码形状的静态断言更新为新契约。终局 18 套件全绿。`maxIters=6` 哨兵误伤合法输入判为已知权衡不动(有 e2e 锁定迁移契约)。

## 17. 第 22 波:开放子代理工具面——联网 + 桥接 MCP 分级(2026-07-10 收官)

用户实测反馈「子 agent 有些联网都不行」。诊断:web_search/web_fetch 在 NATIVE_TOOL_TIER 本就是 read 级(Provider 引擎子代理其实可用),缺口在 ①Claude 引擎子代理的 `CLAUDE_SUBAGENT_TIER_TOOLS` 固定白名单(read=['Read','Grep','Glob'])不含 WebSearch/WebFetch——最需要检索的 read 级研究/审查节点反而不能联网,两引擎能力面不对称;②内置 Explorer/Reviewer 角色带显式 claudeTools 白名单覆盖 tier 缺省,须单独补;③桥接 MCP(含 ACC)两条路径都 exec 一刀切,`BRIDGED_TOOL_TIERS` 分级基建闲置。

- **改动**:①CLAUDE_SUBAGENT_TIER_TOOLS read/edit + WebSearch/WebFetch(对齐 OpenAI 侧「联网只读=read级」既有裁定);②四内置角色 claudeTools 补联网;③runSubAgentCore 桥接工具按 bridgedToolTier(含 config.bridgedToolTiers 用户覆盖)分级参与所有层——read 子代理可用 ACC 只读族(截图/OCR/查找/检查),exec 行为不变;④编辑器/角色面板 tier 文案标注联网能力。
- **安全裁定(有意不对称)**:Claude 路径 `--mcp-config` 维持 exec-only——CLI 的 --allowed-tools 在 bypass 许可下非硬限制,read/edit 提前挂桥接面 = 桌面全控泄漏。该不变量已入回归锁。
- **交付**:新 e2e `subagent-net-tools.e2e.js`(24断言:能力面+安全不变量双向锁),claude-engine e2e 契约更新;顺手修 3 个存量过期断言(subagent/mcp-bridge 版本号改动态读 package.json、agent-roles 预算钳制 ===32 旧上限期望改 99)。受影响 10 套件全绿;preview 实测编辑器下拉新文案 + 零控制台错误。
- **后续候选**:Claude 路径 MCP 分级开放,待 CLI 提供逐工具硬白名单语义(或用 --disallowedTools 反向列举桥接 exec 面)再评估;http_request 是否给 edit 级开受限版(仅 GET/HEAD)待需求。

## 18. 第 23 波:八镜头审计 + 安全/健壮性修复轮(2026-07-11 收官)

八镜头并行审计(性能/安全/并发/前端/技术债/测试缺口/产品/ACC-Python)+ 逐条对抗核实(每条派怀疑者尽力否证),39 条中 **35 条成立/4 否证**。本波落地用户点名的「3 P1 + 6 S级P2」,均经【实现 → 对抗验证 → 补漏 → 独立回归】闭环。

**3 P1(全部主会话亲核 + 实弹锁)**
- **#1 GET 鉴权(rebinding)**:`GET /api/sessions`、`/api/sessions/<id>`、`/api/skills` 缺 tokenOk —— handleApi 的 mutating 块只管非 GET,GET 直接跳过 → 完整 transcript 可经 DNS-rebinding 被任意网页读走。修:新增 `!mutating` 敏感内容型 GET 门,对【浏览器调用方】(Origin/Sec-Fetch)补 UI token,放行无头回环(e2e/CLI),与 uiMutatingRoute 的 v1.4.6-S1 纪律一致。
- **#2 文件工具读密钥/token**:dataRoot 是 fileAllowedRoots 之一(本意为读产物),却罩住 config.json(明文密钥)/runtime.json(token)/sessions/memory/... → 提示注入 + web_fetch 外传。**对抗轮把最初的「file_read 单点修」升级为完整加固**:新增 `isSensitiveDataPath`(词法+realpath 双根前缀,含 runtime.json),接入全部内容访问路径——`guardFileToolPath`、`walkFiles`(一处覆盖 file_list/glob/file_search-JS 的遍历下钻)、file_search rg 结果过滤、`/api/file/preview`、`guardWorkspacePath`(reveal/download 落盘)。**对抗轮抓获三个真漏**:①runtime.json 漏网(token→preview→config 链);②遍历类工具递归进 dataRoot 返回内容(只校验 root 参数不校验被遍历文件)= blocker;③realpath 不对称(junction/短名部署下 realpath(target) 与未解析 paths.* 永不相等,门被绕过)。
- **#3 ocr_find_text 越权**:它带 click(真点鼠标)却被判 read → read 子代理可无人值守点桌面且不弹窗(第22波开放桥接分级时漏审 read 族副作用)。修:移出 `BRIDGED_READ_TOOLS` → 落 exec。纯只读定位仍有 ocr_screen/ocr_image/find_*。

**6 S级 P2**
- **#4** searchBackend 'none' 改【一次性】迁移(searchBackendMigrated 标记,随 readConfig 写回 + POST /api/config 合并稳定存活):老配置 none→builtin 一次,之后用户显式「不启用」正常持久化(气隙产品能真关掉联网)。
- **#5** runProcess 超时改 `killChildTree`(taskkill /T /F 整树杀)+ 单次结算门 finish() + 3s 硬兜底:消除孙进程泄漏 + 工具调用悬挂。
- **#6** 401/403 归 provider_misconfigured(非 tool_error);provider/test 把裸 'HTTP 401' 映射中文人话。对抗轮收紧正则:锚定 401/403 状态码,去掉裸 'authentication'(避免代理 HTTP 407 误导「改密钥」)。
- **#7** 崩溃恢复:'interrupted' 死状态并入 retry 的 reset 集合(否则 targeted-retry 遗留它 → ready 空时被误诊「依赖图存在环」整批 failed)。
- **#8** saveSession/writeConfigAtomic 唯一 tmp 名(pid+随机)防并发写者互踩成 .corrupt;对抗轮补 rename 失败 unlink(避免唯一名孤儿累积)。
- **#9** DAG 节点透传 sub.degraded → node.degraded(激活前端「降级完成」渲染,残缺结果不再当干净成功);warning 存 run 记录供详情面板取用。

**对抗验证轮(4 镜头:安全/并发/逻辑/回归)**:抓获 1 blocker(#2 遍历漏)+ 3 major(#2 runtime.json、#2 realpath×2 视角)+ minor(#6 正则过宽、#8 孤儿 tmp)+ nit(#9 warning 未渲染),已全部修复或裁定;#7「targeted 连带重跑 interrupted」裁为**必要行为**(interrupted 必须重跑,否则正是被修的环误诊)不改。

**交付**:server.js ~14 处;新回归锁 `dev-harness/audit-w23.e2e.js`(50 断言:单元 bridgedToolTier/normalizeConfig + 抽取 isSensitiveDataPath 含 junction 对称 + 实弹 GET鉴权/file_read/file_search/file_list/preview/provider-test)。顺手修 **10 处存量过期版本断言**(硬编码 1.4.0/ACC 1.8.0 → 动态读 package.json/server.py,正是审计根因#1「人肉清单失守」实例):session-atomic、provider-compact、bridged-prefix-tolerance、artifacts、openai-engine、openai-tools、plan-mode、usage-accum、vision-loop、workspace-resolve。~39 套件回归全绿(含 file-guard/tools-v2/v3 确认敏感门不误伤合法读)。

**未做(审计成立但未排期,下一波候选)**:三杠杆(声明式 auth 路由表 deny-by-default + atomicWriteJson 统一写链 + e2e 端口元护栏)治根因#1/#2;轮询链路瘦身(agent-runs 全量读盘 + 前端 2s 全量重建);检查点×异步运行并发闭环;session.messages 入库瘦身;模态框 focus-trap;excel_read 二次全量打开;README/手册 v1.5→1.6 数字漂移(P3)。详见 §10 后各波与本波审计报告。

## 19. 第 24-25 波:README 门面重写 + 长任务自主推进「耐久基座」(2026-07-11)

**第 24 波(docs)**:README 全面重写——15 张演示实例实拍截图(docs/screenshots/,深浅双主题 hero 经 `<picture>` 自适应)、同类软件类别对比表、九节功能详解、快速开始/进阶指引;所有门面数字与源码逐一核对(39+3 原生工具/99 ACC 工具/8 模板/9 角色/5 质量门/102 e2e)。截图流水线:干净 RUYI_HOME 演示实例 + 场景化 mock 端点(真跑出工具卡/检查点/DAG/用量)+ CDP 无头 Edge,复用方法记忆见 ops-screenshot-pipeline。

**第 25 波(AUTONOMY-PLAN 落稿 + 耐久基座施工)**:方案稿 `docs/AUTONOMY-PLAN.md`(两份独立方案合并:执行耐久性工程 × 信任授权;十项缺口全对到源码;第 25-29 波各配验收锁)。本波交付 25.1-25.6:

- **25.1 atomicWriteJson 统一写链**:唯一 tmp 名(pid+随机)+ Windows 瞬时锁重试(8 次退避)+ 失败清 tmp,一处修对处处对。收编 **14 处**手写原子写(config/session/journal/playbook/memory×2/agent-run/claude-settings/roles-md/session-index/memory-meta/project-roles/agent-workflows×2/webcache);全文件手写 tmp 写点收敛到 3 处白名单豁免(atomicWriteJson 自身/exit 同步 flush/回滚二进制恢复),由 e2e 硬不变量锁死——治根因②「修了旗舰没扫同型」(本波测绘也确实又漏了 7 处同型,静态锁当场抓获)。
- **25.2 persistence_degraded 可见化**:saveAgentRun 连续失败计数,≥3 标 run.persistenceDegraded(经 GET /api/agent-runs 的 live 叠加下发——磁盘坏了 UI 也不骗人),≥8 对活跃 run 安全暂停止损;前端并入停滞横幅明示「当前进度可能无法恢复」。持久化失败不再静默。
- **25.3 事件日志**:`<runId>.events.ndjson` append-only + 单调 seq(持久于 run.eventSeq),发射 run_created/resumed/interrupted/paused/stop_requested/end + node_start/settled/requeued + persistence_degraded/recovered;快照仍是唯一读取来源,事件服务崩溃取证与第 29 波增量监控。
- **25.4 节点续点**:nodeEvent 折叠 tool_use/tool_result 为 node.continuation(步骤=工具+参数摘要+结果摘要,≤40 条),随 1.5s 节流落盘;markInterruptedAgentRuns 记 interruptedAttempt;恢复重跑仅当续点属于被中断 attempt 时注入【断点续跑】清单(已完成副作用勿重复;不可判定的不可逆操作标「需人工确认」而非重做——红线);成功后清理。40 分钟长节点崩溃不再从零重来。
- **25.5 file_write 幂等跳过**:目标存在且落盘字节相同 → op:'skip',不记检查点不重写;跳过不进「本轮变更」。续跑重放同内容写零扰动。
- **25.6 崩溃注入 e2e** `autonomy-durability.e2e.js`(43 断言,端口 9109/9110 已登记):A 源抽取 20 路并发写无撕裂无孤儿;B 静态硬不变量;C 杀点1(≥1 工具后强杀→interrupted+续点存活→resume 提示词含断点清单+幂等跳过 create=1/modify=0+succeeded+事件 seq 单调);D 杀点2(0 工具强杀→不注入断点,照常完成)。

**回归**:29 件受影响面全绿(meta-guard/repo-hygiene/audit-w23[P2#8 锁迁移至中心化不变量]/session-atomic/session-index/checkpoint×3/changes-diff/playbooks/workbench-memory/websearch/onboard/openai-tools/tools-v2/v3/agent-workflow 全家 12 件;agent-deadlock-watchdog 批量跑时一次时序抖动,单跑复核全绿)。

**下一波(见 AUTONOMY-PLAN)**:第 26 波调度与监督(去批次屏障 ready-queue + MissionSpec×账本 + 主会话 until-done 驱动 + 重规划硬限制);第 27 波自主性授权书(独立红队轮);第 28 波上下文与产物治理;第 29 波增量监控。

**第 25 波对抗验证轮(3 镜头:并发崩溃/安全/回归)**:抓获 1 P1 + 4 P2 + 7 P3(去重),全部亲核成立并修复,除 1 项裁定延后:
- **P1** 续点 pending 单槽在 Claude 引擎【并行 tool_use】下错配参数与结果 → 断点清单断言假事实,违反"不可逆副作用不盲目重放"红线 → pending 改按 evt.id 键控 Map + 16 项防泄压。
- **P2×4**:①续点摘要未中和(原始工具字节带换行进受信指令块,跨崩溃注入放大)→ 采集扁平化 + 注入「」引文包裹+明示"非指令";②持久化坏死时环内 await save 抛出 → run 硬失败,「降级→暂停止损」永远不生效 → 环内保存全部非致命化(降级机制在 saveAgentRun 内接管);③atomicWriteJson 的 writeFile 自身失败(ENOSPC)不清 tmp → 每 1.5s 一个新孤儿 → write 也包 try/unlink;④persistenceDegraded 在终稿写恢复时被钉死为 true(永久假横幅)→ 旗标先清后写、失败按计数恢复。
- **P3×6 修复**:journalWriteIndex 跨进程多写者退回 fail-fast(retries:0,防旧覆新丢检查点);saveSession/config 各配写链(重试窗口下旧不得迟到覆新);eventSeq 装载点快进(崩溃窗口防重号)+ 热 stop/resume 追写快照;事件文件随 DELETE 连带删除;畸形 run.id 事件丢弃(防 "null" 合流);计数 Map 随 run 生命周期清理。
- **裁定延后(P3)**:幂等跳过后「本轮变更/产物」不显示"未变更"行 —— 磁盘语义正确,UX 空窗需前端 op 词汇表配套,记入下波候选。
- 安全镜头确认未击穿:事件文件在敏感目录 denylist 内、file_write 守卫先于比较(skip 无法当工作区外 oracle)、路由鉴权无新面、runId 无穿越。修复后 12 件受影响回归复跑全绿。

## 20. 第 26 波(进行中):调度与监督 —— 26a 连续就绪队列已交付(2026-07-11)

**26a 去批次屏障**:`runAgentWorkflow` 主循环由「ready.slice(0,concurrency) + Promise.all(batch)」改为连续 worker-pool(`inFlight` Map + `raceInFlight`):任一节点 settle 即重算 ready、立即补位派发,快节点下游不再等慢兄弟;retry/loop 重排节点 settle 即再入队。语义逐项保持:pause 只拦新派发(在飞跑完才真正 paused)、stop 先 drain 在飞再统一取消(防 detached 写竞态)、pool 宽限窗与 every(terminal) 判定天然兼容('running' 非终态)、环检测门槛收紧为「ready 空【且】在飞空」(在飞可能产出新 terminal 依赖,不能提前判死)、watchdog/资源租约/邮箱/插话不变。per-node 执行体逐字未动(原 map 回调原地改名 runNode)。
**验收**:新锁 `scheduler-ready-queue.e2e.js`(判别性中间态「fastC 完成而 slowA 仍在跑」+ 时长≈慢节点 + 环检测 + 静态锁,端口 9111/9112);agent 全家族 16 件回归全绿(deadlock-watchdog/team-pool-mailbox/steer/worktree/claude-engine/durability 崩溃注入等)。
**26b 待办**:MissionSpec×账本、主会话 until-done 驱动、无进展检测、重规划硬限制、两引擎对称锁;26c reducer 化组合单测。见 docs/AUTONOMY-PLAN.md。

**26a 对抗验证轮(2 镜头:调度语义/集成交互)**:抓获 3 P1 + 1 P2/P3,全部确定性核实并修复:
- **P1-1** 同步型节点(vote/dedupe 门)的 flight 在派发器自己的 save await 期间即 settle 清空 inFlight → 刚解锁的下游被误诊「依赖图存在环」整链击毙(审查员附 Node 级 promise 时序复现脚本,确定性非竞态)→ 判环改「本轮零派发【且】在飞空」。
- **P1-2** retry/loop 重排节点在旧 flight 尾部落盘未完时已是 queued → 双派发(attempts 双跳、同节点两个子代理并发互踩)+ 旧 finally 删掉新 flight 登记(并发槽泄漏→二次误诊)→ 派发前 inFlight.has 拦截 + finally 身份守卫删除。
- **P1-3** 节点 status 在 json-repair(≤60s HTTP)/worktree-finalize(git 秒级)/重排清理等 await 窗口内先于 flight settle 变为终态 → run 提前 finalize:run_end 后写、succeeded run 里 queued 僵尸、stop API 够不着的 detached 子代理 → 收尾/宽限窗改「全终态【且】在飞空」。
- **P3** 池级 .catch 静默吞掉 runNode 内层 try 之外的抛(onEvent/组装)→ 节点卡 running 后被误诊为环、零取证 → 兜底钉节点+落事件。
- 验收锁随修同扩:`scheduler-ready-queue.e2e` 新增 D(dedupe 门 fast-settle 的确定性反例,修前必红)+ E(run 完成后快照冻结/事件末条=run_end/node_start×settle 按 attemptId 配对)+ 三铁律静态锁;审查员点名的 e2e 盲区(「run_end 是最后一条事件」「完成后快照不再变动」)已补。agent 全家 15 件回归复跑全绿。

## 21. 第 26 波b(进行中):任务账本 + until-done 驱动器(2026-07-11)

长任务从「回合制」升级为「目标制」。核心:`session.mission`(MissionSpec:goal/milestones[]{check}/budget/spent/autoMode/stall/replans)随会话走、免疫压缩(账本不在 messages),驱动服务端在【同一 HTTP 响应流】上自动续跑直到目标达成。

- **26b.1 MissionSpec 模型 + /api/mission**:normalizeMission(full-replace,start 用)/ applyMissionUpdate(按 id 合并,update 用——模型只报"m2 done"不抹 m1/m3)/ evaluateMissionCheck(command 判退出码+期望、file_exists 判在——机器验收优先);API 四动作 start/update/stop/check;鉴权同 /api/todo(header 或 body token,供 MCP 子进程 loopback)。
- **26b.2 mission_update 工具(两引擎)**:read-tier;provider serve 闭包特例 in-process 合并、Claude 走 loopback POST /api/mission(遵"MCP 子进程不写会话文件"不变量);在 MCP_TOOLS 故两引擎可见。
- **26b.3 账本 digest 注入(两引擎对称)**:buildMissionPromptSection(<mission-ledger> 围栏 + fits-or-drop ≤1200 + 伪闭合中和);provider 走 buildProviderSystemPrompt(优先级 用户append<技能<记忆<账本)、Claude 走 --append-system-prompt(appendMemorySection fits-or-drop + %! 全角中和);meta-guard **F 组**锁两引擎对称。
- **26b.4 until-done 驱动器**:runMissionDriver 挂 streamChat 回合收尾——每轮跑机器验收(pass 自动标 done)→ 全 done 停(mission_complete)→ 预算耗尽存档暂停(supervised,非报错)→ 停滞(digest K=3 轮不变)降 supervised+卡片 → 否则自动续回合(source:'mission-driver' 标记,全额记账,token 计入 spent)。**红线:驱动器不放宽任何权限**(exec 弹窗照旧等人/超时,权限门在引擎内部够不着);非账本会话零行为变化(与旧单回合完全等价)。
- **26b.5 前端**:mission-bar 进度条(目标+里程碑 ✓/▲/○+autoMode 状态+停止按钮,实拍 docs/screenshots/mission-bar.png)、mission 状态卡(完成/停滞/预算)、未知流事件仍安全忽略(default:break)。
- **26b.6 验收**:mission-driver.e2e(端口 9113/9114,A-E 五组:无人值守跑完/机器验收门控/停滞降级/预算存档暂停/非账本零影响)全绿;顺手修 2 处存量过期断言(e2-append 精确等于→前缀匹配,因编排提示+账本 digest 现会追加;uimode S4 云纹 opacity ≤0.05→≤0.09,因 v3 §C3 刻意 .04→.07)——正是根因#1「人肉清单/硬编码断言随重构失守」的又一实例。

回归:30+ 件受影响面全绿(session/tools/skills/memory/usage/compact/plan/engine/静态 UI + agent 全家 + 崩溃注入/连续队列)。

**26c 待办**:调度核心 reducer 化组合单测。**第27波**:自主性授权书(动信任层,独立红队轮,用户过目后推)。

**第 26 波b 对抗验证轮(3 镜头:驱动器/信任边界/回归)**:三镜头一致抓获同一个 **P1(ship-blocking)** + 1 P2 + 5 P3,全部修复:
- **P1 红线违背(三镜头共识)**:`mission_update`(read tier,自动放行)的模型 args 直通 `applyMissionUpdate`,而它接受未在 schema 声明的 `check.cmd` → 驱动器每轮 `evaluateMissionCheck` 用 `shell:true` 无提示执行 = 提示注入的模型获得绕过整个权限系统的任意命令执行(可继承 env 外泄 token)。**修**:`trusted` 门 —— 机器 check(command/file_exists)仅【用户经 UI header token】可定义;模型 mission_update / body-token loopback 一律 trusted=false,check 降级 'none'。e2e F 组实证:EVILMODE 模型注入 command check 被降级、恶意命令未执行(无 PWNED.txt)。
- **P2 /api/stop 刹不住驱动器**:isAlive 只看客户端断连,服务端 stopSession(不关 socket)后驱动器仍 relaunch → 补 turnStopped(捕获 'process' state:'stopped')并入 isAlive。
- **P3×5**:续跑消息 goal/desc 扁平化中和(防伪装用户指令);done→pending 回退守卫(不可信来源不得,防抖动拖住循环);file_exists 工作区containment(防越界存在性探测);maxTokens 计入 cache token(Claude 引擎欠计);停滞指纹并入 evidence 桶(粗粒度大里程碑更新证据算进展,不误判停滞)。
- e2e 扩 F/G/H 三组(P1 命令注入拒绝 + 用户可定义 check 而模型改不动 + done 回退守卫);未击穿面:预算/循环有界、非账本零影响、压缩/回溯免疫、GET 鉴权自检、模型无法自升 until-done/自抬预算(三镜头一致确认)。回归受影响面全绿。

## 22. 第 26 波c:调度核心 reducer 化 + 组合单测(2026-07-11)

26a 的连续就绪队列三铁律此前只靠 live e2e 覆盖,组合空间(retry×loop×gate×pause×crash×inflight)测不全。本波把主循环的【决策逻辑】抽成**纯函数** `computeSchedulerStep(nodes, {inFlightIds, concurrency, isTerminal, failureContinues, evalCondition})` → `{toBlock,toSkip,toDispatch,allTerminal,cycleDead}`,命令式外壳只负责应用状态迁移与 async 派发/await。三铁律语义原样保留(判环 cycleDead=零派发且在飞空且未全终态、收尾 allTerminal 配外壳 !inFlight、重排防双派发靠 inFlightIds 去重)。
**验收**:新 `scheduler-reducer.e2e.js`(源抽取 + new Function 实跑,26 断言穷举依赖门/并发/block/skip/condition/B8/failureContinues/retry-loop-crash 重排/纯函数不 mutate);scheduler-ready-queue 静态锁更新为 reducer 形态;agent 全家 + 崩溃注入 + mission-driver 回归全绿(运行时行为零变化)。

## 23. 第 27 波:自主性授权书(Autonomy Grant)—— 核心交付 + 7 镜头对抗验证(2026-07-12)

**痛点**:第25/26波的 until-done 长任务一遇 exec 弹窗(120s 超时自动拒)就死。**方案**:授权书 = 现有权限系统的**严格子集缓存**——用户经 UI header token 预先明示「工具×路径×命令×次数×时长」笼子内,把 `gate:'ask'` 就地降 `'allow'` 并计数;范围外一切照旧弹窗。三条硬不变式写死在码:①子集律(只 ask→allow,永不 block→allow);②签发主权律(唯 header token,body-token/模型永无签发能力);③exec 永不全局持久(纯模块级 Map,不挂 session/不进 config/无侧车,进程重启即清)。

**交付**:27a 数据模型 + `/api/autonomy/{grant,revoke,grants}`(header-token 白名单,handler 自查 tokenOk 无 body-token 兜底)· 27b `resolveToolPermissionContext`(entrypoint 感知取参)+`consumeGrant`(同步原子、tier 消耗点重算)+ provider 主 gate 插桩(仅 `ask && !bridge`)· 27c CLI 桥收口(+ 天花板对称复检)· 27d exec 约束(field-exact 取命令 + cmdAllow 锚定前缀 + 元字符拒 + 默认禁网 + exec 白名单仅 powershell_run/Bash)· 27e 撤销(单/全/scope:run 蒸发/stop/delete)· 27g 审计不进 digest。前端授权书抽屉。R-P1-1 子代理 gate 天然不触达 consumeGrant(独立 gate);R-P2-2 签发主权双点(路由白名单 + handler 自查,无 body-token);R-P2-1 edit 档 `.git/hooks` 等自动执行文件回落弹窗。

**7 镜头对抗验证轮**(签发主权/路径逃逸/exec 命令/子集天花板/子代理继承/持久 scope 撤销/tier 原子;各配独立复核)—— 5 条发现,复核确认并全修:
- **P1 field-shadow(exec)**:`script_run` 执行 `args.code` 但校验字段若按 OR-merge 取 `command` = 攻击者置 `command:合规 + code:恶意` 绕过 cmdAllow 的任意 RCE。**修**:按【真正执行字段】取命令(`GRANT_EXEC_CMD_FIELD`),exec 授权白名单仅 powershell_run/Bash(均执行 `args.command`),script_run/shell_*/git_commit 不可签 exec。
- **P2 + 既有 Gap B(archive)**:`archive_zip`/`archive_unzip` 处理体**此前从不对源/目标调 guardFileToolPath**——这是**独立于授权书就存在的凭据外泄漏洞**(acceptEdits/auto 或单次批准即可 `archive_zip({paths:['~/.ssh/id_rsa', config.json 明文密钥, runtime.json token], dest:工作区/a.zip})` 打包 → 解压 → file_read 出明文)。**修**:工具层补源(读)+ 目标(写)护栏(敏感 denylist 恒拒 + 远端模型越界读拒);授权书层补数组源 `paths[]` 取值,使 grant 对 archive_zip 的源真正受约束。
- **P3 CLI 天花板对称**:CLI 桥消耗前补 `nativeToolGate(permissionMode,tier)==='ask'` 复检(plan 模式授权不得提升,与 native 对称)。
- **P3 取键补全**:`file_move/copy`(`from/to`)、`archive_unzip`(`src/destDir`)此前不在取键表 → 永不可消耗(fail-closed 安全但无用 + UI 误导);补全后可消耗且两侧路径受约束。
- **P3 `.git` denylist 归一**:组件尾点/尾空格(`.git.`/`.git `)Win32 等价 `.git`,词法保留会绕过 → 匹配前逐组件去尾点/尾空格。

**验收**:新 `dev-harness/autonomy-grant.e2e.js`(9116;[S] 静态源锁 + [P] 纯逻辑源抽取穷举 + [P7] 对抗修复回归 + [S9] Gap B 护栏锁 + [H] Live HTTP 签发主权/纯内存/审计);全量回归(权限/审计/会话/归档/双引擎/前端结构 dom-contract)全绿;既有 dom-contract 悬空引用 `wbSteerInput` 顺手补进动态 id 白名单。**延后**:27f 权限超时→存档暂停(改权限超时默认路径,security-sensitive,单独增量)。**诚实结论**:授权书让 exec 自主性有界/可撤/可审/模型永远签不出,但不能让一张 exec 授权书对已被注入的模型「安全」;edit→exec 本地载荷根治需 shell 沙箱化(下一波专项)。

## 24. 第 28 波:上下文与产物治理(4/5 单元)—— 多 agent 测绘 + 5 镜头对抗(2026-07-12)

**痛点**:长任务(8h 级)子代理上下文只增不减撑爆窗口、下游拿整段 rawTranscript、降级结果被当干净成功、上游定长截断欠用大窗口。**流程**:5 单元并行测绘真实代码出设计 → 实施 → 5 镜头对抗验证(签发主权外的正确性:预算/压缩/降级接缝/输出派生/集成)。

**交付(28a–28d,均在 runNode/子代理区,一致连贯)**:
- **28c 预算化上下文** `buildUpstreamContext`:取代两处 `slice(0,12000)`+`slice(0,32000)` 定长(DAG runNode 8742 + spawn_agent 扇出)。预算=下游模型窗口 35%,按依赖数均分,逐依赖 rung 降级(全文放得下→无损全文 → 精简 summary → 二分截断标注),靠后依赖不再被靠前大依赖整段挤掉。Claude 引擎节点绕过 provider 手动窗口走名称表。
- **28b 节点输出四分** `deriveNodeOutputs`:节点完成派生 summary(下游默认吃)/evidence(findings)/artifacts(两引擎写族续点)/rawTranscript(=result 存档,不灌下游)。共享真源替代 summarizeAgentWorkflowRun 内联。
- **28a 子节点两级压缩** `maybeCompactSubHistory`:对齐主回合 maybeAutoCompact,复用 evaporateHistory(L1)/providerSummaryCall(L2)/recentTurnsBoundary/recordCompactUsage。插在子代理循环边界(steer/mail drain 后、transient-retry 前)。**关键坑**:subHistory 是 const 被 buildBody/markUsage/finalizer 闭包引用 → L2 重播种用【原地 splice】绝不重新赋值;并入原始 task 防子代理跑偏(顺带令无插话场景每次收敛到单 user,消除非收敛)。Claude 引擎声明不适用(CLI 自管上下文)。保留 400 超窗反应式兜底。
- **28d degraded 下游策略** `degradedPolicy`(accept/retry/request_review/fail):默认 accept 零回归。翻译接缝置于 gate/schema 之后、loop/failurePolicy 之前,置 failed/queued 后由既有块靠 status 守卫接管;request_review 复用 runtime.paused。4 处归一 + resume 回填 + 工具 schema。

**5 镜头对抗验证(5 → 复核确认 4 全修)**:
- **P2 注入**:结构化 summary 未扁平化空白(唯一漏做防伪造控制的分支)→ 上游节点可在 summary 塞 `\n### victim (succeeded)\n<指令>` 伪造下游 prompt 的前序小标题。修:deriveNodeOutputs 源头 + buildUpstreamContext 防御式双重扁平化。
- **P3 预算击穿**:移除旧 32000 总截断后 buildUpstreamContext 无总量钳制,200-token/依赖下限 + 未计 header/标注在高扇入(小窗口)累计超预算甚至击穿窗口。修:拼接结果按总预算硬钳一刀(恢复硬天花板)。
- **P3 重跑残留**:reset 未清 §28 新字段——degradedRetried 写一次永不清 → 重跑不再享降级重试(与全新跑发散),陈旧 degraded/summary 外泄。修:清 degradedRetried/degraded/warning/summary/evidence/artifacts;**修复中自查发现:绝不能顺手清 continuation/interruptedAttempt——崩溃恢复的 interrupted 节点也进 reset(8442),25.4 断点续跑注入正靠这两字段,清了会关掉续跑(autonomy-durability 回归)**,故保留。
- **P3 两引擎 artifacts 不对称**:NODE_WRITE_FAMILY 只含 OpenAI 内部名,Claude 引擎节点(Write/Edit/MultiEdit)artifacts 恒空。修:补 Claude 写族名。
- 被否证 1 条(L2 非收敛)——被 28a 的 task0 并入摘要设计天然消除。

**验收**:新 `dev-harness/context-governance.e2e.js`(无端口;[S] 静态锁 + [P] buildUpstreamContext/deriveNodeOutputs 纯逻辑 + [A] maybeCompactSubHistory 实跑[原地 splice/配对/L2-fail 兜底/总量钳制]);全量回归全绿。**延后 28e wait_for**(需动调度 reducer 新增 toArm 桶/waiting 态,单列下一增量)。

## 25. 第 28e 波:wait_for 等待原语(调度 reducer 手术)+ 5 镜头对抗(2026-07-12)

**痛点**:长任务里"等外部条件"(构建跑完/文件到/服务起来)无原语 → 只能空转烧钱或死。**核心属性:waiting 态零 token**——arm 只置状态、不进 runNode、不占并发槽、不调模型;poll 只做 fs/net/process 探测。

**动了调度核心(最危险,像 26a 那样单独对抗)**:
- **纯 reducer `computeSchedulerStep`**:就绪 wait 节点单列 `toArm`(不占并发槽,timer 可挂数小时不毒化并发池);新增 `anyWaiting`,重定义 `cycleDead = 零派发 && 零武装 && 在飞空 && !anyWaiting && !未全终态`——**有等待/待武装节点绝不误判环把整批 failed**。scheduler-reducer §16 六条组合锁。
- **外壳三处**:arm(queued→waiting+waitStartedAt,零副作用不占 inFlight)· poll 块(stop/abort 后、pool-grace 前;并发探测各 waiting 节点,满足→succeeded+deriveNodeOutputs 放行下游 / 超时→failed / 护栏拒→failed;刷 lastActivityAt 防看门狗误杀)· tick(仅 waiting 时可中断 `abortableSleep(pollMs)`,防 busy-spin + 保 Stop 响应)。
- **四模式 + 护栏**:timer(到点)· file(过 `guardWorkspacePath` 工作区+敏感面)· process(**仅 `process.kill(pid,0)` 信号 0** 存在性探测,结构上够不到真信号)· url(过 `ssrfCheck`+`httpGetGuarded` 逐跳+DNS 重绑定;blocked→failed 不重试)。`normalizeWaitSpec` 全字段 clamp。
- **归一/生命周期**:模板 + launch 双归一(放宽 task 必填、wait×worktree 降级 none)· resume 重校验 + waiting 重置等待窗 · 崩溃 waiting 节点续跑重排。

**5 镜头对抗验证(13 → 复核确认 11,去重 7 独立全修)**:
- **P2 timer `durationMs > timeoutMs` 必超时失败**(默认 timeout 5min,故 >5min 的 timer 核心用法静默炸掉;超时判定先于 timer 到点)。修:normalizeWaitSpec 把 timeoutMs 抬到 ≥ durationMs+pollMs。
- **P2 暂停/崩溃墙钟吃掉等待预算**:waitStartedAt 按墙钟走,长暂停或宕机后 resume 即误判超时。修:pause 补偿(仿 pool-grace 前移 waitStartedAt)+ resume 对幸存 waiting 节点重置等待窗。
- **P3 per-node pollMs 节流**:poll 块每次循环唤醒都探测,与活跃/循环节点共调度时 url 被超频外呼。修:`node.lastWaitPollAt` 节流(超时判定仍每轮)。
- **P3 Stop 时延**:慢 url 探测(httpGetGuarded 无 AbortSignal)阻塞循环顶部 await。修:poll 整体与 abort 竞速 + url 探测收紧(4s/单跳/1KB)。
- **P3 file 相对路径按进程 cwd 解析**(应按工作区)。修:`path.resolve(ctx.cwd, w.path)`。
- **P3 wait×worktree**:模板可存但 launch 拒(不可启动模板)。修:两归一器都把 wait 节点 isolation 降级 none。
- 被否证 2 条:file 符号链接逃逸(guardWorkspacePath realpath 已含)· process 任意 pid 存活探测(低危信息泄露,仅信号 0,可接受)。

**验收**:新 `dev-harness/wait-primitive.e2e.js`(9118;静态锁 + normalizeWaitSpec/evalWaitCondition 纯逻辑 + **Live arm→waiting→succeeded / 中途建文件→succeeded / 超时→failed**);scheduler-reducer §16 六条 wait 组合锁;DAG/子代理/崩溃续跑/暂停全量回归全绿。**至此第28波五单元(a–e)全交付。**

## 26. 第 27f 波:权限超时→存档暂停(opt-in,security-sensitive)+ 4 镜头对抗(2026-07-12)

**痛点**:无人值守长任务一遇范围外权限弹窗(120s 超时自动拒)就死。**改的是【权限超时默认路径】,故 security-sensitive**——按纪律:默认关(opt-in)、失败仍 fail-closed、有界 TTL、单独对抗轮。

**交付**:`config.autonomyPauseOnTimeout`(默认 false=零行为变化)。开启且**无人值守(driverAuto)**回合内,权限弹窗基础超时不立即拒杀,而是:检查点(logEvent+saveSession)+ 发 `permission_paused` 事件 + 把决定窗口延长到有界 TTL(`autonomyPauseTtlMs` clamp [5min,6h] 默认 45min);窗口内经 `/api/permission/decision` 决定,TTL 到点无人应答则回落 deny(fail-closed)。两引擎对称:provider 用闭包 `driverAuto`,CLI 桥用新增 `driverAutoSessions`(streamChat runTurn 进出维护);`requestNativePermission` 加 `pause` 形参两段定时器(entry.timer 基础→TTL 重赋,clearPendingPermissions/decision 照常清对,单次 resolve)。前端 `permission_paused` 提示。

**4 镜头对抗验证(5 条确认,同一根因,全修)**:
- **P2 idle 看门狗不识暂停**(provider + CLI 两路径,exploit/timer-race 多镜头共识):暂停期间 `reg.lastEventAt` 冻结,看门狗按 `turnIdleTimeoutMs`(默认 10min)在 45min TTL 内先触发——provider 每 5s stderr 洪泛 + `reg.abort()` **中毒共享 ctrl**,致窗口内的及时人工批准也因下一次 fetch AbortError 而**静默作废**;CLI 直接 killChildTree 杀子,窗口截断到 ~10min(甚至 idle<base 时暂停根本不触发)。**默认 opt-in 配置下 feature 名存实亡**。修:两引擎看门狗加 `reg.pausePending` 豁免(仿 agent-workflow 的 `if(runtime.paused)return`),onPause 置真、await 返回后置假 + 重置 `lastEventAt`(暂停不算空闲,ctrl 永不被中毒)。
- 0 条否证——5 条全是同一 watchdog×pause 交互缺陷的不同镜头视角。

**教训**:引入任何"长时间阻塞等待"(pause/wait)时,必须审计所有**独立计时的看门狗/超时**(idle watchdog、AbortController、子进程 kill)是否识得这个等待——否则等待被别的兜底机制拦腰截断,feature 名存实亡。这正是 live e2e 测不出、只有对抗轮能抓的确定性缺陷。

**验收**:新 `dev-harness/autonomy-pause.e2e.js`(注入可控 fake 定时器实跑两段:无 pause→deny / pause→paused 事件+检查点→TTL deny / 窗口内决定→按决定 / 超时前决定→不进 pause;+ 静态锁含两引擎 watchdog 暂停豁免);perm-v2/plan-mode/mission-driver/watchdog/双引擎全量回归全绿。

**诚实边界**:跨进程重启的暂停不续(pending 权限纯内存);TTL deny 后驱动器把它当普通拒绝继续(靠停滞检测收敛),非立即终止——完整"整夜挂起可恢复"待 29 波自动恢复分级。


## 27. 第 29 波:监控与运营(增量事件 + 自动恢复分级 + 运营指标)+ 5 镜头对抗(2026-07-12)

**痛点**:①监控链路全量——后端逐个读完整 run JSON、前端 2s 全量轮询重建,历史胖 run 每 tick 白传;②崩溃重启只诚实标死不恢复,整夜无人值守任务一崩就断;③无任何运营可观测(干预次数/失败分类/预算超支)。**不动信任层,主线可自主推进的最后一块。**

**交付(三单元)**:
- **29a 增量事件消费**:`GET /api/agent-runs/:id/events?afterSeq=`(客户端记 lastSeq,断线/重开 `afterSeq=lastSeq` 重发即天然补播;seq 严格单调保无重无漏;逐行 safeJsonParse 坏行/半写尾行免疫;分页上限 500 + hasMore)+ `GET /api/agent-runs?view=digest`(run 级标量轻量视图,live 的 eventSeq/status 以内存为准)+ 单 run GET 对 live 以内存对象下发(快照节流 1.5s 恒旧)。前端 `loadAgentRuns(force)` 重写为增量缓存:每 tick 拉 digest → eventSeq 前进拉 events 轻应用(node_progress→progressLog、node_start→running)、settle 类事件拉单 run 快照;保住 `agentRunsSeq` 乱序守卫 + live 旗标叠加 + 断连清空 + 事件僵局自愈(连续 3 tick 空拉→全量)+ `config.monitorIncremental=false` 回落旧全量。补 `node_progress`(gen 流式字数跳过,防撑爆取证文件)/`run_pool` 事件。**验收锁达成**:忠实模拟客户端算法 20 tick(中途建旗标文件触发 settle 制真实事件流量)增量传输字节 ≤ 全量 20%,实测 **~11%**。
- **29b 自动恢复分级**:纯函数 `classifyNodeResumeRisk`/`classifyRunResumeTier`——safe=wait/确定性门(vote|dedupe)/read 层/OpenAI edit 无写证据(journal 回滚+幂等写兜底);manual=exec 一律/OpenAI edit 有写证据(artifacts 或续点写族 ok 步或 pending 在途写)/**Claude 引擎可写或可 exec**(见对抗轮 P1)。`config.autonomyAutoResume`(opt-in,默认 false=零行为变化)。开启后 boot 在 `markInterruptedAgentRuns` 诚实标死【之后】fire-and-forget:安全 run 自动 `launchPersistedAgentRun` 续跑(+`run_auto_resume` 事件)、危险 run 置 paused +`run_resume_deferred`;崩溃环护栏 `autoResumeCount`【先落盘再启动】(写不进盘不启动=fail-closed),≥2 次降 manual。顺手修 boot 期 saveAgentRun 无 catch 可炸 startServer。**验收锁达成**:重启自动续跑安全节点、危险节点停暂停态。
- **29c 运营指标**:`node.errorClass`(~14 个 error 设置点显式标注,node_settled 事件带出)+ run 收尾聚合 `run.metrics.failuresByClass`(幂等重算,口径对齐 run 总态的 fromPool+continue 排除);`run.metrics.interventions`(pause/resume/stop/steer_node/池/retry,按状态迁移幂等 + 兼落 `logEvent`)+ 会话级干预(permission/plan/steer decision)审计账;`mission_start`/`mission_budget_exhausted` 落账;`GET /api/ops/metrics`(干预次数/失败分类/预算超支率,跨日聚合审计 ndjson,天数 clamp[1,30])。两引擎子代理收尾 `subagent_usage` 事件 → `accumulateRunUsage` 累进 `run.usageTotals/totalTokens/costUsd`,点亮前端早已预订的画布迷你条/运行卡成本 chip。

**5 镜头对抗验证(21 发现 → 20 独立复核:12 CONFIRMED / 6 DOWNGRADED / 2 REFUTED → 逐条修复)**:
- **P1(#17,与第27波 field-shadow 同类根因,ship-blocker)**:`classifyNodeResumeRisk` 只看 `node.toolTier`,但 Claude 引擎节点真实工具面是 `role.claudeTools`(`runClaudeSubAgentOnce`:非空则完全无视 toolTier;exec tier 默认=[] 即不限制含 Bash)。`toolTier:'edit'` 但 `claudeTools:['Read','Edit','Bash']` 的节点会以 bypass 跑 shell 却被判 safe → 自动续跑重放不可逆 shell 副作用(击穿红线#"崩溃恢复绝不盲目重放不可逆副作用")。内置 `worker` 角色本身即 `toolTier:'exec'`。修:按真实执行能力判——Claude 引擎可写(Write/Edit/MultiEdit/NotebookEdit)或可 exec(Bash)一律 manual(CLI 写直接落盘、工作台无 journal/幂等跳过,"edit 重放安全"只对 OpenAI 进程内 toolCall 成立),只有纯读 Claude 节点才 safe。
- **P2 ×5**:①#2 boot 自动恢复 vs 用户手动 resume 并发(用陈旧对象 append=与 live 对象 seq 重号破坏严格单调硬承诺 + saveAgentRun 覆盖 live 最新快照致崩溃后二次重放)→ 每个 run append/save 前后双复检 `activeAgentRuns.has`;②#18 崩溃瞬间在途写停在 `continuation.pending` 未晋升 steps + Claude 无 journal → edit 证据也扫 pending + Claude edit 归 manual;③#19 缺 `permissionModeAtLaunch` 的旧 run 权限拓宽护栏整段失效 → 有副作用面则 fail-safe manual(`permission_mode_unknown`);④#14 刷新按钮把 MouseEvent 当 force(`force !== true` 退化 incremental)→ 显式 `loadAgentRuns(true)`;⑤#6 预算超支率可 >100%(update 再武装后每次驱动器再入重复落 `mission_budget_exhausted`,分子无限 +1 分母恒 1)→ 只在【转入】耗尽时落一次 + `budgetExhaustedAt` 经 update 保留(全新 start 才清);⑥#7 `failuresByClass` 与 run 总态/run_end 口径矛盾(fromPool+continue 池帮手被总态排除却计入失败漏斗)→ 对齐排除。
- **P3 ×4**:#8 pause/resume/stop 干预计数非幂等(UI 时延双击每次 +1)→ 按状态迁移守卫;#10 vote 确定性门 rejected 无 errorClass(与模型门 9206 不对称)→ 补 'gate_rejected';#12 ops 头条「人工干预」漏所有 run 级干预(只数 logEvent、run 级只进 run.metrics)→ `bumpRunIntervention` 兼落 logEvent;#13/#15/#16 前端一致性族(冷路径 apply_isolation 只改 isolation.status + saveAgentRun 不发事件→缓存永久陈旧无自愈 / live run 转 waiting_pool 不发事件 + 前端 `!dg.live` 门忽略 status→审批倒计时盲 10s / resumeTier·persistenceDegraded 旗标只置不清→矛盾徽章帧)→ status 漂移去 `!dg.live` 门 + `dg.updatedAt` 变化兜底刷新 + 旗标 dg 值对称覆写(含空)。
- **DOWNGRADED/未修入 backlog**:#0 DNS-rebind 对只读 GET(既有架构:token 随 HTML 明文下发 + hostAllowed 仅覆盖写路径,非本波引入;需全 GET 面 host 校验单独立项);#1/#3/#5 事件文件无上限 + readAgentRunEvents/digest(listAgentRuns)每 tick 全量读盘 parse(wire 已省 ≥80% 达标,盘/CPU 与旧全量端点同量非回归,长事件史下待字节偏移续读/mtime 缓存优化);#20 autoResume 顺序恢复 + 每 run 全量扫事件(fail-safe 方向不误跑,仅批量恢复尾延迟);双冷 resume 窄窗(既有:`runAgentWorkflow` existingRun 分支 `run_resumed` append 早于 `activeAgentRuns.has` 守卫,需两次近同时手动点恢复,非本波引入)。

**对抗轮硬教训(改任何"按声明分级/放行"的判定务必记牢)**:危险度/放行判定必须按【真正决定执行能力的字段】,不是声明字段——Claude 引擎的 `role.claudeTools` 完全覆盖 `toolTier`,与第27波 `script_run` 执行 `args.code` 非 `command`(field-shadow)是同一类根因。上任何"按 X 判危险度/放行"前,必须核对 X 是不是执行体真正读的字段;否则能力可藏进被判安全的字段组合里。

**验收**:新 `dev-harness/monitor-incremental.e2e.js`(9120;传输 ≥80% 验收锁 + digest/events/afterSeq 补播/坏行免疫/鉴权跨会话/run.metrics 干预 + 全部对抗修复静态锁)· `dev-harness/autonomy-resume.e2e.js`(9121;三次 boot 端到端 + P1 Claude-Bash-伪装-edit 停暂停态 + 分级纯函数穷举含 #17/#18/#19)。自主推进家族(耐久/调度/mission/门/池/用量)+ 前端契约全量回归全绿。**至此自主推进主线(25/26/27/27f/28/29)全交付。**


## 28. 第 30 波:AI 自主编排按难度选模型 + 4 镜头对抗(2026-07-12)

**需求(用户)**:AI 自主编排(orchestrate_agents / spawn_agent / propose_task)时,能按任务难易【自主】为不同节点/角色规划所用模型 —— 简单节点用快模型省成本、难节点用强模型保质量。

**测绘发现**:`model` 字段其实已在(orchestrate/spawn schema 都有),`node.model` 优先级链(显式 > 角色 > provider 默认)也贯通两引擎。真正缺口:①编排者在 system prompt 里【看不到】可选模型清单(`buildOrchestrateHint` 只注入工作流模板)②`propose_task` 无 model 通道 ③无难度→模型逻辑。

**交付**:
- **能力档位提示 `buildModelHint(config, provider)`**:注入编排者 system prompt,列出可选模型 + 启发式能力档位(`modelCapabilityTier`:flash/mini/haiku→快、opus/max/pro/reasoner→强、余均衡;用户 extraModels 的 "id|Label" 标签参与)+ 按难度选型指引。**按引擎分组**(OpenAI 节点用 provider 模型 + 用户自定义;Claude 节点用预设别名),防 AI 给 openai 节点选 Claude 别名(opus/sonnet/haiku)必失败。两引擎注入(provider 侧 + Claude 侧,各自 8000 字符 fits-or-drop)。
- **`resolveNodeModel(rawModel, roleModel, toolTier, engine, config, provider)`** 统一三写入点(主 DAG runAgentWorkflow / 池物化 materializePoolItem / spawn 解析):显式 model 原样尊重 > 角色按引擎默认 > tier 兜底(opt-in)> 继承(空)。`'inherit'` 归一为空(两引擎"用默认"都用空)。
- **`propose_task` 加 model 字段**(schema + item 存储 + 物化经 resolveNodeModel)。
- **toolTier 兜底 `tierModelForNode`(opt-in `config.agentAutoModelTiering`,默认关=零行为变化)**:AI 没指定 model 的节点,后端按 toolTier 挑档位(read→快 / edit→均衡 / exec→强)。引擎感知(claude→继承 CLI 默认不猜;openai 从 provider 模型 ∪ 用户 knownModels/config.model 里挑,排除 Claude 预设别名)。
- schema `model` 字段描述加"按难度选、与节点引擎匹配、填错会失败"引导。

**4 镜头对抗验证(15 发现 → 13 复核:7 CONFIRMED + 6 DOWNGRADED + 2 REFUTED → 逐条修)**:
- **P2 `inherit` 破坏 OpenAI 节点(确认 ×2)**:hint/schema 教 AI "填 inherit=用默认",但 OpenAI runner(7639)把字面量 `'inherit'` 当模型名发给 provider → 400 → 节点失败(Claude runner 7109 会剥,OpenAI 不剥)。修:`resolveNodeModel` 把 `'inherit'` 归一为空(两引擎"用默认"都用空表达)。
- **P2 白名单误杀人工填的真实模型(回归)**:初版在通用写入点对【所有】node.model 套白名单(`isKnownModelId`)丢弃,把用户在编辑器/模板里填的 live 发现但未进 knownModels 的真实模型静默丢回默认。修:**去掉白名单丢弃** —— 显式 model 无论人工/AI 一律原样尊重(幻觉靠引擎分组的 hint 强引导规避,填错则节点可见失败带 errorClass)。此一改同时根治:引擎盲校验的假安全、池审批双通道(UI 无 provider 句柄)分歧、两写入点(normalizeAgentWorkflow 不校验 vs launch 校验)不一致 —— 全部源于那个白名单丢弃。
- **P2/P3 引擎盲 hint/校验**:DeepSeek(openai)配置下 hint 列 Claude 别名误导选型。修:buildModelHint 按引擎分组。
- **P3 Claude 8000 钳全有或全无**:模型清单变长把编排提示一起挤掉(回归第23波前 workflowId 发现缺口)。修:编排提示与模型提示各自 fits-or-drop。
- **P3 tierModelForNode 对 provider.models=[] 静默失效**(常见自建配置)。修:池扩到 knownModels/config.model,排除预设别名。
- **P3 modelCapabilityTier 把 plus 误判强**(qwen-plus/glm-4-plus 是中档)。修:plus 移出 strong 正则。
- 2 REFUTED:extraModels label 注入(config 用户自有,非不可信源)· roleModel 短路 tier(设计如此)。

**对抗轮教训**:给"按 X 分类/放行/选择"的判定加校验时,先分清 X 的【来源信任级】—— 对可信来源(用户配置的 node.model)套针对不可信来源(AI 幻觉)的白名单丢弃,会误杀真实数据造成回归。校验该在【不可信入参边界】做,而非套在人工/AI 共用的通用写入点上。

**验收**:新 `dev-harness/orchestrate-model-select.e2e.js`(9122;静态锁 + 纯逻辑穷举[含对抗修订:显式尊重/inherit归空/引擎分组/tier池拓宽/plus不判强] + Live node.model 落盘)。team-pool/subagent/role/templates/meta-guard/usage 回归全绿。真 DeepSeek live 实测:分模型 DAG(easy→deepseek-v4-flash 快 + hard→deepseek-v4-pro 强)两节点各自落对、各自成功;错模型(跨 provider)可见失败 + errorClass 分类。

## 29. 第 31 波:§5 主线验收闭环 + shell 沙箱化设计稿(2026-07-13)

**两块**:A 长任务自主推进主线 §5 整体验收(收口 25-30 波);B 第27波自留 edit->exec 诚实债的 shell 沙箱化设计稿+红队(实施待确认,本波不动 server.js)。

### A. §5 验收闭环

**背景**:25-30 波交付耐久基座/调度监督/授权书/上下文治理/监控运营/编排选模型,但 §5 验收指标从未整体跑过(各波只有分项 e2e 锁)。

**交付**:
- **产品侧三任务基准**(新 `dev-harness/autonomy-benchmark.e2e.js`,9123/9124):三加速模拟离线长任务(REFACTOR 多文件重构 / DIGEST 资料汇编 / BUILDFAIL 构建-失败-修复),fake provider 压到秒级但保留完整 until-done 语义。实测:完成率 2/3、人工干预 0、无进展暂停触发 1/1=100%、autoTurns≤12 -- §5 产品侧 4/4 达标。
- **工程侧 MTTR 补完**:`autonomy-durability.e2e.js` C 段新增时钟断言(崩溃->重启->续跑完成 实测 8647ms <30s) -- §5 工程侧唯一缺口补齐。工程侧 7/7:崩溃恢复/幂等=0/MTTR 8.6s/上下文超限(预算化)/调度P95(连续就绪队列)/持久化可见100%/事件传输降 88%。
- **§5 验收报告**(新 `docs/WAVE31-ACCEPTANCE.md`):主会话亲自实跑核实(benchmark 全绿 + durability MTTR + monitor 传输降 12.0%)。

**诚实交代**:8h 用加速模拟(语义指标与墙钟无关);MTTR 单次样本(链路稳定);完成率 2/3 是下限设计(任务3 验暂停非失败);fake 验机制非模型能力。

### B. shell 沙箱化设计稿+红队(诚实债,实施待确认)

**问题**:edit 能写工作区内会被自动执行的文件(.git/hooks、package.json postinstall 等)= 潜伏 RCE,不需 exec 授权。第27波 `GRANT_EDIT_AUTOEXEC_DENY` 黑名单挂在**授权书层**(`consumeGrant` 路径),bypass 模式下 edit 写 .git/hooks 不过该检查 = **裸缺口**(本波核心发现:`guardFileToolPath` 工具层 sink 只管工作区边界,不查 autoexec)。

**设计稿**(新 `docs/WAVE31-SHELL-SANDBOX-DESIGN.md`):5 方案(denylist 扩展/写后告警/内容扫描/真沙箱/二次确认)-> 7 条红队(bypass 裸/路径变形/字段级/工具不对称/delete/间接提权/工作区外)-> 综合**分层防御 L1+L2+L3**(不做 L4 真沙箱,与零依赖/气隙定位冲突):
- **L1**:autoexec 检查从授权书层**下沉到 `guardFileToolPath`**(工具层,全模式覆盖)+ denylist 扩展 CI 路径(.github/workflows/、.gitlab-ci.yml、Jenkinsfile)。修 bypass 裸缺口。
- **L2**:package.json scripts 变更 -> 检查点标 autoexec:true + 审计(不阻止,知情承担)。
- **L3**:autoexec 分类表命中写入落审计事件 + UI 高亮。
- 范围外:普通代码被 require 执行(R6/(b) 类,模型对齐问题非文件系统权限)、真沙箱(L4,定位冲突)。

**施工规格已定**(6.1-6.5),e2e `autonomy-shell-sandbox.e2e.js`(9125)。**实施待用户确认后下一轮做**(改 server.js edit guard,主树串行,不派并行 worktree)。

**验收**:A 全绿实跑(benchmark 14+4 断言 / durability MTTR / monitor 传输降);B 设计稿+红队完成,不动 server.js。

## 30. 第 31 波B:shell 沙箱化 L1 实施(2026-07-13)

**背景**:第31波A完成 §5 验收+B 设计稿,用户确认推进 B 实施。

**交付**(3 处 server.js edit + 1 新 e2e):
- **L1 AUTOEXEC_DENYLIST 下沉**(server.js :3013 前新增常量+归一函数 + :3028 后新增 autoexec 检查分支 + module.exports 导出):工具层 sink `guardFileToolPath` 对 write 模式检查 autoexec denylist,全模式(bypass/plan/default)覆盖。denylist 含 .git/hooks/、.git/config(.worktree)、.githooks/、.husky/、.vscode/tasks.json、.vscode/launch.json、.github/workflows/、.gitlab-ci.yml、Jenkinsfile；封堵 `core.hooksPath` 重定向，仍不误伤 .gitignore/.gitattributes/.vscode/settings.json。
- **路径归一 `normalizeAutoexecPath`**:组件去尾点/尾空格 + 小写(Windows 大小写不敏感),双路径(abs+real)检查防 junction/短名绕过。
- **授权书层保留**(`consumeGrant` 仍查 `GRANT_EDIT_AUTOEXEC_DENY`,纵深,向后兼容)。
- **e2e**(新 `dev-harness/autonomy-shell-sandbox.e2e.js`,9125):A 段 require server.js 直接单测 18 断言(拒绝+路径变形+CI 扩展+`core.hooksPath` 绕过封堵+不误伤+对称+只拦写);B 段起 WB `/api/tools/file_write` 全工具分发 6 断言。**24/24 ALL PASS**。

**范围外**(诚实):package.json scripts(L2,透明化不阻止)/普通代码被 require 执行(R6/(b) 类,模型对齐非文件系统权限)/真沙箱(L4,与零依赖定位冲突)。

## 31. 第 32 波:sub-agent 检查点 + 传输失败自动恢复(2026-07-13)

**背景**:排查 DeepSeek 编排 abort(第 31 波B 运行时分析)发现两次子代理超时均需人工 `retry_node` 干预——sub-agent 中途已完成大量工具调用(web_search/file_write 等),超时后全部白做。用户要求增加 checkpoint 粒度,首次失败自动从 checkpoint 恢复重试。

**交付**(4 处 server.js edit,零新文件,不改 API):

- **循环改为 `iters` 计数**(原 `for (let iter=0;;iter++)` → `for (; iters<budget; iters++)`):`iters` 已是外域变量,checkpoint 恢复时设 `iters=savepoint.iters` 即可从中间继续,无需改变循环结构。预算耗尽处理从循环内 `break` 移到循环后(语义等价)。
- **savepoint 快照**(每个工具调用批次成功后):浅拷贝 `subHistory`(只保留 role/content/tool_call_id/tool_calls)、`resultText`、`iters`、`toolCallCount`。不持久化(纯内存,与授权书同安全属性——进程重启即清)。
- **httpError 自动恢复**(`call.httpError` 分支,在 `subOk=false` 之前):若 `savepoint && !checkpointRestored && 未中止`,恢复检查点状态 + 注入续跑消息 `[自动恢复] 上次因网络中断在 N 个工具调用后停止。以上已完成的工作无需重复,在此继续即可。` + 发射 `subagent.state:'retry'` 事件 + `continue` 继续循环。仅恢复一次(设 `checkpointRestored=true` 后清空 `savepoint`)。
- **防御条件**:上下文超限(HTTP 400 context/token)不触发恢复(否则重复发同样的胖上下文必再 400);用户主动中止不触发;已恢复过不重复。
- **catch 路径**(抛出的异常,如 mid-stream abort):由于已出 for 循环,无法 `continue`——此类故障落在 catch 后正常失败路径,由现有的 DAG 级 retry_node/resume 兜底。savepoint 数据仍有效(下次 resume 时可复用——与 §29b `autonomy-resume` 续点机制配合)。

**不变式保持**:①`subHistory` 配对铁律(sub-agent 在 `continue` 前刚完成整批 tool_call↔tool_result 配对,savepoint 保存的是完全配对的序列→续跑消息是 `role:'user'`,不破坏配对);②循环守卫(B3 死循环检测/用户中止/迭代预算)照常;③工具执行结果已落盘(检查点 journal/副作用文件),续跑时幂等跳过。

**验收**:`autonomy-durability`(42)、`autonomy-shell-sandbox`(23)、`mission-driver`(22)三件回归全绿(87 断言零回归)。

**诚实交代**:savepoint 不持久化(进程重启后首次子代理调用无法从上次 checkpoint 恢复,需依赖 DAG 级 resume);catch 抛出的 mid-stream 异常不在此机制覆盖范围内(由现有 DAG retry/resume 兜底);checkpoint 恢复把已完成工具结果灌回 subHistory(不重执行),但其 `role:'tool'` 消息内容来自 `truncateToolResult` 截断版——后续轮次若 provider 需要完整工具结果原文,它会从截断版推断(与正常履带行为一致)。


## 32. 第 33 波:安全收口--全 GET 面 host 校验 + 声明式 auth 路由表 deny-by-default(2026-07-13)

**背景**:第29波 backlog #0("DNS-rebind 对只读 GET…需全 GET 面 host 校验单独立项")+ 早期审计声明的"声明式 auth 路由表 deny-by-default"杠杆(治 S0 教训 opt-in 名单根因)。与"政企可审计、气隙优先"定位直接冲突的定位级缺口。

**核实出的缺口**(主会话逐 handler 亲核,非转述):
- **缺口 A(定位级)**:`hostAllowed`(Host 头校验)只在 `originOk` 内调用,而 `originOk` 仅在 `handleApi` 的 `if (mutating)` 块强制 -> **GET 请求完全跳过 host 校验**。HTTP handler 顶部无任何 host 门,`serveStatic('/')` 把 **token 明文注入 index.html** 服务给**任意 Host 头**。攻击链:rebinding 页导航到 `http://evil.com:PORT/` -> 拿到 index.html -> 从 DOM 读出 token -> 以同源 + token 打任意路由(token 随 HTML 明文下发的精确根因)。
- **缺口 B(活跃泄露)**:`GET /api/agent-roles`、`GET /api/agent-workflows`、`GET /api/playbooks` 均在 mutating-only 的 `needsToken` 里(GET 不生效),handler 无 tokenOk 自查,不在 `uiReadRoute` -> **无 host 门 + 无 token 门**,rebinding 页无需 token 可直接读(角色定义/DAG/剧本,含项目结构)。对照:sessions/skills 早经 P1#1 修;memory/agent-runs/checkpoints/audit 等 14 处 handler 自查 tokenOk(token 门在,host 门缺)。
- **缺口 C(结构性)**:`needsToken`/`uiMutatingRoute`/`uiReadRoute` 三条 OR 链 + 14 处散落自查 = opt-in 名单,新路由默认无防护(S0 教训)。缺口 B 正是因此漏掉 3 个 GET。

**交付**(`docs/WAVE33-AUTH-DESIGN.md` 设计稿+7 条红队;server.js 3 处 edit + 1 新 e2e):

- **Part A 顶层 hostAllowed 门**(server.js http.createServer handler 顶部):`if (!hostAllowed(req)) return 403` 覆盖 `/health` + `/api/*` + `serveStatic` 全部。rebinding(Host=evil)-> 403 含 index.html(断 token 泄露主链);loopback(所有合法调用方)-> 通过。**3 行,近零风险**。
- **Part B 声明式 `ROUTE_AUTH` 表 + `authorizeRoute` + deny-by-default**(server.js tokenOk 后):表 `{m,p,auth,prefix?}`,auth ∈ `open`/`origin`/`token`/`token-browser`/`body-token`。`authorizeRoute` first-match 判定,HEAD 归一为 GET,未匹配 -> `'route not authorized'`(403)。**替换** handleApi 鉴权块(原 `mutating`/`needsToken`/`uiMutatingRoute`/`uiReadRoute` 三条 OR 链)为单次 `authorizeRoute` 调用。
- **3 个 GET 收紧**:agent-roles/agent-workflows/playbooks 标 `token-browser`(浏览器须 token,loopback 须同源,与 sessions/skills 同纪律)。
- **14 处 handler tokenOk 自查保留**作纵深(表为主、自查兜底误分类;唯一残留风险 false-deny 由 e2e 兜)。
- **鉴权级别语义逐字对齐现状**:`token-browser` 非浏览器分支走 originOk(loopback 过、无需 token)= dns-rebind test 5 loopback 豁免纪律,保持不变。

**e2e**(新 `dev-harness/auth-deny-default.e2e.js`,9126,28 断言 ALL PASS):A 段顶层 host 门(rebinding 拦 GET / 与 /api/status、token 不泄露、loopback 不受影响)+ B 段 deny-by-default(未声明路由 403 非 404)+ C 段 3 个 GET 收紧(浏览器无 token 403、有 token 200、loopback 豁免、rebinding+token 仍 403)+ D 段鉴权级别回归(open/token-browser/token/body-token 全语义保持)。

**回归**(14 件 e2e):dns-rebind/test5 loopback 豁免保持 200、autonomy-durability、autonomy-shell-sandbox、transient-repro、playbooks、workbench-memory、mission-driver、autonomy-grant(更新 S1/S2 静态锁指向 ROUTE_AUTH)、meta-guard(更新 D 段静态锁指向 ROUTE_AUTH + 锁 3 个 GET 标 token-browser + deny-by-default)、audit-w23、usage-ledger、rewind、monitor-incremental **全绿**。capabilities 1 失败为**预存 identity bleed**(system prompt 含 "Claude",stash 回退到 70c2c22 干净 HEAD 同样失败,与鉴权改动无关)。

**诚实交代**:token 仍随 HTML 明文注入(Part A 后 rebinding 拿不到 index.html 故拿不到 token,但同源合法 UI 仍从 DOM 读 token=设计如此;改 sessionStorage/cookie 注入动前端契约,择期);14 处 handler 自查未移除(表已覆盖,保留纵深更安全,单独清理波);`toolCall()` 40+ 分支表驱动仍为结构演进单独立项;OPTIONS 无 CORS 支持(产品本地回环无需求),deny 合理。

**至此安全收口主线(23 波 mutating 面 + 33 波全 GET 面 + 声明式表)闭环**。

---

## §31 第34波:CI 基建(零依赖串行 runner + GH Actions + KNOWN_FAILURE 机制)

**背景**:113+ e2e 全靠主会话手工挑件串行跑,盲区大(只跑熟悉的件),各波回归靠记忆+grep 核实 file:line。杠杆最大的一波--做完后续每波改动自动验,不再依赖主会话人力兜底。

**现状核实**(亲验,非转述):
- e2e 116 件;退出码全部统一(`process.exit(fail?1:0)`);入口 100 件 IIFE + 1 件 main() + 7 件 .static 纯静态锁 + 8 件其它结构;**0 件动态端口**(全固定 8751-9126)。
- **无 runner / 无 .github/workflows / package.json 无 test 脚本**。
- **真 key/live 依赖仅 3 件**:deepseek-live + deepseek-tools(均 argv[2] KEY,真调 DeepSeek API)+ desktop-bridge-live(真 Python MCP 子进程)。grep `argv[2].*KEY` 确认,不靠文件名猜。
- **README 端口表漂移**:仅登记 26 个端口(8792-8999 段),e2e 实用 116 个唯一端口(8751-9126)-- **90 个未登记**(各波新件忘补,L3 对账待做)。

**交付**:

- **`dev-harness/run-all.js`**(零依赖,Windows-first):遍历 *.e2e.js,排 SKIP(3 live),快通道(.static 秒级)先跑,串行 spawn,超时 taskkill /F /T /PID 杀整进程树(防 server.js 孙进程残留占端口),汇总+失败 tail。退出码 fail>0 -> 1。支持 `--fast` / 指定件。
- **`npm test`** 加入 `ruyi-workbench/package.json`(`node ../dev-harness/run-all.js`)。
- **`.github/workflows/e2e.yml`**:windows-latest + node 20(对齐 engines),push/PR 触发,失败上传 artifact。不进发行包(气隙优先零冲突)。
- **SKIP 名单**:3 件 live,附判断依据(grep argv[2] KEY),不靠文件名猜。
- **KNOWN_FAILURE 机制**:积压回归失败不计红(不挂 CI),报告标 [known-fail];PASS 标 [unexpected-pass] 提醒清理。每条附原因--名单非永久豁免,修好即删。

**全量首跑暴露的 8 失败件**(CI 全量覆盖 vs 手工挑件的核心价值):

| 件 | 性质 | 处理 |
|---|---|---|
| deepseek-tools | SKIP 遗漏(真 live,401 无 key) | ✅ 修正 SKIP 名单 |
| failover | 断言漂移(version 1.4.0,实际 1.6.0) | ✅ 1 行修(1.6.0) |
| git | 断言过时(.diff-add/.diff-del 已用 var(--ok-bg)/var(--danger-bg) 语义令牌,断言仍查手写 color-mix) | ✅ 更新断言(语义令牌,v3 P1 收敛) |
| usage-dashboard | 断言过时(v3 §B2 simple 模式 6->4 隐藏 usage/audit,断言仍期望不隐藏) | ✅ 更新断言(§B2 行为) |
| ui-v3-p1 | color-mix 手写(styles.css:1462 ghost-danger hover,第23波,违反 v3 P1;需 UI 决策:轻量 hover 令牌选择) | KNOWN_FAILURE |
| capabilities | system prompt 含 "Claude"(identity bleed guard;buildProviderSystemPrompt 函数体无 Claude,注入源在调用方拼接,待排查) | KNOWN_FAILURE |
| session-index | PATCH/DELETE /api/sessions/:id 被 auth 表 deny(第33波 deny-by-default 漏 PATCH/DELETE 条目,e2e 用真实方法命中 deny;前端用 POST+x-http-method override 故生产未挂)-> 9 处回归 | ✅ 第35波修(auth 表补条目) |
| workspace-resolve | PATCH /api/sessions/:id cwd 持久化 3 处回归(与 session-index 同源:auth 表漏 PATCH) | ✅ 第35波修(同上) |

**诚实交代**:
- CI 验的是**代码不回归**,不是"产品在气隙环境跑通"(发行包/`package:offline` 的事)。
- 3 件 live 诚实排除,不假装能跑。
- 4 件 known-failure 是积压回归(CI 全量首跑暴露,之前手工挑件从未覆盖);第35波已修 session-index/workspace-resolve(auth 表 PATCH/DELETE 覆盖缺口),余 2 件(capabilities/ui-v3-p1)后续波修;KNOWN_FAILURE 机制防 CI 永红,unexpected-pass 提醒清理。
- README 端口表漂移 90 个未登记(L3 端口对账检查待做,治"各波新件忘补登记"卫生债)。
- 首次 CI(真 windows-latest)大概率暴露几件本机能跑、CI 环境跑不了的件(路径/时序/端口残留),第 2 步就是用来发现并修的。

---

## §31 第35波:auth 路由表补全 PATCH/DELETE 覆盖(第33波 deny-by-default 回归修复)

**背景**:第34波 CI 全量首跑暴露 session-index(9 fail)+ workspace-resolve(3 fail)。根因不在 PATCH 逻辑,而在第33波引入的声明式 auth 路由表(ROUTE_AUTH,deny-by-default)。

**根因(亲验)**:ROUTE_AUTH 表为 4 个 prefix 路由加了 `POST` 条目(供前端 `POST + x-http-method: DELETE/PATCH` override 命中),但**漏了真实 `PATCH`/`DELETE` 方法条目**:
- `PATCH /api/sessions/:id`、`DELETE /api/sessions/:id`(handler server.js:14131/14137 显式支持真实方法)
- `DELETE /api/playbooks/:id`(handler :13827)
- `DELETE /api/agent-workflows/:id`(handler :13941)
- `DELETE /api/memory/:id`(handler :14109)

表 deny-by-default(authorizeRoute 未匹配 -> 'route not authorized' -> 403),故真实 PATCH/DELETE 全被拒,handler 分支成死代码。e2e 用真实方法(`reqJson(...,'PATCH'/'DELETE',...)`)命中 deny -> 9+3 处回归。

**生产影响**:无。前端(app.js:733/739/2875/6383)对这 4 路由统一用 `POST + x-http-method` override,匹配 POST 条目,故 UI 正常;仅 `DELETE /api/agent-runs/:id`(app.js:2974)用真实 DELETE,该路由表里已有(line 1476)。但 handler 既显式支持真实 PATCH/DELETE,表应与之对齐--HTTP 契约一致性,且正确 HTTP 客户端(非仅本前端)发真实方法应能工作。

**修复**:ROUTE_AUTH 补 5 条(auth 级别与对应 POST 一致,无安全弱化):
```
{ m: 'PATCH', p: '/api/sessions/', auth: 'token-browser', prefix: true },
{ m: 'DELETE', p: '/api/sessions/', auth: 'token-browser', prefix: true },
{ m: 'DELETE', p: '/api/memory/', auth: 'token-browser', prefix: true },
{ m: 'DELETE', p: '/api/playbooks/', auth: 'token', prefix: true },
{ m: 'DELETE', p: '/api/agent-workflows/', auth: 'token', prefix: true },
```

**验证**:session-index ALL PASS(原 9 fail)、workspace-resolve ALL PASS(原 3 fail)、auth-deny-default ALL PASS（真实 PATCH/DELETE 五路均验证：无 token 403、带 token 到达 handler）、playbooks/workbench-memory ALL PASS。从 KNOWN_FAILURE 移除这 2 件。

**诚实交代**:
- 这是第33波 deny-by-default 表的覆盖缺口(不是 PATCH 业务逻辑 bug);第34波 CI 全量覆盖才暴露(之前手工挑件从未跑到 session-index/workspace-resolve 的真实 PATCH/DELETE 断言)。
- playbooks/agent-workflows/memory 的 DELETE 真实方法现由 `auth-deny-default` 覆盖：浏览器无 token 为 403、带 token 必须穿过 auth 表并到达既有 handler。
- 余 2 件 known-fail(capabilities identity bleed / ui-v3-p1 color-mix)后续波修。

---

## §31 第36波:v1.7 评审批收口(10 bug 修复 + 护栏补齐 + 漂移清零 + CI 对齐)

**背景**:四路并行深度评审(后端 17.5k 行/前端 8k 行/ACC 9.1k 行/测试打包基建,关键论断主会话逐条对照源码核实)产出 B 表 10 个确认 bug + 一批一致性欠债。本波 = v1.7 全部计划一次落地:修 bug、补护栏、收漂移、capabilities 从 KNOWN_FAILURE 毕业、CI 版本轴对齐。**除标注的 office_open 一处偏差(理由在案)外,评审清单全量执行。**

**ACC v1.8.3(版本三处 + smoke_registry 钉同步 bump;`tests/smoke_v183.py` 29 断言 ALL PASS,全部真文件往返/真进程):**

| 修复 | 位置 | 要点 |
|---|---|---|
| read_file max_bytes 字符/字节错位 | tools/filesystem.py | 文本模式 f.read(n) 读的是【字符】却按字节判截断:中文 UTF-8(1 字≈3 字节)会"内容已全量返回却误报 truncated"或读入 3 倍承诺字节。改二进制读 max_bytes+1 自证截断再 decode(errors=replace 容错边界半字) |
| list_directory 递归封顶失效 | tools/filesystem.py | break 只跳内层循环,os.walk 继续,每目录多塞 1 条可超 1000。硬停 + 如实标 `capped:true`(glob 分支同标) |
| ocr_click nth 越界自矛盾包络 | tools/ocr.py | ok:true+error 并存,_normalize 信任显式 ok 键 → 失败的消歧被当成功。改 ok:false(执行拒绝)+found:true(查询有果)+candidates,符合 ok 语义分层契约 |
| launch_application wait 卡死 | tools/application.py | wait=True 复用 2 秒 ready_timeout 当进程等待上限,同步等待几乎必 timed_out。新增独立 wait_timeout(默认 120s 钳 [1,600]),超时如实回显预算 |
| 审计值脱敏 | tools/audit.py | 原只按【键名】脱敏,run_command 命令行里的 password=/Bearer/sk-/JWT/ghp_ 原文落盘。新增 _SECRET_VALUE_PATTERNS 值级擦除;**顺序敏感**(token 形状先于 generic key=value,否则 "Authorization: Bearer abc" 的 Bearer 被当值吃掉、令牌泄漏——评审级发现,已注释防回潮) |
| update.bat 布局脱节 | installer/update.bat | 写死旧 venv 布局,Full 包(hydrated runtime\python)用户跑增量更新直接"未安装"。改双布局探测(runtime\python 优先,venv 兜底) |
| 输出路径护栏×2 | tools/capture.py, desktop_extra.py | window_screenshot.output_path / get_clipboard_image.save_path 补 protected_path_reason(与 write_file 族同闸,allow_protected 覆盖) |

**server.js(v1.7):**

| 修复 | 位置 | 要点 |
|---|---|---|
| serveStatic 前缀子串 bug | :1663 | `full.startsWith(normalize(base))` 与作者在 :3322 亲自批评的 classic prefix bug 同款(public-evil/ 兄弟目录可越界)。改复用 pathWithinRoot 段比较 |
| settings.model 越权删除 | syncClaudeCliSettings | 工作台无 model 时 `else delete settings.model` 把用户手写配置一并抹掉,与该函数 "MERGE: existing keys are preserved" 契约直接冲突。改**权属 sidecar**(dataRoot/claude-settings-sync.json 记录上次同步值,仅当 settings.model 仍等于该值才删=只删自己写过的);sidecar 缺失(老版本首升)宁可留一次陈旧值不误删 |
| freeStalePort 误杀面 | :16272 | `image:node` 分支会 taskkill【任何】占口的 node.exe,与头注 "never clobber someone else's app" 矛盾。补 processCommandLine 取证(CIM 拿 CommandLine+ExecutablePath):仅当指向本应用 server.js 全路径,或 server.js 与 Ruyi/WinClaudeWorkbench 发行目录同现(打包 runtime\node 相对路径形态)才处死;证据不足一律 blocked(安全方向) |
| desktop_screenshot 越界写 | toolCall | 模型给定 outputPath 无围栏(bypass 模式唯一防线缺失)。补 guardFileToolPath 写闸;**缺省落 generated/ 不过闸**(generated 属 isSensitiveDataPath 敏感名单,应用自选路径会被自家闸误拒——注释在案) |
| uiMode 回退漂移 | normalizeConfig | 非法值回退 'pro' 但 defaultConfig 是 'simple'(两处默认不一致,损坏配置把普通用户扔进开发者面)。对齐 'simple';ia/uimode-style 两件 e2e 断言同步翻 |
| orchestrate maxItems 三处漂移 | schema vs 实现 vs 注释 | schema maxItems:32、实现 slice(0,64)+clamp 1..64 默认 48、两处注释写 32。统一:schema 64 + 注释全改 64/48 |
| D6 主动检索指引名存实亡 | buildProviderSystemPrompt | 判定"web_search 已 offer"是自适应装载前语义;toolLoadingMode:'auto'(默认)下 web pack 未被消息关键词激活时 web_search 不进首批 schema → 该行**永不渲染**。改"目录可用"口径(toolRequirementsMet: network+searchBackend 全满足),离线语义不变 |

**office_open 不加读闸的偏差决策(记录在案防复报)**:打开的文件内容不回流模型(无 S3 外传通道),"打开桌面/下载里的文档"正是非程序员用户的正当主流程,读闸会误杀;模型可控路径的风险面是命令注入(S2 已修)与关联程序执行,后者由 exec tier 弹窗/授权书把守,与其它 exec 工具同级。注释已落在 toolCall 分支。

**capabilities 毕业(真相与挂账不同)**:KNOWN_FAILURE 挂账的"identity bleed(system prompt 含 Claude)"实测**早已不过**——当前真正失败的是 W1a 断言(上面 D6 行)。修 D6 后 48 断言 ALL PASS,名单删除(剩 ui-v3-p1 唯一挂账)。

**端口登记表漂移根治(机制替代人肉)**:README 登记 26/实际 186(第34波亲验 116,仍在涨)。①`run-all.js` 启动即做**端口唯一性审计**:手写状态机剥注释(字符串态含转义,模板串整体视为字符串,合法 JS 无字符串外裸 //),扫 8700-9199 带内数字字面量,跨文件撞车 exit 2 拒跑——占用即声明、撞车即红、零登记动作;负向自测(临时撞口文件→exit 2+人话报错)。②**12 处真实撞车全迁移**(注释假阳性由剥注释自然消解):session-index→9135/6、transient-repro→9137/8、artifacts G 段→9139/40、onboard PORT2→9141(保住 capabilities 8998 死端口语义)、context-window→9142/3、source-fields→9144/5(消除与两件 live 件共用)、mcp-bridge fake→9146、perf→9147、playbooks dead→9148、resume-dangling→9149、tools-v3→9150/1、search-robust→9152、mcp-config disabled→9153。13 件重跑 ALL PASS。③README 表改"描述性",检查单去登记化。

**CI 对齐**:e2e.yml Node 20→24(与 build:exe node24/本地开发同轴,此前三轴不一);新增语法门 step `dev-harness/syntax-gate.js`(node --check 覆盖 151 个一手 JS;依赖 Node≥22 的 --check ESM 自动探测,app/public 是 ESM——版本轴对齐是它的前置)。

**漂移收口**:README "约 1.4 万行"→"1.7 万+ 行"(实测 17,546);ACC v1.8.2→v1.8.3 引用 6 处(根 README×4、ACC README、ADMIN-GUIDE×2);APPLY-PYTHON-UPDATE.md 改 v1.8.3 双布局 + 本批修复清单;ACC README 补 v1.8.3 章节。

**e2e 回归锁(本波新增/扩展)**:
- `v17-review-fixes.static.e2e.js`(快通道,29 断言):S1-S9 源码锁(绝迹断言+新机制断言双向)+ pathWithinRoot 单元矩阵(public-evil 兄弟目录形核心用例)。
- `port-fallback.e2e.js` Phase 2:无辜旁观者(非工作台 node 服务)占口 → 工作台**拒杀**并让位退出,旁观者全程存活(旧码必误杀);全新 HOME2 杜绝 pid 回收偶发。
- `e2-append-system-prompt.e2e.js` (d1)(d2):手写 settings.model 跨 boot/跨回合存活 + sidecar 落 model:null;权属可证时删除照常 + 无关键保留。16 断言 ALL PASS。
- `run-all.js` 端口审计(自检:全量 187 端口零撞车)。

**验证汇总**:ACC smoke_v183 29 断言 + smoke_registry/v16/v161/v17/v171/v18/v13 全 PASS(smoke_v15 失败为**预存环境项**:子进程 PYTHONPATH 怪癖,git stash 干净树同样失败,与本波无关);capabilities 48 断言 ALL PASS;13 件重港件 ALL PASS;port-fallback/e2-append/v17-static 全绿;**全量 127 件:126 pass / 0 fail / 1 known-fail(ui-v3-p1 预存)/ 0 unexpected-pass**(3 live 件按单跳过)。

**诚实交代**:
- ui-v3-p1(color-mix 手写)成唯一挂账,需 UI 决策,不属本波。
- sidecar 权属机制首升时会留一次陈旧 model(无法证明权属宁留勿删),第二次清理即自愈——取舍记录在注释。
- 端口审计只覆盖 8700-9199 测试带;字符串内端口字面量计为占用(真引用),注释提及不计——语义正确,但若未来有人用 `String.fromCharCode` 拼端口则逃逸(接受:工程约束非对抗场景)。
- smoke_v15 预存环境失败(子进程 reportlab 屏蔽测试在本机 PYTHONPATH 下找不到包)未修——与本波无关但记录,后续波查。
- office_open 与评审建议的偏差是实地判断(读闸会误杀正当主流程),非漏做。

---

## 33. 第37波:cmd8191 三部曲(P0 防线 → P1 根治 → P2 信道分离)+ CI 连红扑救

**背景**:Windows 上 npm 安装的 claude CLI 是 cmd shim,Node spawn 不经 shell 起不了 .cmd;且整行命令经 cmd /d /s /c 转述时有 cmd 元字符注入面(实测 issue cmd8191)。三部曲收根治本,顺带扑灭 CI 连红 5 个提交的基建大火。

**P0 防线**:cmd 整行预算 7900 字符 + 超长降级阶梯(砍索引→砍账本→砍政策尾,保用户 append)+ `%!` 全角中和;降级/溢出全留审计痕。
**P1 根治**:`resolveClaudeLauncher` —— npm shim 相对解析出 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`,真身 --version 探测通过才接管,60s memoize;收拢在 normalizeConfig 咽喉点,六个消费方(runClaudeTurn/子代理/mcp add-json/doctor 等)一致受益;运行时替换不落盘,exe 消失自动回落;解析不出**原样返回行为逐字节不变**。cmdLineBudgetFor 按扩展名分档,exe 直启后预算 7900→32000,降级阶梯近乎不再触发。
**P2 信道分离**:稳定索引段(技能/记忆/编排提示)从 --append-system-prompt 迁出,改走 stdin `<workbench-context>` 块按内容 hash 一次性注入;命令行只留用户 append + 账本 digest + 政策尾。五规则:resume 连续+hash 不变跳过;无 resume 每轮必注;slash 不注不污染 hash;进程未启动清 hash;init 暴露静默 resume 丢失清 hash 下轮自愈。**附带收益:预算耗尽不再截肢技能索引(该降级面整类消失),索引原文注入路径保真**。

**测试抓出的两个真 bug**:注入块导语字面写 `<current_user_message>` 被 fake 误当定界起点(导语去角括号 + 提取取 LAST 匹配双保险);注入内容含 `orchestrate_agents` 命中 fake 场景关键字把 ask 场景抢走(fake 改只从真正用户消息定界段选场景,顺带修掉 recoveryHistory 旧消息污染场景的存量盲区)。

**CI 扑救(与 cmd8191 无关但阻塞一切)**:Node 24 拒收 require+顶层 await 混用(62 件秒崩 → 整文件包 async IIFE);9642e26 端口 codemod 批量破坏(11 件重复 const/6 件 TDZ/6 件作用域丢失/9 件不可单行修 → 回滚静态端口已知良好版);run-all.js bucket 驳回静默吞整桶结果(假绿漏洞 → 驳回入账)。

**验证**:claude-exe-resolve.e2e(13 断言)+ index-dedup.e2e(15 断言);全量 127-128 pass / 0 fail / 1 known-fail。提交 7b29790(基建)+ 79873d4(P1)+ 87415cc(P2,提交信息误标"第35波",以此节编号为准)。

---

## 34. 第38波:v1.9「轻装机」第一波 —— 数据管家(Storage Steward)

**背景**:运行时资源审计(实测+代码锚点)发现存储半数仓无自动清理:logs 按日滚动永不删、sessions 无上限、agent-runs append-only(单 run 可达数十 MB)、webcache 无 TTL;唯一完整的容量闭环是 checkpoints(单条 5MB 跳过/每会话 20 轮/全局 200MB 硬顶)。本波把该闭环模板推广成统一保留策略引擎。

**交付**:
- `storagePolicy` 配置三项全 clamp:日志保留天数 [7,365] 默认 30、事件日志压缩天数 [0,365] 默认 14、网页缓存上限 [0,100000] 默认 0=**不限**(尊重 v0.9-S9「离线无价」承诺,自动清理仅用户 opt-in)。
- `collectStorageStats`:13 仓 bytes/files(10 万文件防爆截断)+ 引擎转录只读统计行。
- `storageSweep`:boot 自动(fire-and-forget 不阻塞启动)+ 手动单目标;进程内串行;动作落审计账 `storage_sweep`。日志按**文件名日期**保留(不依赖 mtime);真终态 run 事件日志超期 **gzip 归档**(可读,体积 ÷~10,tmp+rename 原子,幂等);**interrupted 可续跑/paused 等人/running 活着一律不碰**;readAgentRunEvents 透明读 .gz,删除运行记录连带删 .gz。
- 前端「存储」页签(**仅专家界面**,简易模式 CSS 隐藏 + DEV_TABS 兜底):数据目录总计、各仓占用表、保留策略表单(clamp 后回显)、立即清理。懒加载不轮询,DOM 全 textContent。

**验证**:storage-steward.e2e 30 断言(clamp/日期保留/gzip 归档+回退全读/paused 不压/webcache 默认不限+opt-in LRU/单目标隔离/幂等/HTTP 403/策略持久);ia.e2e 开发者组清单 5→6;autonomy-durability tmp 写点静态锁 3→4(归档二进制写与检查点回滚同类豁免)。全量 129 pass / 0 fail / 1 known-fail。提交 12c3722。

---

## 35. 第39波:v1.9 会话存储 v2 + 引擎转录 GC —— 写放大 O(N)→O(增量),688MB 无主之仓收口

**背景**:审计两大单项:① saveSession 每轮全量序列化+落盘 O(会话总历史)/轮,5MB 会话=每轮写 5MB,写放大随使用时长线性恶化;② `~/.claude/projects/` 引擎转录实测 **688MB**(单项目最大 333MB)完全无人管理 —— claude 引擎每会话/每子代理留 jsonl 转录,工作台知道自己的 claudeSessionId 却从不清理。

**会话存储 v2(head JSON + append-only NDJSON 正文)**:
- `<id>.json` 头(标量/小字段 + messageCount/providerHistoryCount + storageVersion:2,每次重写但极小);`<id>.messages.ndjson` / `<id>.provider.ndjson` 正文,一行一条,append-only。
- 快路径:进程内状态表存每行 sha1-16,save 时前缀逐行重算比对,只在尾部增长 → 每文件一次 append **O(增量)/轮**;任何前缀变化(rewind/compaction/pop/蒸发改写)/状态缺失/上次失败 → 自动降级全量重写。**不靠调用方自觉打标记,失配只损性能不丢数据**。
- 崩溃三防线:append 中途崩溃 → 无 \n 终结的撕裂尾行**物理截断**(否则下次 append 把新消息焊进坏行→整会话判 corrupt 真丢数据);append 完成头未写 → 头是提交点,多出行为未提交尾巴按头计数截断;慢路径(全量重写)崩溃 → .prevbody 快照恢复与旧头重新配对(头计数==正文行数时 prevbody 是陈旧快照不恢复)。
- v1bak 懒迁移:legacy 单文件首次 load 原样备份(COPYFILE_EXCL 防覆盖回退锚),v2 下次成功读取后自动删;坏正文隔离 .corrupt 与旧单文件损坏同纪律。
- 实测真实会话 2.78MB 单文件 → 1.7KB 头 + 正文,逐字节回读一致。

**引擎转录 GC**:白名单账本(本工作台 spawn 的 claudeSessionId 才可清)+ 活引用扫描(会话存活引用不清)+ 保留期。**红线:账本外转录绝不触碰(那是用户 Claude Code 自己的数据),专测锁死**。

**验证**:session-storage-v2.e2e 48 断言(快路径/降级/撕裂/未提交尾/prevbody/v1bak/转录 GC 红线);resume-dangling/e3/mission-driver/session-index/agent-workflow-ui-progress 五件带外注入迁移 v2 布局(头不再内联 messages/providerHistory,注入=写正文+同步头计数)。全量 129 pass / 0 fail / 1 known-fail。提交 f3c19a5。

---

## 36. 第40波:v1.9 收尾 —— 债务清零(KNOWN_FAILURE 空表)+ boot 恢复并发化 + 性能观测面

**背景**:v1.9「轻装机」封版波。清掉最后两项挂账,把第39波审计承诺的两个 P1 项落地。

**P0 债务清零**:
- ui-v3-p1 双 FAIL 毕业:① ghost-danger hover 手写 `color-mix(danger 12%, transparent)` → 新令牌 `--danger-veil`(两主题对称;透明基底 —— ghost 按钮可坐任意面,不能用 --danger-bg 的 panel 不透明底,与 --panel-veil 同族命名);② 「发送⇄停止 SVG」静态锁是 i18n 化(`t('common.stop')/t('chat.send')`,zh-CN 解析已核验)没跟上的陈旧形状,锁迁移非代码修。**KNOWN_FAILURE 名单清零(空表),机制保留**。
- smoke_v15:GBK 控制台下裸跑(未按文件头 -X utf8)时,打印含 •(U+2022) 的回读样本抛 UnicodeEncodeError,被 readback 的 broad except 吞成「测试失败」—— 控制台编码问题伪报产品缺陷。stdout/stderr reconfigure errors='backslashreplace',print 永不抛;子进程侧(-X utf8 + PYTHONIOENCODING + PYTHONPATH)经查已正确,无需动。
- §4 性能波回填:PF1/PF2/PF6 实际早已交付未登记(journal 增量缓存/会话索引/流式增量 appendData),已在 §4 补交付注记。

**P1 boot 中断恢复并发化**:旧状 = markInterruptedAgentRuns/autoResumeInterruptedRuns 双扫描顺序 for,且 syncRunEventSeq 对每个 run **整读** events.ndjson(长跑 run 可达数十 MB)→ N 个中断 run = 数百 MB 顺序盘 IO。三改动:① syncRunEventSeq 尾窗化(>512KB 只读尾窗,seq 单调且 append 串行故最大值必在尾部;窗内无 seq 的巨单行极端 → 回落全读保正确;同一 scanMax 函数保证两路径逐字节同语义);② 双扫描工作项化 + mapPool(4) 并发(run 级相互独立:写链/事件链按 run.id 串行,live 复检纪律原样保留);③ launchPersistedAgentRun 接受 configOverride(boot sweep 传入已读 config,免 N 次 readConfig 盘 IO;人工 HTTP resume 不传 —— 必须读新鲜 permissionMode)。

**P1 /api/metrics 性能观测面**(ROUTE_AUTH token 门,专家界面存储页签下段):① 请求耗时 —— createServer 顶层插桩,进程内环形(300 条)零持久化,6 桶直方图 + slowest top8;路径归一化(sess_/run_/hex id → :id,观测面不落会话 id);**/health 不计数**(高频探针会淹没真分布)。② 进程内存 —— 自身 memoryUsage + 在册子进程(activeChildren 引擎回合/mcpClients 桥接)pid 清单,RSS 经一次 tasklist 全表匹配(仅 win32,失败降级 null)。③ 存储趋势 —— summary/metrics 被取时 ≥1h 节流追点,storage-trend.json 240 点封顶(≈10 天),缺文件 = 空史不硬失败。

**验证**:boot-resume-parallel.e2e 16 断言(mapPool 并发度+wall-clock 反串行证明/尾窗==全扫/巨单行回落/撕裂同语义 + 真 boot 6 run 全标 interrupted 且 run_interrupted 精确落 seq 1001[错号会落 991]+ autoResume 分级两分支);metrics-panel.e2e 19 断言(归一化/分桶/环形封顶/节流 + 403/字段齐/health 不计数/趋势落盘)。ui-v3-p1 毕业后 ALL PASS 并移出名单。smoke_v15 裸跑与 -X utf8 双绿。

## 37. V2.0「立柱」总体规划(2026-07-18 立项)—— 结构债付清 + 上下文压缩 v2

**定位**:付清结构债(18K 行单文件复利风险)+ 把压缩体系从「健全但有死角」做到「无死角可度量」。
**不变红线**:运行时产物单文件、零 npm 依赖、气隙可审;每波带对抗轮 + 验收 e2e。

### 37.0 上下文压缩现状评估(V2.0 立项依据)

两套体系 **API 和 CLI 不通用 —— 有意设计**,但留下真实缺口:

| 维度 | Provider(API)引擎 | Claude(CLI)引擎 |
|---|---|---|
| 自动压缩 | ✅ 完整两级:迭代边界检测(阈值 0.8×窗口)→ L1 蒸发旧工具结果(原地、幂等、append-only 保前缀缓存)→ L2 摘要重播种(保留最近 2 个完整回合逐字) | ❌ 服务端零介入,完全依赖 CLI 自管(有意不对称) |
| 手动压缩 | ✅ `/api/provider/compact` 与自动 L2 共用同一摘要内核 | ✅ 前端发 `/compact` 斜杠命令,CLI 自己压 |
| 子代理 | ✅ `maybeCompactSubHistory` 镜像两级 + 原始任务钉入摘要 | ❌ 一次性 spawn,无压缩(有意) |
| 超窗兜底 | ⚠️ 子代理只分类报错;**主回合对 400-context 无恢复路径** | ❌ **主回合 prompt too long = 回合直接失败** |

**做得好的**:token 估算 CJK 感知(ascii/3.6 + cjk/1.5);蒸发幂等且保前缀缓存;摘要内核单点共用;压缩前 gz 快照;压缩调用全额记账;窗口来源四级链(手动→/v1/models 探测→名称表→64K 兜底)对小白透明。

**4 个缺陷(按严重度)**:
1. **摘要调用自身载荷无界**(死锁角):`providerSummaryCall` 把整个 history 发给 /chat/completions。history 已超窗时摘要调用自己 400 → 自动压缩每轮迭代重试都失败 → 每轮白付 60s 超时,永远压不下去。
2. **L2 失败 = 回合慢性死亡**:L2 失败后 payload 仍超预算 → 回合 API 照样 400 → 回合失败。主回合没有「400-context → 强制压缩 → 重试一次」的最后防线。
3. **Claude 引擎超窗零兜底**:子代理 context overflow 判 definitive 不重试,主回合无恢复路径;CLI print 模式是否 auto-compact **从未真机验证**(全套件建在 fake-claude 上)。
4. **摘要质量无保障也无度量**:单段中文 prompt 一次性压全史无结构,无「压缩后关键事实还在不在」的验收手段。

**结论**:要迭代,纳入 V2.0。压缩体系集中在 server.js 的 ~12400-12820 区段,模块化拆分后正好是独立 `context-governance` 模块 —— **压缩 v2 排在模块化之后**,在新模块边界内重写。

### 37.1 波次计划(总工期估 18-23 天,5 波)

**第 41 波 · toolCall() 表驱动拆分(3-4 天)**
- 41a:40+ 分支 switch 拆 6 个表驱动子分发器(file/shell/script/desktop/network/archive),每工具声明 `{name, tier, guard, handler}` —— 全量套件逐字节行为回归。
- 41b:护栏声明化,新工具忘 guard = 静态锁红(archive 漏 guard、desktop_screenshot 越界写这类事故整类消失)。
- 41c:统一上下文解析器与表驱动合流;红队 R-P1-2 的 e2e 全绿。

**第 42 波 · 测试基建先行(3-4 天)** —— 模块化和压缩 v2 的共同前置
- 42a:**静态锁大盘点 + 行为化迁移**,产出模块化成本实测报告 —— 43 波 go/no-go 决策依据。
- 42b:**真实 claude 二进制冒烟基建**(本机有真 CLI 才跑的 live 标记用例,沿用 SKIP 机制):exe 直启、stream-json 协议、权限桥握手。
- 42c:**CLI print 模式压缩行为探针**(live):构造超窗会话验证 `-p --resume` 下 CLI 是否自己 auto-compact —— 44c 的设计依据,目前是未知。

**第 43 波 · 构建期拼接模块化(5-7 天,需 42a 的 go 决策)**
- `app/src/` 拆分:config / session-store / checkpoint-journal / workspace-guard / mcp-bridge / claude-engine / openai-engine / tool-dispatcher / context-governance / http-router;零依赖 `build.js` 拼出单文件 server.js 产物。
- CI 加「构建产物与 src 一致」校验;发行包附源映射保审计面。
- **降级预案**:42a 实测超标 → 退做 43'(文件顶部目录索引 + 体积预算护栏),不硬上。
- 验收:全量套件 + 42b 真实二进制冒烟双绿。

**第 44 波 · 上下文压缩 v2(4-5 天)** —— 消死角 + 可度量
- 44a 摘要载荷预算化:摘要输入先蒸发、再按窗口 50% 预算截断中段(保头保尾);超长会话升级 map-reduce 分段摘要 → 修缺陷 1(死锁角)。
- 44b 主回合 400-context 强制压缩重试(provider 引擎,事件流如实告知用户)→ 修缺陷 2。
- 44c Claude 引擎超窗兜底(设计依 42c 探针):若 print 模式不 auto-compact → 检测 over-window → 自动 /compact 回合 → 重试原消息;子代理 over-window 允许无 resume 新鲜会话重试一次 → 修缺陷 3。
- 44d 估算自校准:API 真实 usage 反推校准系数(每 provider+model,指数滑动平均)→ 触发精度。
- 44e 结构化摘要 prompt(目标/已确认决定/未完成事项/关键文件清单四段式)+ 压缩质量评测夹具(live):长会话埋 10 个关键事实 → 压缩 → 追问,验收 ≥8 可回忆 → 修缺陷 4。
- **量化目标**:摘要调用永不因自身超窗失败;超窗 400 不再终结任何回合(e2e 自动恢复率 100%);压缩后关键事实保留率 ≥80%。

**第 45 波 · 剩余测试深化 + v2.0 封版(3 天)**
- 浏览器 DOM 冒烟(Playwright 渲染真实前端点 DAG 编辑器 —— v3 重设计首次被真实渲染验证)。
- ACC 离线回归(fake-mcp 扩关键 20 工具契约)。
- 编排盲区补测(跨节点资源死锁、loop×retry、双引擎 tier 等价、双冷 resume 窄窗测试先行)。
- 封版:CHANGELOG、路线图回填、全量 + live 三层全绿。

### 37.2 依赖图与风险

```
41(表驱动)──┐
            ├─→ 43(模块化)─→ 44(压缩v2)─→ 45(封版)
42(测试基建)─┘      ↑            ↑
                  42a go决策   42c 探针定设计
```

1. 最大风险 = 43 的静态锁迁移 → 42a 先做成本实测,有降级预案,不硬上。
2. 44c 依赖 42c 真机探针结论 → 若 CLI print 模式已自管压缩,44c 缩水为「只修子代理重试」,省 1-2 天。
3. 44 波每个子项带对抗轮 —— 压缩是「改模型能看到什么」的高危面,历史教训(field-shadow、auto-allow 放大)都出在这类判定逻辑上。

## 38. 第41波:V2.0 开工 —— toolCall() 表驱动拆分(41a)+ guard 声明化行为锁(41b)

**背景**:V2.0 第一波。toolCall() 的 50 分支 switch(14886-15580,约 700 行)是 tool-dispatcher 模块化的最大障碍,也是「新工具忘了挂护栏」事故(archive 漏 guard、desktop_screenshot 越界)的结构性温床。

**41a 表驱动拆分**:codemod(codemod-toolcall-table.js)机械搬运 —— 50 个 case 原文转入 `TOOL_DISPATCH` 注册表(9 组 `{paths, guardNote, handler}`,按 file/shell/script/desktop/network/archive 分域);toolCall 缩为 4 行查表分发;装时机重名断言(静默覆盖 = 启动即炸)。转写完整性机器证据:codemod 干跑 50/50 + 实质行多重集 diff 对消(零丢失)。

**41b guard 声明化行为锁**:tool-dispatch.e2e(18 断言)—— 内省注册表非 grep 源码形状,是 V2.0「静态锁行为化迁移」的第一个样板:每个 exec/edit 级工具必须显式声明 guard(guardNote 非空),未知工具显式 tier 而非靠兜底。首擒两条真实 drift:① `permission_prompt` 无 tier 声明(靠 unknown→exec 兜底)→ 已显式化;② **`project_snapshot` 缺读闸**(file_list/file_search/glob 同族都有,远端模型可越界列目录)→ 已补 —— 注册表的第一个实战成果。

**验证**:file-guard / autonomy-grant / v17-static / shell-session / subagent / tool-dispatch 定向回归全绿;全量套件见提交注记。

## 39. 第42波:测试基建先行 —— 静态锁收口(42a)+ 真身 CLI 冒烟(42b)+ 压缩行为探针(42c)

**42a 静态锁大盘点(43 波 go 决策已出:GO·方案A)**:机器扫描全仓 548 条源码形状断言/34 件(后端 ~150/19 件,前端 ~400/14 件)。落地 `dev-harness/src-reader.js` —— 后端「逻辑全文」统一读取口(今天读单体;43 后自动按 manifest 拼接),19 件后端锁测试 codemod 迁移 + 全绿,unit//产品代码零直读残留。报告:docs/STATIC-LOCK-AUDIT.md。决策:43 走「有序切片+构建期拼接+产物字节级不变」,548 锁零迁移;硬约束五条(声明顺序保序/顶层声明边界下刀/产物无 banner/run-all freshness/CI build 幂等)。

**42b 真身 claude 二进制冒烟(claude-binary-live.e2e.js,SKIP 登记手工跑)**——首战即擒【线上真 bug】:
- 覆盖:① resolveClaudeLauncher npm shim→真身 exe(顺带校正:resolver 只对批处理 shim 动手,裸名经 isBatchLauncher 门原样返回,镜像 detectClaudePath 语义);② 直启 --version;③ stream-json 握手(init/result.success/usage/session_id 四要件);④ 权限桥端到端(真 CLI+permissionMode=default→permission_request→批准→tool_result 真 PID)。
- **擒获:CLI ≥2.1 的 --permission-prompt-tool 响应是 zod union,allow 变体必须带 updatedInput record;UI 纯「允许」时工作台回 {behavior:'allow'}(updatedInput 被 JSON 序列化掉键)→ CLI 判 invalid_union 拒掉工具 → 用户批准了权限工具照样失败**。fake-claude 全套件绿是因为 fake 不校验 schema —— 这正是 live 层的存在理由。修复:/api/permission/request 出口统一回填 updatedInput=原始输入(授权书快路径同款)。防伪纪律:断言只认 tool_result 里的真实 PID(模型文本可编造);批准要批准【每一个】请求(模型可能多次调用)。
- 过程中发现上轮断线遗留已收编:fmtBytes 共享化 + GB/TB/PB 量纲 + syntax-gate ESM 解析(ab20513)。

**42c CLI print 模式压缩行为探针(claude-compact-probe-live.e2e.js + 补刀探针)**——44c 设计依据,真机实测:
- P1:print 模式 `/compact` **可用**(resume 发 /compact → system/compact_boundary + success)→ 手动压缩退路存在。
- P2:resume 累积 ~330K tokens(turn2 in=129K + cache_read=199K)**不报错**;补刀探针(turn3 极小回合测转录大小):**input 仅 294 tokens 且暗号 PINEAPPLE-42 完整保留** → CLI 在 resume 路径上【自动压缩了转录】,且压缩质量过关。
- **结论:CLI print+resume 自管压缩,工作台主回合零兜底。44c 从「主回合+子代理双兜底」缩水为「只修子代理重试」(子代理一次性 spawn 无 resume,超窗仍是裸失败),省 1-2 天。** haiku 实测窗口 >217K(大于名义 200K,44d 估算自校准的窗口表须按实测而非名义值)。
- 成本纪律:探针为一次性决策件(~$0.5 两轮),SKIP 登记;大 prompt 走 stdin(argv 撞 Windows ENAMETOOLONG)。

## 40. 第43波:V2.0「立柱」主梁 —— 构建期拼接模块化(42a 方案A 落地)

**切片(43a/43b)**:18,485 行单体 → `app/src/` 15 模块(388-2362 行,43a 程序验证 15 个切点全部「前一行空白+切点顶格」;codemod-slice-modules.js 机械切,不手工搬)。`app/build.js` 零依赖拼接器(manifest.json 顺序 join('\n'),tmp+rename 原子写,装载首行自检)。**首轮切片 git diff 为空(字节级不变)已证**;dev-harness/src-reader.js 逻辑全文 === 产物已证;548 条静态锁零迁移存活。dev 循环实测:改 src → build → 产物 +9 行(banner),一切正常。

**接线(43c)**:run-all.js 起跑前 freshness 门(--check → 落后自动重建,失败拒跑;build.js 不存在跳门兼容单体时代);.github/workflows/e2e.yml 加 build --check fail-fast(CI 拒陈旧入库,与开发机的自动重建分工);build-overlay.js 打包前 --check + src 清单 manifest 驱动;package-offline.ps1 同款门;README 单文件叙事更新为「产物单文件,源码 15 模块」。

**43e 对抗验证轮(用户指定,3 个 agent 并行,全部只读+TEMP 实验)**——三声明(critic 独立复核全部 CONFIRMED:产物==拼接字节级/与单体仅差 9 行 banner/零 npm 依赖)+ 对抗审查擒获 8 项,全部收口:
- 【高·已修】CRLF 污染链:build.js 丢 CR 防线 → CRLF 模块静默污染产物(模板字面量换行被改写)且 CI 新门在 autocrlf 环境假阳性全红 → .gitattributes 钉 `*.js text eol=lf`(checkout 层根除)+ build.js 恢复 CR 拒绝(第二道铃)
- 【高·存量已修】overlay 前端模块漏列 4/5(FE1 只发了 icons.js,base 安装的 state/util/net/i18n 停在旧版;第42波 fmtBytes 收编后旧 util.js 缺导出 = 白屏实爆条件)→ 5 模块全列
- 【中·已修】build.js 产物零语法校验 → 落盘前 node --check(尾部半成品不覆盖旧产物);首行自检补空文件拒绝
- 【中·已修】manifest 行区间失修(banner +9 漂移)→ 回填并对当前产物自洽(18494 行全覆盖)
- 【低·已修】run-all 失败诊断吞 r.error;src-reader 单件跑无 freshness 门(拼接后全量比对产物);tmp+rename EPERM 重试+PID 后缀
- 【低·存量已修】产物含 2 个裸 NUL 字节(探测缓存键字面量)→ rg 判 binary 截断后文检索 → 改 `'\0'` 转义(语义同字符),rg 恢复全文可搜

**验证**:全量套件 134 pass / 0 fail / 0 known-fail(freshness 门工作);claude-binary-live 冒烟 ALL PASS(重建产物 × 真身 CLI × 权限桥);overlay 端到端打包实测 36 文件齐(含全部 src + 5 前端模块)。

## 41. 第44波:Claude 模型列表 API 化 + 自定义模型可删

**动机(用户反馈)**:Claude CLI 下模型选择器硬编码 5 个版本化型号(claude-opus-4-8 等),新型号发布即过时、须改代码跟进;且自定义添加的模型(extraModels/knownModels)只增不删,无任何删除入口。

**切片**:
- **44a 列表来源收口(后端)**:`MODEL_PRESETS` 砍掉全部版本化型号(claude-opus-4-8 等);版本化型号的唯一来源 = 代理 `/v1/models` 发现 + 用户自定义标注。列表构成 = 默认(CLI 配置) ∪ 代理发现缓存 ∪ extraModels ∪ knownModels ∪ config.model。**44e 修订(用户追加)**:CLI 内建别名 opus/sonnet/haiku 也出列表 —— 预设只剩「默认」一项;别名集合保留为 `CLAUDE_ALIAS_IDS` 仅作引擎归属判定(用户 knownModels/extraModels 里的别名串仍归 Claude 侧,防混入 openai 组),不进任何显示列表。
- **44b 代理发现 sidecar 缓存(后端)**:发现成功落盘 `<dataRoot>/proxy-models-cache.json`(归一化+去重+cap 50,内容没变不写盘);`offlineModelList`/`/api/status` 即时列表合并缓存 → 代理挂掉/离线启动时 API 型号仍在。**刻意不写进 config.json**:GET /api/models 是读路径,缓存合并进 config 再 writeConfig 会让陈旧全量快照与 POST /api/config 竞态互踩(25.1 对抗轮教训);sidecar 独占写点零竞态。
- **44c 编排 hint 引擎归属跟进(后端)**:`buildModelHint` Claude 组 = 别名 ∪ 代理缓存(替代原硬编码组);openai 兜底池与 `tierModelForNode` 同步排除缓存 id(缓存模型属 Claude 端,混入 openai 组会诱导 AI 选错必失败 —— 第30波对抗轮教训的延伸)。
- **44d 行内删除(前端)**:模型 chip 弹层 Claude 组里,extraModels/knownModels 来源的行尾渲染 ×(span+role=button,行本身是 `<button>` 不可嵌套);点击 = 一次 POST /api/config 从两数组移除(删的是当前选中模型则重置为默认),toast + 静默刷新。代理 API 条目不可删(端点真实清单非用户数据)。i18n 三键(zh-CN/en-US)+ `.mc-del` 样式。

**e2e**:orchestrate-model-select 静态锁/[P] 沙箱更新(tier 池 filter 新形状 + 缓存 stub 夹具 + 引擎归属断言 7 条新增);新增 claude-models-cache.e2e.js(20 断言:fake Anthropic 代理两轮——在线验证列表构成/无硬编码/sidecar 落盘且不入 config,离线重启验证缓存兜底 proxyCount=0,删除流后端半验证自定义消失缓存保留)。

**验证**:claude-models-cache ALL PASS ×2;orchestrate-model-select ALL PASS;openai-engine / agent-workflow-claude-engine 相邻回归 ALL PASS;单元 148/148。

**V2.0 剩余**:第45波 上下文压缩 v2(42c 探针已把其缩水为子代理重试)→ 第46波 测试深化封版。
