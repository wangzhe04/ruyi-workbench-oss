'use strict';
// Uploads migration owner over a temporary directory: enroll, seal, verify,
// then remove originals. Unsupported layouts must leave everything untouched.
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
    SRC('01ak-work-data-attachment-runtime.js'), SRC('01al-work-data-uploads-owner.js')].join('\n');
  const context = { require, Buffer, console, process, setTimeout, clearTimeout, crypto, fsp, AbortSignal };
  vm.createContext(context);
  return vm.runInContext(code + '\n({runtime:WorkDataAttachmentRuntime,owner:WorkDataUploadsOwner})', context);
}
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-uploads-owner-'));
  t.after(async () => { try { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); } finally { await fsp.rm(root, { recursive: true, force: true }); } });
  const api = load(), key = crypto.randomBytes(32), instanceId = 'b'.repeat(32);
  const keys = { async snapshot() { return { key: Buffer.from(key), instanceId, release() {} }; } };
  const owner = () => api.owner.create({ root, keys, enabled: () => true });
  const runtime = face => api.runtime.create({ root, keys, enabled: () => true, face });
  const put = async (relative, bytes) => { const file = path.join(root, ...relative.split('/')); await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, bytes); return file; };
  return { api, root, owner, runtime, put };
}
test('owner seals both faces, verifies, then removes the originals', async t => {
  const f = await fixture(t), original = Buffer.from('original attachment'), shot = Buffer.from('tool image bytes');
  await f.put('file_0123456789abcdef/a.bin', original);
  await f.put('toolimg_tag_abc/shot.png', shot);
  const report = await f.owner().sealAll();
  assert.deepEqual(Array.from(report.sealed, row => row.file).sort(), ['a.bin', 'shot.png']);
  assert.equal(report.removed.length, 2);
  assert.equal(fs.existsSync(path.join(f.root, 'file_0123456789abcdef')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'toolimg_tag_abc')), false);
  const a = await f.runtime('attachment').read('file_0123456789abcdef'), aBytes = Buffer.from(a.bytes);
  assert.deepEqual(aBytes, original); a.release();
  const b = await f.runtime('toolImage').read('toolimg_tag_abc'), bBytes = Buffer.from(b.bytes);
  assert.deepEqual(bBytes, shot); b.release();
  assert.equal(sha(original), report.sealed.find(row => row.file === 'a.bin').sha256);
});
test('owner refuses a loose root file and changes nothing', async t => {
  const f = await fixture(t);
  await f.put('file_0123456789abcdef/a.bin', Buffer.from('keep'));
  await f.put('loose.bin', Buffer.from('loose'));
  await assert.rejects(f.owner().sealAll(), error => error.code === 'work_data_uploads_owner.unsupported' && error.unsupported.some(row => row.name === 'loose.bin'));
  assert.equal(fs.existsSync(path.join(f.root, 'file_0123456789abcdef', 'a.bin')), true);
  assert.equal(await f.runtime('attachment').has('file_0123456789abcdef'), false);
});
test('owner refuses a multi-file directory and leaves the single-file one sealed-free', async t => {
  const f = await fixture(t);
  await f.put('file_0123456789abcdef/a.bin', Buffer.from('one'));
  await f.put('file_0123456789abcdef/b.bin', Buffer.from('two'));
  await f.put('file_fedcba9876543210/c.bin', Buffer.from('three'));
  const report = await f.owner().enroll();
  assert.equal(report.files.length, 1);
  assert.equal(report.unsupported.length, 1);
  await assert.rejects(f.owner().sealAll(), /unsupported/);
  assert.equal(fs.existsSync(path.join(f.root, 'file_fedcba9876543210', 'c.bin')), true);
  assert.equal(await f.runtime('attachment').has('file_fedcba9876543210'), false);
});
test('owner refuses empty files and recognises upper-case sealed directories', async t => {
  const f = await fixture(t);
  await f.put('file_0123456789abcdef/empty.bin', Buffer.alloc(0));
  const report = await f.owner().enroll();
  assert.equal(report.files.length, 0);
  assert.equal(report.unsupported[0].reason, 'empty-file');
  await assert.rejects(f.owner().sealAll(), /unsupported/);
  assert.equal(fs.existsSync(path.join(f.root, 'file_0123456789abcdef', 'empty.bin')), true);
  await fsp.mkdir(path.join(f.root, 'A'.repeat(32), 'B'.repeat(32)), { recursive: true });
  assert.equal((await f.owner().enroll()).sealed, 1);
});
test('owner unseals every verified row back to the original layout', async t => {
  const f = await fixture(t), original = Buffer.from('round trip attachment'), shot = Buffer.from('round trip image');
  await f.put('file_0123456789abcdef/a.bin', original);
  await f.put('toolimg_tag_abc/shot.png', shot);
  await f.owner().sealAll();
  assert.equal((await f.runtime('attachment').list()).length, 1);
  const report = await f.owner().unsealAll();
  assert.deepEqual(Array.from(report.restored, row => row.file).sort(), ['a.bin', 'shot.png']);
  assert.deepEqual(Array.from(report.retired).sort(), ['file_0123456789abcdef', 'toolimg_tag_abc']);
  assert.deepEqual(await fsp.readFile(path.join(f.root, 'file_0123456789abcdef', 'a.bin')), original);
  assert.deepEqual(await fsp.readFile(path.join(f.root, 'toolimg_tag_abc', 'shot.png')), shot);
  assert.equal((await f.runtime('attachment').list()).length, 0);
  assert.equal((await f.runtime('toolImage').list()).length, 0);
  assert.equal(await f.runtime('attachment').has('file_0123456789abcdef'), false);
});
test('sealed removal needs an explicit migration opt-in', async t => {
  const f = await fixture(t), runtime = f.runtime('attachment');
  const receipt = await runtime.seal({ id: 'file_0123456789abcdef', kind: 'original', logicalName: 'a.bin', mime: 'application/octet-stream', data: Buffer.from('x') });
  assert.equal(receipt.id, 'file_0123456789abcdef');
  await assert.rejects(runtime.retireSealed('file_0123456789abcdef'), /sealed_removal_forbidden/);
});
test('owner unseals an attachment above the default reader limit and leaves no empty tree', async t => {
  const f = await fixture(t), big = Buffer.alloc(9 * 1024 * 1024, 7);
  await f.put('file_0123456789abcdef/big.bin', big);
  await f.owner().sealAll();
  const report = await f.owner().unsealAll();
  assert.equal(report.restored[0].size, big.length);
  assert.deepEqual(await fsp.readFile(path.join(f.root, 'file_0123456789abcdef', 'big.bin')), big);
  assert.equal((await f.owner().enroll()).sealed, 0);
  assert.equal((await f.runtime('attachment').list()).length, 0);
});
test('owner enroll reports already sealed directories and ignores catalogs', async t => {
  const f = await fixture(t);
  await f.put('_catalog-attachments-v1.json', Buffer.from('{}'));
  await fsp.mkdir(path.join(f.root, 'a'.repeat(32), 'b'.repeat(32)), { recursive: true });
  const report = await f.owner().enroll();
  assert.equal(report.sealed, 1);
  assert.equal(report.files.length, 0);
  assert.equal(report.unsupported.length, 0);
});
