#!/usr/bin/env node
'use strict';

// LIVE E2E · 106 #1 G1/G2 + #2a 真实 provider A/B
//
// 从本机工作台配置读取当前 active provider（key 只存在于临时配置和进程内，不写报告），
// 通过真实 Workbench HTTP 回合比较：
//   G1: runtimeVolatileTailLayoutV1 off/on —— layout_shadow 与 provider cachedInputTokens
//   G2: runtimeAppendOnlyToolSchemasV1 off/on —— schema freeze、跨轮缓存与任务正确性
//   #2a: runtimeExecResultCacheV1 off/on —— 重复 file_read 的命中/本地工具耗时/结果等价
//   #2a-large: 4 个约 2MB 文件、每个首行读取重复 3 次 —— 放大本地读盘/解析差异
//
// 报告只落计量数字、布尔正确性和脱敏事件摘要，不落历史正文、回复文本或 API key。
// 用法: node dev-harness/prefix-layout-real-live.js [结果JSON路径]

const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const DEFAULT_CONFIG = path.join(os.homedir(), '.win-claude-workbench', 'config.json');
const CONFIG_PATH = process.env.RUYI_REAL_CONFIG || DEFAULT_CONFIG;
const OUT = process.argv[2] || process.env.RUYI_REAL_OUT || '';
const MODEL_OVERRIDE = process.env.RUYI_REAL_MODEL || '';
const RUN_SALT = process.env.RUYI_REAL_SALT || `106-real-${Date.now().toString(36)}-${process.pid}`;
const PRICING = { inputPerM: 1, cachedInputPerM: 0.02, outputPerM: 2, currency: 'CNY' };

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function safeReadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2500 }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function kill(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGTERM');
  } catch { /* already exited */ }
}
function postStream(port, payload) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload);
    const events = [];
    const started = Date.now();
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST',
      timeout: 180000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try { events.push(JSON.parse(line)); } catch { /* tolerate keepalive/non-json */ }
        }
      });
      res.on('end', () => {
        if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } }
        resolve({ events, wallMs: Date.now() - started });
      });
    });
    req.on('error', error => resolve({ events, wallMs: Date.now() - started, error: String(error.message || error) }));
    req.on('timeout', () => { req.destroy(); resolve({ events, wallMs: Date.now() - started, error: 'http timeout' }); });
    req.write(data); req.end();
  });
}
function readLogs(home) {
  const dir = path.join(home, 'logs');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.ndjson')).sort(); } catch { return []; }
  const rows = [];
  for (const file of files) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean); } catch { continue; }
    for (const line of lines) { try { const row = JSON.parse(line); if (row && typeof row === 'object') rows.push(row); } catch { /* ignore malformed tail */ } }
  }
  return rows;
}
function usageFromEvents(events) {
  const out = { input: 0, output: 0, cached: 0, calls: 0 };
  for (const evt of events || []) {
    if (evt.type !== 'usage') continue;
    const u = evt.usage || evt;
    out.input += Number(u.input_tokens || u.inputTokens || 0) || 0;
    out.output += Number(u.output_tokens || u.outputTokens || 0) || 0;
    out.cached += Number(u.cached_input_tokens || u.cachedInputTokens || 0) || 0;
    out.calls += 1;
  }
  return out;
}
function costOf(u) {
  return (u.input - u.cached) / 1e6 * PRICING.inputPerM
    + u.cached / 1e6 * PRICING.cachedInputPerM
    + u.output / 1e6 * PRICING.outputPerM;
}
function compactTurn(events, wallMs, expected) {
  const text = (events || []).filter(e => e.type === 'assistant_delta').map(e => String(e.text || '')).join('');
  const result = [...(events || [])].reverse().find(e => e.type === 'result') || null;
  const tools = (events || []).filter(e => e.type === 'tool_use').map(e => String(e.name || ''));
  const u = usageFromEvents(events);
  const providerOk = !!(result && result.ok !== false);
  const expectedSeen = expected ? text.includes(expected) : null;
  return {
    ok: providerOk && (expected ? expectedSeen : true), providerOk, wallMs, calls: u.calls,
    input: u.input, output: u.output, cached: u.cached,
    cachedRatio: u.input ? u.cached / u.input : 0, cost: costOf(u),
    toolCount: tools.length, toolNames: tools, textChars: text.length,
    expectedSeen,
    error: result && result.error ? String(result.error).slice(0, 160) : null,
  };
}

function makeScenario(name, flags, sourceConfig, provider, workspace) {
  return { name, flags, sourceConfig, provider, workspace };
}

async function launchScenario(scenario) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106-real-' + scenario.name + '-'));
  const port = await getFreePort();
  const cfg = {
    configSchema: 11, version: '1.0.0', permissionMode: 'bypass', allowOutsideWorkspace: true,
    defaultWorkspace: scenario.workspace,
    providers: [scenario.provider], activeProvider: scenario.provider.id,
    toolLoadingMode: 'auto', toolEconomicsShadowV1: true,
    runtimeSummarySingleShotV1: false, runtimeSummaryEntityCheckV1: false,
    ...scenario.flags,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home },
  });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  let healthy = false;
  for (let i = 0; i < 80 && !healthy; i++) { await sleep(250); healthy = await health(port); }
  return {
    home, port, wb, healthy,
    async close() { kill(wb); await sleep(350); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

async function runTurns(scenario, turns) {
  const stack = await launchScenario(scenario);
  const rows = [];
  let sessionId = '';
  try {
    if (!stack.healthy) throw new Error('workbench did not become healthy');
    for (const turn of turns) {
      const response = await postStream(stack.port, { message: turn.message, ...(sessionId ? { sessionId } : {}) });
      const sess = response.events.find(e => e.type === 'session');
      if (!sessionId && sess && sess.session && sess.session.id) sessionId = sess.session.id;
      rows.push(compactTurn(response.events, response.wallMs, turn.expected));
      process.stdout.write(`  ${scenario.name}/${turn.id}: ${rows[rows.length - 1].wallMs}ms, calls=${rows[rows.length - 1].calls}, cached=${rows[rows.length - 1].cached}, tools=${rows[rows.length - 1].toolCount}, ok=${rows[rows.length - 1].ok}\n`);
    }
    await sleep(500);
    const logs = readLogs(stack.home);
    const completions = logs.filter(e => e.kind === 'model_call_completed');
    const starts = logs.filter(e => e.kind === 'model_call_started');
    const shadows = logs.filter(e => e.kind === 'layout_shadow');
    const freezes = logs.filter(e => e.kind === 'tool_schema_freeze');
    const cache = logs.filter(e => e.kind === 'exec_result_cache');
    const totals = logs.filter(e => e.kind === 'econ_call_totals');
    const toolRows = logs.filter(e => e.kind === 'tool_call_completed');
    const phaseRows = logs.filter(e => e.kind === 'tool_phase_completed');
    const usage = rows.reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, cached: a.cached + r.cached, calls: a.calls + r.calls }), { input: 0, output: 0, cached: 0, calls: 0 });
    return {
      name: scenario.name, healthy: true, turns: rows,
      aggregate: { ...usage, cachedRatio: usage.input ? usage.cached / usage.input : 0, cost: costOf(usage), wallMs: rows.reduce((n, r) => n + r.wallMs, 0) },
      modelCalls: completions.map(e => ({ input: Number(e.inputTokens) || 0, output: Number(e.outputTokens) || 0, cached: Number(e.cachedInputTokens) || 0, llmMs: Number(e.llmMs) || 0, state: e.state || '' })),
      schemaFingerprints: starts.map(e => String(e.toolSchemaFingerprint || '')),
      layoutShadow: shadows.map(e => ({ sentLayout: e.sentLayout || '', stablePrefixCharsSent: Number(e.stablePrefixCharsSent) || 0, stablePrefixCharsAlt: Number(e.stablePrefixCharsAlt) || 0, totalCharsSent: Number(e.totalCharsSent) || 0, totalCharsAlt: Number(e.totalCharsAlt) || 0 })),
      schemaFreeze: freezes.map(e => ({ state: e.state || '', added: Array.isArray(e.added) ? e.added.length : 0, missing: Array.isArray(e.missing) ? e.missing.length : 0 })),
      execCache: cache.map(e => ({ outcome: e.outcome || '', reason: e.reason || '', bytes: Number(e.bytes) || 0, lookupMs: Number(e.lookupMs) || 0 })),
      toolMetrics: {
        calls: toolRows.length,
        toolMs: toolRows.reduce((n, e) => n + (Number(e.toolMs) || 0), 0),
        phaseMs: phaseRows.reduce((n, e) => n + (Number(e.toolsMs) || 0), 0),
        statuses: toolRows.map(e => String(e.status || '')),
      },
      econTotals: totals.map(e => ({ modelCallAttempts: Number(e.modelCallAttempts) || 0, toolActions: Number(e.toolActions) || 0 })),
    };
  } catch (error) {
    return { name: scenario.name, healthy: false, error: String(error.message || error), turns: rows };
  } finally {
    await stack.close();
  }
}

function comparePair(a, b, kind) {
  if (!a || !b || !a.aggregate || !b.aggregate) return { kind, comparable: false };
  const delta = (x, y) => (x && Number.isFinite(x) && Number.isFinite(y)) ? (y - x) / x : null;
  const result = {
    kind, comparable: true, baseline: a.name, candidate: b.name,
    baselineOk: a.turns.filter(t => t.ok).length, candidateOk: b.turns.filter(t => t.ok).length,
    baselineCachedRatio: a.aggregate.cachedRatio, candidateCachedRatio: b.aggregate.cachedRatio,
    cachedRatioDeltaPp: (b.aggregate.cachedRatio - a.aggregate.cachedRatio) * 100,
    inputDelta: delta(a.aggregate.input, b.aggregate.input), outputDelta: delta(a.aggregate.output, b.aggregate.output),
    costDelta: delta(a.aggregate.cost, b.aggregate.cost), wallDelta: delta(a.aggregate.wallMs, b.aggregate.wallMs),
  };
  if (kind.startsWith('G1')) {
    const avg = xs => xs.length ? xs.reduce((n, x) => n + (x.totalCharsSent ? x.stablePrefixCharsSent / x.totalCharsSent : 0), 0) / xs.length : null;
    const altAvg = xs => xs.length ? xs.reduce((n, x) => n + (x.totalCharsAlt ? x.stablePrefixCharsAlt / x.totalCharsAlt : 0), 0) / xs.length : null;
    // `layoutShadow` is already filtered to the sent layout in each scenario; keep the
    // first request in the denominator so the comparison reflects the same four calls.
    result.baselineStableShare = avg(a.layoutShadow); result.candidateStableShare = avg(b.layoutShadow);
    result.baselineAltTailShare = altAvg(a.layoutShadow); result.candidateAltFirstShare = altAvg(b.layoutShadow);
    result.stableShareDeltaPp = ((result.candidateStableShare || 0) - (result.baselineStableShare || 0)) * 100;
  }
  if (kind === 'G2') {
    result.baselineFreezeEvents = a.schemaFreeze.length; result.candidateFreezeEvents = b.schemaFreeze.length;
    result.candidateFreezeStates = b.schemaFreeze.map(x => x.state);
    result.baselineFingerprintChanges = new Set(a.schemaFingerprints.filter(Boolean)).size;
    result.candidateFingerprintChanges = new Set(b.schemaFingerprints.filter(Boolean)).size;
  }
  if (kind.startsWith('#2a')) {
    result.baselineCacheOutcomes = a.execCache.map(x => x.outcome);
    result.candidateCacheOutcomes = b.execCache.map(x => x.outcome);
    result.candidateHits = b.execCache.filter(x => x.outcome === 'hit').length;
    result.baselineHits = a.execCache.filter(x => x.outcome === 'hit').length;
    result.baselineToolMs = a.toolMetrics ? a.toolMetrics.toolMs : null;
    result.candidateToolMs = b.toolMetrics ? b.toolMetrics.toolMs : null;
    result.baselinePhaseMs = a.toolMetrics ? a.toolMetrics.phaseMs : null;
    result.candidatePhaseMs = b.toolMetrics ? b.toolMetrics.phaseMs : null;
    result.toolMsDelta = delta(result.baselineToolMs, result.candidateToolMs);
    result.phaseMsDelta = delta(result.baselinePhaseMs, result.candidatePhaseMs);
  }
  return result;
}

(async () => {
  let source;
  try { source = safeReadJson(CONFIG_PATH); } catch (error) { console.error('无法读取本地 provider 配置:', error.message); process.exit(2); }
  const active = (source.providers || []).find(p => p.id === source.activeProvider) || (source.providers || [])[0];
  if (!active || !active.apiKey || !active.baseUrl) { console.error('active provider 缺少 apiKey/baseUrl'); process.exit(2); }
  const model = MODEL_OVERRIDE || active.model || 'deepseek-v4-pro';
  const provider = {
    ...active, id: active.id || 'deepseek', model, apiStyle: active.apiStyle || 'responses', apiKey: active.apiKey,
    models: [{ id: model, label: model }],
  };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106-real-work-'));
  const file = path.join(workspace, 'repeat-marker.txt');
  const marker = `REAL-106-FILE-${RUN_SALT}`;
  fs.writeFileSync(file, `只读验证标记: ${marker}\n`, 'utf8');
  const largeFiles = [];
  const largeMarkers = [];
  const largeBytes = 2 * 1024 * 1024;
  for (let i = 0; i < 4; i++) {
    const p = path.join(workspace, `large-repeat-${i + 1}.txt`);
    const m = `REAL-106-LARGE-${i + 1}-${RUN_SALT}`;
    // 每个文件约 2MB，但只让模型读取首行；这样 cache 命中仍需通过版本校验，
    // 而不会把大正文复制进后续请求体，测到的是本地 read/split 成本而非上下文膨胀。
    const head = `文件${i + 1}验证标记: ${m}\n`;
    const fillerLine = 'x'.repeat(240) + '\n';
    const repeats = Math.ceil((largeBytes - Buffer.byteLength(head)) / Buffer.byteLength(fillerLine));
    fs.writeFileSync(p, head + fillerLine.repeat(repeats), 'utf8');
    largeFiles.push(p); largeMarkers.push(m);
  }
  const turnsG1 = [1, 2, 3, 4].map(n => ({ id: 'r' + n, message: `这是 G1 前缀缓存真实测试第 ${n} 轮(${RUN_SALT})。只回复 G1-OK-${n}-${RUN_SALT}，不要调用任何工具。`, expected: `G1-OK-${n}-${RUN_SALT}` }));
  const turnsG1Large = Array.from({ length: 16 }, (_, n) => {
    const turn = n + 1;
    const stableHistory = Array.from({ length: 100 }, (_, k) => `stable-context-${turn}-${k}-alpha beta gamma delta epsilon`).join('\n');
    return {
      id: 'large-r' + turn,
      message: `这是 G1 扩大规模测试第 ${turn} 轮(${RUN_SALT})。下面是一段需要保留在历史中的稳定上下文，请不要调用工具。\n${stableHistory}\n只回复 G1-LARGE-OK-${turn}-${RUN_SALT}。`,
      expected: `G1-LARGE-OK-${turn}-${RUN_SALT}`,
    };
  });
  const turnsG2 = [
    { id: 'core', message: `这是 G2 第 1 轮(${RUN_SALT})。只回复 G2-CORE-${RUN_SALT}，不要调用工具。`, expected: `G2-CORE-${RUN_SALT}` },
    { id: 'read-a', message: `请用 file_read 读取文件 ${file}，原样回复其中的验证标记。`, expected: marker },
    { id: 'plain', message: `这是 G2 第 3 轮(${RUN_SALT})。只回复 G2-PLAIN-${RUN_SALT}，不要调用工具。`, expected: `G2-PLAIN-${RUN_SALT}` },
    { id: 'read-b', message: `请再次用 file_read 读取文件 ${file}，不要依赖记忆，原样回复验证标记。`, expected: marker },
  ];
  const turnsCache = [1, 2, 3].map(n => ({ id: 'read-' + n, message: `必须第 ${n} 次调用 file_read 读取文件 ${file}，不能直接引用上一轮记忆；只回复文件中的验证标记。`, expected: marker }));
  const turnsLarge = [];
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < largeFiles.length; i++) {
      turnsLarge.push({
        id: `large-${pass + 1}-${i + 1}`,
        message: `必须使用 file_read 读取文件 ${largeFiles[i]}，参数 lineOffset=1、lineLimit=1；不要依赖记忆，只回复第一行中的文件标记。`,
        expected: largeMarkers[i],
      });
    }
  }
  console.log(`106 real provider A/B · ${provider.id}/${model}/${provider.apiStyle} · ${new Date().toISOString()}`);
  console.log(`fixture: 3 baseline scenarios + optional 4×${Math.round(largeBytes / 1024 / 1024)}MB files, salt=${RUN_SALT}, reports omit key and text`);
  const scenarios = [
    makeScenario('G1-off', { runtimeVolatileTailLayoutV1: false }, source, provider, workspace),
    makeScenario('G1-on', { runtimeVolatileTailLayoutV1: true }, source, provider, workspace),
    makeScenario('G1-large-off', { runtimeVolatileTailLayoutV1: false }, source, provider, workspace),
    makeScenario('G1-large-on', { runtimeVolatileTailLayoutV1: true }, source, provider, workspace),
    makeScenario('G2-off', { runtimeAppendOnlyToolSchemasV1: false }, source, provider, workspace),
    makeScenario('G2-on', { runtimeAppendOnlyToolSchemasV1: true }, source, provider, workspace),
    makeScenario('#2a-off', { runtimeExecResultCacheV1: false }, source, provider, workspace),
    makeScenario('#2a-on', { runtimeExecResultCacheV1: true, execResultCacheMaxEntriesV1: 20 }, source, provider, workspace),
    makeScenario('#2a-large-off', { runtimeExecResultCacheV1: false }, source, provider, workspace),
    makeScenario('#2a-large-on', { runtimeExecResultCacheV1: true, execResultCacheMaxEntriesV1: 20 }, source, provider, workspace),
  ];
  const wanted = new Set(String(process.env.RUYI_REAL_SCENARIOS || '').split(',').map(s => s.trim()).filter(Boolean));
  const selected = wanted.size ? scenarios.filter(s => wanted.has(s.name)) : scenarios;
  const all = [];
  try {
    for (const scenario of selected) {
      const turns = scenario.name.startsWith('G1-large') ? turnsG1Large
        : scenario.name.startsWith('G1') ? turnsG1
        : scenario.name.startsWith('G2') ? turnsG2
          : scenario.name.startsWith('#2a-large') ? turnsLarge : turnsCache;
      all.push(await runTurns(scenario, turns));
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  const comparisons = [
    ...(selected.some(s => s.name === 'G1-off') && selected.some(s => s.name === 'G1-on') ? [comparePair(all.find(x => x.name === 'G1-off'), all.find(x => x.name === 'G1-on'), 'G1')] : []),
    ...(selected.some(s => s.name === 'G1-large-off') && selected.some(s => s.name === 'G1-large-on') ? [comparePair(all.find(x => x.name === 'G1-large-off'), all.find(x => x.name === 'G1-large-on'), 'G1-large')] : []),
    ...(selected.some(s => s.name === 'G2-off') && selected.some(s => s.name === 'G2-on') ? [comparePair(all.find(x => x.name === 'G2-off'), all.find(x => x.name === 'G2-on'), 'G2')] : []),
    ...(selected.some(s => s.name === '#2a-off') && selected.some(s => s.name === '#2a-on') ? [comparePair(all.find(x => x.name === '#2a-off'), all.find(x => x.name === '#2a-on'), '#2a')] : []),
    ...(selected.some(s => s.name === '#2a-large-off') && selected.some(s => s.name === '#2a-large-on') ? [comparePair(all.find(x => x.name === '#2a-large-off'), all.find(x => x.name === '#2a-large-on'), '#2a-large')] : []),
  ];
  for (const c of comparisons) console.log(`${c.kind} compare: ${JSON.stringify(c)}`);
  const report = {
    schema: 1, generatedAt: new Date().toISOString(), provider: { id: provider.id, model, apiStyle: provider.apiStyle, baseUrl: provider.baseUrl },
    fixture: { salt: RUN_SALT, scenarios: 3, g1LargeTurns: turnsG1Large.length, g1LargeMessageChars: turnsG1Large[0].message.length, largeFileCount: largeFiles.length, largeFileBytes: largeBytes, note: 'unique per-run marker; text/key omitted' },
    comparisons, scenarios: all,
  };
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); console.log('report written: ' + path.resolve(OUT)); }
  const allOk = all.every(x => x.healthy && x.turns.every(t => t.ok));
  console.log(`106 REAL LIVE: ${allOk ? 'ALL TURNS OK' : 'PARTIAL/FAILED TURNS'} (G1/G2/#2a comparisons are evidence, not automatic flips)`);
  process.exitCode = allOk ? 0 : 1;
})().catch(error => { console.error('FATAL', error && error.stack || error); process.exitCode = 1; });
