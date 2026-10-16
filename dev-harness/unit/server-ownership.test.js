'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fixtureChildEnv } = require('../lib/fixture-home');
Object.assign(process.env, fixtureChildEnv());
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-owner-unit-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
const { ServerOwnership: ownership } = require('../lib/server-internals').loadServerInternals(['ServerOwnership']);
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('OS gate is exclusive; repeated old release cannot release a new owner', async () => {
  const dir = path.join(root, 'exclusive');
  const old = await ownership.acquire([dir]);
  await assert.rejects(ownership.acquire([dir]), { code: 'DATA_ROOT_IN_USE' });
  await old.release();
  const current = await ownership.acquire([dir]);
  try {
    await old.release();
    await assert.rejects(ownership.acquire([dir]), { code: 'DATA_ROOT_IN_USE' });
  } finally { await current.release(); }
});

test('canonical roots collapse junctions and missing leaves without creating directories', async () => {
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, 'junction');
  assert.equal(await ownership.canonicalRoot(alias), await ownership.canonicalRoot(real));
  const missing = path.join(alias, 'not-created', 'child');
  assert.equal(await ownership.canonicalRoot(missing), path.join(await ownership.canonicalRoot(real), 'not-created', 'child'));
  assert.equal(fs.existsSync(missing), false);
  if (process.platform === 'win32') assert.equal(await ownership.canonicalRoot(real.toUpperCase()), await ownership.canonicalRoot(real));
});

test('protocol selection retains Node 20.0 and non-Linux POSIX compatibility', () => {
  assert.match(ownership.endpointFor('root', 'win32', '20.0.0'), /^\\\\\.\\pipe\\ruyi-serve-/);
  assert.equal(ownership.endpointFor('root', 'linux', '20.8.0')[0], '\0');
  assert.equal(ownership.endpointFor('root', 'linux', '24.0.0')[0], '\0');
  assert.match(ownership.endpointFor('root', 'linux', '20.7.0'), /\.sock$/);
  assert.match(ownership.endpointFor('root', 'darwin', '24.0.0'), /\.sock$/);
});

test('unknown legacy runtime blocks without modifying files and releases the acquired gate', async () => {
  const dir = path.join(root, 'unknown');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'runtime.json');
  fs.writeFileSync(file, '{broken');
  await assert.rejects(ownership.acquire([dir]), { code: 'DATA_ROOT_OWNER_UNKNOWN' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.unlinkSync(file);
  const lease = await ownership.acquire([dir]);
  await lease.release();
});
