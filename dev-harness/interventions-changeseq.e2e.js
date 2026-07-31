(async () => {
'use strict';
// E2E(第75a波 切片二b):mission.changeSeq(S3)--持久单调 + 高水位防 clobber。
// 覆盖:
//  (a) 真实回合 + Intervention:settle 触发 bumpMissionChangeSeq(磁盘 changeSeq +1);回合收尾 saveSession
//      用【高水位 max-preserve】不 clobber(settle 的 bump 不被回合内存对象的 stale changeSeq 覆盖)。
//      断言:回合后 mission.changeSeq >= 1(若 clobber 会回到 0)。
//  (b) 单调:连续 transition(CAS 原语)每次推进 changeSeq;POST /api/mission update 后保留(不回写旧值)。
//  (c) 静态锁:bumpMissionChangeSeq / missionChangeSeqHighWater / changeSeq 字段在 server.js。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-cseq-e2e');
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
function readChangeSeq(sid) { try { return Number(JSON.parse(fs.readFileSync(headPath(sid), 'utf8')).mission?.changeSeq) || 0; } catch { return 0; } }
function ivFile(sid) { return path.join(HOME, 'sessions', sid + '.interventions.ndjson'); }
function seedPending(sid, ivId) {
  const rec = { id: ivId, type: 'permission', sessionId: sid, status: 'pending', requestedAt: new Date().toISOString(), decidedAt: '', decidedBy: '', interventionVersion: 0, toolName: 'Bash', tier: 'exec', revertible: false };
  fs.writeFileSync(ivFile(sid), JSON.stringify(rec) + '\n', 'utf8');
}
function spawnWb() {
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, RUYI_TEST_HOOKS: '1' }, windowsHide: true });
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
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'got Vue' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}
// 流式发问 + 在 ask_user 事件里 answer;返回 { sid, questionId }。可传 sessionId 续会话。
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
    const sess = await requestJson(WB_PORT, '/api/sessions', { title: 'cseq' }, token);
    const sid = sess.json.session.id;
    const ms = await requestJson(WB_PORT, '/api/mission', { sessionId: sid, action: 'start', mission: { goal: 'changeSeq test' } }, token);
    ok(ms.status === 200 && ms.json?.ok === true, 'start mission (changeSeq=0)');
    ok(readChangeSeq(sid) === 0, '初始 changeSeq=0');

    // ============ (a) 真实回合 + Intervention:高水位防 clobber ============
    // 流式发问(续会话 sid)-> ask_user -> register(bump changeSeq 0->1)-> answer -> settle(bump 1->2)
    // -> 回合收尾 saveSession(内存对象 changeSeq 仍 0/stale,高水位 max(0,2)=2 防 clobber)。
    const turn = await streamWithQuestion({ sessionId: sid, message: 'ask which framework' }, token, async (s, qid) => {
      // register 的 bumpMissionChangeSeq 是 fire-and-forget 异步落盘,ask_user 事件后可能尚未落盘 -> 不在此刻断言。
      // 改为 answer 后回合收尾时统一验证(register+settle 两次 bump 是否都保留且未被 clobber)。
      return requestJson(WB_PORT, '/api/chat/answer', { sessionId: s, questionId: qid, answers: [{ question: 'Which framework?', answer: ['Vue'] }], content: 'Which framework?: Vue' }, token);
    });
    ok(turn.answerResp?.status === 200 && turn.answerResp?.json?.delivered === true, '(a) answer delivered');
    await sleep(300); // 等回合收尾 saveSession 落盘
    const cseqAfterTurn = readChangeSeq(sid);
    ok(cseqAfterTurn >= 2, `(a) 回合后 changeSeq>=2(settle bump 未被回合 saveSession clobber;实际 ${cseqAfterTurn})`);

    // ============ (b) 单调:连续 transition 推进;POST /api/mission update 保留 ============
    const before = readChangeSeq(sid);
    seedPending(sid, 'cseq_t1');
    let r = await requestJson(WB_PORT, '/api/_test/intervention-cas', { sessionId: sid, ivId: 'cseq_t1', expectedVersion: 0, toStatus: 'allowed' }, token);
    ok(r.status === 200 && r.json?.ok === true, '(b) transition #1 成功');
    await sleep(150);
    ok(readChangeSeq(sid) > before, `(b) transition #1 推进 changeSeq(${before} -> ${readChangeSeq(sid)})`);
    const before2 = readChangeSeq(sid);
    seedPending(sid, 'cseq_t2');
    r = await requestJson(WB_PORT, '/api/_test/intervention-cas', { sessionId: sid, ivId: 'cseq_t2', expectedVersion: 0, toStatus: 'allowed' }, token);
    ok(r.status === 200 && r.json?.ok === true, '(b) transition #2 成功');
    await sleep(150);
    ok(readChangeSeq(sid) > before2, `(b) transition #2 单调推进(${before2} -> ${readChangeSeq(sid)})`);
    // POST /api/mission update(loadSession 读最新 changeSeq + saveSession 保留,不回写旧值)
    const beforeUpd = readChangeSeq(sid);
    const upd = await requestJson(WB_PORT, '/api/mission', { sessionId: sid, action: 'update', mission: { milestones: [{ id: 'm1', desc: 'step' }] } }, token);
    ok(upd.status === 200 && upd.json?.ok === true, '(b) POST /api/mission update');
    await sleep(150);
    ok(readChangeSeq(sid) >= beforeUpd, `(b) update 后 changeSeq 不回写旧值(${beforeUpd} -> ${readChangeSeq(sid)})`);

    // ============ (c) 静态锁 ============
    console.log('\n── [c] 静态锁 ──');
    ok(/function bumpMissionChangeSeq\(sessionId\)/.test(src), 'c 02 有 bumpMissionChangeSeq');
    ok(/const missionChangeSeqHighWater = new Map\(\)/.test(src), 'c 02 missionChangeSeqHighWater 高水位 Map');
    ok(/changeSeq: Math\.max\(0, Number\(p\.changeSeq\) \|\| 0\)/.test(src), 'c 02 normalizeMission changeSeq 字段(持久单调)');
    ok(/if \(hw > cur\) head\.mission\.changeSeq = hw/.test(src), 'c 02 saveSession 高水位 max-preserve(防 clobber)');

  } finally {
    kill(wb); await new Promise(r => provider.close(r)); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nINTERVENTIONS CHANGESEQ E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
})();
