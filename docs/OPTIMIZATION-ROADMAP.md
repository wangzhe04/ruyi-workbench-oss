# 如意 Ruyi 工作台 · 迭代与优化路线图

> 本文只保留 **V2.0 封版后的近期交付（第46–52波）**、当前 Escapade 发布线与后续内部计划。
> 第1–45波的早期审计、v1.x 迭代、V2.0 立项与交付记录已移入 [优化路线图历史（第1–45波 / v1.x–V2.0）](archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)。
> 当前要排期或实施的工作，以本文「第53波起：Escapade 2.x 的内部优先级」为准。

---

## 发布线、产品代号与内部波次（2026-07-24 起）

对外发布与内部交付从现在起分开管理：**版本号告诉用户可安装、可回退、可比较的产品版本；波次只服务于研发拆解、验证和路线图追踪。**两者不再一一映射。

| 对外产品线 | 技术版本与 Git tag | 面向用户的写法 | 状态 |
|---|---|---|---|
| **Escapade** | `v2.x.y` | **如意 Ruyi Escapade 2.0**；修订版写作 Escapade 2.0.1、2.1 | 当前大版本；`v2.0.1` 为当前补丁版 |
| **Pretender** | 预留 `v3.x.y` | **如意 Ruyi Pretender 3.0** | 下一个大版本代号，尚未立项或承诺范围 |

- Release 标题使用产品名与主次版本，不加冗余的 `V`；技术 tag 保持短、稳定且可供脚本解析（当前为 `v2.0.1`）。离线包也继续用短文件名（如 `Ruyi-v2.0.1-full.zip`），避免 Full 包在 Windows Explorer 的路径预算中失效。
- `第53波`、`53a` 等只表示内部工作切片；一个 Release 可以汇总多波，一个波也可只在后续补丁版发布。只有范围冻结、测试与打包门通过后，才决定是 `2.0.x` 补丁、`2.x` 功能版本或下一主版本。
- 每个对外大版本以一个产品代号统摄体验目标；Escapade 结束前不会提前把 Pretender 的概念或版本号混入用户界面、下载名或兼容承诺。

---

---

## 近期交付基础（第46–52波，2026-07-21～2026-07-24）

V2.0「立柱」规划(§37)的 41–45 波已全部交付(toolCall 表驱动 / 测试基建 / 构建期模块化 / 模型列表 API 化 / 压缩 v2)。**后续迭代规划以 `docs/optimization-plan/` 为准**(8 路只读分析产出,5 份文档:UI 现代化 / Steer / ACC·MCP / 提示词工作流 / 附加方向),本节只做波次映射与状态钉:

- **第46波 · V2.0 封版**:§37.1 原"封版波"顺移至此——浏览器 DOM 冒烟 v1(兼 01 方案视觉回归门脚手架)、ACC fake-mcp 20 工具契约、编排盲区补测、unit/ 接 runner、CHANGELOG 封版、facts.json 起步。
- **第47波 · 快赢波**:Steer Phase A(Claude 引擎对话 steer,02 方案)+ 桥 cancel/超时契约(03 Phase A)+ S1/S3 安全 + X2 overlay 载荷锁。
- **第48波 · 地基波**:提示词护栏(04 Phase A:快照测试+落盘断言扩展+A/B 夹具骨架+预算断言)+ MCP 配置导入器 v1(03 §4.1:.mcp.json/config.toml 导入+冲突降级)+ 性能 P2(verifyManifest mtime 快路径);P1 readConfig 缓存经对抗验证回退(5 件 e2e 依赖 uncached)+ FE 拆分契约铺路(dom-contract data-testid 升级,01 Step 1 验收#5);**FE 全量拆分(01 Step 1,app.js 8175->3000 行)随 50 波视觉焕新同步推进**(01 方案自定 1-2 波,单轮实拆风险高于价值--48d 只立 testid 契约为 50 波重构铺路)。P5 端口迁移 46 波已做 103/150,余件随改动域顺手迁。
- **第49波 · 生态工具波**:ACC 质量战役 + 新工具首批(edit_file/fetch/memory/sequential-thinking)+ 远程 MCP transport + A1 后端拆分 + E4 CI 扩展。
- **第50波 · UI 视觉焕新波**:01 Step 0 收尾(UI-DESIGN-V4 定稿,v4-glass mockup 已产出)+ Step 1 FE 全量拆分收尾 + Step 2 毛玻璃铺层 + Step 3 视觉回归门/i18n 清零/a11y + **02 Phase D 插话队列可视化/插话卡静态重渲染**(前端呈现同域,47 波未做项并入)。
- **第51波 · 提示词与工作流规范化波**:04 Phase B/C/D(外置 i18n / prefix-cache 稳定分层 / 语义 loop-guard / 规范文档) + **02 Phase B 打断语义(Codex 级批次边界中断,与语义 loop-guard 同域,47 波未做项并入)**。
- **第52波+ · 发布与范式**:overlay 更新 GUI、vNext「交办台」立项决策、产品扩展评估。

依赖要点:47a 与 47b 共享 stdin/cancel 基础设施须同波;48 是 50/51 的硬前置(FE 架构→视觉焕新,提示词护栏→文本改动);49 先于 51(新工具的 description 需同步)。详见 optimization-plan/README.md §2。

### 第46波：V2.0 封版 —— 测试基建收口 + facts.json + CHANGELOG v2.0.0

§37.1 既定封版波(顺移至 46)全量交付,版本号直升 **2.0.0**(00-boot.js VERSION + package.json + package-lock 三角一致,facts 静态锁钉死)。

- **46a unit/ 不再是孤儿**:run-all 快通道最前跑 `node --test dev-harness/unit/*.test.js`(挂即拒跑);CI e2e.yml 同步独立步骤。E2 根治:`stripJsComments`/`portAuditFromDir` 抽真身到 `dev-harness/lib/port-audit.js`,runner 与两件 unit 测试同源 require(此前测的是复制重实现的副本,会随真身漂移而假绿)。顺手修 v17-review-fixes S9 静态锁跟随迁移。顺带擒获一个存量 bug:run-all 无 `--parallel` 时 argv 过滤式误删 argv[0](`--fast` 被吞跑全量、指定件清单丢第一件)。
- **46b 失败重试 + [flaky]**:失败件自动重跑一次,二跑通过记 `[flaky]`(汇总+名单+last-run.log 三处可见,沉默的 flaky 是明天的红);按件超时表 TIMEOUT_OVERRIDES 起步(scheduler-ready-queue 180s)。
- **46c 浏览器 DOM 冒烟 v1**(`dom-smoke.e2e.js`,19 断言):系统 Edge/Chrome headless `--dump-dom --virtual-time-budget` 渲染真实前端,零新增依赖(01 方案"Playwright 已捆绑"实测不成立:无 node_modules/无 npm 包/无 python playwright;视觉回归门第50波可延续同款 headless `--screenshot` 或再评估)。三层断言:静态资源全 200 / 渲染后 DOM 结构 + token 占位符已替换 / modelChip 按 /api/status 渲染(JS boot 真活)。
- **46d fake-mcp 20 工具契约**:7 → 20 件,新增 13 件镜像真实 ACC 契约(write_document/write_excel/write_pdf/write_pptx/write_file/delete_file/excel_beautify/excel_chart/chart_image/image_resize/window_screenshot/get_clipboard_image/read_file),写族真写文件、错误契约镜像(非 .pdf 报错/改写不存在报错/缺路径参数回 base64)。新 `fake-mcp-contract.e2e.js`(63 断言):P1 直连契约逐件直调;P2 workbench 集成一回合 14 步覆盖快照表全操作形(create/modify/delete/move/copy)+ 整轮回撤工作区归零;P3 静态锁【fake 写族 == BRIDGED_WRITE_PATH_ARGS 键集 15 件】("漏表=不能撤销"的 v1.1 返修教训机制化)。E6:ACC 11 个 smoke 收拢 `tests/run_all.py`(stdlib 零依赖统一入口,--ci 子集),CI 新增 acc-smoke job;顺手修 smoke_v15 存量 bug(构造了 env 没传给子进程,降级断言必挂)。
- **46e 编排盲区补测 + 双冷窄窗修复**(`orchestration-blindspots.e2e.js`,37 断言):S1 三节点传递环死锁快拒(原只有两节点覆盖);S2 loop×retry 收敛(3 尝试 × 5 连击 = 15 请求封顶,attempts=3,中止原因不丢);S3 双引擎 tier 等价源抽取直测(claude 恒空/openai 本引擎池/别名+缓存绝不跨引擎/显式尊重/inherit 归空对称);S4 **修复 roadmap §28 既定欠账**——runAgentWorkflow existingRun 分支 run_resumed append 在守卫之前,并发双 resume 重复 append + eventSeq 重号;修 = resumeInFlight 同步占位提前关窗(finally 统一释放)。对抗验证:stash 修复后 e2e 精确擒获 run_resumed +2,恢复后 +1。
- **46f facts.json 单一事实源(D1 起步)**:`dev-harness/facts-generate.js` 机械生成(当前:workbench 2.0.0 / ACC 1.8.3 / 原生工具 50(TOOL_HANDLERS 轴) / ACC 100(活注册表轴) / e2e 146 件(6 live 跳过) / unit 5 套件 / ACC smoke 11),`facts.static.e2e.js` 独立重算逐字段比对 + README 过时口径软锁(99/98 绝迹);CI acc-smoke job 补 accTools 活注册表对账。生成器首秀即擒版本号不一致(package.json 已 bump 而 00-boot 未同步)。
- **封版**:CHANGELOG v2.0.0(中英,盖 44/44e/45/46 四波);README「39 常驻+3 按需」为常驻轴旧口径,与 TOOL_HANDLERS 轴(50)的关系已写入 facts._axes,营销刷新列第50波发版检查单。

**验证**:全部亲跑——unit 148/148;快通道 13 件全绿;fake-mcp 家族 9 件回归全绿;resume/deadlock/loop/tier 家族 8 件回归全绿;ACC smoke 11/11;facts 静态锁 12 断言全绿;46e 对抗轮 stash 复现确认。

### 第47波：快赢波 -- Steer 双引擎 + 桥 cancel 契约 + token Bootstrap/CSP + overlay 载荷锁

封版后第一个功能波(02/03/05 方案快赢项),四件同波交付(47a/47b 共享 stdin/cancel 基建,必须同波)。

- **47a Steer Phase A 双引擎(对话 + 工作台)**:Claude 引擎对话 steer 此前被一刀切拒(`/api/steer` 对 `kind!=='openai'` 直接 409,前端静默 return)。打通:
  - **对话·Claude interactive**:`/api/steer` 按 `reg.kind` 分派 -- Claude 走 `writeToChild`+`buildUserEnvelope` 经 stdin **即时注入** `[用户插话]` 消息(与 AskUser 应答同通道,故两条分流纪律:①`hasPendingQuestionForSession` 提问挂起时拒插话防误收为答案;②入参 `[用户插话]` 前缀先剥,伪造前缀中和)。每回合计数上限 3(print 模式无 stdin 通道,人话拒)。provider 引擎维持原队列+迭代边界 drain,语义不变。
  - **工作台·Claude 节点(`-p` 单发,无迭代边界)**:02 方案 Phase C 选项 A -- `steer_node` 对 Claude 节点改**延迟插话**(`deferred:true`),挂 `node.deferredSteers`,节点结束后经 `buildUpstreamContext` 的「[用户插话 · 延迟生效]」小节注入下游节点(不混入 result 防污染 schema/质量门)。前端按钮文案/placeholder 明示「延迟」差异,不假装即时生效。
  - **前端**:`sendPrompt` 去掉 `if(isProviderMode())` 静默门(任何引擎流式中发送都路由 steer);`steerPrompt` toast 按 `r.injected` 区分即时/下步生效;工作台 `steerAgentNode`/`wbSteerBox` 传 engine、延迟文案;`workflow.steerDeferred`/`steerDeferredAria` 中英双键同交。
  - **探针先行**:`fake-claude.js` 加 `steer` 交互剧本(慢滴正文留窗口 + 循环吞 stdin 插话 envelope 落盘)+ `WCW_FAKE_SLOW_MS` 测试缝(防 launch→注册竞态 flake)。
  - **验证**:`steering-claude.e2e.js`(S 静态锁 10 + A 对话全路径 8 + B AskUser 分流 4 + C print 拒 + D 工作台延迟插话注入下游 7);`agent-steer-node.e2e.js` (c) Claude 节点断言改 200 deferred;steer 家族 7 件回归全绿;steering-claude 5× 稳定(无 flake)。
- **47b 桥 cancel/超时契约**:消灭"桥先 120s 超时、ACC 侧 600s 任务僵尸执行"(用户纠偏后旧命令仍在后台写文件,比不能打断更危险)。
  - **声明式按工具超时表** `BRIDGED_TOOL_TIMEOUTS`(`run_command`/`launch_application` 650s 对齐 ACC 自身 cap,`macro_run` 300s,默认 120s);`callTool` 缺省超时走表(4 个调用点免费获得,不逐处传);`WCW_BRIDGED_TIMEOUT_OVERRIDE` env 测试缝。
  - **超时即发 `notifications/cancelled`**(MCP 标准,requestId 数字,reason=timeout)+ **kill 客户端进程树**(`this.kill()` -> taskkill /T 杀孙进程),错误文本如实告知"桥接进程树已终止";`getBridgedClient` 统一入口 -- 三处分发点(12-tool-dispatch/08/09)原直接 `mcpClients.get` 在超时杀后永远 'not available',改走它后"超时杀 -> 下次调用惰性重 spawn"闭环自愈。
  - **验证**:`bridge-cancel-timeout.e2e.js`(E 静态锁 5 + A 超时错误文本 2 + B cancelled 通知 3 + C 旧进程被杀+新进程重连 2 + D 下次调用恢复 1);fake-mcp 加 `slow_task` 测试件 + 通知/pid 捕获;fake-mcp-contract.e2e 件数 20->21 同步;桥家族 9 件回归全绿;3× 稳定。
- **47c S1 token Bootstrap + S3 CSP**:token 不再随 HTML 明文下发(view-source/缓存/抓包 HTML 均不可得)。
  - **S1**:`serveStatic` 浏览器导航(UA 含 Mozilla / Origin / sec-fetch-dest)GET / -> HTML wcw-token content 置空;非浏览器(无 UA,curl/node e2e/MCP child)仍明文注入(向后兼容,信任面同旧规,74 个 token-scraping e2e 零回归);新增 `POST /api/bootstrap`(open 级,顶层 host 门已挡 rebinding)为浏览器拿 token 的唯一通道;`net.js` `initToken()` 握手存 sessionStorage + 模块变量,`app.js` boot 第一件事 `await initToken()`。
  - **S3**:index.html head 加 CSP meta -- `connect-src 'self'`(阻断 token/数据外泄)、`script-src 'self' 'unsafe-inline'`(排外域,unsafe-inline 兼容首屏主题预绘内联脚本,后续可改 hash 收紧)、`object-src 'none'`、`base-uri 'self'`。
  - **验证**:`token-bootstrap-csp.e2e.js`(S 静态锁 6 + S1 五性:浏览器 HTML 空/非浏览器兼容/bootstrap 返 token/rebinding 403/闭环鉴权 + S3 CSP 在);dom-smoke 真实 Edge 全绿(modelChip 渲染依赖 bootstrap→/api/status 鉴权 = 握手活);auth-deny-default 回归全绿。
- **47d X2 overlay 载荷锁**:`overlay-payload-lock.static.e2e.js` -- PAYLOAD_FILES 与运行时依赖集三向机械对账(① index.html/app.js 引用 ⊆ 载荷表;② 载荷每条磁盘存在;③ 敏感目录 js/locales/vendor/src 磁盘文件 ⊆ 载荷表,防"新文件忘登记" -- 43e 同款白屏事故的预防针)。对抗验证:放未登记文件 -> ③ 精确擒获红。

**验证**:全部亲跑--auth/steer/bridge 家族 10 件全绿;dom-smoke 真实浏览器全绿;facts 静态锁全绿(e2e 146->150,4 新件);全量并行 4 路跑(完成态见提交)。

**未做(留后续波)**:Phase B 打断语义(Codex 级"立即生效"批次边界中断,02 方案);Phase D 插话队列可视化/插话卡静态重渲染;S2 token 持久化策略(sessionStorage 关标签页即失效是刻意的--每次启动重新握手,token 不长留);CSP 收紧('unsafe-inline' -> hash);README/ARCHITECTURE 引擎能力表同步"双引擎 steer"(列第50波文档刷新)。

**47e 补丁(2026-07-22,用户真机报告)**:对话流式中发送按钮恒为「停止」——输入文本也不变 Steer(47a 只通了后端路由与 Enter 隐藏路径,`setStreaming` 把按钮硬编码 stopTurn)。修为 **updateSendBtn 三态**(ChatGPT 同款):非流式=发送;流式+输入框有文本=「插话」(sendPrompt 路由 /api/steer,btn.title 提示不打断回合);流式+空输入=「■ 停止」。配套:composer input 事件即时切态;steerPrompt 清空输入后按钮回落停止;i18n `chat.steer`/`chat.steerHint` 双语键(runtime + docs/i18n 事实源同步);steering-claude S11-S16 静态锁。验证:steering-claude×2/i18n.static/i18n/dom-smoke/ui-v3-p3b/agent-steer-node/openai-engine 全绿。顺手清 locale 文件重复键块(JSON last-wins 语义不变)。

### 第48波：地基波 -- 提示词护栏 + MCP 导入器 + 性能 P1/P2 + FE testid 契约

封版后第二个功能波(02 Phase B/D 已补排进 50/51 波)。四件交付,为 50/51 铺路。

- **48a 提示词护栏(04 Phase A)**:"先护栏后文本"--51 波任何提示词改动过评测才合入。
  - **分层快照测试** `prompt-snapshot.static.e2e.js`(20 断言):buildProviderSystemPrompt 在固定假配置下的输出逐层断言(身份/工具协议/能力/skills/mission/provider 各层关键标记)+ identityOnly/无工具/mission 分支 + 总长闸 + skill-index 围栏闭合。快照即"改动清单自动生成器"--任何提示词 diff 体现为快照更新,review 可见。
  - **A/B 评测夹具骨架** `dev-harness/prompt-benchmark/`(README + seeds.json):04 点名 5 类(tool-protocol/read-before-write/office-ban/loop-self-rescue/plan-trigger),pass_criteria 机械可判(工具子集/序列/关键词),运行器留 51 波填实。
  - **预算断言**:总长闸(800<len<12000 最小配置)+ 技能索引 3000 字上限静态锁。
  - **capture 现状**:压缩(context-compact-v2)/playbook 已用 FAKE_CAPTURE_DIR;质量门/JSON修复随 51 波补断言(fake-openai 全捕获,机制已在)。
- **48b 性能 P1(回退)/P2**:
  - **P1 readConfig 内存缓存 -- 经对抗验证【回退】**:实现 `_configCache` + writeConfigAtomic 单点失效 + structuredClone 防 mutate 别名。但对抗验证擒获:5 件 e2e(usage-ledger/skills-registry/workbench-memory/vision-loop/subagent)直接 fs 写 config.json 切换 provider/配置,依赖 readConfig 每次读盘(usage-ledger:137 注释明述"readConfig is uncached -> picked up");缓存让这些直接写不可见。生产环境 config 变更走 POST /api/config(writeConfig 可失效)故缓存对生产正确,但测试直接写是合法提速捷径,且 mutate 别名隐患,perf 收益(小 config + OS 已缓存磁盘读)不抵 5 件回归 + 风险。**回退至原 readConfig,留 01-config.js 注释说明重做前提**(e2e 改用 POST /api/config 镜像生产,或加 mtime 失效)。这是 48 波对抗验证的核心收获--"缓存正确性 ≠ 缓存安全",测试对 uncached 的依赖是隐性契约。
  - **P2 verifyManifest mtime+size 快路径(保留)**:`_maniCache` 按文件 mtime/size 未变跳过 SHA-256(经 computeHealth->/api/status 每轮全 hash 是纯浪费)+ 60s forceFull 全量校验(mtime 伪造防御)+ manifest.version 变更失效(新 overlay 落地重算)。无测试依赖 uncached manifest,安全保留。
  - **验证** `perf-config-cache.e2e.js`(P1 回退锁 + P2 5 静态/3 行为锁)全绿;5 件回归 e2e 回归全绿。
- **48c MCP 配置导入器 v1(03 §4.1)**:从 Claude Code .mcp.json / ~/.claude.json / Codex config.toml 导入(此前只有出口 generateMcpConfig,无入口)。
  - **解析器**(04-permission-runtime.js):JSON 直解 mcpServers 字典;TOML 行级状态机迷你 parser([mcp_servers.X] 段 + command/args/env/cwd,零依赖);${VAR}/%VAR% 双向插值(解析即规范化);sse/http 标 unsupported(远程 transport 03 §4.2 后续波,不静默丢)。
  - **两步 handler**:scan(发现+冲突检测,paths 缺省自动发现 ~/.claude.json + ~/.codex/config.toml)/ apply(只导 stdio,id 撞名更新,≤10 上限,复用 sanitizeExternalMcpServer 清洗)。
  - **对抗修**:apply 先按 type 跳 sse/http(sanitize 前,sse command 空否则误判"无效条目"),再 sanitize stdio。
  - **验证** `mcp-import-config.e2e.js`(12 解析器单测 + 3 静态锁 + 8 HTTP 全路径)全绿;解析器 export 供 e2e 直测 TOML 边角。
- **48d FE 拆分契约铺路(01 Step 1 验收#5)**:index.html 13 个关键静态节点加 data-testid(与 id 同值,零视觉变化);dom-smoke 升级 B5 断言 testid 语义契约。为 50 波 FE 全量拆分铺路(重构时断言不绑死文本/结构)。**workbench 一域实拆随 50 波**(01 方案自定 1-2 波,app.js 8175->3000 行非单轮可竟,单函数抽取不具代表性且有破坏风险)。

**对抗验证(用户要求查 bug)**:**P1 readConfig 缓存引入 5 件回归--对抗验证擒获并回退**。全量跑暴露 usage-ledger/skills-registry/workbench-memory/vision-loop/subagent 5 件 fail;bisect(stash 48 源码)确认 47 基线全绿、48 引入;根因:5 件 e2e 直接 fs 写 config.json 切换 provider,依赖 readConfig 每次读盘(usage-ledger:137 注释明述),缓存让直接写不可见;structuredClone 仅治 mutate 别名标症不治本。裁决回退 P1,保留 P2(无测试依赖 uncached manifest)。教训:"缓存对生产正确"≠"缓存安全"--测试对 uncached 的依赖是隐性契约,破它即回归。其余核查:P2 mtime 快路径 forceFull+version 失效兜底;48c TOML regex 路径逃逸/malformed 不崩;48d testid 不破坏 overlay 载荷锁。回归:5 件回归件 + auth-deny-default/mcp-config/mcp-bridge/capabilities/perm-v2/context-compact-v2/agent-quality-gates/overlay-payload-lock 全绿。

**未做(留后续波)**:FE 全量拆分(01 Step 1,50 波);提示词外置/i18n/缓存分层(04 Phase B/C,51 波);A/B 运行器填实(51 波);远程 MCP transport(03 §4.2,49 波);质量门/JSON修复 capture 断言(51 波)。

### 第49波：生态工具波 -- ACC 新工具首批 + 远程 MCP transport + ACC 质量战役 + CI 扩展 + A1 首批拆分

封版后第三个功能波(03 方案子命题一/二/三 + 05 E4/A1),六件交付。

- **49a ACC 新工具首批(v1.8.3 -> v1.9.0,100 -> 107 工具)**:03 子命题二首批全落地,零依赖 stdlib 实现。
  - **edit_file(P0)**:局部精确替换(此前模型只能整文件 write_file--既危险又费 token)。唯一性安全闸(0 次/多次均人话拒,replace_all 除外)、old==new 空改动拒、>10MB 拒、编码回环(同编码读写)、protected 护栏、audit 落账;入 `BRIDGED_WRITE_PATH_ARGS`(op:write)--**入表即获得检查点+撤销**(03 P0 联动要求)。
  - **fetch(P0)**:http(s) 抓取 + SSRF 防护(镜像工作台 11-native-tools 模式:scheme 白名单 + DNS 解析 + 私网/回环/链路本地/保留段拒绝 + IPv4-mapped IPv6 拆包 + **逐跳重定向重校验** ≤5 跳 + 字节预算 200KB/硬顶 2MB + charset 按声明解码)。stdlib urllib,零 requests 依赖。
  - **memory x4(P1)**:memory_save/read/list/delete 独立持久存储(data_dir/memory.json,与工作台记忆库互补非冲突);tmp+rename 防撕裂、腐败隔离 .corrupt、500 条/4000 字上限、缺失键 found:false 但 ok:true(查询无果≠执行失败)。
  - **sequential_thinking(P1)**:镜像社区高装机契约(修订/分支/参数校验,进程内链状态)。
  - description 全部遵守"何时用+何时别用+参数约定"新规范(49d 硬锁)。`smoke_v19.py` 53 断言全绿。
- **49b fake-mcp 镜像 + 写族表 + facts**:fake-mcp 21->28 件(7 件新契约镜像,edit_file 唯一性闸/fetch SSRF 形状/memory 四件/thinking);`fake-mcp-contract.e2e` P1 名集锁 21->28 + 7 件新契约逐件直调;facts.json accTools 107/e2e 154/accSmokes 14 重生成。
- **49c 远程 MCP transport(03 §4.2)**:`McpHttpClient` 双 transport 零依赖落地(04-permission-runtime.js)。
  - **streamable-HTTP(2025-03-26)**:POST 单端点,application/json 与 text/event-stream 两种响应形态都解(多行 data 按规范 \n 重拼--e5-multiline-sse 教训),Mcp-Session-Id 捕获回显。
  - **legacy SSE(2024-11-05)**:GET 流 endpoint 发现 -> POST 202 -> 流上 message 事件回应答;**tools/list_changed 通知 -> listTools 惰性重列**(03 §4.2 协议升级项)。
  - **headers ${VAR} 连接时展开**:配置/导入落盘只存引用(密钥永不明文落盘);sanitizeExternalMcpServer 远程分支(id+http(s) url,streamable-http 归一 http);resolveExternalMcpServers/drop-in/getBridgedClient/collectBridgedTools cacheKey/safeMcpInventory 全链路接通;48c 导入器 sse/http 从 unsupported 解锁(缺 url 仍标 unsupported 跳过)。
  - 超时语义与 47b 对齐但无进程树可杀:断连接 + 下次调用 getBridgedClient 惰性重建 + 人话告知。
  - **对抗验证修 1 个真 bug**:e2e A12 撞出 `_rpcHttp` 无 dead 闸(stdio 有,http 漏)--kill 后同实例仍可调用,补闸。
  - **验证** `mcp-remote-transport.e2e.js`(A 直连 12 + B 桥接 4 + S 静态 6)全绿;`mcp-import-config.e2e` 断言翻转到"可导入+密钥引用不展开"全绿;MCP/桥家族 6 件回归全绿。
- **49d ACC 质量战役(03 Phase B 四件)**:
  - **读取栈收敛**:read_document 的 pdf/xlsx 分支标弃用(description 明示 + 响应带 deprecated/successor 字段),指向 pdf_read_pages/excel_read;docx 保留主用途。
  - **description 一致性审计** `smoke_descriptions.py`:107 件全量报告(Args 段覆盖 73、新约定覆盖 8)+ 硬锁 v1.9 新 7 件 + read_document 必须合规;存量改造留后续波(报告已列清单)。
  - **ACC_TOOLSETS 子集注册**(03 T9 schema 减重):server.py 改 importlib 按能力族导入(desktop/office/browser/filesystem/shell/uia/ocr/vision/macro/memory/web/thinking/observe/audio/sync + audit/diagnostics 常驻),未设 env=全开向后兼容;`smoke_toolsets.py` 子进程隔离验证(全开 107/filesystem+shell=15/未知族忽略/office 族正确/新工具族可裁)。
  - **pyproject 修正(03 T2)**:playwright/uiautomation/comtypes/python-pptx/matplotlib 移入 extras(browser/uia/pptx/charts),硬依赖只剩真必需 9 件--依赖声明与 README"可选优雅降级"对齐;requirements_offline.txt 保持全量不受影响;旧注释引用不存在的 macro.py/pdf_tools.py 一并更正。仓库卫生(T10)核查本已干净(__pycache__/build/zip 均未入库)。
  - ACC 全量 14 件 smoke 全绿(v19/toolsets/descriptions 3 件新增)。
- **49e E4 CI 扩展**:
  - **permissions: contents: read** 最小权限 + 四个 action **钉 SHA**(checkout v4.2.2/setup-node v4.4.0/setup-python v5.6.0/upload-artifact v4.6.2,SHA 经 release 页逐一核实,注释保留版本标签)。
  - **linux-static job**(ubuntu):syntax gate + build freshness + unit + prompt-snapshot(确认平台无关子集)——双平台信号,防"静态件悄悄写 Windows-only 假设"。
  - **release-dryrun job**:`dev-harness/release-dryrun.js` 打包干跑(产物新鲜度 -> build-overlay 全装配 -> manifest sha256 抽查对账 -> pkg 打包 -> Ruyi.exe serve /health 200 冒烟)。本地 `--pkg` 全路径亲跑全绿;顺手修 npm.cmd 在 execFile 下 ENOENT/EINVAL(Node 批处理防护,经 cmd /c 调,与 batchSafeSpawn 同教训)。
  - run_all.py CI_SUBSET 补 smoke_toolsets/smoke_descriptions(无显示依赖)。
- **49f A1 后端巨函数拆分(第一批)**:handleApi 三组域路由**原样抽出**至新模块 `13b-api-domain-routes.js`(MCP/checkpoint·storage/steer,~170 行);共享作用域拼接零 import 接线,行为不变。关键坑:send() 无返回值,委托判定用 `res.writableEnded` 而非返回值(否则命中后继续 fallthrough 双响应)。manifest.json 注册第 16 模块,overlay 载荷自动纳入(build-overlay 从 manifest 派生)。

**验证**:全部亲跑--ACC smoke 14/14;mcp-remote-transport/mcp-import-config/fake-mcp-contract 全绿;MCP/桥家族 6 件 + checkpoint/storage/steer 家族 7 件回归全绿;release-dryrun --pkg 全路径(含 Ruyi.exe 冒烟)全绿;facts 静态锁全绿。全量并行 4 路 148 ran:145 pass + 8 flaky(重跑过)+ 2 fail 逐一收口——meta-guard 擒真实文档漂移(ADMIN-GUIDE/README 的 ACC 版本与件数引用未随 1.9.0 同步,已修并新增 v1.9 章节,复跑全绿);perm-v2 为并行负载 flake(solo 3x 稳定,与 46 波已标记的时序族同类,记入待治理名单)。

**未做(留后续波)**:description 存量 99 件新约定改造(报告已列清单,随工具改动顺手);ACC_TOOLSETS 的 tool_search A/B token 数字重测刷新营销证据(03 验收#2);MCP 管理面板 UI(03 §4.1.3);A1 剩余组(agent-runs/permission/session,随邻近改动顺手);github/官方 filesystem 兼容层(03 P2)。


### 第50波：UI 视觉焕新波 -- V4 毛玻璃定稿 + 玻璃铺层 + i18n 清零 + a11y + 插话可视化

封版后第四个功能波(01 Step 0/2/3 + 02 Phase D),分上下两半提交。

### 上半(470308b):Step 0 定稿 + Step 2 玻璃铺层 + 标题/Steer 热修

- **50a Step 0 收尾**:`UI-DESIGN-V4.md` 定稿(§3.2-A~F token 值与分档表);mockup 第 2 轮质感迭代值回写 styles.css(--scene-bg 微渐变 + 噪点 / --glass-bg-1~3 / --glass-border/-strong / --glass-highlight / --glass-shadow/-soft / --glass-blur-1~3 / --accent-2 黛紫 / 鎏金香槟 / 亮 accent #2050c8);token 清障(删零引用 --density-scale/--gold-soft/--sp-7;4 处硬编码 #fff token 化);docs/README 设计稿生命周期标注(D3,五份稿状态钉)。**WCAG 裁决**:暗 accent 保留 #4a6cd9(mockup #6e86f2 对 accent-ink 白字对比 3.3 不过 theme.e2e 4.5 红线),蓝紫高级感经 --accent-2 渐变/glow 表达。
- **50b Step 2 玻璃铺层**:body --scene-bg + 噪点层(暗主题);框架族玻璃二档(sidebar/tool-pane/topbar/composer);浮层族玻璃一档(modal/palette/popover/toast,toast blur-1 防多 toast 叠爆预算);卡片族 --glass-bg-3 列表降级无 blur(§3.2-E 模糊预算同屏 ≤6);点色化(侧栏选中玻璃底+点色左条/主按钮青花-黛紫渐变/顶栏青花发线);主题三态 light/dark/system(matchMedia 解析+监听+预绘防闪,themeToggle emoji 换 SVG monitor/theme);@supports not backdrop-filter 实色回退 + prefers-reduced-transparency 关模糊。`ui-v4-glass.static.e2e` 8 组锁(G1 blur 三档/G2 白名单/G3 禁散写 blur/G4 scene/G5 降级/G6 阅读区克制/G7 三态/G8 点色)。
- **热修①(用户报告 标题卡死)**:前端把本地化占位名(新会话)当标题落库,后端 'New session' 判定永不匹配 -> 所有会话标题卡死。前端传空标题 + 展示侧 sessionDisplayTitle 本地化占位;后端 isUntitledSessionTitle 中英占位集(New session/新会话/New chat),历史会话下一轮自动补名。steering-claude E1-E5 行为锁。
- **热修②(用户报告 Steer 双消息)**:steered 回声去重 15s 窗对 provider drain(下一迭代边界才发)太短,慢工具下窗口失效回声双写。改不限时文本队列逐条 splice(cap 50)。steering-claude S17-S18 锁。

### 下半:Step 3 i18n/a11y + 02 Phase D 插话可视化

- **50c Step 3 i18n 清零 + a11y P0 + 视觉回归门 v1**:
  - **i18n 清零**:TOOL_VERB_MAP 改 t() 键;wbSteerBox/wbPoolBody/wbMailBody/段头/节点操作区全 i18n;95 处硬编码中文 toast 批量转 t()(codemod:形态 A 纯文本 / B 模板 ${} -> {{pN}} / C 拼接);4 目录事实源同步。i18n.static 全绿。顺手补 steerPrompt toast i18n 遗漏(三元形态 codemod 未捕获)。
  - **a11y P0**:installFocusTrap(buildModal 动态模态 + 静态模态 Tab/Shift+Tab 焦点循环不外泄,ESC 与焦点归还已由全局快捷键/buildModal 承担)。**role="log" 评估**:#messages 全清重建架构(01 方案 P2 待做)下 role="log" 隐含 aria-live=polite 会致屏幕阅读器重读全部历史消息(可用性倒退),标 P2 增量渲染联动,不强行加。
  - **视觉回归门 v1**:dom-smoke(dark 渲染)+ ui-v4-glass.static(玻璃 token)+ theme.e2e(双主题 WCAG)三件组合覆盖静态 + dark 渲染层。v2 双主题像素对比需 ?theme= URL 注入基建 + 基线图,留后续。
- **50d 02 Phase D 插话可视化**:
  - **插话卡静态重渲染**:renderStaticMessage 统一处理 msg.steered(刷新/重进会话后 steered:true 消息带「插话」徽章,47a 只做流式期 optimistic render);renderSteeredMessage 传 steered:true,徽章逻辑单源(不再手动 insertBefore)。steering-claude S20-S21 锁。
  - **插话队列可视化**:provider 引擎 steer 排队中(r.queued>0)时 composerHint 显示"队列中 N 条·下一步生效",回合结束 setStreaming(false) 清空。Claude interactive 即时注入不排队不显。steering-claude S22 锁。
- **50e 收尾**:server.js freshness 确认;facts 重生成;全量对抗验证;roadmap §48;提交。

**未做(留后续波)**:role="log"(P2 增量渲染联动,全清重建下加会致屏幕阅读器重读);视觉回归门 v2 双主题像素对比(需 ?theme= URL 注入基建 + 基线图);CSS 分层拆分(tokens/base/components/views/themes,与 FE 全量拆分同域随 51 波);README/ARCHITECTURE steer 旧口径"仅 provider 引擎"全量刷新(47 波欠账,本波未做,留 51 波顺手);div+cursor:pointer 键盘等价散点(随邻近改动);截图/营销资产重拍(毛玻璃是营销卖点,列发版检查单)。

### 第51波（进行中）：提示词与工作流规范化波 -- 51a 语义 loop-guard + 规范文档

封版后第五个功能波(04 Phase B/C/D + 02 Phase B),四块跨多会话交付。本节随各阶段交付追加。

### 51a 04 Phase D 语义 loop-guard + 《模型工作流规范》文档

- **语义 loop-guard(主回合结果指纹无进展判定)**:09-workflow.js 主回合 loop-guard 原仅"同签名连击"(sig=name+rawArgs,WARN3/ABORT5)抓"完全相同调用";补"结果指纹无进展"判定--工具结果内容摘要指纹(【不含】调用参数,"换参数但结果相同"正是要抓的语义死循环;含参数则换路径自动 reset,退化为同签名连击重复),连续 N 次指纹相同 -> loopWarning nudge。普通工具阈值 4,探索类工具(read/search/glob/grep/web_search/ocr/ui_find)宽阈值 8(换路径读不同内容是正常进展,指纹变 reset);warn 先行【不】abort(语义死循环证据弱于签名死循环,只 nudge);错误/空结果视为有新信息 reset。与同签名连击互补:连击先判定(warn 后语义跳过 !loopWarning 避免双 warn),语义补盲区(sig 不同但结果相同)。计数 turn-local 不跨回合泄漏。复用节点级 workflowProgressFingerprint(08:1379)思路推广到主回合(04 Phase D 验收:09:611 节点级已验证)。
- **《模型工作流规范》文档双语**:`ruyi-workbench/docs/MODEL-WORKFLOW-SPEC_CN.md` + `_EN.md`。面向用户与贡献者写清"规划-执行-检查-循环保护-预算-压缩"六环节 + 各档预算语义(TOOL_ITERATION_BUDGETS standard100/long200/hard300/extension50 + isLongToolTask 升档 + shouldExtendToolIterationBudget 动态扩展)。循环保护章含双判定(同签名连击 + 结果指纹)+ 探索工具宽阈值 + warn 先行不 abort。规范即营销素材("可审计的工作方式")。
- **验证**:`semantic-loop-guard.e2e.js`(A 段真死循环捕获:9 个不同路径同内容文件 file_read,sig 每次不同但结果指纹同,第9次 noProgressRun=8>=探索阈值8 -> 语义 warn"无新信息",非同签名连击"第3次";B 段正常探索不误伤:3 个不同内容文件 -> 指纹变 reset -> 不 warn;12 步全执行 warn 不 abort);loop-guard 家族回归(loop-guard/agent-subturn-loop-guard/prompt-snapshot)全绿;facts e2e 155->156。

**未做(留后续阶段)**:51b 02 Phase B 打断语义(批次边界中断 + 桥打断取消,与语义 loop-guard 同域 09);51c 04 Phase B 提示词外置 i18n(app/prompts/ 中英双份 + PROMPT_PACK_VERSION);51d 04 Phase C prefix-cache 稳定分层(system 首条逐字节稳定 + 易变层移 user 侧);51e 收尾(A/B 运行器填实 + 质量门/JSON修复 capture 断言 + 全量对抗验证)。04 Phase D 其他项(预算口径统一/回合级输出契约/Claude 引擎对齐)随邻近阶段顺手。

### 51b 02 Phase B 打断语义(批次边界中断,Deepseek 子代理分析+审查)

- **between-tools steer 检查**:09-workflow.js 主回合工具执行循环(line 1373 for tc of call.toolCalls)内、每个工具完成后(line 1613 result push + 1616 状态检查后)、下一个前,新增 steer 队列检查(line 1623):reg.steerQueue 非空则用 answeredIds 逐条补配对 refusal(复用 loop_abort line 1390-1399 模式)中断剩余批次,steerAborted=true break,外层 continue 回 line 1162 drainSteerQueue 注入插话。Codex 级立即生效(替代整批跑完才注入)。配对铁律:中断点在当前工具 result push 后,剩余工具补 refusal 保证 assistant.tool_calls(N ids) -> 连续 N 条 role:tool 不劈块(strict provider 对未配对 tool_call_id 报 400 永久卡死会话)。
- **配对安全四件**:① line 1042 steerAborted turn-local 标志;② line 1623 between-tools 检查(answeredIds 补 refusal);③ line 1628 图片 flush 加 !steerAborted(部分批次不 trailing user message,连续性铁律);④ line 1636 后 reset(steerAborted=false,走 saveSession+continue 回 drainSteerQueue,不结束回合)。
- **Deepseek 对抗审查**(engine openai/providerId deepseek,minSuccessfulToolCalls 2,23 次工具调用读 09/07/13b):verdict safe。配对安全/steerAborted 生命周期(不残留)/无双注入(drainSteerQueue splice 清空)/竞态(单线程无真竞态)全正确。2 个 minor(设计取舍,非 bug):① spawn_agent/orchestrate_agents 分支(line 1456 continue)跳过 between-tools 检查--子代理长运行期间 steer 延迟到下一迭代 drain(子代理中断需取消子代理,51b 范围外);② between-tools 中断时 pendingToolImages 跳过(部分批次纪律),已执行工具提取的图片随本轮丢失(视觉回路回合削弱屏幕感知,配对安全取舍)。产出亲读复核(Issue #1 spawn_agent continue 核实属实,minor)。
- **验证**:steer-interrupt.e2e(FAKE_PARALLEL_TOOLS=3 file_read + STREAM_DELAY=150 + steer 流期间到达;3 tool_use + f2/f3 refusal"用户插话中断" + f1 真实 + 配对块连续 + 插话 batch+4;x2 非 flake);steering.e2e ⑦ + loop-guard + semantic-loop-guard + agent-subturn-loop-guard + steering-claude 回归全绿;facts e2e 156->157。
- **多agent协作模式**(用户指示):51b/c/d 三块用 Deepseek V4 Pro 子代理并行只读分析(各产出实现点+代码草稿+e2e设计+风险,minSuccessfulToolCalls 2 强制读源码),主会话亲读复核+主树串行实现(避 server.js 并行合并地狱),实现后再 Deepseek 对抗审查+主会话亲验。51c/51d 分析已留存待续。

### 51c-a 前端 i18n 清零(50 波遗留,顺手)
app.js 3 处前端硬编码中文 map 转 t() 键:agentRunStatusLabel(line 3210,16 节点状态)-> t('workflow.node.status.'+status);CHANGE_OP_LABEL 使用处(line 5499,3 操作)-> t('changes.op.'+op);changeToolLabel(line 5409,16 工具)-> t('changes.tool.'+tool)。新增 39 i18n key x 4 locale 文件(workflow.node.status.*15 / changes.op.*3 / changes.tool.*19 / common.unknown)。i18n.static/i18n.e2e/dom-smoke/dom-contract 全绿。**51c-b(04 Phase B 提示词外置,~25 段+中英双份+registry.js+PROMPT_PACK_VERSION)是大重构,Deepseek 分析已留存,留后续阶段。**

### 51c-b 04 Phase B 提示词外置 i18n 骨架(Phase1 中文版,Deepseek 分析)

- **registry 单一注册点**:新建 src/06b-prompt-registry.js(manifest 第 17 模块,06 后):PROMPT_PACK_VERSION='2026-w51-1' + PROMPT_ZH 中文包(身份/工具协议/能力/操控规程/检索/风格/项目/技能header/记忆header/账本/plan-mode,逐层模板函数,文本逐字搬自原内联)。方案 A(JS 模块进 manifest,零 IO 失败,构建时语法校验兜底)。
- **buildProviderSystemPrompt 瘦身**:06 的 17 层 lines.push 文本 -> PROMPT_ZH.xxx(params) 调用,条件逻辑(hasTools/identityOnly/deskPresent/visionCap 等)留 JS。06 buildSkillsPromptSection header + 07 buildMemory/MissionPromptSection 全部文本 + 09:941 plan-mode 中文 -> registry。
- **PROMPT_PACK_VERSION 入会话元数据**:02 sessionMeta 加 promptPack 字段(为 A/B 实验与问题回溯奠基)。
- **行为零漂移**:文本逐字搬,prompt-snapshot 1294 字不变(断言中文标记全绿)。meta-guard F 段适配外置(digest「不得覆盖」检查兼容 PROMPT_ZH.mission.header 引用 + 全局文本守护)。
- **Deepseek 协作**:分析节点(33 次工具调用读 06/07/09/01/build.js)产出外置清单+registry 设计+瘦身改法,建议分阶段(Phase1 中文版零漂移),主会话亲读复核+主树串行实现。
- **验证**:prompt-snapshot/steering/loop-guard/semantic-loop-guard/steering-claude/facts.static/meta-guard/dom-smoke 全绿。
- **Phase2(后续)**:PROMPT_EN 英文版 + locale 感知切换(config.locale en-US 时加载英文)+ A/B 基准集验证(英文行为漂移风险,行为关键层优先审校)。48a prompt-snapshot 护栏已就位。

**待续 51d**:04 Phase C prefix-cache 稳定分层。Deepseek 分析(20 次工具调用)verdict:可行有风险,建议 C1 低风险启动。C1:拆分 buildProviderSystemPrompt 为 buildStableSystemPrompt(身份/工具协议/桌面规程/风格/provider append 稳定层)+ buildVolatileParts(能力/项目/技能/记忆/账本易变层);易变层用 Option A(前缀合并到第一条 user content,不破坏 user↔assistant 交替契约,避免双连续 user);09:919 sys 只调稳定层,09:854 user 消息前缀注入易变层。风险:6+ e2e 断言 system text 标记(如 capabilities 的"当前能力")会失效,需批量改为查 user 消息;provider 兼容性(短 system+巨 user)需 fake-openai 多 provider 断言。C2(需 provider 实测):迁移 09:920-945 附加提示 + 压缩预算微调。关键:Option A 比 Option B(独立 user 消息)安全得多,必须选 Option A。

### 51d C1a 04 Phase C prefix-cache 分层基础(稳定/易变层拆分,Deepseek 分析)

- **06 buildProviderSystemPrompt 拆分**:buildStableSystemPrompt(身份+工具协议+provider append,会话内逐字节稳定,prefix-cache 友好)+ buildVolatileParts(能力/桌面规程/搜索/风格/项目/技能/记忆/账本,每回合可能变化)+ buildProviderSystemPrompt 向后兼容包装(stable+volatile,行为零漂移)。14-main 导出两个新函数。
- **prompt-snapshot 加 D 段断言**:stable 不含 volatile 标记(能力/桌面/技能/账本)+ volatile 含 + 包装=stable+volatile(向后兼容)。行为零漂移:prompt-snapshot 1294 字不变。
- **Deepseek 协作(Provider 端点多 agent)**:分析节点(39 次工具调用)产出 C1 实现+e2e 改动+风险,verdict 低风险(2/5)本轮可行。**主会话亲读复核抓到 1 处时序错误**:Deepseek 建议 09:854 前缀注入 buildVolatileParts,但 854 在参数初始化(892-919 caps/initialTools/projectMemory/skillEntries/memoryEntries)之前不可行。改 C1a 零风险基础(拆分+向后兼容),C1b 留下轮。
- **验证**:prompt-snapshot(D段)/meta-guard/semantic-loop-guard/steering/loop-guard/facts.static/dom-smoke 全绿。
- **C1b(后续)**:09 启用分层(sys=buildStableSystemPrompt,volatile 动态注入 buildBody messages[1] 不持久化,避开 854 参数未初始化);920-945 追加(角色/编排/模型/plan/policies)留 sys(C2 再移 user 侧)。实际 prefix-cache 收益:非 plan 回合 sys 跨回合稳定(命中)。
- **memory 更新**:新增 ruyi-multiagent-pattern(只读分析/审查用 Deepseek 可靠+主会话复核;src/ 主树串行;Provider 端点等特定任务该用多 agent)。更新对 orchestrate 可靠性的认知(早期 probe ~60% 是 probe 场景,51 波只读分析/审查可靠性高)。

**待续 51e**:收尾(A/B 运行器填实 dev-harness/prompt-benchmark/run.js--5 seeds × fake-openai 剧本 + 真 provider 可选 + baseline 对比;质量门/JSON修复 capture 断言;全量对抗验证)。A/B 运行器 fake-openai 模式测流程非行为漂移(真 A/B 要真实 API),需仔细设计。

### 第52波（进行中）：发布与范式 + 51 波遗留收尾

roadmap §43 line 954"第52波+ · 发布与范式"+ 51 波遗留技术债收尾。本节随各阶段交付追加。

### 52c 51d C2 迁移 920-945 附加提示到 user 侧(sys 纯稳定层)

- **09-workflow.js runOpenAiTurn**:920-945 附加提示(角色/编排/模型/plan/appendTurnPolicies)从 `sys +=` 迁移到 `volatileExtras`(与 turnVolatile 合并,注入 user 侧 messages[1])。sys 纯稳定层(只 buildStableSystemPrompt:身份+工具协议+provider),prefix-cache 完整命中。budgetPrompt 估算不变(sys + turnVolatile 总量)。
- **e2e 不破**:C1b 已把 systemOf 改 system+user 拼接,C2 的 920-945 追加在 user 侧,system+user 拼接含。验证:prompt-snapshot/capabilities/plan-mode/steering/meta-guard/subagent/uimode-style/loop-guard/facts.static 全绿。facts e2eCount 修正 153->157(之前文档审计误改)。

### 52d PROMPT_PACK_VERSION 语义化版本检查(前向伏笔清理)

- **14-main 导出 PROMPT_PACK_VERSION**(06b registry 的提示词包版本常量)。
- **prompt-snapshot 加 D9 断言**:PROMPT_PACK_VERSION 存在 + 语义化版本号格式(/^20\d\d-w\d+-\d+$/),为 A/B 实验与问题回溯奠基(版本可追溯)。
- **前向伏笔清理**:子回合 loop-guard B3 已在 08:514-672 实现(无需做);双层语义判定(同签名连击+结果指纹)51a 已做;04 Phase D 其他项(预算口径统一/回合级输出契约/Claude 引擎对齐)留后续。

### 52b A/B 运行器填实(51e 收尾)

- **dev-harness/prompt-benchmark/run.js**:提示词改动前后对比通过率,挡住行为漂移。与 prompt-snapshot.static(文本基线锁)互补--快照管"文本变了可见",A/B 管"行为没变可证"。
- **fake-openai 模式(默认,离线冒烟)**:按 seed.fake_script 剧本回工具,验证工具流程 + loop-guard 行为 + system 注入(CAPTURE 冒烟)。真 provider 模式(--provider)真 A/B,复用 model-tier-probe。
- **--before 落 baseline.json,--after 对比 diff**(无差异=未漂移)。非回归件(CI 不阻断)。
- **seeds.json**:加 fake_script + setup_files;lsr-01 字段修正 loop_guard_aborts_at(主回合);pt-01 needs_plan_mode/ob-01 needs_bridge(fake bypass 不触发,标 skip)。
- **判据**:tool/loop 可靠(tool_subset_of/sequence/read-before-write/loop_guard_aborts);office/plan/output 标 skip(fake 局限);system_prompt_nonempty(CAPTURE 冒烟)。验证:--before 3/3 pass(2 skipped),--after diff 0。

### 52x 子 agent 优先端点+模型(用户需求)

- **config 加 subagentPreferredProvider + subagentPreferredModel**(全局,跨 provider)。spawn_agent/orchestrate 的 openai 节点默认用此 provider+model;模型仍可经 spawn_agent.model 选同端点下别的模型(如 Pro),或 omit 继承。未配置 fallback 主 provider + provider.subagentModel。
- **跨 provider 链路**:resolveNodeModel(13)+runSubAgentCore subModel(08)加 subagentPreferredModel fallback;spawn_agent(09:1379)+orchestrate 节点(09:529)+DAG 物化(09:155)用 subProvider(config.providers.find)。Claude 引擎固定不跨。
- **设置 UI**:agent 部分加 cfgSubagentPreferredProvider/Model(index.html + app.js 读取/保存)+ i18n(zh-CN/en-US + docs)。
- **提示词**:subagentPreferred 条件渲染(06,设了且 id 有效才提示),告诉模型子 agent 默认端点+模型,复杂任务可选同端点别的模型或自己。
- **对抗验证修复**:DAG 物化用 subProvider 挑模型(防 tier 用主 provider 池挑模型送 subProvider 跑 404,与 spawn_agent 路径一致);subagentPreferredModel 提到 tierModel 前(用户显式优先于自动分级);normalizeConfig 规范化;提示词无效 id 不注入。
- **验证**:subagent/agent-quality-gates/prompt-snapshot/capabilities/i18n.static/facts.static/dom-smoke 全绿。

### 52y 前端体验收口（7 项实机反馈）

- **权限 / 设置 IA**：安全弹层只保留人话单选卡，隐藏 select 仅作兼容事件载体；侧栏和右栏删除重复“体检”入口，诊断面板迁入设置并对精简模式开放。
- **模型 / 子代理选择**：顶栏状态点、端点名、模型名与箭头统一中心线；子代理优先端点与模型改为联动 select，端点切换会清空旧模型并按新 Provider 重建模型列表，避免 Kimi / Ark / 其它 Coding Plan 间串用模型 id。
- **Steer / Claude Agent**：Steer 队列改用语义 token、状态 chip 和响应式布局，随深浅主题切换；前端识别 Claude 原生后台 Agent 的 launch acknowledgement，显示“后台执行中”而非“完成”，真正结论仍按既有完成态展示。
- **改动查看**：“查看改动”默认打开独立窗口 / tab，复用当前主题并提供“用本机应用打开当前文件”；浏览器阻止弹窗时回退到原页预览并自动滚入视口。
- **验证**：DOM/IA/i18n/主题/Claude 子代理/Steer/changes targeted 回归通过；真实浏览器确认权限弹层零可见 select、Provider→model 联动、体检设置页、深浅主题模型中心线，控制台零错误。

### 52a 04 Phase B Phase2 英文提示词包 + locale 感知切换

- **PROMPT_EN + `getPromptPack(locale)`**:补齐英文提示词包并与 `PROMPT_ZH` 保持同一层级结构；`en-US` 选择英文包，`auto` 与其它 locale 保持中文包，确保既有中文会话零漂移。
- **全链路接线**:`buildStableSystemPrompt`、`buildVolatileParts`、skills/memory/mission 提示段都显式接收 config 后按 locale 取包，避免任一动态提示仍泄漏中文固定文本。
- **验证**:meta-guard、capabilities、prompt-snapshot、subagent 定向回归通过；52b 的 A/B 基准工具可用于后续真实 provider 的提示词行为比较。

### 待续

- **52e**:§43 发布与范式(overlay 更新 GUI、vNext「交办台」立项决策、产品扩展评估)。

## 第53波起：Escapade 2.x 的内部优先级（计划，非版本承诺）

Escapade 2.0 已完成公开发布。以下是从既有 52e 未竟项、当前实现债与 Pretender 迁移前置条件整理出的**内部**优先级。表中的 `2.0.1`、`2.1` 等只是便于讨论的候选版本桶，不是发布承诺；每次 Release 仍须在范围冻结、测试、打包和兼容门全部通过后再决定正式版本号。

### 规划原则

1. **先收口，再扩张**：2.x 不再以增加大型工具类别为主线，优先处理发布可信度、恢复能力、交互负担和状态一致性。
2. **用户版本不等于内部波次**：一个候选 Release 可以合并多个波次，一个波次也可以拆到补丁版；不得为追版本号牺牲质量门。
3. **Pretender 不倒逼引擎重写**：Escapade 已有双引擎、工具、Agent Run、检查点、审计、技能和离线存储继续作为 3.0 的执行资产。
4. **无遥测仍可度量**：指标默认只在本地日志和诊断导出中统计，不新增静默外发；真实外部服务探针单独标注。
5. **所有“可撤销”声明必须可验证**：界面不得把“有检查点”“可恢复”和“可完全回滚”混成同一个承诺。

### 候选 Release 桶

| 候选桶 | 建议版本 | 主题 | 主要来源 | 范围摘要 |
|---|---|---|---|---|
| **EC-A** | `2.0.1` | 真实基线 | 52e / 53 前置 | 文档、事实、构建清单、模块映射、i18n 与发布门校准；原则上不引入新产品能力 |
| **EC-B** | `2.1` | 安全更新中心 | 第53波 | Overlay 离线更新 GUI、兼容预检、变更预览、备份、验证、失败恢复与重启交接 |
| **EC-C** | `2.1.x` | MCP 运维闭环 | 第55波前半 | MCP 列表、健康状态、导入、重测、启停与远程 connector 兼容诊断 |
| **EC-D** | `2.2` | 安静工作台 | 第54波 + 第55波后半 | **回合叙事化对话**、增量渲染、前端拆域、视觉/无障碍门、CSS 分层、后端剩余领域拆分 |
| **EC-E** | `2.3` | Mission Ready | 第56波前置 | `/api/missions` 聚合读模型、未决事项持久化、结果/变更/回滚引用与旧会话适配 |

正式排期时允许合并 EC-C 与 EC-D；但 EC-A 不与功能版本合并，避免刚发布后的事实修复被新功能风险淹没。

### EC-A · 真实基线（候选 `2.0.1`）

**目标**：让仓库、离线包、运行时事实和用户文档描述同一套产品。

- 构建期自动生成或验证 `app/src/manifest.json` 的 `startLine/endLine`，禁止 `0/0` 和过期行区间在 CI 中静默通过。
- 更新中英文架构、用户与管理员手册的版本、工具数量、右栏信息架构、Steer 双引擎语义和 UI token bootstrap 说明。
- 扫描并清理工作流、存储、指标、变更、记忆等高频路径残留的硬编码界面文案；新增文案必须进入双语资源。
- 把 Full/Slim 包文件清单、checksum、版本三角和最低兼容版本做成可重复的 release-dryrun 检查。
- 为“文档事实”建立静态锁：版本号、原生工具数、ACC 工具数、默认端口、安全 token 获取方式和 live probe 数不得各写各的。

**退出条件**：

- 构建新鲜度、快速测试与默认 E2E 全绿；真实 provider、Claude CLI、远程 MCP 等 live probe 独立列出通过/失败/未配置，不把 skip 算作通过。
- Full/Slim 包均能从干净目录启动，文件清单和 checksum 可复验。
- 架构与手册不再保留已失效的 1.x 当前态叙述；历史说明必须显式标成历史。

### EC-B · 安全更新中心（候选 `2.1`，第53波）

**目标**：把已有 `Manage-Overlay.ps1` 的安全原语带进产品界面，同时保持离线、可检查、可恢复。

- 应用内选择本地 zip；先执行签名/manifest/checksum/路径穿越/目标版本兼容预检，再允许进入应用步骤。
- 向用户展示新增、覆盖、删除和不兼容项；默认不静默覆盖用户数据和配置。
- 复用现有 backup、apply、verify、rollback 流程，增加失败恢复卡、重启交接和最近更新记录。
- 更新过程写入本地审计；诊断导出包含版本、包摘要、验证结果和恢复建议，但不包含密钥。
- 保留 CLI 作为救援路径；GUI 不复制第二套更新实现，只编排同一套受测核心。

**退出条件**：

- 错误版本、篡改包、缺文件包、路径穿越包均在写入前拒绝。
- 对 apply 中断、verify 失败和重启失败进行故障注入，原版本可恢复且用户数据不丢失。
- 同一更新包重复应用具备幂等或明确拒绝语义；所有结果可从审计与本地记录追溯。

### EC-C · MCP 运维闭环（候选 `2.1.x`，第55波前半）

**目标**：让非程序员不编辑 JSON 也能判断“接上了没有、为什么不可用、怎样恢复”。

- 统一展示 MCP 来源、transport、命令/地址、工具数、最近健康状态和能力要求。
- 支持导入、重测、启停和移除用户配置；内置连接器与用户连接器必须有清楚边界。
- 将错误归类为启动、网络、鉴权、协议协商、工具注册、超时和安全拒绝，而不是统一显示“连接失败”。
- 评估并固化 stdio、SSE、Streamable HTTP 等远程 transport 的兼容矩阵；不支持的能力必须在连接前说明。
- 配置变更走现有 token、同源、脱敏和审计护栏，禁止前端直接拼写启动命令。

**退出条件**：

- 从导入到健康检查的常见路径可完全在 UI 内完成。
- 假 MCP 与真实连接器探针覆盖成功、超时、鉴权失败、协议不兼容和工具列表变化。
- 启停或删除连接器不影响无关连接器，重启后状态与配置一致。

### EC-D · 安静工作台（候选 `2.2`，第54波 + 第55波后半）

**目标**：降低“能力很多但看不清当前任务”的负担，同时偿还前后端热点文件的维护债。

- **第54波首要切片：回合叙事化对话（P1）**。保留“一个任务一个大对话框”，但将一次助手回合中的文字、工具、后续文字、计划/询问与错误按真实发生顺序放进同一个回合容器；不再把它们固定拆成 `bubble + toolsWrap` 两块。工具在过程内是 `32–36px` 的紧凑动作行，连续或并行的成功工具自动收起，运行中和失败工具始终外露；回合尾部的“本轮记录”仍完整汇总全部工具索引、文件变更/撤销、产物和用量。详见 [UI-ESCAPADE-TURN-NARRATIVE.md](UI-ESCAPADE-TURN-NARRATIVE.md)。
- **双引擎同构前置**：Claude CLI 的 `assistant_delta → tool_use → tool_result` 与 OpenAI 兼容引擎的 `call.text → call.toolCalls → tool_result` 先归一为同一条有序 `message.segments` 序列，再交给唯一的 `turnNarrativeRenderer`；同一模型响应的并行调用共享 `batchId`。旧会话无 `segments` 时保持现有 `content → toolCalls → turnSummary` 顺序，不伪造历史过程；兼容期继续写入旧字段。
- **实施顺序**：先抽服务端 `TurnSegmentBuilder` 并给两引擎补同序事件夹具；再做持久化/旧会话回退；随后把流式和静态消息渲染改成 keyed segment list，最后接入多工具折叠、末尾“定位到过程”、简易/专家两种密度。它是本 EC 的前置，不等待整个 `app.js` 拆分完成；但应复用同一状态/事件入口，禁止再为流式、历史重进和后台回合各写一套排序逻辑。
- 默认模式聚焦当前任务，右侧非必要面板可自动收起；文件、产物、变更、Agent Run、用量和审计仍可在两次操作内到达。
- 把 `public/app.js` 按会话、Mission、工作流、产物/变更、设置等领域拆分；建立明确的状态/事件入口，停止依靠全局重绘维持一致性。
- 消息、Mission 条和工作流监控采用 keyed 增量更新；语言切换和单条事件不得重建整个主视图。
- 为消息区实现正确的 `role="log"`、焦点保持、屏幕阅读器增量播报和完整键盘等价。
- 建立深浅主题的视觉回归门 v2；CSS 按 tokens/base/components/views/themes 分层，减少跨视图选择器耦合。
- 继续拆分 agent-runs、permission、session 等后端路由与领域逻辑；接口契约与行为测试先于搬文件。

**退出条件**：

- 基准会话下，首屏可交互目标 `<1.5s`，主要视图切换 P95 目标 `<200ms`；指标只作本地基准，不声称代表所有机器。
- 同一“文字 A → 工具 1 → 文字 B → 工具 2 → 文字 C”脚本化序列在 Claude CLI、OpenAI 兼容、流式期、刷新后的静态重进和后台回合重挂载中都保持同构顺序；并行工具不得串 id 或串结果。
- 每轮末尾都能访问全部工具记录、变更/撤销与产物；成功工具可折叠，但失败项与产物不得因折叠而隐藏。旧会话必须无损打开。
- 追加消息、Agent 节点事件和 locale 切换不触发主区域全量 DOM 重建，输入焦点和滚动锚点保持稳定。
- 深浅主题、简易/专业模式、键盘与屏幕阅读器关键旅程全部进入自动或可复现人工验收。

### EC-E · Mission Ready（候选 `2.3`，第56波前置）

**目标**：先在 Escapade 中形成稳定的任务读模型和干预状态，再决定 Pretender 是否值得换壳。

- 新增 `/api/missions` 聚合读模型，把 `session.mission`、Agent Run、产物、变更、检查点、用量与审计游标投影成稳定任务快照；不复制第二套执行状态机。
- 将 permission、question、plan、task-pool decision 等未决事项统一为持久化 `Intervention`，保留原有超时自动拒绝和权限默认不放宽语义。
- 为纯问答增加明确的 Quick Ask 标识，不以启发式文本把所有会话硬套成任务。
- 任务结果必须包含验收状态、成果引用、未完成项、变更摘要和真实的回滚能力；不可逆操作显式标注。
- 定义旧 Session 到 Quick Ask / Legacy Mission 的只读适配和迁移契约，不做破坏性批量改写。
- 在现有壳层提供最小“需要你”聚合入口，用真实数据验证 Pretender 核心原语，但不提前发布 Pretender 品牌或承诺 3.0。

**退出条件**：

- 未决事项在浏览器刷新和服务重启后不丢失；重复决策不重复执行，过期/取消/已处理状态可区分。
- 老会话无损打开；现有 `/api/mission`、Agent Run 与检查点调用方不因新投影失效。
- 单任务、长任务、多 Agent 和 Quick Ask 四条代表旅程完成概念验证，并形成第56波 go / no-go 评审材料。

### 第56波 · Pretender 立项门

第56波不直接交付 Pretender 功能清单，只评估「交办台」是否值得进入 3.0。评审输入包括：

1. EC-E 的真实 Mission / Intervention 数据，而不是只靠 mockup 或前端文案派生。
2. 新壳层 PoC 对单任务、长任务、多 Agent、Quick Ask 四条旅程的改善证据。
3. 旧会话兼容、离线升级/回滚、经典壳层并存成本与退出期限。
4. UI 重构是否可以完全复用现有执行引擎、权限、工具、检查点和审计链路。
5. `docs/UI-VNEXT-CONCEPT.md` 中定义的 Pretender 目标、非目标、分阶段计划与 go / no-go 门。

只有评审通过后，才冻结 **Ruyi Pretender 3.0** 的范围、兼容策略和时间表；未通过则继续以 Escapade 壳层迭代，Mission 数据层仍作为 2.x 的用户价值保留。

### Escapade 通用发布准入

每个候选版本至少通过以下门槛：

- **版本与构建**：版本三角（`package.json` / `00-boot.js` / `facts.json`）、构建新鲜度、源码 manifest 映射和生成物差异检查。
- **行为回归**：相关单元、E2E、DOM/IA、提示词快照与 A/B、权限和恢复路径回归；KNOWN_FAILURE 不得被静默扩张。
- **视觉与无障碍**：涉及 UI 的版本必须完成双主题、支持的界面模式、键盘和焦点验收。
- **离线交付**：Full/Slim 包完整性、checksum、全新目录启动、覆盖升级和回滚演练。
- **外部探针**：真实 provider、Claude CLI、远程 MCP/connector 明确标注通过、失败或未配置；skip 不能伪装为通过。
- **文档与迁移**：CHANGELOG、用户/管理员手册、兼容说明、数据迁移与恢复步骤和实现同步。

建议在每次范围冻结时给出一页 Release Brief，只回答四个问题：解决谁的什么问题、明确不做什么、怎样证明完成、失败后怎样恢复。

## EC-A · 真实基线（候选 2.0.1）-- 首批交付（2026-07-24）

按 §"第53波起" EC-A 退出条件推进。本波让仓库、运行时事实与用户文档描述同一套产品,原则上不引入新产品能力。多 Agent 编排:5 路并行只读审计(manifest/ARCHITECTURE/手册/app.js 文案/release-dryrun+facts 基建,Deepseek 子代理 minSuccessfulToolCalls:2)+ 主会话逐条亲核 file:line + 主树串行实现。

### 交付

- **facts 静态锁增强(B2/B3/B4)**:facts.json 新增 defaultPort(8765,00-boot.js DEFAULT_PORT 重算)、tokenBootstrap("api-bootstrap",语义双锁:ROUTE_AUTH 含 POST /api/bootstrap auth=open + serveStatic browserNav 置空 __WCW_TOKEN__)、liveProbes(6,SKIP 集大小,独立于 e2eLiveSkipped 语义 + 每条 SKIP 文件名须含 live 或在白名单 deepseek-tools)。facts.static.e2e.js +6 断言全绿。**B1 裁定不做**:ACC @mcp.tool() 装饰器静态计数 109 vs 活注册表 107 差 2(条件注册/去重),精确/下界检查均会误报,沿用 venv 活对账 + CI acc-smoke。
- **manifest 0/0 根治(task6)**:06b-prompt-registry.js / 13b-api-domain-routes.js 的 startLine/endLine 都是 0(51c-b/49f 加模块未回填);且全部 17 模块行区间自 43/49 波后漂移(src 多次编辑未同步)。build.js 增强:写模式自动计算并回填行区间(算法:src 以 \n 结尾,endLine = startLine + 模块换行数;区间连续无缝隙覆盖全产物),--check 模式校验 0/0 与过期区间(CI/打包门静默不过)。src-reader.js 只读 m.file 不用行区间(已核实),修复零风险。回填 16 处漂移;06b=7712-7858、13b=19304-19510(与产物标记吻合)。新 `manifest-ranges.static.e2e.js`(17 模块逐条断言:非 0/0/与实际一致/连续/覆盖末尾)。
- **架构+手册 6 文档刷新(task7,3 个 edit-tier 节点并行 + 主会话亲核)**:ARCHITECTURE_CN/EN + USER-GUIDE_CN/EN + ADMIN-GUIDE_CN/EN。版本号 1.6.1/1.4.0 -> 2.0.0;ACC 工具 99/100 -> 107(v1.9.0);原生工具 37/39 旧口径 -> 50(TOOL_HANDLERS 轴,旧值标历史);右栏常驻页签 3 -> 6(文件|产物|变更|Agent 工作流|用量|审计)+ 开发者组 5 实名(终端|桌面|MCP|调试|存储,体检/health -> 存储,诊断已迁入设置);Steer 双引擎(47a:Claude stdin 即时注入上限3/回合 + 工作台延迟插话 + 三态按钮,非"仅 provider");token bootstrap(47c:POST /api/bootstrap + sessionStorage + CSP + host 门);模块化(43:app/src 17 模块 + build.js 拼接);52x subagentPreferredProvider/Model + 52a PROMPT_EN。回归检查:VERSION 1.6.1、1.4.0、体检/health dev-tab、100/99 工具旧口径全部绝迹。
- **release-dryrun 增强(task9,A2/A3/A4/A5)**:A3 版本三角(package.json == 00-boot.js == facts.workbenchVersion == 产物 server.js);A2 manifest 全量 sha256 对账(38 文件,不再抽样);A4 update-manifest.json 新增 minHostVersion 字段(gen-manifest.js 从 package.json 注入,build-overlay 传递,release-dryrun 校验合法版本号;运行时兼容预检属 EC-B);A5 live probe 四态独立列出(配置探针不实跑,6 件:deepseek-live/tools/desktop-bridge-live/claude-binary-live/claude-compact-probe-live/compact-quality-live,逐件 CONFIGURED/UNCONFIGURED,**skip 不算 pass**)。
- **i18n storage 路径(task8)**:app.js renderStorage/loadStorage/cleanStorage 高频路径硬编码中文抽进双语资源(STORAGE_STORE_LABELS 13 仓名 -> STORAGE_STORE_KEYS + t('storage.store.*');loading/loadFailed/unavailable/totalLabel/fileCount/transcriptNote/lastSweepNote/cleanDone/cleanNothing 共 9 个 t() 调用,zh-CN/en-US locale + docs/i18n 事实源四向同步)。

### 验证（全部亲跑）
build --check(产物新鲜 + manifest 行区间自洽)✓;facts.static(含新 6 断言)✓;manifest-ranges.static(17 模块)✓;release-dryrun(A2/A3/A4/A5 ALL PASS)✓;i18n.static(1048 键)✓;meta-guard ✓;dom-smoke(真实浏览器渲染)✓;overlay-payload-lock ✓;manuals/ia/storage-steward/uimode-style ✓。facts regen:e2eCount 157->158、defaultPort 8765、liveProbes 6。

### 待续（记入后续波）
- **i18n 余 4 路**:metrics(11)/changes(18)/memory(19)/workflow(20)共 68 串硬编码中文已审计出 file:line + proposedKey 清单(orchestrate_agents appjs-i18n-audit 节点产出,已留存),随邻近改动顺手抽进 i18n。storage 路径已建模式(storage.* 命名空间 + codemod 唯一性闸 + 事实源四向同步)。
- **A1 Full/Slim 离线包文件清单对账**:package-offline.ps1 无显式清单(递归拷贝);需 checked-in expected-files/<variant>.json + stage 目录 walk 对账。本波只做了 overlay payload 全量 sha256(A2),离线全量包清单留后续(维护负担 D3:清单只锁路径集合不锁 sha,二进制跨机器不一致)。
- **minHostVersion 运行时兼容预检**:gen-manifest 已落字段,apply 前用其做"宿主版本 >= minHostVersion"预检属 EC-B(安全更新中心)。
- **token 持久化策略**:sessionStorage 关标签页即失效是刻意的(每次启动重新握手),不改。

### 诚实交代
- B1(ACC 装饰器下界)调研后裁定不做(109 vs 107 差 2 会误报),非漏做。
- i18n 只做了 storage 一路(21 串),余 4 路(68 串)有审计清单待续,非 100% 覆盖--EC-A 的 i18n 是"扫描并清理"软性项(非退出条件),storage 路径作具体清理建模式,余者排队。
- A1 离线包清单未做(较重,需 baseline 生成 + 维护),只做了 overlay payload 全量对账。
- 多 agent 编排可靠性:本波 5 路只读审计 + 3 路 edit-tier 文档编辑,toolEvidence 显示真实工具调用(40/22/39/20/32 次),主会话逐文件亲核 file:line 确认落地(含抓获 arch 节点 line 21 before 误报 99 实为 100->107、admin 节点 451 冗余等),无失实落盘。

### 对抗验证与收尾（二轮，2026-07-24）

**i18n 全 5 路收尾**: storage(已交付)+ metrics/changes/memory/workflow 4 路(orchestrate_agents 4 路只读代理产出 codemod 规格,主会话串行跑 codemod 97 处替换 + 6 处 replace_all/精确)= 全 5 路 ~106 串进 i18n。

**多 agent 对抗验证**(4 路只读对抗审查:facts+manifest门/文档事实/release-dryrun逻辑/i18n正确性,minSuccessfulToolCalls:3,各 27-39 次工具调用),主会话亲核后修:

- **i18n 嵌套键 P0(最重,7 条)**:`translate()` 是 `catalog[key]` **扁平查找**,不遍历嵌套;但 i18n 4 路 + storage + 51c-a 遗留的 changes.op.*/workflow.node.status.* 都用了**嵌套 locale 对象** -> t() 返回 `[key]` 渲染原始键名(用户看到 `[workflow.budget.loop]`)。**51c-a 起的 changes.op.*/workflow.node.status.* 一直是坏的,我的 i18n 继承了同样错误**。根治:**全量递归扁平化 locale**(zh+en,1050 顶层键 -> 1212 扁平键,嵌套对象 -> 点号扁平键,对齐既有 app.title 约定),一次修好我的 + 51c-a 遗留。系统验证 712 个静态 t() 键 + 动态前缀(storage.store.* 13/workflow.node.status.* 15/changes.op.* 3/workflow.pool.status.* 5)全解析,0 真缺失。
- **codemod bug P0×2**:app.js:3660(t('workflow.isolation.prefix') 被包在模板字面量里成字符串,未调用)、3572(嵌套模板字面量破坏,t('workflow.pool.node') 未调用) -- 子代理 codemod 规格 find/replace 对含 `${}` 的模板行处理出错,主会话亲核抓获并改写为正确 t() 调用。
- **文档事实 P0×2**:ARCHITECTURE_CN /api/steer 仍写"仅 provider 引擎"(实为双引擎 47a:Claude interactive stdin 即时注入+provider steerQueue)、ARCHITECTURE_EN "limit 3/turn" 归于 Claude(3 是 provider 的 STEER_QUEUE_MAX,Claude 无 per-turn cap,仅 2000 字截断+提问挂起拒)。修为准确双引擎语义。
- **页签顺序 P1×2**:USER-GUIDE CN/EN 把审计写在变更前(实际 index.html 是 文件|产物|变更|Agent工作流|用量|审计),对调。
- **release-dryrun P1**:A5 providerKeyed 用 Object.values(cfg.providers) 但 providers 是数组(误用)、dsKey 只查 env 漏 config 里的 deepseek 端点(修后 6 probe 全 CONFIGURED)、A3 server.js 版本用脆弱 includes(改 regex)、A2 shape 漏空串(加 sha256.length===64)。
- **缺失键**:toast.rollbackFail(changes 回滚失败 toast,3 处用但 locale 无) -- 系统验证抓到,补 zh/en。

**裁定不做(经核)**:build.js Atomics.wait P1 是**误报**(Node.js 主线程允许 Atomics.wait,浏览器才禁);facts.static tokenBootstrap grep 锁语法非语义(静态锁固有取舍,当前 grep 对当前代码有效);A1 ZIP-ignore(当前 keyFiles 检查能抓部分 stage 缺失,ZIP 失败是 env tar 问题);A4 minHostVersion 运行时语义(EC-B 范围)。7 处余硬编码中文(stepBar/rewindConfirm/context tooltip 等)是**预存非 EC-A 5 路范围**,记入后续。

**验证(全亲跑,二轮)**:build --check/facts.static/manifest-ranges/release-dryrun(A1-A5)/i18n.static(1212 键)/dom-smoke/meta-guard/storage-steward/ia/uimode-style/manuals/overlay-payload-lock + agent-workflow-templates/session-index/usage-ledger/subagent/perm-v2/auth-deny-default/prompt-snapshot/capabilities 全绿。**i18n 系统验证:712 静态 t() 键 + 4 动态前缀全解析,0 真缺失键**。

**教训**:子代理 codemod 规格(find/replace)对含 `${}` 模板字面量的行易出错(3660/3572),跑 codemod 后必须**系统验证所有 t() 键可解析** + grep mangled 模式(`t(' / 嵌套反引号);51c-a 的嵌套 locale 错误潜伏多波(i18n.static 只查 catalog 对等不查键可解析性,dom-smoke 不触发 workflow 节点状态标签),对抗验证的"提取所有 t() 键逐一查 locale"才抓到。**t() 扁平查找是本仓库的硬约束,locale 必须全扁平点号键**。

### EC-A 发布加固续项 · 首装与 Claude 原生 Agent 生命周期（2026-07-24）

- **首装交付**：Full/Slim 启动前校验关键文件与自带 Node，ZIP 预览/不完整解压/长路径漏文件给出短路径完整解压指引；Full 的 ACC 安装失败降级为基础工作台可用，并保留诊断日志。
- **原生 Agent 协议闭环**：解析 Claude Code 字符串形态的 `<task-notification>`；后台启动回执保持 running，不再误报 completed；父回合提前返回且仍有子 Agent 时，interactive 进程自动追加有界 `TaskOutput(block:true)` 等待并汇总结果。
- **终态诚实性**：CLI 退出仍未收到完成通知时，将子 Agent 标为 interrupted，避免永久“运行中”或伪造成功。
- **DAG 可见性**：前端把可观测的“Claude 主对话 → 原生子 Agent”投影为只读内存 DAG，展示启动、真实等待时长、成功/失败/中断；不虚构 Claude CLI 未提供的内部工具步骤，也不开放无效的插话/重试操作。
- **兼容边界**：生命周期政策只注入 Claude CLI 主回合，不进入 OpenAI-compatible Provider、工作流 Claude 节点或 Kimi/Ark 端点环境映射；现有双引擎与 Coding Plan 切换契约保持不变。

## 第53波 EC-B · 安全更新中心 -- 首批交付（2026-07-26）

按 §"EC-B · 安全更新中心" 退出条件推进。本波把已有 `Manage-Overlay.ps1` 的 apply/rollback/verify 安全原语加固为「先预检、可审计、可幂等」的受测核心,并加后端 API 编排层;GUI 不复制第二套更新实现,只编排同一份 PS1。多 agent 协作:Deepseek V4 Pro 对抗审查(20 次工具调用亲读 PS1/API/e2e 三件)+ 主会话亲核修复。

### 交付

- **53a PS1 受测核心加固(`tools/Manage-Overlay.ps1`)**:UTF-8 BOM(PS5.1 cp936 系统正确解析中文注释)。新增 `precheck`/`audit` action + `-OverlayRoot`/`-Json`/`-Force` 参数。
  - **precheck(写入前全检)**:四类失败均在写入前拒绝 -- ① 路径逃逸(manifest 条目含 `..`/盘符/绝对路径,防 zip-slip 越界写)② 完整性(payload 每文件 sha256 == manifest,防篡改/缺文件包)③ 版本兼容(包 `minHostVersion` > 宿主 `package.json` version -> 拒)④ 幂等(同版本已 apply 且无 `-Force` -> precheck 警告,apply 升格拒)。变更预览(new/overwritten/unchanged/deleted)。
  - **apply 内联 precheck**:Do-Apply 先跑 precheck 全检,失败即拒、绝不写入(backup 目录都不建)。post-apply verify 结果决定顶层 `ok`/审计 `result`(对抗审查 BUG-2:不再硬编码 ok,copy 成功但写入损坏时 verify 抓得到,审计如实记 `verify_failed`)。`.overlay-audit.jsonl` append-only 审计日志(每条 seq/ts/action/version/result/fileCount/backup/error)。
  - **rollback `-Force`**:默认拒(服务在跑别覆盖,向后兼容 CLI 安全);`-Force` 跳过(API 路径自动带,因 API 跑在服务内,文件覆写后 restart 加载恢复的旧文件 -- 与 apply 同语义)。
  - **输出纪律(-Json)**:每个 action 向 pipeline 输出恰好一个 JSON 对象。内部 helper 全赋值收集、`New-Item|Out-Null`、自增用 `$x=$x+1`(对抗审查 BUG-1:`$x++` 表达式会向 pipeline 吐旧值破坏 JSON)。`Get-PrecheckCore` 抽出 4 检查供 `Invoke-Precheck`(带预览+输出)与 `Invoke-PrecheckInternal`(Do-Apply 内联)共用,消除重复(对抗审查 BUG-3)。
- **53b 后端 API 编排层(`app/src/13c-overlay-routes.js`,manifest 模块 18)**:不复制第二套更新实现,只编排 PS1。
  - 四条路由(全 `token` 级,同 checkpoints/rollback 破坏性档,入 `ROUTE_AUTH`):`POST /api/overlay/precheck` { zipPath } / `POST /api/overlay/apply` { zipPath, force? } / `GET /api/overlay/status` / `POST /api/overlay/rollback`。
  - 流程:zipPath 绝对路径+.zip+存在校验 -> PowerShell `Expand-Archive` 解压到 `dataRoot/overlay-tool/extract-<ts>-<rand>/`(工作区内) -> `findOverlayRoot`(Manage-Overlay.ps1 + payload/update-manifest.json,深度≤2) -> 缓存 PS1 到 `dataRoot/overlay-tool/`(供后续 rollback/audit) -> 调 PS1 -Json -Target externalRoot() -> 解析 JSON 返回。extractDir 成功/失败路径都清理。
  - `status` 直接读 `.overlay-applied.json`/`.overlay-backups/`/`.overlay-audit.jsonl`(无需 PS1,无缓存也能工作);剥 BOM(PS5.1 `Set-Content -Encoding UTF8` 带BOM,Node `JSON.parse` 遇BOM抛)。GET handler 内自查 `tokenOk`(同 `/api/audit` 纵深纪律)。
  - 单引号转义防 `Expand-Archive` 命令注入;`logEvent` 审计每个动作。
- **53c e2e 故障注入(`dev-harness/overlay-update-core.e2e.js`,65 断言全绿)**:
  - **S 段静态锁**(9):PS1 含 precheck/audit/路径逃逸/版本兼容/幂等/审计/内联 precheck;API 入 bundle;四路由入 ROUTE_AUTH;manifest 模块 18。
  - **A 段 PS1 核心**(13):precheck 合法包(预览 new/overwritten) + apply(写入+备份+标记+restartNeeded) + audit;A13 输出无管道泄漏(BUG-1 防回归:严格解析检测 first-{ 前非空白)。
  - **B 段故障注入**(15):路径穿越/篡改/缺文件/版本不兼容 四类坏包,precheck + apply 均 rejected,且**零写入**(不建 `.overlay-backups`、不越界写文件)。
  - **C 段 API 编排**(21):precheck(合法+非zip/相对路径 400) + apply + 幂等拒 + -Force 覆盖 + status(版本/备份/审计) + apply V2(不同版本) + status 版本切换;无 token 403。
  - **D 段可恢复**(3):API rollback 一步回退(V2-DATA -> NEW-OVERLAY-DATA,证上一步状态恢复)。
  - 测试 server.js 复制到临时部署跑(externalRoot()=临时部署,不污染真源);token 经 `POST /api/bootstrap`(47c,不依赖 index.html)。

### 对抗验证(Deepseek V4 Pro 子代理,20 次工具调用亲读三件)

verdict has_bugs -> 3 real bug 全修 + 4 minor 全收口:
- **BUG-1 `$restored++` 管道泄漏**(Do-Rollback):表达式向 pipeline 吐 0,1,2... 破坏 -Json 单对象输出;e2e forgiving 切片解析漏抓(假绿)。修:`$restored = $restored + 1`(赋值无输出)。e2e 加 A13 严格泄漏检测防回归。
- **BUG-2 apply 审计硬编码 ok**(Do-Apply):post-apply verify 结果未影响顶层 ok/审计 result;copy 成功但写入损坏时审计谎报 ok。修:`$applyOk = $vr.ok`;result=`ok`/`verify_failed`;顶层 ok=$applyOk。
- **BUG-3 `Invoke-Precheck` 与 `Invoke-PrecheckInternal` 重复~90%**:未来修改易分歧,apply 内联路径漏检。修:抽 `Get-PrecheckCore`(4 检查)共用。
- **MINOR-1/2**:B2/B3/B4 补零写入断言 + B4 补 apply 拒绝测试;C15 -Force 补备份计数断言(证 apply 真执行)。
- **裁定不做**(经核):MINOR-3 rollback 不删 overlay 新增文件(已文档化 "harmless",原 PS1 同行为,需先逃过 4 项 precheck);MINOR-4 apply 中途失败半旧半新态(有备份可手动 rollback,设计如此)。

### 验证(全部亲跑)

`overlay-update-core.e2e`(65 断言)全绿;`build --check`(产物新鲜+manifest 行区间自洽);`facts.static`(e2eCount 158->159);`manifest-ranges`(模块 18 区间);`overlay-payload-lock`(13c 经 src 模块清单入载荷,敏感目录无未登记);`auth-deny-default`/`dom-smoke`/`mcp-import-config`/`checkpoint` 回归全绿。PS1 BOM 后 Parser API 干净解析;precheck/apply/rollback -Json 输出经严格解析(无管道泄漏)。

### 待续(记入后续波)

- **53d 前端 GUI**:设置面板「更新中心」入口 -- 选 zip -> precheck 预览(新增/覆盖/删除/不兼容) -> 确认 apply -> 进度 + restartNeeded 提示 -> 失败恢复卡 + 最近更新记录。i18n 双语。CLI 保留为救援路径。本波只交付后端 API + 受测核心,GUI 是 EC-B 用户价值落地的最后一环。
- **53e 签名预检**:现 precheck 覆盖 manifest+checksum(完整性)+路径穿越+版本兼容;真正的包签名(Authenticode/PKI)未做(需密钥基建),属 EC-B 后续。
- **53f 故障注入 e2e 扩展**:apply 中断(kill 中途)+ verify 失败 + 重启失败 三类故障注入,验证原版本可恢复且用户数据不丢(EC-B 退出条件#2 的完整覆盖;本波 D 段只测了 rollback 正常路径)。
- **CHANGELOG/版本**:本波是 EC-B 内部首批交付,不 bump 版本(保持 2.0.1);EC-B 完整(GUI + 签名 + 故障注入)经范围冻结/测试/打包门后再决定 2.1 发布。


### 第53波 EC-B 续项交付 53d/53e/53f（2026-07-26）

按首批交付的「待续」推进 53d/53f,53e 经评估裁定。多 agent 协作:Deepseek V4 Pro 对抗审查(29 次工具调用亲读 GUI/PS1/e2e)+ 主会话亲核修复。

### 53d 前端更新中心 GUI

设置面板新增「更新中心」页签(专家模式可见,简易模式收敛),编排 53b API(不复制第二套实现):

- **index.html `stab-update` 面板**:当前状态(版本/应用时间/备份数)+ 选 zip(`ovPickBtn`)+ 预检(`ovPrecheckBtn`)+ 应用(`ovApplyBtn` + `ovForceChk` 强制重装)+ 变更预览(新增/覆盖/未变/移除 + 宿主/最低版本兼容)+ 失败恢复卡(`ovResult`/`ovRecoverBtn`)+ 回滚/刷新 + 审计尾(`ovAudit`)。
- **app.js overlay 函数族**:`refreshOverlayStatus`(GET status)/`overlayPickZip`(POST pick-file)/`overlayPrecheck`(POST precheck,启 apply)/`overlayApply`(POST apply,restartNeeded)/`overlayRollback`(POST rollback)。`switchSettingsTab` 加 update hook。
- **`/api/pick-file` 后端**:`pickFile(filter)`(10-context-governance.js,OpenFileDialog + TopMost owner,同 pickFolder 模式)+ 路由 + ROUTE_AUTH token 级。前端选 zip 的原生文件选择器。
- **i18n**:35 个 `settings.update.*` 键 × zh-CN/en-US 双语(locale + docs/i18n 事实源四向同步)。占位符 `{{p1}}/{{p2}}` 契约。
- **`overlay-update-gui.static.e2e.js`**(24 断言):HTML 页签/面板/按钮/字段 + app.js 函数族/hook/绑定/API 调用 + locale 中英对等/占位符 + 后端 pickFile/路由 wiring。

### 53e 签名预检 -- 评估裁定不做实现

经评估,真正的包签名(Authenticode/PKI)需要密钥基建(证书签发 + 私钥管理 + 公钥分发),当前不具备,属 EC-B 后续。裁定理由:

- 当前 precheck 的 **sha256 完整性校验已是事实保证**(防篡改/缺文件包,逐文件校验 manifest),覆盖了"包内容可信"的核心需求。
- 真正的**来源认证**(确认包来自可信发布者)需要非对称签名(RSA/Ed25519 + 公钥分发)。轻量 HMAC(对称密钥)方案有**虚假安全感**:密钥必须存在部署里用于校验,攻击者拿到部署即拿到密钥,可重签任意包。
- 在密钥基建就绪前,签名框架是空壳(签名字段恒空),不引入价值。框架留待 PKI 就绪后落地(gen-manifest 加签名工具 + 部署预置公钥 + precheck 验签)。

### 53f 故障注入 e2e E 段（EC-B 退出条件#2 完整覆盖）

`overlay-update-core.e2e.js` 加 E 段(9 断言),验证"故障后原版本可恢复且用户数据不丢"+"可从审计追溯":

- **verify 失败检测**:apply 合法包 -> 篡改已应用文件(模拟磁盘损坏/杀毒改写)-> `Do-Verify` 报 `ok=false` + mismatches 含该文件。
- **中断可恢复**:篡改后 `rollback -Force` -> 恢复到 apply 前原数据(`ORIGINAL-E`,用户数据不丢)。
- **审计可追溯**:`audit` 尾含 `apply ok`(故障前)+ `rollback ok`(恢复),故障->恢复链完整(>=2 条)。
- E6 磁盘直读验证(非假绿);E 段独立 `DEPLOY_E` 不污染 D 段。

### 对抗验证(Deepseek V4 Pro,29 次工具调用亲读 GUI/PS1/e2e)

verdict has_bugs -> 4 real bug 全修 + 3 minor 收口:
- **A1/A2 XSS**(real):`refreshOverlayStatus` audit innerHTML + `overlayApply` ok innerHTML 拼接 `e.version`/`r.version`(来自 overlay manifest,攻击者可控)-> 存储型 XSS。修:动态值经 `escapeHtml()`(app.js 已导入)。`t()` 的 interpolate 不转义,故 version 先 escape 再传 t()。
- **A3 mismatches innerHTML**(minor):文件路径进 innerHTML,利用难但防御性 escape。
- **B2 按钮状态机**(real/minor):`overlayApply` rejected/else/ok 分支未恢复 `ab.disabled=false`,apply 失败后按钮卡死(需重选 zip 恢复)。修:三分支恢复 disabled。B1(precheck catch 保持 apply 禁用)经核 notbug(precheck 失败时 apply 应禁用)。
- **F4 事件循环阻塞**(real):`runOverlayPs1` 用 `cp.execFileSync` 阻塞 Node 事件循环最长 5min(apply 期间全服务挂起)。修:改 `cp.execFile` + Promise 异步化,3 路由调用处加 `await`。
- **C `_ovZipPath` TOCTOU**(minor):用户快速切换 zip,precheck A 但 apply B。需用户快速操作,留后续(可加 precheck 快照比对)。
- **pickFile/D/13c 路由** notbug:safeFilter 单引号移除够(PS 单引号内元字符字面量);zipPath 三重校验;status GET 自查 token;rollback 无 body 无害。

### 验证(全部亲跑)

`overlay-update-core.e2e`(70 断言:S9+A13+B15+C21+D3+E9)全绿;`overlay-update-gui.static`(24)全绿;`build --check` 新鲜;`facts.static`(e2eCount 159->160);`i18n.static`(1212+35 键);`dom-smoke`/`auth-deny-default`/`mcp-import-config`/`checkpoint`/`overlay-payload-lock`/`manifest-ranges` 回归全绿。runOverlayPs1 异步化后 70 断言无回归。

### 待续(记入后续波)

- **53e 签名预检**:PKI 基建就绪后落地(评估结论见上)。
- **53g 工程收尾（已完成）**:2026-07-26 复跑 `overlay-update-core.e2e` 70 断言、`overlay-update-gui.static.e2e` 24 断言与 `build --check` 全绿；第53波工程范围闭环。当前仍保持 2.0.1，不因内部波次自动 bump 版本；是否发布 2.1 另走范围冻结与打包门。
- **C TOCTOU**:precheck 快照比对(用户快速切换 zip 的竞态,minor)。
- **重启交接自动化**:当前 apply 成功提示用户手动重启;自动化 restart handoff(优雅停服->apply->重启)留后续。

## 第54波 EC-D · 安静工作台 -- 已完成（2026-07-26）

按 §“EC-D · 安静工作台”的 P1 首要切片推进。本波完成双引擎有序回合数据、流式/静态同构渲染、决策状态复原、宽屏阅读面、键盘/读屏增量语义与双主题像素门；EC-D 更大范围的全应用拆域和 CSS 全量分层继续属于第55波后半，不再混入第54波验收。

### 54a 双引擎有序回合协议

- `02-session-store.js` 新增共享 `createTurnSegmentBuilder()`；Claude CLI 与 OpenAI 兼容引擎都将 `assistant_delta / thinking_delta / tool_use / tool_result / subagent / plan / ask_user` 归一为有序 `message.segments`。
- 工具段只存 `toolCallId/name/batchId/status`，输入与结果继续以旧 `message.toolCalls` 为事实源，避免 session JSON 再复制一份大结果；兼容期继续写 `content/thinking/toolCalls/turnSummary`，旧客户端与旧会话不受影响。
- OpenAI 同一模型响应的并行工具共享 `batchId`；Claude 连续 `tool_use` 同样归入一批。`tool_result` 按 id 回填状态，避免并行结果串卡。
- 旧会话没有 `segments` 时严格保持原来的 `content → toolCalls → turnSummary` 展示，不推测历史上已经丢失的事件顺序。

### 54b 回合叙事化渲染

- 流式助手消息改为单一 `.turn-narrative` 容器：文字遇到工具/计划/询问/错误时先封存为独立 Markdown 段，后续文字在事件之后另起段，因此真实呈现“文字 A → 工具 → 文字 B”。
- 静态重进由 `renderStaticTurnNarrative()` 读取同一 `message.segments` 顺序；Claude CLI 与 OpenAI 兼容不再各有一套排序逻辑。
- 同批多个成功工具自动折叠为紧凑组；运行中或失败组保持展开。回合尾部新增折叠的“本轮记录”，完整列出工具并可“定位到过程”；现有变更/撤销、产物和用量继续在末尾展示。
- plan 流式文本会被语义计划段替换，避免“计划正文 + 同内容计划卡”重复；question/note 也进入回合过程。

### 54c 全屏聊天宽度

- 桌面消息与“加载更早”阅读面从固定 `max-width:880px` 调整为 `width:min(1320px, 94%)`。全屏与超宽屏不再只有约四分之一到三分之一宽度，中等窗口仍保留 3% 两侧呼吸边距，窄屏自然收缩。

### 54d 决策、工作流与 Mission 状态闭环

- `permission_request / permission_paused / permission_decision`、`ask_user / question_answer`、`plan / plan_decision`、`agent_workflow` 与 `mission` 全部进入同一个 TurnSegmentBuilder；请求段原位更新到 allowed/denied、answered/cancelled、approved/rejected、done/error 等终态。
- 决定事件由服务端在真正 settle promise 时发出，超时、停止和远端决定也走同一路径；刷新后的静态消息不再依赖仅存于浏览器内存的状态。计划驳回意见与提问答案摘要按上限持久化，完整工具输入/结果仍不复制。
- 流式权限、提问、Mission 卡在叙事原位更新；工作流沿用现有详细监控卡，静态重进提供紧凑状态摘要。顺手修复“无活动父回合、无 Provider 的直接 DAG 启动误选 OpenAI”问题，Claude-only 工作台恢复默认走 Claude CLI。

### 54e keyed 增量、长回合与无障碍

- 新增前端领域模块 `public/js/turn-narrative.js`，集中消息 key、O(1) 渲染签名和滚动锚点；静态 reconcile 不再 `messages.innerHTML=''`，复用未变化消息节点，并在 locale/config 刷新时保留在途 live shell 与阅读位置。
- 消息区使用 `role="log"`；静态历史 reconcile 期间临时 `aria-live=off + aria-busy=true`，避免读屏重播历史，恢复后仅播报新增/状态变化。助手回合使用带本地化标签的 `article`。
- “定位到过程”会移动键盘焦点并显示定位环；原生 `details/summary` 保持键盘可达。静态和流式连续成功工具第 4 项起归并为完成组，失败/运行项留在原位；100 次工具调用不再产生 100 条默认可见行。

### 54f 视觉回归门 v2 与发布载荷

- 新增 `dom-screenshot.e2e.js`：通过 `?theme=dark|light` 固定主题、系统 Edge/Chrome 截取 `1440×1000`，零 npm 依赖解析 PNG，并以 12×8 感知网格和容差对比 checked-in 基线；明暗两态必须彼此显著不同且各自命中基线。
- `turn-narrative.js` 已进入 overlay 显式载荷表，`overlay-payload-lock` 同时锁住 HTML 引用与敏感目录，避免增量包漏模块导致白屏。

### 验证（全部亲跑）

- `turn-narrative.static.e2e`：builder 顺序、batch/status、plan 去重、权限/提问/工作流/Mission 终态、keyed/scroll/a11y、长工具折叠、尾部定位、1320px 宽度和双语键全绿。
- `source-fields.e2e`：真实启动两套离线引擎；OpenAI 并行工具持久化 `tool,tool,text` 且共享 batchId，Claude 工具剧本持久化 `text,tool,text` 且 result 状态回填，全绿。
- `plan-mode.e2e`：批准/驳回事件与 session 静态状态复原；`interactive-question.e2e`：Claude/OpenAI 同构 answered 事件；`perm-v2.e2e`：超时拒绝状态；`mission-driver.e2e` 与 `agent-workflow-claude-engine.e2e` 全绿。
- `dom-screenshot.e2e` 明暗像素基线、`dom-smoke` 真实 Edge、`build --check`、`manifest-ranges`、`overlay-payload-lock`、`facts.static`、`i18n.static`、`ui-v4-glass.static`、`theme`、`uimode-style` 全绿；事实计数 160 → 162。

### 第54波退出结论

第54波范围已闭环，无本波待续项。EC-D 的全应用 `app.js` 领域拆分、CSS tokens/base/components/views/themes 全量物理分层、Mission/Agent 节点的更广泛 keyed 更新和性能基准属于原计划“第55波后半”，按独立契约与迁移批次继续，避免用一次高风险搬家稀释本波用户可见交付。

## 第55波 EC-C · MCP 运维闭环 -- 55a 后端地基（2026-07-26）

按 §“EC-C · MCP 运维闭环”退出条件推进。本波让非程序员不编辑 JSON 也能判断「接上了没有、为什么不可用、怎样恢复」。55a 为后端地基（统一读模型 + 健康探针 + 错误归类 + 兼容矩阵 + 路由 + e2e），前端 GUI 与启停/删除持久化在 55b/55c。

### 55a 统一读模型 + 健康探针 + 错误归类

- **`04-permission-runtime.js` 四函数**（collectBridgedTools 之后）：
  - `MCP_COMPAT_MATRIX`：stdio / sse / http(streamable-HTTP 2025-03-26) 三 transport 的能力清单 + 局限 + `supportsListChanged`，连接前说明（退出条件#4）。
  - `classifyMcpError(err, entry)`：裸错误归一为 7 类（`startup`/`network`/`auth`/`protocol`/`tool_registration`/`timeout`/`security`），顺序敏感（auth/startup/network/timeout/security/tool_registration 在 protocol 之前，因握手失败常携带更具体根因词），而非统一「连接失败」（退出条件#3）。
  - `probeMcpConnector(entry, opts)`：单连接器显式健康探测，复用 `getMcpClient`（活则直给、死则重 spawn），绝不抛，返回 `{status:'ok'|'degraded'|'failed', category?, toolCount?, latencyMs, probedAt}`。start 阶段用 probe 超时竞速（避免 stdio 8s rpc 超时拖慢用户重测）。
  - `buildMcpConnectorInventory(config, {probe})`：合并 desktop/config/drop-in 三源为带 `source`/`transport`/`commandOrUrl`/`enabled`/`builtIn`/`capabilities` 的统一清单（**含 disabled 条目**，UI 需展示并允许启用）；probe 时复用 `resolveExternalMcpServers` 取真实 entry（无漂移）；env 值 `maskKey` 掩码，远程 URL 经 `safeUrlForDisplay` 剥离 userinfo（退出条件#5：配置变更走 token+审计路由，禁止前端拼拼写启动命令）。
- **`13b-api-domain-routes.js` 两条路由**（handleMcpApiRoutes 末尾，token 级）：
  - `GET /api/mcp/connectors?probe=1`：统一清单 + 兼容矩阵随附；`probe=1` 时对 enabled 条目附 health。
  - `POST /api/mcp/connectors/health {id, timeoutMs?}`：单连接器显式重测；id 不在启用清单（disabled/未配置）-> 404 人话。
- **`fake-mcp.js` 故障注入件**：`FAKE_MCP_HANG_INIT`（不应答 initialize -> timeout 类）、`FAKE_MCP_BREAK_INIT`（回 JSON-RPC error -> protocol 类），纯加法默认行为不变。
- **`dev-harness/mcp-ops-closure.e2e.js`**（约 60 断言）：P 段 classifyMcpError 7 类 + 端口号不误归 auth + URL 脱敏；U 段 inventory 无探针形状（三源/disabled/env 掩码）；G 段 inventory 探针（enabled ok / disabled 不探针）；I 段 GET 清单形状 + compat；A-F 段 POST /health 五探针场景（成功/启动失败/协议不兼容/超时/HTTP 401 鉴权）+ legacy SSE `tools/list_changed` 工具列表变化（2->3）；G2 段并发探针互斥（PID 计数验证只 spawn 1 个子进程）；S 段静态锁。

### 对抗验证（Deepseek V4 Pro，17 次工具调用亲读六件源码）

verdict 需修后合入 -> 1 P2 + 3 P3 全修：
- **P2 `getMcpClient` 无互斥**（real）：probeMcpConnector 的 start race-timeout（可低至 2s）先于 getMcpClient 的 8s rpc 超时返回，第二次同 id 探针在 pending 窗内会 spawn 第二个子进程；两个都成功时第一个成孤儿（`child.unref` 只防阻止退出不杀进程，持有句柄/端口/锁）。修：加 `mcpClientPending` Map，同一 entry.id 的并发调用复用同一个 start Promise（一处约 10 行）。e2e G2c 用 `FAKE_MCP_PID_CAPTURE` 计数子进程验证：并发探针恰好 spawn 1 个。
- **P3 auth 正则误匹配端口号**（real）：`(^|[^\d])(401|403)` 会把 `ECONNREFUSED 127.0.0.1:401` 归 auth（端口 401）。修：锚定 HTTP 上下文 `(?:HTTP|状态|status|code)\s*(401|403)\b|unauthorized|forbidden`，端口不误归。e2e P8b 覆盖。
- **P3 disabled 时仍阻塞 autodetect**（real）：`buildMcpConnectorInventory` 的 guard 是 `if (dm)` 非 `if (dm && dm.enabled)`，`dm.enabled===false` 且 `dm.autodetect===true`（normalizeConfig 默认）时仍调 `detectDesktopMcp()`（内部 `spawnSync` 最多 5s），无 ACC 安装的用户每 15s 的 GET 清单阻塞事件循环。修：autodetect 分支加 `dm.enabled !== false` 守卫（与 `resolveExternalMcpServers` 的 `if (dm && dm.enabled)` 对齐）。
- **P3 URL 凭据泄漏**（real）：`commandOrUrl` 原样返回 URL，`http://user:pass@host/mcp` 的凭据经 token 路由返回前端。修：`safeUrlForDisplay` 用 `new URL` 剥离 `username`/`password` 再 toString。e2e P10 覆盖。

### 验证（全部亲跑）

`mcp-ops-closure.e2e`（约 60 断言）全绿；MCP 家族回归（`mcp-bridge`/`mcp-remote-transport`/`mcp-import-config`/`mcp-config`/`fake-mcp-contract`）全绿；`build --check` 新鲜；`facts.static`（e2e 162->163）；`overlay-payload-lock`/`auth-deny-default`/`dom-smoke` 回归全绿。getMcpClient 互斥改动向后兼容（单调用路径行为不变）。

### 待续（记入后续波）

- **55b 启停/删除持久化**：`POST /api/mcp/connectors/toggle` {id, enabled}、`DELETE /api/mcp/connectors` {id}（仅 config 源；desktop/drop-in 拒绝并给原因）；启停/删除不影响无关连接器，重启后状态与配置一致（退出条件#3）。
- **55c 前端 GUI**：设置面板「MCP 运维」页签 -- 统一连接器列表（source 徽章 + transport + 健康灯 + 错误类别人话）+ 重测/启停/移除按钮 + 导入入口;从导入到健康检查的常见路径完全在 UI 内完成（退出条件#1）。
- **EC-D 后半（第55波后半）**：全应用 `app.js` 领域拆分、CSS tokens/base/components/views/themes 全量物理分层、性能基准（首屏 <1.5s、视图切换 P95 <200ms），按独立迁移批次继续。
- 本波不 bump 版本（保持 2.0.1）；EC-C 完整（55b/55c）经范围冻结/测试/打包门后再决定 2.1.x 发布。
