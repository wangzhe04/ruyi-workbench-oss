'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const api = loadWorkDataChunks();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-chunks-unit-'));
const master = crypto.randomBytes(32);
const binding = { purpose: 'memory', instanceId: 'instance-unit', schema: 1, scopeId: 'global', recordId: 'chunk-fixture', seq: 1 };
const cap = 4 * 1024 * 1024;
const failure = error => /^work_data/.test(String(error && error.code));
const text = 'x'.repeat(api.chunks.CHUNK_BYTES - 2) + '😀中文é\r\n\ufeff'.repeat(70000);
const collect = async factory => { const lines = []; for await (const line of factory()) lines.push(line.trimEnd()); return lines; };
const encode = value => collect(api.chunks.sealFactory(value, master, binding, cap));
const decode = (lines, expected = binding, limit = cap) => api.chunks.openLines(lines, master, expected, limit);
function fixture(options = {}) {
  const file = path.join(root, crypto.randomBytes(6).toString('hex') + '.json');
  const state = { enabled: false, missing: false, instance: binding.instanceId };
  const keys = { unlock: async () => { if (state.missing) throw Object.assign(new Error('absent'), { code: 'work_data_key.absent' }); return master; }, instance: async () => state.instance };
  const host = { file: () => file, ...binding, enabled: async () => state.enabled, keys,
    writeJson: api.atomicWriteJson, chunked: true, maxPlaintextBytes: cap, ...options };
  return { file, state, host, record: api.store.createText(host) };
}
after(() => { master.fill(0); fs.rmSync(root, { recursive: true, force: true }); });

test('empty and UTF8 block boundaries preserve BOM, non-BMP, combining marks and CRLF exactly', async () => {
  for (const value of ['', 'x', 'x'.repeat(api.chunks.CHUNK_BYTES), 'x'.repeat(api.chunks.CHUNK_BYTES + 1), text]) {
    const lines = await encode(value);
    assert.equal(await decode(lines), value);
    assert.ok(Buffer.byteLength(lines[0]) <= api.chunks.MAX_HEADER_BYTES);
    for (const line of lines.slice(1)) assert.ok(Buffer.byteLength(line) <= api.chunks.MAX_CHUNK_LINE_BYTES);
    if (!value) assert.equal(lines.length, 1);
  }
  for (const value of ['\ud800', '\udc00', 'x\ud800z']) {
    assert.throws(() => api.chunks.sealFactory(value, master, binding, cap), { code: 'work_data_chunk.unicode_invalid' });
  }
});

test('authenticated but invalid UTF8 is rejected at the AEAD decoder, while real U+FFFD is preserved', () => {
  const id = 'utf8-test', identity = { instanceId: 'instance-unit', purpose: 'memory', recordId: 'utf8' };
  const valid = api.privacy.seal('\ufffd', master, identity, id);
  assert.equal(api.privacy.open(valid, master, identity, id), '\ufffd');
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(JSON.stringify(['ruyi-privacy', 1, id, identity.instanceId, identity.purpose, identity.recordId]));
  const raw = Buffer.from([0xf0, 0x90, 0x80]); // truncated four-byte sequence; lossy decode becomes U+FFFD
  const cipher = crypto.createCipheriv('aes-256-gcm', master, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  const malformed = { ...valid, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  const proof = crypto.createDecipheriv('aes-256-gcm', master, nonce); proof.setAAD(aad); proof.setAuthTag(cipher.getAuthTag());
  assert.deepEqual(Buffer.concat([proof.update(ciphertext), proof.final()]), raw, 'AEAD authentication itself succeeds');
  assert.throws(() => api.privacy.open(malformed, master, identity, id), { code: 'privacy.decrypt_failed' });
});

test('the encoder snapshots its in-flight key and exposes disposal after atomic consumption', async () => {
  const mutable = Buffer.from(master), factory = api.chunks.sealFactory('snapshot', mutable, binding, cap);
  mutable.fill(0);
  assert.equal(await decode(await collect(factory)), 'snapshot');
  factory.dispose();
  await assert.rejects(() => collect(factory), { code: 'work_data_chunk.key_released' });
});

test('weighted admission is FIFO, admits small jobs together, bounds active count and makes big jobs exclusive', async () => {
  const gate = api.chunks.createAdmission({ budgetBytes: 10, maxActive: 4 });
  const order = [], releases = [];
  const first = await gate.acquire(6);
  const second = gate.acquire(5).then(release => { order.push('second'); releases.push(release); });
  const third = gate.acquire(4).then(release => { order.push('third'); releases.push(release); });
  await Promise.resolve();
  assert.equal(gate.snapshot().activeBytes, 6); assert.equal(gate.snapshot().queued, 2, 'later four-byte job cannot jump the five-byte FIFO head');
  first(); await Promise.all([second, third]);
  assert.deepEqual(order, ['second', 'third']); assert.equal(gate.snapshot().activeBytes, 9);
  for (const release of releases) { release(); release(); }
  const held = await gate.acquire(1);
  let bigRelease, smallRelease;
  const big = gate.acquire(11).then(release => { order.push('big'); bigRelease = release; });
  const small = gate.acquire(1).then(release => { order.push('small'); smallRelease = release; });
  held(); await big;
  assert.equal(gate.snapshot().activeCount, 1); assert.equal(gate.snapshot().activeBytes, 11); assert.equal(gate.snapshot().queued, 1);
  bigRelease(); await small; smallRelease();
  assert.deepEqual(order.slice(-2), ['big', 'small']);
  const zero = await Promise.all(Array.from({ length: 4 }, () => gate.acquire(0)));
  const fifth = gate.acquire(0);
  assert.equal(gate.snapshot().activeCount, 4); assert.equal(gate.snapshot().queued, 1);
  zero.pop()(); const last = await fifth; last(); zero.forEach(release => release());
  await assert.rejects(() => gate.run(2, async () => { throw new Error('work failed'); }), /work failed/);
  assert.equal(gate.snapshot().activeCount, 0); assert.equal(gate.snapshot().activeBytes, 0); assert.equal(gate.snapshot().queued, 0);
});

test('codec acquires before allocation, authenticates before queueing and releases on cancellation/source failure', async () => {
  const lines = await encode('admission sample');
  const blocker = await api.chunks.admission.acquire(64 * 1024 * 1024);
  const bad = JSON.parse(lines[0]); bad.manifest.envelope.tag = Buffer.alloc(16).toString('base64');
  await assert.rejects(() => decode([JSON.stringify(bad), ...lines.slice(1)]), failure);
  assert.equal(api.chunks.admission.snapshot().queued, 0, 'unauthenticated data does not enter the allocation queue');
  const pendingRead = decode(lines);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.chunks.admission.snapshot().queued, 1);
  blocker(); assert.equal(await pendingRead, 'admission sample');
  const factory = api.chunks.sealFactory('held output', master, binding, cap), iterator = factory();
  await iterator.next(); assert.equal(api.chunks.admission.snapshot().activeCount, 1);
  await iterator.return(); factory.dispose(); assert.equal(api.chunks.admission.snapshot().activeCount, 0);
  const failedSource = (async function* () { yield lines[0]; throw new Error('read failed'); })();
  await assert.rejects(() => decode(failedSource), /read failed/);
  assert.equal(api.chunks.admission.snapshot().activeCount, 0);
  const release = await api.chunks.admission.acquire(64 * 1024 * 1024);
  const disposedFactory = api.chunks.sealFactory('cancel queued writer', master, binding, cap);
  const pendingWrite = collect(disposedFactory);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.chunks.admission.snapshot().queued, 1);
  disposedFactory.dispose(); release();
  await assert.rejects(() => pendingWrite, { code: 'work_data_chunk.key_released' });
  assert.equal(api.chunks.admission.snapshot().activeCount, 0); assert.equal(api.chunks.admission.snapshot().queued, 0);
});

test('engineering file/header/line bounds cover the largest legal identity and manifest', () => {
  const expected = { ...binding, purpose: 'search-index', instanceId: 'i'.repeat(160), scopeId: 's'.repeat(160), recordId: 'r'.repeat(160), schema: Number.MAX_SAFE_INTEGER, seq: Number.MAX_SAFE_INTEGER };
  const revision = 'f'.repeat(32), lengths = Array(api.chunks.MAX_CHUNKS - 1).fill(api.chunks.CHUNK_BYTES - 3);
  lengths.push(api.chunks.MAX_PLAINTEXT_BYTES - lengths.reduce((sum, value) => sum + value, 0));
  const manifest = { format: 1, revision, totalBytes: api.chunks.MAX_PLAINTEXT_BYTES, count: lengths.length,
    chunkBytes: api.chunks.CHUNK_BYTES, lengths, sha256: 'f'.repeat(64) };
  const base = crypto.createHash('sha256').update(JSON.stringify([expected.purpose, expected.instanceId, expected.schema, expected.scopeId, expected.recordId, expected.seq])).digest('hex');
  const recordId = 'chunks:' + base + ':' + revision;
  const header = { workData: 3, format: 'chunks-v1', ...expected, keyId: 'work-data-v2.k1', revision,
    manifest: api.crypto.seal(JSON.stringify(manifest), master, { ...expected, recordId: recordId + ':m', seq: 0 }) };
  assert.ok(Buffer.byteLength(JSON.stringify(header)) <= api.chunks.MAX_HEADER_BYTES);
  const row = { i: api.chunks.MAX_CHUNKS - 1, e: api.crypto.seal('x'.repeat(api.chunks.CHUNK_BYTES), master,
    { ...expected, recordId: recordId + ':c:' + (api.chunks.MAX_CHUNKS - 1), seq: api.chunks.MAX_CHUNKS - 1 }) };
  assert.ok(Buffer.byteLength(JSON.stringify(row)) <= api.chunks.MAX_CHUNK_LINE_BYTES);
  assert.ok(api.chunks.maxFileBytes(api.chunks.MAX_PLAINTEXT_BYTES) > Math.ceil(api.chunks.MAX_PLAINTEXT_BYTES * 4 / 3));
});

test('the authenticated manifest rejects identity, instance, revision and chunk substitutions', async () => {
  const lines = await encode(text);
  for (const changed of [{ purpose: 'workflow' }, { schema: 2 }, { scopeId: 'other' }, { recordId: 'other' }, { seq: 2 }, { generation: 2 }, { instanceId: 'other-instance' }]) {
    await assert.rejects(() => decode(lines, { ...binding, ...changed }), failure);
  }
  const other = await encode(text);
  const cases = [lines.slice(0, -1), [...lines, lines[1]], [lines[0], lines[2], lines[1], ...lines.slice(3)],
    [lines[0], other[1], ...lines.slice(2)], [lines[0], lines[1], lines[1], ...lines.slice(3)],
    [...lines, ''], [...lines, 'garbage']];
  const badHeader = JSON.parse(lines[0]); badHeader.revision = '0'.repeat(32);
  cases.push([JSON.stringify(badHeader), ...lines.slice(1)]);
  const badTag = JSON.parse(lines[1]); badTag.e.envelope.tag = Buffer.alloc(16).toString('base64');
  cases.push([lines[0], JSON.stringify(badTag), ...lines.slice(2)]);
  const badOrdinal = JSON.parse(lines[1]); badOrdinal.i = Number.MAX_SAFE_INTEGER + 1;
  cases.push([lines[0], JSON.stringify(badOrdinal), ...lines.slice(2)]);
  for (const broken of cases) await assert.rejects(() => decode(broken), failure);
});

test('even authenticated manifests must satisfy exact shape, safe counts, lengths, host cap and final hash', async () => {
  const lines = await encode(text), original = JSON.parse(lines[0]);
  const base = crypto.createHash('sha256').update(JSON.stringify([binding.purpose, binding.instanceId, binding.schema, binding.scopeId, binding.recordId, binding.seq])).digest('hex');
  const manifestBinding = { ...binding, recordId: 'chunks:' + base + ':' + original.revision + ':m', seq: 0 };
  const manifest = JSON.parse(api.crypto.open(original.manifest, master, manifestBinding));
  for (const patch of [
    { count: manifest.count + 1 }, { count: Number.MAX_SAFE_INTEGER + 1 }, { totalBytes: cap + 1 },
    { totalBytes: -1 }, { lengths: [-1, ...manifest.lengths.slice(1)] }, { lengths: [api.chunks.CHUNK_BYTES + 1, ...manifest.lengths.slice(1)] },
    { chunkBytes: api.chunks.CHUNK_BYTES + 1 }, { extra: 'unexpected' }, { sha256: { toString: null, valueOf: null } },
    { sha256: '0'.repeat(64) }, { revision: '0'.repeat(32) },
  ]) {
    const header = { ...original, manifest: api.crypto.seal(JSON.stringify({ ...manifest, ...patch }), master, manifestBinding) };
    await assert.rejects(() => decode([JSON.stringify(header), ...lines.slice(1)]), failure);
  }
  await assert.rejects(() => decode(lines, binding, 1), failure);
});

test('opt-in plain bytes, old v2 compatibility, strict old-adapter rejection, no downgrade, absent keys and sealed validation', async () => {
  const f = fixture({ validateSealedText: value => value !== 'shape-invalid' });
  await f.record.write(text);
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
  assert.equal(await f.record.read(), text);
  f.state.enabled = true;
  await f.record.write(text);
  const sealed = fs.readFileSync(f.file, 'utf8');
  assert.equal(JSON.parse(sealed.split('\n')[0]).workData, 3);
  assert.equal(sealed.includes('中文'), false);
  assert.equal(await f.record.read(), text);
  const old = api.store.createText({ ...f.host, chunked: false });
  await assert.rejects(() => old.read(), { code: 'work_data_store.chunked_unsupported' });
  await assert.rejects(() => old.write('replace'), { code: 'work_data_store.chunked_unsupported' });
  f.state.enabled = false;
  assert.equal(await f.record.read(), text);
  await assert.rejects(() => f.record.write('replace'), { code: 'work_data_store.downgrade_refused' });
  f.state.enabled = true; f.state.missing = true;
  await assert.rejects(() => f.record.read(), { code: 'work_data_key.absent' });
  await assert.rejects(() => f.record.write('replace'), { code: 'work_data_key.absent' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), sealed);
  f.state.missing = false;
  fs.writeFileSync(f.file, sealed.slice(0, -30));
  await assert.rejects(() => f.record.read(), failure);
  await assert.rejects(() => f.record.write('replace'), failure);
  assert.equal(fs.readFileSync(f.file, 'utf8'), sealed.slice(0, -30));
  fs.unlinkSync(f.file);
  await old.write('v2 text');
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).workData, 2);
  assert.equal(await f.record.read(), 'v2 text');
  await old.write('shape-invalid');
  await assert.rejects(() => f.record.read(), error => error.code === 'work_data_store.validate' && error.statusCode === 503);
  await assert.rejects(() => f.record.write('replace'), error => error.code === 'work_data_store.validate' && error.statusCode === 503);
  fs.unlinkSync(f.file); f.state.enabled = false;
  await f.record.write('shape-invalid');
  assert.equal(await f.record.read(), 'shape-invalid', 'plain legacy text does not invoke sealed-only validation');
});

test('the adapter reads authenticated historical chunk generations and refuses a changed generation label', async () => {
  const f = fixture(); f.state.enabled = true;
  const factory = api.chunks.sealFactory('historical generation', master, { ...binding, generation: 2 }, cap);
  try { await api.atomicWriteJson(f.file, factory, { stream: true }); } finally { factory.dispose(); }
  assert.equal(await f.record.read(), 'historical generation');
  const original = fs.readFileSync(f.file, 'utf8'), rows = original.split('\n');
  const header = JSON.parse(rows[0]); header.keyId = 'work-data-v2.k3'; rows[0] = JSON.stringify(header);
  fs.writeFileSync(f.file, rows.join('\n'));
  await assert.rejects(() => f.record.read(), failure);
  await assert.rejects(() => f.record.write('replace'), failure);
  assert.equal(fs.readFileSync(f.file, 'utf8'), rows.join('\n'));
  fs.writeFileSync(f.file, original);
  await f.record.write('new generation-one write');
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8').split('\n')[0]).keyId, 'work-data-v2.k1');
});

test('old-v3 guard authentication releases its permit before the replacement encoder acquires one', async () => {
  const f = fixture(); f.state.enabled = true;
  await f.record.write(text);
  // Leave room for exactly one copy. A nested old-reader + new-writer reservation would deadlock.
  const release = await api.chunks.admission.acquire(64 * 1024 * 1024 - Buffer.byteLength(text));
  const pending = f.record.write(text);
  let timer;
  try {
    await Promise.race([pending, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('nested admission deadlock')), 2000); })]);
  } finally { clearTimeout(timer); release(); await pending; }
  assert.equal(await f.record.read(), text);
  assert.equal(api.chunks.admission.snapshot().activeCount, 0);
});

test('limits apply only to sealed writes and malformed long lines/extra tails fail closed before replacement', async () => {
  assert.throws(() => fixture({ maxPlaintextBytes: undefined }), { code: 'work_data_chunk.limit_invalid' });
  assert.throws(() => fixture({ maxPlaintextBytes: api.chunks.MAX_PLAINTEXT_BYTES + 1 }), { code: 'work_data_chunk.limit_invalid' });
  const f = fixture({ maxPlaintextBytes: 1024 });
  await f.record.write('x'.repeat(2048));
  const plain = fs.readFileSync(f.file, 'utf8'); f.state.enabled = true;
  await assert.rejects(() => f.record.write(plain), { code: 'work_data_chunk.limit' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), plain);
  fs.unlinkSync(f.file); await f.record.write('small');
  const sealed = fs.readFileSync(f.file, 'utf8');
  for (const broken of [sealed + '\n', sealed.trimEnd(), sealed + 'junk',
    sealed.split('\n')[0] + '\n' + 'x'.repeat(api.chunks.MAX_CHUNK_LINE_BYTES + 1) + '\n',
    '{"workData":3,"junk":"' + 'x'.repeat(api.chunks.MAX_HEADER_BYTES) + '"}\n']) {
    fs.writeFileSync(f.file, broken);
    await assert.rejects(() => f.record.read(), failure);
    await assert.rejects(() => f.record.write('replace'), failure);
    assert.equal(fs.readFileSync(f.file, 'utf8'), broken);
  }
  const factory = api.chunks.sealFactory('small', master, binding, cap);
  const first = await collect(factory), second = await collect(factory);
  assert.equal(await decode(first), 'small'); assert.equal(await decode(second), 'small');
  assert.notEqual(first[1], second[1], 'replaying a factory creates fresh random nonces');
});

test('create uses its key-set instance as an external anchor, including with the same master', async () => {
  const f = fixture(); f.state.enabled = true;
  const jsonStore = api.store.create({ ...f.host, chunked: false, prepare: value => value, defaultValue: () => ({}) });
  await jsonStore.write({ secret: 'same-master' });
  f.state.instance = 'other-instance';
  await assert.rejects(() => jsonStore.read(), { code: 'work_data.binding_mismatch' });
});

test('JSON sealed values are validated before sanitizers can erase invalid memory/import fields', async () => {
  for (const field of ['entries', 'sources']) {
    const f = fixture(); f.state.enabled = true;
    const strict = api.store.createJson({ ...f.host, chunked: false, schemaVersion: 1,
      defaultValue: () => ({ schema: 1, [field]: {} }),
      sanitize: value => ({ ...value, [field]: value[field] && typeof value[field] === 'object' ? value[field] : {} }),
      validate: value => value.schema === 1 && Boolean(value[field]) && typeof value[field] === 'object',
    });
    for (const raw of [{ schema: 1 }, { schema: 2, [field]: {} }, { [field]: {} }, { schema: 1, [field]: null }]) {
      const sealed = JSON.stringify({ workData: 2, ...api.crypto.seal(JSON.stringify(raw), master, binding) });
      fs.writeFileSync(f.file, sealed);
      await assert.rejects(() => strict.read(), error => error.code === 'work_data_store.validate' && error.statusCode === 503);
      await assert.rejects(() => strict.write({ schema: 1, [field]: {} }), failure);
      assert.equal(fs.readFileSync(f.file, 'utf8'), sealed);
      assert.equal(fs.existsSync(f.file + '.corrupt'), false);
    }
    fs.writeFileSync(f.file, JSON.stringify({ schema: 1 }));
    assert.equal(JSON.stringify(await strict.read()), JSON.stringify({ schema: 1, [field]: {} }), 'legacy plaintext retains sanitization');
  }
});

test('one switch snapshot guards and writes both v2 JSON/text and v3 without a toggle downgrade', async () => {
  for (const kind of ['json', 'text', 'chunked']) {
    const f = fixture({ chunked: kind === 'chunked' }); f.state.enabled = true;
    const record = kind === 'json'
      ? api.store.createJson({ ...f.host, schemaVersion: 1, defaultValue: () => ({ schema: 1 }), validate: value => value.schema === 1 })
      : f.record;
    const oldValue = kind === 'json' ? { schema: 1, secret: 'OLD-SWITCH-SECRET' } : 'OLD-SWITCH-SECRET';
    const nextValue = kind === 'json' ? { schema: 1, secret: 'NEW-SWITCH-SECRET' } : 'NEW-SWITCH-SECRET';
    await record.write(oldValue);
    // createJson copies its options, so use a fresh writer to install the same adversarial switch.
    let reads = 0;
    f.host.enabled = async () => ++reads === 1;
    const writer = kind === 'json'
      ? api.store.createJson({ ...f.host, schemaVersion: 1, defaultValue: () => ({ schema: 1 }), validate: value => value.schema === 1 })
      : f.record;
    await writer.write(nextValue);
    assert.equal(reads, 1, 'the guard and encoder share one operation switch snapshot');
    assert.equal(fs.readFileSync(f.file, 'utf8').includes('NEW-SWITCH-SECRET'), false);
    assert.equal(JSON.stringify(await writer.read()), JSON.stringify(nextValue));
    const before = fs.readFileSync(f.file, 'utf8');
    const off = kind === 'json' ? api.store.createJson({ ...f.host, enabled: async () => false, schemaVersion: 1,
      defaultValue: () => ({ schema: 1 }), validate: value => value.schema === 1 }) : api.store.createText({ ...f.host, enabled: async () => false });
    await assert.rejects(() => off.write(nextValue), { code: 'work_data_store.downgrade_refused' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    const fresh = fixture({ chunked: kind === 'chunked' });
    let offReads = 0, unlocks = 0;
    const unlock = fresh.host.keys.unlock;
    fresh.host.keys.unlock = async () => { unlocks++; return unlock(); };
    fresh.host.enabled = async () => ++offReads > 1;
    const freshWriter = kind === 'json' ? api.store.createJson({ ...fresh.host, schemaVersion: 1,
      defaultValue: () => ({ schema: 1 }), validate: value => value.schema === 1 }) : fresh.record;
    await freshWriter.write(oldValue);
    assert.equal(offReads, 1); assert.equal(unlocks, 0);
    assert.ok(fs.readFileSync(fresh.file, 'utf8').includes('OLD-SWITCH-SECRET'));
    await freshWriter.write(nextValue);
    assert.equal(offReads, 2); assert.ok(unlocks > 0);
    assert.equal(fs.readFileSync(fresh.file, 'utf8').includes('NEW-SWITCH-SECRET'), false);
  }
});

test('stream factory failures and rename failures preserve old target, clean tmp, and never replay on rename retries', async () => {
  const file = path.join(root, 'atomic-stream.json'); fs.writeFileSync(file, 'old');
  let consumed = 0;
  const broken = () => (async function* () { consumed++; yield 'encrypted partial'; throw new Error('encoder failed'); })();
  await assert.rejects(() => api.atomicWriteJson(file, broken, { stream: true }), /encoder failed/);
  assert.equal(consumed, 1); assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('atomic-stream.json.') && name.endsWith('.tmp')), []);
  let attempts = 0;
  const faults = Object.create(fsp);
  faults.rename = async (...args) => { if (++attempts < 3) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return fsp.rename(...args); };
  const writer = loadWorkDataChunks({ fsp: faults }).atomicWriteJson;
  consumed = 0;
  const factory = () => (async function* () { consumed++; yield 'new'; })();
  await writer(file, factory, { stream: true });
  assert.equal(attempts, 3); assert.equal(consumed, 1); assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  faults.rename = async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); };
  await assert.rejects(() => writer(file, factory, { stream: true }), { code: 'ENOSPC' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('atomic-stream.json.') && name.endsWith('.tmp')), []);
  faults.writeFile = async (tmp, value) => {
    for await (const part of value) { await fsp.writeFile(tmp, part); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
  };
  await assert.rejects(() => writer(file, factory, { stream: true }), { code: 'ENOSPC' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('atomic-stream.json.') && name.endsWith('.tmp')), []);
  await assert.rejects(() => api.atomicWriteJson(file, factory(), { stream: true }), /factory/);
});
