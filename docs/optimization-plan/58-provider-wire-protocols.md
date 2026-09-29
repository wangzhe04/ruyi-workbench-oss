# 58 · 服务商协议层：协议登记表 + Anthropic Messages 兼容

> 状态：**方案定稿（2026-09-29）；批 1 已实现（2026-09-29，交付记录见 §7）；批 2 已实现（2026-09-29，交付记录见 §8）**。用户拍板：官方 Anthropic 与国产/内网的 Anthropic 兼容网关两类都要；先做协议登记表重构，做完直接合并。
> 三批推进：批 1 重构（零行为变更）→ 批 2 Anthropic 协议表项 → 批 3 设置页、提示缓存与服务端工具。

## 0. 目标

如意的「模型服务商」引擎（内部引擎 id `openai`，`runOpenAiTurn`）今天会说两种线协议：OpenAI Chat Completions（`apiStyle: 'chat'`）
与 OpenAI Responses（`apiStyle: 'responses'`）。本方案加第三种 **Anthropic Messages**（`apiStyle: 'anthropic'`，`POST {base}/v1/messages`），
覆盖两类端点：

- **Anthropic 官方 / 直连 Claude 模型**：自适应思考与签名回传、提示缓存、`output_config.effort`、`refusal` 等要做完整；
- **国产或内网的 Anthropic 兼容网关**：先保证工具循环稳；高级能力按能力开关打开，默认保守。

它与现有的 Claude CLI 引擎是两回事：CLI 引擎是 Claude Code 自己跑工具循环、用它自己的工具；新协议是**如意自己跑循环**，
107 个原生工具、五档权限、检查点、回溯、审计全部生效，也不需要装 Claude Code。

内部历史**继续是 OpenAI chat 形**（`role/content/tool_calls/tool_call_id/reasoning_content`），协议差异只在「出站编码 / 入站解码」两个边上处理——
这正是 v1.7 接 Responses 时的做法，本方案把它从「散在各处的三元式」收成一张表。

## 1. 现状盘点（2026-09-29，master `292c6f03`）

协议分叉共 **约 47 处**，散在 6 个后端模块与前端设置页。按职责归类：

| 职责 | 位置 | 现状 |
|---|---|---|
| 端点 URL | 04h `providerApiBase` / `providerCompletionUrl`（布尔参数 `responses`）；09 failover 候选；08 子代理；06/05/10 三个非流式调用 | 每处自己算 `apiStyle === 'responses'` 再传布尔 |
| 请求头 | 04h `providerRequestHeaders` | 只会 Bearer |
| 模型清单 | 07 `fetchOpenAiModels`（`{v1}/models` + Bearer） | 与协议无关地写死 |
| 推理强度 | 05 `applyProviderReasoningEffort(body, provider, apiStyle)`；10 `applySummaryCallPolicy` 各写一份 `reasoning` vs `reasoning_effort` | 两份 |
| 输出上限字段 | 10 `SUMMARY_CALL_POLICY_RULE.models[].output` 按协议给字段名；05 改字写死 `max_tokens` / `max_output_tokens` | — |
| 请求体（流式主回合） | 09 `buildBodyWithLayout`：chat / responses 两支，**volatile 布局逻辑整段复制了一份** | 两支约 60 行重复 |
| 请求体（子代理） | 08 `buildBody` 两支 | — |
| 请求体（非流式） | 06 `providerRawCompletion`（起草/JSON 修复/记忆审稿/线程简介）；10 `singleSummaryCall`（压缩摘要）；05 `providerFixCompletion`（语音改字） | 各两支，system 折叠口径三处不一 |
| 历史→Responses 翻译 | 07 `toResponsesContent` / `buildResponsesInputItems` / `toResponsesTools` / `responsesHistoryWithCompleteToolPairs` | 住在 07，06/08/09/10 都跨模块调用 |
| 流式解码 | 07 `openAiStreamOnce`：靠 `Array.isArray(body.input)` **嗅探**协议；`processEvt` 里两套语法（chat 的 tool_call 槽位状态机 / responses 事件） | 一个 330 行函数 |
| 非流式解码 | 07 流式降级分支、06、05、10 `summaryResponseText` / `summaryResponseIncomplete` | 四份取字逻辑，口径互有出入 |
| 用量口径 | 05/06/06d/08/09/10 约 10 处手写 `prompt_tokens ?? input_tokens` | 无归一层 |
| 协议专属 | 09/08 `serverToolItems`（Responses 服务端 web_search 回传）；`provider.serverWebSearch` | 只对 responses 有意义 |
| 协议值归一 | 05 `sanitizeProvider`、08、09、10×4 处 `x === 'responses' ? 'responses' : 'chat'` | 与 CLI 那边批 4 之前同一种病 |
| 前端 | `public/js/provider-settings.js` 协议下拉写死两项；服务端搜索开关显隐只认 `responses` | — |

几处**口径不一**（重构时统一，属有意的边角变化，见 §3.5）：

- system 消息：06 把历史里追加的 system 规则折进 `instructions`；10 摘要与 08/09 直接丢弃（Responses 分支）。
- 取字：05 改字（responses）取任意带 `text` 的 part；06/10 只取 `output_text` / `input_text`；06 的 chat 分支对数组 content 做 `String()`，会得到 `[object Object]`，10 则正确拼接。

## 2. 目标架构

### 2.1 新模块 `04i-provider-wire.js`（排在 04h 之后、05 之前，**不进依赖环**）

```
PROVIDER_WIRE_DEFAULT = 'chat'
PROVIDER_WIRE_PROTOCOLS = Object.freeze({ chat, responses /*, anthropic（批 2）*/ })
normalizeProviderApiStyle(v)      // 唯一的协议值归一：登记过的键原样，其余 → 'chat'
providerWireProtocol(provider)    // → 表项
ProviderWireHooks                 // 延迟绑定：makeId / redact / completeToolPairs（由 07 顶层填充）
```

依赖纪律：04i 只引用 04h（零出边模块）。它要用的 `makeId`（00）、`redact`（04-permission-runtime）、
配对自愈（02 的 `repairProviderHistoryPairing` / `repairProviderHistoryToolArgs`）都在依赖环里——直接引用会把 04i 拽进 SCC
（上限 32，已满）。所以这三样走 `ProviderWireHooks` 延迟绑定，由 07 在顶层填充（先例：06j `SchedulerHooks`、01f `cliHost`）。

从 07 / 05 **搬进** 04i（纯搬家，名字不变，导出面不变）：

- `toResponsesContent`、`buildResponsesInputItems`、`toResponsesTools`、`responsesHistoryWithCompleteToolPairs`（后者经钩子调 02 的两个自愈函数）；
- `PROVIDER_REASONING_EFFORTS`、`providerReasoningEffort`、`applyProviderReasoningEffort`；
- `openAiStreamOnce` 里的两套事件语法（成为各表项的 `createStreamDecoder`）。

`openAiStreamOnce` 留在 07，只管**传输**：发请求、首字节前的传输失败与 failover 判定、400 归因（工具被拒 / 超窗 / `stream_options`）、
SSE 分帧（空行分事件、多行 `data:` 拼接、`[DONE]`）、`raw_line` 事件；协议由调用方显式传入（`protocol` 参数），
缺省时仍按请求体形状推断（兼容）。

### 2.2 表项成员（每个协议一份，冻结）

| 成员 | 作用 | chat | responses |
|---|---|---|---|
| `id` | 协议值（= `provider.apiStyle`） | `'chat'` | `'responses'` |
| `serverWebSearch` | 是否支持把本地 `web_search` 映射成服务端工具 | `false` | `true` |
| `endpointBase(baseUrl)` | 显示/粘住键用的 base | `/vN` 归一 | 原样 |
| `completionUrl(baseUrl)` | 补全端点 | `…/chat/completions` | `…/responses` |
| `modelsUrl(baseUrl)` | 模型清单 | `{v1}/models` | `{v1}/models` |
| `requestHeaders(provider)` | 出站请求头 | `providerRequestHeaders` | 同左 |
| `encodeMessages({ model, messages, stream, instructions, serverItems })` | 基础请求体（`messages` 是含首条 system 的 chat 形历史） | `{model, messages, stream[, stream_options]}` | `{model, instructions, input, stream}` |
| `applyEffort(body, effort)` | 推理强度字段 | `reasoning_effort` | `reasoning: {effort}` |
| `applyTools(body, tools, { serverWebSearch })` | 工具与 `tool_choice:'auto'` | 原样 | 拍平 + 可选服务端搜索 |
| `outputTokensField` | 输出上限字段名 | `max_tokens` | `max_output_tokens` |
| `encodeQuick({ model, messages, plain })` | 语音改字的短补全（400 token、尽量关思考） | 现 05 chat 形 | 现 05 responses 形 |
| `decodeCompletion(payload)` | 非流式回体 → `{ text, reasoning, toolCalls, finishReason, incomplete, failedDetail, usage, responseId }` | `choices[0].message` | `output[]` |
| `createStreamDecoder({ onEvent, markUsage })` | 流式事件 → `feed(evt, raw)` / `finish()` | tool_call 槽位状态机 | responses 事件语法 |
| `normalizeUsage(u)` | 用量归一到 OpenAI 口径（`prompt_tokens` 含缓存） | 原样 | 原样 |
| `assistantHistoryFields(call)` | 本次回复要随 assistant 消息落进历史的协议字段 | `{reasoning_content}` | `{reasoning_content}` |

后两项在批 1 里对 chat/responses 都是恒等，是给 Anthropic 预留的接口：它的用量要换算口径，思考块要带签名原样落历史。

### 2.3 调用点改成只问表

- 09 `runOpenAiTurn`：`const wire = providerWireProtocol(provider)`；failover 候选、`buildBodyWithLayout`（volatile 布局只写一份，
  协议差异只剩 `wire.encodeMessages` / `applyEffort` / `applyTools`）、四处 assistant 入历史改 `...wire.assistantHistoryFields(call)`；
  `openAiStreamOnce({ …, protocol: wire })`。
- 08 子代理：同上。
- 10 摘要：`encodeMessages` + `applySummaryCallPolicy` 改用 `wire.applyEffort` / `wire.outputTokensField`；取字、未完成判定改 `wire.decodeCompletion`。
- 06 起草、05 改字：同上；05 改字用 `wire.encodeQuick`。
- 07 `fetchOpenAiModels`：URL / 头走表。
- 所有 `x === 'responses' ? 'responses' : 'chat'` → `normalizeProviderApiStyle` / `wire.id`。

### 2.4 前端

新增 `public/js/provider-api-styles.js`（零 import、零 DOM，同 `agent-cli-registry.js` 模具）：`PROVIDER_API_STYLES`
（`id`、`labelKey`、`hintKey`、`serverWebSearch`）。设置页协议下拉由表生成；服务端搜索开关按 `serverWebSearch` 显隐。
键集合与服务端表逐一相同，由单测钉住。

### 2.5 防回潮的锁

- `unit/provider-wire-protocols.test.js`：
  - 表的键集合 = 前端表键集合，成员齐全、类型对、冻结；
  - `normalizeProviderApiStyle` 对输入表的输出与修前三元式逐项相同（含原型链名、大小写、非字符串）；
  - 各成员的金样（编码 / 解码 / 用量 / 历史字段）；
  - 结构锁：`app/src` 与 `public/js` 里不再出现 `apiStyle === 'responses' ?` 这类三元式（source-slice 切函数读）。
- `unit/provider-wire-stream.test.js`：`openAiStreamOnce` 的**特征语料**——在改之前用 master 的代码跑出结果写死：
  - chat：文本、推理、并行 tool_calls（有/无 index、只有 id）、多行 `data:`、无结尾空行、`[DONE]`；
  - responses：文本、推理、按 `item_id` 路由的并行 function_call、`web_search_call`、completed / incomplete / failed；
  - 两种协议的非流式 JSON 回体；
  - 400 工具被拒、400 超窗、400 剥 `stream_options` 重试、502 failover 标记、传输失败结构化返回。
  重构后同一份语料必须逐项相同（事件序列 + 返回值）。
- `unit/provider-http.test.js` 已有的 H4/H5 逐字节锁（改字、起草）原样保留。
- CLAUDE.md「写新代码先找现成的」加一行：按协议分叉的知识只住 04i 的表 + 前端 `provider-api-styles.js`。

## 3. 批 1：重构（本 PR，零行为变更）

### 3.1 顺序

1. **先立特征锁**（改代码之前，在 master 上跑绿）：`unit/provider-wire-stream.test.js` 语料；
   再做一次**出站请求体快照**：用捕获型假端点把主回合（文本 + 工具 + 并行工具 + 视觉）、子代理、压缩摘要、起草、改字、模型清单
   在 chat / responses 两种协议下的每一发请求体逐字节录下来（同 HOME、同工作目录，时间类字段打码）。
2. 建 04i，搬函数（纯搬家，零改写），07 顶层绑 `ProviderWireHooks`；`node app/build.js`，全部现有测试不动也要绿。
3. 抽 `createStreamDecoder`：把 `processEvt` 两支原样搬成两个解码器，`openAiStreamOnce` 改调它；语料锁必须逐项相同。
4. 逐个调用点改成问表：09 → 08 → 10 → 06 → 05 → 07 `fetchOpenAiModels` → 各处协议值归一。每改一个跑一次快照比对。
5. 前端表 + 设置页下拉改造。
6. 锁、CLAUDE.md、生成物（module-dependency-graph、module-contracts、facts）重算。

### 3.2 验收

- 出站请求体快照：新旧 **逐字节相同**（§3.5 列出的边角除外，且边角另有专门断言）；
- `unit/provider-wire-stream.test.js`：新旧逐项相同；
- 快速通道：`syntax-gate`、`build --check`、全部 unit、`run-all --fast`；
- 相关 e2e：`responses-fake`、`responses-websearch-fake`、`summary-call-policy`、`summary-single-shot`、`vision-loop`、`economics-shadow`、
  `observation-recall-replay`、`fake-openai` 系、子代理与工作流系；
- Linux 全量与改动前同环境基线相同（基线 377/32，32 件是 Windows 专属）；
- 依赖图：SCC 仍是 1 个、≤ 32 个模块；前向边不增；
- Windows CI `e2e` 绿后合并。

### 3.3 不做的事

- 不改任何请求体的键序与内容（对服务商前缀缓存友好，也便于逐字节比对）；
- 不碰 Claude CLI / Kimi CLI 引擎；
- 不加 Anthropic（批 2）。

### 3.4 风险

- **依赖环**：04i 一旦直接引用 00/02/04 的符号就进 SCC（33 > 32 → 静态门红）。对策：只经 `ProviderWireHooks` 拿，静态门兜底。
- **钩子未绑定**：07 顶层绑定先于任何调用执行（单文件、加载即执行）；单测断言绑定的就是那三个真函数。
- **流式解码搬家的细微时序**：`raw_line` 先于解码、`providerResponseId` 捕获口径、终止事件后不再处理剩余块——都由语料锁逐项钉住。

### 3.5 有意统一的边角（PR 里单独列出并各配断言）

- 非流式取字统一为 10 的口径：数组形 `content` 正确拼接文本（修 06 的 `[object Object]`）；Responses 只取 `output_text` / `input_text`
  （05 改字原来取任意带 `text` 的 part——真实回体里 message 的 part 只有这两种，实际无差）。

除此之外零行为变更。

## 4. 批 2：Anthropic Messages 表项

### 4.1 端点与鉴权

- 补全 `{providerBaseWithV1(base)}/messages`；模型清单 `{v1}/models`。官方 `https://api.anthropic.com` → `/v1/messages`；
  兼容网关形如 `https://<host>/anthropic` → `/anthropic/v1/messages`，与 Claude CLI 的 `ANTHROPIC_BASE_URL` 口径一致。
- 头：`content-type`、`anthropic-version: 2023-06-01`；鉴权按新字段 `provider.anthropicAuth`：
  `x-api-key`（官方默认）/ `bearer`（部分网关）/ `auto`（官方主机只发 `x-api-key`，其它主机两个都发——与 CLI 的 `claudeAuthMode` 同义）。
  `extraHeaders` 照旧最后覆盖。`anthropic-beta` 只在用到对应功能时带。

### 4.2 请求编码（chat 形历史 → Messages）

| 内部 | Messages |
|---|---|
| 首条 system（身份 + 稳定层） | 顶层 `system`（批 3 起用块数组以便挂 `cache_control`） |
| 历史中后插的 system（压缩标记、修复说明、起草规则） | 折成紧随其后的 user 文本块（`<system-reminder>…</system-reminder>`）；不改顶层 system，保住前缀缓存 |
| `user` 字符串 / parts | `{role:'user', content:[text / image]}`；data URI → `{type:'image', source:{type:'base64', media_type, data}}`，http(s) → `source.type:'url'` |
| `assistant` + `tool_calls` | `content:[thinking…(若有且可回放), text?, tool_use{id, name, input: JSON.parse(arguments)}]`；arguments 不是合法 JSON 时用 `{}`（与 02 的参数自愈口径同） |
| 连续的 `role:'tool'` | **合成一条** user 消息，每个 `tool_result{tool_use_id, content, is_error}`；工具截图的图片消息并进同一条、排在所有 `tool_result` 之后 |
| 相邻同角色消息 | 合并（Messages 要求 user/assistant 交替） |
| `tools` | `{name, description, input_schema}`；`tool_choice:{type:'auto'}`（**永不**发 `any`/`tool`——新模型会 400） |
| `max_tokens` | **必填**。流式默认 32000、非流式 8192；`provider.maxOutputTokens` 可覆盖；模型清单给了 `max_tokens` 就取较小者 |
| 推理强度 | `none/minimal→low`，其余原样进 `output_config.effort`；思考方式见 §4.4 |
| temperature | 只在用户显式设了、且能力表说该端点接受采样参数时才发（新 Claude 模型一律 400） |
| 调用方附加的 `stream_options` / `reasoning_effort` 等 OpenAI 字段 | 不发 |

### 4.3 流式解码

事件：`message_start`（取 `message.id`、初始 usage）→ `content_block_start`（`text` / `thinking` / `redacted_thinking` / `tool_use{id,name}` /
服务端工具块）→ `content_block_delta`（`text_delta` / `thinking_delta` / `signature_delta` / `input_json_delta`）→ `content_block_stop`
→ `message_delta`（`stop_reason`、累计 `output_tokens`）→ `message_stop`（终止）；`ping` 忽略；`error` 事件 → `httpError`
（`overloaded_error` 视同 529，走瞬时重试）。

`stop_reason` 映射：`end_turn` / `stop_sequence` → `stop`；`tool_use` → `tool_calls`；`max_tokens` → `length`；
`pause_turn` → 把本次内容原样续进历史后再发一次；`refusal` → 以可见错误结束本回合，带上 `stop_details.category`。

### 4.4 思考块与签名（改动面最大的一块）

- 解码时把 `thinking`（含 `signature`）/ `redacted_thinking` 块**原样**收进 `call.providerBlocks`；`thinking` 文本照旧进 `reasoning_content` 供界面显示。
- `assistantHistoryFields` 落历史：`{ reasoning_content, providerBlocks: { protocol:'anthropic', model, blocks:[…] } }`。
- 编码时只在**协议与模型都相同**时回放 `providerBlocks`（换模型、换协议一律不带，模型只看文本）。
- 上下文治理的纪律（最新模型会校验「历史被改过」）：
  - 压缩重建（reseed）后的新前缀天然不含思考块；
  - L1 蒸发、动作参数瘦身投影、配对自愈这类**改动较早轮次**的操作：同时去掉被改那条及其之前所有 assistant 的 `providerBlocks`，只丢块、不改块内容；
  - 实施前按 `claude-api` 技能的 preserved-thinking 迁移指南再核一遍规则，并给这条纪律单独写 e2e。
- 思考方式按能力：官方主机 + `claude-*` 模型 → `thinking:{type:'adaptive'}`（不发 `budget_tokens`，新模型会 400）；
  兼容网关默认不发 `thinking`，用户可在能力开关里选「自适应 / 按预算 / 关」。

### 4.5 用量

`message_start.usage`（`input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`）与 `message_delta.usage.output_tokens`
在解码器里合并，`message_stop` 时**只报一次**，归一成：
`prompt_tokens = input + cache_read + cache_creation`，`completion_tokens = output`，`prompt_tokens_details.cached_tokens = cache_read`，
原字段保留。这样 10 处消费方、上下文计量条、台账一行不改就对（Anthropic 的 `input_tokens` 不含缓存，直接用会少算）。
缓存写入的 1.25 倍价由批 3 的 `pricing.cacheWriteInputPerM` 处理。

### 4.6 错误与重试

- 529 / `overloaded_error` 加进瞬时集合（`providerCallIsTransient`，对 chat 也无害）；429 读 `retry-after`；
- 超窗：`prompt is too long` 已在 `context-governance-rules.json` 的判定式里；413 `request_too_large` 同样走强压重试；
- 400 参数不认（兼容网关常见）：沿用摘要那套「认出字段名 → 去掉重打一次 → 进程内记住」，扩到主回合的 `thinking` / `output_config`。

### 4.7 其它入口

- 模型清单：Messages 的 `/v1/models` 回 `display_name`、`max_input_tokens`、`max_tokens`；`max_input_tokens` 加进 `contextLengthKeys`。
- 摘要 / 起草 / 改字：自动走表（`outputTokensField: 'max_tokens'`，`encodeQuick` 不发 `thinking`，effort 取 `low`）。
- 子代理、工作流节点：自动走表。

### 4.8 测试

- 新假端点 `dev-harness/lib/fake-anthropic-provider.js`（与 `fake-openai-provider.js` 同模具：`startFakeAnthropic` + 帧构造器）；
- `anthropic-fake.e2e.js`：文本流；思考 + 签名在工具循环第二发里**逐字节回放**；并行 `tool_use` → 一条 user 里两个 `tool_result`；
  `is_error`；截图结果图片排在 `tool_result` 之后；`max_tokens` 截断；`refusal`；流中 `error` 事件；529 重试；用量换算进台账；
  摘要、起草、改字、子代理、模型清单（`x-api-key` 头）；换模型不回放思考块；蒸发后思考块被整块去掉；
- 单测：编码 / 解码金样、角色交替合并、鉴权头三种模式；
- 另写一个联调脚本 `dev-harness/anthropic-live.js`（环境变量给 key 才跑，同 `deepseek-*-live.js`），真端点冒烟由你在 Windows 上跑。

## 5. 批 3：设置页、提示缓存、服务端工具

- 设置页协议下拉加「Anthropic Messages」与说明；选中后出现鉴权方式、思考方式、提示缓存三个能力项；
- 服务商预设加一条「自定义（Anthropic 兼容 / 内网自建）」；Claude CLI 设置里已填的端点可一键「导入为服务商」；
- **提示缓存**：`tools` 末项 + `system` 末块一个断点（稳定前缀），最近一条 user 一个滚动断点；volatile 层走尾部布局，不打断前缀；
  用 `cache_read_input_tokens` 做验收（多轮后应稳定大于 0）；台账加缓存写入价；
- 服务端搜索：`serverWebSearch` 对 anthropic 映射成 `web_search_20260209`（官方主机才开），`server_tool_use` / `web_search_tool_result`
  块随 `providerBlocks` 回放；
- 文档：README 中英、ADMIN-GUIDE（端点形状、鉴权、能力开关）、USER-GUIDE。

## 6. 验证与合并节奏

- 云端只能用假端点验证协议正确性；真端点联调要你给 key 或内网地址，或合并后在 Windows 上跑 `anthropic-live.js`；
- 每批：快速通道 → 相关 e2e → Linux 全量对基线 → Windows CI → 合并；
- 批 1 合并后再开批 2，批 2 合并后再开批 3。

## 7. 批 1 交付记录（2026-09-29）

- 新模块 `04i-provider-wire.js`：`PROVIDER_WIRE_PROTOCOLS`（chat / responses 两项，成员见 §2.2）、`normalizeProviderApiStyle`、
  `providerWireProtocol`；Responses 翻译四个函数自 07、推理强度三件自 05 纯搬家；`openAiStreamOnce` 的两套事件语法搬成
  两个 `createStreamDecoder`，函数本身只留传输、400 归因与 SSE 分帧。环内工具经 `ProviderWireHooks` 由 07 顶层绑定。
- 调用点：09 主回合（请求体的消息视图只构建一份，原 chat / responses 两支约 60 行重复删掉）、08 子代理、10 摘要（原
  `summaryResponseText` 等三个取字函数并入解码器）、06 起草、05 改字、07 模型清单、05 `sanitizeProvider`。
- 前端 `public/js/provider-api-styles.js`，设置页协议下拉与服务端搜索开关按表生成 / 显隐；离线 overlay 清单已登记。
- 依赖图：64 个模块，SCC 仍 1 个 32 个模块（04i 不在环里），前向边仍 68。导出 +3（上限 572 → 575）。
- 锁：`unit/provider-wire-stream.test.js`（47 条流式 / 非流式 / 失败路径语料，金样在 master 上录）、
  `unit/provider-wire-protocols.test.js`（登记表、归一、各成员金样、延迟绑定、结构锁——在 master 上会命中 53 处分叉）、
  `provider-api-style.browser.e2e.js`（设置页下拉与开关联动）。
- 验证：出站请求体快照（主回合含并行工具与子代理、压缩摘要、起草、记忆起草、模型清单，两种协议各 12 发）与 master
  **逐字节相同**；`unit/provider-http.test.js` 的改字 / 起草逐字节锁不改一字通过；相关 e2e 26 件全过（`agent-mode-v2` 的 7 条
  Linux 失败与 master 逐条相同：没有 `powershell.exe`）。
- 有意统一的边角（§3.5）：非流式取字统一为 10 的口径——chat 的 parts 数组拼文本（修起草拿到 `[object Object]`）、
  Responses 只取 `output_text` / `input_text`。

## 8. 批 2 交付记录（2026-09-29）

- 新模块 `04i-provider-anthropic.js`（排在 04i-provider-wire 之前，只引用 04h，不进环；makeId / redact / 配对自愈由登记表胶水注入）：
  端点 `{v1}/messages`、鉴权头（`anthropicAuth`：缺省官方主机只发 `x-api-key`、其它主机两个都发；可显式 `x-api-key` / `bearer`）、
  chat 形历史 → Messages（后插 system → `<system-reminder>` user 文本；连续工具结果合成一条 user，`tool_result` 排最前；相邻同角色合并；
  首末补 user；图片 data URI / URL；空文本不出块；id 清洗两边一致）、自适应思考（`anthropicThinking`：缺省按模型名，Claude 4.6 起的
  opus / sonnet / fable / mythos 发 `{type:'adaptive', display:'summarized'}`，其余不发）、`output_config.effort`、非流式与流式解码、用量归一、
  400 兼容重打。登记表加 `anthropic` 一项，全表加成员 `retryOn400`（chat / responses 恒 null）。
- 思考块（§4.4 的落地口径，按 claude-api 技能的 preserved-thinking 规则核过）：解码把本次回复的内容块按原顺序收进 `providerBlocks`
  （只在真有思考块时带，`reasoning_content` 照旧）；编码**只回放最后一条 user 之后那段 assistant**，且协议、模型（回体 model 或请求 model）、
  tool_use id 都对得上才原样回放。理由：如意每次请求都在最后一条 user 上追加非持久提示（易变层尾部布局、recall、session notes），
  新 user 一来上一条的追加就没了，它之后的思考块必然失效；丢掉「从最早开始的一段」思考块是 API 明文允许的。循环中途真碰上签名失配
  （L1 蒸发等改了前缀），`retryOn400` 去掉全部思考块重打一次。
- 不带 tools 的请求（摘要、起草、去工具重打）里 Messages 不收 `tool_use` / `tool_result` 块：调用方传 `hasTools`，不是 true 时改写成文字、
  也不回放思考块（09 / 08 按本发是否 applyTools 传；06 / 10 不传）。
- 错误：529 进瞬时集合（04h `providerCallIsTransient`）；流内 `error` 事件在吐内容之前按状态码口径报（overloaded → 529、限流 → 429），
  吐过内容就不带状态码（重试会让界面内容重放）；`refusal` 以带类别的可见错误结束本回合。超窗报文 `prompt is too long` 早在判定式里。
- 其它入口：模型清单认 `max_input_tokens`（`contextLengthKeys` 加一项）；配置清洗新增 `anthropicAuth` / `anthropicThinking`（空不落字段）；
  前端协议表加一行（设置页下拉自动多出「Anthropic Messages」），能力项的界面留给批 3。
- 测试：`unit/provider-wire-anthropic.test.js`（9 组：端点与头、编码、回放、不带 tools、强度与工具、非流式、流式、400 重打、配置与清单）；
  `anthropic-fake.e2e.js`（真工作台 + `lib/fake-anthropic-provider.js`：并行工具循环、思考块逐字节回放、用量归一、历史落块、第二回合不回放旧块、
  签名失配去块重打、子代理、非流式起草、模型清单）。chat / responses 的流式语料锁与出站逐字节锁不改一字通过。
- 云端只能用假端点验证协议形状；真端点联调（官方与国产网关）需要在有 key 的机器上跑。
