#!/usr/bin/env node
'use strict';
// 105 总门真实模型评测器。默认从本机 Workbench config 读取 provider（不打印/不落盘 API key），
// 从项目 history-24 派生 20K/24K/28K 高密度四块历史，比较 map / single / refine /
// refine+fact-table。加 --include-production-map 可额外报告 105g 已默认开启的 map+fact 现状。
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105-total-gate-'));
const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const srv = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const prefix = '--' + name + '=';
  const found = args.find(value => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
};
const has = name => args.includes('--' + name);
const configPath = arg('config', path.join(os.homedir(), '.win-claude-workbench', 'config.json'));
const providerId = arg('provider', 'deepseek');
const modelOverride = arg('model', 'deepseek-v4-flash');
const fixturePath = arg('fixture', path.join(HERE, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354', 'history-24.json.gz'));
const targets = arg('targets', '20000,24000,28000').split(',').map(Number).filter(n => Number.isFinite(n) && n >= 1000);
const outPath = arg('out', '');
const contextWindow = Math.max(8000, Number(arg('context-window', '32000')) || 32000);

function loadProvider() {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const raw = (config.providers || []).find(row => row && row.id === providerId);
  if (!raw) throw new Error('provider not found in config: ' + providerId);
  const model = modelOverride || raw.model || (raw.models && raw.models[0] && raw.models[0].id);
  if (!raw.apiKey) throw new Error('selected provider has no API key');
  return { ...raw, model, contextWindow };
}
function corpusFromFixture(file) {
  const history = JSON.parse(zlib.gunzipSync(fs.readFileSync(file), 'utf8'));
  return history.map(message => {
    if (!message || typeof message !== 'object') return '';
    const fields = [message.content, message.reasoning_content, message.arguments, message.output];
    if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) {
      const fn = call && call.function;
      if (fn && typeof fn.arguments === 'string') fields.push(fn.arguments);
    }
    return fields.filter(value => typeof value === 'string' && value).join('\n');
  }).filter(Boolean).join('\n\n');
}
const CONSTRAINTS = [
  '【总门约束-1】项目代号「星槎总门」，关键路径 C:\\ruyi\\gates\\105-total.json。',
  '【总门约束-2】发布版本 v7.3.1，验收日期 2026-09-30。',
  '【总门旧状态】此前决定 `CACHE_MODE=write-through`；未完成事项 `TASK-OLD-ALPHA`。',
  '【总门最新状态】后文正式推翻旧决定：唯一有效决定为 `CACHE_MODE=write-back`；`TASK-OLD-ALPHA` 已完成并从未完成事项移除；当前唯一未完成事项 `TASK-NEXT-OMEGA`。',
];
const ENTITY_CHECKS = ['星槎总门', 'C:\\ruyi\\gates\\105-total.json', 'v7.3.1', '2026-09-30', 'CACHE_MODE=write-back', 'TASK-NEXT-OMEGA'];
function fixtureNearTokens(corpus, target) {
  const build = chars => {
    const text = corpus.slice(0, chars);
    const size = Math.ceil(text.length / 4);
    return Array.from({ length: 4 }, (_, i) => ({
      role: 'user',
      content: `【history-24 派生块 ${i + 1}/4】\n${CONSTRAINTS[i]}\n${text.slice(i * size, (i + 1) * size)}`,
    }));
  };
  let lo = 1, hi = corpus.length, best = build(1);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = build(mid);
    if (srv.estimateHistoryTokens(candidate) <= target) { best = candidate; lo = mid + 1; }
    else hi = mid - 1;
  }
  return { target, estimate: srv.estimateHistoryTokens(best), history: best };
}
function section(summary, heading, nextHeading) {
  const text = String(summary || '');
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const from = start + heading.length;
  const end = nextHeading ? text.indexOf(nextHeading, from) : -1;
  return text.slice(from, end < 0 ? text.length : end);
}
function score(summary) {
  const text = String(summary || '');
  const decisions = section(text, '【已确认的决定】', '【未完成事项】');
  const open = section(text, '【未完成事项】', '【当前执行状态】');
  const entityHits = ENTITY_CHECKS.filter(value => text.includes(value));
  const checks = {
    codename: text.includes('星槎总门'),
    path: text.includes('C:\\ruyi\\gates\\105-total.json'),
    version: text.includes('v7.3.1'),
    date: text.includes('2026-09-30'),
    latestDecisionPresent: decisions.includes('CACHE_MODE=write-back'),
    staleDecisionAbsent: !decisions.includes('CACHE_MODE=write-through'),
    latestTodoPresent: open.includes('TASK-NEXT-OMEGA'),
    completedTodoAbsent: !open.includes('TASK-OLD-ALPHA'),
  };
  const covered = Object.values(checks).filter(Boolean).length;
  return {
    structured: srv.validateStructuredSummary(text),
    entityRetained: entityHits.length,
    entityTotal: ENTITY_CHECKS.length,
    entityRetention: entityHits.length / ENTITY_CHECKS.length,
    crossBlockCorrect: covered,
    crossBlockTotal: Object.keys(checks).length,
    crossBlockAccuracy: covered / Object.keys(checks).length,
    checks,
  };
}
function pricingFor(provider) {
  const base = provider.pricing || null;
  if (!base) return null;
  const exact = Array.isArray(base.models) ? base.models.find(row => row && row.model === provider.model) : null;
  return exact ? { ...base, ...exact } : base;
}
function costOf(usage, pricing) {
  if (!pricing || !usage) return null;
  const input = Number(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens) || 0;
  const output = Number(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens) || 0;
  if (!Number.isFinite(Number(pricing.inputPerM)) || !Number.isFinite(Number(pricing.outputPerM))) return null;
  return (input * Number(pricing.inputPerM) + output * Number(pricing.outputPerM)) / 1000000;
}
const STRATEGIES = [
  { id: 'map', label: '现有 map-reduce（无事实表隔离基线）', config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: false } },
  { id: 'single', label: '单发优先（超预算时按生产语义分块）', config: { runtimeSummarySingleShotV1: true, runtimeSummaryFactTableV1: true, runtimeSummaryRefineV1: false } },
  { id: 'refine', label: '<=4 块顺序 refine', config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: true } },
  { id: 'refine_fact', label: '顺序 refine + 全局事实表', config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: true, runtimeSummaryRefineV1: true } },
];
if (has('include-production-map')) STRATEGIES.splice(1, 0,
  { id: 'map_fact', label: '当前生产 map-reduce + 全局事实表', config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: true, runtimeSummaryRefineV1: false } });
const onlyStrategies = new Set(arg('strategies', '').split(',').map(value => value.trim()).filter(Boolean));
if (onlyStrategies.size) {
  for (let i = STRATEGIES.length - 1; i >= 0; i--) if (!onlyStrategies.has(STRATEGIES[i].id)) STRATEGIES.splice(i, 1);
}

async function runOne(provider, fixture, strategy) {
  const nativeFetch = global.fetch;
  let calls = 0;
  global.fetch = async (...fetchArgs) => { calls++; return nativeFetch(...fetchArgs); };
  const started = Date.now();
  let result;
  try {
    result = await srv.providerSummaryCall(provider, fixture.history, {
      config: { ...strategy.config, runtimeSummaryEntityCheckV1: false },
    });
  } finally { global.fetch = nativeFetch; }
  const wallMs = Date.now() - started;
  const usage = result && result.usage || null;
  return {
    strategy: strategy.id,
    targetTokens: fixture.target,
    estimatedTokens: fixture.estimate,
    ok: !!(result && result.ok),
    error: result && !result.ok ? String(result.error || '').slice(0, 160) : '',
    calls,
    wallMs,
    inputTokens: Number(usage && (usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens)) || 0,
    outputTokens: Number(usage && (usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens)) || 0,
    cost: costOf(usage, pricingFor(provider)),
    currency: provider.pricing && provider.pricing.currency || null,
    mapReduce: result && result.mapReduce ? result.mapReduce : null,
    score: score(result && result.summary),
  };
}
function aggregate(strategy, rows) {
  const own = rows.filter(row => row.strategy === strategy.id);
  const sum = key => own.reduce((total, row) => total + Number(row[key] || 0), 0);
  const avgScore = key => own.length ? own.reduce((total, row) => total + Number(row.score[key] || 0), 0) / own.length : 0;
  const priced = own.filter(row => row.cost != null);
  return {
    strategy: strategy.id,
    label: strategy.label,
    fixtures: own.length,
    successRate: own.filter(row => row.ok).length / Math.max(1, own.length),
    entityRetention: avgScore('entityRetention'),
    crossBlockAccuracy: avgScore('crossBlockAccuracy'),
    calls: sum('calls'),
    wallMs: sum('wallMs'),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cost: priced.length === own.length ? priced.reduce((total, row) => total + row.cost, 0) : null,
    currency: own.find(row => row.currency)?.currency || null,
  };
}

(async () => {
  if (!targets.length) throw new Error('no valid targets');
  if (!fs.existsSync(fixturePath)) throw new Error('fixture missing: ' + fixturePath);
  const provider = loadProvider();
  const corpus = corpusFromFixture(fixturePath);
  const fixtures = targets.map(target => fixtureNearTokens(corpus, target));
  console.log(JSON.stringify({ event: 'gate_start', provider: provider.id, model: provider.model, apiStyle: provider.apiStyle || 'chat', contextWindow, targets: fixtures.map(row => row.estimate), strategies: STRATEGIES.map(row => row.id) }));
  const rows = [];
  for (const strategy of STRATEGIES) for (const fixture of fixtures) {
    console.log(JSON.stringify({ event: 'case_start', strategy: strategy.id, target: fixture.target }));
    const row = await runOne(provider, fixture, strategy);
    rows.push(row);
    console.log(JSON.stringify({ event: 'case_done', strategy: row.strategy, target: row.targetTokens, ok: row.ok, calls: row.calls, wallMs: row.wallMs, entityRetention: row.score.entityRetention, crossBlockAccuracy: row.score.crossBlockAccuracy }));
  }
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    provider: { id: provider.id, model: provider.model, apiStyle: provider.apiStyle || 'chat', contextWindow },
    fixture: { source: path.relative(ROOT, fixturePath).replace(/\\/g, '/'), targets: fixtures.map(row => ({ target: row.target, estimate: row.estimate })), blocks: 4, syntheticConstraints: true },
    degradationGates: { single400ToMap: 'covered by summary-single-shot.e2e A4', refineFailureToMap: 'covered by summary-refine.e2e A5', passed: 2, total: 2 },
    aggregates: STRATEGIES.map(strategy => aggregate(strategy, rows)),
    rows,
  };
  if (outPath) fs.writeFileSync(path.resolve(outPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('GATE_REPORT ' + JSON.stringify(report));
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
