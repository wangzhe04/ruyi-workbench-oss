(async () => {
'use strict';
// E2E(第 103 波 103a · 切片二):Intervention 决策端点【逐端点响应快照】。
// 目的(23 号方案 §2):路由 descriptor 化迁移前,把 75b contract 端点 + 四类经典适配器的 HTTP 响应
// 按场景字节级锁死 —— 字段级断言放行「多一个键/改一条消息」式漂移,快照不放行。迁移后除既有历史
// 差异外必须零变化(103a 出门判据)。
//
// 场景矩阵(成功/版本冲突/重放/过期/不可送达/缺失/越权):
//  · contract  POST /api/missions/:m/interventions/:i/decision —— 全七场景(纯播种可复现):
//      越权 403 / 缺失 404(未知 mission + 未知 iv)/ 版本冲突 409 / 不可送达 409(有账无活人)/
//      过期 410(expired) + 终态 409(already_terminal)/ 成功 200(replan reject,持久化 run 免活 consumer)/
//      重放 200(同 key 同 payload 返回原响应) + 同 key 异 payload 409 idempotency_conflict。
//  · legacy question  POST /api/chat/answer —— 越权(浏览器无 token)403 / 未挂起 409 / 成功 200 / 重复 409。
//  · legacy permission POST /api/permission/decision —— 越权 403 / 未知 404 / 成功 200(活 permission_request)/ 重复 404。
//  · legacy plan      POST /api/plan/decision —— 越权 403 / 无挂起 200+ok:false(历史形状:错误也是 200,锁定不改)。
//  · legacy pool      POST /api/agent-runs/:runId (pool_approve/pool_reject) —— 越权 403 / 缺参 400 / 死 run 409。
//
// 边界(不重复锁定,只引用):question 契约级混合并发/持久化行序 = interventions-persist.e2e.js (j);
// CAS 六窗崩溃恢复 = interventions-cas.e2e.js;pool 活 run 成功/提案已处理 = interventions-pool.e2e.js;
// plan 批准/拒绝真流程 = plan-mode.e2e.js。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-ivsnap-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ── 快照断言:status + 全信封逐字节(键序归一)。多键/少键/改文案都会红。 ──
const canon = v => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  return v;
}
function snap(label, resp, status, body) {
  const gotStatus = resp && resp.status;
  const gotBody = resp && resp.json;
  const statusOk = gotStatus === status;
  const bodyOk = canon(gotBody) === canon(body);
  ok(statusOk && bodyOk, `${label} -> ${status} 快照${statusOk && bodyOk ? '' : ` :: 实得 ${gotStatus} ${canon(gotBody)}`}`);
}

function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
// opts: { token, origin(模拟浏览器), method }
function requestJson(pathname, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: WB_PORT, path: pathname, method: opts.method || (body == null ? 'GET' : 'POST'),
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(opts.token ? { 'x-wcw-token': opts.token } : {}),
        ...(opts.origin ? { origin: opts.origin, 'sec-fetch-mode': 'cors' } : {}),
      },
    }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitHealth() { for (let i = 0; i < 60; i++) { const r = await requestJson('/health', null).catch(() => null); if (r && r.status === 200) return true; await sleep(100); } return false; }

const ivFile = sid => path.join(HOME, 'sessions', sid + '.interventions.ndjson');
function seedIv(sid, rows) {
  fs.mkdirSync(path.dirname(ivFile(sid)), { recursive: true });
  fs.appendFileSync(ivFile(sid), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
const pendingRow = (sid, id, type, extra = {}) => ({
  id, type, sessionId: sid, status: 'pending', requestedAt: new Date().toISOString(),
  decidedAt: '', decidedBy: '', interventionVersion: 0, ...extra,
});
const contractRoute = (m, i) => '/api/missions/' + encodeURIComponent(m) + '/interventions/' + encodeURIComponent(i) + '/decision';

// ── fake provider(openai-compat SSE):TOOL_SEQUENCE 驱动,与 persist/perm-v2 同款。 ──
function spawnFake(env) {
  const p = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], {
    env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), ...env }, windowsHide: true,
  });
  p.stderr.on('data', d => String(d).trim() && console.error('[fake!] ' + String(d).trim()));
  return p;
}
function fakeUp() { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port: FAKE_PORT, path: '/v1/models', timeout: 800 }, resp => { resp.resume(); res(true); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); }); }
async function restartFake(env) { kill(fake); fake = spawnFake(env); for (let i = 0; i < 30; i++) { if (await fakeUp()) return; await sleep(100); } throw new Error('fake provider 起不来'); }

// 流式 /api/chat/stream:ask_user / permission_request 到达即回调(此刻决策),流尾汇总。
function streamChat(body, token, cbs = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = ''; let sid = '';
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token } }, res => {
      const consume = line => {
        if (!line.trim()) return; let evt; try { evt = JSON.parse(line); } catch { return; }
        events.push(evt);
        if (evt.type === 'session' && evt.session && evt.session.id) sid = evt.session.id;
        if (evt.type === 'ask_user' && cbs.onAsk) cbs.onAsk(sid, evt);
        if (evt.type === 'permission_request' && cbs.onPermission) cbs.onPermission(sid, evt);
      };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); consume(line); } });
      res.on('end', async () => { consume(buf); resolve({ events, sid }); });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}

let fake = null;
let wb = null;
// 事件回调里发起的决策请求句柄(回调在流尾前只算「已发出」,断言前先 await 落地)。
const cbsDone = [];

// ════════════════════════════ 主流程 ════════════════════════════
const src = readServerSource(); // 顺带验证 src/产物新鲜度
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
  permissionTimeoutMs: 15000, includeWorkbenchMcp: true, defaultWorkspace: HOME, recentWorkspaces: [],
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FAKE_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}), 'utf8');

try {
  await restartFake({}); // 先占端口(question/permission 场景前再换序列重启)
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, RUYI_TEST_HOOKS: '1' }, windowsHide: true });
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  ok(await waitHealth(), 'workbench up');
  const token = readToken(); ok(!!token, 'runtime token available');
  const AUTH_403 = { ok: false, error: { code: 'auth.token_invalid', params: {}, message: 'missing or invalid workbench token' } };

  // ─────────── A. contract 端点(纯播种,全七场景) ───────────
  const made = await requestJson('/api/sessions', { title: 'snapshot-mission' }, { token });
  const sid = made.json && made.json.session && made.json.session.id;
  ok(!!sid, '(A) 会话已建(missionId 派生 = sessionId)');

  // A1 越权:无 token(loopback 非浏览器也拒 —— token 级不问出处)。
  snap('(A1) contract 无 token', await requestJson(contractRoute(sid, 'iv_x'), { expectedVersion: 0, idempotencyKey: 'k', action: 'reject' }), 403, AUTH_403);

  // A2 缺失:未知 iv -> 404;未知 mission -> 404(同信封)。
  const NOT_FOUND = { ok: false, reason: 'not_found', error: { code: 'intervention.not_found', params: {}, message: 'mission or intervention not found' } };
  snap('(A2) 未知 interventionId', await requestJson(contractRoute(sid, 'iv_missing'), { expectedVersion: 0, idempotencyKey: 'k-miss', action: 'reject' }, { token }), 404, NOT_FOUND);
  snap('(A2) 未知 missionId', await requestJson(contractRoute('session_0000000000000000', 'iv_x'), { expectedVersion: 0, idempotencyKey: 'k-miss', action: 'reject' }, { token }), 404, NOT_FOUND);

  // A3 非法:编码斜杠绕不过 id 白名单 -> 400 invalid_request。(裸 '..' 会先被 URL 规范化吃掉、
  // 落 404 api.route_not_found,那是另一层既有防御,不在本件快照范围。)
  snap('(A3) 非法 interventionId', await requestJson(contractRoute(sid, 'iv%2Fbad'), { expectedVersion: 0, idempotencyKey: 'k-bad', action: 'reject' }, { token }),
    400, { ok: false, reason: 'invalid_request', error: { code: 'intervention.invalid_request', params: {}, message: 'invalid missionId or interventionId' } });

  // A4 版本冲突:pending v0 + expectedVersion 3 -> 409 version_conflict(带 expected/actual 参数)。
  seedIv(sid, [pendingRow(sid, 'iv_conflict', 'permission')]);
  snap('(A4) 版本冲突', await requestJson(contractRoute(sid, 'iv_conflict'), { expectedVersion: 3, idempotencyKey: 'k-conflict', action: 'deny' }, { token }),
    409, { ok: false, reason: 'version_conflict', error: { code: 'intervention.version_conflict', params: { expectedVersion: 3, actualVersion: 0 }, message: 'intervention version does not match' } });

  // A5 不可送达:有 pending 账但无活 consumer(未挂内存注册表)-> 409 delivery_unavailable。
  seedIv(sid, [pendingRow(sid, 'iv_nolive', 'permission')]);
  snap('(A5) 不可送达', await requestJson(contractRoute(sid, 'iv_nolive'), { expectedVersion: 0, idempotencyKey: 'k-nolive', action: 'deny' }, { token }),
    409, { ok: false, reason: 'delivery_unavailable', error: { code: 'intervention.delivery_unavailable', params: {}, message: 'permission consumer is not live' } });

  // A6 过期/终态:expired -> 410;用户已决 denied -> 409 already_terminal。
  seedIv(sid, [pendingRow(sid, 'iv_expired', 'permission'), { ...pendingRow(sid, 'iv_expired', 'permission'), status: 'expired', decidedBy: 'auto', interventionVersion: 1 }]);
  snap('(A6) 过期', await requestJson(contractRoute(sid, 'iv_expired'), { expectedVersion: 0, idempotencyKey: 'k-expired', action: 'allow' }, { token }),
    410, { ok: false, reason: 'expired', error: { code: 'intervention.expired', params: { status: 'expired' }, message: 'intervention has expired' } });
  seedIv(sid, [pendingRow(sid, 'iv_done', 'permission'), { ...pendingRow(sid, 'iv_done', 'permission'), status: 'denied', decidedBy: 'user', decidedAt: new Date().toISOString(), interventionVersion: 1 }]);
  snap('(A6) 已终态', await requestJson(contractRoute(sid, 'iv_done'), { expectedVersion: 1, idempotencyKey: 'k-done', action: 'allow' }, { token }),
    409, { ok: false, reason: 'already_terminal', error: { code: 'intervention.already_terminal', params: { status: 'denied', interventionVersion: 1 }, message: 'intervention is already terminal' } });

  // A7 成功(replan reject:持久化 run 免活 consumer)+ A8 重放/键冲突。
  const RUN_ID = 'run_snap1';
  fs.mkdirSync(path.join(HOME, 'agent-runs', sid), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'agent-runs', sid, RUN_ID + '.json'), JSON.stringify({
    id: RUN_ID, sessionId: sid, status: 'succeeded', createdAt: new Date().toISOString(),
    replanPatches: [{ id: 'iv_replan', status: 'pending', summary: 'snapshot patch', triggerType: 'gate_rejected', nodeId: 'n1', createdAt: new Date().toISOString() }],
  }), 'utf8');
  seedIv(sid, [pendingRow(sid, 'iv_replan', 'replan', { runId: RUN_ID, summary: 'snapshot patch', triggerType: 'gate_rejected', nodeId: 'n1' })]);
  const successBody = { expectedVersion: 0, idempotencyKey: 'k-replan-ok', action: 'reject' };
  const success = await requestJson(contractRoute(sid, 'iv_replan'), successBody, { token });
  snap('(A7) 成功 replan reject', success, 200, {
    ok: true, missionId: sid, interventionId: 'iv_replan', type: 'replan', action: 'reject', status: 'rejected', interventionVersion: 2,
  });
  const replay = await requestJson(contractRoute(sid, 'iv_replan'), successBody, { token });
  ok(replay.status === 200 && canon(replay.json) === canon(success.json), '(A8) 同 key 同 payload 重放 -> 200 且与原响应逐字节一致');
  snap('(A8) 同 key 异 payload', await requestJson(contractRoute(sid, 'iv_replan'), { ...successBody, action: 'approve' }, { token }),
    409, { ok: false, reason: 'idempotency_conflict', error: { code: 'intervention.idempotency_conflict', params: {}, message: 'idempotencyKey was already used for a different request' } });

  // ─────────── B. legacy question 适配器(/api/chat/answer) ───────────
  snap('(B1) question 浏览器无 token', await requestJson('/api/chat/answer', { sessionId: sid, questionId: 'q_x', answers: [] }, { origin: 'http://evil.example' }), 403, AUTH_403);
  const Q_NOT_PENDING = { ok: false, error: { code: 'question.not_pending', params: {}, message: 'question is no longer pending' } };
  snap('(B2) 未知 questionId', await requestJson('/api/chat/answer', { sessionId: sid, questionId: 'q_missing', answers: [] }, { token }), 409, Q_NOT_PENDING);

  await restartFake({ FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'request_user_input', args: { questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] } }]) });
  let qAnswer = null, qDup = null, qid = '';
  await streamChat({ message: 'ask which framework' }, token, {
    onAsk: (streamSid, evt) => {
      qid = String(evt.questionId || evt.id || '');
      const askPromise = (async () => {
        qAnswer = await requestJson('/api/chat/answer', {
          sessionId: streamSid, questionId: qid,
          answers: [{ question: 'Which framework?', answer: ['Vue'] }], content: 'Which framework?: Vue',
        }, { token });
        qDup = await requestJson('/api/chat/answer', {
          sessionId: streamSid, questionId: qid,
          answers: [{ question: 'Which framework?', answer: ['Vue'] }], content: 'Which framework?: Vue',
        }, { token });
      })();
      cbsDone.push(askPromise);
    },
  });
  await Promise.all(cbsDone.splice(0)); // 等回调里的决策请求落地再断言
  ok(!!qid, '(B3) ask_user 事件到达');
  snap('(B3) question 成功', qAnswer, 200, { ok: true, delivered: true, questionId: qid });
  snap('(B4) question 重复决策', qDup, 409, Q_NOT_PENDING);

  // ─────────── C. legacy permission 适配器(/api/permission/decision) ───────────
  snap('(C1) permission 浏览器无 token', await requestJson('/api/permission/decision', { requestId: 'perm_x', behavior: 'deny' }, { origin: 'http://evil.example' }), 403, AUTH_403);
  // 真实行为:answerPermission 返回字符串 error,json() 统一包成 api.request_failed 信封(快照锁定现状)
  const P_UNKNOWN = { ok: false, error: { code: 'api.request_failed', params: {}, message: 'unknown or expired request' } };
  snap('(C2) 未知 requestId', await requestJson('/api/permission/decision', { requestId: 'perm_missing', behavior: 'deny' }, { token }), 404, P_UNKNOWN);

  const writeTarget = path.join(HOME, 'snap-target.txt');
  await restartFake({ FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'file_write', args: { path: writeTarget, content: 'snapshot' } }]) });
  let pDecision = null, pDup = null, permReqId = '';
  await streamChat({ message: 'write snapshot file' }, token, {
    onPermission: (streamSid, evt) => {
      permReqId = String(evt.requestId || '');
      cbsDone.push((async () => {
        pDecision = await requestJson('/api/permission/decision', { requestId: permReqId, behavior: 'deny', message: 'snapshot deny' }, { token });
        pDup = await requestJson('/api/permission/decision', { requestId: permReqId, behavior: 'deny' }, { token });
      })());
    },
  });
  await Promise.all(cbsDone.splice(0)); // 等回调里的决策请求落地再断言
  ok(!!permReqId, '(C3) permission_request 事件到达');
  snap('(C3) permission 成功', pDecision, 200, { ok: true });
  snap('(C4) permission 重复决策', pDup, 404, P_UNKNOWN);
  ok(!fs.existsSync(writeTarget), '(C3) deny 未落盘(file_write 被拒)');

  // ─────────── D. legacy plan 适配器(/api/plan/decision) ───────────
  snap('(D1) plan 无 token', await requestJson('/api/plan/decision', { sessionId: sid, planId: 'plan_x', decision: 'approve' }), 403, AUTH_403);
  // 历史形状锁:plan 适配器的「无挂起」错误是 200 + ok:false(不是 4xx),且字符串 error 被 json() 包成
  // api.request_failed 信封 —— 快照锁定,不在本波「修正」。
  snap('(D2) plan 无挂起(历史 200 形状)', await requestJson('/api/plan/decision', { sessionId: sid, planId: 'plan_missing', decision: 'approve' }, { token }),
    200, { ok: false, error: { code: 'api.request_failed', params: {}, message: 'no pending plan' } });

  // ─────────── E. legacy pool 适配器(POST /api/agent-runs/:runId) ───────────
  snap('(E1) pool 无 token', await requestJson('/api/agent-runs/run_x', { sessionId: sid, action: 'pool_reject', poolId: 'pool_x' }), 403, AUTH_403);
  // pool 适配器的参数/死 run 错误同样是字符串 error,经 json() 统一包成 api.request_failed 信封
  snap('(E2) pool 缺 ids', await requestJson('/api/agent-runs/run_x', { action: 'pool_reject', poolId: 'pool_x' }, { token }),
    400, { ok: false, error: { code: 'api.request_failed', params: {}, message: 'sessionId/runId required' } });
  snap('(E3) pool 缺 poolId', await requestJson('/api/agent-runs/run_x', { sessionId: sid, action: 'pool_reject' }, { token }),
    400, { ok: false, error: { code: 'api.request_failed', params: {}, message: 'poolId required' } });
  snap('(E4) pool 死 run', await requestJson('/api/agent-runs/run_dead', { sessionId: sid, action: 'pool_reject', poolId: 'pool_x' }, { token }),
    409, { ok: false, error: { code: 'api.request_failed', params: {}, message: '运行已结束;可在新运行中执行该任务' } });

  // ─────────── S. 静态锚:五端点+contract 路由在源码与 ROUTE_AUTH 的既定等级 ───────────
  ok(src.includes("pathname.match(/^\\/api\\/missions\\/([^/]+)\\/interventions\\/([^/]+)\\/decision$/)"), '(S) contract 路由仍在 13d');
  for (const p of ['/api/chat/answer', '/api/permission/decision', '/api/plan/decision']) {
    ok(src.includes(`pathname === '${p}'`), `(S) 适配器路由在源码: ${p}`);
  }
  ok(src.includes("auth: 'body-token'") && src.includes("auth: 'token-browser'"), '(S) ROUTE_AUTH 等级字面量仍在');

  console.log(fail ? `\nINTERVENTIONS SNAPSHOT E2E: FAIL (${fail})` : '\nINTERVENTIONS SNAPSHOT E2E: ALL PASS');
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('FATAL ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  kill(wb); kill(fake);
}
})();

process.on('unhandledRejection', e => { console.error('UNHANDLED ' + (e && e.stack || e)); process.exitCode = 1; });
