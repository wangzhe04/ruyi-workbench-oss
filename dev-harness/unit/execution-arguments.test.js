'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-arguments-unit-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = path.join(root, key);
process.env.RUYI_HOME = path.join(root, 'data'); process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
const { loadServerInternals } = require('../lib/server-internals');
const { executionArgumentsDigest: digest, mcpCallToolParams, probeDesktopExecutionReceipts } = loadServerInternals(['executionArgumentsDigest', 'mcpCallToolParams', 'probeDesktopExecutionReceipts']);
after(() => fs.rmSync(root, { recursive: true, force: true }));
const vectors = require('../fixtures/execution-argument-vectors.json');
test('Node matches shared cross-language argument identity vectors', () => {
  for (const row of vectors.vectors) {
    const actual = JSON.parse(row.wire);
    assert.equal(digest(actual), row.sha256, row.wire);
    if (row.numeric?.type === 'int') assert.equal(JSON.stringify(actual), row.numeric.decimal);
    else if (row.numeric?.type === 'float') { const bits = Buffer.alloc(8); bits.writeDoubleBE(actual); assert.equal(bits.toString('hex'), row.numeric.bits); }
  }
});
test('JSON key insertion order and JSON.stringify zero agree without conflating string/number values', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.equal(digest(-0), digest(0));
  assert.notEqual(digest(1), digest('1'));
  assert.notEqual(digest('é'), digest('e\u0301'));
});
test('unsupported numbers, lone Unicode surrogates and cycles fail before dispatch', () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [NaN, Infinity, undefined, () => {}, new Date(), 1n, '\ud800', '\udfff', cycle]) assert.throws(() => digest(value));
  let nested = 0; for (let i = 0; i < 130; i += 1) nested = [nested];
  assert.throws(() => digest(nested), /capacity/);
});
test('host transport metadata is separate, bounded and cloned; invalid serialization cannot drop context', () => {
  const args = { _meta: { model: true } }, meta = { progressToken: 'host' };
  const params = mcpCallToolParams('fixture', args, { meta }); meta.progressToken = 'changed';
  assert.equal(params.arguments, args); assert.equal(params._meta.progressToken, 'host');
  assert.deepEqual(mcpCallToolParams('fixture', args, {}), { name: 'fixture', arguments: args });
  for (const value of [null, [], { toJSON: () => null }, { toJSON: () => [] }, { text: 'x'.repeat(5000) }]) assert.throws(() => mcpCallToolParams('fixture', {}, { meta: value }));
});

test('integer identity follows exact JSON.stringify digits instead of rounded binary64 integers', () => {
  assert.equal(JSON.stringify(1000000000000000100), '1000000000000000100');
  assert.equal(digest(1000000000000000100), vectors.vectors.find(row => row.wire === '1000000000000000100').sha256);
  assert.notEqual(digest(1e20), digest(1e21));
});

test('real metadata probe fails closed on a shape flag, dropped nonce, altered values or bad worker identity', async () => {
  const marker = 'org.ruyi.workbench/execution-probe-v1';
  const seen = [];
  const run = async modify => probeDesktopExecutionReceipts({ callTool: async (name, args, timeout, options) => {
    seen.push(options.meta[marker].nonce);
    assert.equal(name, 'execution_receipt'); assert.equal(timeout, 8000);
    const response = { ok: true, semantic_validation: { semantic_version: 1 }, execution_receipt_version: 1, metadata_transport_supported: true, metadata_probe: {
      schema: 1, context_required: true, nonce: options.meta[marker].nonce, args_semantic_codec: 'ruyi-sdk-json-v1',
      received_semantic_sha256: digest(args.probe_values), acc_worker_id: 'a'.repeat(32), acc_pid: 12345,
    } };
    modify(response); return response;
  } });
  assert.equal((await run(() => {})).ok, true);
  for (const alter of [r => { delete r.metadata_probe; }, r => { r.metadata_probe.nonce = 'b'.repeat(32); },
    r => { r.metadata_probe.received_semantic_sha256 = '0'.repeat(64); }, r => { r.execution_receipt_version = true; },
    r => { r.metadata_probe.args_semantic_codec = 'ruyi-json-f64-v1'; }, r => { r.metadata_probe.acc_pid = 0; },
    r => { r.metadata_probe.acc_worker_id = 'invalid'; }, r => { r.ok = false; },
    r => { delete r.semantic_validation; }, r => { r.metadata_probe.context_required = false; }]) {
    assert.deepEqual(await run(alter), { ok: false, code: 'execution_receipts_unavailable', outcome: 'not_dispatched', action_sent: false });
  }
  assert.equal(new Set(seen).size, seen.length);
});
