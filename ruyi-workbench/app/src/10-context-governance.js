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
// A2: base64 图片字段专用处理 —— 60KB 平切会把 base64 从【中间】切断,返回给模型的是无法解码的坏图。
// 识别 JSON 里的图片 base64 字段(字段名含 image/base64/screenshot/thumbnail/b64,值 ≥8000 个 base64 字符,
// 或带 data:image/ 前缀),把超长 base64 值【整体】替换为短占位 —— 要么完整图,要么明确「图被裁」,
// 绝不产生半截坏图。替换后仍超限才回退平切(此时 base64 已缩为占位,平切不再切到图)。
// 字段名白名单覆盖 ACC 截图族(image / image_base64)与常见 MCP 图片约定,值长度门槛防误伤非图大字段。
const IMG_B64_TRIM_RE = /("(?:[A-Za-z0-9_]*?(?:image|base64|screenshot|thumbnail|b64)[A-Za-z0-9_]*?)"\s*:\s*")((?:data:[a-z0-9+.-]+\/[a-z0-9+.-]+;base64,)?[A-Za-z0-9+/=]{8000,})/g;

function truncateToolResult(name, jsonStr) {
  const s = String(jsonStr == null ? '' : jsonStr);
  if (s.length <= TOOL_RESULT_CAP) return s;
  if (name === 'file_read') {
    const head = s.slice(0, FILE_READ_HEAD);
    const tail = s.slice(s.length - FILE_READ_TAIL);
    return head + `\n[...中间已截断，共 ${s.length} 字符...]\n` + tail;
  }
  // A2: 先试图片字段压缩(整体替换,不切中间)。
  const trimmed = s.replace(IMG_B64_TRIM_RE, (match, pre, b64) => {
    const n = b64.length;
    return `${pre}[base64 image: ${n} chars trimmed to keep tool-result within the ${TOOL_RESULT_CAP}-char budget; image is intact upstream — re-fetch with a smaller max_width / region if the visual is needed]`;
  });
  if (trimmed.length <= TOOL_RESULT_CAP) return trimmed;
  // 回退平切:用 trimmed 而非原始 s —— 图片字段已缩为占位,平切不再切到任何 base64 中间(只切文本)。
  return trimmed.slice(0, TOOL_RESULT_CAP) + `\n[...已截断，共 ${s.length} 字符，仅保留前 ${TOOL_RESULT_CAP} 字符；如需完整结果请用更精确参数（如 offset/limit、maxResults、region、max_width）重新获取...]\n`;
}

// v0.8-S5 checkpoint SAFETY NET (not a gate): snapshot providerHistory BEFORE a compaction to
// dataRoot/checkpoints/<sessionId>/history-<turnSeq>[<-contentHash>].json.gz (built-in zlib; S4a dir
// convention). The hash suffix is used only by 20-C1 so repeated compactions in one turn cannot overwrite
// a raw observation referenced by an earlier compacted model view. A
// failure here MUST NOT block the compaction or the turn — it is a recovery aid, not a precondition.
async function writeHistorySnapshot(sessionId, turnSeq, history, stableRef = false) {
  try {
    if (!sessionId || !Array.isArray(history)) return '';
    const dir = journalDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    const raw = JSON.stringify(history);
    const snapshotHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const gz = zlib.gzipSync(Buffer.from(raw, 'utf8'));
    const turn = Number(turnSeq) || 0;
    const file = stableRef ? `history-${turn}-${snapshotHash}.json.gz` : `history-${turn}.json.gz`;
    const target = path.join(dir, file);
    const previousSize = await fsp.stat(target).then(st => st.size).catch(() => 0);
    await fsp.writeFile(target, gz);
    // PF1 fix: these history snapshots land in the SAME checkpoints/<id>/ tree the global size cap governs, but
    // only journalRecord used to keep the byte cache current. A compaction-heavy / edit-light session (each
    // auto-compact can write several MB here, and per-session GC never prunes these files) grew the real tree
    // WITHOUT moving the cache, so needSweep stayed false and the hard cap silently became a soft one.
    // (a) account the net snapshot-byte delta (content-hashed C1 snapshots are often reused across repeated
    //     threshold checks; counting every overwrite as a new file would trigger needless global sweeps);
    // (b) give the sweep a chance to run: journalGc is otherwise only called on file writes, which are rare in a
    //     compaction-heavy load. Run it UNDER the per-session write lock so its index read-modify-write can't
    //     race a concurrent journalRecord (the v1.4.1 audit #8 lost-write hazard). Fire-and-forget: a recovery
    //     aid must never block or fail the compaction.
    journalBytesAdjust(gz.length - previousSize);
    withJournalWriteLock(sessionId, () => journalGc(sessionId)).catch(() => {});
    return stableRef ? `history:${turn}:${snapshotHash}` : `history:${turn}`;
  } catch { return ''; /* safety net, never fatal */ }
}

const OBSERVATION_REDUCE_MIN = 1200;
const OBSERVATION_TEXT_HEAD = 900;
const OBSERVATION_TEXT_TAIL = 500;
const OBSERVATION_ARRAY_SAMPLE = 8;
const OBSERVATION_OBJECT_KEYS = 32;
const OBSERVATION_CRITICAL_KEYS = new Set(['ok', 'error', 'errors', 'message', 'detail', 'status', 'statusCode', 'code', 'exitCode', 'stderr', 'query', 'path', 'url', 'finalUrl', 'count', 'total', 'totalLines', 'matches', 'findings', 'results']);

function observationToolNames(history) {
  const out = new Map();
  for (const message of Array.isArray(history) ? history : []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = call && call.id; const name = call && call.function && call.function.name;
      if (id && name) out.set(String(id), String(name));
    }
  }
  return out;
}

function protectedObservation(toolName, message) {
  const content = String(message && message.content || '');
  if (message && (message.pinned || message.evidenceRef || message.protected)) return 'explicit';
  if (/"ok"\s*:\s*false|"error"\s*:\s*"[^"\r\n]+|"errors"\s*:\s*\[(?!\s*\])|verification.{0,20}fail|quality.{0,12}gate|验证失败|校验失败/i.test(content)) return 'failure_evidence';
  if (/"op"\s*:\s*"(create|modify|delete|move|copy)"|checkpoint|journal/i.test(content)) return 'change_evidence';
  if (/(^|__)(file_(write|edit|delete|move|copy)|git_commit|http_download|archive_(zip|unzip))$/i.test(String(toolName || ''))) return 'mutating_tool';
  return '';
}

function compactObservationValue(value, key, depth) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const cap = /stderr|error|message|detail/i.test(String(key || '')) ? 4000 : 1800;
    if (value.length <= cap) return value;
    const head = Math.min(1200, Math.floor(cap * 0.65)); const tail = Math.min(700, cap - head);
    return value.slice(0, head) + `\n[...${value.length - head - tail} chars omitted...]\n` + value.slice(-tail);
  }
  if (depth >= 5) return `[nested value omitted at depth ${depth}]`;
  if (Array.isArray(value)) {
    const sample = value.slice(0, OBSERVATION_ARRAY_SAMPLE).map(v => compactObservationValue(v, key, depth + 1));
    if (value.length > sample.length) sample.push({ _ruyiOmittedItems: value.length - sample.length, _ruyiTotalItems: value.length });
    return sample;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const ordered = [...keys.filter(k => OBSERVATION_CRITICAL_KEYS.has(k)), ...keys.filter(k => !OBSERVATION_CRITICAL_KEYS.has(k))];
    const selected = ordered.slice(0, OBSERVATION_OBJECT_KEYS); const out = {};
    for (const childKey of selected) out[childKey] = compactObservationValue(value[childKey], childKey, depth + 1);
    if (keys.length > selected.length) out._ruyiOmittedKeys = keys.length - selected.length;
    return out;
  }
  return String(value);
}

function reduceObservationContent(toolName, content, rawRef) {
  const original = String(content == null ? '' : content);
  if (original.length < OBSERVATION_REDUCE_MIN) return { reduced: false, content: original, policy: 'below_minimum', originalChars: original.length, visibleChars: original.length, rawRef };
  const baseName = String(toolName || '').replace(/^.+?__/, '');
  let parsed = null; try { parsed = JSON.parse(original); } catch { /* text result */ }
  let visible, policy;
  if (parsed && typeof parsed === 'object') {
    const reduced = compactObservationValue(parsed, '', 0);
    policy = /shell|powershell|script/i.test(baseName) ? 'shell_structured' : (/search|find|glob|list/i.test(baseName) ? 'search_structured' : (/web|http|fetch|download/i.test(baseName) ? 'network_structured' : 'json_structured'));
    const meta = { reduced: true, policy, originalChars: original.length, rawRef };
    if (Array.isArray(reduced)) visible = JSON.stringify({ items: reduced, _ruyiObservation: meta });
    else {
      if (reduced && typeof reduced === 'object') reduced._ruyiObservation = meta;
      visible = JSON.stringify(reduced);
    }
  } else {
    policy = 'text_head_tail';
    visible = `[Ruyi observation reduced · policy=${policy} · originalChars=${original.length} · rawRef=${rawRef}]\n`
      + original.slice(0, OBSERVATION_TEXT_HEAD)
      + `\n[...${Math.max(0, original.length - OBSERVATION_TEXT_HEAD - OBSERVATION_TEXT_TAIL)} chars omitted...]\n`
      + original.slice(-OBSERVATION_TEXT_TAIL);
  }
  // Deep/wide JSON can still remain large after structural sampling. Apply a deterministic final envelope;
  // canonical bytes remain in the pre-compaction snapshot referenced by rawRef.
  if (visible.length > 6000) visible = visible.slice(0, 4000) + `\n[...reduced view trimmed from ${visible.length} chars...]\n` + visible.slice(-1500);
  if (visible.length >= original.length) return { reduced: false, content: original, policy: 'no_gain', originalChars: original.length, visibleChars: original.length, rawRef };
  return { reduced: true, content: visible, policy, originalChars: original.length, visibleChars: visible.length, rawRef };
}

// Internal recovery primitive for diagnostics/tests and a future reviewed Recovery Brief. It never exposes a
// filesystem path and validates both the stable snapshot hash and the observation content hash before return.
async function rehydrateObservation(sessionId, rawRef) {
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(sessionId || ''))) return { ok: false, error: 'invalid session id' };
    const m = /^history:(\d+):([a-f0-9]{16}):(\d+):([a-f0-9]{16})$/.exec(String(rawRef || ''));
    if (!m) return { ok: false, error: 'invalid rawRef' };
    const file = path.join(journalDir(sessionId), `history-${m[1]}-${m[2]}.json.gz`);
    const history = JSON.parse(zlib.gunzipSync(await fsp.readFile(file)).toString('utf8'));
    const item = Array.isArray(history) ? history[Number(m[3])] : null;
    if (!item || item.role !== 'tool' || typeof item.content !== 'string') return { ok: false, error: 'observation not found' };
    const actual = crypto.createHash('sha256').update(item.content).digest('hex').slice(0, 16);
    if (actual !== m[4]) return { ok: false, error: 'observation hash mismatch' };
    return { ok: true, content: item.content, toolCallId: item.tool_call_id || '', rawRef: String(rawRef) };
  } catch (e) { return { ok: false, error: (e && e.code) || 'rehydrate failed' }; }
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
function evaporateHistory(history, opts) {
  if (!Array.isArray(history) || !history.length) return 0;
  // Find the index of the 2nd-most-recent assistant message. Tool messages at or after it are within the
  // "recent 2 assistant turns" window and are preserved verbatim.
  let assistantsSeen = 0, boundary = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'assistant') { assistantsSeen++; if (assistantsSeen === 2) { boundary = i; break; } }
  }
  const useReducer = !!(opts && opts.config && opts.config.runtimeObservationReducerV1 === true && opts.rawRefPrefix);
  const toolNames = useReducer ? observationToolNames(history) : null;
  let count = 0;
  for (let i = 0; i < boundary; i++) {
    const m = history[i];
    if (!m || m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (m.content.startsWith(EVAPORATED_PREFIX)) continue; // already evaporated → skip (idempotent, cache-safe)
    const toolName = toolNames ? (toolNames.get(String(m.tool_call_id || '')) || '') : '';
    const protectedReason = useReducer ? protectedObservation(toolName, m) : '';
    if (protectedReason) continue;
    if (useReducer) {
      const contentHash = crypto.createHash('sha256').update(m.content).digest('hex').slice(0, 16);
      const reduced = reduceObservationContent(toolName, m.content, `${opts.rawRefPrefix}:${i}:${contentHash}`);
      if (!reduced.reduced) continue;
      m.content = reduced.content; count++;
      if (typeof opts.onReduced === 'function') {
        try { opts.onReduced({ toolName, toolCallId: m.tool_call_id || '', index: i, policy: reduced.policy, originalChars: reduced.originalChars, visibleChars: reduced.visibleChars, rawRef: reduced.rawRef }); } catch { /* observer only */ }
      }
      continue;
    }
    if (m.pinned) continue;  // C1b:显式锚定的关键信息不蒸发(预留接口:当前无消息级设置点——session.pinned 是 UI 固定会话,不在此;生效的锚定是下行写操作自动保留)
    if (/"op"\s*:\s*"(create|modify|delete|move|copy)"/.test(m.content)) continue;  // C1b:写操作关键变更自动保留(回滚/审计依赖,不蒸发)
    m.content = EVAPORATED_PREFIX + m.content.slice(0, 120) + ']';
    count++;
  }
  return count;
}

// True shadow evaluation for 20-C1. Both policies run on shallow message copies; the live providerHistory
// and its cache-friendly prefix remain untouched. Only aggregate sizes/counts leave this function: candidate
// rawRefs and observation bytes are deliberately excluded from telemetry.
function measureObservationReductionShadow(history) {
  const startedAt = process.hrtime.bigint();
  if (!Array.isArray(history) || !history.length) {
    return { observationCount: 0, baselineReducedCount: 0, candidateReducedCount: 0, originalChars: 0, baselineVisibleChars: 0, candidateVisibleChars: 0, baselineReductionRate: 0, candidateReductionRate: 0, protectedCount: 0, elapsedMs: 0 };
  }
  let assistantsSeen = 0, boundary = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].role === 'assistant') { assistantsSeen++; if (assistantsSeen === 2) { boundary = i; break; } }
  }
  const coldIndexes = [];
  for (let i = 0; i < boundary; i++) {
    const message = history[i];
    if (message && message.role === 'tool' && typeof message.content === 'string' && !message.content.startsWith(EVAPORATED_PREFIX)) coldIndexes.push(i);
  }
  const copy = () => history.map(message => message && message.role === 'tool' ? { ...message } : message);
  const baselineHistory = copy();
  const candidateHistory = copy();
  const baselineReducedCount = evaporateHistory(baselineHistory);
  const candidateReducedCount = evaporateHistory(candidateHistory, {
    config: { runtimeObservationReducerV1: true },
    rawRefPrefix: 'history:0:0000000000000000',
  });
  const toolNames = observationToolNames(history);
  let originalChars = 0, baselineVisibleChars = 0, candidateVisibleChars = 0, protectedCount = 0;
  for (const index of coldIndexes) {
    const original = history[index];
    originalChars += original.content.length;
    baselineVisibleChars += String(baselineHistory[index].content || '').length;
    candidateVisibleChars += String(candidateHistory[index].content || '').length;
    const toolName = toolNames.get(String(original.tool_call_id || '')) || '';
    if (protectedObservation(toolName, original)) protectedCount++;
  }
  const rate = visible => originalChars > 0 ? Number(((originalChars - visible) / originalChars).toFixed(4)) : 0;
  return {
    observationCount: coldIndexes.length,
    baselineReducedCount,
    candidateReducedCount,
    originalChars,
    baselineVisibleChars,
    candidateVisibleChars,
    baselineReductionRate: rate(baselineVisibleChars),
    candidateReductionRate: rate(candidateVisibleChars),
    protectedCount,
    elapsedMs: Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(3)),
  };
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
// 22-S0 热点基线实测(2026-08-27):单发摘要输入到 60K token 时,glm-5.3-flash 的正常耗时已在
// 40–51s,旧 60s 远程超时等于踩悬崖 —— 真实 dogfood 一天 30 次 L2 里 26 次超时作废。
// ① 远程超时提到 180s(localhost/Ollama 维持 300s);② 本可单发但预估超过此阈值的输入强制走
// map-reduce 分块,让每次真实 HTTP 尝试天然远离超时线。
const SUMMARY_SINGLE_SHOT_MAX_EST = 32000;
const SUMMARY_PROMPT = '请把以上对话压缩为结构化摘要,严格按以下四节输出(某节无内容写「无」):\n'
  + '【目标】用户的核心目标与关键约束\n'
  + '【已确认的决定】已拍板的事实、方案选择、用户偏好\n'
  + '【未完成事项】待办、进行中的工作、悬而未决的问题\n'
  + '【关键文件与上下文】涉及的文件/路径、代码要点、重要数据与结论\n'
  + '保真要求(45e 实测基线驱动):关键名词必须【原样】保留 —— 代号/暗号、数字与量级、日期、人名、'
  + '文件路径、版本号、明确的禁令与约束,一律不得泛化或省略;宁多勿漏,每节列要点,不要写成一段概括。\n'
  + '只输出摘要本身。';

function validateStructuredSummary(summary) {
  if (!summary || typeof summary !== 'string') return false;
  // 每节接受 中文标题 或 常见英文变体(英文模型可能按英文输出;SUMMARY_PROMPT 为中文硬编码,
  // 故英文变体用独立标题词,避免与正文内容误匹配)。
  const sections = [
    ['【目标】', '## Goal', 'Goal:'],
    ['【已确认的决定】', '## Decisions', 'Decisions:'],
    ['【未完成事项】', '## Open', 'Open items:', 'Todo:'],
    ['【关键文件与上下文】', '## Files', 'Files:', 'Key files'],
  ];
  const found = sections.filter(sec => sec.some(s => summary.includes(s))).length;
  return found >= 3;  // C1a:至少 3 节(允许某节"无"),防摘要退化为流水 -> 校验失败则调用方降级保留原文
}
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
  // Never silently discard the middle of a conversation. A small-window summarizer must see every user
  // block through map-reduce; the head/marker/tail projection remains useful to diagnostics and callers
  // that only need a preview, but the summary kernel treats any omitted middle as map-reduce-required.
  if (estimateHistoryTokens(fitted) <= budgetTokens) return { messages: fitted, droppedMiddle: middleCount, needsMapReduce: true };
  return { messages: history.slice(), droppedMiddle: 0, needsMapReduce: true }; // 头尾本身已超 → map-reduce
}

// map-reduce 分组(45a):正常回合按 user 块聚合。一个 user 回合可能包含上百条 assistant/tool
// 消息（长 Agent 工具循环），整块可远超预算；这种块不能只截每条消息后继续整块发送，也不能在
// tool_call/tool_result 中间硬切。把超大块无损序列化成带角色标签的纯文本 transcript，再按实测
// token 估算切成独立 user 片段：既不触发 Provider 的工具配对校验，也不会丢掉块的中后段。
function chunkHistoryByBudget(history, budgetTokens) {
  const starts = userBlockStarts(history);
  const blocks = [];
  for (let i = 0; i < starts.length; i++) blocks.push(history.slice(starts[i], starts[i + 1] || history.length));
  const transcriptText = block => block.map(message => {
    const role = message && message.role === 'user' ? '用户' : (message && message.role === 'assistant' ? '助手' : `工具${message && message.name ? ` ${message.name}` : ''}`);
    const content = typeof (message && message.content) === 'string' ? message.content : JSON.stringify(message && message.content || '');
    const calls = Array.isArray(message && message.tool_calls) && message.tool_calls.length ? `\n[工具调用] ${JSON.stringify(message.tool_calls)}` : '';
    return `【${role}】\n${content}${calls}`;
  }).join('\n\n');
  const splitTranscript = block => {
    const text = transcriptText(block);
    const pieces = [];
    let offset = 0;
    while (offset < text.length) {
      // Binary-search the largest lossless slice that fits. Transcript content ranges from CJK prose
      // (~1.5 chars/token) to JSON/tool output (~3.6 chars/token), so a fixed character ratio either
      // overflows CJK or creates twice as many slow local-model calls for ASCII-heavy histories.
      let low = offset + 1, high = text.length, end = low, row = null;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = { role: 'user', content: `【超长回合分片】\n${text.slice(offset, mid)}` };
        if (estimateHistoryTokens([candidate]) <= budgetTokens) { end = mid; row = candidate; low = mid + 1; }
        else high = mid - 1;
      }
      if (!row) row = { role: 'user', content: `【超长回合分片】\n${text.slice(offset, end)}` };
      pieces.push([row]);
      offset = end;
    }
    return pieces;
  };
  const chunks = [];
  let cur = [], curTokens = 0;
  for (const b of blocks) {
    const t = estimateHistoryTokens(b);
    if (t > budgetTokens) {
      if (cur.length) { chunks.push(cur); cur = []; curTokens = 0; }
      chunks.push(...splitTranscript(b));
      continue;
    }
    if (cur.length && curTokens + t > budgetTokens) { chunks.push(cur); cur = []; curTokens = 0; }
    cur.push(...b); curTokens += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// 单次摘要调用(原内核体,45a 拆出以便 map-reduce 复用)。messages 为历史,prompt 追加于尾。
// v1.7: follows provider.apiStyle — Responses protocol uses instructions+input, reads output_text.
// 22-§4.2 第0步:econCtx.econ 为真时,每次真实 HTTP 尝试(成功或失败)落一条 econ_summary_call ——
// 此前摘要/压缩调用完全不在经济性账本里,报表的 callsPerTask 系统性漏掉它们(归属缺口由本行修复)。
let ECON_AUX_FLAG_CACHE = { at: 0, on: false };
async function economicsShadowEnabledCached() { // 60s 内缓存,避免压缩路径上反复读盘
  if (Date.now() - ECON_AUX_FLAG_CACHE.at < 60000) return ECON_AUX_FLAG_CACHE.on;
  try {
    const cfg = await readConfig();
    ECON_AUX_FLAG_CACHE = { at: Date.now(), on: cfg && cfg.toolEconomicsShadowV1 === true };
  } catch { /* keep previous cached value */ }
  return ECON_AUX_FLAG_CACHE.on;
}
async function singleSummaryCall(provider, messages, model, econCtx) {
  const respStyle = provider && provider.apiStyle === 'responses';
  // 对抗轮(open-risk):responses 用 providerResponsesBase(不加 /v1,与官方 SDK 示例一致)。
  const base = respStyle ? providerResponsesBase(provider.baseUrl) : providerBaseWithV1(provider.baseUrl);
  const chatUrl = base ? base + (respStyle ? '/responses' : '/chat/completions') : '';
  const headers = { 'content-type': 'application/json' };
  const key = String(provider.apiKey || '').trim();
  if (key) headers['authorization'] = 'Bearer ' + key;
  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  // v0.8-S6: prepend the IDENTITY-ONLY layer so the summary call keeps the pinned identity (product name
  // never enters). identityOnly skips the capability/project layers — a摘要 call needs the pin, not the矩阵.
  const sysIdentity = buildProviderSystemPrompt(provider, model, '', [], null, null, null, true);
  const bodyObj = applyProviderReasoningEffort(respStyle
    ? { model, instructions: sysIdentity, input: buildResponsesInputItems([{ role: 'system', content: sysIdentity }, ...messages, { role: 'user', content: SUMMARY_PROMPT }]), stream: false }
    : { model, messages: [{ role: 'system', content: sysIdentity }, ...messages, { role: 'user', content: SUMMARY_PROMPT }], stream: false }, provider, respStyle ? 'responses' : 'chat');
  const temp = (provider.temperature !== '' && provider.temperature != null && Number.isFinite(Number(provider.temperature))) ? Number(provider.temperature) : undefined;
  if (temp !== undefined) bodyObj.temperature = temp;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timeoutMs = 180000; // 远程默认 3 分钟:实测 60K token 摘要 p50≈45–51s,60s 会整批作废(22-S0 热点基线)
  try {
    const u = new URL(String(provider && provider.baseUrl || ''));
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname) || /ollama/i.test(String(provider && (provider.id + ' ' + provider.label) || ''))) timeoutMs = 300000;
  } catch { /* retain remote default */ }
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
  const econT0 = Date.now();
  const econDone = result => { // 摘要调用账目:usage 缺失时 usageSource='missing',不推算不冒充
    try {
      if (!econCtx || econCtx.econ !== true) return;
      const u = result && result.usage;
      const uIn = u ? (Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0) : 0;
      const uOut = u ? (Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0) : 0;
      const okRes = !!(result && result.ok);
      const hasUsage = uIn > 0 || uOut > 0;
      logEvent({
        kind: 'econ_summary_call',
        ...(econCtx.sessionId ? { sessionId: econCtx.sessionId } : {}),
        ...(econCtx.turnSeq != null && Number(econCtx.turnSeq) > 0 ? { turnSeq: Number(econCtx.turnSeq) } : {}),
        ...(econCtx.traceId ? { traceId: econCtx.traceId } : {}),
        ...(econCtx.subagentId ? { subagentId: String(econCtx.subagentId) } : {}),
        trigger: String(econCtx.trigger || 'summary'),
        model: String(model || ''), apiStyle: respStyle ? 'responses' : 'chat',
        ok: okRes,
        usageSource: okRes && hasUsage ? 'provider' : 'missing',
        inputTokens: uIn, outputTokens: uOut,
        ...(okRes && hasUsage && typeof cachedInputTokensFromUsage === 'function' ? { cachedInputTokens: Math.min(uIn, cachedInputTokensFromUsage(u)) } : {}),
        ...(econCtx.chunkIndex ? { mapReduceChunk: Number(econCtx.chunkIndex) } : {}),
        httpMs: Date.now() - econT0,
      });
    } catch { /* shadow accounting must never break compaction */ }
  };
  try {
    const res = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: ctrl ? ctrl.signal : undefined });
    if (!res || !res.ok) {
      let d = ''; if (res) { try { d = await res.text(); } catch { /* ignore */ } }
      const failed = { ok: false, error: `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 300)) : ''}` };
      econDone(failed); return failed;
    }
    const j = await res.json().catch(() => null);
    let summary = '';
    if (respStyle) {
      for (const item of (Array.isArray(j && j.output) ? j.output : [])) {
        if (item && item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) { if (part && (part.type === 'output_text' || part.type === 'input_text') && typeof part.text === 'string') summary += part.text; }
        }
      }
    } else {
      const msg = j && j.choices && j.choices[0] && j.choices[0].message;
      summary = String((msg && msg.content) || '');
    }
    summary = summary.trim();
    if (!summary) { const failed = { ok: false, error: 'provider returned an empty summary' }; econDone(failed); return failed; }
    // v1.4-OSS 用量看板(补): 透传响应 usage + 实际用的 model + 对发送 payload 的输入估算,让压缩调用方记入 aux 台账。
    const okRes = { ok: true, summary, usage: (j && j.usage) || null, model, promptTokensEst: estimateHistoryTokens(bodyObj.messages || bodyObj.input) };
    econDone(okRes); return okRes;
  } catch (e) {
    const failed = { ok: false, error: (e && e.name === 'AbortError') ? `summary request timed out (${Math.round(timeoutMs / 1000)}s)` : ((e && e.message) || 'summary request failed') };
    econDone(failed); return failed;
  } finally { if (timer) clearTimeout(timer); }
}

async function providerSummaryCall(provider, history, opts) {
  const base = providerBaseWithV1(provider.baseUrl);
  const model = String((opts && opts.model) || provider.model || (provider.models && provider.models[0] && provider.models[0].id) || '').trim();
  if (!base || !model || typeof fetch !== 'function') {
    return { ok: false, error: !base ? 'provider base URL is not set' : (!model ? 'no model selected for this provider' : 'fetch unavailable') };
  }
  // 45f 对抗轮 P3-6:无 user 消息的 history 不做摘要 —— 空摘要会把整段历史静默抹成一段「无内容」。
  if (!userBlockStarts(history).length) return { ok: false, error: 'no user turns to summarize' };
  // The selected compactor may be a non-active Provider, so normal /api/models refresh never probed it.
  // Probe on demand before budgeting; Ollama is enriched through native /api/show by fetchOpenAiModels.
  if (resolveContextWindow(provider, model).source === 'fallback') await fetchOpenAiModels(provider, 8000).catch(() => null);
  // 45a:摘要输入预算 = 窗口 × 50%(余量留给输出+系统层;窗口缺省 64K 时预算 32K)。
  const budget = Math.max(4000, Math.floor(providerContextWindow(provider, model) * SUMMARY_INPUT_BUDGET_RATIO));
  const fitted = fitHistoryForSummary(history, budget);
  // 22-S0 摘要归属上下文:econ 标志读一次,身份字段由调用方经 opts.auxCtx 提供(缺失→不落 sessionId/turnSeq)。
  const ectxBase = {
    econ: await economicsShadowEnabledCached(),
    ...(opts && opts.auxCtx ? {
      ...(opts.auxCtx.sessionId ? { sessionId: String(opts.auxCtx.sessionId) } : {}),
      ...(opts.auxCtx.turnSeq != null ? { turnSeq: Number(opts.auxCtx.turnSeq) } : {}),
      ...(opts.auxCtx.traceId ? { traceId: String(opts.auxCtx.traceId) } : {}),
      ...(opts.auxCtx.subagentId ? { subagentId: String(opts.auxCtx.subagentId) } : {}),
      trigger: String(opts.auxCtx.trigger || 'summary'),
    } : { trigger: 'summary' }),
  };
  const singleEstimate = estimateHistoryTokens(Array.isArray(fitted.messages) ? fitted.messages : []);
  const forceChunks = !fitted.needsMapReduce && singleEstimate > SUMMARY_SINGLE_SHOT_MAX_EST; // 肥单发 → 分块,让每次真实尝试远离超时悬崖
  if (!fitted.needsMapReduce && !forceChunks) {
    const sc = await singleSummaryCall(provider, fitted.messages, model, ectxBase);
    if (sc.ok && fitted.droppedMiddle) sc.droppedMiddle = fitted.droppedMiddle;
    if (sc.ok && !validateStructuredSummary(sc.summary)) return { ok: false, error: 'structured summary validation failed (missing sections); 降级保留原文' };
    return sc;
  }
  // map-reduce:分组 → 逐组摘要 → 总摘要。任一组失败即整体失败(错误原样上浮,调用方保留 L1 降级)。
  const chunks = chunkHistoryByBudget(history, forceChunks
    ? Math.min(budget, Math.max(4000, Math.floor(SUMMARY_SINGLE_SHOT_MAX_EST * 0.75))) // 22-S0:肥单发分块时压低每组目标
    : budget);
  if (chunks.length <= 1) return singleSummaryCall(provider, chunks[0] || [], model, ectxBase);
  const partials = [];
  let aggIn = 0, aggOut = 0, aggEst = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const r = await singleSummaryCall(provider, chunks[ci], model, { ...ectxBase, chunkIndex: ci + 1 });
    if (!r.ok) return r;
    partials.push(r.summary);
    if (r.usage) { aggIn += Number(r.usage.prompt_tokens != null ? r.usage.prompt_tokens : r.usage.input_tokens) || 0; aggOut += Number(r.usage.completion_tokens != null ? r.usage.completion_tokens : r.usage.output_tokens) || 0; }
    aggEst += Number(r.promptTokensEst) || 0;
  }
  const joined = [{ role: 'user', content: partials.map((s, i) => `【分段摘要 ${i + 1}/${partials.length}】\n${s}`).join('\n\n') + '\n\n请把以上各分段摘要汇总为一份完整摘要。' }];
  const final = await singleSummaryCall(provider, joined, model, ectxBase);
  if (!final.ok) return final;
  if (!validateStructuredSummary(final.summary)) return { ok: false, error: 'structured summary validation failed (missing sections); 降级保留原文' };
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
    const cachedInTok = estimated ? 0 : Math.min(inTok, cachedInputTokensFromUsage(u));
    const ledgerModel = sc.model || provider.model || '';
    const { cost, currency } = computeProviderCost(provider, inTok, outTok, cachedInTok, ledgerModel);
    appendUsageLedger({
      sessionId: session.id, engine: 'openai', provider: provider.id, model: ledgerModel,
      inTok, outTok, cachedInTok, cost, currency, estimated, turnSeq: session.turnSeq, kind: 'aux', note: 'compact',
    });
  } catch { /* accounting must never break compaction */ }
}

// Resolve the universal compaction selector. Empty selection follows the active engine/provider; an
// explicit selection clones the configured provider with the chosen model so summary calls, accounting,
// and SUMMARY input budgeting agree on the same endpoint. Conversation trigger limits are separate.
function resolveCompactionProvider(config, fallbackProvider) {
  const providerId = String(config && config.compactProviderId || '').trim();
  const modelId = String(config && config.compactModel || '').trim();
  if (!providerId) {
    if (!fallbackProvider) return { provider: null, model: '', isDefault: true };
    const fallbackModel = String(fallbackProvider.model || (fallbackProvider.models && fallbackProvider.models[0] && fallbackProvider.models[0].id) || '').trim();
    return { provider: fallbackProvider, model: fallbackModel, isDefault: true };
  }
  const found = (config.providers || []).find(p => p && p.id === providerId);
  if (!found) return { provider: null, model: '', isDefault: false, error: 'configured compaction provider is unavailable' };
  const model = modelId || String(found.model || (found.models && found.models[0] && found.models[0].id) || '').trim();
  return { provider: { ...found, model }, model, isDefault: false };
}

function compactHistoryFromSession(session) {
  const out = [];
  for (const message of (session && Array.isArray(session.messages) ? session.messages : [])) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue;
    let content = String(message.content || '').trim();
    if (message.role === 'user' && Array.isArray(message.attachments) && message.attachments.length) {
      const refs = message.attachments.map(item => String(item && (item.path || item.name || item.filename) || '')).filter(Boolean);
      if (refs.length) content += `\n\n[本轮附件]\n${refs.join('\n')}`;
    }
    if (message.role === 'assistant') {
      const evidence = {};
      if (message.turnSummary && typeof message.turnSummary === 'object') evidence.turnSummary = message.turnSummary;
      if (Array.isArray(message.toolCalls) && message.toolCalls.length) evidence.toolCalls = message.toolCalls.map(call => ({ name: call && call.name, input: call && call.input }));
      const encoded = Object.keys(evidence).length ? JSON.stringify(evidence) : '';
      if (encoded) content += `\n\n[Ruyi 本轮操作证据]\n${encoded.slice(0, 12000)}`;
    }
    if (!content) continue;
    out.push({ role: message.role, content });
  }
  return out;
}

function lastSessionContextTokens(session) {
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i] && messages[i].usage;
    if (usage && Number.isFinite(Number(usage.contextTokens)) && Number(usage.contextTokens) > 0) return Number(usage.contextTokens);
  }
  return 0;
}

function contextWindowOverrideKey(engine, routeId, model) {
  return JSON.stringify([String(engine || ''), String(routeId || ''), String(model || '').trim()]);
}

function configuredConversationWindow(config, engine, routeId, model) {
  const value = Number(config && config.contextWindowOverrides && config.contextWindowOverrides[contextWindowOverrideKey(engine, routeId, model)]);
  return Number.isFinite(value) && value >= 8000 && value <= 2000000 ? Math.round(value) : 0;
}

function providerConversationContextWindow(config, provider, model) {
  const activeModel = String(model || provider && provider.model || '').trim();
  const manual = configuredConversationWindow(config, 'openai', provider && provider.id, activeModel);
  // Keep learned provider caps authoritative even when a manual conversation limit is configured.
  return providerContextWindow(manual ? { ...provider, contextWindow: manual } : provider, activeModel);
}

async function agentConversationContextMeta(config, session) {
  const agentCliType = String(config && config.agentCliType || 'claude');
  const model = String(config && config.model || session && session.claudeSessionModel || '').trim();
  // An empty configured model is itself a route (the CLI default), not the previous concrete model.
  const manualModel = String(config && config.model || '').trim();
  let contextWindow = configuredConversationWindow(config, 'agent', agentCliType, manualModel);
  let contextWindowSource = contextWindow ? 'manual' : '';
  if (!contextWindow && agentCliType === 'kimi') {
    try { contextWindow = await kimiContextWindow(config, model); } catch { /* fall through to name table */ }
    if (contextWindow > 0) contextWindowSource = 'probe';
  }
  if (!contextWindow) {
    const messages = session && Array.isArray(session.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i], usage = message && message.usage;
      if (!usage || usage.contextWindowSource === 'manual' || usage.source === 'external-compact') continue;
      const tagged = usage.contextEngine === 'agent' && usage.contextAgentCliType === agentCliType;
      const legacy = !usage.contextEngine && message.engine === 'claude' && (message.agentCliType || 'claude') === agentCliType;
      const reportedModel = String(usage.contextModel || usage.model || message.model || '').trim();
      if (!(tagged || legacy) || (model && reportedModel !== model)) continue;
      const measured = Number(usage.contextWindow);
      if (Number.isFinite(measured) && measured > 0) { contextWindow = measured; contextWindowSource = 'usage'; break; }
    }
  }
  if (!(contextWindow > 0)) {
    const resolved = resolveContextWindow(null, model);
    contextWindow = resolved.value;
    contextWindowSource = resolved.source;
  }
  return {
    contextEngine: 'agent', contextAgentCliType: agentCliType, contextModel: model,
    contextWindow, contextWindowSource,
  };
}

// Agent CLIs cannot import an arbitrary external summary into an existing native transcript. The safe
// universal mapping is a visible reseed boundary: summarize Ruyi's complete display transcript, preserve
// it in Ruyi, then start the next native CLI session with only that summary as recovery context.
async function runAgentExternalCompact(sessionId, configOverride, trigger = 'manual') {
  const config = configOverride || await readConfig();
  let session;
  try { session = await loadSession(String(sessionId || '')); } catch { return { ok: false, error: 'session not found' }; }
  if (!session) return { ok: false, error: 'session not found' };
  const resolved = resolveCompactionProvider(config, null);
  if (!resolved.provider || resolved.isDefault) return { ok: false, error: 'no external compaction model selected' };
  const history = compactHistoryFromSession(session);
  if (!history.length) return { ok: false, error: 'no conversation history to compact' };
  const sc = await providerSummaryCall(resolved.provider, history, { model: resolved.model, auxCtx: { sessionId: String(sessionId || ''), trigger: 'agent_external_manual' } });
  if (!sc.ok) return { ok: false, error: sc.error };
  recordCompactUsage(session, resolved.provider, sc);
  const beforeTokens = lastSessionContextTokens(session) || estimateHistoryTokens(history);
  const afterTokens = estimateContentTokens(sc.summary);
  const contextMeta = await agentConversationContextMeta(config, session);
  session.agentRecoverySummary = sc.summary;
  session.agentRecoverySource = {
    providerId: resolved.provider.id,
    model: resolved.model,
    trigger,
    createdAt: nowIso(),
  };
  session.claudeSessionId = null;
  delete session.claudeSessionModel;
  delete session.claudeSessionCwd;
  delete session.claudeSessionRouteKey;
  session.injectedIndexHash = null;
  const marker = upsertCompactMarker(session, {
    kind: 'external', label: `${resolved.provider.label || resolved.provider.id} / ${resolved.model} 压缩上下文`, reseeded: true,
    beforeTokens, afterTokens, note: '下一轮将基于摘要重建原生 Agent 会话。',
  });
  if (marker) marker.usage = { usage: {}, contextTokens: afterTokens, ...contextMeta, source: 'external-compact' };
  session.autoCompactWatermark = afterTokens; // 与 provider/kimi 路径同款滞回水位
  await saveSession(session);
  logEvent({ kind: 'agent_external_compact', sessionId: session.id, trigger, provider: resolved.provider.id, model: resolved.model, summaryChars: sc.summary.length, beforeTokens, afterTokens });
  return { ok: true, mode: 'external-summary', provider: resolved.provider.id, model: resolved.model, summaryChars: sc.summary.length, beforeTokens, afterTokens, sessionReset: true };
}

// ── 压缩标记合并(v2.6.2 观感修复)──────────────────────────────────────────────────────
// 此前自动压缩每次触发都 push 一条独立的 🗜 系统行。长 provider 回合的 agent 循环在每个迭代边界都会过一次
// maybeAutoCompact,而 assistant 大消息要回合结束才落盘 —— 实测单会话曾堆出连续 26 条标记,另一会话 337 行里
// 251 行是压缩行,全部视觉上挂在「最后一条用户消息」与最终回复之间。改为同一压缩集原位合并:
//   · 尾部压缩标记之后还没有新的 user/assistant 行 → 视为同一压缩集,更新那一行(passes/累计蒸发/最新前后
//     token),不再追加新行;对话一旦继续,旧标记自然闭环,下次压缩才开新行;
//   · 落盘安全:行内容变化令 planSessionBodyAppend 的前缀哈希失配,saveSession 自动走全量重写慢路径 ——
//     蒸发改写 providerHistory 本就走该路径,合并不引入额外成本。
// 零收益门槛:「蒸发 1 条:106K→106K」这类噪声 pass 只留审计账(logEvent 照旧),不再凭空造出行来。
const COMPACT_MARKER_MIN_SAVED_TOKENS = 1200;

// 尾部未闭环的压缩标记:从 messages 末尾向前找,遇 user/assistant 对话行即闭环(返回 null);
// 其它 system 噪声行(stderr 等)不打断同一压缩集的连续性。kind 隔离:auto 与手动压缩不互相并入。
function openCompactMarker(session, kind) {
  const msgs = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user' || m.role === 'assistant') return null;
    // 旧格式标记(无 compactMeta)不可并入 —— 文案必须能由 meta 全量重建,数字才保得住诚实。
    if (m.source === 'compact' && (m.compactKind || 'auto') === kind && m.compactMeta
      && Number.isFinite(m.compactMeta.passes)) return m;
  }
  return null;
}

// 追加(或并入)一条压缩标记并返回该消息行(调用方可在返回值上继续挂 usage 等附加字段)。
// 文案永远由 compactMeta 全量派生重建,历史标记(无 meta 的旧格式行)只会被当作闭环处理,不会被误改。
//   o = { kind, label, evaporated?, reseeded?, saved?, beforeTokens?, afterTokens,
//         approx?(默认true→'约'), accuracy?(默认'估算', 显式传空串则省略括注), note?(最新一次覆盖) }
// beforeTokens 仅在【新建】行时生效(压缩集起点的估算值);并入已有行时保留首见起点,不回改。
// saved 省略时由 beforeTokens-afterTokens 推导(kimi 等实测路径只带前后实测值的调用形态)。
function upsertCompactMarker(session, o) {
  const afterTokens = Math.max(0, Math.round(Number(o.afterTokens) || 0));
  const savedExplicit = o.saved == null ? NaN : Math.max(0, Number(o.saved) || 0);
  const saved = o.reseeded ? Infinity
    : (Number.isFinite(savedExplicit) ? savedExplicit
      : Math.max(0, (Math.round(Number(o.beforeTokens) || 0)) - afterTokens));
  let marker = openCompactMarker(session, o.kind);
  if (!marker && !o.reseeded && saved < COMPACT_MARKER_MIN_SAVED_TOKENS) return null; // 零收益不造新行
  if (!marker) {
    marker = { role: 'system', content: '', createdAt: nowIso(), source: 'compact', compactKind: o.kind };
    session.messages.push(marker);
    marker.compactMeta = {
      passes: 0, evaporated: 0, reseeded: false,
      beforeTokens: Math.max(0, Math.round(Number(o.beforeTokens) || afterTokens)),
    };
  }
  const meta = marker.compactMeta;
  meta.passes += 1;
  meta.evaporated += Math.max(0, Number(o.evaporated) || 0);
  meta.reseeded = Boolean(meta.reseeded || o.reseeded);
  meta.afterTokens = afterTokens;
  const times = meta.passes > 1 ? ` ×${meta.passes}` : '';
  const ops = [];
  if (meta.evaporated > 0) ops.push(`蒸发旧工具结果 ${meta.evaporated} 条`);
  if (meta.reseeded) ops.push('摘要重播种');
  const accuracy = o.accuracy === undefined ? '估算' : o.accuracy;
  const head = `🗜 ${o.label}${times}`;
  const tail = `${fmtTokensServer(meta.beforeTokens)}→${o.approx === false ? '' : '约 '}${fmtTokensServer(afterTokens)}${accuracy ? `（${accuracy}）` : ''}`;
  marker.content = ops.length ? `${head}（${ops.join('＋')}）：${tail}` : `${head}：${tail}`;
  if (o.note) marker.content += `；${o.note}`;
  return marker;
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
    const compactTarget = resolveCompactionProvider(config, provider);
    const summaryProvider = compactTarget.provider || provider;
    const sc = await providerSummaryCall(summaryProvider, subHistory, {
      model: compactTarget.model,
      auxCtx: {
        ...(parentSession && parentSession.id ? { sessionId: String(parentSession.id) } : {}),
        ...(subagentId ? { subagentId: String(subagentId) } : {}),
        trigger: 'subturn_auto_L2',
      },
    });
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
    try { if (parentSession) recordCompactUsage(parentSession, summaryProvider, sc); } catch { /* 记账失败不阻断 */ }
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
  const compactTarget = resolveCompactionProvider(config, provider);
  const summaryProvider = compactTarget.provider || provider;
  const history = Array.isArray(session.providerHistory) ? session.providerHistory : [];
  if (!history.length) return { ok: false, error: 'no provider history to compact' };

  const sc = await providerSummaryCall(summaryProvider, history, { model: compactTarget.model });
  if (!sc.ok) {
    logEvent({ kind: 'provider_compact', sessionId: session.id, ok: false, provider: summaryProvider.id, model: compactTarget.model, error: sc.error });
    return { ok: false, error: sc.error };
  }
  const summary = sc.summary;
  recordCompactUsage(session, summaryProvider, sc); // v1.4-OSS 用量看板(补): 手动压缩调用入 aux 台账

  const beforeTokens = estimateHistoryTokens(history);
  session.providerHistory = [
    { role: 'user', content: '(以下是此前对话的压缩摘要)\n' + summary },
    { role: 'assistant', content: '收到，已基于摘要继续。' },
  ];
  const afterTokens = estimateHistoryTokens(session.providerHistory);
  const marker = upsertCompactMarker(session, { kind: 'provider-manual', label: '已压缩上下文', reseeded: true, beforeTokens, afterTokens });
  if (marker) marker.usage = {
    usage: {}, contextTokens: afterTokens, contextWindow: providerConversationContextWindow(config, provider, provider.model),
    contextEngine: 'openai', contextProviderId: provider.id, contextModel: String(provider.model || ''), source: 'provider-compact',
  };
  session.autoCompactWatermark = afterTokens; // 手动压缩后同样进入滞回期
  session.providerHistoryCursor = session.messages.length;
  await saveSession(session);
  logEvent({ kind: 'provider_compact', sessionId: session.id, provider: summaryProvider.id, model: compactTarget.model, summaryChars: summary.length, beforeTokens, afterTokens });
  return { ok: true, provider: summaryProvider.id, model: compactTarget.model, summaryChars: summary.length, beforeTokens, afterTokens };
}

// v0.8-S5 AUTO-COMPACTION driver (§7.7). Called at each provider-turn iteration boundary, BEFORE the next
// API call. If est([system, ...providerHistory]) exceeds threshold × contextWindow, run the two levels:
//   0. snapshot providerHistory → history-<turnSeq>.json.gz (safety net, non-blocking)
//   1. EVAPORATE old tool results → re-estimate → if still over →
//   2. SUMMARY RESEED (shared kernel): [summary-user, ack-assistant] + the last 2 full turns verbatim.
//      Level-2 failure (network/timeout) keeps the level-1 result and does NOT abort the turn.
// For each level that fires: emit a `compact` event {mode, beforeTokens, afterTokens} and upsert ONE merged
// 🗜 system row into session.messages (upsertCompactMarker; repeated levels merge into the same open row). Mutates
// session.providerHistory / session.messages in place; the caller persists via its normal saveSession.
// Returns true if any compaction happened (caller may save immediately). Never throws.
async function maybeAutoCompact(session, provider, sys, config, onEvent, model, tools) {
  try {
    const history = session.providerHistory;
    if (!Array.isArray(history) || !history.length) return false;
    const threshold = Number(config.autoCompactThreshold) || 0.8;
    const window = providerConversationContextWindow(config, provider, model);
    const budget = threshold * window;
    // 重入滞回(45f 观感/空转修复):一次成功压缩后,重新武装水位 = 压后估算 + max(2K, 2% 窗口)。
    // 实测数据里估算值贴着预算线抖动时,曾出现连续 26 次「蒸发 1 条:106K→106K」的每迭代无效循环
    // (每次快照写盘 + 全量存盘 + 追加标记,token 却没降)。水位与预算取大者,窗口放大后不阻碍再压。
    const rearmMargin = Math.max(2000, Math.round(window * 0.02));
    const wm = Number(session.autoCompactWatermark);
    const armedBudget = Number.isFinite(wm) && wm > 0 ? Math.max(budget, wm + rearmMargin) : budget;
    const sysMsg = { role: 'system', content: String(sys || '') };
    const before = calibratedEstimate(provider, model, [sysMsg, ...history], tools); // 45d(a):校准后估算判预算
    if (before <= armedBudget) return false; // under budget / still in hysteresis → nothing to do

    if (config.runtimeOptimizationShadowV1 === true && config.runtimeObservationReducerV1 !== true) {
      try {
        const shadow = measureObservationReductionShadow(history);
        onEvent({ type: 'observation_reduction_shadow', source: 'runtime-shadow', ...shadow });
        logEvent({ kind: 'observation_reduction_shadow', sessionId: session.id, turnSeq: session.turnSeq, ...shadow });
      } catch { /* shadow evaluation must never change the compaction path */ }
    }

    // Safety-net snapshot BEFORE any mutation (non-blocking on failure).
    const rawRefPrefix = await writeHistorySnapshot(session.id, session.turnSeq, history, config.runtimeObservationReducerV1 === true);

    let compacted = false;
    // ── Level 1: evaporate ──────────────────────────────────────────────────────────────────────────
    const evaporated = evaporateHistory(history, {
      config, rawRefPrefix,
      onReduced: meta => {
        onEvent({ type: 'observation_reduced', source: 'runtime-v1', ...meta });
        logEvent({ kind: 'observation_reduced', sessionId: session.id, turnSeq: session.turnSeq, ...meta });
      },
    });
    if (evaporated > 0) {
      const after1 = calibratedEstimate(provider, model, [sysMsg, ...history], tools); // 45d(a)
      onEvent({ type: 'compact', mode: 'evaporate', beforeTokens: before, afterTokens: after1 });
      upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', evaporated, saved: before - after1, beforeTokens: before, afterTokens: after1 });
      logEvent({ kind: 'auto_compact', mode: 'evaporate', sessionId: session.id, beforeTokens: before, afterTokens: after1, evaporated });
      compacted = true;
      if (after1 <= budget) { session.autoCompactWatermark = after1; await saveSession(session).catch(() => {}); return true; } // level 1 was enough
    }

    // ── Level 2: summary reseed (still over budget) ─────────────────────────────────────────────────
    const before2 = calibratedEstimate(provider, model, [sysMsg, ...history], tools); // 45d(a)
    const compactTarget = resolveCompactionProvider(config, provider);
    const summaryProvider = compactTarget.provider || provider;
    const sc = await providerSummaryCall(summaryProvider, history, {
      model: compactTarget.model,
      auxCtx: { sessionId: session.id, turnSeq: session.turnSeq, trigger: 'auto_L2' },
    });
    if (!sc.ok) {
      // Level-2 failed (network/timeout). Keep the level-1 result and continue the turn — do NOT abort.
      logEvent({ kind: 'auto_compact', mode: 'summary', sessionId: session.id, ok: false, error: sc.error });
      if (compacted) { session.autoCompactWatermark = calibratedEstimate(provider, model, [sysMsg, ...history], tools); await saveSession(session).catch(() => {}); }
      return compacted;
    }
    recordCompactUsage(session, summaryProvider, sc); // v1.4-OSS 用量看板(补): 自动压缩(L2 摘要)调用入 aux 台账
    const boundary = recentTurnsBoundary(history);
    const kept = history.slice(boundary); // last 2 full turns, verbatim (user-boundary → pairing-safe)
    session.providerHistory = [
      { role: 'user', content: '(以下是此前对话的压缩摘要)\n' + sc.summary },
      { role: 'assistant', content: '收到，已基于摘要继续。' },
      ...kept,
    ];
    const after2 = estimateHistoryTokens([sysMsg, ...session.providerHistory], '', tools);
    onEvent({ type: 'compact', mode: 'summary', beforeTokens: before2, afterTokens: after2 });
    upsertCompactMarker(session, { kind: 'auto', label: '自动压缩', reseeded: true, beforeTokens: before2, afterTokens: after2 });
    logEvent({ kind: 'auto_compact', mode: 'summary', sessionId: session.id, ok: true, beforeTokens: before2, afterTokens: after2, summaryChars: sc.summary.length });
    session.autoCompactWatermark = after2;
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
    if (allDone()) {
      m.autoMode = 'off'; m.updatedAt = nowIso();
      // 第97波对抗复审(B3):机器验收把最后一个里程碑标 done 的路径,模型本轮可能没调 mission_update
      // (无 __missionFinalizeHow),09 回合收尾不会盖 complete 章 → 这里补盖,收工卡才有验收报告。
      // 若 09 已盖(result 存在)maybeFinalizeMission 会直接返回 false,不重复。
      try { if (await maybeFinalizeMission(session, 'driver')) { /* 章已盖,emit 由下方统一发 */ } } catch { /* 盖章失败不阻断收尾 */ }
      await saveSession(session).catch(() => {}); emit({ type: 'mission', mission: m, state: 'complete' }); return;
    }

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
  const storedConfig = await readConfig();
  // 第78波：交办确认卡可为【这一单当前执行链】收紧/调整安全档，但绝不回写全局配置。
  // 值域复用唯一 PERMISSION_MODES；非法/缺失值静默回落持久配置。该局部副本同时传给首回合、
  // until-done 续跑、Provider 与 Claude，避免 UI 显示一档而后端实际按另一档执行。
  const requestedPermissionMode = String(body.permissionMode || '');
  const config = PERMISSION_MODES.includes(requestedPermissionMode)
    ? { ...storedConfig, permissionMode: requestedPermissionMode }
    : storedConfig;
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
  // D1:assistant_delta/thinking_delta 高频小事件合批(50ms 窗口),减前端重渲染 60-80%;边界事件立即 flush 保顺序
  let deltaBuffer = []; let flushTimer = null;
  const flushDeltas = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!deltaBuffer.length) return;
    const merged = [];
    for (const d of deltaBuffer) {
      const last = merged[merged.length - 1];
      if (last && last.type === d.type) last.text = (last.text || '') + (d.text || '');
      else merged.push({ ...d });
    }
    deltaBuffer = [];
    for (const evt of merged) {
      try { res.write(`${JSON.stringify({ ...evt, ts: nowIso() })}\n`); } catch { /* client gone */ }
    }
  };
  const emit = evt => {
    if (evt && evt.type === 'usage' && evt.usage) {
      const u = evt.usage;
      // 对抗轮 P3: 计入缓存 token —— Claude 引擎 cache_read/cache_creation 常占大头,漏计则 maxTokens 预算欠执行。
      lastTurnTokens = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    }
    if (evt && evt.type === 'process' && evt.state === 'stopped') turnStopped = true;
    if (evt && (evt.type === 'assistant_delta' || evt.type === 'thinking_delta')) {
      deltaBuffer.push(evt);
      if (!flushTimer) flushTimer = setTimeout(flushDeltas, 50);
      return;
    }
    flushDeltas();  // D1:边界事件先 flush 积压 delta,保顺序
    try { res.write(`${JSON.stringify({ ...evt, ts: nowIso() })}\n`); } catch { /* client gone */ }
  };
  // 第27波:本次 HTTP 回合 = 一个「run」。登记活动 runId,scope:'run' 授权绑定它(含首回合内经 UI 签发的 bindNextRun 补绑)。
  const driverRunId = makeId('drun');
  bindDriverRun(session.id, driverRunId);
  // 第69波:登记 settle 信号 —— rewind 截断前等它( dying turn 的收尾 saveSession 落盘先于 driver finally,
  // 由此保证 rewind 的截断写在最后,不被收尾 save 整份盖回)。
  let settleResolve = null;
  const settleEntry = { promise: new Promise(r => { settleResolve = r; }), startedAt: Date.now() };
  turnSettlers.set(session.id, settleEntry);
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
        else await runClaudeTurn({ session, message: String(msg || ''), attachments: atts, cwd: body.cwd, onEvent: emit, config, driverAuto, agentTeam: turnAgentTeam });
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
    flushDeltas();  // D1:回合收尾 flush 残留 delta,防最后一批丢
    finished = true;
    // 第27波:run 结束 → scope:'run' 授权蒸发(遍历删 runId 匹配项),登记表清理。scope:'session' 授权跨回合保留,直到
    // TTL/次数耗尽或显式撤销/切模式。
    try { revokeGrantsForRun(session.id, driverRunId); } catch { /* best-effort */ }
    if (activeDriverRuns.get(session.id) === driverRunId) activeDriverRuns.delete(session.id);
    if (settleResolve) { try { settleResolve(); } catch { /* best-effort */ } }
    if (turnSettlers.get(session.id) === settleEntry) turnSettlers.delete(session.id); // 只删自己的条目;supersede 的新回合条目不动
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
    let interrupted = false;
    let outTruncated = false, errTruncated = false;  // 审计 P0:CAP 截断需告知模型(命令输出被工具层截,非下游 60KB 再截)
    const collect = (chunks, d, isOut) => {
      chunks.push(d);
      if (isOut) { outLen += d.length; while (outLen > CAP && outChunks.length > 1) { outLen -= outChunks.shift().length; outTruncated = true; } }
      else { errLen += d.length; while (errLen > CAP && errChunks.length > 1) { errLen -= errChunks.shift().length; errTruncated = true; } }
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
    const signal = options.signal;
    let abortHandler = null;
    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      if (outTruncated) payload.stdoutTruncated = true;
      if (errTruncated) payload.stderrTruncated = true;
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
    abortHandler = () => {
      if (settled) return;
      interrupted = true;
      killChildTree(child.pid);
      // Keep the normal close event as the primary settlement path, but never make steering wait on a
      // descendant that retained stdio handles after the tree kill.
      killGraceTimer = setTimeout(() => finish({ ok: false, code: -1, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + '\n[interrupted by user steer; process tree killed]', elapsedMs: Date.now() - start, interrupted: true }), 1000);
      if (killGraceTimer.unref) killGraceTimer.unref();
    };
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    }
    child.stdout?.on('data', d => collect(outChunks, d, true));
    child.stderr?.on('data', d => collect(errChunks, d, false));
    child.on('error', error => finish({ ok: false, code: -1, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + error.message, elapsedMs: Date.now() - start, timedOut }));
    child.on('close', code => finish({ ok: code === 0 && !timedOut && !interrupted, code, stdout: decodeBestEffort(Buffer.concat(outChunks)), stderr: decodeBestEffort(Buffer.concat(errChunks)) + (interrupted ? '\n[interrupted by user steer; process tree killed]' : ''), elapsedMs: Date.now() - start, timedOut, interrupted }));
  });
}

// v1.0.1 编码修复(输入侧):无控制台 spawn(用户双击运行时的真实场景)的 powershell.exe 解析 `-Command`
// 参数里的中文会损坏(实测「娄山关」→「|???」——输入阶段就丢字,非输出解码问题)。改用带 BOM 的 UTF-8
// 临时 .ps1 + `-File`:BOM 让 PS 无视控制台代码页、权威按 UTF-8 读脚本,中文 100% 正确进入。输出侧的 GBK
// 乱码由 runProcess 的 decodeBestEffort 兜底(先 UTF-8、有替换符退 GBK)。两侧合起来彻底解决中文乱码。
async function runPowerShell(command, cwd, timeoutMs, signal) {
  const tmpFile = path.join(os.tmpdir(), `ruyi-ps-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  await fsp.writeFile(tmpFile, '﻿' + command, 'utf8'); // UTF-8 BOM(﻿)+ 命令 → PS -File 权威按 UTF-8 读
  try {
    return await runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile,
    ], { cwd: cwd || os.homedir(), timeoutMs, signal });
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

// 第53波 EC-B(53d):原生文件选择器(OpenFileDialog,选 overlay zip 等单文件)。同 pickFolder 的 TopMost owner
// 模式(无 owner 的 ShowDialog 会被压浏览器后面);filter 如 "Zip 包 (*.zip)|*.zip|所有文件|*.*"。
async function pickFile(filter) {
  if (process.platform !== 'win32') {
    return { ok: false, error: '原生文件选择器仅支持 Windows', hint: '请直接粘贴完整路径' };
  }
  const safeFilter = String(filter || 'All files|*.*').replace(/'/g, '');
  const script = "Add-Type -AssemblyName System.Windows.Forms; "
    + "$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true; $f.ShowInTaskbar = $false; "
    + "$f.FormBorderStyle = 'None'; $f.Opacity = 0; "
    + "$f.StartPosition = 'CenterScreen'; $f.Show(); $f.Activate(); "
    + "$d = New-Object System.Windows.Forms.OpenFileDialog; "
    + "$d.Filter = '" + safeFilter + "'; "
    + "if ($d.ShowDialog($f) -eq 'OK') { Write-Output ('OK' + [char]9 + $d.FileName) } else { Write-Output 'CANCEL' }; "
    + "$f.Close()";
  let result;
  try {
    result = await runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script,
    ], { cwd: os.homedir(), timeoutMs: 120000 });
  } catch (e) {
    return { ok: false, error: '无法启动文件选择器: ' + (e && e.message || e), hint: '请直接粘贴完整路径' };
  }
  const out = String((result && result.stdout) || '').trim();
  if (result && result.ok === false && !out) {
    return { ok: false, error: String(result.stderr || '选择器不可用').slice(0, 400), hint: '请直接粘贴完整路径' };
  }
  if (/^CANCEL$/m.test(out) || out === '') return { ok: true, cancelled: true };
  const m = out.match(/^OK	(.+)$/m);
  if (m && m[1].trim()) return { ok: true, path: path.resolve(m[1].trim()) };
  return { ok: true, cancelled: true };
}
