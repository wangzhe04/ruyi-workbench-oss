(async () => {
'use strict';
// Background spawn regression:
//  1) spawn_agent{background:true} returns before the child finishes;
//  2) the parent executes an independent todo_write while the child is still live;
//  3) wait_agents collects the result; and
//  4) the same ad-hoc spawn is persisted in /api/agent-runs for the Workbench DAG.
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-spawn-background-dag');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killp(child) { if (!child || !child.pid) return; try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function health() { return new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/health', timeout: 800 }, res => { let body = ''; res.on('data', c => (body += c)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); }); }
function token() { return new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 1500 }, res => { let body = ''; res.on('data', c => (body += c)); res.on('end', () => resolve((body.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '')); }); req.on('error', () => resolve('')); }); }
function jsonRequest(method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: route, method, timeout: 10000, headers: { ...(headers || {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => { let raw = ''; res.on('data', c => (raw += c)); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad json: ' + raw)); } }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); }); if (data) req.write(data); req.end();
  });
}
function streamChat(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', chunk => { buf += chunk; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) try { events.push(JSON.parse(line)); } catch {} } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
let fake = null, wb = null;
try {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, version: '2.4.1', permissionMode: 'bypass', toolLoadingMode: 'full',
    defaultWorkspace: HOME, subagentMaxPerTurn: 4, subagentMaxConcurrent: 2, agentWorkflowMaxNodes: 48,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FAKE_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }], activeProvider: 'fake',
  }, null, 2));
  const script = JSON.stringify({
    parent: [
      { name: 'spawn_agent', args: { task: '慢速后台分析', agentKey: 'background-research', toolTier: 'read', background: true } },
      { name: 'todo_write', args: { items: [{ id: 'parent-work', text: '父会话独立推进', status: 'completed' }] } },
      { name: 'wait_agents', args: { timeoutMs: 10000 } },
    ],
    sub: [], subText: '后台子任务最终结论：' + '证据已核验。'.repeat(30), parentText: '父会话已汇总后台结果。',
  });
  fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_SUBAGENT_SCRIPT: script, FAKE_STREAM_DELAY_MS: '70' }, windowsHide: true });
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).trim() && console.log('[wb!] ' + String(d).trim()));
  let up = null; for (let i = 0; i < 80 && !up; i++) { await sleep(150); up = await health(); }
  ok(!!up, 'workbench starts');
  const auth = { 'x-wcw-token': await token() };
  const created = await jsonRequest('POST', '/api/sessions', { title: 'background spawn DAG', cwd: HOME }, auth);
  const sid = created && created.session && created.session.id;
  ok(!!sid, 'session created');
  const events = await streamChat({ sessionId: sid, message: '后台派一个慢任务，我先继续处理主线再汇总', cwd: HOME });
  const receiptAt = events.findIndex(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.background === true);
  const receipt = events[receiptAt];
  const childStartAt = events.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'background-research');
  const parentWorkAt = events.findIndex(e => e.type === 'tool_result' && !e.subagentId && e.id === 'call_2');
  const childEndAt = events.findIndex(e => e.type === 'subagent' && e.state === 'end' && e.agentKey === 'background-research');
  const waitResult = events.find(e => e.type === 'tool_result' && !e.subagentId && e.id === 'call_3');
  ok(receiptAt >= 0 && receipt.content.accepted === true && /^run_/.test(receipt.content.runId || ''), 'background spawn returns an immediate run receipt');
  ok(childStartAt >= 0 && parentWorkAt > childStartAt && childEndAt > parentWorkAt, 'parent performs independent work while the child is still running');
  ok(waitResult && waitResult.content && waitResult.content.settled === true && (waitResult.content.runs || []).some(run => (run.nodes || []).some(node => /后台子任务最终结论/.test(node.result || ''))), 'wait_agents collects the persisted child result');
  const listed = await jsonRequest('GET', `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, null, auth);
  const persisted = (listed.runs || []).find(run => run.id === (receipt && receipt.content && receipt.content.runId));
  ok(persisted && persisted.kind === 'spawn_agent' && persisted.nodes.some(node => node.id === 'background-research') && persisted.status === 'succeeded', 'spawn_agent is persisted and visible to the Workbench DAG');
  const result = events.find(e => e.type === 'result');
  ok(result && result.ok === true, 'parent turn completes after collection');
} catch (e) { fail++; console.log('ERROR ' + (e && e.stack || e)); }
finally { killp(wb); killp(fake); await sleep(250); fs.rmSync(HOME, { recursive: true, force: true }); }
console.log('\nSPAWN BACKGROUND DAG E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
