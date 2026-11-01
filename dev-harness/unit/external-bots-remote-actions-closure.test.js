'use strict';
// Original C0 private functions + original Store/TEMP only. No human admission or core effect.
const { test } = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { fixture, plain } = require('../lib/external-bots-inbox-fixture');
const { beforeRemoteViews, beforeRemoteActionClosure, beforeRemoteActions, beforeProgress, retryCoreSource } = require('../lib/external-bots-source-history');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13w-external-bots.js'), 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function unknown({ enabled = false, claimed = false, expired = false } = {}) {
  const f = fixture({ enabled, source });
  vm.runInContext(`Object.assign(api,{code:externalBotRemoteNewCode,hash:externalBotRemoteHash,record:externalBotRemoteRecord,
    upgrade:externalBotUpgradeRemoteState,disposition:externalBotRemoteDisposition,receipt:externalBotRemoteReceipt,command:externalBotRemoteCommand,
    preview:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetentionPreview(body)),
    reclaim:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetentionCommit(body))})`, f.context);
  await f.api.update({ op: 'upsert', connection: f.connection }); await f.api.accept(f.message());
  const state = plain(await f.api.read()), item = state.items[0], token = f.api.code();
  item.receivedAt = new Date(Date.now() - 100 * 86400000).toISOString(); item.readAt = new Date().toISOString(); f.api.upgrade(state);
  const issuedAt = new Date(Date.now() - (expired ? 600000 : 60000)).toISOString();
  const binding = { bootId: f.context.OVERLAY_ID, connectionId: 'qq_test', platform: 'qq', appId: 'app_test', tenantId: 'app_test', botUserId: '',
    controlRevision: 1, credentialRevision: hash('credential'), ownerSenderId: 'user_a', ownerConversationType: 'group', ownerConversationId: 'room_a',
    sessionId: 'session', interventionId: 'intervention', type: 'permission', expectedVersion: 0, runId: '', executionId: '',
    sourceFingerprint: hash('source'), policyFingerprint: hash('policy'), recipientFingerprint: hash('recipient'), audienceRevision: '' };
  const command = plain(f.api.command('qq_test', f.message({ text: '/decide ' + token.code + ' allow' }), { offerId: 'closure_offer', action: 'allow', decisionFingerprint: hash('original core fingerprint') }));
  const { offerId, ...facts } = command;
  const claim = claimed ? { ...facts, idempotencyKey: 'extdec:' + offerId, claimedAt: issuedAt } : null;
  const row = plain(f.api.record({ offerId, codeHash: token.codeHash, binding, bindingHash: f.api.hash('binding', binding), allowedActions: ['allow', 'deny'],
    issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 300000).toISOString(), updatedAt: issuedAt, status: 'unknown', announcementItemId: item.id, claim, resultHash: '' }));
  state.remoteActions = [row]; f.setDisk(JSON.stringify(state)); await f.api.write(state); // Crash-stage fact, no admission API.
  return { f, row, state, token, command };
}
for (const enabled of [false, true]) test(`unclaimed unknown closes safely after expiry or a new boot and retains exact permanent evidence, sealed=${enabled}`, async () => {
  for (const status of ['expired', 'revoked']) {
    const { f, row, state, token } = await unknown({ enabled, expired: status === 'expired' });
    a.equal(f.api.disposition(row, row.binding.bootId, Date.parse(row.issuedAt) + 1), 'reconcile');
    a.equal(f.api.disposition(row, 'new_boot', Date.parse(row.issuedAt) + 1), 'closed');
    a.equal(f.api.disposition(row, row.binding.bootId, Date.parse(row.expiresAt)), 'closed');
    const preview = () => f.api.preview({ requestId: 'closure_retention_0001', retainDays: 30 }); a.equal((await preview()).count, 0);
    const closed = { ...row, status, updatedAt: new Date().toISOString() }, next = plain(state); next.remoteActions = [closed]; await f.api.write(next);
    a.equal(f.api.disposition((await f.api.read()).remoteActions[0]), 'closed'); a.equal((await preview()).count, 0); // Active row still blocks linked bodies.
    const receipt = plain(f.api.receipt(closed)); next.remoteActions = []; next.remoteActionReceipts = [receipt]; await f.api.write(next);
    const eligible = await preview(); a.equal(eligible.count, 1); await f.api.reclaim({ requestId: eligible.requestId, previewToken: eligible.previewToken });
    const final = plain(await f.api.read()); a.equal(final.items.length, 0); a.equal(final.remoteActionReceipts[0].codeHash, row.codeHash); a.equal(final.remoteActionReceipts[0].bindingHash, row.bindingHash); a.equal(final.remoteActionReceipts[0].claim, null);
    for (const secret of [token.code, 'room_a', 'user_a', 'session', 'intervention']) a.equal(JSON.stringify(final.remoteActionReceipts).includes(secret), false);
    const before = f.disk(); for (const resurrect of [row, { ...row, status: 'offered' }, { ...row, status: 'prepared' }]) { const bad = plain(final); bad.remoteActionReceipts = []; bad.remoteActions = [resurrect]; await a.rejects(f.api.write(bad), { code: 'external_channel.storage_unavailable' }); a.equal(f.disk(), before); }
    a.equal(f.counts().runs, 0); a.equal(f.counts().sends, 0);
  }
});
test('current-boot unexpired unknown keeps reconciliation; neither missing nor existing claims can be added, reset, revoked or rekeyed', async () => {
  for (const claimed of [false, true]) {
    const { f, row, state, command } = await unknown({ claimed }); a.equal(f.api.disposition(row), 'reconcile');
    const before = f.disk(), { offerId, ...facts } = command, freshClaim = { ...facts, idempotencyKey: 'extdec:' + offerId, claimedAt: row.issuedAt };
    const badRows = claimed ? [{ ...row, status: 'revoked', claim: null }, { ...row, status: 'expired', claim: null }, { ...row, status: 'offered', claim: null },
      { ...row, status: 'claimed' }, { ...row, status: 'applying' }, { ...row, claim: null }, { ...row, claim: { ...row.claim, sourceHash: hash('another canonical source') } }, { ...row, claim: { ...row.claim, idempotencyKey: 'extdec:other' } }]
      : [{ ...row, status: 'claimed', claim: freshClaim }, { ...row, claim: freshClaim }, { ...row, status: 'offered' }];
    for (const badRow of badRows) { const bad = plain(state); bad.remoteActions = [badRow]; await a.rejects(f.api.write(bad), { code: 'external_channel.storage_unavailable' }); a.equal(f.disk(), before); }
    f.advance(600000); a.equal(f.api.disposition(row, 'new_boot'), claimed ? 'reconcile' : 'closed');
    a.equal(f.counts().runs, 0); a.equal(f.counts().sends, 0);
  }
});
test('R1 exact whole-source inverse composes through unchanged R0 and B2 layers while extra drift reaches the original final rejection', () => {
  const closure = require('../fixtures/external-bots-remote-actions/closure-history.json'), original = require('../fixtures/external-bots-remote-actions/history.json');
  a.equal(hash(beforeRemoteViews(source)), closure.sha256); a.equal(hash(beforeRemoteActionClosure(source)), closure.baseSha256); a.equal(closure.baseSha256, original.sha256);
  a.equal(hash(beforeRemoteActions(source)), original.baseSha256);
  for (const changed of [source + '\n// extra drift', source.replace("return 'closed';", "return 'unexpected';")]) { a.notEqual(changed, source); a.equal(beforeRemoteActionClosure(changed), changed); a.equal(beforeProgress(changed), changed); a.throws(() => retryCoreSource(changed)); }
  const row = closure.inverseSpans[0], saved = row.after; try { row.after += '\n// tampered inverse'; a.throws(() => beforeRemoteActionClosure(source)); } finally { row.after = saved; }
});
