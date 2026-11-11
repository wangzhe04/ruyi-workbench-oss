'use strict';
// Pure boundary tests: no DPAPI, process spawn or fake encrypted-store acceptance.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { requestShape, readObservation, assertSameDirectory } = require('../lib/external-bots-c2/sealed-observer.cjs');

test('Windows canonical case spelling names the same real directory, while a different physical root never does', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-C2-Observer-Case-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const other = path.join(root, 'different-root'); fs.mkdirSync(other);
  assertSameDirectory(root, fs.realpathSync.native(root));
  if (process.platform === 'win32') assertSameDirectory(root.toLowerCase(), root.toUpperCase());
  else assert.throws(() => assertSameDirectory(root.toLowerCase(), root.toUpperCase()));
  assert.throws(() => assertSameDirectory(root, other), /different physical root path/);
  assert.throws(() => assertSameDirectory(root, path.join(root, 'missing')), { code: 'ENOENT' });
});

test('observer accepts only bounded identity-based read operations, never path/write/key/control commands', () => {
  for (const message of [{ id: 1, op: 'ledger' }, { id: 2, op: 'journal', sid: 'session_original-1' }]) assert.equal(requestShape(message), message);
  for (const message of [null, [], {}, { id: 0, op: 'ledger' }, { id: 1.1, op: 'ledger' }, { id: 1, op: 'write' },
    { id: 1, op: 'keys' }, { id: 1, op: 'bind' }, { id: 1, op: 'ledger', file: 'other' },
    { id: 1, op: 'journal' }, { id: 1, op: 'journal', sid: '../other' }, { id: 1, op: 'journal', sid: 'a\\b' },
    { id: 1, op: 'journal', sid: 'C:\\other' }, { id: 1, op: 'journal', sid: '' }, { id: 1, op: 'journal', sid: 'a'.repeat(129) },
    { id: 1, op: 'journal', sid: 'good', kind: 'messages' }]) assert.throws(() => requestShape(message));
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-c2-observer-pure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sessions'));
  const selected = { root, id: 'a'.repeat(48), mode: 'encrypted', generation: 1, proof: { sha256: 'b'.repeat(64) } };
  const current = structuredClone(selected), calls = [];
  const manifest = { async readActive() { calls.push('manifest'); return structuredClone(current); } };
  const api = { async externalBotReadState() { calls.push('production-ledger-read'); return { items: [{ id: 'original' }] }; },
    async decodeSessionJournalText(sid, kind, raw) { calls.push({ sid, kind, raw }); return '{"id":"decision","status":"answered"}\n'; } };
  return { root, selected, current, manifest, api, calls };
}

test('observer delegates exact selected-root bytes to production decoder and binds ledger reads before and after observation', async t => {
  const f = fixture(t), raw = '{"w":2,"e":"opaque-byte-observation"}\n';
  fs.writeFileSync(path.join(f.root, 'sessions', 'original.interventions.ndjson'), raw);
  assert.deepEqual(await readObservation(f.api, f.selected, f.manifest, { id: 1, op: 'journal', sid: 'original' }), [{ id: 'decision', status: 'answered' }]);
  assert.deepEqual(f.calls, ['manifest', { sid: 'original', kind: 'interventions', raw }, 'manifest']);
  f.calls.length = 0;
  assert.deepEqual(await readObservation(f.api, f.selected, f.manifest, { id: 2, op: 'ledger' }), { items: [{ id: 'original' }] });
  assert.deepEqual(f.calls, ['manifest', 'production-ledger-read', 'manifest']);
  if (process.platform === 'win32') {
    f.current.root = f.root.toUpperCase();
    assert.deepEqual(await readObservation(f.api, f.selected, f.manifest, { id: 3, op: 'ledger' }), { items: [{ id: 'original' }] });
  }
});

test('missing bytes, locked key, malformed decoded rows and production ledger errors all reject rather than return an empty journal/ledger', async t => {
  const f = fixture(t), request = { id: 1, op: 'journal', sid: 'original' };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, request), { code: 'ENOENT' });
  fs.writeFileSync(path.join(f.root, 'sessions', 'original.interventions.ndjson'), 'not-plaintext\n');
  f.api.decodeSessionJournalText = async () => { throw Object.assign(Error('locked key'), { code: 'work_data_key.decrypt_failed' }); };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, request), { code: 'work_data_key.decrypt_failed' });
  f.api.decodeSessionJournalText = async () => 'invalid decoded JSON\n';
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, request), SyntaxError);
  f.api.externalBotReadState = async () => { throw Object.assign(Error('corrupt ledger'), { code: 'external_channel.storage_unavailable' }); };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, { id: 2, op: 'ledger' }), { code: 'external_channel.storage_unavailable' });
});

test('changed root, mode, generation, id or manifest proof fails before production IO and a change during IO fails before returning facts', async t => {
  for (const field of ['root', 'mode', 'generation', 'id', 'proof']) {
    const f = fixture(t);
    f.current[field] = field === 'generation' ? 2 : field === 'proof' ? { sha256: 'c'.repeat(64) } : 'changed';
    if (field === 'root') { f.current.root = path.join(f.root, 'different-physical-root'); fs.mkdirSync(f.current.root); }
    await assert.rejects(readObservation(f.api, f.selected, f.manifest, { id: 1, op: 'ledger' }));
    assert.deepEqual(f.calls, ['manifest']);
  }
  const f = fixture(t);
  f.api.externalBotReadState = async () => { f.current.generation++; return { items: [] }; };
  await assert.rejects(readObservation(f.api, f.selected, f.manifest, { id: 2, op: 'ledger' }));
});
