'use strict';
/*
 * Long-running workflow control regression:
 *   A) a Provider node receives the automatic wrap-up steer at its next iteration boundary and succeeds;
 *   B) a Provider node that ignores the steer is aborted after the grace period, while its sibling succeeds;
 *   C) a Claude workflow node receives the same automatic steer live through stream-json stdin.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-node-wrapup');
const CLAUDE_CAPTURE = path.join(HOME, 'claude-wrapup.jsonl');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const ok = (value, label) => value ? console.log('PASS ' + label) : (failures++, console.error('FAIL ' + label));
const sockets = new Set();
const capturedBodies = [];

function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function finish(res) { res.write('data: [DONE]\n\n'); res.end(); }
function emitText(res, text) {
  sse(res, { id: 'wrapup', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  sse(res, { id: 'wrapup', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  finish(res);
}
function emitTool(res) {
  sse(res, { id: 'wrapup', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: path.join(HOME, 'probe.txt') }) } }] }, finish_reason: null }] });
  sse(res, { id: 'wrapup', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  finish(res);
}
function messageText(messages) { return JSON.stringify(messages || []); }
function isSubRequest(messages) {
  const sys = String(((messages || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体');
}
function createFakeProvider() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
    }
    if (req.method !== 'POST' || !req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw); } catch {}
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const text = messageText(messages);
      capturedBodies.push(text);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (!isSubRequest(messages)) return emitText(res, 'parent');
      if (text.includes('WRAP_IGNORE')) {
        let n = 0;
        const timer = setInterval(() => {
          n += 1;
          sse(res, { id: 'wrapup', choices: [{ index: 0, delta: { content: '.' }, finish_reason: null }] });
        }, 100);
        res.on('close', () => clearInterval(timer));
        return;
      }
      if (text.includes('WRAP_COOPERATE')) {
        if (text.includes('[编排者插话]') && text.includes('停止扩展范围')) return emitText(res, 'cooperative wrap-up complete');
        return setTimeout(() => emitTool(res), 700);
      }
      return emitText(res, 'fast sibling complete');
    });
  });
}
function get(port, route, headers = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 1500, headers }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function post(port, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
async function waitFor(fn, tries = 100, gap = 100) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await sleep(gap); }
  return null;
}
function findRun(payload, runId) { return payload && Array.isArray(payload.runs) && payload.runs.find(run => run.id === runId); }
function isTerminal(status) { return ['succeeded', 'failed', 'partial', 'stopped', 'cancelled'].includes(status); }
function kill(proc) { if (proc && proc.pid) try { cp.execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

(async () => {
  const FP = await getFreePort(), WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'probe.txt'), 'probe', 'utf8');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', defaultWorkspace: HOME,
    agentNodeWrapUpMs: 60000, subagentMaxConcurrent: 2, agentWorkflowMaxNodes: 16,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));
  const fake = createFakeProvider();
  fake.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => fake.listen(FP, '127.0.0.1', resolve));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true,
    env: {
      ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE,
      WCW_FAKE_SCENARIO: 'steer', WCW_FAKE_SLOW_MS: '600', WCW_FAKE_STEER_CAPTURE: CLAUDE_CAPTURE,
      WCW_AGENT_NODE_WRAPUP_MS: '300', WCW_AGENT_NODE_WRAPUP_GRACE_MS: '4000',
      WCW_AGENT_WORKFLOW_HEARTBEAT_MS: '100', WCW_AGENT_WORKFLOW_IDLE_MS: '5000',
    },
  });
  try {
    ok(!!(await waitFor(() => get(WP, '/health'), 60, 120)), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve(body)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const headers = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'wrap-up', cwd: HOME }, headers);
    const sessionId = created.session.id;
    const launch = nodes => post(WP, '/api/agent-workflow/launch', { token, sessionId, async: true, nodes }, headers);
    const terminalRun = runId => waitFor(async () => {
      const run = findRun(await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sessionId)}`, headers), runId);
      return run && !run.live && isTerminal(run.status) ? run : null;
    }, 120, 100);

    const cooperative = await launch([{ id: 'cooperate', task: 'WRAP_COOPERATE: do a deliberately long probe', toolTier: 'read' }]);
    const cooperativeRun = await terminalRun(cooperative.runId);
    const cooperativeNode = cooperativeRun && cooperativeRun.nodes.find(node => node.id === 'cooperate');
    ok(cooperativeRun && cooperativeRun.status === 'succeeded', 'Provider node cooperates with automatic wrap-up and succeeds');
    ok(cooperativeNode && cooperativeNode.wrapUpRequestedAt && !cooperativeNode.wrapUpForcedAt, 'Provider node records the soft wrap-up without forced termination');
    ok(capturedBodies.some(text => text.includes('WRAP_COOPERATE') && text.includes('[编排者插话]') && text.includes('停止扩展范围')), 'Provider receives the automatic wrap-up at its next iteration boundary');
    ok(cooperativeNode && (cooperativeNode.progressLog || []).some(item => /自动收尾指令/.test(item.text || '')), 'Provider node persists an automatic wrap-up milestone');

    const stubborn = await launch([
      { id: 'ignore', task: 'WRAP_IGNORE: stream forever and ignore control', toolTier: 'read', failurePolicy: 'continue' },
      { id: 'sibling', task: 'FAST_SIBLING: finish normally', toolTier: 'read' },
    ]);
    const stubbornRun = await terminalRun(stubborn.runId);
    const ignored = stubbornRun && stubbornRun.nodes.find(node => node.id === 'ignore');
    const sibling = stubbornRun && stubbornRun.nodes.find(node => node.id === 'sibling');
    ok(stubbornRun && stubbornRun.status === 'partial', 'an uncooperative node settles the workflow as partial instead of hanging');
    ok(ignored && ignored.status === 'failed' && ignored.wrapUpForcedAt, 'uncooperative Provider node is stopped after the wrap-up grace period');
    ok(ignored && /自动收尾宽限期/.test(ignored.error || ''), 'forced node failure explains the wrap-up deadline');
    ok(sibling && sibling.status === 'succeeded', 'forced wrap-up is node-local and does not cancel a sibling');

    const claude = await launch([{ id: 'claude_live', task: 'CLAUDE_WRAP: analyze a deliberately long item', engine: 'claude', toolTier: 'read' }]);
    const claudeRun = await terminalRun(claude.runId);
    const claudeNode = claudeRun && claudeRun.nodes.find(node => node.id === 'claude_live');
    if (!claudeRun || claudeRun.status !== 'succeeded') console.log('  Claude diagnostic:', JSON.stringify(claudeRun || null));
    ok(claudeRun && claudeRun.status === 'succeeded', 'Claude workflow node cooperates with automatic wrap-up and succeeds');
    ok(claudeNode && String(claudeNode.result || '').includes('停止扩展范围'), 'Claude result proves the live wrap-up envelope reached the running node');
    ok(claudeNode && claudeNode.wrapUpRequestedAt && !claudeNode.wrapUpForcedAt, 'Claude node records soft wrap-up without forced termination');
    let claudeCapture = ''; try { claudeCapture = fs.readFileSync(CLAUDE_CAPTURE, 'utf8'); } catch {}
    ok(claudeCapture.includes('[编排者插话]') && claudeCapture.includes('停止扩展范围'), 'Claude stdin capture contains the orchestrator wrap-up envelope');
  } finally {
    kill(wb);
    for (const socket of sockets) { try { socket.destroy(); } catch {} }
    await new Promise(resolve => fake.close(resolve));
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT NODE WRAP-UP E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 2; });
