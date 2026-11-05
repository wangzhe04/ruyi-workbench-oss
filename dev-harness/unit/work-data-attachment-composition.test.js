'use strict';
// Real composition of the attachment chunk writer, catalog authority and sealed
// reader against a temporary directory and synthetic keys. No product wiring.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises'),
  path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const { constBlock, functionBlock } = require('../lib/source-slice');
const SRC = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function loadComposition() {
  const code = [SRC('01h-privacy-core.js'), constBlock(SRC('01n-work-data-crypto.js'), 'WorkDataCrypto'),
    constBlock(SRC('01r-work-data-chunks.js'), 'WorkDataChunks'), constBlock(SRC('01p-work-data-store.js'), 'WorkDataStore'),
    functionBlock(SRC('01-config.js'), 'atomicWriteJson'), SRC('01af-work-data-attachment-chunks.js'),
    SRC('01ah-work-data-attachment-catalog.js'), SRC('01ag-work-data-attachment-reader.js')].join('\n');
  const context = { require, Buffer, console, process, setTimeout, clearTimeout, crypto, fsp, AbortSignal };
  vm.createContext(context);
  return vm.runInContext(code + '\n({chunks:WorkDataAttachmentChunks,catalog:WorkDataAttachmentCatalog,reader:WorkDataAttachmentReader})', context);
}
function memoryStore() {
  const state = { text: null };
  return { state, store: {
    async read() { if (state.text === null) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } return state.text; },
    async write(value) { state.text = value; },
  } };
}
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-attachment-composition-'));
  t.after(async () => { try { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); } finally { await fsp.rm(root, { recursive: true, force: true }); } });
  const api = loadComposition(), key = crypto.randomBytes(32), instanceId = 'b'.repeat(32);
  const id = 'file_0123456789abcdef', opaque = 'c'.repeat(32), revision = 'd'.repeat(32);
  const binding = { purpose: 'session', instanceId, schema: 1, scopeId: 'sessions', recordId: 'attachment:' + id, seq: 0, generation: 1 };
  const bytes = Buffer.concat([Buffer.alloc(300 * 1024, 7), Buffer.from('tail')]);
  const writer = api.chunks.createWriter({ key, binding, revision, metadata: { logicalName: '报告😀.bin', mime: 'application/octet-stream', kind: 'original' }, maxBytes: api.chunks.MAX_BYTES });
  const parts = []; for (let at = 0; at < bytes.length; at += api.chunks.CHUNK_BYTES) parts.push(writer.write(bytes.subarray(at, at + api.chunks.CHUNK_BYTES)));
  const manifestData = writer.finish();
  const dir = path.join(root, opaque, revision); await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), manifestData);
  for (let ordinal = 0; ordinal < parts.length; ordinal++) await fsp.writeFile(path.join(dir, api.chunks.partName(ordinal)), parts[ordinal].data);
  const { state, store } = memoryStore(), catalog = api.catalog.create({ store, purpose: 'session', scopeId: 'sessions' });
  await catalog.begin({ id, opaque, revision, kind: 'original', logicalName: '报告😀.bin', mime: 'application/octet-stream', generation: 1, recordId: 'attachment:' + id });
  await catalog.seal(id, { manifestSha256: sha(manifestData), manifestBytes: manifestData.length });
  const keys = { async snapshot() { return { key: Buffer.from(key), instanceId, release() {} }; } };
  const reader = api.reader.create({ root, keys, authority: catalog, maxReadBytes: 8 * 1024 * 1024 });
  return { api, root, dir, id, bytes, reader, catalog, parts, state };
}
test('catalog, chunk writer and reader agree on whole and range reads', async t => {
  const f = await fixture(t);
  const whole = await f.reader.readRange(f.id), wholeBytes = Buffer.from(whole.bytes);
  assert.deepEqual(wholeBytes, f.bytes);
  assert.equal(whole.sha256, sha(f.bytes));
  whole.release();
  const range = await f.reader.readRange(f.id, 256 * 1024 - 2, 256 * 1024 + 4), slice = Buffer.from(range.bytes);
  assert.deepEqual(slice, f.bytes.subarray(256 * 1024 - 2, 256 * 1024 + 4));
  range.release();
  const verified = await f.reader.verifyWhole(f.id);
  assert.equal(verified.verified, true);
  assert.equal(verified.totalBytes, f.bytes.length);
  assert.equal(verified.release(), undefined);
});
test('tampered part and removed catalog row both refuse instead of serving stale bytes', async t => {
  const f = await fixture(t);
  const part = path.join(f.dir, f.api.chunks.partName(0));
  const original = await fsp.readFile(part);
  const tampered = Buffer.from(original); tampered[40] ^= 1; await fsp.writeFile(part, tampered);
  await assert.rejects(f.reader.readRange(f.id), /physical/);
  await fsp.writeFile(part, original);
  const ticket = await f.catalog.capture(f.id);
  await f.catalog.remove(f.id);
  assert.equal(f.catalog.assert(ticket, f.id), false);
  await assert.rejects(f.reader.readRange(f.id), /id_missing/);
});
test('census refuses an unexplained extra file next to the sealed parts', async t => {
  const f = await fixture(t);
  await fsp.writeFile(path.join(f.dir, 'part-999999.json'), Buffer.from('{}'));
  await assert.rejects(f.reader.readRange(f.id), /namespace/);
});
