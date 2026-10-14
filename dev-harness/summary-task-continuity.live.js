#!/usr/bin/env node
'use strict';
// Manual real-model semantic check. Synthetic input only; never reads conversation history.
// Not an e2e and never runs in the default regression. --help / --dry-run make no model calls.
const fs = require('fs'), os = require('os'), path = require('path');
const argv = process.argv.slice(2);
function arg(name, fallback = '') {
  const exact = argv.indexOf('--' + name);
  if (exact >= 0) return argv[exact + 1] || fallback;
  const value = argv.find(item => item.startsWith('--' + name + '='));
  return value ? value.slice(name.length + 3) : fallback;
}
const has = name => argv.includes('--' + name);
if (has('help')) {
  console.log(`Synthetic task-continuity evaluation through production providerSummaryCall.
Usage: node dev-harness/summary-task-continuity.live.js [options]
  --provider ID         Default: configured compactProviderId, then activeProvider
  --model NAME          Default: configured compactModel, then selected provider model
  --server PATH         Baseline or current server.js; also RUYI_TEST_SERVER_JS
  --out PATH            Evidence JSON (default: temp directory/report.json)
  --cases IDS           Comma-separated middle_goal,parallel,cancel_replace,two_compactions
  --context-window N    Simulated model context, 8000..12000 (default 9000)
  --input-tokens N      Synthetic input target, 10000..16000 (default 13000)
  --dry-run             Validate fixtures/scorer and show plans; no real config read or network
  --help                Show this help without reading config or loading the server
Real runs read only config.json for the existing provider credentials. They retain production
entity-check/fact-table defaults, select map-reduce, and preserve full summaries for human review.
Scores are field-level checks, not a claim of perfect semantic fidelity. Same options/cases work
against a baseline artifact. No request bodies, provider URLs, or credentials are printed.`);
  process.exit(0);
}
const realRoot = require('./lib/real-data-root').realDataRoot();
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-summary-task-live-'));
process.env.RUYI_HOME = isolated; process.env.WIN_CLAUDE_WORKBENCH_HOME = isolated;
const serverPath = path.resolve(arg('server', process.env.RUYI_TEST_SERVER_JS || path.resolve(__dirname, '../ruyi-workbench/app/server.js')));
process.env.RUYI_TEST_SERVER_JS = serverPath;
const { loadServerInternals } = require('./lib/server-internals');
const S = loadServerInternals(['providerSummaryCall', 'estimateHistoryTokens', 'chunkHistoryByBudget', 'summarySectionLocations', 'validateStructuredSummary', 'normalizeConfig', 'providerContextWindow', 'SUMMARY_INPUT_BUDGET_RATIO', 'CompactionPlan']);
const contextWindow = Number(arg('context-window', '9000')), inputTarget = Number(arg('input-tokens', '13000'));
if (!Number.isInteger(contextWindow) || contextWindow < 8000 || contextWindow > 12000 || !Number.isInteger(inputTarget) || inputTarget < 10000 || inputTarget > 16000) throw new Error('context-window must be 8000..12000; input-tokens must be 10000..16000');
const outPath = path.resolve(arg('out', path.join(isolated, 'report.json')));
const TASKS = ['TASK-MID-REPORT', 'TASK-A-EXPORT', 'TASK-B-VERIFY', 'TASK-C-RECOVERY', 'TASK-OLD-IMPORT', 'TASK-NEW-CATALOG', 'TASK-CARRY-AUDIT'];
const CASES = [
  { id: 'middle_goal', language: 'zh-CN', active: ['TASK-MID-REPORT'], inactive: [], constraints: ['READONLY-UNTIL-APPROVAL'] },
  { id: 'parallel', language: 'en-US', active: ['TASK-B-VERIFY', 'TASK-C-RECOVERY'], inactive: ['TASK-A-EXPORT'], done: ['TASK-A-EXPORT'], constraints: [] },
  { id: 'cancel_replace', language: 'zh-CN', active: ['TASK-NEW-CATALOG'], inactive: ['TASK-OLD-IMPORT'], cancelled: ['TASK-OLD-IMPORT'], constraints: [] },
  { id: 'two_compactions', language: 'en-US', active: ['TASK-CARRY-AUDIT'], inactive: [], constraints: ['READONLY-UNTIL-APPROVAL'], rounds: 2 },
];
const selected = arg('cases').split(',').filter(Boolean);
if (selected.some(id => !CASES.some(item => item.id === id))) throw new Error('unknown case id');
const cases = CASES.filter(item => !selected.length || selected.includes(item.id));
function filler(history, repeats, tag, english) {
  const text = (english
    ? 'Observation record: fields were read, samples compared, and diagnostic output archived. These measurements introduce no new user instruction.\n'
    : '观测记录：字段已读取、样本已比较、运行输出已归档。这些测量没有引入新的用户指令。\n').repeat(repeats);
  const id = 'synthetic_tool_' + tag;
  history.push({ role: 'assistant', content: 'Synthetic observation; no task completion or authorization inferred.', tool_calls: [{ id, type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: 'C:\\synthetic\\measurements.txt' }) } }] });
  history.push({ role: 'tool', tool_call_id: id, content: text });
}
function historyFor(item, repeats, previousSummary) {
  const h = [], user = text => h.push({ role: 'user', content: text });
  const noise = tag => filler(h, repeats, item.id + '_' + tag, item.language === 'en-US');
  if (previousSummary !== undefined) {
    h.push(...S.CompactionPlan.reseed({ scope: 'main', trigger: 'auto', task: historyFor(item, 1)[0], kept: [], recentFiles: [] }, previousSummary));
    h.push({ role: 'assistant', content: 'I will continue using the preserved context.' }); noise('prior');
    user('Update the delivery constraint to FORMAT-BRIEF: give a short checklist. This changes presentation only; all existing authorization limits remain.');
    noise('constraint'); noise('measurements'); user('What remains and how far have you got?');
    return h;
  }
  if (item.id === 'middle_goal') {
    user('先了解材料目录和字段形状，我会在后面说明真正要做的事。'); noise('prelude');
    user('现在的主任务 TASK-MID-REPORT：核验资料并交付差异报告，尚未完成。约束 READONLY-UNTIL-APPROVAL：批准前只读，不改源文件。');
    noise('analysis'); noise('diagnostics'); user('现在进展到哪一步了？');
  } else if (item.id === 'parallel') {
    user('Two parallel objectives: TASK-A-EXPORT exports the inventory; TASK-B-VERIFY verifies mismatches. Both must be delivered.'); noise('initial');
    h.push({ role: 'assistant', content: 'TASK-A-EXPORT produced its inventory. Verification is unfinished.' });
    user('I accept TASK-A-EXPORT as completed. Continue TASK-B-VERIFY and add TASK-C-RECOVERY: check restoration readiness.');
    noise('verification'); noise('recovery'); user('How is today\'s work progressing?');
  } else if (item.id === 'cancel_replace') {
    user('主任务 TASK-OLD-IMPORT：准备旧系统导入方案。'); noise('old');
    user('明确取消 TASK-OLD-IMPORT，改做 TASK-NEW-CATALOG：仅整理新资料目录并交付索引。'); noise('new');
    h.push({ role: 'assistant', content: '归档观察：TASK-OLD-IMPORT 曾读取旧目录；这仅是取消前的历史记录，不能作为继续导入的依据。' });
    noise('history'); user('对照一下过去输出的目录结构，只作参考，不要重启取消的工作。');
  } else {
    user('First inspect the material format. I will specify the actual deliverable later.'); noise('prelude');
    user('The active unfinished task is TASK-CARRY-AUDIT: audit the synthetic records and deliver the discrepancy checklist. READONLY-UNTIL-APPROVAL: inspect only; no source changes without approval.');
    noise('audit'); noise('measurements'); user('Where are we now?');
  }
  return h;
}
function nearTarget(item, previousSummary) {
  let low = 1, high = 1000, best = historyFor(item, 1, previousSummary);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), history = historyFor(item, middle, previousSummary);
    if (S.estimateHistoryTokens(history) <= inputTarget) { best = history; low = middle + 1; } else high = middle - 1;
  }
  return best;
}
function sectionsOf(summary) {
  const text = String(summary || ''), locations = S.summarySectionLocations(text), fields = {};
  locations.forEach((location, i) => { fields[['goal', 'decisions', 'open', 'status', 'files'][location.index]] = text.slice(location.pos + location.len, locations[i + 1]?.pos ?? text.length).trim(); });
  return fields;
}
function mentions(field, id) {
  return String(field || '').split(/\n|[。；;，,]/).flatMap(line => [...line.matchAll(new RegExp(id, 'g'))].map(mention => {
    const at = mention.index, prior = line.slice(0, at), following = line.slice(at + id.length);
    const previousId = [...prior.matchAll(/TASK-[A-Z0-9-]+/g)].at(-1);
    const next = following.search(/TASK-[A-Z0-9-]+/);
    const context = (prior.slice(Math.max(previousId ? previousId.index + previousId[0].length : 0, prior.lastIndexOf('(') + 1, prior.lastIndexOf('（') + 1)) + id + (next < 0 ? following : following.slice(0, next)))
      .replace(/未完成|尚未完成|not (?:yet )?completed?|unfinished/gi, 'pending');
    const inactive = /已完成|已取消|取消|不再|历史|被取代|cancel(?:led|ed)?|completed?|\bdone\b|superseded?|historical|do not resume|no longer|not active/i.test(context);
    return { line: line.trim(), classification: inactive ? 'inactive_or_historical' : 'active_or_unspecified' };
  }));
}
function score(summary, item, round = 1) {
  const fields = sectionsOf(summary), checks = { structured: S.validateStructuredSummary(String(summary || '')) };
  const activeIn = (field, id) => mentions(fields[field], id).some(row => row.classification === 'active_or_unspecified');
  for (const id of item.active) { checks['goal:' + id] = activeIn('goal', id); checks['open:' + id] = activeIn('open', id); }
  for (const id of item.inactive) checks['not_reactivated:' + id] = !activeIn('goal', id) && !activeIn('open', id);
  for (const id of item.done || []) checks['status_done:' + id] = mentions(fields.status, id).some(row => row.classification === 'inactive_or_historical');
  for (const id of item.cancelled || []) checks['cancellation_retained:' + id] = ['goal', 'decisions', 'status'].some(field => mentions(fields[field], id).some(row => row.classification === 'inactive_or_historical'));
  for (const constraint of [...item.constraints, ...(round > 1 ? ['FORMAT-BRIEF'] : [])]) checks['constraint:' + constraint] = String(fields.goal || '').includes(constraint);
  checks.status_continuation = /进行中|下一步|待办|未完成|继续|in progress|next step|pending|continue/i.test(fields.status || '');
  const evidence = Object.fromEntries(TASKS.map(id => [id, Object.fromEntries(['goal', 'open', 'status'].map(field => [field, mentions(fields[field], id)]))]));
  return { passed: Object.values(checks).filter(Boolean).length, total: Object.keys(checks).length, checks, fields, evidence, humanReviewRequired: true };
}
function scorerChecks() {
  const item = CASES.find(row => row.id === 'cancel_replace');
  const good = '## Goal\n- TASK-NEW-CATALOG: organize the catalog.\n- TASK-OLD-IMPORT was cancelled; historical only.\n## Decisions\n- TASK-OLD-IMPORT cancelled.\n## Open\n- TASK-NEW-CATALOG: unfinished.\n## Current Status\n- In progress: catalog audit.\n- Next step: finish catalog.\n## Files\n- None';
  const bad = good.replace('TASK-OLD-IMPORT was cancelled; historical only.', 'TASK-OLD-IMPORT: continue importing.');
  const missing = good.replace('- TASK-NEW-CATALOG: organize the catalog.', '- Check today\'s progress.');
  const parallel = '## Goal\n- TASK-A-EXPORT completed, TASK-B-VERIFY remains active, TASK-C-RECOVERY remains active.\n## Decisions\n- Inventory accepted.\n## Open\n- TASK-B-VERIFY: pending.\n- TASK-C-RECOVERY: pending.\n## Current Status\n- Done: TASK-A-EXPORT.\n- In progress: TASK-B-VERIFY.\n- Next step: TASK-C-RECOVERY.\n## Files\n- None';
  const parallelScore = score(parallel, CASES.find(row => row.id === 'parallel'));
  const repeated = parallel.replace('TASK-A-EXPORT completed,', 'TASK-A-EXPORT completed (completed TASK-A-EXPORT),');
  const revived = repeated.replace('(completed TASK-A-EXPORT)', '(continue TASK-A-EXPORT)');
  return { repeated_completed_id_allowed: score(repeated, CASES[1]).checks['not_reactivated:TASK-A-EXPORT'], repeated_revived_id_rejected: !score(revived, CASES[1]).checks['not_reactivated:TASK-A-EXPORT'], cancelled_goal_history_allowed: score(good, item).checks['not_reactivated:TASK-OLD-IMPORT'], revived_goal_rejected: !score(bad, item).checks['not_reactivated:TASK-OLD-IMPORT'], missing_goal_rejected: !score(missing, item).checks['goal:TASK-NEW-CATALOG'], done_status_recognized: parallelScore.checks['status_done:TASK-A-EXPORT'], parallel_tasks_preserved: parallelScore.checks['goal:TASK-B-VERIFY'] && parallelScore.checks['goal:TASK-C-RECOVERY'] };
}
function safeError(error, secret) {
  let text = String(error?.message || error || 'unknown failure');
  if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/https?:\/\/\S+/g, '[endpoint]').replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_-]+/gi, '[redacted]').slice(0, 320);
}
async function main() {
  const baseConfig = S.normalizeConfig({}).config;
  const summaryConfig = { ...baseConfig, runtimeSummarySingleShotV1: false, runtimeSummaryRefineV1: false };
  const probe = { contextWindow, model: 'synthetic-plan' };
  const budget = Math.max(4000, Math.floor(S.providerContextWindow(probe, probe.model) * S.SUMMARY_INPUT_BUDGET_RATIO));
  const plans = cases.map(item => {
    const history = nearTarget(item), chunks = S.chunkHistoryByBudget(history, budget);
    if (chunks.length < 3) throw new Error('fixture must have at least three production chunks: ' + item.id);
    return { id: item.id, inputLanguage: item.language, estimatedTokens: S.estimateHistoryTokens(history), inputChars: history.reduce((sum, msg) => sum + String(msg.content || '').length, 0), messages: history.length, plannedChunks: chunks.length, rounds: item.rounds || 1, history, expectation: { active: item.active, inactive: item.inactive, constraints: item.constraints } };
  });
  const report = { schema: 1, generatedAt: new Date().toISOString(), syntheticOnly: true, server: serverPath, contextWindow, inputTarget, budget,
    defaults: { entityCheck: summaryConfig.runtimeSummaryEntityCheckV1, factTable: summaryConfig.runtimeSummaryFactTableV1, singleShot: false, refine: false }, scorerChecks: scorerChecks(), plans, rows: [], humanReviewRequired: true };
  if (!Object.values(report.scorerChecks).every(Boolean)) throw new Error('scorer negative controls failed');
  if (has('dry-run')) {
    report.dryRun = true;
    report.reseedProbe = cases.filter(item => item.rounds > 1).map(item => {
      const history = nearTarget(item, '## Goal\nTASK-CARRY-AUDIT remains active. READONLY-UNTIL-APPROVAL.\n## Decisions\nRead only.\n## Open\nTASK-CARRY-AUDIT unfinished.\n## Current Status\nIn progress.\n## Files\nNone');
      return { id: item.id, plannedChunks: S.chunkHistoryByBudget(history, budget).length, seedMessages: history.slice(0, 2) };
    });
    fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ event: 'dry_run', ...report, plans: plans.map(({ history, ...row }) => row), out: outPath })); return;
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(realRoot, 'config.json'), 'utf8')); }
  catch { throw new Error('cannot read or parse provider configuration'); }
  const providerId = arg('provider', cfg.compactProviderId || cfg.activeProvider || '');
  const raw = (cfg.providers || []).find(row => row && row.id === providerId);
  if (!raw) throw new Error('selected provider is not configured');
  const model = arg('model', (providerId === cfg.compactProviderId ? cfg.compactModel : '') || raw.model || '');
  if (!model || !raw.baseUrl) throw new Error('selected provider/model is incomplete');
  const provider = { ...raw, model, contextWindow };
  report.provider = { id: providerId, model, apiStyle: raw.apiStyle || 'chat' };
  const persist = () => { fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n'); };
  console.log(JSON.stringify({ event: 'evaluation_start', provider: report.provider, contextWindow, defaults: report.defaults, cases: cases.map(row => row.id), out: outPath }));
  for (const item of cases) {
    let previousSummary;
    for (let round = 1; round <= (item.rounds || 1); round++) {
      const history = nearTarget(item, previousSummary), plannedChunks = S.chunkHistoryByBudget(history, budget).length;
      if (plannedChunks < 3) throw new Error('sequential fixture must retain at least three chunks');
      const nativeFetch = global.fetch; let calls = 0; const statuses = [], responseCaptures = [];
      global.fetch = async (...args) => {
        const call = ++calls, response = await nativeFetch(...args); statuses.push(response.status);
        // Capture only replies to this synthetic compression round; never retain request headers/URLs.
        responseCaptures.push(response.clone().text().then(body => ({ call, status: response.status, rawBody: (raw.apiKey ? body.split(raw.apiKey).join('[redacted]') : body).split(raw.baseUrl).join('[endpoint]') }), error => ({ call, status: response.status, captureError: safeError(error, raw.apiKey) })));
        return response;
      };
      const start = Date.now(); let result;
      try { result = await S.providerSummaryCall(provider, history, { config: { ...summaryConfig, locale: item.language } }); }
      catch (error) { result = { ok: false, error: safeError(error, raw.apiKey) }; }
      finally { global.fetch = nativeFetch; }
      const rawResponses = await Promise.all(responseCaptures);
      const usage = result?.usage || {}, summary = String(result?.summary || '');
      const row = { case: item.id, round, ok: result?.ok === true, error: result?.ok ? '' : safeError(result?.error, raw.apiKey), wallMs: Date.now() - start,
        estimatedTokens: S.estimateHistoryTokens(history), plannedChunks, actualChunks: result?.mapReduce?.chunks ?? null, calls, statuses,
        inputTokens: Number(usage.prompt_tokens ?? usage.input_tokens) || 0, outputTokens: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
        rawResponses, mapReduce: result?.mapReduce || null, summaryPolicy: result?.summaryPolicy || null, summary, history, score: score(summary, item, round) };
      if (row.mapReduce?.taskEvidence) {
        row.score.checks.task_evidence_nonempty = Number(row.mapReduce.taskEvidence.entries) > 0;
        row.score.total++; if (row.score.checks.task_evidence_nonempty) row.score.passed++;
      }
      report.rows.push(row); persist();
      console.log(JSON.stringify({ event: 'round_done', case: item.id, round, ok: row.ok, plannedChunks, actualChunks: row.actualChunks, calls, inputTokens: row.inputTokens, outputTokens: row.outputTokens, score: row.score.checks, passed: row.score.passed, total: row.score.total }));
      if (!row.ok) break;
      previousSummary = summary;
    }
  }
  persist();
  const pass = report.rows.every(row => row.ok && row.actualChunks >= 3 && row.score.passed === row.score.total) && report.rows.length === cases.reduce((sum, item) => sum + (item.rounds || 1), 0);
  console.log(JSON.stringify({ event: 'evaluation_done', machineChecksPassed: pass, humanReviewRequired: true, rounds: report.rows.length, calls: report.rows.reduce((sum, row) => sum + row.calls, 0), out: outPath }));
  if (!pass) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ event: 'evaluation_failed', error: safeError(error) })); process.exitCode = 1; });
