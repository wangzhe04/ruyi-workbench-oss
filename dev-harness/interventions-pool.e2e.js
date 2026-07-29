(async () => {
'use strict';
// E2E(第71b波 EC-E 切片二补钉):task-pool proposed 统一进 Intervention + 残留 pending 叙事段清理。
// 覆盖:
//  (a) live 工作流:propose_task -> registerIntervention(pending,NDJSON);pool_approve -> settle approved;
//      pool_reject -> settle rejected;宽限窗到期 run 收尾 -> 余留 proposed expire -> settle expired。
//      期间 GET /api/missions/:sid 的 pending.pool 计数随决策 3 -> 0。
//  (b) boot 路径(kill + 播种 + respawn):
//      b1 paused run 的存量 proposed 提案(无 Intervention 记录)-> boot 对账补登记(backfilled:true,pending);
//      b2 补登记的 pool pending 不被 markInterruptedInterventions 一刀切(run paused 分流保留);
//      b3 崩溃时 running 的 run -> boot 中断 + 提案 expire + 旁路 settle expired(decidedBy auto);
//      b4 孤儿 pool pending(run 不存在)-> cancelled_restart;
//      b5/b6 missionPendingCounts 四源统一:pool 从 Intervention 读;boot 后新播的 proposed(无 iv)经 run 快照并集兜底;
//      b7/b8 残留 pending 叙事段清理:permission(pending+paused)/plan/question 段 -> cancelled + note 且落盘持久;
//      已终态段(allowed)不动。
//  (s) 静态锁:02 清理器+竞态守卫+pool 分流、08 中断结算+对账、09 注册+收尾结算、13d 审批结算+四源统一。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-ivpool-e2e');
const PROVIDER_PORT = await getFreePort(), WB_PORT = await getFreePort();
const GRACE_MS = 4000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function requestJson(port, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body == null ? 'GET' : 'POST', headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitHealth(port) { for (let i = 0; i < 60; i++) { const r = await requestJson(port, '/health', null).catch(() => null); if (r && r.status === 200) return true; await sleep(100); } return false; }
function ivFile(sid) { return path.join(HOME, 'sessions', sid + '.interventions.ndjson'); }
function readIv(sid) {
  const byId = new Map();
  let txt; try { txt = fs.readFileSync(ivFile(sid), 'utf8'); } catch { return byId; }
  for (const line of txt.split('\n')) { if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; } if (r && r.id) byId.set(String(r.id), r); }
  return byId;
}
async function waitForIv(sid, id, status, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 4000)) {
    const r = readIv(sid).get(String(id));
    if (r && (!status || r.status === status)) return r;
    await sleep(60);
  }
  return readIv(sid).get(String(id)) || null;
}
function runFile(sid, runId) { return path.join(HOME, 'agent-runs', sid, runId + '.json'); }
function readRun(sid, runId) { try { return JSON.parse(fs.readFileSync(runFile(sid, runId), 'utf8')); } catch { return null; } }

// ── fake openai:子回合按 task 标记驱动(与 team-pool-mailbox 同型)──────────────────────────
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function isSubRequest(msgs) {
  const sys = String(((msgs || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体');
}
function emitToolCall(res, id, callId, name, argsObj) {
  const args = JSON.stringify(argsObj);
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function startProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || (req.url || '').includes('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fake-model"}]}'); }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
    const id = 'chatcmpl-ivpool';
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    const fu = msgs.find(m => m && m.role === 'user');
    const ownTask = String(fu ? fu.content || '' : '').split('以下是前序节点结果')[0];
    const done = msgs.filter(m => m && m.role === 'tool').length;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (!isSubRequest(msgs)) return emitText(res, id, 'accepted');
    if (/PROPOSE3/.test(ownTask)) {
      if (done === 0) return emitToolCall(res, id, 'call_p0', 'propose_task', { task: 'APPRME 批准我', reason: 'r0' });
      if (done === 1) return emitToolCall(res, id, 'call_p1', 'propose_task', { task: 'REJME 拒绝我', reason: 'r1' });
      if (done === 2) return emitToolCall(res, id, 'call_p2', 'propose_task', { task: 'EXPME 过期我', reason: 'r2' });
      return emitText(res, id, 'PROPOSE3 完成');
    }
    return emitText(res, id, '节点完成');
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}

function spawnWb() {
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, WCW_POOL_GRACE_MS: String(GRACE_MS) }, windowsHide: true,
  });
}
const mkRun = (sid, runId, status, poolItems) => ({
  schemaVersion: 4, id: runId, sessionId: sid, turnSeq: 0, providerId: 'fake', status,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), concurrency: 2,
  taskPool: poolItems, messages: [], poolPolicy: 'manual', poolAutoCap: 3, eventSeq: 0, nodes: [],
  metrics: { interventions: {} },
});
const mkPoolItem = (id, task) => ({ id, proposedBy: 'n1', task, roleId: '', dependsOn: [], resources: [], toolTier: '', model: '', reason: 'seed', status: 'proposed', decidedBy: '', decidedAt: '', resultNodeId: '', createdAt: new Date().toISOString() });

(async () => {
  const src = readServerSource();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'bypass', includeWorkbenchMcp: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }), 'utf8');
  const provider = await startProvider();
  let wb = spawnWb(); wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));

  try {
    ok(await waitHealth(WB_PORT), 'workbench up');
    let token = readToken(); ok(!!token, 'runtime token available');

    // ============ (a) live 工作流:注册/审批/拒绝/过期 全链路 ============
    const created = await requestJson(WB_PORT, '/api/sessions', { title: 'ivpool-a' }, token);
    const sid = created.json && created.json.session && created.json.session.id;
    ok(!!sid, '(a) 会话已建');
    const launch = await requestJson(WB_PORT, '/api/agent-workflow/launch', { token, sessionId: sid, async: true, poolPolicy: 'manual', nodes: [{ id: 'proposer', task: 'PROPOSE3 提案节点', toolTier: 'read' }] }, token);
    const runId = launch.json && launch.json.runId;
    ok(launch.json && launch.json.ok && /^run_/.test(runId || ''), '(a) 工作流已启动');

    // 等 3 条提案到齐(run 快照里 proposed)
    let items = null;
    for (let i = 0; i < 100 && !items; i++) {
      const runs = await requestJson(WB_PORT, '/api/agent-runs?sessionId=' + encodeURIComponent(sid), null, token);
      const run = runs.json && (runs.json.runs || []).find(r => r.id === runId);
      const tp = run && Array.isArray(run.taskPool) ? run.taskPool.filter(p => p.status === 'proposed') : [];
      if (tp.length >= 3) items = tp; else await sleep(100);
    }
    ok(!!items && items.length === 3, '(a) 3 条提案到齐(proposed)');
    const byTask = t => (items || []).find(p => String(p.task || '').includes(t));
    const itemA = byTask('APPRME'), itemR = byTask('REJME'), itemE = byTask('EXPME');
    ok(!!itemA && !!itemR && !!itemE, '(a) 三条提案按 task 可辨');

    // a1: 提案注册 pending Intervention(3 条)
    const ivA = await waitForIv(sid, itemA && itemA.id, 'pending');
    const ivR = await waitForIv(sid, itemR && itemR.id, 'pending');
    const ivE = await waitForIv(sid, itemE && itemE.id, 'pending');
    ok(!!ivA && ivA.type === 'pool' && ivA.runId === runId, '(a1) 提案注册 pending Intervention(pool,带 runId)');
    ok(!!ivR && !!ivE, '(a1) 三条提案全部落盘 pending');

    // a2: missionPendingCounts 四源统一 —— pool=3
    let poolCnt = -1;
    for (let i = 0; i < 50; i++) {
      const det = await requestJson(WB_PORT, '/api/missions/' + sid, null, token);
      if (det.json && det.json.snapshot && det.json.snapshot.pending) { poolCnt = det.json.snapshot.pending.pool; if (poolCnt === 3) break; }
      await sleep(100);
    }
    ok(poolCnt === 3, '(a2) /api/missions pending.pool=3(统一读形计数)');

    // 批准 A / 拒绝 R -> 旁路结算
    const appr = await requestJson(WB_PORT, '/api/agent-runs/' + encodeURIComponent(runId), { sessionId: sid, action: 'pool_approve', poolId: itemA.id }, token);
    ok(appr.status === 200 && appr.json && appr.json.ok === true, '(a) pool_approve 200');
    const rej = await requestJson(WB_PORT, '/api/agent-runs/' + encodeURIComponent(runId), { sessionId: sid, action: 'pool_reject', poolId: itemR.id }, token);
    ok(rej.status === 200 && rej.json && rej.json.ok === true, '(a) pool_reject 200');
    const ivA2 = await waitForIv(sid, itemA.id, 'approved');
    ok(!!ivA2 && ivA2.decidedBy === 'user', '(a3) 批准 -> settle approved(decidedBy=user)');
    const ivR2 = await waitForIv(sid, itemR.id, 'rejected');
    ok(!!ivR2 && ivR2.decidedBy === 'user', '(a3) 拒绝 -> settle rejected(decidedBy=user)');

    // 宽限窗到期 -> run 收尾 -> EXPME expire + 旁路结算
    let terminal = null;
    for (let i = 0; i < 120 && !terminal; i++) {
      const runs = await requestJson(WB_PORT, '/api/agent-runs?sessionId=' + encodeURIComponent(sid), null, token);
      const run = runs.json && (runs.json.runs || []).find(r => r.id === runId);
      if (run && ['succeeded', 'partial', 'failed', 'stopped'].includes(String(run.status))) terminal = run; else await sleep(150);
    }
    ok(!!terminal, '(a) run 已终态(' + (terminal && terminal.status) + ')');
    const ivE2 = await waitForIv(sid, itemE.id, 'expired');
    ok(!!ivE2 && ivE2.decidedBy === 'auto', '(a4) 宽限窗到期 -> 余留提案 expire + settle expired(decidedBy=auto)');
    const det2 = await requestJson(WB_PORT, '/api/missions/' + sid, null, token);
    ok(det2.json && det2.json.snapshot && det2.json.snapshot.pending && det2.json.snapshot.pending.pool === 0, '(a5) 全部终态后 pending.pool=0');

    // ============ (b) boot 路径:kill + 播种 + respawn ============
    kill(wb); await sleep(500);
    // b-seed 1: paused run 带存量 proposed(无 Intervention 记录 —— 模拟 71b 前落盘)
    fs.mkdirSync(path.join(HOME, 'agent-runs', sid), { recursive: true });
    fs.writeFileSync(runFile(sid, 'run_aaa1'), JSON.stringify(mkRun(sid, 'run_aaa1', 'paused', [mkPoolItem('pool-l1', 'LEGACY1 存量待批')])), 'utf8');
    // b-seed 2: running run(模拟宽限窗内被杀)-> boot 中断 + expire
    fs.writeFileSync(runFile(sid, 'run_bbb2'), JSON.stringify(mkRun(sid, 'run_bbb2', 'running', [mkPoolItem('pool-l2', 'LEGACY2 崩溃待批')])), 'utf8');
    // b-seed 3: 孤儿 pool pending(run 不存在)
    fs.appendFileSync(ivFile(sid), JSON.stringify({ id: 'pool-orphan', type: 'pool', sessionId: sid, runId: 'run_zzz9', status: 'pending', requestedAt: new Date().toISOString(), decidedAt: '', decidedBy: '' }) + '\n', 'utf8');
    // b-seed 4: 残留 pending 叙事段(改 messages 正文 + 头 messageCount)
    const headPath = path.join(HOME, 'sessions', sid + '.json');
    const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
    const staleMsg = { role: 'assistant', content: '', ts: new Date().toISOString(), segments: [
      { id: 'sg1', type: 'permission', requestId: 'perm-stale-1', toolName: 'Bash', tier: 'exec', status: 'pending' },
      { id: 'sg2', type: 'permission', requestId: 'perm-paused-1', toolName: 'Write', tier: 'edit', status: 'paused' },
      { id: 'sg3', type: 'plan', planId: 'plan-stale-1', markdown: '## 旧计划', status: 'pending' },
      { id: 'sg4', type: 'question', questionId: 'q-stale-1', questions: [{ question: '旧问题?' }], status: 'pending' },
      { id: 'sg5', type: 'permission', requestId: 'perm-done-1', toolName: 'Read', tier: 'read', status: 'allowed' },
    ] };
    fs.appendFileSync(path.join(HOME, 'sessions', sid + '.messages.ndjson'), JSON.stringify(staleMsg) + '\n', 'utf8');
    head.messageCount = (Number(head.messageCount) || 0) + 1;
    fs.writeFileSync(headPath, JSON.stringify(head), 'utf8');

    wb = spawnWb(); wb.stderr.on('data', d => String(d).trim() && console.error('[wb2!] ' + String(d).trim()));
    ok(await waitHealth(WB_PORT), '(b) workbench 重启 up');
    token = readToken(); ok(!!token, '(b) 重启后重读 token');

    // b1+b2: 对账补登记 + paused 分流保留
    const ivL1 = await waitForIv(sid, 'pool-l1', 'pending', 5000);
    ok(!!ivL1 && ivL1.type === 'pool' && ivL1.backfilled === true && ivL1.runId === 'run_aaa1', '(b1) boot 对账补登记存量提案(backfilled,pending,带 runId)');
    await sleep(600); // 给 markInterruptedInterventions 充分时间(若它会误杀,此时已落盘)
    const ivL1b = readIv(sid).get('pool-l1');
    ok(!!ivL1b && ivL1b.status === 'pending', '(b2) paused run 的 pool pending 不被重启一刀切(分流保留)');

    // b3: 中断 expire + 旁路结算
    const ivL2 = await waitForIv(sid, 'pool-l2', 'expired', 5000);
    ok(!!ivL2 && ivL2.decidedBy === 'auto', '(b3) 崩溃 running run -> boot 中断 + 提案 expire + settle expired(auto)');
    const runB = readRun(sid, 'run_bbb2');
    ok(!!runB && runB.status === 'interrupted' && runB.taskPool[0].status === 'expired', '(b3) run 快照同步:interrupted + 提案 expired');

    // b4: 孤儿终态化
    const ivOrphan = await waitForIv(sid, 'pool-orphan', 'cancelled_restart', 5000);
    ok(!!ivOrphan && ivOrphan.decidedBy === 'restart', '(b4) 孤儿 pool pending(run 不存在)-> cancelled_restart');

    // b5: 四源统一计数 —— 仅 pool-l1 未决
    let poolB = -1;
    for (let i = 0; i < 50; i++) {
      const det = await requestJson(WB_PORT, '/api/missions/' + sid, null, token);
      if (det.json && det.json.snapshot && det.json.snapshot.pending) { poolB = det.json.snapshot.pending.pool; if (poolB === 1) break; }
      await sleep(100);
    }
    ok(poolB === 1, '(b5) 重启后 pending.pool=1(只有补登记的 pool-l1)');

    // b6: run 快照并集兜底 —— boot 后新播 proposed(无 iv)也计入
    fs.writeFileSync(runFile(sid, 'run_ccc3'), JSON.stringify(mkRun(sid, 'run_ccc3', 'paused', [mkPoolItem('pool-c3', 'LEGACY3 后播待批')])), 'utf8');
    const det3 = await requestJson(WB_PORT, '/api/missions/' + sid, null, token);
    ok(det3.json && det3.json.snapshot.pending.pool === 2, '(b6) 并集兜底:无 iv 记录的 proposed 也计入(pool=2)');

    // b7: 残留 pending 叙事段清理
    const sess1 = await requestJson(WB_PORT, '/api/sessions/' + sid, null, token);
    const segs = (((sess1.json || {}).session || {}).messages || []).flatMap(m => (m && m.segments) || []);
    const segBy = k => segs.find(s => s && s.id === k);
    ok(segBy('sg1') && segBy('sg1').status === 'cancelled' && /失效/.test(String(segBy('sg1').note || '')), '(b7) permission pending 段 -> cancelled + note');
    ok(segBy('sg2') && segBy('sg2').status === 'cancelled', '(b7) permission paused 段 -> cancelled(存档暂停同失效)');
    ok(segBy('sg3') && segBy('sg3').status === 'cancelled', '(b7) plan pending 段 -> cancelled');
    ok(segBy('sg4') && segBy('sg4').status === 'cancelled', '(b7) question pending 段 -> cancelled');
    ok(segBy('sg5') && segBy('sg5').status === 'allowed', '(b7) 已终态段(allowed)不动');

    // b8: 清理落盘持久 —— 二次装载仍 cancelled(不翻回 pending)
    const sess2 = await requestJson(WB_PORT, '/api/sessions/' + sid, null, token);
    const segs2 = (((sess2.json || {}).session || {}).messages || []).flatMap(m => (m && m.segments) || []);
    ok(segs2.filter(s => s && ['sg1', 'sg2', 'sg3', 'sg4'].includes(s.id)).every(s => s.status === 'cancelled'), '(b8) 清理落盘持久(二次装载仍 cancelled)');

    // ============ (s) 静态锁 ============
    console.log('\n── [s] 静态锁 ──');
    ok(/function healStalePendingSegments\(session\)/.test(src), 's 02 有 healStalePendingSegments 清理器');
    ok(/!activeChildren\.has\(session\.id\) && !turnSettlers\.has\(session\.id\)/.test(src), 's 02 loadSession 竞态守卫(activeChildren + turnSettlers)');
    ok(/iv\.type === 'pool'/.test(src) && /run\.status === 'paused'\) continue; \/\/ 恢复后可决策/.test(src), 's 02 markInterruptedInterventions pool 分流(paused 保留)');
    ok(/settleIntervention\(run\.sessionId, p\.id, 'expired', \{ decidedBy: 'auto', note: 'run interrupted at boot' \}\)/.test(src), 's 08 中断 expire 旁路 settle');
    ok(/legacyPoolProposed/.test(src) && /backfilled: true/.test(src), 's 08 存量对账补登记(legacyPoolProposed + backfilled)');
    ok(/registerIntervention\(run\.sessionId, 'pool', item\.id,/.test(src), 's 09 proposeTaskImpl 注册 pool Intervention');
    ok(/settleIntervention\(run\.sessionId, p\.id, 'expired', \{ decidedBy: p\.decidedBy \|\| 'auto', note: 'run finalized' \}\)/.test(src), 's 09 收尾 expire 旁路 settle');
    ok(/settleIntervention\(sessionId, poolId, 'approved', \{ decidedBy: 'user'/.test(src), 's 13d pool_approve 旁路 settle approved');
    ok(/settleIntervention\(sessionId, poolId, 'rejected', \{ decidedBy: 'user'/.test(src), 's 13d pool_reject 旁路 settle rejected');
    ok(/poolPendingIds/.test(src) && /iv\.type === 'pool'\) \{ pool\+\+;/.test(src), 's 13d missionPendingCounts 四源统一(pool 从 iv + 并集兜底)');

  } finally {
    kill(wb); await new Promise(r => provider.close(r));
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nINTERVENTIONS POOL E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
})();
