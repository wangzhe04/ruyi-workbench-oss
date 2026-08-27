#!/usr/bin/env node
'use strict';

// 21-E1 tool-call economics baseline report. Reads ONLY the already-redacted ledger events emitted by the
// E0 shadow (model_call_started/completed, assistant_tool_batch, tool_call_completed, tool_phase_completed)
// plus the pre-existing iter_timing/turn_start rows. It never reads tool arguments, results, raw queries,
// file contents or paths, and never mutates Ruyi state. It freezes the baseline the E2+ active experiments
// must be attributed against; it authorizes no runtime behavior by itself.
const fs = require('fs');
const path = require('path');

function increment(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function sum(list) { return list.reduce((a, b) => a + b, 0); }
function mean(list) { return list.length ? sum(list) / list.length : 0; }
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function round(value, digits = 2) { return Number(Number(value || 0).toFixed(digits)); }
function pstats(values) {
  return { n: values.length, mean: round(mean(values)), p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), p99: round(percentile(values, 0.99)), max: round(values.length ? Math.max(...values) : 0) };
}
function sortedCounts(map, limit = 0) {
  const list = [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([name, count]) => ({ name, count }));
  return limit > 0 ? list.slice(0, limit) : list;
}
const ECON_KINDS = new Set(['model_call_started', 'model_call_completed', 'assistant_tool_batch', 'tool_call_completed', 'tool_phase_completed', 'econ_call_totals']);
// 归属辅助类:econ_call_totals = 回合级不抽样总量事实源(22-S0);其余为摘要调用归属与手工压缩计数。
const AUX_KINDS = new Set(['auto_compact', 'provider_compact', 'failover', 'econ_summary_call']);
const ALL_LEDGER_KINDS = new Set([...ECON_KINDS, ...AUX_KINDS]);
// Control-plane / meta tools whose solo batches are the E5 reduction target (solo meta batch / task).
const META_TOOLS = new Set(['todo_write', 'todo_update', 'mission_update', 'tool_search', 'tool_load', 'list_tools', 'tool_invoke_read', 'tool_invoke_edit', 'tool_invoke_exec']);

// ── per-batch helper: reconstruct each assistant batch's tool names from tool_call_completed rows ──────────
function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key == null) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function summarizeEconomicsEvents(events) {
  const rows = (Array.isArray(events) ? events : []).filter(e => e && ECON_KINDS.has(e.kind));
  const auxRows = (Array.isArray(events) ? events : []).filter(e => e && AUX_KINDS.has(e.kind));
  const started = rows.filter(r => r.kind === 'model_call_started');
  const completed = rows.filter(r => r.kind === 'model_call_completed');
  const batches = rows.filter(r => r.kind === 'assistant_tool_batch');
  const tools = rows.filter(r => r.kind === 'tool_call_completed');
  const phases = rows.filter(r => r.kind === 'tool_phase_completed');
  const totalsRows = rows.filter(r => r.kind === 'econ_call_totals');
  const hasTotals = totalsRows.length > 0;

  // ── 第0步计量校准:总量以 econ_call_totals(不抽样事实源)为准,明细条数只是采样宇宙 ─────────────────
  // turn/task 归属键:totals 行与明细行并集(子代理/摘要调用各自带 sessionId,天然按会话分账)。
  const turnKeys = new Set([...started, ...completed].map(r => `${r.sessionId || ''}#${r.turnSeq || 0}`));
  for (const t of totalsRows) turnKeys.add(`${t.sessionId || ''}#${t.turnSeq || 0}`);
  for (const s of auxRows) if (s.kind === 'econ_summary_call' && s.sessionId) turnKeys.add(`${s.sessionId}#${s.turnSeq || 0}`);
  const taskCount = turnKeys.size;

  const totalsAttempts = hasTotals ? totalsRows.reduce((a, t) => a + (Number(t.modelCallAttempts) || 0), 0) : null;
  const totalsToolActions = hasTotals ? totalsRows.reduce((a, t) => a + (Number(t.toolActions) || 0), 0) : null;
  const totalsFailovers = hasTotals ? totalsRows.reduce((a, t) => a + (Number(t.failoverAttempts) || 0), 0) : null;
  const totalsLoggedStarted = hasTotals ? totalsRows.reduce((a, t) => a + (Number(t.modelCallsLogged) || 0), 0) : null;
  const windowsModelCalls = hasTotals ? totalsAttempts : started.length;
  const windowsToolCalls = hasTotals ? totalsToolActions : tools.length;

  // ── 1. 模型调用 ──────────────────────────────────────────────────────────────────────────────────────
  // 有 totals 时分子用不抽样总量;否则退回明细条数并在 coverage.estimatedFromSampled 显式标记。
  const callsPerTask = taskCount ? windowsModelCalls / taskCount : 0;
  const startedIds = new Set(started.map(r => r.modelCallId));
  const completedIds = new Set(completed.map(r => r.modelCallId));
  const unpairedStarted = started.filter(r => !completedIds.has(r.modelCallId)).length;
  const unpairedCompleted = completed.filter(r => !startedIds.has(r.modelCallId)).length;
  const byUsageSource = new Map();
  for (const r of completed) increment(byUsageSource, String(r.usageSource || 'unknown'));
  const providerUsage = completed.filter(r => r.usageSource === 'provider');
  const toolBearingCalls = new Set(batches.map(r => r.modelCallId)).size;
  const toolBearingCallsTotal = hasTotals ? totalsRows.reduce((a, t) => a + (Number(t.batchesLogged) || 0), 0) : toolBearingCalls;
  const toolBearingRatio = windowsModelCalls ? toolBearingCallsTotal / windowsModelCalls : 0;
  const cachedTotals = providerUsage.reduce((acc, r) => { acc.input += r.inputTokens || 0; acc.cached += r.cachedInputTokens || 0; return acc; }, { input: 0, cached: 0 });
  const llmMs = completed.filter(r => r.llmMs >= 0).map(r => r.llmMs);
  const inputTokens = providerUsage.map(r => r.inputTokens || 0);
  const outputTokens = providerUsage.map(r => r.outputTokens || 0);

  // ── 2. 批次形态 ──────────────────────────────────────────────────────────────────────────────────────
  const batchTools = groupBy(tools, r => r.assistantBatchId);
  const bySession = groupBy(tools, r => r.sessionId);
  const callSessions = new Set(started.map(r => r.sessionId).filter(Boolean));
  const widthDist = new Map();
  const readOnlyBatches = [];   // 批内全部 tier==='read'
  const mixedBatches = [];      // 批内 read 与非 read 混存
  const wideReadBatches = [];   // nTools > 8 且全 read(当前回退串行, E2 的并行岛候选)
  for (const [batchId, rowsInBatch] of batchTools) {
    increment(widthDist, rowsInBatch.length);
    const tiers = new Set(rowsInBatch.map(t => String(t.tier || '')));
    const allRead = tiers.size === 1 && tiers.has('read');
    if (allRead && rowsInBatch.length > 8) wideReadBatches.push(batchId);
    if (allRead) readOnlyBatches.push(batchId);
    else if (tiers.size > 1) mixedBatches.push(batchId);
  }
  const batchWidthFromEvent = batches.map(r => r.batchWidth != null ? r.batchWidth : r.nTools || 0);
  const parallelPhases = phases.filter(r => r.strategy === 'parallel');
  const serialPhases = phases.filter(r => r.strategy === 'serial');

  // ── 3. 工具阶段 ──────────────────────────────────────────────────────────────────────────────────────
  const toolsMs = phases.map(r => r.toolsMs || 0);
  const criticalPath = phases.map(r => r.criticalPathMs || 0);
  const serialEst = phases.map(r => r.serialEstimateMs || 0);
  const speedups = phases.filter(r => (r.toolsMs || 0) > 0).map(r => ((r.serialEstimateMs || 0) / r.toolsMs));
  const toolMsPerCall = tools.map(r => r.toolMs || 0);

  // ── 4. 参数历史(代理: argsBytes 分布; 精确"后续重复携带"由 E3 双视图落地后提供) ──────────────────────
  const argsBytes = tools.map(r => r.argsBytes || 0);
  const resultBytes = tools.map(r => r.resultBytes || 0);
  const byArgsTool = new Map();
  for (const r of tools) byArgsTool.set(r.name, (byArgsTool.get(r.name) || 0) + (r.argsBytes || 0));
  const topArgsTools = sortedCounts(byArgsTool, 10).map(e => ({ name: e.name, argsBytes: e.count }));

  // ── 5. 元工具链 ──────────────────────────────────────────────────────────────────────────────────────
  const byMeta = new Map();
  for (const r of tools) if (META_TOOLS.has(r.name)) increment(byMeta, r.name);
  const soloMetaBatches = [];      // 单工具批且该工具属于 meta 集合
  for (const [batchId, rowsInBatch] of batchTools) {
    if (rowsInBatch.length === 1 && META_TOOLS.has(rowsInBatch[0].name)) soloMetaBatches.push(batchId);
  }
  const soloMetaPerTask = taskCount ? soloMetaBatches.length / taskCount : 0;
  // 三跳链: 按会话内出现顺序扫描 tool_call_completed, 识别 search → load → invoke/direct 链
  let chains = 0;
  for (const [sessionId, rowsInSession] of bySession) {
    let stage = 0; // 0=idle, 1=seen search, 2=seen load
    for (const row of rowsInSession) {
      const isSearch = row.name === 'tool_search';
      const isLoad = row.name === 'tool_load';
      const isInvoke = /^tool_invoke_/.test(row.name || '');
      const isConcreteTool = row.name && !META_TOOLS.has(row.name); // 直接落到具体工作工具
      if (stage === 0) { if (isSearch) stage = 1; }
      else if (stage === 1) {
        if (isLoad) stage = 2;
        else if (isSearch) stage = 1;      // 重复 search 保持等待
        else stage = 0;                     // 搜索后直接用了具体工具(无 load 链)或中断
      }
      else if (stage === 2) {
        if (isInvoke || isConcreteTool) { chains++; stage = 0; } // 链闭合: load 后经 invoke 或直调具体工具
        else if (isLoad) stage = 2;         // 连续 load
        else if (isSearch) stage = 1;
        else stage = 0;
      }
    }
  }
  const repeatSearch = new Map(); // sessionId -> 同会话 tool_search 重复次数
  for (const [sessionId, rowsInSession] of bySession) {
    const searches = rowsInSession.filter(r => r.name === 'tool_search');
    if (searches.length > 1) repeatSearch.set(sessionId, searches.length);
  }

  // ── 6. 缓存稳定性(代理: schema fingerprint 序列 + historyBytes 趋势) ─────────────────────────────────
  const fingerprintFlips = new Map(); // sessionId+turnSeq -> {flips, firstFlipIter}
  const byCallTurn = groupBy(started, r => `${r.sessionId || ''}#${r.turnSeq || 0}`);
  for (const [turnKey, rowsInTurn] of byCallTurn) {
    rowsInTurn.sort((a, b) => (a.iter || 0) - (b.iter || 0));
    let flips = 0, firstFlip = -1, prev = null;
    rowsInTurn.forEach((r, i) => {
      if (prev !== null && r.toolSchemaFingerprint && prev !== r.toolSchemaFingerprint) { flips++; if (firstFlip < 0) firstFlip = i; }
      prev = r.toolSchemaFingerprint;
    });
    fingerprintFlips.set(turnKey, { flips, firstFlipIter: firstFlip, calls: rowsInTurn.length });
  }
  const flipTurns = [...fingerprintFlips.values()].filter(v => v.flips > 0);
  const stableTurns = [...fingerprintFlips.values()].filter(v => v.flips === 0 && v.calls >= 2);
  const historyBytes = started.map(r => r.historyBytes || 0);

  // ── 7. 第0步计量校准:总量对账、采样覆盖率与辅助调用归属 ────────────────────────────────────────────
  // 对账三断言各自独立:①明细条数 == runtime 声明的已落账数(无丢失);②截断由上限造成时如实标注;
  // ③既不匹配又非截断 → drift(日志丢失或口径 bug)。只有 drifted 才是不可信信号。
  const turnKeyOf = r => `${r.sessionId || ''}#${r.turnSeq || 0}`;
  const startedByTurn = groupBy(started, turnKeyOf);
  const toolsByTurn = groupBy(tools, turnKeyOf);
  const batchesByTurn = groupBy(batches, turnKeyOf);
  const phasesByTurn = groupBy(phases, turnKeyOf);
  const reconciliation = totalsRows.map(t => {
    const key = turnKeyOf(t);
    const exp = {
      started: Number(t.modelCallsLogged) || 0,
      tools: Number(t.toolCallsLogged) || 0,
      batches: Number(t.batchesLogged) || 0,
      phases: Number(t.phasesLogged) || 0,
    };
    const got = {
      started: (startedByTurn.get(key) || []).length,
      tools: (toolsByTurn.get(key) || []).length,
      batches: (batchesByTurn.get(key) || []).length,
      phases: (phasesByTurn.get(key) || []).length,
    };
    const mismatched = (exp.started !== got.started) || (exp.tools !== got.tools) || (exp.batches !== got.batches) || (exp.phases !== got.phases);
    const truncatedByCap = (Number(t.eventsDropped) || 0) > 0;
    return {
      sessionId: t.sessionId || '', turnSeq: Number(t.turnSeq) || 0,
      state: String(t.state || ''), modelCallAttempts: Number(t.modelCallAttempts) || 0,
      failoverAttempts: Number(t.failoverAttempts) || 0,
      sampledShare: (Number(t.modelCallAttempts) || 0) ? round((Number(t.modelCallsLogged) || 0) / (Number(t.modelCallAttempts) || 0)) : 1,
      expectedDetailRows: exp.started + exp.tools + exp.batches + exp.phases,
      observedDetailRows: got.started + got.tools + got.batches + got.phases,
      truncatedByCap, countsMatchLedger: !mismatched,
      drifted: mismatched && !truncatedByCap,
    };
  });
  const driftedKeys = reconciliation.filter(r => r.drifted).map(r => `${r.sessionId}#${r.turnSeq}`);
  const cappedTurns = reconciliation.filter(r => r.truncatedByCap).length;

  // 摘要调用归属(auto_L2/manual/subturn/forced_400 等触发源分列)+ 手工压缩计数。
  const summaryRows = auxRows.filter(r => r.kind === 'econ_summary_call');
  const autoCompactSummaryOk = auxRows.filter(r => r.kind === 'auto_compact' && r.mode === 'summary' && r.ok === true).length;
  const autoCompactSummaryFailed = auxRows.filter(r => r.kind === 'auto_compact' && r.mode === 'summary' && r.ok === false).length;
  const autoCompactEvaporate = auxRows.filter(r => r.kind === 'auto_compact' && r.mode === 'evaporate').length;
  const manualCompacts = auxRows.filter(r => r.kind === 'provider_compact').length;
  const summaryUsageProvider = summaryRows.filter(r => r.usageSource === 'provider');
  const byTrigger = new Map();
  for (const r of summaryRows) increment(byTrigger, String(r.trigger || 'unknown'));
  const summaryTokens = summaryUsageProvider.reduce((a, r) => ({ input: a.input + (Number(r.inputTokens) || 0), output: a.output + (Number(r.outputTokens) || 0) }), { input: 0, output: 0 });

  // 缺失覆盖清单(诚实标记,不用推算值冒充精确总量):
  const unknowns = [];
  if (!hasTotals) unknowns.push('no unsampled turn totals (econ_call_totals) in window: callsPerTask uses sampled-detail counts and under-reports long turns');
  if (driftedKeys.length) unknowns.push(`detail rows diverge from declared logged counts beyond cap truncation in ${driftedKeys.length} turn(s)`);
  const missingUsage = summaryRows.filter(r => r.usageSource !== 'provider').length;
  if (missingUsage) unknowns.push(`token cost unknown (usageSource!=provider) for ${missingUsage}/${summaryRows.length} summary call(s)`);

  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    source: '21-E0 ledger shadow events (redacted) + 22-S0 unsampled turn totals',
    windows: {
      sessions: callSessions.size, turns: taskCount,
      modelCalls: windowsModelCalls, batches: hasTotals ? totalsRows.reduce((a, t) => a + (Number(t.batchesLogged) || 0), 0) : batches.length,
      toolCalls: windowsToolCalls, toolPhases: hasTotals ? totalsRows.reduce((a, t) => a + (Number(t.phasesLogged) || 0), 0) : phases.length,
      source: hasTotals ? 'unsampled-totals' : 'sampled-detail-counts',
    },
    coverage: {
      source: hasTotals ? 'unsampled-totals+sampled-detail' : 'sampled-detail-only',
      estimatedFromSampled: !hasTotals,
      turnsWithTotals: totalsRows.length,
      sampledCallsCoverage: hasTotals && totalsAttempts ? round(totalsLoggedStarted / totalsAttempts) : null,
      turnsTruncatedByCap: cappedTurns,
      reconciledTurns: reconciliation.filter(r => r.countsMatchLedger).length,
      driftedTurnKeys: driftedKeys,
      reconciliation,
      unknowns,
      note: '对账三断言独立成立:总量准确(=attempts)、配对完整(明细==声明落账数)、覆盖充分(sampledShare/截断标注);缺失标 unknown 不推算。',
    },
    http: {
      logicalModelCalls: windowsModelCalls,
      extraEndpointAttempts: hasTotals ? totalsFailovers : null,
      attemptsTotal: hasTotals ? windowsModelCalls + totalsFailovers : null,
      note: hasTotals ? 'HTTP 尝试 = 逻辑调用 + 预首字节失败后的备用端点重试;failover 明细行可交叉核对。回合完整调用面 = attemptsTotal + auxCalls.summaryCallsTotal(压缩/摘要调用单独归属)。' : '缺少 econ_call_totals 时 HTTP 尝试未知。',
    },
    auxCalls: {
      summaryCallsTotal: summaryRows.length,
      summaryOk: summaryRows.filter(r => r.ok === true).length,
      summaryFailed: summaryRows.filter(r => r.ok === false).length,
      byTrigger: sortedCounts(byTrigger),
      usageProviderShare: summaryRows.length ? round(summaryUsageProvider.length / summaryRows.length) : 0,
      providerTokens: summaryTokens,
      autoCompactEvaporateCount: autoCompactEvaporate,
      autoCompactSummaryOkCount: autoCompactSummaryOk,
      autoCompactSummaryFailedCount: autoCompactSummaryFailed,
      manualCompactCount: manualCompacts,
      note: 'econ_summary_call 覆盖自动压缩 L2/手工压缩/子代理压缩/超窗重试的摘要调用;playbook 草拟与 JSON 修复等辅助调用尚未归属(unknown)。evaporate 是本地改写,无模型调用。',
    },
    pairing: { unpairedStarted, unpairedCompleted, startedToCompletedRatio: started.length && completed.length ? round(completed.length / started.length) : 0, scope: 'unpaired 计数仅描述采样明细切片;全局完整性见 coverage.reconciliation' },
    modelCalls: {
      callsPerTask: round(callsPerTask, 3), toolBearingRatio: round(toolBearingRatio, 3),
      usageSource: sortedCounts(byUsageSource),
      providerInputTokens: pstats(inputTokens), providerOutputTokens: pstats(outputTokens),
      cachedInputShare: cachedTotals.input ? round(cachedTotals.cached / cachedTotals.input) : 0,
      llmMs: pstats(llmMs),
      note: 'calls 分子取自不抽样总量(econ_call_totals),含被采样规则跳过的调用;usage 缺失时 usageSource=estimated 不混入 provider 均值。',
    },
    batchShape: {
      widthDistribution: sortedCounts(widthDist),
      batchWidthFromEvent: pstats(batchWidthFromEvent),
      parallelPhaseShare: phases.length ? round(parallelPhases.length / phases.length) : 0,
      readOnlyBatchShare: batches.length ? round(readOnlyBatches.length / batches.length) : 0,
      mixedBatchShare: batches.length ? round(mixedBatches.length / batches.length) : 0,
      wideReadBatchesOver8: wideReadBatches.length,
      note: '>8 纯 read 批当前整体回退串行, 是 E2 bounded read worker pool 的并行岛候选。',
    },
    toolPhase: {
      toolsMs: pstats(toolsMs), criticalPathMs: pstats(criticalPath), serialEstimateMs: pstats(serialEst),
      toolMsPerCall: pstats(toolMsPerCall), speedupVsSerial: pstats(speedups),
      parallelPhaseCount: parallelPhases.length, serialPhaseCount: serialPhases.length,
      note: 'speedup = serialEstimate/toolsMs; 并行批 ≈ 关键路径收益, 串行批 ≈ 1。',
    },
    argsHistory: {
      argsBytesPerTool: pstats(argsBytes), resultBytesPerTool: pstats(resultBytes),
      topArgsTools,
      note: '后续重复携带次数与估算 input tokens 需 E3 action-envelope 双视图后才有精确值, 当前以 argsBytes 分布作基线。',
    },
    metaChain: {
      byMetaTool: sortedCounts(byMeta),
      soloMetaBatches, soloMetaPerTask: round(soloMetaPerTask, 3),
      searchLoadInvokeChains: chains,
      repeatSearchSessions: repeatSearch.size,
      note: '孤立 meta 批 = 单工具批且属于控制面工具; 三跳链按事件出现顺序扫描 search→load→invoke。',
    },
    cacheStability: {
      fingerprintFlipTurns: flipTurns.length, stableTurnCount: stableTurns.length,
      historyBytes: pstats(historyBytes),
      note: 'stable prefix bytes/first changed segment 需逐段对比, 当前以 schema fingerprint 变化与 historyBytes 趋势作代理。',
    },
    note: '本报表只读脱敏账本事件, 不改 prompt/调度/history; 是 E2+ 主动实验的归因基线, 不授权任何运行时行为。总量口径以 econ_call_totals 为事实源; claude/kimi 桥接回合与 playbook 草拟等非摘要辅助调用当前不在账本内(缺失标 unknown)。',
  };
}

// ── CLI / log reading ────────────────────────────────────────────────────────────────────────────────────
function resolveLogDir(input) {
  const target = path.resolve(input || process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(require('os').homedir(), '.win-claude-workbench'));
  const nested = path.join(target, 'logs');
  return fs.existsSync(nested) && fs.statSync(nested).isDirectory() ? nested : target;
}

function readEconomicsEvents(logDir) {
  if (!fs.existsSync(logDir)) return { events: [], files: [], parseErrors: 0 };
  const files = fs.readdirSync(logDir).filter(name => /^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort();
  const events = []; let parseErrors = 0;
  for (const name of files) {
    const lines = fs.readFileSync(path.join(logDir, name), 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try { const row = JSON.parse(line); if (row && ALL_LEDGER_KINDS.has(row.kind)) events.push(row); } catch { parseErrors++; }
    }
  }
  return { events, files, parseErrors };
}

if (require.main === module) {
  const input = process.argv[2];
  const logDir = resolveLogDir(input);
  const { events, files, parseErrors } = readEconomicsEvents(logDir);
  const report = summarizeEconomicsEvents(events);
  report.logDir = logDir; report.files = files; report.parseErrors = parseErrors;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

module.exports = { summarizeEconomicsEvents, ECON_KINDS, AUX_KINDS, META_TOOLS };
