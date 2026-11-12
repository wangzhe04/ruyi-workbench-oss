'use strict';
// Tests the acceptance oracle only. No simulated DPAPI or encrypted-store read
// is accepted as evidence of Windows production encryption or cold recovery.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), { EventEmitter } = require('node:events');
const { functionBlock } = require('../lib/source-slice');
const { requestShape, inspectContainer, sameDirectory, createActorDiagnostics, createSealedWorkflowBrowser } = require('../lib/sealed-workflow-browser.cjs');
test('cold reader accepts only exact business identities, never a caller filename, action or decoder', () => {
  for (const input of [{ kind: 'relay', sessionId: 'original_session', relayId: 'run_original' }, { kind: 'scheduler', playbookId: 'pb_original' }]) assert.equal(requestShape(input), input);
  for (const input of [null, [], {}, { kind: 'run' }, { kind: 'relay', sessionId: '../other', relayId: 'run_original' },
    { kind: 'relay', sessionId: 'session', relayId: 'run', action: 'start' }, { kind: 'scheduler', playbookId: 'pb', file: 'other' },
    { kind: 'scheduler', playbookId: 'C:\\other' }, { kind: 'scheduler', playbookId: 'a'.repeat(129) }]) assert.throws(() => requestShape(input));
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-sealed-workflow-oracle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('container oracle requires chunks-v1 and exact instance, family, schema, scope and record identity', t => {
  const root = fixture(t), file = path.join(root, 'task.json');
  const expected = { purpose: 'task', schema: 1, scopeId: 'session', recordId: 'agent-run:run_original' };
  const header = { workData: 3, format: 'chunks-v1', instanceId: 'instance_original', ...expected };
  const write = value => fs.writeFileSync(file, JSON.stringify(value) + '\n{"opaque":"synthetic"}\n');
  write(header);
  const receipt = inspectContainer(file, expected, header.instanceId, ['SENSITIVE_MATERIAL']);
  assert.equal(receipt.recordId, expected.recordId); assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  for (const key of ['workData', 'format', 'instanceId', 'purpose', 'schema', 'scopeId', 'recordId']) {
    write({ ...header, [key]: 'wrong' });
    assert.throws(() => inspectContainer(file, expected, header.instanceId, ['SENSITIVE_MATERIAL']), key);
  }
  write({ ...header, material: 'SENSITIVE_MATERIAL' });
  assert.throws(() => inspectContainer(file, expected, header.instanceId, ['SENSITIVE_MATERIAL']));
  fs.writeFileSync(file, JSON.stringify({ id: 'run_original', material: 'SENSITIVE_MATERIAL' }));
  assert.throws(() => inspectContainer(file, expected, header.instanceId, ['SENSITIVE_MATERIAL']));
});
test('physical directory comparison accepts Windows case spelling and rejects a different or missing root', t => {
  const root = fixture(t), other = path.join(root, 'other'); fs.mkdirSync(other);
  sameDirectory(root, fs.realpathSync.native(root));
  if (process.platform === 'win32') sameDirectory(root.toLowerCase(), root.toUpperCase());
  assert.throws(() => sameDirectory(root, other));
  assert.throws(() => sameDirectory(root, path.join(root, 'missing')), { code: 'ENOENT' });
});
test('unknown actor cleanup is recorded with original incomplete facts and later close cannot retroactively accept qualification', t => {
  const root = fixture(t), diagnostics = createActorDiagnostics(root);
  const facts = { pid: 123, spawn: true, exit: null, close: null, stderrEnd: false, stderrClose: false };
  diagnostics.state.actors.push({ role: '--cold', facts, stage: 'cleanup-unknown', cleanupRequested: true });
  const original = Error('original cold read timeout'); diagnostics.fail(original);
  let stored = JSON.parse(fs.readFileSync(diagnostics.file, 'utf8'));
  assert.equal(stored.qualification, 'failed'); assert.equal(stored.actors[0].stage, 'cleanup-unknown');
  assert.equal(stored.actors[0].facts.exit, null); assert.equal(stored.actors[0].facts.close, null);
  facts.exit = { code: 1, signal: null }; facts.close = { code: 1, signal: null }; diagnostics.persist();
  stored = JSON.parse(fs.readFileSync(diagnostics.file, 'utf8'));
  assert.equal(stored.qualification, 'failed'); assert.equal(stored.actors[0].stage, 'cleanup-unknown');
  assert.equal(stored.failures[0].message, original.message);
});
test('evidence write failure attaches to the original failure and rejects successful qualification without replacing its cause', t => {
  const diagnostics = createActorDiagnostics(fixture(t), () => { throw Object.assign(Error('synthetic evidence disk failure'), { code: 'ENOSPC' }); });
  const original = Error('original held child close unknown');
  assert.doesNotThrow(() => diagnostics.fail(original));
  assert.equal(original.message, 'original held child close unknown');
  assert.equal(original.workflowDiagnosticErrors[0].code, 'ENOSPC');
  assert.throws(() => diagnostics.assertRecorded(), /actor evidence could not be recorded/);
});
test('complete observer executes every actual shared-browser callback; the original child-only observer fails beforeStart', t => {
  const body = functionBlock(fs.readFileSync(path.resolve(__dirname, '../lib/browser-fixture.js'), 'utf8'), 'startBrowserFixture');
  const callbacks = [...body.matchAll(/^\s*(opts\.evidenceObserver\?\.(\w+)\([^\r\n]*\);)\s*$/gm)]
    .map(match => ({ statement: match[1], method: match[2] }));
  assert.deepEqual([...new Set(callbacks.map(row => row.method))].sort(), ['beforeStart', 'child', 'cleanup', 'provider']);
  const qualification = createSealedWorkflowBrowser(), root = fixture(t);
  const makeChild = () => Object.assign(new EventEmitter(), { pid: 123, stderr: new EventEmitter() });
  const fx = { root, provider: Object.assign(new EventEmitter(), { listening: true }), server: makeChild(), browser: makeChild() };
  const invoke = (row, observer) => vm.runInNewContext(row.statement, { opts: { evidenceObserver: observer }, fx });
  const beforeStart = callbacks.find(row => row.method === 'beforeStart');
  assert.throws(() => invoke(beforeStart, { child() {} }), /beforeStart is not a function/);
  for (const method of ['beforeStart', 'provider', 'child', 'cleanup']) {
    for (const callback of callbacks.filter(row => row.method === method)) assert.doesNotThrow(() => invoke(callback, qualification.observer));
  }
  assert.equal(qualification.fixture, fx, 'startup failure retains the original fixture for its own teardown');
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'sealed-workflow-actors.json'), 'utf8'));
  assert.ok(stored.actors.some(row => row.role === 'fixture-provider'));
  assert.equal(stored.actors.filter(row => row.stage?.startsWith('test teardown requested')).length, 3);
  assert.equal(stored.failures.length, 0);
});
