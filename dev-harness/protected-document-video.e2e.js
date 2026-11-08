'use strict';
// Normal native tool and model-turn entry. The opt-in mode uses the frozen
// Windows Full runtime. All files and the model endpoint are synthetic.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inflateSync } = require('node:zlib');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, toolCallFrames, textFrames } = require('./lib/fake-openai-provider');
const { releaseEnvironment } = require('./lib/release-checks');
const { makeVideoFixture, audioCanary, metadataCanary } = require('./lib/media-video-fixture');
const { protectedPdf, protectedDocx } = require('./lib/protected-document-fixtures');

const runner = createRunner('PROTECTED DOCUMENT VIDEO');
const full = process.argv.slice(2).includes('--full-components');

function images(body) {
  return body.messages.filter(message => message.role === 'user' && Array.isArray(message.content))
    .flatMap(message => message.content.filter(item => item.type === 'image_url').map(item => item.image_url.url));
}

function hasOpaqueMask(url) {
  // The production derivative uses RGB PNG, filter zero, and no source chunks.
  // The fixture draws one ordinary word. Eight successive horizontal runs of
  // 64 black pixels establish a filled redaction rectangle, beyond any glyph.
  const png = Buffer.from(url.split(',')[1], 'base64');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), stride = 1 + width * 3;
  const chunks = [];
  for (let at = 8; at + 12 <= png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: stride * height });
  let rows = 0;
  for (let y = 0; y < height; y++) {
    let run = 0, longest = 0;
    for (let x = y * stride + 1; x < (y + 1) * stride; x += 3) {
      run = raw[x] === 0 && raw[x + 1] === 0 && raw[x + 2] === 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    rows = longest >= 64 ? rows + 1 : 0;
    if (rows >= 8) return true;
  }
  return false;
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--full-components'), 'unexpected flag');
  if (full) {
    assert.equal(process.platform, 'win32');
    for (const key of ['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT']) assert.ok(path.isAbsolute(process.env[key] || ''), key);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-protected-doc-video-'));
  let fake, app, failure;
  try {
    const data = path.join(root, 'data'), workspace = path.join(root, 'workspace');
    await Promise.all([fs.mkdir(data), fs.mkdir(workspace)]);
    Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), data));
    process.env.RUYI_MEDIA_RESOURCE_PROFILE = 'legacy-full-4987-v1';
    if (!full) {
      process.env.RUYI_MEDIA_RUNTIME_ROOT = path.join(root, 'missing-runtime');
      process.env.RUYI_MEDIA_SOURCES_ROOT = path.join(root, 'missing-sources');
    }
    const email = 'synthetic-customer@example.com';
    const keyword = 'CONFIDENTIAL';
    const video = makeVideoFixture(), pdf = protectedPdf({ text: keyword }), docx = protectedDocx({ text: 'Quarterly contact ' + email });
    const hidden = protectedDocx({ hidden: true });
    await Promise.all([
      fs.writeFile(path.join(workspace, 'sample.avi'), video), fs.writeFile(path.join(workspace, 'sample.pdf'), pdf),
      fs.writeFile(path.join(workspace, 'sample.docx'), docx), fs.writeFile(path.join(workspace, 'hidden.docx'), hidden),
      fs.writeFile(path.join(workspace, 'follow-up.txt'), 'Synthetic follow-up after the visual request.'),
    ]);
    let plan, iteration = 0;
    fake = await startFakeProvider({ handler(request) {
      if (!request.stream) return textFrames('Synthetic answer.');
      if (++iteration === 1) return toolCallFrames('file_read', plan.args, 'local_media');
      if (iteration === 2 && plan.visual && full) return toolCallFrames('file_read', { path: 'follow-up.txt' }, 'after_media');
      return textFrames('Synthetic answer.');
    } });
    const provider = { id: 'fixture', label: 'Fixture', type: 'openai-compat', baseUrl: fake.url, model: 'fake-model', vision: true };
    const config = { configSchema: 14, privacyModeV1: 'enhanced', credentialEncryptionV1: true,
      workDataEncryptionV1: false, defaultWorkspace: workspace, workspaces: [{ path: workspace, read: true, write: true, execute: false }],
      permissionMode: 'bypass', activeProvider: provider.id, providers: [provider], toolLoadingMode: 'full', stewardEnabledV1: false,
      privacyRulesV1: [{ id: 'fixture-mask', kind: 'literal', value: keyword, category: 'INTERNAL' }],
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, autodetect: false } };
    await fs.writeFile(path.join(data, 'config.json'), JSON.stringify(config));
    app = require('./lib/server-internals').loadServerInternals(['createSession', 'runSessionTurn', 'runSubAgentCore', 'readConfig', 'mutateConfig', 'loadSession', 'MediaImageHooks']);
    const activeConfig = await app.readConfig();
    const activeProvider = activeConfig.providers.find(item => item.id === provider.id);

    const cases = [
      { args: { path: 'sample.pdf', as: 'image', pageLimit: 1 }, bytes: pdf, label: 'PDF page', visual: true, mask: true },
      { args: { path: 'sample.avi', as: 'image', startSeconds: 0.25, frameCount: 2, intervalSeconds: 0.5 }, bytes: video, label: 'video samples', visual: true },
      ...(full ? [
        { args: { path: 'sample.docx' }, bytes: docx, label: 'DOCX text', text: 'Quarterly contact ' },
        { args: { path: 'sample.docx', as: 'image' }, bytes: docx, label: 'DOCX reflow preview / subagent', visual: true, subagent: true, projection: 'office-content-preview' },
        { args: { path: 'hidden.docx', as: 'image' }, bytes: hidden, label: 'hidden DOCX', refusal: 'document_hidden_content' },
      ] : []),
    ];
    for (plan of cases) {
      iteration = 0;
      const first = fake.requests.length;
      const session = await app.createSession({ title: 'Protected local media fixture', cwd: workspace });
      const events = [];
      const message = 'Inspect the requested local visual material.';
      const onEvent = event => events.push(event);
      const result = plan.subagent ? await app.runSubAgentCore({ parentSession: session, provider: activeProvider, config: activeConfig,
        task: message, toolTier: 'read', maxIters: 4, onEvent, subagentId: 'protected-media-fixture', depth: 1 })
        : (await app.runSessionTurn({ sessionId: session.id, message, cwd: workspace, source: 'http', onEvent })).result;
      assert.equal(result.ok, true, plan.label + ': native turn completes');
      const captured = fake.requests.slice(first).filter(request => request.stream).map(request => JSON.parse(request.raw));
      assert.equal(captured.length, full && plan.visual ? 3 : 2, plan.label + ': model call count');
      const receipt = JSON.parse(captured[1].messages.find(message => message.role === 'tool' && message.tool_call_id === 'local_media').content);
      const sent = images(captured[1]);
      if (!full) {
        assert.equal(receipt.ok, false);
        assert.equal(receipt.code, plan.args.frameCount ? 'privacy.image_runtime_unavailable' : 'reader_unavailable');
        assert.deepEqual(sent, []);
        runner.ok(true, plan.label + ': missing verified components fail closed without visual egress');
        continue;
      }
      if (plan.refusal) {
        assert.equal(receipt.ok, false);
        assert.equal(receipt.code, plan.refusal);
      } else assert.equal(receipt.ok, true, plan.label + ': ' + JSON.stringify(receipt));
      assert.equal(sent.length, plan.visual ? plan.args.frameCount || 1 : 0);
      if (plan.visual) {
        assert.equal(new Set(sent).size, sent.length, 'sampled pixels distinguish the requested frames');
        for (const url of sent) assert.match(url, /^data:image\/png;base64,iVBORw0KGgo/);
        assert.deepEqual(images(captured[2]), [], 'prepared pixels are sent only to the immediate model request');
      }
      if (plan.projection) assert.equal(receipt.projection, plan.projection);
      if (plan.mask) assert.ok(hasOpaqueMask(sent[0]), 'wire PNG covers the synthetic literal with an opaque pixel rectangle');
      if (plan.text) assert.ok(receipt.content.startsWith(plan.text) && !receipt.content.includes(email));
      if (plan.args.frameCount) {
        assert.deepEqual(receipt.coverage.sampledSeconds, [0.25, 0.75]);
        assert.equal(receipt.coverage.fullVideo, false);
      }
      const wire = JSON.stringify(captured), saved = JSON.stringify(await app.loadSession(session.id)), projected = JSON.stringify(events);
      for (const value of [wire, saved, projected]) {
        assert.ok(!value.includes('https://ruyi.invalid/protected-image/'));
        assert.ok(!value.includes(plan.bytes.toString('base64')));
        assert.ok(!value.includes(audioCanary) && !value.includes(metadataCanary) && !value.includes('UNEXPOSED'));
      }
      assert.ok(!wire.includes(email));
      assert.ok(!saved.includes('data:image/png;base64,') && !projected.includes('data:image/png;base64,'));
      runner.ok(true, plan.label + ': real file_read supplies the authorized projection without original media');
    }
    if (full) {
      await app.mutateConfig(config => { config.privacyModeV1 = 'off'; });
      plan = { args: { path: 'sample.avi', as: 'image', frameCount: 1 }, visual: false };
      iteration = 0;
      const first = fake.requests.length;
      const session = await app.createSession({ title: 'Ordinary video fixture', cwd: workspace });
      const { result } = await app.runSessionTurn({ sessionId: session.id, message: 'Read a local video still.', cwd: workspace, source: 'http', onEvent() {} });
      assert.equal(result.ok, true);
      const captured = fake.requests.slice(first).filter(request => request.stream).map(request => JSON.parse(request.raw));
      assert.equal(captured.length, 2);
      const sent = images(captured[1]);
      assert.equal(sent.length, 1);
      assert.match(sent[0], /^data:image\/png;base64,iVBORw0KGgo/);
      assert.ok(!JSON.stringify(captured).includes(video.toString('base64')));
      runner.ok(true, 'video sampling also sends only a decoded still with privacy disabled');
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await fake?.close(); }
    finally {
      if (failure || app?.MediaImageHooks.helperMayStillRun()) console.log('Retained synthetic fixture at ' + root);
      else await fs.rm(root, { recursive: true });
    }
  }
}

main().catch(error => runner.fail(error.stack || String(error))).finally(() => runner.done());
