// 04i-provider-anthropic.js - 58 号方案批 2:Anthropic Messages 线协议的编解码(apiStyle:'anthropic')。
//
// 两类端点共用这一份:Anthropic 官方(https://api.anthropic.com)与国产 / 内网的 Anthropic 兼容网关(形如 https://<host>/anthropic)。
// 端点一律是 {providerBaseWithV1(base)}/messages,与 Claude CLI 的 ANTHROPIC_BASE_URL 口径一致。
// 内部历史仍是 OpenAI chat 形;这里只做两个边:chat 形历史 → Messages 请求体,Messages 回体 / 事件流 → 与另两种协议同形的解码结果。
// 登记表的胶水在 04i-provider-wire.js(本模块排在它前面,只提供纯函数;要用的 makeId / redact / 配对自愈由调用方经参数注入,
// 本模块不引用 04h 以外的任何顶层符号,进不了依赖环)。局部量同样不叫 text(见 04i-provider-wire.js 头注)。
//
// 思考块与签名(本协议改动面最大的一块):
//   - 解码时把本次回复的内容块按原顺序收进 providerBlocks({ protocol:'anthropic', model, requestModel, blocks }),只在回复里真有
//     thinking / redacted_thinking 块时才带;thinking 的文字照旧进 reasoning 供界面显示。
//   - 编码时只回放「最后一条 user 消息之后」那一段 assistant 的 providerBlocks,且协议与模型都对得上、tool_use 的 id 与历史里的
//     tool_calls 一一对应时才原样回放;更早的一律只发文本与 tool_use。理由:最新模型会校验思考块产生时的前缀没被改过,
//     而如意每次请求都会在最后一条 user 上追加非持久的提示(易变层尾部布局、recall、session notes),新 user 消息一来,
//     上一条 user 的追加就没了 —— 它之后的思考块必然失效。只丢「从最早开始的一段」思考块是 API 明文允许的(leading run),
//     保留的那段的前缀在同一回合里是稳定的。
//   - 真碰上签名校验 400(工具循环中途被 L1 蒸发等改了前缀),retryOn400 去掉全部思考块重打一次(官方文档给的无 beta 恢复路径)。
//
// 用量口径:Anthropic 的 input_tokens 不含缓存读写,这里在解码器里合并 message_start 与 message_delta 的 usage,
// 在 message_stop 只报一次,并归一成 OpenAI 口径(prompt_tokens = input + cache_read + cache_creation),原字段保留。

const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_STREAM_MAX_TOKENS = 32000;
const ANTHROPIC_COMPLETION_MAX_TOKENS = 8192;
const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ANTHROPIC_EMPTY_TEXT = '(空)';
// provider.anthropicAuth:'x-api-key' / 'bearer';缺省(auto)= 官方主机只发 x-api-key,其它主机两个都发(与 CLI 的 claudeAuthMode 同义)。
const ANTHROPIC_AUTH_MODES = new Set(['x-api-key', 'bearer']);
// provider.anthropicThinking:'adaptive' 总是发自适应思考;'off' 不发 thinking 字段(模型自己的缺省);缺省(auto)按模型名判断。
const ANTHROPIC_THINKING_MODES = new Set(['adaptive', 'off']);

function normalizeAnthropicAuth(value) {
  return typeof value === 'string' && ANTHROPIC_AUTH_MODES.has(value) ? value : '';
}
function normalizeAnthropicThinking(value) {
  return typeof value === 'string' && ANTHROPIC_THINKING_MODES.has(value) ? value : '';
}
// 主机名用正则取(不用 URL 类:00-boot 有同名顶层绑定,扫描器会把它记成一条进环的边)。
function anthropicOfficialHost(baseUrl) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i.exec(String(baseUrl || '').trim());
  return Boolean(m && m[1].toLowerCase() === 'api.anthropic.com');
}
function anthropicMessagesUrl(baseUrl) {
  const base = providerBaseWithV1(baseUrl);
  return base ? base + '/messages' : '';
}
function anthropicRequestHeaders(provider) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_API_VERSION };
  const key = String((provider && provider.apiKey) || '').trim();
  if (key) {
    const mode = normalizeAnthropicAuth(provider && provider.anthropicAuth);
    const official = anthropicOfficialHost(provider && provider.baseUrl);
    if (mode !== 'bearer') headers['x-api-key'] = key;
    if (mode === 'bearer' || (!mode && !official)) headers['authorization'] = 'Bearer ' + key;
  }
  if (provider && provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  return headers;
}
// 自适应思考只发给认得它的模型:Claude 4.6 起的 opus / sonnet / fable / mythos(更早的与 haiku 走 budget_tokens,发 adaptive 会 400)。
// 网关上的非 Claude 模型(GLM / Kimi / DeepSeek 的 Anthropic 兼容端点等)缺省不发,由各家自己的缺省决定。
function anthropicModelTakesAdaptiveThinking(model) {
  const m = /(?:^|[^a-z])claude-(opus|sonnet|fable|mythos)-(\d{1,2})(?:[-.](\d{1,2}))?(?![\d])/i.exec(String(model || ''));
  if (!m) return false;
  const major = Number(m[2]);
  const minor = m[3] != null ? Number(m[3]) : 0;
  return major > 4 || (major === 4 && minor >= 6);
}
function anthropicThinkingFor(provider, model) {
  const mode = normalizeAnthropicThinking(provider && provider.anthropicThinking);
  if (mode === 'off') return null;
  if (mode === 'adaptive' || anthropicModelTakesAdaptiveThinking(model)) return { type: 'adaptive', display: 'summarized' };
  return null;
}

// tool_use / tool_result 的 id 只许 [A-Za-z0-9_-];历史里的 id 来自别的协议时可能带别的字符,两边用同一个映射就对得上。
function anthropicToolId(id) {
  const raw = String(id == null ? '' : id);
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return clean || 'toolu_missing';
}
function anthropicNonEmpty(value) {
  const s = typeof value === 'string' ? value : String(value == null ? '' : value);
  return s.trim() ? s : ANTHROPIC_EMPTY_TEXT;
}
function anthropicImageBlock(uri) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  if (/^https?:\/\//i.test(uri)) return { type: 'image', source: { type: 'url', url: uri } };
  return null;
}
// user 消息内容(字符串或 OpenAI 多模态 parts)→ Messages 内容块;空文本块会被 API 拒收,所以不产出空块。
function anthropicUserBlocks(content) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return content == null ? [] : anthropicUserBlocks(String(content));
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      if (part.text.trim()) blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' || part.type === 'input_image') {
      const uri = typeof part.image_url === 'string' ? part.image_url
        : (part.image_url && typeof part.image_url.url === 'string') ? part.image_url.url
        : (typeof part.input_image === 'string' ? part.input_image : '');
      const img = uri ? anthropicImageBlock(uri) : null;
      blocks.push(img || { type: 'text', text: '[图片输入无法解析图像 URI，已替换为占位文本]' });
    }
  }
  return blocks;
}
function anthropicToolInput(rawArgs) {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs;
  try {
    const parsed = JSON.parse(String(rawArgs || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function anthropicToolResultContent(content) {
  if (typeof content === 'string') return anthropicNonEmpty(content);
  if (Array.isArray(content)) {
    const blocks = anthropicUserBlocks(content);
    return blocks.length ? blocks : ANTHROPIC_EMPTY_TEXT;
  }
  return anthropicNonEmpty(content == null ? '' : JSON.stringify(content));
}
// 能否原样回放这条 assistant 的内容块:协议对、模型对(回体里的 model 或当初请求的 model)、块里的 tool_use id 与历史 tool_calls 一一对应。
function anthropicReplayableBlocks(m, model) {
  const pb = m && m.providerBlocks;
  if (!pb || pb.protocol !== 'anthropic' || !Array.isArray(pb.blocks) || !pb.blocks.length) return null;
  if (model && pb.model !== model && pb.requestModel !== model) return null;
  const blockIds = pb.blocks.filter(b => b && b.type === 'tool_use').map(b => String(b.id));
  const callIds = (Array.isArray(m.tool_calls) ? m.tool_calls : []).filter(tc => tc && tc.id != null).map(tc => anthropicToolId(tc.id));
  if (blockIds.length !== callIds.length || blockIds.some((id, i) => id !== callIds[i])) return null;
  return pb.blocks.map(b => JSON.parse(JSON.stringify(b)));
}
// hasTools=false(这一发不带 tools:摘要、起草、去工具重打):Messages 不收没有 tools 定义的 tool_use / tool_result 块,
// 工具调用与结果改写成文字留在对话里(摘要要的正是这些内容)。
function anthropicAssistantBlocks(m, hasTools) {
  const blocks = [];
  const said = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => (p && typeof p.text === 'string') ? p.text : '').join('') : '');
  if (said.trim()) blocks.push({ type: 'text', text: said });
  for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
    if (!tc || tc.id == null) continue;
    const fn = tc.function || {};
    if (hasTools) blocks.push({ type: 'tool_use', id: anthropicToolId(tc.id), name: String(fn.name || ''), input: anthropicToolInput(fn.arguments) });
    else blocks.push({ type: 'text', text: '[调用工具 ' + String(fn.name || '') + '] ' + JSON.stringify(anthropicToolInput(fn.arguments)) });
  }
  return blocks;
}
function anthropicToolResultAsText(m) {
  const content = anthropicToolResultContent(m.content);
  const head = { type: 'text', text: '[工具结果 ' + anthropicToolId(m.tool_call_id) + ']' + (typeof content === 'string' ? '\n' + content : '') };
  return typeof content === 'string' ? [head] : [head, ...content];
}
// chat 形历史(首条 system 已由调用方拿走)→ Messages 的 messages 数组。
//   - 历史中后插的 system / developer(压缩标记、修复说明、起草规则)→ 紧随其后的 user 文本块 <system-reminder>,顶层 system 不动;
//   - 连续的 role:'tool' 合成一条 user 消息里的 tool_result 块;相邻同角色消息合并(Messages 要求 user / assistant 交替);
//     合并后的 user 消息里 tool_result 块排在最前(API 要求),工具截图等后插的图片 / 文字排在它们之后;
//   - 首条不是 user 时补一条占位 user;末条是 assistant 时补一条占位 user(新模型不收 assistant 预填)。
function anthropicMessagesFromHistory(history, model, hasTools) {
  const list = Array.isArray(history) ? history : [];
  let lastUser = -1;
  for (let i = list.length - 1; i >= 0; i--) { if (list[i] && list[i].role === 'user') { lastUser = i; break; } }
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: blocks.slice() });
  };
  list.forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    if (m.role === 'system' || m.role === 'developer') {
      const rule = typeof m.content === 'string' ? m.content : '';
      if (rule.trim()) push('user', [{ type: 'text', text: '<system-reminder>\n' + rule + '\n</system-reminder>' }]);
      return;
    }
    if (m.role === 'assistant') {
      const replay = hasTools && i > lastUser ? anthropicReplayableBlocks(m, model) : null;
      push('assistant', replay || anthropicAssistantBlocks(m, hasTools));
      return;
    }
    if (m.role === 'tool') {
      if (m.tool_call_id == null) return;
      push('user', hasTools ? [{ type: 'tool_result', tool_use_id: anthropicToolId(m.tool_call_id), content: anthropicToolResultContent(m.content) }] : anthropicToolResultAsText(m));
      return;
    }
    push('user', anthropicUserBlocks(m.content)); // user 与未知角色都当 user
  });
  for (const msg of out) {
    if (msg.role !== 'user') continue;
    const results = msg.content.filter(b => b.type === 'tool_result');
    if (results.length && results.length !== msg.content.length) msg.content = [...results, ...msg.content.filter(b => b.type !== 'tool_result')];
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(继续)' }] });
  if (out[out.length - 1].role !== 'user') out.push({ role: 'user', content: [{ type: 'text', text: '(继续)' }] });
  return out;
}
// 基础请求体。messages 是 chat 形历史,首条 system;instructions 显式给了就用它当顶层 system。
// foldSystem 在这里没有区别:后插的 system 规则总是以 <system-reminder> 留在对话里(Messages 没有多 system 通道,但丢掉不行)。
// hasTools:这一发会不会带 tools(调用方随后 applyTools)。不是 true 时工具块改写成文字(见 anthropicAssistantBlocks),也不回放思考块。
function encodeAnthropicMessages({ model, messages, stream, instructions, provider, hasTools }) {
  const list = Array.isArray(messages) ? messages : [];
  const hasLead = Boolean(list[0] && (list[0].role === 'system' || list[0].role === 'developer'));
  const lead = hasLead ? String(list[0].content || '') : '';
  const system = typeof instructions === 'string' ? instructions : lead;
  const rest = hasLead ? list.slice(1) : list;
  const body = { model, max_tokens: stream ? ANTHROPIC_STREAM_MAX_TOKENS : ANTHROPIC_COMPLETION_MAX_TOKENS };
  if (system.trim()) body.system = system;
  body.messages = anthropicMessagesFromHistory(rest, model, hasTools === true);
  const thinking = anthropicThinkingFor(provider, model);
  if (thinking) body.thinking = thinking;
  body.stream = stream === true;
  return body;
}
function applyAnthropicEffort(body, effort) {
  const e = String(effort || '').trim().toLowerCase();
  if (!e) return body;
  const mapped = (e === 'none' || e === 'minimal') ? 'low' : e;
  if (!ANTHROPIC_EFFORTS.has(mapped)) return body;
  body.output_config = Object.assign({}, body.output_config, { effort: mapped });
  return body;
}
// chat 形函数工具 → { name, description, input_schema };tool_choice 只发 auto(新模型对 any / tool 回 400)。
function anthropicTools(tools) {
  const out = [];
  for (const t of (Array.isArray(tools) ? tools : [])) {
    if (!t || typeof t !== 'object') continue;
    const fn = t.type === 'function' && t.function && typeof t.function === 'object' ? t.function : t;
    const name = String(fn.name || '');
    if (!name) continue;
    out.push({ name, description: String(fn.description || ''), input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} } });
  }
  return out;
}
function applyAnthropicTools(body, tools) {
  body.tools = anthropicTools(tools);
  body.tool_choice = { type: 'auto' };
  return body;
}
function encodeAnthropicQuick({ model, messages, plain }) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list.filter(m => m && m.role === 'system').map(m => m.content).join('\n\n');
  const user = list.filter(m => m && m.role === 'user').map(m => m.content).join('\n');
  const body = { model, max_tokens: 400, messages: [{ role: 'user', content: [{ type: 'text', text: anthropicNonEmpty(user) }] }], stream: false };
  if (system.trim()) body.system = system;
  if (!plain) body.output_config = { effort: 'low' };
  return body;
}

// ── 解码 ─────────────────────────────────────────────────────────────────────────────────────────────
function normalizeAnthropicUsage(usage) {
  if (!usage || typeof usage !== 'object' || usage.prompt_tokens != null) return usage;
  const count = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const input = count(usage.input_tokens), read = count(usage.cache_read_input_tokens), created = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  const prompt = input + read + created;
  return { ...usage, prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output, prompt_tokens_details: { cached_tokens: read } };
}
// stop_reason → 另两种协议的 finishReason 口径。
function anthropicFinishReason(stopReason) {
  switch (String(stopReason || '')) {
    case 'end_turn': case 'stop_sequence': case 'pause_turn': return 'stop';
    case 'tool_use': return 'tool_calls';
    case 'max_tokens': case 'model_context_window_exceeded': return 'length';
    case 'refusal': return 'refusal';
    default: return stopReason ? String(stopReason) : null;
  }
}
function anthropicRefusalDetail(stopDetails) {
  const category = stopDetails && typeof stopDetails === 'object' && stopDetails.category ? String(stopDetails.category) : '';
  const why = stopDetails && typeof stopDetails === 'object' && stopDetails.explanation ? String(stopDetails.explanation) : '';
  return 'Anthropic refusal' + (category ? ' (' + category + ')' : '') + (why ? ': ' + why.slice(0, 300) : '');
}
// 回放用的内容块:只留协议定义的字段,thinking / redacted_thinking 原样(含签名)。
function anthropicReplayBlock(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'thinking') return { type: 'thinking', thinking: String(block.thinking || ''), signature: String(block.signature || '') };
  if (block.type === 'redacted_thinking') return { type: 'redacted_thinking', data: String(block.data || '') };
  if (block.type === 'text') return { type: 'text', text: String(block.text || ''), ...(Array.isArray(block.citations) ? { citations: block.citations } : {}) };
  if (block.type === 'tool_use') return { type: 'tool_use', id: String(block.id || ''), name: String(block.name || ''), input: block.input && typeof block.input === 'object' ? block.input : {} };
  return null;
}
function anthropicProviderBlocks(blocks, model, requestModel) {
  const kept = blocks.map(anthropicReplayBlock).filter(Boolean);
  if (!kept.some(b => b.type === 'thinking' || b.type === 'redacted_thinking')) return null;
  return { protocol: 'anthropic', model: String(model || ''), ...(requestModel ? { requestModel: String(requestModel) } : {}), blocks: kept };
}
function decodeAnthropicCompletion(j, opts) {
  const blocks = Array.isArray(j && j.content) ? j.content : [];
  let outText = '', reasoning = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') outText += b.text;
    else if (b.type === 'thinking' && typeof b.thinking === 'string') reasoning += b.thinking;
    else if (b.type === 'tool_use' && b.name) toolCalls.push({ id: b.id || (opts && opts.newId ? opts.newId('call') : 'toolu_missing'), name: b.name, rawArgs: JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}) });
  }
  const stop = j && j.stop_reason;
  const isError = Boolean(j && j.type === 'error');
  const errorDetail = isError && j.error ? String(j.error.message || j.error.type || 'provider error') : '';
  const refusal = stop === 'refusal';
  const providerBlocks = anthropicProviderBlocks(blocks, j && j.model, opts && opts.requestModel);
  return {
    text: outText, reasoning, toolCalls,
    finishReason: isError ? 'error' : anthropicFinishReason(stop),
    incomplete: stop === 'max_tokens' || stop === 'model_context_window_exceeded',
    incompleteReason: String(stop || 'output limit'),
    failed: isError || refusal,
    failedDetail: isError ? errorDetail : (refusal ? anthropicRefusalDetail(j.stop_details) : ''),
    usage: normalizeAnthropicUsage(j && j.usage) || null,
    responseId: (j && typeof j.id === 'string' && j.id) || '',
    ...(providerBlocks ? { providerBlocks } : {}),
  };
}
// 流中的 error 事件:还没吐出任何内容时按 HTTP 状态口径报(overloaded → 529、限流 → 429、api_error → 500,
// 04h providerCallIsTransient 据此走瞬时重试);已经吐过内容就不带状态码 —— 重试会让界面上的内容重放一遍。
const ANTHROPIC_STREAM_ERROR_STATUS = { overloaded_error: 529, rate_limit_error: 429, api_error: 500, request_too_large: 413 };
function anthropicStreamErrorText(err, emitted, scrub) {
  const kind = String((err && err.type) || 'error');
  const msg = String((err && err.message) || '');
  const detail = kind + (msg ? ': ' + (typeof scrub === 'function' ? scrub(msg.slice(0, 400)) : msg.slice(0, 400)) : '');
  const status = ANTHROPIC_STREAM_ERROR_STATUS[kind];
  return !emitted && status ? 'HTTP ' + status + ': ' + detail : 'Anthropic stream error: ' + detail;
}
// 流式事件:message_start → content_block_start / delta / stop(按 index)→ message_delta(stop_reason、累计 output_tokens)→ message_stop。
function createAnthropicStreamDecoder({ onEvent, markUsage, requestModel, newId, scrub }) {
  let outText = '', reasoning = '', stopReason = null, stopDetails = null, providerResponseId = '', model = '', streamError = '';
  let usageStart = null, usageDelta = null, usageMarked = false, emitted = false;
  const blocks = []; // 按 index 存放,index 缺失时顺延
  const reportUsage = () => {
    if (usageMarked || (!usageStart && !usageDelta)) return;
    usageMarked = true;
    markUsage(normalizeAnthropicUsage({ ...(usageStart || {}), ...(usageDelta || {}) }));
  };
  return {
    feed(evt) {
      const t = evt && evt.type;
      if (t === 'message_start') {
        const msg = evt.message || {};
        if (typeof msg.id === 'string') providerResponseId = msg.id;
        if (typeof msg.model === 'string') model = msg.model;
        if (msg.usage && typeof msg.usage === 'object') usageStart = { ...msg.usage };
        return false;
      }
      if (t === 'content_block_start') {
        const idx = Number.isInteger(evt.index) ? evt.index : blocks.length;
        const cb = evt.content_block && typeof evt.content_block === 'object' ? evt.content_block : {};
        const block = { ...cb };
        if (block.type === 'tool_use') { block.partial = ''; if (!block.id) block.id = newId ? newId('call') : 'toolu_missing'; }
        if (block.type === 'text' && typeof block.text === 'string' && block.text) { outText += block.text; emitted = true; onEvent({ type: 'assistant_delta', text: block.text }); }
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) { reasoning += block.thinking; onEvent({ type: 'thinking_delta', text: block.thinking }); }
        blocks[idx] = block;
        return false;
      }
      if (t === 'content_block_delta') {
        const idx = Number.isInteger(evt.index) ? evt.index : blocks.length - 1;
        const block = blocks[idx];
        const d = evt.delta || {};
        if (!block) return false;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          block.text = String(block.text || '') + d.text; outText += d.text; emitted = true;
          if (d.text) onEvent({ type: 'assistant_delta', text: d.text });
        } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          block.thinking = String(block.thinking || '') + d.thinking; reasoning += d.thinking;
          if (d.thinking) onEvent({ type: 'thinking_delta', text: d.thinking });
        } else if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          block.signature = String(block.signature || '') + d.signature;
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          block.partial = String(block.partial || '') + d.partial_json; emitted = true;
        } else if (d.type === 'citations_delta' && d.citation) {
          block.citations = [...(Array.isArray(block.citations) ? block.citations : []), d.citation];
        }
        return false;
      }
      if (t === 'content_block_stop') {
        const block = blocks[Number.isInteger(evt.index) ? evt.index : blocks.length - 1];
        if (block && block.type === 'tool_use') {
          if (block.partial) { try { block.input = JSON.parse(block.partial); } catch { block.input = {}; } }
          if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input)) block.input = {};
        }
        return false;
      }
      if (t === 'message_delta') {
        if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.delta && evt.delta.stop_details) stopDetails = evt.delta.stop_details;
        if (evt.usage && typeof evt.usage === 'object') usageDelta = { ...(usageDelta || {}), ...evt.usage };
        return false;
      }
      if (t === 'message_stop') { reportUsage(); return true; }
      if (t === 'error') { streamError = anthropicStreamErrorText(evt.error, emitted, scrub); return true; }
      return false; // ping 与未知事件
    },
    finish() {
      reportUsage();
      const list = blocks.filter(Boolean);
      const toolCalls = list.filter(b => b.type === 'tool_use' && b.name).map(b => ({ id: b.id, name: b.name, rawArgs: b.partial || JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}) }));
      const finishReason = streamError ? 'error' : anthropicFinishReason(stopReason);
      const providerBlocks = anthropicProviderBlocks(list, model, requestModel);
      const out = { text: outText, reasoning, finishReason, toolCalls, providerResponseId, ...(providerBlocks ? { providerBlocks } : {}) };
      if (streamError) out.httpError = streamError;
      else if (stopReason === 'refusal') out.httpError = anthropicRefusalDetail(stopDetails);
      return out;
    },
  };
}
// 400 兼容重打(07 openAiStreamOnce 在超窗判定之后、stream_options 嗅探之前问这一句;返回新请求体 = 重打一次,null = 不重打):
//   1) 思考块签名校验失败(前缀被改过):去掉全部 thinking / redacted_thinking 块;
//   2) 兼容网关不认某个参数(thinking / output_config / temperature / top_p / top_k):去掉报文里点名的那几个。
function anthropicRetryBodyOn400(body, errText) {
  const msg = String(errText || '');
  if (!body || typeof body !== 'object' || !msg) return null;
  const hasThinkingBlocks = Array.isArray(body.messages) && body.messages.some(m => Array.isArray(m && m.content) && m.content.some(b => b && (b.type === 'thinking' || b.type === 'redacted_thinking')));
  if (hasThinkingBlocks && /signature|thinking.{0,40}block|block.{0,20}thinking/i.test(msg)) {
    const messages = body.messages.map(m => (Array.isArray(m && m.content)
      ? { ...m, content: m.content.filter(b => !(b && (b.type === 'thinking' || b.type === 'redacted_thinking'))) }
      : m)).filter(m => !Array.isArray(m.content) || m.content.length);
    return { ...body, messages };
  }
  const named = ['thinking', 'output_config', 'temperature', 'top_p', 'top_k'].filter(k => body[k] !== undefined && new RegExp('\\b' + k + '\\b', 'i').test(msg));
  if (named.length && /extra inputs|not permitted|unknown|unsupported|not\s*support|unrecognized|invalid|not allowed/i.test(msg)) {
    const copy = { ...body };
    for (const k of named) delete copy[k];
    return copy;
  }
  return null;
}
