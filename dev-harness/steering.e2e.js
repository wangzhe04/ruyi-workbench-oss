(async () => {
// E2E (v0.8-S7): mid-turn STEERING on the provider engine (fake-openai, offline). §4 A3 / §7.3 / §6 0.8-S7.
// FAKE_STREAM_DELAY_MS=150 + a 2-step FAKE_TOOL_SEQUENCE stretch the turn so we can POST /api/steer WHILE
// the first tool_use is streaming. Assertions:
//   ① the /api/steer response is {ok:true, queued:N};
//   ② the stream carries a `steered` event whose text matches what we sent;
//   ③ after the turn, providerHistory contains a user message prefixed 「[用户插话] 」 positioned AFTER an
//      assistant turn, and the FULL history passes a CONTIGUITY check: every assistant.tool_calls (N ids)
//      is followed IMMEDIATELY by exactly those N role:'tool' replies (order may differ but they must be
//      consecutive — nothing of any other role wedged between; a user message inside a tool block is a
//      hard 400 on strict providers);
//   ④ session.messages contains a message with steered:true and the interjection text;
//   ⑤ POSTing /api/steer with NO active turn → {ok:false} ('当前没有进行中的回合');
//   ⑥ POSTing /api/steer with NO token → 403;
//   ⑦ PARALLEL-batch segment (FAKE_PARALLEL_TOOLS: 2 tool_calls in ONE assistant message + steer mid-turn):
//      contiguity holds AND the interjection sits AFTER the complete tool block (assistant→tool→tool→user)
//      — regression pin for the removed mid-batch drain (a steer must never split a tool block).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-steering-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const STEER_TEXT = '顺便把结果写成表格';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const errorText = value => typeof value === 'string' ? value : String(value && (value.message || value.code) || '');
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
// POST returning {status, body(parsed)}; optional headers (for token + no-token cases).
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let parsed = null; try { parsed = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, body: parsed }); }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function deleteJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'DELETE', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let parsed = null; try { parsed = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, body: parsed }); }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
// Streaming POST to /api/chat/stream that invokes onEvent(evt) for each parsed line as it arrives (so a
// test can act mid-turn). Resolves with the full events array at stream end.
function streamChatLive(port, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { let evt = null; try { evt = JSON.parse(line); } catch { /* ignore */ } if (evt) { events.push(evt); try { onEvent(evt); } catch { /* ignore */ } } } } });
      res.on('end', () => { if (buf.trim()) { try { const evt = JSON.parse(buf); events.push(evt); onEvent(evt); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}
// CONTIGUITY check (stricter than "every id has a reply"): each assistant.tool_calls with N ids must be
// followed IMMEDIATELY by exactly N role:'tool' messages whose tool_call_id SET equals the ids (order may
// differ, but they must be consecutive — a user/assistant message wedged inside the block is a 400 risk).
function checkToolBlockContiguity(ph) {
  for (let i = 0; i < ph.length; i++) {
    const m = ph[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = m.tool_calls.map(t => t.id).slice().sort();
      const replies = ph.slice(i + 1, i + 1 + ids.length);
      if (replies.length !== ids.length) return { ok: false, at: i, why: 'short block' };
      if (!replies.every(r => r && r.role === 'tool')) return { ok: false, at: i, why: 'non-tool wedged in block' };
      const rids = replies.map(r => r.tool_call_id).slice().sort();
      if (JSON.stringify(ids) !== JSON.stringify(rids)) return { ok: false, at: i, why: 'id set mismatch' };
    }
  }
  return { ok: true };
}
// Wait until the fake responds on /models (used after respawning it for the parallel segment).
function fakeUp(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 800 }, resp => { resp.resume(); res(true); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); }); }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const f1 = path.join(HOME, 'a.txt'); fs.writeFileSync(f1, 'alpha');
  const f2 = path.join(HOME, 'b.txt'); fs.writeFileSync(f2, 'beta');
  writeConfig(HOME, FAKE_PORT);
  // Two file_read steps so the turn spans two API calls → a real boundary for injection to land at.
  const seq = JSON.stringify([{ name: 'file_read', args: { path: f1 } }, { name: 'file_read', args: { path: f2 } }]);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seq, FAKE_STREAM_DELAY_MS: '150' }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(fake, wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    const created = await postJson(WB_PORT, '/api/sessions', { title: 'steer test', cwd: HOME }, { 'x-wcw-token': token });
    const sid = created.body && created.body.session && created.body.session.id;
    ok(!!sid, 'session created');

    // ⑤ No active turn yet → steer is rejected.
    const noTurn = await postJson(WB_PORT, '/api/steer', { sessionId: sid, text: STEER_TEXT }, { 'x-wcw-token': token });
    ok(noTurn.body && noTurn.body.ok === false && /进行中的回合/.test(errorText(noTurn.body.error)), '(no-turn) steer rejected — 当前没有进行中的回合 (got ' + JSON.stringify(noTurn.body) + ')');

    // ⑥ No token → 403.
    const noTok = await postJson(WB_PORT, '/api/steer', { sessionId: sid, text: STEER_TEXT });
    ok(noTok.status === 403, '(no-token) steer → 403 (got ' + noTok.status + ')');
    const noTokDelete = await deleteJson(WB_PORT, '/api/steer', { sessionId: sid, text: STEER_TEXT });
    ok(noTokDelete.status === 403, '(no-token) cancel steer → 403 (got ' + noTokDelete.status + ')');

    // New cancel API: queue then withdraw at the meta boundary, before the delayed fake provider emits its
    // first tool call. The canceled text must never reach either the stream or persisted session messages.
    const cancelSession = await postJson(WB_PORT, '/api/sessions', { title: 'steer cancel test', cwd: HOME }, { 'x-wcw-token': token });
    const cancelSid = cancelSession.body && cancelSession.body.session && cancelSession.body.session.id;
    const cancelText = '[用户插话] 这条应被撤回';
    let queueThenCancel = null;
    const cancelEvents = await streamChatLive(WB_PORT, { sessionId: cancelSid, message: '撤回一条插话', cwd: HOME }, evt => {
      if (evt.type === 'meta' && !queueThenCancel) {
        queueThenCancel = postJson(WB_PORT, '/api/steer', { sessionId: cancelSid, text: cancelText }, { 'x-wcw-token': token })
          .then(queued => deleteJson(WB_PORT, '/api/steer', { sessionId: cancelSid, text: cancelText }, { 'x-wcw-token': token }).then(canceled => ({ queued, canceled })))
          .catch(error => ({ error }));
      }
    });
    const cancelResult = await queueThenCancel;
    ok(cancelResult && cancelResult.queued && cancelResult.queued.body && cancelResult.queued.body.ok === true && cancelResult.queued.body.queued === 1, '(cancel) steer first enters queue');
    ok(cancelResult && cancelResult.canceled && cancelResult.canceled.status === 200 && cancelResult.canceled.body && cancelResult.canceled.body.ok === true && cancelResult.canceled.body.remaining === 0, '(cancel) DELETE is authorized and removes the queued steer');
    ok(!cancelEvents.some(e => e.type === 'steered' && e.text === '这条应被撤回'), '(cancel) withdrawn steer emits no steered event');
    const canceledHistory = await getJson(WB_PORT, '/api/sessions/' + cancelSid);
    const canceledMessages = (canceledHistory.session && canceledHistory.session.messages) || [];
    ok(!canceledMessages.some(m => m && m.steered === true && m.content === '这条应被撤回'), '(cancel) withdrawn steer is absent from persisted session messages');

    // ---- Live turn: steer on the FIRST tool_use ----
    let steerResp = null, steered = false;
    const ev1 = await streamChatLive(WB_PORT, { sessionId: sid, message: '读两个文件', cwd: HOME }, evt => {
      if (evt.type === 'tool_use' && !steered) {
        steered = true;
        // Fire-and-forget the steer while the turn is live (during the first tool_use stream window).
        postJson(WB_PORT, '/api/steer', { sessionId: sid, text: STEER_TEXT }, { 'x-wcw-token': token }).then(r => { steerResp = r; }).catch(() => {});
      }
    });

    // ① steer response ok. (May settle just after stream end — give it a beat.)
    for (let i = 0; i < 20 && !steerResp; i++) await sleep(50);
    ok(steerResp && steerResp.body && steerResp.body.ok === true && typeof steerResp.body.queued === 'number', '① steer response {ok:true, queued:N} (got ' + JSON.stringify(steerResp && steerResp.body) + ')');

    // ② `steered` event with matching text.
    const steeredEv = ev1.find(e => e.type === 'steered');
    ok(!!steeredEv, '② a `steered` event was streamed');
    ok(steeredEv && steeredEv.text === STEER_TEXT, '② steered event text matches (got ' + (steeredEv && steeredEv.text) + ')');

    // ③ providerHistory has a 「[用户插话] 」 user message, positioned after an assistant turn (pairing intact).
    const got = await getJson(WB_PORT, '/api/sessions/' + sid);
    const ph = (got.session && got.session.providerHistory) || [];
    const steerIdx = ph.findIndex(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[用户插话] '));
    ok(steerIdx >= 0, '③ providerHistory contains a 「[用户插话] 」 user message (idx ' + steerIdx + ')');
    ok(steerIdx > 0 && ph.slice(0, steerIdx).some(m => m && m.role === 'assistant'), '③ the interjection is positioned after an assistant turn (pairing-safe boundary)');
    // The interjection text must match.
    ok(steerIdx >= 0 && ph[steerIdx].content === '[用户插话] ' + STEER_TEXT, '③ interjection content is 「[用户插话] 」+ text');
    // Contiguity: every assistant.tool_calls block is immediately + consecutively answered (no wedging).
    const contig1 = checkToolBlockContiguity(ph);
    ok(contig1.ok, '③ providerHistory tool blocks CONTIGUOUS (no message wedged inside a block) — no 400 risk' + (contig1.ok ? '' : ' (' + contig1.why + ' @' + contig1.at + ')'));

    // ④ session.messages carries the steered:true message.
    const msgs = (got.session && got.session.messages) || [];
    const steeredMsg = msgs.find(m => m && m.steered === true && m.content === STEER_TEXT);
    ok(!!steeredMsg, '④ session.messages contains a steered:true message with the interjection text');

    // ================= ⑦ PARALLEL-batch segment =================
    // Respawn the fake on the SAME port with FAKE_PARALLEL_TOOLS (2 tool_calls in ONE assistant message)
    // + the stream delay. Regression pin for the removed mid-batch drain: a steer arriving while the
    // batch streams must be injected only AFTER the complete tool block, never between tool₁ and tool₂.
    try { cp.execFileSync('taskkill', ['/PID', String(fake.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(300);
    const par = JSON.stringify([{ name: 'file_read', args: { path: f1 } }, { name: 'file_read', args: { path: f2 } }]);
    const fake2 = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_PARALLEL_TOOLS: par, FAKE_STREAM_DELAY_MS: '150' }, windowsHide: true });
    fake2.stdout.on('data', d => String(d).trim() && console.log('[fake2] ' + String(d).trim()));
    procs.push(fake2);
    let up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '⑦ parallel fake respawned on :' + FAKE_PORT);

    const created2 = await postJson(WB_PORT, '/api/sessions', { title: 'steer parallel', cwd: HOME }, { 'x-wcw-token': token });
    const sid2 = created2.body && created2.body.session && created2.body.session.id;
    ok(!!sid2, '⑦ parallel session created');

    // Steer shortly after turn start (`meta`): it lands mid-first-stream (the 2-tool batch streams
    // ~750ms under the 150ms frame delay), i.e. while BOTH tool calls of the batch are still pending —
    // exactly the window where the old mid-batch drain would have split the block.
    let steerResp2 = null;
    const ev2 = await streamChatLive(WB_PORT, { sessionId: sid2, message: '并行读两个文件', cwd: HOME }, evt => {
      if (evt.type === 'meta' && !steerResp2) {
        steerResp2 = { pending: true };
        setTimeout(() => { postJson(WB_PORT, '/api/steer', { sessionId: sid2, text: STEER_TEXT }, { 'x-wcw-token': token }).then(r => { steerResp2 = r; }).catch(() => {}); }, 250);
      }
    });
    for (let i = 0; i < 20 && !(steerResp2 && steerResp2.body); i++) await sleep(50);
    ok(steerResp2 && steerResp2.body && steerResp2.body.ok === true, '⑦ parallel steer accepted (got ' + JSON.stringify(steerResp2 && steerResp2.body) + ')');
    ok(ev2.filter(e => e.type === 'tool_use').length === 2, '⑦ two tool_use in one batch (got ' + ev2.filter(e => e.type === 'tool_use').length + ')');
    ok(!!ev2.find(e => e.type === 'steered' && e.text === STEER_TEXT), '⑦ steered event streamed in the parallel turn');

    const got2 = await getJson(WB_PORT, '/api/sessions/' + sid2);
    const ph2 = (got2.session && got2.session.providerHistory) || [];
    const contig2 = checkToolBlockContiguity(ph2);
    ok(contig2.ok, '⑦ parallel providerHistory tool block CONTIGUOUS' + (contig2.ok ? '' : ' (' + contig2.why + ' @' + contig2.at + ')'));
    const steerIdx2 = ph2.findIndex(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[用户插话] '));
    ok(steerIdx2 >= 0, '⑦ parallel providerHistory contains the interjection (idx ' + steerIdx2 + ')');
    // The interjection must sit AFTER the complete tool block: its predecessor is a role:'tool' message and
    // the batch assistant (2 tool_calls) lies before it with both replies in between.
    ok(steerIdx2 > 0 && ph2[steerIdx2 - 1] && ph2[steerIdx2 - 1].role === 'tool', '⑦ interjection immediately follows the tool block (prev role: ' + (steerIdx2 > 0 && ph2[steerIdx2 - 1] && ph2[steerIdx2 - 1].role) + ')');
    const batchIdx = ph2.findIndex(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length === 2);
    ok(batchIdx >= 0 && steerIdx2 === batchIdx + 3, '⑦ interjection at assistant(tc×2)+3 — after BOTH tool replies, not inside the block (batch@' + batchIdx + ', steer@' + steerIdx2 + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSTEERING E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
