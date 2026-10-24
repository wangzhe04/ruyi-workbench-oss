'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const repo = process.env.RUYI_CREDENTIAL_STAGE_REPO || path.resolve(__dirname, '../..');
const { constBlock } = require(path.join(repo, 'dev-harness/lib/source-slice'));
const read = name => fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src', name), 'utf8');
const candidate = process.env.RUYI_CREDENTIAL_STAGE_CANDIDATE ? fs.readFileSync(process.env.RUYI_CREDENTIAL_STAGE_CANDIDATE, 'utf8') : read('01k-credential-vault.js');
const code = suffix => error => error.code === 'credential_vault.' + suffix;
function fixture() {
  const source = read('01i-privacy-rules.js') + '\n' + read('01h-privacy-core.js') + '\n' + constBlock(candidate, 'CredentialVault');
  const { core, vault } = vm.runInNewContext(source + '\n({core:PrivacyCore,vault:CredentialVault})', { require, Buffer, URL, structuredClone });
  const wrapping = crypto.randomBytes(32), calls = [], flags = { reads: 0, writes: 0, supported: true, state: vault.empty() };
  const host = { core, size: async () => Buffer.byteLength(JSON.stringify(flags.state)), store: {
    read: async () => { flags.reads++; const copy = structuredClone(flags.state); if (flags.readHook) await flags.readHook(flags.reads); return copy; },
    write: async value => { flags.writes++; flags.state = structuredClone(value); }, invalidate() {},
  }, protector: { supported: () => flags.supported, run: async (op, input, domain) => {
    calls.push({ op, input, domain, domainText: domain.toString('utf8') });
    if (flags.enter && op === flags.enterOp) flags.enter();
    if (flags.gate && op === flags.enterOp) await flags.gate;
    if (flags.throwOp === op) throw Error('synthetic ' + op + ' failure');
    if (op === 'protect') {
      if (flags.mutateInput) input.fill(1);
      if (flags.badWrap) return flags.badWrap;
      const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', wrapping, nonce); cipher.setAAD(domain);
      const result = Buffer.concat([nonce, cipher.update(input), cipher.final(), cipher.getAuthTag()]);
      if (flags.mutateDomain) domain.fill(1);
      return result;
    }
    if (flags.badKey) return flags.badKey;
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrapping, input.subarray(0, 12)); decipher.setAAD(domain); decipher.setAuthTag(input.subarray(-16));
    return Buffer.concat([decipher.update(input.subarray(12, -16)), decipher.final()]);
  } } };
  const api = vault.create(host);
  return { api, vault, core, flags, calls, close: () => { api.clear(); wrapping.fill(0); },
    seed: key => api.protectConfig(JSON.stringify({ credentialEncryptionV1: true, providers: [{ id: 'provider', baseUrl: 'https://synthetic.test', apiKey: key || 'PRIVATE_SYNTHETIC_KEY' }] })) };
}

test('empty vault returns null without initializing, protecting, writing or demanding native support', async () => {
  const f = fixture(); try { f.flags.supported = false; assert.equal(await f.api.snapshotForWorkDataRecovery(), null); assert.equal(f.calls.length, 0); assert.equal(f.flags.writes, 0); assert.equal(f.flags.state.instanceId, ''); }
  finally { f.close(); }
});

test('snapshot includes all historical records and owned master, with parsed-content proof and no writes', async () => {
  const f = fixture(); try {
    await f.seed('first-secret'); await f.seed('second-secret');
    const original = JSON.stringify(f.flags.state), writes = f.flags.writes, offset = f.calls.length;
    const snapshot = await f.api.snapshotForWorkDataRecovery();
    try {
      assert.equal(snapshot.state.records.length, 2); assert.equal(snapshot.proof.serializedState, original);
      assert.equal(snapshot.proof.sha256, crypto.createHash('sha256').update(original).digest('hex'));
      assert.equal(snapshot.lease.instanceId, snapshot.state.instanceId); assert.equal(snapshot.lease.key.length, 32);
      assert.equal(f.flags.writes, writes); assert.equal(JSON.stringify(f.flags.state), original);
      assert.deepEqual(f.calls.slice(offset).map(call => call.op), ['unprotect']);
      assert.ok(f.calls.at(-1).input.equals(Buffer.alloc(f.calls.at(-1).input.length))); assert.ok(f.calls.at(-1).domain.equals(Buffer.alloc(f.calls.at(-1).domain.length)));
      f.api.clear(); assert.ok(!snapshot.lease.key.equals(Buffer.alloc(32)));
    } finally { snapshot.lease.release(); snapshot.lease.release(); }
    assert.ok(snapshot.lease.key.equals(Buffer.alloc(32)));
  } finally { f.close(); }
});

test('snapshot authenticates stale records rather than only current config refs', async () => {
  for (const field of ['envelope', 'owner', 'fingerprint', 'json']) {
    const f = fixture(); try {
      await f.seed('old-unreferenced'); await f.seed('live-secret');
      const snapshot = await f.api.snapshotForWorkDataRecovery();
      try {
        const record = f.flags.state.records[0];
        if (field === 'envelope') record.envelope.tag = Buffer.alloc(16).toString('base64');
        if (field === 'owner') record.owner = '0'.repeat(64);
        if (field === 'fingerprint') record.fingerprint = '0'.repeat(64);
        if (field === 'json') {
          const serialized = 'not-json';
          record.envelope = f.core.seal(serialized, snapshot.lease.key, { instanceId: f.flags.state.instanceId, recordId: record.id, purpose: 'credential' }, 'master-v1');
          record.fingerprint = crypto.createHmac('sha256', snapshot.lease.key).update(record.owner + ':' + serialized).digest('hex');
        }
        const before = JSON.stringify(f.flags.state), writes = f.flags.writes;
        await assert.rejects(f.api.snapshotForWorkDataRecovery(), code('recovery_record_invalid'));
        assert.equal(JSON.stringify(f.flags.state), before); assert.equal(f.flags.writes, writes);
      } finally { snapshot.lease.release(); }
    } finally { f.close(); }
  }
});

test('same-header record change during unprotect rejects the whole parsed state snapshot', async () => {
  const f = fixture(); try {
    await f.seed(); let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }); f.flags.enter = enter; f.flags.enterOp = 'unprotect'; f.flags.gate = new Promise(resolve => { release = resolve; });
    const pending = f.api.snapshotForWorkDataRecovery(); await entered;
    f.flags.state.records[0].fingerprint = '0'.repeat(64); release();
    await assert.rejects(pending, code('recovery_changed'));
  } finally { f.close(); }
});

test('snapshot serializes behind pending config writes and preserves their complete record set', async () => {
  const f = fixture(); try {
    let enter, release; const entered = new Promise(resolve => { enter = resolve; });
    f.flags.enter = enter; f.flags.enterOp = 'protect'; f.flags.gate = new Promise(resolve => { release = resolve; });
    const seed = f.seed(); await entered;
    const pending = f.api.snapshotForWorkDataRecovery(); assert.equal(f.flags.reads, 1); release(); await seed;
    const snapshot = await pending; try { assert.equal(snapshot.state.records.length, 1); assert.equal(f.flags.writes, 1); } finally { snapshot.lease.release(); }
  } finally { f.close(); }
});

test('empty-record master remains recoverable for privacy locals despite cache clear during export', async () => {
  const f = fixture(); try {
    const local = await f.api.sealLocal('PRIVATE_MAPPING_TEXT', 'privacy-scope', 'scope-one'); assert.equal(f.flags.state.records.length, 0);
    let enter, release; const entered = new Promise(resolve => { enter = resolve; }); f.flags.enter = enter; f.flags.enterOp = 'unprotect'; f.flags.gate = new Promise(resolve => { release = resolve; });
    const pending = f.api.snapshotForWorkDataRecovery(); await entered; f.api.clear(); release(); const snapshot = await pending;
    try { assert.equal(snapshot.state.records.length, 0); assert.equal(f.core.open(local.envelope, snapshot.lease.key, { instanceId: local.instanceId, recordId: 'scope-one', purpose: 'privacy-scope' }, 'master-v1'), 'PRIVATE_MAPPING_TEXT'); }
    finally { snapshot.lease.release(); }
  } finally { f.close(); }
});

test('cross-account stage rewrap preserves instance and complete records without touching destination activity', async () => {
  const source = fixture(), destination = fixture(); try {
    const oldConfig = await source.seed('historical-secret'), liveConfig = await source.seed('current-secret');
    await destination.seed('unrelated-destination-secret'); const before = JSON.stringify(destination.flags.state), reads = destination.flags.reads, writes = destination.flags.writes;
    const snapshot = await source.api.snapshotForWorkDataRecovery();
    try {
      const staged = await destination.api.stageRecoveredForWorkData({ state: snapshot.state, key: snapshot.lease.key });
      try {
        assert.equal(staged.state.instanceId, snapshot.state.instanceId); assert.notEqual(staged.state.protectedKey, snapshot.state.protectedKey);
        assert.equal(JSON.stringify(staged.state.records), JSON.stringify(snapshot.state.records)); assert.ok(staged.lease.key.equals(snapshot.lease.key)); assert.notEqual(staged.lease.key, snapshot.lease.key);
        assert.equal(JSON.stringify(destination.flags.state), before); assert.equal(destination.flags.reads, reads); assert.equal(destination.flags.writes, writes);
        const wrapCalls = destination.calls.slice(-2); assert.deepEqual(wrapCalls.map(call => call.op), ['protect', 'unprotect']); assert.ok(wrapCalls.every(call => call.domainText === 'ruyi.credential-vault.v1:' + snapshot.state.instanceId));
        // Simulate the host installing this verified stage into a new root, never overwriting activity.
        destination.flags.state = structuredClone(staged.state); destination.api.clear();
        assert.equal((await destination.api.hydrateConfig(JSON.parse(oldConfig))).raw.providers[0].apiKey, 'historical-secret');
        assert.equal((await destination.api.hydrateConfig(JSON.parse(liveConfig))).raw.providers[0].apiKey, 'current-secret');
      } finally { staged.lease.release(); }
      assert.ok(!snapshot.lease.key.equals(Buffer.alloc(32)));
    } finally { snapshot.lease.release(); }
  } finally { source.close(); destination.close(); }
});

test('stage copies caller records/key before async protect and zeroes only owned buffers', async () => {
  const f = fixture(); try {
    await f.seed(); const snapshot = await f.api.snapshotForWorkDataRecovery(), expectedRecords = JSON.stringify(snapshot.state.records), expectedKey = Buffer.from(snapshot.lease.key);
    let enter, release; const entered = new Promise(resolve => { enter = resolve; }); f.flags.enter = enter; f.flags.enterOp = 'protect'; f.flags.gate = new Promise(resolve => { release = resolve; });
    const pending = f.api.stageRecoveredForWorkData({ state: snapshot.state, key: snapshot.lease.key }); await entered;
    snapshot.state.records.length = 0; snapshot.lease.release(); release();
    const staged = await pending; try { assert.equal(JSON.stringify(staged.state.records), expectedRecords); assert.ok(staged.lease.key.equals(expectedKey)); }
    finally { staged.lease.release(); expectedKey.fill(0); }
  } finally { f.close(); }
});

test('bad key, bad records, malformed state and unsupported protector never write destination', async () => {
  const f = fixture(); try {
    await f.seed(); const snapshot = await f.api.snapshotForWorkDataRecovery();
    try {
      const before = JSON.stringify(f.flags.state), writes = f.flags.writes;
      for (const input of [null, {}, { state: snapshot.state, key: Buffer.alloc(31) }, { state: f.vault.empty(), key: snapshot.lease.key }]) await assert.rejects(f.api.stageRecoveredForWorkData(input), error => /^credential_vault\./.test(error.code));
      await assert.rejects(f.api.stageRecoveredForWorkData({ state: snapshot.state, key: crypto.randomBytes(32) }), code('recovery_record_invalid'));
      const tampered = structuredClone(snapshot.state); tampered.records[0].owner = '0'.repeat(64);
      await assert.rejects(f.api.stageRecoveredForWorkData({ state: tampered, key: snapshot.lease.key }), code('recovery_record_invalid'));
      f.flags.supported = false;
      await assert.rejects(f.api.stageRecoveredForWorkData({ state: snapshot.state, key: snapshot.lease.key }), code('unsupported'));
      assert.equal(JSON.stringify(f.flags.state), before); assert.equal(f.flags.writes, writes);
    } finally { snapshot.lease.release(); }
  } finally { f.close(); }
});

test('native failures, bad roundtrip and malicious input mutation fail closed and permit retry', async () => {
  for (const fault of ['protect', 'unprotect', 'wrong-key', 'short-key', 'bad-wrap', 'mutate-input']) {
    const f = fixture(); try {
      await f.seed(); const snapshot = await f.api.snapshotForWorkDataRecovery();
      try {
        const before = Buffer.from(snapshot.lease.key), writes = f.flags.writes, offset = f.calls.length;
        if (['protect', 'unprotect'].includes(fault)) f.flags.throwOp = fault;
        if (fault === 'wrong-key') f.flags.badKey = crypto.randomBytes(32);
        if (fault === 'short-key') f.flags.badKey = Buffer.alloc(31, 1);
        if (fault === 'bad-wrap') f.flags.badWrap = Buffer.alloc(65537, 1);
        if (fault === 'mutate-input') f.flags.mutateInput = true;
        await assert.rejects(f.api.stageRecoveredForWorkData({ state: snapshot.state, key: snapshot.lease.key }), error => /^credential_vault\./.test(error.code));
        assert.ok(snapshot.lease.key.equals(before)); assert.equal(f.flags.writes, writes);
        for (const call of f.calls.slice(offset)) { assert.ok(call.input.equals(Buffer.alloc(call.input.length))); assert.ok(call.domain.equals(Buffer.alloc(call.domain.length))); }
        if (f.flags.badKey) assert.ok(f.flags.badKey.equals(Buffer.alloc(f.flags.badKey.length)));
        delete f.flags.throwOp; delete f.flags.badKey; delete f.flags.badWrap; delete f.flags.mutateInput;
        const retry = await f.api.stageRecoveredForWorkData({ state: snapshot.state, key: snapshot.lease.key }); retry.lease.release(); before.fill(0);
      } finally { snapshot.lease.release(); }
    } finally { f.close(); }
  }
});

test('fixed credential entropy survives protector domain mutation and never uses work-data purpose', async () => {
  const f = fixture(); try {
    await f.seed(); const snapshot = await f.api.snapshotForWorkDataRecovery();
    try {
      f.flags.mutateDomain = true; const staged = await f.api.stageRecoveredForWorkData({ state: snapshot.state, key: snapshot.lease.key });
      try { const calls = f.calls.slice(-2); assert.equal(calls[0].domainText, calls[1].domainText); assert.ok(calls.every(call => call.domainText.startsWith('ruyi.credential-vault.v1:'))); }
      finally { staged.lease.release(); }
    } finally { snapshot.lease.release(); }
  } finally { f.close(); }
});

test('snapshot native failure bypasses warm cache, erases bad returned buffers and permits retry', async () => {
  for (const fault of ['unsupported', 'unprotect', 'short-key', 'wrong-key', 'late-read']) {
    const f = fixture(); try {
      await f.seed(); const before = JSON.stringify(f.flags.state), writes = f.flags.writes;
      if (fault === 'unsupported') f.flags.supported = false;
      if (fault === 'unprotect') f.flags.throwOp = 'unprotect';
      if (fault === 'short-key') f.flags.badKey = Buffer.alloc(31, 1);
      if (fault === 'wrong-key') f.flags.badKey = crypto.randomBytes(32);
      if (fault === 'late-read') { const next = f.flags.reads + 2; f.flags.readHook = async reads => { if (reads === next) throw Error('late source unavailable'); }; }
      await assert.rejects(f.api.snapshotForWorkDataRecovery(), error => /^credential_vault\./.test(error.code));
      if (f.flags.badKey) assert.ok(f.flags.badKey.equals(Buffer.alloc(f.flags.badKey.length)));
      assert.equal(JSON.stringify(f.flags.state), before); assert.equal(f.flags.writes, writes);
      delete f.flags.throwOp; delete f.flags.badKey; delete f.flags.readHook; f.flags.supported = true;
      const retry = await f.api.snapshotForWorkDataRecovery(); retry.lease.release();
    } finally { f.close(); }
  }
});

test('recovery staging refuses oversized parsed state and noncanonical envelope before native work', async () => {
  const f = fixture(); try {
    await f.seed(); const snapshot = await f.api.snapshotForWorkDataRecovery(), calls = f.calls.length;
    try {
      const oversized = structuredClone(snapshot.state); oversized.records[0].envelope.padding = 'x'.repeat(f.vault.MAX.bytes);
      await assert.rejects(f.api.stageRecoveredForWorkData({ state: oversized, key: snapshot.lease.key }), code('capacity'));
      const malformed = structuredClone(snapshot.state); malformed.protectedKey += '=';
      await assert.rejects(f.api.stageRecoveredForWorkData({ state: malformed, key: snapshot.lease.key }), code('recovery_state_invalid'));
      assert.equal(f.calls.length, calls);
      const arrayOwner = structuredClone(snapshot.state); arrayOwner.records[0].owner = [arrayOwner.records[0].owner];
      await assert.rejects(f.api.stageRecoveredForWorkData({ state: arrayOwner, key: snapshot.lease.key }), code('recovery_record_invalid'));
    } finally { snapshot.lease.release(); }
  } finally { f.close(); }
});

test('credential-only backup format and import semantics remain separate and usable', async () => {
  const f = fixture(), destination = fixture(); try {
    const config = await f.seed(), exported = await f.api.exportBackup(config, 'synthetic-password-1234');
    const row = JSON.parse(exported); assert.equal(row.schema, 1); assert.equal(row.kind, undefined); assert.equal(row.exportId.length, 32);
    const prepared = await destination.api.prepareImport(exported, 'synthetic-password-1234', { runtime: true });
    assert.equal(prepared.runtime.providers[0].apiKey, 'PRIVATE_SYNTHETIC_KEY'); assert.equal(destination.flags.writes, 0);
  } finally { f.close(); destination.close(); }
});
