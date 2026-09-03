// 09d-token-estimation.js - 110-4b: 从 09-workflow.js 搬出的 token 估算与分桶簇(纯搬家,零行为变更)。
// Compact-ratio token formatter (server-side twin of the UI's fmtTokens; no decimals needed here —
// it only labels an estimate in the system message the compact endpoint writes).
function fmtTokensServer(n) {
  if (!Number.isFinite(n)) return '?';
  // 尾零只允许剥【小数部分】("82.0"→"82"、"1.00"→"1");整百整千的 K/M 整数尾零绝不可剥 ——
  // 旧正则 /\.?0+$/ 曾把 110000 显示成 "11K"、100000 显示成 "1K"(错报 10 倍,真机会话已现)。
  // 与前端 util.js fmtTokens 同一语义,保持两侧读数一致。
  const f = (x, d) => { let s = x.toFixed(d); if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, ''); return s; };
  if (n >= 1e6) return f(n / 1e6, n >= 1e7 ? 0 : 2) + 'M';
  if (n >= 1e3) return f(n / 1e3, n >= 1e5 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
// v0.8-S5 estimate v2 (§7.7). Tokenizer-free, offline-safe. tokens ≈ ascii_chars/3.6 + cjk_chars/1.5.
// "cjk" = code points ≥ 0x2E80 (CJK radicals onward): CJK ideographs, kana, Hangul, fullwidth forms, etc.
// Approximation trade-off: we do NOT iterate code points on the hot path — we count CJK chars with ONE
// regex .match() over the string (the char CLASS below covers the common CJK/kana/Hangul/fullwidth ranges
// as UTF-16 units; surrogate-pair ideographs beyond the BMP are rare in chat and estimated as ascii, an
// acceptable under-count) and treat every other char as ascii. So: cjk = (str.match(CJK)||[]).length,
// ascii = str.length - cjk, tokens += ascii/3.6 + cjk/1.5.
// The estimate must cover THREE content shapes (parts-aware from day one so v0.9 vision doesn't force a
// rewrite): (a) string content; (b) parts array content [{type:'text',text},{type:'image_url',…}] — text
// is char-counted, each image is a FIXED 1100 tokens; (c) assistant.tool_calls[].function.arguments (the
// exact block the old estimator dropped). Plus +40 structural overhead per message, and the systemPrompt
// when supplied (it is resent every request, so it occupies the window too).
// Ranges as \u escapes (unambiguous): U+2E80-U+9FFF (CJK radicals->unified ideographs, incl. kana
// U+3040-U+30FF), U+AC00-U+D7A3 (Hangul syllables), U+F900-U+FAFF (CJK compat ideographs), U+FE30-U+FE4F
// (CJK compat forms), U+FF00-U+FFEF (halfwidth/fullwidth forms). Covers the cjk set the spec means
// (>0x2E80) across the common BMP; astral ideographs (rare in chat) fall through and count as ascii.
const CJK_RE = /[\u2E80-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/g;
// 105e: 分桶开关运行时镜像 —— estimate* 是纯同步热路径(每回合多次、fitHistoryForSummary 二分内层),
// 不能 await readConfig;由持有 config 的入口(runOpenAiTurn / runSubAgentCore)调 setEstimateBucketsV1
// 刷新(maybeAutoCompact 唯一调用点在 runOpenAiTurn 回合内,已在入口覆盖)。config.json 进程级唯一,
// 镜像无多配置歧义;默认 false = 两桶逐字节不变。
let estimateBucketsV1On = false;
function setEstimateBucketsV1(on) { estimateBucketsV1On = on === true; }
function estimateTextTokens(str) {
  if (typeof str !== 'string' || !str) return 0;
  const cjk = (str.match(CJK_RE) || []).length;
  const ascii = str.length - cjk;
  // 105e: 开关关 = 现状两桶,同样的输入同样的输出(逐字节一致);开时先分类再套桶因子。
  if (!estimateBucketsV1On) return ascii / 3.6 + cjk / 1.5;
  const bucket = classifyTextForEstimate(str);
  const divisor = bucket === 'json' ? ESTIMATION_RULES.factors.json : bucket === 'code' ? ESTIMATION_RULES.factors.code : 3.6;
  return ascii / divisor + cjk / 1.5; // CJK 字符在所有桶中保持 ÷1.5
}
// 105e 三桶分类器 —— 确定性、廉价、零 LLM。采样头+尾各 ≤sampleChars 字符:
//   trim 后 JSON.parse 成功(仅未被采样截断时)、或结构字符 {}[]":, 密度 ≥ 阈值 → json;
//   代码信号(换行+缩进、;{}()=> 密度、关键字命中)评分 ≥ 阈值 → code;否则 text。
// tool_calls arguments / Responses arguments·output 等结构化内容走同一入口,自然命中 json 桶。
function classifyTextForEstimate(str) {
  if (typeof str !== 'string' || !str) return 'text';
  const n = ESTIMATION_RULES.sampleChars;
  const truncated = str.length > n * 2;
  const sample = truncated ? str.slice(0, n) + str.slice(-n) : str;
  if (!truncated) {
    const t = sample.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(t); return 'json'; } catch { /* 截断/近 JSON 落到密度判定 */ }
    }
  }
  const structHits = (sample.match(/[{}[\]":,]/g) || []).length;
  if (structHits / sample.length >= ESTIMATION_RULES.jsonStructDensity) return 'json';
  let score = 0;
  const lines = sample.split('\n');
  if (lines.length >= 3) {
    let indented = 0;
    for (const l of lines) if (/^(\t| {2,})\S/.test(l)) indented++;
    if (indented / lines.length >= 0.3) score += 2; // 换行+缩进
  }
  const punct = (sample.match(/[;{}()=><]/g) || []).length;
  if (punct / sample.length >= 0.03) score += 2; // ;{}()=> 密度
  const kw = (sample.match(/\b(function|const|let|var|return|import|export|class|def|async|await|public|private|static|void|if|for|while)\b|=>/g) || []).length;
  if (kw >= 3) score += 2; // 关键字命中
  return score >= ESTIMATION_RULES.codeSignalThreshold ? 'code' : 'text';
}
// Estimate the token cost of one message's `content` (string | parts array | absent).
function estimateContentTokens(content) {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (Array.isArray(content)) {
    let t = 0;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' || typeof part.text === 'string') t += estimateTextTokens(String(part.text || ''));
      else if (part.type === 'image_url' || part.image_url || part.type === 'image') t += 1100; // fixed per-image cost
    }
    return t;
  }
  return 0;
}
// history: provider-history array (or [system, ...providerHistory] — callers may prepend a {role:'system'}
// message). systemPrompt: optional extra system string to count on top (kept for direct/unit callers).
function estimateHistoryTokens(history, systemPrompt, tools) {
  if (!Array.isArray(history)) return typeof systemPrompt === 'string' ? Math.round(estimateTextTokens(systemPrompt)) : 0;
  let t = 0;
  for (const m of history) {
    if (!m || typeof m !== 'object') continue;
    t += 40; // per-message structural overhead (role/formatting/delimiters)
    t += estimateContentTokens(m.content);
    // DeepSeek Responses thinking mode requires prior reasoning to be replayed after a
    // tool call. It is therefore part of the real next-request payload and budget.
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
      t += estimateTextTokens(m.reasoning_content);
    }
    // assistant tool_calls: the function arguments are real payload sent to the model — count them.
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc && tc.function;
        if (fn && typeof fn.arguments === 'string') t += estimateTextTokens(fn.arguments);
        if (fn && typeof fn.name === 'string') t += estimateTextTokens(fn.name);
      }
    }
    // 对抗轮(P2-4):Responses-API input items 在 content 之外还携带 function_call.arguments 与
    // function_call_output.output(工具参数/工具结果是真实发送给模型的载荷,必须计入估算;
    // 此前 responses 分支的 promptTokensEst 低估了这些 token)。
    if (typeof m.arguments === 'string' && m.arguments) t += estimateTextTokens(m.arguments);
    if (typeof m.output === 'string' && m.output) t += estimateTextTokens(m.output);
    if (typeof m.name === 'string' && m.name && m.type === 'function_call') t += estimateTextTokens(m.name);
  }
  if (typeof systemPrompt === 'string' && systemPrompt) t += estimateTextTokens(systemPrompt);
  if (Array.isArray(tools) && tools.length) t += estimateToolSchemaTokens(tools);
  return Math.round(t);
}

// ============================================================================
// v0.8-S5 — Context management: two-level auto-compaction + shared summary kernel (§7.7).
// ============================================================================
const CONTEXT_WINDOW_FALLBACK = 65536; // runtime default when provider.contextWindow is unset
const EVAPORATED_PREFIX = '[已省略:';   // marker prefixing an evaporated tool result (idempotency guard)
