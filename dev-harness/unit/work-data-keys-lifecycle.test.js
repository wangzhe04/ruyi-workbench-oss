'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), vm = require('node:vm');
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const text = fs.readFileSync(process.env.RUYI_KEYS_CANDIDATE || path.resolve(__dirname, '../../ruyi-workbench/app/src/01o-work-data-keys.js'), 'utf8');
const loadKeyApi = cryptoOverride => vm.runInNewContext(text + '\nWorkDataKeys;', { require: name => name === 'node:crypto' && cryptoOverride ? cryptoOverride : require(name), Buffer, console });
const api = loadKeyApi();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-key-lifecycle-unit-'));
after(() => { assert.ok(path.basename(root).startsWith('ruyi-key-lifecycle-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(native = api) {
  const flags = { enabled: true, header: native.empty(), protect: 0, unprotect: 0, writes: 0 }, wrapping = crypto.randomBytes(32);
  const protector = { supported: () => true, run: async (op, value, entropy) => {
    if (op === 'protect') {
      flags.lastProtectInput = value; flags.lastProtectEntropy = entropy; flags.protect++; if (flags.enterProtect) flags.enterProtect(); if (flags.protectGate) await flags.protectGate;
      if (flags.throwProtect) throw new Error('synthetic protect failure');
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrapping, nonce); cipher.setAAD(entropy);
      return (flags.lastWrapped = Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]));
    }
    flags.unprotect++; if (flags.enterUnprotect) flags.enterUnprotect(); if (flags.unprotectGate) await flags.unprotectGate;
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrapping, value.subarray(0, 12)); decipher.setAAD(entropy); decipher.setAuthTag(value.subarray(-16));
    return (flags.lastUnprotected = Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]));
  } };
  const store = { read: async () => clone(flags.header), write: async value => { flags.writes++; if (flags.failWrite) throw new Error('synthetic key write failure'); flags.header = clone(value); } };
  const keys = native.create({ store, protector, enabled: async () => flags.enabled });
  const replace = async key => { const protectedKey = await protector.run('protect', key, Buffer.from('ruyi.work-data.v1:' + flags.header.instanceId)); flags.header = { ...flags.header, protectedKey: protectedKey.toString('base64') }; protectedKey.fill(0); };
  return { flags, protector, keys, replace, close: () => { keys.clear(); wrapping.fill(0); } };
}

test('same instance with replaced wrapped key must invalidate the master cache', async () => {
  const f = fixture(); try {
    const old = await f.keys.ensure(), oldHex = old.toString('hex'), replacement = crypto.randomBytes(32);
    await f.replace(replacement); const unlocked = await f.keys.unlock();
    console.log('same-instance replacement observed stale=' + (unlocked.toString('hex') === oldHex) + ' unprotect=' + f.flags.unprotect);
    assert.ok(unlocked.equals(replacement), 'replaced wrapped master is the only unlocked authority');
    replacement.fill(0); unlocked.fill(0); old.fill(0);
  } finally { f.close(); }
});

test('clear while 01p awaits instance must not zero the operation master and persist unreadable ciphertext', async () => {
  const f = fixture(), fx = loadWorkDataChunks(), file = path.join(root, 'clear-race.json');
  try {
    await f.keys.ensure(); const warm = await f.keys.unlock();
    const store = fx.store.createText({ file: () => file, purpose: 'memory', schema: 1, scopeId: 'global', recordId: 'race',
      enabled: async () => true, keys: { unlock: () => f.keys.unlock(), instance: async () => { f.keys.clear(); return f.keys.instance(); } }, writeJson: fx.atomicWriteJson });
    await store.write('PRIVATE_VALID_PAYLOAD');
    console.log('clear zeroed returned cache buffer=' + warm.equals(Buffer.alloc(32)));
    assert.equal(await store.read(), 'PRIVATE_VALID_PAYLOAD'); warm.fill(0);
  } finally { f.close(); }
});

test('concurrent explicit ensure must produce one authoritative key header and independent returned copies', async () => {
  const f = fixture(); try {
    let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    f.flags.protectGate = gate; f.flags.enterProtect = entered;
    const first = f.keys.ensure(), second = f.keys.ensure(); await started; await new Promise(resolve => setImmediate(resolve)); release();
    const values = await Promise.all([first, second]);
    console.log('ensure protects=' + f.flags.protect + ' writes=' + f.flags.writes + ' returnedSame=' + values[0].equals(values[1]));
    assert.equal(f.flags.writes, 1); assert.equal(f.flags.protect, 1); assert.ok(values[0].equals(values[1])); assert.notEqual(values[0], values[1]); values.forEach(value => value.fill(0));
  } finally { f.close(); }
});
test('native snapshot leases are explicit independent owned copies with idempotent own-only release', async () => {
  const f = fixture(); try {
    const seed = await f.keys.ensure(), first = await f.keys.snapshot(), second = await f.keys.snapshot();
    assert.ok(Object.isFrozen(first)); assert.deepEqual(Object.keys(first).sort(), ['instanceId', 'key', 'release']); assert.equal(first.instanceId, f.flags.header.instanceId); assert.ok(first.key.equals(seed)); assert.notEqual(first.key, second.key);
    first.release(); first.release(); assert.ok(first.key.equals(Buffer.alloc(32))); assert.ok(second.key.equals(seed));
    f.keys.clear(); assert.ok(second.key.equals(seed)); assert.ok(!seed.equals(Buffer.alloc(32)));
    second.release(); assert.ok(second.key.equals(Buffer.alloc(32))); const after = await f.keys.unlock(); assert.ok(after.equals(seed));
    after.fill(0); seed.fill(0);
  } finally { f.close(); }
});

test('all unlock and ensure return paths own their Buffer and cannot alter the cache or another caller', async () => {
  const f = fixture(); try {
    const seed = await f.keys.ensure(), expected = Buffer.from(seed), hit = await f.keys.unlock(), ensured = await f.keys.ensure();
    assert.notEqual(seed, hit); assert.notEqual(hit, ensured); hit.fill(0); seed.fill(0);
    assert.ok(ensured.equals(expected)); const next = await f.keys.unlock(); assert.ok(next.equals(expected));
    f.keys.clear(); assert.ok(next.equals(expected)); assert.ok(ensured.equals(expected)); next.fill(0); ensured.fill(0); expected.fill(0);
  } finally { f.close(); }
});

test('clear during unprotect does not repopulate the cache or zero the already-started lease', async () => {
  const f = fixture(); try {
    const seed = await f.keys.ensure(); f.keys.clear();
    let entered, release; const started = new Promise(resolve => { entered = resolve; }); f.flags.enterUnprotect = entered; f.flags.unprotectGate = new Promise(resolve => { release = resolve; });
    const pending = f.keys.snapshot(); await started; f.keys.clear(); release(); const lease = await pending;
    assert.ok(lease.key.equals(seed)); assert.equal(f.flags.unprotect, 1); assert.ok(f.flags.lastUnprotected.equals(Buffer.alloc(32)));
    const next = await f.keys.snapshot(); assert.equal(f.flags.unprotect, 2, 'post-clear completion did not refill cache'); assert.ok(next.key.equals(seed));
    lease.release(); assert.ok(next.key.equals(seed)); next.release(); seed.fill(0);
  } finally { f.close(); }
});

test('same-instance header replacement during unprotect rejects a mixed authority snapshot and zeroes the rejected master', async () => {
  const f = fixture(); try {
    const seed = await f.keys.ensure(); f.keys.clear();
    let entered, release; const started = new Promise(resolve => { entered = resolve; }); f.flags.enterUnprotect = entered; f.flags.unprotectGate = new Promise(resolve => { release = resolve; });
    const pending = f.keys.snapshot(); await started; const replacement = crypto.randomBytes(32); await f.replace(replacement); release();
    await assert.rejects(pending, { code: 'work_data_key.changed' }); assert.ok(f.flags.lastUnprotected.equals(Buffer.alloc(32)));
    const current = await f.keys.snapshot(); assert.ok(current.key.equals(replacement)); current.release(); seed.fill(0); replacement.fill(0);
  } finally { f.close(); }
});

test('failed ensure zeroes temporaries and the serial tail permits a clean explicit retry', async () => {
  for (const failure of ['throwProtect', 'failWrite']) {
    const f = fixture(); try {
      f.flags[failure] = true;
      await assert.rejects(f.keys.ensure(), { code: failure === 'throwProtect' ? 'work_data_key.protect_failed' : 'work_data_key.unavailable' });
      assert.ok(f.flags.lastProtectInput.equals(Buffer.alloc(32))); assert.ok(f.flags.lastProtectEntropy.equals(Buffer.alloc(f.flags.lastProtectEntropy.length)));
      if (f.flags.lastWrapped) assert.ok(f.flags.lastWrapped.equals(Buffer.alloc(f.flags.lastWrapped.length)));
      assert.equal(f.flags.header.instanceId, ''); f.flags[failure] = false;
      const value = await f.keys.ensure(), same = await f.keys.unlock(); assert.ok(value.equals(same)); assert.equal(f.flags.protect, 2);
      value.fill(0); same.fill(0);
    } finally { f.close(); }
  }
});

test('no read implicitly creates keys and OFF plaintext store paths perform no unlock/protector work', async () => {
  const f = fixture(), fx = loadWorkDataChunks(), file = path.join(root, 'off-plaintext.json');
  try {
    f.flags.enabled = false;
    await assert.rejects(f.keys.ensure(), { code: 'work_data_key.disabled' }); await assert.rejects(f.keys.snapshot(), { code: 'work_data_key.absent' }); await assert.rejects(f.keys.unlock(), { code: 'work_data_key.absent' });
    const store = fx.store.createText({ file: () => file, purpose: 'memory', schema: 1, scopeId: 'global', recordId: 'off', enabled: async () => false, keys: f.keys, writeJson: fx.atomicWriteJson });
    await store.write('OFF_EXACT_TEXT'); assert.equal(await store.read(), 'OFF_EXACT_TEXT'); assert.equal(fs.readFileSync(file, 'utf8'), 'OFF_EXACT_TEXT');
    assert.equal(f.flags.protect, 0); assert.equal(f.flags.unprotect, 0); assert.equal(f.flags.writes, 0); assert.equal(f.flags.header.instanceId, '');
  } finally { f.close(); }
});

test('turning OFF preserves already-sealed read capability without new key creation', async () => {
  const f = fixture(); try {
    const seed = await f.keys.ensure(); f.keys.clear(); f.flags.enabled = false;
    const lease = await f.keys.snapshot(); assert.ok(lease.key.equals(seed)); assert.equal(f.flags.protect, 1); assert.equal(f.flags.writes, 1);
    lease.release(); seed.fill(0); await assert.rejects(f.keys.ensure(), { code: 'work_data_key.disabled' });
  } finally { f.close(); }
});
test('a warm cache cannot survive malformed or unauthenticatable replacement headers', async () => {
  const f = fixture(); try {
    const seed = await f.keys.ensure(), original = clone(f.flags.header);
    f.flags.header = { ...original, protectedKey: 'AAAA' };
    await assert.rejects(f.keys.snapshot(), { code: 'work_data_key.decrypt_failed' });
    f.flags.header = original; const current = await f.keys.snapshot(); assert.ok(current.key.equals(seed)); assert.equal(f.flags.unprotect, 2); current.release();
    f.flags.header = { ...original, schema: 99 };
    await assert.rejects(f.keys.snapshot(), { code: 'work_data_key.invalid' });
    f.flags.header = original; const afterInvalid = await f.keys.snapshot(); assert.ok(afterInvalid.key.equals(seed)); assert.equal(f.flags.unprotect, 3); afterInvalid.release(); seed.fill(0);
  } finally { f.close(); }
});
test('instance-id random failure zeroes the already-generated master and does not poison ensure retry', async () => {
  let firstMaster, failOnce = true;
  const faulty = loadKeyApi({ ...crypto, randomBytes: size => {
    if (size === 16 && failOnce) { failOnce = false; throw new Error('synthetic instance random failure'); }
    const value = crypto.randomBytes(size); if (size === 32 && !firstMaster) firstMaster = value; return value;
  } });
  const f = fixture(faulty); try {
    await assert.rejects(f.keys.ensure(), /synthetic instance random failure/);
    assert.ok(firstMaster.equals(Buffer.alloc(32))); assert.equal(f.flags.writes, 0); assert.equal(f.flags.protect, 0); assert.equal(f.flags.header.instanceId, '');
    const retry = await f.keys.ensure(); assert.ok(!retry.equals(Buffer.alloc(32))); assert.equal(f.flags.writes, 1); assert.equal(f.flags.protect, 1);
    assert.ok(firstMaster.equals(Buffer.alloc(32))); retry.fill(0);
  } finally { f.close(); }
});