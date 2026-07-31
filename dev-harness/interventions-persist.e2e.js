(async () => {
'use strict';
// E2E(第71波 EC-E 切片二):未决事项 Intervention 持久化。
// 覆盖:
//  (a) 注册落盘 + 决策同步:provider 引擎 request_user_input -> ask_user 注册 pending Intervention;
//      /api/chat/answer -> deliver -> settle answered。NDJSON 后写胜折叠显示 answered。
//  (b) 重复决策不重复执行:同 questionId 二次 answer -> 409(Map 已 delete);NDJSON 无第二条 answered。
//  (c) 重启终态化:手动写 pending Intervention(模拟注册后未决策就崩)-> kill+respawn wb ->
//      boot markInterruptedInterventions 标 cancelled_restart -> GET 读到终态(不永挂)。
//  (d) 只读派生 + 鉴权:GET /api/interventions/:sid 无 token -> 403;有 token -> 200 + counts;
//      GET 不改磁盘(读前后 NDJSON 一致)。
//  (e) 静态锁:02 helper、13d 路由+missionPendingCounts async、01-config ROUTE_AUTH、13-http-router boot、04/07 注册/决策点。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-interventions-e2e');
const PROVIDER_PORT = await getFreePort(), WB_PORT = await getFreePort();
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
// 读 NDJSON 折叠(后写胜),返回 Map(id -> record)。
function readIv(sid) {
  const byId = new Map();
  let txt; try { txt = fs.readFileSync(ivFile(sid), 'utf8'); } catch { return byId; }
  for (const line of txt.split('\n')) { if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; } if (r && r.id) byId.set(String(r.id), r); }
  return byId;
}
// 轮询直到某 ivId 出现且 status 匹配(append 是 fire-and-forget,有落盘延迟)。
async function waitForIv(sid, id, status, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 3000)) {
    const m = readIv(sid); const r = m.get(String(id));
    if (r && (!status || r.status === status)) return r;
    await sleep(50);
  }
  return readIv(sid).get(String(id)) || null;
}

function startProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url === '/health' ? '{"ok":true}' : '{"data":[{"id":"fake-model"}]}'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const hasAnswer = (body.messages || []).some(m => m.role === 'tool' && String(m.content || '').includes('Vue'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = v => res.write('data: ' + JSON.stringify(v) + '\n\n');
    if (!hasAnswer) {
      const args = JSON.stringify({ questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_q1', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Provider received Vue' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}

// 发 /api/chat/stream,在 ask_user 事件回调里做断言 + answer;返回 { events, sid, questionId, answerResp }。
function streamWithQuestion(body, token, onAsk) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = ''; let sid = ''; let questionId = ''; let answerPromise = null;
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token } }, res => {
      const consume = line => {
        if (!line.trim()) return; let evt; try { evt = JSON.parse(line); } catch { return; }
        events.push(evt);
        if (evt.type === 'session' && evt.session?.id) sid = evt.session.id;
        if (evt.type === 'ask_user' && !questionId) {
          questionId = evt.questionId || evt.id;
          if (onAsk && !answerPromise) answerPromise = onAsk(sid, questionId, evt);
        }
      };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); consume(line); } });
      res.on('end', async () => { consume(buf); const a = answerPromise ? await answerPromise : null; resolve({ events, sid, questionId, answerResp: a }); });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}

function spawnWb() {
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true });
}

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

    // ============ (a) 注册落盘 + 决策同步 ============
    const turn = await streamWithQuestion({ message: 'ask which framework' }, token, async (sid, qid, evt) => {
      // ask_user 已发出 -> registerIntervention(pending) 已调(04 注册点)。轮询 NDJSON 确认 pending 落盘。
      const pending = await waitForIv(sid, qid, 'pending', 3000);
      ok(!!pending && pending.type === 'question' && pending.status === 'pending', '(a) ask_user 注册 pending Intervention 落盘(NDJSON)');
      // 模拟 UI answer -> deliver -> settleIntervention(answered)。
      return requestJson(WB_PORT, '/api/chat/answer', { sessionId: sid, questionId: qid, answers: [{ question: 'Which framework?', answer: ['Vue'] }], content: 'Which framework?: Vue' }, token);
    });
    ok(turn.answerResp?.status === 200 && turn.answerResp?.json?.delivered === true, '(a) answer 端点确认 deliver');
    ok(turn.events.some(e => e.type === 'question_answer' && e.ok === true), '(a) question_answer 事件发出');
    const answered = await waitForIv(turn.sid, turn.questionId, 'answered', 3000);
    // ============ (f/g) 75a: settle 保留完整状态 + interventionVersion 单调 ============
    // 75a 前:settle 写部分行 {id,status,decidedAt,...} 后写胜覆盖 register -> type/requestedAt 丢失。
    // 75a 后:settleIntervention 经缓存合并写完整状态行;readInterventions merge-fold 双保险。
    ok(!!answered && answered.type === 'question', '(f) settle 保留 type(完整状态行,不丢字段)');
    ok(!!answered && typeof answered.requestedAt === 'string' && answered.requestedAt.length > 0, '(f) settle 保留 requestedAt');
    ok(!!answered && Number(answered.interventionVersion) === 1, '(g) interventionVersion 单调(register=0 -> settle=1)');
    // API 侧 readInterventions merge-fold 同样保留 type(端到端):
    const ivApi = await requestJson(WB_PORT, '/api/interventions/' + turn.sid, null, token);
    const ivApiRow = ivApi.json?.interventions?.find(x => x && x.id === turn.questionId);
    ok(!!ivApiRow && ivApiRow.type === 'question' && Number(ivApiRow.interventionVersion) === 1, '(f/g) API /api/interventions/:sid 返回完整 type+version(merge-fold)');
    ok(!!answered && answered.status === 'answered' && answered.decidedBy === 'user', '(a) 决策同步:settle answered(decidedBy=user,后写胜折叠)');

    // ============ (b) 重复决策不重复执行 ============
    const beforeCount = readIv(turn.sid).size;
    const stale = await requestJson(WB_PORT, '/api/chat/answer', { sessionId: turn.sid, questionId: turn.questionId, content: 'duplicate' }, token);
    ok(stale.status === 409, '(b) 重复决策 -> 409(Map 已 delete,不重复执行)');
    await sleep(200);
    const afterDup = readIv(turn.sid).get(String(turn.questionId));
    ok(afterDup && afterDup.status === 'answered', '(b) 重复决策不新增条目(后写胜仍 answered)');

    // ============ (c) 重启终态化 ============
    // 手动写一个 pending Intervention(模拟:注册后未决策,进程被杀)。
    const sidC = turn.sid;
    const staleIv = { id: 'perm_test_stale_1', type: 'permission', sessionId: sidC, status: 'pending', requestedAt: new Date().toISOString(), decidedAt: '', decidedBy: '' };
    fs.appendFileSync(ivFile(sidC), JSON.stringify(staleIv) + '\n', 'utf8');
    ok(readIv(sidC).get('perm_test_stale_1')?.status === 'pending', '(c) 手动写 pending Intervention(模拟崩溃前状态)');
    // kill + respawn wb -> boot markInterruptedInterventions 标 cancelled_restart。
    kill(wb); await sleep(400);
    wb = spawnWb(); wb.stderr.on('data', d => String(d).trim() && console.error('[wb2!] ' + String(d).trim()));
    ok(await waitHealth(WB_PORT), '(c) workbench 重启 up');
    token = readToken(); ok(!!token, '(c) 重启后重读 token(respawn 重新生成 token)');
    await sleep(300); // 给 markInterruptedInterventions 一点时间扫盘 + append
    const afterRestart = await waitForIv(sidC, 'perm_test_stale_1', 'cancelled_restart', 3000);
    ok(!!afterRestart && afterRestart.status === 'cancelled_restart' && afterRestart.decidedBy === 'restart', '(c) 重启终态化:pending -> cancelled_restart(decidedBy=restart,不永挂)');
    // 已 answered 的 question 不被重启终态化(不是 pending)。
    const qAfterRestart = await waitForIv(sidC, turn.questionId, 'answered', 1000);
    ok(!!qAfterRestart && qAfterRestart.status === 'answered', '(c) 已结算的 Intervention 不被重启终态化(仍 answered)');

    // ============ (d) 只读派生 + 鉴权 ============
    const noToken = await requestJson(WB_PORT, '/api/interventions/' + sidC, null, null);
    ok(noToken.status === 403, '(d) GET 无 token -> 403(handler 内 tokenOk 自查)');
    const ndjsonBefore = fs.readFileSync(ivFile(sidC), 'utf8');
    const withToken = await requestJson(WB_PORT, '/api/interventions/' + sidC, null, token);
    ok(withToken.status === 200 && withToken.json?.ok === true && Array.isArray(withToken.json?.interventions), '(d) GET 有 token -> 200 + interventions 数组');
    ok(withToken.json.counts?.pending === 0, '(d) counts.pending=0(全部已终态:cancell`ed_restart/answered)');
    ok(withToken.json.counts?.resolved >= 2, '(d) counts.resolved>=2(answered + cancelled_restart)');
    const ndjsonAfter = fs.readFileSync(ivFile(sidC), 'utf8');
    ok(ndjsonBefore === ndjsonAfter, '(d) 只读派生不回写磁盘(读前后 NDJSON 一致)');

    // ============ (h) 75a: 撕裂尾行 append 前物理截断 ============
    // 写「有效 pending 行 + 撕裂尾行(无 \n)」-> 重启 -> boot markInterruptedInterventions 为 pending append
    // cancelled_restart 时,appendIntervention 先 repairInterventionTornTail 截断撕裂尾再 append。
    // 断言:撕裂尾(torn_line_xyz)被截断不在文件;新 append 干净;文件以 \n 结尾。
    {
      const sidH = sidC, isoH = new Date().toISOString();
      const validPending = JSON.stringify({ id: 'torn_perm_1', type: 'permission', sessionId: sidH, status: 'pending', requestedAt: isoH, decidedAt: '', decidedBy: '', interventionVersion: 0 }) + '\n';
      const tornTail = '{"id":"torn_line_xyz","type":"question","sessionId":"' + sidH + '","status":"pending","requestedAt":"' + isoH + '"'; // 无闭合 } 无 \n = 撕裂尾
      fs.appendFileSync(ivFile(sidH), validPending + tornTail, 'utf8');
      const rawBefore = fs.readFileSync(ivFile(sidH), 'utf8');
      ok(rawBefore.includes('torn_line_xyz') && !rawBefore.endsWith('\n'), '(h) 准备:写入撕裂尾行(无 \\n)');
      kill(wb); await sleep(400);
      wb = spawnWb(); wb.stderr.on('data', d => String(d).trim() && console.error('[wb3!] ' + String(d).trim()));
      ok(await waitHealth(WB_PORT), '(h) workbench 重启 up');
      token = readToken();
      const tornAfter = await waitForIv(sidH, 'torn_perm_1', 'cancelled_restart', 3000);
      ok(!!tornAfter && tornAfter.status === 'cancelled_restart', '(h) boot 为 torn_perm_1 append cancelled_restart(触发 repair)');
      const rawAfter = fs.readFileSync(ivFile(sidH), 'utf8');
      ok(!rawAfter.includes('torn_line_xyz'), '(h) 撕裂尾行被物理截断(torn_line_xyz 不在文件,未焊进坏行)');
      ok(rawAfter.endsWith('\n'), '(h) append 后文件以 \\n 结尾(干净)');
    }

    // ============ (i) 75a: missionId 派生(方案 B) + 存量不回写 ============
    // (i1) 新会话:GET /api/missions 卡片带 missionId === sessionId;(i2) 头文件写入 missionId。
    // (i3) 剥掉头文件 missionId(模拟第75a波前存量)-> POST /api/mission start 触发 loadSession+saveSession
    //      -> 头文件仍无 missionId(不回写);(i4) GET /api/missions 仍返回 missionId(只读派生)。
    {
      const sidI = turn.sid;
      const headPath = path.join(HOME, 'sessions', sidI + '.json');
      const head1 = JSON.parse(fs.readFileSync(headPath, 'utf8'));
      ok(head1.missionId === sidI, '(i2) 新会话头文件写入 missionId(createSession)');
      // quick_ask 不入 /api/missions 列表(无 mission = 'none' 不入列表),先 start 立单再测卡片
      const msStart = await requestJson(WB_PORT, '/api/mission', { sessionId: sidI, action: 'start', mission: { goal: 'missionId test' } }, token);
      ok(msStart.status === 200 && msStart.json?.ok === true, '(i0) POST /api/mission start 立单(quick_ask -> mission)');
      const mr1 = await requestJson(WB_PORT, '/api/missions', null, token);
      const card1 = (mr1.json?.missions || []).find(m => m && (m.sessionId === sidI || m.missionId === sidI));
      ok(!!card1 && card1.missionId === sidI, '(i1) GET /api/missions 卡片 missionId === sessionId');
      delete head1.missionId; // 模拟第75a波前存量会话(头文件无 missionId)
      fs.writeFileSync(headPath, JSON.stringify(head1), 'utf8');
      const ms = await requestJson(WB_PORT, '/api/mission', { sessionId: sidI, action: 'start', mission: { goal: 'no-writeback test' } }, token);
      ok(ms.status === 200 && ms.json?.ok === true, '(i3) POST /api/mission start 触发 loadSession+saveSession');
      const head2 = JSON.parse(fs.readFileSync(headPath, 'utf8'));
      ok(head2.missionId === undefined, '(i3) 存量 missionId 不回写磁盘(saveSession 后头文件仍无 missionId)');
      const mr2 = await requestJson(WB_PORT, '/api/missions', null, token);
      const card2 = (mr2.json?.missions || []).find(m => m && (m.sessionId === sidI || m.missionId === sidI));
      ok(!!card2 && card2.missionId === sidI, '(i4) 剥掉后 GET /api/missions 仍返回 missionId(只读派生 sessionMissionId)');
    }


    // ============ (e) 静态锁 ============
    console.log('\n── [e] 静态锁 ──');
    ok(/function appendIntervention\(sessionId, record\)/.test(src) && /function registerIntervention\(sessionId, type, ivId, extra\)/.test(src), 'e 02 有 appendIntervention/registerIntervention');
    ok(/function settleIntervention\(sessionId, ivId, status, extra\)/.test(src) && /async function readInterventions\(sessionId\)/.test(src), 'e 02 有 settleIntervention/readInterventions');
    ok(/async function markInterruptedInterventions\(\)/.test(src) && /cancelled_restart/.test(src), 'e 02 有 markInterruptedInterventions + cancelled_restart 终态');
    ok(/async function missionPendingCounts\(sessionId, runs\)/.test(src) && /readInterventions\(sessionId\)/.test(src), 'e 13d missionPendingCounts 改 async 从 readInterventions 现算');
    ok(/GET' && pathname\.startsWith\('\/api\/interventions\/'\)/.test(src), 'e 13d GET /api/interventions/:sid 只读路由');
    ok(/\{ m: 'GET', p: '\/api\/interventions\/', auth: 'token-browser', prefix: true \}/.test(src), 'e 01-config ROUTE_AUTH /api/interventions/ token-browser');
    ok(/await markInterruptedInterventions\(\);/.test(src), 'e 13-http-router boot 调 markInterruptedInterventions');
    ok(/registerIntervention\(sessionId, 'question', id,/.test(src), 'e 04 question 注册点调 registerIntervention');
    ok(/settleIntervention\(sessionId, id, answer && answer\.ok !== false \? 'answered' : 'cancelled'/.test(src), 'e 04 question deliver 调 settleIntervention');
    ok(/registerIntervention\(sessionId, 'permission', requestId,/.test(src), 'e 07 原生 permission 注册点调 registerIntervention');
    ok(/registerIntervention\(sessionId, 'plan', planId,/.test(src), 'e 07 plan 注册点调 registerIntervention');
    ok(/settleIntervention\(sessionId, requestId, decision && decision\.behavior === 'allow' \? 'allowed' : 'denied'/.test(src), 'e 07 permission settle 调 settleIntervention');
    ok(/settleIntervention\(entry\.sessionId, String\(body\.requestId \|\| ''\), behavior === 'allow' \? 'allowed' : 'denied'/.test(src), 'e 13d 桥 permission decision 调 settleIntervention');
    ok(/settleIntervention\(sessionId, planId, decision === 'approve' \? 'approved' : 'rejected'/.test(src), 'e 13d plan decision 调 settleIntervention');
    ok(/settleIntervention\(sessionId, requestId, 'denied', \{ decidedBy: 'timeout'/.test(src), 'e 13d 桥 permission 超时 timer 调 settleIntervention(timeout)');
    ok(/settleIntervention\(sessionId, rid, 'denied', \{ decidedBy: 'clear'/.test(src), 'e 04 clearPendingPermissions 调 settleIntervention(clear)');

  } finally {
    kill(wb); await new Promise(r => provider.close(r));
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nINTERVENTIONS PERSIST E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
})();
