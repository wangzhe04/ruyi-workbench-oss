'use strict';
// Generated gateway + authoritative bot ledger + actual official API transport.
// Synthetic credentials and loopback HTTP only; no model, accounts or child processes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { once } = require('node:events');
const { createRunner } = require('./lib/harness');
const { install } = require('./lib/external-channel-delivery-preload');
const { fixture } = require('./lib/privacy-test-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-bot-disclosure-e2e-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
process.env.RUYI_BOT_QQ_DISCLOSURE = 'synthetic-qq-vault-secret';
process.env.RUYI_BOT_FEISHU_DISCLOSURE = 'synthetic-feishu-vault-secret';
process.env.RUYI_BOT_VERIFICATION_DISCLOSURE = 'synthetic-verification-secret';
process.env.RUYI_BOT_ENCRYPT_DISCLOSURE = 'synthetic-encrypt-secret';
const app = require('./lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'PrivacyRegex', 'ExternalChannelDelivery',
  'externalBotNormalizeConnection', 'externalBotWriteState', 'externalBotReadState', 'externalBotNextJob', 'externalBotFinishJob', 'externalBotPrepareReply',
  'externalBotRecover', 'externalBotDrain', 'externalBotBoundReplyText', 'externalBotReplyText', 'STEWARD_SESSION_ID'], { withEval: true });
const t = createRunner('PRIVACY BOT DISCLOSURE'), { ok } = t;
const vault = fixture().vault;
app.PrivacyCore.configHooks.sealLocal = vault.sealLocal; app.PrivacyCore.configHooks.openLocal = vault.openLocal;
let server, restore, requests = [], onToken, responseMode = '', serial = 0;
const policy = (mode = 'enhanced', extra = {}) => ({ privacyModeV1: mode, privacyRulesV1: [], providers: [], ...extra });
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
async function send(job, controller = new AbortController()) {
  const assertPolicy = app.PrivacyGateway.disclosurePolicyGuard();
  const result = await app.PrivacyGateway.withPolicy(app.STEWARD_SESSION_ID, () => app.ExternalChannelDelivery.sendReply(job.connection, job.item, job.item.execution.replyText,
    { attemptId: job.item.delivery.attemptId, signal: controller.signal, timeoutMs: 5000,
      prepare: dispatch => app.externalBotPrepareReply(job, controller, dispatch, assertPolicy) }));
  await app.externalBotFinishJob(job, result); return result;
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
    app.PrivacyGateway.configure(policy(mode));
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
    app.PrivacyGateway.configure(policy(mode));
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
    app.PrivacyGateway.configure(policy(mode)); const job = await seed(); onToken = mutate;
    // A changed attempt cannot be settled as the original; test delivery refuses
    // first, then restore only that test ledger identity before normal settlement.
    const result = await app.PrivacyGateway.withPolicy(app.STEWARD_SESSION_ID, () => app.ExternalChannelDelivery.sendReply(job.connection, job.item, job.item.execution.replyText,
      { attemptId: job.item.delivery.attemptId, prepare: dispatch => app.externalBotPrepareReply(job, new AbortController(), dispatch) }));
    ok(result.status === 'failed' && messageRequests().length === 0, `held token ${name} refuses before any message request`);
    if (name === 'attempt') await edit(state => { state.items[0].delivery.attemptId = job.item.delivery.attemptId; });
    await app.externalBotFinishJob(job, result);
    const before = JSON.stringify((await app.externalBotReadState()).items[0].execution); await app.externalBotDrain();
    ok((await app.externalBotReadState()).items[0].delivery.status === 'failed' && JSON.stringify((await app.externalBotReadState()).items[0].execution) === before && messageRequests().length === 0, `held token ${name} preserves completed execution and never replays`);
  }
  app.PrivacyGateway.configure(policy());
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
    app.PrivacyGateway.configure(policy());
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
      const result = await app.PrivacyGateway.withPolicy(app.STEWARD_SESSION_ID, () => app.ExternalChannelDelivery.sendReply(job.connection, job.item, job.item.execution.replyText,
        { attemptId: job.item.delivery.attemptId, signal: controller.signal, prepare: dispatch => app.externalBotPrepareReply(job, controller, dispatch) }));
      ok(held && result.status === 'failed' && messageRequests().length === 0, `held prepare ${name} refuses before message transport`);
    } finally { app.PrivacyCore.configHooks.sealLocal = original; }
  }
  for (const [start, middle] of [['enhanced','off'],['off','enhanced']]) {
    app.PrivacyGateway.configure(policy(start));const job=await seed();
    onToken=async()=>{app.PrivacyGateway.configure(policy(middle));app.PrivacyGateway.configure(policy(start));};
    const result=await send(job), before=JSON.stringify((await app.externalBotReadState()).items[0].execution);
    await app.externalBotDrain();
    ok(result.status==='failed'&&messageRequests().length===0&&JSON.stringify((await app.externalBotReadState()).items[0].execution)===before, 'held token '+start+' roundtrip refuses unsent body without replay');
  }
  for(const stage of ['persist','refreshed']) {
    app.PrivacyGateway.configure(policy());const job=await seed('qq','group','{"password":"epoch-closure-'+serial+'"}'),controller=new AbortController();
    const guard=app.PrivacyGateway.disclosurePolicyGuard(), original=app.PrivacyCore.configHooks.sealLocal;let reached=false;
    if(stage==='persist')app.PrivacyCore.configHooks.sealLocal=async(...args)=>{if(!reached){reached=true;app.PrivacyGateway.configure(policy('off'));app.PrivacyGateway.configure(policy());}return original(...args);};
    try {
      const result=await app.PrivacyGateway.withPolicy(app.STEWARD_SESSION_ID,()=>app.ExternalChannelDelivery.sendReply(job.connection,job.item,job.item.execution.replyText,{attemptId:job.item.delivery.attemptId,prepare:dispatch=>app.externalBotPrepareReply(job,controller,prepared=>{if(stage==='refreshed'){reached=true;app.PrivacyGateway.markUnavailable();app.PrivacyGateway.configure(policy());}return dispatch(prepared);},guard)}));
      await app.externalBotFinishJob(job,result);
      ok(reached&&result.status==='failed'&&messageRequests().length===0&&(await app.externalBotReadState()).items[0].execution.status==='completed','policy epoch '+stage+' refuses before actual platform request, retaining completed execution');
    }finally{app.PrivacyCore.configHooks.sealLocal=original;}
  }
  app.PrivacyGateway.configure(policy());
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
  if (restore) restore(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  vault.clear(); fs.rmSync(root, { recursive: true, force: true }); t.done();
});
