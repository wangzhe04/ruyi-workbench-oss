// E2E: 21-E2a bounded read worker pool. Drives a REAL workbench turn against the offline fake provider.
//  - switch ON + 12 pure reads  -> strategy=pool_read, maxConcurrency=8, pairing closed
//  - switch OFF + 12 pure reads -> strategy=serial (>8 falls back to serial, legacy behavior)
//  - mixed read+edit+read       -> strategy=serial (islands are E2b; E2a must not touch mixed batches)
'use strict';
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePorts } = require('./free-port');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
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
          if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } }
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
function readLogs(home) {
  return fs.readdirSync(path.join(home, 'logs')).filter(f => /^workbench-.*\.ndjson$/.test(f))
    .flatMap(f => fs.readFileSync(path.join(home, 'logs', f), 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })).filter(Boolean);
}

async function runCase(label, { schedulerOn, mixed }) {
  const HOME = path.join(os.tmpdir(), `ruyi-pool-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const [fakePort, wbPort] = await getFreePorts(2);
  const n = 12;
  const files = Array.from({ length: n }, (_, i) => path.join(HOME, `f${i}.txt`));
  files.forEach((f, i) => fs.writeFileSync(f, `DATA_${i}`));
  const parallel = mixed
    ? [
        { name: 'file_read', args: { path: files[0] } },
        { name: 'file_edit', args: { path: files[1], oldText: 'DATA_1', newText: 'EDITED_1' } },
        { name: 'file_read', args: { path: files[2] } },
      ]
    : files.map(f => ({ name: 'file_read', args: { path: f } }));
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 10, version: '2.5.0', permissionMode: 'bypass', toolLoadingMode: 'full',
    runtimeOptimizationShadowV1: true, runtimeToolRetrievalV1: false, runtimeFailureTelemetryV1: false,
    boundedReadSchedulerV1: schedulerOn, boundedReadConcurrencyV1: 4,
    defaultWorkspace: HOME, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [], bridgeExternalToolsToProvider: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_PARALLEL_TOOLS: JSON.stringify(parallel) }, windowsHide: true });
  const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  let live = null; for (let i = 0; i < 50 && !live; i++) { await sleep(120); live = await health(wbPort); }
  await postStream(wbPort, { message: 'Do the requested reads and reply.' });
  await sleep(400);
  const rows = readLogs(HOME);
  const phases = rows.filter(r => r.kind === 'tool_phase_completed');
  const tools = rows.filter(r => r.kind === 'tool_call_completed');
  const started = rows.filter(r => r.kind === 'model_call_started');
  const completed = rows.filter(r => r.kind === 'model_call_completed');
  killTree(fake); killTree(wb); await sleep(150);
  fs.rmSync(HOME, { recursive: true, force: true });
  return { phases, tools, started, completed, n, mixed };
}

(async () => {
  let fail = 0;
  const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
  try {
    const on = await runCase('pool-on', { schedulerOn: true, mixed: false });
    ok(on.started.length >= 2 && on.completed.length >= 2, 'pool-on: turn completed (model calls paired)');
    ok(on.tools.length === on.n && on.tools.every(t => t.status === 'completed'), 'pool-on: all 12 read calls executed and completed');
    const phase = on.phases.find(p => p.strategy === 'pool_read');
    ok(!!phase, 'pool-on: tool_phase strategy=pool_read present');
    ok(phase && phase.maxConcurrency === 8, 'pool-on: maxConcurrency capped at 8 (min(8,max(4,12)))');
    ok(phase && phase.criticalPathMs >= 0 && phase.criticalPathMs <= phase.serialEstimateMs && phase.queueWaitMs >= 0, 'pool-on: criticalPath<=serialEstimate and queueWaitMs present');
    ok(!on.phases.some(p => p.strategy === 'serial'), 'pool-on: no serial phase for the pure-read batch');
    const startedIds = new Set(on.started.map(r => r.modelCallId));
    ok(on.completed.every(r => startedIds.has(r.modelCallId)), 'pool-on: model-call pairing closed');
    ok(on.tools.every(t => t.assistantBatchId === on.phases[0].assistantBatchId), 'pool-on: all tool calls share the batch id');

    const off = await runCase('pool-off', { schedulerOn: false, mixed: false });
    ok(off.tools.length === off.n, 'pool-off: all 12 read calls executed (serial)');
    ok(off.phases.every(p => p.strategy === 'serial'), 'pool-off: >8 pure read falls back to serial (legacy behavior)');
    const offStarted = new Set(off.started.map(r => r.modelCallId));
    ok(off.completed.every(r => offStarted.has(r.modelCallId)), 'pool-off: model-call pairing closed');

    const mixed = await runCase('mixed', { schedulerOn: true, mixed: true });
    ok(mixed.tools.length === 3 && mixed.tools.every(t => t.status === 'completed'), 'mixed: read+edit+read all executed');
    ok(mixed.phases.every(p => p.strategy === 'serial'), 'mixed: E2a leaves mixed batches serial (islands are E2b)');
    ok(mixed.tools.every(t => t.assistantBatchId === (mixed.phases[0] && mixed.phases[0].assistantBatchId)), 'mixed: batch id consistent');
  } catch (e) {
    fail++; console.log('ERROR ' + (e && e.stack || e));
  }
  console.log(`\nREAD-POOL E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
})();
