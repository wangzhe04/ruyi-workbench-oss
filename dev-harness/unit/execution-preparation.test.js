'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-preparation-unit-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR']) process.env[key] = path.join(root, key);
process.env.RUYI_HOME = path.join(root, 'data'); process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
const { loadServerInternals } = require('../lib/server-internals');
const { prepareDesktopExecutionArguments: prepare, executionArgumentsDigest: digest } = loadServerInternals(['prepareDesktopExecutionArguments', 'executionArgumentsDigest']);
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('preparation owns a recursively frozen snapshot whose exact outgoing bytes and digests agree', async () => {
  const args = { text: '你好🚀', steps: [{ x: -0, value: 1000000000000000100 }, { x: 1e21 }] };
  const prepared = prepare(args);
  args.text = 'changed'; args.steps[0].value = 0; args.steps.push('changed');
  await Promise.resolve();
  assert.equal(prepared.snapshot.text, '你好🚀'); assert.equal(prepared.snapshot.steps.length, 2);
  assert.equal(Object.is(prepared.snapshot.steps[0].x, -0), false);
  assert.equal(JSON.stringify(prepared.snapshot), prepared.json);
  assert.equal(prepared.bytes, Buffer.byteLength(prepared.json));
  assert.equal(prepared.sha256, crypto.createHash('sha256').update(prepared.json).digest('hex'));
  assert.equal(prepared.semanticSha256, digest(JSON.parse(prepared.json)));
  assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.snapshot) && Object.isFrozen(prepared.snapshot.steps[0]));
  assert.throws(() => { prepared.snapshot.steps[0].value = 1; }, TypeError);
});

test('accessors and toJSON are rejected without being executed, including arrays', () => {
  let invoked = 0;
  const getter = {}; Object.defineProperty(getter, 'text', { enumerable: true, get() { invoked += 1; return 'hidden'; } });
  const array = [1]; Object.defineProperty(array, '0', { enumerable: true, get() { invoked += 1; return 2; } });
  const hook = { toJSON() { invoked += 1; return { changed: true }; } };
  for (const args of [getter, { nested: getter }, { nested: array }, hook, { nested: hook }]) assert.throws(() => prepare(args));
  assert.equal(invoked, 0);
});

test('raw JSON, sparse arrays, nonfinite numbers, unsupported values and extra array fields fail before preparation', () => {
  const extra = [1]; extra.ignored = 2;
  const symbol = { text: 'safe' }; symbol[Symbol('hidden')] = 'hidden';
  const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 'hidden' });
  const cycle = {}; cycle.self = cycle;
  const invalid = [[], null, { value: JSON.rawJSON('9007199254740993') }, { value: new Array(2) }, { value: extra },
    { value: NaN }, { value: Infinity }, { value: undefined }, { value: 1n }, { value: new Date() },
    { value: () => {} }, { value: '\ud800' }, symbol, hidden, cycle];
  for (const value of invalid) assert.throws(() => prepare(value));
});

test('prototype-looking keys remain data without changing an outgoing object prototype', () => {
  const args = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"name":"literal"}}');
  const prepared = prepare(args);
  assert.equal(Object.getPrototypeOf(prepared.snapshot), null);
  assert.equal(prepared.json, JSON.stringify(args));
  assert.equal({}.polluted, undefined);
});

test('depth and byte limits refuse before returning a dispatchable preparation', () => {
  let nested = {}; for (let index = 0; index < 130; index += 1) nested = { child: nested };
  assert.throws(() => prepare(nested), /capacity/);
  assert.throws(() => prepare({ text: 'x'.repeat(8 * 1024 * 1024) }), /capacity/);
});

test('copied arrays and objects cannot inherit toJSON hooks before or after an async boundary', async () => {
  const arrayBefore = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const objectBefore = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let invoked = 0;
  try {
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value() { invoked += 1; return 'changed'; } });
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { invoked += 1; return 'changed'; } });
    const prepared = prepare({ rows: [{ value: 1 }, [2, 3]] });
    assert.equal(Object.getPrototypeOf(prepared.snapshot.rows), null);
    assert.equal(prepared.json, '{"rows":[{"value":1},[2,3]]}');
    await Promise.resolve();
    assert.equal(JSON.stringify(prepared.snapshot), prepared.json);
    assert.equal(digest(prepared.snapshot), prepared.semanticSha256);
    assert.equal(invoked, 0);
  } finally {
    if (arrayBefore) Object.defineProperty(Array.prototype, 'toJSON', arrayBefore); else delete Array.prototype.toJSON;
    if (objectBefore) Object.defineProperty(Object.prototype, 'toJSON', objectBefore); else delete Object.prototype.toJSON;
  }
});
