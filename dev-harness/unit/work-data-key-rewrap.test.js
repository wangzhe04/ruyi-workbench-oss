'use strict';
// 150 W6: WorkDataKeys.probe classification, the boot refusal table, the recovery-package rewrap
// orchestrator (01o WorkDataKeyRewrap) and the guidance text (13 workDataKeyGuidance).
// Real product code via server-internals; a synthetic per-"account" protector stands in for DPAPI
// (account B cannot open account A's blobs, exactly like a reinstall/new machine). The header and
// sealed-record IO and the AEAD record authentication are the product host's own functions
// (workDataKeyRewrapHost) on a temporary data directory; only keys/staging/vault are swapped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { releaseEnvironment } = require('../lib/release-checks');
const tempParent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(tempParent, 'ruyi-key-rewrap-unit-'));
const data = path.join(root, 'data');
fs.mkdirSync(data, { recursive: true });
const env = releaseEnvironment(path.join(root, 'home'), data), reverseServer = process.env.RUYI_TEST_SERVER_JS;
for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
Object.assign(process.env, env);
if (reverseServer) process.env.RUYI_TEST_SERVER_JS = reverseServer; // reverse verification against a pre-fix build
const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['WorkDataKeys', 'WorkDataKeyRewrap', 'WorkDataRecovery', 'WorkDataCrypto', 'workDataKeyRewrapHost', 'workDataKeyGuidance', 'workDataRewrapPasswordFromBytes', 'paths']);
test.after(() => { assert.equal(path.dirname(root), tempParent); fs.rmSync(root, { recursive: true, force: true }); });

const PASSWORD = 'synthetic-unit-' + crypto.randomBytes(9).toString('hex');
function account(options = {}) {
  const secret = crypto.randomBytes(32), log = [];
  return { log, transient: false, failNext: 0, supported: () => options.supported !== false,
    async run(op, bytes, entropy) {
      log.push(op);
      if (this.failNext > 0) { this.failNext--; throw Object.assign(new Error('local_crypto.process_timeout'), { code: 'local_crypto.process_timeout' }); }
      if (this.transient) throw Object.assign(new Error('local_crypto.process_timeout'), { code: 'local_crypto.process_timeout' });
      const key = crypto.createHash('sha256').update(secret).update(entropy).digest();
      if (op === 'protect') {
        const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), body]);
      }
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      } catch { throw Object.assign(new Error('local_crypto.decrypt_failed'), { code: 'local_crypto.decrypt_failed' }); }
    } };
}
const headerFile = () => path.join(api.paths.data, 'work-data-key-v1.json');
const readHeader = () => { try { return fs.readFileSync(headerFile()); } catch { return null; } };
async function fresh() {
  for (const entry of await fsp.readdir(data)) await fsp.rm(path.join(data, entry), { recursive: true, force: true });
  await fsp.mkdir(path.join(data, 'sessions'), { recursive: true });
}
function keysOver(protector, readHook) {
  return api.WorkDataKeys.create({ protector, enabled: () => false, store: { read: async () => {
    if (readHook) await readHook();
    const bytes = readHeader(); if (!bytes) return api.WorkDataKeys.empty(); return JSON.parse(bytes.toString('utf8'));
  } } });
}
// A root created under account A: header + n sealed v2 records on disk.
async function rootUnder(a, { records = 2 } = {}) {
  await fresh();
  const staged = await keysOver(a).stageNew();
  fs.writeFileSync(headerFile(), JSON.stringify(staged.header));
  const master = Buffer.from(staged.lease.key), instanceId = staged.header.instanceId; staged.lease.release();
  for (let i = 0; i < records; i++) {
    const container = api.WorkDataCrypto.seal(JSON.stringify({ id: 'sess_' + i, private: 'synthetic ' + i }), master,
      { purpose: 'session', instanceId, schema: 1, scopeId: 'sessions', recordId: 'sess_' + i, seq: 0, generation: 1 });
    fs.writeFileSync(path.join(data, 'sessions', 'sess_' + i + '.json'), JSON.stringify({ workData: 2, ...container }));
  }
  return { master, instanceId, header: staged.header };
}
async function packageOf(keys, password = PASSWORD, { files = [], auxiliaries = [] } = {}) {
  return api.WorkDataRecovery.seal({ appVersion: '3.1.0', generation: 1, createdAt: new Date().toISOString(), directories: [], files, auxiliaries,
    keys: keys.map(key => ({ id: key.purpose + ':' + key.instanceId, purpose: key.purpose, instanceId: key.instanceId, protectedKey: 'AAAA', master: key.master })) }, password);
}
function hostFor(protector, { encrypted = 'manifest', vault = null, bots, fault = null, writeFault = null } = {}) {
  const product = api.workDataKeyRewrapHost(), calls = { open: 0 };
  return { calls, host: { ...product, keys: keysOver(protector), freshKeys: () => keysOver(protector),
    stage: value => keysOver(protector).stageRecovered(value), encrypted: async () => encrypted, vault, ...(bots ? { bots } : {}),
    openPackage: (serialized, password) => { calls.open++; return api.WorkDataRecovery.open(serialized, password); },
    writeHeaderBytes: async bytes => { if (writeFault) await writeFault(bytes); return product.writeHeaderBytes(bytes); },
    fault: point => { if (point === fault) throw Object.assign(new Error('work_data_key.rewrap_test_fault'), { code: 'work_data_key.rewrap_test_fault' }); } } };
}
const rewrapWith = (protector, options, input) => { const { host, calls } = hostFor(protector, options); return { calls, run: api.WorkDataKeyRewrap.create(host).rewrap(input) }; };
async function unlocksUnder(protector, master, instanceId) {
  const lease = await keysOver(protector).snapshot();
  try { assert.equal(lease.instanceId, instanceId); assert.ok(lease.key.equals(master)); } finally { lease.release(); }
}

test('probe classifies healthy, locked, unavailable, damaged, absent and unsupported headers without creating a key', async () => {
  const a = account(), b = account();
  await rootUnder(a);
  assert.equal((await keysOver(a).probe()).status, 'healthy');
  assert.equal((await keysOver(b).probe()).status, 'locked');
  const busy = account(); busy.transient = true;
  assert.equal((await keysOver(busy).probe()).status, 'unavailable');
  fs.writeFileSync(headerFile(), '{broken');
  assert.equal((await keysOver(a).probe()).status, 'damaged');
  fs.unlinkSync(headerFile());
  assert.equal((await keysOver(a).probe()).status, 'absent');
  assert.equal(readHeader(), null);
  assert.equal((await keysOver(account({ supported: false })).probe()).status, 'unsupported');
});

test('probe: a timed-out first unlock that succeeds on retry is healthy and warms the cache; a busy header read is not damage', async () => {
  const a = account(); await rootUnder(a);
  const keys = keysOver(a);
  a.failNext = 1;
  assert.equal((await keys.probe()).status, 'healthy', 'cold PowerShell start timed out once, the key itself is fine');
  const calls = a.log.length; (await keys.snapshot()).release();
  assert.equal(a.log.length, calls, 'the retried unlock warmed the snapshot cache: no further DPAPI call');
  const busy = keysOver(a, async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); });
  assert.equal((await busy.probe()).status, 'unavailable', 'EBUSY/EACCES on the header read is "not read this time"');
  fs.writeFileSync(headerFile(), JSON.stringify({ schema: 1, instanceId: 'not-hex', protectedKey: 'AAAA' }));
  assert.equal((await keysOver(a).probe()).status, 'damaged', 'an invalid header shape is settled damage');
});

test('boot inspect never probes a plain root and reports unavailable without refusing', async () => {
  const a = account(); await rootUnder(a); const calls = a.log.length;
  const plain = await api.WorkDataKeyRewrap.create({ keys: keysOver(a), encrypted: async () => false }).inspect();
  assert.deepEqual({ ...plain }, { refusal: null, status: 'plain' }); assert.equal(a.log.length, calls, 'a plain root with a leftover header pays no DPAPI call at boot');
  const busy = account(); busy.transient = true;
  const slow = await api.WorkDataKeyRewrap.create({ keys: keysOver(busy), encrypted: async () => 'manifest' }).inspect();
  assert.equal(slow.refusal, null); assert.equal(slow.status, 'unavailable');
  const locked = await api.WorkDataKeyRewrap.create({ keys: keysOver(account()), encrypted: async () => 'manifest' }).inspect();
  assert.equal(locked.refusal?.code, 'work_data_key.rewrap_required');
});

test('sealed-record proof: a corrupt minority is reported, not blocking; undecidable samples count neither way', async () => {
  const a = account(), b = account();
  const root0 = await rootUnder(a, { records: 5 });
  const rot = file => { const row = JSON.parse(fs.readFileSync(file, 'utf8')); const env = row.envelope; const key = Object.keys(env).find(k => /cipher/i.test(k));
    const bytes = Buffer.from(env[key], 'base64'); bytes[0] ^= 1; env[key] = bytes.toString('base64'); fs.writeFileSync(file, JSON.stringify(row)); };
  rot(path.join(data, 'sessions', 'sess_0.json'));
  const serialized = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }]);
  const result = await rewrapWith(b, {}, { serialized, password: PASSWORD }).run;
  assert.equal(result.workDataKey, 'rewrapped'); assert.equal(result.unreadableRecords, 1); assert.equal(result.proof, undefined);
  assert.equal(result.previousHeaderKept, true, 'a proof with failing records keeps the replaced header as a side copy');
  await unlocksUnder(b, root0.master, root0.instanceId);
  // Majority unreadable: the package key is not shown to open this root.
  const root1 = await rootUnder(a, { records: 3 });
  for (const i of [0, 1]) rot(path.join(data, 'sessions', 'sess_' + i + '.json'));
  const before = readHeader();
  await assert.rejects(rewrapWith(b, {}, { serialized: await packageOf([{ purpose: 'work-data', instanceId: root1.instanceId, master: root1.master }]), password: PASSWORD }).run,
    { code: 'work_data_key.rewrap_package_mismatch' });
  assert.deepEqual(readHeader(), before);
  // A tie (one record authenticates, one fails) is refused: one planted record must not outvote nothing.
  const rootTie = await rootUnder(a, { records: 2 });
  rot(path.join(data, 'sessions', 'sess_0.json'));
  const beforeTie = readHeader();
  await assert.rejects(rewrapWith(b, {}, { serialized: await packageOf([{ purpose: 'work-data', instanceId: rootTie.instanceId, master: rootTie.master }]), password: PASSWORD }).run,
    { code: 'work_data_key.rewrap_package_mismatch' });
  assert.deepEqual(readHeader(), beforeTie);
  // Malformed samples (no decidable AEAD) must not hide a forged master behind a "proof".
  const root2 = await rootUnder(a, { records: 3 });
  for (const i of [0, 1, 2]) { const file = path.join(data, 'sessions', 'sess_' + i + '.json'); const row = JSON.parse(fs.readFileSync(file, 'utf8')); row.keyId = 'bogus'; fs.writeFileSync(file, JSON.stringify(row)); }
  const forged = await rewrapWith(b, {}, { serialized: await packageOf([{ purpose: 'work-data', instanceId: root2.instanceId, master: crypto.randomBytes(32) }]), password: PASSWORD }).run;
  assert.equal(forged.proof, 'instance-id'); assert.equal(forged.previousHeaderKept, true);
});

test('instanceId-only proof keeps the replaced header as a side copy; a rollback removes the copy it made', async () => {
  const a = account(), b = account(), root0 = await rootUnder(a, { records: 0 }), before = readHeader();
  const serialized = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }]);
  const backups = path.join(data, 'key-rewrap-backups'), list = () => { try { return fs.readdirSync(backups); } catch { return []; } };
  await assert.rejects(rewrapWith(b, { fault: 'after-verify' }, { serialized, password: PASSWORD }).run, { code: 'work_data_key.rewrap_test_fault' });
  assert.deepEqual(readHeader(), before); assert.deepEqual(list(), []);
  const result = await rewrapWith(b, {}, { serialized, password: PASSWORD }).run;
  assert.equal(result.proof, 'instance-id'); assert.equal(result.previousHeaderKept, true);
  const kept = list(); assert.equal(kept.length, 1); assert.match(kept[0], /^previous-header-.+\.json$/);
  assert.deepEqual(fs.readFileSync(path.join(backups, kept[0])), before);
  await unlocksUnder(b, root0.master, root0.instanceId);
  // A forged package with no decidable record and no header to compare is refused, not trusted.
  await rootUnder(a, { records: 0 }); fs.unlinkSync(headerFile());
  await assert.rejects(rewrapWith(b, {}, { serialized, password: PASSWORD }).run, { code: 'work_data_key.rewrap_target_unknown' });
});

test('locked external-bot credentials are restaged from the package in the same all-or-nothing replacement', async () => {
  const a = account(), b = account(), root0 = await rootUnder(a);
  const botsPath = path.join(data, 'external-bot-credentials.json');
  const source = { schema: 1, records: [{ binding: { connectionId: 'qq-main', platform: 'qq', appId: 'app', tenantId: 'tenant', botUserId: '' }, revision: crypto.randomBytes(16).toString('hex'), cipher: 'b2xk', present: ['botSecret'] }] };
  const sourceBytes = Buffer.from(JSON.stringify(source)); fs.writeFileSync(botsPath, sourceBytes);
  const portable = Buffer.from(JSON.stringify({ schema: 1, records: [{ ...source.records[0], cipher: undefined, values: { botSecret: 'synthetic-bot-secret' } }] }));
  let locked = true;
  const bots = { readBytes: async () => fs.existsSync(botsPath) ? fs.readFileSync(botsPath) : null,
    writeBytes: async bytes => { if (bytes === null) fs.rmSync(botsPath, { force: true }); else { fs.writeFileSync(botsPath, bytes); locked = !JSON.parse(bytes.toString()).records.every(row => row.cipher === 'bmV3'); } },
    inspect: async () => locked ? 'locked' : 'healthy',
    stage: async ({ bytes, portable: data }) => {
      const state = JSON.parse(bytes.toString()), payload = JSON.parse(data.toString());
      if (payload.records.length !== state.records.length || payload.records.some((row, i) => row.revision !== state.records[i].revision)) throw Object.assign(new Error('external_credentials.recovery_invalid'), { code: 'external_credentials.recovery_invalid' });
      return { state: { ...state, records: state.records.map(row => ({ ...row, cipher: 'bmV3' })) } };
    } };
  const aux = data => ({ files: [{ path: 'external-bot-credentials.json', data: sourceBytes, keyRefs: [] }],
    auxiliaries: [{ type: 'external-bot-credentials', schema: 1, sourcePath: 'external-bot-credentials.json', sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'), data }] });
  const keys = [{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }];
  const headerBefore = readHeader();
  await assert.rejects(rewrapWith(b, { bots, fault: 'after-verify' }, { serialized: await packageOf(keys, PASSWORD, aux(portable)), password: PASSWORD }).run, { code: 'work_data_key.rewrap_test_fault' });
  assert.deepEqual(readHeader(), headerBefore); assert.deepEqual(fs.readFileSync(botsPath), sourceBytes); locked = true;
  // Bots changed after the export (different revision): not restorable, reported, the key still rewrapped.
  const stale = Buffer.from(JSON.stringify({ schema: 1, records: [{ ...JSON.parse(portable).records[0], revision: crypto.randomBytes(16).toString('hex') }] }));
  const partial = await rewrapWith(b, { bots }, { serialized: await packageOf(keys, PASSWORD, aux(stale)), password: PASSWORD }).run;
  assert.equal(partial.workDataKey, 'rewrapped'); assert.equal(partial.externalBotCredentials, 'locked'); assert.deepEqual(fs.readFileSync(botsPath), sourceBytes);
  // Header now healthy under b; only the bots need restaging.
  const result = await rewrapWith(b, { bots }, { serialized: await packageOf(keys, PASSWORD, aux(portable)), password: PASSWORD }).run;
  assert.equal(result.workDataKey, 'healthy'); assert.equal(result.externalBotCredentials, 'rewrapped');
  assert.ok(JSON.parse(fs.readFileSync(botsPath, 'utf8')).records.every(row => row.cipher === 'bmV3'));
});

test('password bytes: UTF-8 BOM, UTF-16LE/BE BOM, CRLF and cmd echo are normalised; spaces are kept verbatim', () => {
  const read = bytes => api.workDataRewrapPasswordFromBytes(bytes);
  const pw = 'synthetic 口令-' + 'x'.repeat(8);
  assert.equal(read(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pw + '\r\n')])), pw);
  assert.equal(read(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(pw + '\r\n', 'utf16le')])), pw);
  const be = Buffer.from(pw + '\r\n', 'utf16le'); be.swap16();
  assert.equal(read(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), pw);
  assert.equal(read(Buffer.from(pw + '\nsecond line')), pw);
  assert.equal(read(Buffer.from(pw)), pw);
  assert.equal(read(Buffer.from(pw + ' \r\n')), pw + ' ', 'cmd "echo pw | ..." trailing space is kept, the CLI only adds a hint');
  const hint = api.workDataKeyGuidance({ code: 'work_data_recovery.authentication', passwordTrailingSpace: true });
  assert.match(hint, /末尾带空格/); assert.ok(!hint.includes(pw));
  assert.doesNotMatch(api.workDataKeyGuidance({ code: 'work_data_recovery.authentication' }), /末尾带空格/);
});

test('product writer: fsynced raw-byte replacement under a non-protected temporary name; only its own torn temporaries are cleaned', async () => {
  await fresh();
  const host = api.workDataKeyRewrapHost();
  const raw = Buffer.from([0xff, 0x00, 0x7b, 0xc3]);
  await host.writeHeaderBytes(raw); assert.deepEqual(readHeader(), raw);
  assert.deepEqual(fs.readdirSync(data).filter(name => name.endsWith('.tmp')), []);
  const ours = '.work-data-key-rewrap-' + 'a'.repeat(24) + '.tmp', foreign = ['work-data-key-v1.json.123.deadbeef.tmp', '.work-data-key-rewrap-zz.tmp'];
  for (const name of [ours, ...foreign]) fs.writeFileSync(path.join(data, name), 'torn');
  await host.cleanupTemporaries();
  assert.equal(fs.existsSync(path.join(data, ours)), false);
  for (const name of foreign) assert.equal(fs.existsSync(path.join(data, name)), true, name + ' is not provably ours');
  await host.writeHeaderBytes(null); assert.equal(readHeader(), null);
});

test('boot refusal: only encrypted roots refuse; a missing header refuses only for an encrypted manifest', () => {
  const r = (status, encrypted) => api.WorkDataKeyRewrap.bootRefusal({ status }, encrypted)?.code || null;
  assert.equal(r('locked', 'manifest'), 'work_data_key.rewrap_required');
  assert.equal(r('locked', 'legacy'), 'work_data_key.rewrap_required');
  assert.equal(r('damaged', 'manifest'), 'work_data_key.header_damaged');
  assert.equal(r('absent', 'manifest'), 'work_data_key.header_missing');
  assert.equal(r('absent', 'legacy'), null);
  assert.equal(r('unavailable', 'manifest'), null, 'helper slow/unstartable or header not readable this time is not key loss');
  for (const status of ['healthy', 'unsupported']) assert.equal(r(status, 'manifest'), null);
  for (const status of ['locked', 'damaged', 'absent', 'unavailable']) assert.equal(r(status, false), null);
});

test('rewrap after an account change: the same master and instance are rewrapped under the current account', async () => {
  const a = account(), b = account(), root0 = await rootUnder(a);
  const serialized = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }]);
  const before = readHeader();
  const result = await rewrapWith(b, {}, { serialized, password: PASSWORD }).run;
  assert.deepEqual({ ...result }, { ok: true, changed: true, workDataKey: 'rewrapped', credentialVault: 'absent', externalBotCredentials: 'absent' });
  assert.notDeepEqual(readHeader(), before);
  await unlocksUnder(b, root0.master, root0.instanceId);
  await assert.rejects(keysOver(a).snapshot(), { code: 'work_data_key.decrypt_failed' });
});

test('wrong password, a foreign package and a forged master are refused before any write', async () => {
  const a = account(), b = account(), root0 = await rootUnder(a), before = readHeader();
  const good = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }]);
  const wrong = rewrapWith(b, {}, { serialized: good, password: 'synthetic-wrong-' + crypto.randomBytes(6).toString('hex') });
  const failure = await wrong.run.then(() => null, error => error);
  assert.equal(failure.code, 'work_data_recovery.authentication');
  assert.ok(!JSON.stringify({ ...failure, message: failure.message }).includes(PASSWORD));
  const foreign = await packageOf([{ purpose: 'work-data', instanceId: crypto.randomBytes(16).toString('hex'), master: crypto.randomBytes(32) }]);
  await assert.rejects(rewrapWith(b, {}, { serialized: foreign, password: PASSWORD }).run, { code: 'work_data_key.rewrap_package_mismatch' });
  const forged = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: crypto.randomBytes(32) }]);
  await assert.rejects(rewrapWith(b, {}, { serialized: forged, password: PASSWORD }).run, { code: 'work_data_key.rewrap_package_mismatch' });
  assert.deepEqual(readHeader(), before);
  assert.ok(!b.log.includes('protect'), 'no staging happened for a refused package');
});

test('deleted, malformed or wrong-instance headers derive the target from authenticated sealed records', async () => {
  const a = account(), b = account();
  for (const damage of ['delete', 'garbage', 'instance']) {
    const root0 = await rootUnder(a);
    const serialized = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }]);
    if (damage === 'delete') fs.unlinkSync(headerFile());
    else if (damage === 'garbage') fs.writeFileSync(headerFile(), '\u0000not json');
    else fs.writeFileSync(headerFile(), JSON.stringify({ ...root0.header, instanceId: crypto.randomBytes(16).toString('hex') }));
    const result = await rewrapWith(b, {}, { serialized, password: PASSWORD }).run;
    assert.equal(result.workDataKey, 'rewrapped', damage);
    await unlocksUnder(b, root0.master, root0.instanceId);
  }
});

test('nothing to prove means nothing is written: absent header without sealed records', async () => {
  const a = account();
  await fresh();
  const serialized = await packageOf([{ purpose: 'work-data', instanceId: crypto.randomBytes(16).toString('hex'), master: crypto.randomBytes(32) }]);
  const legacy = rewrapWith(a, { encrypted: 'legacy' }, { serialized, password: PASSWORD });
  assert.equal((await legacy.run).changed, false); assert.equal(legacy.calls.open, 0);
  await assert.rejects(rewrapWith(a, { encrypted: 'manifest' }, { serialized, password: PASSWORD }).run, { code: 'work_data_key.rewrap_target_unknown' });
  assert.equal(readHeader(), null);
});

test('healthy keys and a busy protector never open the package or write', async () => {
  const a = account(), root0 = await rootUnder(a), before = readHeader();
  const serialized = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }]);
  const healthy = rewrapWith(a, {}, { serialized, password: PASSWORD });
  assert.equal((await healthy.run).changed, false); assert.equal(healthy.calls.open, 0);
  const busy = account(); busy.transient = true;
  const blocked = rewrapWith(busy, {}, { serialized, password: PASSWORD });
  await assert.rejects(blocked.run, { code: 'work_data_key.unlock_unavailable' }); assert.equal(blocked.calls.open, 0);
  assert.deepEqual(readHeader(), before);
});

test('failures after the first write restore the exact previous header bytes (or absence)', async () => {
  const a = account(), b = account();
  for (const [label, options, expected] of [
    ['before-write', { fault: 'before-write' }, 'work_data_key.rewrap_test_fault'],
    ['after-write', { fault: 'after-write' }, 'work_data_key.rewrap_test_fault'],
    ['after-verify', { fault: 'after-verify' }, 'work_data_key.rewrap_test_fault'],
    // The replacement write itself fails (disk error): the rollback still re-asserts the old bytes.
    ['write-throws', { writeFault: (() => { let first = true; return async () => { if (first) { first = false; throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }; })() }, 'EIO'],
  ]) {
    const root0 = await rootUnder(a), before = readHeader();
    const serialized = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }]);
    const failure = await rewrapWith(b, options, { serialized, password: PASSWORD }).run.then(() => null, error => error);
    assert.equal(failure?.code, expected, label);
    assert.deepEqual(readHeader(), before, label);
    if (label !== 'before-write') assert.equal(failure.rolledBack, true, label);
  }
  // A non-UTF-8 damaged header is restored byte for byte (no string re-encoding on rollback).
  const rootRaw = await rootUnder(a), raw = Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x7b]);
  fs.writeFileSync(headerFile(), raw);
  const serializedRaw = await packageOf([{ purpose: 'work-data', instanceId: rootRaw.instanceId, master: rootRaw.master }]);
  await assert.rejects(rewrapWith(b, { fault: 'after-verify' }, { serialized: serializedRaw, password: PASSWORD }).run, { code: 'work_data_key.rewrap_test_fault' });
  assert.deepEqual(readHeader(), raw);
  // A previously absent header is removed again on rollback.
  const root1 = await rootUnder(a); fs.unlinkSync(headerFile());
  const serialized = await packageOf([{ purpose: 'work-data', instanceId: root1.instanceId, master: root1.master }]);
  await assert.rejects(rewrapWith(b, { fault: 'after-verify' }, { serialized, password: PASSWORD }).run, { code: 'work_data_key.rewrap_test_fault' });
  assert.equal(readHeader(), null);
  // A rollback that cannot be confirmed is its own code (never reported as a clean refusal).
  const root2 = await rootUnder(a);
  const serialized2 = await packageOf([{ purpose: 'work-data', instanceId: root2.instanceId, master: root2.master }]);
  let writes = 0;
  await assert.rejects(rewrapWith(b, { fault: 'after-write', writeFault: async () => { if (++writes === 2) throw Object.assign(new Error('EIO'), { code: 'EIO' }); } },
    { serialized: serialized2, password: PASSWORD }).run, { code: 'work_data_key.rewrap_rollback_failed' });
});

test('a locked credential vault is rewrapped from the same package, all-or-nothing with the header', async () => {
  const a = account(), b = account(), root0 = await rootUnder(a);
  const vaultMaster = crypto.randomBytes(32), vaultInstance = crypto.randomBytes(16).toString('hex');
  let vaultBytes = Buffer.from(JSON.stringify({ schema: 1, instanceId: vaultInstance, protectedKey: 'b2xk', records: [] }));
  let locked = true;
  const vault = {
    readBytes: async () => vaultBytes, writeBytes: async bytes => { vaultBytes = bytes; locked = false; },
    async snapshot() {
      if (locked) throw Object.assign(new Error('credential_vault.unlock_failed'), { code: 'credential_vault.unlock_failed' });
      const state = JSON.parse(vaultBytes.toString('utf8'));
      return { state, lease: { key: Buffer.from(vaultMaster), release() {} } };
    },
    async stage({ state, key }) {
      if (!key.equals(vaultMaster)) throw Object.assign(new Error('credential_vault.recovery_record_invalid'), { code: 'credential_vault.recovery_record_invalid' });
      return { state: { ...state, protectedKey: 'bmV3' }, lease: { release() {} } };
    },
    clear() {},
  };
  const withoutVaultKey = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }]);
  const before = readHeader(), vaultBefore = vaultBytes;
  await assert.rejects(rewrapWith(b, { vault }, { serialized: withoutVaultKey, password: PASSWORD }).run, { code: 'work_data_key.rewrap_credential_mismatch' });
  assert.deepEqual(readHeader(), before); assert.equal(vaultBytes, vaultBefore);
  const wrongVaultKey = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }, { purpose: 'credential', instanceId: vaultInstance, master: crypto.randomBytes(32) }]);
  await assert.rejects(rewrapWith(b, { vault }, { serialized: wrongVaultKey, password: PASSWORD }).run, { code: 'work_data_key.rewrap_credential_mismatch' });
  assert.deepEqual(readHeader(), before);
  const full = await packageOf([{ purpose: 'work-data', instanceId: root0.instanceId, master: root0.master }, { purpose: 'credential', instanceId: vaultInstance, master: vaultMaster }]);
  await assert.rejects(rewrapWith(b, { vault, fault: 'after-verify' }, { serialized: full, password: PASSWORD }).run, { code: 'work_data_key.rewrap_test_fault' });
  assert.deepEqual(readHeader(), before); assert.equal(vaultBytes.toString(), vaultBefore.toString());
  locked = true;
  const result = await rewrapWith(b, { vault }, { serialized: full, password: PASSWORD }).run;
  assert.deepEqual({ ...result }, { ok: true, changed: true, workDataKey: 'rewrapped', credentialVault: 'rewrapped', externalBotCredentials: 'absent' });
  assert.equal(JSON.parse(vaultBytes.toString('utf8')).protectedKey, 'bmV3');
  // Vault-only loss (header already healthy under this account): only the vault is rewrapped.
  locked = true; const healthyHeader = readHeader();
  const vaultOnly = await rewrapWith(b, { vault }, { serialized: full, password: PASSWORD }).run;
  assert.deepEqual({ ...vaultOnly }, { ok: true, changed: true, workDataKey: 'healthy', credentialVault: 'rewrapped', externalBotCredentials: 'absent' });
  assert.deepEqual(readHeader(), healthyHeader);
});

test('guidance names the stable code and the rewrap command for refusals, and never echoes secrets', () => {
  const codes = ['rewrap_required', 'header_damaged', 'header_missing'];
  for (const suffix of codes) {
    const text = api.workDataKeyGuidance({ code: 'work_data_key.' + suffix });
    assert.ok(text.includes('work_data_key.' + suffix) && text.includes(api.WorkDataKeyRewrap.COMMAND) && text.includes('--package'), suffix);
    assert.ok(text.length <= 800, suffix + ' fits the startup notice');
  }
  const busy = api.workDataKeyGuidance({ code: 'work_data_key.unlock_unavailable' });
  assert.ok(busy.includes('work_data_key.unlock_unavailable') && !busy.includes('--package'));
  for (const code of ['work_data_recovery.authentication', 'work_data_key.rewrap_package_mismatch', 'work_data_key.rewrap_password_argv_forbidden', 'work_data_recovery.invalid'])
    assert.match(api.workDataKeyGuidance({ code, message: PASSWORD }), /没有改动任何文件/);
  assert.match(api.workDataKeyGuidance({ code: 'work_data_key.rewrap_test_fault', rolledBack: true }), /已回滚/);
  assert.equal(api.workDataKeyGuidance({ code: 'credential_vault.unlock_failed' }), '', 'unbound root keeps the credential-only guidance');
  assert.equal(api.workDataKeyGuidance(new Error('other')), '');
  for (const code of [...codes.map(s => 'work_data_key.' + s), 'work_data_recovery.authentication'])
    assert.ok(!api.workDataKeyGuidance({ code, message: PASSWORD, password: PASSWORD }).includes(PASSWORD));
});
