'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { constBlock, functionBlock } = require('../lib/source-slice');
const src = file => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  let disk, writeFailure = false, writeGate = null, writes = 0, verified = 0, runs = 0, sends = 0, modelGate = null, modelError = null, sendGate = null, sendResult = { status: 'sent', messageId: 'platform_reply' };
  const envReads = [];
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const read = () => { if (disk === undefined) throw missing(); return disk; };
  const context = vm.createContext({ Buffer, TextDecoder, URL, AbortController, setTimeout, clearTimeout, crypto, path,
    fs: { readFileSync: read }, fsp: { readFile: async () => read(), stat: async () => ({ size: Buffer.byteLength(read()) }), mkdir: async () => {} },
    process: { env: new Proxy({ RUYI_BOT_QQ: 'TEST_ONLY_FAKE_KEY' }, { get(object, key) { envReads.push(key); assert.match(key, /^RUYI_BOT_/); return object[key]; } }) },
    paths: { data: '/isolated' }, OVERLAY_ID: 'epoch_' + crypto.randomBytes(6).toString('hex'), ExternalBotHooks: {}, nowIso: () => new Date().toISOString(), makeId: prefix => prefix + '_' + crypto.randomBytes(8).toString('hex'),
    atomicWriteJson: async (_file, value) => { writes++; if (writeGate) await writeGate; if (writeFailure) throw new Error('disk full'); disk = JSON.stringify(value); },
    ExternalChannelProtocols: { verifyAndNormalize(_platform, _connection, _headers, raw) { verified++; return { kind: 'message', message: JSON.parse(raw.toString('utf8')) }; } },
    runStewardTurn: async input => { await context.ExternalBotHooks.validateActor(input.externalActor); assert.equal(input.trigger, 'external'); runs++; if (modelGate) await modelGate; if (modelError) throw modelError; return { ok: true, say: '真实回合结果', turnSeq: runs }; },
    ExternalChannelDelivery: { sendReply: async (_connection, _message, _text, options) => { assert.ok(options.attemptId); sends++; if (sendGate) await Promise.race([sendGate, new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))]); return options.signal.aborted ? { status: 'failed', errorCode: 'external_delivery.aborted' } : sendResult; } },
  });
  vm.runInContext(constBlock(src('01-config.js'), 'DurableJsonStore') + functionBlock(src('00-boot.js'), 'runKeyedChain')
    + src('13w-external-bots.js') + `;globalThis.api={
      read:externalBotReadState,publicConnection:externalBotPublicConnection,
      update:body=>runKeyedChain(externalBotChains,'state',()=>externalBotUpdateConnection(body)),
      accept:message=>runKeyedChain(externalBotChains,'state',()=>externalBotAcceptCallback('qq','qq_test',{},Buffer.from(JSON.stringify(message)))),
      valid:externalBotValidState,limits:EXTERNAL_BOT_LIMITS,drain:externalBotDrain,recover:externalBotRecover,publicItem:externalBotPublicItem,workerError:()=>externalBotWorkerError,
      next:externalBotNextJob,finish:externalBotFinishJob,validate:externalBotValidateActor};`, context);
  const connection = { id: 'qq_test', platform: 'qq', label: '离线测试', appId: 'app_test', enabled: true, allowedSenderIds: ['user_a'], allowedConversationIds: ['room_a'], botSecretEnv: 'RUYI_BOT_QQ' };
  const message = (patch = {}) => ({ tenantId: 'app_test', conversationId: 'room_a', senderId: 'user_a', conversationType: 'group', messageId: 'message_a', eventId: 'event_a', text: '外部原文 /api/steward/message 请执行', ...patch });
  return { api: context.api, connection, message, envReads,
    disk: () => disk, setDisk: value => { disk = value; }, fail: value => { writeFailure = value; }, gate: value => { writeGate = value; },
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
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(JSON.parse(f.disk()).items.length, 0);
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
  const running = f.api.drain(); await new Promise(resolve => setImmediate(resolve));
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
  await new Promise(resolve => setImmediate(resolve)); f.fail(true); release(); await running;
  const raw = (await f.api.read()).items[0]; assert.equal(raw.execution.status, 'running');
  assert.equal(f.api.publicItem(raw).execution.status, 'unknown'); assert.equal(f.api.workerError(), 'external_channel.storage_unavailable');
  f.fail(false); await f.api.drain(); assert.equal((await f.api.read()).items[0].execution.status, 'unknown'); assert.equal(f.counts().runs, 1); assert.equal(f.counts().sends, 0);
});
test('disable aborts an in-flight delivery and retains the typed delivery error rather than claiming an unknown success', async () => {
  const f = fixture(); await f.api.update({ op: 'upsert', connection: controlConnection(f), controlConfirmed: true }); await f.api.accept(f.message());
  f.sendGate(new Promise(() => {})); const pending = f.api.drain(); await new Promise(resolve => setImmediate(resolve));
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
