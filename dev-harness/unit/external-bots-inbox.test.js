'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-external-work-data-unit-'));
const fixtureKeys = [];
after(() => {
  fixtureKeys.forEach(key => key.fill(0));
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-external-work-data-unit-'));
  fs.rmSync(root, { recursive: true, force: true });
});
const until = async predicate => {
  const end = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > end) throw new Error('fixture timeout'); await new Promise(resolve => setTimeout(resolve, 1)); }
};
const { constBlock, functionBlock } = require('../lib/source-slice');
const src = file => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'ledger-')), file = path.join(dir, 'external-bots', 'state-v1.json');
  const fx = loadWorkDataChunks(), key = options.key || crypto.randomBytes(32);
  fixtureKeys.push(key);
  const storage = { enabled: options.enabled === true, missing: false, unlocks: 0, readError: null };
  fx.store.Hooks.keys = { unlock: async () => { storage.unlocks++; if (storage.missing) throw Object.assign(new Error('missing'), { code: 'work_data_key.absent' }); return key; }, instance: async () => 'external-bots-unit' };
  let writeFailure = false, writeGate = null, writes = 0, verified = 0, runs = 0, sends = 0, modelGate = null, modelError = null, sendGate = null, sendResult = { status: 'sent', messageId: 'platform_reply' };
  const envReads = []; const localCredentials = new Map(); let credentialRevision = 0, clockOffset = 0;
  class FixtureDate extends Date { static now() { return Date.now() + clockOffset; } }
  const read = () => fs.readFileSync(file, 'utf8');
  const context = vm.createContext({ Buffer, TextDecoder, URL, URLSearchParams, AbortController, Date: FixtureDate, setTimeout, clearTimeout, crypto, path,
    fs, fsp: { ...fsp, stat: async (...args) => { if (storage.readError) throw storage.readError; return fsp.stat(...args); } },
    WorkDataStore: fx.store, readConfig: async () => ({ workDataEncryptionV1: storage.enabled }),
    process: { env: new Proxy({ RUYI_BOT_QQ: 'TEST_ONLY_FAKE_KEY' }, { get(object, key) { envReads.push(key); assert.match(key, /^RUYI_BOT_/); return object[key]; } }) },
    paths: { data: dir }, OVERLAY_ID: 'epoch_' + crypto.randomBytes(6).toString('hex'), ExternalBotHooks: {}, nowIso: () => new Date().toISOString(), makeId: prefix => prefix + '_' + crypto.randomBytes(8).toString('hex'),
    STEWARD_SESSION_ID: 'fixture-steward', PrivacyGateway: { withPolicy: (_scope, work) => work(), disclosurePolicyGuard: () => () => {} },
    atomicWriteJson: async (...args) => { writes++; if (writeGate) await writeGate; if (writeFailure) throw new Error('disk full'); return fx.atomicWriteJson(...args); },
    ExternalChannelProtocols: { verifyAndNormalize(_platform, _connection, _headers, raw) { verified++; return { kind: 'message', message: JSON.parse(raw.toString('utf8')) }; } },
    runStewardTurn: async input => { await context.ExternalBotHooks.validateActor(input.externalActor); assert.equal(input.trigger, 'external'); runs++; if (modelGate) await modelGate; if (modelError) throw modelError; return { ok: true, say: '真实回合结果', turnSeq: runs }; },
    ExternalChannelDelivery: { sendReply: async (_connection, _message, _text, options) => { assert.ok(options.attemptId); sends++; if (sendGate) await Promise.race([sendGate, new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))]); return options.signal.aborted ? { status: 'failed', errorCode: 'external_delivery.aborted' } : sendResult; } },
  });
  context.ExternalBotCredentials = {
    async snapshot(connection) {
      const values = {}, fields = {}, saved = localCredentials.get(connection.id) || {};
      for (const slot of connection.platform === 'qq' ? ['botSecret'] : ['verificationToken', 'encryptKey', 'appSecret']) {
        const ref = connection[slot + 'Env']; const value = ref ? context.process.env[ref] || '' : saved[slot] || '';
        values[slot] = value; fields[slot] = { source: ref ? 'env' : value ? 'local' : 'none', present: !!value, ready: !!value, errorCode: '' };
      }
      return { values, fields, credentialRevision: crypto.createHash('sha256').update(JSON.stringify([credentialRevision, values])).digest('hex') };
    },
    async inspect(connection) { const {values,...rest}=await this.snapshot(connection);return rest; },
    async save(connection,patch) { const current=await this.snapshot(connection);assert.equal(patch.expectedRevision,current.credentialRevision);const values={...localCredentials.get(connection.id),...patch.set};for(const slot of patch.remove||[])delete values[slot];localCredentials.set(connection.id,values);credentialRevision++;return this.inspect(connection); },
  };
  vm.runInContext(functionBlock(src('00-boot.js'), 'runKeyedChain')
    + src('13w-external-bots.js') + `;globalThis.api={
      read:externalBotReadState,write:externalBotWriteState,publicConnection:externalBotPublicConnection,
      page:async query=>externalBotDeliveryPage(await externalBotReadState(),new URLSearchParams(query)),archive:body=>runKeyedChain(externalBotChains,'state',()=>externalBotArchiveDelivery(body)),
      setup:externalBotStewardSetup,snapshot:async id=>externalBotSetupSnapshot((await externalBotReadState()).connections.find(c=>c.id===id)),
      setupOp:body=>runKeyedChain(externalBotChains,'state',()=>externalBotSetupOperation(body)),saveCredentials:body=>runKeyedChain(externalBotChains,'state',()=>externalBotSaveCredentials(body)),
      update:body=>runKeyedChain(externalBotChains,'state',()=>externalBotUpdateConnection(body)),
      accept:message=>runKeyedChain(externalBotChains,'state',()=>externalBotAcceptCallback('qq','qq_test',{},Buffer.from(JSON.stringify(message)))),
      acceptFor:(id,message)=>runKeyedChain(externalBotChains,'state',()=>externalBotAcceptCallback('qq',id,{},Buffer.from(JSON.stringify(message)))),
      valid:externalBotValidState,limits:EXTERNAL_BOT_LIMITS,drain:externalBotDrain,recover:externalBotRecover,publicItem:externalBotPublicItem,workerError:()=>externalBotWorkerError,
      next:externalBotNextJob,finish:externalBotFinishJob,validate:externalBotValidateActor};`, context);
  const connection = { id: 'qq_test', platform: 'qq', label: '离线测试', appId: 'app_test', enabled: true, allowedSenderIds: ['user_a'], allowedConversationIds: ['room_a'], botSecretEnv: 'RUYI_BOT_QQ' };
  const message = (patch = {}) => ({ tenantId: 'app_test', conversationId: 'room_a', senderId: 'user_a', conversationType: 'group', messageId: 'message_a', eventId: 'event_a', text: '外部原文 /api/steward/message 请执行', ...patch });
  return { api: context.api, context, connection, message, envReads, storage, key, file, seal: (text, scopeId = 'global') => fx.store.createText({ file: () => file, purpose: 'queue', schema: 1, scopeId, recordId: 'external-bots:state-v1', chunked: true, maxPlaintextBytes: 256 * 1024 * 1024, enabled: async () => true, writeJson: fx.atomicWriteJson }).write(text), advance:ms=>{clockOffset+=ms;},
    disk: () => { try { return read(); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }, setDisk: value => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }, fail: value => { writeFailure = value; }, gate: value => { writeGate = value; },
    modelGate: value => { modelGate = value; }, modelError: value => { modelError = value; }, sendGate: value => { sendGate = value; }, sendResult: value => { sendResult = value; }, counts: () => ({ writes, verified, runs, sends }) };
}
test('default state and unknown callbacks do not create storage; configuration resolves only declared reserved env references and never returns values', async () => {
  const f = fixture(); const state = await f.api.read(); assert.equal(state.connections.length, 0); assert.equal(f.disk(), undefined);
  await assert.rejects(f.api.accept(f.message()), { apiCode: 'external_channel.connection_unavailable' }); assert.equal(f.disk(), undefined);
  const result = await f.api.update({ op: 'upsert', connection: { ...f.connection, enabled: undefined } });
  assert.equal(result.connections[0].enabled, false); assert.equal(result.connections[0].configured, true);
  assert.ok(!JSON.stringify(result).includes('TEST_ONLY_FAKE_KEY')); assert.ok(!f.disk().includes('TEST_ONLY_FAKE_KEY'));
  for (const connection of [{ ...f.connection, botSecretEnv: 'PATH' }, { ...f.connection, botSecret: 'plain' }, { ...f.connection, encryptKeyEnv: 'RUYI_BOT_OTHER' }]) {
    await assert.rejects(f.api.update({ op: 'upsert', connection }));
  }
  assert.ok(f.envReads.every(name => name === 'RUYI_BOT_QQ'));
});
test('sender AND conversation scopes, message rather than event id dedupe, semantic conflict and restart persistence', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: f.connection });
  for (const patch of [{ senderId: 'other' }, { conversationId: 'other' }, { tenantId: 'other' }]) await assert.rejects(f.api.accept(f.message(patch)), { apiCode: 'external_channel.source_forbidden' });
  await f.api.accept(f.message()); await f.api.accept(f.message({ eventId: 'event_b' }));
  assert.equal((await f.api.read()).items.length, 1);
  await assert.rejects(f.api.accept(f.message({ text: 'different' })), { apiCode: 'external_channel.message_conflict' });
  const next = fixture(); next.setDisk(f.disk()); await next.api.accept(next.message({ eventId: 'event_after_restart' }));
  assert.equal((await next.api.read()).items.length, 1); assert.equal(next.counts().writes, 0);
});
test('ACK waits for disk commit; failed writes and corrupt/schema-less ledgers fail closed rather than manufacturing dedupe evidence', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: f.connection });
  f.fail(true); await assert.rejects(f.api.accept(f.message()), { apiCode: 'external_channel.storage_unavailable' });
  assert.equal((await f.api.read()).items.length, 0); f.fail(false);
  let release; f.gate(new Promise(resolve => { release = resolve; })); let settled = false;
  const accepted = f.api.accept(f.message()).then(() => { settled = true; });
  await until(() => f.counts().writes === 2); assert.equal(settled, false); assert.equal(JSON.parse(f.disk()).items.length, 0);
  release(); await accepted; assert.equal((await f.api.read()).items.length, 1);
  for (const corrupt of ['{', '{"connections":[],"items":[]}', '{"schema":99,"connections":[],"items":[],"retiredConnectionIds":[]}']) {
    f.setDisk(corrupt); await assert.rejects(f.api.read(), { apiCode: 'external_channel.storage_unavailable' }); assert.equal(f.disk(), corrupt);
  }
});
test('disable/reconfigure share the ingestion chain; retired and changed application identities cannot reuse previous authority', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: f.connection });
  const disabled = f.api.update({ op: 'disable', id: 'qq_test' });
  const arrival = f.api.accept(f.message()); await disabled;
  await assert.rejects(arrival, { apiCode: 'external_channel.connection_unavailable' }); assert.equal(f.counts().verified, 0);
  await assert.rejects(f.api.update({ op: 'upsert', connection: { ...f.connection, appId: 'other_app' } }), { apiCode: 'external_channel.identity_immutable' });
  await f.api.update({ op: 'delete', id: 'qq_test' });
  await assert.rejects(f.api.update({ op: 'upsert', connection: f.connection }), { apiCode: 'external_channel.connection_retired' });
  const next = fixture(); next.setDisk(f.disk()); await assert.rejects(next.api.update({ op: 'upsert', connection: next.connection }), { apiCode: 'external_channel.connection_retired' });
});
test('capacity retains every received/dedupe record and invalid rows or oversized retired-id sets are rejected whole', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: f.connection }); await f.api.accept(f.message());
  const state = JSON.parse(f.disk()); const first = state.items[0];
  for (let i = 1; i < f.api.limits.items; i++) state.items.push({ ...first, id: 'item_' + i, messageId: 'message_' + i, sourceKey: JSON.stringify(['qq_test','app_test','room_a','message_' + i]) });
  f.setDisk(JSON.stringify(state)); await assert.rejects(f.api.accept(f.message({ messageId: 'new_message' })), { apiCode: 'external_channel.inbox_full' });
  assert.equal((await f.api.read()).items.length, 1000); await f.api.accept(f.message({ eventId: 'duplicate_when_full' }));
  const invalid = plain(state); invalid.items[0] = null; assert.equal(f.api.valid(invalid), false);
  invalid.items = []; invalid.retiredConnectionIds = Array.from({ length: 4097 }, (_, i) => 'old_' + i); assert.equal(f.api.valid(invalid), false);
});

const controlConnection = f => ({ ...f.connection, mode: 'control', ownerSenderId: 'user_a', ownerConversationId: 'room_a', ownerConversationType: 'group' });
test('control requires explicit local confirmation, stable id retries and opaque item-bound capability; normal allowed peers remain inbox-only', async () => {
  const f = fixture(); const connection = controlConnection(f);
  await assert.rejects(f.api.update({ op: 'upsert', connection }), { apiCode: 'external_channel.control_confirmation_required' });
  await assert.rejects(f.api.update({ op: 'upsert', connection: { ...connection, id: undefined }, controlConfirmed: true }), { apiCode: 'external_channel.connection_invalid' });
  const first = await f.api.update({ op: 'upsert', connection, controlConfirmed: true });
  const retry = await f.api.update({ op: 'upsert', connection, controlConfirmed: true });
  assert.equal(retry.connections.length, 1); assert.equal(first.connections[0].controlRevision, retry.connections[0].controlRevision);
  await f.api.accept(f.message()); const job = await f.api.next(); assert.equal(job.kind, 'run');
  assert.equal((await f.api.validate(job.actor)).itemId, job.item.id);
  await assert.rejects(f.api.validate({ ...plain(job.item.control), itemId: job.item.id }), { apiCode: 'external_channel.control_revoked' });
  await f.api.update({ op: 'disable', id: 'qq_test' });
  await assert.rejects(f.api.validate(job.actor), { apiCode: 'external_channel.control_revoked' });
  const peer = fixture(); await peer.api.update({ op: 'upsert', connection: { ...controlConnection(peer), allowedSenderIds: ['user_a','peer'] }, controlConfirmed: true });
  await peer.api.accept(peer.message({ senderId: 'peer' })); assert.equal((await peer.api.read()).items[0].execution, null);
});
test('control admission commits running before invocation, persists result before send and never reruns duplicate deliveries', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true });
  await f.api.accept(f.message()); let release; f.modelGate(new Promise(resolve => { release = resolve; }));
  const running = f.api.drain(); await until(() => f.counts().runs === 1);
  assert.equal((await f.api.read()).items[0].execution.status, 'running'); assert.equal(f.counts().runs, 1); assert.equal(f.counts().sends, 0);
  await f.api.accept(f.message({ eventId: 'retry_while_running' })); release(); await running;
  const item = (await f.api.read()).items[0]; assert.equal(item.execution.status, 'completed'); assert.equal(item.delivery.status, 'sent');
  await f.api.accept(f.message({ eventId: 'retry_after_completed' })); await f.api.drain(); assert.equal(f.counts().runs, 1); assert.equal(f.counts().sends, 1);
});
test('restart resumes only queued work after authority recheck; old running and sending become unknown without replay', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  const next = fixture(); next.setDisk(f.disk()); await next.api.drain(); assert.equal(next.counts().runs, 1); assert.equal(next.counts().sends, 1);
  const active = fixture(); active.setDisk(f.disk()); await active.api.next();
  const crashed = fixture(); crashed.setDisk(active.disk()); await crashed.api.drain();
  assert.equal((await crashed.api.read()).items[0].execution.status, 'unknown'); assert.equal(crashed.counts().runs, 0); assert.equal(crashed.counts().sends, 0);
  const sending = fixture(); sending.setDisk(f.disk()); const job = await sending.api.next(); await sending.api.finish(job, { ok: true, say: 'reply' }); await sending.api.next();
  const sendCrash = fixture(); sendCrash.setDisk(sending.disk()); await sendCrash.api.drain();
  assert.equal((await sendCrash.api.read()).items[0].delivery.status, 'unknown'); assert.equal(sendCrash.counts().runs, 0); assert.equal(sendCrash.counts().sends, 0);
});
test('write failure blocks running side effects, revoked queued work never invokes runner, and platform uncertainty is not marked sent or retried', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  f.fail(true); await f.api.drain(); assert.equal(f.counts().runs, 0); assert.equal((await f.api.read()).items[0].execution.status, 'queued');
  f.fail(false); await f.api.update({ op: 'disable', id: 'qq_test' }); await f.api.drain(); assert.equal(f.counts().runs, 0); assert.equal((await f.api.read()).items[0].execution.status, 'failed');
  const uncertain = fixture(); await uncertain.api.update({ op: 'upsert', connection: controlConnection(uncertain), controlConfirmed: true }); await uncertain.api.accept(uncertain.message());
  uncertain.sendResult({ status: 'unknown', errorCode: 'external_channel.delivery_unknown' }); await uncertain.api.drain();
  assert.equal((await uncertain.api.read()).items[0].delivery.status, 'unknown'); await uncertain.api.drain(); assert.equal(uncertain.counts().runs, 1); assert.equal(uncertain.counts().sends, 1);
});
test('a failed completion write projects unknown with a visible worker error and next recovery settles unknown without re-execution', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  let release; f.modelGate(new Promise(resolve => { release = resolve; })); const running = f.api.drain();
  await until(() => f.counts().runs === 1); f.fail(true); release(); await running;
  const raw = (await f.api.read()).items[0]; assert.equal(raw.execution.status, 'running');
  assert.equal(f.api.publicItem(raw).execution.status, 'unknown'); assert.equal(f.api.workerError(), 'external_channel.storage_unavailable');
  f.fail(false); await f.api.drain(); assert.equal((await f.api.read()).items[0].execution.status, 'unknown'); assert.equal(f.counts().runs, 1); assert.equal(f.counts().sends, 0);
});
test('disable aborts an in-flight delivery and retains the typed delivery error rather than claiming an unknown success', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  f.sendGate(new Promise(() => {})); const pending = f.api.drain(); await until(() => f.counts().sends === 1);
  assert.equal(f.counts().sends, 1); await f.api.update({ op: 'disable', id: 'qq_test' }); await pending;
  const item = (await f.api.read()).items[0]; assert.equal(item.delivery.status, 'failed'); assert.equal(item.delivery.errorCode, 'external_delivery.aborted');
});
test('unexpected runner exceptions are unknown without retry advice or replay, and structured action facts remain distinct from a completed turn', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  f.modelError(new Error('unexpected after a possible tool effect')); await f.api.drain();
  let item = (await f.api.read()).items[0]; assert.equal(item.execution.status, 'unknown'); assert.ok(item.execution.replyText.includes('查询现有任务')); assert.ok(!item.execution.replyText.includes('后重试'));
  await f.api.accept(f.message({ eventId: 'retry_unknown' })); await f.api.drain(); assert.equal(f.counts().runs, 1);
  const other = fixture(); await other.api.update({ op: 'upsert', connection: controlConnection(other), controlConfirmed: true }); await other.api.accept(other.message());
  const job = await other.api.next(); await other.api.finish(job, { ok: true, say: '模型答复', toolFailures: 2, toolProposals: 3, contractIncomplete: true, acts: [{ tool: 'proposal' }], actions: [{ result: { ok: false, error: 'failed' } }] });
  item = (await other.api.read()).items[0]; assert.equal(item.execution.status, 'completed'); assert.equal(item.execution.actionFailures, 3); assert.equal(item.execution.proposals, 4); assert.equal(item.execution.contractIncomplete, true); assert.ok(item.execution.replyText.includes('后续选项')); assert.ok(item.execution.replyText.includes('操作失败'));
});

async function prepared(f) { const result=await f.api.setup({op:'prepare',platform:'qq',appId:'app_test',label:'Prepared'},{trigger:'user'}); return result.connectionId; }
async function pairable(f,id) { let view=await f.api.snapshot(id);await f.api.saveCredentials({connectionId:id,expectedSetupToken:view.expectedSetupToken,credentials:{set:{botSecret:'SYNTHETIC_LOCAL_SECRET'},remove:[]}});view=await f.api.snapshot(id);return f.api.setupOp({op:'pair_start',connectionId:id,expectedSetupToken:view.expectedSetupToken}); }
test('setup preparation accepts only a local user, complete non-secret identity, and reuses exact disabled identity without modifying it',async()=>{
 const f=fixture();for(const trigger of ['external','inbox','visit',''])assert.equal((await f.api.setup({op:'prepare',platform:'qq',appId:'app_test'},{trigger})).error,'steward.forbidden');
 for(const key of ['secret','enabled','ownerSenderId','controlConfirmed','trigger'])assert.equal((await f.api.setup({op:'prepare',platform:'qq',appId:'app_test',[key]:'NEVER_ECHO_THIS'},{trigger:'user'})).error,'invalid_request');
 const missing=await f.api.setup({op:'prepare',platform:'feishu',appId:'f_app'},{trigger:'user'});assert.deepEqual(plain(missing.missing),['tenantId','botUserId']);assert.equal(f.disk(),undefined);
 const id=await prepared(f),before=f.disk();const same=await f.api.setup({op:'prepare',platform:'qq',appId:'app_test',label:'other'},{trigger:'user'});assert.equal(same.connectionId,id);assert.equal(f.disk(),before);
 const row=(await f.api.read()).connections[0];assert.equal(row.enabled,false);assert.equal(row.mode,'inbox');assert.equal(row.ownerSenderId,'');
 await f.api.update({op:'upsert',connection:{...f.connection,id}});const unchanged=f.disk();assert.equal((await f.api.setup({op:'prepare',platform:'qq',appId:'app_test'},{trigger:'user'})).error,'external_channel.setup_existing_conflict');assert.equal(f.disk(),unchanged);
});
test('pairing authenticates only exact text, fixes the first candidate, and captures no inbox/model/delivery side effect',async()=>{
 const f=fixture(),id=await prepared(f),waiting=await pairable(f,id);assert.match(waiting.pairing.code,/^RUYI-[A-Za-z0-9_-]{22}$/);
 await f.api.acceptFor(id,f.message({messageId:'setup_ignored',text:'wrong '+waiting.pairing.code}));assert.equal((await f.api.snapshot(id)).pairing.candidate,null);
 await Promise.all([f.api.acceptFor(id,f.message({text:waiting.pairing.code})),f.api.acceptFor(id,f.message({senderId:'other',conversationId:'other_room',text:waiting.pairing.code}))]);
 const view=await f.api.snapshot(id);assert.equal(view.pairing.candidate.senderId,'user_a');assert.equal(view.pairing.code,undefined);assert.equal((await f.api.read()).items.length,0);assert.equal(f.counts().runs,0);assert.equal(f.counts().sends,0);
 const diagnostic=await f.api.setup({op:'inspect',connectionId:id},{});assert.ok(!JSON.stringify(diagnostic).includes(waiting.pairing.code));assert.ok(!JSON.stringify(diagnostic).includes('SYNTHETIC_LOCAL_SECRET'));assert.equal(diagnostic.connections[0].evidence.receivedMessages,0);
 await assert.rejects(f.api.setupOp({op:'activate',connectionId:id,expectedSetupToken:waiting.expectedSetupToken,controlConfirmed:true}),{code:'external_channel.setup_conflict'});
 await assert.rejects(f.api.setupOp({op:'activate',connectionId:id,expectedSetupToken:view.expectedSetupToken}),{code:'external_channel.control_confirmation_required'});
 const active=await f.api.setupOp({op:'activate',connectionId:id,expectedSetupToken:view.expectedSetupToken,controlConfirmed:true});assert.equal(active.connection.enabled,true);assert.equal(active.connection.mode,'control');assert.deepEqual(plain(active.connection.allowedSenderIds),['user_a']);assert.deepEqual(plain(active.connection.allowedConversationIds),['room_a']);assert.equal(active.connection.ownerConversationType,'group');assert.equal(active.pairing,null);await f.api.acceptFor(id,f.message({text:waiting.pairing.code,eventId:'redelivery'}));await f.api.acceptFor(id,f.message({messageId:'setup_ignored',text:'wrong '+waiting.pairing.code,eventId:'redelivery_ignored'}));await f.api.drain();assert.equal((await f.api.read()).items.length,0);assert.equal(f.counts().runs,0);assert.ok(!f.disk().includes(waiting.pairing.code));
 await assert.rejects(f.api.setupOp({op:'activate',connectionId:id,expectedSetupToken:view.expectedSetupToken,controlConfirmed:true}),{code:'external_channel.setup_conflict'});
});
test('pairing expires and restarts fail old confirmations without durable pairing authority',async()=>{
 const f=fixture(),id=await prepared(f),waiting=await pairable(f,id);await f.api.acceptFor(id,f.message({text:waiting.pairing.code}));const candidate=await f.api.snapshot(id);f.advance(300001);assert.equal((await f.api.snapshot(id)).pairing,null);
 await assert.rejects(f.api.setupOp({op:'activate',connectionId:id,expectedSetupToken:candidate.expectedSetupToken,controlConfirmed:true}),{code:'external_channel.setup_conflict'});
 const restarted=fixture();restarted.setDisk(f.disk());assert.equal((await restarted.api.snapshot(id)).pairing,null);await assert.rejects(restarted.api.setupOp({op:'pair_start',connectionId:id,expectedSetupToken:candidate.expectedSetupToken}),{code:'external_channel.setup_conflict'});
 assert.ok(!f.disk().includes(waiting.pairing.code));assert.equal((await restarted.api.read()).connections[0].enabled,false);
});
test('configuration and credential changes revoke pairing and every old setup snapshot, including non-authority label changes',async()=>{
 const f=fixture(),id=await prepared(f);let waiting=await pairable(f,id);const row=(await f.api.read()).connections[0],{controlRevision,...fields}=plain(row);await f.api.update({op:'upsert',connection:{...fields,label:'changed'}});assert.equal((await f.api.snapshot(id)).pairing,null);await assert.rejects(f.api.setupOp({op:'pair_start',connectionId:id,expectedSetupToken:waiting.expectedSetupToken}),{code:'external_channel.setup_conflict'});
 waiting=await pairable(f,id);await f.api.saveCredentials({connectionId:id,expectedSetupToken:waiting.expectedSetupToken,credentials:{set:{botSecret:'REPLACED_LOCAL_SECRET'},remove:[]}});assert.equal((await f.api.snapshot(id)).pairing,null);await assert.rejects(f.api.setupOp({op:'pair_start',connectionId:id,expectedSetupToken:waiting.expectedSetupToken}),{code:'external_channel.setup_conflict'});
});
test('activation waits for the authoritative atomic write and a failed write grants no control',async()=>{
 const f=fixture(),id=await prepared(f),waiting=await pairable(f,id);await f.api.acceptFor(id,f.message({text:waiting.pairing.code}));const view=await f.api.snapshot(id);f.fail(true);await assert.rejects(f.api.setupOp({op:'activate',connectionId:id,expectedSetupToken:view.expectedSetupToken,controlConfirmed:true}),{code:'external_channel.storage_unavailable'});assert.equal((await f.api.read()).connections[0].enabled,false);assert.equal((await f.api.snapshot(id)).pairing.state,'candidate');
 f.fail(false);await f.api.setupOp({op:'activate',connectionId:id,expectedSetupToken:view.expectedSetupToken,controlConfirmed:true});assert.equal((await f.api.read()).connections[0].enabled,true);
});
test('legacy disabled incomplete identities and one credential fault do not turn a committed mutation or the whole list into a false failure',async()=>{
 const f=fixture();const snapshot=f.context.ExternalBotCredentials.snapshot;f.context.ExternalBotCredentials.snapshot=async c=>{if(c.platform==='feishu')throw Object.assign(new Error('safe-code-only'),{code:'external_credentials.identity_invalid'});return snapshot(c);};
 const result=await f.api.update({op:'upsert',connection:{id:'legacy',platform:'feishu',appId:'f_legacy',enabled:false}});assert.equal(result.ok,true);assert.equal(result.connections[0].configured,false);assert.equal(result.connections[0].credentialError,'external_credentials.identity_invalid');
 await f.api.update({op:'upsert',connection:f.connection});const view=await f.api.snapshot('legacy');assert.equal(view.readiness.ingressReady,false);assert.equal(view.readiness.errorCode,'external_credentials.identity_invalid');assert.equal((await f.api.update({op:'disable',id:'legacy'})).connections.length,2);assert.equal((await f.api.update({op:'delete',id:'legacy'})).connections.length,1);
});
test('setup-only evidence commits before candidate/ACK and a failed write cannot create even a temporary identity proof',async()=>{
 const f=fixture(),id=await prepared(f),waiting=await pairable(f,id);f.fail(true);
 await assert.rejects(f.api.acceptFor(id,f.message({text:waiting.pairing.code})),{code:'external_channel.storage_unavailable'});
 assert.equal((await f.api.snapshot(id)).pairing.candidate,null);assert.equal((await f.api.read()).setupReceipts,undefined);
 f.fail(false);await f.api.acceptFor(id,f.message({text:waiting.pairing.code}));assert.equal((await f.api.snapshot(id)).pairing.state,'candidate');assert.equal((await f.api.read()).setupReceipts.length,1);
});
test('setup-only receipt capacity rejects new messages without evicting old dedupe, and corrupt receipt integrity fails the whole ledger closed',async()=>{
 const f=fixture(),id=await prepared(f),waiting=await pairable(f,id);await f.api.acceptFor(id,f.message({messageId:'ignored',text:'not the pairing code'}));
 const state=plain(await f.api.read()),first=state.setupReceipts[0];state.setupReceipts=Array.from({length:4096},(_,index)=>({...first,messageId:'setup_'+index,sourceKey:JSON.stringify([id,first.tenantId,first.conversationId,'setup_'+index])}));f.setDisk(JSON.stringify(state));
 await assert.rejects(f.api.acceptFor(id,f.message({text:waiting.pairing.code})),{code:'external_channel.setup_receipts_full'});assert.equal((await f.api.snapshot(id)).pairing.candidate,null);assert.equal((await f.api.read()).setupReceipts.length,4096);
 state.setupReceipts[0].senderId='tampered';f.setDisk(JSON.stringify(state));await assert.rejects(f.api.read(),{code:'external_channel.storage_unavailable'});
});
test('oversized complete reply preserves completed business and fails only delivery without a private prefix', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  const job = await f.api.next(); await f.api.finish(job, { ok: true, say: 'PRIVATE_PREFIX' + '私'.repeat(400000), turnSeq: 7 });
  const item = (await f.api.read()).items[0];
  assert.equal(item.execution.status, 'completed'); assert.equal(item.execution.turnSeq, 7); assert.equal(item.delivery.status, 'failed');
  assert.equal(item.delivery.errorCode, 'external_delivery.source_limit'); assert.ok(!item.execution.replyText.includes('PRIVATE_PREFIX'));
  await f.api.drain(); assert.equal(f.counts().runs, 0); assert.equal(f.counts().sends, 0);
});
test('outbox capacity refuses oversized projection source without widening state cap or losing completed business', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  const job = await f.api.next(), state = await f.api.read();
  for (let i = 0; i < 39; i++) {
    const item = plain(state.items[0]); item.id = 'capacity_item_' + i; item.messageId = 'capacity_message_' + i;
    item.sourceKey = JSON.stringify([item.connectionId, item.tenantId, item.conversationId, item.messageId]);
    item.execution.status = 'completed'; item.execution.replyText = 'x'.repeat(1048576); item.delivery = null; state.items.push(item);
  }
  f.setDisk(JSON.stringify(state)); assert.ok(Buffer.byteLength(f.disk()) < f.api.limits.stateBytes);
  await f.api.finish(job, { ok: true, say: 'PRIVATE_PREFIX' + 'x'.repeat(1048500), turnSeq: 8 });
  const item = (await f.api.read()).items[0]; assert.equal(item.execution.status, 'completed'); assert.equal(item.delivery.status, 'failed');
  assert.equal(item.delivery.errorCode, 'external_delivery.source_limit'); assert.ok(!item.execution.replyText.includes('PRIVATE_PREFIX'));
  assert.ok(Buffer.byteLength(f.disk()) <= f.api.limits.stateBytes);
});

test('external ledger OFF keeps exact pretty bytes, never needs keys, and only ENOENT defaults', async () => {
  const f = fixture();
  assert.equal(f.disk(), undefined); assert.deepEqual(plain(await f.api.read()), { schema: 1, connections: [], items: [], retiredConnectionIds: [] });
  await f.api.update({ op: 'upsert', connection: f.connection });
  assert.equal(f.disk(), JSON.stringify(await f.api.read(), null, 2)); assert.equal(f.storage.unlocks, 0);
  for (const bad of ['null', '[]', '{}', '{', JSON.stringify({ schema: 1, connections: [], items: [], retiredConnectionIds: [], unexpected: true })]) {
    f.setDisk(bad);
    await assert.rejects(f.api.read(), { code: 'external_channel.storage_unavailable' });
    await assert.rejects(f.api.update({ op: 'upsert', connection: f.connection }), { code: 'external_channel.storage_unavailable' });
    assert.equal(f.disk(), bad);
  }
  f.storage.readError = Object.assign(new Error('denied'), { code: 'EACCES' });
  await assert.rejects(f.api.read(), { code: 'external_channel.storage_unavailable' });
});

test('turning encryption on resumes existing authority and dedupe without storing callback text in clear', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true });
  await f.api.accept(f.message()); const old = plain(await f.api.read()); f.storage.enabled = true;
  assert.deepEqual(plain(await f.api.read()), old); // Reading an old ledger does not migrate it.
  await f.api.accept(f.message({ messageId: 'message_b', text: 'PRIVATE_CALLBACK_TEXT' }));
  const bytes = f.disk(), header = JSON.parse(bytes.split('\n')[0]); assert.equal(header.workData, 3); assert.equal(header.purpose, 'queue'); assert.equal(header.manifest.purpose, 'queue'); assert.ok(!bytes.includes('PRIVATE_CALLBACK_TEXT'));
  const restart = fixture({ key: f.key, enabled: true }); restart.setDisk(bytes);
  await restart.api.accept(restart.message({ eventId: 'new_delivery_id' }));
  assert.equal((await restart.api.read()).items.length, 2); assert.equal(restart.counts().writes, 0);
  const before = restart.disk(); restart.storage.enabled = false;
  await assert.rejects(restart.api.accept(restart.message({ messageId: 'no_plain_downgrade' })), { code: 'external_channel.storage_unavailable' });
  assert.equal(restart.disk(), before);
});

test('missing keys and authenticated invalid state never ACK, execute, send, cache permissions, or overwrite disk', async () => {
  const f = fixture({ enabled: true }); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true });
  await f.api.accept(f.message()); const before = f.disk(); f.storage.missing = true;
  await assert.rejects(f.api.accept(f.message({ messageId: 'while_key_missing' })), { code: 'external_channel.storage_unavailable' });
  await assert.rejects(f.api.update({ op: 'disable', id: 'qq_test' }), { code: 'external_channel.storage_unavailable' });
  await f.api.drain(); assert.equal(f.counts().runs, 0); assert.equal(f.counts().sends, 0); assert.equal(f.disk(), before);
  f.storage.missing = false;
  for (const invalid of [{ schema: 99, connections: [], items: [], retiredConnectionIds: [] }, { schema: 1, connections: [], items: [{}], retiredConnectionIds: [] }]) {
    f.setDisk(before); await f.seal(JSON.stringify(invalid)); const bad = f.disk();
    await assert.rejects(f.api.read(), { code: 'external_channel.storage_unavailable' });
    await assert.rejects(f.api.accept(f.message()), { code: 'external_channel.storage_unavailable' });
    await f.api.drain(); assert.equal(f.counts().runs, 0); assert.equal(f.counts().sends, 0); assert.equal(f.disk(), bad);
  }
  f.setDisk('{}'); await f.seal(JSON.stringify({ schema: 1, connections: [], items: [], retiredConnectionIds: [] }), 'different-owner');
  await assert.rejects(f.api.read(), { code: 'external_channel.storage_unavailable' });
});

test('every transaction rereads current disk and corrupt chunks block both new ACK and queued runner admission', async () => {
  const f = fixture({ enabled: true }); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true });
  await f.api.accept(f.message()); const bytes = f.disk(); await f.api.read();
  for (const bad of [bytes.slice(0, -10), bytes.replace(/"ciphertext":"./, '"ciphertext":"!'), '{"workData":3,"manifest":']) {
    f.setDisk(bad); await assert.rejects(f.api.accept(f.message({ messageId: 'must_not_ack' })), { code: 'external_channel.storage_unavailable' });
    await f.api.drain(); assert.equal(f.counts().runs, 0); assert.equal(f.counts().sends, 0); assert.equal(f.disk(), bad);
  }
  f.setDisk(bytes); const job = await f.api.next(); await f.api.finish(job, { ok: true, say: 'bounded pending reply' });
  const pending = f.disk(); f.storage.missing = true; await f.api.drain();
  assert.equal(f.counts().runs, 0); assert.equal(f.counts().sends, 0); assert.equal(f.disk(), pending);
});

test('40 MiB means legacy plain disk bytes but authenticated compact business bytes, never base64 bytes', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  const state = plain(await f.api.read()), base = state.items[0]; state.items = [];
  for (let i = 0; i < 32; i++) {
    const item = plain(base); item.id = 'large_item_' + i; item.messageId = 'large_message_' + i;
    item.sourceKey = JSON.stringify([item.connectionId, item.tenantId, item.conversationId, item.messageId]);
    item.execution.status = 'completed'; item.execution.replyText = 'x'.repeat(1048576); item.delivery = null; state.items.push(item);
  }
  assert.equal(f.api.valid(state), true); assert.ok(Buffer.byteLength(JSON.stringify(state)) < f.api.limits.stateBytes);
  f.storage.enabled = true; await f.api.write(state);
  assert.ok(Buffer.byteLength(f.disk()) > f.api.limits.stateBytes); assert.equal((await f.api.read()).items.length, 32);
  const valid = f.disk();
  for (let i = 32; i < 41; i++) {
    const item = plain(base); item.id = 'large_item_' + i; item.messageId = 'large_message_' + i;
    item.sourceKey = JSON.stringify([item.connectionId, item.tenantId, item.conversationId, item.messageId]);
    item.execution.status = 'completed'; item.execution.replyText = 'x'.repeat(1048576); item.delivery = null; state.items.push(item);
  }
  await assert.rejects(f.api.write(state), { code: 'external_channel.inbox_full' }); assert.equal(f.disk(), valid);
  await f.seal(JSON.stringify(state)); const oversizeSealed = f.disk();
  await assert.rejects(f.api.read(), { code: 'external_channel.storage_unavailable' }); assert.equal(f.disk(), oversizeSealed);
  const initial = JSON.stringify({ schema: 1, connections: [], items: [], retiredConnectionIds: [] });
  f.storage.enabled = false; f.setDisk(initial + ' '.repeat(f.api.limits.stateBytes)); const oversizedPlain = f.disk(), unlocks = f.storage.unlocks;
  await assert.rejects(f.api.read(), { code: 'external_channel.storage_unavailable' });
  await assert.rejects(f.api.update({ op: 'upsert', connection: f.connection }), { code: 'external_channel.storage_unavailable' });
  assert.equal(f.disk(), oversizedPlain); assert.equal(f.storage.unlocks, unlocks);
});

test('delivery pages read v1 without writes and preserve a bounded acceptance watermark under insert and status changes', async () => {
  const f = fixture();
  assert.equal((await f.api.page('')).items.length, 0); assert.equal(f.disk(), undefined);
  await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true });
  for (let n = 0; n < 5; n++) await f.api.accept(f.message({ messageId: 'page_' + n }));
  const before = f.disk(), first = plain(await f.api.page('limit=2'));
  assert.deepEqual(first.items.map(row => row.messageId), ['page_4', 'page_3']); assert.ok(first.nextCursor);
  assert.equal(f.disk(), before); assert.equal(JSON.parse(before).schema, 1);
  assert.equal(first.items[0].acceptance.status, 'accepted'); assert.equal(first.items[0].execution.status, 'queued'); assert.equal(first.items[0].delivery, null);
  await f.api.accept(f.message({ messageId: 'page_new' }));
  const job = await f.api.next(); await f.api.finish(job, { ok: true, say: 'same business result', turnSeq: 1 });
  const second = plain(await f.api.page('limit=2&cursor=' + first.nextCursor));
  assert.deepEqual(second.items.map(row => row.messageId), ['page_2', 'page_1']);
  const third = plain(await f.api.page('limit=2&cursor=' + second.nextCursor));
  assert.deepEqual(third.items.map(row => row.messageId), ['page_0']); assert.equal(third.items[0].execution.status, 'completed');
  assert.equal(third.items[0].delivery.status, 'pending'); assert.equal(third.nextCursor, '');
  assert.equal((await f.api.page('')).items[0].messageId, 'page_new');
});

test('delivery cursor binds filters and rejects duplicate/unknown/unbounded inputs', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true });
  for (let n = 0; n < 3; n++) await f.api.accept(f.message({ messageId: 'cursor_' + n }));
  const first = await f.api.page('limit=1&connectionId=qq_test&archive=all');
  for (const query of ['limit=0', 'limit=101', 'limit=1e2', 'limit=01', 'limit=1&limit=2', 'unknown=1', 'archive=wrong', 'connectionId=', 'cursor=', 'cursor=abc']) {
    if (query === 'connectionId=') continue; // An empty optional connection filter means all connections.
    await assert.rejects(f.api.page(query), error => /^external_channel\.(request|cursor)_invalid$/.test(error.code));
  }
  for (const filter of ['archive=active&connectionId=qq_test', 'archive=all&connectionId=other']) {
    await assert.rejects(f.api.page('cursor=' + first.nextCursor + '&' + filter), { code: 'external_channel.cursor_invalid' });
  }
  const tuple = JSON.parse(Buffer.from(first.nextCursor, 'base64url'));
  tuple[1] = 'not_retained';
  await assert.rejects(f.api.page('archive=all&connectionId=qq_test&cursor=' + Buffer.from(JSON.stringify(tuple)).toString('base64url')), { code: 'external_channel.cursor_invalid' });
});

test('archive upgrades one existing ledger atomically and preserves acceptance execution delivery and attempt facts', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  const job = await f.api.next(); await f.api.finish(job, { ok: true, say: 'completed reply', turnSeq: 3 });
  const original = plain((await f.api.read()).items[0]), before = f.disk();
  f.fail(true); await assert.rejects(f.api.archive({ id: original.id, archived: true }), { code: 'external_channel.storage_unavailable' });
  assert.equal(f.disk(), before); f.fail(false);
  const result = await f.api.archive({ id: original.id, archived: true });
  const stored = plain(await f.api.read()); assert.equal(stored.schema, 2); assert.ok(result.item.archivedAt);
  const { archivedAt, ...facts } = stored.items[0]; assert.deepEqual(facts, original);
  assert.equal(result.retained, 1); assert.equal(result.capacity, 1000); assert.equal(result.full, false);
  const written = f.disk(), writes = f.counts().writes;
  await f.api.archive({ id: original.id, archived: true }); assert.equal(f.disk(), written); assert.equal(f.counts().writes, writes);
  assert.equal((await f.api.page('')).items.length, 0); assert.equal((await f.api.page('archive=archived')).items[0].id, original.id);
  await f.api.accept(f.message({ eventId: 'archived_duplicate' })); assert.equal(f.disk(), written);
  await f.api.drain(); assert.equal(f.counts().runs, 0); assert.equal(f.counts().sends, 1);
  const delivered = (await f.api.read()).items[0]; assert.equal(delivered.delivery.attemptId, original.delivery.attemptId); assert.equal(delivered.delivery.status, 'sent');
  await f.api.archive({ id: original.id, archived: false }); assert.equal((await f.api.page('')).items[0].archivedAt, '');
  assert.equal((await f.api.read()).schema, 2);
});

test('archive and acceptance share the state chain while cursor anchors survive archived records', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true });
  for (let n = 0; n < 4; n++) await f.api.accept(f.message({ messageId: 'archive_page_' + n }));
  const first = await f.api.page('limit=1');
  await f.api.archive({ id: first.items[0].id, archived: true });
  const hidden = (await f.api.read()).items[1]; await f.api.archive({ id: hidden.id, archived: true });
  await f.api.accept(f.message({ messageId: 'post_watermark' }));
  const rest = plain(await f.api.page('cursor=' + first.nextCursor));
  assert.deepEqual(rest.items.map(row => row.messageId), ['archive_page_2', 'archive_page_0']);
  const newest = (await f.api.read()).items.at(-1); assert.equal(newest.archivedAt, '');
  const writes = f.counts().writes; await f.api.archive({ id: newest.id, archived: false }); assert.equal(f.counts().writes, writes);
  for (const body of [{ id: newest.id }, { id: newest.id, archived: true, extra: 1 }, { id: 'absent', archived: true }]) await assert.rejects(f.api.archive(body));
});

test('archived dedupe still occupies all 1000 records and does not permit capacity reclamation', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  const state = plain(await f.api.read()), first = state.items[0];
  for (let n = 1; n < 1000; n++) state.items.push({ ...first, id: 'retained_' + n, messageId: 'retained_' + n,
    sourceKey: JSON.stringify([first.connectionId, first.tenantId, first.conversationId, 'retained_' + n]) });
  await f.api.write(state); await f.api.archive({ id: first.id, archived: true });
  const before = f.disk(); await assert.rejects(f.api.accept(f.message({ messageId: 'still_full' })), { code: 'external_channel.inbox_full' });
  await f.api.accept(f.message({ eventId: 'duplicate_full_archived' })); assert.equal(f.disk(), before);
  const page = await f.api.page(''); assert.equal(page.full, true); assert.equal(page.retained, 1000); assert.equal(page.total, 999);
});

test('encrypted archived payload reopens on the same Store AAD and preserves missing-key and no-downgrade refusal', async () => {
  const f = fixture({ enabled: true }); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  const item = (await f.api.read()).items[0]; await f.api.archive({ id: item.id, archived: true });
  const bytes = f.disk(), header = JSON.parse(bytes.split('\n')[0]);
  assert.equal(header.purpose, 'queue'); assert.equal(header.schema, 1); assert.equal(header.scopeId, 'global'); assert.equal(header.recordId, 'external-bots:state-v1');
  assert.ok(!bytes.includes(item.text));
  const cold = fixture({ enabled: true, key: f.key }); cold.setDisk(bytes);
  assert.equal((await cold.api.page('archive=archived')).items[0].id, item.id); assert.equal(cold.disk(), bytes);
  cold.storage.missing = true;
  await assert.rejects(cold.api.page('archive=all'), { code: 'external_channel.storage_unavailable' });
  await assert.rejects(cold.api.archive({ id: item.id, archived: false }), { code: 'external_channel.storage_unavailable' }); assert.equal(cold.disk(), bytes);
  cold.storage.missing = false; cold.storage.enabled = false;
  await assert.rejects(cold.api.archive({ id: item.id, archived: false }), { code: 'external_channel.storage_unavailable' }); assert.equal(cold.disk(), bytes);
  cold.setDisk(bytes.slice(0, -12)); const corrupt = cold.disk();
  await assert.rejects(cold.api.page(''), { code: 'external_channel.storage_unavailable' }); assert.equal(cold.disk(), corrupt);
});

test('payload versions and archive metadata are validated whole without accepting downgraded semantics', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  const state = plain(await f.api.read());
  for (const bad of [
    { ...state, schema: 3 }, { ...state, schema: 2 },
    { ...state, items: state.items.map(row => ({ ...row, archivedAt: '' })) },
    { ...state, schema: 2, items: state.items.map(row => ({ ...row, archivedAt: 'invalid' })) },
    { ...state, schema: 2, items: state.items.map(row => ({ ...row, archivedAt: 0 })) },
  ]) { f.setDisk(JSON.stringify(bad)); const bytes = f.disk(); await assert.rejects(f.api.read(), { code: 'external_channel.storage_unavailable' }); assert.equal(f.disk(), bytes); }
});
