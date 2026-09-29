// 04i-provider-wire.js - 58 号方案:服务商线协议登记表(批 1 chat / responses;批 2 anthropic,编解码住 04i-provider-anthropic.js)。
//
// 「模型服务商」引擎(内部引擎 id openai,runOpenAiTurn)会说几种线协议:OpenAI Chat Completions(apiStyle:'chat',缺省)
// 与 OpenAI Responses(apiStyle:'responses')。修前协议知识散在 05/06/07/08/09/10 约 47 处 `apiStyle === 'responses' ? … : …`,
// 加一种协议就要满仓找。现在协议之间的全部差异住在这张表里,调用点只问 providerWireProtocol(provider).xxx。
// 内部历史始终是 OpenAI chat 形(role/content/tool_calls/tool_call_id/reasoning_content),差异只在出站编码与入站解码两个边上。
//
// 加一种协议 = 在 PROVIDER_WIRE_PROTOCOLS 登记一项(成员齐全,unit/provider-wire-protocols.test.js 钉)+ 前端
// public/js/provider-api-styles.js 加一行(键集合与这里逐一相同,同一件单测钉)。
//
// 依赖纪律:本模块只引用 04h(零出边)。要用的 makeId(00)、redact(04-permission-runtime)、配对与参数自愈(02)
// 都在唯一大 SCC 里,直接引用会把本模块拽进环(module-dependency-graph.static 的 SCC 规模上限 32,已满)。这四样走
// ProviderWireHooks 延迟绑定,由 07-autonomy 在顶层一次填好(先例 06j SchedulerHooks、01f cliHost);单文件加载即执行,
// 早于任何一次调用。局部量一律【不叫 text】(outText / said / out):扫描器按顶层符号名认引用,00-boot 有个 text() 响应助手,
// 裸标识符 text 会凭空造出一条 04i -> 00-boot 的边、把本模块拖进 SCC(与 06i 同一个坑);对象键 text: 不算引用。
//
// 表项成员(每项冻结;函数成员一律是函数,不用 null 表示「没有这一步」):
//   id                         协议值(= provider.apiStyle,经 normalizeProviderApiStyle 归一)
//   serverWebSearch            能否把本地 web_search 映射成服务端工具(provider.serverWebSearch 只对它为 true 的协议生效)
//   endpointBase(baseUrl)      显示 / failover 粘住键用的 base
//   completionUrl(baseUrl)     补全端点;base 没配 → ''(调用方据此报「provider base URL is not set」)
//   modelsUrl(baseUrl)         模型清单端点;base 没配 → ''
//   requestHeaders(provider, { model })            出站请求头(anthropic 按模型带 beta 头;另两种协议不看 model)
//   encodeMessages({ model, messages, stream, instructions, serverItems, foldSystem })
//                              基础请求体。messages 是 chat 形历史,首条是 system;instructions 缺省取首条 system 的正文,
//                              foldSystem 再把历史里后插的 system/developer 规则折进去(Responses 没有多 system 通道);
//                              serverItems 是上一发回来的服务端工具项(Responses 的 web_search_call),原样接在历史之后
//   applyEffort(body, effort)  推理强度字段(effort 为空不写)
//   applyTemperature(body, t)  采样温度(t 为 undefined 不写;anthropic 对拒收采样参数的新 Claude 模型不写)
//   applyTools(body, tools, { serverWebSearch })   工具 + tool_choice:'auto'(工具是 chat 形,协议自己翻译)
//   outputTokensField          输出上限字段名
//   encodeQuick({ model, messages, plain })        句尾改字那种短补全:400 token、尽量关思考;plain = 去掉思考开关重打的那一发
//   decodeCompletion(payload, { requestModel })    非流式回体 → { text, reasoning, toolCalls, finishReason, incomplete, incompleteReason,
//                              failed, failedDetail, usage, responseId[, providerBlocks] }(text 未 trim)
//   createStreamDecoder({ onEvent, markUsage, requestModel })    流式事件解码器:feed(evt) → 这一帧是否终止流;
//                              finish() → { text, reasoning, finishReason, toolCalls, [httpError,] providerResponseId[, providerBlocks] }
//   normalizeUsage(usage)      用量归一到 OpenAI 口径(prompt_tokens 含缓存);chat / responses 原样
//   assistantHistoryFields(call)                   本次回复随 assistant 消息落进历史的协议字段
//   retryOn400(body, errText)  400 的协议内兼容重打:返回去掉冲突字段的新请求体,或 null(不重打;chat / responses 恒 null)
//
// encodeMessages 还收 provider(可选,anthropic 据它决定思考方式)与 hasTools(这一发随后会不会 applyTools;anthropic 不带 tools
// 的请求里不许有 tool_use / tool_result 块,要改写成文字);另两种协议两个都不看。

// 延迟绑定:{ makeId, redact, repairProviderHistoryPairing, repairProviderHistoryToolArgs },07-autonomy 顶层填充。
const ProviderWireHooks = {};

// Keep this allowlist shared by config normalization and request construction. Omission means "use the
// endpoint/model default"; selected values use the OpenAI-compatible fields for their respective APIs.
const PROVIDER_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
function providerReasoningEffort(provider) {
  const effort = String(provider && (provider.reasoningEffort || provider.reasoning_effort) || '').trim().toLowerCase();
  return PROVIDER_REASONING_EFFORTS.has(effort) ? effort : '';
}
function applyProviderReasoningEffort(body, provider, apiStyle) {
  const effort = providerReasoningEffort(provider);
  if (!effort || !body || typeof body !== 'object') return body;
  providerWireProtocol(apiStyle).applyEffort(body, effort);
  return body;
}

// v1.7 — OpenAI Responses API request shaping (DeepSeek /v1/responses, Codex/agent oriented).
// Ruyi's provider engine keeps ONE normalized chat-shaped providerHistory (roles user/assistant/tool +
// assistant.tool_calls). The Responses protocol wants `input` ITEMS instead of `messages`, so we translate
// at request time (never mutating the stored history — multi-round tool loops keep working identically):
//   user        → { type:'message', role:'user', content:[{type:'input_text', text}] }
//   assistant   → optional {type:'reasoning',content:[{type:'reasoning_text',text}]} then
//                 { type:'message', role:'assistant', content:[{type:'output_text', text}] } (+ function_call items)
//   tool        → { type:'function_call_output', call_id, output }
//   system      → folded into `instructions` (the Responses equivalent of a leading system message)
// function tools are ALSO flattened: Responses uses { type:'function', name, description, parameters }
// (chat's nested { type:'function', function:{...} } shape is NOT accepted there).
function toResponsesContent(content) {
  // String → single input_text block. Parts array (vision) → text parts + input_image parts。图片 part 在此
  // 展平成 Responses 形 { type:'input_image', image_url:'data:…' }(OpenAI Responses 官方形状;DeepSeek
  // /responses 现也接受 input_image —— 2026-09 用户确认,旧注释「Responses 无图像输入」已过时)。
  // chat 形 {type:'image_url', image_url:{url}} 与 Responses 形都认;URI 实在取不出才降级为可见占位文本
  // (绝不静默丢图)。图片是否随消息发由上游闸住:provider.vision !== true 时根本不建 image part(09-workflow)。
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
      else if (part.type === 'input_text' && typeof part.text === 'string') parts.push({ type: 'input_text', text: part.text });
      else if (part.type === 'image_url' || part.type === 'input_image') {
        const raw = typeof part.image_url === 'string' ? part.image_url
          : (part.image_url && typeof part.image_url.url === 'string') ? part.image_url.url
          : (typeof part.input_image === 'string' ? part.input_image : '');
        if (raw) parts.push({ type: 'input_image', image_url: raw });
        else parts.push({ type: 'input_text', text: '[图片输入无法解析图像 URI，已替换为占位文本]' });
      }
    }
    return parts.length ? parts : [{ type: 'input_text', text: '' }];
  }
  return [{ type: 'input_text', text: String(content || '') }];
}
// Translate a chat-shaped providerHistory into Responses `input` items (see header note).
function buildResponsesInputItems(history) {
  const items = [];
  const paired = responsesHistoryWithCompleteToolPairs(history).history;
  for (const m of paired) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') continue; // folded into instructions by the caller
    if (m.role === 'user') { items.push({ type: 'message', role: 'user', content: toResponsesContent(m.content) }); continue; }
    if (m.role === 'assistant') {
      // DeepSeek Responses is stateless and thinking mode is enabled by default. When tools are present it
      // requires every prior reasoning_text to be passed back; dropping it makes the next tool-loop request
      // fail with HTTP 400. Keep the normalized history chat-shaped, but project its reasoning_content into
      // a first-class Responses reasoning item immediately before the adjacent assistant/function_call items.
      const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
      if (reasoning) items.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoning }] });
      const said = typeof m.content === 'string' ? m.content : '';
      if (said) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: said }] });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc || tc.id == null) continue;
          items.push({ type: 'function_call', call_id: String(tc.id), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) || '' });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      if (m.tool_call_id != null) {
        items.push({ type: 'function_call_output', call_id: String(m.tool_call_id), output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '') });
      }
      continue;
    }
    items.push({ type: 'message', role: 'user', content: toResponsesContent(m.content) }); // unknown role → user
  }
  return items;
}
// Flatten chat-shaped function tools ({type:'function', function:{...}}) into Responses' flat shape.
// v1.8: Ruyi's local `web_search` function tool is MAPPED to the Responses SERVER-SIDE tool
// {type:'web_search'} (DeepSeek executes it; events web_search_call.* + output_item web_search_call) —
// but ONLY when the provider opts in via serverWebSearch:true (the DeepSeek preset ships it). This keeps
// the built-in LOCAL web_search (builtin/searxng/bing/brave/tavily/bocha/custom backends) as the FALLBACK
// for every other provider and for Responses endpoints that ignore server-side tool types (DeepSeek
// silently drops unsupported tools — an unconditional mapping would silently remove web_search there).
// DeepSeek ignores unknown builtin tool types, so only web_search is ever mapped; everything else keeps
// its historical flatten/passthrough behavior.
function toResponsesTools(tools, serverWebSearch) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const flatName = t.type === 'function' ? (t.name || (t.function && t.function.name) || '') : '';
    if (serverWebSearch === true && flatName === 'web_search') {
      out.push({ type: 'web_search' });
      continue;
    }
    if (t.type === 'function' && t.function && typeof t.function === 'object') {
      out.push({ type: 'function', name: t.function.name || '', description: t.function.description || '', parameters: t.function.parameters || { type: 'object', properties: {} } });
    } else if (t.type === 'function') {
      out.push({ type: 'function', name: t.name || '', description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } });
    } else {
      out.push(t); // web_search etc. pass through verbatim
    }
  }
  return out;
}
// Responses strict pairing adapter. A bounded history projection (summary fitting, retry/reseed, or an
// interrupted subturn) can end after an assistant function_call but before its function_call_output.
// DeepSeek Responses rejects that otherwise useful prefix with HTTP 400 "No tool output found". Reuse the
// persisted-history repair primitive on a SHALLOW ARRAY COPY: missing outputs become explicit synthetic
// results before the next message/end, while the caller's auditable history stays byte-for-byte untouched.
function responsesHistoryWithCompleteToolPairs(history) {
  const paired = Array.isArray(history) ? history.slice() : [];
  // 参数铁律自愈同址施行(见 02-session-store.js)。与配对自愈不同,它是【就地】改消息对象的
  // ——— 浅拷贝共享同一批 message,故这一改会落到调用方的历史上。这是刻意的:把 arguments 改成
  // 当时实际执行用的 '{}' 正是我们想让它【持久】的终态(与配对自愈往数组里插合成回复不同,那种
  // 改写只该活在请求体投影里,所以那条仍严格只动副本)。
  const argsRepaired = ProviderWireHooks.repairProviderHistoryToolArgs(paired);
  return { history: paired, repaired: ProviderWireHooks.repairProviderHistoryPairing(paired) + argsRepaired };
}

// ── 协议无关的小件 ─────────────────────────────────────────────────────────────────────────────────────
// 模型清单:两种 OpenAI 协议都在 {v1}/models(Responses 的补全端点不加 /v1,清单端点照旧加)。
function providerWireModelsUrl(baseUrl) {
  const base = providerBaseWithV1(baseUrl);
  return base ? base + '/models' : '';
}
// 服务商侧响应 id(21-E0 辅助关联;请求侧 modelCallId 为主键,无 id 的端点保持空串)。
function providerWireResponseIdOf(evt) {
  if (evt && evt.response && typeof evt.response.id === 'string' && evt.response.id) return evt.response.id;
  if (evt && typeof evt.id === 'string' && evt.id && evt.type !== 'response.created') return evt.id;
  return '';
}
// 流式工具调用槽 → 返回值里的 toolCalls:空名滤掉、缺 id 现补;服务端工具(web_search_call)带原始 item 以便原样回传。
function providerWireToolCallsFromSlots(slots) {
  return slots.filter(t => t.name).map(t => {
    const base = { id: t.id || ProviderWireHooks.makeId('call'), name: t.name, rawArgs: t.args || '{}' };
    if (t.serverSide) { base.serverSide = true; if (t.item) base.item = t.item; }
    return base;
  });
}
// 非流式回体里「命中输出上限」的判据(105j):Responses 的 status:'incomplete',或 chat 的 finish_reason 是 length / max_*_tokens,
// 或 incomplete_details.reason 带同义词。reasoning-only 或截断的回体不许被误报成普通的空回复。
function providerWireIncomplete(payload, statusIncomplete) {
  const finish = payload && payload.choices && payload.choices[0] && payload.choices[0].finish_reason;
  const reason = String(payload && payload.incomplete_details && payload.incomplete_details.reason || '').toLowerCase();
  return statusIncomplete || providerWireOutputLimited(finish) || /max[_-](?:output|completion)[_-]tokens|length/.test(reason);
}
// 解码器交回的 finishReason 是否表示「命中输出上限被截断」:responses / anthropic 已归一成 'length',chat 原样透传
// (多数是 length,个别端点写 max_tokens / max_output_tokens)。09 据此不执行参数被截断的工具调用、并提示回答不完整。
function providerWireOutputLimited(finishReason) {
  return /^(?:length|max[_-](?:output|completion)?[_-]?tokens)$/.test(String(finishReason || '').toLowerCase());
}
function providerWireFailureDetail(payload) {
  const e = payload && payload.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return String(e.message || e.code || e.type || 'provider error');
  return '';
}
// 流内错误(chat 的顶层 {error:{…}} 帧、finish_reason:'error';Responses 的 type:'error' 事件)→ finish() 的 httpError 文本。
// 与 04i-provider-anthropic 的 anthropicStreamErrorText 同形:还没吐出任何内容、且能认出状态码时报成 'HTTP <status>: …'
// (等价于首字节前的失败:429 走瞬时重试、400 超窗走强压重试,都不会重放已显示的内容);已经吐过内容则报成流内错误,
// 不带状态码(调用方据此不重试 —— 防重放)。数字 code / status 优先,其次认 OpenAI 系的几个字符串 code / type。
const OPENAI_STREAM_ERROR_STATUS = Object.freeze({
  rate_limit_exceeded: 429, rate_limit_error: 429, insufficient_quota: 429,
  server_error: 500, internal_error: 500, service_unavailable: 503, overloaded: 503,
  context_length_exceeded: 400, invalid_request_error: 400,
});
function providerWireStreamErrorText(err, emitted) {
  const e = err && typeof err === 'object' ? err : { message: err == null ? '' : String(err) };
  const numeric = [e.status, e.code, e.status_code].map(Number).find(n => Number.isInteger(n) && n >= 400 && n <= 599);
  const status = numeric || OPENAI_STREAM_ERROR_STATUS[String(e.code || '')] || OPENAI_STREAM_ERROR_STATUS[String(e.type || '')] || 0;
  const kind = String(e.code || e.type || 'error');
  const msg = String(e.message || '');
  const detail = kind + (msg ? ': ' + ProviderWireHooks.redact(msg.slice(0, 400)) : '');
  return !emitted && status ? 'HTTP ' + status + ': ' + detail : 'Provider stream error: ' + detail;
}
// 两种协议共用的回体外壳字段。
function providerWireDecoded(payload, core) {
  return {
    ...core,
    failed: String(payload && payload.status || '').toLowerCase() === 'failed',
    failedDetail: providerWireFailureDetail(payload),
    incompleteReason: String(payload && payload.incomplete_details && payload.incomplete_details.reason
      || (payload && payload.choices && payload.choices[0] && payload.choices[0].finish_reason) || 'output limit'),
    usage: (payload && payload.usage) || null,
    responseId: (payload && (payload.id || (payload.response && payload.response.id))) || '',
  };
}

// ── chat(OpenAI Chat Completions)──────────────────────────────────────────────────────────────────────
// 非流式取字(58 号批 1 统一 06/05/07/10 四份的口径):content 是字符串,或 OpenAI 多模态形的 parts 数组(拼各 part 的 text)。
function chatCompletionText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map(part => part && typeof part.text === 'string' ? part.text : '').join('');
  return '';
}
function decodeChatCompletion(j) {
  const ch = j && j.choices && j.choices[0];
  const msg = ch && ch.message;
  // E6:推理链两种拼法都认(reasoning_content / reasoning)。
  const reasoning = (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content) || (msg && typeof msg.reasoning === 'string' && msg.reasoning) || '';
  const toolCalls = Array.isArray(msg && msg.tool_calls)
    ? msg.tool_calls.map(tc => ({ id: tc.id || ProviderWireHooks.makeId('call'), name: tc.function && tc.function.name, rawArgs: (tc.function && tc.function.arguments) || '{}' })).filter(t => t.name)
    : [];
  return providerWireDecoded(j, { text: chatCompletionText(msg), reasoning, toolCalls, finishReason: ch && ch.finish_reason, incomplete: providerWireIncomplete(j, false) });
}
// chat 流式:choices[0].delta 的 content / reasoning_content(或 reasoning)/ tool_calls 分片;终止靠分帧层的 [DONE]。
function createChatStreamDecoder({ onEvent, markUsage }) {
  let outText = '', reasoning = '', finishReason = null, providerResponseId = '', streamError = '', emitted = false;
  // 用量:有的服务商在【每一帧】都带累计 usage(不止 include_usage 的末帧)。逐帧 markUsage 会把同一次调用记好几遍
  // (调用方按次累加 input/output),所以只记最后一份、在 finish() 里报一次。
  let lastUsage = null;
  // E1: accumulate streamed tool_calls into SLOTS keyed primarily by tool_call id. A delta carrying a
  // non-empty id opens (or re-selects) that call's slot; a delta with only an index selects/creates the slot
  // for that index; a delta with neither keeps writing to the CURRENT slot. This "non-empty id => open/select
  // a slot, otherwise keep writing the current slot" state machine keeps multiple PARALLEL tool_calls
  // independent even when the provider omits `index` on the delta fragments (some vLLM/Ollama/self-hosted
  // endpoints do). The old code forced every index-less delta into acc[0], splicing distinct calls' names
  // ("file_readfile_write") and arguments into one corrupt, unparseable blob.
  const slots = []; // { id, index, name, args } in first-seen order
  let curSlot = null;
  const selectSlot = tc => {
    // Priority 1: an explicit, non-empty id is the authoritative call identity -> find-or-create by id
    // (idempotent whether the provider sends the id once at the start or repeats it on every fragment).
    if (typeof tc.id === 'string' && tc.id) {
      let s = slots.find(x => x.id === tc.id);
      if (!s) {
        // Adopt a slot previously opened for this same index that has not yet been assigned an id.
        if (tc.index != null) s = slots.find(x => !x.id && x.index === tc.index);
        if (s) s.id = tc.id;
        else { s = { id: tc.id, index: (tc.index != null ? tc.index : null), name: '', args: '' }; slots.push(s); }
      }
      curSlot = s; return s;
    }
    // Priority 2: no id but an explicit index -> find-or-create by index (the standard OpenAI shape where
    // continuation fragments carry only the index). 同一个 index 可能先后开过几个槽(Gemini 兼容端点给每个并行调用
    // 都发 index:0、各带不同 id):只带 index 的续片属于【最近开的】那个槽,不是第一个。
    if (tc.index != null) {
      let s = slots.findLast(x => x.index === tc.index);
      if (!s) { s = { id: '', index: tc.index, name: '', args: '' }; slots.push(s); }
      curSlot = s; return s;
    }
    // Priority 3: neither id nor index -> keep writing to the current slot (open a first default slot if this
    // is the very first fragment).
    if (!curSlot) { curSlot = { id: '', index: null, name: '', args: '' }; slots.push(curSlot); }
    return curSlot;
  };
  return {
    feed(evt) {
      if (!providerResponseId) providerResponseId = providerWireResponseIdOf(evt);
      if (evt.usage) lastUsage = evt.usage;
      // 流内错误帧(上游中途失败时网关/代理常这样收尾,有的还跟一个 [DONE]):终止流,交给调用方的 httpError 路径。
      // 修前它被当成普通帧忽略,半截回答被当作成功落盘。
      if (evt.error && !evt.choices) { streamError = providerWireStreamErrorText(evt.error, emitted); return true; }
      const ch = evt.choices && evt.choices[0];
      if (!ch) return false;
      if (ch.finish_reason) finishReason = ch.finish_reason;
      const delta = ch.delta;
      if (delta) {
        const reason = (typeof delta.reasoning_content === 'string' && delta.reasoning_content) || (typeof delta.reasoning === 'string' && delta.reasoning) || '';
        if (reason) { reasoning += reason; onEvent({ type: 'thinking_delta', text: reason }); }
        if (typeof delta.content === 'string' && delta.content) { outText += delta.content; emitted = true; onEvent({ type: 'assistant_delta', text: delta.content }); }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const slot = selectSlot(tc);
            emitted = true;
            // 有的端点每一片都重复完整的 function.name:与已拼出的名字相同就不再追加(否则成了 file_readfile_read);
            // 真正分片的名字('file_' + 'read')每片不同,照旧拼接。
            if (tc.function) { if (tc.function.name && tc.function.name !== slot.name) slot.name += tc.function.name; if (typeof tc.function.arguments === 'string') slot.args += tc.function.arguments; }
          }
        }
      }
      // finish_reason:'error'(vLLM 等在生成中途出错时这样收尾):同样是失败,不是一个正常结束的回答。
      if (String(ch.finish_reason || '').toLowerCase() === 'error' && !streamError) {
        streamError = providerWireStreamErrorText({ type: 'error', message: 'finish_reason=error' }, emitted);
      }
      return false;
    },
    finish() {
      if (lastUsage) { markUsage(lastUsage); lastUsage = null; }
      const out = { text: outText, reasoning, finishReason: streamError ? 'error' : finishReason, toolCalls: providerWireToolCallsFromSlots(slots), providerResponseId };
      if (streamError) out.httpError = streamError;
      return out;
    },
  };
}

// ── responses(OpenAI Responses API,DeepSeek /responses)───────────────────────────────────────────────
// Instructions:显式给的优先;否则取首条 system 的正文;foldSystem 时再把历史里后插的 system/developer 规则(非空、与首条不同)
// 以空行接上 —— Responses 没有 chat 的多 system-message 通道,不折就会被 buildResponsesInputItems 丢掉(06 起草/JSON 修复/
// 记忆审稿人的严格协议就在后插的 system 里)。
function responsesInstructions(messages, foldSystem) {
  const list = Array.isArray(messages) ? messages : [];
  const lead = list[0] && (list[0].role === 'system' || list[0].role === 'developer') ? String(list[0].content || '') : '';
  if (!foldSystem) return lead;
  const extras = list.slice(1)
    .filter(m => m && (m.role === 'system' || m.role === 'developer') && String(m.content || '').trim())
    .map(m => String(m.content).trim())
    .filter(rule => rule !== lead);
  return [lead, ...extras].join('\n\n');
}
function responsesOutputText(payload) {
  let out = '';
  for (const item of (Array.isArray(payload && payload.output) ? payload.output : [])) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && (part.type === 'output_text' || part.type === 'input_text') && typeof part.text === 'string') out += part.text;
    }
  }
  return out;
}
// v1.7 (Responses API): a non-streamed response body is a `response` object with an `output` item list
// (message / function_call / reasoning…), NOT chat's {choices:[{message}]}.
function decodeResponsesCompletion(j) {
  const out = Array.isArray(j && j.output) ? j.output : [];
  let reasoning = '';
  const toolCalls = [];
  for (const item of out) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id || ProviderWireHooks.makeId('call'), name: item.name, rawArgs: (typeof item.arguments === 'string' && item.arguments) ? item.arguments : '{}' });
      continue;
    }
    if (item.type === 'reasoning') {
      for (const part of (Array.isArray(item.content) ? item.content : [])) { if (part && part.type === 'reasoning_text' && typeof part.text === 'string') reasoning += part.text; }
    }
  }
  const status = j && j.status;
  return providerWireDecoded(j, {
    text: responsesOutputText(j), reasoning, toolCalls: toolCalls.filter(t => t.name),
    finishReason: status === 'incomplete' ? 'length' : (status === 'failed' ? 'error' : 'stop'),
    incomplete: providerWireIncomplete(j, String(status || '').toLowerCase() === 'incomplete'),
  });
}
// ── OpenAI Responses API stream (DeepSeek /v1/responses) ────────────────────────────────────────
// Events: response.created | response.in_progress | response.output_item.added/done |
// response.content_part.added/done | response.reasoning_text.delta/done | response.output_text.delta/done |
// response.function_call_arguments.delta/done | response.completed | response.incomplete | response.failed.
// No `data: [DONE]` — the stream ends on response.completed/incomplete/failed.
function createResponsesStreamDecoder({ onEvent, markUsage }) {
  let outText = '', reasoning = '', finishReason = null, providerResponseId = '', responsesFailedError = '', emitted = false;
  // 用量只记最后一份、finish() 报一次(同 chat:中途事件自带的 usage 与终止事件的 usage 是同一次调用的累计值,
  // 逐个 markUsage 会重复计费);incomplete / failed 的回体也带 usage,照样要记(截断的那一发同样花了钱)。
  let lastUsage = null;
  const slots = [];
  let curSlot = null;
  // function_call 的参数有的端点只在 .done 事件里给全量(不发 delta):按 item_id / call_id 找槽,槽里还没有参数才补。
  const slotForItem = (itemId, callId) => (itemId && slots.find(x => x.itemId === itemId)) || (callId && slots.find(x => x.id === callId)) || null;
  return {
    feed(evt) {
      if (!providerResponseId) providerResponseId = providerWireResponseIdOf(evt);
      if (evt && evt.usage) lastUsage = evt.usage; // some events carry usage directly
      const t = evt && evt.type;
      if (t === 'response.output_item.added' && evt.item && evt.item.type === 'function_call') {
        // A function_call output item opens/selects its slot (call_id + name), arguments stream separately.
        // 对抗轮(P1-2):以 call_id 为主键选槽 —— 并行 function_call 是常态(官方文档 parallel_tool_calls 忽略
        // = 始终开启),delta 事件自带 item_id,必须按 item_id 路由参数,不能依赖"最后 added 的槽"(交错事件序会错配)。
        const fc = evt.item;
        const id = fc.call_id || ProviderWireHooks.makeId('call');
        let s = slots.find(x => x.id === id);
        if (!s) { s = { id, index: null, name: fc.name || '', args: '', itemId: evt.item && evt.item.id || '' }; slots.push(s); }
        else if (fc.name) s.name += fc.name;
        curSlot = s;
        return false;
      }
      // v1.8: a web_search_call output item is a SERVER-SIDE tool invocation (DeepSeek /responses executes
      // the search itself). Surface it as a toolCall named 'web_search' with serverSide:true so the tool
      // loop knows NOT to execute it locally; the raw item is carried back to the next request's `input`
      // (DeepSeek restores the search results server-side). status/output arrive on the .done event.
      if (t === 'response.output_item.added' && evt.item && evt.item.type === 'web_search_call') {
        const ws = evt.item;
        const id = ws.id || ProviderWireHooks.makeId('call');
        let s = slots.find(x => x.id === id);
        if (!s) { s = { id, index: null, name: 'web_search', args: '', itemId: id, serverSide: true, item: ws }; slots.push(s); }
        curSlot = s;
        return false;
      }
      if (t === 'response.output_item.done' && evt.item && evt.item.type === 'web_search_call') {
        const ws = evt.item;
        const id = ws.id || '';
        let s = id ? slots.find(x => x.id === id) : curSlot;
        if (s) {
          s.item = ws; // keep the FULL item so it can be echoed back verbatim (server restores the results)
          // v1.8.1: DeepSeek's web_search_call carries the query under `action` (NOT the OpenAI-doc shape
          // `output.query`/`output.search_terms` — the real item has NO `output` field at all):
          //   { type:'web_search_call', id, status, action:{ type:'search', queries:[...] } }
          //   { type:'web_search_call', id, status, action:{ type:'open_page', url } }
          // Parse both so the UI shows the REAL search terms / opened URL instead of an empty placeholder.
          const action = ws.action && typeof ws.action === 'object' ? ws.action : null;
          let q = '';
          if (action) {
            if (Array.isArray(action.queries)) q = action.queries.filter(Boolean).join(' | ');
            else if (typeof action.url === 'string') q = action.url;
          }
          s.args = JSON.stringify({ status: ws.status || '', actionType: (action && action.type) || '', query: q });
        }
        return false;
      }
      if (t === 'response.function_call_arguments.delta' && typeof evt.delta === 'string' && evt.delta) {
        // 对抗轮(P1-2):优先按事件的 item_id 精确定位槽(并行时 arguments delta 按 item_id 路由,绝不串写);
        // item_id 缺失/未命中才回退到"最近 added 的槽"(串行单调用场景,与旧行为一致)。
        let target = null;
        const itemId = evt && evt.item_id;
        if (typeof itemId === 'string' && itemId) target = slots.find(x => x.itemId === itemId);
        if (!target) target = curSlot;
        if (!target) { target = { id: ProviderWireHooks.makeId('call'), index: null, name: '', args: '', itemId: '' }; slots.push(target); }
        target.args += evt.delta;
        emitted = true;
        curSlot = target;
        return false;
      }
      if (t === 'response.function_call_arguments.done' && typeof evt.arguments === 'string') {
        const target = slotForItem(evt.item_id, '') || curSlot;
        if (target && !target.args && !target.serverSide) { target.args = evt.arguments; emitted = true; }
        return false;
      }
      if (t === 'response.output_item.done' && evt.item && evt.item.type === 'function_call') {
        const fc = evt.item;
        let s = slotForItem(fc.id, fc.call_id);
        // 只发 .done 不发 .added 的端点:在这里开槽(与 added 同形)。
        if (!s) { s = { id: fc.call_id || ProviderWireHooks.makeId('call'), index: null, name: '', args: '', itemId: fc.id || '' }; slots.push(s); }
        if (!s.name && fc.name) s.name = fc.name;
        if (!s.args && typeof fc.arguments === 'string' && fc.arguments) { s.args = fc.arguments; emitted = true; }
        return false;
      }
      if (t === 'response.reasoning_text.delta' && typeof evt.delta === 'string' && evt.delta) {
        reasoning += evt.delta; onEvent({ type: 'thinking_delta', text: evt.delta }); return false;
      }
      if (t === 'response.output_text.delta' && typeof evt.delta === 'string' && evt.delta) {
        outText += evt.delta; emitted = true; onEvent({ type: 'assistant_delta', text: evt.delta }); return false;
      }
      if (t === 'response.completed') {
        // Final event: the full response object (with usage) rides on the event.
        if (evt.response && evt.response.usage) lastUsage = evt.response.usage;
        finishReason = 'stop';
        return true;
      }
      if (t === 'response.incomplete') { // truncated (e.g. max_output_tokens)
        if (evt.response && evt.response.usage) lastUsage = evt.response.usage;
        finishReason = 'length';
        return true;
      }
      // 流内 error 事件({type:'error', code, message}):终止流并走 httpError(修前被当作未知事件忽略,半截回答被当作成功)。
      if (t === 'error') {
        responsesFailedError = providerWireStreamErrorText(evt.error && typeof evt.error === 'object' ? evt.error : evt, emitted);
        finishReason = 'error';
        return true;
      }
      if (t === 'response.failed') {
        if (evt.response && evt.response.usage) lastUsage = evt.response.usage;
        // Terminal failure — surface the error detail to the caller's existing httpError path.
        // 对抗轮(P1-3/P2-1/P2-3):
        //  • 无 error 详情也置错误(否则 finishReason 无人消费 → 静默空转,见 P2-1);
        //  • 文本过 redact() 防恶意服务商在 error 里回显密钥(P2-3);
        //  • 错误含 context/length 语义时置 contextOverflow,让 45b 强压重试能识别(P1-3)。
        const err = evt.response && (evt.response.error || evt.response.last_error);
        const em = (err && (err.message || err.code)) || (err && typeof err === 'object' ? JSON.stringify(err) : String(err || ''));
        responsesFailedError = 'Responses failed' + (em ? ': ' + ProviderWireHooks.redact(String(em).slice(0, 400)) : ' (no error detail)');
        if (/context|length|token/i.test(responsesFailedError)) responsesFailedError = 'HTTP 400: ' + responsesFailedError;
        finishReason = 'error';
        return true;
      }
      return false; // created / in_progress / content_part.* / output_item.done / reasoning_text.done / output_text.done / … — non-terminal
    },
    finish() {
      if (lastUsage) { markUsage(lastUsage); lastUsage = null; }
      // v1.8: serverSide toolCalls (web_search_call items) carry the raw item so the tool loop can echo it
      // back into the next request's `input` without executing anything locally.
      const toolCalls = providerWireToolCallsFromSlots(slots);
      // v1.7 (Responses): a `response.failed` terminal event is a protocol-level failure with no HTTP error
      // status — surface it through the caller's existing httpError path so attribution/retry behaves uniformly.
      if (responsesFailedError) return { text: outText, reasoning, finishReason, toolCalls, httpError: responsesFailedError, providerResponseId };
      return { text: outText, reasoning, finishReason, toolCalls, providerResponseId };
    },
  };
}

// ── 登记表 ────────────────────────────────────────────────────────────────────────────────────────────
const reasoningContentField = call => (call && call.reasoning ? { reasoning_content: call.reasoning } : {});
const noRetryOn400 = () => null;
const setTemperature = (body, temperature) => { if (temperature !== undefined) body.temperature = temperature; return body; };
const PROVIDER_WIRE_DEFAULT = 'chat';
const PROVIDER_WIRE_PROTOCOLS = Object.freeze({
  chat: Object.freeze({
    id: 'chat',
    serverWebSearch: false,
    endpointBase: baseUrl => providerApiBase(baseUrl, false),
    completionUrl: baseUrl => providerCompletionUrl(baseUrl, false),
    modelsUrl: providerWireModelsUrl,
    requestHeaders: provider => providerRequestHeaders(provider),
    encodeMessages: ({ model, messages, stream }) => (stream
      ? { model, messages, stream, stream_options: { include_usage: true } }
      : { model, messages, stream }),
    applyEffort: (body, effort) => { if (effort) body.reasoning_effort = effort; return body; },
    applyTemperature: setTemperature,
    applyTools: (body, tools) => { body.tools = tools; body.tool_choice = 'auto'; return body; },
    outputTokensField: 'max_tokens',
    // flash 系模型缺省思考,400 token 的预算会被隐藏推理吃光、正文为空(52 号文 §3 实测),所以显式关思考;端点不认这两个字段回 400 时
    // 调用方以 plain:true 去掉重打一次。
    encodeQuick: ({ model, messages, plain }) => ({ model, messages, stream: false, temperature: 0, max_tokens: 400, ...(plain ? {} : { thinking: { type: 'disabled' }, enable_thinking: false }) }),
    decodeCompletion: decodeChatCompletion,
    createStreamDecoder: createChatStreamDecoder,
    normalizeUsage: usage => usage,
    assistantHistoryFields: reasoningContentField,
    retryOn400: noRetryOn400,
  }),
  responses: Object.freeze({
    id: 'responses',
    serverWebSearch: true,
    // 对抗轮(open-risk):responses 走原样 baseUrl + /responses(不加 /v1,与官方 SDK 示例一致),见 04h providerResponsesBase。
    endpointBase: baseUrl => providerApiBase(baseUrl, true),
    completionUrl: baseUrl => providerCompletionUrl(baseUrl, true),
    modelsUrl: providerWireModelsUrl,
    requestHeaders: provider => providerRequestHeaders(provider),
    encodeMessages: ({ model, messages, stream, instructions, serverItems, foldSystem }) => ({
      model,
      instructions: typeof instructions === 'string' ? instructions : responsesInstructions(messages, foldSystem === true),
      // v1.8: server-side tool items (web_search_call) are appended to `input` AFTER the translated history —
      // DeepSeek restores the search results server-side and the model continues on the next call.
      input: [...buildResponsesInputItems(messages), ...(Array.isArray(serverItems) ? serverItems : [])],
      stream,
    }),
    applyEffort: (body, effort) => { if (effort) body.reasoning = { effort }; return body; },
    applyTemperature: setTemperature,
    // v1.8.2: server-side web_search mapping only when the provider opts in (serverWebSearch:true) —
    // otherwise web_search stays a LOCAL function tool (builtin backend fallback, works on any provider).
    applyTools: (body, tools, opts) => { body.tools = toResponsesTools(tools, opts && opts.serverWebSearch === true); body.tool_choice = 'auto'; return body; },
    outputTokensField: 'max_output_tokens',
    encodeQuick: ({ model, messages, plain }) => {
      const list = Array.isArray(messages) ? messages : [];
      const system = list.filter(m => m && m.role === 'system').map(m => m.content).join('\n\n');
      const user = list.filter(m => m && m.role === 'user').map(m => m.content).join('\n');
      return { model, instructions: system, input: user, stream: false, max_output_tokens: 400, ...(plain ? {} : { reasoning: { effort: 'minimal' } }) };
    },
    decodeCompletion: decodeResponsesCompletion,
    createStreamDecoder: createResponsesStreamDecoder,
    normalizeUsage: usage => usage,
    assistantHistoryFields: reasoningContentField,
    retryOn400: noRetryOn400,
  }),
  // 批 2:Anthropic Messages(官方与兼容网关)。编解码见 04i-provider-anthropic.js;这里只接线:配对自愈、makeId / redact 钩子。
  anthropic: Object.freeze({
    id: 'anthropic',
    serverWebSearch: false, // 批 3 映射 web_search_20260209
    endpointBase: baseUrl => providerBaseWithV1(baseUrl),
    completionUrl: anthropicMessagesUrl,
    modelsUrl: providerWireModelsUrl,
    requestHeaders: anthropicRequestHeaders,
    encodeMessages: ({ model, messages, stream, instructions, provider, hasTools }) => encodeAnthropicMessages({
      model, stream, instructions, provider, hasTools,
      // 与 Responses 同一个配对自愈:tool_use 必须紧跟 tool_result,缺了补合成结果(只改副本)。
      messages: responsesHistoryWithCompleteToolPairs(messages).history,
    }),
    applyEffort: applyAnthropicEffort,
    applyTemperature: applyAnthropicTemperature,
    applyTools: applyAnthropicTools,
    outputTokensField: 'max_tokens',
    encodeQuick: encodeAnthropicQuick,
    decodeCompletion: (payload, opts) => decodeAnthropicCompletion(payload, { requestModel: opts && opts.requestModel, newId: ProviderWireHooks.makeId }),
    createStreamDecoder: opts => createAnthropicStreamDecoder({ ...opts, newId: ProviderWireHooks.makeId, scrub: ProviderWireHooks.redact }),
    normalizeUsage: normalizeAnthropicUsage,
    // thinking 的文字照旧进 reasoning_content(界面、摘要都认它);带签名的内容块原样进 providerBlocks,供同一段工具循环里回放。
    assistantHistoryFields: call => ({ ...reasoningContentField(call), ...(call && call.providerBlocks ? { providerBlocks: call.providerBlocks } : {}) }),
    retryOn400: anthropicRetryBodyOn400,
  }),
});
// 唯一的协议值归一:登记过的键原样,其余(缺失、空串、大小写不对、原型链名字、非字符串)一律当缺省 chat ——
// 与修前各处的 `x === 'responses' ? 'responses' : 'chat'` 输出逐项相同,只是口径现在由登记表给。
function normalizeProviderApiStyle(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_WIRE_PROTOCOLS, value) ? value : PROVIDER_WIRE_DEFAULT;
}
// 按服务商(对象,读 .apiStyle)或协议值(字符串)取表项。
function providerWireProtocol(providerOrStyle) {
  const style = providerOrStyle && typeof providerOrStyle === 'object' ? providerOrStyle.apiStyle : providerOrStyle;
  return PROVIDER_WIRE_PROTOCOLS[normalizeProviderApiStyle(style)];
}
// 调用方没说协议时按请求体形状认(Responses 用 input 项,chat 用 messages)—— 只给没传 protocol 的老调用点兜底。
// anthropic 的请求体也用 messages,认不出来;所有调用点都显式传 protocol,这里只是老接口的兜底。
function providerWireProtocolForBody(body) {
  return PROVIDER_WIRE_PROTOCOLS[body && Array.isArray(body.input) ? 'responses' : 'chat'];
}
