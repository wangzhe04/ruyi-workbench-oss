require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// Background agent regression (代理模式 v2:spawn_agent 已并入 orchestrate_agents,单代理写顶层简写):
//  1) orchestrate_agents{task, background:true} returns a {runId, status:'running'} receipt before the child finishes;
//  2) the parent executes an independent todo_write while the child is still live;
//  3) wait_agents collects the DELIVERY ENVELOPE (bounded node summary, not the raw node result); and
//  4) the same ad-hoc launch is persisted in /api/agent-runs for the Workbench DAG with background:true.
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
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
function killp(child) { if (!child || !child.pid) return; try { killOwnTree(child); } catch {} }
function health() { return new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/health', timeout: 800 }, res => { let body = ''; res.on('data', c => (body += c)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); }); }
function token() { return new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 5000 }, res => { let body = ''; res.on('data', c => (body += c)); res.on('end', () => resolve((body.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '')); }); req.on('error', () => resolve('')); }); } // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
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
      { name: 'orchestrate_agents', args: { task: '慢速后台分析', agentKey: 'background-research', toolTier: 'read', background: true } },
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
  const created = await jsonRequest('POST', '/api/sessions', { title: 'background agent DAG', cwd: HOME }, auth);
  const sid = created && created.session && created.session.id;
  ok(!!sid, 'session created');
  const events = await streamChat({ sessionId: sid, message: '后台派一个慢任务，我先继续处理主线再汇总', cwd: HOME });
  const receiptAt = events.findIndex(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.background === true);
  const receipt = events[receiptAt];
  const childStartAt = events.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'background-research');
  const parentWorkAt = events.findIndex(e => e.type === 'tool_result' && !e.subagentId && e.id === 'call_2');
  const childEndAt = events.findIndex(e => e.type === 'subagent' && e.state === 'end' && e.agentKey === 'background-research');
  const waitResult = events.find(e => e.type === 'tool_result' && !e.subagentId && e.id === 'call_3');
  ok(receiptAt >= 0 && receipt.content.accepted === true && receipt.content.status === 'running' && /^run_/.test(receipt.content.runId || ''), 'background orchestrate_agents returns an immediate {runId, status:running} receipt');
  ok(childStartAt >= 0 && parentWorkAt > childStartAt && childEndAt > parentWorkAt, 'parent performs independent work while the child is still running');
  ok(events[childStartAt] && events[childStartAt].background === true, 'background run events are tagged background:true (own card / not the parent activity bar)');
  const waitRuns = (waitResult && waitResult.content && waitResult.content.runs) || [];
  ok(waitResult && waitResult.content && waitResult.content.settled === true && waitRuns.length === 1 && waitRuns[0].kind === 'agent_envelope' && waitRuns[0].status === 'succeeded', 'wait_agents collects the delivery envelope (settled, succeeded)');
  const node0 = waitRuns[0] && waitRuns[0].nodes && waitRuns[0].nodes[0];
  ok(node0 && node0.nodeId === 'background-research' && /后台子任务最终结论/.test(node0.summary || '') && node0.summary.length <= 1501 && !('result' in node0) && !('toolEvidence' in node0), 'envelope node carries a bounded summary, no raw result/toolEvidence');
  ok(waitRuns[0] && waitRuns[0].usage && typeof waitRuns[0].usage.durationMs === 'number' && /agent_result/.test(waitRuns[0].more || ''), 'envelope carries usage + the agent_result pointer');
  const listed = await jsonRequest('GET', `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, null, auth);
  const persisted = (listed.runs || []).find(run => run.id === (receipt && receipt.content && receipt.content.runId));
  ok(persisted && persisted.kind === 'orchestrate_agents' && persisted.background === true && persisted.nodes.some(node => node.id === 'background-research') && persisted.status === 'succeeded', 'the ad-hoc background launch is persisted (kind orchestrate_agents, background:true) and visible to the Workbench DAG');
  const result = events.find(e => e.type === 'result');
  ok(result && result.ok === true, 'parent turn completes after collection');
  // 只投递一次:wait_agents 已取走终态信封 → 账本里的完成回执被登记为已读,下一回合不再注入。
  const sess = await jsonRequest('GET', `/api/sessions/${encodeURIComponent(sid)}`, null, auth);
  const receiptRows = ((sess.session && sess.session.messages) || []).filter(m => m && m.backgroundJobId === 'agent:' + receipt.content.runId);
  ok(receiptRows.length === 1, 'exactly one hidden agent receipt row lands in the session data plane');
  ok(Array.isArray(sess.session.backgroundJobSeen) && sess.session.backgroundJobSeen.includes('agent:' + receipt.content.runId), 'envelope collected by wait_agents is marked delivered (no second injection later)');
} catch (e) { fail++; console.log('ERROR ' + (e && e.stack || e)); }
finally { killp(wb); killp(fake); await sleep(250); fs.rmSync(HOME, { recursive: true, force: true }); }
console.log('\nSPAWN BACKGROUND DAG E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
