'use strict';
// M3-1: the frozen work-data envelope must fail closed on a wrong purpose, key generation, family,
// scope, record or revision, must never accept a v1 container, and must never create a key by itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock } = require('../lib/source-slice');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const moduleSource = constBlock(read('01n-work-data-crypto.js'), 'WorkDataCrypto');
assert.ok(moduleSource.length > 1200, 'sliced the whole WorkDataCrypto declaration');
const { core, workData } = vm.runInNewContext(read('01h-privacy-core.js') + '\n' + moduleSource + '\n({core:PrivacyCore,workData:WorkDataCrypto})', { require, Buffer });

const MASTER = crypto.randomBytes(32);
const INSTANCE = 'a'.repeat(32);
const TEXT = JSON.stringify({ title: '合同甲方张三', body: '一行中文与 emoji 🙂' });
const binding = (patch = {}) => ({ purpose: 'session', instanceId: INSTANCE, schema: 1, scopeId: 'scope-1', recordId: 'turn-1', seq: 0, ...patch });
const fails = (fn, suffix) => assert.throws(fn, error => error.code === 'work_data.' + suffix, 'expected work_data.' + suffix);

test('seals one record and opens it only with the exact binding', () => {
  const container = workData.seal(TEXT, MASTER, binding({ schema: 3, seq: 7 }));
  assert.equal(container.version, 2);
  assert.equal(container.keyId, 'work-data-v2.k1');
  assert.equal(container.purpose, 'session');
  assert.equal(JSON.stringify(container).includes('张三'), false);
  assert.equal(JSON.stringify(container).includes('scope-1'), true);
  assert.equal(workData.open(container, MASTER, binding({ schema: 3, seq: 7 })), TEXT);
  for (const [patch, suffix] of [
    [{ instanceId: 'b'.repeat(32) }, 'binding_mismatch'],
    [{ schema: 2 }, 'binding_mismatch'],
    [{ scopeId: 'scope-2' }, 'binding_mismatch'],
    [{ recordId: 'turn-2' }, 'binding_mismatch'],
    [{ seq: 8 }, 'binding_mismatch'],
    [{ generation: 2 }, 'key_mismatch'],
    [{ purpose: 'memory' }, 'purpose_mismatch'],
  ]) fails(() => workData.open(container, MASTER, binding({ schema: 3, seq: 7, ...patch })), suffix);
});

test('derived keys are per purpose and per generation, deterministic and never the master itself', () => {
  const session = workData.deriveKey(MASTER, 'session'), memory = workData.deriveKey(MASTER, 'memory');
  assert.equal(session.length, 32);
  assert.equal(session.equals(memory), false);
  assert.equal(workData.deriveKey(MASTER, 'session').equals(session), true);
  assert.equal(session.equals(MASTER), false);
  assert.equal(workData.deriveKey(MASTER, 'session', 1).equals(workData.deriveKey(MASTER, 'session', 2)), false);
  // A container re-labelled to another purpose still fails: the derived key and the AAD both move.
  const relabelled = { ...workData.seal(TEXT, MASTER, binding()), purpose: 'memory' };
  fails(() => workData.open(relabelled, MASTER, binding({ purpose: 'memory' })), 'decrypt_failed');
});

test('key generations rotate the key material itself, without losing already sealed history', () => {
  const first = workData.seal(TEXT, MASTER, binding());
  const second = workData.seal(TEXT, MASTER, binding({ generation: 2 }));
  assert.equal(second.keyId, 'work-data-v2.k2');
  fails(() => workData.open(second, MASTER, binding()), 'key_mismatch');
  fails(() => workData.open(first, MASTER, binding({ generation: 2 })), 'key_mismatch');
  // Generation is in the derivation info: relabelling the key id is not enough to reopen old material.
  const relabelled = { ...first, keyId: 'work-data-v2.k2' };
  fails(() => workData.open(relabelled, MASTER, binding({ generation: 2 })), 'decrypt_failed');
  assert.equal(workData.open(second, MASTER, binding({ generation: 2 })), TEXT);
  assert.equal(workData.open(first, MASTER, binding()), TEXT);
  assert.equal(workData.keyId(1), 'work-data-v2.k1');
  fails(() => workData.keyId(0), 'generation_invalid');
  fails(() => workData.keyId(100), 'generation_invalid');
});

test('a v1 container is refused even when its envelope was produced with the same key', () => {
  const key = workData.deriveKey(MASTER, 'session');
  const envelope = core.seal(TEXT, key, { instanceId: INSTANCE, purpose: 'session', recordId: 'turn-1' }, 'work-data-v2.k1');
  const legacy = { version: 1, keyId: 'work-data-v2.k1', purpose: 'session', instanceId: INSTANCE, schema: 1, scopeId: 'scope-1', recordId: 'turn-1', seq: 0, envelope };
  fails(() => workData.open(legacy, MASTER, binding()), 'format_unsupported');
  // A v1 container with an extra field is not a v2 container either.
  fails(() => workData.open({ ...legacy, version: 2, extra: true }, MASTER, binding()), 'envelope_invalid');
  // Re-versioned but still v1 AAD: the optional extra binding tightens authentication, so it fails.
  fails(() => workData.open({ ...legacy, version: 2 }, MASTER, binding()), 'decrypt_failed');
});

test('no implicit key: a missing or short master is rejected and the module cannot persist anything', () => {
  for (const master of [undefined, Buffer.alloc(0), Buffer.alloc(31), crypto.randomBytes(33), MASTER.toString('hex')]) {
    fails(() => workData.seal(TEXT, master, binding()), 'key_invalid');
    fails(() => workData.deriveKey(master, 'session'), 'key_invalid');
  }
  assert.equal(/require\(['"]node:fs['"]\)|atomicWriteJson|DurableJsonStore|node:path/.test(moduleSource), false);
});

test('frozen purposes and numeric binding limits are enforced before any crypto runs', () => {
  assert.equal(Object.isFrozen(workData.PURPOSES), true);
  assert.deepEqual(Array.from(workData.PURPOSES), ['session', 'memory', 'queue', 'task', 'workflow', 'search-index', 'cache', 'backup', 'audit', 'migration', 'user-config']);
  fails(() => workData.seal(TEXT, MASTER, binding({ purpose: 'sessions' })), 'purpose_invalid');
  fails(() => workData.seal(TEXT, MASTER, binding({ purpose: '' })), 'purpose_invalid');
  fails(() => workData.seal(TEXT, MASTER, binding({ schema: -1 })), 'schema_invalid');
  fails(() => workData.seal(TEXT, MASTER, binding({ schema: 1.5 })), 'schema_invalid');
  fails(() => workData.seal(TEXT, MASTER, binding({ seq: -1 })), 'seq_invalid');
  fails(() => workData.seal(TEXT, MASTER, binding({ generation: 100 })), 'generation_invalid');
  fails(() => workData.seal(TEXT, MASTER, binding({ instanceId: '../escape' })), 'binding_invalid');
  fails(() => workData.seal(TEXT, MASTER, null), 'binding_invalid');
  fails(() => workData.seal(42, MASTER, binding()), 'text_required');
  fails(() => workData.seal('x'.repeat(workData.MAX_PLAINTEXT + 1), MASTER, binding()), 'text_limit');
});

test('privacy core keeps the v1 AAD bytes when no extra binding is supplied', () => {
  const key = crypto.randomBytes(32), base = { instanceId: INSTANCE, purpose: 'session', recordId: 'turn-1' };
  const plain = core.seal(TEXT, key, base, 'k1');
  assert.equal(core.open(plain, key, base, 'k1'), TEXT);
  assert.throws(() => core.open(plain, key, { ...base, extra: [1] }, 'k1'), error => error.code === 'privacy.decrypt_failed');
  const bound = core.seal(TEXT, key, { ...base, extra: [1, 'scope-1', 0] }, 'k1');
  assert.equal(core.open(bound, key, { ...base, extra: [1, 'scope-1', 0] }, 'k1'), TEXT);
  assert.throws(() => core.open(bound, key, { ...base, extra: [2, 'scope-1', 0] }, 'k1'), error => error.code === 'privacy.decrypt_failed');
  assert.throws(() => core.seal(TEXT, key, { ...base, extra: [1, '../x', 0] }, 'k1'), error => error.code === 'privacy.identity_invalid');
  assert.throws(() => core.seal(TEXT, key, { ...base, extra: [1.5] }, 'k1'), error => error.code === 'privacy.binding_invalid');
});
