require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E:代理模式 v2(2026-09-24)—— 单一入口 orchestrate_agents + 交付信封隔离 + 后台解耦与一次投递 + agent_result 取全文
// + MCP 面同一套工具。provider 引擎,离线 via fake-openai(FAKE_SUBAGENT_SCRIPT.parentByMessage 按人类消息选父剧本,
// '$RUN_ID' 由 fake 用最近一条回执里的 runId 代入)。
//
//  A  背景启动:orchestrate_agents{task, toolTier:'exec', background:true} → 立即回执 {runId,status:'running'};父回合正常结束;
//     run 仍活着(digest live);后台任务条 GET /api/sessions/:id/background 列出 kind:'agent' 的这一行。
//  B  主会话继续:代理仍在跑时再发一条 → 新回合正常完成;这一请求里【没有】代理完成通知。
//  C  一次投递:run 完成 → 账本 agent:<runId> 一条;会话数据面隐藏回执恰好一行;下一回合(C)的请求 messages 里
//     「[代理完成通知」恰好出现一次、含 runId、且长度远小于节点 50k 字全文(信封上限)。
//  D  agent_result({runId:'$RUN_ID', maxChars:5000}) → 有界切片(text 5000 / totalChars ≥ 50000 / truncated / nextOffset)。
//  E  同步调用:tool_result 与持久化消息 toolCalls 里都是信封(nodes[].summary ≤1501、无 result 全文)。
//  F  一次投递的两种先后顺序(wave137 集成期竞态,用 fake 控时序):F1 节点慢 3s → wait 先取走 → 之后零通知;
//     F2 节点瞬时、父回合先 powershell 睡 2s 再 wait → 迭代边界已注入完成通知 → wait 只回短回执(agent_envelope_receipt);
//     F3 后续回合:F1 的 run 零通知、F2 的 run 恰好一条、无重复通知;账本每 run 恰好一份。
//  G  后台任务条停止:长跑后台 run → POST /background/stop {id:'run:<runId>'} → 状态 stopped,失败/停止信封照投递。
//  H  子代理事件层:子代理的 tool_use/tool_result 带 subagentId;活回合的 liveTail.tools 不含子代理工具(父实时工具列表零泄漏)。
//  I  MCP 面:tools/list 无 spawn_agent、有 orchestrate_agents/wait_agents/agent_result;tools/call agent_result 经回环取到全文;
//     tools/call spawn_agent 被翻译成单节点 orchestrate 并附「已并入」提示。
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-agent-mode-v2');
const CAP = path.join(HOME, 'cap');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function killp(child) { if (!child || !child.pid) return; try { killOwnTree(child); } catch {} }
function health() { return new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/health', timeout: 800 }, res => { let body = ''; res.on('data', c => (body += c)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } }); }); req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); }); }
function token() { return new Promise(resolve => { const req = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 5000 }, res => { let body = ''; res.on('data', c => (body += c)); res.on('end', () => resolve((body.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '')); }); req.on('error', () => resolve('')); }); }
function jsonRequest(method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: route, method, timeout: 20000, headers: { ...(headers || {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, res => { let raw = ''; res.on('data', c => (raw += c)); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad json: ' + raw)); } }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); }); if (data) req.write(data); req.end();
  });
}
function streamChat(payload, onEvent) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', timeout: 60000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', chunk => { buf += chunk; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { let evt = null; try { evt = JSON.parse(line); } catch {} if (evt) { events.push(evt); if (onEvent) { try { onEvent(evt); } catch {} } } } } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function fakeUp(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 800 }, resp => { resp.resume(); res(true); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); }); }
function capturedBodies() {
  try { return fs.readdirSync(CAP).filter(f => /^req-\d+\.json$/.test(f)).sort().map(f => JSON.parse(fs.readFileSync(path.join(CAP, f), 'utf8'))); } catch { return []; }
}
const msgText = m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
// 父请求 = system 不含子代理身份标记;最后一条人类 user 含 needle。
function lastParentRequestFor(needle) {
  const bodies = capturedBodies().filter(b => !(b.messages || []).some(m => m && m.role === 'system' && /子任务执行体/.test(msgText(m))));
  for (let i = bodies.length - 1; i >= 0; i--) if ((bodies[i].messages || []).some(m => m && m.role === 'user' && msgText(m).includes(needle))) return bodies[i];
  return null;
}
async function waitRun(sid, runId, auth, pred, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    const r = await jsonRequest('GET', `/api/agent-runs/${encodeURIComponent(runId)}?sessionId=${encodeURIComponent(sid)}`, null, auth).catch(() => null);
    last = r && r.run;
    if (last && pred(last)) return last;
    await sleep(200);
  }
  return last;
}

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
let fake = null, wb = null, mcp = null;
const BIG = '结论:' + 'ZQ'.repeat(25000); // 50,004 字的节点全文
try {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true }); fs.mkdirSync(CAP, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, version: '3.0.0', permissionMode: 'bypass', toolLoadingMode: 'full',
    defaultWorkspace: HOME, subagentMaxPerTurn: 8, subagentMaxConcurrent: 2, agentWorkflowMaxNodes: 48,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FAKE_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }], activeProvider: 'fake',
  }, null, 2));
  const script = JSON.stringify({
    parent: [],
    parentByMessage: {
      CMD_BG1: [{ name: 'orchestrate_agents', args: { task: '慢速大产出分析', agentKey: 'slow', toolTier: 'exec', background: true } }, { text: '主线继续:代理已在后台。' }],
      CMD_CHAT2: [{ text: '第二回合完成。' }],
      CMD_CHAT3: [{ text: '第三回合完成。' }],
      CMD_FETCH4: [{ name: 'agent_result', args: { runId: '$RUN_ID', maxChars: 5000 } }, { text: '已取全文片段。' }],
      CMD_SYNC5: [{ name: 'orchestrate_agents', args: { task: '快速同步分析', agentKey: 'fast', toolTier: 'read' } }, { text: '同步完成。' }],
      // F1(wait 先到):节点里 Start-Sleep 3 → wait_agents 开始等时 run 还活着。
      CMD_WAIT6: [{ name: 'orchestrate_agents', args: { task: '慢速后台收件', agentKey: 'slowbg', toolTier: 'exec', background: true } }, { name: 'wait_agents', args: { timeoutMs: 20000 } }, { text: '已收件。' }],
      // F2(通知先到):节点瞬时完成;父回合先自己睡 2s(迭代边界在这之后把信封作通知注入)再 wait。
      CMD_NOTICE6: [{ name: 'orchestrate_agents', args: { task: '瞬时后台收件', agentKey: 'instbg', toolTier: 'read', background: true } }, { name: 'powershell_run', args: { command: 'Start-Sleep -Seconds 2; Write-Output parent-paused', timeoutMs: 20000 } }, { name: 'wait_agents', args: { timeoutMs: 20000 } }, { text: '已收件(通知先到)。' }],
      CMD_CHAT7: [{ text: '第七回合完成。' }],
      CMD_STOP8: [{ name: 'orchestrate_agents', args: { task: '超长后台分析', agentKey: 'long', toolTier: 'exec', background: true } }, { text: '已后台启动长任务。' }],
    },
    sub: [],
    subStepsByTask: {
      '慢速大产出分析': [{ name: 'powershell_run', args: { command: 'Start-Sleep -Seconds 4; Write-Output slow-done', timeoutMs: 30000 } }],
      '超长后台分析': [{ name: 'powershell_run', args: { command: 'Start-Sleep -Seconds 60; Write-Output long-done', timeoutMs: 90000 } }],
      '慢速后台收件': [{ name: 'powershell_run', args: { command: 'Start-Sleep -Seconds 3; Write-Output slowbg-done', timeoutMs: 30000 } }],
    },
    subText: BIG,
    subTextByTask: { '快速同步分析': '同步节点结论:' + 'S'.repeat(3000), '慢速后台收件': '后台慢节点结论。', '瞬时后台收件': '后台瞬时节点结论。', 'MCP 快任务': 'MCP 节点结论。' },
    parentText: '父回合完成。',
  });
  fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_SUBAGENT_SCRIPT: script, FAKE_CAPTURE_DIR: CAP }, windowsHide: true });
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).trim() && console.log('[wb!] ' + String(d).trim()));
  let up = null; for (let i = 0; i < 80 && !up; i++) { await sleep(150); up = await health(); }
  ok(!!up, 'workbench starts');
  let fup = false; for (let i = 0; i < 30 && !fup; i++) { await sleep(150); fup = await fakeUp(FAKE_PORT); }
  ok(fup, 'fake provider up');
  const tok = await token();
  const auth = { 'x-wcw-token': tok };
  const created = await jsonRequest('POST', '/api/sessions', { title: 'agent mode v2', cwd: HOME }, auth);
  const sid = created && created.session && created.session.id;
  ok(!!sid, 'session created');

  // ── A 背景启动 ──
  let liveTailDuring = null;
  const evA = await streamChat({ sessionId: sid, message: 'CMD_BG1 后台派一个慢任务', cwd: HOME });
  const receipt = evA.find(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.background === true);
  const runId = receipt && receipt.content.runId;
  ok(receipt && receipt.content.accepted === true && receipt.content.status === 'running' && /^run_/.test(runId || ''), 'A background orchestrate_agents returns {runId, status:running} immediately');
  ok(evA.find(e => e.type === 'tool_use' && e.name === 'orchestrate_agents' && !e.subagentId), 'A parent tool_use is orchestrate_agents (single entry)');
  const resA = evA.find(e => e.type === 'result');
  ok(resA && resA.ok === true, 'A parent turn ends normally while the agent keeps running');
  const wfStartA = evA.find(e => e.type === 'agent_workflow' && e.state === 'start');
  ok(wfStartA && wfStartA.background === true && wfStartA.id === runId, 'A workflow start event is tagged background:true');
  const digestA = await jsonRequest('GET', `/api/agent-runs?sessionId=${encodeURIComponent(sid)}&view=digest`, null, auth);
  const rowA = (digestA.runs || []).find(r => r.id === runId);
  ok(rowA && rowA.live === true, 'A run is still live after the parent turn ended (not killed by turn end)');
  const trayA = await jsonRequest('GET', `/api/sessions/${encodeURIComponent(sid)}/background`, null, auth);
  const trayRow = (trayA.items || []).find(it => it.runId === runId);
  ok(trayRow && trayRow.kind === 'agent' && trayRow.id === 'run:' + runId, 'A background tray lists the run as kind:agent with a stoppable id');
  // 持久化消息:后台回执小、无全文
  const sessA = await jsonRequest('GET', `/api/sessions/${encodeURIComponent(sid)}`, null, auth);
  const lastAssistantA = (sessA.session.messages || []).filter(m => m.role === 'assistant').pop();
  const tcA = lastAssistantA && (lastAssistantA.toolCalls || []).find(tc => tc.name === 'orchestrate_agents');
  ok(tcA && tcA.result && tcA.result.background === true && JSON.stringify(tcA.result).length < 1500, 'A persisted toolCalls result is the small receipt');
  const segA = (lastAssistantA.segments || []).find(sg => sg.type === 'workflow');
  ok(segA && segA.background === true && segA.status === 'background', 'A persisted workflow segment is background (finalizeAll did not mark it cancelled)');

  // ── B 主会话继续 ──
  const evB = await streamChat({ sessionId: sid, message: 'CMD_CHAT2 顺便聊两句', cwd: HOME });
  const resB = evB.find(e => e.type === 'result');
  const digestB = await jsonRequest('GET', `/api/agent-runs?sessionId=${encodeURIComponent(sid)}&view=digest`, null, auth);
  const rowB = (digestB.runs || []).find(r => r.id === runId);
  ok(resB && resB.ok === true && rowB && rowB.live === true, 'B a new turn completes normally while the agent is still running');
  const reqB = lastParentRequestFor('CMD_CHAT2');
  ok(reqB && !(reqB.messages || []).some(m => m.role === 'user' && /代理完成通知/.test(msgText(m))), 'B no envelope injected before the run finished');

  // ── C 完成 → 一次投递 ──
  const doneRun = await waitRun(sid, runId, auth, r => r && r.status === 'succeeded' && !r.live, 30000);
  // 节点全文存档沿用既有的 24000 字上限(09 runNode `slice(0, 24000)`,本波不动);子代理吐了 50k,存档 24k,信封仍只是摘要。
  ok(doneRun && doneRun.status === 'succeeded' && doneRun.nodes[0].result.length >= 20000, 'C run finished with a ≥20k-char archived node result (sub produced 50k; archive cap 24k pre-exists) — got ' + (doneRun && doneRun.nodes[0] && doneRun.nodes[0].result.length));
  await sleep(400);
  const jobsFile = path.join(HOME, 'sessions', 'background-jobs', sid + '.json');
  const jobs = fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, 'utf8')) : [];
  const agentJobs = jobs.filter(j => j.id === 'agent:' + runId);
  ok(agentJobs.length === 1 && agentJobs[0].kind === 'agent' && agentJobs[0].status === 'succeeded' && agentJobs[0].output.length < 12000, 'C exactly one agent envelope job in the background ledger (bounded)');
  const sessC0 = await jsonRequest('GET', `/api/sessions/${encodeURIComponent(sid)}`, null, auth);
  ok((sessC0.session.messages || []).filter(m => m.backgroundJobId === 'agent:' + runId).length === 1, 'C exactly one hidden receipt row in the session data plane');
  const evC = await streamChat({ sessionId: sid, message: 'CMD_CHAT3 代理好了吗', cwd: HOME });
  ok(evC.find(e => e.type === 'result' && e.ok === true), 'C follow-up turn ok');
  const reqC = lastParentRequestFor('CMD_CHAT3');
  const noticesC = reqC ? (reqC.messages || []).filter(m => m.role === 'user' && /代理完成通知/.test(msgText(m))) : [];
  ok(noticesC.length === 1 && msgText(noticesC[0]).includes(runId), 'C the envelope notice appears exactly once in the next request and names the runId');
  ok(noticesC.length === 1 && msgText(noticesC[0]).length < 6000 && !msgText(noticesC[0]).includes('ZQ'.repeat(800)), 'C the injected envelope is bounded (node produced 50k chars)');
  const maxMsgC = reqC ? Math.max(...(reqC.messages || []).map(m => msgText(m).length)) : 0;
  ok(maxMsgC > 0 && maxMsgC < 30000, 'C no message in the parent context carries the 50k node output (max ' + maxMsgC + ')');

  // ── D agent_result ──
  const evD = await streamChat({ sessionId: sid, message: 'CMD_FETCH4 取全文', cwd: HOME });
  const fetchRes = evD.find(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.totalChars != null);
  ok(fetchRes && fetchRes.content.ok === true && fetchRes.content.runId === runId && fetchRes.content.text.length === 5000 && fetchRes.content.totalChars >= 20000 && fetchRes.content.truncated === true && fetchRes.content.nextOffset === 5000, 'D agent_result returns a bounded slice with paging info — ' + JSON.stringify(fetchRes && { len: fetchRes.content.text && fetchRes.content.text.length, total: fetchRes.content.totalChars, truncated: fetchRes.content.truncated, next: fetchRes.content.nextOffset, err: fetchRes.content.error }));
  const reqD = lastParentRequestFor('CMD_FETCH4');
  ok(reqD && (reqD.messages || []).filter(m => m.role === 'user' && /代理完成通知/.test(msgText(m))).length === 1, 'D the earlier envelope notice is still exactly once (no re-injection)');

  // ── E 同步:信封进 tool_result 与持久化消息 ──
  const evE = await streamChat({ sessionId: sid, message: 'CMD_SYNC5 同步跑一个', cwd: HOME });
  const envE = evE.find(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.kind === 'agent_envelope');
  ok(envE && envE.content.ok === true && envE.content.nodes.length === 1 && envE.content.nodes[0].summary.length <= 1501 && !('result' in envE.content.nodes[0]) && envE.content.nodes[0].fullChars > 3000, 'E synchronous call returns the envelope (summary ≤1500 + fullChars, no raw result)');
  const sessE = await jsonRequest('GET', `/api/sessions/${encodeURIComponent(sid)}`, null, auth);
  const lastAssistantE = (sessE.session.messages || []).filter(m => m.role === 'assistant').pop();
  const tcE = lastAssistantE && (lastAssistantE.toolCalls || []).find(tc => tc.name === 'orchestrate_agents');
  ok(tcE && tcE.result && tcE.result.kind === 'agent_envelope' && JSON.stringify(tcE.result).length < 4000, 'E persisted toolCalls result is the envelope, not the full node output');
  const segE = (lastAssistantE.segments || []).find(sg => sg.type === 'workflow' && sg.workflowId === envE.content.runId);
  ok(segE && segE.status === 'done', 'E synchronous workflow segment settles done');
  const envJobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')).filter(j => j.id === 'agent:' + envE.content.runId);
  ok(envJobs.length === 0, 'E a synchronous run does not also enter the background ledger (no double delivery)');

  // ── F 一次投递的两种先后顺序 ──
  const noticesNaming = (req, id) => (req ? (req.messages || []) : []).filter(m => m.role === 'user' && /代理完成通知/.test(msgText(m)) && msgText(m).includes(String(id)));
  // F1(wait 先到)
  const evF = await streamChat({ sessionId: sid, message: 'CMD_WAIT6 后台再来一个并收件', cwd: HOME });
  const waitRes = evF.find(e => e.type === 'tool_result' && !e.subagentId && e.content && Array.isArray(e.content.runs));
  const envF = waitRes && waitRes.content.runs[0];
  const runIdF = envF && envF.runId;
  ok(waitRes && waitRes.content.settled === true && envF.kind === 'agent_envelope' && envF.status === 'succeeded' && envF.nodes && envF.nodes[0] && /后台慢节点结论/.test(envF.nodes[0].summary || ''), 'F1 wait_agents started while the run was live → returns the full terminal envelope');
  const reqF1 = lastParentRequestFor('CMD_WAIT6');
  ok(reqF1 && noticesNaming(reqF1, runIdF).length === 0, 'F1 no completion notice for that run in the same turn (the wait took it first)');
  // F2(通知先到)
  const evF2b = await streamChat({ sessionId: sid, message: 'CMD_NOTICE6 后台瞬时任务,父先忙别的再收件', cwd: HOME });
  const waitRes2 = evF2b.find(e => e.type === 'tool_result' && !e.subagentId && e.content && Array.isArray(e.content.runs));
  const rcpt = waitRes2 && waitRes2.content.runs[0];
  const runId6B = rcpt && rcpt.runId;
  ok(evF2b.find(e => e.type === 'result' && e.ok === true) && /^run_/.test(runId6B || ''), 'F2 notice-first turn completes');
  // 时序前提:父回合的 powershell_run 真的睡了 2s(工具存在且成功),否则「通知先到」的前提不成立。
  const psUse = evF2b.find(e => e.type === 'tool_use' && !e.subagentId && e.name === 'powershell_run');
  const psRes = psUse && evF2b.find(e => e.type === 'tool_result' && !e.subagentId && e.id === psUse.id);
  const run6B = await jsonRequest('GET', `/api/agent-runs/${encodeURIComponent(runId6B)}?sessionId=${encodeURIComponent(sid)}`, null, auth).catch(() => null);
  const r6 = run6B && run6B.run;
  ok(psRes && psRes.content && psRes.content.ok === true && /parent-paused/.test(JSON.stringify(psRes.content)), 'F2 precondition: the parent powershell_run pause really ran — ' + String(JSON.stringify(psRes && psRes.content) || 'no powershell_run tool_result').slice(0, 200));
  console.log('  F2 timing: run createdAt=' + (r6 && r6.createdAt) + ' completedAt=' + (r6 && r6.completedAt) + ' status=' + (r6 && r6.status) + ' | tool_use at index ' + evF2b.indexOf(psUse) + ', wait tool_result at index ' + evF2b.indexOf(waitRes2));
  ok(rcpt && rcpt.kind === 'agent_envelope_receipt' && rcpt.delivered === 'already' && rcpt.status === 'succeeded' && !(rcpt.nodes && rcpt.nodes[0] && 'summary' in rcpt.nodes[0]) && /agent_result/.test(rcpt.note || ''), 'F2 wait_agents after the notice already landed returns a short receipt, not the envelope again — got ' + JSON.stringify(rcpt && { kind: rcpt.kind, delivered: rcpt.delivered }));
  const reqF2 = lastParentRequestFor('CMD_NOTICE6');
  const notices6B = noticesNaming(reqF2, runId6B);
  const envelopeViaWait = rcpt && rcpt.kind === 'agent_envelope' ? 1 : 0;
  ok(notices6B.length === 1 && notices6B.length + envelopeViaWait === 1, 'F2 exactly one delivery in that turn: notice=' + notices6B.length + ' + envelope-in-wait=' + envelopeViaWait);
  // F3 后续回合
  await sleep(300);
  const evF3 = await streamChat({ sessionId: sid, message: 'CMD_CHAT7 再聊', cwd: HOME });
  ok(evF3.find(e => e.type === 'result' && e.ok === true), 'F3 follow-up turn ok');
  const reqF = lastParentRequestFor('CMD_CHAT7');
  ok(reqF && noticesNaming(reqF, runIdF).length === 0, 'F3 the wait-first run is never injected later');
  ok(reqF && noticesNaming(reqF, runId6B).length === 1, 'F3 the notice-first run still has exactly one notice (no second injection after the wait receipt)');
  const allNoticesF = reqF ? (reqF.messages || []).filter(m => m.role === 'user' && /代理完成通知/.test(msgText(m))).map(msgText) : [];
  ok(allNoticesF.length === 2 && new Set(allNoticesF).size === allNoticesF.length, 'F3 parent context carries exactly two distinct notices in total (first run + notice-first run)');
  const jobsF = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  ok(jobsF.filter(j => j.id === 'agent:' + runIdF).length === 1 && jobsF.filter(j => j.id === 'agent:' + runId6B).length === 1, 'F3 the ledger holds exactly one envelope per run');

  // ── G 后台任务条停止 ──
  const evG = await streamChat({ sessionId: sid, message: 'CMD_STOP8 后台派个超长的', cwd: HOME });
  const receiptG = evG.find(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.background === true);
  const runIdG = receiptG && receiptG.content.runId;
  ok(!!runIdG, 'G long background run launched');
  const liveG = await waitRun(sid, runIdG, auth, r => r && r.nodes && r.nodes[0] && r.nodes[0].status === 'running', 10000);
  ok(liveG && liveG.live === true, 'G long run is live before stop');
  const stopG = await jsonRequest('POST', `/api/sessions/${encodeURIComponent(sid)}/background/stop`, { id: 'run:' + runIdG }, auth);
  ok(stopG && stopG.ok === true, 'G background tray stop accepted');
  const stopAt = Date.now();
  const stoppedG = await waitRun(sid, runIdG, auth, r => r && !r.live && r.status === 'stopped', 60000);
  ok(stoppedG && stoppedG.status === 'stopped', 'G explicit stop ends the run as stopped — status=' + (stoppedG && stoppedG.status) + ' live=' + (stoppedG && stoppedG.live) + ' after ' + (Date.now() - stopAt) + 'ms');
  // 墙钟上界豁免：防挂死的宽上界——正常停止在一两秒内，没把中断信号传给子代理工具时要等满 60 s 的长命令才结束，20 s 与失败形态隔得足够开
  ok(Date.now() - stopAt < 20000, 'G stop interrupts the in-flight long command promptly (sub-agent tool calls carry the abort signal) — ' + (Date.now() - stopAt) + 'ms');
  await sleep(400);
  const jobsG = JSON.parse(fs.readFileSync(jobsFile, 'utf8')).filter(j => j.id === 'agent:' + runIdG);
  ok(jobsG.length === 1 && jobsG[0].status === 'stopped', 'G the stopped run still delivers exactly one (stopped) envelope');

  // ── H 子代理事件层 / liveTail 零泄漏 ──
  const subToolUses = evA.filter(e => e.type === 'tool_use' && e.subagentId);
  ok(subToolUses.length === 0 || subToolUses.every(e => e.background === true), 'H sub-agent tool events (if streamed) are tagged background + subagentId');
  const subEvG = evG.filter(e => (e.type === 'tool_use' || e.type === 'tool_result') && e.subagentId);
  ok(subEvG.every(e => e.background === true), 'H every streamed sub-agent tool event carries background:true (parent activity bar ignores it)');
  // 活回合尾巴:用一个慢父回合观察 —— 用 CMD_STOP8 期间的 /api/sessions/:id(回合已结束,resumable.liveTail 不存在)不够;
  // 改用源锁(agent-mode-v2.static)钉 appendLiveTail 的 subagentId 早退;这里只断言事件层形状。

  // ── I MCP 面 ──
  mcp = cp.spawn(process.execPath, [SERVER, 'mcp'], { env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, WCW_SESSION_ID: sid, WCW_PORT: String(WB_PORT), WCW_HOST: '127.0.0.1', WCW_TOKEN: tok }, windowsHide: true });
  mcp.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[mcp!] ' + l.trim())));
  const pending = new Map(); let mbuf = ''; let idc = 0;
  mcp.stdout.on('data', d => { mbuf += d; let nl; while ((nl = mbuf.indexOf('\n')) >= 0) { const line = mbuf.slice(0, nl); mbuf = mbuf.slice(nl + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
  const rpc = (method, params, ms) => new Promise((resolve, reject) => { const id = ++idc; const t = setTimeout(() => { pending.delete(id); reject(new Error('rpc timeout: ' + method)); }, ms || 15000); pending.set(id, m => { clearTimeout(t); resolve(m); }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2024-11-05' });
  const list = await rpc('tools/list', {});
  const names = ((list.result && list.result.tools) || []).map(t => t.name);
  ok(!names.includes('spawn_agent') && names.includes('orchestrate_agents') && names.includes('wait_agents') && names.includes('agent_result'), 'I MCP tools/list: no spawn_agent; orchestrate/wait/result present');
  const mcpFetch = await rpc('tools/call', { name: 'agent_result', arguments: { runId, maxChars: 800 } });
  const mcpText = mcpFetch.result && mcpFetch.result.content && mcpFetch.result.content[0] && mcpFetch.result.content[0].text || '';
  ok(mcpFetch.result && mcpFetch.result.isError !== true && /"totalChars":\s*2\d{4}/.test(mcpText) && /"returnedChars":\s*800/.test(mcpText), 'I MCP agent_result loops back and returns a bounded slice — ' + mcpText.slice(0, 160).replace(/\s+/g, ' '));
  const mcpLegacy = await rpc('tools/call', { name: 'spawn_agent', arguments: { task: 'MCP 快任务', toolTier: 'read' } }, 40000);
  const legacyText = mcpLegacy.result && mcpLegacy.result.content && mcpLegacy.result.content[0] && mcpLegacy.result.content[0].text || '';
  ok(mcpLegacy.result && mcpLegacy.result.isError !== true && /agent_envelope/.test(legacyText) && /已并入 orchestrate_agents/.test(legacyText) && /MCP 节点结论/.test(legacyText), 'I MCP spawn_agent is translated into a single-node orchestrate run and returns an envelope with the merge note');
  const mcpWait = await rpc('tools/call', { name: 'wait_agents', arguments: { runIds: [runId], timeoutMs: 1000 } });
  const waitText = mcpWait.result && mcpWait.result.content && mcpWait.result.content[0] && mcpWait.result.content[0].text || '';
  // 第一个 run 的信封早在 C 段以完成通知送达过 → MCP 面的 wait 也只回短回执(同一套结算)。
  ok(mcpWait.result && /"settled":\s*true/.test(waitText) && /agent_envelope_receipt/.test(waitText) && /"delivered":\s*"already"/.test(waitText), 'I MCP wait_agents loops back; an already-delivered run comes back as a short receipt');
} catch (e) { fail++; console.log('ERROR ' + (e && e.stack || e)); }
finally { killp(mcp); killp(wb); killp(fake); await sleep(300); fs.rmSync(HOME, { recursive: true, force: true }); }
console.log('\nAGENT MODE V2 E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
