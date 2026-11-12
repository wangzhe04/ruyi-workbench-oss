'use strict';
// Fixture-only CurrentUser DPAPI setup and read observation. The real server
// remains the only business writer. No key or decrypted business data is sent
// to disk by this observer, and no owner-shaped stub is used to bind a root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertRunCoordinates, assertRunIdentity } = require('./sealed-run-contract.cjs');

function assertSameDirectory(left, right) {
  // RootAuthority canonicalizes Windows names; a manifest may preserve the
  // original spelling. Compare real directories, not caller spelling alone.
  const real = value => fs.realpathSync.native(value);
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  assert.equal(fold(real(left)), fold(real(right)), 'different physical root path');
  const a = fs.lstatSync(left, { bigint: true }), b = fs.lstatSync(right, { bigint: true });
  assert.ok(a.isDirectory() && b.isDirectory() && !a.isSymbolicLink() && !b.isSymbolicLink(), 'real directory identities required');
  assert.ok(a.ino > 0n && b.ino > 0n && a.dev === b.dev && a.ino === b.ino, 'different physical directory identity');
}

function requestShape(message) {
  assert.ok(message && typeof message === 'object' && !Array.isArray(message));
  assert.ok(Number.isSafeInteger(message.id) && message.id > 0);
  assert.ok(['ledger', 'journal', 'run'].includes(message.op), 'read-only observer operation');
  assert.deepEqual(Object.keys(message).sort(), message.op === 'run' ? ['id', 'op', 'runId', 'sid'] : message.op === 'journal' ? ['id', 'op', 'sid'] : ['id', 'op']);
  if (message.op !== 'ledger') assert.match(message.sid, /^[A-Za-z0-9_-]{1,128}$/, 'session identity, never a caller path');
  if (message.op === 'run') assertRunCoordinates(message.sid, message.runId);
  return message;
}

async function readObservation(api, selected, manifest, raw) {
  const message = requestShape(raw);
  const verifyRoot = async () => {
    const current = await manifest.readActive();
    assertSameDirectory(current.root, selected.root); assert.equal(current.mode, 'encrypted');
    assert.equal(current.id, selected.id); assert.equal(current.generation, selected.generation);
    assert.equal(current.proof.sha256, selected.proof.sha256, 'active authority changed');
  };
  await verifyRoot();
  let value;
  if (message.op === 'ledger') value = await api.externalBotReadState();
  else if (message.op === 'run') {
    value = await api.readAgentRunSnapshot(message.sid, message.runId, { strict: true });
    assertRunIdentity(value, message.sid, message.runId);
  }
  else {
    const text = fs.readFileSync(path.join(selected.root, 'sessions', message.sid + '.interventions.ndjson'), 'utf8');
    const decoded = await api.decodeSessionJournalText(message.sid, 'interventions', text);
    value = decoded.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  await verifyRoot();
  return value;
}

async function serve(home) {
  assert.equal(process.platform, 'win32', 'real Windows CurrentUser DPAPI required');
  assert.equal(typeof process.send, 'function', 'original IPC channel required');
  assert.ok(path.isAbsolute(home));
  assert.equal(fs.realpathSync.native(home).toLowerCase(), home.toLowerCase());
  assert.equal(path.basename(home), 'home');
  assert.match(path.basename(path.dirname(home)), /^ruyi-c2-actual-[A-Za-z0-9]{6}$/);
  assert.equal(process.env.RUYI_HOME, home);
  assert.deepEqual(fs.readdirSync(home), ['config.json'], 'seed only a new isolated home');
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(config.workDataEncryptionV1, true);
  const api = require('../server-internals.js').loadServerInternals([
    'WorkDataManifest', 'WorkDataKeys', 'LocalSecretCrypto', 'ServerOwnership', 'atomicWriteJson',
    'WorkDataRootHooks', 'workDataKeys', 'externalBotReadState', 'decodeSessionJournalText', 'readAgentRunSnapshot', 'paths',
  ]);
  const manifest = api.WorkDataManifest.create({ base: home });
  const owner = await api.ServerOwnership.acquire([home]);
  let keys, staged, selected;
  try {
    const initial = await manifest.readActive();
    const encrypted = await manifest.prepare({ expected: initial, mode: 'encrypted' });
    keys = api.WorkDataKeys.create({ store: { read: async () => { throw Error('unexpected seed read'); } },
      enabled: () => false, protector: api.LocalSecretCrypto });
    staged = await keys.stageNew();
    await api.atomicWriteJson(path.join(encrypted.root, 'work-data-key-v1.json'), staged.header);
    await api.atomicWriteJson(path.join(encrypted.root, 'config.json'), config);
    await manifest.commit({ expected: initial, candidate: encrypted });
    selected = await api.WorkDataRootHooks.bind(owner);
    assertSameDirectory(selected.root, encrypted.root);
    assert.equal(selected.mode, 'encrypted');
    assert.equal(api.paths.data, selected.root);
  } finally {
    staged?.lease.release(); keys?.clear(); api.workDataKeys.clear();
    await owner.release();
  }
  // As in the sealed retention fixture, production readers retain their bound
  // namespace after setup releases the OS owner. Every observation rechecks the
  // real active manifest; this process never reacquires or impersonates serve.
  let tail = Promise.resolve();
  process.on('message', raw => {
    tail = tail.then(async () => {
      let message;
      try {
        message = requestShape(raw);
        const value = await readObservation(api, selected, manifest, message);
        process.send({ id: message.id, value });
      } catch (error) {
        process.send({ id: Number.isSafeInteger(raw?.id) ? raw.id : null,
          error: { code: error.code || '', message: error.message } });
      }
    });
    tail.catch(error => { console.error(error.stack || error); process.exitCode = 1; process.disconnect(); });
  });
  process.on('disconnect', () => { api.workDataKeys.clear(); });
  process.send({ id: 0, value: { root: selected.root, mode: selected.mode, id: selected.id,
    generation: selected.generation, manifestSha256: selected.proof.sha256, dpapi: 'Windows CurrentUser; production LocalSecretCrypto' } });
}

if (require.main === module) {
  assert.equal(process.argv.length, 3, 'observer receives only its isolated home');
  serve(process.argv[2]).catch(error => { console.error(error.stack || error); process.exitCode = 1; if (process.connected) process.disconnect(); });
}
module.exports = { requestShape, readObservation, assertSameDirectory };
