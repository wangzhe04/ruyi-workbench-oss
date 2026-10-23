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
})().catch(error => t.fail(error.stack || String(error))).finally(() => {
  https.request = originalRequest; delete process.__ruyiExternalStorageRuns; api.workDataKeys.clear();
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-external-work-data-e2e-'));
  fs.rmSync(root, { recursive: true, force: true }); t.done();
});