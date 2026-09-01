#!/usr/bin/env node
'use strict';
// 105g sweet-spot live gate: same real history/provider for multiple fact-table caps.
// Reads the local provider config without printing or persisting its API key. The report contains only
// aggregate metrics and exact deterministic-entity counts, never history text or model summaries.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105g-sweetspot-'));
const ROOT = path.resolve(__dirname, '..');
const srv = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
const providerConfigPath = process.env.RUYI_FACT_GATE_CONFIG || path.join(os.homedir(), '.win-claude-workbench', 'config.json');
const fixturePath = path.join(__dirname, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354', 'history-24.json.gz');
const candidateCaps = (process.env.RUYI_FACT_GATE_CAPS || '0,8,12,16,24,32').split(',').map(Number)
  .filter(value => Number.isFinite(value) && value >= 0);
const model = process.env.RUYI_FACT_GATE_MODEL || 'deepseek-v4-flash';
const scope = process.env.RUYI_FACT_GATE_SCOPE || 'short';
const contextWindow = Math.max(8000, Number(process.env.RUYI_FACT_GATE_CONTEXT_WINDOW || (scope === 'long' ? 32000 : 18000)) || 18000);

function providerFromConfig() {
  const config = JSON.parse(fs.readFileSync(providerConfigPath, 'utf8'));
  const raw = (config.providers || []).find(row => row && row.id === 'deepseek');
  if (!raw || !raw.apiKey) throw new Error('deepseek provider/key missing in local config');
  return { ...raw, model, contextWindow };
}
function loadHistory() {
  const full = JSON.parse(zlib.gunzipSync(fs.readFileSync(fixturePath), 'utf8'));
  return scope === 'long' ? full : full.slice(0, 44);
}
function tableEntities(message) {
  return String(message && message.content || '').split(/\r?\n/).filter(line => line.startsWith('- ')).map(line => line.slice(2));
}
function pricing(provider) {
  const p = provider.pricing || null;
  if (!p) return null;
  const exact = Array.isArray(p.models) && p.models.find(row => row && row.model === provider.model);
  return exact ? { ...p, ...exact } : p;
}
function cost(provider, usage) {
  const p = pricing(provider);
  if (!p || !usage || !Number.isFinite(Number(p.inputPerM)) || !Number.isFinite(Number(p.outputPerM))) return null;
  const input = Number(usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens) || 0;
  const output = Number(usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens) || 0;
  return (input * Number(p.inputPerM) + output * Number(p.outputPerM)) / 1000000;
}
function rowScore(summary, table, global) {
  const text = String(summary || '');
  const tableRetained = table.filter(entity => text.includes(entity)).length;
  const globalRetained = global.filter(entity => text.includes(entity)).length;
  return {
    structured: srv.validateStructuredSummary(text),
    tableEntities: table.length,
    tableRetained,
    tableRetention: table.length ? tableRetained / table.length : 0,
    globalEntities: global.length,
    globalRetained,
    globalRetention: global.length ? globalRetained / global.length : 0,
  };
}
async function run(provider, history, global, cap) {
  const nativeFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => { calls++; return nativeFetch(...args); };
  const started = Date.now();
  let result;
  try {
    const config = {
      runtimeSummarySingleShotV1: false,
      runtimeSummaryEntityCheckV1: false,
      runtimeSummaryFactTableV1: cap > 0,
      ...(cap > 0 ? { summaryFactTableMaxSamplesV1: cap } : {}),
    };
    result = await srv.providerSummaryCall(provider, history, { config });
  } finally { globalThis.fetch = nativeFetch; }
  const usage = result && result.usage || null;
  const table = cap > 0 ? tableEntities(srv.buildSummaryFactTableMessages(history, cap).chunk) : [];
  return {
    cap,
    ok: !!(result && result.ok),
    error: result && !result.ok ? String(result.error || '').slice(0, 180) : '',
    calls,
    wallMs: Date.now() - started,
    inputTokens: Number(usage && (usage.prompt_tokens != null ? usage.prompt_tokens : usage.input_tokens)) || 0,
    outputTokens: Number(usage && (usage.completion_tokens != null ? usage.completion_tokens : usage.output_tokens)) || 0,
    cost: cost(provider, usage),
    currency: provider.pricing && provider.pricing.currency || null,
    mapReduce: result && result.mapReduce || null,
    score: rowScore(result && result.summary, table, global),
  };
}
function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) { if (!groups.has(row.cap)) groups.set(row.cap, []); groups.get(row.cap).push(row); }
  return [...groups.entries()].map(([cap, group]) => {
    const avg = key => group.reduce((sum, row) => sum + Number(row.score[key] || 0), 0) / group.length;
    const sum = key => group.reduce((total, row) => total + Number(row[key] || 0), 0);
    const priced = group.filter(row => row.cost != null);
    return {
      cap,
      fixtures: group.length,
      successRate: group.filter(row => row.ok).length / group.length,
      tableEntities: group[0].score.tableEntities,
      tableRetention: avg('tableRetention'),
      globalEntities: group[0].score.globalEntities,
      globalRetention: avg('globalRetention'),
      calls: sum('calls'),
      wallMs: sum('wallMs'),
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cost: priced.length === group.length ? priced.reduce((total, row) => total + row.cost, 0) : null,
      currency: group.find(row => row.currency)?.currency || null,
    };
  });
}

(async () => {
  if (!fs.existsSync(fixturePath)) throw new Error('fixture missing');
  const provider = providerFromConfig();
  const history = loadHistory();
  const global = tableEntities(srv.buildSummaryFactTableMessages(history, 64).chunk);
  console.log(JSON.stringify({ event: 'sweetspot_start', scope, provider: provider.id, model: provider.model, apiStyle: provider.apiStyle || 'chat', contextWindow: provider.contextWindow, historyMessages: history.length, historyEstimate: srv.estimateHistoryTokens(history), globalEntities: global.length, caps: candidateCaps }));
  const rows = [];
  for (const cap of candidateCaps) {
    console.log(JSON.stringify({ event: 'case_start', cap }));
    const row = await run(provider, history, global, cap);
    rows.push(row);
    console.log(JSON.stringify({ event: 'case_done', cap, ok: row.ok, calls: row.calls, wallMs: row.wallMs, tableEntities: row.score.tableEntities, tableRetention: row.score.tableRetention, globalRetention: row.score.globalRetention, inputTokens: row.inputTokens }));
  }
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    provider: { id: provider.id, model: provider.model, apiStyle: provider.apiStyle || 'chat', contextWindow: provider.contextWindow },
    fixture: { scope, source: path.relative(ROOT, fixturePath).replace(/\\/g, '/'), messages: history.length, estimate: srv.estimateHistoryTokens(history), globalEntities: global.length },
    aggregates: aggregate(rows),
    rows,
  };
  const out = process.env.RUYI_FACT_GATE_OUT || path.join(ROOT, 'docs', 'optimization-plan', '105g-fact-sweetspot-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('SWEETSPOT_REPORT ' + JSON.stringify(report));
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
