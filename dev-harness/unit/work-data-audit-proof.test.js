'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const { fixture } = require('./work-data-journals.test');

test('audit kind has fixed audit purpose and day scope; legacy four kinds remain frozen', async () => {
  const f = fixture('audit-log');
  assert.deepEqual(Array.from(f.records.KINDS), ['messages', 'provider', 'interventions', 'changes']);
  await f.append(['{"kind":"intervention","secret":"audit-payload"}']);
  const row = JSON.parse((await fsp.readFile(f.file, 'utf8')).trim());
  assert.equal(row.e.purpose, 'audit'); // fixed by the kind, never selected by the payload.
  const binding = { purpose: 'audit', instanceId: f.state.instanceId, schema: 2, scopeId: f.context.sessionId, recordId: 'audit-log:0', seq: 0 };
  assert.equal(f.base.crypto.open(row.e, f.key, binding), '{"kind":"intervention","secret":"audit-payload"}');
  assert.throws(() => f.base.crypto.open(row.e, f.key, { ...binding, purpose: 'queue' }));
  assert.throws(() => f.base.crypto.open(row.e, f.key, { ...binding, scopeId: 'another-day' }));
  f.released();
});

test('read proof hashes same logical full sink even when ordinary tail discards changed head with frozen stat', async () => {
  const f = fixture('audit-log'); f.state.enabled = false;
  const original = '{"head":1}\n' + 'z'.repeat(150000) + '\n{"tail":1}\n';
  await fsp.writeFile(f.file, original); f.state.frozenStat = await fsp.stat(f.file, { bigint: true });
  const proof = await f.journal.readProof(100, 50);
  assert.equal(proof.text, Buffer.from(original).subarray(-50).toString('utf8'));
  await proof.check();
  const handle = await fsp.open(f.file, 'r+'); try { await handle.write(Buffer.from('{"head":2}'), 0, 10, 0); } finally { await handle.close(); }
  await assert.rejects(proof.check(), { code: 'work_data_journal.source_changed' });
  assert.equal(f.state.acquires, 0);
});

test('proof reauthenticates current ciphertext and fresh key/instance before accepting same bytes', async () => {
  const f = fixture('audit-log'); await f.append(['{"kind":"audit","x":1}']);
  const proof = await f.journal.readProof(1000, 1000), acquired = f.state.acquires;
  await proof.check(); assert.ok(f.state.acquires > acquired); f.released();
  f.state.keyError = Object.assign(Error('missing'), { code: 'work_data_key.absent' });
  await assert.rejects(proof.check(), { code: 'work_data_key.absent' });
  f.state.keyError = null; f.state.instanceId = 'd'.repeat(32);
  await assert.rejects(proof.check(), { code: 'work_data_record.authenticate_failed' });
});

test('proof rejects valid same-size replacement ciphertext under full frozen stamp', async () => {
  const f = fixture('audit-log'); await f.append(['{"kind":"audit","x":1}']);
  f.state.frozenStat = await fsp.stat(f.file, { bigint: true });
  const proof = await f.journal.readProof(1000, 1000);
  const binding = { purpose: 'audit', instanceId: f.state.instanceId, schema: 2, scopeId: f.context.sessionId, recordId: 'audit-log:0', seq: 0 };
  const next = JSON.stringify({ w: 2, e: f.base.crypto.seal('{"kind":"audit","x":2}', f.key, binding) }) + '\n';
  assert.equal(Buffer.byteLength(next), Number(f.state.frozenStat.size)); await fsp.writeFile(f.file, next);
  await assert.rejects(proof.check(), { code: 'work_data_journal.source_changed' }); f.released();
});

test('proof authenticates full no-LF sealed tail, permits reads, and refuses mutation', async () => {
  const f = fixture('audit-log'); await f.append(['{"kind":"tail"}']);
  await fsp.truncate(f.file, (await fsp.stat(f.file)).size - 1);
  const proof = await f.journal.readProof(Infinity, 1);
  assert.equal(proof.text, '{"kind":"tail"}'); await proof.check();
  await assert.rejects(f.append(['{"kind":"next"}']), { code: 'work_data_journal.sealed_tail_uncommitted' }); f.released();
});
