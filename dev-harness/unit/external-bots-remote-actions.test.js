'use strict';
// C0 data contracts only: real 13w + original WorkDataStore, synthetic keys/TEMP.
// No callback command routing, core action, server, socket, native or human authority.
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { fixture, plain } = require('../lib/external-bots-inbox-fixture');
const { beforeRemoteActionClosure, beforeRemoteActions, beforeProgress, beforeRetention, historicalSource } = require('../lib/external-bots-source-history');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13w-external-bots.js'), 'utf8');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function make(options = {}) {
  const f = fixture(options);
  vm.runInContext(`Object.assign(api, {
    remoteCode:externalBotRemoteNewCode,codeHash:externalBotRemoteCodeHash,codeMatches:externalBotRemoteCodeMatches,
    binding:externalBotRemoteBinding,remoteHash:externalBotRemoteHash,record:externalBotRemoteRecord,
    command:externalBotRemoteCommand,dedupe:externalBotRemoteDedupe,remoteReceipt:externalBotRemoteReceipt,
    disposition:externalBotRemoteDisposition,upgradeRemote:externalBotUpgradeRemoteState,remoteLimits:EXTERNAL_BOT_REMOTE,
    preview:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetentionPreview(body)),
    reclaim:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetentionCommit(body)),
    retry:body=>runKeyedChain(externalBotChains,'state',()=>externalBotRetryReply(body,EXTERNAL_BOT_LOCAL_REPLY_RETRY)),
    actors:externalBotActiveActors
  })`, f.context);
  return f;
}
function offer(f, type = 'permission', offerId = 'offer_test') {
  const token = f.api.remoteCode(), issuedAt = new Date().toISOString();
  const binding = f.api.binding({ bootId: f.context.OVERLAY_ID, connectionId: 'qq_test', platform: 'qq', appId: 'app_test', tenantId: 'app_test', botUserId: '',
    controlRevision: 1, credentialRevision: hash('synthetic-credential'), ownerSenderId: 'user_a', ownerConversationType: 'group', ownerConversationId: 'room_a',
    sessionId: 'session_test', interventionId: 'intervention_test', type, expectedVersion: 0, runId: '', executionId: '',
    sourceFingerprint: hash('full synthetic source'), policyFingerprint: hash('synthetic-policy'), recipientFingerprint: hash('synthetic-recipient'), audienceRevision: '' });
  const row = f.api.record({ offerId, codeHash: token.codeHash, binding, bindingHash: f.api.remoteHash('binding', binding), allowedActions: [...f.api.remoteLimits.actions[type]],
    issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 300000).toISOString(), updatedAt: issuedAt, status: 'prepared', announcementItemId: '', claim: null, resultHash: '' });
  return { row: plain(row), code: token.code };
}
function command(f, o, patch = {}, text = '/decide ' + o.code + ' allow') {
  return plain(f.api.command('qq_test', f.message({ text, ...patch }), { offerId: o.row.offerId, action: o.row.binding.type === 'question' ? 'answer' : o.row.allowedActions[0], decisionFingerprint: hash('original typed core fingerprint') }));
}
function claimed(o, c) {
  const { offerId, ...facts } = c;
  return { ...o.row, status: 'claimed', announcementItemId: 'announcement_test', claim: { ...facts, idempotencyKey: 'extdec:' + offerId, claimedAt: o.row.issuedAt } };
}
async function install(f, row) {
  const state = plain(await f.api.read()); f.api.upgradeRemote(state); state.remoteActions.push(row); await f.api.write(state); return state;
}
async function replace(f, row) {
  const state = plain(await f.api.read()); state.remoteActions[state.remoteActions.findIndex(value => value.offerId === row.offerId)] = row; await f.api.write(state); return state;
}
async function enterClaim(f, o, c = command(f, o)) {
  await install(f, o.row); await replace(f, { ...o.row, status: 'offered', announcementItemId: 'announcement_test' });
  const row = claimed(o, c); await replace(f, row); return row;
}
test('128-bit canonical codes use a distinct digest domain and never accept base64 aliases', () => {
  const f = make(), seen = new Set();
  for (let i = 0; i < 8; i++) {
    const token = f.api.remoteCode(); a.match(token.code, /^ra_[A-Za-z0-9_-]{22}$/); a.equal(Buffer.from(token.code.slice(3), 'base64url').length, 16);
    a.equal(Buffer.from(token.code.slice(3), 'base64url').toString('base64url'), token.code.slice(3)); a.equal(f.api.codeMatches(token.codeHash, token.code), true);
    a.notEqual(token.codeHash, hash(token.code)); seen.add(token.code);
    for (const bad of [token.code + '=', token.code.slice(0, -1) + 'B', '', null, token.code + '\n']) a.equal(f.api.codeMatches(token.codeHash, bad), false);
    a.equal(f.api.codeMatches('0'.repeat(64), token.code), false); a.equal(f.api.codeMatches('x'.repeat(64), token.code), false);
  }
  a.equal(seen.size, 8);
});
test('five typed bindings normalize to a fixed hash, retain version0 and reject injected authority or body fields', () => {
  const f = make();
  for (const type of ['permission', 'question', 'plan', 'pool', 'replan']) {
    const { row } = offer(f, type); a.equal(f.api.record(row).binding.expectedVersion, 0);
    const reversed = Object.fromEntries(Object.entries(row.binding).reverse()); a.deepEqual(plain(f.api.binding(reversed)), row.binding);
    for (const change of [r => r.userPressed = true, r => r.code = 'RAW_CODE', r => r.answer = 'RAW_ANSWER', r => r.binding.externalOwner = true,
      r => r.binding.expectedVersion = -1, r => r.binding.controlRevision = 0, r => r.binding.type = '__proto__', r => r.binding.sourceFingerprint = 'bad',
      r => r.offerId = 'x'.repeat(122), r => r.allowedActions.push('unknown'), r => r.expiresAt = new Date(Date.parse(r.issuedAt) + 300001).toISOString()]) {
      const bad = plain(row); change(bad); a.throws(() => f.api.record(bad), { code: 'external_channel.request_invalid' });
    }
    if (row.allowedActions.length > 1) a.throws(() => f.api.record({ ...row, allowedActions: row.allowedActions.toReversed() }), { code: 'external_channel.request_invalid' });
  }
});
test('command identity binds raw text hash, sender and context while eventId retransmission remains stable', () => {
  const f = make(), o = offer(f), first = command(f, o);
  a.deepEqual(command(f, o, { eventId: 'another_event' }), first);
  for (const patch of [{ senderId: 'user_b' }, { conversationId: 'room_b' }, { conversationType: 'direct' }, { text: '/decide ' + o.code + ' deny' }]) a.notDeepEqual(command(f, o, patch), first);
  a.equal(JSON.stringify(first).includes(o.code), false); a.equal(first.textHash, hash('/decide ' + o.code + ' allow'));
  a.throws(() => f.api.command('qq_test', f.message(), { offerId: o.row.offerId, action: 'allow', decisionFingerprint: hash('x'), userPressed: true }), { code: 'external_channel.request_invalid' });
  a.throws(() => f.api.command('qq_test', f.message({ text: 'x'.repeat(8193) }), { offerId: o.row.offerId, action: 'allow', decisionFingerprint: hash('x') }), { code: 'external_channel.request_invalid' });
});
test('unknown, claimed and applying facts only request reconciliation; restart, expiry and revoke cannot restore authorization', () => {
  const f = make(), o = offer(f), claim = claimed(o, command(f, o));
  for (const status of ['prepared', 'offered']) {
    const row = { ...o.row, status, announcementItemId: status === 'prepared' ? '' : 'announcement_test' };
    a.equal(f.api.disposition(row, row.binding.bootId, Date.parse(row.issuedAt)), 'unclaimed');
    a.equal(f.api.disposition(row, 'new_boot', Date.parse(row.issuedAt)), 'closed'); a.equal(f.api.disposition(row, row.binding.bootId, Date.parse(row.expiresAt)), 'closed');
  }
  for (const status of ['claimed', 'applying', 'unknown']) a.equal(f.api.disposition({ ...claim, status }, 'new_boot', Date.parse(o.row.expiresAt) + 1), 'reconcile');
  for (const status of ['applied', 'rejected']) a.equal(f.api.disposition({ ...claim, status, resultHash: hash('recorded original receipt') }), 'terminal');
  for (const status of ['revoked', 'expired']) a.equal(f.api.disposition({ ...o.row, status, announcementItemId: 'announcement_test' }), 'closed');
  a.throws(() => f.api.remoteReceipt({ ...claim, status: 'unknown' })); a.throws(() => f.api.record({ ...claim, status: 'offered' }));
});
for (const enabled of [false, true]) {
  test(`same-ledger durable command facts contain no raw code/answer and permanent dedupe survives restart, sealed=${enabled}`, async () => {
    const f = make({ enabled }), o = offer(f, 'question'), secret = 'ANSWER_FEEDBACK_CANARY', c = command(f, o, {}, '/answer ' + o.code + ' ' + secret);
    let row = await enterClaim(f, o, c); row = { ...row, status: 'applying' }; await replace(f, row); row = { ...row, status: 'applied', resultHash: hash('synthetic original durable response') }; await replace(f, row);
    const state = plain(await f.api.read()), receipt = plain(f.api.remoteReceipt(row)); state.remoteActions = []; state.remoteActionReceipts = [receipt]; await f.api.write(state);
    const material = JSON.stringify(await f.api.read()); for (const forbidden of [o.code, secret, 'user_a', 'room_a', 'session_test']) a.equal(material.includes(forbidden), false);
    a.equal(f.disk().includes(o.code), false); a.equal(f.disk().includes(secret), false); a.equal(JSON.stringify(await f.api.page('limit=20')).includes(o.row.offerId), false);
    const cold = make({ enabled, key: f.key }); cold.setDisk(f.disk()); const before = cold.disk();
    a.equal(cold.api.dedupe(await cold.api.read(), c).status, 'duplicate'); a.equal(cold.api.dedupe(await cold.api.read(), c).idempotencyKey, 'extdec:' + o.row.offerId);
    const changed = command(cold, o, {}, '/answer ' + o.code + ' changed'); a.throws(() => cold.api.dedupe(state, changed), { code: 'external_channel.message_conflict' });
    a.throws(() => cold.api.dedupe(state, command(cold, o, { messageId: 'another_message' })), { code: 'external_channel.message_conflict' });
    a.equal(cold.disk(), before); a.equal(cold.counts().runs, 0); a.equal(cold.counts().sends, 0);
    if (enabled) {
      cold.storage.missing = true; await a.rejects(cold.api.read(), { code: 'external_channel.storage_unavailable' }); a.equal(cold.disk(), before); cold.storage.missing = false;
      cold.storage.enabled = false; await a.rejects(cold.api.write(await cold.api.read()), { code: 'external_channel.storage_unavailable' }); a.equal(cold.disk(), before); a.equal((await cold.api.read()).schema, 7);
      cold.storage.enabled = true; await cold.api.write(await cold.api.read()); a.equal((await cold.api.read()).schema, 7); a.equal(cold.api.dedupe(await cold.api.read(), c).status, 'duplicate');
    }
  });
  test(`actual historical payload1-6 readers reject the entire payload7 ledger and preserve bytes, sealed=${enabled}`, async () => {
    const f = make({ enabled }); await install(f, offer(f).row);
    const sources = [historicalSource('v1'), historicalSource('v2'), historicalSource('v3'), beforeRetention(source), beforeProgress(source), beforeRemoteActions(source)];
    for (const oldSource of sources) {
      const old = fixture({ enabled, key: f.key, source: oldSource }); old.setDisk(f.disk()); const before = old.disk();
      await a.rejects(old.api.read(), { code: 'external_channel.storage_unavailable' }); await a.rejects(old.api.write({ schema: 1, connections: [], items: [], retiredConnectionIds: [] }), { code: 'external_channel.storage_unavailable' }); a.equal(old.disk(), before);
    }
  });
}
test('all original writer paths preserve payload7, while unrelated manual retention keeps exact dedupe', async () => {
  const f = make(); await f.api.update({ op: 'upsert', connection: { ...f.connection, mode: 'control', ownerSenderId: 'user_a', ownerConversationId: 'room_a', ownerConversationType: 'group' }, controlConfirmed: true });
  await f.api.accept(f.message()); await f.api.finish(await f.api.next(), { ok: true, say: 'ordinary completed reply', turnSeq: 1 }); f.api.actors.clear();
  await f.api.finish(await f.api.next(), { status: 'failed', errorCode: 'external_delivery.predispatch' }); await install(f, offer(f).row);
  let state = plain(await f.api.read()), item = state.items[0];
  await f.api.retry({ id: item.id, expectedAttemptId: item.delivery.attemptId, retryRequestId: 'remote_retry_000001' }); item = (await f.api.read()).items[0];
  await f.api.cancel({ id: item.id, attemptId: item.delivery.attemptId }); await f.api.archive({ id: item.id, archived: true });
  state = plain(await f.api.read()); const old = new Date(Date.now() - 100 * 86400000).toISOString();
  for (const row of state.items) { row.receivedAt = old; row.execution.startedAt = old; row.execution.finishedAt = old; row.delivery.updatedAt = old; row.delivery.cancelledAt = old; for (const history of row.replyHistory) { history.requestedAt = old; history.attempt.updatedAt = old; } }
  await f.api.write(state); const preview = await f.api.preview({ requestId: 'remote_retention_0001', retainDays: 30 }); a.equal(preview.count, 1);
  await f.api.reclaim({ requestId: preview.requestId, previewToken: preview.previewToken });
  const { controlRevision, ...connection } = plain((await f.api.read()).connections[0]);
  await f.api.update({ op: 'upsert', connection: { ...connection, progressUpdates: true }, controlConfirmed: true });
  await f.api.accept(f.message({ messageId: 'status_message', text: '/status' })); await f.api.recover();
  state = await f.api.read(); a.equal(state.schema, 7); a.equal(state.remoteActions.length, 1); a.equal(state.retentionReceipts.length, 1);
  a.equal(state.items[0].feedback.queryId, 'not_found'); a.equal(f.counts().runs, 0); a.equal(f.counts().sends, 0);
  await f.api.update({ op: 'disable', id: connection.id }); await f.api.update({ op: 'delete', id: connection.id }); a.equal((await f.api.read()).schema, 7);
});
test('linked C bodies are conservatively excluded and a claim arriving after preview invalidates commit', async () => {
  for (const phase of ['prepared', 'offered', 'claimed', 'applying', 'unknown', 'applied', 'rejected', 'revoked', 'expired']) {
    const f = make(); await f.api.update({ op: 'upsert', connection: f.connection }); await f.api.accept(f.message());
    const state = plain(await f.api.read()), item = state.items[0]; item.receivedAt = new Date(Date.now() - 100 * 86400000).toISOString(); item.readAt = new Date().toISOString(); await f.api.write(state);
    const preview = await f.api.preview({ requestId: 'remote_retention_0002', retainDays: 30 }); a.equal(preview.count, 1);
    const o = offer(f); let row = ['claimed', 'applying', 'unknown', 'applied', 'rejected'].includes(phase) ? claimed(o, command(f, o)) : o.row;
    row = { ...row, status: phase, announcementItemId: item.id, resultHash: ['applied', 'rejected'].includes(phase) ? hash('recorded receipt') : '' };
    const next = plain(await f.api.read()); f.api.upgradeRemote(next); next.remoteActions = [row]; f.setDisk(JSON.stringify(next)); // Crash-stage data, not an admission API.
    a.equal((await f.api.preview({ requestId: 'remote_retention_0003', retainDays: 30 })).count, 0);
    await a.rejects(f.api.reclaim({ requestId: preview.requestId, previewToken: preview.previewToken }), { code: 'external_channel.retention_changed' }); a.equal((await f.api.read()).items.length, 1);
  }
});
test('strict monotonic writes retain claim/unknown/dedupe and cannot downgrade, erase, mutate or resurrect facts', async () => {
  const f = make(), o = offer(f); let row = await enterClaim(f, o); row = { ...row, status: 'unknown' }; await replace(f, row);
  const valid = plain(await f.api.read()), before = f.disk();
  for (const change of [s => { s.schema = 6; delete s.remoteActions; delete s.remoteActionReceipts; }, s => s.remoteActions = [],
    s => { s.remoteActions[0].status = 'offered'; s.remoteActions[0].claim = null; }, s => s.remoteActions[0].status = 'applying',
    s => s.remoteActions[0].claim.idempotencyKey = 'extdec:new', s => s.remoteActions[0].codeHash = hash('changed-code')]) {
    const bad = plain(valid); change(bad); await a.rejects(f.api.write(bad), { code: 'external_channel.storage_unavailable' }); a.equal(f.disk(), before);
  }
  row = { ...row, status: 'rejected', resultHash: hash('strict receipt metadata') }; await replace(f, row);
  const terminal = plain(await f.api.read()); terminal.remoteActions = []; terminal.remoteActionReceipts = [plain(f.api.remoteReceipt(row))]; await f.api.write(terminal);
  const final = f.disk(); for (const change of [s => s.remoteActionReceipts = [], s => s.remoteActionReceipts[0].resultHash = hash('changed'), s => { s.remoteActionReceipts = []; s.remoteActions = [o.row]; }]) {
    const bad = plain(terminal); change(bad); await a.rejects(f.api.write(bad), { code: 'external_channel.storage_unavailable' }); a.equal(f.disk(), final);
  }
});
for (const enabled of [false, true]) test(`write rejection and rename ACK loss preserve exact claim facts without replay, sealed=${enabled}`, async () => {
  const f = make({ enabled }), o = offer(f), c = command(f, o); await install(f, o.row);
  const offered = { ...o.row, status: 'offered', announcementItemId: 'announcement_test' }, before = f.disk();
  f.fail(true); await a.rejects(replace(f, offered), { code: 'external_channel.storage_unavailable' }); a.equal(f.disk(), before); f.fail(false); await replace(f, offered);
  const atomic = f.context.atomicWriteJson; let lost = true;
  f.context.atomicWriteJson = async (...args) => { const result = await atomic(...args); if (lost) { lost = false; throw Object.assign(Error('synthetic post-rename lost ACK'), { code: 'EIO' }); } return result; };
  await a.rejects(replace(f, claimed(o, c)), { code: 'external_channel.storage_unavailable' });
  const persisted = plain(await f.api.read()); a.equal(persisted.remoteActions[0].status, 'claimed'); a.equal(f.api.dedupe(persisted, c).status, 'duplicate');
  const cold = make({ enabled, key: f.key }); cold.setDisk(f.disk()); await cold.api.recover(); a.equal(await cold.api.next(), null);
  a.equal(cold.api.disposition((await cold.api.read()).remoteActions[0]), 'reconcile'); a.equal(cold.counts().runs, 0); a.equal(cold.counts().sends, 0);
  const settled = cold.disk(); await a.rejects(replace(cold, offered), { code: 'external_channel.storage_unavailable' }); a.equal(cold.disk(), settled);
  cold.storage.readError = Object.assign(Error('synthetic read denial'), { code: 'EACCES' }); await a.rejects(cold.api.write(persisted), { code: 'external_channel.storage_unavailable' }); a.equal(cold.disk(), settled); cold.storage.readError = null;
  cold.setDisk(settled.slice(0, -10)); const broken = cold.disk(); await a.rejects(cold.api.read(), { code: 'external_channel.storage_unavailable' }); await a.rejects(cold.api.write(persisted), { code: 'external_channel.storage_unavailable' }); a.equal(cold.disk(), broken);
});
test('capacity and strict schema reject overflow/duplicate hashes/unknown fields without evicting prior evidence', async () => {
  const f = make(), o = offer(f); const state = await install(f, o.row);
  const active = plain(state); active.remoteActions = Array.from({ length: 256 }, (_, i) => ({ ...plain(o.row), offerId: 'offer_' + i, codeHash: hash('code_' + i) })); a.equal(f.api.valid(active), true);
  const full = plain(active); full.remoteActions.push({ ...o.row, offerId: 'overflow', codeHash: hash('overflow') }); a.equal(f.api.valid(full), false);
  const terminal = { ...o.row, status: 'expired', announcementItemId: 'announcement_test' }, receipt = plain(f.api.remoteReceipt(terminal));
  const receipts = plain(state); receipts.remoteActions = []; receipts.remoteActionReceipts = Array.from({ length: 4096 }, (_, i) => ({ ...receipt, offerId: 'receipt_' + i, codeHash: hash('receipt_' + i) })); a.equal(f.api.valid(receipts), true);
  receipts.remoteActionReceipts.push({ ...receipt, offerId: 'overflow', codeHash: hash('overflow') }); a.equal(f.api.valid(receipts), false);
  for (const change of [s => delete s.remoteActionReceipts, s => s.remoteActions[0].rawCode = 'leak', s => s.remoteActions.push(plain(o.row)), s => s.schema = 6]) { const bad = plain(state); change(bad); a.equal(f.api.valid(bad), false); }
  const cap = make(); await cap.api.write(active); const before = cap.disk(); await a.rejects(cap.api.write(full), { code: 'external_channel.storage_unavailable' }); a.equal(cap.disk(), before); a.equal((await cap.api.read()).remoteActions.length, 256);
});
test('hash-pinned inverse preserves every historical fixture and rejects extra whole-source drift', () => {
  const history = require('../fixtures/external-bots-remote-actions/history.json'); a.equal(hash(beforeRemoteActionClosure(source)), history.sha256); a.equal(hash(beforeRemoteActions(source)), history.baseSha256);
  for (const drift of [source + '\n// unreviewed drift\n', source.replace('Math.max(state.schema, 6)', '6')]) { a.equal(beforeRemoteActions(drift), drift); a.throws(() => a.equal(hash(beforeRemoteActions(drift)), history.baseSha256)); }
  const span = history.inverseSpans[0].before; try { history.inverseSpans[0].before += '\n// altered inverse'; a.throws(() => beforeRemoteActions(source)); } finally { history.inverseSpans[0].before = span; }
});
