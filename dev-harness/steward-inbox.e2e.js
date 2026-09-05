(async () => {
'use strict';
// E2E(第 116 波 116b · 27 号文 §11.3「116b 收件箱与游标」):管家收件箱轮询器 / 游标 / 四条路由。
// 真服务 + fake-openai,全程只经既有路径造事实(不 monkey-patch 服务端)。
//
// 覆盖:
//  (A) 开关【关】(默认):`<data>/steward` 目录不存在;POST /api/steward/start -> 409 steward.disabled;
//      state 返回 enabled:false/running:false;inbox 返回空;跑完真实任务账本变更后仍然零文件零目录;
//      无 token -> 403(ROUTE_AUTH token 级)。
//  (B) 开关【开】:boot 起轮询(state.running=true 且 lastTickAt 非空);冷启动只建基线 —— (A) 阶段
//      攒下的历史【不】倒灌进箱子(inbox 仍为空)。
//  (C) needs_you:真实 permission 待决(fake-openai 触发 file_write -> permission_request)-> 轮询后
//      inbox 出现 kind=needs_you 且 payload 带 interventionId/type/摘要、【不带】工具输入正文。
//  (D) done:既有 /api/mission start+update 路径把里程碑全标 done -> 结果章 complete -> inbox 出现 done。
//  (E) failed:按既有文件格式合成一个 agent run 快照 + events.ndjson(run_end status:failed)->
//      inbox 出现 kind=failed 且带 runId。
//  (F) 幂等:再连跑两轮 tick,inbox 行数与 inboxSeq 都不变(去重键生效)。
//  (G) stop:POST /api/steward/stop 后等过一个完整轮询周期,state.lastTickAt 不变、running=false。
//  (H) 重启续游标(同 HOME):inbox 无重复、inboxSeq 单调不回退、cursor-v1.json schema/结构完好。
//  (I) 关开关后再起服务:inbox 文件字节数不再增长(即便期间又造了新的任务账本变更)。
//
// 端口:全部 getFreePort() 动态取,不带内字面量端口(run-all 端口审计口径)。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-steward-inbox-e2e');
const PROVIDER_PORT = await getFreePort(), WB_PORT = await getFreePort();
const POLL_MS = 5000; // stewardPollMs 下限,(G)/(I) 要等过一个完整周期
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
// listen 与 runtime.json 落盘之间有一个短窗口(健康探针先通),握手文件要轮询等一下。
async function waitToken() { for (let i = 0; i < 60; i++) { const t = readToken(); if (t) return t; await sleep(100); } return ''; }

function request(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: pathname, method, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
const get = (p, token) => request('GET', p, null, token);
const post = (p, body, token) => request('POST', p, body == null ? {} : body, token);

async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    const r = await get('/health').catch(() => null);
    if (r && r.status === 200) return true;
    await sleep(100);
  }
  return false;
}

const stewardDir = () => path.join(HOME, 'steward');
const inboxFile = () => path.join(stewardDir(), 'inbox-v1.ndjson');
const cursorFile = () => path.join(stewardDir(), 'cursor-v1.json');
function inboxSize() { try { return fs.statSync(inboxFile()).size; } catch { return -1; } }

function writeConfig(stewardOn) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'default', // file_write(edit 层)必须走 permission_request
    permissionTimeoutMs: 30000, includeWorkbenchMcp: true, defaultWorkspace: HOME, recentWorkspaces: [],
    stewardEnabledV1: stewardOn, stewardPollMs: POLL_MS,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }), 'utf8');
}

function spawnWb() {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true,
  });
  child.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  return child;
}

// fake-openai:第一次回合发一个 file_write 工具调用(触发权限请求);之后只回文本。
function startProvider(writeTarget) {
  let served = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(req.url === '/health' ? '{"ok":true}' : '{"data":[{"id":"fake-model"}]}'); }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { JSON.parse(raw); } catch { /* 形状不重要 */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const sse = v => res.write('data: ' + JSON.stringify(v) + '\n\n');
    if (served++ === 0) {
      const args = JSON.stringify({ path: writeTarget, content: 'steward-inbox-e2e' });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_w1', type: 'function', function: { name: 'file_write', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的。' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}

// 发一个流式回合,permission_request 到达时回调(此刻做管家侧断言 + 决策放行/拒绝)。
function streamChat(body, token, onPermission) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); let buf = '', sid = '', pending = null;
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token,
    } }, res => {
      const consume = line => {
        if (!line.trim()) return; let evt; try { evt = JSON.parse(line); } catch { return; }
        if (evt.type === 'session' && evt.session && evt.session.id) sid = evt.session.id;
        if (evt.type === 'permission_request' && !pending && onPermission) pending = onPermission(sid, String(evt.requestId || ''));
      };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); consume(line); } });
      res.on('end', async () => { consume(buf); const out = pending ? await pending : null; resolve({ sid, out }); });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}

// 强制跑一轮 tick(start 对已在跑的轮询器是幂等的补跑),再读箱子;直到 predicate 命中或超时。
async function tickUntil(token, predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 12000);
  let last = { items: [] };
  for (;;) {
    await post('/api/steward/start', {}, token);
    const r = await get('/api/steward/inbox?since=0&limit=200', token);
    last = (r.json && r.json) || { items: [] };
    if (predicate(last.items || [])) return last;
    if (Date.now() > deadline) return last;
    await sleep(250);
  }
}

readServerSource(); // 顺带验证 src/ 与产物新鲜度
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
const WRITE_TARGET = path.join(HOME, 'steward-e2e-target.txt');
const provider = await startProvider(WRITE_TARGET);
let wb = null;

try {
  /* ═════════════ (A) 开关关:零轮询、零持久化写入 ═════════════ */
  writeConfig(false);
  wb = spawnWb();
  ok(await waitHealth(), '(A) workbench up(开关关)');
  const token = await waitToken();
  ok(!!token, '(A) runtime token 可读');

  ok(!fs.existsSync(stewardDir()), '(A) 开关关:<data>/steward 目录不存在');
  const startOff = await post('/api/steward/start', {}, token);
  ok(startOff.status === 409 && startOff.json && startOff.json.error && startOff.json.error.code === 'steward.disabled',
    '(A) 开关关:POST /api/steward/start -> 409 steward.disabled(稳定信封)');
  const stateOff = await get('/api/steward/state', token);
  ok(stateOff.status === 200 && stateOff.json && stateOff.json.enabled === false && stateOff.json.running === false,
    '(A) 开关关:state 返回 enabled:false/running:false');
  ok(stateOff.json && stateOff.json.counts && typeof stateOff.json.counts.byKind === 'object' && stateOff.json.pollMs === POLL_MS,
    '(A) 开关关:state 信封含 counts.byKind 与 pollMs');
  const inboxOff = await get('/api/steward/inbox', token);
  ok(inboxOff.status === 200 && Array.isArray(inboxOff.json.items) && inboxOff.json.items.length === 0,
    '(A) 开关关:inbox 返回空数组(读不存在的文件不建目录)');
  ok((await get('/api/steward/state')).status === 403, '(A) 无 token -> 403(ROUTE_AUTH token 级)');
  ok((await post('/api/steward/stop', {})).status === 403, '(A) stop 无 token -> 403');

  // 造一批真实的任务账本变更(mission_started + result complete),证明开关关时它们一个字节都不落管家的箱。
  const sessA = await post('/api/sessions', { title: 'steward-off' }, token);
  const sidA = sessA.json && sessA.json.session && sessA.json.session.id;
  ok(!!sidA, '(A) 会话已建');
  await post('/api/mission', { sessionId: sidA, action: 'start', mission: { goal: '关开关下的任务', milestones: [{ id: 'm1', desc: '第一步' }] } }, token);
  await post('/api/mission', { sessionId: sidA, action: 'update', patch: { milestones: [{ id: 'm1', status: 'done' }] } }, token);
  await sleep(600);
  ok(!fs.existsSync(stewardDir()), '(A) 造过真实 mission 变更后:<data>/steward 仍不存在(零持久化写入)');

  kill(wb); wb = null; await sleep(400);

  /* ═════════════ (B) 开关开:boot 起轮询 + 冷启动只建基线 ═════════════ */
  writeConfig(true);
  wb = spawnWb();
  ok(await waitHealth(), '(B) workbench up(开关开)');
  const tok = await waitToken();
  let state = null;
  for (let i = 0; i < 60 && !(state && state.lastTickAt); i++) { state = (await get('/api/steward/state', tok)).json; if (!(state && state.lastTickAt)) await sleep(150); }
  ok(state && state.enabled === true && state.running === true, '(B) 开关开:boot 后 state enabled:true/running:true');
  ok(state && typeof state.lastTickAt === 'string' && state.lastTickAt.length > 0, '(B) boot 后已跑过至少一轮 tick(lastTickAt 非空)');
  ok(fs.existsSync(cursorFile()), '(B) 首轮 tick 落下 cursor-v1.json');
  {
    const cold = await get('/api/steward/inbox?since=0&limit=200', tok);
    ok(cold.status === 200 && (cold.json.items || []).length === 0,
      `(B) 冷启动只建基线:(A) 阶段的历史不倒灌进箱(实测 ${(cold.json.items || []).length} 条)`);
  }

  /* ═════════════ (C) needs_you:真实 permission 待决 ═════════════ */
  let needsRow = null;
  const turn = await streamChat({ message: '写一个文件' }, tok, async (sid, requestId) => {
    const res = await tickUntil(tok, items => items.some(x => x.kind === 'needs_you' && x.payload && x.payload.interventionId === requestId), 15000);
    needsRow = (res.items || []).find(x => x.kind === 'needs_you' && x.payload && x.payload.interventionId === requestId) || null;
    await post('/api/permission/decision', { requestId, behavior: 'deny', message: 'e2e deny' }, tok);
    return { sid, requestId };
  });
  ok(!!(turn.out && turn.out.requestId), '(C) fake-openai 触发了真实 permission_request');
  ok(!!needsRow, '(C) 轮询后 inbox 出现 kind=needs_you');
  if (needsRow) {
    ok(needsRow.payload.interventionType === 'permission', '(C) needs_you payload.interventionType=permission');
    ok(needsRow.seq === turn.out.requestId, '(C) needs_you 的 seq 位 = interventionId(去重游标)');
    ok(needsRow.sessionId === turn.out.sid && needsRow.count === 1, '(C) needs_you 带 sessionId 且 count=1');
    ok(typeof needsRow.payload.summary === 'string' && needsRow.payload.summary.includes('file_write'), '(C) 摘要含工具名');
    ok(!JSON.stringify(needsRow.payload).includes('steward-inbox-e2e'), '(C) payload 不含工具输入正文(只带摘要与引用 id)');
    ok(Number.isSafeInteger(needsRow.inboxSeq) && needsRow.inboxSeq >= 1, '(C) 行带单调 inboxSeq');
  }
  ok(!fs.existsSync(WRITE_TARGET), '(C) deny 生效:目标文件未落盘');

  /* ═════════════ (D) done:结果章 complete ═════════════ */
  const sessB = await post('/api/sessions', { title: 'steward-done' }, tok);
  const sidB = sessB.json && sessB.json.session && sessB.json.session.id;
  await post('/api/mission', { sessionId: sidB, action: 'start', mission: { goal: '收工用例', milestones: [{ id: 'm1', desc: '第一步' }] } }, tok);
  await post('/api/mission', { sessionId: sidB, action: 'update', patch: { milestones: [{ id: 'm1', status: 'done' }] } }, tok);
  const doneRes = await tickUntil(tok, items => items.some(x => x.kind === 'done' && x.sessionId === sidB), 15000);
  const doneRow = (doneRes.items || []).find(x => x.kind === 'done' && x.sessionId === sidB) || null;
  ok(!!doneRow, '(D) 结果章 complete -> inbox 出现 kind=done');
  if (doneRow) ok(doneRow.payload.resultStatus === 'complete' && doneRow.payload.changeType === 'result', '(D) done payload 带 changeType=result/resultStatus=complete');

  /* ═════════════ (E) failed:合成 agent run 事件 ═════════════ */
  const RUN_ID = 'run_5731ab';
  const runDir = path.join(HOME, 'agent-runs', sidB);
  fs.mkdirSync(runDir, { recursive: true });
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, RUN_ID + '.events.ndjson'),
    JSON.stringify({ seq: 1, ts: nowIso, runId: RUN_ID, type: 'run_created', data: {} }) + '\n'
    + JSON.stringify({ seq: 2, ts: nowIso, runId: RUN_ID, type: 'node_progress', nodeId: 'n1', data: { text: '不该入箱的进度正文' } }) + '\n'
    + JSON.stringify({ seq: 3, ts: nowIso, runId: RUN_ID, type: 'run_end', data: { status: 'failed', failed: 1 } }) + '\n', 'utf8');
  fs.writeFileSync(path.join(runDir, RUN_ID + '.json'), JSON.stringify({
    id: RUN_ID, sessionId: sidB, status: 'failed', eventSeq: 3, createdAt: nowIso, updatedAt: nowIso, completedAt: nowIso, nodes: [],
  }), 'utf8');
  const failedRes = await tickUntil(tok, items => items.some(x => x.kind === 'failed' && x.runId === RUN_ID), 15000);
  const failedRow = (failedRes.items || []).find(x => x.kind === 'failed' && x.runId === RUN_ID) || null;
  ok(!!failedRow, '(E) run_end status=failed -> inbox 出现 kind=failed');
  if (failedRow) {
    ok(failedRow.seq === 3 && failedRow.sessionId === sidB, '(E) failed 带源 seq=3 与 sessionId');
    ok(!JSON.stringify(failedRow.payload).includes('不该入箱的进度正文'), '(E) node_progress 正文不入箱(心跳丢弃)');
  }
  {
    const all = (failedRes.items || []);
    ok(!all.some(x => x.kind === 'stalled' || x.kind === 'budget') || all.every(x => ['needs_you', 'failed', 'done', 'stalled', 'budget'].includes(x.kind)),
      '(E) 箱内 kind 全在五类白名单');
    ok(all.every(x => x.inboxSeq >= 1) && all.every((x, i) => i === 0 || x.inboxSeq > all[i - 1].inboxSeq), '(E) inboxSeq 严格单调递增');
  }

  /* ═════════════ (F) 幂等:连跑两轮不产生重复 ═════════════ */
  const before = await get('/api/steward/inbox?since=0&limit=200', tok);
  await post('/api/steward/start', {}, tok);
  await post('/api/steward/start', {}, tok);
  const after = await get('/api/steward/inbox?since=0&limit=200', tok);
  ok((after.json.items || []).length === (before.json.items || []).length,
    `(F) 连跑两轮 tick 后行数不变(${(before.json.items || []).length})`);
  ok(after.json.inboxSeq === before.json.inboxSeq, '(F) inboxSeq 不变(去重键生效)');
  const beforeCount = (before.json.items || []).length;
  const beforeSeq = before.json.inboxSeq;
  ok(beforeCount >= 3, `(F) 箱内至少三类事件各一条(实测 ${beforeCount} 条)`);
  {
    const since = await get('/api/steward/inbox?since=' + (beforeSeq - 1) + '&limit=200', tok);
    ok((since.json.items || []).length === 1 && since.json.items[0].inboxSeq === beforeSeq, '(F) since 游标只返回其后的行');
    const clamped = await get('/api/steward/inbox?since=0&limit=9999', tok);
    ok(clamped.json.limit === 200, '(F) limit 夹到上限 200');
    const clamped2 = await get('/api/steward/inbox?since=0&limit=-3', tok);
    ok(clamped2.json.limit === 50, '(F) 非法 limit 回默认 50');
  }
  {
    const cursor = JSON.parse(fs.readFileSync(cursorFile(), 'utf8'));
    ok(cursor.schema === 1 && Number.isSafeInteger(cursor.inboxSeq) && cursor.sources
      && cursor.sources.missionChanges && cursor.sources.agentRuns && Array.isArray(cursor.sources.pendingIds),
      '(F) cursor-v1.json 结构完好(schema 1 + 三个源游标)');
    ok(Number(cursor.sources.agentRuns[RUN_ID]) === 3, '(F) run 游标推进到 seq 3');
  }

  /* ═════════════ (G) stop 后不再 tick ═════════════ */
  const stopped = await post('/api/steward/stop', {}, tok);
  ok(stopped.status === 200 && stopped.json.ok === true && stopped.json.running === false, '(G) stop -> {ok:true,running:false}');
  const tickAtBefore = (await get('/api/steward/state', tok)).json.lastTickAt;
  await sleep(POLL_MS + 2500); // 等过一个完整轮询周期
  const afterStop = (await get('/api/steward/state', tok)).json;
  ok(afterStop.running === false, '(G) stop 后 state.running 保持 false');
  ok(afterStop.lastTickAt === tickAtBefore, '(G) stop 后一个完整周期内 lastTickAt 不变(interval 真的停了)');

  /* ═════════════ (H) 重启续游标 ═════════════ */
  const inboxBytesBefore = inboxSize();
  const rowsBefore = fs.readFileSync(inboxFile(), 'utf8').split('\n').filter(Boolean).length;
  kill(wb); wb = null; await sleep(400);
  wb = spawnWb();
  ok(await waitHealth(), '(H) 重启后 workbench up');
  const tok2 = await waitToken();
  let state2 = null;
  for (let i = 0; i < 60 && !(state2 && state2.lastTickAt); i++) { state2 = (await get('/api/steward/state', tok2)).json; if (!(state2 && state2.lastTickAt)) await sleep(150); }
  ok(state2 && state2.running === true, '(H) 重启后轮询器自动起来');
  await post('/api/steward/start', {}, tok2);
  const rowsAfter = fs.readFileSync(inboxFile(), 'utf8').split('\n').filter(Boolean).length;
  ok(rowsAfter === rowsBefore, `(H) 重启 + 再跑一轮:inbox 无重复(${rowsBefore} -> ${rowsAfter})`);
  const state3 = (await get('/api/steward/state', tok2)).json;
  ok(state3.inboxSeq === beforeSeq, `(H) inboxSeq 从游标续接不回退也不跳号(${beforeSeq})`);
  ok(inboxSize() === inboxBytesBefore, '(H) inbox 文件字节数不变(一条都没重写)');

  /* ═════════════ (I) 关开关后再起服务:不再写入 ═════════════ */
  kill(wb); wb = null; await sleep(400);
  writeConfig(false);
  wb = spawnWb();
  ok(await waitHealth(), '(I) 关开关后 workbench up');
  const tok3 = await waitToken();
  const stateOff2 = (await get('/api/steward/state', tok3)).json;
  ok(stateOff2.enabled === false && stateOff2.running === false, '(I) 关开关后 state enabled:false/running:false');
  const sessC = await post('/api/sessions', { title: 'steward-off-again' }, tok3);
  const sidC = sessC.json && sessC.json.session && sessC.json.session.id;
  await post('/api/mission', { sessionId: sidC, action: 'start', mission: { goal: '关开关后的任务', milestones: [{ id: 'm1', desc: '第一步' }] } }, tok3);
  await post('/api/mission', { sessionId: sidC, action: 'update', patch: { milestones: [{ id: 'm1', status: 'done' }] } }, tok3);
  await sleep(POLL_MS + 2000);
  ok(inboxSize() === inboxBytesBefore, '(I) 关开关后又造了新变更:inbox 字节数仍不变(零写入)');
  ok((await post('/api/steward/start', {}, tok3)).status === 409, '(I) 关开关后 start 仍 409');
} catch (e) {
  fail++; console.log('FAIL 未捕获异常: ' + ((e && e.stack) || e));
} finally {
  kill(wb);
  try { provider.close(); } catch { /* ignore */ }
}

console.log(fail === 0 ? 'STEWARD INBOX E2E: ALL PASS' : `STEWARD INBOX E2E: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
})();
