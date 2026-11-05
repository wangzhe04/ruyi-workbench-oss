'use strict';
// Sealed store draft over a temporary directory: 01ai writes 01af parts plus the
// manifest, 01ah records the catalog row, 01ag reads the result back.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises'),
  path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const { constBlock, functionBlock } = require('../lib/source-slice');
const SRC = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function load() {
  const code = [SRC('01h-privacy-core.js'), constBlock(SRC('01n-work-data-crypto.js'), 'WorkDataCrypto'),
    constBlock(SRC('01r-work-data-chunks.js'), 'WorkDataChunks'), constBlock(SRC('01p-work-data-store.js'), 'WorkDataStore'),
    functionBlock(SRC('01-config.js'), 'atomicWriteJson'), SRC('01af-work-data-attachment-chunks.js'),
    SRC('01ah-work-data-attachment-catalog.js'), SRC('01ag-work-data-attachment-reader.js'), SRC('01ai-work-data-attachment-store.js')].join('\n');
  const context = { require, Buffer, console, process, setTimeout, clearTimeout, crypto, fsp, AbortSignal };
  vm.createContext(context);
  return vm.runInContext(code + '\n({chunks:WorkDataAttachmentChunks,catalog:WorkDataAttachmentCatalog,reader:WorkDataAttachmentReader,store:WorkDataAttachmentStore})', context);
}
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-attachment-store-'));
  t.after(async () => { try { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); } finally { await fsp.rm(root, { recursive: true, force: true }); } });
  const api = load(), key = crypto.randomBytes(32), instanceId = 'b'.repeat(32), rows = { text: null, releases: 0 };
  const memory = { async read() { if (rows.text === null) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } return rows.text; }, async write(value) { rows.text = value; } };
  const catalog = api.catalog.create({ store: memory, purpose: 'session', scopeId: 'sessions' });
  const keys = { async snapshot() { return { key: Buffer.from(key), instanceId, release() { rows.releases++; } }; } };
  const store = api.store.create({ root, keys, catalog, purpose: 'session', scopeId: 'sessions', generation: 1 });
  const reader = api.reader.create({ root, keys, authority: catalog });
  const id = 'file_0123456789abcdef', opaque = 'c'.repeat(32), revision = 'd'.repeat(32);
  const data = Buffer.concat([Buffer.alloc(300 * 1024, 9), Buffer.from('tail')]);
  const metadata = { logicalName: '报告😀.bin', mime: 'application/octet-stream', kind: 'original' };
  return { api, root, id, opaque, revision, data, metadata, store, reader, catalog, rows };
}
test('sealed store writes parts and manifest that the reader verifies', async t => {
  const f = await fixture(t);
  const receipt = await f.store.seal({ id: f.id, opaque: f.opaque, revision: f.revision, metadata: f.metadata, data: f.data });
  assert.equal(receipt.totalBytes, f.data.length);
  assert.equal(receipt.sha256, sha(f.data));
  assert.equal(f.rows.releases, 1);
  const lease = await f.reader.readRange(f.id), bytes = Buffer.from(lease.bytes);
  assert.deepEqual(bytes, f.data);
  lease.release();
  assert.equal((await f.reader.verifyWhole(f.id)).verified, true);
  assert.equal((await f.catalog.rows())[0].state, 'sealed');
});
test('a failed publish leaves the catalog marked uncertain instead of half-readable', async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, f.opaque, f.revision);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), Buffer.from('{}'));
  await assert.rejects(f.store.seal({ id: f.id, opaque: f.opaque, revision: f.revision, metadata: f.metadata, data: f.data }), /EEXIST/);
  assert.equal((await f.catalog.rows())[0].state, 'uncertain');
  await assert.rejects(f.reader.readRange(f.id), /not_sealed/);
});
test('an invalid key snapshot is refused and its lease is still released', async t => {
  const f = await fixture(t);
  let releases = 0;
  const store = f.api.store.create({ root: f.root, catalog: f.catalog, purpose: 'session', scopeId: 'sessions', generation: 1,
    keys: { async snapshot() { return { key: Buffer.alloc(16), instanceId: 'b'.repeat(32), release() { releases++; } }; } } });
  await assert.rejects(store.seal({ id: f.id, opaque: f.opaque, revision: f.revision, metadata: f.metadata, data: f.data }), /keys/);
  assert.equal(releases, 1);
  assert.equal((await f.catalog.rows()).length, 0);
});
test('re-sealing a sealed id refuses without changing the readable copy', async t => {
  const f = await fixture(t);
  await f.store.seal({ id: f.id, opaque: f.opaque, revision: f.revision, metadata: f.metadata, data: f.data });
  await assert.rejects(f.store.seal({ id: f.id, opaque: f.opaque, revision: f.revision, metadata: f.metadata, data: f.data }), /id_exists/);
  const lease = await f.reader.readRange(f.id), bytes = Buffer.from(lease.bytes);
  assert.deepEqual(bytes, f.data);
  lease.release();
});
