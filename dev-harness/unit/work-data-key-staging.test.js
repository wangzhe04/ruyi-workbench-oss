'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { test } = require('node:test'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/01o-work-data-keys.js'), 'utf8');
const load = cryptoOverride => vm.runInNewContext(source + '\nWorkDataKeys;', { Buffer, require: name => name === 'node:crypto' && cryptoOverride ? cryptoOverride : require(name) });
const api = load(), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const code = suffix => error => error.code === 'work_data_key.' + suffix;
function fixture(native = api) {
  const wrapping = crypto.randomBytes(32), calls = [], flags = { supported: true, reads: 0, writes: 0, enabled: 0, state: native.empty() };
  const protector = { supported: () => flags.supported, run: async (op, input, domain) => {
    calls.push({ op, input, domain, domainText: domain.toString('utf8') });
    if (flags.enter && op === flags.enterOp) flags.enter();
    if (flags.gate && op === flags.enterOp) await flags.gate;
    if (flags.throw === op) throw new Error('synthetic ' + op + ' failure');
    if (op === 'protect') {
      if (flags.mutateProtectInput) input.fill(1);
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrapping, nonce); cipher.setAAD(domain);
      const result = Buffer.concat([nonce, cipher.update(input), cipher.final(), cipher.getAuthTag()]); flags.wrapped = result;
      if (flags.mutateProtectDomain) domain.fill(1);
      if (flags.badWrap) return flags.badWrap;
      return result;
    }
    if (flags.badRoundtrip) return (flags.roundtrip = flags.badRoundtrip);
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrapping, input.subarray(0, 12)); decipher.setAAD(domain); decipher.setAuthTag(input.subarray(-16));
    return (flags.roundtrip = Buffer.concat([decipher.update(input.subarray(12, -16)), decipher.final()]));
  } };
  const keys = native.create({ protector, store: { read: async () => { flags.reads++; return structuredClone(flags.state); }, write: async state => { flags.writes++; flags.state = structuredClone(state); } },
    enabled: async () => { flags.enabled++; return false; } });
  return { keys, flags, calls, close: () => { keys.clear(); wrapping.fill(0); } };
}

test('explicit staging while OFF creates verified independent headers and leases without touching active authority', async () => {
  const f = fixture(); try {
    const first = await f.keys.stageNew(), second = await f.keys.stageNew();
    try {
      assert.ok(api.validate(first.header)); assert.notEqual(first.header.instanceId, second.header.instanceId);
      assert.ok(!first.lease.key.equals(second.lease.key)); assert.equal(first.lease.instanceId, first.header.instanceId);
      assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.header)); assert.ok(Object.isFrozen(first.lease));
      assert.deepEqual(f.calls.map(call => call.op), ['protect', 'unprotect', 'protect', 'unprotect']);
      assert.ok(same(f.flags.state, api.empty())); assert.equal(f.flags.reads, 0); assert.equal(f.flags.writes, 0); assert.equal(f.flags.enabled, 0);
      for (const call of f.calls) { assert.ok(call.input.equals(Buffer.alloc(call.input.length))); assert.ok(call.domain.equals(Buffer.alloc(call.domain.length))); }
      assert.ok(!first.lease.key.equals(Buffer.alloc(32)), 'finally cleared only temporaries');
    } finally { first.lease.release(); first.lease.release(); second.lease.release(); }
    assert.ok(first.lease.key.equals(Buffer.alloc(32)));
  } finally { f.close(); }
});

test('recovery preserves portable instance and master while rewrapping for a different local account', async () => {
  const original = fixture(), destination = fixture();
  try {
    const sourceStage = await original.keys.stageNew();
    try {
      const recovered = await destination.keys.stageRecovered({ instanceId: sourceStage.header.instanceId, key: sourceStage.lease.key });
      try {
        assert.equal(recovered.header.instanceId, sourceStage.header.instanceId); assert.notEqual(recovered.header.protectedKey, sourceStage.header.protectedKey);
        assert.ok(recovered.lease.key.equals(sourceStage.lease.key)); assert.notEqual(recovered.lease.key, sourceStage.lease.key);
        assert.equal(destination.flags.reads + destination.flags.writes + destination.flags.enabled, 0);
        assert.ok(destination.calls.every(call => call.domainText === 'ruyi.work-data.v1:' + sourceStage.header.instanceId));
        destination.flags.state = structuredClone(recovered.header);
        const reopened = await destination.keys.snapshot(); try { assert.ok(reopened.key.equals(sourceStage.lease.key)); } finally { reopened.release(); }
      } finally { recovered.lease.release(); }
      assert.ok(!sourceStage.lease.key.equals(Buffer.alloc(32)));
    } finally { sourceStage.lease.release(); }
  } finally { original.close(); destination.close(); }
});

test('staging cannot replace or invalidate an existing active key cache', async () => {
  const f = fixture(); try {
    const initial = await f.keys.stageNew(); f.flags.state = structuredClone(initial.header);
    const active = await f.keys.snapshot(); active.release();
    const before = { reads: f.flags.reads, enabled: f.flags.enabled, calls: f.calls.length }, header = structuredClone(f.flags.state);
    const staged = await f.keys.stageNew();
    try {
      assert.ok(same(f.flags.state, header)); assert.equal(f.flags.reads, before.reads); assert.equal(f.flags.enabled, before.enabled); assert.equal(f.flags.writes, 0);
      const after = await f.keys.snapshot(); try { assert.ok(after.key.equals(initial.lease.key)); assert.equal(f.calls.length, before.calls + 2, 'existing cache remains warm'); } finally { after.release(); }
    } finally { staged.lease.release(); initial.lease.release(); }
  } finally { f.close(); }
});

test('stageRecovered owns input bytes before await and clear cannot erase a returned staging lease', async () => {
  const f = fixture(), key = crypto.randomBytes(32), expected = Buffer.from(key), instanceId = 'c'.repeat(32);
  try {
    let enter, release; const entered = new Promise(resolve => { enter = resolve; }); f.flags.enter = enter; f.flags.enterOp = 'protect'; f.flags.gate = new Promise(resolve => { release = resolve; });
    const input = { instanceId, key }, pending = f.keys.stageRecovered(input); await entered;
    key.fill(0); input.instanceId = 'd'.repeat(32); input.key = Buffer.alloc(1); f.keys.clear(); release();
    const staged = await pending;
    try { assert.equal(staged.header.instanceId, instanceId); assert.ok(staged.lease.key.equals(expected)); f.keys.clear(); assert.ok(staged.lease.key.equals(expected)); }
    finally { staged.lease.release(); }
  } finally { expected.fill(0); f.close(); }
});

test('invalid staging inputs and unsupported platform cause no protector or authority operations', async () => {
  const f = fixture(), key = crypto.randomBytes(32); try {
    for (const input of [null, [], {}, { instanceId: 'bad', key }, { instanceId: 'a'.repeat(32), key, extra: true }]) await assert.rejects(f.keys.stageRecovered(input), code('invalid'));
    await assert.rejects(f.keys.stageRecovered({ instanceId: 'a'.repeat(32), key: Buffer.alloc(31) }), code('key_invalid'));
    f.flags.supported = false;
    await assert.rejects(f.keys.stageNew(), code('unsupported')); await assert.rejects(f.keys.stageRecovered({ instanceId: 'a'.repeat(32), key }), code('unsupported'));
    assert.equal(f.calls.length, 0); assert.equal(f.flags.reads + f.flags.writes + f.flags.enabled, 0); assert.ok(!key.equals(Buffer.alloc(32)));
  } finally { key.fill(0); f.close(); }
});

test('protect and roundtrip failures erase owned temporaries, return no lease and permit a clean retry', async () => {
  for (const fault of ['protect-throw', 'unprotect-throw', 'wrong-master', 'short-master', 'empty-wrap', 'oversize-wrap']) {
    const f = fixture(), key = crypto.randomBytes(32), before = Buffer.from(key); try {
      if (fault.endsWith('-throw')) f.flags.throw = fault.split('-')[0];
      if (fault === 'wrong-master') f.flags.badRoundtrip = crypto.randomBytes(32);
      if (fault === 'short-master') f.flags.badRoundtrip = Buffer.alloc(31, 1);
      if (fault === 'empty-wrap') f.flags.badWrap = Buffer.alloc(0);
      if (fault === 'oversize-wrap') f.flags.badWrap = Buffer.alloc(65537, 1);
      await assert.rejects(f.keys.stageRecovered({ instanceId: 'e'.repeat(32), key }), code(fault === 'protect-throw' || fault.endsWith('-wrap') ? 'protect_failed' : 'roundtrip_failed'));
      assert.ok(key.equals(before)); assert.equal(f.flags.reads + f.flags.writes + f.flags.enabled, 0);
      for (const call of f.calls) { assert.ok(call.input.equals(Buffer.alloc(call.input.length))); assert.ok(call.domain.equals(Buffer.alloc(call.domain.length))); }
      if (f.flags.roundtrip) assert.ok(f.flags.roundtrip.equals(Buffer.alloc(f.flags.roundtrip.length)));
      delete f.flags.throw; delete f.flags.badWrap; delete f.flags.badRoundtrip;
      const retry = await f.keys.stageRecovered({ instanceId: 'e'.repeat(32), key }); try { assert.ok(retry.lease.key.equals(before)); } finally { retry.lease.release(); }
    } finally { key.fill(0); before.fill(0); f.close(); }
  }
});

test('roundtrip uses fixed original work-data domain after a protector mutates its first entropy argument', async () => {
  const f = fixture(); try {
    f.flags.mutateProtectDomain = true;
    const staged = await f.keys.stageNew();
    try { assert.equal(f.calls[0].domainText, f.calls[1].domainText); assert.notEqual(f.calls[0].domain, f.calls[1].domain); }
    finally { staged.lease.release(); }
  } finally { f.close(); }
});

test('protector mutation cannot silently replace the recovered portable master', async () => {
  const f = fixture(), input = crypto.randomBytes(32), expected = Buffer.from(input); try {
    f.flags.mutateProtectInput = true;
    await assert.rejects(f.keys.stageRecovered({ instanceId: 'f'.repeat(32), key: input }), code('roundtrip_failed'));
    assert.ok(input.equals(expected)); assert.equal(f.flags.reads + f.flags.writes + f.flags.enabled, 0);
    assert.ok(f.flags.roundtrip.equals(Buffer.alloc(32)));
  } finally { input.fill(0); expected.fill(0); f.close(); }
});

test('random instance failure erases generated staging master, with no active writes or implicit publication', async () => {
  let captured, failOnce = true;
  const controlled = load({ ...crypto, randomBytes: size => {
    if (size === 16 && failOnce) { failOnce = false; throw new Error('synthetic staging instance RNG failure'); }
    const result = crypto.randomBytes(size); if (size === 32 && !captured) captured = result; return result;
  } });
  const f = fixture(controlled); try {
    await assert.rejects(f.keys.stageNew(), /synthetic staging instance RNG failure/); assert.ok(captured.equals(Buffer.alloc(32))); assert.equal(f.calls.length, 0);
    const retry = await f.keys.stageNew(); retry.lease.release(); assert.equal(f.flags.reads + f.flags.writes + f.flags.enabled, 0);
  } finally { f.close(); }
});
