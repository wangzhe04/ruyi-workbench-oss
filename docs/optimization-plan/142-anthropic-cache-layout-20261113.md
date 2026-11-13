# 142 · Anthropic Messages 前缀布局优化（2026-11-13）

接续[141号缓存与用量调查](141-anthropic-prompt-cache-20261113.md)，基线为已推送的 `5322a14b`。本批继续优化跨用户回合的缓存，不改变用量归一公式。仅修改源码及生成的server，没有替换安装版或打包；版本仍为3.0.1、3.1未发布，140号记录的整体回归缺口继续保留。

## 结论与根因

相同的三轮、每轮一次真实 `file_read` 加一次结果续调，141号修复后Sonnet的热请求加权命中率约90.2%，DeepSeek官方Chat约97.6%。排除首个冷请求之后再比较，差距依然存在。

工具续调本已接近99%；主要损失发生在下一条用户消息。整包 `turnVolatile` 原先从上一条user移到新user，尽管内容大部分未变，旧消息的前缀仍被改写。基线每次新用户回合重写约5,837个缓存token，system和tools指纹均未变。仅拆固定指南和项目/技能/Playbook引用的初版升到约93.8%；继续拆开角色、工作流、模型目录与固定并行规则后，三轮样本热命中达到约97.6%。未增加重复文本来稀释未命中比例。

## 协议规律与工程选择

- Anthropic缓存按tools、system、messages的前缀匹配；断点是写入/读取边界，不能修复它之前的改动。最多四个断点，回看范围有限，故优先稳定布局，再选边界。5分钟TTL继续沿用，未增加更贵的1小时写入。[官方缓存说明](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- thinking签名可能绑定此前的指令、工具和消息；改动引用前缀时必须先停用相应回放，不能只等待400重试。当前实现保守地停用本用户回合余下的thinking回放，保留文本、tool_use和配对结果。[官方preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- 官方cache diagnostics可定位前缀首次差异，但兼容网关未必支持。本批诊断只记录块长度、哈希、类型和数值用量，没有向网关默认添加diagnostics字段。[官方诊断说明](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics)

Chat、Responses、Messages仍共用同一个内部Agent Loop。Chat用assistant.tool_calls和role=tool；Responses用function_call/function_call_output；Messages用assistant.tool_use与下一条user.tool_result。DeepSeek一类后端自动维护公共前缀缓存；Messages在显式缓存之外还需要维护内容块边界和thinking回放。协议名不保证某个网关后端具备何种缓存能力，不能把Yotta转发的Claude测试泛化为全部OpenAI兼容服务。

## 最终布局与新鲜度边界

`buildVolatileParts`保留原完整字符串顺序，增加仅供Claude流式主回合使用的类型分层：

| 内容 | 放置 | 刷新与安全约束 |
| --- | --- | --- |
| 身份、工具协议及提供商系统提示 | 原system | 原有生成方式 |
| 宿主固定指南、固定并行规则 | 附加system text块 | 不含项目、技能、角色、工作流或模型作者内容 |
| 项目说明、已启用技能、Playbook、角色/工作流/模型目录 | 首条user中的独立reference块 | 每逻辑迭代重读当前来源和配置，保留原围栏与中和，新增外层围栏也中和同名伪造标签；明确不是新请求、授权或执行证据 |
| 能力、权限、额度、默认路由、核心/相关记忆、mission、plan与任务策略 | 当前user尾部 | 沿用状态与撤销处理，不为缓存保存旧快照 |
| recall、notes、scratchpad、临时受保护媒体 | 原尾部通道 | 原权限、取消、一次性媒体与压缩契约继续生效 |

reference只改请求副本，不写providerHistory，也不改原用户正文。引用改变会正常使后续前缀缓存失效，不能为追求命中保留被撤销资料。模型目录从当前配置按原provider.id重新取对象；端点消失则不再注入其模型目录，实际执行路由身份不随目录刷新而变化。技能在异步捕获结束和构建请求时复查会话选择，期间撤销只会清空并缩小请求。

每个逻辑迭代在压缩、估算和预算门之前捕获一个generation；媒体预览、最终发送和传输重试共享它。预算门之后不再现场刷新成更大的正文，后续来源更新进入下一个逻辑迭代。不能宣称每次HTTP重试都重新读取全部来源。

四个断点依次覆盖基础system、reference末尾、最新真实用户正文末尾、请求末尾；重合对象去重。多模态用户边界显式捕获，reference不会占用原文定位。URL图片不附加cache_control，以保持受保护图片引用要求的精确字段形状；缓存周围的文本/工具结果，base64图片仍可作为边界。

非Claude兼容模型、非流式摘要、Chat/Responses和管家自定义提示保持原路径。完整构造器与基线函数在32种组合、64项字节级比较中一致，见[兼容比较](evidence/anthropic-cache-layers-legacy-20261113.json)。

## 真实测量

所有任务使用独立临时家目录与合成工作区。凭据仅在父进程代理内存中，子进程配置只有假key。每轮必须成功调用真实file_read、得到对应标记并正确回答；原始请求用量与逐回合账本精确对账。每组system带随机标识，避免借用其他组预热。命中率用 `sum(cache_read)/sum(total_input)`，热请求统一排除首个冷请求。

| 三轮/六发 | 基线5322 | 最终分层 | 141号DeepSeek官方Chat |
| --- | ---: | ---: | ---: |
| 输入token | 152,175 | 152,490 | 99,245 |
| 缓存读token | 114,903 | 124,502 | 81,152 |
| 含冷请求命中率 | 75.51% | 81.65% | 81.77% |
| 热请求命中率 | 90.21% | 97.55% | 97.60% |
| Sonnet网关报告USD | 0.1082013 | 0.0860112 | 未提供，不假定价格 |

最终三轮总费用下降20.51%，跨用户回合缓存写入由5,837降至1,169 token。与141号尚未开启缓存的更早基线不同，不能把两轮优化的下降百分比直接相加。网关报告费用逐桶复算通过，但未把该报告等同供应商最终账单。不同模型的token分词与价格不相同，DeepSeek列只作同任务缓存比例参考。

候选阶段原始记录：[before](evidence/sonnet-cache-layers-before-20261113.json)、[初版仅部分分层](evidence/sonnet-cache-layers-first-20261113.json)、[分层候选三轮](evidence/sonnet-cache-layers-after-20261113.json)、[adaptive候选六轮](evidence/sonnet-cache-layers-thinking-20261113.json)。每个报告记录独立server SHA；候选证据不得冒充之后修订源码的最终资格。adaptive六轮12发热命中97.41%，但网关未返回thinking块，故只证明adaptive配置的真实调用与缓存，签名回放仍须由离线有签名反例验证。

复现：`node dev-harness/probe-anthropic-agent-loop.js --live --report <path>`；基线加`--baseline-head`（只冻结HEAD的server，辅助资源仍共享工作树）；长样本加`--turns 6 --thinking adaptive`，可用`--effort high`显式指定强度。默认不带live只打印SKIP。

最终源码SHA `428428f390124cacd363884f0a8d86cd527738488d674007ee7d9b318ba0ca0d` 的[三轮复测](evidence/sonnet-cache-layers-final-20261113.json)与[六轮adaptive/high](evidence/sonnet-cache-layers-high-final-20261113.json)均通过，原始计数与账本精确一致。六轮共312,912输入token、280,574缓存读token，含冷命中89.67%、热命中97.40%，费用0.1162044 USD。实际发出adaptive和high，但仍未返回thinking块，继续保留真实签名回放未验的限制。[统一计算比较](evidence/anthropic-cache-layers-comparison-20261113.json)。

探针旧版误把字符串`low`写进布尔`reasoning`，没有设置有效的reasoningEffort。上述基线和候选均未实际指定强度，A/B口径一致；新版使用正确字段并记录实际出站effort与返回thinking块计数，不把旧值追认为低强度验收。

## 验证与限制

定向单测包含类型分层、四断点、多模态原文边界、伪造围栏、非Anthropic字节行为、思考签名预失效、模型目录撤销、异步技能撤销、预算generation一致和真实三协议受保护图片交付。Anthropic假端点E2E补了同一工具循环的项目A→B→删除、模型A→B→撤销，验证立即清除引用、保留工具配对且没有400补救重试，也不持久化引用。

验证首红如实保留：旧source-slice夹具缺少新闭包变量；新mission夹具缺少里程碑；模型目录夹具缺少已有offlineModelList入口seed；真实URL图片严格形状测试揭示了cache_control兼容缺陷并已修正。最终检查结果与独立只读审查记录见本批validation证据。未执行全642件E2E或安装包/GUI验收，不替代3.1整体收口。

完整fast首轮unit为5,306 PASS／0 FAIL／33 SKIP；static为99 PASS／1 FAIL，失败是prompt-snapshot的D9/D10b仍锁旧预算初始化表达式。更新为执行生产renderPromptLayers，同时验证旧路径精确预算和分层路径全部规则/引用后，100 static另行串行复验全绿。该次完整fast仍记为RED，不用分步绿覆盖。[首红记录](evidence/anthropic-cache-layers-fast-first-red-20261113.json)、[最终static](evidence/anthropic-cache-layers-static-final-20261113.json)、[独立只读审查](evidence/anthropic-cache-layers-review-20261113.json)。

最终定向单测36/36、相关E2E七件7/7通过；完整unit及分步100 static、原RED、独审和实测身份汇总见[validation](evidence/anthropic-cache-layers-validation-20261113.json)。本批无运行时npm依赖增加。
