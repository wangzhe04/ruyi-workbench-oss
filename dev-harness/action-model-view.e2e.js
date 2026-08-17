// E2E: 21-E3 action-argument model view. Drives a REAL workbench turn against the offline fake provider:
//   file_write with a 5000-char content → NEXT request body must carry the compact envelope (not the raw
//   payload), while the persisted provider history keeps the ORIGINAL arguments (zero evidence loss).
//   Switch off → the request body keeps the raw payload byte-for-byte (zero behavior change).
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

async function runCase(modelViewOn) {
  const HOME = path.join(os.tmpdir(), `ruyi-e3-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const [fakePort, wbPort] = await getFreePorts(2);
  const target = path.join(HOME, 'report.md');
  const BIG = 'P'.repeat(5000);
  const sequence = [
    { name: 'file_write', args: { path: target, content: BIG } },
  ];
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 10, version: '2.5.0', permissionMode: 'bypass', toolLoadingMode: 'full',
    runtimeOptimizationShadowV1: true, runtimeToolRetrievalV1: false, runtimeFailureTelemetryV1: false,
    actionArgumentModelViewV1: modelViewOn,
    defaultWorkspace: HOME, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [], bridgeExternalToolsToProvider: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  const captureDir = path.join(HOME, 'capture'); fs.mkdirSync(captureDir, { recursive: true });
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_TOOL_SEQUENCE: JSON.stringify(sequence), FAKE_CAPTURE_DIR: captureDir }, windowsHide: true });
  const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  let live = null; for (let i = 0; i < 50 && !live; i++) { await sleep(120); live = await health(wbPort); }
  await postStream(wbPort, { message: 'Write the report file then reply.' });
  await sleep(500);
  const requests = fs.readdirSync(captureDir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(captureDir, f), 'utf8')));
  // provider history 原文(证据零损失)
  const provFile = fs.readdirSync(path.join(HOME, 'sessions')).find(f => /\.provider\.ndjson$/.test(f));
  const provHistory = provFile ? fs.readFileSync(path.join(HOME, 'sessions', provFile), 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  killTree(fake); killTree(wb); await sleep(150);
  fs.rmSync(HOME, { recursive: true, force: true });
  return { requests, provHistory, BIG };
}

(async () => {
  let fail = 0;
  const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
  try {
    const on = await runCase(true);
    ok(on.requests.length >= 2, 'E3-on: at least two provider calls (tool + follow-up)');
    // 第二个及以后请求:file_write arguments 应为 envelope
    const followUps = on.requests.slice(1);
    ok(followUps.length > 0 && followUps.every(r => !JSON.stringify(r).includes('P'.repeat(200))), 'E3-on: raw 5000-char payload absent from ALL follow-up request bodies');
    const envelopeFound = followUps.some(r => {
      const s = JSON.stringify(r);
      // envelope 以 JSON 字符串形式嵌在 arguments 里 → 字段带反斜杠转义,匹配 _ruyiActionRef 即可
      return s.includes('_ruyiActionRef') && s.includes('action-v1') && s.includes('payload');
    });
    ok(envelopeFound, 'E3-on: follow-up request carries the compact action envelope');
    // 只量 arguments 本身(非整个请求体,那含 tool schema)
    const argLens = [];
    for (const r of followUps) {
      const msgs = r.messages || [];
      for (const m of msgs) if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) argLens.push(Buffer.byteLength(String((tc.function && tc.function.arguments) || ''), 'utf8'));
    }
    ok(argLens.length > 0 && argLens.every(l => l < 600), `E3-on: projected arguments stay compact (${argLens.join('/')}B vs 5090 raw)`);
    // 证据零损失:providerHistory 原消息仍含完整 rawArgs
    const origAssistant = on.provHistory.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
    ok(origAssistant && JSON.stringify(origAssistant.tool_calls).includes('P'.repeat(200)), 'E3-on: persisted provider history KEEPS the full original arguments (audit view intact)');

    const off = await runCase(false);
    ok(off.requests.length >= 2, 'E3-off: two provider calls');
    const offFollow = off.requests.slice(1);
    ok(offFollow.every(r => JSON.stringify(r).includes('P'.repeat(200))), 'E3-off: raw payload stays in follow-up requests (legacy behavior unchanged)');
    ok(offFollow.every(r => !JSON.stringify(r).includes('_ruyiActionRef')), 'E3-off: no envelope anywhere (switch fully inert)');
  } catch (e) {
    fail++; console.log('ERROR ' + (e && e.stack || e));
  }
  console.log(`\nACTION-MODEL-VIEW E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
})();
