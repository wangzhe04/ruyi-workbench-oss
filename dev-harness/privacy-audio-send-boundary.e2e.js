'use strict';
// Real generated-server transcription/PCM entry points + loopback HTTP receiver.
// Only toolbox startup and readConfig completion scheduling are controlled. No real
// model, microphone, toolbox process, credentials, user files, or external network.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider } = require('./lib/fake-openai-provider');
const { loadServerInternals } = require('./lib/server-internals');
const { releaseEnvironment } = require('./lib/release-checks');
const runner = createRunner('PRIVACY AUDIO SEND BOUNDARY');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-audio-boundary-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), data));
const modes = ['basic', 'enhanced', 'strict'];
const audio = Buffer.from('SYNTHETIC-PRIVATE-AUDIO-BYTES\0fixture');
const settle = promise => promise.then(value => ({ value }), error => ({ error }));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture rendezvous timed out')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function check(label, work) { try { await work(); runner.ok(true, label); } catch (error) { runner.fail(label + ': ' + error.message); } }

(async () => {
  let fake;
  try {
    const received = [];
    fake = await startFakeProvider({ models: false, handler() { throw Error('fixture unexpectedly used model route'); }, fallback(req, res) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, raw: Buffer.concat(chunks) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'fixture transcript', choices: [{ message: { content: 'fixture transcript' } }], session_id: 'fixture-session' }));
      });
    } });
    const provider = { id: 'toolbox-asr-fixture', type: 'openai-compat', label: 'Fixture ASR', baseUrl: fake.url,
      apiKey: '', model: 'fixture-whisper', models: [{ id: 'fixture-whisper', caps: ['asr'] }] };
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ privacyModeV1: 'off', credentialEncryptionV1: true,
      providers: [provider], activeProvider: provider.id, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
      stewardEnabledV1: false, schedulerEnabledV1: false, autoImportMcpServers: false }));
    const app = loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'ToolboxHooks', 'readConfig', 'mutateConfig', 'transcribeAudioViaProvider', 'audioStreamUpstream'], { withEval: true });
    const control = app.__eval(`(() => {
      const originalRead = readConfig;
      const control = { calls: 0, failAt: 0, afterResolve: null };
      readConfig = () => ({ then(resolve, reject) {
        const index = ++control.calls;
        if (index === control.failAt) return reject(Object.assign(new Error('fixture config read failure'), {code:'EIO'}));
        originalRead().then(snapshot => {
          resolve(snapshot);
          // Runs after an old snapshot resolves, before the production await resumes.
          // This reproduces a newly committed process policy at that exact boundary.
          if (control.afterResolve) control.afterResolve(snapshot, index);
        }, reject);
      } });
      return control;
    })()`);
    async function reset(mode = 'off') {
      control.failAt = 0; control.afterResolve = null;
      app.ToolboxHooks.ensureForProvider = async () => {};
      await app.mutateConfig(config => { config.privacyModeV1 = mode; config.privacyPolicyRecoveryRequiredV1 = false; });
      control.calls = 0;
    }
    const transcribe = overrides => app.transcribeAudioViaProvider(provider, 'fixture-whisper', {
      audio, contentType: 'audio/wav', filename: 'synthetic.wav', language: '', prompt: '', warmup: true, ...overrides,
    });
    const pcmSession = { upstream: fake.url, upstreamId: 'fixture-session' };

    await check('OFF transcription sends exact original bytes to the loopback receiver', async () => {
      await reset(); const before = received.length, result = await transcribe();
      assert.equal(result.text, 'fixture transcript'); assert.equal(received.length, before + 1);
      assert(received.at(-1).raw.includes(audio)); assert.match(received.at(-1).url, /audio\/transcriptions/);
    });
    for (const mode of modes) {
      await check(mode + ' already enabled rejects transcription before toolbox startup or any HTTP send', async () => {
        await reset(mode); const before = received.length; let starts = 0;
        app.ToolboxHooks.ensureForProvider = async () => { starts++; };
        await assert.rejects(transcribe, error => error.code === 'privacy.media_not_supported');
        assert.equal(starts, 0); assert.equal(received.length, before);
      });
      await check('OFF -> ' + mode + ' committed during toolbox wait rejects the pending original audio', async () => {
        await reset(); const entered = deferred(), release = deferred(), before = received.length;
        app.ToolboxHooks.ensureForProvider = () => { entered.resolve(); return release.promise; };
        const pending = settle(transcribe());
        try {
          await bounded(entered.promise);
          // Uses real config persistence and configEmitWritten -> configurePrivacy.
          await app.mutateConfig(config => { config.privacyModeV1 = mode; });
        } finally { release.resolve(); }
        const result = await bounded(pending);
        assert.equal(result.error?.code, 'privacy.media_not_supported'); assert.equal(received.length, before);
      });
      await check('a real old OFF read paused in hydration cannot undo committed ' + mode + ' or send original audio', async () => {
        await reset(); const entered = deferred(), release = deferred(), before = received.length;
        const originalHydrate = app.PrivacyCore.configHooks.hydrateConfig; let offReads = 0;
        app.PrivacyCore.configHooks.hydrateConfig = async raw => {
          const result = await originalHydrate(raw);
          // Hold the final toolbox-refresh read, so another fresh read cannot
          // accidentally repair a stale publication before the actual audio send.
          if (raw?.privacyModeV1 === 'off' && ++offReads === 2) { entered.resolve(); await release.promise; }
          return result;
        };
        const pending = settle(transcribe());
        try {
          await bounded(entered.promise);
          await app.mutateConfig(config => { config.privacyModeV1 = mode; });
          assert.throws(() => app.PrivacyGateway.assertMediaAllowed(), error => error.code === 'privacy.media_not_supported');
        } finally { release.resolve(); }
        try {
          assert.equal((await bounded(pending)).error?.code, 'privacy.media_not_supported');
          assert.equal(received.length, before);
          assert.throws(() => app.PrivacyGateway.assertMediaAllowed(), error => error.code === 'privacy.media_not_supported');
          await assert.rejects(() => app.PrivacyGateway.withPolicy('new-audio-scope-' + mode, async () => app.PrivacyGateway.assertMediaAllowed()), error => error.code === 'privacy.media_not_supported');
        } finally { app.PrivacyCore.configHooks.hydrateConfig = originalHydrate; }
      });
      await check('OFF -> ' + mode + ' after toolbox config snapshot resolves rejects at transcription send commit', async () => {
        await reset(); const before = received.length;
        control.afterResolve = (snapshot, index) => { if (index === 2) app.PrivacyGateway.configure({ ...snapshot, privacyModeV1: mode }); };
        await assert.rejects(transcribe, error => error.code === 'privacy.media_not_supported');
        assert.equal(control.calls, 2); assert.equal(received.length, before);
      });
      await check('OFF -> ' + mode + ' after PCM config snapshot resolves rejects the chunk, while DELETE cleanup remains available', async () => {
        await reset(); const before = received.length;
        control.afterResolve = snapshot => app.PrivacyGateway.configure({ ...snapshot, privacyModeV1: mode });
        await assert.rejects(() => app.audioStreamUpstream(pcmSession, 'POST', '/fixture-session/audio', audio, 'audio/pcm'), error => error.code === 'privacy.media_not_supported');
        assert.equal(received.length, before);
        // A stale explicit off snapshot must not override the current process policy.
        assert.throws(() => app.PrivacyGateway.assertMediaAllowed({ privacyModeV1: 'off' }), error => error.code === 'privacy.media_not_supported');
        control.failAt = control.calls + 1;
        const result = await app.audioStreamUpstream(pcmSession, 'DELETE', '/fixture-session');
        assert.equal(result.status, 200); assert.equal(received.length, before + 1);
        assert.equal(received.at(-1).method, 'DELETE'); assert.equal(received.at(-1).raw.length, 0);
      });
    }
    await check('failed toolbox startup never sends audio and a later OFF retry remains usable', async () => {
      await reset(); const entered = deferred(), release = deferred(), before = received.length;
      app.ToolboxHooks.ensureForProvider = () => { entered.resolve(); return release.promise; };
      const pending = settle(transcribe()); await bounded(entered.promise); release.reject(Error('fixture toolbox failure'));
      assert.match((await bounded(pending)).error?.message || '', /fixture toolbox failure/); assert.equal(received.length, before);
      await reset(); assert.equal((await transcribe()).ok, true); assert.equal(received.length, before + 1);
    });
    for (const failAt of [1, 2]) await check('config read failure at transcription checkpoint ' + failAt + ' prevents any send', async () => {
      await reset(); const before = received.length; control.failAt = failAt;
      await assert.rejects(transcribe, error => error.code === 'EIO'); assert.equal(received.length, before);
    });
    await check('policy unavailable after config refresh refuses transcription at the final send boundary', async () => {
      await reset(); const before = received.length;
      control.afterResolve = (_, index) => { if (index === 2) app.PrivacyGateway.markUnavailable(); };
      await assert.rejects(transcribe, error => error.code === 'privacy.policy_unavailable'); assert.equal(received.length, before);
    });
    await check('OFF PCM sends exact bytes; failed config read blocks the next chunk and preserves DELETE cleanup', async () => {
      await reset(); const before = received.length;
      assert.equal((await app.audioStreamUpstream(pcmSession, 'POST', '/fixture-session/audio', audio, 'audio/pcm')).status, 200);
      assert.equal(received.length, before + 1); assert.deepEqual(received.at(-1).raw, audio);
      control.failAt = control.calls + 1;
      await assert.rejects(() => app.audioStreamUpstream(pcmSession, 'POST', '/fixture-session/audio', audio), error => error.code === 'EIO');
      assert.equal(received.length, before + 1);
      app.PrivacyGateway.markUnavailable();
      assert.equal((await app.audioStreamUpstream(pcmSession, 'DELETE', '/fixture-session')).status, 200);
      assert.equal(received.length, before + 2); assert.equal(received.at(-1).raw.length, 0);
    });
    await check('synthetic configuration creates no credential vault or operating-system protector work', async () => {
      assert.equal(fs.existsSync(path.join(data, 'credential-vault-v1.json')), false);
    });
  } catch (error) { runner.fail('fatal: ' + (error.stack || error)); }
  finally {
    if (fake) await fake.close();
    if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-audio-boundary-')) throw Error('cleanup scope');
    fs.rmSync(root, { recursive: true, force: true });
    runner.done();
  }
})();
