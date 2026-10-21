'use strict';
// Run from repository root: node dev-harness/privacy-m1/media/media.e2e.js
// --write-evidence writes only the sanitized aggregate; all synthetic media is removed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRunner } = require('../../lib/harness');
const { ROOT, WORKER, PYTHON, POLICY, sha, loadDetector, createPolicyOwner, runWorker, startReceiver, processImage } = require('./prototype');
const { ok, done } = createRunner('PRIVACY M1 MEDIA');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-m1-media-'));
  const receiver = await startReceiver();
  const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(), prototypeVersion: 'm1-media-0.1.0', productionIntegrated: false,
    executionEnvironment: { platform: process.platform, architecture: process.arch, osRelease: os.release(), nodeVersion: process.version },
    scope: 'synthetic PNG images only; loopback receiver; no user media, cloud inference or new downloads',
    limitations: ['WinSDK OCR exposes no confidence score; this is controlled-fixture feasibility, not a general image safety gate',
      'No face, signature, QR, arbitrary rotation, multi-language fixture, PDF, Office or video anonymization claim',
      'ASR is not implemented; no local model was configured or exercised; fail closed only',
      'Inventory is bounded to existing ACC runtime, repository known model locations and process PATH; not a whole-machine scan'],
    cases: [], failures: [], uploadOutcomes: [], receiver: {} };
  try {
    const inventory = await runWorker({ mode: 'inventory' });
    evidence.components = inventory;
    delete evidence.components.ok;
    evidence.components.runtime = 'existing ACC build_offline/python_embed';
    evidence.components.additionalRuntimeProbes = [];
    const probes = [
      ['ACC development venv', path.join(ROOT, 'mcp/ai-computer-control/.venv/Scripts/python.exe')],
      ['system Python312', path.join(process.env.LOCALAPPDATA || '', 'Programs/Python/Python312/python.exe')],
    ];
    for (const [runtime, python] of probes) {
      if (!fs.existsSync(python)) { evidence.components.additionalRuntimeProbes.push({ runtime, status: 'missing-component' }); continue; }
      const result = await runWorker({ mode: 'probe' }, { python }); delete result.ok;
      evidence.components.additionalRuntimeProbes.push({ runtime, ...result });
    }
    evidence.components.knownRepositoryModelDirectories = ['models', 'ruyi-workbench/models', 'mcp/asr-shim/models'].map(relative =>
      ({ id: relative, present: fs.existsSync(path.join(ROOT, relative)) }));
    evidence.components.pythonLicense = 'PSF-2.0 (bundled Python distribution)';
    evidence.components.ocrRuntime = 'Windows.Media.Ocr, OS component; Windows license applies; no OCR model redistribution';
    const policyOwner = createPolicyOwner();
    const { detector, policyHash, rulesHash } = policyOwner.loadDetector();
    const getCurrentPolicyRevision = policyOwner.getCurrentPolicyRevision;
    evidence.manifest = { processorVersion: 'm1-media-0.1.0', processorHash: sha(fs.readFileSync(WORKER)),
      orchestrationHash: sha(fs.readFileSync(path.join(__dirname, 'prototype.js'))),
      pythonExecutableHash: sha(fs.readFileSync(PYTHON)), policyVersion: POLICY.version, policyHash, rulesHash,
      acceptanceSourceHashes: { 'media.e2e.js': sha(fs.readFileSync(__filename)),
        'mapping.test.js': sha(fs.readFileSync(path.join(__dirname, 'mapping.test.js'))) },
      policyAuthorityContract: 'independent owner revision/hash; checked at processing stages and synchronous HTTP submission',
      uploadContract: 'signal + absolute deadline + commit check; acknowledged=sent; post-submit error=unknown; never auto-retry',
      encoding: 'fresh RGB PNG, no copied image metadata', sourceContract: 'owned single source snapshot, checked before derive and send' };
    const fixtures = await runWorker({ mode: 'fixture', root });
    for (const fixture of fixtures.fixtures) {
      const before = receiver.captures.length;
      const result = await processImage({ source: fixture.file, root, id: fixture.name, detector, upload: receiver.upload, getCurrentPolicyRevision });
      const capture = receiver.captures.at(-1);
      assert.equal(receiver.captures.length, before + 1);
      assert.equal(sha(capture.bytes), result.derivedHash);
      assert.notEqual(sha(capture.bytes), result.sourceHash);
      assert.ok(!capture.bytes.equals(fs.readFileSync(fixture.file)));
      assert.equal(sha(fs.readFileSync(fixture.file)), result.sourceHash);
      assert.equal(capture.headers['x-media-name'], 'derived.png');
      assert.ok(!JSON.stringify(capture.headers).includes('fixture@example'));
      assert.equal(result.hitCount, 3);
      assert.deepEqual(result.categories.sort(), ['EMAIL', 'INTERNAL', 'PHONE']);
      assert.ok(result.crossWord && result.matchedWords >= 5);
      assert.equal(result.delivery, 'sent'); assert.equal(result.acknowledged, true);
      evidence.cases.push({ id: fixture.name, status: 'passed', ...result, actualHttpCaptureHash: sha(capture.bytes),
        onlyDerivedSent: true, originalNotSent: true, originalUnchanged: true });
      ok(true, fixture.name + ': real OCR -> PrivacyCore full intervals -> pixels -> fresh PNG -> actual loopback HTTP bytes');
    }
    async function rejectsClosed(id, code, work) {
      const before = receiver.captures.length;
      const requestsBefore = receiver.requests.length;
      await assert.rejects(work, error => error.code === code);
      assert.equal(receiver.captures.length, before);
      assert.equal(receiver.requests.length, requestsBefore);
      evidence.failures.push({ id, expectedCode: code, status: 'passed', originalFallback: false, additionalHttpRequests: 0 });
      ok(true, id + ': ' + code + ', zero upload or original fallback');
    }
    let counter = 0;
    const negative = extra => processImage({ source: fixtures.fixtures[0].file, root, id: 'negative-' + (++counter),
      detector, upload: receiver.upload, getCurrentPolicyRevision, ...extra });
    await rejectsClosed('missing-ocr-runtime', 'missing-component', () => negative({ workerOptions: { python: path.join(root, 'missing.exe') } }));
    await rejectsClosed('unrecognized-image', 'unrecognized', () => negative({ source: fixtures.blank }));
    const early = new AbortController(); early.abort();
    await rejectsClosed('cancel-before-processing', 'cancelled', () => negative({ signal: early.signal }));
    const late = new AbortController();
    await rejectsClosed('cancel-before-upload', 'cancelled', () => negative({ signal: late.signal, beforeUpload: () => late.abort() }));
    const enteredUpload = new AbortController();
    await rejectsClosed('cancel-on-upload-entry', 'cancelled', () => negative({ signal: enteredUpload.signal,
      upload: (bytes, options) => { enteredUpload.abort(); return receiver.upload(bytes, options); } }));
    await rejectsClosed('changed-snapshot', 'source-changed', () => negative({ beforeUpload: ({ snapshot }) => fs.appendFileSync(snapshot, 'changed') }));
    await rejectsClosed('changed-derived', 'source-changed', () => negative({ beforeUpload: ({ target }) => fs.appendFileSync(target, 'changed') }));
    const changedSource = path.join(root, 'changed-source.png');
    fs.copyFileSync(fixtures.fixtures[0].file, changedSource);
    await rejectsClosed('changed-current-source', 'source-changed', () => negative({ source: changedSource,
      beforeUpload: () => fs.appendFileSync(changedSource, 'changed') }));
    const revisedPolicy = JSON.parse(JSON.stringify(POLICY));
    const revisedDetector = loadDetector(revisedPolicy).detector;
    await rejectsClosed('changed-policy-version', 'processor-or-policy-changed', () => negative({ detector: revisedDetector,
      beforeUpload: () => { revisedPolicy.version = 'm1-fixture-policy-revised'; } }));
    for (const stage of ['before-upload', 'upload-entry']) {
      const owner = createPolicyOwner(), oldDetector = owner.loadDetector().detector;
      let replacementDetector;
      const replace = () => {
        owner.replacePolicy({ ...POLICY, version: 'm1-new-authoritative-policy' });
        replacementDetector = owner.loadDetector().detector;
      };
      await rejectsClosed('replace-authoritative-policy-' + stage, 'processor-or-policy-changed', () => negative({
        detector: oldDetector, getCurrentPolicyRevision: owner.getCurrentPolicyRevision,
        ...(stage === 'before-upload' ? { beforeUpload: replace } : {
          upload: (bytes, options) => { replace(); return receiver.upload(bytes, options); },
        }),
      }));
      assert.notEqual(replacementDetector, oldDetector);
      assert.equal(owner.getCurrentPolicyRevision().revision, 2);
    }
    await rejectsClosed('stale-processor-manifest', 'processor-or-policy-changed', () => negative({
      expectedProcessorHash: '0'.repeat(64) }));
    assert.equal(sha(fs.readFileSync(WORKER)), evidence.manifest.processorHash);
    await rejectsClosed('bounded-worker-timeout', 'timeout', () => runWorker({ mode: 'wait' }, { timeout: 500 }));
    await rejectsClosed('ocr-stage-timeout', 'timeout', () => negative({ workerOptions: { timeout: 1 } }));
    const active = new AbortController();
    const cancellationTimer = setTimeout(() => active.abort(), 500);
    try { await rejectsClosed('cancel-active-worker', 'cancelled', () => runWorker({ mode: 'wait' }, { signal: active.signal })); }
    finally { clearTimeout(cancellationTimer); }
    // These requests really send a derivative before cancellation/timeout. They are
    // unknown to the sender, never a zero-egress assertion and never auto-retried.
    for (const kind of ['timeout-without-response', 'cancel-after-receiver-capture']) {
      const controller = new AbortController();
      const stalled = await startReceiver({ respond: false,
        onCapture: kind === 'cancel-after-receiver-capture' ? () => controller.abort() : undefined });
      let uploadStarted;
      try {
        let observed;
        await assert.rejects(() => negative({ signal: controller.signal, deadline: Date.now() + 10000,
          upload: (bytes, options) => {
            uploadStarted = Date.now();
            return stalled.upload(bytes, { ...options, deadline: Math.min(options.deadline, Date.now() + 250) });
          },
        }), error => {
          observed = error;
          return error.code === (kind === 'timeout-without-response' ? 'upload-timeout' : 'cancelled');
        });
        const elapsed = Date.now() - uploadStarted;
        assert.equal(observed.delivery, 'unknown'); assert.equal(observed.requestDestroyed, true);
        assert.ok(elapsed < 3000, 'upload cancellation/deadline bounded independently of response');
        assert.equal(stalled.requests.length, 1); assert.equal(stalled.captures.length, 1);
        const capturedHash = sha(stalled.captures[0].bytes);
        assert.equal(capturedHash, evidence.cases[0].derivedHash);
        assert.notEqual(capturedHash, evidence.cases[0].sourceHash);
        evidence.uploadOutcomes.push({ id: kind, status: 'passed', code: observed.code, delivery: observed.delivery,
          requestDestroyed: observed.requestDestroyed, elapsedMs: elapsed, deadlineBudgetMs: 250,
          additionalHttpRequests: 1, receiverCapturedDerived: true, actualHttpCaptureHash: capturedHash,
          originalFallback: false, retracted: false, retried: false });
        ok(true, kind + ': real derived bytes captured, request destroyed, delivery unknown, no retry');
      } finally { await stalled.close(); }
    }
    // An actual generated silent PCM/WAV is local only. Missing ASR never forwards it.
    const wav = Buffer.alloc(44 + 16000 * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    const audio = path.join(root, 'synthetic.wav'); fs.writeFileSync(audio, wav);
    await rejectsClosed('asr-no-adapter-or-model', 'missing-component', () => runWorker({ mode: 'audio', source: audio }));
    evidence.asr = { status: 'missing-component', completeTranscriptionPassed: false, syntheticAudioHash: sha(wav),
      modelConfigured: false, modelVersion: null, modelHash: null, modelLicense: null, rawAudioUploaded: false };
    evidence.video = { status: 'not-implemented', completeVideoRedactionPassed: false,
      ffmpegVersion: null, ffmpegLicense: null, reason: inventory.videoOnPath.ffmpeg ? 'not exercised' : 'ffmpeg/ffprobe absent from tested PATH' };
    evidence.receiver = { bind: '127.0.0.1', requests: receiver.requests.length + evidence.uploadOutcomes.length,
      acknowledgedRequests: receiver.captures.length, unknownOutcomeRequests: evidence.uploadOutcomes.length, actualBytesCaptured: true,
      requestHashes: [...receiver.captures.map(c => sha(c.bytes)), ...evidence.uploadOutcomes.map(c => c.actualHttpCaptureHash)],
      originalPayloadRequests: 0 };
    evidence.status = 'image-fixture-feasibility-passed';
  } finally {
    await receiver.close();
    // Delete only our exact mkdtemp-owned directory after containment verification.
    const parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('ruyi-m1-media-'));
    fs.rmSync(root, { recursive: true, force: true });
    evidence.cleanup = { ownTemporaryDirectoryRemoved: !fs.existsSync(root) };
  }
  if (process.argv.includes('--write-evidence')) {
    fs.writeFileSync(path.join(ROOT, 'docs/optimization-plan/evidence/privacy-m1-media.json'), JSON.stringify(evidence, null, 2) + '\n');
  }
  ok(evidence.cleanup.ownTemporaryDirectoryRemoved, 'self-owned synthetic media and snapshots removed');
}
main().then(() => done()).catch(error => { ok(false, 'prototype failed: ' + (error.code || error.name)); done(); });
