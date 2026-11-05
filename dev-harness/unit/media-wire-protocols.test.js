'use strict';
// M4「preview=final wire」:同一个受保护图片,经【三个线协议的编码器】之后,必须还能被交付层认出来,
// 并且三种载荷里的字节完全相同 —— 否则某个协议会静默丢图(引用被编码器改成别的形状),或者把
// 原图/原件路径漏进请求体。
//
// 这里用的是真东西:04i 的 providerWireProtocol 编码器 + 13ba/13bd 的真 MediaImageService;
// 只有渲染处理器是合成夹具(不跑 OCR/原生组件,见 media-image-service.test.js 同一套夹具)。
require('../lib/media-artifact-test-guard');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-media-wire-'));
const dataRoot = path.join(tempRoot, 'data'); fs.mkdirSync(dataRoot, { recursive: true });
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(tempRoot, 'home'), dataRoot));
const wireApi = require('../lib/server-internals').loadServerInternals(['providerWireProtocol']);

const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = ['01i-privacy-rules.js', '01h-privacy-core.js', '13ba-media-image-contract.js', '13bd-media-image-service.js']
  .map(name => fs.readFileSync(path.join(sourceRoot, name), 'utf8')).join('\n');
const media = vm.runInNewContext(sources + ';({MediaImageContract,MediaImageService});', { require, Buffer, Headers, setTimeout, clearTimeout });

const RECIPIENT_URL = 'https://api.example.invalid/v1/chat/completions';
function fixture() {
  const time = Date.now(), sessionId = 'sess_wire', scope = sha(sessionId).slice(0, 32);
  const bytes = Buffer.alloc(64, 0x5a), config = { personal: true, knownSecrets: [], rules: [] };
  const source = { id: 'file_wire', name: 'private-name.png', snapshot: { bytes, hash: sha(bytes), revision: 'r1', scope },
    assert: () => true, release: async () => true };
  const policy = { config, hash: sha(JSON.stringify(config)), rulesHash: sha('rules'), revision: 'p1', assert: () => true };
  const snapshot = { hash: sha('processor'), version: 'v1' };
  const processor = { capture: () => snapshot, assert: () => true,
    start() {
      const frame = { rgba: Buffer.alloc(12 * 12 * 4, 255), width: 12, height: 12, sourceHash: source.snapshot.hash,
        processorHash: snapshot.hash, frames: 1, orientationApplied: true, ocrComplete: true, codesComplete: true,
        transform: { width: 12, height: 12, orientation: 1 }, words: [{ text: 'secret@example.test', line: 0, box: [1, 1, 5, 5] }], codes: [] };
      return { promise: Promise.resolve(frame), finish: () => ({ closed: true, helperMayStillRun: false, ownershipRetained: false }) };
    } };
  const stored = new Map();
  const service = media.MediaImageService.create({ now: () => time, context: () => ({ scopeId: sessionId }),
    storeFor: async ({ authority }) => ({
      async put(value) {
        const captured = await authority.capture(value.sourceId); authority.assert(captured);
        stored.set('mimg_wire', { ...value, bytes: Buffer.from(value.bytes), captured }); return { id: 'mimg_wire' };
      },
      async read() {
        const value = stored.get('mimg_wire'); const copy = Buffer.from(value.bytes);
        return { bytes: copy, manifest: value.manifest, assert: () => { authority.assert(value.captured); return sha(copy) === value.manifest.payloadHash; },
          release() { copy.fill(0); } };
      },
      async remove() { const value = stored.get('mimg_wire'); value?.bytes.fill(0); stored.delete('mimg_wire'); return true; },
    }) });
  return { service, source, policy, processor, recipient: media.MediaImageService.recipientHash(RECIPIENT_URL, { authorization: 'Bearer synthetic' }),
    prepare: () => service.prepare({ sessionId, source, policy, processor, recipient: media.MediaImageService.recipientHash(RECIPIENT_URL, { authorization: 'Bearer synthetic' }) }),
    stored };
}
const PROVIDERS = {
  chat: { apiStyle: 'chat', baseUrl: 'https://api.example.invalid', model: 'm' },
  responses: { apiStyle: 'responses', baseUrl: 'https://api.example.invalid', model: 'm' },
  anthropic: { apiStyle: 'anthropic', baseUrl: 'https://api.example.invalid', model: 'm' },
};
// 三种协议编码器吐出来的图片块形状(见 04i 与 04i-provider-anthropic.js 的 anthropicImageBlock)。
const SHAPE = {
  chat: body => body.messages[0].content[1],
  responses: body => body.input[0].content[1],
  anthropic: body => body.messages[0].content[1],
};
function base64In(part) {
  if (!part) return '';
  if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') return part.image_url.url.split(',')[1] || '';
  if (part.type === 'input_image' && typeof part.image_url === 'string') return part.image_url.split(',')[1] || '';
  if (part.type === 'image' && part.source && part.source.type === 'base64') return part.source.data || '';
  return '';
}

test('同一受保护图片经三个线协议编码后仍被交付层认出,且载荷字节一致', async () => {
  const f = fixture();
  const prepared = await f.prepare();
  const preview = await f.service.borrow(prepared.id);
  const previewHash = sha(preview.bytes);
  preview.release();
  const hashes = {};
  for (const [apiStyle, provider] of Object.entries(PROVIDERS)) {
    const wire = wireApi.providerWireProtocol(provider);
    const encoded = wire.encodeMessages({ model: 'm', stream: false, foldSystem: true, provider,
      messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: prepared.reference } }] }] });
    // 编码后引用还在 —— 否则交付层根本没机会替换(图片会被静默丢掉)。
    assert.ok(JSON.stringify(encoded).includes(prepared.reference), apiStyle + ' 编码后丢了受保护图片引用');
    const encodedShape = SHAPE[apiStyle](encoded);
    assert.equal(base64In(encodedShape), '', apiStyle + ' 编码阶段不许已经出现图片字节');

    const batch = await f.service.delivery(encoded, f.recipient);
    try {
      batch.assert();
      const delivered = base64In(SHAPE[apiStyle](batch.body));
      assert.ok(delivered, apiStyle + ' 交付后没拿到图片块');
      hashes[apiStyle] = sha(Buffer.from(delivered, 'base64'));
      assert.equal(Buffer.from(delivered, 'base64').length, preview.bytes.length, apiStyle + ' 交付的字节长度必须等于受保护图片');
      const posted = JSON.stringify(batch.body);
      assert.ok(!posted.includes(prepared.reference), apiStyle + ' 交付后不许再把引用原样发出去');
      // 每种协议的载荷形态不同:chat/responses 是 data URL,anthropic 是 media_type+base64。
      const markers = apiStyle === 'anthropic'
        ? (posted.match(/"media_type":"image\/png"/g) || []).length
        : (posted.match(/data:image\/png;base64,/g) || []).length;
      assert.equal(markers, 1, apiStyle + ' 请求体里只该有一张受保护图片');
    } finally { batch.release(); }
  }
  assert.deepEqual(hashes, { chat: previewHash, responses: previewHash, anthropic: previewHash });
  await f.service.remove(prepared.id);
});

test('未知/过期的受保护图片引用在交付时被拒,不会降级成一张别的图', async () => {
  const f = fixture();
  const prepared = await f.prepare();
  const stale = prepared.reference.slice(0, -32) + 'f'.repeat(32);
  const wire = wireApi.providerWireProtocol(PROVIDERS.chat);
  const encoded = wire.encodeMessages({ model: 'm', stream: false, foldSystem: true, provider: PROVIDERS.chat,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: stale } }] }] });
  await assert.rejects(f.service.delivery(encoded, f.recipient), error => error.code === 'privacy.image_expired');
  await f.service.remove(prepared.id);
});

after(() => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ } });
