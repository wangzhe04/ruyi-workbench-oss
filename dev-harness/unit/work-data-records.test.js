'use strict';
// M3-2c: the per-record NDJSON format must reject every way a line could be read at the wrong place:
// another ordinal (reorder/duplicate/gap), another session, another kind, another instance, or a
// tampered byte. Plaintext and encrypted bodies must stay byte-separable, never silently mixed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { constBlock } = require('../lib/source-slice');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const source = [read('01h-privacy-core.js'), constBlock(read('01n-work-data-crypto.js'), 'WorkDataCrypto'),
  constBlock(read('01q-work-data-records.js'), 'WorkDataRecords')].join('\n');
const { records } = vm.runInNewContext(source + '\n({records:WorkDataRecords})', { require, Buffer });
const KEY = crypto.randomBytes(32);
const INSTANCE = 'b'.repeat(32);
const ctx = (patch = {}) => ({ instanceId: INSTANCE, sessionId: 'sess_records01', kind: 'messages', ...patch });
const line = text => JSON.stringify({ role: 'user', content: text });
const fails = (fn, code) => assert.throws(fn, error => error.code === 'work_data_record.' + code);

test('records round-trip and the encoded line hides the content', () => {
  const plain = line('中文内容 with emoji 🙂');
  const encoded = records.encodeLine(plain, KEY, ctx({ ordinal: 0 }));
  assert.equal(records.isEncodedLine(encoded), true);
  assert.equal(encoded.includes('中文内容'), false);
  assert.equal(records.decodeLine(encoded, KEY, ctx({ ordinal: 0 })), plain);
  assert.equal(records.isEncodedLine(plain), false);
});

test('an ordinal that does not match the line position fails', () => {
  const first = records.encodeLine(line('a'), KEY, ctx({ ordinal: 0 }));
  const second = records.encodeLine(line('b'), KEY, ctx({ ordinal: 1 }));
  fails(() => records.decodeLine(second, KEY, ctx({ ordinal: 0 })), 'ordinal_mismatch');
  // Swapping the two lines in a body is rejected too.
  const body = second + '\n' + first + '\n';
  fails(() => records.decodeBody(body, KEY, ctx()), 'ordinal_mismatch');
  // Duplicating a line shifts everything after it.
  const duplicated = first + '\n' + first + '\n';
  fails(() => records.decodeBody(duplicated, KEY, ctx()), 'ordinal_mismatch');
});

test('another session, kind, instance or a tampered byte cannot be opened', () => {
  const encoded = records.encodeLine(line('secret'), KEY, ctx({ ordinal: 0 }));
  fails(() => records.decodeLine(encoded, KEY, ctx({ ordinal: 0, sessionId: 'sess_other001' })), 'authenticate_failed');
  fails(() => records.decodeLine(encoded, KEY, ctx({ ordinal: 0, kind: 'provider' })), 'authenticate_failed');
  fails(() => records.decodeLine(encoded, KEY, ctx({ ordinal: 0, instanceId: 'c'.repeat(32) })), 'authenticate_failed');
  const parsed = JSON.parse(encoded);
  parsed.e.envelope.ciphertext = Buffer.from(parsed.e.envelope.ciphertext, 'base64').fill(0, 0, 4).toString('base64');
  fails(() => records.decodeLine(JSON.stringify(parsed), KEY, ctx({ ordinal: 0 })), 'authenticate_failed');
  fails(() => records.decodeLine(encoded, crypto.randomBytes(32), ctx({ ordinal: 0 })), 'authenticate_failed');
});

test('a body must be all records: mixed plaintext, blank interiors and unknown versions fail', () => {
  const a = records.encodeLine(line('a'), KEY, ctx({ ordinal: 0 }));
  const b = records.encodeLine(line('b'), KEY, ctx({ ordinal: 1 }));
  assert.equal(records.decodeBody(a + '\n' + b + '\n', KEY, ctx()), line('a') + '\n' + line('b') + '\n');
  fails(() => records.decodeBody(a + '\n' + line('plain') + '\n', KEY, ctx()), 'corrupt');
  fails(() => records.decodeBody(a + '\n\n' + b + '\n', KEY, ctx()), 'corrupt');
  const future = JSON.parse(a); future.w = 3;
  fails(() => records.decodeBody(JSON.stringify(future) + '\n', KEY, ctx()), 'format_unsupported');
  fails(() => records.decodeLine('not json', KEY, ctx({ ordinal: 0 })), 'corrupt');
  fails(() => records.decodeLine(JSON.stringify({ w: 2 }), KEY, ctx({ ordinal: 0 })), 'corrupt');
  fails(() => records.decodeLine(JSON.stringify({ w: 2, e: 5 }), KEY, ctx({ ordinal: 0 })), 'corrupt');
  // A body line may never be empty (an interior blank line is corruption); encode refuses empty text.
  fails(() => records.encodeLine('', KEY, ctx({ ordinal: 0 })), 'text_required');
});

test('an empty body and a body without a trailing newline keep their shape', () => {
  assert.equal(records.decodeBody('', KEY, ctx()), '');
  const only = records.encodeLine(line('x'), KEY, ctx({ ordinal: 0 }));
  assert.equal(records.decodeBody(only, KEY, ctx()), line('x'));
  assert.equal(records.decodeBody(only + '\n', KEY, ctx()), line('x') + '\n');
});

test('kinds and ordinals are validated before any crypto runs', () => {
  fails(() => records.encodeLine(line('a'), KEY, ctx({ ordinal: -1 })), 'ordinal_invalid');
  fails(() => records.encodeLine(line('a'), KEY, ctx({ ordinal: 1.5 })), 'ordinal_invalid');
  fails(() => records.encodeLine(line('a'), KEY, ctx({ kind: 'interventions', ordinal: 0 })), 'kind_invalid');
  fails(() => records.encodeLine('', KEY, ctx({ ordinal: 0 })), 'text_required');
  assert.deepEqual([...records.KINDS], ['messages', 'provider']);
});
