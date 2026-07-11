# dev-harness —— 如意 Ruyi 后端契约验证脚手架

本轮为工作台(`ruyi-workbench`)与桌面控制(`ai-computer-control`)写的**离线 e2e** 与假件(fake)。
纯 Node、零 npm;路径已改为 `__dirname` 相对解析(dev-harness 与两子项目同级),**无需手改 WB 路径**。

## 怎么跑

```powershell
# 单件
node dev-harness\openai-engine.e2e.js
# 每件自成一体:spawn fake-openai/fake-mcp + workbench,断言,taskkill 清理,exit 0=全绿。
```

**离线件应 ALL PASS**(不含需真端点/真 Python 的 live 件)。每件文件头部注释都列了它断言的边界。
需外部条件的件:`deepseek-live`/`deepseek-tools`(真 DeepSeek 密钥)、`desktop-bridge-live`(真 python 桌面 MCP)、
`desktop-mcp-smoke`(`AI_COMPUTER_CONTROL_HOME` 指向 ACC 仓库)。
`model-tier-probe.js` 是**实弹评测件**(非回归、无 `.e2e.js` 后缀、判定行 DONE 而非 ALL PASS,不进离线回归 grep;见下「实弹/探针」)。

## fake 家族 env 契约

### fake-openai.js —— 假 OpenAI 兼容 SSE 端点

| env | 语义 |
|---|---|
| `FAKE_OPENAI_PORT` | 监听端口(默认 8911;也可 argv[2])。 |
| `FAKE_TOOL_PATH` | 首个带 `tools` 的回合吐 `file_read {path: 此值}` 的单 tool_call;下一回合 echo 该工具结果内容。 |
| `FAKE_TOOL_NAME` | 首个 tools 回合调用此(可带桥接前缀)工具名,args 取 `FAKE_TOOL_ARGS`;下一回合 echo。 |
| `FAKE_TOOL_ARGS` | 配合 `FAKE_TOOL_NAME` 的 JSON 参数对象。 |
| `FAKE_TOOL_SEQUENCE` | JSON 数组 `[{name,args}]`。第 N 个带 tools 请求按 history 里 `role:'tool'` 数吐第 N 个**单** tool_call(id `call_1..call_N`,args 分两 SSE 片段);耗尽后 echo 收尾。**优先于** `FAKE_TOOL_PATH/NAME`。 |
| `FAKE_PARALLEL_TOOLS` | JSON 数组 `[{name,args}]`。首个 tools 请求在**一条** assistant 消息里吐全部 N 个 tool_call(index `0..N-1`);下一请求 echo。 |
| `FAKE_REJECT_TOOLS` | `=1`:**首个**带 tools 的请求回 400(消息含 `tool/function` 命中工作台 tools-rejected 嗅探、但避开 stream_options 正则);后续**无** tools 请求正常流式。驱动 `runOpenAiTurn` 去 tools 重试分支。一次性(首拒后翻标志)。 |
| `FAKE_STREAM_DELAY_MS` | `=N`:每个 SSE 数据帧之间 sleep N ms,把 turn 拉长(≈N×帧数),给 steering/loop 测试留插话窗口。作用于 tool-sequence 与 echo 路径。0=瞬时,零行为变化。 |
| `FAKE_CAPTURE_DIR` | 每个请求体落盘 `<dir>/req-<n>.json`(n 从 1、零填充)。供断言注入的 `system` 消息(身份钉死/项目记忆围栏/「当前不可用」)。 |
| `FAKE_REJECT_TOOLS_WORDING` | (v0.9-S0)覆盖 `FAKE_REJECT_TOOLS` 的 400 文案(默认沿用现文案 `this model does not accept the tools / function calling parameter`)。供注入**旧误判形状**——同时命中 `/tool\|function/i` 与 `/…not\s*support…/i` 的措辞(如 `tools are not supported here`),验证 v0.9-S0 归因收紧后仍走 tools-rejected(因请求带 tools)。 |
| `FAKE_VISION` | (v0.9-S0)`=1`:image-echo 模式。任一请求消息的 `content` 为**数组**且含 `image_url` part → 流式回答文本回显 `SEEN_IMAGE:<hash>`(hash = data URI 的 `<长度>-<前8字符>` 简单指纹);无 image part 时正常聊天/工具应答(该模式无 image 即惰性)。S7 视觉回路测试地基。 |
| `FAKE_DRAFT_JSON` | (v0.9-S2)当设置且请求为**非流式**(`stream:false`)时,fake 扮演「存为 playbook」起草器——直接把该 JSON 字符串作为 assistant 消息 `content` 返回(不做校验)。`draftPlaybookFromSession` 正是发这样一个非流式调用,故此契约让 draft 往返(模型输出→`parsePlaybookDraft`→`normalizePlaybook`)可离线确定性断言。优先级:接管 `stream:false` 分支(否则该分支回定长句)。 |
| `FAKE_PLAN_FIRST` | (v0.9-S5)`=1`:计划模式真流程测试地基。**首个**请求(history 里**无** assistant 消息)流式返回以 `PLAN:` 开头、**不带** tool_call 的纯文本(finish_reason `stop`)——正是 `runOpenAiTurn` 的 plan 暂停所识别的形状;**后续**请求(history 已有 assistant,如工作台记录的计划文本)落到下方普通分支,故可与 `FAKE_TOOL_SEQUENCE` 组合驱动批准后的执行阶段。优先级高于 tool/echo 分支。 |
| `FAKE_PLAN_TEXT` | (v0.9-S5)覆盖 `FAKE_PLAN_FIRST` 的计划正文(默认 `PLAN:\n1. 读取文件\n2. 修改配置`)。 |
| `FAKE_SUBAGENT_SCRIPT` | (v0.9-S6)子代理 `spawn_agent` 测试地基。JSON `{parent:[…],sub:[…],subText?,parentText?}`——按请求 `system` 是否含子代理身份标记「子任务执行体」(`runSubAgent` 前置)**分流**:命中→走 `sub` 剧本(被交办的子回合,可含 `file_write` 等)、否则→ `parent` 剧本(顶层回合,可含 `spawn_agent` tool_call)。每份剧本按请求 role:'tool' 数步进(仿 `FAKE_TOOL_SEQUENCE`):步为 `{name,args}`(吐**一个** tool_call)或 `{text}`(吐最终文本收尾);耗尽 → 吐 `subText`/`parentText`(默认定长句)。子回合工具消息在子的**独立** history,故父的 role:'tool' 计数只反映父的 spawn_agent 结果,互不干扰。优先级高于 tool/echo 分支。 |
| `FAKE_SUBAGENT_PARALLEL` | (v0.9-S6)JSON 数组 `[{name,args}]`(通常 N 个 `spawn_agent`)。**父的首个请求**(history 无 role:'tool'、非子请求)在**一条** assistant 消息里吐全部 N 个 tool_call(单批次扇出上限测试);父的后续请求落 `parent` 剧本收尾。子请求永不走此分支。 |
| `FAKE_SEQUENCE_PRIORITY` | (v0.9-S7)`=1`:令**未耗尽**的 `FAKE_TOOL_SEQUENCE` 优先于 image-echo 分支。默认 image-echo 一见 history 里有 image part 就回显 `SEEN_IMAGE:` 停手;保图≤2 测试需在图片累积后仍连开截图,故此标志让序列跑完再让 image-echo 恢复(耗尽后最终答仍回显最后一张图,证图到达)。仅在同时设 `FAKE_TOOL_SEQUENCE` 时有意义。 |

### fake-mcp.js —— 假 stdio JSON-RPC MCP server(MCP 2024-11-05)

- `tools/list` 固定 4 工具:`echo{message}`、`add{a,b}`、`screenshot_full`(名字命中桥接 **read** tier,供 default 模式免弹断言)、`diagnostics`(供能力矩阵桌面可选依赖探测)。
- `FAKE_MCP_OPTIONAL`:JSON 覆盖 `diagnostics` 返回的可选模块可用性,如 `{"ocr":true,"uia":true,"cv2":false,"playwright":false}`。

### 其它假件/探针(非 e2e)

- `min_fastmcp.py` —— 最小 FastMCP(诊断 stdio)。
- `diagnose-stdio.js` —— 对照 stdio 工具供给(抓过 0-工具双导入 bug)。
- `deepseek-probe.js` —— 对真 DeepSeek 端点的探针(需密钥)。
- `model-tier-probe.js` —— **实弹分级模型评测件**(v1.0-S6b,**非回归**:无 `.e2e.js` 后缀、不进离线回归 grep、判定行 DONE)。`node model-tier-probe.js <API_KEY> <MODEL> [BASE_URL]`,同一套 agentic 场景(A 多步工具链 / B todo 纪律 / C 抗幻觉 / D 并行格式)打不同档位模型量化对比,为「是否做小模型针对性优化」提供数据;每场景独立临时 HOME + 独立 server,key 只经命令行入进程、finally 连同 HOME 删除、输出不回显 key。留作新模型接入时的验收探针。
- `free-port.js` —— `getFreePort()`/`getFreePorts(n)`(v0.8-S8;见下「端口段」)。

## e2e 模板范式

每个离线 e2e 遵循同一骨架:

1. **临时 HOME**:`HOME = path.join(os.tmpdir(), 'wcw-<slice>-e2e')`,开跑前 `rmSync` 清空重建;spawn workbench 时 env 带 `WIN_CLAUDE_WORKBENCH_HOME: HOME`(数据隔离,不污染真实 `~/.win-claude-workbench`)。**v0.8-S8 起也认 `RUYI_HOME`**(优先),测兼容性时可用它。
2. **写 config.json**:`configSchema: 6`、`version: '0.8.0'`、`providers[{...fake...}]`、`activeProvider: 'fake'`,视需要预置 `permissionMode`/`toolAllowRules`/`contextWindow` 等。**注**:范式示例种子里的 `configSchema:6`/`0.8.0` 是**有意用旧 schema 测迁移路径**(`normalizeConfig` 的 `{...defaultConfig(), ...raw}` 合并 + 末尾覆写 `config.configSchema`/`config.version` 令老种子无损升级);**当前代码基线是 `configSchema 7` / `VERSION 1.0.0`**——新写 e2e 若不为了测迁移,直接用当前 schema/版本亦可。
3. **健康轮询**:`for (i<40) { sleep(150); h = await health(port) }`,`GET /health` 返回 JSON 即视为起来。
4. **token 抓取**(需要 UI-token 门的路由):从 `<HOME>/runtime.json` 读 `token`,或走 body-token 端点(`/api/todo`、`/api/permission/request`)。
5. **taskkill 清理**:`finally { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']) }`;spawn fake 与 workbench 都要杀(树杀避免孤儿 powershell 子进程)。
6. `exit(fail ? 1 : 0)`;逐条 `PASS/FAIL <label>`。

## 端口段登记表(878x-899x)

**每件 e2e 用固定端口串行跑**(确定性 + 失败定位清晰)。多数件同时占一个 **fake-openai 端口**(891x/892x/893x 段)
与一个 **workbench 端口**(879x/88xx 或 895x+ 段);下表登记两者。已用段:

| 端口 | 占用(件·角色) |
|---|---|
| 8792 | port-fallback(占位探测起点) |
| 8793 | openai-engine · WB |
| 8795 | deepseek-live · WB(live,需真密钥) |
| 8796 | openai-tools · WB |
| 8797-8798 | source-fields · WB_A/WB_B |
| 8797 | deepseek-tools · WB(live)※ 与 source-fields WB_A 共用端口 |
| 8798 | desktop-bridge-live · WB(live)※ 与 source-fields WB_B 共用端口 |
| 8799 | mcp-bridge · WB |
| 8801-8802 | mcp-config · WB |
| 8834 | provider-compact · WB |
| 8911 / 8912 / 8913 / 8921 / 8931 | fake-openai 端口:openai-engine / openai-tools / mcp-bridge·desktop-bridge-live※ / source-fields / provider-compact |
| desktop-mcp-smoke | 无 HTTP 端口(纯 stdio,`node app/server.js mcp` 子进程) |
| 8951-8952 | session-atomic ※ resume-dangling 共用 8951 |
| 8953-8954 | usage-accum(S0) |
| 8955-8958 | bridged-read-noprompt(S0) |
| 8961-8966 | tools-v2 / agent-loop(S1) |
| 8967-8969 | shell-session / shell-mcp-guard(S2) |
| 8971 | search-robust(S2fix) |
| 8972-8974 | todo-summary / todo-loopback(S3) |
| 8975-8977 | checkpoint / checkpoint-mcpchild(S4a) |
| 8978-8981 | rewind / perm-v2(S4b) |
| 8982-8983 | autocompact(S5) |
| 8984-8985 + 8998[dead] | capabilities(S6) — 8998 是无人监听、未登记的死端口(网络探测=false) |
| 8986-8989 | steering / loop-guard(S7) |
| **8990-8992** | **repo-hygiene(S8)**(8990/8991 = RUYI_HOME 优先级;8992 = F2 apiKey 掩码段) |
| **8993-8994** | **reject-attribution(v0.9-S0)**(8993 = fake-openai;8994 = WB;两场景串行复用同段) |
| **8995-8996** | **uimode-style(v0.9-S1)**(8995 = fake-openai;8996 = WB;config 往返 + outputStyle 注入 + errorClasses) |
| **9001-9002 + 9009[dead]** | **playbooks(v0.9-S2)**(9001 = fake-openai[FAKE_DRAFT_JSON];9002 = WB;9009 = 死端口令 network 探测=false→网络类 playbook 置灰) |
| **9003-9004** | **workspace-resolve(v0.9-S3)**(9003 = fake-openai;9004 = WB;指纹解析唯一/多候选/零命中 + recentWorkspaces LRU + pick-folder 降级 + session cwd PATCH) |
| **9005-9006** | **artifacts(v0.9-S4)**(9005 = fake-openai[FAKE_TOOL_SEQUENCE file_write ×3];9006 = WB;turn_summary.artifacts 分类 + GET session 累计 + /api/file/preview 文本/图片/html/binary + 路径穿越 403 + >1MB 截断) |
| **9007-9008** | **plan-mode(v0.9-S5)**(9007 = fake-openai[FAKE_PLAN_FIRST + FAKE_TOOL_SEQUENCE file_write];9008 = WB;plan 事件→approve 放行执行/reject 收尾 plan_rejected + 无 token 403 + 未知 planId 幂等 + FAKE_PLAN_FIRST 关时非读工具仍硬拦截;fake 按场景在同段串行重启复用) |
| **9009-9010** | **subagent(v0.9-S6)**(9009 = fake-openai[FAKE_SUBAGENT_SCRIPT / FAKE_SUBAGENT_PARALLEL];9010 = WB;基本派生 file_write + subagent start/end 事件对 + 子 tool_use/result 带 subagentId + journal 同父 turnSeq + 父收子结论 · 禁嵌套拒绝 · 单批次扇出上限[第 3 个拒] · read tier 子回合写不成 · subagentMaxPerTurn:0 工具不注册 + 直调 /api/tools 拒。**9009 与 playbooks 的死端口共用段但串行无重叠**——playbooks 只把 9009 当无人监听的死端口做离线探测,subagent 运行时在 9009 起真 fake,两件串行跑不冲突) |
| **9011-9012** | **vision-loop(v0.9-S7)**(9011 = fake-openai[FAKE_VISION + FAKE_TOOL_SEQUENCE(fake__screenshot_full) + FAKE_SEQUENCE_PRIORITY];9012 = WB;fake-mcp 桥入令 screenshot_full 可用 + desktopMcp.present=true。(a) vision 路径图片附件走 parts + SEEN_IMAGE 回显 + 视觉规程;(b) 工具截图入回路:tool 图字段剥离占位 + 批后 user 图片消息 + tool_image 事件 + 连续性;(c) 保图≤2 淘汰最老;(d) 无 vision 路径 user content 是字符串 + 文本规程 + 工具图字段保留不转图;(e) 全程配对+连续性。WB 起一次、fake 按场景在同段串行重启复用) |
| **9013-9014** | **audit(v0.9-S8)**(9013 = fake-openai;9014 = WB;跑一 turn → GET /api/audit 断言含 workbench turn_start/end + ts 降序 + summary 人话化 + 无 token 403 + source=workbench 过滤 + desktop unavailable degraded + redact 脱敏[注入 sk- 秘钥断言明文不入响应]+ limit=9999 钳≤500。config `desktopMcp.enabled:false` 令桌面源确定性 unavailable) |
| **9015-9017** | **websearch(v0.9-S9)**(9015 = fake-openai[FAKE_TOOL_SEQUENCE web_search];9016 = WB;9017 = 本地 fake searxng JSON 端点[后端 baseUrl 可信不过 SSRF]。**纯函数直测**:ssrfCheck 逐条拒内网/回环/元数据/协议 + 放行公网、extractMainText 剥 script/style/head·段落换行·实体解、缓存往返 + SSRF 拒不落缓存 + 离线回落 fromCache、webSearch searxng 分流、maskSecrets/unmaskSecrets 覆盖 providers+searchBackend。**live**:type none → web_search 被过滤 + system「当前不可用」;searxng 配好 → web_search/web_fetch 出现 + D6 指令句渲染 + 真调 web_search 结果回流;apiKey `bing-secret-key-123456` → status/config 掩为 `••••3456` + 掩码回存不丢真 key) |
| **9018-9019** | **ssrf-hardening(v0.9 收官修复批)**(**保留登记但实际不用**:每条断言都是纯函数调用[`embeddedIpv4FromV6`/`ssrfCheck`/`isPrivateIpv4`],不开任何 socket) |
| **9020-9022** | **usage-ledger(v1.4-OSS 用量看板)**(9020 = fake-openai[有 usage 帧,配 pricing 的 provider];9022 = fake-openai[`FAKE_NO_USAGE`→估算轮];9021 = WB)。append-only 月账本 `usage/YYYY-MM.jsonl` + `GET /api/usage/summary`:两 priced 轮 + 一估算轮追加 3 行;summary totals/byEngine/byProvider/bySession(标题取自会话索引)分组、成本按币种(CNY)合计、estimatedTurns 计数、range=today/week/month/all 过滤(注入旧月行只入 all)、损坏账本行跳过、第三方 Claude 端点行 `costTrusted:false` 计入 planBasedTurns 且成本不入 costsByCurrency(source 取 CLAUDE_ENDPOINT_PRESETS 标签)、budget.spentThisMonth 当月可信合计、无账本空聚合不 500、无 token 403 |
| **无端口** | **theme(v1.0-S1)**(纯静态:只读解析 `app/public/styles.css` + `index.html`,不起服务不触网。青花令牌键集一致 + 旧赤陶橙隔离 + WCAG 对比度红线 + 空状态无字母 "C" 残留) |
| 8999 | **ia(v1.0-S2)· WB**(顶栏 5+⋯、右侧常驻页签+开发者组、权限安全 chip 四档、新装默认 uiMode simple、非法 uiMode 清洗回 pro) |
| 8997 | **onboard(v1.0-S3)· WB**(首跑引导 + 新装三键翻转 permissionMode default/engineMode interactive/permissionBridge true + 联网搜索页签 searchBackend 存续 + provider vision 开关) |
| **getFreePort()** | **git(v1.0-S4)· WB**(端口动态取:`git_status`/`git_diff`/`git_log`/`git_commit` —— execFile 无 shell、`--output=` 旗标走私被 `--` 挡、仓库外 cwd 拒、diff 上色数据) |
| **9031-9035 + 9039[dead]** | **failover(v1.0-S6)**(9031 = live 备用端点 fake-openai;9032 = WB;9033 = 401-端点 fake;9034 = 半截流[die-midstream] fake;9035 = fake tavily/博查 搜索端点[后端 baseUrl 可信不过 SSRF];9039 = 无人监听的死主端口[①预首字节失败切备用]。extraBaseUrls 故障转移:预首字节失败切下一端点发 `failover` 事件 + 401 不切 + 流中死亡不切 + 会话粘住;normalizeConfig 清洗 extraBaseUrls;webSearch tavily/bocha 分流) |
| 8991 | **perf(v1.0-S7)· WB**(性能专项:`/api/sessions/<id>` 等端点响应时延门限;※ 与 repo-hygiene 的 8990-8992 段字面重叠——当前串行执行同刻只跑一件,并行/CI 前须迁移) |
| **无端口** | **manuals(v1.0-S8)**(纯文件断言:双手册 `USER-GUIDE_CN.md`/`ADMIN-GUIDE_CN.md` 各 ≥4000 字节 + 关键词齐 + 无 sk- 密钥/无旧品牌名「Win Claude Workbench」空格形[存量兼容标识 `win-claude-workbench` 行豁免]/无 TODO 残留 + README 含两手册链接) |
| **9041** | **dns-rebind(v1.4.6-S1)· WB**(DNS 重绑定/CSRF:伪造 Host 头[evil.example]命中 POST /api/sessions 被拒 403 + 浏览器 Origin 无 token 被拒 + 同源 Origin+token 放行 + 回环无 Origin 无 token 仍放行[离线 harness 豁免]) |
| **9042** | **file-guard(v1.4.6-S2/S3)· WB**(纯函数:`buildOpenSpawn` 无 cmd.exe/单 argv[命令注入闭合] + `providerIsLocal` 本地/远端判定 + `guardFileToolPath` 策略矩阵[越界写恒拒·越界读仅本地 provider 放行·allowOutsideWorkspace 放行];集成:/api/tools/file_read·file_write 越界拦截[无 provider=远端]+ 翻到本地 provider 后越界读放行) |
| **9043-9044** | **e1-parallel-noindex(E1)**(fake-openai `FAKE_PARALLEL_TOOLS_NOINDEX`:并行多个 tool_call 增量**不带 index**)。断言按-id 聚合槽状态机把两个 file_read 正确分槽、各带正确不同 path(参数不串)、恰好 2 个 tool_use,不再拼成坏 JSON) |
| **9045-9046** | **e4-no-usage(E4)**(fake-openai `FAKE_NO_USAGE`:全程不发 usage 帧)。断言仍产出 `usage` 事件、`estimated===true`、input_tokens/contextTokens>0、calls===0(`estimateHistoryTokens` 兜底),且 `markUsage` 兼容 input_tokens/output_tokens 别名) |
| **9047-9048** | **e5-multiline-sse(E5)**(fake-openai `FAKE_MULTILINE_DATA`:一个 event 跨多行 `data:`)。断言标准 SSE 分帧(空行切 event + 合并多行 data)重组 tool_call 参数完整、内容不丢,兼容单行一 JSON 端点) |
| **9049** | **e2-append-system-prompt(E2)**(`USERPROFILE` 隔离 ~/.claude)。断言 settings.json **不再写** appendSystemPrompt 键(并剥离旧 stale 键)、保留 permissions.defaultMode 与无关既有键、`--append-system-prompt` flag 仍每次 spawn 携带) |
| **9050-9051** | **e3-engine-switch-continuity(E3)**(fake-claude + fake-openai,同进程 Claude→Provider→Claude)。断言切回 Claude 的回合(已 seen sid)仍注入恢复历史、含中间 Provider 轮次、不重复 Turn A;含 E3-fix2:中间夹一条无 engine 的 agent_workflow 总结消息仍不屏蔽 Provider 尾段) |
| **9093-9094** | **agent-workflow-ui-progress(v1.4.6)**(9093 = 内联 fake-openai[子请求按 history 里 role:'tool' 数吐 3 个逐轮延时 tool_call 再吐 schema 结论,把节点拉长];9094 = WB,同时挂 `WCW_FAKE_CLAUDE` + `WCW_FAKE_SCENARIO` 指向 HOME 内 `longtext.jsonl` 长文 fixture)。无聊天流的 UI 按钮/resume/CLI 启动 run 的实时进度:(A)不 await 地 launch OpenAI 慢多步节点 + 并发轮询 `/api/agent-runs`,在节点仍 `running` 时读到中间 `node.progressLog`[start/tool 里程碑],证节流器中途落盘(非仅节点收尾的终态 saveAgentRun);(C)Claude 引擎节点执行期落盘 ≥1 条 subagent_progress「生成中 · N 字」里程碑,且「子 Agent 完成」条目独立追加不覆盖生成中条目) |
| **9095-9096** | **agent-subturn-loop-guard(B3)**(9095 = 内联 fake-openai[子请求每轮吐**同一** `file_read`(同 call id/同参数)];9096 = WB)。子回合 `runSubAgentCore` 移植父回合的「连续 N 次相同工具签名即中止」保护:单节点 DAG 无 maxIters(预算=100),断言 fake 只被调 **5** 次(非 ~100)、节点以「连续 5 次相同工具调用」失败、持久化 `node.iters≤6`/`toolCalls≤5`。防「卡住的子代理烧完 100 预算」) |
| **无端口** | **agent-workflow-monitor-ui(v1.5)**(纯静态:只读聚合前端源码 `app/public/app.js`+`js/**`+`styles.css`,不起服务不触网。§2 编排实时监控重设计的前端契约:聚合头[状态 chip+节点 done/total+已运行时长+成本] · 状态徽标 `.wf-status-badge.st-<status>` 全状态语义色标 · 双引擎徽标 `eng-claude`/`eng-provider`(--wf-claude 青花蓝/--wf-provider 釉里红)· 防御式 rejected 派生[nodeDisplayStatus:后端直发用之,否则从 gateVerdict/verdict==="fail" 派生;failed 红/rejected 琥珀/skipped 灰三分色]· 停滞横幅「疑似停滞」[idleAborted 或等待资源+blocker]+ [查看][停止]· 迭代/预算 mini 进度 · 计时 · 质量门 verdict+置信度 · 资源锁 blocker 高亮 · 一键处置 wire 到 pause/resume/stop/retry_node + 「查看错误」· aria-label 无障碍 · renderAgentRuns 不用 innerHTML[XSS]· 保留 .agent-run-card/.agent-node 基类 + 2s 轮询协议不回归) |
| **9097-9098** | **agent-deadlock-watchdog(B1)**(9097 = 内联 fake-openai[按 user 文本标记 ALPHA/BETA 交叉写对方资源、HANG 挂起不回];9098 = WB,`WCW_RESOURCE_LEASE_TIMEOUT_MS=1500` + `WCW_AGENT_WORKFLOW_IDLE_MS=3000`)。三段:①**进程内**直测 `acquireResourceLease` 阻塞 300ms 后以 `RESOURCE_TIMEOUT` 拒(非永久挂起)、非冲突即时取、释放后无泄漏[进程内 require server.js,靠 fake listener 保活事件循环——租约超时定时器 `.unref()`];②**集成死锁**两并发节点各声明一独占资源、运行中交叉写对方资源→工具级租约超时打破死锁,断言 run **到达终态不永久挂起** + progressLog 有「等待资源」「工具返回 错误」;③**集成 watchdog** provider 永不回的节点被 run 级空闲 watchdog(async 路径)中止,断言 `run.idleAborted===true`) |
| **9099-9100** | **usage-subagent-ledger(v1.4-OSS 用量看板补)**(9099 = fake-openai[plain-chat 带 usage 帧 42/15、非流式补全带 usage 11/7,provider 配 pricing CNY];9100 = WB,清空 `ANTHROPIC_BASE_URL/BASE/AUTH_TOKEN/API_KEY` 环境变量[防 claudeLedgerSource 因开发机残留 env 误判 costTrusted]+挂 `WCW_FAKE_CLAUDE` → fake-claude result 帧带 `total_cost_usd:0.0123`+usage{812/214})。Agent DAG 工作流子代理消耗入月账本 `usage/YYYY-MM.jsonl`:launch 一个双引擎 2 节点工作流(openai 节点 + `engine:'claude'` 节点)跑到终态后断言账本出现 `kind:'subagent'` 行——openai 行 provider/model/cost(按 pricing 精确算)、claude 行 cost=0.0123·currency USD·costTrusted true·estimated false;`GET /api/usage/summary?range=today` 的 `totals.subagentTurns===2`(密闭 HOME 精确值)且 byProvider 两来源含子代理 tokens(精确等值)、bySession 父会话含三行之和;回归:①普通聊天回合仍写 `kind:'turn'`·costTrusted 行不受影响;②混读——手工 append 的无 `kind` 旧格式行计入 `totals.turns` 而不计 subagentTurns/auxCalls(向后兼容);③辅助调用——`POST /api/provider/compact` 触发一次摘要调用,断言恰好新增一行 `kind:'aux'`/`note:'compact'`[11/7 tokens·按 pricing 算]且 `totals.auxCalls===1`) |
| **9103-9104** | **skills-registry(v1 技能体系)**(9103 = fake-openai[FAKE_CAPTURE_DIR 抓请求体 + FAKE_TOOL_SEQUENCE 令模型调 skill_read];9104 = WB,挂 `WCW_FAKE_CLAUDE` + `WCW_FAKE_ARGV_CAPTURE`;临时 HOME + 临时 cwd 项目内置 `.ruyi/skills/demo-skill/SKILL.md`[frontmatter name/description]与 dataRoot `skills/` 用户技能)。统一技能注册表 v1:(a)`GET /api/skills?cwd=` 含四源[内置技能/用户技能/项目技能/命令/Playbook]且 project 覆盖同 id user;(b)`POST /api/session/skills` 启用[合法 id]+ 上限 8[传 10 只留 8]+ 非法/非技能 id[命令/playbook/不存在]拒绝;(c)provider 回合捕获请求体 system 含技能索引行[`[demo-skill]` + 描述标记]、tools 含 `skill_read`;(d)FAKE_TOOL_SEQUENCE 两条令模型先调 `skill_read{id:demo-skill}`[结果 ok + SKILL.md 全文 + 文件清单]再调未启用 id[结果 ok:false,白名单/路径守卫拒];(e)切 `activeProvider:''` 走 Claude 回合,`--append-system-prompt` 合成串同时含 config.appendSystemPrompt 标记与技能索引且总长 ≤8000;(f)回归:未启用技能的会话 provider system 无技能段 + tools 无 `skill_read`) |
| **9101-9102** | **agent-steer-node(v1 定向插话)**(9101 = 内联 fake-openai[子请求逐轮吐**distinct-arg** file_read × ROUNDS 再吐结论文本,每帧 sleep 200ms 把节点拉长;捕获全部请求体供断言插话注入];9102 = WB,挂 `WCW_FAKE_CLAUDE` 令 claude 节点确定性)。运行中 DAG 对**单个 OpenAI 引擎节点**定向插话(steer_node action):4 节点 DAG `work→{later,claudenext,gate}`,work 运行时 later/claudenext/gate 处 queued(队列断言零竞态)。(a)对运行中 work 插话 `STEER_MARK`→后续 fake 请求体现 `[编排者插话] STEER_MARK`(迭代边界 drain);(b)持久化 work.progressLog 出「插话 · STEER_MARK」里程碑;(c)对 claude 引擎节点 steer→409「Claude 引擎节点…」(单发 -p 进程);(d)对已 succeeded 节点(run 仍 live)steer→409「节点已结束」;(e)每节点队列 cap:queued 节点连插 3 成功、第 4 条 409「插话队列已满」;(bonus)3 条 queued 预插按 CAP1→CAP2→CAP3 顺序整批出现在 later 启动后的**同一**请求体里;(f)对 vote 质量门节点(确定性短路,不经过模型)steer→409「确定性质量门…」;(g)伪造 sessionId + 真实 runId→404(run 归属校验,pause/resume/stop/steer_node 共用同一守卫);(h)空文本→400「插话内容不能为空」;(i)不存在的 nodeId→404「节点不存在」;(j)run 到达终态后再 steer→409「工作流当前未运行」) |
| **9105-9106** | **team-pool-mailbox(团队模式 v2 Phase 1+2:共享任务池 + Agent 邮箱)**(9105 = 内联 fake-openai[按 sub-request **自身 task** 里的标记驱动:PROPOSER/AUTOPROP/CHAINROOT/CHAINPROP/SOLO 发 propose_task、SENDER 发 send_to_agent、RECEIVER/SCHEMATARGET/KEEPER 长跑、FAILHELPER 直接 HTTP 400 令节点失败;捕获全部请求体];9106 = WB,挂 `WCW_POOL_GRACE_MS=2000` 缩短宽限窗、config 含白名单角色 `restricted`[openaiTools=['file_read']])。**A5(任务池)**:(1)propose_task→run.taskPool 出 proposed 项、提案者不阻塞;(2)manual 批准→物化并执行(缺省 dependsOn=[提案者])、拒绝→rejected 无节点;(3)auto-capped cap=3 前 3 auto 物化(decidedBy:auto)、总数>8 被拒、链深>2 被拒(CHAIN3 不入池);(4)物化节点 kind:subagent 入账、engine 继承、failurePolicy continue 帮手失败 run 仍 succeeded;(5)收尾竞态:有 proposed→waiting_pool 宽限窗、窗内批准可执行、窗过 expired、run 结束后批准 409「运行已结束…」。**B4(邮箱)**:(1)A→B 请求体含 `[节点 <sender> 消息]` 前缀;(2)双端 progressLog 里程碑(发消息→/收到 消息)+ run.messages 持久化;(3)目标终态→dropped + 将丢弃语义;(4)风暴 cap 逐级(每目标 3、每发送者 8)+ 自发自收拒绝;(5)schema 目标注入体带 JSON 提醒(复用 steerReminder)。**豁免**:白名单角色下 propose_task/send_to_agent 仍被注册(元工具豁免 role.openaiTools)+ 禁嵌套守卫未误杀 spawn_agent 回归) |
| **9057-9058** | **workbench-memory(团队模式 v2 Phase 3:跨会话记忆)**(9057 = fake-openai[FAKE_CAPTURE_DIR 抓请求体 + FAKE_DRAFT_JSON 令非流式补全回一条记忆 JSON 供 draft 往返];9058 = WB,挂 `WCW_FAKE_CLAUDE` + `WCW_FAKE_ARGV_CAPTURE`;临时 HOME=dataRoot + 4 个临时项目 cwd[各自 projectKey] + 一个 HOME 外 OUTSIDE 目录[越界回退] + dataRoot `skills/` 用户技能[三段优先级用])。文件型记忆库 `dataRoot()/memory/{global,project/<projectKey>}/<id>.md`:**C5(1)** `POST /api/memory/draft`→provider 起草 {name,description,type,body} + 确认落盘 + aux 台账行 `note:'memory-draft'`;**C5(2)** 双引擎索引注入——provider system 与 Claude `--append-system-prompt` 均含 `<workbench-memory>` 围栏 + 「不得覆盖」声明 + 文件绝对路径(provider 用 file_read/Claude 用 Read),整段 ≤2000;**C5(3)** `{id,scope}` 来源锁定[启用 scope:global,同 id 的 project 记忆不顶替]+ 文件消失→幽灵项 `POST /api/session/memories []` 可清;**C5(4)** 项目记忆随 cwd 换组[A/B 各自 16-hex projectKey 隔离,global 处处可见];**C5(5)** 未启用→零注入[project 无记忆 + global 需手动]。**extras**:cwd 越界→静默回退 defaultWorkspace;伪造围栏 `</workbench-memory>` 中和为 `[/workbench-memory`[仅一个真闭合];8000 合成三段优先级[用户 append < 技能索引 < 记忆索引,近满 append 时记忆段整体丢弃];主回合 Claude spawn 启用记忆时 `--add-dir <memoryRoot>`) |
| **9113-9114** | **mission-driver(第26波b · 任务账本 + until-done 驱动器)**(9113 = 内联 fake[按最后一条 user 消息里第一个未完成里程碑 `[mK]` 驱动:本轮 0 工具→file_write mK.txt、1 工具→mission_update 标 done、≥2→终稿;目标含 STALLMODE 则永回纯文本模拟停滞];9114 = WB,permissionMode bypass)。**A/B** 3 里程碑(file_exists 验收)无人值守跑完:一次 POST /api/chat/stream → mission_complete、3 文件都在、spent.autoTurns==2、自动续跑消息标 source:'mission-driver'、每里程碑有 evidence;**C** 停滞:fake 不推进→连续 3 回合同 digest→state:'stuck'+autoMode='supervised';**D** 预算:maxAutoTurns=2 但 5 里程碑→2 自动回合后 state:'budget_exhausted'+supervised(非报错,进度保留);**E** 非账本会话零行为变化(无 mission 事件、session.mission 仍 null) |
| **9111-9112** | **scheduler-ready-queue(第26波 · 连续就绪队列,去批次屏障)**(9111 = 内联 fake[按任务标记差速:SLOWMARK ~4s / 其余 ~0.25s,纯文本无工具];9112 = WB,concurrency 2)。**A** 判别性中间态:DAG slowA∥fastB→fastC,必须观测到「fastC=succeeded 而 slowA 仍 running」(批次屏障下不可能)+ 总时长≈慢节点而非串行和;**B** 环检测语义保持(a⇄b → run failed + error 含「依赖图存在环」);**C** 静态锁:Promise.all(batch.map) 代码消失、inFlight/raceInFlight 在、环判定门槛为「ready 空且在飞空」 |
| **9116** | **autonomy-grant(第27波 · 自主性授权书)**(单 WB 端口,无 fake provider——授权书路由不触发模型)。三段:**[S] 静态源锁**(/api/autonomy/ 在 header-token 白名单 + 不在 mutating 豁免名单 + 三路由各自 tokenOk 无 body-token 兜底[R-P2-2]、native 消耗点在 gate===block 之前[子集律]、CLI 桥消耗点、runSubAgentCore 无 consumeGrant[R-P1-1]、saveSession/normalizeConfig 不落 autonomyGrants[exec 不持久]、任务账本 digest 无授权字段[不进上下文]、禁 spawn_agent 签发[红线#4]);**[P] 纯逻辑源抽取**(new Function 实跑 grantIssueTierInfo/resolveToolPermissionContext/normalizeGrant/consumeGrant/撤销:tier×entrypoint×path-glob×cmdAllow×net×metachar×scope×TTL×maxUses×revoke×fail-closed 穷举 —— .git/hooks 与 .vscode/tasks.json edit 授权回落[R-P2-1]、文件族空路径 fail-closed[R-P1-2]、前缀边界 buildEVIL 挡粘连、默认禁网 curl 失配、cwd 越界失配、scope=run 隔离);**[H] Live HTTP**(签发主权 body.token===RUNTIME.token 仍 403、exec 无 cmdAllow/spawn_agent 拒收、dry-run 命中文件、grant 不落 session 文件[纯内存]、撤销即时、审计 issued/revoked 留痕) |
| **9109-9110** | **autonomy-durability(第25波 · 耐久基座:崩溃注入 + 断点续跑 + 幂等写 + 事件日志)**(9109 = fake-openai[FAKE_TOOL_SEQUENCE 三连 file_write + FAKE_STREAM_DELAY_MS 拖慢节点 + FAKE_CAPTURE_DIR 抓续跑提示词];9110 = WB,临时 HOME)。**A** atomicWriteJson 源抽取:20 路并发写同目标→终稿完整 JSON、无 *.tmp 孤儿;**B** 静态锁:原子写调用点 ≥14、全文件手写 tmp 写点=3(白名单豁免:atomicWriteJson 自身/exit 同步 flush/回滚二进制恢复)、persistenceDegraded live 叠加、事件助手 ≥10 发射点、幂等跳过不进变更清单、前端横幅;**C** 杀点1(≥1 工具步骤后 taskkill):重启→run/node=interrupted + interruptedAttempt=1 + continuation 存活→resume→捕获提示词含【断点续跑】+ 首个 file_write 幂等跳过(检查点 a.txt create=1/modify=0)+ run=succeeded + 续点清理 + events seq 严格单调含 run_created/node_start/run_interrupted/run_resumed/node_settled/run_end;**D** 杀点2(node_start 后 0 工具,FAKE_STREAM_DELAY_MS=1500 拉宽窗口):resume 不注入断点标记、照常完成 |
| **9107-9108** | **judge-json-repair(v1.5 · 裁判/质量门 JSON 解析加固 + provider 兜底修复)**(9107 = 内联 fake-openai[按 judge 节点 task 标记分流:JUDGE_BADFIX 吐**精确复刻的生产故障样本**(markdown 表格 + 结尾 ```json 围栏 + summary 含 `未到"fail"级别` 未转义引号 + verdict uncertain)、JUDGE_TRUNC 吐整体截断 JSON、JUDGE_CLEAN 吐干净 JSON、PRO_SIDE/CON_SIDE 吐正反文本;非流式请求 system 含「JSON 修复器」→ 回干净 JSON 并计 GET `/__repairs` 计数];9108 = WB)。**§1 进程内单测**(require server.js 导出 parseStructuredAgentOutput/repairJson):生产故障样本经加固直接解析成功(verdict uncertain·summary 含 fail·findings 存活)+ repairJson 四类各修复(未转义内引号/尾逗号/裸换行/智能引号)+ 幂等 + **合法 JSON 零误伤**(NO-OP;含转义引号与 `"},[]"` 边界内容)+ 整体截断解析层修不动。**§2 集成**(pro/con/judge cross_review DAG 三跑):A) 故障样本 → 解析层已修、**零**修复调用、judge 得确定性 verdict(uncertain→rejected 而非 failed 的解析失败)、run 未被拖垮;B) 截断样本 → **1 次**(bounded)json-repair 修复调用、node.jsonRepaired、judge succeeded、台账 `kind:'aux'`/`note:'json-repair'` 行(11/7 CNY·agentKey=judge);C) 回归干净 JSON → succeeded·零修复调用·台账不新增) |

> ※ 标注的行与旧件/兄弟件共用端口:**在当前串行执行下有意共用**(同刻只有一件在跑);
> **并行/CI 前须迁移**到独立端口或改用 `free-port.js` 的 `getFreePort()` 动态取端口
> (fake 走 env `FAKE_OPENAI_PORT`,workbench 走 `--port`)。**现有件不改**(串行硬编码没问题)。

## 新 e2e 检查单

- [ ] 端口取**空闲段**(见上表),或用 `getFreePort()`。
- [ ] 临时 `HOME`(tmpdir),开跑清空;spawn env 带数据目录变量。
- [ ] 健康轮询起服务,别裸 sleep 猜时间。
- [ ] 需要 mutating 路由的 UI-token → 从 `runtime.json` 读;body-token 端点走 body。
- [ ] `finally` 里 `taskkill /T /F` 杀 fake + workbench(**必做**,否则残留进程占端口)。
- [ ] 逐条 `PASS/FAIL <label>`;`process.exit(fail?1:0)`。
- [ ] 断言只加不改语义(事件协议纪律);新字段可断言,别断言旧字段被删。
- [ ] 跑两遍确认无端口/临时目录残留导致的偶发。
- [ ] 登记进上面的端口段表。
