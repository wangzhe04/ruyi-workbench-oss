'use strict';
// Native file_read image delivery through the actual turn and model boundary.
// Default: missing-runtime and admission refusals. --full-components: the pinned
// Windows runtime performs real decoding/OCR and supplies the final PNG.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inflateSync } = require('node:zlib');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { releaseEnvironment } = require('./lib/release-checks');

const runner = createRunner('NATIVE PROTECTED IMAGE');
const full = process.argv.includes('--full-components');
const ordinaryPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const width = 512, height = 192, keyword = 'SECRET';
const wordRegion = { left: 72, top: 64, right: 352, bottom: 120 };
const imageParts = body => body.messages.flatMap(message => Array.isArray(message.content)
  ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : []);
function bitmap() {
  // A fixed 5x7 block alphabet makes the source independent of installed fonts
  // and renderers. The 8x scale gives Windows OCR a high-contrast 56-pixel word.
  const glyphs = {
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  };
  const bytes = Buffer.alloc(54 + width * height * 3);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  bytes.fill(255, 54);
  for (const [index, letter] of [...keyword].entries()) {
    for (const [row, cells] of glyphs[letter].entries()) for (const [column, ink] of [...cells].entries()) {
      if (ink !== '1') continue;
      for (let y = row * 8; y < (row + 1) * 8; y++) for (let x = column * 8; x < (column + 1) * 8; x++) {
        const offset = 54 + ((height - 1 - (wordRegion.top + y)) * width + wordRegion.left + index * 48 + x) * 3;
        bytes.fill(0, offset, offset + 3);
      }
    }
  }
  return Buffer.concat([bytes, Buffer.from('UNEXPOSED ORIGINAL IMAGE METADATA')]);
}
function checkPixels(url) {
  assert.match(url, /^data:image\/png;base64,/);
  const png = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), height);
  assert.equal(png[24], 8); assert.equal(png[25], 2);
  const chunks = [];
  for (let at = 8; at + 12 <= png.length;) {
    const count = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + count));
    at += count + 12;
  }
  const stride = width * 3 + 1;
  const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: height * stride });
  const rgb = (x, y) => [...pixels.subarray(y * stride + 1 + x * 3, y * stride + 1 + x * 3 + 3)];
  assert.deepEqual(rgb(16, 16), [255, 255, 255], 'public upper background remains white');
  assert.deepEqual(rgb(480, 160), [255, 255, 255], 'public lower background remains white');
  for (let y = wordRegion.top; y < wordRegion.bottom; y++) for (let x = wordRegion.left; x < wordRegion.right; x++) {
    assert.deepEqual(rgb(x, y), [0, 0, 0], `sensitive word rectangle is opaque at ${x},${y}`);
  }
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--full-components'), 'unknown option');
  if (full) {
    assert.equal(process.platform, 'win32');
    for (const key of ['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT']) assert.ok(path.isAbsolute(process.env[key] || ''), key);
    assert.ok(process.env.RUYI_MEDIA_OCR_LANGUAGE);
  }
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'ruyi-native-protected-image-'));
  let app, fake, failure;
  try {
    const data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
    await fs.mkdir(data); await fs.mkdir(workspace);
    Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), data));
    process.env.RUYI_MEDIA_RESOURCE_PROFILE = 'legacy-full-4987-v1';
    if (!full) {
      process.env.RUYI_MEDIA_RUNTIME_ROOT = path.join(root, 'missing-runtime');
      process.env.RUYI_MEDIA_SOURCES_ROOT = path.join(root, 'missing-source');
    }
    const original = bitmap();
    await fs.writeFile(path.join(workspace, 'screenshot.bmp'), original);
    await fs.writeFile(path.join(workspace, 'ordinary.png'), ordinaryPng);
    await fs.writeFile(path.join(workspace, 'large.bmp'), Buffer.alloc(4 * 1024 * 1024 + 1, 0x42));
    await fs.writeFile(path.join(workspace, 'followup.txt'), 'Continue with text only.');
    let plan, iteration = 0;
    fake = await startFakeProvider({ handler(request) {
      if (!request.stream) return textFrames('Synthetic answer.');
      if (++iteration === 1) return toolCallFrames('file_read', plan.args, 'native_image');
      if (iteration === 2 && full && !plan.refusal) return toolCallFrames('file_read', { path: 'followup.txt' }, 'after_image');
      return textFrames('Synthetic answer.');
    } });
    const provider = { id: 'fixture', type: 'openai-compat', baseUrl: fake.url, model: 'fixture', vision: true };
    await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, privacyModeV1: 'enhanced',
      credentialEncryptionV1: true, workDataEncryptionV1: false, defaultWorkspace: workspace,
      privacyRulesV1: [{ id: 'native-image-fixture', kind: 'literal', value: keyword, category: 'INTERNAL' }],
      workspaces: [{ path: workspace, read: true, write: true, execute: false }], permissionMode: 'bypass',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false },
      stewardEnabledV1: false, toolLoadingMode: 'full', activeProvider: provider.id, providers: [provider] }));
    app = require('./lib/server-internals').loadServerInternals([
      'createSession', 'runSessionTurn', 'loadSession', 'mutateConfig', 'MediaImageHooks',
    ]);
    for (plan of [
      { label: 'default screenshot read', args: { path: 'screenshot.bmp' } },
      { label: 'explicit image read', args: { path: 'screenshot.bmp', as: 'image' } },
      { label: 'text request', args: { path: 'screenshot.bmp', as: 'text' }, refusal: 'not_text' },
      { label: 'omitted pixels', args: { path: 'screenshot.bmp', includeImages: false }, refusal: 'not_text' },
      { label: 'image size cap', args: { path: 'large.bmp', as: 'image' }, refusal: 'file_too_large' },
      { label: 'non-vision model', args: { path: 'screenshot.bmp', as: 'image' }, vision: false, refusal: 'privacy.media_not_supported' },
    ]) {
      await app.mutateConfig(config => { config.providers[0].vision = plan.vision !== false; });
      const session = await app.createSession({ title: plan.label, cwd: workspace });
      const events = [], before = fake.requests.length; iteration = 0;
      const { result } = await app.runSessionTurn({ sessionId: session.id, cwd: workspace, source: 'http',
        message: 'Read the requested public image file.', onEvent: event => events.push(event) });
      assert.equal(result.ok, true, plan.label + ': turn completes');
      const captured = fake.requests.slice(before).filter(request => request.stream).map(request => JSON.parse(request.raw));
      const receipt = JSON.parse(captured[1].messages.find(message => message.role === 'tool' && message.tool_call_id === 'native_image').content);
      const urls = imageParts(captured[1]);
      if (plan.refusal || !full) {
        assert.equal(receipt.ok, false);
        const missing = process.platform === 'win32' ? 'privacy.image_processor_dependency_failed' : 'privacy.image_processor_platform_unsupported';
        assert.equal(receipt.code, plan.refusal || missing, plan.label + ': refusal');
        assert.deepEqual(urls, []);
        runner.ok(true, plan.label + ': refusal supplies no original or derived pixels');
      } else {
        assert.equal(receipt.ok, true); assert.equal(receipt.mode, 'image');
        assert.equal(urls.length, 1); checkPixels(urls[0]);
        assert.equal(captured.length, 3); assert.deepEqual(imageParts(captured[2]), []);
        assert.ok(!JSON.stringify(receipt).includes('screenshot.bmp'));
        runner.ok(true, plan.label + ': actual file_read supplies one processed PNG only to the immediate request');
      }
      const saved = JSON.stringify(await app.loadSession(session.id)), projected = JSON.stringify(events);
      for (const serialized of [JSON.stringify(captured), saved, projected]) {
        assert.ok(!serialized.includes(original.toString('base64')));
        assert.ok(!serialized.includes('UNEXPOSED ORIGINAL IMAGE METADATA'));
        assert.ok(!serialized.includes(keyword));
        assert.ok(!serialized.includes('https://ruyi.invalid/protected-image/'));
      }
      assert.ok(!saved.includes('data:image/png;base64,') && !projected.includes('data:image/png;base64,'));
    }
    await app.mutateConfig(config => { config.privacyModeV1 = 'off'; config.providers[0].vision = true; });
    plan = { args: { path: 'ordinary.png', as: 'image' }, refusal: true };
    iteration = 0;
    const before = fake.requests.length;
    const ordinary = await app.createSession({ title: 'Ordinary image read', cwd: workspace });
    const offResult = await app.runSessionTurn({ sessionId: ordinary.id, cwd: workspace, source: 'http',
      message: 'Read the public PNG.', onEvent() {} });
    assert.equal(offResult.result.ok, true);
    const offWire = fake.requests.slice(before).filter(request => request.stream).map(request => JSON.parse(request.raw));
    assert.deepEqual(imageParts(offWire[1]), ['data:image/png;base64,' + ordinaryPng.toString('base64')]);
    runner.ok(true, 'privacy OFF preserves the original native image bytes');
    assert.deepEqual(await fs.readFile(path.join(workspace, 'screenshot.bmp')), original);
    runner.ok(true, 'native protected reads preserve the screenshot original');
  } catch (error) { failure = error; throw error; }
  finally {
    await fake?.close();
    if (failure || app?.MediaImageHooks.helperMayStillRun()) console.log('Retained synthetic fixture at ' + root);
    else {
      assert.equal(path.dirname(await fs.realpath(root)), temp);
      assert.ok(path.basename(root).startsWith('ruyi-native-protected-image-'));
      await fs.rm(root, { recursive: true });
    }
  }
}
main().catch(error => runner.fail(error.stack || String(error))).finally(() => runner.done());
