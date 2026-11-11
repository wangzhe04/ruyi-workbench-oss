'use strict';
require('../lib/media-artifact-test-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionBlock } = require('../lib/source-slice');
const source = functionBlock(fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/12-tool-dispatch.js'), 'utf8'), 'readNativeMedia');
assert.ok(source.length > 1000);

function fixture({ vision = true, changeAfterRead = false, cancelled = false, bytes = Buffer.from('synthetic image snapshot') } = {}) {
  const controller = new AbortController(), route = { signal: controller.signal };
  let reads = 0, registrations = 0, parentChecks = 0, pages, changed = false;
  const coded = code => Object.assign(Error(code), { code });
  const parent = { assert() { parentChecks++; if (changed) throw coded('privacy.image_source_changed'); } };
  const hooks = {
    async readLocalMediaFile(_file, signal, work) {
      reads++; assert.equal(signal, controller.signal);
      try { const result = await work(bytes, parent); parent.assert(); return result; }
      finally { bytes.fill(0); }
    },
    async prepareToolVisual(received, produce) {
      assert.equal(received, route);
      const produced = await produce(); pages = produced.pages;
      if (!produced.result.ok) return produced;
      try {
        assert.equal(pages.length, 1); assert.equal(pages[0].name, 'image.png');
        if (changeAfterRead) changed = true;
        if (cancelled) controller.abort();
        if (controller.signal.aborted) throw coded('privacy.image_cancelled');
        produced.source.assert();
        return { result: produced.result, prepared: { references: ['host-issued-reference'] } };
      } finally { for (const page of pages) page.bytes.fill(0); }
    },
  };
  const call = vm.runInNewContext(source + '\nreadNativeMedia;', {
    Buffer, path, externalRoot: () => '/synthetic-app', MediaImageHooks: hooks,
    PrivacyGateway: { captureMediaPolicy: () => ({ assert: () => true }) },
    privacyInspectLocalPath: async () => {}, privacyLocalIo: async (_file, _write, work) => work(),
    ToolPreparedMedia: { route: () => vision ? route : null,
      register: async (_ctx, result, prepared) => { registrations++; assert.equal(prepared.references[0], 'host-issued-reference'); return result; } },
  });
  return { call: args => call('/private/screenshot.bmp', 'image', args, {}, true),
    stats: () => ({ reads, registrations, parentChecks, pages }), bytes };
}

test('native image defaults to protected vision and strips source pixels from its tool result', async () => {
  const f = fixture(), result = await f.call({});
  assert.equal(result.ok, true); assert.equal(result.mode, 'image');
  assert.equal(result.images, undefined); assert.equal(result.path, undefined);
  assert.equal(JSON.stringify(result).includes('synthetic image snapshot'), false);
  assert.equal(f.stats().registrations, 1); assert.ok(f.stats().parentChecks >= 2);
  assert.ok(f.bytes.every(byte => byte === 0));
  assert.ok(f.stats().pages[0].bytes.every(byte => byte === 0));
});

test('non-vision and text-only requests refuse before reading original bytes', async () => {
  const noVision = fixture({ vision: false });
  assert.equal((await noVision.call({ as: 'image' })).code, 'privacy.media_not_supported');
  assert.equal(noVision.stats().reads, 0);
  for (const args of [{ as: 'text' }, { includeImages: false }]) {
    const f = fixture(); assert.equal((await f.call(args)).code, 'not_text'); assert.equal(f.stats().reads, 0);
  }
});

test('changed source or cancellation never registers a protected image receipt', async () => {
  for (const option of ['changeAfterRead', 'cancelled']) {
    const f = fixture({ [option]: true });
    assert.equal((await f.call({ as: 'image' })).code, 'privacy.image_' + (option === 'changeAfterRead' ? 'source_changed' : 'cancelled'));
    assert.equal(f.stats().registrations, 0);
    assert.ok(f.bytes.every(byte => byte === 0));
    for (const page of f.stats().pages || []) assert.ok(page.bytes.every(byte => byte === 0));
  }
});

test('native image cap rejects before pixel preparation', async () => {
  const f = fixture({ bytes: Buffer.alloc(4 * 1024 * 1024 + 1, 0x42) });
  assert.equal((await f.call({ as: 'image' })).code, 'file_too_large');
  assert.equal(f.stats().registrations, 0); assert.equal(f.stats().pages, undefined);
});
