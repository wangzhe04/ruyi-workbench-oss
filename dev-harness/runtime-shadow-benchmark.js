#!/usr/bin/env node
'use strict';

// Deterministic synthetic gate for the runtime-optimization shadow path. It uses Ruyi's real native catalog
// and pure runtime primitives, writes no user data, performs no external calls, and authorizes no active flag.
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const ruyi = require('../ruyi-workbench/app/server.js');
const { summarizeFailureEvents } = require('./runtime-failure-report.js');

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function round(value, digits = 4) { return Number(Number(value || 0).toFixed(digits)); }
function rankOf(result, expected) {
  const names = (result.matches || []).map(item => item.name);
  const index = names.indexOf(expected);
  return index < 0 ? 0 : index + 1;
}
function retrievalMetrics(rows, key) {
  const ranks = rows.map(row => row[key + 'Rank']);
  const hit = ranks.filter(rank => rank > 0 && rank <= 5).length;
  const top1 = ranks.filter(rank => rank === 1).length;
  const ndcg = ranks.reduce((sum, rank) => sum + (rank > 0 && rank <= 5 ? 1 / Math.log2(rank + 1) : 0), 0);
  return { recallAt5: round(hit / rows.length), ndcgAt5: round(ndcg / rows.length), top1Accuracy: round(top1 / rows.length) };
}

const retrievalCases = [
  ['file_read', '读取工作区里的文件内容', 'read a workspace file', 'file_read path content'],
  ['file_list', '列出目录下有哪些文件', 'list a directory', 'file_list root entries'],
  ['file_search', '全文搜索文件内容', 'search text across files', 'file_search query maxResults'],
  ['glob', '按通配符模式查找文件', 'find files by glob pattern', 'glob pattern cwd'],
  ['file_write', '创建并写入一个新文件', 'write a new file', 'file_write path content'],
  ['file_edit', '修改文件并替换一段文本', 'edit and replace text in a file', 'file_edit oldText newText'],
  ['codebase_symbol_search', '查找代码符号的定义和引用', 'find definition and references', 'codebase_symbol_search symbol query'],
  ['docs_search', '搜索项目文档里的说明', 'search project documentation', 'docs_search query root'],
  ['git_status', '查看仓库当前代码变更状态', 'show working tree status', 'git_status cwd'],
  ['git_diff', '查看尚未提交的代码差异', 'show code changes diff', 'git_diff staged path'],
  ['powershell_run', '执行一条 powershell 命令', 'run a powershell command', 'powershell_run command timeoutMs'],
  ['script_run', '运行磁盘上的脚本文件', 'execute a script file', 'script_run path args'],
  ['http_request', '发送 http 请求调用接口', 'make an HTTP API request', 'http_request url method headers'],
  ['archive_zip', '把文件和文件夹压缩打包成 zip', 'create a zip archive', 'archive_zip paths dest'],
  ['desktop_screenshot', '截取当前桌面屏幕', 'take a desktop screenshot', 'desktop_screenshot maxWidth quality'],
  ['office_open', '打开 excel word ppt 或 pdf 文档', 'open an office document', 'office_open path application'],
  ['orchestrate_agents', '编排多个代理的工作流', 'orchestrate multiple agents', 'orchestrate_agents tasks dependencies'],
  ['spawn_agent', '把子任务委派给子代理', 'delegate a task to a subagent', 'spawn_agent task toolTier'],
  ['workbench_memory_read', '读取工作台保存的记忆', 'read workbench memory', 'workbench_memory_read id query'],
  ['workbench_memory_propose', '提议把经验保存为记忆', 'propose saving a memory', 'workbench_memory_propose content scope'],
].flatMap(([expected, ...queries]) => queries.map((query, variant) => ({ expected, query, variant: ['zh', 'en', 'mixed'][variant] })));

function runRetrievalBenchmark(config, catalog) {
  // Warm the JIT without retaining a query or candidate result.
  for (let i = 0; i < 10; i++) ruyi.searchToolCatalog(catalog, retrievalCases[i], config, { forceV1: true, legacyNameBoost: 3 });
  const rows = []; const latencyMs = [];
  for (const sample of retrievalCases) {
    const baseline = ruyi.searchToolCatalog(catalog, { query: sample.query, limit: 5 }, { ...config, runtimeToolRetrievalV1: false }, { legacyNameBoost: 3 });
    const startedAt = performance.now();
    const candidate = ruyi.searchToolCatalog(catalog, { query: sample.query, limit: 5 }, config, { forceV1: true, legacyNameBoost: 3 });
    latencyMs.push(performance.now() - startedAt);
    rows.push({ expected: sample.expected, variant: sample.variant, baselineRank: rankOf(baseline, sample.expected), candidateRank: rankOf(candidate, sample.expected) });
  }
  const baseline = retrievalMetrics(rows, 'baseline');
  const candidate = retrievalMetrics(rows, 'candidate');
  const baselineError = 1 - baseline.top1Accuracy;
  const candidateError = 1 - candidate.top1Accuracy;
  const relativeTop1ErrorReduction = baselineError > 0 ? (baselineError - candidateError) / baselineError : (candidateError === 0 ? 1 : 0);
  const checks = {
    sampleSize: rows.length === 60,
    recallAt5: candidate.recallAt5 >= 0.95 || candidate.recallAt5 >= baseline.recallAt5 + 0.08,
    ndcgAt5: candidate.ndcgAt5 >= baseline.ndcgAt5 + 0.08,
    top1ErrorReduction: relativeTop1ErrorReduction >= 0.10,
    latencyP95: percentile(latencyMs, 0.95) < 15,
  };
  return {
    sampleSize: rows.length,
    catalogSize: catalog.length,
    baseline,
    candidate,
    delta: {
      recallAt5: round(candidate.recallAt5 - baseline.recallAt5),
      ndcgAt5: round(candidate.ndcgAt5 - baseline.ndcgAt5),
      top1Accuracy: round(candidate.top1Accuracy - baseline.top1Accuracy),
      relativeTop1ErrorReduction: round(relativeTop1ErrorReduction),
    },
    latencyMs: { p50: round(percentile(latencyMs, 0.5), 3), p95: round(percentile(latencyMs, 0.95), 3), max: round(Math.max(...latencyMs), 3) },
    misses: rows.filter(row => row.candidateRank === 0).map(row => ({ expected: row.expected, variant: row.variant })),
    gate: { pass: Object.values(checks).every(Boolean), checks },
  };
}

function structuredResult(index, kind) {
  const items = Array.from({ length: 100 }, (_, i) => ({
    path: `src/module-${index}/file-${i}.js`, line: i + 1, status: i % 3 ? 'ok' : 'review',
    message: `${kind} result ${i} ` + 'deterministic payload '.repeat(8),
  }));
  return JSON.stringify({ ok: true, status: 200, exitCode: 0, path: `src/module-${index}`, count: items.length, results: items });
}
function textResult(index) {
  return `command ${index} completed\n` + Array.from({ length: 180 }, (_, i) => `line ${i}: build output ${'stable '.repeat(12)}`).join('\n') + '\nexitCode=0';
}
function buildObservationHistory() {
  const specs = [];
  for (let i = 0; i < 5; i++) specs.push({ name: 'file_search', content: structuredResult(i, 'search') });
  for (let i = 5; i < 10; i++) specs.push({ name: 'http_request', content: structuredResult(i, 'network') });
  for (let i = 10; i < 16; i++) specs.push({ name: 'powershell_run', content: i % 2 ? structuredResult(i, 'shell') : textResult(i) });
  specs.push({ name: 'file_read', content: JSON.stringify({ ok: false, error: 'verification failed', detail: 'critical evidence ' + 'x'.repeat(9000) }) });
  specs.push({ name: 'file_write', content: JSON.stringify({ ok: true, op: 'modify', path: 'src/critical.js', journal: 'checkpoint', detail: 'x'.repeat(9000) }) });
  specs.push({ name: 'git_diff', content: JSON.stringify({ ok: false, error: 'quality gate rejected', findings: ['critical'], detail: 'x'.repeat(9000) }) });
  specs.push({ name: 'file_read', pinned: true, content: JSON.stringify({ ok: true, path: 'pinned.txt', detail: 'x'.repeat(9000) }) });
  const history = [];
  specs.forEach((spec, index) => {
    const id = `shadow-observation-${index}`;
    history.push({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: spec.name, arguments: '{}' } }] });
    history.push({ role: 'tool', tool_call_id: id, content: spec.content, pinned: spec.pinned });
  });
  history.push({ role: 'assistant', content: 'recent turn one' }, { role: 'user', content: 'continue' }, { role: 'assistant', content: 'recent turn two' });
  return { history, specs };
}

function runObservationBenchmark() {
  const { history, specs } = buildObservationHistory();
  const before = JSON.stringify(history);
  const shadow = ruyi.measureObservationReductionShadow(history);
  const liveHistoryUnchanged = JSON.stringify(history) === before;
  const latencyMs = []; let criticalEvidenceLoss = 0;
  for (let i = 0; i < 16; i++) {
    const startedAt = performance.now();
    const reduced = ruyi.reduceObservationContent(specs[i].name, specs[i].content, `history:0:0000000000000000:${i}:0000000000000000`);
    latencyMs.push(performance.now() - startedAt);
    const visible = String(reduced.content || '');
    let structured = null; try { structured = JSON.parse(specs[i].content); } catch { /* text observation */ }
    const markers = structured ? ['"ok":true', 'path'] : ['command', 'exitCode=0'];
    for (const marker of markers) if (!visible.includes(marker)) criticalEvidenceLoss++;
  }
  const checks = {
    sampleSize: shadow.observationCount === 20,
    meaningfulReduction: shadow.candidateReductionRate >= 0.20,
    protectedEvidence: shadow.protectedCount === 4 && shadow.candidateReducedCount === 16,
    criticalEvidenceLoss: criticalEvidenceLoss === 0,
    liveHistoryUnchanged,
    latencyP95: percentile(latencyMs, 0.95) < 10,
  };
  return {
    ...shadow,
    latencyMs: { p50: round(percentile(latencyMs, 0.5), 3), p95: round(percentile(latencyMs, 0.95), 3), max: round(Math.max(...latencyMs), 3) },
    criticalEvidenceLoss,
    liveHistoryUnchanged,
    gate: { pass: Object.values(checks).every(Boolean), checks },
  };
}

function failureFixtures() {
  const rows = [];
  const add = (count, expected, tier, error, disposition = 'executed') => {
    for (let i = 0; i < count; i++) rows.push({ expected, tier, disposition, result: { ok: false, error: `${error} fixture-${i}` } });
  };
  add(6, 'invalid_arguments', 'read', 'invalid argument: required property path is missing');
  add(5, 'tool_unavailable', 'read', 'tool not found: connector unavailable');
  add(5, 'transient_read', 'read', 'ETIMEDOUT temporary 503');
  add(4, 'no_progress', 'read', 'semantic stall: no progress');
  add(4, 'permission_denied', 'edit', 'blocked by permission: denied');
  add(3, 'verification_failed', 'read', 'verification failed: quality gate rejected');
  add(2, 'side_effect_unknown', 'edit', 'network timeout: effect unknown');
  add(1, 'unknown', 'read', 'opaque failure Z-19');
  return rows;
}
function runFailureBenchmark() {
  const fixtures = failureFixtures();
  const events = []; let correct = 0;
  fixtures.forEach((fixture, index) => {
    const classified = ruyi.classifyRuntimeToolFailure(`fixture_tool_${index}`, fixture.result, { tier: fixture.tier, disposition: fixture.disposition });
    if (classified && classified.failureClass === fixture.expected) correct++;
    events.push({ kind: 'runtime_failure_classified', toolName: `fixture_tool_${index}`, ...classified });
  });
  const report = summarizeFailureEvents(events);
  const accuracy = correct / fixtures.length;
  const noUnsafeReplay = events.filter(event => event.failureClass === 'side_effect_unknown').every(event => event.recoverableHint === false && event.allowedRepair === 'stop_for_effect_check');
  const checks = { sampleSize: fixtures.length === 30, taxonomyAccuracy: accuracy === 1, reportGate: report.gate.pass, noUnsafeReplay };
  return { sampleSize: fixtures.length, taxonomyAccuracy: round(accuracy), noUnsafeReplay, report, gate: { pass: Object.values(checks).every(Boolean), checks } };
}

function main() {
  const config = { ...ruyi.defaultConfig(), allowCommandTools: true, allowDesktopTools: true, subagentMaxPerTurn: 2, permissionMode: 'default' };
  const tools = ruyi.buildOpenAiTools(config, {}, {});
  const catalog = ruyi.buildToolCatalog(tools, {}, config);
  const retrieval = runRetrievalBenchmark(config, catalog);
  const observationReduction = runObservationBenchmark();
  const failureClassification = runFailureBenchmark();
  const allSyntheticGatesPass = retrieval.gate.pass && observationReduction.gate.pass && failureClassification.gate.pass;
  const result = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    mode: 'synthetic-shadow-simulation',
    config: { runtimeOptimizationShadowV1: config.runtimeOptimizationShadowV1, runtimeToolRetrievalV1: config.runtimeToolRetrievalV1, runtimeObservationReducerV1: config.runtimeObservationReducerV1, runtimeFailureTelemetryV1: config.runtimeFailureTelemetryV1 },
    safety: { externalCalls: 0, userDataRead: false, activeBehaviorChanged: false },
    retrieval,
    observationReduction,
    failureClassification,
    overall: {
      pass: allSyntheticGatesPass,
      decision: allSyntheticGatesPass ? 'keep_shadow_collect_real_runtime_data' : 'fix_before_shadow_rollout',
      note: 'Synthetic success is not authorization to enable active behavior; real shadow samples must still satisfy the documented gates.',
    },
  };
  const outDir = path.join(__dirname, 'ab-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'runtime-shadow-latest.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ output: outFile, ...result }, null, 2) + '\n');
  if (!allSyntheticGatesPass) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { retrievalCases, runRetrievalBenchmark, buildObservationHistory, runObservationBenchmark, failureFixtures, runFailureBenchmark };
