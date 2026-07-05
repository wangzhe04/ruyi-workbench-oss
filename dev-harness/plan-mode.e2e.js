// E2E (v0.9-S5): 计划模式真流程 (plan→批准→执行) on the provider engine, offline via fake-openai.
// Ports 9007 (fake-openai) + 9008 (workbench). §0.9-S5 / 总纲 §4 A5.
//
// The turn PAUSES on the plan event, so a plain postStream would hang. Like steering.e2e we stream LIVE and
// fire the decision POST concurrently the moment the `plan` event arrives, then let the stream finish.
//
// Scenarios:
//  (a) approve → permissionMode:'plan' + FAKE_PLAN_FIRST=1 + FAKE_TOOL_SEQUENCE=[file_write x.txt]:
//        the first request yields a PLAN: text → `plan` event; test POSTs approve → the follow-up request's
//        file_write is EXECUTED (x.txt exists on disk) and appears in turn_summary.filesChanged; turn ok.
//  (b) reject → a fresh session: `plan` event → POST reject → file_write NOT executed (y.txt absent),
//        result.errorClass==='plan_rejected', turn ends (result present).
//  (c) no-token decision → 403; unknown planId → {ok:false, error:'no pending plan'}; idempotent re-decide.
//  (d) FAKE_PLAN_FIRST OFF (normal plan mode) + FAKE_TOOL_SEQUENCE=[file_write z.txt]: no `plan` event; the
//        mutating tool is still HARD-BLOCKED (legacy plan behavior) → z.txt absent, tool_result is an error.
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = 9007, WB_PORT = 9008;
const HOME = path.join(os.tmpdir(), 'wcw-plan-mode-e2e');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
// POST returning {status, body(parsed)}; optional headers (token / no-token).
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 6000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let parsed = null; try { parsed = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, body: parsed }); }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('post timeout')); }); req.write(data); req.end();
  });
}
// Stream /api/chat/stream LIVE — onEvent(evt) fires per parsed line as it arrives (so the test can decide
// mid-turn). Resolves with the full events array at stream end.
function streamChatLive(port, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { let evt = null; try { evt = JSON.parse(line); } catch { /* ignore */ } if (evt) { events.push(evt); try { onEvent(evt); } catch { /* ignore */ } } } } });
      res.on('end', () => { if (buf.trim()) { try { const evt = JSON.parse(buf); events.push(evt); onEvent(evt); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function writeConfig(fakePort) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.0.0', permissionMode: 'plan',
    defaultWorkspace: HOME, recentWorkspaces: [],
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function spawnFake(env) { const p = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), ...env }, windowsHide: true }); p.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim())); return p; }
function fakeUp(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 800 }, resp => { resp.resume(); res(true); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); }); }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  writeConfig(FAKE_PORT);

  // Start with the approve/reject fake: FAKE_PLAN_FIRST=1 + a single file_write step (path chosen per session
  // via FAKE_TOOL_SEQUENCE below — but the sequence path is fixed at fake spawn, so we spawn per-scenario).
  const xTxt = path.join(HOME, 'x.txt');   // approve scenario target
  const seqX = JSON.stringify([{ name: 'file_write', args: { path: xTxt, content: 'approved-write' } }]);
  let fake = spawnFake({ FAKE_PLAN_FIRST: '1', FAKE_TOOL_SEQUENCE: seqX });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(fake, wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    ok(h && h.version === '1.4.0', 'version 1.4.0');
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // ── (a) APPROVE → plan event → approve → file_write executed ─────────────────────────────────────────
    const c1 = await postJson(WB_PORT, '/api/sessions', { title: 'plan approve', cwd: HOME }, hdr);
    const sid1 = c1.body && c1.body.session && c1.body.session.id;
    ok(!!sid1, '(a) session created');

    let planEvt = null, decideResp = null;
    const ev1 = await streamChatLive(WB_PORT, { sessionId: sid1, message: '改个配置', cwd: HOME }, evt => {
      if (evt.type === 'plan' && !planEvt) {
        planEvt = evt;
        // Approve the moment the plan lands (the turn is paused awaiting this).
        postJson(WB_PORT, '/api/plan/decision', { sessionId: sid1, planId: evt.planId, decision: 'approve' }, hdr).then(r => { decideResp = r; }).catch(() => {});
      }
    });
    ok(!!planEvt, '(a) a `plan` event was streamed');
    ok(planEvt && typeof planEvt.planId === 'string' && planEvt.planId, '(a) plan event carries a planId');
    ok(planEvt && typeof planEvt.markdown === 'string' && /PLAN/i.test(planEvt.markdown), '(a) plan event carries the PLAN markdown');
    for (let i = 0; i < 20 && !decideResp; i++) await sleep(50);
    ok(decideResp && decideResp.body && decideResp.body.ok === true, '(a) approve decision {ok:true} (got ' + JSON.stringify(decideResp && decideResp.body) + ')');
    // The file_write must have run AFTER approval.
    ok(fs.existsSync(xTxt), '(a) file_write EXECUTED post-approval (x.txt exists)');
    const tuse1 = ev1.find(e => e.type === 'tool_use' && e.name === 'file_write');
    ok(!!tuse1, '(a) a file_write tool_use was streamed');
    const tres1 = ev1.find(e => e.type === 'tool_result');
    ok(tres1 && tres1.isError !== true, '(a) file_write tool_result is NOT an error (allowed by plan approval)');
    const ts1 = ev1.find(e => e.type === 'turn_summary');
    ok(ts1 && Array.isArray(ts1.filesChanged) && ts1.filesChanged.some(f => (f.path || '').replace(/\\/g, '/').endsWith('x.txt')), '(a) turn_summary.filesChanged records x.txt (journal entry)');
    const res1 = ev1.find(e => e.type === 'result');
    ok(res1 && res1.ok === true && !res1.errorClass, '(a) turn result ok, no errorClass');

    // ── (c) token / unknown-planId guards (use the approve planId which is now consumed) ─────────────────
    const noTok = await postJson(WB_PORT, '/api/plan/decision', { sessionId: sid1, planId: 'plan_whatever', decision: 'approve' });
    ok(noTok.status === 403, '(c) plan decision without token → 403 (got ' + noTok.status + ')');
    const unknown = await postJson(WB_PORT, '/api/plan/decision', { sessionId: sid1, planId: 'plan_does_not_exist', decision: 'approve' }, hdr);
    ok(unknown.body && unknown.body.ok === false && /no pending plan/.test(unknown.body.error || ''), '(c) unknown planId → {ok:false, no pending plan}');
    // Idempotent: re-deciding the already-consumed approve planId → same "no pending plan".
    const reDecide = await postJson(WB_PORT, '/api/plan/decision', { sessionId: sid1, planId: planEvt.planId, decision: 'reject' }, hdr);
    ok(reDecide.body && reDecide.body.ok === false && /no pending plan/.test(reDecide.body.error || ''), '(c) re-decide consumed planId → no pending plan (idempotent)');

    // ── (b) REJECT → plan event → reject → file_write NOT executed + plan_rejected ──────────────────────
    // Respawn the fake targeting y.txt so the reject scenario has its own write target.
    killp(fake); await sleep(300);
    const yTxt = path.join(HOME, 'y.txt');
    const seqY = JSON.stringify([{ name: 'file_write', args: { path: yTxt, content: 'should-not-exist' } }]);
    fake = spawnFake({ FAKE_PLAN_FIRST: '1', FAKE_TOOL_SEQUENCE: seqY });
    procs.push(fake);
    let up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(b) reject fake respawned');

    const c2 = await postJson(WB_PORT, '/api/sessions', { title: 'plan reject', cwd: HOME }, hdr);
    const sid2 = c2.body && c2.body.session && c2.body.session.id;
    ok(!!sid2, '(b) session created');
    let planEvt2 = null, rejResp = null;
    const ev2 = await streamChatLive(WB_PORT, { sessionId: sid2, message: '改另一个配置', cwd: HOME }, evt => {
      if (evt.type === 'plan' && !planEvt2) { planEvt2 = evt; postJson(WB_PORT, '/api/plan/decision', { sessionId: sid2, planId: evt.planId, decision: 'reject', note: '先别改' }, hdr).then(r => { rejResp = r; }).catch(() => {}); }
    });
    ok(!!planEvt2, '(b) a `plan` event was streamed');
    for (let i = 0; i < 20 && !rejResp; i++) await sleep(50);
    ok(rejResp && rejResp.body && rejResp.body.ok === true, '(b) reject decision {ok:true}');
    ok(!fs.existsSync(yTxt), '(b) file_write NOT executed after reject (y.txt absent)');
    ok(!ev2.find(e => e.type === 'tool_use'), '(b) no tool_use streamed (turn ended at rejection)');
    const res2 = ev2.find(e => e.type === 'result');
    ok(res2 && res2.errorClass === 'plan_rejected', '(b) result.errorClass === plan_rejected (got ' + (res2 && res2.errorClass) + ')');

    // ── (d) FAKE_PLAN_FIRST OFF → first assistant msg jumps straight to a tool_call (no PLAN:) → v0.9 F5:
    // the plan-phase guard now REFUSES the whole first tool batch («请先提交 PLAN:») instead of letting it slip
    // to the legacy per-tool gate. Same security outcome (z.txt absent) but a clearer refusal that nudges the
    // model to submit a real plan first (an un-consumed plan phase no longer leaks a read/edit tool run). ─────
    killp(fake); await sleep(300);
    const zTxt = path.join(HOME, 'z.txt');
    const seqZ = JSON.stringify([{ name: 'file_write', args: { path: zTxt, content: 'blocked' } }]);
    fake = spawnFake({ FAKE_TOOL_SEQUENCE: seqZ }); // FAKE_PLAN_FIRST unset
    procs.push(fake);
    up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(d) no-plan fake respawned');
    const c3 = await postJson(WB_PORT, '/api/sessions', { title: 'plan first-toolcall guard', cwd: HOME }, hdr);
    const sid3 = c3.body && c3.body.session && c3.body.session.id;
    const ev3 = await streamChatLive(WB_PORT, { sessionId: sid3, message: '直接改', cwd: HOME }, () => {});
    ok(!ev3.find(e => e.type === 'plan'), '(d) no `plan` event (model did not emit PLAN:)');
    ok(!fs.existsSync(zTxt), '(d) mutating tool NOT executed in plan mode (z.txt absent)');
    const tres3 = ev3.find(e => e.type === 'tool_result' && e.isError === true);
    ok(tres3 && /计划模式:请先提交 PLAN:/.test((tres3.content && tres3.content.error) || ''), '(d) F5: first-message tool_call refused with «计划模式:请先提交 PLAN:» (plan phase not consumed by a bare tool_call)');

    // ── (e) v1.0.2 F1c 防回潮:拒绝 → 模型补交 PLAN: → plan 事件仍必须发出(planPhase 重新武装)────────────
    // Pre-fix, planPhase was consumed at branch entry, so a PLAN: submitted AFTER the F5 refusal never paused:
    // no `plan` event ever streamed and the plan text ended the turn as plain prose(用户症状:第二次计划弹不出).
    // Fake: req1 = tool_call (refused by F5) → req2 = PLAN: text (FAKE_PLAN_WHEN_REFUSED) → approve → req3
    // re-emits the tool_call (sequence length 2: the refusal consumed slot 1) → EXECUTED.
    killp(fake); await sleep(300);
    const wTxt = path.join(HOME, 'w.txt');
    const seqW = JSON.stringify([
      { name: 'file_write', args: { path: wTxt, content: 'post-refusal-approved' } },
      { name: 'file_write', args: { path: wTxt, content: 'post-refusal-approved' } },
    ]);
    fake = spawnFake({ FAKE_TOOL_SEQUENCE: seqW, FAKE_PLAN_WHEN_REFUSED: '1' }); // FAKE_PLAN_FIRST unset
    procs.push(fake);
    up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(e) plan-when-refused fake respawned');
    const c4 = await postJson(WB_PORT, '/api/sessions', { title: 'plan re-arm after refusal', cwd: HOME }, hdr);
    const sid4 = c4.body && c4.body.session && c4.body.session.id;
    let planEvt4 = null, decideResp4 = null;
    const ev4 = await streamChatLive(WB_PORT, { sessionId: sid4, message: '再改一个配置', cwd: HOME }, evt => {
      if (evt.type === 'plan' && !planEvt4) {
        planEvt4 = evt;
        postJson(WB_PORT, '/api/plan/decision', { sessionId: sid4, planId: evt.planId, decision: 'approve' }, hdr).then(r => { decideResp4 = r; }).catch(() => {});
      }
    });
    const refusal4 = ev4.find(e => e.type === 'tool_result' && e.isError === true && /请先提交 PLAN/.test((e.content && e.content.error) || ''));
    ok(!!refusal4, '(e) first tool_call was refused (F5 path taken)');
    ok(!!planEvt4, '(e) 拒绝后补交的 PLAN: 仍发出 `plan` 事件(planPhase 重新武装,防回潮核心断言)');
    for (let i = 0; i < 20 && !decideResp4; i++) await sleep(50);
    ok(decideResp4 && decideResp4.body && decideResp4.body.ok === true, '(e) approve decision {ok:true}');
    ok(fs.existsSync(wTxt), '(e) file_write EXECUTED post-approval (w.txt exists)');
    const res4 = ev4.find(e => e.type === 'result');
    ok(res4 && res4.ok === true && !res4.errorClass, '(e) turn result ok');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nPLAN-MODE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
