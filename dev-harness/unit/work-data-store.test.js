'use strict';
// M3-2: the managed record store must (a) keep the on-disk bytes identical while the switch is off,
// (b) never create a key on a read/write, (c) seal whole records when enabled, and (d) treat an
// unauthenticatable container as a hard error instead of an empty record. Legacy "bad plaintext
// means empty plus a diagnostic" behaviour has to survive.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock } = require('../lib/source-slice');
// The real writer is loaded from server.js below; isolate the data root before that happens.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdstore-home-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const source = [read('01h-privacy-core.js'), constBlock(read('01n-work-data-crypto.js'), 'WorkDataCrypto'),
  constBlock(read('01o-work-data-keys.js'), 'WorkDataKeys'), constBlock(read('01p-work-data-store.js'), 'WorkDataStore')].join('\n');
assert.ok(constBlock(read('01p-work-data-store.js'), 'WorkDataStore').length > 2000, 'sliced the whole WorkDataStore declaration');
const { workData, keys, store } = (() => {
  const sandbox = { require, Buffer, console };
  sandbox.atomicWriteJson = async (file, value) => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  };
  vm.createContext(sandbox);
  return vm.runInContext(source + '\n({workData:WorkDataCrypto,keys:WorkDataKeys,store:WorkDataStore})', sandbox);
})();

// Same shape as the credential-vault test's fake: DPAPI stands in for a wrapping key we control, and
// the key state lives in memory so a second instance behaves like a fresh process.
function fixture({ enabled = false } = {}) {
  const wrappingKey = crypto.randomBytes(32);
  let state = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdstore-'));
  const protector = {
    supported: () => true,
    run: async (op, value, entropy) => {
      if (op === 'protect') {
        const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, nonce);
        cipher.setAAD(entropy);
        return Buffer.concat([nonce, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
      }
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, value.subarray(0, 12));
      decipher.setAAD(entropy); decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]);
    },
  };
  const keyStore = { read: async () => JSON.parse(JSON.stringify(state || keys.empty())), write: async value => { state = JSON.parse(JSON.stringify(value)); } };
  const flags = { enabled };
  // Production shape: 02-session-store wires enabled to a Promise (readConfig().then(...)), so the
  // stub is async too — an async/sync mismatch here is exactly what hid a blocking bug before.
  const keyApi = () => keys.create({ store: keyStore, protector, enabled: async () => flags.enabled });
  const atomicWriteJson = async (file, value) => { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8'); };
  const corrupts = [];
  const recordStore = ({ name = 'record.json', recordId = 'sess_test', prepare, defaultValue } = {}) => store.create({
    file: () => path.join(dir, name), purpose: 'session', schema: 1, scopeId: 'sessions', recordId,
    keys: keyApi(), writeJson: (file, value) => atomicWriter()(file, value),
    // Async here too: the adapter must await the switch, not compare it to true.
    enabled: async () => flags.enabled, prepare, defaultValue, onCorrupt: error => corrupts.push(String(error && error.code || error)),
  });
  return { dir, flags, keyApi, recordStore, corrupts, state: () => state, file: name => path.join(dir, name),
    setEnabled: value => { flags.enabled = value; } };
}
const prepare = value => {
  // Mirrors the real scratchpad prepare: reject a non-object root so the legacy shape path is exercised.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('shape'), { code: 'session_scratchpad.shape' });
  return { schema: 1, updatedAt: String(value.updatedAt || ''), entries: Array.isArray(value.entries) ? value.entries : [] };
};
const fallback = () => ({ schema: 1, updatedAt: '', entries: [] });
// vm objects come from another realm: compare their JSON shape, not their prototypes.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
// Byte-for-byte claims must use the product's writer, not a look-alike stub.
let internalsCache = null;
const internals = () => internalsCache || (internalsCache = require('../lib/server-internals').loadServerInternals(['atomicWriteJson', 'applyConfigPatch']));
const atomicWriter = () => internals().atomicWriteJson;
const SAMPLE = { schema: 1, updatedAt: '2026-10-22T00:00:00.000Z', entries: [{ key: 'a', text: '中文草稿 🙂', at: '2026-10-22T00:00:00.000Z' }] };

test('switch off: bytes are exactly the legacy pretty JSON, and no key is ever created', async () => {
  const f = fixture();
  const rec = f.recordStore({ prepare, defaultValue: fallback });
  await rec.write(SAMPLE);
  const text = await fsp.readFile(f.file('record.json'), 'utf8');
  assert.equal(text, JSON.stringify(prepare(SAMPLE), null, 2));
  const reference = path.join(f.dir, 'reference.json');
  await atomicWriter()(reference, prepare(SAMPLE));
  assert.equal(text, await fsp.readFile(reference, 'utf8'), 'the disabled path must match the real writer byte for byte');
  assert.equal(text.includes('workData'), false);
  same(await rec.read(), prepare(SAMPLE));
  assert.equal(f.state(), null, 'a disabled store must not create a key envelope');
  assert.equal(fs.existsSync(f.file('record.json')) && fs.existsSync(path.join(f.dir, 'work-data-key-v1.json')), false);
});

test('switch on: the record is sealed, round-trips, and the key envelope lives in its own file', async () => {
  const f = fixture({ enabled: true });
  const key = await f.keyApi().ensure();
  assert.equal(key.length, 32);
  assert.equal(f.state().schema, 1);
  assert.match(f.state().instanceId, /^[a-f0-9]{32}$/);
  const rec = f.recordStore({ prepare, defaultValue: fallback });
  await rec.write(SAMPLE);
  const text = await fsp.readFile(f.file('record.json'), 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.workData, 2);
  assert.equal(text.includes('中文草稿'), false);
  assert.equal(typeof parsed.envelope.ciphertext, 'string');
  same(await rec.read(), prepare(SAMPLE));
});

// Regression: production wires `enabled` to a Promise. Before the await fix this whole path reported
// `work_data_key.disabled` and the switch could never take effect.
test('an async enabled() (the production shape) still unlocks and seals', async () => {
  const f = fixture({ enabled: true });
  const key = await f.keyApi().ensure();
  assert.equal(key.length, 32);
  assert.equal((await f.keyApi().status()).enabled, true);
  const rec = f.recordStore({ prepare, defaultValue: fallback });
  await rec.write(SAMPLE);
  assert.equal(JSON.parse(await fsp.readFile(f.file('record.json'), 'utf8')).workData, 2);
  same(await rec.read(), prepare(SAMPLE));
});

test('enabled without a key refuses to write and never falls back to plaintext', async () => {
  const f = fixture({ enabled: true });
  const rec = f.recordStore({ prepare, defaultValue: fallback });
  await assert.rejects(() => rec.write(SAMPLE), error => error.code === 'work_data_key.absent');
  assert.equal(fs.existsSync(f.file('record.json')), false);
});

test('an unauthenticatable container is a hard error, never an empty record', async () => {
  const f = fixture({ enabled: true });
  await f.keyApi().ensure();
  const rec = f.recordStore({ prepare, defaultValue: fallback });
  await rec.write(SAMPLE);
  const file = f.file('record.json');
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  const bytes = Buffer.from(parsed.envelope.ciphertext, 'base64');
  bytes[0] ^= 0xff;
  parsed.envelope.ciphertext = bytes.toString('base64');
  await fsp.writeFile(file, JSON.stringify(parsed, null, 2), 'utf8');
  await assert.rejects(() => rec.read(), error => String(error.code).startsWith('work_data.'));
  // A second family pointing at the same file must not open it either (record binding).
  const other = f.recordStore({ prepare, defaultValue: fallback, recordId: 'sess_other' });
  await rec.write(SAMPLE);
  await assert.rejects(() => other.read(), error => String(error.code).startsWith('work_data.'));
});

test('the container is bound to its instance: another key set cannot open it', async () => {
  const first = fixture({ enabled: true });
  await first.keyApi().ensure();
  const rec = first.recordStore({ prepare, defaultValue: fallback });
  await rec.write(SAMPLE);
  const second = fixture({ enabled: true });
  await second.keyApi().ensure();
  const moved = second.recordStore({ prepare, defaultValue: fallback });
  await fsp.copyFile(first.file('record.json'), second.file('record.json'));
  await assert.rejects(() => moved.read(), error => String(error.code).startsWith('work_data.'));
});

test('legacy plaintext stays readable after the switch flips, and bad plaintext keeps the old contract', async () => {
  const f = fixture();
  await f.recordStore({ prepare, defaultValue: fallback }).write(SAMPLE);
  f.setEnabled(true);
  await f.keyApi().ensure();
  const enabled = f.recordStore({ prepare, defaultValue: fallback });
  same(await enabled.read(), prepare(SAMPLE), 'a plaintext record written before enabling is still readable');
  await fsp.writeFile(f.file('record.json'), '{ not json', 'utf8');
  same(await enabled.read(), fallback());
  assert.equal(f.corrupts.length, 1);
  assert.match(f.corrupts[0], /^SyntaxError/);
  await fsp.writeFile(f.file('record.json'), JSON.stringify([1, 2, 3]), 'utf8');
  same(await enabled.read(), fallback());
  assert.equal(f.corrupts.length, 2);
  assert.equal(f.corrupts[1], 'session_scratchpad.shape');
});

test('reads never create a key, and a fresh process re-unlocks the persisted envelope', async () => {
  const f = fixture({ enabled: true });
  const rec = f.recordStore({ prepare, defaultValue: fallback });
  same(await rec.read(), fallback());
  assert.equal(f.state(), null, 'reading a missing record must not create a key');
  await f.keyApi().ensure();
  await rec.write(SAMPLE);
  const freshProcess = f.recordStore({ prepare, defaultValue: fallback });   // new WorkDataKeys instance, empty cache
  same(await freshProcess.read(), prepare(SAMPLE));
});

// The switch changes the on-disk format and the key lifecycle, so the generic config patch must not
// flip it (M3-3 owns the local setup flow) and a normal patch must not create a key envelope.
test('the generic config patch cannot flip the work-data switch', async () => {
  const patch = internals().applyConfigPatch;
  await assert.rejects(() => patch({ workDataEncryptionV1: true }),
    error => error.code === 'work_data.encryption_requires_setup' && error.statusCode === 409);
  await patch({ theme: 'dark' });
  assert.equal(fs.existsSync(path.join(HOME_DIR, 'work-data-key-v1.json')), false);
});

// Structural lock: the product wiring must stay on the adapter (not a second hand-rolled seal path),
// and the switch must keep coming from config rather than a hard-coded true.
test('the scratchpad family is wired through WorkDataStore behind the config switch', () => {
  const { functionBlock } = require('../lib/source-slice');
  const block = functionBlock(read('02-session-store.js'), 'sessionScratchpadStore');
  assert.ok(block.length > 300, 'sliced sessionScratchpadStore');
  assert.match(block, /WorkDataStore\.create\(/);
  assert.match(block, /workDataEncryptionV1 === true/);
  assert.doesNotMatch(block, /WorkDataCrypto\.seal|DurableJsonStore\.create/);
  const keySet = constBlock(read('02-session-store.js'), 'workDataKeys');
  assert.ok(keySet.length > 200, 'sliced the work-data key set declaration');
  assert.match(keySet, /'work-data-key-v1\.json'/);
  assert.match(keySet, /LocalSecretCrypto/);
  assert.match(block, /writeJson: atomicWriteJson/);
});
