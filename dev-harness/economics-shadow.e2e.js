// E2E: 21-E0 three-layer call ledger shadow (modelCallId → assistantBatchId → toolCallId).
// Drives a REAL workbench turn against the offline fake provider with a PARALLEL read batch, then
// asserts the five economics events are persisted to the NDJSON log with a coherent ID chain and
// without raw query/args leakage. No real model, no network, no HB360 dependency.
'use strict';
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePorts } = require('./free-port');
const { summarizeEconomicsEvents } = require('./economics-report');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), `ruyi-economics-${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, res => {
      let body = ''; res.on('data', c => (body += c)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', chunk => {
        buf += chunk; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore diagnostics */ } }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.end(data);
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

(async () => {
  let fail = 0; const children = [];
  const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const [fakePort, wbPort] = await getFreePorts(2);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 10, version: '2.5.0', permissionMode: 'bypass', toolLoadingMode: 'full', runtimeOptimizationShadowV1: true, runtimeToolRetrievalV1: false, runtimeFailureTelemetryV1: false,
    defaultWorkspace: HOME, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [], bridgeExternalToolsToProvider: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));

  try {
    const parallel = [
      { name: 'file_read', args: { path: path.join(HOME, 'a.txt') } },
      { name: 'file_read', args: { path: path.join(HOME, 'b.txt') } },
    ];
    fs.writeFileSync(path.join(HOME, 'a.txt'), 'AAA'); fs.writeFileSync(path.join(HOME, 'b.txt'), 'BBB');
    const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_PARALLEL_TOOLS: JSON.stringify(parallel) }, windowsHide: true });
    const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    children.push(fake, wb);
    let live = null; for (let i = 0; i < 50 && !live; i++) { await sleep(120); live = await health(wbPort); }
    ok(!!live, 'provider workbench starts');
    await postStream(wbPort, { message: 'Read both files and reply briefly.' });
    await sleep(400);
    const rows = fs.readdirSync(path.join(HOME, 'logs')).filter(f => /^workbench-.*\.ndjson$/.test(f))
      .flatMap(f => fs.readFileSync(path.join(HOME, 'logs', f), 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })).filter(Boolean);
    const econ = rows.filter(r => /^(model_call_started|model_call_completed|assistant_tool_batch|tool_call_completed|tool_phase_completed)$/.test(r.kind || ''));
    ok(econ.length >= 5, `five-class economics events persisted (got ${econ.length} rows)`);
    const started = econ.filter(r => r.kind === 'model_call_started');
    const completed = econ.filter(r => r.kind === 'model_call_completed');
    const batches = econ.filter(r => r.kind === 'assistant_tool_batch');
    const tools = econ.filter(r => r.kind === 'tool_call_completed');
    const phases = econ.filter(r => r.kind === 'tool_phase_completed');
    ok(started.length > 0 && completed.length > 0, 'model_call started/completed both present');
    ok(started.every(r => r.modelCallId && r.turnSeq && Number.isInteger(r.iter) && r.apiStyle && r.estimatedInputTokens >= 0), 'model_call_started carries required fields');
    ok(completed.every(r => r.modelCallId && typeof r.usageSource === 'string' && r.llmMs >= 0 && r.state), 'model_call_completed carries required fields');
    const startedIds = new Set(started.map(r => r.modelCallId));
    ok(completed.every(r => startedIds.has(r.modelCallId)), 'every completed pairs with a started modelCallId');
    ok(batches.length > 0 && batches[0].assistantBatchId && batches[0].nTools === 2 && batches[0].toolNamesHash, 'assistant_tool_batch carries batch id, width, names hash');
    ok(batches[0].modelCallId && startedIds.has(batches[0].modelCallId), 'assistant_tool_batch links to its modelCallId');
    ok(tools.length >= 2 && tools.every(r => r.toolCallId && r.name && r.tier && r.status && r.argsBytes >= 0 && r.resultBytes >= 0), 'tool_call_completed rows carry per-call ledger fields');
    ok(tools.every(r => r.assistantBatchId === batches[0].assistantBatchId), 'all tool_call_completed rows share the same assistantBatchId');
    ok(phases.length > 0 && phases[0].strategy === 'parallel' && phases[0].maxConcurrency === 2 && phases[0].criticalPathMs >= 0 && phases[0].serialEstimateMs >= 0, 'tool_phase_completed reports parallel strategy + critical path');
    ok(phases[0].assistantBatchId === batches[0].assistantBatchId, 'tool_phase_completed shares the batch id');
    const serialized = JSON.stringify(econ);
    ok(!serialized.includes('AAA') && !serialized.includes('BBB') && !serialized.includes(HOME), 'economics events leak no raw args or paths');
    // 采样纪律: 前 12 个 model call 全采,之后每 4 采 1 —— 本回合仅 2-3 个 call,应全量。
    ok(started.length <= 12, 'sampling keeps full coverage for short turns');
    // usage 增量语义: 若 provider 报 usage,completed 的 input/output ≥ 0 且与整回合累计一致。
    const usageRows = completed.filter(r => r.usageSource === 'provider');
    if (usageRows.length) ok(usageRows.every(r => r.inputTokens >= 0 && r.outputTokens >= 0), 'provider usage deltas are non-negative');
    // 21-E1: 同一批真实账本事件应能直接聚合出基线报告(读报告模块, 不复制日志)。
    const report = summarizeEconomicsEvents(econ);
    ok(report.windows.modelCalls > 0 && report.windows.toolCalls >= 2, 'E1 report aggregates the real e2e events');
    ok(report.pairing.unpairedStarted === 0 && report.pairing.unpairedCompleted === 0, 'E1 report pairing closed on real events');
    ok(report.batchShape.parallelPhaseShare === 1, 'E1 report sees the parallel read phase');
    ok(report.metaChain.soloMetaBatches.length === 0, 'E1 report finds no solo meta batch in this fixture');
    const serializedReport = JSON.stringify(report);
    ok(!serializedReport.includes('AAA') && !serializedReport.includes(HOME), 'E1 report leaks no raw args or paths');
    // ── 22-S0 计量校准:回合级不抽样总量账目(本夹具 1 回合 = 2 次模型调用 + 2 个并行 read) ──
    const totalsRows = rows.filter(r => r.kind === 'econ_call_totals');
    ok(totalsRows.length === 1, `exactly one econ_call_totals row persisted (got ${totalsRows.length})`);
    const tr = totalsRows[0];
    ok(tr.modelCallAttempts === started.length && tr.modelCallsLogged === started.length,
      'unsampled attempts == sampled logged rows on a short fully-sampled turn');
    ok(Number(tr.toolActions) >= 2 && tr.toolActions === tools.length, 'unsampled tool-action total reconciles with detail universe');
    ok(tr.batchesLogged === batches.length && tr.phasesLogged === phases.length, 'batch/phase logged counters reconcile with ledger rows');
    ok(tr.eventsEmitted > 0 && tr.eventsDropped === 0 && tr.eventCap === 400, 'cap accounting present with zero drops in this fixture');
    ok(tr.state === 'completed' && Number(tr.durationMs) >= 0 && !!tr.apiStyle, 'totals carry terminal state, duration, apiStyle');
    const serializedTotals = JSON.stringify(totalsRows);
    ok(!serializedTotals.includes('AAA') && !serializedTotals.includes(HOME), 'totals events leak no raw args or paths');
    // 报表端:含总量行时 windows 必须取「不抽样事实源」且实时对账闭合。
    const calibrated = summarizeEconomicsEvents(rows.filter(r => /^(model_call_started|model_call_completed|assistant_tool_batch|tool_call_completed|tool_phase_completed|econ_call_totals)$/.test(r.kind || '')));
    ok(calibrated.windows.source === 'unsampled-totals' && calibrated.windows.modelCalls === tr.modelCallAttempts, 'calibrated report takes unsampled totals as truth source');
    ok(calibrated.coverage.reconciliation.length === 1 && calibrated.coverage.reconciliation[0].countsMatchLedger === true, 'live ledger reconciliation closes');
    ok(Array.isArray(calibrated.coverage.unknowns) && calibrated.coverage.unknowns.length === 0, 'fully covered window reports zero unknowns');
  } catch (e) {
    fail++; console.log('ERROR ' + (e && e.stack || e));
  } finally {
    children.reverse().forEach(killTree); await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log(`\nECONOMICS-SHADOW E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
    process.exitCode = fail ? 1 : 0;
  }
})();
