'use strict';
// Regression: an in-chat multi-agent tool call must keep its parent turn alive while a child provider is
// actively streaming, while a genuinely silent provider must still be aborted by the idle watchdog.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-parent-heartbeat');
const IDLE_MS = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
const sockets = new Set();
const sse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
function finish(res) { res.write('data: [DONE]\n\n'); res.end(); }
function textFrame(res, text, done) {
  sse(res, { id: 'chatcmpl-heartbeat', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  if (done) { sse(res, { id: 'chatcmpl-heartbeat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); finish(res); }
}
function toolFrame(res, task) {
  sse(res, { id: 'chatcmpl-heartbeat', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_team', type: 'function', function: { name: 'orchestrate_agents', arguments: JSON.stringify({ nodes: [{ id: 'coder', role: 'coder', task, toolTier: 'read' }] }) } }] }, finish_reason: null }] });
  sse(res, { id: 'chatcmpl-heartbeat', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  finish(res);
}
const fake = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch {}
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sys = String((messages.find(m => m && m.role === 'system') || {}).content || '');
    const users = messages.filter(m => m && m.role === 'user').map(m => String(m.content || '')).join('\n');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (sys.includes('你是子任务执行体')) {
      if (users.includes('HANG_NODE')) return; // real silence: both watchdogs must remain effective
      let n = 0;
      const timer = setInterval(() => {
        n++;
        textFrame(res, `chunk-${n} `, n === 9);
        if (n === 9) clearInterval(timer);
      }, 700); // >5s total, crossing the parent's watchdog tick while bytes keep arriving
      // IncomingMessage `close` also fires after a normally consumed request body; only the response lifecycle
      // tells us the streaming client has actually gone away.
      res.on('close', () => clearInterval(timer));
      return;
    }
    const hasToolResult = messages.some(m => m && m.role === 'tool' && m.tool_call_id === 'call_team');
    if (hasToolResult) return textFrame(res, 'parent completed after team result', true);
    return toolFrame(res, users.includes('hang') ? 'HANG_NODE' : 'ACTIVE_STREAM_NODE');
  });
});
fake.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

function get(port, route) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 1000 }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function post(port, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('post timeout')); }); req.write(raw); req.end();
  });
}
function streamChat(body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = '';
    const req = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) try { events.push(JSON.parse(line)); } catch {} } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('chat timeout')); }); req.write(raw); req.end();
  });
}
function kill(proc) { if (proc && proc.pid) try { cp.execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

(async () => {
  const FP = await getFreePort(), WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 8, permissionMode: 'bypass', defaultWorkspace: HOME,
    subagentMaxPerTurn: 8, subagentMaxConcurrent: 2, agentWorkflowMaxNodes: 16,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake',
  }));
  await new Promise(resolve => fake.listen(FP, '127.0.0.1', resolve));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME, WCW_TURN_IDLE_MS: String(IDLE_MS), WCW_AGENT_WORKFLOW_IDLE_MS: String(IDLE_MS) } });
  try {
    let healthy = false; for (let i = 0; i < 50 && !healthy; i++) { await sleep(120); healthy = !!(await get(WP, '/health')); }
    ok(healthy, 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const created = await post(WP, '/api/sessions', { title: 'parent heartbeat', cwd: HOME }, { 'x-wcw-token': token });
    const sid = created && created.session && created.session.id;

    const t0 = Date.now();
    const activeEvents = await streamChat({ sessionId: sid, message: 'run active team', cwd: HOME, agentTeam: true });
    const elapsed = Date.now() - t0;
    ok(elapsed >= 6000, 'active child stream crosses the parent watchdog window');
    ok(activeEvents.filter(e => e.type === 'subagent_progress' && e.note === '模型流式响应中').length >= 3, 'child stream emits throttled parent-visible activity');
    ok(!activeEvents.some(e => e.type === 'stderr' && /turn idle/.test(e.text || '')), 'active multi-agent turn is not falsely idle-aborted');
    ok(activeEvents.some(e => e.type === 'agent_workflow' && e.state === 'end' && e.status === 'succeeded'), 'workflow succeeds after the long active stream');
    ok(activeEvents.some(e => e.type === 'result' && e.ok === true), 'parent turn completes successfully');

    const hungSession = await post(WP, '/api/sessions', { title: 'silent provider', cwd: HOME }, { 'x-wcw-token': token });
    const hungEvents = await streamChat({ sessionId: hungSession.session.id, message: 'hang team', cwd: HOME, agentTeam: true });
    ok(hungEvents.some(e => e.type === 'stderr' && /idle/.test(e.text || '')), 'genuinely silent child is still stopped by an idle watchdog');
    ok(hungEvents.some(e => e.type === 'result' && e.ok === false), 'silent turn ends as a failure instead of hanging forever');
  } finally {
    kill(wb); for (const s of sockets) s.destroy(); await new Promise(resolve => fake.close(resolve));
  }
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
