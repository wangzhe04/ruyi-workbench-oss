#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 如意工作台 server(第43波 构建期拼接模块化)
//
// 本文件(app/src/00-boot.js)是【源码模块】之一:app/server.js 是由 app/build.js
// 把 app/src/*.js 按 src/manifest.json 顺序拼接出的【产物】。改代码请改 src/ 对应
// 模块,然后 `node app/build.js` 重建产物;不要手改 app/server.js(会被下次构建覆盖)。
// 产物字节级可复现(build --check 校验),运行时零依赖单文件,气隙可审。
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cp = require('child_process');
const readline = require('readline');
const { StringDecoder } = require('string_decoder');
const zlib = require('zlib'); // v0.8-S4a: checkpoint journal gzips `before` content with the built-in zlib (gzipSync/gunzipSync) — NO npm.
const { URL, pathToFileURL } = require('url');

const APP_NAME = '如意 Ruyi'; // v0.8-S8 品牌落地(原 'Win Claude Workbench';去 Claude 化,开源商标合规)
const VERSION = '2.8.0'; // Escapade 2.8.0: 会守时、说得准、听得懂（123–127）＋发布批准点的安全修与缺陷修（107）
// Unique per running server instance; lets an updater prove the process actually restarted
// after an overlay was applied (a version string alone can't prove a restart happened).
const OVERLAY_ID = crypto.randomBytes(6).toString('hex');
const DEFAULT_PORT = 8765;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
// 127-114b(26 号文 §3/45 号文 §2 ②): ASR 转写入站专用上限 25 MB —— 早于上面的 128 MB 总闸判定
// (同一请求流里先撞哪条闸,决定 26 MB 夹具拿到的是 413 还是放行;反向:把本常量换成 MAX_BODY_BYTES
// 或把判定挪到 readBody 之后,asr-transcribe.e2e.js 的 24.9/26 MB 返回码对照当场红)。
const ASR_MAX_BODY_BYTES = 25 * 1024 * 1024;
// 13(128a,48 号文 §2):配置只落「改过的键」——显式键集合 configExplicitKeysV1 ＋ 稀疏落盘,没碰过的设置跟随
// 产品当前默认;迁移按显式键判。本号本身不挂迁移(推断每次读都跑),只标记「这份文件是稀疏格式写的」。
// 12(v2.8 / 107-T1): 126-111b/111d/111e 三个压缩开关翻成默认开,并对 schema<12 的存量配置做一次性
// 迁移(盘上显式写着的 false → true)。11 = v2.8 selectable Agent CLI driver (Claude Code / Kimi Code)。
const CONFIG_SCHEMA = 13;
// v0.8-S0: session file schema. Bumped independently of CONFIG_SCHEMA; normalizeSession backfills.
const SESSION_SCHEMA = 1;

function isPkg() {
  return typeof process.pkg !== 'undefined';
}

function exePath() {
  return isPkg() ? process.execPath : process.argv[1];
}

function appRoot() {
  return path.resolve(__dirname, '..');
}

function dataRoot() {
  // v0.8-S8 品牌落地:RUYI_HOME 优先于旧的 WIN_CLAUDE_WORKBENCH_HOME。兼容策略——两者都识别,
  // 新变量优先;旧变量至少保留一个大版本(兼容承诺),存量部署/脚本不受影响。子进程注入的
  // 仍是旧变量名(值=已解析 dataRoot),故老 .mcp.json 与桥接子进程照常工作。默认目录名保持
  // .win-claude-workbench 不变(改目录名会破坏存量用户数据迁移,与 MCP id/exe 一样)。
  // 【存量兼容标识 — 发布后至少保留一个大版本】v1.0-S9 发布确认:目录改名 ruyi-workbench 已落地,
  // 但 env 变量名 WIN_CLAUDE_WORKBENCH_HOME 与默认数据目录 .win-claude-workbench 有意保持不变(存量兼容,建议 v2.0 收口)。
  return process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(os.homedir(), '.win-claude-workbench');
}

function externalRoot() {
  return isPkg() ? path.dirname(process.execPath) : appRoot();
}

// A Full offline release ships one verified CPython beside ACC. ACC already starts that interpreter
// by absolute path, but ordinary task commands (`python ...`) inherit the server PATH. Without this
// bridge a clean intranet machine either reports Python missing or falls through to an unrelated
// system Python that cannot import openpyxl/winsdk. Expose the bundled interpreter process-wide so
// native provider tools, Claude CLI children, PowerShell tasks, and direct Ruyi.exe launches agree.
function exposeBundledPythonRuntime() {
  if (process.platform !== 'win32') return '';
  const pythonDir = path.join(externalRoot(), 'mcp', 'ai-computer-control', 'python_embed');
  const pythonExe = path.join(pythonDir, 'python.exe');
  try { if (!fs.existsSync(pythonExe)) return ''; } catch { return ''; }
  const currentPath = String(process.env.PATH || process.env.Path || '');
  const pathDirs = currentPath.split(path.delimiter).filter(Boolean);
  if (!pathDirs.some(dir => path.resolve(dir).toLowerCase() === path.resolve(pythonDir).toLowerCase())) {
    process.env.PATH = [pythonDir, ...pathDirs].join(path.delimiter);
  }
  process.env.PYTHON = pythonExe;
  process.env.PYTHONUTF8 = '1';
  // Keep the signed release runtime immutable when user scripts import source-only packages.
  process.env.PYTHONDONTWRITEBYTECODE = '1';
  process.env.RUYI_BUNDLED_PYTHON = pythonExe;
  return pythonExe;
}

const BUNDLED_PYTHON_RUNTIME = exposeBundledPythonRuntime();

const paths = {
  data: dataRoot(),
  config: path.join(dataRoot(), 'config.json'),
  sessions: path.join(dataRoot(), 'sessions'),
  uploads: path.join(dataRoot(), 'uploads'),
  logs: path.join(dataRoot(), 'logs'),
  generated: path.join(dataRoot(), 'generated'),
  checkpoints: path.join(dataRoot(), 'checkpoints'), // v0.8-S4a: file-checkpoint journal (per-session)
  playbooks: path.join(dataRoot(), 'playbooks'), // v0.9-S2: user-authored playbooks (built-ins ship in resources/)
  skills: path.join(dataRoot(), 'skills'), // v1 技能体系: 用户级技能 skills/<id>/SKILL.md(内置技能仍在 resources/,项目技能在 <cwd>/.ruyi/skills)
  webcache: path.join(dataRoot(), 'webcache'), // v0.9-S9: web_fetch main-text cache (<sha256(url)>.json), offline-reusable
  agentRuns: path.join(dataRoot(), 'agent-runs'), // persistent DAG workflow state, grouped by session
  agentWorkflows: path.join(dataRoot(), 'agent-workflows'), // personal reusable DAG templates
  agentWorktrees: path.join(dataRoot(), 'agent-worktrees'), // optional isolated write-agent worktrees (outside the repo)
  usage: path.join(dataRoot(), 'usage'),
  memory: path.join(dataRoot(), 'memory'), // v2 跨会话记忆(团队模式 v2 Phase3): global/ 与 project/<projectKey>/ // v1.4-OSS 用量看板: append-only monthly cost ledgers usage/YYYY-MM.jsonl
};

// v1 技能体系: 技能/目录名的安全字符集(供落盘 skills/<id>/、防路径穿越)。复用同 playbook id 的形状。
const SKILL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const LEGACY_API_ERROR_CODES = new Map([
  ['missing or invalid workbench token', 'auth.token_invalid'],
  ['bad token', 'auth.token_invalid'],
  ['invalid sessionId', 'session.id_invalid'],
  ['sessionId required', 'session.id_required'],
  ['session not found', 'session.not_found'],
  ['method not allowed', 'api.method_not_allowed'],
  ['host not allowed', 'api.host_rejected'],
  ['unknown action', 'request.action_unknown'],
  // 128b:撤回相关的三句裸串给稳定码(否则一律落成 api.request_failed,前端只能把原串 'rewind_superseded' 摆给用户看)。
  ['rewind_superseded', 'session.rewind_superseded'],
  ['session.rewound_during_write', 'session.rewound_during_write'],
  ['session.history_changed_during_compact', 'session.history_changed_during_compact'],
]);

// Keep the legacy message as an optional diagnostic while ensuring every HTTP error has a stable,
// language-neutral machine code. Individual routes can still use apiFailure() for a richer code/params.
function normalizeApiErrorPayload(data) {
  if (!data || data.ok !== false || typeof data.error !== 'string') return data;
  const message = data.error;
  const { error, ...rest } = data;
  return {
    ...rest,
    error: {
      code: LEGACY_API_ERROR_CODES.get(message) || 'api.request_failed',
      params: {},
      message,
    },
  };
}

function json(data, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(normalizeApiErrorPayload(data), null, 2),
  };
}

// P2 API error contract. Error codes and params are stable/localization-friendly; message remains a
// diagnostic fallback for older callers while the front end migrates away from sentence matching.
function apiFailure(code, params = {}, message = '', status = 400) {
  return json({
    ok: false,
    error: {
      code: String(code || 'api.unknown'),
      params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
      ...(message ? { message: String(message) } : {}),
    },
  }, status);
}

function text(data, status = 200, headers = {}) {
  return {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
    body: data,
  };
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// 117q-B1(30 号文 §4.1):子进程 stdout 的 NDJSON 逐行喂入器。为什么必须走 StringDecoder ——
// chunk 边界不保证落在字符边界上,而 CJK 是 3 字节:对每个 chunk 单独 toString('utf8') 会把
// 被切开的汉字静默变成 U+FFFD,后续续接字节也解码成垃圾。这是一个以中文为主的产品的主干道。
// flush() 负责子进程关闭后把 decoder 里的残字与最后那半行交出去(三者协议都是「一行一个 JSON」)。
function createNdjsonLineFeeder(onLine) {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  return {
    push(chunk) {
      remainder += decoder.write(chunk);
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) onLine(line);
    },
    flush() {
      remainder += decoder.end();
      if (remainder.trim()) onLine(remainder);
      remainder = '';
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// P2-8(30号文§3 总表 + §4「中和伪造围栏标签」判据): 防提示词注入的判据 —— 曾在 06d/06e/06/09 手写 6 遍
// (workbench-memory / workbench-memory-core / mission-ledger / project-memory / skill-index /
// workbench-plan-approved),六处形状完全一致(gi 标志 + 可选斜杠捕获组),判据一致全靠人工复制维持。把不可信
// 文本里可能出现的 `<TAG`/`</TAG` 前括号换成方括号,让模型吐出来的文本不能提前闭合/伪造调用方外层拼接的固定
// 字面围栏(如 <workbench-memory>…</workbench-memory>)。方括号与尖括号同为 1 字符/1 字节,替换不改变长度,
// 不影响调用方紧随其后的字符/字节预算截断算术。只做这一步替换 —— 调用方各自原有的空白折叠(`\s+`→' ')/
// trim/null 兜底/截断等链式处理保持原样,不并入本函数(各处链式处理的必要差异见各调用点)。
function neutralizeFenceTag(text, tagName) {
  return String(text).replace(new RegExp('<(/?)' + tagName, 'gi'), '[$1' + tagName);
}

// P2-9(30号文§3 总表 + §8.9②): 工具分级排序表 —— 现有 07-autonomy.js/08-agent-runs.js(×3)/
// 09b-replan-ledger.js(×2)六处独立声明字面量 `{read:0,edit:1,exec:2}`,判据一致(数值越大权限越宽)全靠
// 人工复制维持。这是【权限升级判据】—— 08/09b 拿它判"子代理这次调用的工具是否超出授权层级"、"replan
// 补丁是否试图把节点 tier 抬高",分叉的后果是越权。117q-B5 曾把它落在 07-autonomy.js,但 09b 此前从未
// 消费 07 的任何符号,那次收编因此新增了一条循环边 09b-replan-ledger.js->07-autonomy.js,被迫登记进
// module-dependency-policy.json 的白名单(117q-B7 已撤回该条目 —— 移完后 09b 不再引用 07 的任何符号,
// 那条边真的不存在了)。落回本文件(00-boot.js)则 07/08/09b 三个消费者全部已经依赖 00-boot,新增边数
// 为零——它本就只是一张纯查表常量,没有任何 autonomy 语义。冻结防意外改写。
const TOOL_TIER_RANK = Object.freeze({ read: 0, edit: 1, exec: 2 });

// P2-16(30号文§3 总表): argsHash 指纹算法两份字面相同 —— 06f-autonomy-grants.js::consumeGrant(用量事件,
// 收对象 args)与 09b-replan-ledger.js::recordNodeContinuation(节点续点 pending 步骤,收预先算好的
// argsStr 字符串)各自手写一遍 sha1+hex 截 12 位。收拢两处 best-effort 语义:入参已经是字符串就直接用,
// 否则 JSON.stringify(args || {});任何异常兜底返回空串(与两处原有 try/catch 兜底行为一致,不让指纹计算
// 炸调用方主流程)。纯函数,只吃入参、无 IO。
function hashArgs(args) {
  try {
    const str = typeof args === 'string' ? args : JSON.stringify(args || {});
    return crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

async function ensureDirs() {
  await Promise.all([
    fsp.mkdir(paths.data, { recursive: true }),
    fsp.mkdir(paths.sessions, { recursive: true }),
    fsp.mkdir(paths.uploads, { recursive: true }),
    fsp.mkdir(paths.logs, { recursive: true }),
    fsp.mkdir(paths.generated, { recursive: true }),
    fsp.mkdir(paths.checkpoints, { recursive: true }),
    fsp.mkdir(paths.playbooks, { recursive: true }), // v0.9-S2
    fsp.mkdir(paths.skills, { recursive: true }), // v1 技能体系: 用户级技能目录
    fsp.mkdir(paths.webcache, { recursive: true }), // v0.9-S9
    fsp.mkdir(paths.agentRuns, { recursive: true }),
    fsp.mkdir(paths.agentWorkflows, { recursive: true }),
    fsp.mkdir(paths.agentWorktrees, { recursive: true }),
    fsp.mkdir(paths.usage, { recursive: true }), // v1.4-OSS 用量看板: append-only monthly ledgers
    fsp.mkdir(paths.memory, { recursive: true }), // v2 跨会话记忆: 记忆库根(global/ 与 project/<projectKey>/ 按需建)
  ]);
}

// ===== v1.4-OSS 用量/成本账本 (append-only monthly ledger) ================================================
// Each finished turn (both engines) appends ONE JSON line to usage/YYYY-MM.jsonl (month = the row's UTC ts).
// Design: APPEND-ONLY, never read-modify-write, so concurrent 多会话 turns cannot corrupt a shared index the
// way a read-modify-write index could. Empty / zero-token turns are skipped. A ledger write failure is
// fire-and-forget (a non-critical persistence, like the rest) and must NEVER break the turn. Corrupt lines are
// skipped at read time (safeJsonParse per line). COST SEMANTICS: every recorded `cost` is a NOTIONAL/estimate
// figure, never an assertion of real billing (a Claude subscription or a third-party Coding Plan may not bill
// per token at all). `costTrusted:false` marks rows whose currency amount is plan-based / not a meaningful
// spend (see the Claude third-party endpoint path); aggregation keeps those OUT of the real costsByCurrency.
let usageLedgerChain = Promise.resolve();
// 128f-⑥:还没轮到的那几行(见 appendUsageLedger)。退出路径上的同步补写只动 state==='queued' 的。
const usageLedgerPending = [];
// 退出监听器里只能同步 I/O(async 版永远跑不完 —— 与 02 的 flushSessionIndexSync 同一个理由)。返回补写了几行。
function flushUsageLedgerSync() {
  let written = 0;
  for (const item of usageLedgerPending) {
    if (!item || item.state !== 'queued') continue;
    try { fs.mkdirSync(path.dirname(item.file), { recursive: true }); fs.appendFileSync(item.file, item.line, 'utf8'); item.state = 'done'; written += 1; }
    catch { /* best effort:退出路径上不许抛 */ }
  }
  return written;
}

// Resolve the ledger source + cost-trust for a Claude CLI turn. modelsApiBase EMPTY = Anthropic direct ->
// source 'claude-cli', CLI total_cost_usd usable as a NOTIONAL USD estimate. NON-EMPTY = a third-party
// Anthropic-compatible endpoint (e.g. 火山方舟 Ark Coding Plan) whose CLI-reported cost is computed with
// ANTHROPIC pricing and is therefore WRONG for that vendor (and often a flat monthly plan) -> record tokens
// only, cost null, costTrusted false, and tag the source by its known preset id (else host) so grouping stays
// honest (Claude 官方 vs Ark 等). Runs at turn time, so CLAUDE_ENDPOINT_PRESETS (declared later) is available.
function claudeLedgerSource(config) {
  let base = (config && typeof config.modelsApiBase === 'string') ? config.modelsApiBase.trim() : '';
  // v1.4-OSS 用量看板(补): 当 config.modelsApiBase 为空时,CLI 子进程仍会继承 OS 环境里的 ANTHROPIC_BASE_URL /
  // ANTHROPIC_BASE(effectiveAnthropicEnv 只在 modelsApiBase 非空时覆盖它们,否则原样穿透)。纯用环境变量把
  // Claude CLI 路由到第三方(Ark 等)时,CLI 报的 total_cost_usd 仍按 Anthropic 计价、对该厂商不可信 —— 据此把
  // costTrusted 判为 false,与显式 modelsApiBase 的第三方路径一致。
  if (!base) base = String(process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE || '').trim();
  if (!base) return { provider: 'claude-cli', costTrusted: true };
  let tag = '';
  try {
    for (const p of CLAUDE_ENDPOINT_PRESETS) { if (p && p.baseUrl && base.startsWith(p.baseUrl)) { tag = p.id; break; } }
    if (!tag) tag = 'claude-endpoint:' + new URL(base).host;
  } catch { tag = 'claude-endpoint:unknown'; }
  return { provider: tag, costTrusted: false };
}

// v1.4-OSS 用量看板(补): shared Claude-turn billing-field resolver. Extracted from the main-turn ledger append
// so BOTH the main chat turn AND a Claude sub-agent node bill identically. Cost precedence (诚实计费):
//  (1) config.claudePricing set -> tokens×price, a meaningful estimate for direct + third-party endpoints,
//      costTrusted:true; (2) else, Anthropic-direct only (claudeLedgerSource costTrusted), the CLI's reported
//      total_cost_usd as a NOTIONAL USD figure; (3) else (third-party, unpriced) cost null + costTrusted false
//      (its CLI cost is Anthropic-priced and wrong for that vendor, often a flat monthly plan not billed per token).
// computeCostFromPricing is a hoisted function declaration, so the forward reference here is safe at call time.
function claudeCostFields(config, inTok, outTok, costUsd) {
  const { provider, costTrusted: directTrust } = claudeLedgerSource(config);
  let cost = null, currency = null, costTrusted = directTrust;
  const priced = computeCostFromPricing(config && config.claudePricing, inTok, outTok);
  if (priced.currency) { cost = priced.cost; currency = priced.currency; costTrusted = true; }
  else if (directTrust) { const c = Number(costUsd); if (Number.isFinite(c)) { cost = c; currency = 'USD'; } }
  return { provider, cost, currency, costTrusted };
}

// Validate optional per-million-token pricing. Provider pricing may add cachedInputPerM and exact model
// overrides; legacy {inputPerM,outputPerM,currency} remains byte-stable after normalization.
function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parseRate = value => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const inP = parseRate(raw.inputPerM), outP = parseRate(raw.outputPerM), cachedP = parseRate(raw.cachedInputPerM);
  const cur = (typeof raw.currency === 'string') ? raw.currency.trim().slice(0, 8) : '';
  const modelRows = [];
  const seen = new Set();
  for (const row of (Array.isArray(raw.models) ? raw.models : []).slice(0, 100)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const model = typeof row.model === 'string' ? row.model.trim().slice(0, 240) : '';
    if (!model || seen.has(model)) continue;
    const modelIn = parseRate(row.inputPerM), modelOut = parseRate(row.outputPerM), modelCached = parseRate(row.cachedInputPerM);
    if (modelIn == null && modelOut == null && modelCached == null) continue;
    seen.add(model);
    modelRows.push({
      model,
      ...(modelIn == null ? {} : { inputPerM: modelIn }),
      ...(modelOut == null ? {} : { outputPerM: modelOut }),
      ...(modelCached == null ? {} : { cachedInputPerM: modelCached }),
    });
  }
  if (!cur || (inP == null && outP == null && cachedP == null && !modelRows.length)) return null;
  return {
    inputPerM: inP == null ? 0 : inP,
    outputPerM: outP == null ? 0 : outP,
    currency: cur,
    ...(cachedP == null ? {} : { cachedInputPerM: cachedP }),
    ...(modelRows.length ? { models: modelRows } : {}),
  };
}
function cachedInputTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const raw = details.cached_tokens != null ? details.cached_tokens
    : details.cache_read_input_tokens != null ? details.cache_read_input_tokens
      : usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : usage.cached_tokens;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
// Cached input is part of input tokens for OpenAI-compatible usage frames. Charge the non-cached remainder at
// inputPerM and cached tokens at cachedInputPerM; when the cache price is unset, conservatively use inputPerM.
function computeCostFromPricing(pricing, inTok, outTok, cachedInTok = 0) {
  const p = normalizePricing(pricing);
  if (!p) return { cost: null, currency: null };
  const input = Math.max(0, Number(inTok) || 0);
  const cached = Math.min(input, Math.max(0, Number(cachedInTok) || 0));
  const cachedRate = Number.isFinite(Number(p.cachedInputPerM)) ? Number(p.cachedInputPerM) : p.inputPerM;
  const cost = (input - cached) / 1e6 * p.inputPerM + cached / 1e6 * cachedRate + (Number(outTok) || 0) / 1e6 * p.outputPerM;
  return { cost: Number.isFinite(cost) ? cost : null, currency: p.currency };
}
// Exact model override wins within one provider; missing cached price continues to fall back to that row's input rate.
function computeProviderCost(provider, inTok, outTok, cachedInTok = 0, model = '') {
  const pricing = normalizePricing(provider && provider.pricing);
  if (!pricing) return { cost: null, currency: null };
  const modelId = String(model || provider && provider.model || '').trim();
  const override = Array.isArray(pricing.models) ? pricing.models.find(row => row.model === modelId) : null;
  const resolved = override ? {
    inputPerM: override.inputPerM == null ? pricing.inputPerM : override.inputPerM,
    outputPerM: override.outputPerM == null ? pricing.outputPerM : override.outputPerM,
    cachedInputPerM: override.cachedInputPerM == null ? (pricing.cachedInputPerM == null ? pricing.inputPerM : pricing.cachedInputPerM) : override.cachedInputPerM,
    currency: pricing.currency,
  } : pricing;
  return computeCostFromPricing(resolved, inTok, outTok, cachedInTok);
}

function appendUsageLedger(entry) {
  try {
    const inTok = Math.max(0, Math.round(Number(entry.inTok) || 0));
    const outTok = Math.max(0, Math.round(Number(entry.outTok) || 0));
    const cachedInTok = Math.min(inTok, Math.max(0, Math.round(Number(entry.cachedInTok) || 0)));
    // NB: Number(null) === 0, so guard null/undefined explicitly — a tokens-only turn must stay cost:null.
    const costNum = (entry.cost == null) ? NaN : Number(entry.cost);
    // v1.4-OSS 用量看板(补): skip a truly empty row — zero tokens AND no trusted positive cost. A row that reports
    // a real cost but no per-token usage (e.g. a Claude-plan aux call billed a flat amount) is KEPT so its spend
    // is not silently lost. costNum is computed above so this guard can see it.
    if (inTok <= 0 && outTok <= 0 && !(Number.isFinite(costNum) && costNum > 0)) return;
    const ts = (typeof entry.ts === 'string' && entry.ts) ? entry.ts : nowIso();
    const rec = {
      ts,
      sessionId: String(entry.sessionId || ''),
      engine: entry.engine === 'claude' ? 'claude' : 'openai',
      provider: String(entry.provider || ''),
      model: String(entry.model || ''),
      inTok, outTok, cachedInTok,
      cost: Number.isFinite(costNum) ? costNum : null,
      currency: (typeof entry.currency === 'string' && entry.currency) ? entry.currency : null,
      costTrusted: entry.costTrusted !== false, // false = plan-based / notional (kept out of real cost totals)
      estimated: entry.estimated === true,
      turnSeq: Number(entry.turnSeq) || 0,
      // v1.4-OSS 用量看板(补): kind is three-valued — 'turn' (top-level chat turn), 'subagent' (an Agent 工作流/
      // spawn_agent DAG node), or 'aux' (a non-turn helper call: 压缩摘要 / playbook 起草 等). Old rows without a
      // kind read as 'turn' (向后兼容). agentKey/subagentId are stamped only for sub-agent rows so the dashboard
      // can attribute a DAG node's spend; both truncated to a sane length.
      kind: entry.kind === 'subagent' ? 'subagent' : (entry.kind === 'aux' ? 'aux' : 'turn'),
    };
    if (entry.agentKey != null && String(entry.agentKey)) rec.agentKey = String(entry.agentKey).slice(0, 120);
    if (entry.subagentId != null && String(entry.subagentId)) rec.subagentId = String(entry.subagentId).slice(0, 120);
    // v1.4-OSS 用量看板(补): optional note tags an aux row's sub-kind (e.g. 'compact' / 'playbook-draft'), ≤40 chars.
    if (entry.note != null && String(entry.note)) rec.note = String(entry.note).slice(0, 40);
    const line = JSON.stringify(rec) + '\n';
    const file = path.join(paths.usage, ts.slice(0, 7) + '.jsonl');
    // 128f-⑥:排队的这一行先登记进 usageLedgerPending(状态 queued)—— 退出路径(SIGINT／SIGTERM／未捕获异常都走
    // process.exit)上链还没轮到它,flushUsageLedgerSync 用同步 I/O 把 queued 的补写掉;正在写的那一行(writing)
    // 不补:它落没落盘不知道,补了可能记两遍(费用翻倍比少一行更糟)。
    const pending = { file, line, state: 'queued' };
    usageLedgerPending.push(pending);
    // One global append chain so multi-session concurrent writes never interleave a half-line.
    usageLedgerChain = usageLedgerChain.then(async () => {
      try {
        if (pending.state === 'queued') {
          pending.state = 'writing';
          await fsp.mkdir(paths.usage, { recursive: true });
          await fsp.appendFile(file, line, 'utf8');
          pending.state = 'done';
        }
      } finally {
        const at = usageLedgerPending.indexOf(pending);
        if (at >= 0) usageLedgerPending.splice(at, 1);
      }
      markPretenderIndexDirty(rec.sessionId, 'usage'); // 75c: lazily refresh only this Mission's usage aggregate
      if (rec.kind === 'turn') bumpMissionChangeSeq(rec.sessionId, {
        type: 'budget',
        cursor: { turnSeq: rec.turnSeq, engine: rec.engine },
        detail: { inTok: rec.inTok, outTok: rec.outTok, cachedInTok: rec.cachedInTok, cost: rec.cost, currency: rec.currency || '', estimated: rec.estimated },
      });
    }).catch(() => {}); // fire-and-forget: a ledger failure must never wedge the chain or the turn
  } catch { /* never let accounting break a turn */ }
}

// Local-calendar day key (YYYY-MM-DD) for byDay bucketing (matches the today/month local range boundaries).
function usageDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Lower-bound instant (ms) for a range. today/month use the LOCAL calendar; week = last 7x24h; all = 0.
function usageRangeLowerMs(range, now) {
  const d = new Date(now);
  if (range === 'today') { d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (range === 'week') return now - 7 * 24 * 60 * 60 * 1000;
  if (range === 'all') return 0;
  d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); // 'month' (default)
}
// Read every ledger row with ts >= lowerMs. Reads only month files that can contain such rows (file month key
// >= the lower bound's UTC month; monotonic, so no qualifying row is missed). Corrupt lines are skipped, and a
// missing usage dir (old install) yields [] rather than throwing.
async function readUsageRows(lowerMs) {
  const rows = [];
  let files = [];
  try { files = await fsp.readdir(paths.usage); } catch { return rows; }
  const lowerKey = lowerMs > 0 ? new Date(lowerMs).toISOString().slice(0, 7) : '';
  for (const f of files) {
    if (!/^\d{4}-\d{2}\.jsonl$/.test(f)) continue;
    if (lowerKey && f.slice(0, 7) < lowerKey) continue; // whole month precedes the lower bound
    let raw = '';
    try { raw = await fsp.readFile(path.join(paths.usage, f), 'utf8'); } catch { continue; }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const rec = safeJsonParse(line, null);
      if (!rec || typeof rec !== 'object') continue; // corrupt line skipped
      const t = Date.parse(rec.ts);
      if (!Number.isFinite(t) || (lowerMs > 0 && t < lowerMs)) continue;
      rows.push(rec);
    }
  }
  return rows;
}
// Aggregate the ledger for a range into the /api/usage/summary shape. costsByCurrency holds ONLY trusted,
// non-plan-based costs; planBasedTurns counts turns whose cost is plan-based/notional (surfaced separately).
// Dimensions: engine / provider / session / day / model (117x-M1 added byModel; see its comment in the loop).
async function buildUsageSummary(range) {
  const config = await readConfig().catch(() => ({}));
  const now = Date.now();
  const rows = await readUsageRows(usageRangeLowerMs(range, now));
  // provider/source id -> display label (native providers + Claude direct + known Claude endpoints).
  const labels = new Map([['claude-cli', 'Claude CLI (Anthropic)']]);
  for (const p of (Array.isArray(config.providers) ? config.providers : [])) if (p && p.id) labels.set(String(p.id), String(p.label || p.id));
  for (const p of CLAUDE_ENDPOINT_PRESETS) if (p && p.id) labels.set(String(p.id), String(p.label || p.id));
  // session id -> title from the lightweight metadata index (no full-session scan).
  const titles = new Map();
  // 128f-⑧(Brief §4.2 第 22 条后半):修前直读盘上索引 —— 索引写是去抖 ~200 ms 的,刚改名的会话在这一窗里还是旧标题。
  // 与 listSessions 同一个叠法:盘上 → 在飞 → 排队(新的在后,墓碑删掉)。
  try {
    const idx = await readSessionIndex();
    const merged = overlayUnflushedSessionIndex(new Map((Array.isArray(idx) ? idx : []).filter(e => e && e.id).map(e => [String(e.id), e])));
    for (const [id, e] of merged) titles.set(String(id), (e && e.title) || '');
  } catch { /* index optional */ }

  const addCost = (bucket, cur, cost) => { bucket[cur] = (bucket[cur] || 0) + cost; };
  const totals = { inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, subagentTurns: 0, auxCalls: 0, estimatedTurns: 0, planBasedTurns: 0, costsByCurrency: {} };
  const byEngine = new Map(), byProvider = new Map(), bySession = new Map(), byDay = new Map(), byModel = new Map();

  for (const r of rows) {
    const inTok = Number(r.inTok) || 0, outTok = Number(r.outTok) || 0, cachedInTok = Math.min(inTok, Number(r.cachedInTok) || 0);
    const cost = Number(r.cost), cur = (typeof r.currency === 'string' && r.currency) ? r.currency : null;
    const trusted = r.costTrusted !== false;
    const hasCost = trusted && cur && Number.isFinite(cost);
    totals.inTok += inTok; totals.outTok += outTok; totals.cachedInTok += cachedInTok; totals.turns += 1;
    if (r.kind === 'subagent') totals.subagentTurns += 1; // v1.4-OSS 用量看板(补): DAG/子代理回合独立计数
    if (r.kind === 'aux') totals.auxCalls += 1; // v1.4-OSS 用量看板(补): 辅助调用(压缩/起草等)独立计数
    if (r.estimated === true) totals.estimatedTurns += 1;
    if (!trusted) totals.planBasedTurns += 1;
    if (hasCost) addCost(totals.costsByCurrency, cur, cost);
    const eng = r.engine === 'claude' ? 'claude' : 'openai';
    let em = byEngine.get(eng); if (!em) byEngine.set(eng, em = { engine: eng, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    em.inTok += inTok; em.outTok += outTok; em.cachedInTok += cachedInTok; em.turns += 1; if (!trusted) em.planBasedTurns += 1; if (hasCost) addCost(em.costsByCurrency, cur, cost);
    const pid = String(r.provider || '');
    let pm = byProvider.get(pid); if (!pm) byProvider.set(pid, pm = { provider: pid, label: labels.get(pid) || pid, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    pm.inTok += inTok; pm.outTok += outTok; pm.cachedInTok += cachedInTok; pm.turns += 1; if (!trusted) pm.planBasedTurns += 1; if (hasCost) addCost(pm.costsByCurrency, cur, cost);
    const sid = String(r.sessionId || '');
    let sm = bySession.get(sid); if (!sm) bySession.set(sid, sm = { sessionId: sid, title: titles.get(sid) || '', inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    sm.inTok += inTok; sm.outTok += outTok; sm.cachedInTok += cachedInTok; sm.turns += 1; if (!trusted) sm.planBasedTurns += 1; if (hasCost) addCost(sm.costsByCurrency, cur, cost);
    const tsMs = Date.parse(r.ts);
    const dk = usageDayKey(tsMs);
    let dm = byDay.get(dk); if (!dm) byDay.set(dk, dm = { date: dk, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} });
    dm.inTok += inTok; dm.outTok += outTok; dm.cachedInTok += cachedInTok; if (hasCost) addCost(dm.costsByCurrency, cur, cost);
    // 117x-M1: byModel. Keyed by the (engine, provider, model) TRIPLE, not by model id alone: the same id can be
    // served by two providers, and collapsing them would force us to invent one provider/engine for the entry.
    // Rows whose `model` is empty are SKIPPED entirely (NOT bucketed into a "未记录模型" group): byModel exists to
    // drive the model selector's 常用置顶/副行, and an entry with no id can neither be selected nor pinned — 设计页
    // §11.17.7 ④ spells it out: 「把 model 字段删掉 -> 该条不进 byModel 而不是记成空串」. Consequence (and the
    // invariant its lock pins): sum(byModel.turns) === sum(byEngine.turns) - (rows carrying an empty model).
    // Everything else reuses the exact same 口径 as the four dimensions above (addCost/roundB/finishGroup), so a
    // model entry's planBased flag and costsByCurrency mean precisely what a provider entry's do.
    const mid = String(r.model || '');
    if (mid) {
      const mk = JSON.stringify([eng, pid, mid]); // JSON-array key: unambiguous whatever characters an id carries
      let mm = byModel.get(mk);
      if (!mm) byModel.set(mk, mm = { model: mid, provider: pid, label: labels.get(pid) || pid, engine: eng, inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {}, lastAt: '', lastMs: 0 });
      mm.inTok += inTok; mm.outTok += outTok; mm.cachedInTok += cachedInTok; mm.turns += 1; if (!trusted) mm.planBasedTurns += 1; if (hasCost) addCost(mm.costsByCurrency, cur, cost);
      // lastAt = the ts of this group's MOST RECENT ledger row, kept as that row's own ISO string so it reads
      // exactly like the `ts` on the line it came from (设计页 §11.17.2「常用」按最近一次使用时间排序). A row whose
      // ts does not parse is ignored FOR lastAt ONLY — it still counts in this entry's tokens/turns — so lastAt can
      // never become 'Invalid Date'/NaN; a group with no parseable ts at all keeps the empty string. (readUsageRows
      // already drops unparseable-ts rows before we get here, so this is defence in depth, not a live path.)
      if (Number.isFinite(tsMs) && tsMs > mm.lastMs) { mm.lastMs = tsMs; mm.lastAt = String(r.ts); }
    }
  }
  // Round every currency bucket to 6 dp to shed binary-float noise (0.30000000000000004 -> 0.3), and derive a
  // per-entry planBased flag: true ONLY when the entry has plan-based turns AND no trusted cost to show (so a
  // mixed entry that still has a real cost keeps showing it, and the front-end can honestly badge 计划内计费).
  const round6 = n => Math.round((Number(n) || 0) * 1e6) / 1e6;
  const roundB = b => { for (const k of Object.keys(b)) b[k] = round6(b[k]); return b; };
  const finishGroup = m => { roundB(m.costsByCurrency); m.planBased = m.planBasedTurns > 0 && Object.keys(m.costsByCurrency).length === 0; };
  roundB(totals.costsByCurrency);
  for (const m of byEngine.values()) finishGroup(m);
  for (const m of byProvider.values()) finishGroup(m);
  for (const m of bySession.values()) finishGroup(m);
  for (const m of byModel.values()) finishGroup(m); // same 口径 as the three groups above, deliberately not a second one
  for (const m of byDay.values()) roundB(m.costsByCurrency);

  // Budget: CURRENT local month's TRUSTED spend in the budget currency (independent of `range`).
  let budget = null;
  const ub = config.usageBudget;
  if (ub && typeof ub === 'object' && Number(ub.monthly) > 0 && typeof ub.currency === 'string' && ub.currency) {
    const monthRows = await readUsageRows(usageRangeLowerMs('month', now));
    let spent = 0;
    for (const r of monthRows) { const c = Number(r.cost); if (r.costTrusted !== false && r.currency === ub.currency && Number.isFinite(c)) spent += c; }
    budget = { monthly: Number(ub.monthly), currency: ub.currency, spentThisMonth: round6(spent) };
  }
  return {
    ok: true, range, totals,
    byEngine: [...byEngine.values()],
    byProvider: [...byProvider.values()],
    // 117x-M1: most-recently-used first (lastAt desc), then busier first, then model id — a total order, so the
    // payload never silently depends on Map insertion order. NOT sliced, unlike bySession: the selector shows a
    // 「上次用 · 共 M 回合」副行 for EVERY model it lists, and a slice would both starve that副行 and break the
    // sum(byModel.turns) === sum(byEngine.turns) - empty-model-rows invariant. lastMs is scratch, stripped here.
    byModel: [...byModel.values()]
      .sort((a, b) => (b.lastMs - a.lastMs) || (b.turns - a.turns) || (a.model < b.model ? -1 : (a.model > b.model ? 1 : 0)))
      .map(({ lastMs, ...rest }) => rest),
    bySession: [...bySession.values()].sort((a, b) => (b.inTok + b.outTok) - (a.inTok + a.outTok)).slice(0, 20),
    byDay: [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)),
    budget,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 第 121 波 K2a(34 号文 §6.1;27 号文 `:20` 预告的那一步):进程内事件总线。
//
// 为什么住在 00-boot:它的订阅者(13r-event-stream.js)排在最后,而生产者散落在 02/04/05/09/13i/13q
// —— 总线必须比【所有】生产者都早,生产者才只需要一条后向引用。00-boot 是全仓第一个模块,且每一个
// 生产者所在模块对它的依赖边【本来就存在】(见 docs/architecture/module-dependency-graph.json),
// 所以这一步一条新边都不加,forwardEdges 不动。
//
// 三条纪律:
//   ① 零订阅者时 emit 是 no-op,且【永不抛】—— 观察面绝不反噬写路径(同 logEvent 的口径);
//   ② 订阅者自己抛的异常就地吞掉并继续派给下一个,一个坏订阅者不许拖垮生产者;
//   ③ 总线【不落盘、不持久化、不跨进程】。它只是「谁写了什么」到「谁想知道」之间的一条线,
//      重启即空;任何需要重启后还在的事实都必须另有落盘的权威源(会话头/NDJSON)。
const RUYI_EVENT_SUBSCRIBERS = new Set();
const RUYI_EVENTS = {
  // 返回退订函数(约定同 DOM/Node 的 off 语义:重复退订无副作用)。
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    RUYI_EVENT_SUBSCRIBERS.add(fn);
    return () => { RUYI_EVENT_SUBSCRIBERS.delete(fn); };
  },
  emit(name, payload) {
    if (!RUYI_EVENT_SUBSCRIBERS.size) return;           // 纪律①:零订阅者 = 零开销
    for (const fn of RUYI_EVENT_SUBSCRIBERS) {
      try { fn(String(name || ''), payload); } catch { /* 纪律②:订阅者的错不许回流到写路径 */ }
    }
  },
  subscriberCount() { return RUYI_EVENT_SUBSCRIBERS.size; },
};
// 事件流模块(13r-event-stream.js)的延迟绑定命名空间 —— 先例是 06i 的 StewardHooks 与 06c 的
// AgentLoopHooks。13-http-router.js 排在 13r 【之前】,直接写 handleEventStreamRoutes 会是一条
// 新前向边;它只写 `EventStreamHooks.handleApiRoutes`(13 → 00-boot 是既有后向边),13r 加载时
// Object.assign 填充实现。未填充(理论上不可能)时那一行是无操作。
const EventStreamHooks = {};
