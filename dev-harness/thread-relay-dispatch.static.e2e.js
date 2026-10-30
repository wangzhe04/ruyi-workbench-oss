'use strict';
// PURE R2: real relay/lifecycle/provider/CLI dispatch and revision-guard slices,
// in-memory owners/files and inert fetch/spawn/RPC adapters. No HTTP, engine,
// native process, DPAPI, browser, timer or user-data access. --observe-r1 uses
// RUYI_RELAY_R1_BEFORE only for the pinned R1 09c/10 gzip bytes.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { functionBlock, sliceBlock } = require('./lib/source-slice');
const { createRunner } = require('./lib/harness');
const old = process.argv.includes('--observe-r1'), test = createRunner(old ? 'THREAD RELAY R2 R1 NEGATIVE' : 'THREAD RELAY R2'); const { ok } = test;
const root = path.resolve(__dirname, '../ruyi-workbench/app/src'), read = name => fs.readFileSync(path.join(root, name), 'utf8');
const fixtureFile = path.join(__dirname, 'thread-relay-admission.static.e2e.js'), fixtureSource = fs.readFileSync(fixtureFile, 'utf8');
const declarations = fixtureSource.slice(0, fixtureSource.indexOf('\n(async () => {'));
const fixture = vm.runInNewContext(declarations + '\nfixture', {
  require: createRequire(fixtureFile), __dirname, Buffer, URL,
  process: { argv: [], env: old ? { RUYI_RELAY_SNAPSHOT: process.env.RUYI_RELAY_R1_BEFORE } : {} },
});
async function setup(key) {
  const f = fixture(); await f.seed('a'); await f.seed('b'); await f.seed('c');
  const chain = await f.make(key); await f.relay.submit('a', chain.id, chain.threadRelay.edges[0].id); return { f, chain };
}
const execute = f => f.relay.execute(f.admitted(), f.admitted().nodes[0], new AbortController().signal, () => {});
async function attempt(work) { try { return { value: await work() }; } catch (error) { return { error: error.code || error.message }; } }
function mutate(f, kind) {
  if (kind === 'source') f.value('a').content = 'edited source after source validation';
  else if (kind === 'source-busy') f.owners.set('a', { snapshot: { serverInstanceId: 'source', driverRunId: 'new-source-owner' } });
  else if (kind === 'policy') f.config.permissionMode = 'plan';
  else f.change(kind);
}
function ownerHooks(owners) {
  const source = read('04-permission-runtime.js');
  const context = vm.runInNewContext(read('03c-model-dispatch-context.js') + '\nModelDispatchContext', { require });
  const hooks = vm.runInNewContext(sliceBlock(source, 'SessionExecutionHooks.withDispatchOwner =', '// A logical driver owns')
    + '\n' + functionBlock(source, 'assertSessionExecutionOwner') + '\nSessionExecutionHooks', { require, ModelDispatchContext: context, SessionExecutionHooks: {}, turnSettlers: owners });
  hooks.context = context; return hooks;
}
(async () => {
  try {
    for (const kind of old ? ['source'] : ['source', 'source-busy', 'policy', 'pending', 'stopped', 'busy', 'workflow']) {
      const { f, chain } = await setup('last_journal_' + kind);
      const readJournal = f.sandbox.readInterventionsWithMeta; let changed = false;
      f.sandbox.readInterventionsWithMeta = async sid => {
        const rows = await readJournal(sid);
        if (sid === 'b' && f.state.phase === 'dispatch' && !changed) { changed = true; mutate(f, kind); }
        return rows;
      };
      const r = await attempt(() => execute(f));
      if (old) {
        ok(changed && f.state.engines === 1 && r.value?.ok === true && f.admitted().threadRelayExecution.receipt.status === 'succeeded', 'R1 exact source-edit-in-final-target-journal counterexample dispatches once');
        ok((await f.relay.completion('a', f.approval('a').reference)).status === 'unknown'
          && f.approval('a').reference.sourceStamp !== chain.threadRelay.edges[0].source.reference.sourceStamp, 'R1 current completion is unknown while stale approved execution succeeds');
      } else ok(changed && !!r.error && f.state.engines === 0, 'combined final fence blocks last journal await → ' + kind);
    }
    if (old) { test.done(); return; }
    for (const kind of ['source', 'policy', 'pending', 'stopped', 'busy']) {
      const { f } = await setup('late_callback_' + kind);
      f.setInject(at => { if (at === 'afterFence') mutate(f, kind); });
      const r = await attempt(() => execute(f));
      ok(!!r.error && f.state.engines === 0, 'caller consumes same assert after await and late callback → ' + kind);
    }
    const postSource = functionBlock(read('04h-provider-http.js'), 'providerModelPostOnce');
    for (const mode of ['privacy-source', 'privacy-policy', 'final-source', 'final-pending', 'late-owner', 'own-write', 'normal']) {
      const { f } = await setup('wire_' + mode), hooks = ownerHooks(f.owners);
      const post = vm.runInNewContext(postSource + '\nproviderModelPostOnce', {
        ModelDispatchContext: hooks.context,
        PrivacyGateway: { active: () => null, withPolicy: (sid, work) => work(), disclosurePolicyGuard: () => () => {}, assertPolicyAvailable() {},
          beforeModelRequest: async body => { if (mode.startsWith('privacy-')) mutate(f, mode.slice('privacy-'.length)); if (mode === 'late-owner') f.owners.delete('b'); return body; } },
        fetch: () => { f.state.engines++; return { ok: true }; },
      });
      f.state.dispatch = async (owner, input) => {
        owner.sessionId = 'b'; owner.prepareDispatch = input.relayLifecycle.beforeDispatch;
        if (mode === 'own-write') f.change('own-change');
        const assert = hooks.assertDispatch;
        hooks.assertDispatch = (actualOwner, fence) => { if (mode.startsWith('final-')) mutate(f, mode.slice('final-'.length)); return assert(actualOwner, fence); };
        const work = () => post({ url: 'inert-provider', headers: {}, body: { messages: [{ role: 'user', content: 'approved material' }] } });
        if (mode === 'normal') await work(); else await hooks.withDispatchOwner(owner, work);
      };
      const result = await attempt(() => execute(f));
      ok(['own-write', 'normal'].includes(mode) ? result.value?.ok === true && f.state.engines === 1 : !!result.error && f.state.engines === 0,
        'real provider final POST owner fence: ' + mode);
    }
    // Real CLI dispatch sub-slices; all side-effect adapters are counters only.
    for (const [file, end, assignment] of [['05-claude-engine.js', '  const reg =', 'const child'], ['05b-kimi-bridge.js', '    reg = {', 'child']]) {
      const source = read(file), start = source.indexOf('const spawnFence = executionOwner?.prepareDispatch');
      const snippet = source.slice(start, source.indexOf(end, start));
      let count = 0, revision = 0;
      const owner = { sessionId: 'b', prepareDispatch: async () => { const captured = revision; return { assert() { if (captured !== revision) throw Error('changed after final callback'); } }; } };
      const hooks = ownerHooks(new Map([['b', owner]]));
      const result = await attempt(() => vm.runInNewContext('(async()=>{' + (assignment === 'child' ? 'let child;' : '') + '\n' + snippet + '\n})()', {
        executionOwner: owner, session: { id: 'b' }, SessionExecutionHooks: hooks, assertSessionExecutionOwner() {}, activeChildren: { has: () => true },
        stopSession: () => { revision++; }, cp: { spawn: () => { count++; return {}; } },
        spawnCmd: 'inert', spawnArgs: [], spawnOpts: {}, spawn: { command: 'inert', args: [], opts: {} }, workingDir: '', env: {},
      }));
      ok(snippet.includes(assignment) && result.error === 'changed after final callback' && count === 0, 'real ' + file + ' spawn asserts again after synchronous stop callback');
    }
    const claude = read('05-claude-engine.js');
    const input = sliceBlock(claude, "  child.stdin.on('error', () => {});", '  const stderrDecodeStream =');
    let stopped = 0, writes = 0;
    vm.runInNewContext(input, { child: { stdin: { on() {}, write() { writes++; }, end() {} } }, spawnFence: { assert() { throw Error('late change'); } },
      SessionExecutionHooks: { assertDispatch: (owner, fence) => fence.assert() }, executionOwner: {}, session: { id: 'b' },
      interactive: true, adapter: {}, fullPrompt: '', buildUserEnvelope: text => ({ text }), logEvent() {}, stopSession: () => { stopped++; } });
    ok(writes === 0 && stopped === 1, 'Claude late refusal sends no prompt and follows original child stop/exit path');
    const kimi = read('05b-kimi-bridge.js'), promptStart = kimi.indexOf('const promptFence = executionOwner?.prepareDispatch');
    const prompt = kimi.slice(promptStart, kimi.indexOf('      promptDelivered = true;', promptStart));
    let rpcCalls = 0;
    const owner = { sessionId: 'b', prepareDispatch: async () => ({ assert() { throw Error('late source change'); } }) };
    const rpcResult = await attempt(() => vm.runInNewContext('(async()=>{' + prompt + '})()', {
      executionOwner: owner, session: { id: 'b' }, assertSessionExecutionOwner() {}, SessionExecutionHooks: ownerHooks(new Map([['b', owner]])), nativeSessionId: 'native', promptParts: [], prompt: '',
      rpc: { request() { rpcCalls++; } },
    }));
    ok(rpcResult.error === 'late source change' && rpcCalls === 0, 'real Kimi session/prompt refuses at its final RPC boundary: ' + rpcResult.error);
    // Real config fence and bounded material guard with a synthetic filesystem.
    const configContext = { fs: { statSync: () => ({ dev: 1n, ino: 1n, size: 1n, mtimeNs: 1n, ctimeNs: 1n }) }, paths: { config: 'cfg' }, configReadGeneration: 1 };
    const configFence = vm.runInNewContext(functionBlock(read('01-config.js'), 'configReadFence') + '\nconfigReadFence', configContext);
    const guard = configFence(); configContext.configReadGeneration++;
    ok(!!(await attempt(() => Promise.resolve(guard()))).error, 'real config owner generation invalidates final policy fence');
    let sourceRevision = 1, material = Buffer.from('approved bytes'), materialStamp = 1n, maxRead = 0, completionVersion = 1n;
    const stat = () => ({ dev: 1n, ino: 2n, size: BigInt(material.length), mtimeNs: materialStamp, ctimeNs: materialStamp, isFile: () => true });
    const physical = {
      statSync: file => { if (file === 'completion') return { ...stat(), ino: 3n, mtimeNs: completionVersion, ctimeNs: completionVersion }; if (file !== 'material') throw Object.assign(Error('missing'), { code: 'ENOENT' }); return stat(); },
      realpathSync: file => file, openSync: () => 1, closeSync() {}, fstatSync: () => stat(),
      readSync: (fd, bytes, offset, length) => { maxRead = Math.max(maxRead, length); material.copy(bytes, offset, 0, length); return Math.min(length, material.length); },
    };
    const materialGuard = vm.runInNewContext(functionBlock(read('13aa-steward-delivery.js'), 'stewardDeliveryRevisionGuard') + '\nstewardDeliveryRevisionGuard', {
      fs: physical, crypto, Buffer, path, paths: { sessions: 'sessions' }, sessionBodyPaths: id => ({ messages: id + '.messages', provider: id + '.provider' }), sessionDiskWriteSeqOf: () => sourceRevision,
    });
    const fingerprint = crypto.createHash('sha256').update(material).digest('hex');
    const fileGuard = materialGuard({ id: 'a' }, {}, [{ path: 'material', fingerprint }]); fileGuard();
    ok(maxRead <= 128 * 1024 + 1, 'real final material guard reads only the bounded approved UTF-8 budget');
    material = Buffer.from('changed bytes!'); materialStamp++;
    ok(!!(await attempt(() => Promise.resolve(fileGuard()))).error, 'real physical material identity/content changes invalidate the same fence');
    const sourceGuard = materialGuard({ id: 'a' }, {}, []); sourceRevision++;
    ok(!!(await attempt(() => Promise.resolve(sourceGuard()))).error, 'real managed session write revision invalidates the source fence');
    const completionGuard = materialGuard({ id: 'a' }, {}, [], 'completion'); completionVersion++;
    ok(!!(await attempt(() => Promise.resolve(completionGuard()))).error, 'real completion receipt replacement invalidates the same source fence');
    for (const locale of ['zh-CN', 'en-US']) {
      const product = fs.readFileSync(path.join(__dirname, '../ruyi-workbench/app/public/locales', locale + '.json'));
      const mirror = fs.readFileSync(path.join(__dirname, '../docs/i18n/locales', locale + '.json'));
      ok(product.equals(mirror) && Object.keys(JSON.parse(product)).filter(key => key.startsWith('relay.')).length === 64, locale + ' locale mirror matches all product bytes and 64 relay keys');
    }
  } catch (error) { test.fail(error.stack || String(error)); }
  test.done();
})();
