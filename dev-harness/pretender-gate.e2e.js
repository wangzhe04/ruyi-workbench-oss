(async () => {
'use strict';
// E2E(第56波 Pretender 立项门):全局「需要你」聚合 + 任务单五态派生 + 四旅程数据面 + PoC 接线。
// 覆盖:
//  (a) GET /api/interventions 全局收件箱:无 token 403;question pending 时出现(type/sessionId/live/计数);
//      决策后消失;counts 含 pool 键。
//  (b) 五态派生(mission-state.js 纯函数,node 直接 require):quick_ask 逃生舱 / needs_you(真实 pending)/
//      dispatching(刚立单)/ done(complete 章)/ stopped(stop 章+supervised)/ running(until-done);
//      fromCard 与 fromSnapshot 一致(同一事实两种投影)。
//  (c) 四旅程数据面:单任务(result+checkpoints+acceptance)/ 长任务(cursor+usage)/ 多 Agent(runs digest)/
//      Quick Ask(kind 显式且不进 /api/missions)。
//  (d) 静态锁:ROUTE_AUTH 裸路径条目、handler 分支、activeTurn 投影、PoC 引用 mission-state.js 与真实 API。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-pretender-gate-e2e');
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

// fake provider:首个 user 消息触发 request_user_input;答了 Vue 后纯文本收尾(与 interventions-persist 同型)。
function startProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || (req.url || '').includes('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fake-model"}]}'); }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
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
// 发 /api/chat/stream 并保持(问题 pending 期间做其它断言);answer 由调用方稍后发。
function streamOpen(body, token) {
  const state = { events: [], sid: '', questionId: '', done: null };
  state.done = new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); let buf = '';
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token } }, res => {
      const consume = line => { if (!line.trim()) return; let evt; try { evt = JSON.parse(line); } catch { return; } state.events.push(evt); if (evt.type === 'session' && evt.session && evt.session.id) state.sid = evt.session.id; if (evt.type === 'ask_user' && !state.questionId) state.questionId = evt.questionId || evt.id; };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); consume(line); } });
      res.on('end', () => { consume(buf); resolve(state); });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
  return state;
}
function spawnWb() {
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true });
}

(async () => {
  const src = readServerSource();
  const MissionState = require(path.join(WB, 'app', 'public', 'js', 'mission-state.js'));
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

    // ── 准备:s1 立单(autoMode off);s2 长任务(until-done);s3 速问 ──
    const s1 = (await requestJson(WB_PORT, '/api/sessions', { title: 'gate-s1' }, token)).json.session.id;
    await requestJson(WB_PORT, '/api/mission', { action: 'start', sessionId: s1, token, mission: { goal: '立项门旅程', milestones: [{ id: 'm1', desc: '步骤一' }, { id: 'm2', desc: '步骤二' }] } }, token);
    const s2 = (await requestJson(WB_PORT, '/api/sessions', { title: 'gate-s2' }, token)).json.session.id;
    await requestJson(WB_PORT, '/api/mission', { action: 'start', sessionId: s2, token, autoMode: 'until-done', mission: { goal: '长任务', autoMode: 'until-done', milestones: [{ id: 'm1', desc: '长步骤' }] } }, token);
    const s3 = (await requestJson(WB_PORT, '/api/sessions', { title: 'gate-s3-quick' }, token)).json.session.id;

    // (b-1) dispatching:刚立单、无执行痕迹
    let cards = (await requestJson(WB_PORT, '/api/missions', null, token)).json.missions;
    const cardS1 = () => cards.find(c => c.sessionId === s1);
    ok(MissionState.fromCard(cardS1()).state === 'dispatching', '(b) 刚立单 -> 交办中 dispatching');

    // ── (a)+(b-2):发起带提问的回合(保持 pending)──
    const stream = streamOpen({ sessionId: s1, message: 'ask which framework' }, token);
    let qSeen = null;
    for (let i = 0; i < 80 && !qSeen; i++) {
      const g = await requestJson(WB_PORT, '/api/interventions', null, token);
      if (g.json && Array.isArray(g.json.pending) && g.json.pending.some(iv => iv.type === 'question' && iv.sessionId === s1)) qSeen = g.json;
      else await sleep(100);
    }
    ok(!!qSeen, '(a) 全局收件箱出现 pending question(跨会话聚合)');
    const qItem = qSeen && qSeen.pending.find(iv => iv.sessionId === s1);
    ok(!!qItem && qItem.type === 'question' && qItem.live === true && !!qItem.requestedAt, '(a) 收件箱条目:type/sessionId/requestedAt/live(活回合可即时决策)');
    ok(qSeen.counts && qSeen.counts.question === 1 && qSeen.counts.total === 1 && typeof qSeen.counts.pool === 'number', '(a) counts 分型计数(含 pool 键)');
    const noTok = await requestJson(WB_PORT, '/api/interventions', null, null);
    ok(noTok.status === 403, '(a) 无 token -> 403(ROUTE_AUTH token-browser)');

    // (b-2) needs_you:真实 pending 驱动鎏金态(哪怕回合在跑)
    cards = (await requestJson(WB_PORT, '/api/missions', null, token)).json.missions;
    ok(MissionState.fromCard(cardS1()).state === 'needs_you', '(b) 有未决 -> 需要你 needs_you(鎏金优先)');
    const snap1 = (await requestJson(WB_PORT, '/api/missions/' + s1, null, token)).json.snapshot;
    ok(snap1.activeTurn === true, '(b) 快照 activeTurn=true(活回合投影)');
    ok(MissionState.fromSnapshot(snap1).state === 'needs_you', '(b) fromSnapshot 与 fromCard 同态(needs_you)');

    // 决策 -> 收件箱清空
    await requestJson(WB_PORT, '/api/chat/answer', { sessionId: s1, questionId: stream.questionId || qItem.id, answers: [{ question: 'Which framework?', answer: ['Vue'] }], content: 'Which framework?: Vue' }, token);
    await stream.done;
    let cleared = false;
    for (let i = 0; i < 40 && !cleared; i++) {
      const g = await requestJson(WB_PORT, '/api/interventions', null, token);
      if (g.json && g.json.counts && g.json.counts.total === 0) cleared = true; else await sleep(100);
    }
    ok(cleared, '(a) 决策后收件箱清空(不重复出现)');

    // (b-3) done:全里程碑 done -> complete 章 -> 已收工
    await requestJson(WB_PORT, '/api/mission', { action: 'update', sessionId: s1, token, patch: { milestones: [{ id: 'm1', status: 'done' }, { id: 'm2', status: 'done' }] } }, token);
    cards = (await requestJson(WB_PORT, '/api/missions', null, token)).json.missions;
    const d1 = MissionState.fromCard(cardS1());
    ok(d1.state === 'done', '(b) 全 done -> 已收工 done(结果章驱动)');
    ok(d1.sources && d1.sources.resultStatus === 'complete', '(b) 派生证据可查(sources.resultStatus)');

    // (b-4) stopped:stop 章 -> 已停工;supervised(预算耗尽待命)同态
    await requestJson(WB_PORT, '/api/mission', { action: 'update', sessionId: s1, token, patch: { milestones: [{ id: 'm3', desc: '追加', status: 'pending' }] } }, token);
    await requestJson(WB_PORT, '/api/mission', { action: 'stop', sessionId: s1, token }, token);
    cards = (await requestJson(WB_PORT, '/api/missions', null, token)).json.missions;
    ok(MissionState.fromCard(cardS1()).state === 'stopped', '(b) stop 章 -> 已停工 stopped');
    const dS = MissionState.deriveMissionState({ kind: 'mission', autoMode: 'supervised', budgetExhausted: true, pending: {}, runCount: 1, turnSeq: 3, milestonesDone: 1 });
    ok(dS.state === 'stopped', '(b) supervised/预算耗尽 -> 已停工(合成态补充)');

    // (b-5) running:until-done 驱动中
    cards = (await requestJson(WB_PORT, '/api/missions', null, token)).json.missions;
    ok(MissionState.fromCard(cards.find(c => c.sessionId === s2)).state === 'running', '(b) until-done -> 进行中 running');

    // (b-6) quick_ask 逃生舱
    ok(MissionState.deriveMissionState({ kind: 'quick_ask', pending: { questions: 1 } }).state === 'quick_ask', '(b) quick_ask 不硬套五态(有未决也不鎏金化任务态)');

    // ── (c) 四旅程数据面 ──
    const snapDone = (await requestJson(WB_PORT, '/api/missions/' + s1, null, token)).json.snapshot;
    ok(!!snapDone.result && snapDone.result.status === 'stopped' && snapDone.result.unfinished.length === 1, '(c) 单任务:结果章(stopped + 未完成项 m3)');
    ok(snapDone.checkpoints && typeof snapDone.checkpoints.rollbackAvailable === 'boolean' && snapDone.acceptance.total === 3, '(c) 单任务:回滚引用 + 验收计数');
    ok(snapDone.cursor && snapDone.cursor.turnSeq >= 1 && snapDone.usage && snapDone.usage.turns >= 1, '(c) 长任务:游标 turnSeq + 用量切片');
    // 多 Agent:播种 run 快照(与 71b 同配方),断言 runs digest 数据面
    fs.mkdirSync(path.join(HOME, 'agent-runs', s1), { recursive: true });
    fs.writeFileSync(path.join(HOME, 'agent-runs', s1, 'run_abc1.json'), JSON.stringify({
      schemaVersion: 4,
      id: 'run_abc1',
      sessionId: s1,
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      concurrency: 2,
      taskPool: [{ id: 'pool_review', status: 'proposed', proposedBy: 'n1', task: 'review the delivery', reason: 'final check', roleId: 'reviewer', dependsOn: ['n1'] }],
      messages: [],
      poolPolicy: 'manual',
      poolAutoCap: 3,
      eventSeq: 7,
      nodes: [{
        id: 'n1',
        status: 'succeeded',
        roleId: 'explorer',
        roleLabel: 'Reader',
        task: 'read the source',
        dependsOn: [],
        engine: 'openai',
        model: 'fake-model',
        result: 'x'.repeat(24000),
        roleSnapshot: { large: true },
        toolEvidence: [{ tool: 'file_read' }],
        progressLog: [{ text: 'started' }, { text: 'latest compact progress' }],
      }],
    }), 'utf8');
    const snapRuns = (await requestJson(WB_PORT, '/api/missions/' + s1, null, token)).json.snapshot;
    const rd = snapRuns.runs && snapRuns.runs[0];
    ok(rd && rd.nodes && rd.nodes[0] && rd.nodes[0].roleLabel === 'Reader' && rd.nodes[0].progress === 'latest compact progress' && rd.nodes[0].steerable === false && rd.nodes[0].steerReason === 'not_live' && rd.proposals && rd.proposals[0] && rd.proposals[0].id === 'pool_review', '(c) multi-agent compact graph keeps presentation/steer facts and proposed pool work');
    ok(rd && !Object.hasOwn(rd.nodes[0], 'result') && !Object.hasOwn(rd.nodes[0], 'roleSnapshot') && !Object.hasOwn(rd.nodes[0], 'toolEvidence') && !Object.hasOwn(rd.nodes[0], 'progressLog'), '(c) multi-agent compact graph omits large node payloads');
    ok(!!rd && rd.status === 'succeeded' && rd.eventSeq === 7 && rd.nodeCount === 1 && typeof rd.poolPending === 'number' && rd.live === false, '(c) 多 Agent:runs digest(状态/eventSeq/节点数/池/活标志)= 班组图数据面');
    ok(typeof snapRuns.cursor.runs.run_abc1 === 'number', '(c) 多 Agent:游标含 run eventSeq(增量消费位置令牌)');
    // Quick Ask:kind 显式 + 不进任务列表
    const sessList = (await requestJson(WB_PORT, '/api/sessions', null, token)).json.sessions;
    ok(sessList.some(s => s.id === s3 && s.kind === 'quick_ask'), '(c) Quick Ask:会话 meta kind 显式');
    cards = (await requestJson(WB_PORT, '/api/missions', null, token)).json.missions;
    ok(!cards.some(c => c.sessionId === s3), '(c) Quick Ask 不进 /api/missions(不制造任务收工语义)');

    // ── (d) 静态锁 ──
    console.log('\n── [d] 静态锁 ──');
    ok(/\{ m: 'GET', p: '\/api\/interventions', auth: 'token-browser' \}/.test(src), "d 01-config ROUTE_AUTH 裸路径 '/api/interventions' token-browser");
    ok(/if \(req\.method === 'GET' && pathname === '\/api\/interventions'\)/.test(src), 'd 13d 全局聚合 handler 分支');
    ok(/activeTurn: activeChildren\.has\(sessionId\)/.test(src) && /activeTurn: opts\.persistent \? false : activeChildren\.has\(head\.id\)/.test(src) && /function overlayMissionCard\(slice\)/.test(src), 'd 75c activeTurn 分层(快照 live + 卡片持久事实后叠 overlay)');
    const ms = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'mission-state.js'), 'utf8');
    ok(/module\.exports = api/.test(ms) && /typeof window !== 'undefined'/.test(ms), 'd mission-state.js 双导出(node + window)');
    ok(/'dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask'/.test(ms), 'd 五态 + 速问 状态集完整');
    const poc = fs.readFileSync(path.join(ROOT, 'docs', 'mockups', 'vnext-poc.html'), 'utf8');
    ok(/mission-state\.js/.test(poc) && /\/api\/interventions/.test(poc) && /\/api\/missions/.test(poc), 'd PoC 引用五态纯函数 + 真实 API(不复制逻辑)');
    ok(/MissionState\.fromCard/.test(poc) && /MissionState\.fromSnapshot/.test(poc), 'd PoC 卡片/快照双适配消费');

  } finally {
    kill(wb); await new Promise(r => provider.close(r));
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nPRETENDER GATE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
})();
