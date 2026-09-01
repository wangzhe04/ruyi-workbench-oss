// E2E: 20-T1/20-C1/20-F1 runtime optimization pure logic + wiring locks. No ports, no model calls.
'use strict';
const crypto = require('crypto');
const { readServerSource } = require('./src-reader');
const src = readServerSource();
let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

console.log('\n── [S] feature flags and wiring ──');
ok(/runtimeOptimizationShadowV1: true/.test(src), 'S master shadow defaults true');
ok(/runtimeSessionNotesV1: true/.test(src), 'S runtimeSessionNotesV1 defaults true after 105b real-history gate');
ok(/runtimeSummaryEntityCheckV1: true/.test(src), 'S runtimeSummaryEntityCheckV1 defaults true after 105c real-history + DeepSeek gate');
ok(/'runtimeSessionNotesV1', 'runtimeSummaryEntityCheckV1'/.test(src), 'S runtimeSummaryEntityCheckV1 入严格布尔 sanitize 表');
ok(/function summaryEntityCheckEnabled\(config\)/.test(src), 'S summaryEntityCheckEnabled 唯一判定点存在');
ok(/runtimeSessionNotesInjectV1: true/.test(src), 'S runtimeSessionNotesInjectV1 defaults true after 105d real-history gate');
ok(/runtimeSessionNotesMergeV1: true/.test(src), 'S runtimeSessionNotesMergeV1 defaults true after 105d real-history gate');
ok(/'runtimeSummaryEntityCheckV1', 'runtimeSessionNotesInjectV1', 'runtimeSessionNotesMergeV1'/.test(src), 'S 105d 两开关入严格布尔 sanitize 表');
ok(/function sessionNotesInjectEnabled\(config\)/.test(src) && /function sessionNotesMergeEnabled\(config\)/.test(src), 'S 105d 两开关唯一判定点存在');
// 105e: 估算因子分桶 —— A/B 回放 + 夹具修复后默认开启；显式 false 完整回退两桶。
ok(/runtimeEstimateBucketsV1: true/.test(src), 'S runtimeEstimateBucketsV1 defaults true (105e 动态压缩门已过,显式 false 回退)');
ok(/'runtimeSessionNotesMergeV1', 'runtimeEstimateBucketsV1', 'runtimeFailureTelemetryV1'/.test(src), 'S runtimeEstimateBucketsV1 入严格布尔 sanitize 表(105c/105d 邻接不动)');
ok(/function estimateBucketsEnabled\(config\)/.test(src), 'S estimateBucketsEnabled 唯一判定点存在');
ok(/function setEstimateBucketsV1\(on\)/.test(src) && /function classifyTextForEstimate\(str\)/.test(src), 'S 105e 镜像 setter + 三桶分类器存在');
ok(/estimation: \{ sampleChars: 2048, jsonStructDensity: 0\.05, codeSignalThreshold: 3, factors: \{ json: 2\.8, code: 3\.2 \} \}/.test(src), 'S rules estimation 块(json 2.8 / code 3.2)在产物 fallback 内');
ok(/setEstimateBucketsV1\(estimateBucketsEnabled\(config\)\)/.test(src), 'S 入口镜像刷新接线(runOpenAiTurn/runSubAgentCore;maybeAutoCompact 唯一调用点在回合内,不重复刷新)');
for (const flag of ['runtimeToolRetrievalV1', 'runtimeFailureTelemetryV1']) {
  ok(new RegExp(flag + ': false').test(src), `S ${flag} defaults false`);
  ok(new RegExp("config\\[key\\] === true").test(src), `S strict boolean normalization present (${flag})`);
}
for (const flag of ['runtimeObservationReducerV1', 'runtimeObservationRecallV1']) {
  ok(new RegExp(flag + ': true').test(src), `S ${flag} defaults true after 105a real-history adoption gate`);
  ok(new RegExp("config\\[key\\] === true").test(src), `S strict boolean normalization present (${flag})`);
}
ok(/searchToolCatalog\(catalog, \{ query, limit \}, config/.test(src), 'S OpenAI catalog uses shared T1 ranker');
ok(/searchToolCatalog\(catalog, args, config/.test(src), 'S Claude\/MCP catalog uses shared T1 ranker');
ok(/runtimeFailureTelemetryV1 === true \|\| config\.runtimeOptimizationShadowV1 === true/.test(src) && /kind: 'runtime_failure_classified'/.test(src), 'S F1 classification runs under the master shadow switch');
ok(!/function attemptRuntimeRecovery|runtimeRecoveryBriefV1/.test(src), 'S F1 shadow slice contains no recovery executor');

console.log('\n── [T1] deterministic hybrid retrieval ──');
const t1Start = src.indexOf('const TOOL_RETRIEVAL_HINTS = Object.freeze({');
const t1End = src.indexOf('\nfunction listCompactTools(', t1Start);
ok(t1Start >= 0 && t1End > t1Start, 'T1 source block found');
const t1Block = src.slice(t1Start, t1End);
const t1 = new Function('crypto', 'TOOL_PACK_DESCRIPTIONS', t1Block + '\nreturn { searchToolCatalog, compareToolRetrievalShadow, classifyRuntimeToolFailure };')(crypto, { core: 'core', code: 'code', files_read: 'files', files_write: 'writes', network: 'network' });
const item = (name, pack, tier, aliases, capabilities, parameterText, description) => ({ name, pack, tier, aliases, capabilities, parameterText, description, bridged: false });
const catalog = [
  item('file_read', 'files_read', 'read', ['读取文件', '查看文件'], ['workspace.file.read'], 'path offset limit', 'Read a workspace file'),
  item('file_edit', 'files_write', 'edit', ['修改文件', '替换文本'], ['workspace.file.edit'], 'path old_text new_text', 'Edit a file'),
  item('codebase_symbol_search', 'code', 'read', ['查找符号定义', '查找代码引用'], ['code.symbol.definition', 'code.symbol.references'], 'query root', 'Find code definitions and references'),
  item('http_download', 'network', 'edit', ['下载文件', '从网址下载'], ['network.http.download'], 'url dest', 'Download a URL to a file'),
];
const cfg = { runtimeToolRetrievalV1: true, permissionMode: 'plan' };
const zh = t1.searchToolCatalog(catalog, { query: '查找代码符号的定义和引用', limit: 3 }, cfg, {});
ok(zh.matches[0] && zh.matches[0].name === 'codebase_symbol_search', 'T1 Chinese implicit intent ranks symbol search first');
ok(zh.matches[0].matchedOn.includes('aliases') || zh.matches[0].matchedOn.includes('capabilities'), 'T1 explain exposes matched fields');
const params = t1.searchToolCatalog(catalog, { query: 'old_text new_text', limit: 3 }, cfg, {});
ok(params.matches[0] && params.matches[0].name === 'file_edit' && params.matches[0].matchedOn.includes('parameters'), 'T1 JSON Schema parameter terms participate in ranking');
const exact = t1.searchToolCatalog(catalog, { query: 'http_download', limit: 2 }, cfg, { loadedNames: new Set(['file_read']) });
ok(exact.matches[0].name === 'http_download' && exact.matches[0].blockedReason && exact.retrievalVersion === 'deterministic-v1', 'T1 exact name boost + permission explanation');
const legacy = t1.searchToolCatalog(catalog, { query: 'workspace file', limit: 2 }, { runtimeToolRetrievalV1: false }, { legacyNameBoost: 3 });
ok(!legacy.retrievalVersion && legacy.matches.length > 0, 'T1 flag off preserves legacy result shape');
const shadowCandidate = t1.searchToolCatalog(catalog, { query: '查找代码符号的定义和引用', limit: 3 }, { runtimeToolRetrievalV1: false }, { forceV1: true });
const comparison = t1.compareToolRetrievalShadow(legacy, shadowCandidate);
ok(shadowCandidate.retrievalVersion === 'deterministic-v1' && comparison.queryHash && !('query' in comparison), 'T1 shadow evaluates v1 without exposing the raw query');

console.log('\n── [C1] deterministic observation reduction ──');
const c1Start = src.indexOf('const OBSERVATION_REDUCE_MIN = 1200;');
const c1End = src.indexOf('\n// v0.8-S5 SHARED SUMMARY KERNEL', c1Start);
ok(c1Start >= 0 && c1End > c1Start, 'C1 source block found');
const c1Block = src.slice(c1Start, c1End);
const c1 = new Function('crypto', 'EVAPORATED_PREFIX', c1Block + '\nreturn { reduceObservationContent, protectedObservation, evaporateHistory, measureObservationReductionShadow };')(crypto, '[已省略:');
const large = JSON.stringify({ ok: true, query: 'needle', matches: Array.from({ length: 80 }, (_, i) => ({ path: `src/f${i}.js`, line: i, text: 'X'.repeat(180) })) });
const reduced = c1.reduceObservationContent('file_search', large, 'history:3:aaaaaaaaaaaaaaaa:2:bbbbbbbbbbbbbbbb');
ok(reduced.reduced && reduced.visibleChars < reduced.originalChars && reduced.content.includes('rawRef'), 'C1 large JSON becomes a smaller structured model view with rawRef');
ok(c1.protectedObservation('file_write', { content: JSON.stringify({ ok: true, op: 'modify', path: 'a.js' }) }) === 'change_evidence', 'C1 write/checkpoint evidence is protected');
const history = [
  { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'file_search', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 't1', content: large },
  { role: 'assistant', content: 'later' },
  { role: 'assistant', content: 'latest' },
];
let meta = null;
const count = c1.evaporateHistory(history, { config: { runtimeObservationReducerV1: true }, rawRefPrefix: 'history:3:aaaaaaaaaaaaaaaa', onReduced: value => { meta = value; } });
ok(count === 1 && meta && history[1].content.includes('_ruyiObservation'), 'C1 reducer runs only on old observations and emits metadata');
ok(history[0].tool_calls[0].id === history[1].tool_call_id, 'C1 keeps tool-call pairing intact');
const legacyHistory = JSON.parse(JSON.stringify(history));
legacyHistory[1].content = large;
c1.evaporateHistory(legacyHistory);
ok(legacyHistory[1].content.startsWith('[已省略:'), 'C1 flag off keeps legacy evaporation behavior');
const shadowHistory = [
  { role: 'assistant', tool_calls: [{ id: 's1', type: 'function', function: { name: 'file_search', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 's1', content: large },
  { role: 'assistant', content: 'later' },
  { role: 'assistant', content: 'latest' },
];
const shadowBefore = JSON.stringify(shadowHistory);
const shadowMetrics = c1.measureObservationReductionShadow(shadowHistory);
ok(JSON.stringify(shadowHistory) === shadowBefore && shadowMetrics.candidateReducedCount === 1 && shadowMetrics.candidateVisibleChars < shadowMetrics.originalChars, 'C1 shadow measures a copied history without mutating the live prefix');

console.log('\n── [F1] deterministic classification ──');
ok(t1.classifyRuntimeToolFailure('file_read', { ok: false, error: 'ETIMEDOUT' }, { tier: 'read' }).failureClass === 'transient_read', 'F1 read timeout → transient_read');
ok(t1.classifyRuntimeToolFailure('file_edit', { ok: false, error: 'timeout after dispatch' }, { tier: 'edit' }).failureClass === 'side_effect_unknown', 'F1 mutating timeout → side_effect_unknown');
ok(t1.classifyRuntimeToolFailure('file_read', { ok: false, error: 'required property path is missing' }, { tier: 'read' }).failureClass === 'invalid_arguments', 'F1 schema error → invalid_arguments');
ok(t1.classifyRuntimeToolFailure('file_write', { ok: false, error: 'denied by user' }, { tier: 'edit' }).recoverableHint === false, 'F1 permission denial is not auto-recoverable');
ok(t1.classifyRuntimeToolFailure('file_read', { ok: true, content: 'ok' }, { tier: 'read' }) === null, 'F1 successful calls produce no failure record');
const timedExec = t1.classifyRuntimeToolFailure('powershell_run', { ok: false, code: -1, timedOut: true, stderr: '[timed out; process tree killed]' }, { tier: 'exec' });
ok(timedExec.failureClass === 'side_effect_unknown' && timedExec.allowedRepair === 'stop_for_effect_check', 'F1 structured exec timeout stays side-effect-safe');
ok(t1.classifyRuntimeToolFailure('script_run', { ok: false, code: 1, stderr: 'Traceback (most recent call last)' }, { tier: 'exec' }).failureClass === 'execution_failed', 'F1 non-zero process result → execution_failed');
ok(t1.classifyRuntimeToolFailure('file_edit', { ok: false, error: 'oldText was not found' }, { tier: 'edit' }).failureClass === 'edit_conflict', 'F1 stale edit anchor → edit_conflict');
ok(t1.classifyRuntimeToolFailure('web_search', { ok: false, error: 'query is required' }, { tier: 'read' }).failureClass === 'invalid_arguments', 'F1 required named input → invalid_arguments');
ok(t1.classifyRuntimeToolFailure('file_read', { ok: false, code: 'not-allowed', error: '该路径属于应用内部数据，已禁止文件工具访问' }, { tier: 'read' }).failureClass === 'policy_blocked', 'F1 product guard → policy_blocked');
ok(t1.classifyRuntimeToolFailure('shell_send', { ok: false, error: "未知 shellId 'gone'" }, { tier: 'exec' }).failureClass === 'resource_not_found', 'F1 expired runtime handle → resource_not_found');
ok(t1.classifyRuntimeToolFailure('file_edit', { ok: false, error: 'HTTP 503 Service Unavailable' }, { tier: 'edit' }).failureClass === 'side_effect_unknown', 'F1 mutating transport ambiguity never becomes retry_once');
ok(t1.classifyRuntimeToolFailure('file_read', { ok: true, error: 'warning field present' }, { tier: 'read' }) === null, 'F1 ok:true warning does not become a failure');
ok(timedExec.classifierVersion === 'deterministic-v2' && !JSON.stringify(timedExec).includes('process tree killed'), 'F1 v2 telemetry exposes version but not raw stderr');

console.log('\n── [E0] three-layer call ledger shadow (21) ──');
ok(/toolEconomicsShadowV1: true/.test(src), 'E0 economics shadow defaults true (sampled)');
ok(/econLog\('model_call_started'/.test(src) && /econLog\('model_call_completed'/.test(src), 'E0 model_call started/completed events wired');
ok(/econLog\('assistant_tool_batch'/.test(src), 'E0 assistant_tool_batch event wired');
ok(/econLog\('tool_call_completed'/.test(src) && /econLog\('tool_phase_completed'/.test(src), 'E0 tool_call/tool_phase completed events wired');
ok(/ECON_EVENT_CAP = 400/.test(src) && /econSampledIter = iter => iter < ECON_SAMPLE_FULL_ITERS/.test(src), 'E0 sampling + per-turn event cap present');
ok(/providerResponseId/.test(src), 'E0 provider response id surfaced from stream layer');
ok(/usageSource: usageCalls > usageSnapshot\.calls \? 'provider' : 'estimated'/.test(src), 'E0 usage source distinguishes provider-reported vs estimated');
ok(/assistantBatchId: activeProviderBatchId, toolCallId: tc\.id/.test(src), 'E0 tool_call_completed carries the three-layer link');
ok(!/toolEconomicsShadowV1: false/.test(src), 'E0 economics shadow is not an opt-in-only flag');

console.log('\n── [E2] bounded read scheduler wiring (21) ──');
ok(/boundedReadSchedulerV1: false/.test(src), 'E2 active scheduler defaults false');
ok(/boundedReadConcurrencyV1: 4/.test(src), 'E2 default concurrency 4');
ok(/config\.boundedReadSchedulerV1 === true/.test(src), 'E2 strict boolean gate in the tool loop');
ok(/Math\.min\(8, Math\.max\(4, localToolCalls\.length\)\)/.test(src), 'E2 concurrency formula = min(8, max(4, width)) (decision B)');
ok(/strategy: poolStrategy/.test(src) && /'pool_read'/.test(src), 'E2 phase event exposes pool_read strategy');
ok(/queueWaitMs/.test(src), 'E2 resource-queue wait measured');
ok(!/boundedReadSchedulerV1: true/.test(src), 'E2 active flag is not defaulted on');

console.log('\n── [E5] meta-tool convergence wiring (21) ──');
ok(/metaToolHintsV1: false/.test(src), 'E5 meta hints default false');
ok(/function buildCallHint/.test(src) && /callHint/.test(src) && /requiredArgs/.test(src) && /'blocked'/.test(src), 'E5 search hint builder present (requiredArgs/callHint/state/blockedReason)');
ok(/config\.metaToolHintsV1 === true/.test(src), 'E5 hints gated on strict boolean');
ok(/discoveryState = \{ seq: 0, openedAt: 0, awaitingOutcome: false \}/.test(src), 'E5 discoverySeq chain state present');
ok(/searchSeq: discoveryState\.seq/.test(src) && /discoverySeq: discoveryState\.seq/.test(src), 'E5 searchSeq/discoverySeq emitted into the ledger');
ok(/unchanged: true, note: '任务清单与当前状态一致/.test(src), 'E5 todo dedupe returns unchanged on identical content');
ok(/deduped: true/.test(src), 'E5 deduped flag lands in tool_call_completed');
ok(!/metaToolHintsV1: true/.test(src), 'E5 meta hints are not defaulted on');

console.log('\n── [E3] action-argument model view wiring (21) ──');
ok(/actionArgumentModelViewV1: false/.test(src), 'E3 action model view defaults false');
ok(/function projectActionModelView/.test(src) && /ACTION_VIEW_TOOLS = new Set\(/.test(src) && /ACTION_VIEW_MIN_CHARS = 512/.test(src), 'E3 projection block present (whitelist + threshold)');
ok(/const viewHistory = actionAuditMap\.size \? projectActionModelView\(session\.providerHistory, actionAuditMap\)\.history : session\.providerHistory;/.test(src), 'E3 buildBody consumes the projected view');
ok(/crypto\.createHash\('sha256'\)\.update\(rawArgs\)\.digest\('hex'\) !== entry\.sha256/.test(src), 'E3 sha256 tamper gate on projection');
ok(/session\.actionAudit\.length > 200/.test(src), 'E3 audit capped (no unbounded growth)');
ok(/status: isErr \? 'failed' : 'completed'/.test(src), 'E3 failed actions never projected');
ok(!/actionArgumentModelViewV1: true/.test(src), 'E3 action model view is not defaulted on');

console.log('');
if (fail) { console.log(`RUNTIME-OPTIMIZATION E2E: FAIL (${fail})`); process.exit(1); }
console.log('RUNTIME-OPTIMIZATION E2E: ALL PASS');
