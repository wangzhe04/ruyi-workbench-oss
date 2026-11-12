'use strict';
// Opt-in W/T qualification. Real OS ownership and production CurrentUser DPAPI;
// the cold process reads existing records only and never starts serve/scheduler.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { fixtureChildEnv } = require('./fixture-home');
const { killOwnTree } = require('./kill-own-tree');
const ROOT = path.resolve(__dirname, '../..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
// Retain exact ChildProcess obligations, never a later process looked up by PID.
// A caller deadline is not proof of death; the on-disk facts remain UNKNOWN.
const retainedActors = new Set();
function createActorDiagnostics(root, write = fs.writeFileSync) {
  const state = { actors: [], failures: [], diagnosticErrors: [], qualification: 'pending',
    teardownBoundary: 'fx.close is test teardown only; it cannot retroactively accept unknown qualification' };
  const file = path.join(root, 'sealed-workflow-actors.json');
  function persist() {
    try { write(file, JSON.stringify(state, null, 2)); }
    catch (error) { state.diagnosticErrors.push({ code: error.code || '', message: error.message }); }
  }
  return { state, file, persist, fail(error) {
    state.qualification = 'failed';
    state.failures.push({ name: error.name, message: error.message, stack: error.stack || '' });
    persist();
    if (state.diagnosticErrors.length) error.workflowDiagnosticErrors = state.diagnosticErrors.slice();
  }, assertRecorded() {
    if (state.diagnosticErrors.length) throw Object.assign(Error('workflow actor evidence could not be recorded'), { workflowDiagnosticErrors: state.diagnosticErrors.slice() });
  } };
}
function sameDirectory(left, right) {
  assert.equal(fold(fs.realpathSync.native(left)), fold(fs.realpathSync.native(right)));
  const a = fs.lstatSync(left, { bigint: true }), b = fs.lstatSync(right, { bigint: true });
  assert.ok(a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink());
  assert.ok(a.ino > 0n && a.ino === b.ino && a.dev === b.dev);
}
function requestShape(input) {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input));
  assert.ok(['relay', 'scheduler'].includes(input.kind));
  const names = input.kind === 'relay' ? ['kind', 'relayId', 'sessionId'] : ['kind', 'playbookId'];
  assert.deepEqual(Object.keys(input).sort(), names.sort());
  for (const name of names.filter(value => value !== 'kind')) assert.match(input[name], /^[A-Za-z0-9_-]{1,128}$/);
  return input;
}
function inspectContainer(file, expected, instanceId, forbidden) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const raw = fs.readFileSync(file), header = JSON.parse(raw.toString('utf8').split('\n', 1)[0]);
  assert.equal(header.workData, 3); assert.equal(header.format, 'chunks-v1');
  assert.equal(header.instanceId, instanceId);
  for (const [name, value] of Object.entries(expected)) assert.equal(header[name], value, name);
  for (const text of forbidden) {
    assert.ok(typeof text === 'string' && text.length > 0);
    assert.equal(raw.includes(Buffer.from(text)), false, 'business plaintext must be absent');
  }
  return { bytes: raw.length, sha256: sha(raw), purpose: header.purpose, schema: header.schema,
    scopeId: header.scopeId, recordId: header.recordId, instanceId: header.instanceId };
}
function held(child, changed = () => {}) {
  const facts = { pid: child.pid, spawn: false, error: null, exit: null, close: null, stderrEnd: child.stderr ? false : null, stderrClose: child.stderr ? false : null };
  let resolve;
  const closed = new Promise(done => { resolve = done; });
  child.on('spawn', () => { facts.spawn = true; changed(); });
  child.on('error', error => { facts.error = error.message; changed(); });
  child.on('exit', (code, signal) => { facts.exit = { code, signal }; changed(); });
  child.on('close', (code, signal) => { facts.close = { code, signal }; changed(); resolve(); });
  child.stderr?.on('end', () => { facts.stderrEnd = true; changed(); });
  child.stderr?.on('close', () => { facts.stderrClose = true; changed(); });
  return { child, facts, closed };
}
async function within(promise, timeout, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' deadline')), timeout); })]); }
  finally { clearTimeout(timer); }
}
function assertClosed(row) {
  assert.ok(row.facts.spawn && !row.facts.error && row.facts.exit && row.facts.close, 'held process exit and close required');
  assert.deepEqual(row.facts.exit, row.facts.close);
  if (row.child.stderr) assert.ok(row.facts.stderrEnd && row.facts.stderrClose, 'original stderr pipe EOF and close required');
}
async function runChild(mode, home, input, diagnostics) {
  const startedAt = Date.now(), executionDeadline = startedAt + 120000, absoluteCleanupDeadline = executionDeadline + 30000;
  const child = cp.fork(__filename, [mode, home], { cwd: ROOT, windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...fixtureChildEnv(), RUYI_HOME: home,
      WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_TEST_SERVER_JS: path.join(ROOT, 'ruyi-workbench/app/server.js'),
      WCW_TEST_NO_NET_ANCHORS: '1', NODE_OPTIONS: '' } });
  const row = held(child, diagnostics.persist); let message, stderr = '', failure;
  const record = { role: mode, startedAt, executionDeadline, absoluteCleanupDeadline, facts: row.facts,
    stage: 'running', cleanupRequested: false, outcome: 'pending' };
  diagnostics.state.actors.push(record); diagnostics.persist();
  retainedActors.add(row);
  const watchdog = setTimeout(() => {
    if (!row.facts.close) { record.retention = 'absolute-watchdog-expired; original exit/close still unknown'; diagnostics.persist(); }
    retainedActors.delete(row);
  }, Math.max(1, absoluteCleanupDeadline - Date.now()));
  watchdog.unref();
  row.closed.then(() => { clearTimeout(watchdog); retainedActors.delete(row); });
  child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-12000); });
  child.on('message', value => { if (message !== undefined) failure ||= Error('more than one child result'); else message = value; });
  if (input) child.send(input);
  try { await within(row.closed, Math.max(1, executionDeadline - Date.now()), 'owned ' + mode); }
  catch (error) { failure = error; }
  finally {
    if (!row.facts.close) {
      record.stage = 'cleanup-requested'; record.cleanupRequested = true; diagnostics.persist();
      try { record.killReceipt = killOwnTree(child); diagnostics.persist(); await within(row.closed, Math.max(1, absoluteCleanupDeadline - Date.now()), 'owned child cleanup'); }
      catch (cleanup) {
        record.stage = 'cleanup-unknown'; record.outcome = 'failed'; diagnostics.persist();
        const error = new AggregateError([...(failure ? [failure] : []), cleanup], 'owned workflow child cleanup unknown');
        error.ownedChild = row;
        diagnostics.fail(error);
        throw error;
      }
    }
  }
  try {
    assertClosed(row); record.stage = 'known-held-exit-and-close';
    if (failure) throw failure;
    assert.equal(row.facts.exit.code, 0, stderr);
    assert.ok(message?.ok === true, stderr || JSON.stringify(message));
    record.outcome = 'completed'; diagnostics.persist(); diagnostics.assertRecorded();
  } catch (error) { record.outcome = 'failed'; diagnostics.fail(error); throw error; }
  return { value: message.value, lifecycle: row.facts };
}
function createSealedWorkflowBrowser() {
  let selected, diagnostics, fixture;
  const children = new WeakMap();
  return {
    get fixture() { return fixture; },
    observer: {
      beforeStart(fx) {
        fixture = fx;
        diagnostics = createActorDiagnostics(fx.root);
        console.log('Sealed workflow fixture at ' + fx.root);
        diagnostics.persist(); diagnostics.assertRecorded();
      },
      provider(fx) {
        try {
          const record = { role: 'fixture-provider', listeningObserved: fx.provider.listening === true, closeObserved: false };
          diagnostics.state.actors.push(record);
          fx.provider.once('close', () => { record.closeObserved = true; diagnostics.persist(); });
          diagnostics.persist();
        } catch (error) { diagnostics?.fail(error); }
      },
      child(role, child) {
        try {
          const row = held(child, () => diagnostics?.persist()); children.set(child, row);
          diagnostics.state.actors.push({ role: 'fixture-' + role, facts: row.facts, stage: 'owned by original browser fixture' });
          diagnostics.persist();
        } catch (error) { diagnostics?.fail(error); }
      },
      cleanup(fx, role) {
        try {
          diagnostics.state.actors.push({ role: 'fixture-' + role + '-teardown', requestedAt: Date.now(),
            stage: 'test teardown requested; no exit or qualification inference' });
          diagnostics.persist();
        } catch (error) { diagnostics?.fail(error); }
      },
    },
    async beforeServe(fx) {
      assert.equal(process.platform, 'win32', '--sealed requires real Windows CurrentUser DPAPI');
      assert.equal(fixture, fx, 'original beforeStart must capture this exact fixture');
      selected = (await runChild('--seed', fx.home, undefined, diagnostics)).value;
      assert.equal(selected.mode, 'encrypted');
    },
    async qualifyCold(fx, input, expected, forbidden, effects = () => 0) {
      requestShape(input); assert.ok(selected);
      const manifestFile = path.join(fx.home, '.work-data/active-v1.json');
      const manifest = fs.readFileSync(manifestFile);
      assert.equal(sha(manifest), selected.manifestSha256);
      sameDirectory(selected.root, path.join(fx.home, '.work-data/generations', selected.id));
      const instanceId = JSON.parse(fs.readFileSync(path.join(selected.root, 'work-data-key-v1.json'), 'utf8')).instanceId;
      const specs = input.kind === 'relay' ? [{ relative: `agent-runs/${input.sessionId}/${input.relayId}.json`,
        binding: { purpose: 'task', schema: 1, scopeId: input.sessionId, recordId: 'agent-run:' + input.relayId } }]
        : [{ relative: 'scheduler/tasks-v1.json', binding: { purpose: 'task', schema: 1, scopeId: 'scheduler', recordId: 'scheduler-tasks' } },
          { relative: `playbooks/${input.playbookId}.json`, binding: { purpose: 'workflow', schema: 1, scopeId: 'user', recordId: 'playbook:' + sha(input.playbookId + '.json') } }];
      const inspect = () => specs.map(spec => {
        assert.equal(fs.existsSync(path.join(fx.home, spec.relative)), false, 'no stable-base fallback');
        return inspectContainer(path.join(selected.root, spec.relative), spec.binding, instanceId, forbidden);
      });
      const before = inspect(), effectCount = effects(), original = fx.server, row = children.get(original);
      assert.ok(row, 'exact original serve must be retained from its spawn');
      const runtime = JSON.parse(fs.readFileSync(path.join(fx.home, 'runtime.json'), 'utf8'));
      assert.equal(runtime.pid, original.pid); assert.equal(runtime.port, fx.appPort); assert.equal(runtime.token, fx.token);
      const stop = { role: 'qualification-original-serve-stop', facts: row.facts, cleanupRequested: true,
        absoluteCleanupDeadline: Date.now() + 30000, stage: 'cleanup-requested' };
      diagnostics.state.actors.push(stop); diagnostics.persist();
      try {
        if (!row.facts.close) { stop.killReceipt = killOwnTree(original); diagnostics.persist(); }
        await within(row.closed, Math.max(1, stop.absoluteCleanupDeadline - Date.now()), 'original serve close'); assertClosed(row);
        stop.stage = 'known-held-exit-and-close'; diagnostics.persist();
      } catch (error) {
        stop.stage = 'cleanup-unknown'; error.ownedServe = row; diagnostics.fail(error); throw error;
      }
      const cold = await runChild('--cold', fx.home, { request: input, selected }, diagnostics);
      assert.notEqual(cold.lifecycle.pid, original.pid);
      assert.deepEqual(cold.value.result, expected, 'cold production readers reproduce the exact HTTP business state');
      assert.deepEqual(inspect(), before, 'cold read cannot rewrite the original encrypted records');
      assert.deepEqual(fs.readFileSync(manifestFile), manifest);
      assert.equal(effects(), effectCount, 'cold qualification executes no model turn');
      const evidence = { input, selected, serverSha256: sha(fs.readFileSync(path.join(ROOT, 'ruyi-workbench/app/server.js'))),
        originalServe: row.facts, coldReader: cold.lifecycle, containers: before, logicalSha256: sha(JSON.stringify(expected)), observationOnly: true };
      fs.writeFileSync(path.join(fx.root, 'sealed-workflow-qualification.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
      diagnostics.state.qualification = 'accepted'; diagnostics.persist(); diagnostics.assertRecorded();
      return evidence;
    },
    recordFailure(error) { diagnostics?.fail(error); },
  };
}
async function childMain(mode, home) {
  assert.equal(process.argv.length, 4); assert.ok(['--seed', '--cold'].includes(mode));
  assert.equal(process.platform, 'win32'); assert.ok(process.connected && path.isAbsolute(home));
  assert.equal(path.basename(home), 'home');
  assert.match(path.basename(path.dirname(home)), /^ruyi-(thread-relay-ui|scheduled-playbooks-browser)-[A-Za-z0-9]{6}$/);
  assert.equal(process.env.RUYI_HOME, home); sameDirectory(home, fs.realpathSync.native(home));
  const inputPromise = mode === '--cold' ? new Promise(resolve => process.once('message', resolve)) : null;
  const api = require('./server-internals').loadServerInternals(['WorkDataManifest', 'WorkDataKeys', 'LocalSecretCrypto',
    'ServerOwnership', 'atomicWriteJson', 'WorkDataRootHooks', 'workDataKeys', 'paths', 'ThreadRelay',
    'readAgentRunSnapshot', 'withSchedulerTaskOperation', 'schedulerTaskStore', 'schedulerPublicTask',
    'readUserPlaybookText', 'normalizePlaybook']);
  const owner = await api.ServerOwnership.acquire([home]);
  let staged, keys, value;
  try {
    const manifest = api.WorkDataManifest.create({ base: home });
    if (mode === '--seed') {
      const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
      assert.equal(config.workDataEncryptionV1, true); assert.equal(fs.existsSync(path.join(home, '.work-data')), false);
      const initial = await manifest.readActive(), encrypted = await manifest.prepare({ expected: initial, mode: 'encrypted' });
      keys = api.WorkDataKeys.create({ store: { read: async () => { throw Error('unexpected seed key read'); } }, enabled: () => false, protector: api.LocalSecretCrypto });
      staged = await keys.stageNew();
      await api.atomicWriteJson(path.join(encrypted.root, 'work-data-key-v1.json'), staged.header);
      await api.atomicWriteJson(path.join(encrypted.root, 'config.json'), config);
      await manifest.commit({ expected: initial, candidate: encrypted });
      const selected = await api.WorkDataRootHooks.bind(owner);
      sameDirectory(selected.root, encrypted.root);
      assert.equal(selected.mode, 'encrypted'); assert.equal(api.paths.data, selected.root);
      value = { root: selected.root, id: selected.id, generation: selected.generation, mode: selected.mode, manifestSha256: selected.proof.sha256 };
    } else {
      assert.equal(mode, '--cold');
      const input = await inputPromise; requestShape(input.request);
      const selected = await api.WorkDataRootHooks.bind(owner);
      const verify = async () => {
        const current = await manifest.readActive(); sameDirectory(current.root, input.selected.root);
        assert.equal(current.mode, 'encrypted'); assert.equal(current.id, input.selected.id);
        assert.equal(current.generation, input.selected.generation); assert.equal(current.proof.sha256, input.selected.manifestSha256);
        assert.equal(api.paths.data, selected.root);
      };
      await verify(); let result;
      const request = input.request;
      if (request.kind === 'relay') {
        result = await api.ThreadRelay.read(request.sessionId, request.relayId);
        assert.deepEqual(result, await api.readAgentRunSnapshot(request.sessionId, request.relayId, { strict: true }));
      } else {
        const stored = JSON.parse(await api.withSchedulerTaskOperation(operation => api.schedulerTaskStore(operation).read()));
        const playbook = api.normalizePlaybook(JSON.parse(await api.readUserPlaybookText(request.playbookId + '.json')));
        assert.equal(playbook?.id, request.playbookId);
        result = { tasks: stored.tasks.map(task => api.schedulerPublicTask(task, 'en-US')), playbook: { ...playbook, builtin: false } };
      }
      await verify(); value = { result };
    }
  } finally {
    try { staged?.lease.release(); keys?.clear(); api.workDataKeys.clear(); }
    finally { await owner.release(); }
  }
  process.send({ ok: true, value }, () => process.disconnect());
}
if (require.main === module) childMain(process.argv[2], process.argv[3]).catch(error => {
  console.error(error.stack || error); process.exitCode = 1; if (process.connected) process.disconnect();
});
module.exports = { createSealedWorkflowBrowser, requestShape, inspectContainer, sameDirectory, createActorDiagnostics };
