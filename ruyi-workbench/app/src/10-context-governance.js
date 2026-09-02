// ── v1.0.2-S2: 上下文窗口三级自适应 ─────────────────────────────────────────────────────────────────
// 用户痛点:DeepSeek 有 1M 窗却被当 64K 用。解析链(优先级从高到低):
//   1. 手动:provider.contextWindow(sanitizeProvider 已清洗, 8000..2000000)—— 保留最高优先;
//   2. 探测:fetchOpenAiModels 从上游 /v1/models 条目提取 context_length 类字段, 存入 CTX_PROBE_CACHE
//      (键 provider+model, TTL 10 分钟), providerContextWindow 解析激活模型时查此缓存;
//   3. 名称对照表(子串匹配, 小写, 保守取值);
//   4. 兜底:CONTEXT_WINDOW_FALLBACK(65536)—— 防 autocompact.e2e 漂移。
// 第104波：窗口、超窗识别与摘要验证规则由版本化数据文件持有；这里仅做运行时适配。
// 发布产物是单文件：离线更新/临时部署只复制 app/server.js，不一定带 src/。因此保留
// 与版本化 JSON 同构的内置副本作为 artifact fallback；源码运行时优先读取 JSON，规则仍由
// context-governance-rules.json 作为唯一可审计输入维护。这样既不让产物依赖旁车文件，也不改变规则。
const CONTEXT_GOVERNANCE_RULES = (() => {
  const fallback = {
    schema: 1,
    modelWindows: [
      { match: 'deepseek-v4', tokens: 1000000 },
      { match: 'mimo-v2.5-pro', tokens: 1000000, exact: true },
      { match: 'mimo-v2.5', tokens: 1000000, exact: true },
      { match: 'qwen3.8', tokens: 1000000 },
      { match: 'qwen3.7', tokens: 1000000 },
      { match: 'qwen3.6-max', tokens: 262144 },
      { match: 'qwen3.6-plus', tokens: 1000000 },
      { match: 'qwen3.6-flash', tokens: 1000000 },
      { match: 'qwen3.6', tokens: 262144 },
      { match: 'qwen3.5-omni', tokens: 65536 },
      { match: 'qwen3.5-plus', tokens: 1000000 },
      { match: 'qwen3.5-flash', tokens: 1000000 },
      { match: 'qwen3.5', tokens: 32768 },
      { match: 'qwen3-coder-plus', tokens: 1000000 },
      { match: 'qwen3-coder-next', tokens: 262144 },
      { match: 'qwen3-max', tokens: 262144 },
      { match: 'qwen3', tokens: 262144 },
      { match: 'qwen-plus-2025-01-25', tokens: 131072 },
      { match: 'qwen-plus', tokens: 1000000 },
      { match: 'qwen-flash', tokens: 1000000 },
      { match: 'qwen-turbo', tokens: 131072 },
      { match: 'qwen-max', tokens: 32768 },
      { match: 'qwen-long', tokens: 10000000 },
      { match: 'deepseek', tokens: 131072 },
      { match: 'qwen', tokens: 131072 },
      { match: 'glm-5.3', tokens: 1000000 },
      { match: 'glm-5.2', tokens: 1000000 },
      { match: 'glm-5.1', tokens: 202752 },
      { match: 'glm-5-turbo', tokens: 202752 },
      { match: 'glm-5', tokens: 202752 },
      { match: 'glm-4.7', tokens: 202752 },
      { match: 'glm-4.6', tokens: 202752 },
      { match: 'glm-4.5', tokens: 131072 },
      { match: 'glm-4-long', tokens: 1000000 },
      { match: 'glm', tokens: 131072 },
      { match: 'kimi', tokens: 262144 },
      { match: 'moonshot', tokens: 262144 },
      { match: 'minimax-m3', tokens: 1000000 },
      { match: 'minimax-m2.7', tokens: 196608 },
      { match: 'minimax-m2.5', tokens: 196608 },
      { match: 'gemma4', tokens: 131072 },
      { match: 'minicpm5', tokens: 131072 },
      { match: 'whiskyakm', tokens: 131072 },
      { match: 'gpt-5.6', tokens: 1050000 },
      { match: 'gpt-5.5', tokens: 1050000 },
      { match: 'gpt-5.4-pro', tokens: 1050000 },
      { match: 'gpt-5.4-mini', tokens: 400000 },
      { match: 'gpt-5.4-nano', tokens: 400000 },
      { match: 'gpt-5.4', tokens: 1050000 },
      { match: 'gpt-5.2-chat-latest', tokens: 128000, exact: true },
      { match: 'gpt-5.2', tokens: 400000 },
      { match: 'gpt-5.1-chat-latest', tokens: 128000, exact: true },
      { match: 'gpt-5.1', tokens: 400000 },
      { match: 'gpt-5-chat-latest', tokens: 128000, exact: true },
      { match: 'gpt-5', tokens: 400000 },
      { match: 'gpt-4o', tokens: 128000 },
      { match: 'gpt-4.1', tokens: 128000 },
      { match: 'o3', tokens: 200000 },
      { match: 'o4', tokens: 200000 },
      { match: 'claude', tokens: 200000 },
    ],
    contextLengthKeys: ['context_length', 'max_context_length', 'context_window', 'max_model_len'],
    overflow: {
      statuses: [400, 413, 422],
      pattern: 'context.{0,20}(length|window|limit|token)|(length|window|limit|token).{0,20}context|maximum.{0,20}(token|length)|length.{0,12}exceed|prompt.{0,12}too.{0,4}long|prompt\\s+is\\s+too\\s+long|too_many_tokens|tokens\\s*>|input\\s+too\\s+long|input.{0,8}length.{0,30}(should be|range|限制)|上下文.{0,8}(超限|过长|超出)|长度超限|超出.{0,4}长度',
      flags: 'i',
      legacySubagentPattern: 'context|token|length|maximum|too\\s*long|too\\s*large|exceed',
      legacySubagentLongErrorChars: 400,
    },
    summary: {
      inputBudgetRatio: 0.5,
      singleShotMaxEstimate: 32000,
      // 105f: 单发优先的 reserve 分量与单发估算上限钳位,与 context-governance-rules.json 逐字同构(additive)。
      singleShotReserve: { systemTokens: 1200, expectedOutputTokens: 6144, calibrationMarginTokens: 2048 },
      singleShotCap: { default: 32768, min: 8192, max: 131072 },
      maxConcurrent: { default: 8, min: 1, max: 8 },
      callPolicy: {
        unknown: { reasoning: 'omit', outputField: 'omit' },
        defaultTiers: { map: [4096, 6144], refine: [6144, 8192], reduce: [6144, 8192], single: [6144, 8192], repair: [6144, 8192] },
        models: [{ match: 'deepseek-v4', reasoning: { mode: 'effort', supported: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], preferred: 'minimal' }, output: { responses: 'max_output_tokens', chat: 'max_tokens' } }],
        promptGuidance: '输出只保留结构化事实与交接所需要点，不展开推理过程；map 每节尽量短，reduce 保留跨段事实，总体避免无关扩写。',
      },
      reseedTailMaxTokens: 16000,
      minimumSections: 4,
      statusSectionIndex: 3,
      prompt: '请把以上对话压缩为结构化摘要,严格按以下五节输出(某节无内容写「无」):\n【目标】用户的核心目标与关键约束\n【已确认的决定】已拍板的事实、方案选择、用户偏好\n【未完成事项】待办、进行中的工作、悬而未决的问题\n【当前执行状态】按「已完成 / 正在进行 / 阻塞 / 下一步」列出当前交接状态；没有则写「无」\n【关键文件与上下文】涉及的文件/路径、代码要点、重要数据与结论\n保真要求(45e 实测基线驱动):关键名词必须【原样】保留 —— 代号/暗号、数字与量级、日期、人名、文件路径、版本号、明确的禁令与约束,一律不得泛化或省略;宁多勿漏,每节列要点,不要写成一段概括。\n输出只保留结构化事实与交接所需要点,不展开推理过程;map 每节尽量短,reduce 保留跨段事实,总体避免无关扩写。\n只输出摘要本身。',
      sections: [
        ['【目标】', '## Goal', 'Goal:'],
        ['【已确认的决定】', '## Decisions', 'Decisions:'],
        ['【未完成事项】', '## Open', 'Open items:', 'Todo:'],
        ['【当前执行状态】', '## Current Status', '## Execution Status', 'Current Status:'],
        ['【关键文件与上下文】', '## Files', 'Files:', 'Key files'],
      ],
      stateLabels: [
        ['已完成', 'Done', 'Completed'],
        ['正在进行', '进行中', 'In progress', 'In Progress'],
        ['阻塞', 'Blocked'],
        ['下一步', 'Next step', 'Next Step', 'Next steps', 'Next Steps'],
      ],
      entityCheck: {
        maxSamples: 12,
        minSamples: 4,
        scanChars: 200000,
        maxEntityChars: 120,
        patterns: {
          winPath: "[A-Za-z]:\\\\[^\\s\"'`，。；：、)】」<>|*?,\\u4e00-\\u9fff]+",
          slashPath: "(?:^|[\\s\"'(【「`=:,，。；])(/?[\\w.@%+-]+(?:/[\\w.@%+-]+)+/?)",
          version: "\\bv?\\d+\\.\\d+(?:\\.\\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?\\b",
          isoDate: "\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?)?\\b",
          unitNumber: "\\b\\d+(?:\\.\\d+)?\\s?(?:%|KB|MB|GB|KiB|MiB|GiB|tokens?|ms|s|分钟|秒|次|条|个|行|波|项|件)(?![0-9A-Za-z])",
          bigNumber: "\\b\\d{1,3}(?:,\\d{3})+\\b|\\b\\d{4,}\\b",
          backtick: "`([^`\\n]{2,80})`",
          cjkQuote: "「([^」\\n]{2,40})」",
        },
        repairPrompt: '你是摘要修订器。下面给出一份对话摘要,以及确定性抽检发现它遗漏的【必须原样保留】事实清单。请在保持原有五节结构(【目标】/【已确认的决定】/【未完成事项】/【当前执行状态】/【关键文件与上下文】)不变的前提下,把清单中的每条事实原样织入对应小节;不得删除摘要中已有的其他事实,不得改写数字、路径、版本与代号的写法。只输出修订后的完整摘要。',
      },
      // 105g(4.3 首项): map-reduce 全局事实表注入文案与条数上限,与 context-governance-rules.json
      // 的 summary.factTable 块逐字同构(additive)。
      factTable: {
        maxSamples: 64,
        header: '【全局事实表(从完整对话确定性抽取,按最近出现排序;前后冲突以靠后为准)】',
        chunkDirective: '以上是从完整对话确定性抽取的关键事实。本段内容若涉及表中事实,摘要必须逐字保留其写法;未被本段涉及的事实不得写进本段摘要。',
        reduceDirective: '以上是从完整对话确定性抽取的关键事实。汇总时对仍有效的事实逐字保留;已被后文推翻的决定不得并列保留为有效约束。',
      },
      // 105h(4.3 第二项): <=4 块顺序 refine 的上限与修订 prompt,与 JSON 同构(additive)。
      refine: {
        maxChunks: 4,
        prompt: '你是顺序摘要修订器。输入包含【当前累计摘要】和其后的【新增历史块】。请用新增历史更新累计摘要,严格保持【目标】/【已确认的决定】/【未完成事项】/【当前执行状态】/【关键文件与上下文】五节结构。新增历史中更晚的决定覆盖旧决定;已完成或被取消的事项必须从未完成事项中消失;不得把已推翻决定与最新决定并列为有效约束。路径、版本、日期、代号、数字和明确禁令必须逐字保留。只输出修订后的完整摘要。',
      },
    },
    compactionPlan: { defaultThreshold: 0.8, tailBudgetRatio: 0.5, minimumTailTokens: 1 },
    // 105e: 估算分桶因子与分类阈值(JSON/代码比散文 token 密度高,拍定保守默认),由
    // noteEstimateSample EMA 用真实 usage 校准;样本 <3 时 estimateFactor=1 即纯静态估算。
    // 与 context-governance-rules.json 的 estimation 块逐字同构(additive)。
    estimation: { sampleChars: 2048, jsonStructDensity: 0.05, codeSignalThreshold: 3, factors: { json: 2.8, code: 3.2 } },
  };
  const rulesPath = path.join(__dirname, 'src', 'context-governance-rules.json');
  const loaded = fs.existsSync(rulesPath) ? require(path.join(__dirname, 'src', 'context-governance-rules.json')) : null;
  return loaded || fallback;
})();
if (!CONTEXT_GOVERNANCE_RULES || CONTEXT_GOVERNANCE_RULES.schema !== 1) throw new Error('unsupported context-governance-rules schema');
// 模型名对照表顺序敏感(更具体的版本/快照须在家族兜底之前命中)，顺序由数据文件锁定。
// exact 条目同时接受供应商常见的 `vendor/model` 前缀，但不会误把 ASR/TTS 等同名变体当作文本模型。
const MODEL_CONTEXT_TABLE = CONTEXT_GOVERNANCE_RULES.modelWindows.map(row => [row.match, row.tokens, row.exact === true]);
// 从上游 /v1/models 条目提取窗口大小:取 context_length/max_context_length/context_window/max_model_len
// 任一为正数的第一个。none → undefined(探测无结果, 不污染缓存正数判定)。
const CTX_LENGTH_KEYS = CONTEXT_GOVERNANCE_RULES.contextLengthKeys.slice();
// 105e: 估算分桶规则(数据文件持有;09-workflow 的估算热路径在调用期引用,拼接产物同作用域,无 TDZ 风险)。
const ESTIMATION_RULES = CONTEXT_GOVERNANCE_RULES.estimation;
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
// 名称表命中(子串/受限精确匹配, 小写)。无命中 → undefined。
function contextWindowFromTable(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return undefined;
  for (const [needle, size, exact] of MODEL_CONTEXT_TABLE) {
    const n = String(needle || '').toLowerCase();
    if (exact ? (m === n || m.endsWith('/' + n)) : m.includes(n)) return size;
  }
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
const contextCalibrationStore = DurableJsonStore.create({
  id: 'context-calibration',
  file: () => path.join(paths.data, 'context-calibration.json'),
  schemaVersion: 1,
  defaultValue: () => ({ schema: 1, factors: {}, windowCaps: {} }),
  sanitize(value) {
    const factors = value && value.factors && typeof value.factors === 'object' && !Array.isArray(value.factors) ? value.factors : {};
    const windowCaps = value && value.windowCaps && typeof value.windowCaps === 'object' && !Array.isArray(value.windowCaps) ? value.windowCaps : {};
    for (const [key, sample] of Object.entries(factors)) {
      if (!sample || !Number.isFinite(Number(sample.f)) || !Number.isFinite(Number(sample.n)) || Number(sample.n) < 0) delete factors[key];
      else factors[key] = { f: Math.min(3, Math.max(0.5, Number(sample.f))), n: Math.floor(Number(sample.n)) };
    }
    for (const [key, learned] of Object.entries(windowCaps)) {
      if (!learned || !Number.isFinite(Number(learned.cap)) || Number(learned.cap) <= 0) delete windowCaps[key];
      else windowCaps[key] = { cap: Math.floor(Number(learned.cap)), at: typeof learned.at === 'string' ? learned.at.slice(0, 64) : '' };
    }
    return { schema: 1, factors, windowCaps };
  },
  validate: value => value.schema === 1 && !!value.factors && !!value.windowCaps,
  capacity: [
    { path: 'factors', max: CONTEXT_CALIBRATION_MAX },
    { path: 'windowCaps', max: CONTEXT_CALIBRATION_MAX },
  ],
  onCorrupt(error) {
    try { logEvent({ kind: 'context_calibration_corrupt', error: String(error && error.message || error).slice(0, 200) }); } catch { /* ignore */ }
  },
});
function loadContextCalibration() {
  return contextCalibrationStore.readSync();
}
const _calibKey = (providerId, model) => String(providerId || '') + '/' + String(model || '');
function persistContextCalibration() {
  // 单写者假设(45f 对抗轮 P2-2 裁决):note* 调用点全部在 serve 进程内(MCP 子进程走 HTTP loopback,
  // 不是写者);多 serve 实例共享 dataRoot 是窄面,接受互覆,不做跨进程合并。
  return contextCalibrationStore.write(loadContextCalibration()).catch(() => { /* 记账永不阻断 */ });
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
const CONTEXT_OVERFLOW_STATUSES = new Set(CONTEXT_GOVERNANCE_RULES.overflow.statuses.map(Number));
const CONTEXT_OVERFLOW_PATTERNS = new RegExp(CONTEXT_GOVERNANCE_RULES.overflow.pattern, CONTEXT_GOVERNANCE_RULES.overflow.flags);
function isContextOverflowError(httpError, options = {}) {
  const s = String(httpError || '');
  const hasStatus = [...CONTEXT_OVERFLOW_STATUSES].some(status => new RegExp(`\\b${status}\\b`).test(s));
  if (!hasStatus) return false;
  if (CONTEXT_OVERFLOW_PATTERNS.test(s)) return true;
  if (options.legacySubagentFallback === true && /\b400\b/.test(s)) {
    const legacy = new RegExp(CONTEXT_GOVERNANCE_RULES.overflow.legacySubagentPattern, 'i');
    return legacy.test(s) || s.length > CONTEXT_GOVERNANCE_RULES.overflow.legacySubagentLongErrorChars;
  }
  return false;
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

function reduceObservationContent(toolName, content, rawRef, opts) {
  const recallEnabled = !!(opts && opts.recallEnabled);
  // 105a: 仅当 observation_recall 工具生效时在缩减视图里提示回读入口;默认关时文案逐字节不变。
  const recallHint = recallEnabled ? ' · recall=observation_recall(rawRef)' : '';
  const recallInstruction = recallEnabled
    ? 'This view is incomplete. If the task depends on exact omitted historical content, call observation_recall with rawRef before answering; do not conclude that a fact is absent from this reduced view.'
    : '';
  const original = String(content == null ? '' : content);
  if (original.length < OBSERVATION_REDUCE_MIN) return { reduced: false, content: original, policy: 'below_minimum', originalChars: original.length, visibleChars: original.length, rawRef };
  const baseName = String(toolName || '').replace(/^.+?__/, '');
  let parsed = null; try { parsed = JSON.parse(original); } catch { /* text result */ }
  let visible, policy;
  if (parsed && typeof parsed === 'object') {
    const reduced = compactObservationValue(parsed, '', 0);
    policy = /shell|powershell|script/i.test(baseName) ? 'shell_structured' : (/search|find|glob|list/i.test(baseName) ? 'search_structured' : (/web|http|fetch|download/i.test(baseName) ? 'network_structured' : 'json_structured'));
    const meta = { reduced: true, policy, originalChars: original.length, rawRef };
    if (recallEnabled) {
      meta.recall = 'observation_recall(rawRef)';
      meta.instruction = recallInstruction;
    }
    if (Array.isArray(reduced)) visible = JSON.stringify({ items: reduced, _ruyiObservation: meta });
    else {
      if (reduced && typeof reduced === 'object') reduced._ruyiObservation = meta;
      visible = JSON.stringify(reduced);
    }
  } else {
    policy = 'text_head_tail';
    visible = `[Ruyi observation reduced · policy=${policy} · originalChars=${original.length} · rawRef=${rawRef}${recallHint}]\n`
      + (recallInstruction ? `[Recovery instruction: ${recallInstruction}]\n` : '')
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

// 105a model-adoption prompt: rawRef markers can sit tens of thousands of tokens behind the current
// question. Surface a bounded current-session index next to the newest user message without persisting it
// or copying any raw observation bytes. Only system-produced reduced tool views are eligible.
function buildObservationRecallPrompt(history, config) {
  if (!observationRecallEnabled(config) || !Array.isArray(history)) return '';
  const refs = [];
  const seen = new Set();
  const refPattern = /history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}/g;
  for (const message of history) {
    if (!message || message.role !== 'tool' || typeof message.content !== 'string') continue;
    const content = message.content;
    if (!content.includes('[Ruyi observation reduced') && !content.includes('"_ruyiObservation"')) continue;
    for (const match of content.matchAll(refPattern)) {
      const ref = match[0];
      if (!seen.has(ref)) { seen.add(ref); refs.push(ref); }
    }
  }
  if (!refs.length) return '';
  const visible = refs.slice(-8);
  const omitted = refs.length - visible.length;
  return '[Ruyi recovery index — runtime context, not user-authored]\n'
    + 'The reduced historical tool views below are incomplete but recoverable. If the request may depend on an exact omitted historical value or detail, call observation_recall with the relevant rawRef before answering or claiming that it is absent.\n'
    + visible.map(ref => `- rawRef=${ref}`).join('\n')
    + (omitted > 0 ? `\n- ${omitted} older recoverable reference(s) omitted from this bounded index` : '');
}

// 105d-A: session notes 回注 prompt —— 把旁车 notes 有界、非持久地贴到最新一条 user 消息旁
// (样板同 105a recovery index)。开关关 / notes 缺失 / 解析失败 / 三节全空(皆「无」) → ''(零注入)。
// 有界:【整个注入块】不超过上限；正文超出时保留头部 + 省略计数标记(常数内置,对齐 105a 风格),
// 预算口径与 recall prompt 一致 —— 在 buildBody 内追加,不进 budgetPrompt。
const SESSION_NOTES_INJECT_MAX_CHARS = 2000;
function buildSessionNotesInjectPrompt(notesMarkdown, config) {
  if (!sessionNotesInjectEnabled(config) || typeof notesMarkdown !== 'string' || !notesMarkdown) return '';
  const sections = parseSessionNotesMarkdown(notesMarkdown);
  if (!sections) return '';
  const allEmpty = [sections.decisions, sections.open, sections.files].every(s => !s || s === '无');
  if (allEmpty) return '';
  const prefix = '[Ruyi session notes — runtime context, not user-authored]\n'
    + 'The notes below are a deterministic extraction from the most recent compaction summary of this session (decisions / open items / key files). If they overlap or conflict with a summary already in the conversation, the newest summary wins.\n';
  const bodyBudget = Math.max(0, SESSION_NOTES_INJECT_MAX_CHARS - prefix.length);
  if (notesMarkdown.length <= bodyBudget) return prefix + notesMarkdown;
  // 省略数本身的位数会改变可见正文长度，至多两轮即可收敛；末轮再防御性钳位总长。
  let kept = bodyBudget;
  for (let i = 0; i < 3; i++) {
    const marker = `\n[...${notesMarkdown.length - kept} chars omitted...]`;
    const next = Math.max(0, bodyBudget - marker.length);
    if (next === kept) break;
    kept = next;
  }
  const marker = `\n[...${notesMarkdown.length - kept} chars omitted...]`;
  return (prefix + notesMarkdown.slice(0, kept) + marker).slice(0, SESSION_NOTES_INJECT_MAX_CHARS);
}

// 105d-A 去重守门(纯函数,e2e 白盒共用): notes 上游即最近一次压缩摘要;历史首条 user 已含该摘要
// 标记(【压缩摘要】 或 (以下是此前对话的压缩摘要))时跳过注入,避免重复计费。content 兼容 string/数组。
function historyStartsWithCompactionSummary(history) {
  const firstUser = Array.isArray(history) ? history.find(entry => entry && entry.role === 'user') : null;
  const text = !firstUser ? ''
    : typeof firstUser.content === 'string' ? firstUser.content
    : Array.isArray(firstUser.content) ? firstUser.content.map(part => part && typeof part.text === 'string' ? part.text : '').join('\n') : '';
  return text.includes('【压缩摘要】') || text.includes('(以下是此前对话的压缩摘要)');
}

// 105d-A: 把非持久运行时提示贴到【最后一条】 user 消息(注入形态仿 105a recall prompt,
// content 兼容 string/parts 数组)。只改传入的 msgs 请求副本;无 user 消息或形态不识 → false。
function appendPromptToLastUserMessage(msgs, text) {
  if (!text || !Array.isArray(msgs)) return false;
  const lastUserIndex = msgs.findLastIndex(entry => entry && entry.role === 'user');
  if (lastUserIndex < 0) return false;
  const lastUser = msgs[lastUserIndex];
  if (typeof lastUser.content === 'string') {
    msgs[lastUserIndex] = { ...lastUser, content: lastUser.content + '\n\n' + text };
    return true;
  }
  if (Array.isArray(lastUser.content)) {
    msgs[lastUserIndex] = { ...lastUser, content: [...lastUser.content, { type: 'text', text }] };
    return true;
  }
  return false;
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
      const reduced = reduceObservationContent(toolName, m.content, `${opts.rawRefPrefix}:${i}:${contentHash}`, { recallEnabled: opts.config.runtimeObservationRecallV1 === true });
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
const SUMMARY_INPUT_BUDGET_RATIO = CONTEXT_GOVERNANCE_RULES.summary.inputBudgetRatio;
// 22-S0 热点基线实测(2026-08-27):单发摘要输入到 60K token 时,glm-5.3-flash 的正常耗时已在
// 40–51s,旧 60s 远程超时等于踩悬崖 —— 真实 dogfood 一天 30 次 L2 里 26 次超时作废。
// ① 远程超时提到 180s(localhost/Ollama 维持 300s);② 本可单发但预估超过此阈值的输入强制走
// map-reduce 分块,让每次真实 HTTP 尝试天然远离超时线。
const SUMMARY_SINGLE_SHOT_MAX_EST = CONTEXT_GOVERNANCE_RULES.summary.singleShotMaxEstimate;
// 105f: 单发优先的预算余量 —— reserve = system＋摘要 prompt＋预期输出＋校准误差上界。摘要 prompt 分量
// 运行时估算(跟随 SUMMARY_PROMPT 实际文本,不抄死数字);其余分量在 rules 的 summary.singleShotReserve。
const SUMMARY_SINGLE_SHOT_RESERVE = CONTEXT_GOVERNANCE_RULES.summary.singleShotReserve || {};
const SUMMARY_SINGLE_SHOT_CAP_RULE = CONTEXT_GOVERNANCE_RULES.summary.singleShotCap || { default: 32768, min: 8192, max: 131072 };
function summarySingleShotReserveTokens() {
  return (Number(SUMMARY_SINGLE_SHOT_RESERVE.systemTokens) || 0)
    + estimateTextTokens(summaryPromptWithGuidance())
    + (Number(SUMMARY_SINGLE_SHOT_RESERVE.expectedOutputTokens) || 0)
    + (Number(SUMMARY_SINGLE_SHOT_RESERVE.calibrationMarginTokens) || 0);
}
// 105f: 单发估算上限解析 —— 「provider/model」精确覆盖 > provider 覆盖 > 引擎(apiStyle)覆盖 > 全局设置;
// 每个来源都过同一钳位 [min, max](坏值落回 default)。不提供无限档;与远程超时无关(不自动改超时)。
function summarySingleShotCap(config, provider, model) {
  const rule = SUMMARY_SINGLE_SHOT_CAP_RULE;
  const clampCap = v => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Number(rule.max) || 131072, Math.max(Number(rule.min) || 8192, Math.round(n))) : (Number(rule.default) || 32768);
  };
  const ov = (config && config.summarySingleShotMaxOverridesV1 && typeof config.summarySingleShotMaxOverridesV1 === 'object' && !Array.isArray(config.summarySingleShotMaxOverridesV1)) ? config.summarySingleShotMaxOverridesV1 : {};
  const pid = String((provider && provider.id) || '');
  const mid = String(model || (provider && provider.model) || '');
  const style = provider && provider.apiStyle === 'responses' ? 'responses' : 'chat';
  for (const key of [pid && mid ? pid + '/' + mid : '', pid, 'style:' + style]) {
    if (key && ov[key] != null) return clampCap(ov[key]);
  }
  return clampCap(config && config.summarySingleShotMaxTokensV1);
}

// 摘要请求策略不是用户配置:它只由版本化规则、协议和模型名决定。未知模型/自定义端点故意不发送
// reasoning/max-output 字段,以保持 OpenAI-compatible 的最低公约数;已知能力在正常请求中被动验证,
// 明确的参数拒绝只触发一次移除参数的兼容重试并在进程内记忆。与 provider.reasoningEffort 分离,
// 因而不会把用户给主回合的推理档位硬套到摘要回路。
const SUMMARY_CALL_POLICY_RULE = CONTEXT_GOVERNANCE_RULES.summary.callPolicy || {
  unknown: { reasoning: 'omit', outputField: 'omit' },
  defaultTiers: { map: [4096, 6144], refine: [6144, 8192], reduce: [6144, 8192], single: [6144, 8192], repair: [6144, 8192] },
  models: [{ match: 'deepseek-v4', reasoning: { mode: 'effort', supported: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], preferred: 'minimal' }, output: { responses: 'max_output_tokens', chat: 'max_tokens' } }],
};
const SUMMARY_POLICY_STAGES = new Set(['map', 'refine', 'reduce', 'single', 'repair']);
const SUMMARY_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const SUMMARY_CALL_CAP_CACHE = new Map();
function summaryCallPolicyKey(provider, model, apiStyle) {
  // baseUrl is part of the capability identity (different gateways can expose different schemas), but the
  // key deliberately contains no api key and is bounded so a malformed custom URL cannot grow the cache.
  const base = String(provider && provider.baseUrl || '').trim().toLowerCase().slice(0, 400);
  return [String(provider && provider.id || '').slice(0, 80), String(model || '').slice(0, 120), apiStyle === 'responses' ? 'responses' : 'chat', base].join('\u0000');
}
function summaryModelPolicy(model) {
  const m = String(model || '').trim().toLowerCase();
  const rows = Array.isArray(SUMMARY_CALL_POLICY_RULE.models) ? SUMMARY_CALL_POLICY_RULE.models : [];
  return rows.find(row => row && String(row.match || '').trim() && m.includes(String(row.match).trim().toLowerCase())) || null;
}
function summaryEffortFromRule(rule) {
  const r = rule && rule.reasoning;
  if (!r || r.mode !== 'effort' || !Array.isArray(r.supported)) return { mode: 'omit' };
  const supported = [...new Set(r.supported.map(v => String(v || '').trim().toLowerCase()).filter(v => SUMMARY_EFFORT_ORDER.includes(v)))];
  if (!supported.length) return { mode: 'omit' };
  const preferred = String(r.preferred || '').trim().toLowerCase();
  const value = supported.includes(preferred) ? preferred : SUMMARY_EFFORT_ORDER.find(v => supported.includes(v));
  return value ? { mode: 'effort', value } : { mode: 'omit' };
}
function summaryPolicyTiers(stage) {
  const defaults = SUMMARY_CALL_POLICY_RULE.defaultTiers || {};
  const raw = Array.isArray(defaults[stage]) ? defaults[stage] : (Array.isArray(defaults.single) ? defaults.single : [6144, 8192]);
  const tiers = raw.map(Number).filter(v => Number.isFinite(v) && v >= 512).map(v => Math.round(v));
  return tiers.length ? [...new Set(tiers)] : [6144, 8192];
}
function resolveSummaryCallPolicy(provider, model, apiStyle, stage) {
  const normalizedStyle = apiStyle === 'responses' ? 'responses' : 'chat';
  const normalizedStage = SUMMARY_POLICY_STAGES.has(stage) ? stage : 'single';
  const modelRule = summaryModelPolicy(model);
  const key = summaryCallPolicyKey(provider, model, normalizedStyle);
  const cached = SUMMARY_CALL_CAP_CACHE.get(key) || {};
  const reasoning = cached.reasoningUnsupported ? { mode: 'omit' } : summaryEffortFromRule(modelRule);
  const configuredField = modelRule && modelRule.output && modelRule.output[normalizedStyle];
  const outputField = cached.outputUnsupported ? '' : (typeof configuredField === 'string' ? configuredField : '');
  const tiers = summaryPolicyTiers(normalizedStage);
  return {
    key,
    known: !!modelRule,
    apiStyle: normalizedStyle,
    stage: normalizedStage,
    reasoning,
    output: { field: outputField, tiers, tierIndex: 0 },
  };
}
function summaryCallPolicyMetadata(policy) {
  return {
    knownModel: !!(policy && policy.known),
    stage: policy && policy.stage || 'single',
    reasoning: policy && policy.reasoning && policy.reasoning.mode === 'effort' ? policy.reasoning.value : 'omit',
    outputField: policy && policy.output && policy.output.field || 'omit',
    outputTokens: policy && policy.output && policy.output.field ? policy.output.tiers[policy.output.tierIndex] : undefined,
  };
}
function markSummaryCallPolicyUnsupported(policy, fields) {
  if (!policy || !policy.key || !Array.isArray(fields) || !fields.length) return;
  const hit = SUMMARY_CALL_CAP_CACHE.get(policy.key) || {};
  if (fields.includes('reasoning')) hit.reasoningUnsupported = true;
  if (fields.includes('output')) hit.outputUnsupported = true;
  SUMMARY_CALL_CAP_CACHE.set(policy.key, hit);
}
function summaryUnsupportedParameterFields(status, detail, policy) {
  if (!(Number(status) === 400 || Number(status) === 422) || !policy) return [];
  const text = String(detail || '');
  if (!text || isContextOverflowError(text)) return [];
  const fields = [];
  const outputField = policy.output && policy.output.field;
  if (outputField && new RegExp(`\\b${outputField.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(text)) fields.push('output');
  if (policy.reasoning && policy.reasoning.mode !== 'omit' && /reasoning(?:_effort)?|\beffort\b|\bthinking\b/i.test(text)) fields.push('reasoning');
  if (fields.length) return [...new Set(fields)];
  // Some gateways only say "unknown parameter". Remove all controls once, but never on a context error.
  if (/(unsupported|not\s+support(?:ed)?|unknown|invalid).{0,50}(parameter|field|argument)|(?:parameter|field|argument).{0,50}(unsupported|not\s+support(?:ed)?|unknown|invalid)/i.test(text)) {
    if (outputField) fields.push('output');
    if (policy.reasoning && policy.reasoning.mode !== 'omit') fields.push('reasoning');
  }
  return [...new Set(fields)];
}
function applySummaryCallPolicy(body, policy) {
  if (!body || typeof body !== 'object' || !policy) return body;
  if (policy.reasoning && policy.reasoning.mode === 'effort' && policy.reasoning.value) {
    if (policy.apiStyle === 'responses') body.reasoning = { effort: policy.reasoning.value };
    else body.reasoning_effort = policy.reasoning.value;
  }
  const out = policy.output || {};
  const value = out.field && Array.isArray(out.tiers) ? out.tiers[out.tierIndex] : 0;
  if (out.field && Number.isFinite(value) && value > 0) body[out.field] = value;
  return body;
}
// 并行 map-reduce 的并发上限解析(105i:36 块无上限并发会把 provider 打进排队/限流)——
// 读 config.summaryMaxConcurrentV1,过 [min,max] 钳位,坏值落回全局默认 8。该上限对所有模型一致，
// 仍由 fail-fast 取消保护在 provider 或单块失败时停止派发；用户未新增配置项。
const SUMMARY_MAX_CONCURRENT_RULE = CONTEXT_GOVERNANCE_RULES.summary.maxConcurrent || { default: 8, min: 1, max: 8 };
function summaryMaxConcurrent(config, provider, model) {
  const rule = SUMMARY_MAX_CONCURRENT_RULE;
  const n = Number(config && config.summaryMaxConcurrentV1);
  const clamp = value => Math.min(Number(rule.max) || 8, Math.max(Number(rule.min) || 1, Math.round(value)));
  if (Number.isFinite(n)) return clamp(n);
  return Number(rule.default) || 8;
}
// 有界并发执行摘要类调用(仿 09-workflow 21-E2 worker-pool:poolNext 领任务、完成即补位,无批次屏障)。
// fail-fast:任一结果 !ok 即 abort failCtrl —— worker 停止领新任务,在飞请求经 extraSignal 取消;
// 结果按输入下标保序(失败点之后的空位为 undefined,调用方按序找首个真实失败上浮)。
async function mapSummaryWithLimit(items, limit, fn, failCtrl) {
  const results = new Array(items.length);
  let poolNext = 0;
  let failed = false;
  const workers = Math.min(items.length, Math.max(1, limit));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (!failed && poolNext < items.length) {
      const i = poolNext++;
      const r = await fn(i);
      results[i] = r;
      if (!r || !r.ok) { failed = true; try { failCtrl && failCtrl.abort(); } catch { /* ignore */ } }
    }
  }));
  return results;
}
// L2 重播种保留的近期原文上限。它是绝对上限而非「保留最近 N 回合」：两回合可能只有几百
// token，也可能夹着几十 K 的工具结果。调用点还会钳到当次压缩预算的一半，避免小窗口被尾部反撑爆。
// 只保留完整 user 回合；若最新一整回合本身放不下，宁可交给结构化摘要，也绝不从 tool_call/tool_result
// 组中间切开，避免把协议历史重播成孤儿。
const COMPACT_RESEED_TAIL_MAX_TOKENS = CONTEXT_GOVERNANCE_RULES.summary.reseedTailMaxTokens;
const SUMMARY_PROMPT = CONTEXT_GOVERNANCE_RULES.summary.prompt;
function summaryPromptWithGuidance() {
  const guidance = String(SUMMARY_CALL_POLICY_RULE.promptGuidance || '').trim();
  if (!guidance || String(SUMMARY_PROMPT || '').includes(guidance)) return SUMMARY_PROMPT;
  return SUMMARY_PROMPT + '\n' + guidance;
}

function validateStructuredSummary(summary) {
  if (!summary || typeof summary !== 'string') return false;
  // 每节接受 中文标题 或 常见英文变体(英文模型可能按英文输出;SUMMARY_PROMPT 为中文硬编码,
  // 故英文变体用独立标题词,避免与正文内容误匹配)。
  const sections = CONTEXT_GOVERNANCE_RULES.summary.sections;
  const found = sections.filter(sec => sec.some(s => summary.includes(s))).length;
  // 当前执行状态是交接摘要的关键部分，不能再用“任意三节”放行；否则模型
  // 漏掉状态节时，下一轮会失去“已完成/进行中/阻塞/下一步”的恢复依据。
  const stateLabels = CONTEXT_GOVERNANCE_RULES.summary.stateLabels;
  const statusSection = sections[CONTEXT_GOVERNANCE_RULES.summary.statusSectionIndex];
  const statePresent = statusSection.some(s => summary.includes(s));
  const stateComplete = statePresent && stateLabels.every(labels => labels.some(label => summary.includes(label)));
  return found >= CONTEXT_GOVERNANCE_RULES.summary.minimumSections && stateComplete;  // 结构化摘要必须含五节中的至少四节,且状态节四项齐全
}

// ── 105b: session-notes.md 状态外置(只写切片)─────────────────────────────────
// 从既有五节结构化摘要【确定性切出】状态三节,整写到 sessions/<id>.session-notes.md 旁车副本。
// 节索引锚定 context-governance-rules.json 的 summary.sections 顺序(1=已确认的决定,2=未完成事项,
// 4=关键文件与上下文);0=目标、3=当前执行状态留在摘要叙事里,不进 notes(摘要保留叙事职责)。
// 不新增 LLM 调用、不改摘要/prompt/reseed 字节形状;默认关闭,失败静默,绝不阻断回合。
const SESSION_NOTES_SECTION_INDEXES = [1, 2, 4];
const SESSION_NOTES_TITLES = ['已确认的决定', '未完成事项', '关键文件与上下文'];
function extractSessionNotes(summary) {
  const rules = CONTEXT_GOVERNANCE_RULES.summary;
  const text = String(summary || '');
  // 定位每节标题:任一名命中,取最靠前的出现位置与对应别名长度。
  const found = [];
  for (let i = 0; i < rules.sections.length; i++) {
    let pos = -1, len = 0;
    for (const alias of rules.sections[i]) {
      const p = text.indexOf(alias);
      if (p >= 0 && (pos < 0 || p < pos)) { pos = p; len = alias.length; }
    }
    if (pos >= 0) found.push({ index: i, pos, len });
  }
  found.sort((a, b) => a.pos - b.pos);
  const out = [];
  for (const idx of SESSION_NOTES_SECTION_INDEXES) {
    const f = found.find(x => x.index === idx);
    if (!f) { out.push('无'); continue; }              // 缺节降级为「无」,对齐摘要空节约定
    const next = found.find(x => x.pos > f.pos);
    const body = text.slice(f.pos + f.len, next ? next.pos : undefined).trim();
    out.push(body || '无');
  }
  return { decisions: out[0], open: out[1], files: out[2] };
}
function renderSessionNotesMarkdown(notes, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const head = `<!-- schema:1 session:${String(m.sessionId || '')} updatedAt:${String(m.updatedAt || '')} turnSeq:${Number.isFinite(m.turnSeq) ? m.turnSeq : 0} -->`;
  const parts = ['# Session Notes', '', head, ''];
  const bodies = [notes && notes.decisions, notes && notes.open, notes && notes.files];
  for (let i = 0; i < SESSION_NOTES_TITLES.length; i++) {
    parts.push(`## ${SESSION_NOTES_TITLES[i]}`, '', String(bodies[i] || '无'), '');
  }
  return parts.join('\n');
}
// 105d: 解析 renderSessionNotesMarkdown 产物的 `##` 三节回 {decisions, open, files};
// 三个标题一个都找不到视为解析失败(null) —— 回注重空判定与增量合并共用这个解析器。
function parseSessionNotesMarkdown(markdown) {
  const text = String(markdown || '');
  const keys = ['decisions', 'open', 'files'];
  const found = [];
  for (let i = 0; i < SESSION_NOTES_TITLES.length; i++) {
    const marker = `## ${SESSION_NOTES_TITLES[i]}`;
    const pos = text.indexOf(marker);
    if (pos >= 0) found.push({ index: i, pos, len: marker.length });
  }
  if (!found.length) return null;
  found.sort((a, b) => a.pos - b.pos);
  const out = {};
  for (const f of found) {
    const next = found.find(x => x.pos > f.pos);
    const body = text.slice(f.pos + f.len, next ? next.pos : undefined).trim();
    out[keys[f.index]] = body || '无'; // 空节对齐摘要空节约定
  }
  return { decisions: out.decisions || '无', open: out.open || '无', files: out.files || '无' };
}
// 105d-B: 增量合并 —— 决定/关键文件两节并集去重(按行 trim 精确去重,next 的行在前、prev 独有行
// 追加在后,新的优先;超 64K 由 writeSessionNotes 现有尾部截断兜底,自然保住新内容);
// 未完成事项节以最新为准(replace) —— 已完成事项必须能消失,摘要是权威状态。「无」节视为空集。
// prev 缺失/解析失败 → 直接用 next(降级为 105b 整体重写语义)。
// 已知局限:文本级合并无法识别「被后文推翻的决定」,并列保留属实验语义,由 105 总门取证裁决。
function mergeSessionNotes(prevMarkdown, nextNotes) {
  const prev = typeof prevMarkdown === 'string' && prevMarkdown ? parseSessionNotesMarkdown(prevMarkdown) : null;
  if (!prev || !nextNotes || typeof nextNotes !== 'object') return nextNotes;
  return {
    decisions: mergeSessionNotesLines(nextNotes.decisions, prev.decisions),
    open: nextNotes.open, // replace: 以最新摘要为准
    files: mergeSessionNotesLines(nextNotes.files, prev.files),
  };
}
function mergeSessionNotesLines(nextBody, prevBody) {
  const toLines = body => (String(body || '').trim() === '无' ? [] : String(body || '').split('\n').map(l => l.trim()).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const line of [...toLines(nextBody), ...toLines(prevBody)]) {
    if (seen.has(line)) continue;
    seen.add(line); out.push(line);
  }
  return out.join('\n'); // 空集交给 renderSessionNotesMarkdown 的「无」兜底,保证合并结果可再解析(回环)
}
// 挂钩入口:L2 摘要成功后 fire-and-forget。开关关闭 = 零文件读写;任何失败吞掉(纪律同 writeHistorySnapshot)。
function maybeWriteSessionNotes(session, summary, config) {
  try {
    if (!sessionNotesEnabled(config)) return;
    if (!session || !session.id || typeof summary !== 'string' || !summary) return;
    const nextNotes = extractSessionNotes(summary);
    const meta = { sessionId: session.id, updatedAt: new Date().toISOString(), turnSeq: session.turnSeq };
    // 105d-B: 增量合并分支 —— read→merge→render→write,仍 fire-and-forget、整体 catch 绝不阻断回合。
    // 已知限制:read→merge→write 不在 per-session 写链内,依赖「同会话 L2 串行」这一既有事实。
    if (sessionNotesMergeEnabled(config)) {
      Promise.resolve()
        .then(() => readSessionNotes(session.id))
        .then(prev => writeSessionNotes(session.id, renderSessionNotesMarkdown(mergeSessionNotes(prev, nextNotes), meta)))
        .catch(() => {});
      return;
    }
    const md = renderSessionNotesMarkdown(nextNotes, meta);
    writeSessionNotes(session.id, md).catch(() => {});
  } catch { /* session notes 是旁车副本,绝不阻断回合 */ }
}

// ── 105c: 摘要实体确定性抽检(23 号方案 §4.1)──────────────────────────────────
// L2 摘要产出后,对【摘要输入原文】做确定性实体抽检:路径/版本/带量级数字/ISO 日期/代号(反引号、「」)。
// 采样上限 maxSamples(按最近出现位置+频次排序,越近的事实越该保住);样本不足 minSamples 直接跳过,
// 不臆造检查。有缺失 → 给出缺失清单并【恰好一次】定向修补(只发 当前摘要+缺失清单,不重发全量历史);
// 修补网络失败或修补稿结构校验不过 → 保留原摘要;修补稿一经采用,即便仍有缺失也不再二次重试。
// 开关 runtimeSummaryEntityCheckV1 经真实历史+DeepSeek 采用门后默认开启;显式 false = 零检查、零修补、零事件。
const SUMMARY_ENTITY_RULES = CONTEXT_GOVERNANCE_RULES.summary.entityCheck || {};
const SUMMARY_ENTITY_PATTERNS = (() => {
  const out = [];
  const src = SUMMARY_ENTITY_RULES.patterns || {};
  for (const kind of ['winPath', 'slashPath', 'version', 'isoDate', 'unitNumber', 'bigNumber', 'backtick', 'cjkQuote']) {
    try {
      if (typeof src[kind] === 'string' && src[kind]) {
        // slashPath/backtick/cjkQuote 的实体在捕获组 1(前缀/包裹符不算实体本体)。
        out.push({ kind, re: new RegExp(src[kind], 'g'), grouped: kind === 'slashPath' || kind === 'backtick' || kind === 'cjkQuote' });
      }
    } catch { /* 坏模式不阻断压缩 */ }
  }
  return out;
})();
function extractSummaryEntities(text, rules) {
  const r = rules && typeof rules === 'object' ? rules : SUMMARY_ENTITY_RULES;
  const maxEntityChars = Number.isFinite(r.maxEntityChars) ? r.maxEntityChars : 120;
  const maxSamples = Number.isFinite(r.maxSamples) ? r.maxSamples : 12;
  const scanChars = Number.isFinite(r.scanChars) ? r.scanChars : 200000;
  const raw = String(text || '');
  const scan = raw.length > scanChars ? raw.slice(raw.length - scanChars) : raw; // 尾部优先
  const found = new Map(); // entity -> { count, last }
  for (const p of SUMMARY_ENTITY_PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(scan))) {
      const idx = m.index;
      if (p.re.lastIndex === idx) p.re.lastIndex++; // 零宽保护
      let v = String(p.grouped && m[1] != null ? m[1] : m[0]);
      v = v.replace(/^[.,;:!?([{《"'「、，。；：\s]+/, '').replace(/[.,;:!?)\]}》》"',、，。；：\s]+$/, ''); // 毗邻标点不属实体
      if (v.length < 2 || v.length > maxEntityChars) continue;
      if (p.kind === 'slashPath') {
        const slashes = (v.match(/\//g) || []).length;
        // 噪声过滤:and/or、10/20 这类单斜杠且无扩展名、无前导斜杠的串不算路径实体。
        if (!v.startsWith('/') && slashes < 2 && !/\.[A-Za-z0-9]{1,10}$/.test(v)) continue;
      }
      const cur = found.get(v);
      if (cur) { cur.count++; if (idx > cur.last) cur.last = idx; }
      else found.set(v, { count: 1, last: idx });
    }
  }
  // 包含清扫:被更长候选包含的短项不重复抽检(2026 ⊂ 2026-08-31;2.6.2 ⊂ v2.6.2)。
  const vals = [...found.keys()];
  const kept = vals.filter(a => !vals.some(b => b !== a && b.length > a.length && b.includes(a)));
  return kept
    .sort((a, b) => (found.get(b).last - found.get(a).last) || (found.get(b).count - found.get(a).count))
    .slice(0, maxSamples);
}
function checkSummaryEntities(summary, entities) {
  const text = String(summary || '');
  return (Array.isArray(entities) ? entities : []).filter(e => !text.includes(e));
}
// 与 chunkHistoryByBudget 的 transcript 同口径:内容 + 工具调用,纯文本拼接,供抽检抽取。
function summarySourceText(history) {
  const parts = [];
  for (const m of (Array.isArray(history) ? history : [])) {
    if (!m) continue;
    parts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) parts.push(JSON.stringify(m.tool_calls));
  }
  return parts.join('\n');
}
// ── 105g(4.3 首项): map-reduce 全局事实表 ─────────────────────────────────────
// 真实分块(chunks>1)时,并行的分段摘要互相看不到对方块内的约束/决定,跨块事实易丢。这里从完整
// 历史确定性抽取全局实体表(复用 105c 抽取器,零新增 LLM 调用,条数有界),作为一条 user 消息
// 注入每个分段与每轮汇总调用。开关关时两条消息都为 null,请求体逐字节不变。
const SUMMARY_FACT_TABLE_RULES = CONTEXT_GOVERNANCE_RULES.summary.factTable || {};
function buildSummaryFactTableMessages(history, maxSamplesOverride) {
  const requested = Number(maxSamplesOverride);
  const ruleDefault = Number.isFinite(Number(SUMMARY_FACT_TABLE_RULES.maxSamples)) ? Number(SUMMARY_FACT_TABLE_RULES.maxSamples) : 64;
  const maxSamples = Number.isFinite(requested) ? Math.min(64, Math.max(4, Math.round(requested))) : ruleDefault;
  const entities = extractSummaryEntities(summarySourceText(history), { ...SUMMARY_ENTITY_RULES, maxSamples });
  if (!entities.length) return { entities: 0, chunk: null, reduce: null };
  const header = String(SUMMARY_FACT_TABLE_RULES.header || '【全局事实表】');
  const table = header + '\n' + entities.map(v => '- ' + v).join('\n');
  const mk = directive => ({ role: 'user', content: table + '\n' + String(directive || '') });
  return {
    entities: entities.length,
    chunk: mk(SUMMARY_FACT_TABLE_RULES.chunkDirective),
    reduce: mk(SUMMARY_FACT_TABLE_RULES.reduceDirective),
  };
}
const SUMMARY_REFINE_RULES = CONTEXT_GOVERNANCE_RULES.summary.refine || {};
function buildSummaryRefineMessages(currentSummary, nextChunk, factMessage) {
  return [
    { role: 'user', content: '【当前累计摘要】\n' + String(currentSummary || '') + '\n\n【新增历史块开始】' },
    ...(Array.isArray(nextChunk) ? nextChunk : []),
    { role: 'user', content: '【新增历史块结束】' },
    ...(factMessage ? [factMessage] : []),
  ];
}
// 摘要成功出口的统一后置检查:返回要采用的 sc(原稿或修补稿)。任何内部异常都必须原样返回原稿。
async function applySummaryEntityCheck(provider, history, sc, model, opts) {
  try {
    const aux = (opts && opts.auxCtx) || {};
    const teleBase = {
      ...(aux.sessionId ? { sessionId: String(aux.sessionId) } : {}),
      ...(aux.turnSeq != null ? { turnSeq: Number(aux.turnSeq) } : {}),
      ...(aux.subagentId ? { subagentId: String(aux.subagentId) } : {}),
      trigger: String(aux.trigger || 'summary'),
    };
    const entities = extractSummaryEntities(summarySourceText(history));
    const minSamples = Number.isFinite(SUMMARY_ENTITY_RULES.minSamples) ? SUMMARY_ENTITY_RULES.minSamples : 4;
    const tele = o => { try { logEvent({ kind: 'summary_entity_check', ...teleBase, sampled: entities.length, ...o }); } catch { /* 遥测绝不阻断 */ } };
    if (entities.length < minSamples) { tele({ outcome: 'skipped_few_samples' }); return sc; }
    const missing = checkSummaryEntities(sc.summary, entities);
    if (!missing.length) { tele({ outcome: 'pass' }); return sc; }
    // 恰好一次定向修补:输入 = 当前摘要 + 缺失清单,prompt 用规则里的 repairPrompt;不重发全量历史。
    const repairMessages = [{ role: 'user', content: '【当前摘要】\n' + sc.summary + '\n\n【遗漏的必须保留事实】\n' + missing.map(v => '- ' + v).join('\n') }];
    const ectx = {
      econ: await economicsShadowEnabledCached(),
      ...teleBase,
      trigger: teleBase.trigger + '_entity_repair',
      summaryStage: 'repair',
    };
    const rc = await singleSummaryCall(provider, repairMessages, model, ectx, String(SUMMARY_ENTITY_RULES.repairPrompt || ''));
    if (!rc || !rc.ok) { tele({ outcome: 'repair_failed', missingCount: missing.length, missingSample: missing.slice(0, 8) }); return sc; }
    if (!validateStructuredSummary(rc.summary)) { tele({ outcome: 'repair_rejected', missingCount: missing.length, missingSample: missing.slice(0, 8) }); return sc; }
    // 采用修补稿:usage 聚合进 sc(修补成本计入本次压缩台账),即便仍有缺失也不再二次重试。
    const stillMissing = checkSummaryEntities(rc.summary, entities);
    if (rc.usage) {
      const prev = sc.usage || {};
      sc.usage = {
        prompt_tokens: (Number(prev.prompt_tokens != null ? prev.prompt_tokens : prev.input_tokens) || 0) + (Number(rc.usage.prompt_tokens != null ? rc.usage.prompt_tokens : rc.usage.input_tokens) || 0),
        completion_tokens: (Number(prev.completion_tokens != null ? prev.completion_tokens : prev.output_tokens) || 0) + (Number(rc.usage.completion_tokens != null ? rc.usage.completion_tokens : rc.usage.output_tokens) || 0),
        aggregated: true,
      };
    }
    sc.promptTokensEst = (Number(sc.promptTokensEst) || 0) + (Number(rc.promptTokensEst) || 0);
    sc.summary = rc.summary;
    sc.entityCheck = { sampled: entities.length, missing: missing.length, stillMissing: stillMissing.length, repaired: true };
    tele({ outcome: 'repaired', missingCount: missing.length, stillMissingCount: stillMissing.length, missingSample: missing.slice(0, 8) });
    return sc;
  } catch { return sc; }
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
async function legacySingleSummaryCall(provider, messages, model, econCtx, promptOverride, extraSignal) {
  const respStyle = provider && provider.apiStyle === 'responses';
  // 105c: promptOverride 供定向修补调用替换尾部 SUMMARY_PROMPT(默认不变)。
  const summaryPrompt = typeof promptOverride === 'string' && promptOverride ? promptOverride : SUMMARY_PROMPT;
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
    ? { model, instructions: sysIdentity, input: buildResponsesInputItems([{ role: 'system', content: sysIdentity }, ...messages, { role: 'user', content: summaryPrompt }]), stream: false }
    : { model, messages: [{ role: 'system', content: sysIdentity }, ...messages, { role: 'user', content: summaryPrompt }], stream: false }, provider, respStyle ? 'responses' : 'chat');
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
  // 105i: extraSignal 供并行 map-reduce 的 fail-fast 取消(兄弟块失败即中止本请求);与内部超时合并为一个信号。
  const mergedSignal = ctrl
    ? (extraSignal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' ? AbortSignal.any([ctrl.signal, extraSignal]) : ctrl.signal)
    : (extraSignal || undefined);
  try {
    const res = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: mergedSignal });
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
    const cancelledBySibling = e && e.name === 'AbortError' && extraSignal && extraSignal.aborted && !(ctrl && ctrl.signal.aborted);
    const failed = { ok: false, error: (e && e.name === 'AbortError') ? (cancelledBySibling ? 'summary request cancelled (sibling chunk failed)' : `summary request timed out (${Math.round(timeoutMs / 1000)}s)`) : ((e && e.message) || 'summary request failed') };
    econDone(failed); return failed;
  } finally { if (timer) clearTimeout(timer); }
}

// 105j: Responses/Chat 非流式响应统一解析。尤其要保留 status/incomplete_details/usage，不能把
// reasoning-only 或命中输出上限的响应误报成普通 empty summary。
function summaryResponseText(payload, responses) {
  if (responses) {
    let text = '';
    for (const item of (Array.isArray(payload && payload.output) ? payload.output : [])) {
      if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && (part.type === 'output_text' || part.type === 'input_text') && typeof part.text === 'string') text += part.text;
      }
    }
    return text.trim();
  }
  const msg = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.trim();
  if (Array.isArray(msg.content)) return msg.content.map(part => part && typeof part.text === 'string' ? part.text : '').join('').trim();
  return '';
}
function summaryResponseIncomplete(payload, responses) {
  const status = String(payload && payload.status || '').toLowerCase();
  const finish = String(payload && payload.choices && payload.choices[0] && payload.choices[0].finish_reason || '').toLowerCase();
  const reason = String(payload && payload.incomplete_details && payload.incomplete_details.reason || '').toLowerCase();
  return (responses && status === 'incomplete') || /^(?:length|max[_-](?:output|completion)?[_-]?tokens)$/.test(finish) || /max[_-](?:output|completion)[_-]tokens|length/.test(reason);
}
function summaryResponseFailureDetail(payload) {
  const e = payload && payload.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return String(e.message || e.code || e.type || 'provider error');
  return '';
}

// 105j: summary call policy-aware implementation. It keeps the historical six-argument signature while all
// callers gain the same bounded reasoning/output policy and one-shot compatibility fallback.
async function singleSummaryCall(provider, messages, model, econCtx, promptOverride, extraSignal) {
  const respStyle = provider && provider.apiStyle === 'responses';
  const summaryPrompt = typeof promptOverride === 'string' && promptOverride ? promptOverride : summaryPromptWithGuidance();
  const base = respStyle ? providerResponsesBase(provider.baseUrl) : providerBaseWithV1(provider.baseUrl);
  const chatUrl = base ? base + (respStyle ? '/responses' : '/chat/completions') : '';
  const headers = { 'content-type': 'application/json' };
  const key = String(provider.apiKey || '').trim();
  if (key) headers.authorization = 'Bearer ' + key;
  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  const sysIdentity = buildProviderSystemPrompt(provider, model, '', [], null, null, null, true);
  const stage = econCtx && SUMMARY_POLICY_STAGES.has(econCtx.summaryStage)
    ? econCtx.summaryStage
    : (promptOverride ? 'repair' : ((econCtx && Number(econCtx.chunkIndex) >= 1000) ? 'reduce' : ((econCtx && econCtx.chunkIndex != null) ? 'map' : 'single')));
  const policy = resolveSummaryCallPolicy(provider, model, respStyle ? 'responses' : 'chat', stage);
  const makeBody = () => {
    const body = respStyle
      ? { model, instructions: sysIdentity, input: buildResponsesInputItems([{ role: 'system', content: sysIdentity }, ...messages, { role: 'user', content: summaryPrompt }]), stream: false }
      : { model, messages: [{ role: 'system', content: sysIdentity }, ...messages, { role: 'user', content: summaryPrompt }], stream: false };
    applySummaryCallPolicy(body, policy);
    const temp = (provider.temperature !== '' && provider.temperature != null && Number.isFinite(Number(provider.temperature))) ? Number(provider.temperature) : undefined;
    if (temp !== undefined) body.temperature = temp;
    return body;
  };
  if (!chatUrl || !model || typeof fetch !== 'function') {
    return { ok: false, error: !chatUrl ? 'provider base URL is not set' : (!model ? 'no model selected for this provider' : 'fetch unavailable'), summaryPolicy: summaryCallPolicyMetadata(policy) };
  }
  let timeoutMs = 180000;
  try {
    const u = new URL(String(provider && provider.baseUrl || ''));
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname) || /ollama/i.test(String(provider && (provider.id + ' ' + provider.label) || ''))) timeoutMs = 300000;
  } catch { /* retain remote default */ }
  const attempts = [];
  let compatibilityRetried = false;
  let outputRetried = false;
  const finish = result => {
    const out = { ...result, summaryPolicy: { ...summaryCallPolicyMetadata(policy), retries: Math.max(0, attempts.length - 1) } };
    if (attempts.length > 1) aggregateSummaryCalls(out, attempts);
    return out;
  };
  while (true) {
    const bodyObj = makeBody();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
    const econT0 = Date.now();
    const econDone = result => {
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
          ...(econCtx.traceId ? { traceId: String(econCtx.traceId) } : {}),
          ...(econCtx.subagentId ? { subagentId: String(econCtx.subagentId) } : {}),
          trigger: String(econCtx.trigger || 'summary'),
          model: String(model || ''), apiStyle: respStyle ? 'responses' : 'chat', ok: okRes,
          usageSource: okRes && hasUsage ? 'provider' : 'missing', inputTokens: uIn, outputTokens: uOut,
          ...(okRes && hasUsage && typeof cachedInputTokensFromUsage === 'function' ? { cachedInputTokens: Math.min(uIn, cachedInputTokensFromUsage(u)) } : {}),
          ...(econCtx.chunkIndex ? { mapReduceChunk: Number(econCtx.chunkIndex) } : {}), httpMs: Date.now() - econT0,
        });
      } catch { /* shadow accounting must never break compaction */ }
    };
    const mergedSignal = ctrl
      ? (extraSignal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function' ? AbortSignal.any([ctrl.signal, extraSignal]) : ctrl.signal)
      : (extraSignal || undefined);
    try {
      const res = await fetch(chatUrl, { method: 'POST', headers, body: JSON.stringify(bodyObj), signal: mergedSignal });
      if (!res || !res.ok) {
        let d = ''; if (res) { try { d = await res.text(); } catch { /* ignore */ } }
        const detail = `HTTP ${res ? res.status : '?'}${d ? ': ' + redact(d.slice(0, 300)) : ''}`;
        const failed = { ok: false, error: detail, promptTokensEst: estimateHistoryTokens(bodyObj.messages || bodyObj.input) };
        const rejected = summaryUnsupportedParameterFields(res && res.status, detail, policy);
        econDone(failed); attempts.push(failed);
        if (!compatibilityRetried && rejected.length) {
          compatibilityRetried = true;
          markSummaryCallPolicyUnsupported(policy, rejected);
          if (rejected.includes('reasoning')) policy.reasoning = { mode: 'omit' };
          if (rejected.includes('output')) policy.output.field = '';
          continue;
        }
        return finish(failed);
      }
      const payload = await res.json().catch(() => null);
      const summary = summaryResponseText(payload, respStyle);
      const usage = (payload && payload.usage) || null;
      const promptTokensEst = estimateHistoryTokens(bodyObj.messages || bodyObj.input);
      let result;
      if (payload && String(payload.status || '').toLowerCase() === 'failed') {
        const detail = summaryResponseFailureDetail(payload);
        result = { ok: false, error: `provider returned failed summary${detail ? ': ' + redact(detail.slice(0, 300)) : ''}`, usage, promptTokensEst };
      } else if (summaryResponseIncomplete(payload, respStyle)) {
        const reason = String(payload && payload.incomplete_details && payload.incomplete_details.reason || (payload && payload.choices && payload.choices[0] && payload.choices[0].finish_reason) || 'output limit');
        result = { ok: false, error: `provider returned an incomplete summary (${reason})`, incomplete: true, usage, promptTokensEst };
      } else if (!summary) {
        result = { ok: false, error: 'provider returned an empty summary', usage, promptTokensEst };
      } else {
        result = { ok: true, summary, usage, model, promptTokensEst };
      }
      econDone(result); attempts.push(result);
      if (result.incomplete && !outputRetried && policy.output && policy.output.field && policy.output.tierIndex < policy.output.tiers.length - 1) {
        outputRetried = true;
        policy.output.tierIndex += 1;
        continue;
      }
      return finish(result);
    } catch (e) {
      const cancelledBySibling = e && e.name === 'AbortError' && extraSignal && extraSignal.aborted && !(ctrl && ctrl.signal.aborted);
      const failed = { ok: false, error: (e && e.name === 'AbortError') ? (cancelledBySibling ? 'summary request cancelled (sibling chunk failed)' : `summary request timed out (${Math.round(timeoutMs / 1000)}s)`) : ((e && e.message) || 'summary request failed') };
      econDone(failed); attempts.push(failed); return finish(failed);
    } finally { if (timer) clearTimeout(timer); }
  }
}

function aggregateSummaryCalls(target, calls) {
  let aggIn = 0, aggOut = 0, aggEst = 0;
  for (const r of (Array.isArray(calls) ? calls : [])) {
    if (r && r.usage) {
      aggIn += Number(r.usage.prompt_tokens != null ? r.usage.prompt_tokens : r.usage.input_tokens) || 0;
      aggOut += Number(r.usage.completion_tokens != null ? r.usage.completion_tokens : r.usage.output_tokens) || 0;
    }
    aggEst += Number(r && r.promptTokensEst) || 0;
  }
  if (aggIn > 0 || aggOut > 0) target.usage = { prompt_tokens: aggIn, completion_tokens: aggOut, aggregated: true };
  target.promptTokensEst = aggEst;
  return target;
}

async function providerSummaryCallCore(provider, history, opts) {
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
  // 105f:开关开时预算 = 窗口 − reserve(分量见 summarySingleShotReserveTokens),余量不再一刀切半价。
  const singleOn = summarySingleShotEnabled(opts && opts.config);
  const summaryWindow = providerContextWindow(provider, model);
  const budget = Math.max(4000, singleOn
    ? summaryWindow - summarySingleShotReserveTokens()
    : Math.floor(summaryWindow * SUMMARY_INPUT_BUDGET_RATIO));
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
  // 105f:开关开时上限走可配置档位(默认 32K≈旧常量),关时保持 22-S0 常量 32000 逐字节不变。
  const singleCap = singleOn ? summarySingleShotCap(opts && opts.config, provider, model) : SUMMARY_SINGLE_SHOT_MAX_EST;
  const forceChunks = !fitted.needsMapReduce && singleEstimate > singleCap; // 肥单发 → 分块,让每次真实尝试远离超时悬崖
  let degradedFromSingle = false;
  if (!fitted.needsMapReduce && !forceChunks) {
    const sc = await singleSummaryCall(provider, fitted.messages, model, ectxBase);
    if (sc.ok && fitted.droppedMiddle) sc.droppedMiddle = fitted.droppedMiddle;
    if (sc.ok && !validateStructuredSummary(sc.summary)) return { ok: false, error: 'structured summary validation failed (missing sections); 降级保留原文' };
    // 105f:仅【可识别的上下文超窗 400】(isContextOverflowError 共现语义,宁可漏判不误判)自动降级
    // map-reduce;其余失败(超时/5xx/非超窗 400/校验失败)原样上浮,调用方保留 L1 降级。失败调用
    // 已由 singleSummaryCall 的 econ 账目计入成本(105 总门「额外失败调用计入成本」)。
    if (sc.ok || !singleOn || !isContextOverflowError(sc.error)) return sc;
    degradedFromSingle = true;
  }
  // map-reduce:分组 → 逐组摘要 → 总摘要。任一组失败即整体失败(错误原样上浮,调用方保留 L1 降级)。
  const chunks = chunkHistoryByBudget(history, (forceChunks || degradedFromSingle)
    ? Math.min(budget, Math.max(4000, Math.floor(singleCap * 0.75))) // 22-S0:肥单发分块时压低每组目标;105f 400 降级同目标(单发已证明该量级越窗)
    : budget);
  if (chunks.length <= 1) {
    const sc = await singleSummaryCall(provider, chunks[0] || [], model, ectxBase);
    if (sc.ok && !validateStructuredSummary(sc.summary)) return { ok: false, error: 'structured summary validation failed (missing sections); 降级保留原文' };
    return sc;
  }
  // 105g: 开关开且真实分块时构建全局事实表注入消息(确定性抽取,零新增 LLM 调用);
  // 开关关时两条消息皆 null,分段/汇总请求体与现状逐字节一致。
  const factTable = summaryFactTableEnabled(opts && opts.config)
    ? buildSummaryFactTableMessages(history, summaryFactTableCap(opts && opts.config))
    : null;
  const factChunkMsg = factTable && factTable.chunk;
  const factReduceMsg = factTable && factTable.reduce;
  // 105h: 2–4 块可选顺序 refine。首块先产出累计摘要,后续块逐次修订;每一步都必须通过
  // 五节结构校验。任一步失败不采用半成品,而是从原始 history 完整重跑下方现有 map-reduce。
  // 开关关时本分支零调用、零消息构造,105g 请求序列与请求体逐字节不变。
  const refineMaxChunks = Number.isFinite(Number(SUMMARY_REFINE_RULES.maxChunks)) ? Number(SUMMARY_REFINE_RULES.maxChunks) : 4;
  const refineOn = summaryRefineEnabled(opts && opts.config) && chunks.length >= 2 && chunks.length <= refineMaxChunks;
  const refineCalls = [];
  let refineFailure = '';
  if (refineOn) {
    let current = await singleSummaryCall(provider, factChunkMsg ? [...chunks[0], factChunkMsg] : chunks[0], model, { ...ectxBase, chunkIndex: 1, summaryStage: 'refine' });
    refineCalls.push(current);
    if (!current.ok) refineFailure = 'request';
    else if (!validateStructuredSummary(current.summary)) refineFailure = 'validation';
    for (let ci = 1; !refineFailure && ci < chunks.length; ci++) {
      current = await singleSummaryCall(
        provider,
        buildSummaryRefineMessages(current.summary, chunks[ci], factReduceMsg),
        model,
        { ...ectxBase, chunkIndex: ci + 1, summaryStage: 'refine' },
        String(SUMMARY_REFINE_RULES.prompt || SUMMARY_PROMPT),
      );
      refineCalls.push(current);
      if (!current.ok) refineFailure = 'request';
      else if (!validateStructuredSummary(current.summary)) refineFailure = 'validation';
    }
    if (!refineFailure) {
      aggregateSummaryCalls(current, refineCalls);
      current.mapReduce = {
        chunks: chunks.length,
        rounds: Math.max(1, chunks.length - 1),
        refine: { steps: chunks.length, calls: refineCalls.length },
        ...(degradedFromSingle ? { degradedFromSingle: true } : {}),
        ...(factTable && factTable.entities ? { factTable: { entities: factTable.entities } } : {}),
      };
      return current;
    }
  }
  // 分段数量多时，直接拼接 partials 会再次越过摘要输入预算。逐轮把摘要按同一
  // user-block 预算分组，直到可以安全地单发总摘要；最多 12 轮，防止异常模型输出
  // 不收敛时无限调用。每轮仍复用同一个结构化 SUMMARY_PROMPT。
  const calls = [];
  // 105i: 整个 map-reduce 共用一个 fail-fast 信号 —— 任一块/组失败即取消其余在飞与未派发的请求。
  const failCtrl = typeof AbortController === 'function' ? new AbortController() : null;
  const summaryConcurrency = summaryMaxConcurrent(opts && opts.config, provider, model);
  const rememberCall = async (messages, context, signal) => {
    const r = await singleSummaryCall(provider, messages, model, context, undefined, signal);
    calls.push(r);
    return r;
  };
  // 各 chunk 输入互不依赖(事实表消息相同、互不看对方结果),有界并发发出;按块序取首个失败上浮,
  // 保持原串行的失败语义(差异:失败时在飞请求被取消并记账,不再发出未派发的块)。
  const initialCalls = await mapSummaryWithLimit(chunks, summaryConcurrency, (ci) =>
    rememberCall(factChunkMsg ? [...chunks[ci], factChunkMsg] : chunks[ci], { ...ectxBase, chunkIndex: ci + 1, summaryStage: 'map' }, failCtrl && failCtrl.signal), failCtrl);
  let firstChunkFail = null;
  for (const r of initialCalls) if (r && !r.ok) { firstChunkFail = r; break; } // 跳过未派发空位,按块序取真实失败
  if (firstChunkFail) return firstChunkFail;
  let partialResults = initialCalls;
  let final = null;
  for (let round = 0; round < 12 && partialResults.length > 1; round++) {
    const rows = partialResults.map((r, i) => ({
      role: 'user',
      content: `【分段摘要 ${i + 1}/${partialResults.length}】\n${r.summary}`,
    }));
    const groups = chunkHistoryByBudget(rows, budget);
    if (groups.length === 1) {
      final = await rememberCall([{
        role: 'user',
        content: groups[0].map(m => m.content).join('\n\n') + '\n\n请把以上各分段摘要汇总为一份完整摘要。',
      }, ...(factReduceMsg ? [factReduceMsg] : [])], { ...ectxBase, summaryStage: 'reduce' });
      break;
    }
    // 同一轮内各归并组互不依赖,有界并发;轮次之间仍串行(下一轮输入依赖本轮输出)。
    const next = await mapSummaryWithLimit(groups, summaryConcurrency, (gi) => rememberCall([{
      role: 'user',
      content: groups[gi].map(m => m.content).join('\n\n') + '\n\n请把以上各分段摘要汇总为一份完整摘要。',
    }, ...(factReduceMsg ? [factReduceMsg] : [])], { ...ectxBase, chunkIndex: 1000 + (round * 100) + gi + 1, summaryStage: 'reduce' }, failCtrl && failCtrl.signal), failCtrl);
    let firstGroupFail = null;
    for (const r of next) if (r && !r.ok) { firstGroupFail = r; break; }
    if (firstGroupFail) return firstGroupFail;
    partialResults = next;
  }
  if (!final && partialResults.length === 1) final = partialResults[0];
  if (!final) return { ok: false, error: 'map-reduce consolidation did not converge; 降级保留原文' };
  if (!final.ok) return final;
  if (!validateStructuredSummary(final.summary)) return { ok: false, error: 'structured summary validation failed (missing sections); 降级保留原文' };
  // 所有 refine 尝试(若有)与 reduce 轮都纳入一次压缩的 aux 用量，避免降级后把额外尝试成本藏掉。
  aggregateSummaryCalls(final, [...refineCalls, ...calls]);
  final.mapReduce = {
    chunks: chunks.length,
    rounds: Math.max(1, calls.length - chunks.length),
    concurrency: summaryConcurrency,
    ...(degradedFromSingle ? { degradedFromSingle: true } : {}),
    ...(refineFailure ? { degradedFromRefine: true, refineCalls: refineCalls.length, refineFailure } : {}),
    ...(factTable && factTable.entities ? { factTable: { entities: factTable.entities } } : {}),
  };
  return final;
}

// 105c: 实体抽检 wrapper —— providerSummaryCallCore 的唯一出口增强点。开关关/摘要不成功/抽检内部异常
// 都原样透传;只有 sc.ok 且显式开启时才做抽样检查与一次定向修补(见 applySummaryEntityCheck)。
async function providerSummaryCall(provider, history, opts) {
  const sc = await providerSummaryCallCore(provider, history, opts);
  if (!sc || !sc.ok) return sc;
  if (!summaryEntityCheckEnabled(opts && opts.config)) return sc;
  const model = String(sc.model || (opts && opts.model) || (provider && provider.model) || '').trim();
  return applySummaryEntityCheck(provider, history, sc, model, opts);
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
  const sc = await providerSummaryCall(resolved.provider, history, { model: resolved.model, config, auxCtx: { sessionId: String(sessionId || ''), trigger: 'agent_external_manual' } });
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

// L2 SUMMARY RESEED boundary. Keep as many complete recent user turns as fit `maxTailTokens`; all older
// history is represented by the structured summary. A kept slice always starts at role:'user', so it cannot
// orphan an assistant tool_call or its tool result. If the newest whole user turn alone exceeds the cap,
// return history.length: it remains in the summary instead of violating the fixed-tail budget.
function recentTurnsBoundary(history, maxTailTokens) {
  if (!Array.isArray(history)) return 0;
  const cap = Math.max(0, Math.floor(Number(maxTailTokens == null ? COMPACT_RESEED_TAIL_MAX_TOKENS : maxTailTokens) || 0));
  if (!cap) return history.length;
  const starts = userBlockStarts(history);
  let boundary = history.length, keptTokens = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const begin = starts[i], end = starts[i + 1] || history.length;
    const turnTokens = estimateHistoryTokens(history.slice(begin, end));
    if (keptTokens + turnTokens > cap) break;
    keptTokens += turnTokens;
    boundary = begin;
  }
  return boundary;
}

// 第104波：所有自动压缩入口共享同一份不可变计划语义。计划只计算预算、完整回合尾部与
// 重播种形状；摘要执行、持久化和事件仍由各 owner 负责，因此不会把副作用重新揉成一团。
const CompactionPlan = (() => {
  const defaults = CONTEXT_GOVERNANCE_RULES.compactionPlan;
  function create(options = {}) {
    const history = Array.isArray(options.history) ? options.history : [];
    const provider = options.provider || null;
    const model = String(options.model || provider && provider.model || '');
    const threshold = Number(options.config && options.config.autoCompactThreshold) || defaults.defaultThreshold;
    const window = options.conversationWindow
      ? providerConversationContextWindow(options.config || {}, provider, model)
      : providerContextWindow(provider, model);
    const budget = threshold * window;
    const tailBudget = Math.max(defaults.minimumTailTokens, Math.min(
      COMPACT_RESEED_TAIL_MAX_TOKENS,
      Math.floor(budget * defaults.tailBudgetRatio)
    ));
    const boundary = recentTurnsBoundary(history, tailBudget);
    const task = history.find(message => message && message.role === 'user') || history[0] || null;
    return Object.freeze({
      schema: 1,
      scope: options.scope === 'subagent' ? 'subagent' : 'main',
      trigger: String(options.trigger || 'auto'),
      threshold,
      window,
      budget,
      tailBudget,
      boundary,
      task,
      kept: boundary <= 0 ? [] : history.slice(boundary),
    });
  }
  function reseed(plan, summary) {
    const forced = plan && plan.trigger === 'forced_400';
    const subagent = plan && plan.scope === 'subagent';
    const heading = forced ? '【压缩摘要｜因上下文超限重播种】' : '【压缩摘要】';
    const acknowledgement = subagent
      ? '已了解原任务与以上摘要,继续推进。'
      : (forced ? '收到,已基于摘要继续。' : '收到，已基于摘要继续。');
    return [
      { role: 'user', content: '原始任务(保持聚焦):\n' + String(plan && plan.task && plan.task.content || '') + '\n\n' + heading + '\n' + String(summary || '') },
      { role: 'assistant', content: acknowledgement },
      ...((plan && plan.kept) || []),
    ];
  }
  function snapshot(plan) {
    return {
      schema: plan.schema, scope: plan.scope, trigger: plan.trigger,
      threshold: plan.threshold, window: plan.window, budget: plan.budget,
      tailBudget: plan.tailBudget, boundary: plan.boundary, keptCount: plan.kept.length,
    };
  }
  return Object.freeze({ create, reseed, snapshot });
})();

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
    const budgetPlan = CompactionPlan.create({ scope: 'subagent', trigger: 'auto', history: subHistory, provider, model: subModel, config });
    const budget = budgetPlan.budget;
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
      config,
      auxCtx: {
        ...(parentSession && parentSession.id ? { sessionId: String(parentSession.id) } : {}),
        ...(subagentId ? { subagentId: String(subagentId) } : {}),
        trigger: 'subturn_auto_L2',
      },
    });
    if (!sc || !sc.ok) { if (evaporated > 0) { emit('evaporate', after1); return true; } return false; }
    const plan = CompactionPlan.create({ scope: 'subagent', trigger: 'auto', history: subHistory, provider, model: subModel, config });
    // task0 已钉进 summary user；若整个短历史都落入尾部，不能只过滤 task0 后留下 assistant-first
    // 的片段（会破交替契约），因此改为不保留这段尾部。
    // 钉住原始 task【并入】摘要 user 消息(而非单列)——避免 [task0-user, summary-user] 两条连续 user 破坏部分 provider 的
    // 交替契约;kept 以 user 边界起切,故 reseed 天然 user→assistant→user… 交替。
    const reseeded = CompactionPlan.reseed(plan, sc.summary);
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
  const storedConfig = await readConfig();
  let session;
  try { session = await loadSession(String(sessionId || '')); }
  catch { return { ok: false, error: 'session not found' }; }
  if (!session) return { ok: false, error: 'session not found' };
  const config = configForSessionEngineRoute(storedConfig, session);
  const provider = activeOpenAiProvider(config);
  if (!provider) return { ok: false, error: 'active engine is not an OpenAI-compatible provider' };
  const compactTarget = resolveCompactionProvider(config, provider);
  const summaryProvider = compactTarget.provider || provider;
  const history = Array.isArray(session.providerHistory) ? session.providerHistory : [];
  if (!history.length) return { ok: false, error: 'no provider history to compact' };

  const sc = await providerSummaryCall(summaryProvider, history, { model: compactTarget.model, config });
  if (!sc.ok) {
    logEvent({ kind: 'provider_compact', sessionId: session.id, ok: false, provider: summaryProvider.id, model: compactTarget.model, error: sc.error });
    return { ok: false, error: sc.error };
  }
  const summary = sc.summary;
  recordCompactUsage(session, summaryProvider, sc); // v1.4-OSS 用量看板(补): 手动压缩调用入 aux 台账
  maybeWriteSessionNotes(session, summary, config); // 105b: 与自动 L2 同纪律,显式关时零副作用

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
    const budgetPlan = CompactionPlan.create({ scope: 'main', trigger: 'auto', history, provider, model, config, conversationWindow: true });
    const window = budgetPlan.window;
    const budget = budgetPlan.budget;
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
      config,
      auxCtx: { sessionId: session.id, turnSeq: session.turnSeq, trigger: 'auto_L2' },
    });
    if (!sc.ok) {
      // Level-2 failed (network/timeout). Keep the level-1 result and continue the turn — do NOT abort.
      logEvent({ kind: 'auto_compact', mode: 'summary', sessionId: session.id, ok: false, error: sc.error });
      if (compacted) { session.autoCompactWatermark = calibratedEstimate(provider, model, [sysMsg, ...history], tools); await saveSession(session).catch(() => {}); }
      return compacted;
    }
    recordCompactUsage(session, summaryProvider, sc); // v1.4-OSS 用量看板(补): 自动压缩(L2 摘要)调用入 aux 台账
    maybeWriteSessionNotes(session, sc.summary, config); // 105b: 状态三节外置到 session-notes.md,显式关时零副作用
    const plan = CompactionPlan.create({ scope: 'main', trigger: 'auto', history, provider, model, config, conversationWindow: true });
    session.providerHistory = CompactionPlan.reseed(plan, sc.summary);
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

async function streamChat(req, res) {
  const body = await readJsonBody(req);
  const storedConfig = await readConfig();
  // 第78波：交办确认卡可为【这一单当前执行链】收紧/调整安全档，但绝不回写全局配置。
  // 值域复用唯一 PERMISSION_MODES；非法/缺失值静默回落持久配置。该局部副本同时传给首回合、
  // until-done 续跑、Provider 与 Claude，避免 UI 显示一档而后端实际按另一档执行。
  const requestedPermissionMode = String(body.permissionMode || '');
  const permissionConfig = PERMISSION_MODES.includes(requestedPermissionMode)
    ? { ...storedConfig, permissionMode: requestedPermissionMode }
    : storedConfig;
  // A missing/corrupt session id must not crash the turn: fall back to a fresh session (loadSession
  // already isolated the corrupt file as .corrupt).
  const session = (body.sessionId ? await loadSession(body.sessionId) : null) || await createSession({ title: body.title, cwd: body.cwd });
  const config = configForSessionEngineRoute(permissionConfig, session);
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
    const pinnedRoute = inferSessionEngineRoute(session);
    if (pinnedRoute?.engine === 'openai' && !provider) {
      throw new Error(`会话绑定的 Provider 不可用：${pinnedRoute.providerId}`);
    }
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
