'use strict';
// ACTUAL OFFLINE HTTP E2E: starts one isolated workbench and the shared fake
// provider. Includes a real existing A→B→C journey and a crash/restart. Run only
// in the team's serial actual-test window; the source implementation pass does
// not execute this file. No real provider, account or user data is required.
require('./lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { request, waitForHttp, sleep } = require('./lib/browser-fixture');
const t = createRunner('THREAD RELAY'); const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-relay-')), home = path.join(root, 'data'), work = path.join(root, 'work');
fs.mkdirSync(home); fs.mkdirSync(work);
let proc, fake, port, token, releaseHold;
const held = new Promise(resolve => { releaseHold = resolve; });
const ref = d => ({ turnSeq: d.turnSeq, latestTurnSeq: d.latestTurnSeq, sourceStamp: d.sourceStamp, fileStamp: d.fileStamp });
async function get(route) { return request(port, 'GET', route, null, token); }
async function post(route, value) { return request(port, 'POST', route, { token, ...value }, token, 120000); }
async function start() {
  port = await getFreePort();
  proc = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: path.resolve(__dirname, '../ruyi-workbench'), windowsHide: true, stdio: 'pipe',
    env: { ...fixtureChildEnv(), RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, WCW_POOL_GRACE_MS: '0' },
  });
  let output = ''; proc.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); }); proc.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
  if (!await waitForHttp(port, 'GET', '/health', result => result.status === 200)) throw Error('server not ready: ' + output);
  token = (await post('/api/bootstrap', {}))?.json?.token;
  if (!token) throw Error('bootstrap token missing');
}
async function poll(rootId, relayId, predicate) {
  for (let n = 0; n < 300; n++) {
    const result = (await get('/api/thread-relays?sessionId=' + rootId + '&relayId=' + relayId))?.json?.relays?.[0];
    if (result && predicate(result)) return result;
    await sleep(50);
  }
  throw Error('relay progress timeout');
}
async function chat(sid, text) {
  const result = await post('/api/chat/stream', { sessionId: sid, message: text, cwd: work });
  if (result?.status !== 200 || !result.text.includes('"type":"result"')) throw Error('chat failed ' + result?.text?.slice(-500));
}
async function approved(sid, turnSeq) {
  for (let n = 0; n < 100; n++) {
    const d = (await get('/api/steward/delivery?sessionId=' + sid + '&turnSeq=' + turnSeq))?.json;
    if (d?.relayCompletion === 'succeeded') return { reference: ref(d), accepted: true, materials: { text: true, files: [] } };
    await sleep(30);
  }
  throw Error('delivery completion receipt unavailable');
}
function diagnostic(label, result, details = {}) {
  const error = result?.json?.error;
  console.log('RELAY_HTTP ' + JSON.stringify({ label, status: result?.status ?? null,
    code: typeof error === 'object' ? error?.code ?? null : null,
    error: typeof error === 'string' ? error.slice(0, 160) : null, ...details }));
}
async function idle(sid, runId) {
  let last;
  for (let n = 0; n < 100; n++) {
    const head = await get('/api/sessions/' + sid);
    const row = runId ? await get('/api/agent-runs/' + runId + '?sessionId=' + sid) : null;
    last = { sessionId: sid, runId: runId || null, headStatus: head?.status ?? null,
      execution: head?.json?.execution ?? null, sessionLive: head?.json?.resumable?.live === true,
      runStatus: row?.status ?? null, runLive: row?.json?.run?.live === true };
    if (head?.status === 200 && head.json.session?.id === sid && head.json.execution === null
        && head.json.resumable?.live !== true && (!runId || row?.status === 200 && row.json.run?.id === runId && row.json.run.live !== true)) return;
    await sleep(30);
  }
  throw Error('original owner still live: ' + JSON.stringify(last));
}
(async () => {
  try {
    fake = await startFakeProvider({ handler: async req => {
      const last = [...req.messages].reverse().find(row => row.role === 'user');
      const text = String(last?.content || '');
      if (text.includes('HOLD_TARGET')) await held;
      if (text.includes('FOREIGN_SCOPE_RESULT')) return textFrames('[[RUYI_PVT:EMAIL:ffffffffffffffffffffffffffffffff]]');
      if (text.includes('FAIL_TARGET')) return { status: 400, json: { error: { message: 'synthetic target failure' } } };
      return textFrames(text.includes('SOURCE_DELIVERY') ? 'APPROVED_RELAY_MATERIAL' : 'TARGET_DELIVERY_COMPLETE');
    } });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: 12, defaultWorkspace: work,
      permissionMode: 'auto', engineMode: 'interactive', stewardEnabledV1: true, stewardPollMs: 120000,
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, agentAutoWake: false, agentTaskPoolPolicy: 'off',
      activeProvider: 'fake', providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'fixture', model: 'fake-model' }] }));
    await start();
    const createSession = async () => (await post('/api/sessions', { title: 'Same title', cwd: work })).json.session.id;
    const a = await createSession(), b = await createSession(), c = await createSession(), d = await createSession(), e = await createSession();
    await chat(a, 'SOURCE_DELIVERY');
    const source = await approved(a, 1);
    const ordinaryA = (await get('/api/sessions/' + a)).json.session;
    ok(ordinaryA.stewardWatch !== true && !ordinaryA.stewardLastTurn, 'ordinary A has a trusted delivery receipt without adding a watched success ledger');
    const command = { action: 'create', sessionId: a, requestId: 'actual_click_1', source,
      targets: [{ sessionId: b, task: 'CONTINUE_IN_EXISTING_B' }, { sessionId: c, task: 'CONTINUE_IN_EXISTING_C' }] };
    const [created, repeated] = await Promise.all([post('/api/thread-relays', command), post('/api/thread-relays', command)]);
    let relay = created.json.relay;
    ok(created.status === 200 && repeated.json.relay.id === relay.id, 'repeat HTTP click returns one stable relay');
    const first = relay.threadRelay.edges[0], next = relay.threadRelay.edges[1];
    const blocked = await post('/api/thread-relays', { action: 'start', sessionId: a, relayId: relay.id, edgeId: next.id });
    ok(blocked.status === 409, 'C cannot run before B has a verified accepted delivery');
    const startBody = { action: 'start', sessionId: a, relayId: relay.id, edgeId: first.id };
    await Promise.all([post('/api/thread-relays', startBody), post('/api/thread-relays', startBody)]);
    relay = await poll(a, relay.id, value => value.threadRelay.edges[0].state === 'review');
    const bSession = (await get('/api/sessions/' + b)).json.session;
    ok(bSession.id === b && bSession.turnSeq === 1 && bSession.messages.some(row => row.role === 'user' && row.content.includes('APPROVED_RELAY_MATERIAL')), 'real B continues in the exact existing session with approved A material');
    ok(bSession.stewardWatch !== true && !bSession.stewardLastTurn, 'ordinary B remains unwatched while its real completion is verifiable for C');
    ok(fake.requests.filter(row => JSON.stringify(row.messages).includes('CONTINUE_IN_EXISTING_B')).length === 1, 'duplicate submissions start B at most once');
    ok(relay.threadRelay.edges[1].state === 'waiting', 'B success alone does not imply human acceptance');
    const accepted = await post('/api/thread-relays', { action: 'accept', sessionId: a, relayId: relay.id, edgeId: first.id, source: await approved(b, 1) });
    ok(accepted.json.relay.threadRelay.edges[1].source.sessionId === b, 'next dependency binds B’s exact accepted version');
    await post('/api/thread-relays', { action: 'start', sessionId: a, relayId: relay.id, edgeId: next.id });
    const completed = await poll(a, relay.id, value => value.threadRelay.edges[1].state === 'review');
    // accept(B) binds this stable edge to B's accepted delivery and therefore
    // supplies C's execution identity; create() only had a placeholder runId.
    const acceptedNext = accepted.json.relay.threadRelay.edges.find(edge => edge.id === next.id);
    const completedNext = completed.threadRelay.edges.find(edge => edge.id === next.id);
    ok(completedNext.runId === acceptedNext.runId && completedNext.id === next.id,
      'C keeps its accepted execution identity and stable edge after submission');
    ok((await get('/api/sessions/' + c)).json.session.turnSeq === 1, 'real existing C runs after B acceptance');
    const removeRun = (sid, rid) => request(port, 'DELETE', '/api/agent-runs/' + rid + '?sessionId=' + sid, null, token);
    await idle(b, first.runId); await idle(c, completedNext.runId); await idle(a, relay.id);
    const removedB = await removeRun(b, first.runId); diagnostic('delete B current receipt', removedB, { runId: first.runId });
    ok(removedB.status === 200, 'ordinary target history removal succeeds');
    const retained = (await get('/api/agent-runs/' + first.runId + '?sessionId=' + b)).json;
    ok(retained.run?.threadRelayExecution?.receipt?.status === 'succeeded' && retained.run.historyDeletedAt,
      'history removal retains the original target receipt under its original M3 identity');
    const removedRelay = await removeRun(a, relay.id); diagnostic('delete relay', removedRelay, { runId: relay.id });
    const removedC = await removeRun(c, completedNext.runId); diagnostic('delete C accepted receipt', removedC, { runId: completedNext.runId });
    ok(removedRelay.status === 200 && removedC.status === 200,
      'ordinary history removal retires the relay and both execution rows');
    const afterDelete = await post('/api/thread-relays', command);
    ok(afterDelete.status === 200 && afterDelete.json.relay.id === relay.id && afterDelete.json.relay.threadRelay.cancelled,
      'same request after both history removals returns the retained retired identity');
    ok((await post('/api/thread-relays', startBody)).status === 409
      && fake.requests.filter(row => JSON.stringify(row.messages).includes('CONTINUE_IN_EXISTING_B')).length === 1
      && (await get('/api/sessions/' + b)).json.session.turnSeq === 1, 'deleted history cannot replay a succeeded target');
    const fresh = (await post('/api/thread-relays', { ...command, requestId: 'explicit_new_after_delete',
      targets: [{ sessionId: b, task: 'EXPLICIT_NEW_RELAY' }] })).json.relay;
    await post('/api/thread-relays', { action: 'start', sessionId: a, relayId: fresh.id, edgeId: fresh.threadRelay.edges[0].id });
    await poll(a, fresh.id, value => value.threadRelay.edges[0].state === 'review');
    ok(fresh.id !== relay.id && (await get('/api/sessions/' + b)).json.session.turnSeq === 2,
      'an explicit new request can continue the same existing target with a new stable identity');
    const editCommand = { action: 'create', sessionId: a, requestId: 'actual_edit_1', source,
      targets: [{ sessionId: e, task: 'MUST_NOT_USE_CHANGED_SOURCE' }] };
    const edited = (await post('/api/thread-relays', editCommand)).json.relay;
    await chat(a, 'SOURCE_DELIVERY changed');
    await idle(a); await approved(a, 2);
    const editedStart = await post('/api/thread-relays', { action: 'start', sessionId: a, relayId: edited.id, edgeId: edited.threadRelay.edges[0].id });
    diagnostic('start old source after trusted turn2 and owner release', editedStart, { sourceTurnSeq: source.reference.turnSeq, currentTurnSeq: 2 });
    ok(editedStart.status === 409 && editedStart.json.error.code === 'thread_relay.source_changed', 'source revision change refuses the old authorization');
    const foreign = await createSession(), foreignTarget = await createSession();
    await chat(foreign, 'FOREIGN_SCOPE_RESULT');
    const beforeForeign = fake.requests.length;
    const foreignCreate = await post('/api/thread-relays', { action: 'create', sessionId: foreign, requestId: 'actual_foreign_1', source: await approved(foreign, 1), targets: [{ sessionId: foreignTarget, task: 'MUST_NOT_FORWARD_FOREIGN_ALIAS' }] });
    ok(foreignCreate.status === 409 && fake.requests.length === beforeForeign, 'an unresolved source-scope alias never reaches another existing thread or provider');
    const crash = (await post('/api/thread-relays', { action: 'create', sessionId: a, requestId: 'actual_crash_1', source: await approved(a, 2), targets: [{ sessionId: d, task: 'HOLD_TARGET' }] })).json.relay;
    const crashStart = { action: 'start', sessionId: a, relayId: crash.id, edgeId: crash.threadRelay.edges[0].id };
    await post('/api/thread-relays', crashStart);
    for (let n = 0; n < 300 && !fake.requests.some(row => JSON.stringify(row.messages).includes('HOLD_TARGET')); n++) await sleep(30);
    ok(fake.requests.some(row => JSON.stringify(row.messages).includes('HOLD_TARGET')), 'unknown rehearsal reaches the real target provider once');
    await killOwnTree(proc); proc = null; releaseHold(); await start();
    const unknown = await poll(a, crash.id, value => value.threadRelay.edges[0].state === 'unknown');
    await post('/api/thread-relays', crashStart);
    ok(unknown.threadRelay.edges[0].runId === crash.threadRelay.edges[0].runId && fake.requests.filter(row => JSON.stringify(row.messages).includes('HOLD_TARGET')).length === 1, 'restart and repeated start verify the same unknown identity without replay');
    const cancelled = await post('/api/thread-relays', { action: 'cancel', sessionId: a, relayId: crash.id });
    ok(cancelled.json.relay.threadRelay.cancelled && (await post('/api/thread-relays', crashStart)).status === 409, 'explicit cancellation prevents later replay');
    const failure = (await post('/api/thread-relays', { action: 'create', sessionId: a, requestId: 'actual_fail_1', source: await approved(a, 2), targets: [{ sessionId: e, task: 'FAIL_TARGET' }] })).json.relay;
    await post('/api/thread-relays', { action: 'start', sessionId: a, relayId: failure.id, edgeId: failure.threadRelay.edges[0].id });
    await poll(a, failure.id, value => value.threadRelay.edges[0].state === 'failed');
    ok(true, 'real target provider failure has a durable failure receipt');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { releaseHold(); if (proc) await killOwnTree(proc); if (fake) await fake.close(); }
  t.done();
})();
