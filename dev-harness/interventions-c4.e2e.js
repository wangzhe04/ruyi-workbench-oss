(async () => {
'use strict';
// E2E(第75a波 切片三 / C4):provider 回合内路由突变 mission 不被回合收尾盖回。
// 覆盖(C4,PLAN §2.3/§4 第75a波):
//  (a) provider 回合进行中(ask_user 暂停窗口)POST /api/mission update 加里程碑 m2 -> 回合收尾 saveSession
//      不盖回(13d C4 同步:把路由 mission 变更同步进活动回合内存 session.mission,回合收尾 save 写入)。
//      断言:回合后 mission.milestones 含 m2(若盖回则丢失)。
//  (b) 对照:update 在回合外(无活动回合)正常落盘(基线,非 C4 路径)。
//  (c) 静态锁:C4 同步块(action === 'update' && reg.session.mission -> applyMissionUpdate)在 server.js。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-c4-e2e');
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
function headPath(sid) { return path.join(HOME, 'sessions', sid + '.json'); }
function readMission(sid) { try { return JSON.parse(fs.readFileSync(headPath(sid), 'utf8')).mission || null; } catch { return null; } }
function spawnWb() {
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true });
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
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'got Vue, done' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}
function streamWithQuestion(body, token, onAsk) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = ''; let sid = body.sessionId || ''; let questionId = ''; let answerPromise = null;
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token } }, res => {
      const consume = line => {
        if (!line.trim()) return; let evt; try { evt = JSON.parse(line); } catch { return; }
        events.push(evt);
        if (evt.type === 'session' && evt.session?.id) sid = evt.session.id;
        if (evt.type === 'ask_user' && !questionId) { questionId = evt.questionId || evt.id; if (onAsk && !answerPromise) answerPromise = onAsk(sid, questionId, evt); }
      };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); consume(line); } });
      res.on('end', async () => { consume(buf); const a = answerPromise ? await answerPromise : null; resolve({ events, sid, questionId, answerResp: a }); });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
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
    let token = readToken(); ok(!!token, 'runtime token');
    const sess = await requestJson(WB_PORT, '/api/sessions', { title: 'c4' }, token);
    const sid = sess.json.session.id;
    await requestJson(WB_PORT, '/api/mission', { sessionId: sid, action: 'start', mission: { goal: 'C4 test', milestones: [{ id: 'm1', desc: 'base' }] } }, token);
    ok((readMission(sid)?.milestones || []).some(m => m.id === 'm1'), 'start mission with m1');

    // ============ (a) C4:回合内路由突变不被盖回 ============
    // 流式发问 -> ask_user 暂停 -> 暂停窗口内 POST /api/mission update 加 m2 -> answer -> 回合收尾 save。
    // 13d C4 同步把 m2 写进活动回合内存 session.mission -> 回合收尾 save 不盖回。
    const turn = await streamWithQuestion({ sessionId: sid, message: 'ask which framework' }, token, async (s, qid) => {
      // 暂停窗口内:路由突变加里程碑 m2(update patch = top-level milestones)
      const upd = await requestJson(WB_PORT, '/api/mission', { sessionId: s, action: 'update', milestones: [{ id: 'm2', desc: 'route-during-turn', status: 'pending' }] }, token);
      ok(upd.status === 200 && upd.json?.ok === true, '(a) 暂停窗口内 POST /api/mission update(加 m2)');
      // 再 answer 让回合继续
      return requestJson(WB_PORT, '/api/chat/answer', { sessionId: s, questionId: qid, answers: [{ question: 'Which framework?', answer: ['Vue'] }], content: 'Which framework?: Vue' }, token);
    });
    ok(turn.answerResp?.status === 200 && turn.answerResp?.json?.delivered === true, '(a) answer delivered');
    await sleep(300); // 等回合收尾 saveSession 落盘
    const msAfter = readMission(sid)?.milestones || [];
    ok(msAfter.some(m => m.id === 'm1'), '(a) m1 保留(既有里程碑)');
    ok(msAfter.some(m => m.id === 'm2'), '(a) m2 保留(C4:回合内路由突变未被回合收尾盖回)');

    // ============ (b) 对照:回合外 update 正常落盘(基线) ============
    const beforeM3 = (readMission(sid)?.milestones || []).some(m => m.id === 'm3');
    ok(!beforeM3, '(b) 准备:m3 不存在');
    const upd2 = await requestJson(WB_PORT, '/api/mission', { sessionId: sid, action: 'update', milestones: [{ id: 'm3', desc: 'outside-turn', status: 'pending' }] }, token);
    ok(upd2.status === 200 && upd2.json?.ok === true, '(b) 回合外 POST /api/mission update(加 m3)');
    await sleep(150);
    ok((readMission(sid)?.milestones || []).some(m => m.id === 'm3'), '(b) m3 落盘(回合外 update 基线)');

    // ============ (c) 静态锁 ============
    console.log('\n── [c] 静态锁 ──');
    ok(/action === 'update' && reg\.session\.mission/.test(src), 'c 13d C4 同步:update 分支 merge 到活动回合 session.mission');
    ok(/reg\.session\.mission = applyMissionUpdate\(reg\.session\.mission/.test(src), 'c 13d C4 同步:applyMissionUpdate(合并,保留 in-process mission_update)');
    ok(/provider round-tail[\s\S]*saveSession \(09:1924\)/.test(src), 'c 13d C4 注释引用 09:1924 回合收尾');

  } finally {
    kill(wb); await new Promise(r => provider.close(r)); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nINTERVENTIONS C4 E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
})();
