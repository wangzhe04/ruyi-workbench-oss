'use strict';
// Actual encrypted cold boot of an OFFERED, never-claimed permission. Boot's
// legitimate cancellation is recorded separately from the no-write replay gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { actionCommand } = require('./journey-contract.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const counts = fx => ({ model: fx.model.requests.length, outbound: fx.outbound.length, tokenRequests: fx.tokenRequests.length });

function assertOfferStillLive(offer, observedAt) {
  assert.equal(typeof offer.expiresAt, 'string', 'original offer deadline required');
  const deadlineMs = Date.parse(offer.expiresAt);
  assert.ok(Number.isFinite(deadlineMs) && Number.isFinite(observedAt) && observedAt >= 0 && observedAt < deadlineMs,
    'old-boot refusal must occur before the original offer naturally expires');
  return { expiresAt: offer.expiresAt, deadlineMs, observedAt, remainingMs: deadlineMs - observedAt };
}

function assertOriginalOffer(snapshot, scenario, offered, overlayId) {
  const rows = snapshot.rows.filter(row => row.id === scenario.iv.id);
  assert.equal(rows.length, 1, 'the original permission has no applying/terminal phase');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].sessionId, scenario.sid);
  assert.equal(rows[0].interventionVersion || 0, scenario.iv.interventionVersion || 0);
  const offer = snapshot.ledger.remoteActions.find(row => row.offerId === offered.handle);
  assert.equal(offer?.status, 'offered'); assert.equal(offer.claim, null);
  assert.equal(offer.binding.bootId, overlayId);
  assert.equal(offer.binding.sessionId, scenario.sid); assert.equal(offer.binding.interventionId, scenario.iv.id);
  const announcement = snapshot.ledger.items.find(row => row.id === offer.announcementItemId);
  assert.equal(announcement?.execution?.status, 'completed'); assert.equal(announcement?.delivery?.status, 'sent');
  assert.equal(announcement.id, offered.pages.at(-1).item.id, 'the original complete page published the offered code');
  assert.match(offered.code, /^ra_[A-Za-z0-9_-]{22}$/);
  assert.ok(!JSON.stringify(snapshot.ledger).includes(offered.code), 'raw offered code is not persisted even inside the sealed logical ledger');
  return offer;
}

function assertRecoveredOffer(before, after, scenario, offered) {
  const previous = before.ledger.remoteActions.find(row => row.offerId === offered.handle);
  const offer = after.ledger.remoteActions.find(row => row.offerId === offered.handle);
  assert.ok(offer && ['offered', 'revoked', 'expired'].includes(offer.status), 'unclaimed old offer stays non-authorizing');
  assert.equal(offer.claim, null); assert.deepEqual(offer.binding, previous.binding); assert.equal(offer.codeHash, previous.codeHash);
  const rows = after.rows.filter(row => row.id === scenario.iv.id), terminal = rows.at(-1);
  assert.equal(rows.length, 2, 'boot adds only its original cancellation row');
  const originalPending = before.rows.find(row => row.id === scenario.iv.id);
  assert.deepEqual(rows[0], originalPending, 'boot preserves the full original pending phase');
  assert.equal(rows[0].status, 'pending'); assert.equal(terminal.status, 'cancelled_restart');
  assert.equal(terminal.sessionId, scenario.sid);
  assert.equal(terminal.decidedBy, 'restart'); assert.equal(terminal.interventionVersion, (scenario.iv.interventionVersion || 0) + 1);
  assert.ok(terminal.decidedAt); assert.ok(!rows.some(row => row.status === 'applying' || row.status === 'allowed'));
  assert.equal(terminal.idempotencyKey, undefined, 'no remote claim manufactured a decision identity');
  assert.equal(terminal.decisionFingerprint, undefined);
  assert.deepEqual(terminal, { ...originalPending, status: 'cancelled_restart', decidedAt: terminal.decidedAt,
    decidedBy: 'restart', interventionVersion: (scenario.iv.interventionVersion || 0) + 1 }, 'boot cancellation preserves original parameters and changes only its recovery fields');
  assert.ok(!before.journalBytes.equals(after.journalBytes), 'boot cancellation is real durable journal change, not replay side effect');
  return terminal;
}

function assertNoReplayChanges(baseline, current) {
  assert.deepEqual(current.ledger, baseline.ledger, 'rejected old code creates no durable inbox/claim');
  assert.deepEqual(current.rows, baseline.rows, 'rejected old code creates no authoritative phase');
  assert.deepEqual(current.queueBytes, baseline.queueBytes, 'post-boot ciphertext queue stays byte-identical');
  assert.deepEqual(current.journalBytes, baseline.journalBytes, 'post-boot ciphertext journal stays byte-identical');
}

async function stableSnapshot(fx, sid) {
  return fx.wait(async () => {
    const queueBytes = fs.readFileSync(fx.ledgerFile()), journalBytes = fs.readFileSync(fx.journalFile(sid));
    const ledger = await fx.ledger(), rows = await fx.journal(sid);
    if (!queueBytes.equals(fs.readFileSync(fx.ledgerFile())) || !journalBytes.equals(fs.readFileSync(fx.journalFile(sid)))) return null;
    return { ledger, rows, queueBytes, journalBytes };
  }, 'stable original production-reader/ciphertext observation');
}

function saveSnapshot(output, name, snapshot) {
  fs.writeFileSync(path.join(output, name + '-queue.bin'), snapshot.queueBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(output, name + '-journal.bin'), snapshot.journalBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(output, name + '-logical.json'), JSON.stringify({ ledger: snapshot.ledger, rows: snapshot.rows,
    queueSha256: sha(snapshot.queueBytes), journalSha256: sha(snapshot.journalBytes) }, null, 2), { flag: 'wx' });
}

async function unclaimedColdOfferJourney(fx, sequence, t, output, helpers) {
  assert.ok(fx.sealed && fx.browser, 'actual Windows DPAPI/browser fixture required');
  const scenario = await helpers.nativePending(fx, 'permission', 'allow', sequence);
  const { sid, iv, title, target } = scenario, platform = 'qq';
  await helpers.browserPending(fx, iv, 'permission', output);
  const offered = await fx.offer(iv, 'permission', title, platform);
  const original = fx.server, oldRuntime = JSON.parse(fs.readFileSync(path.join(fx.home, 'runtime.json'), 'utf8'));
  assert.equal(original?.pid, oldRuntime.pid); assert.equal(oldRuntime.token, fx.token); assert.ok(oldRuntime.overlayId);
  const before = await stableSnapshot(fx, sid), originalOffer = assertOriginalOffer(before, scenario, offered, oldRuntime.overlayId);
  const prebootValidity = assertOfferStillLive(originalOffer, Date.now());
  assert.equal(fs.existsSync(target), false);
  const originalCounts = counts(fx);
  const originalStorage = await fx.assertSealed(sid, [title, offered.code, 'C2 原始参数']);
  saveSnapshot(output, 'before-boot', before);
  t.ok(true, 'encrypted original live permission publishes a complete sent offer with no claim, applying phase or file effect');

  await fx.stop();
  const stopped = fx.evidence().actors.find(row => row.pid === original.pid);
  assert.ok((original.exitCode !== null || original.signalCode !== null) && stopped?.exit && stopped.close, 'original held serve exited and closed before replacement spawn');
  const oldStream = await fx.bounded(scenario.stream.done.then(events => ({ status: 'fulfilled', eventTypes: events.map(row => row.type) }),
    error => ({ status: 'rejected-after-known-serve-close', code: error.code || '', name: error.name })), 'old original pending stream settlement');
  await fx.start();
  const runtime = JSON.parse(fs.readFileSync(path.join(fx.home, 'runtime.json'), 'utf8'));
  assert.ok(fx.server !== original && runtime.pid === fx.server.pid && runtime.token === fx.token
    && runtime.token !== oldRuntime.token && runtime.overlayId && runtime.overlayId !== oldRuntime.overlayId, 'actual new serve process/boot/token on the original physical home');
  const health = await fx.request('GET', '/health', undefined, { admin: false });
  assert.equal(health.status, 200); assert.equal(health.json?.overlayId, runtime.overlayId);
  await fx.wait(async () => (await fx.journal(sid)).some(row => row.id === iv.id && row.status === 'cancelled_restart'), 'production boot cancellation committed');
  const recovered = await stableSnapshot(fx, sid), terminal = assertRecoveredOffer(before, recovered, scenario, offered);
  assert.equal(fs.existsSync(target), false); assert.deepEqual(counts(fx), originalCounts, 'restart recovers state without model/dispatch/token/file effects');
  saveSnapshot(output, 'after-boot-before-replay', recovered);
  const history = await fx.request('GET', '/api/interventions/' + encodeURIComponent(sid) + '?limit=100');
  fs.writeFileSync(path.join(output, 'recovered-history.json'), JSON.stringify(history, null, 2), { flag: 'wx' });
  assert.equal(history.status, 200); assert.equal(history.json?.integrity?.degraded, false); assert.ok(!history.json.nextCursor);
  const historyRow = history.json.interventions.find(row => row.id === iv.id && row.sessionId === sid);
  assert.deepEqual(historyRow, { ...recovered.rows[0], ...terminal }, 'new HTTP owner independently reads the exact original boot recovery');
  t.ok(true, 'known old serve exit/close precedes a fresh serve; real boot cancellation is recorded separately from replay invariance');

  const callbacks = [], text = actionCommand('permission', offered.code, 'allow'), id = fx.nextId('old_boot_unclaimed');
  const attempts = [[id, id], [id, fx.nextId('old_boot_new_event')], [fx.nextId('old_boot_reused_code'), fx.nextId('old_boot_new_message_event')]];
  for (const [messageId, eventId] of attempts) {
    const observedAt = Date.now();
    fs.writeFileSync(path.join(output, 'replay-' + (callbacks.length + 1) + '-before.json'), JSON.stringify({ messageId, eventId,
      expiresAt: originalOffer.expiresAt, deadlineMs: Date.parse(originalOffer.expiresAt), observedAt }, null, 2), { flag: 'wx' });
    const validityBefore = assertOfferStillLive(originalOffer, observedAt);
    const response = await fx.callback(messageId, text, platform, { eventId });
    const settled = await fx.settledCallback(messageId, response);
    callbacks.push({ messageId, eventId, status: response.status, response: response.json, settled, validityBefore, observedAfter: Date.now() });
    fs.writeFileSync(path.join(output, 'replay-' + callbacks.length + '.json'), JSON.stringify(callbacks.at(-1), null, 2), { flag: 'wx' });
    assertOfferStillLive(originalOffer, callbacks.at(-1).observedAfter);
    assert.deepEqual(settled, { kind: 'synchronous-rejection', status: 409, code: 'external_channel.delivery_changed', originalInboxItemAbsent: true });
    assertNoReplayChanges(recovered, await stableSnapshot(fx, sid));
    assert.deepEqual(counts(fx), originalCounts); assert.equal(fs.existsSync(target), false);
  }
  t.ok(true, 'old unclaimed code plus same-message/new-event and new-message reuse synchronously refuse with no claim, core phase or dispatch');

  const b = fx.browser, oldPage = await fx.bounded(b.evaluate('performance.timeOrigin'), 'old unclaimed browser document');
  await fx.bounded(b.cdp.send('Page.reload'), 'reload after unclaimed cold boot');
  assert.ok(await fx.bounded(b.waitForEval(`performance.timeOrigin!==${oldPage} && window.state?.config?.workDataEncryptionV1===true`), 'fresh encrypted browser document'));
  assert.ok(await fx.bounded(b.setLens('steward'), 'fresh unclaimed steward lens'));
  const browserOutput = path.join(output, 'cold-browser'); fs.mkdirSync(browserOutput);
  const browser = await helpers.coldBrowserPendingAbsence(fx, iv, browserOutput);
  assertNoReplayChanges(recovered, await stableSnapshot(fx, sid));
  assert.deepEqual(counts(fx), originalCounts); assert.equal(fs.existsSync(target), false);
  const storage = await fx.assertSealed(sid, [title, offered.code, 'C2 原始参数']);
  const result = { type: 'permission', action: 'unclaimed-cold-refusal', platform, sessionId: sid, interventionId: iv.id,
    oldBoot: { pid: oldRuntime.pid, overlayId: oldRuntime.overlayId, offerId: originalOffer.offerId, status: originalOffer.status, claim: originalOffer.claim, prebootValidity },
    newBoot: { pid: runtime.pid, overlayId: runtime.overlayId, oldHeldExit: stopped.exit, oldHeldClose: stopped.close, oldStream },
    recoveredStatus: terminal.status, recoveredVersion: terminal.interventionVersion, postBootOfferStatus: recovered.ledger.remoteActions.find(row => row.offerId === offered.handle).status,
    originalStorage, storage, callbacks, browser,
    bounds: ['actual reboot also cancels the old live permission; not isolated proof of the boot-binding check alone', 'no claim or applied action is seeded or replayed', 'offline synthetic QQ, not real platform'] };
  fs.writeFileSync(path.join(output, 'unclaimed-cold-offer.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  t.ok(true, 'fresh browser excludes the boot-cancelled permission; post-boot raw ciphertext, original terminal and zero effects remain unchanged');
  return result;
}
module.exports = { assertOfferStillLive, assertOriginalOffer, assertRecoveredOffer, assertNoReplayChanges, unclaimedColdOfferJourney };
