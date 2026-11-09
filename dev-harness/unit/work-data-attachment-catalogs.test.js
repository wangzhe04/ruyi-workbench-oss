'use strict';
// Catalog persistence glue over the real sealed store: catalogs are chunked
// encrypted files, survive a fresh module instance, and refuse to open while
// work-data encryption is off.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises'),
  path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const { constBlock, functionBlock } = require('../lib/source-slice');
const SRC = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function load() {
  const code = [SRC('01h-privacy-core.js'), constBlock(SRC('01n-work-data-crypto.js'), 'WorkDataCrypto'),
    constBlock(SRC('01r-work-data-chunks.js'), 'WorkDataChunks'), constBlock(SRC('01p-work-data-store.js'), 'WorkDataStore'),
    functionBlock(SRC('01-config.js'), 'atomicWriteJson'), SRC('01af-work-data-attachment-chunks.js'),
    SRC('01ah-work-data-attachment-catalog.js'), SRC('01ag-work-data-attachment-reader.js'),
    SRC('01ai-work-data-attachment-store.js'), SRC('01aj-work-data-attachment-catalogs.js')].join('\n');
  const context = { require, Buffer, console, process, setTimeout, clearTimeout, crypto, fsp, AbortSignal };
  vm.createContext(context);
  return vm.runInContext(code + '\n({chunks:WorkDataAttachmentChunks,catalog:WorkDataAttachmentCatalog,reader:WorkDataAttachmentReader,store:WorkDataAttachmentStore,storeApi:WorkDataStore,catalogs:WorkDataAttachmentCatalogs})', context);
}
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-attachment-catalogs-'));
  t.after(async () => { try { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); } finally { await fsp.rm(root, { recursive: true, force: true }); } });
  const api = load(), key = crypto.randomBytes(32), instanceId = 'b'.repeat(32), flags = { enabled: true, releases: 0 };
  const keys = { async snapshot() { return { key: Buffer.from(key), instanceId, release() { flags.releases++; } }; } };
  const open = () => api.catalogs.create({ root, keys, enabled: () => flags.enabled });
  const id = 'file_0123456789abcdef', opaque = 'c'.repeat(32), revision = 'd'.repeat(32);
  const data = Buffer.concat([Buffer.alloc(280 * 1024, 3), Buffer.from('tail')]);
  const metadata = { logicalName: '附件😀.bin', mime: 'application/octet-stream', kind: 'original' };
  return { api, root, key, instanceId, flags, keys, open, id, opaque, revision, data, metadata };
}
test('catalogs persist across a fresh instance and the reader still verifies', async t => {
  const f = await fixture(t);
  const first = f.open(), catalog = first.open('attachment');
  const store = f.api.store.create({ root: f.root, keys: f.keys, catalog, purpose: 'session', scopeId: 'sessions', generation: 1 });
  const receipt = await store.seal({ id: f.id, opaque: f.opaque, revision: f.revision, metadata: f.metadata, data: f.data });
  assert.equal(receipt.sha256, sha(f.data));
  const reopened = f.open().open('attachment');
  const rows = await reopened.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'sealed');
  const reader = f.api.reader.create({ root: f.root, keys: f.keys, authority: reopened });
  const lease = await reader.readRange(f.id), bytes = Buffer.from(lease.bytes);
  assert.deepEqual(bytes, f.data);
  lease.release();
});
test('faces keep separate catalogs and the sealed file carries no plaintext rows', async t => {
  const f = await fixture(t);
  f.flags.enabled = false;
  assert.throws(() => f.open().open('attachment'), /disabled/);
  f.flags.enabled = true;
  const attachments = f.open().open('attachment'), toolImages = f.open().open('toolImage');
  await attachments.begin({ id: f.id, opaque: f.opaque, revision: f.revision, kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', generation: 1, recordId: 'attachment:' + f.id });
  assert.equal((await attachments.rows()).length, 1);
  assert.equal((await toolImages.rows()).length, 0);
  assert.deepEqual([...f.api.catalogs.faces].sort(), ['attachment', 'toolImage']);
  const raw = await fsp.readFile(path.join(f.root, '_catalog-attachments-v1.json'));
  assert.equal(raw.includes(Buffer.from(f.id)), false);
  assert.match(raw.toString('utf8'), /"workData"\s*:\s*3/);
});
test('an otherwise valid plaintext catalog cannot authorize sealed blob reads or be overwritten as current', async t => {
  const f = await fixture(t), catalog = f.open().open('attachment');
  const store = f.api.store.create({ root: f.root, keys: f.keys, catalog, purpose: 'session', scopeId: 'sessions', generation: 1 });
  await store.seal({ id: f.id, opaque: f.opaque, revision: f.revision, metadata: f.metadata, data: f.data });
  const raw = JSON.stringify({ schema: 1, rows: await catalog.rows() });
  const file = path.join(f.root, '_catalog-attachments-v1.json');
  await fsp.writeFile(file, raw);
  const reopened = f.open().open('attachment');
  const reader = f.api.reader.create({ root: f.root, keys: f.keys, authority: reopened });
  await assert.rejects(reader.readRange(f.id), { code: 'work_data_attachment_catalogs.unsealed' });
  await assert.rejects(reopened.remove(f.id), { code: 'work_data_attachment_catalogs.unsealed' });
  assert.equal(await fsp.readFile(file, 'utf8'), raw);
});
test('two handles on the same root still serialize their writes', async t => {
  const f = await fixture(t), first = f.open().open('attachment'), second = f.open().open('attachment');
  const other = 'file_fedcba9876543210';
  await Promise.all([
    first.begin({ id: f.id, opaque: f.opaque, revision: f.revision, kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', generation: 1, recordId: 'attachment:' + f.id }),
    second.begin({ id: other, opaque: f.opaque, revision: f.revision, kind: 'original', logicalName: 'b.bin', mime: 'application/octet-stream', generation: 1, recordId: 'attachment:' + other }),
  ]);
  const rows = await f.open().open('attachment').rows();
  assert.deepEqual(Array.from(rows, row => row.id).sort(), [f.id, other].sort());
});
test('per-face serialization keeps concurrent begins from losing rows', async t => {
  const f = await fixture(t);
  const catalog = f.open().open('attachment');
  const other = 'file_fedcba9876543210';
  await Promise.all([
    catalog.begin({ id: f.id, opaque: f.opaque, revision: f.revision, kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', generation: 1, recordId: 'attachment:' + f.id }),
    catalog.begin({ id: other, opaque: f.opaque, revision: f.revision, kind: 'original', logicalName: 'b.bin', mime: 'application/octet-stream', generation: 1, recordId: 'attachment:' + other }),
  ]);
  const rows = await f.open().open('attachment').rows();
  assert.deepEqual(Array.from(rows, row => row.id).sort(), [f.id, other].sort());
});
