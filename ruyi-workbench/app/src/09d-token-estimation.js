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
// 性能批 C2:CJK_RE 命中数的等价计数。修前 str.match(CJK_RE) 给每个汉字分配一个字符串,每回合至少估两次整段历史,
// 400 万汉字要 230 ms。CJK_RE 不带 u 标志、按 UTF-16 码元匹配,几个区间都不含代理区(D800–DFFF),所以逐码元比区间
// 与之逐个相同(unit/token-estimate-cjk 在全部 65536 个码元与随机串上比对)。
function countCjkCodeUnits(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x2E80) continue;
    if (c <= 0x9FFF || (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFFEF)) n++;
  }
  return n;
}
function estimateTextTokens(str) {
  if (typeof str !== 'string' || !str) return 0;
  const cjk = countCjkCodeUnits(str);
  // 105e: 开关关 = 现状两桶,同样的输入同样的输出(逐字节一致);开时先分类再套桶因子。
  return tokensFromTextCounts(str.length - cjk, cjk, estimateBucketsV1On ? classifyTextForEstimate(str) : null);
}
// 估算公式的唯一一处:bucket 为 null = 两桶(开关关);否则按桶套因子。直算与记忆表两条路都从这里出数,
// 原料(ascii、cjk、bucket)相同则结果逐位相同 —— 记忆表只存原料,不存乘过因子/校准系数的结果。
function tokensFromTextCounts(ascii, cjk, bucket) {
  if (bucket === null) return ascii / 3.6 + cjk / 1.5;
  const divisor = bucket === 'json' ? ESTIMATION_RULES.factors.json : bucket === 'code' ? ESTIMATION_RULES.factors.code : 3.6;
  return ascii / divisor + cjk / 1.5; // CJK 字符在所有桶中保持 ÷1.5
}
// 性能批(回合起点估算):按内容记忆每段文本的估算原料。
// 每个 API 迭代前都要估两遍整段历史(maybeAutoCompact 的 calibratedEstimate + lastEstBeforeCall),回合末再一遍;
// 2000 条 / 10 MB 的会话一遍 50–150 ms(bench/token-estimate.bench.js;真机 cpu-prof 里关键字正则一项就 ~120 ms/回合),几乎全花在 countCjkCodeUnits 与 classifyTextForEstimate 上,而两次估算之间
// 历史里绝大多数字符串一个字没变。会话每回合从盘上重读(loadSession 给新对象、新字符串),所以不能按消息对象
// 挂 WeakMap,只能按【内容】认:Map 以字符串本身为键(SameValueZero = 逐字比较,没有哈希碰撞认错的可能)。
//   · 存原料 { cjk, bucket } 而非结果:bucket 只取决于字符串与 ESTIMATION_RULES 的阈值(进程内常量),因子在
//     tokensFromTextCounts 里现读;开关(estimateBucketsV1On)翻转不用失效 —— 关时不看 bucket,开时缺了才补分类。
//     calibratedEstimate 的 EMA 校准系数乘在 estimateHistoryTokens 的整数总和上,不经过这里,随时变都不受影响。
//   · 命中即 delete + set:既是 LRU 的「挪到最新」,也把键换成本次传入的那份字符串 —— 重读前的旧副本随之可回收,
//     表里常驻的一般就是活会话自己的字符串,不另占一份。
//   · 只给整段历史这类「下次还会原样再估」的调用用(estimateHistoryTokens / estimateToolSchemaTokens);
//     流式电量表逐次变长的前缀、二分截断的一次性切片走 estimateTextTokens / estimateContentTokens 直算,不进表。
//   · 有界:字符总数与条目数双上限,超了从最久未用的一端淘汰;短串(< MIN_CHARS)直算比查表便宜,不进表。
const TOKEN_ESTIMATE_MEMO_MIN_CHARS = 64;
const TOKEN_ESTIMATE_MEMO_MAX_CHARS = 24 * 1024 * 1024;
const TOKEN_ESTIMATE_MEMO_MAX_ENTRIES = 100000;
const tokenEstimateMemo = { map: new Map(), chars: 0 };
function tokenEstimateMemoEntry(str) {
  const memo = tokenEstimateMemo;
  let entry = memo.map.get(str);
  if (entry) {
    memo.map.delete(str);
    memo.map.set(str, entry);
    return entry;
  }
  entry = { cjk: countCjkCodeUnits(str), bucket: undefined };
  if (str.length > TOKEN_ESTIMATE_MEMO_MAX_CHARS) return entry; // 单条就超总量:这次用、不进表
  memo.map.set(str, entry);
  memo.chars += str.length;
  if (memo.chars > TOKEN_ESTIMATE_MEMO_MAX_CHARS || memo.map.size > TOKEN_ESTIMATE_MEMO_MAX_ENTRIES) {
    for (const key of memo.map.keys()) {
      if (key === str || (memo.chars <= TOKEN_ESTIMATE_MEMO_MAX_CHARS && memo.map.size <= TOKEN_ESTIMATE_MEMO_MAX_ENTRIES)) break;
      memo.map.delete(key);
      memo.chars -= key.length;
    }
  }
  return entry;
}
// 与 estimateTextTokens 同入同出(逐位同值),只是原料按内容记忆。
function estimateTextTokensMemo(str) {
  if (typeof str !== 'string' || !str) return 0;
  if (str.length < TOKEN_ESTIMATE_MEMO_MIN_CHARS) return estimateTextTokens(str);
  const entry = tokenEstimateMemoEntry(str);
  if (!estimateBucketsV1On) return tokensFromTextCounts(str.length - entry.cjk, entry.cjk, null);
  if (entry.bucket === undefined) entry.bucket = classifyTextForEstimate(str);
  return tokensFromTextCounts(str.length - entry.cjk, entry.cjk, entry.bucket);
}
// 105e 三桶分类器 —— 确定性、廉价、零 LLM。采样头+尾各 ≤sampleChars 字符:
//   trim 后 JSON.parse 成功(仅未被采样截断时)、或结构字符 {}[]":, 密度 ≥ 阈值 → json;
//   代码信号(换行+缩进、;{}()=> 密度、关键字命中)评分 ≥ 阈值 → code;否则 text。
// tool_calls arguments / Responses arguments·output 等结构化内容走同一入口,自然命中 json 桶。
// 性能批:判定与原版逐个相同(unit/token-estimate-memo 拿原版逐字抄本在随机串与真实文件切片上对拍),做法换成:
//   · 结构字符、代码标点、行数、缩进行一趟 charCodeAt 数完,不再 .match() 出成串的单字符数组、不 split 行;
//   · 缩进行 = 原 /^(\t| {2,})\S/:行首恰一个 \t 或 ≥2 个空格,紧跟一个非 \s 码元(\s 集合见 isRegexSpaceCodeUnit);
//   · 关键字只在它能左右结论时才扫(已达阈值、或加上也不够就跳过),数到 3 个即停 —— 原版只看 kw >= 3。
const ESTIMATE_KEYWORD_RE = /\b(function|const|let|var|return|import|export|class|def|async|await|public|private|static|void|if|for|while)\b|=>/g;
// JS 正则 \s 在非 u 模式下按 UTF-16 码元匹配的集合(WhiteSpace + LineTerminator);unit 测试在全部 65536 个码元上与 /\s/ 比对。
function isRegexSpaceCodeUnit(c) {
  return (c >= 0x09 && c <= 0x0D) || c === 0x20 || c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A)
    || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}
// ASCII 码元分类表:1 = 结构字符 [ ] " : ,(原 /[{}[\]":,]/)、2 = 代码标点 ; ( ) = > <(原 /[;{}()=><]/)、
// 3 = { } 两边都算、4 = \n。
const ESTIMATE_CHAR_CLASS = (() => {
  const t = new Uint8Array(128);
  for (const ch of '[]":,') t[ch.charCodeAt(0)] = 1;
  for (const ch of ';()=><') t[ch.charCodeAt(0)] = 2;
  for (const ch of '{}') t[ch.charCodeAt(0)] = 3;
  t[0x0A] = 4;
  return t;
})();
function countEstimateKeywords(sample, cap) {
  const re = ESTIMATE_KEYWORD_RE;
  re.lastIndex = 0;
  let hits = 0;
  while (hits < cap && re.test(sample)) hits++; // 各分支至少 2 个码元,不会空匹配卡住 lastIndex
  re.lastIndex = 0;
  return hits;
}
function classifyTextForEstimate(str) {
  if (typeof str !== 'string' || !str) return 'text';
  const n = ESTIMATION_RULES.sampleChars;
  const truncated = str.length > n * 2;
  if (!truncated) {
    const t = str.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(t); return 'json'; } catch { /* 截断/近 JSON 落到密度判定 */ }
    }
  }
  // 采样 = 头 n + 尾 n。计数这一趟不真拼出来(拼接串逐个 charCodeAt 很慢),按下标映射直接读原串:
  // 采样下标 i < head 读 str[i],否则读 str[i + skip](跳过中段)。未截断时 head = 全长、skip = 0。
  // 头尾长度取自真 slice(slice 是 O(1) 视图),n 为 0/小数/负数这类退化值时与原版拼接逐码元对齐。
  const head = truncated ? str.slice(0, n).length : str.length;
  const tail = truncated ? str.slice(-n).length : 0;
  const len = head + tail;
  const skip = str.length - tail - head;
  let structHits = 0, punct = 0, lines = 1, indented = 0, lineStart = true;
  const at = i => str.charCodeAt(i < head ? i : i + skip);
  for (let seg = 0, i = 0; seg < 2; seg++) {
    const end = seg === 0 ? head : len, off = seg === 0 ? 0 : skip;
    for (; i < end; i++) {
      const c = str.charCodeAt(i + off);
      if (lineStart) {
        lineStart = false;
        if (c === 0x09) {
          if (i + 1 < len && !isRegexSpaceCodeUnit(at(i + 1))) indented++;
        } else if (c === 0x20) {
          let j = i + 1;
          while (j < len && at(j) === 0x20) j++;
          if (j - i >= 2 && j < len && !isRegexSpaceCodeUnit(at(j))) indented++;
        }
      }
      const k = c < 128 ? ESTIMATE_CHAR_CLASS[c] : 0;
      if (k !== 0) {
        if (k === 4) { lines++; lineStart = true; } // \n(= split('\n') 的段数)
        else { if (k & 1) structHits++; if (k & 2) punct++; }
      }
    }
  }
  if (structHits / len >= ESTIMATION_RULES.jsonStructDensity) return 'json';
  let score = 0;
  if (lines >= 3 && indented / lines >= 0.3) score += 2; // 换行+缩进
  if (punct / len >= 0.03) score += 2; // ;{}()=> 密度
  const threshold = ESTIMATION_RULES.codeSignalThreshold;
  if (score < threshold && score + 2 >= threshold
    && countEstimateKeywords(truncated ? str.slice(0, n) + str.slice(-n) : str, 3) >= 3) score += 2; // 关键字命中(\b 跨接缝,须在真采样上扫)
  return score >= threshold ? 'code' : 'text';
}
// Estimate the token cost of one message's `content` (string | parts array | absent).
function estimateContentTokens(content) {
  return estimateContentTokensBy(content, estimateTextTokens);
}
// textTokens:estimateTextTokens(直算)或 estimateTextTokensMemo(整段历史用,见上);两者逐位同值,求和顺序不变。
function estimateContentTokensBy(content, textTokens) {
  if (typeof content === 'string') return textTokens(content);
  if (Array.isArray(content)) {
    let t = 0;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' || typeof part.text === 'string') t += textTokens(String(part.text || ''));
      else if (part.type === 'image_url' || part.image_url || part.type === 'image') t += 1100; // fixed per-image cost
    }
    return t;
  }
  return 0;
}
// history: provider-history array (or [system, ...providerHistory] — callers may prepend a {role:'system'}
// message). systemPrompt: optional extra system string to count on top (kept for direct/unit callers).
function estimateHistoryTokens(history, systemPrompt, tools) {
  if (!Array.isArray(history)) return typeof systemPrompt === 'string' ? Math.round(estimateTextTokensMemo(systemPrompt)) : 0;
  let t = 0;
  for (const m of history) {
    if (!m || typeof m !== 'object') continue;
    t += 40; // per-message structural overhead (role/formatting/delimiters)
    t += estimateContentTokensBy(m.content, estimateTextTokensMemo);
    // DeepSeek Responses thinking mode requires prior reasoning to be replayed after a
    // tool call. It is therefore part of the real next-request payload and budget.
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
      t += estimateTextTokensMemo(m.reasoning_content);
    }
    // assistant tool_calls: the function arguments are real payload sent to the model — count them.
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc && tc.function;
        if (fn && typeof fn.arguments === 'string') t += estimateTextTokensMemo(fn.arguments);
        if (fn && typeof fn.name === 'string') t += estimateTextTokensMemo(fn.name);
      }
    }
    // 对抗轮(P2-4):Responses-API input items 在 content 之外还携带 function_call.arguments 与
    // function_call_output.output(工具参数/工具结果是真实发送给模型的载荷,必须计入估算;
    // 此前 responses 分支的 promptTokensEst 低估了这些 token)。
    if (typeof m.arguments === 'string' && m.arguments) t += estimateTextTokensMemo(m.arguments);
    if (typeof m.output === 'string' && m.output) t += estimateTextTokensMemo(m.output);
    if (typeof m.name === 'string' && m.name && m.type === 'function_call') t += estimateTextTokensMemo(m.name);
  }
  if (typeof systemPrompt === 'string' && systemPrompt) t += estimateTextTokensMemo(systemPrompt);
  if (Array.isArray(tools) && tools.length) t += estimateToolSchemaTokens(tools);
  return Math.round(t);
}

// ============================================================================
// v0.8-S5 — Context management: two-level auto-compaction + shared summary kernel (§7.7).
// ============================================================================
const CONTEXT_WINDOW_FALLBACK = 1000000; // runtime default when provider.contextWindow is unset（用户 2026-09-22 拍板：未知模型默认按 1M 窗算，宁晚压缩不误压缩；窗口超限学习只降不升兜住高估）
const EVAPORATED_PREFIX = '[已省略:';   // marker prefixing an evaporated tool result (idempotency guard)
