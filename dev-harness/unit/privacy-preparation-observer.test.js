'use strict';
// Source-overlay validation of the rendezvous only. Does not start an HTTP service
// or imply that the real main/child Stop E2E has run.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), Module = require('node:module');
const { createPreparationObserver } = require(fs.existsSync(path.join(__dirname, '../lib/privacy-preparation-observer.js')) ? '../lib/privacy-preparation-observer' : './preparation-observer');
const repo = process.env.RUYI_GATEWAY_DRAFT_REPO || path.resolve(__dirname, '../..');
const draft = process.env.RUYI_GATEWAY_DRAFT_DIR || (fs.existsSync(path.join(__dirname, '../src/03a-privacy-gateway.js')) ? path.resolve(__dirname, '..') : null);
const fixturePath = path.join(repo, 'dev-harness/lib/privacy-test-fixture.js');
let fixtureLibrary;
if (draft) {
  const fixtureModule = new Module(fixturePath, module); fixtureModule.filename = fixturePath; fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixturePath));
  fixtureModule._compile(fs.readFileSync(path.join(draft, 'test-lib/privacy-test-fixture.js'), 'utf8'), fixturePath); fixtureLibrary = fixtureModule.exports;
} else fixtureLibrary = require(fixturePath);
const { fixture, gateway } = fixtureLibrary;
const { functionBlock } = require(path.join(repo, 'dev-harness/lib/source-slice'));
const sourceRoot = draft ? path.join(draft, 'src') : path.join(repo, 'ruyi-workbench/app/src');
const gatewaySource = fs.readFileSync(path.join(sourceRoot, '03a-privacy-gateway.js'), 'utf8');
const httpSource = fs.readFileSync(path.join(sourceRoot, '04h-provider-http.js'), 'utf8');
const policy = { privacyModeV1: 'enhanced', privacyRulesV1: [], providers: [] };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-preparation-observer-unit-'));
after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });

for (const [style, body] of [
  ['chat', { messages: [{ role: 'user', content: 'public request' }] }],
  ['responses', { input: [{ role: 'user', content: [{ type: 'input_text', text: 'public request' }] }] }],
  ['anthropic', { system: 'public instruction', messages: [{ role: 'user', content: [{ type: 'text', text: 'public request' }] }] }],
]) test(style + ': observer pauses actual live consumeSteps, then resumes exactly once into AbortError', async () => {
  let notify, yields = 0, sends = 0;
  const paused = new Promise(resolve => { notify = resolve; });
  const observer = createPreparationObserver({ onPause: notify });
  const folder = path.join(root, style); fs.mkdirSync(folder);
  const schedule = (callback, ...args) => { yields++; return observer.schedule(setImmediate, callback, ...args); };
  const api = gateway(folder, fixture(), { source: gatewaySource, setImmediate: schedule }); api.configure(policy);
  const post = vm.runInNewContext(functionBlock(httpSource, 'providerModelPostOnce') + '\nproviderModelPostOnce;', { PrivacyGateway: api, fetch: async () => { sends++; return { ok: true }; } });
  const ctrl = new AbortController(); observer.arm({ id: style, kind: 'main' });
  let identity;
  const request = api.run('observer-' + style, policy, async () => {
    identity = api.active();
    try { return await observer.boundary('main', { url: 'http://invalid.local/model', headers: {}, body, signal: ctrl.signal }, post); }
    finally { assert.equal(api.active(), identity); }
  });
  const rejected = assert.rejects(request, error => error.name === 'AbortError');
  const evidence = await Promise.race([paused, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('no real preparation pause')), 5000); timer.unref(); })]);
  assert.equal(evidence.phase, 'inside-consumeSteps-setImmediate'); assert.equal(evidence.signalAbortedAtPause, false);
  assert.equal(ctrl.signal.aborted, false); assert.equal(evidence.rows, 4096); assert.ok(evidence.bodyBytes > 250000); assert.equal(sends, 0);
  ctrl.abort(); assert.equal(observer.snapshot().signalAborted, true); assert.equal(observer.release(), true);
  await rejected; assert.equal(observer.release(), false); assert.equal(sends, 0); assert.ok(yields >= 1);
});

test('the held rendezvous is one-shot and an unrelated async operation is not intercepted', async () => {
  let pauses = 0, callbacks = 0;
  const observer = createPreparationObserver({ onPause() { pauses++; } });
  observer.arm({ id: 'one-shot', kind: 'main' });
  const ctrl = new AbortController();
  // Named helper is deliberately only for validating observer mechanics; the three
  // preceding tests are the evidence that production consumeSteps reaches the gate.
  function consumeSteps(callback) { return observer.schedule(setImmediate, callback); }
  const operation = observer.boundary('main', { body: {}, signal: ctrl.signal }, async () => {
    await new Promise(resolve => consumeSteps(() => { callbacks++; resolve(); }));
    await new Promise(resolve => consumeSteps(() => { callbacks++; resolve(); }));
  });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(pauses, 1); assert.equal(observer.snapshot().held, true);
  await new Promise(resolve => observer.schedule(setImmediate, resolve)); assert.equal(pauses, 1);
  observer.release(); await operation; assert.equal(callbacks, 2); assert.equal(pauses, 1);
});
