'use strict';
// The document renderer is out of scope. This exercises its internal handoff
// with synthetic pages and a real model POST to a loopback receiver.
// --full-components requires the pinned Windows runtime and source sidecar.
require('./lib/self-isolate-home');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const { releaseEnvironment } = require('./lib/release-checks');

const full = process.argv.includes('--full-components');
const t = createRunner('MEDIA RENDERED PREPARE'), { ok } = t;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sessionId = 'sess_rendered_fixture';

// A 32-by-32 solid-color BMP has an independent source representation, so
// format conversion cannot accidentally pass by sending the original bytes.
function bmp(rgb) {
  const bytes = Buffer.alloc(54 + 32 * 32 * 3);
  bytes.write('BM');
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(32, 18);
  bytes.writeInt32LE(32, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  for (let i = 54; i < bytes.length; i += 3) {
    bytes[i] = rgb[2]; bytes[i + 1] = rgb[1]; bytes[i + 2] = rgb[0];
  }
  return bytes;
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--full-components'), 'unknown argument');
  if (full) {
    assert.equal(process.platform, 'win32', 'Windows OCR is required');
    for (const key of ['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT']) {
      assert.ok(path.isAbsolute(process.env[key] || ''), key + ' must be an absolute path');
    }
    assert.ok(process.env.RUYI_MEDIA_OCR_LANGUAGE, 'RUYI_MEDIA_OCR_LANGUAGE is required');
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-rendered-media-'));
  const data = path.join(root, 'data');
  let fake, app, failure;
  try {
    await fs.mkdir(data);
    const env = releaseEnvironment(path.join(root, 'home'), data);
    delete process.env.RUYI_TEST_SERVER_JS;
    Object.assign(process.env, env);
    if (!full) {
      process.env.RUYI_MEDIA_RUNTIME_ROOT = path.join(root, 'missing-runtime');
      process.env.RUYI_MEDIA_SOURCES_ROOT = path.join(root, 'missing-source');
    }
    process.env.RUYI_MEDIA_RESOURCE_PROFILE = 'legacy-full-4987-v1';
    fake = await startFakeProvider({ handler: () => textFrames('Synthetic pages received.') });
    const provider = { id: 'fixture', label: 'Fixture', type: 'openai-compat', baseUrl: fake.url,
      apiKey: '', model: 'fake-model', vision: true };
    await fs.writeFile(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, privacyModeV1: 'enhanced',
      credentialEncryptionV1: true, workDataEncryptionV1: false, autoImportClaudeCodeMcp: false,
      includeWorkbenchMcp: false, desktopMcp: { enabled: false, autodetect: false },
      activeProvider: provider.id, providers: [provider], defaultWorkspace: root }));
    app = require('./lib/server-internals').loadServerInternals(['MediaImageHooks', 'PrivacyGateway', 'activeOpenAiProvider',
      'providerWireProtocol', 'providerModelPostOnce', 'readConfig']);
    const config = await app.readConfig();
    app.PrivacyGateway.configure(config);
    const prepare = (pages, signal) => app.MediaImageHooks.prepareRenderedPages({ sessionId, pages, signal });
    const pages = [{ name: 'public-blue.bmp', bytes: bmp([96, 128, 208]) }, { name: 'public-green.bmp', bytes: bmp([96, 208, 128]) }];
    const derived = path.join(data, 'media-derived-v1', sha(sessionId).slice(0, 32));

    const revoked = prepare(pages);
    await app.MediaImageHooks.revokeScope(sessionId);
    await assert.rejects(revoked, { code: 'privacy.image_revoked' });
    ok(true, 'revocation during config lookup prevents the batch from opening a new scope');

    await assert.rejects(prepare(pages, AbortSignal.abort()), { code: 'privacy.image_cancelled' });
    ok(true, 'an already-cancelled batch is rejected before consulting the processor');
    if (!full) {
      const code = process.platform === 'win32' ? 'privacy.image_processor_dependency_failed' : 'privacy.image_processor_platform_unsupported';
      await assert.rejects(prepare(pages), { code });
      await assert.rejects(fs.stat(derived), { code: 'ENOENT' });
      ok(fake.requests.length === 0, 'missing native capability produces no artifact or model request');
      return;
    }

    const callerPages = pages.map(page => ({ ...page }));
    const preparing = prepare(callerPages);
    callerPages[0].name = 'changed-after-admission.bmp';
    callerPages.pop();
    const issued = await preparing;
    ok(Object.keys(issued).sort().join(',') === 'recipient,references' && issued.references.length === 2
      && issued.references.every((ref, index) => Object.keys(ref).sort().join(',') === 'id,name,reference'
        && ref.name === pages[index].name && ref.reference === 'https://ruyi.invalid/protected-image/' + ref.id),
    'real native preparation returns only the two ordered protected references');

    const kept = (await fs.readdir(derived)).sort();
    assert.equal(kept.length, 2);
    const saved = await Promise.all(kept.map(name => fs.readFile(path.join(derived, name), 'utf8').then(JSON.parse)));
    const badPage = { name: 'unsupported.gif', bytes: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') };
    await assert.rejects(prepare([pages[0], badPage]), { code: 'privacy.image_processor_worker_format_unsupported' });
    assert.deepEqual((await fs.readdir(derived)).sort(), kept);
    ok(fake.requests.length === 0, 'late decode failure removes the partial batch and preserves unrelated prepared pages');

    const selected = app.activeOpenAiProvider(config), wire = app.providerWireProtocol(selected);
    const body = wire.encodeMessages({ model: selected.model, stream: true, provider: selected,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe the two synthetic pages.' }, ...issued.references.map(ref => ({
        type: 'image_url', image_url: { url: ref.reference },
      }))] }] });
    const response = await app.PrivacyGateway.run(sessionId, config, () => app.providerModelPostOnce({
      url: wire.completionUrl(selected.baseUrl), headers: wire.requestHeaders(selected, { model: selected.model }),
      body, signal: AbortSignal.timeout(10000),
    }));
    await response.text();
    assert.equal(fake.requests.length, 1);
    const raw = fake.requests[0].raw, sent = JSON.parse(raw);
    const user = sent.messages.find(message => message.role === 'user');
    assert.ok(Array.isArray(user?.content), 'the captured user message contains media parts');
    const urls = user.content.filter(part => part.type === 'image_url').map(part => part.image_url.url);
    ok(response.ok && fake.requests.length === 1 && urls.length === pages.length && urls.every((url, index) => {
      const expected = saved.find(row => row.manifest.sourceHash === sha(pages[index].bytes));
      const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
      return url.startsWith('data:image/png;base64,') && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        && sha(bytes) === expected?.manifest.payloadHash && bytes.toString('base64') === expected.data
        && !raw.includes(pages[index].bytes.toString('base64')) && !raw.includes(pages[index].name);
    }), 'one model POST contains both exact stored PNGs in order, without the original BMPs');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([app?.MediaImageHooks.revokeScope(sessionId), fake?.close()]);
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    try {
      if (app && app.MediaImageHooks.helperMayStillRun() !== false) errors.push(Error('Rendered media helper may still be running'));
    } catch (error) { errors.push(error); }
    const retained = failure?.ownershipRetained || failure?.cleanupFailed || failure?.helperMayStillRun;
    if (!errors.length && !retained) {
      try { await fs.rm(root, { recursive: true, force: true }); }
      catch (error) { errors.push(error); }
    }
    if (errors.length || retained) console.log('Retained synthetic media fixture at ' + root);
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors,
      'Rendered media fixture cleanup failed', { cause: failure || errors[0] });
  }
}

main().catch(error => t.fail(error.stack || String(error))).finally(() => t.done());
