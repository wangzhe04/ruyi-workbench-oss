// ── v1.0.2-S2: 上下文窗口三级自适应 ─────────────────────────────────────────────────────────────────
// 用户痛点:DeepSeek 有 1M 窗却被当 64K 用。解析链(优先级从高到低):
//   1. 手动:provider.contextWindow(sanitizeProvider 已清洗, 8000..2000000)—— 保留最高优先;
//   2. 探测:fetchOpenAiModels 从上游 /v1/models 条目提取 context_length 类字段, 存入 CTX_PROBE_CACHE
//      (键 provider+model, TTL 10 分钟), providerContextWindow 解析激活模型时查此缓存;
//   3. 名称对照表(子串匹配, 小写, 保守取值);
//   4. 兜底:CONTEXT_WINDOW_FALLBACK(65536)—— 防 autocompact.e2e 漂移。
// 模型名对照表:模块级常量便于维护。子串匹配, 顺序敏感(deepseek-v4 须在 deepseek 之前命中)。
const MODEL_CONTEXT_TABLE = [
  ['deepseek-v4', 1000000],
  ['deepseek', 131072],   // deepseek 其余(v3/chat/reasoner)
  ['qwen', 131072],
  ['glm', 131072],
  ['kimi', 262144],
  ['moonshot', 262144],
  ['gpt-4o', 128000],
  ['gpt-4.1', 128000],
  ['o3', 200000],
  ['o4', 200000],
  ['claude', 200000],
];
// 从上游 /v1/models 条目提取窗口大小:取 context_length/max_context_length/context_window/max_model_len
// 任一为正数的第一个。none → undefined(探测无结果, 不污染缓存正数判定)。
const CTX_LENGTH_KEYS = ['context_length', 'max_context_length', 'context_window', 'max_model_len'];
function extractContextLength(rawModelEntry) {
  if (!rawModelEntry || typeof rawModelEntry !== 'object') return undefined;
  for (const k of CTX_LENGTH_KEYS) {
    const v = Number(rawModelEntry[k]);
    if (Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return undefined;
}
// 探测缓存:键 `${providerId}\u0000${modelId}` → { at, contextLength }. TTL 10 分钟。进程内, 无落盘。
const CTX_PROBE_CACHE = new Map();
const CTX_PROBE_TTL_MS = 10 * 60 * 1000;
function ctxProbeKey(providerId, modelId) { return String(providerId || '') + '\0' + String(modelId || ''); }
function cacheContextLength(providerId, modelId, contextLength) {
  if (!(Number.isFinite(contextLength) && contextLength > 0)) return;
  CTX_PROBE_CACHE.set(ctxProbeKey(providerId, modelId), { at: Date.now(), contextLength: Math.round(contextLength) });
}
function cachedContextLength(providerId, modelId) {
  const hit = CTX_PROBE_CACHE.get(ctxProbeKey(providerId, modelId));
  if (!hit) return undefined;
  if ((Date.now() - hit.at) > CTX_PROBE_TTL_MS) { CTX_PROBE_CACHE.delete(ctxProbeKey(providerId, modelId)); return undefined; }
  return hit.contextLength;
}
// 名称表命中(子串, 小写)。无命中 → undefined。
function contextWindowFromTable(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return undefined;
  for (const [needle, size] of MODEL_CONTEXT_TABLE) if (m.includes(needle)) return size;
  return undefined;
}
// 完整解析:返回 { value, source }, source ∈ 'manual'|'probe'|'table'|'fallback'。`model` 缺省时退回
// provider 的激活模型(provider.model 或 models[0])。手动优先, 再探测缓存, 再名称表, 最后兜底。
function resolveContextWindow(provider, model) {
  const cw = provider && Number(provider.contextWindow);
  if (Number.isFinite(cw) && cw > 0) return { value: Math.round(cw), source: 'manual' };
  const activeModel = String(model || (provider && provider.model) || (provider && provider.models && provider.models[0] && provider.models[0].id) || '').trim();
  const probed = provider ? cachedContextLength(provider.id, activeModel) : undefined;
  if (Number.isFinite(probed) && probed > 0) return { value: probed, source: 'probe' };
  const tabled = contextWindowFromTable(activeModel);
  if (Number.isFinite(tabled) && tabled > 0) return { value: tabled, source: 'table' };
  return { value: CONTEXT_WINDOW_FALLBACK, source: 'fallback' };
}
// Effective context window for a provider (手动/探测/表/兜底). Never returns 0. `model` optional (解析激活模型)。
function providerContextWindow(provider, model) {
  const resolved = resolveContextWindow(provider, model).value;
  // 45d(b):窗口超限学习 —— context-400 实测教训只降不升(42c 探针证明名义值不可信:haiku 名义 200K 实测 >217K)。
  const cap = learnedWindowCap(provider && provider.id, model);
  return cap ? Math.min(resolved, cap) : resolved;
}

// ── 第45波 45d:token 估算自校准 + 窗口超限学习 ─────────────────────────────────
// 两条学习线,存 data/context-calibration.json(小 JSON,内存 Map + 异步写穿):
//   (a) 估算因子:每次 API 调用用【真实 usage.input_tokens ÷ 发送前估算】采样,EMA(α=0.3)得每
//       provider+model 的校准因子(clamp [0.5,3],样本 ≥3 才生效防单次异常带偏)→ 压缩触发精度从
//       「拍脑袋常数」变「越用越准」。只用于预算判定,不改 UI 估算显示(那是对人的口径)。
//   (b) 窗口超限学习:context 类 400 发生时的估算占用 × 0.9 记为该 provider+model 的窗口上限,
//       只降不升(保守);providerContextWindow 单咽喉点应用。条目 ≤200(超出按插入序淘汰)。
const CONTEXT_CALIBRATION_MAX = 200;
let _ctxCalib = null; // { factors: {key:{f,n}}, windowCaps: {key:{cap,at}} }
function loadContextCalibration() {
  if (_ctxCalib) return _ctxCalib;
  _ctxCalib = { factors: {}, windowCaps: {} };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(paths.data, 'context-calibration.json'), 'utf8'));
    if (j && typeof j === 'object') { if (j.factors) _ctxCalib.factors = j.factors; if (j.windowCaps) _ctxCalib.windowCaps = j.windowCaps; }
  } catch (e) {
    // 45f 对抗轮 P2-1:文件不存在与【文件损坏】必须分流 —— 损坏时静默重建空史,下次写回就把
    // 全部学习成果无声清掉。损坏走 .corrupt 隔离(沿用 session 文件同款先例)+ 落账,再从空史重建。
    if (e && e.code !== 'ENOENT') {
      try { fs.copyFileSync(path.join(paths.data, 'context-calibration.json'), path.join(paths.data, 'context-calibration.json.corrupt')); } catch { /* ignore */ }
      try { logEvent({ kind: 'context_calibration_corrupt', error: String(e && e.message || e).slice(0, 200) }); } catch { /* ignore */ }
    }
  }
  return _ctxCalib;
}
const _calibKey = (providerId, model) => String(providerId || '') + '/' + String(model || '');
let _calibWriteChain = Promise.resolve();
function persistContextCalibration() {
  // 单写者假设(45f 对抗轮 P2-2 裁决):note* 调用点全部在 serve 进程内(MCP 子进程走 HTTP loopback,
  // 不是写者);多 serve 实例共享 dataRoot 是窄面,接受互覆,不做跨进程合并。
  _calibWriteChain = _calibWriteChain.then(async () => {
    try {
      const c = loadContextCalibration();
      for (const bucket of ['factors', 'windowCaps']) {
        const keys = Object.keys(c[bucket]);
        if (keys.length > CONTEXT_CALIBRATION_MAX) for (const k of keys.slice(0, keys.length - CONTEXT_CALIBRATION_MAX)) delete c[bucket][k];
      }
      // 45f 对抗轮 P2-1:tmp+rename 原子写 —— 写中途崩溃不留撕裂 JSON(撕裂曾会被静默重建清空学习)。
      const file = path.join(paths.data, 'context-calibration.json');
      const tmp = file + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(c), 'utf8');
      await fsp.rename(tmp, file);
    } catch { /* 记账永不阻断 */ }
  });
  return _calibWriteChain;
}
function noteEstimateSample(providerId, model, estimated, actual) {
  try {
    estimated = Number(estimated) || 0; actual = Number(actual) || 0;
    if (estimated < 500 || actual <= 0) return; // 小样本噪声大,不采
    const c = loadContextCalibration();
    const k = _calibKey(providerId, model);
    const ratio = Math.min(3, Math.max(0.5, actual / estimated));
    const prev = c.factors[k];
    c.factors[k] = { f: prev ? prev.f * 0.7 + ratio * 0.3 : ratio, n: (prev ? prev.n : 0) + 1 };
    persistContextCalibration();
  } catch { /* ignore */ }
}
function estimateFactor(providerId, model) {
  try {
    const f = loadContextCalibration().factors[_calibKey(providerId, model)];
    return (f && f.n >= 3 && Number.isFinite(f.f)) ? f.f : 1;
  } catch { return 1; }
}
function noteWindowOvershoot(providerId, model, estimatedAtFailure) {
  try {
    estimatedAtFailure = Math.floor(Number(estimatedAtFailure) || 0);
    if (estimatedAtFailure < 1000) return;
    const c = loadContextCalibration();
    const k = _calibKey(providerId, model);
    const learned = Math.floor(estimatedAtFailure * 0.9);
    const prev = c.windowCaps[k];
    if (prev && prev.cap <= learned) return; // 只降不升
    c.windowCaps[k] = { cap: learned, at: nowIso() };
    persistContextCalibration();
  } catch { /* ignore */ }
}
function learnedWindowCap(providerId, model) {
  try {
    const w = loadContextCalibration().windowCaps[_calibKey(providerId, model)];
    return (w && Number(w.cap) > 0) ? Number(w.cap) : 0;
  } catch { return 0; }
}
// 校准后的预算估算(45d(a) 唯一应用点):估算 × 因子。签名与 maybeAutoCompact 的估算同款。
function calibratedEstimate(provider, model, messages, tools) {
  return Math.round(estimateHistoryTokens(messages, '', tools) * estimateFactor(provider && provider.id, model));
}

// context 类 400 判定(45b):HTTP 400/413/422 + 上下文/长度【共现】语义。宁可漏判(不压)不误判(乱压历史)。
// 45f 对抗轮 P1-1 收紧:裸 `context` / `max_tokens` / 裸 `too long` 全删 —— 它们会命中
// "function calling is not supported in this context" / 参数校验类 400,把非超窗错误吸进破坏性压缩。
const CONTEXT_OVERFLOW_PATTERNS = /context.{0,20}(length|window|limit|token)|(length|window|limit|token).{0,20}context|maximum.{0,20}(token|length)|length.{0,12}exceed|prompt.{0,12}too.{0,4}long|prompt\s+is\s+too\s+long|too_many_tokens|tokens\s*>|input\s+too\s+long|input.{0,8}length.{0,30}(should be|range|限制)|上下文.{0,8}(超限|过长|超出)|长度超限|超出.{0,4}长度/i;
function isContextOverflowError(httpError) {
  const s = String(httpError || '');
  if (!/\b(400|413|422)\b/.test(s)) return false;
  return CONTEXT_OVERFLOW_PATTERNS.test(s);
}

// v0.8-S5 tiered tool-result truncation. Replaces the old flat 60KB slice at the tool-result push site.
// `name` is the tool name, `jsonStr` the JSON.stringify(resultObj). For a file_read-class result over 60KB
// keep the HEAD (40KB) + a marker + the TAIL (8KB) so the model retains both the opening context and the
// end of the file (in line mode it can re-locate any middle region by totalLines). Every other tool keeps
// the plain 60KB head cut. NOTE: this truncates the serialized JSON string, not the object — the head/tail
// windows may straddle JSON syntax, which is fine: the model reads it as text, and providerHistory only
// needs a stable, size-bounded string. Deterministic; no state.
const TOOL_RESULT_CAP = 60000;   // flat cap for non-file-read tools
const FILE_READ_HEAD = 40000;    // head window for file_read-class results
const FILE_READ_TAIL = 8000;     // tail window for file_read-class results
function truncateToolResult(name, jsonStr) {
  const s = String(jsonStr == null ? '' : jsonStr);
  if (s.length <= TOOL_RESULT_CAP) return s;
  if (name === 'file_read') {
    const head = s.slice(0, FILE_READ_HEAD);
    const tail = s.slice(s.length - FILE_READ_TAIL);
    return head + `\n[...中间已截断，共 ${s.length} 字符...]\n` + tail;
  }
  return s.slice(0, TOOL_RESULT_CAP);
}

// v0.8-S5 checkpoint SAFETY NET (not a gate): snapshot providerHistory BEFORE a compaction to
// dataRoot/checkpoints/<sessionId>/history-<turnSeq>.json.gz (built-in zlib; S4a dir convention). A
// failure here MUST NOT block the compaction or the turn — it is a recovery aid, not a precondition.
async function writeHistorySnapshot(sessionId, turnSeq, history) {
  try {
    if (!sessionId || !Array.isArray(history)) return;
    const dir = journalDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(history), 'utf8'));
    await fsp.writeFile(path.join(dir, `history-${Number(turnSeq) || 0}.json.gz`), gz);
    // PF1 fix: these history snapshots land in the SAME checkpoints/<id>/ tree the global size cap governs, but
    // only journalRecord used to keep the byte cache current. A compaction-heavy / edit-light session (each
    // auto-compact can write several MB here, and per-session GC never prunes these files) grew the real tree
    // WITHOUT moving the cache, so needSweep stayed false and the hard cap silently became a soft one.
    // (a) account the snapshot bytes (over-count on a same-turnSeq overwrite is the SAFE direction);
    // (b) give the sweep a chance to run: journalGc is otherwise only called on file writes, which are rare in a
    //     compaction-heavy load. Run it UNDER the per-session write lock so its index read-modify-write can't
    //     race a concurrent journalRecord (the v1.4.1 audit #8 lost-write hazard). Fire-and-forget: a recovery
    //     aid must never block or fail the compaction.
    journalBytesAdjust(gz.length);
    withJournalWriteLock(sessionId, () => journalGc(sessionId)).catch(() => {});
  } catch { /* safety net, never fatal */ }
}

// v0.8-S5 LEVEL 1 · EVAPORATE. Replace the CONTENT TEXT of `role:'tool'` messages that sit BEFORE the last
// 2 assistant turns with `[已省略:<first 120 chars of the original>]`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// PAIRING IRON LAW (OpenAI hard-validates this): every assistant.tool_calls[].id MUST have a matching
// role:'tool' message. So we ONLY rewrite the tool message's `content` string — we NEVER delete a message
// and NEVER touch assistant.tool_calls. Deleting a tool message (or its assistant) would make the NEXT
// request 400 (unanswered tool_call_id). Evaporation shrinks payload without breaking the pairing.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// APPEND-ONLY / CACHE ECONOMICS (§7.7): upstream (DeepSeek/DashScope) auto-caches the request PREFIX.
// Rewriting old tool contents deliberately SMASHES that cached prefix — so evaporation is destructive to
// the cache and MUST happen at most ONCE per threshold crossing, never speculatively. Between two
// compactions providerHistory stays strictly append-only (no rewriting old messages) so the prefix cache
// stays warm. Already-evaporated messages (content starts with EVAPORATED_PREFIX) are skipped so a repeat
// pass is a no-op (idempotent) and doesn't re-smash an already-cold prefix.
// Returns the number of tool messages evaporated on this pass (0 = nothing to do).
function evaporateHistory(history) {
  if (!Array.isArray(history) || !history.length) return 0;
  // Find the index of the 2nd-most-recent assistant message. Tool messages at or after it are within the
  // "recent 2 assistant turns" window and are preserved verbatim.
  let assistantsSeen = 0, boundary = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'assistant') { assistantsSeen++; if (assistantsSeen === 2) { boundary = i; break; } }
  }
  let count = 0;
  for (let i = 0; i < boundary; i++) {
    const m = history[i];
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (m.content.startsWith(EVAPORATED_PREFIX)) continue; // already evaporated → skip (idempotent, cache-safe)
    m.content = EVAPORATED_PREFIX + m.content.slice(0, 120) + ']';
    count++;
  }
  return count;
}

// v0.8-S5 SHARED SUMMARY KERNEL. One non-streaming summary call over `messages` (history + a summary
// prompt). Returns { ok:true, summary } or { ok:false, error }. NEVER throws. Used by BOTH the manual
// /api/provider/compact endpoint AND the auto-compact level-2 (§7.7 "共用内核"), so their summary behavior
// is identical. Does NOT mutate the session — the caller decides how to reseed history.
//
// ── 第45波(压缩 v2)45a:摘要载荷预算化(修「死锁角」)────────────────────────────────
// 旧内核把整个 history 发给 /chat/completions:history 已超窗(窗口估小/单条巨型工具结果)时,摘要
// 调用自身也 400 → 自动压缩每轮重试每轮失败,白付 60s 超时且永远压不下去。现在内核自带预算:
//   ① fitHistoryForSummary:按「窗口 × SUMMARY_INPUT_BUDGET_RATIO」预算适配输入 —— 保头(原始目标
//      user 块)保尾(最近 2 个 user 块),中段整块省略(user 块边界,配对安全;全程副本,不动调用方);
//   ② 适配后仍超预算(巨型单块)→ map-reduce:按 user 块分组(≤预算/组,超大块内消息内容截断)
//      逐组摘要,再对拼接的分段摘要做总摘要;usage 聚合记账,元数据 mapReduce.chunks。
// ── 45e:结构化摘要 prompt(目标/决定/未完成/关键文件四段式,替代旧单段流水)─────────────
const SUMMARY_INPUT_BUDGET_RATIO = 0.5;
const SUMMARY_CHUNK_MSG_CAP = 30000; // map-reduce 组内单条消息内容截断(字符,防单条巨型结果吃掉整组预算)
const SUMMARY_PROMPT = '请把以上对话压缩为结构化摘要,严格按以下四节输出(某节无内容写「无」):\n'
  + '【目标】用户的核心目标与关键约束\n'
  + '【已确认的决定】已拍板的事实、方案选择、用户偏好\n'
  + '【未完成事项】待办、进行中的工作、悬而未决的问题\n'
  + '【关键文件与上下文】涉及的文件/路径、代码要点、重要数据与结论\n'
  + '保真要求(45e 实测基线驱动):关键名词必须【原样】保留 —— 代号/暗号、数字与量级、日期、人名、'
  + '文件路径、版本号、明确的禁令与约束,一律不得泛化或省略;宁多勿漏,每节列要点,不要写成一段概括。\n'
  + '只输出摘要本身。';

function userBlockStarts(history) {
  const idx = [];
  for (let i = 0; i < history.length; i++) if (history[i] && history[i].role === 'user') idx.push(i);
  return idx;
}

// 预算适配(45a):返回【新数组】,绝不 mutate 调用方 history(manual compact 失败时「原样保留」契约)。
function fitHistoryForSummary(history, budgetTokens) {
  if (!Array.isArray(history) || !history.length) return { messages: [], droppedMiddle: 0 };
  if (estimateHistoryTokens(history) <= budgetTokens) return { messages: history.slice(), droppedMiddle: 0 };
  const starts = userBlockStarts(history);
  if (starts.length <= 3) return { messages: history.slice(), droppedMiddle: 0, needsMapReduce: true };
  const headEnd = starts[1];                 // 头 = 第 2 个 user 块之前(含原始目标)
  const tailStart = starts[starts.length - 2]; // 尾 = 最近 2 个 user 块(逐字)
  const middleCount = tailStart - headEnd;
  const marker = { role: 'user', content: `(摘要输入预算截断:此处省略中间 ${middleCount} 条消息)` };
  const fitted = [...history.slice(0, headEnd), marker, ...history.slice(tailStart)];
  if (estimateHistoryTokens(fitted) <= budgetTokens) return { messages: fitted, droppedMiddle: middleCount };
  return { messages: history.slice(), droppedMiddle: 0, needsMapReduce: true }; // 头尾本身已超 → map-reduce
}

// map-reduce 分组(45a):按 user 块聚合,组 ≤ 预算;单块超预算时块内消息内容截断。
// 45f 对抗轮 P2-3:截断量随预算动态取(窗口学习把预算压到 <30K 字符时,固定 30K cap 会让
// 单块照样超预算 → 摘要调用自身 400,死锁角借尸还魂)。字符 ≈ token×1.5(CJK 保守)。
function chunkHistoryByBudget(history, budgetTokens) {
  const starts = userBlockStarts(history);
  const blocks = [];
  for (let i = 0; i < starts.length; i++) blocks.push(history.slice(starts[i], starts[i + 1] || history.length));
  const msgCap = Math.max(2000, Math.min(SUMMARY_CHUNK_MSG_CAP, Math.floor(budgetTokens * 1.5)));
  const capContent = m => {
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return c.length > msgCap ? { ...m, content: c.slice(0, msgCap) + `\n…(单条内容过长,摘要输入截断,原 ${c.length} 字符)` } : m;
  };
  const chunks = [];
  let cur = [], curTokens = 0;
  for (const b of blocks) {
    const capped = b.map(capContent);
    const t = estimateHistoryTokens(capped);
    if (cur.length && curTokens + t > budgetTokens) { chunks.push(cur); cur = []; curTokens = 0; }
    cur.push(...capped); curTokens += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// 单次摘要调用(原内核体,45a 拆出以便 map-reduce 复用)。messages 为历史,prompt 追加于尾。
async function singleSummaryCall(provider, messages, model) {
  const base = providerBaseWithV1(provider.baseUrl);
  const chatUrl = base ? base + '/chat/completions' : '';
  const headers = { 'content-type': 'application/json' };
  const key = String(provider.apiKey || '').trim();
  if (key) headers['authorization'] = 'Bearer ' + key;
  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  // v0.8-S6: prepend the IDENTITY-ONLY layer so the summary call keeps the pinned identity (product name
  // never enters). identityOnly skips the capability/project layers — a摘要 call needs the pin, not the矩阵.
  const sysIdentity = buildProviderSystemPrompt(provider, model, '', [], null, null, null, true);
  const bodyObj = { model, messages: [{ role: 'system', content: sysIdentity }, ...messages, { role: 'user', content: SUMMARY_PROMPT }], stream: false };
  const temp = (provider.temperature !== '' && provider.temperature != null && Number.isFinite(Number(provider.temperature))) ? Number(provider.temperature) : undefined;
  if (temp !== undefined) bodyObj.temperature = temp;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, 60000) : null;
  try {
    const res = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: ctrl ? ctrl.signal : undefined });
    if (!res || !res.ok) {
      let d = ''; if (res) { try { d = await res.text(); } catch { /* ignore */ } }
      return { ok: false, error: `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 300)) : ''}` };
    }
    const j = await res.json().catch(() => null);
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    const summary = String((msg && msg.content) || '').trim();
    if (!summary) return { ok: false, error: 'provider returned an empty summary' };
    // v1.4-OSS 用量看板(补): 透传响应 usage + 实际用的 model + 对发送 payload 的输入估算,让压缩调用方记入 aux 台账。
    return { ok: true, summary, usage: (j && j.usage) || null, model, promptTokensEst: estimateHistoryTokens(bodyObj.messages) };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'AbortError') ? 'summary request timed out (60s)' : ((e && e.message) || 'summary request failed') };
  } finally { if (timer) clearTimeout(timer); }
}

async function providerSummaryCall(provider, history, opts) {
  const base = providerBaseWithV1(provider.baseUrl);
  const model = String(provider.model || (provider.models && provider.models[0] && provider.models[0].id) || '').trim();
  if (!base || !model || typeof fetch !== 'function') {
    return { ok: false, error: !base ? 'provider base URL is not set' : (!model ? 'no model selected for this provider' : 'fetch unavailable') };
  }
  // 45f 对抗轮 P3-6:无 user 消息的 history 不做摘要 —— 空摘要会把整段历史静默抹成一段「无内容」。
  if (!userBlockStarts(history).length) return { ok: false, error: 'no user turns to summarize' };
  // 45a:摘要输入预算 = 窗口 × 50%(余量留给输出+系统层;窗口缺省 64K 时预算 32K)。
  const budget = Math.max(4000, Math.floor(providerContextWindow(provider, model) * SUMMARY_INPUT_BUDGET_RATIO));
  const fitted = fitHistoryForSummary(history, budget);
  if (!fitted.needsMapReduce) {
    const sc = await singleSummaryCall(provider, fitted.messages, model);
    if (sc.ok && fitted.droppedMiddle) sc.droppedMiddle = fitted.droppedMiddle;
    return sc;
  }
  // map-reduce:分组 → 逐组摘要 → 总摘要。任一组失败即整体失败(错误原样上浮,调用方保留 L1 降级)。
  const chunks = chunkHistoryByBudget(history, budget);
  if (chunks.length <= 1) return singleSummaryCall(provider, chunks[0] || [], model);
  const partials = [];
  let aggIn = 0, aggOut = 0, aggEst = 0;
  for (const c of chunks) {
    const r = await singleSummaryCall(provider, c, model);
    if (!r.ok) return r;
    partials.push(r.summary);
    if (r.usage) { aggIn += Number(r.usage.prompt_tokens != null ? r.usage.prompt_tokens : r.usage.input_tokens) || 0; aggOut += Number(r.usage.completion_tokens != null ? r.usage.completion_tokens : r.usage.output_tokens) || 0; }
    aggEst += Number(r.promptTokensEst) || 0;
  }
  const joined = [{ role: 'user', content: partials.map((s, i) => `【分段摘要 ${i + 1}/${partials.length}】\n${s}`).join('\n\n') + '\n\n请把以上各分段摘要汇总为一份完整摘要。' }];
  const final = await singleSummaryCall(provider, joined, model);
  if (!final.ok) return final;
  if (final.usage) { final.usage.prompt_tokens = (Number(final.usage.prompt_tokens) || 0) + aggIn; final.usage.completion_tokens = (Number(final.usage.completion_tokens) || 0) + aggOut; }
  // 45f 对抗轮 P3-4a:总摘要无 usage 但分段有实测 → 分段实测不丢(挂到 final 上一起记账)。
  else if (aggIn > 0 || aggOut > 0) final.usage = { prompt_tokens: aggIn, completion_tokens: aggOut, aggregated: true };
  final.promptTokensEst = (Number(final.promptTokensEst) || 0) + aggEst;
  final.mapReduce = { chunks: chunks.length };
  return final;
}

// v1.4-OSS 用量看板(补): record a compaction summary call as an 'aux' ledger row (kind:'aux', note:'compact').
// Tokens from the response usage (prompt/completion, with input/output aliases); when the endpoint omits usage
// they are ESTIMATED from the sent payload + the returned summary and flagged estimated:true. Both compact call
// sites (manual runProviderCompact + auto maybeAutoCompact level-2) route through here. Fully defensive.
function recordCompactUsage(session, provider, sc) {
  try {
    if (!session || !provider || !sc || !sc.ok) return;
    let inTok = 0, outTok = 0, estimated = false;
    const u = sc.usage;
    const uIn = u ? (Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0) : 0;
    const uOut = u ? (Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0) : 0;
    if (uIn > 0 || uOut > 0) {
      // 45f 对抗轮 P3-4b:分项回退 —— usage 存在但某侧为 0(某些网关)时,该侧用估算补,另一侧保实测。
      inTok = uIn > 0 ? uIn : (Number(sc.promptTokensEst) || 0);
      outTok = uOut > 0 ? uOut : Math.round(estimateContentTokens(sc.summary || ''));
      estimated = (uIn <= 0 || uOut <= 0);
    } else { inTok = Number(sc.promptTokensEst) || 0; outTok = Math.round(estimateContentTokens(sc.summary || '')); estimated = true; }
    const { cost, currency } = computeProviderCost(provider, inTok, outTok);
    appendUsageLedger({
      sessionId: session.id, engine: 'openai', provider: provider.id, model: sc.model || provider.model || '',
      inTok, outTok, cost, currency, estimated, turnSeq: session.turnSeq, kind: 'aux', note: 'compact',
    });
  } catch { /* accounting must never break compaction */ }
}

// v0.8-S5 LEVEL 2 · SUMMARY RESEED boundary. Return the index in `history` of the 2nd-most-recent
// role:'user' message (= the start of the most recent 2 full turns). Everything before it will be replaced
// by [summary-user, ack-assistant]; everything from it onward is kept VERBATIM. Starting a kept slice at a
// user message is pairing-safe by construction (a user boundary never orphans a tool_call). Returns
// history.length (keep nothing) if fewer than 2 user messages exist.
function recentTurnsBoundary(history) {
  if (!Array.isArray(history)) return 0;
  let usersSeen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].role === 'user') { usersSeen++; if (usersSeen === 2) return i; }
  }
  return history.length; // <2 user messages → keep nothing (summary + ack only)
}

// 第28波(§28a):子代理回合的两级自动压缩 —— 对齐主回合 maybeAutoCompact,复用同款原语(evaporateHistory / L2 摘要内核
// providerSummaryCall / recentTurnsBoundary / recordCompactUsage)。此前 subHistory 单调增长无压缩(server.js 自认遗留),
// 长跑子代理大工具结果撑爆窗口 → 400 → 节点失败。返回是否压缩过;never throw(压缩绝不阻断子回合)。
// 【关键实现坑】subHistory 是 runSubAgentCore 里的 const,被 buildBody/markUsage/finalizer 闭包引用 —— L2 重播种必须【原地
// splice】替换内容,绝不能重新赋值(否则闭包仍指旧数组,压缩对已发请求体静默失效)。evaporate 本就原地改 content,天然安全。
// 【子代理专属】主回合无固定目标,子代理有单一 task(subHistory[0])—— L2 重播种【钉住 task[0]】,防摘要吞掉原始目标后跑偏。
async function maybeCompactSubHistory(opts) {
  const { subHistory, sys, provider, subModel, config, onEvent, subagentId, parentSession, tools } = opts || {};
  try {
    if (!Array.isArray(subHistory) || subHistory.length < 3 || !provider) return false;
    const budget = (Number(config && config.autoCompactThreshold) || 0.8) * providerContextWindow(provider, subModel);
    const withSys = h => [{ role: 'system', content: String(sys || '') }, ...h];
    const before = calibratedEstimate(provider, subModel, withSys(subHistory), tools); // 45d(a):校准后估算判预算(45f P3-3:子代理实际带 tools,估算口径必须含)
    if (before <= budget) return false;                          // append-only 到下次跨阈,与主回合同
    // L1 蒸发(逐字复用):把最近 2 个 assistant 回合之前的 role:'tool' 内容改写为占位。原地、幂等、配对安全。
    const evaporated = evaporateHistory(subHistory);
    const after1 = calibratedEstimate(provider, subModel, withSys(subHistory), tools); // 45d(a) 同上含 tools
    const emit = (mode, after) => { try { if (onEvent) onEvent({ type: 'compact', mode, subagentId, beforeTokens: before, afterTokens: after }); } catch { /* stream gone */ } };
    if (evaporated > 0 && after1 <= budget) { emit('evaporate', after1); return true; }
    // L2 摘要重播种(仍超预算):复用共用摘要内核。失败 → 保留 L1、不中断子回合(镜像主回合)。
    const sc = await providerSummaryCall(provider, subHistory);
    if (!sc || !sc.ok) { if (evaporated > 0) { emit('evaporate', after1); return true; } return false; }
    const boundary = recentTurnsBoundary(subHistory);
    const task0 = subHistory[0];
    const kept = subHistory.slice(boundary).filter(m => m !== task0); // 保留最近 2 个 user 回合逐字(user 边界起切,配对安全)
    // 钉住原始 task【并入】摘要 user 消息(而非单列)——避免 [task0-user, summary-user] 两条连续 user 破坏部分 provider 的
    // 交替契约;kept 以 user 边界起切,故 reseed 天然 user→assistant→user… 交替。
    const reseeded = [
      { role: 'user', content: '原始任务(保持聚焦):\n' + String((task0 && task0.content) || '') + '\n\n【前文已压缩为摘要】\n' + String(sc.summary || '') },
      { role: 'assistant', content: '已了解原任务与以上摘要,继续推进。' },
      ...kept,
    ];
    subHistory.splice(0, subHistory.length, ...reseeded);           // 原地 splice(const 绑定,闭包安全)——绝不重新赋值
    emit('summary', estimateHistoryTokens(withSys(subHistory)));
    try { if (parentSession) recordCompactUsage(parentSession, provider, sc); } catch { /* 记账失败不阻断 */ }
    return true;
  } catch { return false; }
}

// §5.2 (v0.7b) / v0.8-S5: server-side manual context compaction for a native (OpenAI-compatible) provider
// session. Now uses the SHARED summary kernel (providerSummaryCall) so the manual 🗜 endpoint and the
// auto-compact level-2 are the same code path. Collapses providerHistory to [summary-user, ack-assistant]
// and appends a system note. On any failure the history is left untouched. Returns { ok, ... }; never
// throws. Guarded by same-origin (mutating) upstream; NOT in needsToken.
async function runProviderCompact(sessionId) {
  const config = await readConfig();
  let session;
  try { session = await loadSession(String(sessionId || '')); }
  catch { return { ok: false, error: 'session not found' }; }
  if (!session) return { ok: false, error: 'session not found' };
  const provider = activeOpenAiProvider(config);
  if (!provider) return { ok: false, error: 'active engine is not an OpenAI-compatible provider' };
  const history = Array.isArray(session.providerHistory) ? session.providerHistory : [];
  if (!history.length) return { ok: false, error: 'no provider history to compact' };

  const sc = await providerSummaryCall(provider, history);
  if (!sc.ok) return { ok: false, error: sc.error };
  const summary = sc.summary;
  recordCompactUsage(session, provider, sc); // v1.4-OSS 用量看板(补): 手动压缩调用入 aux 台账

  const beforeTokens = estimateHistoryTokens(history);
  session.providerHistory = [
    { role: 'user', content: '(以下是此前对话的压缩摘要)\n' + summary },
    { role: 'assistant', content: '收到，已基于摘要继续。' },
  ];
  const afterTokens = estimateHistoryTokens(session.providerHistory);
  session.messages.push({
    role: 'system',
    content: `🗜 已压缩上下文：${fmtTokensServer(beforeTokens)}→约 ${fmtTokensServer(afterTokens)}（估算）`,
    createdAt: nowIso(), source: 'compact',
  });
  session.providerHistoryCursor = session.messages.length;
  await saveSession(session);
  logEvent({ kind: 'provider_compact', sessionId: session.id, provider: provider.id, summaryChars: summary.length, beforeTokens, afterTokens });
  return { ok: true, summaryChars: summary.length, beforeTokens, afterTokens };
}

// v0.8-S5 AUTO-COMPACTION driver (§7.7). Called at each provider-turn iteration boundary, BEFORE the next
// API call. If est([system, ...providerHistory]) exceeds threshold × contextWindow, run the two levels:
//   0. snapshot providerHistory → history-<turnSeq>.json.gz (safety net, non-blocking)
//   1. EVAPORATE old tool results → re-estimate → if still over →
//   2. SUMMARY RESEED (shared kernel): [summary-user, ack-assistant] + the last 2 full turns verbatim.
//      Level-2 failure (network/timeout) keeps the level-1 result and does NOT abort the turn.
// For each level that fires: emit a `compact` event {mode, beforeTokens, afterTokens} and append a 🗜
// system message to session.messages (reusing the existing compact-message render path). Mutates
// session.providerHistory / session.messages in place; the caller persists via its normal saveSession.
// Returns true if any compaction happened (caller may save immediately). Never throws.
async function maybeAutoCompact(session, provider, sys, config, onEvent, model, tools) {
  try {
    const history = session.providerHistory;
    if (!Array.isArray(history) || !history.length) return false;
    const threshold = Number(config.autoCompactThreshold) || 0.8;
    const budget = threshold * providerContextWindow(provider, model); // v1.0.2-S2: 传激活模型, 走三级解析
    const sysMsg = { role: 'system', content: String(sys || '') };
    const before = calibratedEstimate(provider, model, [sysMsg, ...history], tools); // 45d(a):校准后估算判预算
    if (before <= budget) return false; // under budget → nothing to do (append-only until next crossing)

    // Safety-net snapshot BEFORE any mutation (non-blocking on failure).
    await writeHistorySnapshot(session.id, session.turnSeq, history);

    let compacted = false;
    // ── Level 1: evaporate ──────────────────────────────────────────────────────────────────────────
    const evaporated = evaporateHistory(history);
    if (evaporated > 0) {
      const after1 = calibratedEstimate(provider, model, [sysMsg, ...history], tools); // 45d(a)
      onEvent({ type: 'compact', mode: 'evaporate', beforeTokens: before, afterTokens: after1 });
      session.messages.push({ role: 'system', content: `🗜 自动压缩（蒸发旧工具结果 ${evaporated} 条）：${fmtTokensServer(before)}→约 ${fmtTokensServer(after1)}（估算）`, createdAt: nowIso(), source: 'compact' });
      logEvent({ kind: 'auto_compact', mode: 'evaporate', sessionId: session.id, beforeTokens: before, afterTokens: after1, evaporated });
      compacted = true;
      if (after1 <= budget) { await saveSession(session).catch(() => {}); return true; } // level 1 was enough
    }

    // ── Level 2: summary reseed (still over budget) ─────────────────────────────────────────────────
    const before2 = calibratedEstimate(provider, model, [sysMsg, ...history], tools); // 45d(a)
    const sc = await providerSummaryCall(provider, history);
    if (!sc.ok) {
      // Level-2 failed (network/timeout). Keep the level-1 result and continue the turn — do NOT abort.
      logEvent({ kind: 'auto_compact', mode: 'summary', sessionId: session.id, ok: false, error: sc.error });
      if (compacted) await saveSession(session).catch(() => {});
      return compacted;
    }
    recordCompactUsage(session, provider, sc); // v1.4-OSS 用量看板(补): 自动压缩(L2 摘要)调用入 aux 台账
    const boundary = recentTurnsBoundary(history);
    const kept = history.slice(boundary); // last 2 full turns, verbatim (user-boundary → pairing-safe)
    session.providerHistory = [
      { role: 'user', content: '(以下是此前对话的压缩摘要)\n' + sc.summary },
      { role: 'assistant', content: '收到，已基于摘要继续。' },
      ...kept,
    ];
    const after2 = estimateHistoryTokens([sysMsg, ...session.providerHistory], '', tools);
    onEvent({ type: 'compact', mode: 'summary', beforeTokens: before2, afterTokens: after2 });
    session.messages.push({ role: 'system', content: `🗜 自动压缩（摘要重播种）：${fmtTokensServer(before2)}→约 ${fmtTokensServer(after2)}（估算）`, createdAt: nowIso(), source: 'compact' });
    logEvent({ kind: 'auto_compact', mode: 'summary', sessionId: session.id, ok: true, beforeTokens: before2, afterTokens: after2, summaryChars: sc.summary.length });
    await saveSession(session).catch(() => {});
    return true;
  } catch (e) {
    // Compaction is best-effort; a failure must never break the turn.
    try { logEvent({ kind: 'auto_compact', sessionId: session && session.id, ok: false, error: (e && e.message) || String(e) }); } catch { /* ignore */ }
    return false;
  }
}

// ============================================================================
// 第26波b(AUTONOMY-PLAN §26b):until-done 驱动器 —— 一次用户回合后,若会话有 until-done 账本,服务端在【同一个
// HTTP 响应流】上自动续跑,直到:①全部里程碑 done(mission_complete);②预算耗尽(archive-pause,非报错);
// ③停滞(digest K 轮不变 → 降 supervised + mission_stuck 卡片)。红线:驱动器不放宽任何权限(exec 弹窗照旧等人/
// 超时,权限门在各引擎内部,驱动器够不着也不试图绕);自动回合全额记账(runOpenAiTurn 内 appendUsageLedger 照常)。
async function runMissionDriver({ session, config, provider, emit, runTurn, getLastTokens, isAlive }) {
  const cwd = normalizeCwd(session.cwd, config.defaultWorkspace);
  const allDone = () => (session.mission.milestones.length > 0 && session.mission.milestones.every(m => m.status === 'done'));
  // 每轮:跑机器验收(自动标 done)→ 判完成/预算/停滞 → 决定停或续。
  for (let guard = 0; guard < 100; guard++) {   // guard 只是死循环兜底,真正上限是 maxAutoTurns
    const m = session.mission;
    if (!m || m.autoMode !== 'until-done') return;
    if (!isAlive()) return;   // 用户断开/停止 → 立即收手

    // ① 机器验收:pass 的 pending/blocked 里程碑标 done(证据落 evidence)。
    let checkedAny = false;
    for (const ms of m.milestones) {
      if (ms.status === 'done') continue;
      const r = await evaluateMissionCheck(ms.check, cwd);
      if (r) { checkedAny = true; if (r.pass) { ms.status = 'done'; ms.evidence = String(r.detail || '机器验收通过').slice(0, MISSION_MAX_TEXT); } }
    }
    if (checkedAny) { m.updatedAt = nowIso(); await saveSession(session).catch(() => {}); emit({ type: 'mission', mission: m }); }

    // ② 全部完成 → 收尾。
    if (allDone()) { m.autoMode = 'off'; m.updatedAt = nowIso(); await saveSession(session).catch(() => {}); emit({ type: 'mission', mission: m, state: 'complete' }); return; }

    // ③ 预算:自动续跑回合数 / token 上限。达上限 → 存档暂停(autoMode→supervised,保留进度,非报错)。
    if (m.spent.autoTurns >= m.budget.maxAutoTurns || (m.budget.maxTokens > 0 && m.spent.tokens >= m.budget.maxTokens)) {
      // 对抗轮 P2(#6): 只在【转入】耗尽时落一次审计账 —— 用户经 action:'update' 把 autoMode 重设回 until-done 后,
      // 预算仍是耗尽态(applyMissionUpdate 不改 budget/spent),驱动器每次再入都会立刻再命中本判定;若每次都 logEvent,
      // budgetExhausted 分子随再武装无限 +1 而分母(started)恒为 1,超支率可 >100%。budgetExhaustedAt 已置 = 本轮耗尽
      // 已记过,不重复落账(下次 start 全新任务时 normalizeMission prev=null 会清掉它,新任务的耗尽正常重记)。
      const firstExhaust = !m.budgetExhaustedAt;
      m.autoMode = 'supervised'; m.budgetExhaustedAt = m.budgetExhaustedAt || nowIso(); m.updatedAt = nowIso(); await saveSession(session).catch(() => {});
      if (firstExhaust) logEvent({ kind: 'mission_budget_exhausted', sessionId: session.id, autoTurns: m.spent.autoTurns, maxAutoTurns: m.budget.maxAutoTurns, tokens: m.spent.tokens, maxTokens: m.budget.maxTokens });
      emit({ type: 'mission', mission: m, state: 'budget_exhausted', reason: `自动推进预算已用尽(${m.spent.autoTurns}/${m.budget.maxAutoTurns} 回合),已暂停等待你的指示` });
      return;
    }

    // ④ 停滞:进度指纹连续 K 轮不变 → 降 supervised + 卡片(交给用户;可选一次重规划由用户触发)。
    const digest = missionProgressDigest(m);
    if (digest === m.stall.lastDigest) m.stall.sameCount = (Number(m.stall.sameCount) || 0) + 1;
    else { m.stall.lastDigest = digest; m.stall.sameCount = 0; }
    if (m.stall.sameCount >= MISSION_STALL_LIMIT) {
      m.autoMode = 'supervised'; m.updatedAt = nowIso(); await saveSession(session).catch(() => {});
      emit({ type: 'mission', mission: m, state: 'stuck', reason: `连续 ${m.stall.sameCount} 个回合无进展,已暂停。你可以补充信息、手动调整里程碑,或结束任务。` });
      return;
    }

    // ⑤ 续跑:构造推进消息(列出未完成里程碑),自动发起下一回合(全额记账,标 driverAuto)。
    // 对抗轮 P3: goal/desc 可被模型经 mission_update 写入 —— 扁平化空白后再拼进这条自动 user 消息,
    // 避免 desc 里的换行+指令伪装成额外的用户指令(与 digest 的 fence 纪律一致)。
    const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
    const pending = m.milestones.filter(ms => ms.status !== 'done');
    const contMsg = '请继续推进当前任务(Mission)。目标:' + flat(m.goal).slice(0, 300) + '\n未完成的里程碑:\n' +
      pending.map(ms => '- [' + flat(ms.id).slice(0, 64) + '] ' + flat(ms.desc).slice(0, 200)).join('\n') +
      '\n聚焦下一个里程碑,完成后用 mission_update 工具把它标 done 并附证据。若某步确实无法推进,请说明原因。';
    m.spent.autoTurns += 1;
    await saveSession(session).catch(() => {});
    emit({ type: 'mission', mission: m, state: 'continue', autoTurn: m.spent.autoTurns });
    await runTurn(contMsg, true);   // driverAuto=true
    if (getLastTokens) { try { session.mission.spent.tokens += Number(getLastTokens()) || 0; } catch {} }
  }
}

async function streamChat(req, res) {
  const body = await readJsonBody(req);
  const config = await readConfig();
  // A missing/corrupt session id must not crash the turn: fall back to a fresh session (loadSession
  // already isolated the corrupt file as .corrupt).
  const session = (body.sessionId ? await loadSession(body.sessionId) : null) || await createSession({ title: body.title, cwd: body.cwd });
  const attachments = body.attachments || [];

  // Lowest-latency streaming on loopback: no Nagle batching, flush headers immediately.
  try { req.socket.setNoDelay(true); } catch { /* ignore */ }
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  try { res.flushHeaders(); } catch { /* ignore */ }

  let finished = false;
  // Kill only when the streaming RESPONSE is actually disconnected. IncomingMessage's `close`
  // also fires after a normally-consumed request body on modern Node, so using req.close here can
  // terminate a healthy background turn when the UI opens another session.
  let disconnectHandled = false;
  const handleDisconnect = () => {
    if (finished || disconnectHandled) return;
    disconnectHandled = true;
    readConfig().then(cfg => { if (cfg.killOnDisconnect) stopSession(session.id, 'disconnected'); }).catch(() => {});
  };
  req.on('aborted', handleDisconnect);
  res.on('close', () => { if (!finished && !res.writableEnded) handleDisconnect(); });

  // 第26波b: 捕获每回合的 token 用量(账本预算计量)+ 停止信号。usage 事件透传不变,仅旁路记录。
  let lastTurnTokens = 0;
  let turnStopped = false;   // 对抗轮 P2: 回合被停止(/api/stop → stopSession → abort → 'process' state:'stopped')
  const emit = evt => {
    if (evt && evt.type === 'usage' && evt.usage) {
      const u = evt.usage;
      // 对抗轮 P3: 计入缓存 token —— Claude 引擎 cache_read/cache_creation 常占大头,漏计则 maxTokens 预算欠执行。
      lastTurnTokens = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    }
    if (evt && evt.type === 'process' && evt.state === 'stopped') turnStopped = true;
    try { res.write(`${JSON.stringify({ ...evt, ts: nowIso() })}\n`); } catch { /* client gone */ }
  };
  // 第27波:本次 HTTP 回合 = 一个「run」。登记活动 runId,scope:'run' 授权绑定它(含首回合内经 UI 签发的 bindNextRun 补绑)。
  const driverRunId = makeId('drun');
  bindDriverRun(session.id, driverRunId);
  try {
    emit({ type: 'session', session });
    const provider = activeOpenAiProvider(config);
    // 单回合执行器(首回合=用户消息带附件;账本续跑回合=driverAuto、无附件)。两引擎同签名。
    const runTurn = async (msg, driverAuto) => {
      lastTurnTokens = 0;
      const atts = driverAuto ? [] : attachments;
      // 第27f波:标记本会话处于无人值守回合(供 CLI 桥的权限超时→存档暂停判定;provider 路径用闭包 driverAuto)。serial 回合,进出平衡。
      if (driverAuto) driverAutoSessions.add(session.id);
      try {
        const turnAgentTeam = !driverAuto && body.agentTeam === true && Number(config.subagentMaxPerTurn) > 0;
        if (provider) await runOpenAiTurn({ session, message: String(msg || ''), attachments: atts, cwd: body.cwd, onEvent: emit, provider, config, driverAuto, agentTeam: turnAgentTeam });
        else await runClaudeTurn({ session, message: String(msg || ''), attachments: atts, cwd: body.cwd, onEvent: emit, driverAuto, agentTeam: turnAgentTeam });
      } finally { if (driverAuto) driverAutoSessions.delete(session.id); }
    };
    await runTurn(String(body.message || ''), false);
    // until-done 驱动器:仅当会话有活动账本才进(非账本会话零行为变化,与旧单回合完全等价)。
    // 对抗轮 P2: isAlive 同时看 turnStopped —— /api/stop(服务端 stopSession,不关 socket)也要能刹住驱动器,
    // 不能只靠客户端断连(否则脚本/代理调 /api/stop 后驱动器仍relaunch 到预算耗尽)。
    if (session.mission && session.mission.autoMode === 'until-done') {
      await runMissionDriver({ session, config, provider, emit, runTurn, getLastTokens: () => lastTurnTokens, isAlive: () => !disconnectHandled && !finished && !turnStopped });
    }
  } catch (err) {
    emit({ type: 'error', error: err.message || String(err) });
  } finally {
    finished = true;
    // 第27波:run 结束 → scope:'run' 授权蒸发(遍历删 runId 匹配项),登记表清理。scope:'session' 授权跨回合保留,直到
    // TTL/次数耗尽或显式撤销/切模式。
    try { revokeGrantsForRun(session.id, driverRunId); } catch { /* best-effort */ }
    if (activeDriverRuns.get(session.id) === driverRunId) activeDriverRuns.delete(session.id);
    res.end();
  }
}

// v1.0.1 编码修复:Windows 子进程(powershell/cmd/git/python…)在中文系统默认按 OEM 代码页(GBK/cp936)
// 输出,而非 UTF-8。此前 runProcess 按 UTF-8 逐块 toString → 中文全乱码(GBK 字节 c2a6c9bd… 被读成「¦ɽ」)。
// 修法:累积原始字节,收尾时智能解码——先按 UTF-8 解;若出现替换符(�,说明不是合法 UTF-8),退回 GBK。
// 我们自己以 UTF-8 输出的工具不受影响(合法 UTF-8 无替换符,原样保留),GBK 原生命令输出也能正确还原。
// **headless 安全**:纯 Node 侧解码,不依赖控制台——[Console]::OutputEncoding 那类 PS 方案在无窗口 spawn 下
// 会因无有效控制台句柄而静默失效(实测端到端仍乱码),Node 侧解码无此坑。
let _gbkDecoder = null;
function decodeBestEffort(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try { if (!_gbkDecoder) _gbkDecoder = new TextDecoder('gbk'); return _gbkDecoder.decode(buf); }
  catch { return utf8; } // 该 node 无 gbk ICU → 退回 UTF-8(至少不崩)
}
function runProcess(command, args, options = {}) {
  return new Promise(resolve => {
    const start = Date.now();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60000));
    const CAP = 2_000_000; // 字节上限(超出从最旧块丢弃,保留尾部,与旧行为一致)
    const outChunks = []; let outLen = 0;
    const errChunks = []; let errLen = 0;
    let timedOut = false;
    const collect = (chunks, d, isOut) => {
      chunks.push(d);
      if (isOut) { outLen += d.length; while (outLen > CAP && outChunks.length > 1) outLen -= outChunks.shift().length; }
      else { errLen += d.length; while (errLen > CAP && errChunks.length > 1) errLen -= errChunks.shift().length; }
    };
    // Transparently wrap .cmd/.bat targets (e.g. claude.cmd) so they don't throw "spawn EINVAL".
    const s = options.shell ? { command, args, opts: {} } : batchSafeSpawn(command, args);
    const child = cp.spawn(s.command, s.args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      shell: options.shell || false,
      ...s.opts,
    });
    // 审计 P2: 单次结算门 —— close/error/超时兜底三条路径共用,防重复 resolve。
    let settled = false;
    let killGraceTimer = null;
    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // 审计 P2: 超时用 killChildTree(taskkill /T /F)整树杀 —— child.kill('SIGTERM') 在 Windows 上只杀直接子
      // 进程,claude.cmd→node、shell→子命令等孙进程会遗孤泄漏,且其继承的 stdio 句柄不关 → 'close' 迟迟不触发,
      // promise 悬挂到远超 timeoutMs。killChildTree 内含 SIGKILL 兜底。
      killChildTree(child.pid);
      // 二次兜底:即便整树已杀,若仍有句柄让 'close' 不触发,3s 后硬 resolve,绝不让工具调用无限悬挂。
      killGraceTimer = setTimeout(() => finish({ ok: false, code: -1, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + '\n[timed out; process tree killed]', elapsedMs: Date.now() - start, timedOut: true }), 3000);
      if (killGraceTimer.unref) killGraceTimer.unref();
    }, timeoutMs);
    child.stdout?.on('data', d => collect(outChunks, d, true));
    child.stderr?.on('data', d => collect(errChunks, d, false));
    child.on('error', error => finish({ ok: false, code: -1, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + error.message, elapsedMs: Date.now() - start, timedOut }));
    child.on('close', code => finish({ ok: code === 0 && !timedOut, code, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)), elapsedMs: Date.now() - start, timedOut }));
  });
}

// v1.0.1 编码修复(输入侧):无控制台 spawn(用户双击运行时的真实场景)的 powershell.exe 解析 `-Command`
// 参数里的中文会损坏(实测「娄山关」→「|???」——输入阶段就丢字,非输出解码问题)。改用带 BOM 的 UTF-8
// 临时 .ps1 + `-File`:BOM 让 PS 无视控制台代码页、权威按 UTF-8 读脚本,中文 100% 正确进入。输出侧的 GBK
// 乱码由 runProcess 的 decodeBestEffort 兜底(先 UTF-8、有替换符退 GBK)。两侧合起来彻底解决中文乱码。
async function runPowerShell(command, cwd, timeoutMs) {
  const tmpFile = path.join(os.tmpdir(), `ruyi-ps-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  await fsp.writeFile(tmpFile, '﻿' + command, 'utf8'); // UTF-8 BOM(﻿)+ 命令 → PS -File 权威按 UTF-8 读
  try {
    return await runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile,
    ], { cwd: cwd || os.homedir(), timeoutMs });
  } finally {
    fsp.unlink(tmpFile).catch(() => {});
  }
}

// v1.0.2 返修三:reveal-in-explorer WITH foreground.  真机诊断(把关人亲验):/api/file/reveal 直接
// cp.spawn('explorer.exe','/select,…') 从【后台服务进程】启动时,资源管理器窗口开在浏览器【后面】—— Windows
// 前台锁不让后台进程抢占前台(实测:server 端点调用后 revfg 窗口数 +1 但前台仍是 chrome)。用户遂报「弹不出来」。
// 修:改由 PowerShell 助手打开/定位后,用 AttachThreadInput+SetForegroundWindow 把窗口提到最前(从前台锁绕行的
// 标准手法,已实测 claude→explorer 生效)。安全:目标路径经【环境变量 RUYI_REVEAL_PATH】传入,绝不拼进脚本文本
// → 零命令注入;脚本纯 ASCII + BOM 临时文件(v1.0.1 编码教训)。windowsHide 只作用于 powershell 自身(消除其
// 控制台闪窗),它 Start-Process 出来的 explorer 是独立进程、照常显示并被提前台(与 office_open 的 cmd/c start 同理)。
// mode:'select'=定位并选中 | 'open'=用默认程序打开(server 已对可执行/脚本降级为 select,见 buildRevealSpawn)。
const REVEAL_PS_SCRIPT = [
  "$target = $env:RUYI_REVEAL_PATH",
  "if (-not $target) { exit 2 }",
  "$mode = $env:RUYI_REVEAL_MODE; if (-not $mode) { $mode = 'select' }",
  "if ($mode -eq 'open') { Start-Process -FilePath $target; exit 0 }",
  "Add-Type -TypeDefinition @\"",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class RuyiFg {",
  "  [DllImport(\"user32.dll\")] static extern bool SetForegroundWindow(IntPtr h);",
  "  [DllImport(\"user32.dll\")] static extern IntPtr GetForegroundWindow();",
  "  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
  "  [DllImport(\"user32.dll\")] static extern bool AttachThreadInput(uint a, uint b, bool f);",
  "  [DllImport(\"user32.dll\")] static extern bool BringWindowToTop(IntPtr h);",
  "  [DllImport(\"user32.dll\")] static extern bool ShowWindow(IntPtr h, int n);",
  "  [DllImport(\"kernel32.dll\")] static extern uint GetCurrentThreadId();",
  "  public static void Force(long hw) {",
  "    IntPtr h = new IntPtr(hw);",
  "    if (h == IntPtr.Zero) return;",
  "    ShowWindow(h, 9);", // SW_RESTORE
  "    IntPtr fg = GetForegroundWindow();",
  "    uint pidA; uint tA = GetWindowThreadProcessId(fg, out pidA);",
  "    uint me = GetCurrentThreadId();",
  "    if (tA != me) AttachThreadInput(me, tA, true);",
  "    BringWindowToTop(h); SetForegroundWindow(h);",
  "    if (tA != me) AttachThreadInput(me, tA, false);",
  "  }",
  "}",
  "\"@",
  "Start-Process explorer.exe -ArgumentList ('/select,' + $target)",
  "Start-Sleep -Milliseconds 500",
  "$folder = (Split-Path -Parent $target).TrimEnd('\\')",
  "$sh = New-Object -ComObject Shell.Application",
  "foreach ($w in @($sh.Windows())) {",
  "  $u = $null; try { $u = $w.LocationURL } catch {}",
  "  if ($u) { try { if (([Uri]$u).LocalPath.TrimEnd('\\') -ieq $folder) { [RuyiFg]::Force([int64]$w.HWND); break } } catch {} }",
  "}",
  "exit 0",
].join('\r\n');
// Fire-and-forget reveal. Writes the BOM'd ASCII script to a temp .ps1 and spawns powershell with the target
// path in the environment (never in the argv/script text). Never throws to the caller — best-effort; the HTTP
// handler returns ok as soon as the spawn is initiated (matching prior behavior; the window appears ~1s later).
function revealInExplorer(absPath, mode) {
  const tmpFile = path.join(os.tmpdir(), `ruyi-reveal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  try {
    fs.writeFileSync(tmpFile, '﻿' + REVEAL_PS_SCRIPT, 'utf8'); // sync so the file exists before spawn reads it
    const child = cp.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
      stdio: 'ignore', windowsHide: true, // hides PS console only; Start-Process'd explorer still shows + foregrounds
      env: { ...process.env, RUYI_REVEAL_PATH: absPath, RUYI_REVEAL_MODE: (mode === 'open' ? 'open' : 'select') },
    });
    const cleanup = () => { fsp.unlink(tmpFile).catch(() => {}); };
    child.on('exit', cleanup);
    child.on('error', () => { // powershell missing → fall back to a plain (possibly-behind) explorer open
      cleanup();
      try { cp.spawn('explorer.exe', mode === 'open' ? [absPath] : ['/select,' + absPath], { detached: true, stdio: 'ignore' }).unref(); } catch { /* give up */ }
    });
    child.unref();
    return true;
  } catch (e) {
    fsp.unlink(tmpFile).catch(() => {});
    // Synchronous spawn failure → last-ditch direct explorer (opens, may be behind the browser).
    try { cp.spawn('explorer.exe', mode === 'open' ? [absPath] : ['/select,' + absPath], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
  }
}

// v0.9-S3 (C3): pop the native Windows folder picker (System.Windows.Forms.FolderBrowserDialog). The
// dialog REQUIRES a Single-Threaded Apartment — `powershell -STA` (WinForms deadlocks/misbehaves under the
// default MTA). Returns { ok:true, path } on selection, { ok:true, cancelled:true } on cancel, or
// { ok:false, error, hint } when unavailable (non-Windows, or WinForms can't load). 120s timeout: the user
// is interacting with a modal dialog, so this must outlast a normal tool. STDOUT = the selected path (or
// empty on cancel); we echo a sentinel prefix to disambiguate cancel from an empty selection.
async function pickFolder() {
  if (process.platform !== 'win32') {
    return { ok: false, error: '原生文件夹选择器仅支持 Windows', hint: '请在文件夹输入框中直接粘贴完整路径' };
  }
  // The script is passed to `-Command`; it Add-Types WinForms, shows the dialog, and prints either
  // "OK\t<path>" or "CANCEL". A failure to load WinForms throws and is caught below.
  // v1.0.2 返修:无 owner 的 ShowDialog() 常被压在浏览器窗口后面 —— 用户以为「点了没反应」(真机反馈
  // 「工作区改不了」的一大来源)。造一个隐形 TopMost owner form,对话框随 owner 置顶到最前。纯 ASCII 脚本
  // (v1.0.1 编码教训:-Command 里不放中文)。
  const script = "Add-Type -AssemblyName System.Windows.Forms; "
    + "$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; "
    + "$f.FormBorderStyle = 'None'; $f.Opacity = 0; "
    + "$f.StartPosition = 'CenterScreen'; $f.Show(); $f.Activate(); "
    + "$d = New-Object System.Windows.Forms.FolderBrowserDialog; "
    // v1.0.2 返修·致命修复:原脚本写 ('OK`t' + …) —— PowerShell 单引号字符串里反引号【不】转义,输出的是
    // 字面 OK`t 而非 TAB,下方 /^OK\t/ 正则永不匹配 → 用户选好的路径被当「取消」静默丢弃。原生选择器自
    // v0.9-S3 上线起从未真正工作过(真弹窗无法进自动化 e2e,一直漏网;Node spawn 实测复现)。改用 [char]9
    // 显式拼 TAB,协议两侧终于一致。
    + "if ($d.ShowDialog($f) -eq 'OK') { Write-Output ('OK' + [char]9 + $d.SelectedPath) } else { Write-Output 'CANCEL' }; "
    + "$f.Close()";
  let result;
  try {
    // -STA is the load-bearing flag (COM/WinForms apartment). windowsHide would hide the dialog too, so
    // runProcess must NOT hide the window here — runProcess sets windowsHide:true, but the modal dialog is
    // owned by the STA message loop and still shows; the parent console stays hidden which is fine.
    result = await runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script,
    ], { cwd: os.homedir(), timeoutMs: 120000 });
  } catch (e) {
    return { ok: false, error: '无法启动文件夹选择器: ' + (e && e.message || e), hint: '请在文件夹输入框中直接粘贴完整路径' };
  }
  const out = String((result && result.stdout) || '').trim();
  // WinForms load failure surfaces on stderr with a non-zero exit → treat as unavailable.
  if (result && result.ok === false && !out) {
    return { ok: false, error: String(result.stderr || '选择器不可用').slice(0, 400), hint: '请在文件夹输入框中直接粘贴完整路径' };
  }
  if (/^CANCEL$/m.test(out) || out === '') return { ok: true, cancelled: true };
  const m = out.match(/^OK\t(.+)$/m);
  if (m && m[1].trim()) return { ok: true, path: path.resolve(m[1].trim()) };
  // Unexpected shape → treat as cancel rather than inventing a path.
  return { ok: true, cancelled: true };
}
