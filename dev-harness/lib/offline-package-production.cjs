'use strict';
// Manual package driver child. Uses the stage's real production readers/DPAPI
// and an actual ServerOwnership lease, never an owner-shaped test substitute.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { assertSameDirectory } = require('./external-bots-c2/sealed-observer.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function run(job) {
  assert.equal(process.platform, 'win32');
  assert.ok(['seed', 'inspect'].includes(job.op));
  for (const value of [job.stage, job.output, job.data]) assert.ok(typeof value === 'string' && path.isAbsolute(value));
  assert.equal(path.resolve(job.data), path.join(path.resolve(job.output), 'encrypted', 'data'));
  const marker = JSON.parse(fs.readFileSync(path.join(job.output, 'qualification-owner.json'), 'utf8'));
  assert.equal(marker.nonce, process.env.RUYI_PACKAGE_QUALIFICATION_NONCE);
  assert.equal(marker.stage, job.stage);
  assert.equal(process.env.RUYI_HOME, job.data);
  assert.equal(hash(path.join(job.stage, 'app/server.js')), job.expectedServerSha);
  if (job.op === 'seed') assert.deepEqual(fs.readdirSync(job.data), ['config.json'], 'seed only an isolated newly created data root');
  process.env.RUYI_TEST_SERVER_JS = path.join(job.stage, 'app/server.js');
  const api = require('./server-internals').loadServerInternals([
    'WorkDataManifest', 'WorkDataKeys', 'LocalSecretCrypto', 'ServerOwnership', 'atomicWriteJson',
    'WorkDataRootHooks', 'workDataKeys', 'loadSession', 'paths',
  ]);
  const manifest = api.WorkDataManifest.create({ base: job.data });
  let owner, keys, staged, result, primary;
  try {
    owner = await api.ServerOwnership.acquire([job.data]);
    if (job.op === 'seed') {
      const config = JSON.parse(fs.readFileSync(path.join(job.data, 'config.json'), 'utf8'));
      assert.equal(config.workDataEncryptionV1, true);
      const initial = await manifest.readActive(), encrypted = await manifest.prepare({ expected: initial, mode: 'encrypted' });
      keys = api.WorkDataKeys.create({ store: { read: async () => { throw Error('unexpected seed read'); } },
        enabled: () => false, protector: api.LocalSecretCrypto });
      staged = await keys.stageNew();
      await api.atomicWriteJson(path.join(encrypted.root, 'work-data-key-v1.json'), staged.header);
      await api.atomicWriteJson(path.join(encrypted.root, 'config.json'), config);
      await manifest.commit({ expected: initial, candidate: encrypted });
    }
    const selected = await api.WorkDataRootHooks.bind(owner), active = await manifest.readActive();
    assertSameDirectory(selected.root, active.root); assert.equal(selected.mode, 'encrypted');
    assert.equal(selected.id, active.id); assert.equal(selected.generation, active.generation);
    assert.equal(selected.proof.sha256, active.proof.sha256); assert.equal(api.paths.data, selected.root);
    result = { mode: selected.mode, root: selected.root, id: selected.id, generation: selected.generation,
      manifestSha256: selected.proof.sha256, dpapi: 'Windows CurrentUser; production LocalSecretCrypto', node: process.version };
    if (job.op === 'inspect') {
      assertSameDirectory(selected.root, job.selected.root);
      for (const key of ['id', 'generation', 'manifestSha256']) assert.equal(result[key], job.selected[key]);
      assert.match(job.sessionId, /^[A-Za-z0-9_-]{1,64}$/);
      const session = await api.loadSession(job.sessionId); assert.equal(session?.id, job.sessionId);
      result.session = { id: session.id, title: session.title, turnSeq: session.turnSeq,
        messages: session.messages, providerHistory: session.providerHistory, storageVersion: session.storageVersion };
      const after = await manifest.readActive();
      assertSameDirectory(after.root, selected.root); assert.equal(after.proof.sha256, selected.proof.sha256);
      assert.equal(after.id, selected.id); assert.equal(after.generation, selected.generation); assert.equal(after.mode, 'encrypted');
    }
  } catch (error) { primary = error; }
  const cleanup = [];
  for (const release of [() => staged?.lease.release(), () => keys?.clear(), () => api.workDataKeys.clear(), () => owner?.release()]) {
    try { await release(); } catch (error) { cleanup.push(error); }
  }
  if (cleanup.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanup], 'package production reader cleanup failed', { cause: primary || cleanup[0] });
  if (primary) throw primary;
  assert.equal(hash(path.join(job.stage, 'app/server.js')), job.expectedServerSha);
  return result;
}
if (require.main === module) {
  assert.equal(process.argv.length, 3, 'one controlled job file required');
  run(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
module.exports = { run };
