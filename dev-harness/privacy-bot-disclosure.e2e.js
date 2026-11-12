'use strict';
// Generated gateway + authoritative bot ledger + actual official API transport.
// Synthetic credentials and loopback HTTP only; no model, accounts or child processes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { install } = require('./lib/external-channel-delivery-preload');
const { fixture } = require('./lib/privacy-test-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-bot-disclosure-e2e-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
process.env.RUYI_BOT_QQ_DISCLOSURE = 'synthetic-qq-vault-secret';
process.env.RUYI_BOT_FEISHU_DISCLOSURE = 'synthetic-feishu-vault-secret';
process.env.RUYI_BOT_VERIFICATION_DISCLOSURE = 'synthetic-verification-secret';
process.env.RUYI_BOT_ENCRYPT_DISCLOSURE = 'synthetic-encrypt-secret';
const app = require('./lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'PrivacyRegex', 'ExternalChannelDelivery', 'mutateConfig', 'readConfig',
  'externalBotNormalizeConnection', 'externalBotWriteState', 'externalBotReadState', 'externalBotNextJob', 'externalBotFinishJob', 'externalBotPrepareReply',
  'externalBotRecover', 'externalBotDrain', 'externalBotSendJob', 'externalBotDeliveries', 'externalBotBoundReplyText', 'externalBotReplyText', 'STEWARD_SESSION_ID'], { withEval: true });
const t = createRunner('PRIVACY BOT DISCLOSURE'), { ok } = t;
const vault = fixture().vault;
app.PrivacyCore.configHooks.sealLocal = vault.sealLocal; app.PrivacyCore.configHooks.openLocal = vault.openLocal;
let server, restore, requests = [], onToken, responseMode = '', serial = 0;
const policy = (mode = 'enhanced', extra = {}) => ({ privacyModeV1: mode, privacyRulesV1: [], providers: [], ...extra });
// NextJob and the real credential/state readers reload trusted disk policy.
// Prepare each scenario through that production path; configure-only mutations
// below remain deliberate in-flight epoch faults, never initial authority.
async function trustedPolicy(mode = 'enhanced', extra = {}) {
  const expected = policy(mode, extra);
  await app.mutateConfig(config => Object.assign(config, expected, {
    privacyTechnicalV1: false, privacyPolicyRecoveryRequiredV1: false,
    credentialEncryptionV1: true, workDataEncryptionV1: false,
    activeProvider: '', externalMcpServers: [], includeWorkbenchMcp: false,
    autoImportClaudeCodeMcp: false, autoImportKimiCodeMcp: false, enableMcpDropIn: false,
    desktopMcp: { enabled: false, autodetect: false }, stewardEnabledV1: false, schedulerEnabledV1: false,
  }));
  const saved = await app.readConfig();
  assert.equal(saved.privacyModeV1, mode, 'actual committed policy mode');
  assert.deepEqual(saved.privacyRulesV1, expected.privacyRulesV1, 'actual committed policy rules');
  assert.equal(saved.privacyTechnicalV1, false);
  assert.equal(saved.privacyPolicyRecoveryRequiredV1, false);
  assert.equal(saved.credentialEncryptionV1, true);
  assert.equal(saved.workDataEncryptionV1, false);
}
const messageRequests = () => requests.filter(row => !row.token);
function connection(platform, kind) {
  const group = kind === 'group', sender = 'human', room = group ? 'room' : sender;
  return { ...app.externalBotNormalizeConnection({ platform, appId: platform + '-fixture-app', tenantId: platform + '-tenant', botUserId: 'fixture-bot', enabled: true,
    mode: 'control', ownerSenderId: sender, ownerConversationId: room, ownerConversationType: kind, allowedSenderIds: [sender], allowedConversationIds: [room],
    ...(platform === 'qq' ? { botSecretEnv: 'RUYI_BOT_QQ_DISCLOSURE' } : { appSecretEnv: 'RUYI_BOT_FEISHU_DISCLOSURE', verificationTokenEnv: 'RUYI_BOT_VERIFICATION_DISCLOSURE', encryptKeyEnv: 'RUYI_BOT_ENCRYPT_DISCLOSURE' }) }, 'bot_fixture'), controlRevision: 1 };
}
async function seed(platform = 'qq', kind = 'group', replyText = 'public reply') {
  const c = connection(platform, kind), date = new Date().toISOString();
  const item = { id: 'item_' + (++serial), connectionId: c.id, platform, connectionLabel: '', tenantId: c.tenantId,
    conversationId: c.ownerConversationId, senderId: c.ownerSenderId, conversationType: kind, text: 'synthetic accepted command', messageId: 'message_' + serial,
    eventId: 'event_' + serial, receivedAt: date, readAt: '',
    control: { connectionId: c.id, platform, tenantId: c.tenantId, senderId: c.ownerSenderId, conversationId: c.ownerConversationId, conversationType: kind, controlRevision: c.controlRevision, appId: c.appId },
    execution: { status: 'completed', serverInstanceId: 'fixture', startedAt: date, finishedAt: date, errorCode: '', replyText, turnSeq: serial, actionFailures: 0, proposals: 0, contractIncomplete: false },
    delivery: { status: 'pending', attemptId: 'attempt_' + serial, messageId: '', errorCode: '', updatedAt: date } };
  item.sourceKey = JSON.stringify([item.connectionId, item.tenantId, item.conversationId, item.messageId]);
  item.contentHash = crypto.createHash('sha256').update(JSON.stringify([item.senderId, item.conversationType, item.text])).digest('hex');
  await app.externalBotWriteState({ schema: 1, connections: [c], items: [item], retiredConnectionIds: [] });
  requests = []; responseMode = ''; onToken = null;
  return app.externalBotNextJob();
}
// Observe the real SendJob result before its original settlement. The fixture
// never creates a delivery owner: only the production SendJob may do that.
const sends = new Map();
globalThis.__botDisclosureObserver = {
  originalPrepare: app.externalBotPrepareReply,
  originalFinish: app.externalBotFinishJob,
  prepare(job, controller, dispatch, guard) {
    const row = sends.get(job);
    if (!row || row.originalController !== controller) throw Error('Original bot send owner unavailable');
    return row.prepare ? row.prepare(job, controller, dispatch, guard) : app.externalBotPrepareReply(job, controller, dispatch, guard);
  },
  async finish(job, result) {
    const row = sends.get(job);
    if (!row || row.observed) throw Error('Unexpected bot settlement');
    row.observed = true; row.result = result; row.resolve(result);
    await row.permit;
    return app.externalBotFinishJob(job, result);
  },
};
app.__eval('externalBotPrepareReply = (...args) => globalThis.__botDisclosureObserver.prepare(...args); externalBotFinishJob = (...args) => globalThis.__botDisclosureObserver.finish(...args);');
async function beginSend(job, controller = new AbortController(), prepare) {
  if (sends.has(job)) throw Error('Bot send already started');
  const row = { prepare, controller };
  row.ready = new Promise((resolve, reject) => { row.resolve = resolve; row.reject = reject; });
  row.ready.catch(() => {});
  row.permit = new Promise(resolve => { row.release = resolve; });
  sends.set(job, row);
  row.run = app.externalBotSendJob(job); row.run.catch(error => row.reject(error));
  let timer;
  try {
    // Capture once, immediately after the real SendJob synchronously registers
    // its owner. Later cancellation can only touch this exact original object.
    row.owner = app.externalBotDeliveries.get(job.item.id);
    if (!row.owner || row.owner.attemptId !== job.item.delivery.attemptId || !row.owner.controller) throw Error('Actual bot send did not issue its original owner');
    row.originalController = row.owner.controller;
    row.abort = () => row.originalController.abort();
    controller.signal.addEventListener('abort', row.abort, { once: true });
    if (controller.signal.aborted) row.abort();
    return await Promise.race([row.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Original bot result caller deadline (5000ms)')), 5000); })]);
  } catch (primary) {
    row.failure = primary; row.release();
    try { await row.run; }
    catch (cleanup) { if (cleanup !== primary) throw new AggregateError([primary, cleanup], 'Bot send and original settlement failed', { cause: primary }); }
    finally { if (row.abort) controller.signal.removeEventListener('abort', row.abort); sends.delete(job); }
    throw primary; // A late successful original result cannot clear the caller failure.
  } finally { clearTimeout(timer); }
}
async function finishSend(job, result) {
  const row = sends.get(job);
  if (!row || row.result !== result) throw Error('Bot result does not belong to the original send');
  row.release();
  try { await row.run; if (row.failure) throw row.failure; }
  finally { row.controller.signal.removeEventListener('abort', row.abort); sends.delete(job); }
}
async function send(job, controller = new AbortController(), prepare) {
  const result = await beginSend(job, controller, prepare);
  await finishSend(job, result); return result;
}
async function edit(change) {
  const state = await app.externalBotReadState(); change(state); await app.externalBotWriteState(state);
}
const textOf = row => row.host === 'api.bot.qq.com' ? row.body.content : JSON.parse(row.body.content).text;
(async () => {
  server = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks)), token = /getAppAccessToken|tenant_access_token/.test(req.url), feishu = req.headers.host === 'open.feishu.cn';
        requests.push({ host: req.headers.host, path: req.url, headers: req.headers, body, token });
        if (token && onToken) { const hook = onToken; onToken = null; await hook(); }
        if (!token && responseMode === 'reset') { res.destroy(); return; }
        if (!token && responseMode === 'reject') { res.writeHead(403); res.end('{}'); return; }
        res.end(JSON.stringify(token ? feishu ? { code: 0, tenant_access_token: 'synthetic-feishu-access' } : { access_token: 'synthetic-qq-access' }
          : feishu ? { code: 0, data: { message_id: 'sent-fixture' } } : { id: 'sent-fixture' }));
      } catch (error) { res.destroy(error); }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); restore = install(server.address().port);
  await app.externalBotRecover();
  for (const mode of ['off', 'basic', 'enhanced', 'strict']) for (const platform of ['qq', 'feishu']) for (const kind of ['direct', 'group']) {
    const source = 'patient-disclosure-sentinel ' + process.env[platform === 'qq' ? 'RUYI_BOT_QQ_DISCLOSURE' : 'RUYI_BOT_FEISHU_DISCLOSURE'];
    await trustedPolicy(mode);
    if (mode !== 'off') await app.PrivacyGateway.withPolicy(app.STEWARD_SESSION_ID, async () => { app.PrivacyGateway.active().scope.protectValue('patient-disclosure-sentinel', 'INTERNAL'); });
    const job = await seed(platform, kind, source), result = await send(job), sent = messageRequests();
    ok(result.status === 'sent' && sent.length === 1, `${mode}/${platform}/${kind} sends exactly one reply`);
    const actual = textOf(sent[0]);
    ok(mode === 'off' ? actual === source : !actual.includes('patient-disclosure-sentinel') && !actual.includes('vault-secret'), `${mode}/${platform}/${kind} actual receiver gets expected projection`);
    ok(platform === 'qq' ? sent[0].path.includes('/' + (kind === 'group' ? 'groups/room' : 'users/human') + '/messages')
      : sent[0].path.includes('/messages/' + job.item.messageId + '/reply'), `${mode}/${platform}/${kind} recipient route stays bound`);
    ok(platform === 'qq' ? requests[0].body.clientSecret === job.connection.botSecret && sent[0].headers.authorization === 'QQBot synthetic-qq-access'
      : requests[0].body.app_secret === job.connection.appSecret && sent[0].headers.authorization === "Bearer " + "synthetic-feishu-access", `${mode}/${platform}/${kind} auth remains only official token slots/header`);
  }
  for (const mode of ['off', 'basic', 'enhanced', 'strict']) {
    await trustedPolicy(mode);
    const source = '{"password":"PRIVATE_PREFIX_' + 'x'.repeat(2300) + '_PRIVATE_END"}', job = await seed('qq', 'group', source);
    const result = await send(job), actual = textOf(messageRequests()[0]);
    ok(result.status === 'sent' && (mode === 'off' ? actual === app.externalBotBoundReplyText(source) : !actual.includes('PRIVATE_PREFIX_') && !actual.includes('_PRIVATE_END')), `${mode} protects complete logical JSON before historical clipping`);
    ok((await app.externalBotReadState()).items[0].execution.replyText === source, `${mode} durable execution retains complete reply`);
  }
  const tokenCases = [
    ['off-on', 'off', async () => app.PrivacyGateway.configure(policy('basic'))],
    ['on-off', 'enhanced', async () => app.PrivacyGateway.configure(policy('off'))],
    ['rules', 'enhanced', async () => app.PrivacyGateway.configure(policy('enhanced', { privacyRulesV1: [{ id: 'deny', kind: 'literal', value: 'public', category: 'INTERNAL' }] }))],
    ['credential', 'enhanced', async () => { process.env.RUYI_BOT_QQ_DISCLOSURE += '-changed'; }],
    ['recipient', 'enhanced', async () => edit(state => { state.connections[0].botUserId = 'another-bot'; })],
    ['source', 'enhanced', async () => edit(state => { state.items[0].execution.replyText = 'new authoritative reply'; })],
    ['attempt', 'enhanced', async () => edit(state => { state.items[0].delivery.attemptId = 'replacement_attempt'; })],
    ['control', 'enhanced', async () => edit(state => { state.connections[0].controlRevision++; })],
  ];
  for (const [name, mode, mutate] of tokenCases) {
    await trustedPolicy(mode); const job = await seed(); onToken = mutate;
    // A changed attempt cannot be settled as the original; test delivery refuses
    // first, then restore only that test ledger identity before normal settlement.
    const result = await beginSend(job);
    ok(result.status === 'failed' && messageRequests().length === 0, `held token ${name} refuses before any message request`);
    if (name === 'attempt') await edit(state => { state.items[0].delivery.attemptId = job.item.delivery.attemptId; });
    await finishSend(job, result);
    const before = JSON.stringify((await app.externalBotReadState()).items[0].execution); await app.externalBotDrain();
    ok((await app.externalBotReadState()).items[0].delivery.status === 'failed' && JSON.stringify((await app.externalBotReadState()).items[0].execution) === before && messageRequests().length === 0, `held token ${name} preserves completed execution and never replays`);
  }
  await trustedPolicy();
  { const job = await seed(), controller = new AbortController(); onToken = async () => controller.abort(); const result = await send(job, controller);
    ok(result.status === 'failed' && messageRequests().length === 0, 'held token cancellation is known failed with zero message requests'); }
  for (const value of ['[[RUYI_PVT:EMAIL:' + 'f'.repeat(32) + ']]', '[[RUYI_PVT:INTERNAL:' + 'e'.repeat(32) + ']]']) {
    const job = await seed('feishu', 'group', value), result = await send(job);
    ok(result.status === 'failed' && messageRequests().length === 0 && (await app.externalBotReadState()).items[0].execution.status === 'completed', 'unknown/cross-scope shaped reference refuses delivery only');
  }
  let foreign, revoked;
  await app.PrivacyGateway.withPolicy('foreign-bot-source', async () => { foreign = app.PrivacyGateway.active().scope.protectValue('foreign-private-value', 'INTERNAL'); });
  await app.PrivacyGateway.withPolicy(app.STEWARD_SESSION_ID, async () => { const scope = app.PrivacyGateway.active().scope; revoked = scope.protectValue('revoked-private-value', 'INTERNAL'); scope.revoke(revoked); });
  for (const value of [foreign, revoked]) {
    const job = await seed('qq', 'direct', value), result = await send(job); ok(result.status === 'failed' && messageRequests().length === 0, 'actual foreign or revoked reference never reaches receiver');
  }
  for (const name of ['policy', 'credential', 'recipient', 'source', 'attempt', 'cancel']) {
    await trustedPolicy();
    const job = await seed('qq', 'group', '{"password":"prepare-only-sensitive-' + serial + '"}'), controller = new AbortController();
    const original = app.PrivacyCore.configHooks.sealLocal; let held = false;
    app.PrivacyCore.configHooks.sealLocal = async (...args) => {
      if (!held) {
        held = true;
        if (name === 'policy') app.PrivacyGateway.configure(policy('off'));
        if (name === 'credential') process.env.RUYI_BOT_QQ_DISCLOSURE += '-prepare-changed';
        if (name === 'recipient') await edit(state => { state.connections[0].botUserId = 'prepare-another-bot'; });
        if (name === 'source') await edit(state => { state.items[0].execution.replyText = 'prepare-replacement-source'; });
        if (name === 'attempt') await edit(state => { state.items[0].delivery.attemptId = 'prepare_replacement_attempt'; });
        if (name === 'cancel') controller.abort();
      }
      return original(...args);
    };
    try {
      const result = await beginSend(job, controller);
      ok(held && result.status === 'failed' && messageRequests().length === 0, `held prepare ${name} refuses before message transport`);
      if (name === 'attempt') {
        // The stale attempt must also fail actual production settlement. Do not
        // restore its identity merely to make that actor appear current.
        let refusal;
        try { await finishSend(job, result); } catch (error) { refusal = error; }
        ok(refusal?.code === 'external_channel.delivery_unknown' && messageRequests().length === 0,
          'held prepare changed attempt retains the original production settlement refusal');
        await app.externalBotRecover();
      } else await finishSend(job, result);
    } finally { app.PrivacyCore.configHooks.sealLocal = original; }
  }
  for (const [start, middle] of [['enhanced','off'],['off','enhanced']]) {
    await trustedPolicy(start);const job=await seed();
    onToken=async()=>{app.PrivacyGateway.configure(policy(middle));app.PrivacyGateway.configure(policy(start));};
    const result=await send(job), before=JSON.stringify((await app.externalBotReadState()).items[0].execution);
    await app.externalBotDrain();
    ok(result.status==='failed'&&messageRequests().length===0&&JSON.stringify((await app.externalBotReadState()).items[0].execution)===before, 'held token '+start+' roundtrip refuses unsent body without replay');
  }
  for(const stage of ['persist','refreshed']) {
    await trustedPolicy();const job=await seed('qq','group','{"password":"epoch-closure-'+serial+'"}'),controller=new AbortController();
    const guard=app.PrivacyGateway.disclosurePolicyGuard(), original=app.PrivacyCore.configHooks.sealLocal;let reached=false;
    if(stage==='persist')app.PrivacyCore.configHooks.sealLocal=async(...args)=>{if(!reached){reached=true;app.PrivacyGateway.configure(policy('off'));app.PrivacyGateway.configure(policy());}return original(...args);};
    try {
      const result=await send(job,controller,(actualJob,actualController,dispatch)=>app.externalBotPrepareReply(actualJob,actualController,prepared=>{if(stage==='refreshed'){reached=true;app.PrivacyGateway.markUnavailable();app.PrivacyGateway.configure(policy());}return dispatch(prepared);},guard));
      ok(reached&&result.status==='failed'&&messageRequests().length===0&&(await app.externalBotReadState()).items[0].execution.status==='completed','policy epoch '+stage+' refuses before actual platform request, retaining completed execution');
    }finally{app.PrivacyCore.configHooks.sealLocal=original;}
  }
  await trustedPolicy();
  // Unrelated learning during host projection does not falsely deny a public reply.
  { const original = app.PrivacyCore.configHooks.sealLocal; let learned = false;
    await app.PrivacyGateway.withPolicy(app.STEWARD_SESSION_ID, async () => { app.PrivacyGateway.active().scope.protectValue('force-persistence-for-concurrent-learning', 'INTERNAL'); });
    app.PrivacyCore.configHooks.sealLocal = async (...args) => { if (!learned) { learned = true; app.PrivacyGateway.active().scope.protectValue('unrelated-concurrent-value', 'INTERNAL'); } return original(...args); };
    try {
      const job = await seed('qq', 'group', 'public unchanged reply'), result = await send(job);
      ok(learned && result.status === 'sent' && textOf(messageRequests()[0]) === 'public unchanged reply', 'parallel unrelated mapping learning refreshes and sends unchanged bytes');
    }
    finally { app.PrivacyCore.configHooks.sealLocal = original; }
  }
  for (const mode of ['reject', 'reset']) {
    const job = await seed(); responseMode = mode; const result = await send(job), before = JSON.stringify((await app.externalBotReadState()).items[0].execution); await app.externalBotDrain();
    ok(result.status === (mode === 'reject' ? 'failed' : 'unknown') && messageRequests().length === 1, `message ${mode} keeps failed/unknown distinction and no automatic retry`);
    ok(JSON.stringify((await app.externalBotReadState()).items[0].execution) === before, `message ${mode} never reruns completed business`);
  }
})().catch(error => { console.error(error.stack || error); t.fail('uncaught fixture error'); }).finally(async () => {
  // Even a caller failure keeps the original SendJob promise until its actual
  // settlement. A late successful result never removes the earlier failure.
  const pending = [...sends.values()];
  for (const row of pending) row.release();
  const settled = await Promise.allSettled(pending.map(row => row.run));
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i]; if (row.abort) row.controller.signal.removeEventListener('abort', row.abort);
    if (settled[i].status === 'rejected') { console.error(settled[i].reason?.stack || settled[i].reason); t.fail('original bot settlement cleanup failed'); }
  }
  sends.clear();
  app.__eval('externalBotPrepareReply = globalThis.__botDisclosureObserver.originalPrepare; externalBotFinishJob = globalThis.__botDisclosureObserver.originalFinish; delete globalThis.__botDisclosureObserver;');
  if (restore) restore(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  vault.clear(); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
