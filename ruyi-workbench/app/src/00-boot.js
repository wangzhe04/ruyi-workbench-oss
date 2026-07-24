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
const zlib = require('zlib'); // v0.8-S4a: checkpoint journal gzips `before` content with the built-in zlib (gzipSync/gunzipSync) — NO npm.
const { URL } = require('url');

const APP_NAME = '如意 Ruyi'; // v0.8-S8 品牌落地(原 'Win Claude Workbench';去 Claude 化,开源商标合规)
const VERSION = '2.0.1'; // Escapade 2.0.1:Full/Slim 首次解压与启动链修复
// Unique per running server instance; lets an updater prove the process actually restarted
// after an overlay was applied (a version string alone can't prove a restart happened).
const OVERLAY_ID = crypto.randomBytes(6).toString('hex');
const DEFAULT_PORT = 8765;
const MAX_BODY_BYTES = 128 * 1024 * 1024;
const CONFIG_SCHEMA = 8; // v1.6.1: adaptive tool discovery/loading shared by provider + Claude CLI
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

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
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

// Validate an optional pricing object {inputPerM, outputPerM, currency} -> canonical form or null. Shared by
// providers[].pricing (sanitizeProvider) and config.claudePricing (normalizeConfig). Prices are per MILLION
// tokens, non-negative; a currency code is required; kept only when at least one price parses.
function normalizePricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const inP = Number(raw.inputPerM), outP = Number(raw.outputPerM);
  const cur = (typeof raw.currency === 'string') ? raw.currency.trim().slice(0, 8) : '';
  const hasIn = Number.isFinite(inP) && inP >= 0, hasOut = Number.isFinite(outP) && outP >= 0;
  if ((hasIn || hasOut) && cur) return { inputPerM: hasIn ? inP : 0, outputPerM: hasOut ? outP : 0, currency: cur };
  return null;
}
// Cost from a pricing object + token counts (per MILLION tokens). No/invalid pricing -> {cost:null, currency:null}.
function computeCostFromPricing(pricing, inTok, outTok) {
  const p = normalizePricing(pricing);
  if (!p) return { cost: null, currency: null };
  const cost = (Number(inTok) || 0) / 1e6 * p.inputPerM + (Number(outTok) || 0) / 1e6 * p.outputPerM;
  return { cost: Number.isFinite(cost) ? cost : null, currency: p.currency };
}
// Cost for a native provider turn from the provider's optional pricing. No pricing -> {cost:null, currency:null}.
function computeProviderCost(provider, inTok, outTok) {
  return computeCostFromPricing(provider && provider.pricing, inTok, outTok);
}

function appendUsageLedger(entry) {
  try {
    const inTok = Math.max(0, Math.round(Number(entry.inTok) || 0));
    const outTok = Math.max(0, Math.round(Number(entry.outTok) || 0));
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
      inTok, outTok,
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
    // One global append chain so multi-session concurrent writes never interleave a half-line.
    usageLedgerChain = usageLedgerChain.then(async () => {
      await fsp.mkdir(paths.usage, { recursive: true });
      await fsp.appendFile(file, line, 'utf8');
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
  try { const idx = await readSessionIndex(); if (Array.isArray(idx)) for (const e of idx) if (e && e.id) titles.set(String(e.id), e.title || ''); } catch { /* index optional */ }

  const addCost = (bucket, cur, cost) => { bucket[cur] = (bucket[cur] || 0) + cost; };
  const totals = { inTok: 0, outTok: 0, turns: 0, subagentTurns: 0, auxCalls: 0, estimatedTurns: 0, planBasedTurns: 0, costsByCurrency: {} };
  const byEngine = new Map(), byProvider = new Map(), bySession = new Map(), byDay = new Map();

  for (const r of rows) {
    const inTok = Number(r.inTok) || 0, outTok = Number(r.outTok) || 0;
    const cost = Number(r.cost), cur = (typeof r.currency === 'string' && r.currency) ? r.currency : null;
    const trusted = r.costTrusted !== false;
    const hasCost = trusted && cur && Number.isFinite(cost);
    totals.inTok += inTok; totals.outTok += outTok; totals.turns += 1;
    if (r.kind === 'subagent') totals.subagentTurns += 1; // v1.4-OSS 用量看板(补): DAG/子代理回合独立计数
    if (r.kind === 'aux') totals.auxCalls += 1; // v1.4-OSS 用量看板(补): 辅助调用(压缩/起草等)独立计数
    if (r.estimated === true) totals.estimatedTurns += 1;
    if (!trusted) totals.planBasedTurns += 1;
    if (hasCost) addCost(totals.costsByCurrency, cur, cost);
    const eng = r.engine === 'claude' ? 'claude' : 'openai';
    let em = byEngine.get(eng); if (!em) byEngine.set(eng, em = { engine: eng, inTok: 0, outTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    em.inTok += inTok; em.outTok += outTok; em.turns += 1; if (!trusted) em.planBasedTurns += 1; if (hasCost) addCost(em.costsByCurrency, cur, cost);
    const pid = String(r.provider || '');
    let pm = byProvider.get(pid); if (!pm) byProvider.set(pid, pm = { provider: pid, label: labels.get(pid) || pid, inTok: 0, outTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    pm.inTok += inTok; pm.outTok += outTok; pm.turns += 1; if (!trusted) pm.planBasedTurns += 1; if (hasCost) addCost(pm.costsByCurrency, cur, cost);
    const sid = String(r.sessionId || '');
    let sm = bySession.get(sid); if (!sm) bySession.set(sid, sm = { sessionId: sid, title: titles.get(sid) || '', inTok: 0, outTok: 0, turns: 0, planBasedTurns: 0, costsByCurrency: {} });
    sm.inTok += inTok; sm.outTok += outTok; sm.turns += 1; if (!trusted) sm.planBasedTurns += 1; if (hasCost) addCost(sm.costsByCurrency, cur, cost);
    const dk = usageDayKey(Date.parse(r.ts));
    let dm = byDay.get(dk); if (!dm) byDay.set(dk, dm = { date: dk, inTok: 0, outTok: 0, costsByCurrency: {} });
    dm.inTok += inTok; dm.outTok += outTok; if (hasCost) addCost(dm.costsByCurrency, cur, cost);
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
    bySession: [...bySession.values()].sort((a, b) => (b.inTok + b.outTok) - (a.inTok + a.outTok)).slice(0, 20),
    byDay: [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)),
    budget,
  };
}
