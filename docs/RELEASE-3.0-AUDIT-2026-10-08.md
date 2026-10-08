# 3.0 正式版发布前走查（第 4 波，2026-10-08）

> **2026-10-08 发版复核补记**：下文是原始发现记录，不表示各项仍未修复。本轮在已合并的 `6d99b91d` 基础上核对实现、重跑安全与数据回归，并修复了第 2 节第 8 项中的编译失败后继续打包问题：依赖安装、主程序编译或桌面壳编译失败都会停止，不能再混入旧程序；三种失败场景均有实际脚本回归测试。发行干跑同时增加 `package-lock.json` 两处版本一致性检查。整套本机单测通过（1,767 pass、25 skip、0 fail；跳过项不计通过）。
>
> 对外文案已移除不能普遍兑现的承诺：81% 是特定历史样本的工具输出字符缩减，64% 是重复文件读取样本的工具阶段耗时，均不是所有对话的上下文或整体耗时；管家并非禁止代批所有对外发送，通用 HTTP 工具也并非一律拒绝内网。README 与 3.0 发布说明改为说明实际能力和适用边界。原记录中的独立红队、真实读屏与人因验证不记为已通过；余下体验与兼容性问题保留跟进，不以正式版本号视作全部关闭。

基线：`620d76b`（PR #46 合入后，版本仍为 `3.0.0-preview.3`）。方法：三批共 24 路并行只读走查（第一批 8 路看 preview.3 之后的改动；第二批 8 路横扫发版就绪、Windows 专属、长跑资源、落盘、鉴权与注入、打包与桌面壳、两仓契约、ruyi-toolbox；第三批 8 路补管家收件箱 / 代批、语音、工具 schema、网络与归档工具、提示词组装、前端核心旧模块、测试套件假绿），之后逐条回到源码核对。

本文只是**发现清单**，除第 7 节的工作文件夹选择器外，本次没有改产品代码。每条都标了核实程度：

- **✅ 已核实**：回到源码读过调用链，确认触发路径存在；标「实测」的另有脚本或真浏览器复现。
- **⏳ 未复核**：走查报告给了逐字引用与触发场景，但没有逐条回源码核对；严重度沿用报告判断，可能偏高。
- **❌ 不成立**：核对后判为误报、设计如此或已在 SECURITY.md 明示不防。

## 0. 基线测试

| 检查 | 结果 |
|---|---|
| `node dev-harness/syntax-gate.js` | 933 件 0 失败 |
| `node ruyi-workbench/app/build.js --check` | 产物新鲜 |
| `node --test "dev-harness/unit/*.test.js"` | 1771 项：1761 过 / 0 败 / 10 跳 |
| `node dev-harness/run-all.js --fast` | 80 件全过（另 7 件 live 跳过） |
| ruyi-toolbox 四组 pytest | asr-shim 148 过；asr-stream 49 过 1 跳；tools 22 过 5 跳；document-parser 62 过 |
| ruyi-toolbox `ruff check --select F .` | 1 处 F401（`evaluation/document-parser/run_candidate.py:13` 未用的 `read_json`） |

全量回归（Windows CI）与真机未在本次重跑。

## 1. 结论

代码层面没有发现会让 3.0 正式版「起不来 / 大面积不可用」的问题，但有**几条应在正名前修掉的 P1**：一条用户数据丢失、三条安全闸缺口、一条语音组件的反复卡顿，以及发版流程本身的三处缺口。另有 50 号文的人因 / 读屏 / 红队终审三道门需要用户拍板补做或豁免（见 4.1）。

## 2. 建议发版前修（P1，已核实）

| # | 问题 | 位置 | 触发 → 后果 |
|---|---|---|---|
| 1 | **0 字节 / 全空白的 config.json 不从 `.prev` 恢复**，随后两次保存就把含密钥的 `.prev` 覆盖 | `01-config.js:1996`（只有 ENOENT 与「非空且非法 JSON」两支读 `.prev`；`:2009` 注释的意图是空文件也该恢复） | 断电 / 杀软 / 同步盘把 config.json 截成 0 字节（全仓无 fsync，rename 后数据未落盘是经典场景）→ 当空配置启动 → 用户存一次设置写入无服务商的新配置 → 再存一次时 `.prev` 被它覆盖 → **全部服务商与 API Key 永久丢失** |
| 2 | **管家代批的非豁免分支不查「没扫全」** | `13l-steward-ops.js:259-287`（查了 indirect / 外发 / 网址载荷，没查 `stewardAutoAskScanIncomplete`） | 智能自动档正是因为命令超过 4000 字扫描窗口（或嵌套超过 4 层）才停下来问（`07-autonomy.js:1587`）；命令前垫 4000 个空格，窗口外的 `git push --force` / `rm -rf` / `curl …` 在管家这一侧判成「无命中」，豁免十道闸整段不进，摘录为空 → 管家可代批。与 SECURITY.md「超出窗口的命令一律先问你」「联网与读密钥管家不代批」不符。修法一行：非豁免放行类也拒 scanIncomplete |
| 3 | **管家 `steward_file_read` 无视工作区的「读：关」** | `06i-steward-core.js:1515-1524`（`stewardWorkspaceRootFor` 不看 `row.read`）→ `13l-steward-ops.js:1138` 以该根作 `session.cwd` 调 `file_read`，`fileAllowedRoots` 把 cwd 计入读根 | 用户在设置里关掉某工作区的读权限 → 管家仍能读其中任意文本文件并送模型 |
| 4 | **`http_request` 在智能自动档 GET 免确认、且不判回环 / 内网 / 元数据地址** | `07-autonomy.js:1580`（exec 档非载荷即 allow）；`11-native-tools.js:4775`（只校验 http/https 前缀） | 被注入的模型 `GET http://127.0.0.1:<端口>/api/sessions`：token-browser 路由对无 Origin 的回环请求免 token（SECURITY.md 承认的「本机进程」边界，但这里发起者是模型自己的工具）→ 读到别的线程的会话与历史，绕开文件闸对数据目录的敏感保护；同理可达 169.254.169.254。走查在临时实例上实测 200 |
| 5 | **工具箱服务健康超时后，失败冷却失效** | `04f-toolbox-services.js:138-140` 先置 `stopping=true` 再杀进程，`:121` 的 exit 回调把 `failed` 改写成 `stopped`；`:282` 的冷却只认 `failed` | 语音组件起来后 20 秒内不答 /health（加载慢、模型坏）→ 之后**每按一次麦克风 / 每次转写都重拉并干等 20 秒**；设置页显示「已停止」而不是「没起来」。走查已实测 |
| 6 | **NTFS 流后缀绕过「应用内部数据」敏感闸**（需 Windows 真机确认） | `03-bridge-guard.js:468`（`isSensitiveDataPath` / `isWriteProtectedDataPath` 不剥 `::$DATA`；第三波只给 autoexec 闸加了 `normalizeAutoexecPath`） | `<数据根>\config.json::$DATA` 词法判不敏感（`path.win32` 实测 relative 为 `..\config.json::$DATA`、basename 正则不中）；若 Windows 上 realpath 不还原正名，`file_read` / 预览可读出明文 apiKey。修法：两个判据入口先按 `normalizeAutoexecPath` 同口径剥流后缀 |
| 7 | **升级残留：preview≤3 写进全局 `~/.claude/agents` 的项目角色免问档永不修正** | `01-config.js:2246-2264` | 旧版把仓库角色声明的 `permissionMode: bypassPermissions` 写进用户全局子代理文件；新版（安全走查 S3）不再写这一行，于是「老版本写法」比对不上 → 判为用户文件跳过 → 全局子代理继续免问，独立 claude 会话也生效。修法：legacyMd 同时认带旧 permissionMode 行的那一份 |
| 8 | **发版流程**：打包不查各步退出码、Full 路径从未在 CI 跑、仍不生成 SHA256SUMS | `tools/package-offline.ps1:246/253/264/271`；`dev-harness/release-dryrun.js:133/138`；9-23 审计 P1 未闭合 | `npx pkg` 或桌面壳编译失败 → 静默复制**上一次留下的** `Ruyi.exe` / `RuyiDesktop.exe`，退出 0；release-dryrun 的 Full 段在 CI 永远 SKIP 却打印 ALL PASS；发布清单靠手算哈希、与 commit 无绑定 |

## 3. 建议修（P2，已核实）

**安全 / 稳定**

- **任意网页可让工作台缓冲约 128MB 请求体**：body-token 路由豁免 originOk（`01b-route-auth.js:10`），先 `readJsonBody`（上限 128MB）再验 token。恶意页 `fetch(…/api/todo, {mode:'no-cors', body: 'a'.repeat(1e8)})`，走查实测 RSS 106→297MB；并发几发可压垮进程、打断在途回合。修法：body-token 路由带 Origin 头的直接拒，或这几条路由的上限降到 1MB 级。
- **web_fetch / http_download 的 DNS 预检解析失败即放行且不锁定地址**（`11-native-tools.js:3858` 返回 null → `:4170` 不 pin，真正连接时另做一次解析、不再校验）：首查失败、再查答 127.0.0.1 的重绑定可达不校验 Host 的本机服务（走查模拟复现）。修法：不走代理时用自定义 `lookup` 在连接时校验每次解析结果。
- **`office_open` / `browser_open` 不过 UNC 闸**（`12-tool-dispatch.js:2297`）：智能自动档下 exec 工具默认放行、外发规则表没有 UNC 条目，`\\攻击者\share\a.pdf` → explorer 去连 SMB、外泄 NTLM 哈希（非安全扩展名那支的 `fsp.stat` 也会先连）。与第一波「任何 I/O 之前拒非本机 UNC」不一致；命令类工具在智能自动档同样能碰 UNC，属同一类。
- **旧导入的项目指令里含敏感块、且用户改过同来源任一条时，补扫不清理也不告知**（`06d-memory-domain.js:737-756`）：该块继续作为核心胶囊每轮发给服务商，迁移中心显示「跳过 0 段」。
- **管家「一键停机」打断在途轮询会永久丢事件**（`13i-steward-inbox.js:1217-1218`）：`stewardCollectEvents` 在收集途中已推进内存游标（mission 变更 / 子代理 / 回合 / pendingIds），停机让代际变化 → 本拍 `aborted` 丢掉已收事件；再次「启动」不重读磁盘游标（`loaded` 仍为真，`startStewardInbox` 只自增代际），下一拍把推进后的游标落盘 → 这段时间的 needs_you / failed 永不入箱，代批与提醒都不会再发生。
- **优雅关停不结束在途 Agent CLI 回合**（`13-http-router.js:2206` 的 `cleanupMcp` 不调 `stopSession`）：uncaughtException / SIGTERM 退出时 Claude / Kimi 子进程变孤儿继续跑完当前回合。桌面壳有 Job Object 兜底，控制台 Ctrl+C 也会带走，主要影响其它退出路径。
- **服务商通道不认 `HTTPS_PROXY`**（`04h-provider-http.js:71` 全局 fetch）：网络工具认、并在报错里教用户设它；只能经代理出网的机器上每次模型调用都报「网络不可用」。内置运行时是 Node 24，可考虑 `NODE_USE_ENV_PROXY`。
- **思考增量不算「已吐内容」**（`04i-provider-anthropic.js:491/505`，`04i-provider-wire.js:341`）：thinking 之后来 overloaded / 429 错误帧会被标成 HTTP 529/429 → 整次重打，界面上同一段思考出现两遍。`09-workflow.js:2716` 的注释声称不会重放已显示内容。

**升级 / 迁移**

- **旧 MCP 登记 `win-claude-workbench` 只在 install / 安装脚本里清**（`13-http-router.js:2622`）：发布说明建议「解到新目录」升级、不跑安装脚本 → Claude 会话同时加载旧登记（两个 MCP 子进程；旧路径搬走后每个会话报连接失败）。
- **迁移中心「改写老包引用」写盘失败仍计入成功**（`13u-migration-center.js:741/758`）：文件被 CLI 占用时 8 次重试后抛出，条目照样进 applied 与迁移日志，界面弹「已改写 N 项」。

**前端（前两条走查实测，其余为源码核对）**

- 管家输入框：附件上传还没完成就回车，这句不带附件发出，附件挂到下一句（`steward-composer.js:340/395`；工作台那条路有在飞计数）。
- 设置页密钥框：框里是掩码 `••••1234`，点进去在末尾粘新 key → 整串以掩码开头，服务端当「没改」换回旧值，界面却说已保存（`provider-settings.js:2122`；向导 `onboarding-wizard.js:180` 拦了，设置页没拦；搜索后端 / Claude 端点同构）。**实测**
- 线程超过 200 条：管家左栏静默截断，没有「加载更多」，计数显示 200（`steward-board.js:345`）。**实测**
- 命令面板切引擎，全局保存失败仍弹成功、`state` 不回滚（`navigation-controls.js:272`）。**实测**
- 设置弹窗有未保存改动时 ✕ 关闭无提示，刷新即丢（`navigation-controls.js:798`）。**实测**
- 拖链接 / 文字到页面空白处会整页跳走（`app.js:1118-1122`，前端第一波 `a0af228c` 引入的回归：非文件拖放不再 preventDefault）。
- 安静卡「直接回答」遇到服务端 409 `question.delivery_failed`（明说「问题仍在等」）却提示「已经不需要回答」并撤卡（`quiet-card.js:198`）。
- `turn_busy_elsewhere` 时乐观用户气泡留在屏上，重发出现两条（`chat-stream-runtime.js:860`）。
- 「在资源管理器中显示」对含空格的路径：`Start-Process explorer.exe -ArgumentList ('/select,' + $target)` 不加引号（`04-desktop-shell.js:340`；需 Windows 真机确认现象）。

**ruyi-toolbox**

- asr-stream：截断 WAV / 采样率为 0 / 深嵌套 JSON 时异常没转成 JSON，客户端只看到连接被断（`server.py:293/331`，`audio.py:71`；asr-shim 有兜底）。
- 登记自检不查依赖能否 import、也不查模型文件完整性：装坏的组件 / 下载中断留下的半截模型照样登记（`registry.py` 的 `self_check`；`download-model.ps1` 以 `tokens.txt` 存在为「已下载」）。与契约「起不来的不许登记」不符；叠加第 2 节第 5 条就是「每按一次麦克风卡 20 秒」。
- asr-shim 引擎锁包住模型加载（含首次在线下载），`/v1/unload` 与看门狗退出都要等加载完（`engine.py:121`）。

**测试套件**

- 真 ACC 段在 Windows CI 永远 SKIP（CI 不装 ACC 依赖），「工作台没起来」也记 SKIP，件仍 ALL PASS（`bridged-prefix-tolerance.e2e.js:89/97`，`checkpoint-coverage.e2e.js`，`desktop-mcp-smoke.e2e.js`）；run-all 只看退出码，运行时 SKIP 在汇总里看不见。

## 4. 发版清单与需要拍板的事

### 4.1 需要用户拍板

- 50 号文的 3.0 正名门：门② E02（付费升档）设计结论仍是「未做」；门③ 红队终审「不自证，留给用户」、真读屏「要人」、人因验证 2026-08-10 跳过、须在批准点重议。正名前要么补做，要么在发布说明里明文豁免。

### 4.2 改版本号要动的地方

`ruyi-workbench/package.json`、`ruyi-workbench/package-lock.json`（两处，**任何门都不校验**）、`app/src/00-boot.js:26` 的 `VERSION`（→ `build.js` 重算产物）、`facts.json`（`node dev-harness/facts-generate.js`）、README / README_EN 第 17 行横幅、`ruyi-workbench/docs/ARCHITECTURE_CN/EN`、`ADMIN-GUIDE_CN §7.6 / EN §8.5`、CHANGELOG「未发布」节头、新建 `docs/release-notes/v3.0.0.md`（preview 系列缺「已知问题」「从预览版升级」「回退」三节，回退口径与 ADMIN-GUIDE_EN:869 需统一）、`docs/OPTIMIZATION-ROADMAP.md:27`。

版本比较：代码里没有 semver 排序（只有 overlay 的精确相等），3.0.0 与 preview 的先后不会判错；2.8.0 → 3.0.0 的配置迁移路径已用 `normalizeConfig` 实测正确；正式版无需动 `CONFIG_SCHEMA`。

### 4.3 文档小项

`docs/README.md:29` 写 Pretender 3.0「已退役」与 CHANGELOG / 发布说明冲突；CHANGELOG:226 节头仍写委托书「重做」；`docs/optimization-plan/06-hb360-cost-convergence.md:217` 一条真坏链（41 号文另有 83 条 `.js:NNN` 写法的链接）；engines 声明 `>=20` 而 CI 只测 Node 24；ADMIN-GUIDE_EN「旧标识已全部改名」但 `WCW_*` 环境变量仍是对外配置项；`zh-CN.json` 的 `toast.wfProblems` 值是字面 `\n`；README 截图早于 preview.3（顶栏权限芯片可能过时）。

## 5. 未复核的报告（⏳）

以下为走查报告原样摘要，严重度沿用报告判断。**发版前建议至少把标 P1 的几条回源码核一遍。**

**管家（代批 / 污点 / 收件箱）**

- P1 污点在 actions 路径按「回合前的会话对象」取键（turnSeq 差一），同回合读网页后的 actions 不被拦（`13q-steward-runner-turn.js:208/322`）。
- P1 污点只在三处生效：直调 `steward_schedule_create` / `steward_thread_continue` / `steward_thread_new` / `steward_memory_write` / 非豁免 `steward_decide` 不查污点。
- P1 递话以 `role:user` 进入目标线程，目标线程不继承污点；管家没有会话级粘性污点位，工具结果留在上下文，下一个「干净」回合仍能据此代批。
- P1 已知线程分支缺 `turnSettlers` 守卫：回合起止窗口里误报「跑完了」并吞掉之后的真实失败（`13i-steward-inbox.js:1009/1061`）。
- P2 运行中回合转为等权限仍占并发位（默认 5 位）；当日费用闸读账失败按 0 放行；mission 变更账读失败（EBUSY）当缺账推进游标；收件箱账本只增不减。
- P2 记忆写入的「依据」校验：正文与用户原句书写系统不同直接放行（`13l-steward-ops.js:622`）。

**网络工具**

- P2 `http_request` 的 `maxBodyChars` 为 `1e308` / NaN 时字节硬顶失效；`http_download` 静默覆盖已存在文件（有检查点）；`archive_unzip` 不过滤保留设备名；6to4 地址未判。

**落盘**

- P2 JSONL 撕裂尾修复在残行超过 64KB 时截在行中间，下一条记录被焊接丢失（`02-session-store.js:244-246`，已用复刻函数验证）；用量账本 / agent 运行事件 / 审计流三处追加根本不修尾。
- P2 删除会话不删上传的附件，附件目录没有会话归属；`durable-state-inventory` 未登记 uploads / agent-worktrees / session-notes。
- P3 `.corrupt` 隔离单槽（第二次损坏覆盖第一次原件）；`config.json.bak-providers-*` 无上限，删掉的服务商密钥留在副本里；POSIX 上 `mcp.json` / generated 配置未收紧到 0600。

**语音**

- P2 规则路径（没配改字大模型时）英文常用词对 than→then、to→too 改两次即学成全局提示并进流式热词；基础词表错听样子按子串命中（「腹泻」→复现、「雾气」→服务器）。均为沙盒实测。
- P2 流式录音设备被拔后显示「正在听」直到 3 分钟；切线程 / 切标签不停录音；「转写中」无客户端超时、不可取消。

**提示词 / schema / 其它**

- P2 多处按 UTF-16 码元截断切断代理对（技能索引、项目记忆 16KB、fenceSafeSlice），孤立代理进请求体。
- P2 `script_run` 的 `force` 不在 schema 里，报错文案教模型加 `force:true` 越过 Office 软闸；59 处 `additionalProperties:false` 网关不执行，拼错的参数静默忽略。
- P3 en-US 系统提示里混中文状态词；检索分词对单字 / 日韩俄 / 重音字母零召回；中文与 emoji 的 token 估算偏低（有 EMA 校准兜底）。
- P3 子代理：开 `autonomyAutoResume` 时被降为人工续跑的后台 run 不补中断信封；重规划补丁非原子（中途失败已加的节点留在 run 里、补丁停在 pending）；排队租约的 abort 监听器不摘。
- P3 Windows：`Manage-Overlay.ps1` 不用 `-LiteralPath`（目录含 `[ ]` 失败）；覆盖包 PowerShell 调用缺 `windowsHide`；桌面壳单实例互斥名固定（旧壳驻托盘时新目录启动的新壳弹「已在运行」退出）；桌面壳没有原生 NavigationStarting 闸。

## 6. 已核为不成立（❌）

- 「`/api/bootstrap` 无凭据发 token、本机非浏览器进程免 token 调 decision」：SECURITY.md 已明示不防本机其它进程。只是 `13-http-router.js:206` 注释「blocks other local processes」已过时；legacy `/api/permission/decision` 仍透传 `updatedInput` 与 `scope:'session'`（管家路径已剥），可顺手对齐。
- 「启动补唤醒会送达超过 6 小时的旧信封」：那些信封本就该送达，窗口只决定「叫醒哪些会话」。
- 浏览器侧 CSRF / DNS rebinding / CORS / 前端 XSS：本批没有可复现绕过（Host 门、Origin 与 Sec-Fetch 校验、`renderMarkdown` 白名单、CSP、mermaid strict 都已实测）。
- 本地化：两份 catalog 的 key 完全一致，前端引用的 160 个字面 key 都存在。

## 7. 本次同时做的改动：工作文件夹选择器

用户反馈「选择路径的那个界面太古老了（比如设工作区那个）」。

- **原生对话框**：`/api/pick-folder` 从 WinForms `FolderBrowserDialog`（Windows PowerShell 跑在 .NET Framework 上，仍是 SHBrowseForFolder 那棵 XP 时代的树：不能粘贴路径、不能搜索）换成 Vista 起的通用项目对话框（`IFileOpenDialog` + `FOS_PICKFOLDERS`），与资源管理器同一套界面：地址栏可直接粘贴 / 输入路径、快速访问、搜索、最近位置；并**从当前工作文件夹打开**。Add-Type 用不了（受约束语言模式 / 组策略）或 COM 起不来时退回老对话框。脚本纯 ASCII、整段走 `-EncodedCommand`；标题与起始目录只经环境变量传入，起始目录只认本机盘符绝对路径（UNC 不传）。
- **顶栏弹层**：「浏览文件夹」放到最上面作为主按钮并说明可在地址栏粘贴；常用工作区每行显示名字＋完整路径（过长从左边省略）、当前文件夹打「当前」标；↑↓★ 文字换成带无障碍名的图标按钮（首行不可上移 / 已是默认时禁用），悬停或键盘聚焦时出现；新增「最近用过」；粘贴路径校验失败改为在输入框下就地说明（role=alert），不再一闪而过的 toast。
- 测试：`dev-harness/unit/folder-picker-modern.test.js`（脚本形状、环境变量清洗；Windows 上用真 powershell.exe 解析脚本并 Add-Type 编译其中的 C#，不弹窗）；`dev-harness/workspace-picker-popover.browser.e2e.js`（真浏览器 P1–P8）。C# 另在本地用 mcs 与 pwsh 7（Roslyn）编译通过；真弹窗仍需 Windows 真机看一眼。
