'use strict';
// TEMP pure-crypto definitions only. No host wiring or runtime acceptance implied.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const repo = process.env.RUYI_NDJSON_REPO || process.cwd();
const src = path.join(repo, 'ruyi-workbench/app/src');
const source = fs.readFileSync(path.join(src, '01h-privacy-core.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(src, '01n-work-data-crypto.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(src, '01r-work-data-chunks.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(__dirname, 'src/01q-work-data-records.js'), 'utf8');
const { records, envelope, chunks } = vm.runInNewContext(source + '\n({records:WorkDataRecords,envelope:WorkDataCrypto,chunks:WorkDataChunks})', { require, Buffer });
const key = crypto.randomBytes(32), instanceId = 'a'.repeat(32);
const context = patch => ({ instanceId, sessionId: 'sess_ndjson', ordinal: 7, ...patch });
const plain = JSON.stringify({ secret: '合成日志😀', seq: 918, inboxSeq: 37 });
const fail = (fn, suffix) => assert.throws(fn, error => error.code === 'work_data_record.' + suffix);

test('old four session kinds retain the exact frozen purpose and AAD identity', () => {
  for (const kind of ['messages', 'provider', 'interventions', 'changes']) {
    const ctx = context({ kind, purpose: 'queue', runId: 'ignored_for_old_kinds' });
    const line = records.encodeLine(plain, key, ctx), row = JSON.parse(line);
    assert.equal(row.e.purpose, 'session'); assert.equal(row.e.recordId, kind + ':7'); assert.equal(row.e.seq, 7);
    assert.equal(envelope.open(row.e, key, { purpose: 'session', instanceId, schema: 2, scopeId: ctx.sessionId, recordId: kind + ':7', seq: 7 }), plain);
  }
});

test('inbox and decisions bind the fixed queue purpose and distinct physical kinds', () => {
  for (const kind of ['steward-inbox', 'steward-decisions']) {
    const ctx = context({ sessionId: 'steward', kind, purpose: 'session' });
    const line = records.encodeLine(plain, key, ctx), row = JSON.parse(line);
    assert.equal(row.e.purpose, 'queue'); assert.equal(row.e.recordId, kind + ':7'); assert.equal(records.decodeLine(line, key, ctx), plain);
    fail(() => records.decodeLine(line, key, { ...ctx, kind: kind === 'steward-inbox' ? 'steward-decisions' : 'steward-inbox' }), 'authenticate_failed');
    fail(() => records.decodeLine(line, key, { ...ctx, sessionId: 'other-steward' }), 'authenticate_failed');
  }
});

test('event records authenticate run and session names in addition to ordinal and fixed task purpose', () => {
  const ctx = context({ kind: 'agent-run-events', runId: 'run_one', purpose: 'queue' });
  const line = records.encodeLine(plain, key, ctx), row = JSON.parse(line);
  assert.equal(row.e.purpose, 'task'); assert.equal(row.e.recordId, 'agent-run-events:run_one:7'); assert.equal(records.decodeLine(line, key, ctx), plain);
  fail(() => records.decodeLine(line, key, { ...ctx, runId: 'run_two' }), 'authenticate_failed');
  fail(() => records.decodeLine(line, key, { ...ctx, sessionId: 'sess_other' }), 'authenticate_failed');
  fail(() => records.decodeLine(line, key, { ...ctx, ordinal: 8 }), 'ordinal_mismatch');
});

test('maximum accepted run name and safe-integer physical position fit frozen envelope identity bounds', () => {
  const ctx = context({ kind: 'agent-run-events', runId: 'R'.repeat(96), ordinal: Number.MAX_SAFE_INTEGER });
  const line = records.encodeLine(plain, key, ctx), row = JSON.parse(line);
  assert.ok(row.e.recordId.length <= 160); assert.equal(records.decodeLine(line, key, ctx), plain);
});

test('malformed event run names and unregistered kinds never become another family binding', () => {
  for (const runId of [undefined, '', '../run', 'run:name', 'r'.repeat(97), 7]) fail(() => records.encodeLine(plain, key, context({ kind: 'agent-run-events', runId })), 'run_invalid');
  fail(() => records.encodeLine(plain, key, context({ kind: 'scheduler-fires', runId: 'run_one' })), 'kind_invalid');
});

test('a forged visible purpose or sequence cannot move an event into a queue stream', () => {
  const ctx = context({ kind: 'agent-run-events', runId: 'run_one' }), row = JSON.parse(records.encodeLine(plain, key, ctx));
  row.e.purpose = 'queue'; fail(() => records.decodeLine(JSON.stringify(row), key, ctx), 'authenticate_failed');
  row.e.seq = 8; fail(() => records.decodeLine(JSON.stringify(row), key, ctx), 'ordinal_mismatch');
});

const cap = 256 * 1024 * 1024;
const consume = async factory => { let output = ''; for await (const part of factory()) output += part; return output; };
const large = JSON.stringify({ text: '大行😀'.repeat(160000), seq: 917 });

test('large new-family records stream one physical line and roundtrip complete Unicode through authenticated chunks', async () => {
  assert.ok(Buffer.byteLength(large) > envelope.MAX_PLAINTEXT);
  for (const kind of ['steward-inbox', 'steward-decisions', 'agent-run-events']) {
    const ctx = context({ kind, runId: 'run_large' }), factory = records.encodeRecordFactory(large, key, ctx, cap);
    try {
      const encoded = await consume(factory), row = JSON.parse(encoded);
      assert.equal(encoded.split('\n').length, 2); assert.equal(row.w, 3); assert.ok(row.b.length > 1);
      assert.equal(row.h.schema, 3); assert.equal(row.h.purpose, kind === 'agent-run-events' ? 'task' : 'queue');
      assert.equal(encoded.includes('大行'), false); assert.equal(await records.decodeRecordLine(encoded, key, ctx, cap), large);
    } finally { factory.dispose(); }
  }
});

test('large record manifest/blocks/run/position all remain authority boundaries', async () => {
  const ctx = context({ kind: 'agent-run-events', runId: 'run_large' }), factory = records.encodeRecordFactory(large, key, ctx, cap);
  let encoded;
  try { encoded = await consume(factory); } finally { factory.dispose(); }
  await assert.rejects(records.decodeRecordLine(encoded, key, { ...ctx, runId: 'run_other' }, cap));
  await assert.rejects(records.decodeRecordLine(encoded, key, { ...ctx, sessionId: 'sess_other' }, cap));
  await assert.rejects(records.decodeRecordLine(encoded, key, { ...ctx, ordinal: 8 }, cap), { code: 'work_data_record.ordinal_mismatch' });
  for (const alter of [row => row.b.reverse(), row => row.b.pop(), row => { row.b[0].i = 7; }, row => { row.h.revision = 'b'.repeat(32); }, row => { row.h.manifest.envelope.tag = Buffer.alloc(16).toString('base64'); }]) {
    const row = JSON.parse(encoded); alter(row); await assert.rejects(records.decodeRecordLine(JSON.stringify(row), key, ctx, cap));
  }
});

test('factories are replayable until explicit dispose and no old kind silently expands its crypto limit', async () => {
  const ctx = context({ kind: 'steward-decisions' }), factory = records.encodeRecordFactory(large, key, ctx, cap);
  try {
    const first = await consume(factory), second = await consume(factory);
    assert.notEqual(first, second); assert.equal(await records.decodeRecordLine(first, key, ctx, cap), large); assert.equal(await records.decodeRecordLine(second, key, ctx, cap), large);
  } finally { factory.dispose(); }
  await assert.rejects(consume(factory), { code: 'work_data_chunk.key_released' });
  assert.throws(() => records.encodeRecordFactory(large, key, context({ kind: 'messages' }), cap), { code: 'work_data.text_limit' });
});

test('small records stay version2; size/shape preflight and interrupted iteration release crypto admission', async () => {
  const ctx = context({ kind: 'steward-inbox' }), small = records.encodeRecordFactory(plain, key, ctx, cap);
  try { const encoded = await consume(small); assert.equal(JSON.parse(encoded).w, 2); assert.equal(await records.decodeRecordLine(encoded, key, ctx, cap), plain); } finally { small.dispose(); }
  assert.throws(() => records.encodeRecordFactory(large, key, ctx, 1024 * 1024), { code: 'work_data_chunk.limit' });
  const factory = records.encodeRecordFactory(large, key, ctx, cap), iterator = factory();
  try { assert.equal((await iterator.next()).done, false); assert.equal(chunks.admission.snapshot().activeCount, 1); }
  finally { await iterator.return(); factory.dispose(); }
  assert.equal(chunks.admission.snapshot().activeCount, 0);
  assert.equal(chunks.admission.snapshot().activeBytes, 0);
});
