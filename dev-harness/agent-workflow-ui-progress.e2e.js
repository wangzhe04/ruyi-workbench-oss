'use strict';
/*
 * Covers the right-side Agent workflow UX contract:
 * - UI launches use async:true and return immediately.
 * - Polling /api/agent-runs exposes live node progressLog entries.
 * - Finished runs persist a readable summary.
 * - Direct UI-launched workflows append a summary message to the parent session.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-workflow-ui-progress');
const FP = 9093;
const WP = 9094;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
async function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  await sleep(60);
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
async function emitTool(res, id, callId) {
  const args = JSON.stringify({ path: path.join(HOME, 'evidence.txt') });
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'file_read', arguments: args } }] }, finish_reason: null }] });
  await sleep(120);
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function isSubRequest(msgs) {
  const sys = String(((msgs || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体') || sys.includes('瀛愪换鍔℃墽琛屼綋');
}
const finalJson = JSON.stringify({ verdict: 'pass', confidence: 0.88, summary: 'UI progress workflow completed', findings: [] });
let toolRequests = 0;
const fake = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasToolResult = msgs.some(m => m && m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (isSubRequest(msgs) && !hasToolResult) { toolRequests++; return emitTool(res, 'chatcmpl-ui-progress', 'call_ui_progress'); }
      return emitText(res, 'chatcmpl-ui-progress', isSubRequest(msgs) ? finalJson : 'workflow accepted');
    });
    return;
  }
  res.writeHead(404); res.end();
});

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1200, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.write(raw); r.end();
  });
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
async function waitFor(label, fn) {
  for (let i = 0; i < 80; i++) { const v = await fn(); if (v) return v; await sleep(100); }
  ok(false, label); return null;
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'evidence.txt'), 'ui progress evidence');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));
  await new Promise(r => fake.listen(FP, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'ui-progress', cwd: HOME }, hdr);
    const sid = created.session.id;
    const schema = { type: 'object', required: ['verdict', 'confidence', 'summary', 'findings'], properties: { verdict: { type: 'string' }, confidence: { type: 'number' }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } };
    const launched = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, async: true, nodes: [{ id: 'verify', task: 'verify with progress', role: 'verifier', outputSchema: schema }] }, hdr);
    ok(launched.ok === true && launched.accepted === true && /^run_/.test(launched.runId || ''), 'async workflow launch returns immediately with a run id');

    const liveRun = await waitFor('live progress appears in agent-runs', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = r && Array.isArray(r.runs) && r.runs.find(x => x.id === launched.runId);
      const node = run && run.nodes && run.nodes[0];
      return node && Array.isArray(node.progressLog) && node.progressLog.some(x => /调用工具|子 Agent 启动/.test(x.text || '')) && run;
    });
    ok(!!liveRun, 'agent-runs exposes live node progressLog entries');

    const doneRun = await waitFor('workflow finishes with persisted summary', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = r && Array.isArray(r.runs) && r.runs.find(x => x.id === launched.runId);
      return run && run.status === 'succeeded' && run.summary && run.nodes && run.nodes[0] && run.nodes[0].result && run;
    });
    ok(!!doneRun && /UI progress workflow completed/.test(doneRun.summary), 'finished run persists readable summary and node result');
    const session = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', `${sid}.json`), 'utf8'));
    ok(session.messages.some(m => m && m.source === 'agent_workflow' && /UI progress workflow completed/.test(m.content || '')), 'workflow completion appends an assistant summary message to the session');
    ok(toolRequests >= 1, 'fake provider actually exercised sub-agent tool progress');
  } finally {
    kill(wb); fake.close(); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT WORKFLOW UI PROGRESS E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
