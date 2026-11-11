'use strict';
// Source composition: genuine PrivacyCore detector and image pipeline with a
// synthetic decoded frame. No native OCR, files, model transport or socket is run.
require('./lib/media-artifact-test-guard');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { core, fixture, png, pixel } = require('./lib/media-image-contract-fixture');
const t = createRunner('MEDIA IMAGE OCR BUDGET SOURCE'), { ok } = t;

async function exercise(mode) {
  const count = mode === 'normal' ? 4000 : 512, controller = new AbortController();
  let frameBytes, reads = 0, hitCount = 0;
  const f = fixture({ changeFrame(frame) {
    frameBytes = frame.rgba;
    frame.words = Array.from({ length: count }, () => ({ text: 'fixture@example.test', line: 0, box: [4, 4, 8, 8] }));
    frame.codes = [];
  } });
  const original = Buffer.from(f.original), detector = core.createDetector({ personal: true, rules: [] });
  f.policyOwner.prepareDetector = async () => ({ detect(text) {
    const hits = detector.detect(text); hitCount = hits.length;
    return hits.map(hit => ({ ...hit, get start() {
      reads++;
      if (reads === 64 && mode === 'cancel') controller.abort();
      if (reads === 64 && mode === 'deadline') f.setTime(61001);
      return hit.start;
    } }));
  } });
  if (mode === 'normal') {
    const token = await f.pipeline.prepare({ signal: controller.signal });
    const borrowed = f.pipeline.borrow(token);
    try {
      const image = png(borrowed.bytes);
      assert.deepEqual(pixel(image, 6, 6), [0, 0, 0]);
      assert.deepEqual(pixel(image, 16, 14), [200, 200, 200]);
      assert.equal(hitCount, count);
      assert.ok(reads <= count * 4, `bounded interval reads: ${reads}`);
      ok(true, '4000 real detected OCR intervals preserve masked and public pixels with bounded selection');
    } finally { borrowed.release(); f.pipeline.release(token); }
  } else {
    await assert.rejects(f.pipeline.prepare({ signal: controller.signal }), {
      code: mode === 'cancel' ? 'privacy.image_cancelled' : 'privacy.image_expired',
    });
    assert.equal(hitCount, count);
    assert.ok(reads <= 128, `interruption stops interval traversal: ${reads}`);
    assert.equal(f.calls.at(-1).finish.failed, true);
    ok(true, `${mode} during OCR interval mapping stops before publication and closes the processor job`);
  }
  assert.ok(frameBytes.every(byte => byte === 0));
  assert.ok(f.calls[0].source.every(byte => byte === 0));
  assert.deepEqual(f.original, original);
  ok(true, `${mode} releases decoded and processing buffers while preserving the original source`);
}

(async () => {
  for (const mode of ['cancel', 'deadline', 'normal']) await exercise(mode);
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done());
