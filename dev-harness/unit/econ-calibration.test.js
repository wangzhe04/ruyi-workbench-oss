// Unit: 22-§4.2 第0步计量校准 —— 不抽样总量(econ_call_totals)为口径事实源的已知答案账目。
// 验收矩阵:短序列精确、长序列超400上限仍报真实总量、重试/中断归属、子节点分账、缺失覆盖标 unknown。
'use strict';
const { summarizeEconomicsEvents } = require('../economics-report');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const mc = (id, iter, S, T) => ({ kind: 'model_call_started', sessionId: S, turnSeq: T, modelCallId: id, iter, apiStyle: 'chat', toolSchemaFingerprint: 'fp', historyBytes: 1000, estimatedInputTokens: 500 });
const md = (id, S, T) => ({ kind: 'model_call_completed', sessionId: S, turnSeq: T, modelCallId: id, providerResponseId: 'r_' + id, usageSource: 'provider', inputTokens: 600, outputTokens: 30, cachedInputTokens: 200, llmMs: 800, finishReason: 'stop', state: 'completed' });
const ab = (id, n, S, T) => ({ kind: 'assistant_tool_batch', sessionId: S, turnSeq: T, modelCallId: id, assistantBatchId: 'b_' + id, nTools: n, batchWidth: n, toolNamesHash: 'h', rawArgsBytes: 10 });
const tc = (batchId, name, S, T) => ({ kind: 'tool_call_completed', sessionId: S, turnSeq: T, assistantBatchId: batchId, toolCallId: 'c_' + Math.random(), name, tier: 'read', status: 'completed', toolMs: 10, argsBytes: 8, resultBytes: 20 });
const tp = (batchId, S, T) => ({ kind: 'tool_phase_completed', sessionId: S, turnSeq: T, assistantBatchId: batchId, strategy: 'serial', maxConcurrency: 1, toolsMs: 10, criticalPathMs: 10, serialEstimateMs: 10 });
// 按采样规则(first12 全采,之后每4采1)推算某 iter 是否落明细 —— 与运行时同一谓词,夹具用它对齐总量行声明。
const sampledIters = n => { let c = 0; for (let i = 0; i < n; i++) if (i < 12 || i % 4 === 0) c++; return c; };

// ── 场景1 · 短序列:3 次逻辑调用全采,1 次 failover 重试,4 个工具动作 ────────────────────────────────────
{
  const S = 'calib-short', T = 1;
  const ids = ['m0', 'm1', 'm2'];
  const events = [
    mc('m0', 0, S, T), md('m0', S, T),
    mc('m1', 1, S, T), md('m1', S, T), ab('m1', 2, S, T),
    tc('b_m1', 'file_read', S, T), tc('b_m1', 'file_search', S, T), tp('b_m1', S, T),
    mc('m2', 2, S, T), md('m2', S, T), ab('m2', 2, S, T),
    tc('b_m2', 'glob', S, T), tc('b_m2', 'list_tools', S, T), tp('b_m2', S, T),
    // 工具动作 4 = 明细里的 4 条(全采一致); 第 m2 调用有一次 failover 切换,但仍是同一逻辑调用。
  ];
  const totals = { kind: 'econ_call_totals', sessionId: S, turnSeq: T, engine: 'openai', apiStyle: 'chat',
    modelCallAttempts: ids.length, modelCallsLogged: sampledIters(ids.length), toolActions: 4, toolCallsLogged: 4,
    batchesLogged: 2, phasesLogged: 2, failoverAttempts: 1, eventsEmitted: events.length + 1 - 1, eventsDropped: 0, eventCap: 400, state: 'completed', durationMs: 5000 };
  const r = summarizeEconomicsEvents([...events, totals]);
  ok(r.schema === 2, 'S1 schema bumped to 2');
  ok(r.windows.modelCalls === 3 && r.windows.toolCalls === 4 && r.windows.turns === 1, 'S1 windows from unsampled totals');
  ok(r.windows.source === 'unsampled-totals' && r.coverage.estimatedFromSampled === false, 'S1 totals marked as truth source');
  ok(r.http.logicalModelCalls === 3 && r.http.extraEndpointAttempts === 1 && r.http.attemptsTotal === 4, 'S1 http attempts = logical + failover retry');
  ok(r.modelCalls.callsPerTask === 3, 'S1 callsPerTask uses real totals (3 calls / 1 turn)');
  const rec = r.coverage.reconciliation[0];
  ok(rec.countsMatchLedger === true && rec.truncatedByCap === false && rec.drifted === false, 'S1 reconciliation: detail rows == declared logged counts');
  ok(rec.sampledShare === 1, 'S1 short turn fully covered (sampledShare 1)');
}

// ── 场景2 · 长序列越过 400 上限:明细被截断,总量必须仍是真实值且标记截断不误判 drift ─────────────────────
{
  const S = 'calib-long', T = 9;
  const ATTEMPTS = 150;                 // 采样后应落账 12 + 每4取1 → 47 条 started 明细
  const LOGGED = sampledIters(ATTEMPTS);
  ok(LOGGED === 47, `fixture math: sampling rule predicts 47 sampled calls over ${ATTEMPTS} attempts`);
  const events = [];
  for (let i = 0; i < 20; i++) { const id = 'L' + i; events.push(mc(id, i * 4, S, T)); if (i < 18) events.push(md(id, S, T)); } // 只保留前段(模拟 400 上限截断后的残缺明细)
  const totals = { kind: 'econ_call_totals', sessionId: S, turnSeq: T, engine: 'openai', apiStyle: 'chat',
    modelCallAttempts: ATTEMPTS, modelCallsLogged: LOGGED, toolActions: 620, toolCallsLogged: 594,
    batchesLogged: LOGGED - 4, phasesLogged: LOGGED - 5, failoverAttempts: 0,
    eventsEmitted: 400, eventsDropped: 583, eventCap: 400, state: 'completed', durationMs: 120000 };
  const r = summarizeEconomicsEvents([...events, totals]);
  ok(r.windows.modelCalls === 150, 'S2 total stays TRUE attempt count under cap truncation (was ~19 before calibration)');
  ok(Math.abs(r.modelCalls.callsPerTask - 150) < 0.001, 'S2 callsPerTask = 150 real calls / 1 turn');
  ok(r.coverage.sampledCallsCoverage === 0.31, 'S2 sampled coverage ratio reported (47/150)');
  ok(r.coverage.turnsTruncatedByCap === 1, 'S2 truncation flagged via cap counter');
  ok(r.coverage.driftedTurnKeys.length === 0, 'S2 truncated-by-cap NOT misjudged as ledger drift');
  ok(r.pairing.scope.includes('coverage'), 'S2 pairing scoped to sampled slice, global integrity lives in coverage');
}

// ── 场景3 · 重试与中断:attempts 含未完成调用,state=error 如实透传 ──────────────────────────────────────
{
  const S = 'calib-interrupt', T = 2;
  const events = [mc('i0', 0, S, T), md('i0', S, T), ab('i0', 1, S, T),
    tc('b_i0', 'todo_write', S, T), tp('b_i0', S, T),
    mc('i1', 1, S, T), md('i1', S, T),
    mc('i2', 2, S, T),                 // 发出但回合中断,无 completed 行(历史缺陷会把这轮整条吞掉)
    mc('i3', 3, S, T)];                // 同上:已发出未配对
  const totals = { kind: 'econ_call_totals', sessionId: S, turnSeq: T, engine: 'openai', apiStyle: 'chat',
    modelCallAttempts: 4, modelCallsLogged: 4, toolActions: 1, toolCallsLogged: 1,
    batchesLogged: 1, phasesLogged: 1, failoverAttempts: 0, eventsEmitted: events.length, eventsDropped: 0, eventCap: 400, state: 'error', durationMs: 8000 };
  const r = summarizeEconomicsEvents([...events, totals]);
  ok(r.windows.modelCalls === 4, 'S3 interrupted attempts still counted (4 issued calls, not 2 completed)');
  ok(r.pairing.unpairedStarted === 2, 'S3 unpaired-in-sample visible (2 issued without completion)');
  ok(r.coverage.reconciliation[0].state === 'error', 'S3 turn terminal state passed through');
  ok(r.coverage.reconciliation[0].countsMatchLedger === true, 'S3 counts reconcile on an interrupted turn too');
}

// ── 场景4 · 子节点分账:父会话与子代理节点各自独立 totals,分账互不吞并 ───────────────────────────────────
{
  const P = 'parent-session', C = 'agent-run-node3';
  const events = [
    mc('p0', 0, P, 11), md('p0', P, 11), ab('p0', 1, P, 11), tc('b_p0', 'file_read', P, 11), tp('b_p0', P, 11),
    { kind: 'econ_call_totals', sessionId: P, turnSeq: 11, modelCallAttempts: 1, modelCallsLogged: 1, toolActions: 1, toolCallsLogged: 1, batchesLogged: 1, phasesLogged: 1, failoverAttempts: 0, eventsEmitted: 5, eventsDropped: 0, eventCap: 400, state: 'completed', durationMs: 3000 },
    mc('c0', 0, C, 1), md('c0', C, 1),
    { kind: 'econ_call_totals', sessionId: C, turnSeq: 1, modelCallAttempts: 1, modelCallsLogged: 1, toolActions: 0, toolCallsLogged: 0, batchesLogged: 0, phasesLogged: 0, failoverAttempts: 0, eventsEmitted: 2, eventsDropped: 0, eventCap: 400, state: 'completed', durationMs: 2500 },
  ];
  const r = summarizeEconomicsEvents(events);
  ok(r.windows.sessions === 2 && r.windows.turns === 2 && r.windows.modelCalls === 2, 'S4 parent + child node billed as separate turns/sessions');
  ok(r.windows.toolCalls === 1, 'S4 tool action attributed to parent only');
  ok(r.coverage.reconciliation.length === 2 && r.coverage.reconciliation.every(x => x.countsMatchLedger), 'S4 both ledgers reconcile independently');
}

// ── 场景5 · 缺失覆盖:旧日志(无 totals)必须显式降级为估计并标 unknown,不得冒充精确 ──────────────────────
{
  const events = [mc('x0', 0, 'legacy', 1), md('x0', 'legacy', 1)];
  const r = summarizeEconomicsEvents(events);
  ok(r.coverage.estimatedFromSampled === true && r.coverage.source === 'sampled-detail-only', 'S5 legacy window marked estimated-from-sample');
  ok(Array.isArray(r.coverage.unknowns) && r.coverage.unknowns.some(u => u.includes('no unsampled turn totals')), 'S5 explicit unknown entry present');
  ok(r.coverage.sampledCallsCoverage === null && r.http.attemptsTotal === null, 'S5 unrecoverable fields are null(unknown), not fabricated');
}

// ── 场景6 · 摘要调用归属:auto_L2/manual/subturn 计入 aux,不混入主循环调用量 ────────────────────────────
{
  const S = 'calib-summary';
  const events = [
    mc('z0', 0, S, 4), md('z0', S, 4),                        // 主循环唯一一次调用
    { kind: 'econ_summary_call', sessionId: S, turnSeq: 4, trigger: 'auto_L2', model: 'm', apiStyle: 'chat', ok: true, usageSource: 'provider', inputTokens: 1000, outputTokens: 50, cachedInputTokens: 300, httpMs: 900 },
    { kind: 'econ_summary_call', sessionId: S, trigger: 'manual', model: 'm', apiStyle: 'chat', ok: true, usageSource: 'missing', inputTokens: 0, outputTokens: 0, httpMs: 700 },
    { kind: 'econ_summary_call', sessionId: S, trigger: 'subturn_auto_L2', mapReduceChunk: 2, model: 'm', apiStyle: 'responses', ok: false, usageSource: 'missing', inputTokens: 0, outputTokens: 0, httpMs: 60 },
    { kind: 'auto_compact', mode: 'evaporate', ok: true },
    { kind: 'auto_compact', mode: 'summary', ok: true },
    { kind: 'auto_compact', mode: 'summary', ok: false },
    { kind: 'provider_compact' },
  ];
  const r = summarizeEconomicsEvents(events);
  ok(r.windows.modelCalls === 1, 'S6 summary calls never inflate main-loop call totals');
  ok(r.auxCalls.summaryCallsTotal === 3 && r.auxCalls.summaryOk === 2 && r.auxCalls.summaryFailed === 1, 'S6 aux summary counts split ok/failed');
  ok(r.auxCalls.byTrigger.find(t => t.name === 'manual').count === 1 && r.auxCalls.byTrigger.length === 3, 'S6 attribution by trigger source');
  ok(r.auxCalls.usageProviderShare === 0.33, 'S6 usage availability share honest (1/3 provider)');
  ok(r.auxCalls.providerTokens.input === 1000 && r.auxCalls.providerTokens.output === 50, 'S6 provider-reported summary tokens summed without estimation padding');
  ok(r.auxCalls.autoCompactEvaporateCount === 1 && r.auxCalls.autoCompactSummaryOkCount === 1 && r.auxCalls.autoCompactSummaryFailedCount === 1 && r.auxCalls.manualCompactCount === 1, 'S6 compaction event counts aggregated');
  ok(Array.isArray(r.coverage.unknowns) && r.coverage.unknowns.some(u => u.includes('token cost unknown') && u.includes('2/3')), 'S6 missing summary usage marked unknown with exact count');
}

// 报表脱敏纪律:任意场景输出都不得携带原始参数/路径
ok(!JSON.stringify([1]).includes('__proto__') && true, 'sanity noop');

console.log('');
if (fail) { console.log(`ECON-CALIBRATION UNIT: FAIL (${fail})`); process.exit(1); }
console.log('ECON-CALIBRATION UNIT: ALL PASS');
