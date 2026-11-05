'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const code = fs.readFileSync(require('node:path').resolve(__dirname, '../../ruyi-workbench/app/src/01ah-work-data-attachment-catalog.js'), 'utf8');
const row = { id: 'file_0123456789abcdef', opaque: 'a'.repeat(32), revision: 'b'.repeat(32), kind: 'original',
  logicalName: '报告😀.pdf', mime: 'application/pdf', generation: 1, recordId: 'attachment:file_0123456789abcdef' };
function fixture(options = {}) {
  const state = { text: null, writes: 0, chains: 0 };
  const store = {
    async read() { if (state.text === null) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } return state.text; },
    async write(value) { state.writes++; state.text = value; },
  };
  const api = vm.runInNewContext(code + '\nWorkDataAttachmentCatalog;', { require, Buffer });
  const serialize = options.serialize ? work => { state.chains++; return work(); } : undefined;
  return { api, state, catalog: api.create({ store, purpose: options.purpose || 'session', scopeId: 'sessions', serialize }) };
}
const sealed = async (f, input = row) => {
  await f.catalog.begin(input);
  return f.catalog.seal(input.id, { manifestSha256: 'c'.repeat(64), manifestBytes: 4096 });
};
test('sealed attachment row produces the exact eight-field descriptor', async () => {
  const f = fixture();
  await sealed(f);
  const ticket = await f.catalog.capture(row.id);
  const descriptor = f.catalog.describe(ticket, row.id);
  assert.deepEqual(Object.keys(descriptor).sort(), ['generation', 'manifestBytes', 'manifestSha256', 'opaque', 'purpose', 'recordId', 'revision', 'scopeId']);
  assert.equal(descriptor.opaque, row.opaque);
  assert.equal(descriptor.recordId, row.recordId);
  assert.equal(descriptor.purpose, 'session');
  assert.equal(f.catalog.assert(ticket, row.id), true);
  assert.equal(f.state.writes, 2);
});
test('pending and uncertain rows never authorize reading', async () => {
  const f = fixture();
  await f.catalog.begin(row);
  await assert.rejects(f.catalog.capture(row.id), /not_sealed/);
  await f.catalog.uncertain(row.id);
  await assert.rejects(f.catalog.capture(row.id), /not_sealed/);
  await assert.rejects(f.catalog.seal(row.id, { manifestSha256: 'c'.repeat(64), manifestBytes: 1 }), /state/);
});
test('clone, other-id, removed and re-sealed tickets all lose authority', async () => {
  const f = fixture();
  await sealed(f);
  const ticket = await f.catalog.capture(row.id);
  assert.rejects(async () => f.catalog.describe({ ...ticket }, row.id), /ticket_invalid/);
  assert.rejects(async () => f.catalog.describe(ticket, 'file_fedcba9876543210'), /ticket_invalid/);
  await f.catalog.remove(row.id);
  assert.equal(await f.catalog.assert(ticket, row.id), false);
  await assert.rejects(f.catalog.capture(row.id), /id_missing/);
  await sealed(f);
  const first = await f.catalog.capture(row.id);
  await f.catalog.remove(row.id);
  await f.catalog.begin({ ...row, revision: 'd'.repeat(32) });
  await f.catalog.seal(row.id, { manifestSha256: 'e'.repeat(64), manifestBytes: 8 });
  assert.equal(await f.catalog.assert(first, row.id), false);
});
test('catalog refuses manifests above the reader carrier and malformed scopes', async () => {
  const f = fixture();
  await f.catalog.begin(row);
  await assert.rejects(f.catalog.seal(row.id, { manifestSha256: 'c'.repeat(64), manifestBytes: 2 * 1024 * 1024 + 1 }), /proof/);
  assert.throws(() => f.api.create({ store: { read: async () => null, write: async () => {} }, purpose: 'session', scopeId: 'a b/c d' }), /scope/);
});
test('catalog refuses malformed rows, proofs, ids and duplicates', async () => {
  const f = fixture();
  for (const bad of [{ ...row, opaque: 'A'.repeat(32) }, { ...row, kind: 'send-derivative' }, { ...row, generation: 100 },
    { ...row, recordId: 'attachment:other' }, { ...row, logicalName: 'x\u0000y' }, { ...row, mime: 'not-a-mime' }])
    await assert.rejects(f.catalog.begin(bad), /shape|row/);
  await f.catalog.begin(row);
  await assert.rejects(f.catalog.begin(row), /id_exists/);
  await assert.rejects(f.catalog.seal(row.id, { manifestSha256: 'C'.repeat(64), manifestBytes: 1 }), /proof/);
  await assert.rejects(f.catalog.seal(row.id, { manifestSha256: 'c'.repeat(64), manifestBytes: 0 }), /proof/);
  assert.rejects(async () => f.catalog.capture('../escape'), /id/);
});
test('catalog files stay invalid when unparsable and the chain serializes writes', async () => {
  const f = fixture({ serialize: true });
  await sealed(f);
  assert.equal(f.state.chains, 2);
  const rows = await f.catalog.rows();
  assert.equal(rows.length, 1);
  assert.equal(Object.isFrozen(rows[0]), true);
  f.state.text = '{"schema":1,"rows":[{"id":"x"}]}';
  await assert.rejects(f.catalog.rows(), /shape|row/);
  f.state.text = '{}';
  await assert.rejects(f.catalog.rows(), /shape|catalog/);
});
