'use strict';
// Sealed upload hook: the transport adapter registers on the boot namespace and
// writes through the real attachment runtime. No HTTP and no router edge.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises'),
  path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const { constBlock, functionBlock } = require('../lib/source-slice');
const SRC = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const key = crypto.randomBytes(32);
function load(root, { badKeys = false } = {}) {
  const code = [SRC('01h-privacy-core.js'), constBlock(SRC('01n-work-data-crypto.js'), 'WorkDataCrypto'),
    constBlock(SRC('01r-work-data-chunks.js'), 'WorkDataChunks'), constBlock(SRC('01p-work-data-store.js'), 'WorkDataStore'),
    functionBlock(SRC('01-config.js'), 'atomicWriteJson'), functionBlock(SRC('04-permission-runtime.js'), 'sanitizeFsSegmentName'),
    SRC('01af-work-data-attachment-chunks.js'), SRC('01ah-work-data-attachment-catalog.js'), SRC('01ag-work-data-attachment-reader.js'),
    SRC('01ai-work-data-attachment-store.js'), SRC('01aj-work-data-attachment-catalogs.js'),
    SRC('01ak-work-data-attachment-runtime.js'), SRC('13ax-work-data-attachment-upload.js')].join('\n');
  const keys = { async snapshot() { return { key: Buffer.from(badKeys ? Buffer.alloc(16) : key), instanceId: 'b'.repeat(32), release() {} }; } };
  const context = { require, Buffer, console, process, setTimeout, clearTimeout, crypto, fsp, AbortSignal, path,
    paths: { uploads: root }, workDataKeys: keys, nowIso: () => '2026-11-05T00:00:00.000Z', WorkDataAttachmentUploadHooks: {},
    readConfig: async () => ({ workDataEncryptionV1: true }), toolImageSessionTag: () => 'tag' };
  vm.createContext(context);
  return vm.runInContext(code + '\n({hooks:WorkDataAttachmentUploadHooks,runtime:WorkDataAttachmentRuntime})', context);
}
async function fixture(t, options) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-upload-hook-'));
  t.after(async () => { try { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); } finally { await fsp.rm(root, { recursive: true, force: true }); } });
  return { api: load(root, options), root };
}
test('hook seals the bytes, derives an id and keeps the sanitized name', async t => {
  const f = await fixture(t);
  const record = await f.api.hooks.sealUpload({ name: '../../evil.txt', mime: 'text/plain', data: Buffer.from('HOOK BYTES').toString('base64') });
  assert.match(record.id, /^file_[a-f0-9]{16}$/);
  assert.equal(record.name, 'evil.txt');
  assert.equal(record.size, 10);
  assert.equal(record.sealed, true);
  assert.equal(record.createdAt, '2026-11-05T00:00:00.000Z');
  const runtime = f.api.runtime.create({ root: f.root, keys: { async snapshot() { return { key: Buffer.from(key), instanceId: 'b'.repeat(32), release() {} }; } }, enabled: () => true });
  const lease = await runtime.read(record.id), bytes = Buffer.from(lease.bytes);
  assert.equal(bytes.toString('utf8'), 'HOOK BYTES');
  lease.release();
});
test('hook returns null for empty data and falls back to a safe mime', async t => {
  const f = await fixture(t);
  assert.equal(await f.api.hooks.sealUpload({ name: 'x.bin', data: '' }), null);
  const record = await f.api.hooks.sealUpload({ name: 'x.bin', mime: 'not a mime', data: Buffer.from('x').toString('base64') });
  assert.equal(record.name, 'x.bin');
});
test('download hooks expose sealed info and ranged bytes', async t => {
  const f = await fixture(t);
  const record = await f.api.hooks.sealUpload({ name: 'a.bin', mime: 'text/plain', data: Buffer.from('0123456789').toString('base64') });
  const info = await f.api.hooks.info(record.id);
  assert.equal(info.totalBytes, 10);
  assert.equal(info.mime, 'text/plain');
  const whole = await f.api.hooks.read({ id: record.id, start: 0, end: info.totalBytes });
  assert.equal(Buffer.from(whole.bytes).toString('utf8'), '0123456789');
  const part = await f.api.hooks.read({ id: record.id, start: 2, end: 5 });
  assert.equal(Buffer.from(part.bytes).toString('utf8'), '234');
  assert.equal(await f.api.hooks.info('file_ffffffffffffffff'), null);
});
test('tool image hooks seal into their own face and retire by session tag', async t => {
  const f = await fixture(t);
  const id = 'toolimg_tag_0123456789abcdef01234567';
  assert.equal(await f.api.hooks.sealToolImage({ id, name: 'shot.png', mime: 'image/png', data: Buffer.from('PNGDATA') }), true);
  assert.equal(await f.api.hooks.sealToolImage({ id, name: 'shot.png', mime: 'image/png', data: Buffer.from('PNGDATA') }), true, 'a repeated image is idempotent instead of failing the tool result');
  const info = await f.api.hooks.info(id);
  assert.equal(info.totalBytes, 7);
  assert.equal(info.mime, 'image/png');
  const whole = await f.api.hooks.read({ id, start: 0, end: 7 });
  assert.equal(Buffer.from(whole.bytes).toString('utf8'), 'PNGDATA');
  const removed = await f.api.hooks.removeToolImages('session-1');
  assert.deepEqual(Array.from(removed.removed), [id]);
  assert.equal(await f.api.hooks.info(id), null);
});
test('hook surfaces sealing failures instead of writing plaintext', async t => {
  const f = await fixture(t, { badKeys: true });
  await assert.rejects(f.api.hooks.sealUpload({ name: 'x.bin', data: Buffer.from('x').toString('base64') }), /work_data/);
  const leftovers = fs.existsSync(f.root) ? fs.readdirSync(f.root).filter(name => name.startsWith('file_')) : [];
  assert.deepEqual(leftovers, []);
});

