// Unit: 21-E1 economics baseline report aggregation over synthetic (redacted) ledger events.
'use strict';
const { summarizeEconomicsEvents } = require('../economics-report');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const S = 'session-1';
const T = 7;
// session-1 / turn-7: 3 model calls — call0 no tools (plain answer), call1 parallel read batch of 2,
// call2 solo todo_write; a search→load→invoke chain; one schema fingerprint flip.
const mc = (id, iter, fp) => ({ kind: 'model_call_started', sessionId: S, turnSeq: T, traceId: 't', modelCallId: id, iter, apiStyle: 'chat', toolSchemaFingerprint: fp, historyBytes: 8000 + iter * 100, estimatedInputTokens: 2000 + iter * 50 });
const md = (id, usageSource, inp, out, cached) => ({ kind: 'model_call_completed', sessionId: S, turnSeq: T, modelCallId: id, providerResponseId: 'resp_' + id, usageSource, inputTokens: inp, outputTokens: out, cachedInputTokens: cached, llmMs: 900, finishReason: 'stop', state: 'completed' });
const ab = (mcId, batchId, nTools, names) => ({ kind: 'assistant_tool_batch', sessionId: S, turnSeq: T, modelCallId: mcId, assistantBatchId: batchId, nTools, batchWidth: nTools, toolNamesHash: names, rawArgsBytes: 120 });
const tc = (batchId, id, name, tier, argsBytes, resultBytes, toolMs, status) => ({ kind: 'tool_call_completed', sessionId: S, turnSeq: T, assistantBatchId: batchId, toolCallId: id, name, tier, status, toolMs, argsBytes, resultBytes });
const tp = (batchId, strategy, maxConc, toolsMs, crit, serial) => ({ kind: 'tool_phase_completed', sessionId: S, turnSeq: T, assistantBatchId: batchId, strategy, maxConcurrency: maxConc, toolsMs, criticalPathMs: crit, serialEstimateMs: serial });

const events = [
  mc('m0', 0, 'fp-a'), md('m0', 'provider', 2100, 120, 500),
  mc('m1', 1, 'fp-a'), md('m1', 'provider', 2300, 80, 600),
  ab('m1', 'b1', 2, 'hash-read'),
  tc('b1', 'c1', 'file_read', 'read', 40, 300, 60, 'completed'),
  tc('b1', 'c2', 'file_search', 'read', 60, 800, 200, 'completed'),
  tp('b1', 'parallel', 2, 210, 200, 260),
  mc('m2', 2, 'fp-b'), md('m2', 'estimated', 0, 0, 0),
  ab('m2', 'b2', 1, 'hash-todo'),
  tc('b2', 'c3', 'todo_write', 'edit', 30, 20, 5, 'completed'),
  tp('b2', 'serial', 1, 5, 5, 5),
  // meta chain: search → load → invoke
  tc('b3', 'c4', 'tool_search', 'read', 25, 100, 3, 'completed'),
  tc('b4', 'c5', 'tool_load', 'read', 20, 80, 2, 'completed'),
  tc('b5', 'c6', 'tool_invoke_read', 'read', 50, 400, 30, 'completed'),
  // session-2 / turn-1: two plain calls (no tools), stable fingerprint across both
  { kind: 'model_call_started', sessionId: 'session-2', turnSeq: 1, traceId: 't2', modelCallId: 'm9', iter: 0, apiStyle: 'responses', toolSchemaFingerprint: 'fp-x', historyBytes: 5000, estimatedInputTokens: 1000 },
  { kind: 'model_call_completed', sessionId: 'session-2', turnSeq: 1, modelCallId: 'm9', providerResponseId: 'resp_9', usageSource: 'provider', inputTokens: 1100, outputTokens: 40, cachedInputTokens: 900, llmMs: 500, finishReason: 'stop', state: 'completed' },
  { kind: 'model_call_started', sessionId: 'session-2', turnSeq: 1, traceId: 't2', modelCallId: 'm10', iter: 1, apiStyle: 'responses', toolSchemaFingerprint: 'fp-x', historyBytes: 5100, estimatedInputTokens: 1100 },
  { kind: 'model_call_completed', sessionId: 'session-2', turnSeq: 1, modelCallId: 'm10', providerResponseId: 'resp_10', usageSource: 'provider', inputTokens: 1200, outputTokens: 30, cachedInputTokens: 1000, llmMs: 450, finishReason: 'stop', state: 'completed' },
];

const r = summarizeEconomicsEvents(events);

// ── 1. 模型调用 ──
ok(r.windows.sessions === 2 && r.windows.turns === 2 && r.windows.modelCalls === 5, 'windows: 2 sessions / 2 turns / 5 calls');
ok(r.modelCalls.callsPerTask === 2.5, 'calls/task = 5/2');
ok(r.modelCalls.toolBearingRatio === 0.4, 'tool-bearing ratio = 2/5');
ok(r.modelCalls.usageSource.length === 2 && r.modelCalls.usageSource.find(s => s.name === 'provider').count === 4, 'usage source: 4 provider + 1 estimated');
ok(r.modelCalls.cachedInputShare > 0 && r.modelCalls.cachedInputShare < 0.5, 'cached share in (0, 0.5)');
ok(r.pairing.unpairedStarted === 0 && r.pairing.unpairedCompleted === 0 && r.pairing.startedToCompletedRatio === 1, 'pairing closed (no silent drops)');

// ── 2. 批次形态 ──
ok(r.batchShape.parallelPhaseShare === 0.5, 'parallel phase share = 1/2 phases');
ok(r.batchShape.readOnlyBatchShare > 0, 'read-only batch detected');
ok(r.batchShape.mixedBatchShare === 0, 'no mixed-tier batch in fixture');
ok(r.batchShape.widthDistribution.find(d => Number(d.name) === 2).count === 1, 'width distribution counts the 2-wide batch');

// ── 3. 工具阶段 ──
ok(r.toolPhase.parallelPhaseCount === 1 && r.toolPhase.serialPhaseCount === 1, 'parallel/serial phase counts');
ok(r.toolPhase.speedupVsSerial.n === 2 && r.toolPhase.speedupVsSerial.mean >= 1, 'speedup computed for both phases (parallel ~1.24, serial 1)');

// ── 4. 参数历史 ──
ok(r.argsHistory.argsBytesPerTool.n === 6 && r.argsHistory.argsBytesPerTool.max === 60, 'args bytes distribution over 6 tool calls');
ok(r.argsHistory.topArgsTools[0].name === 'file_search' && r.argsHistory.topArgsTools[0].argsBytes === 60, 'top args tool = file_search (60B)');

// ── 5. 元工具链 ──
// todo_write 单工具批 + search/load/invoke 各自是独立批次(真实语义中它们就是孤立 meta 批, E5 削减目标)
ok(r.metaChain.soloMetaBatches.length === 4 && r.metaChain.soloMetaPerTask === 2, 'solo meta batches = 4 (todo/search/load/invoke) / 2 turns');
ok(r.metaChain.byMetaTool.find(s => s.name === 'todo_write').count === 1, 'meta tool counts by name');
ok(r.metaChain.searchLoadInvokeChains === 1, 'search→load→invoke chain detected exactly once');

// ── 6. 缓存稳定性 ──
ok(r.cacheStability.fingerprintFlipTurns === 1 && r.cacheStability.stableTurnCount === 1, 'one flip turn (fp-a→fp-b), one stable multi-call turn');

// 只读纪律: 报告只含元数据(name/bytes/distributions), 不含 rawArgs/result 原文
ok(!JSON.stringify(r).includes('rawArgs'), 'report never serializes raw arguments');

console.log('');
if (fail) { console.log(`ECONOMICS-REPORT UNIT: FAIL (${fail})`); process.exit(1); }
console.log('ECONOMICS-REPORT UNIT: ALL PASS');
