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
const { constBlock } = require('../lib/source-slice');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-media-wire-'));
const dataRoot = path.join(tempRoot, 'data'); fs.mkdirSync(dataRoot, { recursive: true });
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(tempRoot, 'home'), dataRoot));
const wireApi = require('../lib/server-internals').loadServerInternals(['providerWireProtocol']);

const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sources = ['01i-privacy-rules.js', '01h-privacy-core.js', '13ba-media-image-contract.js', '13bd-media-image-service.js']
  .map(name => fs.readFileSync(path.join(sourceRoot, name), 'utf8')).join('\n');
const media = vm.runInNewContext(sources + ';({MediaImageContract,MediaImageService});', { require, Buffer, Headers, setTimeout, clearTimeout });
const toolMediaSource = constBlock(fs.readFileSync(path.join(sourceRoot, '10-context-governance.js'), 'utf8'), 'ToolPreparedMedia');

test('unprotected video reads receive the native turn cancellation signal without gaining a protected route', async () => {
  const bridge = vm.runInNewContext(toolMediaSource + '\nToolPreparedMedia;', { PrivacyGateway: { active: () => null } });
  const provider = { vision: true }, controller = new AbortController(), sessionId = 'video-off', turnSeq = 1;
  const turn = bridge.create({ provider, sessionId, turnSeq, signal: controller.signal, endpoint: () => RECIPIENT_URL });
  const ctx = turn.bind({ provider, sessionId, turnSeq });
  assert.equal(bridge.route(ctx), null);
  assert.equal(bridge.signal(ctx), controller.signal);
  controller.abort();
  assert.equal(bridge.signal(ctx).aborted, true);
  await turn.close();
});
function toolMediaFixture(provider, url = RECIPIENT_URL) {
  let scope = { scopeId: 'sess_wire' };
  const bridge = vm.runInNewContext(toolMediaSource + '\nToolPreparedMedia;', { PrivacyGateway: { active: () => scope } });
  const stop = new AbortController(), model = 'model-override', headers = { authorization: 'Bearer synthetic' };
  const ctx = { provider, sessionId: 'sess_wire', turnSeq: 5, signal: null };
  const create = () => bridge.create({ provider, model, sessionId: ctx.sessionId, turnSeq: ctx.turnSeq, endpoint: () => url, headers, signal: stop.signal });
  return { bridge, ctx, create, stop, headers, model, changeScope: () => { scope = { scopeId: 'sess_wire' }; } };
}

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
    // 隐私层的入口是 projectPart(03a 的 projectMediaPart):编码后的形状必须仍被它认出来,
    // 否则网关会以 media_not_supported fail-closed —— 三种协议一个都不能例外。
    const pointer = apiStyle === 'responses' ? '/input/0/content/1' : '/messages/0/content/1';
    assert.ok(f.service.projectPart(encodedShape, { scopeId: 'sess_wire', pointer }),
      apiStyle + ' 编码后的引用形状必须能过 projectPart(否则网关只会拒绝,图永远发不出去)');

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

test('native result capability appends an ephemeral visual user message after paired tool results on all three wires', async () => {
  for (const [apiStyle, configured] of Object.entries(PROVIDERS)) {
    const provider = { ...configured, vision: true }, f = fixture(), host = toolMediaFixture(provider);
    const prepared = await f.prepare();
    const loop = host.create(), unboundLoop = host.create();
    const result = { ok: true, content: 'Page 1 was sampled.' }, encodedResult = JSON.stringify(result);
    assert.equal(host.bridge.available(host.ctx), false);
    assert.equal(loop.bind(host.ctx), host.ctx);
    assert.equal(host.bridge.available({ ...host.ctx }), false, 'a cloned tool context has no host grant');
    assert.equal(host.bridge.route(host.ctx).model, host.model);
    assert.equal(host.bridge.route(host.ctx).headers, host.headers);
    assert.equal(host.bridge.signal(host.ctx), host.stop.signal);
    const returned = await host.bridge.register(host.ctx, result, { references: [prepared], release: () => f.service.remove(prepared.id) });
    assert.equal(returned, result);
    assert.equal(JSON.stringify(result), encodedResult);
    const promoted = loop.transfer(result, { ...result, proxyNote: 'Call file_read directly next time.' });
    const toolReply = { role: 'tool', tool_call_id: 'call_page', content: encodedResult };
    unboundLoop.queue(promoted, toolReply);
    assert.equal(unboundLoop.endpoint(), undefined, 'another loop with the same session and scope cannot consume a receipt');
    loop.queue({ ...promoted, references: [prepared] }, toolReply);
    assert.equal(loop.endpoint(), undefined, 'a forged or reconstructed result does not carry a receipt');
    const history = [{ role: 'user', content: 'Inspect this page.' },
      { role: 'assistant', tool_calls: [{ id: 'call_page', type: 'function', function: { name: 'file_read', arguments: '{}' } }] },
      toolReply];
    loop.queue(promoted, toolReply);
    await loop.finishBatch(true);
    assert.equal(loop.endpoint(), RECIPIENT_URL);
    const messages = [...history];
    loop.append(messages);
    assert.equal(messages.at(-1).role, 'user');
    assert.equal(history.at(-1).role, 'tool');
    assert.ok(!JSON.stringify(history).includes(prepared.reference), 'persistable history is text only');

    const wire = wireApi.providerWireProtocol(provider);
    const encoded = wire.encodeMessages({ model: host.model, stream: true, provider, hasTools: true, messages });
    const rows = encoded.input || encoded.messages;
    const visualRow = rows.find(row => row.role === 'user' && Array.isArray(row.content)
      && row.content.some(part => ['image_url', 'input_image', 'image'].includes(part.type)));
    assert.ok(visualRow, apiStyle + ' user visual row');
    const pairedResultIndex = rows.findIndex(row => row.role === 'tool' || row.type === 'function_call_output');
    if (apiStyle === 'anthropic') assert.equal(visualRow.content[0].type, 'tool_result', 'Anthropic tool_result remains first in the merged user message');
    else assert.ok(pairedResultIndex >= 0 && rows.indexOf(visualRow) > pairedResultIndex, apiStyle + ' visual is after the tool result');
    const batch = await f.service.delivery(encoded, f.recipient);
    try {
      batch.assert();
      const posted = JSON.stringify(batch.body);
      assert.ok(!posted.includes(prepared.reference));
      assert.ok(posted.includes(f.stored.get('mimg_wire').bytes.toString('base64')), apiStyle + ' actual protected bytes');
    } finally { batch.release(); }
    await loop.clear();
    loop.queue(promoted, toolReply);
    assert.equal(loop.endpoint(), undefined, 'the same successful result cannot replay visual media');
    assert.equal(f.stored.size, 0, 'clearing the request releases the prepared artifact');
  }
});

test('refused result, cancelled batch, and replaced scope cannot send prepared media', async () => {
  const host = toolMediaFixture({ vision: true });
  const loop = host.create(), releases = [];
  const prepared = tag => ({ references: [{ id: 'a'.repeat(32), reference: 'https://ruyi.invalid/protected-image/' + 'a'.repeat(32) }],
    async release() { releases.push(tag); } });
  loop.bind(host.ctx);
  const withheld = await host.bridge.register(host.ctx, { ok: true }, prepared('withheld'));
  loop.queue(withheld, { role: 'tool', content: '{"ok":false,"code":"privacy.result_unavailable"}' });
  await loop.finishBatch(true);
  assert.deepEqual(releases, ['withheld']);
  const cancelled = await host.bridge.register(host.ctx, { ok: true }, prepared('cancelled'));
  loop.queue(cancelled, { role: 'tool', content: '{"ok":true}' });
  await loop.finishBatch(false);
  assert.equal(loop.endpoint(), undefined);
  assert.deepEqual(releases, ['withheld', 'cancelled']);
  const stale = await host.bridge.register(host.ctx, { ok: true }, prepared('stale'));
  const reply = { role: 'tool', content: '{"ok":true}' };
  loop.queue(stale, reply);
  assert.throws(() => loop.append([{ ...reply }]), { code: 'privacy.media_context_changed' }, 'a replaced history cannot inherit the visual sample');
  host.changeScope();
  assert.throws(() => loop.append([]), { code: 'privacy.media_route_unavailable' });
  await assert.rejects(host.bridge.register(host.ctx, { ok: true }, prepared('late')), { code: 'privacy.media_route_unavailable' });
  await loop.close();
  assert.deepEqual(releases, ['withheld', 'cancelled', 'late', 'stale']);

  const text = toolMediaFixture({ vision: false });
  text.create().bind(text.ctx);
  assert.equal(text.bridge.available(text.ctx), false);
  assert.equal(text.bridge.signal(text.ctx), text.stop.signal, 'protected text can still be cancelled without a vision provider');
  text.stop.abort();
  assert.equal(text.bridge.signal(text.ctx).aborted, true);
});

test('a newly queued instruction retires an unfetched visual and continues with text only', async () => {
  const host = toolMediaFixture({ vision: true }), loop = host.create();
  const result = { ok: true }, reply = { role: 'tool', content: JSON.stringify(result) };
  const id = 'a'.repeat(32), reference = 'https://ruyi.invalid/protected-image/' + id;
  const events = [];
  let inputPending = false;
  loop.bind(host.ctx);
  await host.bridge.register(host.ctx, result, { references: [{ id, reference }], async release() { events.push('release'); } });
  loop.queue(result, reply);
  await loop.finishBatch(true);
  const value = await loop.send(async assertRequest => {
    const messages = [reply]; loop.append(messages);
    if (assertRequest) {
      assert.ok(JSON.stringify(messages).includes(reference));
      await Promise.resolve();
      inputPending = true;
      assertRequest();
      assert.fail('the original request must never reach fetch');
    }
    assert.deepEqual(messages, [reply]);
    events.push('text-only');
    return 'done';
  }, () => inputPending, () => { events.push('drain'); inputPending = false; });
  assert.equal(value, 'done');
  assert.deepEqual(events, ['release', 'drain', 'text-only']);
});

after(() => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best-effort */ } });
