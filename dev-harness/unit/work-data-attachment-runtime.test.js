'use strict';
// Runtime facade over a temporary root: derivation, sealing, range reads and
// lookup, all through the real modules. No HTTP route is involved.
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
    SRC('01ai-work-data-attachment-store.js'), SRC('01aj-work-data-attachment-catalogs.js'),
    SRC('01ak-work-data-attachment-runtime.js')].join('\n');
  const context = { require, Buffer, console, process, setTimeout, clearTimeout, crypto, fsp, AbortSignal };
  vm.createContext(context);
  return vm.runInContext(code + '\n({chunks:WorkDataAttachmentChunks,reader:WorkDataAttachmentReader,catalogs:WorkDataAttachmentCatalogs,runtime:WorkDataAttachmentRuntime})', context);
}
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-attachment-runtime-'));
  t.after(async () => { try { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); } finally { await fsp.rm(root, { recursive: true, force: true }); } });
  const api = load(), key = crypto.randomBytes(32), instanceId = 'b'.repeat(32), flags = { enabled: true };
  const keys = { async snapshot() { return { key: Buffer.from(key), instanceId, release() {} }; } };
  const runtime = () => api.runtime.create({ root, keys, enabled: () => flags.enabled });
  return { api, root, flags, runtime, id: 'file_0123456789abcdef', data: Buffer.concat([Buffer.alloc(270 * 1024, 5), Buffer.from('tail')]) };
}
test('runtime derives the location, seals, reads ranges and reports presence', async t => {
  const f = await fixture(t), first = f.runtime();
  assert.equal(first.opaqueFor(f.id), sha('attachment-opaque:' + f.id).slice(0, 32));
  assert.equal(first.revisionFor(f.data), sha(f.data).slice(0, 32));
  assert.equal(await first.has(f.id), false);
  const receipt = await first.seal({ id: f.id, kind: 'original', logicalName: '附件😀.bin', mime: 'application/octet-stream', data: f.data });
  assert.equal(receipt.sha256, sha(f.data));
  assert.equal(await first.has(f.id), true);
  assert.equal((await first.verify(f.id)).verified, true);
  const lease = await first.read(f.id, 256 * 1024 - 2, 256 * 1024 + 4), slice = Buffer.from(lease.bytes);
  assert.deepEqual(slice, f.data.subarray(256 * 1024 - 2, 256 * 1024 + 4));
  lease.release();
  const reopened = f.runtime();
  assert.equal(await reopened.has(f.id), true);
  const again = await reopened.read(f.id), bytes = Buffer.from(again.bytes);
  assert.deepEqual(bytes, f.data);
  again.release();
});
test('runtime refuses to operate while encryption is off, even after a successful open', async t => {
  const f = await fixture(t);
  const runtime = f.runtime();
  await runtime.seal({ id: f.id, kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', data: f.data });
  assert.equal(await runtime.has(f.id), true);
  f.flags.enabled = false;
  await assert.rejects(runtime.seal({ id: 'file_fedcba9876543210', kind: 'original', logicalName: 'b.bin', mime: 'application/octet-stream', data: f.data }), /disabled/);
  await assert.rejects(runtime.has(f.id), /disabled/);
  await assert.rejects(runtime.read(f.id), /disabled/);
  assert.throws(() => runtime.revisionFor(undefined), /data/);
  assert.throws(() => runtime.opaqueFor('../escape'), /id/);
});
test('runtime discards a failed seal but never a sealed copy', async t => {
  const f = await fixture(t), runtime = f.runtime();
  const dir = path.join(f.root, runtime.opaqueFor(f.id), runtime.revisionFor(f.data));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), Buffer.from('{}'));
  await assert.rejects(runtime.seal({ id: f.id, kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', data: f.data }), /EEXIST/);
  assert.equal(await runtime.has(f.id), false);
  const none = await runtime.discard('file_fedcba9876543210');
  assert.equal(none.discarded, false);
  assert.equal(none.id, 'file_fedcba9876543210');
  const discarded = await runtime.discard(f.id);
  assert.equal(discarded.discarded, true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal((await runtime.discard(f.id)).discarded, false);
});
test('runtime refuses to discard a sealed attachment', async t => {
  const f = await fixture(t), runtime = f.runtime();
  await runtime.seal({ id: f.id, kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', data: f.data });
  await assert.rejects(runtime.discard(f.id), /sealed/);
  assert.equal(await runtime.has(f.id), true);
  assert.equal(fs.existsSync(path.join(f.root, runtime.opaqueFor(f.id), runtime.revisionFor(f.data), 'manifest.json')), true);
});
test('runtime keeps ids apart and refuses unknown ids', async t => {
  const f = await fixture(t), runtime = f.runtime();
  await runtime.seal({ id: f.id, kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', data: f.data });
  assert.equal(await runtime.has('file_fedcba9876543210'), false);
  await assert.rejects(runtime.read('file_fedcba9876543210'), /id_missing|not_sealed/);
  await assert.rejects(runtime.seal({ id: f.id, kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', data: f.data }), /id_exists/);
});
