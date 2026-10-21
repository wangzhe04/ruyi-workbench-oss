# M1 外发清册原型：源码审阅与离线变更门

日期：2026-10-21。清点器本身不修改产品源码，不实现完整披露策略，不将任何新通道标成 `protected`。M2/A3 产品发送边界收敛及策略切换修复独立验收，本清册同步记录其调用关系。它给后续 M2 接收方合同提供可比较的源码清单；它不是运行时网络监视器或“全部出口已覆盖”的证明。

## 使用

在仓库根目录使用 Node.js 24，仅用 Node 内建模块，不安装包、不启动应用、不加载 Python/CLI/MCP、不读取用户家目录或凭据、不访问网络：

```powershell
node dev-harness/privacy-m1/egress/inventory.js --check
node --test dev-harness/privacy-m1/egress/inventory.test.js
node dev-harness/privacy-m1/egress/inventory.js --write
```

`--check` 对照手工 `manifest.json`，并逐字检查生成 JSON/Markdown。新增/删除源码、源码原字节 SHA-256变化、新增/删除调用、调用指纹变化、缺少/重复/非法分类、无运行证据却标 `protected` 均失败。`--write` 可以输出含 `reviewErrors` 的待审清册，但**不会更新或补齐手工 manifest，发现未分类时仍退出 1**。只运行不带参数的命令检查 manifest，不改文件。

审阅者须先阅读变更源码、接收方及调用链，再手工改 manifest 中相应 `sources`/`entries` 与分类组。不得批量接纳新指纹后宣称完成审阅。分类组的任何文本修改改变 `manifestFingerprint`，旧生成物的 `--check` 随即失败。manifest、脚本与生成物都可被有写权限者一起更改；本门不是抗恶意篡改系统，也没有把手工分类本身认证为正确。

本门保持独立，未接入默认生产 CI，也不要求每次产品开发冻结全部源码。

## 清点范围与计数

当前快照：268 份第一方源码/声明配置，660 条**候选**。其中包含 133 个已审为本地正则的 `RegExp.exec`、同名 UI 回调、传输能力导入、声明配置和动态边界。这些数字不能当作 660 次实际外网发送，也不能用命中数推导覆盖率。网络、MCP stdio 输入与 stdout 输出、子进程、文件、浏览器委托、包装函数、动态边界及模块能力分别保留 `category`。

扫描仅遍历仓库 `ruyi-workbench/` 与 `mcp/` 的 `.js/.mjs/.cjs/.py/.ps1/.cmd/.bat/.cs/.html/.sh/.json/.toml/.yaml/.yml`。不遍历工作台运行时用户数据目录，不启动这些程序。`app/server.js` 是 `app/src` 拼接产物，排除以免双算；vendor、node_modules、tests/test、build/build_offline、dist、bin/obj、Python runtime/venv/site-packages、locales 与 package-lock 排除。新文件在允许范围内会出现；新增排除目录内部实现不会出现，修改扫描范围必须另行审阅。符号链接拒绝扫描，不跟随到仓库外。

UI 到本机 `/api`、Kimi 本机桥、toolbox 本机探活在清册中标成 `local-only`；它们的后端 onward 调用有独立条目。`local-only` 只说明这一跳，不代表服务自身不能外发。子进程即使是本机 Python、编辑器、Git 或 Office，也没有因此获得网络隔离证明。

清册采用稳定的 `file#symbol#callee#ordinal` 锚。没有源码行号与生成时间。全文件按原字节计算 SHA-256，注释、换行和空白变化也要求人工重审，以覆盖 Python 缩进、JS ASI 和 PowerShell 行继续等有意义差异；候选调用局部使用词法指纹，普通注释不会制造出口；载荷字符串只进入 SHA-256，输出不包含源码摘录、URL 字面量、正文或认证头。分类合同集中存入 `groups`，每条调用用 group 名引用，避免数百份重复长说明。JSON 为机器比较所需，Markdown 是对应人工审阅视图；两者为同一生成器输出，不是两份独立证据。手工 manifest 保留独立审核基线，是检测分类被删改所需的第三份不同职责文件。

## 四个模型正文发送入口

M2/A3 将四处正文 POST 接线收敛到 `04h-provider-http.js / providerModelPostOnce / fetch` 一个物理发送点。以下四个业务入口仍分别登记为 `wrapper`，不因物理调用从四处变为一处而宣称覆盖提升。物理点和四个包装调用均记 `model-only`，**接收方披露策略尚未补齐**。统一边界在既有 `withPolicy` 内执行 `await beforeModelRequest → JSON.stringify → assertPolicyAvailable → fetch`，策略复核后没有其它 await；已有 active scope 复用，无上下文沿用 `auxiliary`，off 仅绑定策略签名而不建立 scope。此绑定也修复无 scope/off 的请求在 prepare await 期间开启保护后仍可能提交的竞态，因此本片包含行为修复。调用方继续负责头、信号、协议、重试和读体。

| 业务入口（均调用统一 POST） | 生产调用关系及重试边界 | 当前源码证据与边界 |
|---|---|---|
| `04h-provider-http.js / providerPostJsonOnce / providerModelPostOnce` | `05 providerFixCompletion`、`06 providerRawCompletion` 经共用非流式 helper；更上层摘要/纠错/起草消费者依然需要正确 scope | 统一边界先保护完整正文、编码，再 `assertPolicyAvailable`；headers 的服务认证与模型正文分开；不能据此证明任意调用者 scope 正确 |
| `07-autonomy.js / probeProviderCompletion / providerModelPostOnce` | 模型兼容性探测，协议登记表生成 ping 请求体 | 每次正文发送经过统一边界；探测 URL/认证头另属接收方元数据披露 |
| `07-autonomy.js / openAiStreamOnce / providerModelPostOnce` | `09-workflow.js / runOpenAiTurn`；`08-agent-runs.js / runSubAgentCore` 的普通与重试调用均使用它；内部 `doFetch` 负责重新发送 | `doFetch` 每发均调用统一边界；流式/非流式、工具拒绝等兼容重发要复用此处，不能只检查第一次业务入口 |
| `10-context-governance.js / singleSummaryCall / providerModelPostOnce` | `providerSummaryCallCore`、摘要/压缩和多轮合并路径；受信号/预算约束 | 每次摘要正文在发送前经过统一边界；历史来源投影与 scope 生命周期不由清册静态证明 |

生成清册同时列出上述 helper 的调用点；包装函数是生产关系证据，不能再当作新的物理 HTTP 出口相加。模型清单探测/HEAD、原始音频 POST、实时 PCM、MCP HTTP、Web 工具和机器人不应混进这四个模型业务入口来声称它们都受保护。

## M2-2 工具历史编码收敛审阅

`08-agent-runs.js` 七处与 `09-workflow.js` 十处历史编码改为调用 `10-context-governance.js:encodeModelToolResult`。完整结果对象原样传给 `modelToolResult`，其映射持久化完成后才 JSON 序列化并调用原 `truncateToolResult`；来源证明、已执行结果扣留回执、错误传播及各调用方事件/历史配对职责保留。未新增实际外发点，本片不补接收方授权，原 `model-only` / `unknown` 分类不变。依赖图仍为621条边、一个强连通分量。此次按已读差异更新三份产品源及构建manifest/module-contracts指纹；测试证据由本批独立记录提供，不把源码收敛写成完整隐私验收。

## M2-3 受限本地原值使用审阅

`prepareExecution` 在释放引用原值前使用宿主确定的本地文件/当前会话字段适配器，注册和工具tier不再授予通用还原。参数/代理归一、权限编辑、等待后的派发及真实文件I/O保留宿主绑定并重验；UNC、映射网络盘、未知介质或链接落点不继承本地授权。未适配脚本、HTTP和MCP收到引用时拒绝恢复；普通不含引用的调用及off语义不因此变成已隔离。该批完成时搜索/HTTP/机器人/独立MCP的完整接收方合同仍待后续批次；后续用户已收窄公开联网范围，见下节裁决。原model-only/unknown/bypassed分类不作通道级升级。

新增六个词法候选逐项审阅：`03/privacyInspectionSegment/run`为短命AsyncLocalStorage检查段，记non-egress；`03a/withExecution/run`为AsyncLocalStorage本地回调，记non-egress；`03b/start/exec`为回复正则，记non-egress；`03b/start/spawn`和`03b/pump/write`为固定DriveInfo本地子进程及仅盘符根字母的stdin，单列privacy-drive-probe/local-only。新增`03b/<transport-import>`为局部node:child_process能力导入，沿用capability/unknown，不用固定调用点推导builtin内部普遍安全。探针仅提供受限介质判据，不是OS隔离；脚本无派生子进程，生命周期只处理仍存活的ChildProcess对象。主/子批准备、DriveType准入及根检查有界；检查缓存只在单次检查段内复用，实际I/O前重新读取实际目标和原词法接收方的介质/链接拓扑并复核权限、策略和引用。原子临时件和移动中间件仅有受限本地清理/恢复路径。这是明确适配器的宿主合同，并非所有文件系统元数据调用都加了新hook，更不是系统强制隔离或抵御同账户恶意程序的证明。最终依赖图为88模块/625边/0重复provides/1强连通分量；顶层冻结循环误识别和broker反向依赖导致的初始图失败由本批证据保留，不放宽政策。最终源码100文件合成搜索单次观察约1.35秒，对照无引用约196毫秒（非统计基准，不含真实DPAPI），剩余成本已记录，不能用盘符探针热查询约0.3毫秒代替整条工具成本。详细产品证据由本批记录承载，不用词法候选数量推导覆盖率。

## 公开联网范围裁决（2026-10-21，M2-3之后）

用户决定普通公开搜索、网页抓取和下载不新增内容脱敏；M2-4只核验公开调用正常通过，以及M2-3现有本地私密代号不自动还原到query/URL/body的轻量边界。M2-5通用HTTP脱敏/披露适配取消，移出发布阻塞项。SSRF、DNS固定、重定向、代理、权限及认证清理等原检查继续保留；机器人、导出、MCP、媒体等范围不变。未实现的完整HTTP保护不因范围调整变成已完成，清册原`bypassed/unknown/model-only`分类及历史证据不作升级；这里只更新后续任务要求。详见86/92。

### 2026-10-21 M2-6a 受管机器人回发

`13w` 的受管 worker 现在在 token 返回后、现有 state 写链内重新核对权威执行结果、attempt、平台/租户/机器人/群或私聊及凭据修订。`03a` 以私有 receipt 绑定策略、完整来源和投影；完整回复先保护，再沿用原平台裁剪。`13x` 在 JSON 字节准备好后、实际 `transport.request` 前同步检查取消、身份与 receipt，不在两者之间 await。超长/容量不足保留业务完成事实，只失败投递；已派发的不确定结果仍为 unknown，不重放业务。OFF 不初始化扫描或映射加密，保留原正文与裁剪。

本批104项真实生成物/权威收发箱/本机官方协议接收端断言连续两遍通过；是 synthetic 凭据与本地传输证据，不是真 QQ/飞书账号验收。物理 `13x:post` 同时承载 token 和消息，裸适配器调用也仍可不带宿主 prepare，因此保留 bots/capability 原分类，不据受管消息子路径升级整个通道；导出与 MCP 仍按后续批次验收。指纹更新经独立逐项审阅，详见本批证据与92交接。

## 外发链路的重要缺口

| 通道 | 真实边界/生产关系 | 当前事实与 M2 后续要求 |
|---|---|---|
| Web 搜索/抓取/下载/任意 HTTP | `builtinSearch/webSearchViaBackend/deepseekWebRequest/httpRequest/httpGetGuarded` 经 `openHttpRequest`；代理有 CONNECT 与 TLS，DNS 本身也披露目标 | 现有 SSRF、权限、认证清理不等于接收方隐私合同。本批对带引用的未适配输入拒绝还原；普通query/body/header仍无完整接收方策略，通道级保留 `bypassed`；用户已取消通用HTTP适配，后续仅以M2-4核验公开调用直通和私密引用不自动还原，不再把完整适配作为发布门 |
| 受管 MCP | `McpStdioClient.start/_rpc/_notify/_onLine` 与 `McpHttpClient._request/_openSseStream`；HTTP/SSE 的 `lib`、`transport` 别名仍被 `.request` 候选发现 | `model-only` 是宿主模型侧结果投影的有界声明；本批未适配服务的引用参数拒绝恢复；本地 stdio 内部再联网、远程工具/资源/错误、独立消费者的连接级 scope 仍需单独实现/验收 |
| 独立工作台 MCP consumer | `13-http-router.js/startMcp -> sendMcp/sendMcpNotification -> process.stdout.write`；工具文本/图片、resources、error、progress 均是输出数据 | 专属 `workbench-mcp-output` 合同，记 `unknown`；不同于受管 MCP 客户端和独立 ACC 服务器。工具/资源列表在保护开启时隐藏，工具结果、资源读取和 catch 错误各有条件拒绝检查，但两处 stdout serializer 没有统一的连接级身份/scope/最终披露合同。进度 timer 直接发 progress token/通知，初始化/协议返回与错误行为也不能从工具结果检查推导已覆盖 |
| CLI 与任意子进程 | Claude 主/子任务，Kimi bridge/ACP/terminal，通用 shell、Git、媒体 helper、桌面/脚本启动器 | 现有开启保护时拒绝不支持 CLI，不是已经交付托管保护模式；关闭保护时的 hooks/MCP/plugins/遥测/子进程/缓存出口未知。清册记 `unknown`；无 OS 网络隔离证明 |
| ACC Python | `fetch -> _fetch_once -> opener.open -> _PinnedHTTP(S)Connection -> _pinned_connect`，两处 DNS，browser CDP/launch/goto/evaluate，shell/application/startfile、Office/file save | 固定 IP 与重定向 SSRF 检查不是正文脱敏；独立 ACC MCP consumer 收到原始工具结果/截图的边界未知。不能把“本地 stdio”当成可信不联网计算 |
| QQ/飞书 | delivery `post` 与 discovery `request/probe`，真实 HTTPS 请求与认证 token | 幂等、身份和回执约束已有；回复正文/接收群体没有共同的接收方投影合同，`bypassed`。发现/认证请求与业务回复复用底层 HTTP，不表示数据类别相同 |
| 外部文件与媒体 | 浏览器事件日志/会话/记忆/图表导出；后端/Python/Office 的 file save/copy/write；音频 multipart/JSON 和实时 PCM | 明文导出为 `bypassed`；凭据恢复包单列，不能代表完整工作数据保护；通用文件目标可能是可移动盘/网络共享，静态记 `unknown`。音频增加提交点检查并修复迟到配置发布，但没有接收方合同或本地 ASR，仍为 `unknown` |
| 浏览器加载与导航 | `.src/.href/.innerHTML/.srcdoc/setAttribute`、Markdown 渲染、HTML iframe、桌面 WebView 和外部浏览器 | 词法候选不等于能绕过 CSP。`index.html` 的 `img-src self/data/blob`、`connect-src self` 阻止普通远程图片/脚本 fetch；sanitizeNode 单独允许 http(s) src/href 不足以判断实际请求。用户点击外链、外部浏览器与动态页面的终点仍须审阅，记 `unknown` |

入口还涉及 `external-bot-gateway.js`，它是向已约束本机上游转发 webhook 的**入站中继**，没有被错标为机器人对外回复。桌面 `Process.Start`、安装/更新 PowerShell/batch 和打包下载命令保留为委托进程或动态命令；构建期依赖下载与用户聊天外发是不同目的。

音频事实复核：首版记录了 `transcribeAudioViaProvider` 在 toolbox/配置等待后的 TOCTOU，及迟到 `readConfig` 重新发布旧 off 策略的问题。后续修复在转写及非 DELETE PCM 的 `fetch` 前增加无 await 的当前策略检查，并以配置 generation 阻止旧读与其迁移回写覆盖新提交。真实生成服务器函数和本机接收端回归证明三档切换、迟到 hydration、失败及 DELETE 清理行为，见 `privacy-audio-send-boundary.e2e.js` 和 `unit/privacy-config-publication.test.js`。DELETE 仅保留无正文会话清理；已经提交的请求不能声称撤回。本清册仍不将该通道标为完整 protected：接收方合同、本地转写及原媒体处理尚未实现，详情见 [89 号记录](../../../docs/optimization-plan/89-audio-and-cli-isolation-followup.md)。

## 词法扫描能力和限制

实现先分词、忽略普通注释/字符串伪调用，匹配括号以定位调用及函数符号；用多族调用名称、模块能力、简单赋值/解构/别名链、Python 重命名函数 import、计算调用、动态 import/eval/Function、模板内疑似代码、DOM 资源赋值、非 JS 启动命令相互补充。ESM 重命名或更复杂绑定未完全解析时，模块能力或 first-class transport reference 保留 unknown。

这不是 AST/跨语言解析器，没有控制流、作用域、污点传播、可达性或全调用图证明。简单别名是有上限且作用域不敏感的固定点；同名方法会误报；匿名 arrow/对象 handler 可能落在 `<module>`，需要按调用锚和 manifest 合同阅读源码。模板嵌套、正则歧义、Python raw/f-string、PowerShell here-string/特殊注释、C#/COM 反射、动态模块、环境驱动 URL、native/DLL/第三方库、传入回调、CSS/HTML 自动资源和子进程内部行为均不能宣称静态完整覆盖。

全源码原字节 SHA-256只使允许范围内的未知实现变化触发人工重审；**它不能发现原本漏掉的出口，不能使未识别语法变成已理解，更不能替代 OS 隔离或网络实际字节验收**。二进制依赖与被排除 runtime/vendor 的内部外发必须在独立进程隔离和运行证据阶段补齐。没有从真实网络请求获得本轮证据，也没有读取密钥来“验证认证”。

## 行为测试证据

`inventory.test.js` 在临时目录创建并修改合成源码，不执行夹具代码。当前 14 项 Node test 通过，覆盖：新增 fetch/WebSocket/赋值别名链/解构重命名；计算调用、fetch.bind、动态 import 与模板疑似代码进入 unknown；ESM 别名保留模块能力；Python urllib opener/DNS/subprocess/重命名函数；独立工作台 MCP 两处 stdout serializer 与文本/图片/资源/错误/进度包装调用新增时拒绝未分类，仓库专属合同与受管 MCP/ACC 分开，转写音频保持 unknown/TOCTOU；端点改体/删除/分类删除及非法字段；未知调用形状触发源码重审；新增声明 MCP；生成 server/vendor/包内重复件不重复计数；同字节确定输出及无敏感字面量，注释不制造出口但触发复核，Python 缩进/JS return 换行/PowerShell 行继续变化触发复核；分类合同变化使生成指纹变化、拒绝重复分类和无运行证据的 protected；新增模型 POST wrapper、四个业务入口与唯一物理 fetch 分开记账，新增 wrapper 调用拒绝未分类；仓库四个入口与单发送点及当前 manifest 新鲜度。

M2/A3 产品独立验收：`node dev-harness/privacy-model-send-boundary.e2e.js` 16 项 ALL PASS。真实 PrivacyGateway 与本机接收端覆盖三线协议各四入口、off 原字节且不建 scope/worker/映射密封、无 scope 的 off→三档开启及 on→off/规则切换阻断、无上下文 auxiliary、已有 scope 对象与代号复用、JSON 编码时策略切换、持久化失败、取消，以及兼容重发每次保护和切换后阻止第二次发送。这是该发送边界的证据，不提升搜索、机器人或独立 MCP 的状态。

这些测试证明的是清点器和审阅门的行为，不是被清点产品的隐私性能或真实出口封锁。产品全量 E2E、真实 provider/CLI/MCP/机器人、网络抓包均不在此原型测试结论内。
