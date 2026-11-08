'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/11d-media-inspection.js'), 'utf8');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2j0EAAAAASUVORK5CYII=';
const load = runLocalMediaHelper => new Function('require', 'MediaImageHooks', source + '\nreturn MediaInspection;')(
  require, { runLocalMediaHelper });
const media = Buffer.from('synthetic source bytes');

test('video sampling sends one bounded byte snapshot and fixed local decoder options', async () => {
  const api = load(async (helper, argv, input, limits) => {
    assert.equal(helper, 'native-video-read.py');
    assert.deepEqual(argv, ['mov', '[500,1250,2000]']);
    assert.equal(input, media);
    assert.equal(limits.timeoutMs, 30000);
    assert.equal(limits.maxBytes, 18 * 1024 * 1024);
    assert.equal(limits.env.OPENCV_FFMPEG_CAPTURE_OPTIONS,
      'protocol_whitelist;ruyi-no-external-io|format_whitelist;mov|input_format;mov|max_pixels;8294400|enable_drefs;0|use_absolute_path;0');
    return { ok: true, frames: [{ requestedMs: 500, timestampMs: 625, png, title: 'raw metadata' },
      { requestedMs: 1250, timestampMs: 1250, png }], audio: 'raw audio' };
  });
  const result = await api.videoFrames('C:\\temp\\private-video.MP4', { startSeconds: 0.5, intervalSeconds: 0.75 }, undefined, media);
  assert.deepEqual(result.coverage, { requestedSeconds: [0.5, 1.25, 2], sampledSeconds: [0.625, 1.25], missedSeconds: [2],
    fullVideo: false, audioIncluded: false, subtitlesIncluded: false, containerMetadataIncluded: false });
  assert.deepEqual(result.images, [{ name: 'frame-1.png', mimeType: 'image/png', data: png },
    { name: 'frame-2.png', mimeType: 'image/png', data: png }]);
  assert.doesNotMatch(JSON.stringify(result), /private-video|raw metadata|raw audio|synthetic source bytes/);
});

test('video argument, source, and cancellation failures happen before starting the decoder', async () => {
  const api = load(() => assert.fail('decoder must not run'));
  assert.equal(api.isVideoPath('clip.WEBM'), true);
  assert.equal(api.isVideoPath('clip.m3u8'), false);
  assert.equal((await api.videoFrames('clip.m3u8', {}, undefined, media)).code, 'video_format_unsupported');
  assert.equal((await api.videoFrames('clip.mp4', {}, undefined, Buffer.alloc(0))).code, 'video_source_invalid');
  for (const args of [{ startSeconds: -1 }, { frameCount: 5 }, { intervalSeconds: 0.01 }, { frameCount: '2' }]) {
    assert.equal((await api.videoFrames('clip.mp4', args, undefined, media)).code, 'video_options_invalid');
  }
  await assert.rejects(api.videoFrames('clip.mp4', {}, AbortSignal.abort(), media), { name: 'AbortError' });
});

test('video decoder output cannot supply invalid images or fabricated coverage', async () => {
  const good = { requestedMs: 0, timestampMs: 0, png };
  for (const frames of [[], [{ ...good, requestedMs: 7 }], [{ ...good, timestampMs: -1 }],
    [{ ...good, timestampMs: 6000 }], [{ ...good, png: media.toString('base64') }],
    [{ ...good, timestampMs: 1100 }, { ...good, requestedMs: 1000, timestampMs: 1100 }]]) {
    const api = load(async () => ({ ok: true, frames }));
    const result = await api.videoFrames('clip.avi', {}, undefined, media);
    assert.equal(result.code, 'video_decode_failed');
    assert.equal(Object.hasOwn(result, 'images'), false);
  }
  const api = load(async () => ({ ok: false, code: 'video_no_frames', error: 'local secret' }));
  const refusal = await api.videoFrames('clip.mp4', {}, undefined, media);
  assert.equal(refusal.code, 'video_no_frames');
  assert.doesNotMatch(refusal.error, /local secret/);
});

test('cancellation while the decoder runs suppresses its late stills', async () => {
  const controller = new AbortController();
  const api = load(async () => {
    controller.abort();
    return { ok: true, frames: [{ requestedMs: 0, timestampMs: 0, png }] };
  });
  await assert.rejects(api.videoFrames('clip.mp4', {}, controller.signal, media), { name: 'AbortError' });
});
