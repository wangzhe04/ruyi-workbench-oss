'use strict';
require('./lib/self-isolate-home');
// Real signed callback/domain lifecycle + Windows DPAPI. Synthetic state, no platform or model calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), https = require('node:https');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { FAKE_BOT_ENV, qqConnection, qqEvent, qqWire } = require('./lib/external-bot-fixtures');
const t = createRunner('EXTERNAL BOTS WORK DATA');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-external-work-data-e2e-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')), FAKE_BOT_ENV);
// Make unexpected execution observable and prevent all real platform HTTPS even if a regression
// incorrectly advances a queued item. Normal successful state transitions remain production code.
let sends = 0; const originalRequest = https.request; process.__ruyiExternalStorageRuns = 0;
https.request = () => { sends++; throw new Error('synthetic outbound boundary'); };
const api = require('./lib/server-internals').loadServerInternals([
  'externalBotReadState', 'externalBotWriteState', 'externalBotUpdateConnection', 'externalBotAcceptCallback', 'externalBotDrain',
  'externalBotChains', 'runKeyedChain', 'readConfig', 'writeConfig', 'workDataKeys', 'paths',
], { withEval: true });
api.__eval('runStewardTurn = async () => { process.__ruyiExternalStorageRuns++; return { ok: true, say: "Synthetic private reply" }; };');
const file = path.join(api.paths.data, 'external-bots', 'state-v1.json');
const bytes = () => fs.readFileSync(file, 'utf8');
const stateError = { code: 'external_channel.storage_unavailable' };
const update = body => api.runKeyedChain(api.externalBotChains, 'state', () => api.externalBotUpdateConnection(body));
const callback = patch => {
  const wire = qqWire(qqEvent(patch));
  return api.runKeyedChain(api.externalBotChains, 'state', () => api.externalBotAcceptCallback('qq', 'qq_test', wire.headers, wire.bytes));
};
const setSwitch = async enabled => { const config = await api.readConfig(); config.workDataEncryptionV1 = enabled; await api.writeConfig(config); };
let failed = false; const keepRoot = process.argv.includes('--keep-root');
(async () => {
  await setSwitch(false); assert.equal((await api.externalBotReadState()).items.length, 0);
  t.ok(!fs.existsSync(file), 'only a missing ledger is an unwritten default');
  await update({ op: 'upsert', connection: qqConnection() }); await callback({ text: 'OFF真实验签原文' });
  const plain = await api.externalBotReadState();
  t.ok(bytes() === JSON.stringify(plain, null, 2), 'OFF lifecycle preserves exact pretty JSON bytes');
  if (process.platform !== 'win32') { console.log('SKIP real DPAPI: Windows only; source units cover synthetic sealing'); return; }
  // Construct a legitimate >1 MiB ledger from the item created through real signature/admission.
  const base = plain.items[0]; plain.items = [];
  for (let i = 0; i < 160; i++) {
    const item = JSON.parse(JSON.stringify(base)); item.id = 'large_' + i; item.messageId = 'large_message_' + i;
    item.sourceKey = JSON.stringify([item.connectionId, item.tenantId, item.conversationId, item.messageId]);
    item.text = 'x'.repeat(8192); item.contentHash = crypto.createHash('sha256').update(JSON.stringify([item.senderId, item.conversationType, item.text])).digest('hex');
    plain.items.push(item);
  }
  await api.externalBotWriteState(plain); const legacyBytes = bytes(); assert.ok(Buffer.byteLength(legacyBytes) > 1048576);
  await setSwitch(true); await api.workDataKeys.ensure();
  assert.equal((await api.externalBotReadState()).items.length, 160); assert.equal(bytes(), legacyBytes);
  await callback({ messageId: 'on_message', text: 'PRIVATE_CALLBACK_TEXT' });
  const sealed = bytes();
  const header = JSON.parse(sealed.split('\n')[0]);
  t.ok(header.workData === 3 && header.purpose === 'queue' && header.manifest.purpose === 'queue' && !sealed.includes('PRIVATE_CALLBACK_TEXT'), 'continuing the old large ledger seals all authority and dedupe data under the frozen queue purpose');
  await callback({ messageId: 'on_message', eventId: 'redelivery', text: 'PRIVATE_CALLBACK_TEXT' });
  t.ok(bytes() === sealed && (await api.externalBotReadState()).items.length === 161, 'same-message retry preserves durable dedupe and performs no rewrite');
  const owner = { ...qqConnection(), mode: 'control', ownerSenderId: 'qq_person', ownerConversationId: 'qq_room', ownerConversationType: 'group' };
  await update({ op: 'upsert', connection: owner, controlConfirmed: true });
  await callback({ messageId: 'queued_before_key_failure', text: '不得在存储故障时执行' });
  const queued = bytes(), keyFile = path.join(api.paths.data, 'work-data-key-v1.json');
  api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.bak');
  try {
    await assert.rejects(() => api.externalBotReadState(), stateError);
    await assert.rejects(() => callback({ messageId: 'must_not_ack', text: '不可确认' }), stateError);
    await assert.rejects(() => update({ op: 'disable', id: 'qq_test' }), stateError);
    await api.externalBotDrain();
    t.ok(bytes() === queued && process.__ruyiExternalStorageRuns === 0 && sends === 0, 'missing key grants zero ACK/execution/send and retains all original ledger bytes');
  } finally { fs.renameSync(keyFile + '.bak', keyFile); api.workDataKeys.clear(); }
  fs.writeFileSync(file, queued.slice(0, -20)); const corrupt = bytes();
  await assert.rejects(() => callback({ messageId: 'corrupt_must_not_ack' }), stateError); await api.externalBotDrain();
  t.ok(bytes() === corrupt && process.__ruyiExternalStorageRuns === 0 && sends === 0, 'truncated chunks cannot fall back to cached permissions or empty dedupe');
  fs.writeFileSync(file, queued); await setSwitch(false);
  await assert.rejects(() => callback({ messageId: 'no_downgrade' }), stateError);
  t.ok(bytes() === queued, 'disabling encryption never overwrites an already sealed ledger with plaintext');
  // Independent small producer: real DPAPI and the original no-network HTTPS boundary.
  // Keep every earlier large/key/corruption/OFF assertion unchanged.
  {
    const retryRoot = fs.mkdtempSync(path.join(root, 'payload4-'));
    const retryEnvironment = require('./lib/release-checks').releaseEnvironment(path.join(retryRoot, 'home'), path.join(retryRoot, 'data'));
    const savedEnvironment = new Map(Object.keys(retryEnvironment).map(key => [key, process.env[key]]));
    const { historicalSource } = require('./lib/external-bots-source-history');
    const historicalPins = { v1: '5bf225988e7a0744c6f13c87e82defd9f93612e88c917b25ad1cb26bc308938d', v2: '1ad6064fb9e31079e2b07c85353e56a1a94c33eff5d5abbf18f9efc87938d1f0', v3: 'c82cef972e46ae42d58f74d775a6a6a09e52caeb7d3d368a71fcaa57074504c6' };
    let retryApi; const oldReaders = [];
    assert.equal(process.__ruyiExternalRetryRuns, undefined);
    process.__ruyiExternalRetryRuns = 0;
    try {
      Object.assign(process.env, retryEnvironment);
      retryApi = require('./lib/server-internals').loadServerInternals([
        'externalBotReadState', 'externalBotUpdateConnection', 'externalBotAcceptCallback', 'externalBotDrain',
        'externalBotChains', 'runKeyedChain', 'readConfig', 'writeConfig', 'workDataKeys', 'paths',
      ], { withEval: true });
      assert.notEqual(retryApi.paths.data, api.paths.data);
      assert.equal(path.dirname(retryApi.paths.data), retryRoot);
      const retryConfig = await retryApi.readConfig(); retryConfig.workDataEncryptionV1 = true; await retryApi.writeConfig(retryConfig);
      await retryApi.workDataKeys.ensure();
      retryApi.__eval('runStewardTurn = async () => { process.__ruyiExternalRetryRuns++; return { ok: true, say: "DPAPI_RETRY_PRIVATE_ORIGINAL_REPLY" }; };');
      const retryUpdate = body => retryApi.runKeyedChain(retryApi.externalBotChains, 'state', () => retryApi.externalBotUpdateConnection(body));
      const originalWire = qqWire(qqEvent({ messageId: 'dpapi_retry_original', eventId: 'dpapi_retry_original_event', text: 'DPAPI_RETRY_PRIVATE_SIGNED_INPUT' }));
      const retryCallback = wire => retryApi.runKeyedChain(retryApi.externalBotChains, 'state', () => retryApi.externalBotAcceptCallback('qq', 'qq_test', wire.headers, wire.bytes));
      const retryFile = path.join(retryApi.paths.data, 'external-bots', 'state-v1.json');
      const retryBytes = () => fs.readFileSync(retryFile, 'utf8');
      const retrySends = sends;
      await retryUpdate({ op: 'upsert', connection: { ...qqConnection(), mode: 'control', ownerSenderId: 'qq_person', ownerConversationId: 'qq_room', ownerConversationType: 'group' }, controlConfirmed: true });
      await retryCallback(originalWire);
      await retryApi.externalBotDrain();
      const schema1 = await retryApi.externalBotReadState(), predecessor = schema1.items[0], schema1Bytes = retryBytes();
      assert.equal(schema1.schema, 1); assert.equal(schema1.items.length, 1);
      assert.equal(predecessor.execution.status, 'completed'); assert.equal(predecessor.execution.replyText, 'DPAPI_RETRY_PRIVATE_ORIGINAL_REPLY');
      assert.equal(predecessor.delivery.status, 'failed'); assert.equal(predecessor.delivery.errorCode, 'external_delivery.predispatch');
      assert.equal(process.__ruyiExternalRetryRuns, 1); assert.equal(sends, retrySends + 1);
      assert.equal(JSON.parse(schema1Bytes.split('\n')[0]).workData, 3);
      assert.ok(Buffer.byteLength(schema1Bytes) < 1024 * 1024);
      t.ok(!schema1Bytes.includes('DPAPI_RETRY_PRIVATE_ORIGINAL_REPLY') && !schema1Bytes.includes('DPAPI_RETRY_PRIVATE_SIGNED_INPUT'), 'P4 real signed callback and one business run produce a small DPAPI schema1 ledger with known token-phase pre-MESSAGE refusal');
      for (const version of ['v1', 'v2', 'v3']) {
        const oldSource = historicalSource(version);
        assert.equal(crypto.createHash('sha256').update(oldSource).digest('hex'), historicalPins[version]);
        // Complete historical 13w in THIS real server namespace: same actual Store,
        // queue AAD, paths, config, DPAPI key owner and physical ledger; no fake codec.
        const old = retryApi.__eval(oldSource + '\n;({ read: externalBotReadState, valid: externalBotValidState, accept: externalBotAcceptCallback, update: externalBotUpdateConnection, drain: externalBotDrain, chains: externalBotChains, stop: () => { externalBotWorkerStopped = true; } });');
        oldReaders.push({ version, old });
        const readable = await old.read();
        assert.deepEqual(readable, schema1); assert.equal(old.valid(schema1), true);
        assert.equal(retryBytes(), schema1Bytes); assert.equal(process.__ruyiExternalRetryRuns, 1); assert.equal(sends, retrySends + 1);
        t.ok(readable.items.length === 1 && readable.items[0].delivery.attemptId === predecessor.delivery.attemptId, 'P4 exact old ' + version + ' reader decrypts the SAME complete schema1 DPAPI ledger before retry (positive crypto/cap/namespace control)');
      }
      const localRetry = retryApi.__eval('body => runKeyedChain(externalBotChains, "state", () => externalBotRetryReply(body, EXTERNAL_BOT_LOCAL_REPLY_RETRY))');
      const body = { id: predecessor.id, expectedAttemptId: predecessor.delivery.attemptId, retryRequestId: 'dpapi_retry_request_00000001' };
      const receipt = await localRetry(body), schema4 = await retryApi.externalBotReadState(), successor = schema4.items[0], schema4Bytes = retryBytes();
      assert.equal(receipt.ok, true); assert.equal(receipt.alreadyRetried, false); assert.equal(schema4.schema, 4); assert.equal(schema4.items.length, 1);
      assert.notEqual(successor.delivery.attemptId, predecessor.delivery.attemptId); assert.equal(successor.delivery.status, 'pending');
      assert.equal(successor.replyHistory.length, 1); assert.deepEqual(successor.replyHistory[0].attempt, predecessor.delivery);
      assert.equal(successor.replyHistory[0].nextAttemptId, successor.delivery.attemptId); assert.equal(successor.replyHistory[0].retryRequestId, body.retryRequestId);
      assert.equal(receipt.receipt.itemId, predecessor.id); assert.equal(receipt.receipt.previousAttemptId, predecessor.delivery.attemptId); assert.equal(receipt.receipt.attemptId, successor.delivery.attemptId); assert.equal(receipt.receipt.retryRequestId, body.retryRequestId); assert.equal(receipt.receipt.requestedAt, successor.replyHistory[0].requestedAt);
      assert.deepEqual(successor.execution, predecessor.execution); assert.equal(successor.sourceKey, predecessor.sourceKey);
      assert.equal(process.__ruyiExternalRetryRuns, 1); assert.equal(sends, retrySends + 1);
      t.ok(!schema4Bytes.includes(body.retryRequestId) && !schema4Bytes.includes('DPAPI_RETRY_PRIVATE_ORIGINAL_REPLY') && !schema4Bytes.includes('replyHistory'), 'P4 private local capability persists one sealed payload4 successor and complete old attempt before any new send or business work');
      const replayPending = await localRetry(body);
      assert.equal(replayPending.alreadyRetried, true); assert.deepEqual(replayPending.receipt, receipt.receipt); assert.equal(retryBytes(), schema4Bytes);
      await retryApi.externalBotDrain();
      const attempted = await retryApi.externalBotReadState(), attemptedBytes = retryBytes();
      assert.equal(attempted.schema, 4); assert.equal(attempted.items[0].delivery.attemptId, successor.delivery.attemptId); assert.equal(attempted.items[0].delivery.status, 'failed');
      assert.equal(attempted.items[0].delivery.errorCode, 'external_delivery.predispatch'); assert.equal(attempted.items[0].replyHistory.length, 1);
      assert.deepEqual(attempted.items[0].execution, predecessor.execution); assert.equal(process.__ruyiExternalRetryRuns, 1); assert.equal(sends, retrySends + 2);
      const replayFailed = await localRetry(body);
      assert.equal(replayFailed.alreadyRetried, true); assert.deepEqual(replayFailed.receipt, receipt.receipt); assert.equal(retryBytes(), attemptedBytes);
      await retryCallback(originalWire);
      assert.equal(retryBytes(), attemptedBytes); assert.equal((await retryApi.externalBotReadState()).items.length, 1);
      t.ok(process.__ruyiExternalRetryRuns === 1 && sends === retrySends + 2, 'P4 pending and terminal same-ID retry plus signed callback redelivery preserve one successor/history and never rerun business or add a third token attempt');
      retryApi.workDataKeys.clear();
      const reopened = await retryApi.externalBotReadState();
      assert.deepEqual(reopened, attempted); assert.equal(retryBytes(), attemptedBytes);
      t.ok(!attemptedBytes.includes(body.retryRequestId) && !attemptedBytes.includes('DPAPI_RETRY_PRIVATE_ORIGINAL_REPLY'), 'P4 clear-key cold DPAPI read preserves complete payload4 while physical request ID and reply remain sealed');
      for (const { version, old } of oldReaders) {
        assert.equal(old.valid(reopened), false);
        await assert.rejects(() => old.read(), stateError);
        await assert.rejects(() => retryApi.runKeyedChain(old.chains, 'state', () => old.accept('qq', 'qq_test', originalWire.headers, originalWire.bytes)), stateError);
        await assert.rejects(() => retryApi.runKeyedChain(old.chains, 'state', () => old.update({ op: 'disable', id: 'qq_test' })), stateError);
        await old.drain();
        assert.equal(retryBytes(), attemptedBytes); assert.equal(process.__ruyiExternalRetryRuns, 1); assert.equal(sends, retrySends + 2);
        assert.deepEqual(await retryApi.externalBotReadState(), reopened);
        t.ok(true, 'P4 exact old ' + version + ' refuses entire REAL DPAPI payload4 ledger with zero overwrite/dedupe loss/business/new outbound calls');
      }
      const off = await retryApi.readConfig(); off.workDataEncryptionV1 = false; await retryApi.writeConfig(off);
      await assert.rejects(() => retryCallback(qqWire(qqEvent({ messageId: 'dpapi_retry_no_off_overwrite', text: 'DPAPI_RETRY_NO_DOWNGRADE' }))), stateError);
      await assert.rejects(() => retryUpdate({ op: 'disable', id: 'qq_test' }), stateError);
      await retryApi.externalBotDrain();
      t.ok(retryBytes() === attemptedBytes && process.__ruyiExternalRetryRuns === 1 && sends === retrySends + 2, 'P4 OFF refuses the sealed history-bearing ledger without plaintext rewrite, dedupe reset or new execution/send');
    } finally {
      for (const { old } of oldReaders) old.stop();
      if (retryApi) { retryApi.__eval('externalBotWorkerStopped = true;'); retryApi.workDataKeys.clear(); }
      delete process.__ruyiExternalRetryRuns;
      for (const [key, value] of savedEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }

})().catch(error => { failed = true; t.fail(error.stack || String(error)); }).finally(() => {
  https.request = originalRequest; delete process.__ruyiExternalStorageRuns; api.workDataKeys.clear();
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-external-work-data-e2e-'));
  failed ||= t.failures > 0;
  if (failed || keepRoot) console.log('EXTERNAL WORK DATA RETAINED ' + root);
  else fs.rmSync(root, { recursive: true, force: true });
  t.done();
});