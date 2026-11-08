'use strict';
// 「渲染 + 遮盖」的第一块:M4 里 PDF/Office 页面渲染出来的像素是内存里的 Buffer,`prepare` 原来只吃
// uploads 里带 dev/ino 文件身份的 source。这里给渲染件它自己的证明,并钉住四条:
//   ① 复制语义(调用方之后改自己的 Buffer 不影响已登记的来源);
//   ② 内容由 sha256 钉住,改了就 assert 失败;
//   ③ 作用域由会话 id 派生(与附件 source 同一个 scope 形状);
//   ④ 释放即抹零、释放后再用 fail-closed(不许拿一份已经抹掉的内存当图发出去)。
// 最后再把这份来源真的喂给 MediaImageService.prepare → delivery,证明它不是"形状对上"而是能跑完整条链。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rendered-source-'));
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(tempRoot, 'home'), path.join(tempRoot, 'data')));
const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = ['01i-privacy-rules.js', '01h-privacy-core.js', '13ba-media-image-contract.js', '13bd-media-image-service.js']
  .map(name => fs.readFileSync(path.join(sourceRoot, name), 'utf8')).join('\n');
const media = vm.runInNewContext(sources + ';({MediaImageContract,MediaImageService});', { require, Buffer, Headers, setTimeout, clearTimeout });
const SESSION = 'sess_rendered', PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4088, 0x5a)]);

test('渲染来源:复制语义 + sha256 钉住内容 + 会话派生作用域', async () => {
  const callerBytes = Buffer.from(PNG);
  const source = media.MediaImageService.renderedSource({ id: 'page-1', name: 'page-1.png', bytes: callerBytes, sessionId: SESSION });
  assert.equal(source.snapshot.hash, sha(PNG));
  assert.equal(source.snapshot.scope, sha(SESSION).slice(0, 32));
  assert.equal(source.snapshot.revision, source.snapshot.hash);
  assert.equal(source.assert(), true);
  callerBytes.fill(0x00);                                   // 调用方改自己的 Buffer
  assert.equal(source.snapshot.bytes.equals(PNG), true, '来源自己持有一份,不受调用方改动影响');
  assert.equal(source.assert(), true);
  await source.release();
  assert.deepEqual([...new Set(source.snapshot.bytes)], [0], 'release 就地抹零');
  assert.throws(() => source.assert(), error => error.code === 'privacy.image_source_changed');
  await source.release();                                   // 幂等
});

test('渲染来源:作用域被撤 / 输入非法都 fail-closed', async () => {
  let revoked = false;
  const owner = { assert() { if (revoked) throw Object.assign(Error('scope'), { code: 'privacy.image_scope_changed' }); return true; } };
  const source = media.MediaImageService.renderedSource({ id: 'page-2', name: 'page-2.png', bytes: PNG, sessionId: SESSION, scopeOwner: owner });
  assert.equal(source.assert(), true);
  revoked = true;
  assert.throws(() => source.assert(), error => error.code === 'privacy.image_scope_changed');
  for (const bad of [{}, { id: 'x' }, { id: 'x', name: 'n', bytes: Buffer.alloc(0), sessionId: SESSION },
    { id: 'x', name: 'n', bytes: Buffer.alloc(4 * 1024 * 1024 + 1), sessionId: SESSION }, { id: 'x', name: 'n', bytes: PNG, sessionId: '' }]) {
    assert.throws(() => media.MediaImageService.renderedSource(bad), error => error.code === 'privacy.image_source_invalid', JSON.stringify(Object.keys(bad)));
  }
});

test('a page remains bound to its local source revision and parent stop revokes the child scope', async () => {
  const childScope = SESSION + ':worker', service = media.MediaImageService.create({ context: () => ({ scopeId: childScope }), storeFor() {} });
  const scope = service.beginScope(childScope), revision = sha('original document identity');
  let changed = false;
  const parent = { revision, assert() { if (changed) throw Object.assign(Error('source changed'), { code: 'source_changed' }); } };
  const source = media.MediaImageService.renderedSource({ id: 'page', name: 'page.png', bytes: PNG, sessionId: childScope, scopeOwner: scope, parent });
  try {
    assert.equal(source.snapshot.revision, sha(JSON.stringify([revision, sha(PNG)])));
    assert.equal(source.snapshot.scope, sha(childScope).slice(0, 32));
    assert.equal(source.assert(), true);
    changed = true;
    assert.throws(() => source.assert(), { code: 'source_changed' });
    changed = false;
    await service.revokeScope(SESSION);
    assert.throws(() => source.assert(), { code: 'privacy.image_revoked' });
  } finally { await source.release(); scope.release(); }
});

test('渲染来源能真的跑完 prepare → delivery(不是只形状对上)', async () => {
  const stored = new Map();
  const recipient = media.MediaImageService.recipientHash('https://api.example.invalid/v1/chat/completions', { authorization: 'Bearer synthetic' });
  const service = media.MediaImageService.create({ now: () => Date.now(), context: () => ({ scopeId: SESSION }),
    storeFor: async ({ authority }) => ({
      async put(value) { const captured = await authority.capture(value.sourceId); authority.assert(captured); stored.set('mimg_r', { ...value, bytes: Buffer.from(value.bytes), captured }); return { id: 'mimg_r' }; },
      async read() { const value = stored.get('mimg_r'), copy = Buffer.from(value.bytes);
        return { bytes: copy, manifest: value.manifest, assert: () => { authority.assert(value.captured); return sha(copy) === value.manifest.payloadHash; }, release() { copy.fill(0); } }; },
      async remove() { stored.delete('mimg_r'); return true; },
    }) });
  const config = { personal: true, knownSecrets: [], rules: [] };
  const policy = { config, hash: sha(JSON.stringify(config)), rulesHash: sha('rules'), revision: 'p1', assert: () => true };
  const snapshot = { hash: sha('processor'), version: 'v1' };
  const processor = { capture: () => snapshot, assert: () => true,
    start() {
      const frame = { rgba: Buffer.alloc(12 * 12 * 4, 255), width: 12, height: 12, sourceHash: sha(PNG), processorHash: snapshot.hash,
        frames: 1, orientationApplied: true, ocrComplete: true, codesComplete: true,
        transform: { width: 12, height: 12, orientation: 1 }, words: [{ text: 'secret@example.test', line: 0, box: [1, 1, 5, 5] }], codes: [] };
      return { promise: Promise.resolve(frame), finish: () => ({ closed: true, helperMayStillRun: false, ownershipRetained: false }) };
    } };
  const source = media.MediaImageService.renderedSource({ id: 'page-3', name: 'page-3.png', bytes: PNG, sessionId: SESSION });
  const prepared = await service.prepare({ sessionId: SESSION, source, policy, processor, recipient });
  assert.match(prepared.reference, /^https:\/\/ruyi\.invalid\/protected-image\/[a-f0-9]{32}$/);
  const borrowed = await service.borrow(prepared.id);
  const previewHash = sha(borrowed.bytes);
  borrowed.release();
  const batch = await service.delivery({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: prepared.reference } }] }] }, recipient);
  try {
    batch.assert();
    const url = batch.body.messages[0].content[0].image_url.url;
    assert.equal(sha(Buffer.from(url.split(',')[1], 'base64')), previewHash, '交付的必须是同一份受保护图片');
  } finally { batch.release(); }
  await service.remove(prepared.id);
});

test('渲染来源:内容被改 / 换一个会话准备 都 fail-closed', async () => {
  // ① 内容被改:sha256 钉住的那条判定。构造器自己复制字节,所以只有拿到 snapshot.bytes(同一份 Buffer)
  //    的人才能改到它 —— 而这正是"某个调用方拿到的就是这份内存"的情形,必须检出来。
  const source = media.MediaImageService.renderedSource({ id: 'page-4', name: 'page-4.png', bytes: PNG, sessionId: SESSION });
  source.snapshot.bytes[0] ^= 1;
  assert.throws(() => source.assert(), error => error.code === 'privacy.image_source_changed',
    '内容被改过就必须 fail-closed(否则像素可以被替换后照样发出去)');

  // ② 换来路不明的会话准备:A 会话造的来源不能在 B 会话下 prepare 成功(记录会落进 A 的命名空间)。
  const stored = new Map();
  const service = media.MediaImageService.create({ now: () => Date.now(), context: () => ({ scopeId: 'sess_other' }),
    storeFor: async ({ authority }) => ({
      async put(value) { const captured = await authority.capture(value.sourceId); authority.assert(captured); stored.set('mimg_s', { ...value, bytes: Buffer.from(value.bytes), captured }); return { id: 'mimg_s' }; },
      async read() { const value = stored.get('mimg_s'), copy = Buffer.from(value.bytes);
        return { bytes: copy, manifest: value.manifest, assert: () => authority.assert(value.captured), release() { copy.fill(0); } }; },
      async remove() { stored.delete('mimg_s'); return true; },
    }) });
  const config = { personal: true, knownSecrets: [], rules: [] };
  const policy = { config, hash: sha(JSON.stringify(config)), rulesHash: sha('rules'), revision: 'p1', assert: () => true };
  const processor = { capture: () => ({ hash: sha('p'), version: 'v1' }), assert: () => true };
  const recipient = media.MediaImageService.recipientHash('https://api.example.invalid/v1/chat/completions', {});
  const other = media.MediaImageService.renderedSource({ id: 'page-5', name: 'page-5.png', bytes: PNG, sessionId: SESSION });
  await assert.rejects(service.prepare({ sessionId: 'sess_other', source: other, policy, processor, recipient }),
    error => error.code === 'privacy.image_source_scope_mismatch');
});

after(() => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ } });
