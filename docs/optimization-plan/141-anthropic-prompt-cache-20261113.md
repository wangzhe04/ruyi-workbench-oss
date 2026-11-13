# 141 · Anthropic Messages 缓存修复与 Agent Loop 对比（2026-11-13）

基于本机工作区 `138e8d8e` 定位。本页保存开发与提交前验证，实际提交身份以Git历史为准；已重建 `app/server.js`，没有打包或替换安装版。应用版本仍为3.0.1，3.1未发布。3.1总体进度沿用[140号交接](140-m4-m6-command-line-handoff-20261112.md)：原631项回归612 PASS／19 FAIL，13个FLAKY包含在PASS内；其中数量锁单独修复，其余18项仍待查，不能用本次定向验证抵消原RED。

## 已定位并修复

1. Anthropic编解码器原本只统计缓存读写，没有发送任何 `cache_control`。官方Messages接口需要显式启用缓存，不能直接沿用其他服务商的自动缓存假设。
2. 默认易变层前插到第一条历史user消息，每轮项目、记忆或技能提示变化都可能使历史前缀从早期失配。Claude的Anthropic协议现在通过登记表的 `preferVolatileTail(model)` 选择最新user尾部；Chat、Responses和非Claude兼容模型维持原布局与开关。
3. 临时提示原本和字符串用户正文粘成一个块。现在传入临时提示追加前的 `cacheUserPrefix`，编码时验证原文确实是前缀，再拆成原正文块和临时尾部块。原文（包括已持久化的消息时间）在下一轮仍有相同边界；临时提示仍不落盘。
4. 对流式Claude请求设置不超过四个显式5分钟断点：稳定system、最新user的首尾可缓存块、前一user的首块；重复位置只算一个，不标记thinking或其签名。system断点也覆盖排在它前面的tools。网关明确拒收 `cache_control` 时，只删除断点重打，保留内容、工具、思考与签名；无关400不关闭缓存。非流式起草/摘要维持原请求形状，不新增没有降级路径的缓存字段。

工具表原来已有会话冻结、顺序恢复和新增工具尾部追加，本次继续复用。**追加新工具仍然改变tools集合，可能使整段缓存失效**；追加顺序稳定不等于缓存永不失效。撤权、工具离线、压缩和观察蒸发导致的必要历史变化继续优先保证正确性。

## 同一个 Agent Loop 的三种线格式

三条路径共用09工作流、内部chat形历史、权限和工具执行。差异位于04i协议编码和解码，不是独立的三套执行器。

| 内容 | Chat Completions | Responses | Anthropic Messages |
| --- | --- | --- | --- |
| 系统指令 | `messages[].role=system` | 顶层`instructions` | 顶层`system`，本次Claude使用可标断点的text块 |
| 模型调用工具 | assistant的`tool_calls`；参数为JSON字符串 | `function_call`项；参数为JSON字符串 | assistant内容中的`tool_use`；input为对象 |
| 执行结果 | `role=tool`，`tool_call_id`逐个对应 | `function_call_output`，`call_id`对应 | 下一条user里的`tool_result`；并行结果合并并排在文本/图片前 |
| 下一次模型调用 | 完整历史加assistant调用和tool结果 | 完整input项加调用和结果；如意当前仍是无状态回放 | 完整messages加assistant块和user结果；相邻角色合并 |
| 推理回放 | 内部`reasoning_content`按兼容端点需要保留 | 当前适配把`reasoning_content`转成reasoning项，保障DeepSeek工具循环 | `providerBlocks`保存原块序和签名，仅回放最新user之后当前循环里的思考块；旧思考按既有策略移除 |
| 缓存适配 | 常见服务商自动缓存，需稳定消息和工具；兼容格式本身不保证缓存 | 同样依赖具体后端；Responses名称不代表自动保存会话或免发历史 | 必须启用缓存并选择有效边界；思考签名、块边界和前缀修改需额外处理 |

工程判断：原Chat/Responses路径对常见自动缓存后端已经较友好；Anthropic旧适配缺少启用和边界，不能仅凭共用循环获得同样命中率。修复后的Messages能够高命中，但它并非天然比OpenAI兼容协议更贵或更差；最终取决于后端缓存机制、网关转换、模型和稳定前缀。

官方依据：[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)。OpenAI的隐式/显式边界能力随模型代际变化，不向所有兼容网关发送官方新字段。DeepSeek的默认磁盘缓存和公共前缀持久化机制也不能直接套用到Claude后端。

## 本机历史账本

只读默认数据根2026-11账本，排除estimated，按 `sum(cachedInTok)/sum(inTok)` 加权；不是逐行百分比的平均。

| 服务商/模型/用途 | 记录数 | 输入token | 缓存token | 加权缓存占比 |
| --- | ---: | ---: | ---: | ---: |
| DeepSeek / deepseek-flash / turn | 84 | 768,479,424 | 759,187,968 | 98.79% |
| DeepSeek / deepseek-flash / subagent | 79 | 122,247,153 | 114,984,064 | 94.06% |
| 混元 / hy4 / turn | 8 | 105,675,372 | 103,390,656 | 97.84% |

这些主对话样本日期为11月4日至11日。当前配置DeepSeek为Responses、混元为Chat；账本本身未保存历史apiStyle，不能据当前配置严格证明每一条当时的协议。该账本没有可用的Yotta A主对话行，不虚构历史对照。

## Yotta A · Sonnet 缓存实测

使用本机凭据库解出的配置，模型 `claude-sonnet-5-5`。只发送合成文本，输出限制64 token；报告没有key、提示正文、真实用户数据或回复正文。[原始计数](evidence/anthropic-cache-probe-20261113.json)：

| 请求 | 普通输入 | 缓存读 | 缓存写 | 输出 |
| --- | ---: | ---: | ---: | ---: |
| 修前冷请求 | 4973 | 0 | 0 | 4 |
| 修前原样重复 | 4973 | 0 | 0 | 4 |
| 修后冷请求 | 4 | 0 | 4981 | 4 |
| 修后原样重复 | 4 | 4981 | 0 | 5 |
| 修后下一用户轮，旧临时提示移走 | 4 | 4969 | 21 | 4 |

这个首轮样本验证了Yotta A可以接受显式断点并返回标准Anthropic缓存拆分。当时原型还对非流式启用缓存；独审后最终范围收窄为流式，诊断工具也已改用生产流式路径。重复请求约99.9%的输入走缓存；冷写和缓存读都有价格，不能说总费用下降99.9%，也不能替代Yotta账单验收。

复现工具：`node dev-harness/probe-anthropic-cache.js --live --report <安全报告路径>`；默认不带`--live`只打印SKIP。

## 带工具的跨协议实测及网关口径疑点

另用配置中的Yotta（Chat/Responses）与Yotta A（Messages）请求相同模型名，真实取得一次 `cache_probe_echo` 调用、本地返回OK、继续调用、原样重复、进入下一用户轮。每种协议的system使用独立随机标识，避免跨协议预热。工具没有IO副作用。

三轮非流式记录分别保留为[r1](evidence/provider-loop-cache-20261113-r1.json)、[r2](evidence/provider-loop-cache-20261113-r2.json)、[r3](evidence/provider-loop-cache-20261113-r3.json)。r1的Chat四次均报零缓存；r2/r3的Chat和Responses均约95%输入读缓存。这个路由/后端差异保留，不用后续成功覆盖首次零命中，也不把同名模型回显当成相同实际后端的独立证明。

r3原样重复工具续调的报告：

| 协议 | 原始总输入字段 | 原始缓存读 | 原始输出 | 当前如意归一后的总输入 |
| --- | ---: | ---: | ---: | ---: |
| Chat | prompt_tokens=3469 | 3328 | 2 | 3469 |
| Responses | input_tokens=3482 | 3328 | 2 | 3482 |
| Messages | input_tokens=3480 | 3328 | 2 | 6808 |

Messages工具样本没有 `total_tokens`、`prompt_tokens` 或cached-details字段作独立校验，cache creation为0。又通过生产 `openAiStreamOnce` 路径做了[流式四次复测](evidence/provider-loop-cache-stream-20261113.json)：工具续调原始input=3487、cache_read=3328，当前按Anthropic标准归一成6815；下一用户轮原始input=3454、cache_read=3200。疑点在流式也存在。

**首轮限定结论（后续控制实验见下）：** Yotta A的这组工具回包疑似把“含缓存的总输入”放进了Anthropic标准应为“未缓存输入”的 `input_tokens`，从而使如意标准归一重复加缓存。直接无工具样本又返回标准拆分，不能对该服务商统一减去cache_read，更不能对所有Anthropic请求按猜测修数。保留标准计数和原始字段，没有全局启发式改写。**旧样本的字段契约未获独立证明，不能据此判定真实多扣费。**

复现工具：`node dev-harness/probe-provider-loop-cache.js --live [--stream] [--style anthropic] --report <安全报告路径>`。有界合成请求，报告只保存usage计数、协议、模型回显及耗时。它验证真实线编码/工具回放/解码；不冒充真实文件工具、完整UI或整个3.1验收。

## 首轮定向验证

- Node24下7个相关unit文件：53 PASS／0 FAIL。涵盖三协议、思考/签名、媒体编解码、会话笔记、上下文fallback及工具schema预算。
- `anthropic-fake`、`anthropic-gateway-setup`、`subagent-thinking-continuity`、`prefix-layout` 四项离线E2E通过；不支持缓存参数时仍能完成回合，非Claude兼容模型和原Chat布局不回归。
- 模块依赖、runtime optimization、manifest ranges、route inventory、facts五项静态门通过；生成依赖清册与server已更新。
- 开发过程保留事实：新用户正文断言曾暴露默认前插布局，补协议布局后通过；一次跨轮断言把缓存标记位置也当作正文比较，改为系统与正文实际内容比较后通过；登记表增加能力项后原成员锁首红，补齐三协议接口及对应断言后通过。未删除原断言覆盖的行为。
- 未执行全量unit、635项默认E2E、安装包或发布验收。本次没有更改真实服务商设置、密钥、用户对话或安装目录。

后续仍可能发生的合理缓存失效：首次接入新工具、权限/工具目录变化、历史压缩、观察蒸发、模型或思考配置改变、缓存过期。旧思考块跨用户轮移除仍沿用原签名安全策略，不为缓存命中率回放前缀不再有效的签名。

## 后续用量控制实验与独立审查

用户授权继续调查并在回归后提交推送。以完全相同的工具续调请求比较有/无断点，取得[原始控制实验](evidence/yotta-usage-native-control-20261113.json)：有断点的重复请求input=2、read=5424、write=0；去掉断点后input=5426、read=0、write=0，**两者总输入都为5426**。这是独立于归一公式的同请求对照，当前标准回包没有重复计数。

[DeepSeek经同一Anthropic兼容端点](evidence/yotta-usage-deepseek-control-20261113.json)也返回标准拆分：input=142、read=3328，总3470；去掉显式断点后依然能走后端自动缓存，但未缓存input仍为142。旧3k输入同时带3k缓存的异常在本轮没有复现；不声称掌握了网关的部署变更或真实后端身份，不为历史样本伪造结论。

独立count_tokens接口[返回401](evidence/yotta-usage-count-unavailable-20261113.json)，不当作独立计数成功。同一凭据调用messages成功；没有索取其他密钥或绕过接口权限。[另一模型别名的请求失败](evidence/yotta-usage-alias-failed-20261113.json)也保留，不混入成功样本。

真实HTTP Agent Loop使用临时独立家目录、数据根、AppData和三份合成文件，真实模型发起`file_read`，产品执行并回传，三用户轮分别核对真实工具结果和标记。父转发代理只在内存持有真实key；子进程配置只有fake key，报告只落计数/哈希及布尔验证，不含key、提示正文、回复正文或用户数据。

早期诊断器的两个首红保留：[误认tool_call事件](evidence/yotta-agent-loop-event-oracle-red-20261113.json)，产品实际事件为tool_use，随后以真实tool_use和对应成功tool_result核对；[观测器尚未结算即核账](evidence/yotta-agent-loop-observer-red-20261113.json)，账本152339是真六发合计，expected126366漏了末发25973。增加有界等待上游观测EOF结算，原通过条件不放宽。其后[三轮预验收](evidence/yotta-agent-loop-initial-qualified-20261113.json)账本152229、缓存114938与原始六发精确相等；网关报告的每发cost_usd也与标准分桶费率逐项吻合。该证据属于当时服务源码，最终A/B另记下方。

用户明确授权的独立只读agent审查发现并复核关闭两项P2：

- `tool_result.cache_control`等路径的400会先撞工具拒收归因，导致去掉工具。新增协议表`retryBeforeToolsOn400`，在确凿超窗后、工具归因前剥离明确拒收的缓存字段；递归一次强制禁止再次兼容重放，继承取消、媒体禁止重放和出站断言。新增工具保留、连续400最多两发、禁止重放、超窗优先反例。
- 非流式请求没有协议缓存字段兼容路径。默认缓存限定`stream===true`，非流式原请求形状保留；单位与HTTP E2E均增加断言。

审查未发现标准用量路径重复累计；start/delta合并后只上报一次，09每请求累加一次，每用户轮写一条账本。费用估算只有普通输入/缓存读取/输出三档，没有独立缓存写入费率；不将本次结果扩大成所有费用估算已修复。最终费用对比直接使用经算术核验的网关cost_usd。

首次完整unit门5333 tests：5295 PASS／5 FAIL／33 SKIP；五红都来自`external-bots-forge-observation`源码切片夹具漏掉新`useVolatileTail`闭包。用官方constBlock提取真实声明并补齐协议默认钩子，原五条断言全部保留并通过；该首红不抹除。最终完整门与HEAD基线A/B见后续收据。

## 最终回归与本机Sonnet费用A/B

[验证收据](evidence/anthropic-cache-validation-20261113.json)记录Node24完整unit：5335 tests／194 suites，5302 PASS／0 FAIL／33 SKIP。其所在原组合fast随后静态97 PASS／3 FAIL，保留真实RED：新增诊断器需要同步进程归属及隔离spawn计数锁（367→368、218→219），隔离声明采用扫描器可核验的完整`fixtureChildEnv()`写法；另有一份本机PS1实际为LF，按既定策略恢复CRLF，归一内容与HEAD完全相同，没有语义或Git blob变化。

修复静态/诊断器问题后，[全部100项静态单独重跑](evidence/anthropic-cache-static-final-20261113.json)100 PASS／0 FAIL，原120秒单件预算、隔离家目录和预加载守卫均保留。不是把原组合fast改写成绿；产品源码与单元测试未因这些静态修复改变。四项相关HTTP/E2E全部通过，syntax-gate1515文件0失败、生成物freshness及diff检查通过；之后诊断脚本的小调整由语法检查、静态门和真实执行再次验证。没有执行整个635默认或发布/安装包门。[独立审查收据](evidence/anthropic-cache-review-20261113.json)记录两项P2及复核关闭。

按用户要求，最后才执行真实A/B：修改前HEAD `138e8d8e0674ab11808c203adbc0a881f3c8b592` 的原始server.js与最终重建server.js，各启动独立如意服务、使用同一模型`claude-sonnet-5-5`、相同配置和三个等长合成文件任务。每边三用户轮、六次模型调用，均真实`file_read`、工具结果/标记正确、账本与回包精确一致、每发cost_usd与分桶费率核验相符。每边使用独立随机标识避免互相预热。

基线冻结的是HEAD的server.js字节；public/src/resources/config支持目录沿用当前工作区，报告明确此边界，不声称恢复了整个旧源码树。基线server SHA-256为`6bf65669ace6a688efb1ad9a6530b53e475c48457e2d3f525c9f626a7487a099`；最终server为`1159097321b9b01cb525f4c49924945b2d7d183a7715a243fcfc8c6e3464213c`。

| 计量 | 修改前HEAD | 最终代码 |
| --- | ---: | ---: |
| 总输入token（含缓存） | 152133 | 152238 |
| 普通输入token | 152133 | 18 |
| 缓存读取token | 0 | 114942 |
| 缓存写入token | 0 | 37278 |
| 输出token | 348 | 363 |
| 输入缓存读取占比（加权） | 0% | 75.50% |
| 网关报告费用USD（包含冷写和输出） | 0.307746 | 0.1083552 |

**本次配对样本的报告费用下降64.79%。** 总输入并没有下降，主要变化是普通输入转为缓存读写；普通输入的降幅不能当成费用降幅。首次缓存写入有溢价，输出也存在小幅采样差异，不能推广为所有任务的固定节省率；金额是网关`cost_usd`，不冒充账户最终账单。

原始[修改前报告](evidence/sonnet-agent-cost-before-20261113.json)、[修改后报告](evidence/sonnet-agent-cost-after-20261113.json)与[费用比较](evidence/sonnet-agent-cost-comparison-20261113.json)均保留源身份和逐发计数，不含凭据或正文。

结论：当前Yotta A带工具的标准回包和如意账本未重复计数；旧的异常格式尚未复现，不能追认其真实计费语义。因此不加入按服务商名或数值大小猜测后减去缓存的规则。实际修复的是缓存启用、稳定前缀及两处协议兼容边界，真实多轮费用收益已获得限定实测证据。

## 用户追加的OpenAI兼容端点对照

继续使用本机Yotta配置中的OpenAI兼容端点，模型仍是`claude-sonnet-5-5`。复用最终服务、相同三轮合成文件任务和配置，分别跑Chat Completions与Responses；各三用户轮、六次调用，真实读取、账本逐项一致、每发网关费用算术全部通过。新增能力只在诊断器，不修改Chat/Responses产品发送行为；各协议仍按产品已有方式映射推理参数，不能假定隐藏后端或推理状态完全相同。

| 路径 | 输入token | 输出token | 缓存读取 | 网关报告USD |
| --- | ---: | ---: | ---: | ---: |
| OpenAI兼容Chat | 152199 | 360 | 0 | 0.307998 |
| OpenAI兼容Responses | 151857 | 360 | 0 | 0.307314 |
| 最终Anthropic | 152238 | 363 | 114942 | 0.1083552 |

本次同模型、同业务任务样本中，两种OpenAI兼容路径均未报告缓存命中；修复后的Anthropic报告费用约低64.8%。历史DeepSeek/混元高缓存是不同后端/模型的既有记录，不能由OpenAI兼容的协议名称推定Sonnet也自动缓存。该结论只覆盖此次Yotta路由，不推广为OpenAI兼容协议或官方GPT模型本身不支持缓存。

完整[Chat报告](evidence/sonnet-agent-cost-chat-20261113.json)、[Responses报告](evidence/sonnet-agent-cost-responses-20261113.json)及更新后的[配对比较](evidence/sonnet-agent-cost-comparison-20261113.json)保留全部计数。复现：`node dev-harness/probe-anthropic-agent-loop.js --live --style chat --report <安全路径>`，或将style改为responses。

## 用户澄清后的DeepSeek官方原生缓存验证

用户明确要测DeepSeek这类原生OpenAI兼容服务，而不是Sonnet经Yotta兼容转换。随后使用本机`providerId=deepseek`的官方直连配置、`deepseek-flash`，分别验证Chat与Responses。保持三轮合成文件任务、各六次真实模型调用和file_read；不添加缓存参数，不修改原有OpenAI产品适配。两组真实工具结果与标记均正确，回包计数与产品账本精确一致。

| 官方直连协议 | 总输入token | 缓存读取token | 含首次冷请求的加权命中率 | 后续五发的加权命中率 |
| --- | ---: | ---: | ---: | ---: |
| Chat Completions | 99245 | 81152 | 81.77% | 97.60% |
| Responses | 99302 | 81280 | 81.85% | 97.69% |

两组第一发缓存为0；后续工具往返分别约98.7%–98.95%与98.61%–99.14%。含冷启动的三轮短样本与历史长对话98.79%的统计分母不同，不能直接按总体比例判断退化。原生自动缓存路径维持高命中；此前Sonnet/Yotta两组零缓存只是该网关/模型的结果。

诊断器增加`--provider`和`--model`以显式选择原生配置，并记录providerId。Sonnet仍严格核验网关报告费用与官方分桶算术；DeepSeek此次只核缓存与账本，不套用Sonnet价格，未返回的金额明确为null。

原始[Chat报告](evidence/deepseek-native-cache-chat-20261113.json)、[Responses报告](evidence/deepseek-native-cache-responses-20261113.json)与[逐发/加权比较](evidence/deepseek-native-cache-comparison-20261113.json)保留。复现：`node dev-harness/probe-anthropic-agent-loop.js --live --provider deepseek --model deepseek-flash --style chat --report <安全路径>`，或将style改为responses。
