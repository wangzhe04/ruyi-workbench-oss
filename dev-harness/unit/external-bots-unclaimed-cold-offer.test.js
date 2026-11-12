'use strict';
// Test-oracle boundaries only; these synthetic values are not DPAPI/HTTP proof.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertOfferStillLive, assertOriginalOffer, assertRecoveredOffer, assertNoReplayChanges } = require('../lib/external-bots-c2/unclaimed-cold-offer.cjs');

test('old-boot refusal oracle rejects missing, invalid, reached or expired original deadlines without renewing TTL', () => {
  const expiresAt = '2026-11-11T10:10:00.000Z', deadline = Date.parse(expiresAt);
  assert.deepEqual(assertOfferStillLive({ expiresAt }, deadline - 1), { expiresAt, deadlineMs: deadline, observedAt: deadline - 1, remainingMs: 1 });
  for (const [offer, observedAt] of [[{}, deadline - 1], [{ expiresAt: 'invalid' }, deadline - 1],
    [{ expiresAt }, deadline], [{ expiresAt }, deadline + 1], [{ expiresAt }, NaN]]) assert.throws(() => assertOfferStillLive(offer, observedAt));
});

function fixture() {
  const scenario = { sid: 'sess_original', iv: { id: 'permission_original', interventionVersion: 0 } };
  const offered = { handle: 'offer_original', code: 'ra_' + 'a'.repeat(22), pages: [{ item: { id: 'page_original' } }] };
  const before = { rows: [{ id: scenario.iv.id, sessionId: scenario.sid, status: 'pending', interventionVersion: 0 }],
    ledger: { items: [{ id: 'page_original', execution: { status: 'completed' }, delivery: { status: 'sent' } }],
      remoteActions: [{ offerId: offered.handle, status: 'offered', claim: null, codeHash: 'code-hash-original', announcementItemId: 'page_original',
        binding: { bootId: 'old_overlay', sessionId: scenario.sid, interventionId: scenario.iv.id } }] },
    journalBytes: Buffer.from('synthetic-preboot-raw-bytes'), queueBytes: Buffer.from('synthetic-preboot-queue-bytes') };
  const recovered = structuredClone(before);
  recovered.journalBytes = Buffer.from('synthetic-postboot-raw-bytes'); recovered.queueBytes = Buffer.from(before.queueBytes);
  recovered.rows.push({ ...before.rows[0], status: 'cancelled_restart', interventionVersion: 1, decidedBy: 'restart', decidedAt: '2026-11-11T10:00:00.000Z' });
  return { scenario, offered, before, recovered };
}

test('preboot oracle requires an original complete sent offer with null claim, pending-only consumer and matching boot/session/intervention', () => {
  const f = fixture(); assertOriginalOffer(f.before, f.scenario, f.offered, 'old_overlay');
  const mutations = [
    f => { f.before.rows[0].status = 'allowed'; }, f => { f.before.rows.push({ ...f.before.rows[0], status: 'applying' }); },
    f => { f.before.ledger.remoteActions[0].claim = { idempotencyKey: 'already-applied' }; },
    f => { f.before.ledger.remoteActions[0].status = 'applied'; }, f => { f.before.ledger.remoteActions[0].binding.bootId = 'other_boot'; },
    f => { f.before.ledger.remoteActions[0].binding.interventionId = 'another_permission'; },
    f => { f.before.ledger.items[0].reply = f.offered.code; },
    f => { f.before.ledger.items[0].delivery.status = 'unknown'; }, f => { f.offered.pages[0].item.id = 'another_page'; },
  ];
  for (const mutate of mutations) { const changed = fixture(); mutate(changed); assert.throws(() => assertOriginalOffer(changed.before, changed.scenario, changed.offered, 'old_overlay')); }
});

test('cold recovery permits its real cancellation bytes and an unclaimed offered/revoked/expired ledger without pretending preboot bytes were invariant', () => {
  for (const status of ['offered', 'revoked', 'expired']) {
    const f = fixture(); f.recovered.ledger.remoteActions[0].status = status;
    f.recovered.queueBytes = Buffer.from('legitimate-recovery-or-expiry-queue-bytes');
    assert.equal(assertRecoveredOffer(f.before, f.recovered, f.scenario, f.offered).status, 'cancelled_restart');
  }
});

test('cold recovery cannot launder an applied/claimed action, wrong-version terminal, extra CAS phase or substituted binding as boot cancellation', () => {
  const mutations = [
    f => { f.recovered.ledger.remoteActions[0].status = 'applied'; }, f => { f.recovered.ledger.remoteActions[0].status = 'unknown'; },
    f => { f.recovered.ledger.remoteActions[0].claim = { idempotencyKey: 'claimed' }; },
    f => { f.recovered.ledger.remoteActions[0].binding.bootId = 'new_overlay'; }, f => { f.recovered.ledger.remoteActions[0].codeHash = 'different'; },
    f => { f.recovered.rows[1].status = 'allowed'; }, f => { f.recovered.rows[1].interventionVersion = 2; },
    f => { f.recovered.rows[1].decidedBy = 'external_human'; }, f => { f.recovered.rows[1].idempotencyKey = 'remote-claim'; },
    f => { f.recovered.rows[1].decisionFingerprint = 'unexpected-authority'; },
    f => { f.recovered.rows[0].sessionId = 'different_original'; }, f => { f.recovered.rows[0].parameters = { path: 'changed' }; },
    f => { f.recovered.rows[1].parameters = { path: 'changed' }; },
    f => { f.recovered.rows.splice(1, 0, { ...f.recovered.rows[0], status: 'applying' }); },
    f => { f.recovered.journalBytes = Buffer.from(f.before.journalBytes); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => assertRecoveredOffer(f.before, f.recovered, f.scenario, f.offered)); }
});

test('replay oracle independently locks logical inbox/claim/core facts and both exact postboot ciphertext byte sequences', () => {
  const f = fixture(), baseline = f.recovered;
  const copy = () => ({ ...structuredClone(baseline), queueBytes: Buffer.from(baseline.queueBytes), journalBytes: Buffer.from(baseline.journalBytes) });
  assertNoReplayChanges(baseline, copy());
  const mutations = [
    row => { row.ledger.items.push({ id: 'admitted-old-code' }); }, row => { row.ledger.remoteActions[0].claim = { idempotencyKey: 'new' }; },
    row => { row.rows.push({ ...row.rows[0], status: 'applying' }); }, row => { row.queueBytes[0] ^= 1; }, row => { row.journalBytes[0] ^= 1; },
  ];
  for (const mutate of mutations) { const changed = copy(); mutate(changed); assert.throws(() => assertNoReplayChanges(baseline, changed)); }
});
