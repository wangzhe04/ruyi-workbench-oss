'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { test } = require('node:test'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/01t-work-data-recovery.js'), 'utf8');
const load = cryptoOverride => vm.runInNewContext(source + '\nWorkDataRecovery;', { Buffer,
  require: name => { assert.ok(['node:crypto', 'node:buffer'].includes(name), 'pure codec cannot access filesystem or host state'); return name === 'node:crypto' && cryptoOverride ? cryptoOverride : require(name); } });
const api = load(), password = 'full recovery synthetic password';
const code = suffix => error => error.code === 'work_data_recovery.' + suffix;
function fixture() {
  return { appVersion: '3.0.1', generation: 2, createdAt: '2026-10-24T00:00:00.000Z', directories: ['sessions', 'empty-folder'],
    keys: [
      { id: 'work-data:one', purpose: 'work-data', instanceId: 'a'.repeat(32), protectedKey: Buffer.from('old-account-work-data-wrap').toString('base64'), master: crypto.randomBytes(32) },
      { id: 'credential:one', purpose: 'credential', instanceId: 'b'.repeat(32), protectedKey: Buffer.from('independent-vault-wrap').toString('base64'), master: crypto.randomBytes(32) },
    ], files: [
      { path: 'sessions/session.json', data: Buffer.from('FULL_PRIVATE_SESSION_秘密'), keyRefs: ['work-data:one'] },
      { path: 'credential-vault-v1.json', data: Buffer.from('PRIVATE_CREDENTIAL_STATE'), keyRefs: ['credential:one'] },
      { path: 'empty.bin', data: Buffer.alloc(0), keyRefs: [] },
    ] };
}
const headerOf = row => ({ kind: row.kind, version: row.version, exportId: row.exportId, kdf: row.kdf, cipher: row.cipher });
function alterPayload(serialized, mutate, recomputeDigest = true) {
  const row = JSON.parse(serialized), derived = crypto.scryptSync(password, Buffer.from(row.kdf.salt, 'base64'), 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const aad = Buffer.from(JSON.stringify(headerOf(row))), decipher = crypto.createDecipheriv('aes-256-gcm', derived, Buffer.from(row.nonce, 'base64'));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.data, 'base64')), decipher.final()]).toString('utf8'));
    mutate(payload);
    if (recomputeDigest) payload.manifestSha256 = crypto.createHash('sha256').update(JSON.stringify(payload.manifest)).digest('hex');
    const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', derived, nonce); cipher.setAAD(aad);
    return JSON.stringify({ ...row, nonce: nonce.toString('base64'), data: Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  } finally { derived.fill(0); }
}

test('full snapshot roundtrip includes versions, empty directories, binary files and independent key envelopes', async () => {
  const input = fixture(), exported = await api.seal(input, password);
  assert.equal(JSON.parse(exported).kind, 'ruyi-work-data-recovery');
  for (const marker of ['FULL_PRIVATE_SESSION', 'PRIVATE_CREDENTIAL_STATE', 'sessions/session.json', input.keys[0].master.toString('base64')]) assert.ok(!exported.includes(marker));
  const opened = await api.open(exported, password);
  try {
    assert.equal(opened.snapshot.appVersion, input.appVersion); assert.equal(opened.snapshot.generation, 2);
    assert.deepEqual([...opened.snapshot.directories], input.directories);
    assert.equal(opened.snapshot.keys.length, 2); assert.equal(opened.snapshot.files.length, 3);
    for (let i = 0; i < 2; i++) {
      assert.equal(opened.snapshot.keys[i].purpose, input.keys[i].purpose);
      assert.ok(opened.snapshot.keys[i].master.equals(input.keys[i].master)); assert.notEqual(opened.snapshot.keys[i].master, input.keys[i].master);
    }
    assert.ok(opened.snapshot.files[0].data.equals(input.files[0].data)); assert.match(opened.manifestSha256, /^[a-f0-9]{64}$/);
  } finally { opened.release(); opened.release(); }
  assert.ok(opened.snapshot.keys.every(key => key.master.equals(Buffer.alloc(32))));
  assert.ok(opened.snapshot.files.every(file => file.data.equals(Buffer.alloc(file.data.length))));
  assert.ok(!input.keys[0].master.equals(Buffer.alloc(32)), 'release cannot erase caller key');
});

test('fresh salt and nonce produce distinct exports of identical snapshot', async () => {
  const input = fixture(), first = JSON.parse(await api.seal(input, password)), second = JSON.parse(await api.seal(input, password));
  assert.notEqual(first.exportId, second.exportId); assert.notEqual(first.nonce, second.nonce); assert.notEqual(first.kdf.salt, second.kdf.salt); assert.notEqual(first.data, second.data);
});

test('wrong password and tampering return no snapshot; a retry with original package remains usable', async () => {
  const input = fixture(), exported = await api.seal(input, password), before = Buffer.from(input.files[0].data);
  await assert.rejects(api.open(exported, 'incorrect recovery password'), code('authentication'));
  for (const field of ['data', 'tag', 'nonce', 'exportId']) {
    const row = JSON.parse(exported); row[field] = (row[field][0] === 'a' ? 'b' : 'a') + row[field].slice(1);
    await assert.rejects(api.open(JSON.stringify(row), password), code('authentication'));
  }
  assert.ok(input.files[0].data.equals(before));
  const opened = await api.open(exported, password); opened.release();
});

test('credential-only package, changed format, unknown parameters and malformed base64 reject before KDF', async () => {
  let derivations = 0;
  const controlled = load({ ...crypto, scrypt: (...args) => { derivations++; return crypto.scrypt(...args); } });
  const exported = await api.seal(fixture(), password);
  for (const mutate of [row => { row.kind = 'ruyi-credential-recovery'; }, row => { row.version = api.VERSION + 1; }, row => { row.kdf.N = 1048576; },
    row => { row.kdf.r = 0; }, row => { row.kdf.extra = 1; }, row => { row.extra = 1; }, row => { row.nonce = 'AAAA'; },
    row => { row.data += '='; }, row => { row.exportId = ['a'.repeat(32)]; }]) {
    const row = JSON.parse(exported); mutate(row); await assert.rejects(controlled.open(JSON.stringify(row), password), code('invalid'));
  }
  assert.equal(derivations, 0);
});

test('portable paths reject traversal, absolute paths, ADS, Windows aliases and duplicate namespace', async () => {
  for (const name of ['../secret', '/absolute', 'a/../b', 'C:/secret', 'a\\b', 'a:ads', 'CON', 'aux.txt', 'a/nul.log', 'CONIN$', 'CONOUT$.txt', 'COM¹.txt', 'LPT²', 'a.', 'a ', 'a//b', 'a/\u0000b', 'a/\ud800']) {
    const input = fixture(); input.files[0].path = name; await assert.rejects(api.seal(input, password), code('path_invalid'));
  }
  for (const mutate of [input => { input.files[1].path = 'SESSIONS/SESSION.JSON'; }, input => { input.directories.push('SESSIONS'); },
    input => { input.files[1].path = 'sessions'; }, input => { input.files[1].path = 'sessions/session.json/child'; }]) {
    const input = fixture(); mutate(input); await assert.rejects(api.seal(input, password), code('path_conflict'));
  }
  const unicodeAlias = fixture(); unicodeAlias.files.push({ path: 'I', data: Buffer.alloc(0), keyRefs: [] }, { path: 'ı', data: Buffer.alloc(0), keyRefs: [] });
  await assert.rejects(api.seal(unicodeAlias, password), code('path_conflict'));
  const missingDirectory = fixture(); missingDirectory.directories = [];
  await assert.rejects(api.seal(missingDirectory, password), code('directory_missing'));
});

test('snapshot validation rejects missing refs, duplicate keys, unknown purposes and malformed master', async () => {
  for (const [mutate, suffix] of [
    [input => { input.files[0].keyRefs = ['not-in-package']; }, 'manifest_invalid'],
    [input => { input.files[0].keyRefs.push('work-data:one'); }, 'manifest_invalid'],
    [input => { input.keys[1].id = input.keys[0].id; }, 'key_invalid'],
    [input => { input.keys[1].purpose = 'network'; }, 'key_invalid'],
    [input => { input.keys[0].master = Buffer.alloc(31); }, 'key_invalid'],
    [input => { input.keys[0].protectedKey = ''; }, 'key_invalid'],
    [input => { input.createdAt = '2026-02-30T00:00:00.000Z'; }, 'manifest_invalid'],
  ]) {
    const input = fixture(); mutate(input); await assert.rejects(api.seal(input, password), code(suffix));
  }
});

test('authenticated malformed payload cannot omit, add, reorder or corrupt manifest entries and keys', async () => {
  const exported = await api.seal(fixture(), password);
  for (const mutate of [
    payload => { payload.files.pop(); }, payload => { payload.files.push(payload.files[0]); }, payload => { payload.files.reverse(); },
    payload => { payload.files[0].data = Buffer.from('other').toString('base64'); }, payload => { payload.manifest.bytes++; },
    payload => { payload.manifest.files[0].sha256 = '0'.repeat(64); }, payload => { payload.manifest.files[0].path = '../outside'; },
    payload => { payload.manifest.files[0].keyRefs = ['missing']; }, payload => { payload.keys.pop(); },
    payload => { payload.keys[0].master = crypto.randomBytes(32).toString('base64'); }, payload => { payload.manifest.keys[0].purpose = 'unknown'; },
    payload => { payload.manifest.files[0].extra = 1; }, payload => { payload.extra = 1; },
  ]) await assert.rejects(api.open(alterPayload(exported, mutate), password), error => /^work_data_recovery\./.test(error.code));
});

test('manifest digest itself is required and authenticated separately from file hashes', async () => {
  const exported = await api.seal(fixture(), password);
  const forged = alterPayload(exported, payload => { payload.manifestSha256 = '0'.repeat(64); }, false);
  await assert.rejects(api.open(forged, password), code('manifest_invalid'));
});

test('host budgets reject before writes or KDF and can explicitly permit a larger snapshot', async () => {
  let derivations = 0;
  const controlled = load({ ...crypto, scrypt: (...args) => { derivations++; return crypto.scrypt(...args); } });
  await assert.rejects(controlled.create({ limits: { bytes: 1 } }).seal(fixture(), password), code('capacity'));
  await assert.rejects(controlled.create({ limits: { files: 1 } }).seal(fixture(), password), code('invalid'));
  await assert.rejects(controlled.create({ limits: { serialized: 10 } }).seal(fixture(), password), code('capacity'));
  assert.equal(derivations, 0);
  assert.equal(api.create({ limits: { bytes: api.LIMITS.bytes + 1 } }).LIMITS.bytes, api.LIMITS.bytes + 1);
  for (const limits of [{ bytes: 0 }, { bytes: -1 }, { bytes: Infinity }, { path: 10 }, { serialized: Number.MAX_SAFE_INTEGER }]) assert.throws(() => api.create({ limits }), code('limits_invalid'));
  const exported = await api.seal(fixture(), password);
  await assert.rejects(api.create({ limits: { serialized: 10 } }).open(exported, password), code('invalid'));
  await assert.rejects(api.create({ limits: { bytes: 1 } }).open(exported, password), code('manifest_invalid'));
});

test('password constraints match the independent credential recovery format', async () => {
  for (const value of ['', 'short', 'x'.repeat(1025), '\ud800'.repeat(12), null]) await assert.rejects(api.seal(fixture(), value), code('password_invalid'));
});

test('seal owns the snapshot before async derivation, without retaining caller key leases', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const controlled = load({ ...crypto, scrypt: (...args) => { entered(); gate.then(() => crypto.scrypt(...args)); } });
  const input = fixture(), original = Buffer.from(input.files[0].data), master = Buffer.from(input.keys[0].master);
  const pending = controlled.seal(input, password); await started;
  input.keys[0].master.fill(0); input.files[0].data.fill(0); input.files[0].keyRefs.length = 0; input.directories.length = 0;
  release(); const exported = await pending, opened = await controlled.open(exported, password);
  try { assert.ok(opened.snapshot.files[0].data.equals(original)); assert.ok(opened.snapshot.keys[0].master.equals(master)); assert.equal(opened.snapshot.files[0].keyRefs.length, 1); assert.equal(opened.snapshot.directories.length, 2); }
  finally { opened.release(); master.fill(0); }
});

test('expensive KDF concurrency is bounded across codec instances and clears after completion', async () => {
  const callbacks = [], controlled = load({ ...crypto, scrypt: (...args) => callbacks.push(args.at(-1)) });
  const first = controlled.seal(fixture(), password), second = controlled.create().seal(fixture(), password);
  await assert.rejects(controlled.create().seal(fixture(), password), code('busy'));
  assert.equal(callbacks.length, 2);
  callbacks.shift()(null, crypto.randomBytes(32)); callbacks.shift()(null, crypto.randomBytes(32)); await Promise.all([first, second]);
  const third = controlled.seal(fixture(), password); callbacks.shift()(null, crypto.randomBytes(32)); await third;
});

test('multi-megabyte binary base64 validation has bounded scans without regexp stack overflow', async () => {
  const input = fixture(); input.files[0].data = crypto.randomBytes(2 * 1024 * 1024);
  const exported = await api.seal(input, password), opened = await api.open(exported, password);
  try { assert.ok(opened.snapshot.files[0].data.equals(input.files[0].data)); } finally { opened.release(); }
});
