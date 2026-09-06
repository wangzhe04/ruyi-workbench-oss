(async () => {
'use strict';
// E2E(第 117 波 117e 第 0 步 · 27 号文 §11.6 「117d 登记项 ①」):**挂进事项容器的线程要能答待决**。
//
// 回归的是 116g 引入的一个真 bug:`missionAttachThread` 把 `session.missionId` 改写成【容器 id】之后,
// `decideIntervention` 的 `sessionMissionId(head) !== missionId` 那道门就把「这条会话按自己的 id 来答
// 自己的待决」判成 not_found —— 而 /api/chat/answer、/api/permission/decision、/api/plan/decision
// 三条兼容适配器传的正是 sessionId。结果:凡是进了多线程事项的线程,问题/权限/计划一律答不进去
// (经典壳同样受影响,不只管家壳)。
//
// 修法(117e 第 0 步):门显式承认「missionId 等于该会话自身 id」是合法别名。**不放宽**跨会话:
// 待决本体仍按 `readInterventions(missionId)` 从这条会话自己的旁路账里取,并再核一次
// `current.sessionId === missionId`。
//
// 覆盖:
//  (A) 造容器 + attach 两条线程 → 会话头的 missionId 确实变成了容器 id(bug 的前提条件成立);
//  (B) 已 attach 的线程 A:question → POST /api/chat/answer 送达;
//  (C) 已 attach 的线程 A:permission → POST /api/permission/decision 送达;
//  (D) 已 attach 的线程 B(线程级 permissionMode=plan):plan → POST /api/plan/decision 送达;
//  (E) 未 attach 的线程 C 照旧(不回归);
//  (F) 跨会话仍然答不进:拿【别的会话 id】走统一契约端点去答另一条线程的待决 → not_found;
//      容器 id(没有会话文件)同样 not_found;两次越权尝试都没把待决消费掉,自身 id 仍答得进。
//
// 端口用 getFreePort()。判定行:`INTERVENTION MISSION GATE E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-iv-mission-gate-'));
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

function req(method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: pathname, method, timeout: 30000,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* non-json */ } resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, text: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, text: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}

// 流式 /api/chat/stream:回合会停在待决上,所以必须【边流边答】(与 interventions-snapshot 同款)。
function streamChat(body, token, cbs = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const events = []; let buf = ''; let sid = String(body.sessionId || '');
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token },
    }, res => {
      const consume = line => {
        if (!line.trim()) return;
        let evt; try { evt = JSON.parse(line); } catch { return; }
        events.push(evt);
        if (evt.type === 'session' && evt.session && evt.session.id) sid = evt.session.id;
        if (evt.type === 'ask_user' && cbs.onAsk) cbs.onAsk(sid, evt);
        if (evt.type === 'permission_request' && cbs.onPermission) cbs.onPermission(sid, evt);
        if (evt.type === 'plan' && cbs.onPlan) cbs.onPlan(sid, evt);
      };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); consume(line); } });
      res.on('end', () => { consume(buf); resolve({ events, sid }); });
    });
    r.on('error', () => resolve({ events, sid }));
    r.write(raw); r.end();
  });
}

function spawnFake(env) {
  const p = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], {
    env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), ...env }, windowsHide: true,
  });
  p.stderr.on('data', d => String(d).trim() && console.error('[fake!] ' + String(d).trim()));
  return p;
}
function fakeUp() {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: FAKE_PORT, path: '/v1/models', timeout: 800 }, res => { res.resume(); resolve(true); });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}
let fake = null;
async function restartFake(env) {
  kill(fake); await sleep(200);
  fake = spawnFake(env);
  for (let i = 0; i < 40; i++) { if (await fakeUp()) return; await sleep(120); }
  throw new Error('fake provider did not start');
}

fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 9, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
  permissionTimeoutMs: 20000, includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
  subagentMaxPerTurn: 0,
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${FAKE_PORT}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}, null, 2), 'utf8');

let wb = null;
const settled = [];
try {
  await restartFake({ FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'request_user_input', args: { questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] } }]) });

  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true, stdio: 'ignore',
  });
  let token = '';
  for (let i = 0; i < 100 && !token; i++) {
    await sleep(120);
    try { token = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
  }
  ok(!!token, 'A0 服务起来了(拿到 token)');
  for (let i = 0; i < 60; i++) { const r = await req('GET', '/health', null, token); if (r.status === 200) break; await sleep(120); }

  /* ═════════ (A) 容器 + attach ═════════ */
  console.log('── (A) 事项容器与线程归属 ──');
  const mk = async title => (await req('POST', '/api/sessions', { title, cwd: HOME }, token)).json?.session?.id || '';
  // 每个场景各用一条【自己的】线程:fake-openai 的 FAKE_TOOL_SEQUENCE 按历史里 role:'tool' 的
  // 条数取第 N 项,同一条会话跑第二轮时序列已经耗尽,再挂不出待决(与本波修的门无关,是夹具口径)。
  const idA = await mk('挂进事项的线程A');
  const idP = await mk('挂进事项的线程P');
  const idB = await mk('挂进事项的线程B');
  const idX = await mk('挂进事项的线程X');
  const idC = await mk('未归事项的线程C');
  ok(Boolean(idA && idP && idB && idX && idC), `A1 五条线程已建(${idA} / ${idP} / ${idB} / ${idX} / ${idC})`);

  const container = await req('POST', '/api/missions', { title: '季度收尾', acceptance: [{ text: '交付', done: false }] }, token);
  const missionId = container.json && container.json.mission && container.json.mission.missionId;
  ok(Boolean(missionId), `A2 事项容器已建(${missionId || '失败'})`);
  for (const id of [idA, idP, idB, idX]) {
    await req('POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id }, token);
  }
  const headA = await req('GET', `/api/sessions/${encodeURIComponent(idA)}`, null, token);
  ok(headA.json && headA.json.session && String(headA.json.session.missionId) === String(missionId),
    `A3 attach 之后会话头的 missionId 就是【容器 id】(bug 的前提成立,实测 ${headA.json?.session?.missionId})`);
  const headC = await req('GET', `/api/sessions/${encodeURIComponent(idC)}`, null, token);
  ok(!headC.json?.session?.missionId || String(headC.json.session.missionId) === String(idC),
    'A3b 未 attach 的线程 missionId 仍是自己(或缺省)');

  /* ═════════ (B) question 适配器 ═════════ */
  console.log('── (B) /api/chat/answer ──');
  let answerResp = null, qid = '';
  await streamChat({ sessionId: idA, message: 'ask which framework', cwd: HOME }, token, {
    onAsk: (sid, evt) => {
      qid = String(evt.questionId || evt.id || '');
      settled.push((async () => {
        answerResp = await req('POST', '/api/chat/answer', {
          sessionId: sid, questionId: qid,
          answers: [{ question: 'Which framework?', answer: ['Vue'] }], content: 'Which framework?: Vue',
        }, token);
      })());
    },
  });
  await Promise.all(settled.splice(0));
  ok(Boolean(qid), 'B1 线程 A 挂出了 question 待决');
  ok(answerResp && answerResp.status === 200 && answerResp.json && answerResp.json.ok === true && answerResp.json.delivered === true,
    `B2 挂进事项的线程能答 question(实测 ${answerResp && answerResp.status} ${JSON.stringify(answerResp && answerResp.json)})`);

  /* ═════════ (C) permission 适配器 ═════════ */
  console.log('── (C) /api/permission/decision ──');
  const writeTarget = path.join(HOME, 'gate-target.txt');
  await restartFake({ FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'file_write', args: { path: writeTarget, content: 'gate' } }]) });
  let permResp = null, permId = '';
  await streamChat({ sessionId: idP, message: 'write the file', cwd: HOME }, token, {
    onPermission: (sid, evt) => {
      permId = String(evt.requestId || '');
      settled.push((async () => {
        permResp = await req('POST', '/api/permission/decision', { requestId: permId, behavior: 'deny', message: 'gate test' }, token);
      })());
    },
  });
  await Promise.all(settled.splice(0));
  ok(Boolean(permId), 'C1 线程 P 挂出了 permission 待决');
  ok(permResp && permResp.status === 200 && permResp.json && permResp.json.ok === true,
    `C2 挂进事项的线程能答 permission(实测 ${permResp && permResp.status} ${JSON.stringify(permResp && permResp.json)})`);
  ok(!fs.existsSync(writeTarget), 'C3 deny 生效(文件没落盘)');

  /* ═════════ (D) plan 适配器 ═════════ */
  console.log('── (D) /api/plan/decision ──');
  const patched = await req('PATCH', `/api/sessions/${encodeURIComponent(idB)}`, { permissionMode: 'plan' }, token);
  ok(patched.status === 200 && patched.json && patched.json.ok === true, 'D0 线程 B 的线程级权限切到「只做计划」');
  const planTarget = path.join(HOME, 'gate-plan.txt');
  await restartFake({ FAKE_PLAN_FIRST: '1', FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'file_write', args: { path: planTarget, content: 'plan' } }]) });
  let planResp = null, planId = '';
  await streamChat({ sessionId: idB, message: '改个配置', cwd: HOME }, token, {
    onPlan: (sid, evt) => {
      planId = String(evt.planId || '');
      settled.push((async () => {
        planResp = await req('POST', '/api/plan/decision', { sessionId: sid, planId, decision: 'reject', note: '先别改' }, token);
      })());
    },
  });
  await Promise.all(settled.splice(0));
  ok(Boolean(planId), 'D1 线程 B 挂出了 plan 待决');
  ok(planResp && planResp.status === 200 && planResp.json && planResp.json.ok === true,
    `D2 挂进事项的线程能答 plan(实测 ${planResp && planResp.status} ${JSON.stringify(planResp && planResp.json)})`);

  /* ═════════ (E) 未 attach 的线程照旧 ═════════ */
  console.log('── (E) 未 attach 的线程不回归 ──');
  await restartFake({ FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'request_user_input', args: { questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] } }]) });
  let answerC = null, qidC = '';
  await streamChat({ sessionId: idC, message: 'ask which framework', cwd: HOME }, token, {
    onAsk: (sid, evt) => {
      qidC = String(evt.questionId || evt.id || '');
      settled.push((async () => {
        answerC = await req('POST', '/api/chat/answer', {
          sessionId: sid, questionId: qidC,
          answers: [{ question: 'Which framework?', answer: ['React'] }], content: 'Which framework?: React',
        }, token);
      })());
    },
  });
  await Promise.all(settled.splice(0));
  ok(Boolean(qidC) && answerC && answerC.status === 200 && answerC.json && answerC.json.ok === true,
    `E1 未 attach 的线程照旧能答(实测 ${answerC && answerC.status})`);

  /* ═════════ (F) 跨会话仍然答不进 ═════════ */
  console.log('── (F) 跨会话与容器 id 仍然 not_found ──');
  // 造一条待决留在【线程 X】上,用来试探跨会话答复。
  await restartFake({ FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'request_user_input', args: { questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] } }]) });
  let crossOther = null, crossContainer = null, crossSelf = null, qidA2 = '';
  await streamChat({ sessionId: idX, message: 'ask which framework', cwd: HOME }, token, {
    onAsk: (sid, evt) => {
      qidA2 = String(evt.questionId || evt.id || '');
      settled.push((async () => {
        const route = (mission, iv) => `/api/missions/${encodeURIComponent(mission)}/interventions/${encodeURIComponent(iv)}/decision`;
        // 判定序:门(head + missionId 别名)-> contract 参数 -> 旁路账里找 current -> payload 形状。
        // 前两条在「找 current」那一步就 404 了,payload 根本走不到,所以这里不必构造合法的
        // 类型化答复形状(那是 interventions-snapshot 的地盘)。
        // ① 用【别的会话 id】去答 X 的待决 —— 门放行了别名,但待决本体在 C 自己的旁路账里找不到。
        crossOther = await req('POST', route(idC, qidA2), { expectedVersion: 0, idempotencyKey: 'gate-cross-1', action: 'answer' }, token);
        // ② 用【容器 id】去答 —— 容器没有会话文件,读不出 head,照旧 404。
        crossContainer = await req('POST', route(missionId, qidA2), { expectedVersion: 0, idempotencyKey: 'gate-cross-2', action: 'answer' }, token);
        // ③ 两次越权尝试都没把待决消费掉:用【自己的 id】走经典适配器仍然答得进(修的就是它)。
        crossSelf = await req('POST', '/api/chat/answer', {
          sessionId: idX, questionId: qidA2,
          answers: [{ question: 'Which framework?', answer: ['Vue'] }], content: 'Which framework?: Vue',
        }, token);
      })());
    },
  });
  await Promise.all(settled.splice(0));
  ok(Boolean(qidA2), 'F0 线程 X 挂出一条 question 待决');
  ok(crossOther && crossOther.status === 404 && crossOther.json && crossOther.json.reason === 'not_found',
    `F1 拿别的会话 id 答别人的待决仍然 not_found(实测 ${crossOther && crossOther.status} ${JSON.stringify(crossOther && crossOther.json && crossOther.json.reason)})`);
  ok(crossContainer && crossContainer.status === 404 && crossContainer.json && crossContainer.json.reason === 'not_found',
    `F2 拿容器 id 答仍然 not_found(实测 ${crossContainer && crossContainer.status})`);
  ok(crossSelf && crossSelf.status === 200 && crossSelf.json && crossSelf.json.ok === true && crossSelf.json.delivered === true,
    `F3 越权尝试没消费掉待决,拿会话自身 id 仍然答得进(实测 ${crossSelf && crossSelf.status} ${JSON.stringify(crossSelf && crossSelf.json)})`);
} catch (e) {
  console.log('ERROR ' + ((e && e.stack) || e));
  fail++;
} finally {
  kill(wb); kill(fake);
  await sleep(300);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('');
if (fail) { console.log(`INTERVENTION MISSION GATE E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('INTERVENTION MISSION GATE E2E: ALL PASS');
process.exit(0);
})();
