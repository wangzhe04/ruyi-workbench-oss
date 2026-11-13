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
const { ServerOwnership: ownership, guardFileToolPath, isSensitiveDataPath, sensitiveGlobsForRg } =
  require('../lib/server-internals').loadServerInternals(['ServerOwnership', 'guardFileToolPath', 'isSensitiveDataPath', 'sensitiveGlobsForRg']);
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('OS gate is exclusive; repeated old release cannot release a new owner', async () => {
  const dir = path.join(root, 'exclusive');
  fs.mkdirSync(dir);
  const old = await ownership.acquire([dir]);
  assert.equal(old.isHeld(), true);
  await assert.rejects(ownership.acquire([dir]), { code: 'DATA_ROOT_IN_USE' });
  const releasing = old.release();
  assert.equal(old.isHeld(), false, 'release revokes authority synchronously before close finishes');
  await releasing;
  const current = await ownership.acquire([dir]);
  assert.equal(current.isHeld(), true);
  try {
    await old.release();
    assert.equal(old.isHeld(), false);
    assert.equal(current.isHeld(), true);
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
  assert.match(ownership.endpointFor('root', 'darwin', '24.0.0'), /^\/private\/tmp\/ruyi-serve-v1-\w+\/[a-f0-9]{32}\.lock$/);
  assert.match(ownership.legacyEndpointFor('root'), /\.sock$/);
});

test('Mac kernel lock is independent of TMPDIR and retained through a live legacy socket', { skip: process.platform !== 'darwin' }, async () => {
  const dir = path.join(root, 'temp-independent');
  fs.mkdirSync(dir);
  const canonical = await ownership.canonicalRoot(dir);
  const originalTemp = process.env.TMPDIR;
  const first = await ownership.acquire([dir]);
  const endpoint = ownership.endpointFor(canonical);
  const inode = fs.statSync(endpoint).ino;
  try {
    process.env.TMPDIR = path.join(root, 'long-' + 'x'.repeat(140));
    assert.equal(ownership.endpointFor(canonical), endpoint);
    await assert.rejects(ownership.acquire([dir]), { code: 'DATA_ROOT_IN_USE' });
  } finally {
    if (originalTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTemp;
    await first.release();
  }
  const second = await ownership.acquire([dir]);
  try { assert.equal(fs.statSync(endpoint).ino, inode, 'the persistent lock inode must not be replaced'); }
  finally { await second.release(); }
});

test('Mac refuses symlink and hardlink lock files without touching their targets', { skip: process.platform !== 'darwin' }, async () => {
  for (const kind of ['symlink', 'hardlink']) {
    const dir = path.join(root, kind);
    const canonical = await ownership.canonicalRoot(dir);
    const lock = ownership.endpointFor(canonical);
    const target = path.join(root, kind + '-target');
    fs.writeFileSync(target, 'keep', { mode: 0o600 });
    if (kind === 'symlink') fs.symlinkSync(target, lock); else fs.linkSync(target, lock);
    try {
      await assert.rejects(ownership.acquire([dir]), { code: 'DATA_ROOT_OWNER_UNKNOWN' });
      assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
      assert.equal(fs.lstatSync(lock).isSymbolicLink(), kind === 'symlink');
    } finally { fs.unlinkSync(lock); }
  }
});

test('Mac preserves unknown residual sockets and malformed ownership evidence', { skip: process.platform !== 'darwin' }, async () => {
  const cp = require('child_process');
  for (const evidence of ['missing', 'null', 'wrong-inode']) {
    const canonical = await ownership.canonicalRoot(path.join(root, 'unknown-socket-' + evidence));
    const endpoint = ownership.legacyEndpointFor(canonical);
    const recordFile = ownership.socketRecordFor(canonical);
    const child = cp.spawnSync(process.execPath, ['-e',
      "require('net').createServer().listen(process.argv[1],()=>process.exit(0))", endpoint],
    { env: process.env, timeout: 5000, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const stat = fs.lstatSync(endpoint);
    if (evidence !== 'missing') fs.writeFileSync(recordFile, evidence === 'null' ? 'null' : JSON.stringify({
      schema: 1, canonical, endpoint, pid: child.pid, dev: stat.dev, ino: stat.ino + 1, birthtimeMs: stat.birthtimeMs,
    }), { mode: 0o600 });
    try {
      await assert.rejects(ownership.acquire([canonical]), { code: 'DATA_ROOT_OWNER_UNKNOWN' });
      assert.equal(fs.lstatSync(endpoint).ino, stat.ino);
    } finally {
      fs.unlinkSync(endpoint); // only the socket this fixture just created
      fs.rmSync(recordFile, { force: true });
    }
  }
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

test('Mac never removes a live socket even with matching stale-owner metadata', { skip: process.platform !== 'darwin' }, async () => {
  const canonical = await ownership.canonicalRoot(path.join(root, 'live-socket'));
  const endpoint = ownership.legacyEndpointFor(canonical);
  const recordFile = ownership.socketRecordFor(canonical);
  const dead = require('child_process').spawnSync(process.execPath, ['-e', ''], { env: process.env, timeout: 5000 });
  assert.equal(dead.status, 0);
  const server = require('net').createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  const stat = fs.lstatSync(endpoint);
  fs.writeFileSync(recordFile, JSON.stringify({ schema: 1, canonical, endpoint, pid: dead.pid,
    dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }), { mode: 0o600 });
  try {
    await assert.rejects(ownership.acquire([canonical]), { code: 'DATA_ROOT_OWNER_UNKNOWN' });
    assert.equal(fs.lstatSync(endpoint).ino, stat.ino);
    assert.equal(server.listening, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(recordFile, { force: true });
  }
});

test('Mac ownership namespace is protected from file tools even in bypass workspaces', { skip: process.platform !== 'darwin' }, async () => {
  const canonical = await ownership.canonicalRoot(path.join(root, 'protected-lock'));
  const lease = await ownership.acquire([canonical]);
  const lock = ownership.endpointFor(canonical);
  const alias = path.join(root, 'lock-alias');
  fs.symlinkSync(lock, alias);
  const ctx = { effectivePermissionMode: 'bypass', config: {
    permissionMode: 'bypass', allowOutsideWorkspace: true, defaultWorkspace: root,
    workspaces: [{ path: '/private/tmp', read: true, write: true, execute: true }],
  } };
  try {
    const dataAlias = '/System/Volumes/Data' + lock;
    assert.equal(fs.statSync(dataAlias, { bigint: true }).ino, fs.statSync(lock, { bigint: true }).ino);
    for (const target of [lock, lock.replace('/private/tmp/', '/tmp/'), dataAlias, ownership.socketRecordFor(canonical),
      '/System/Volumes/Data' + ownership.socketRecordFor(canonical), alias]) {
      for (const write of [false, true]) {
        const result = await guardFileToolPath(target, ctx, { tool: write ? 'file_write' : 'file_read', write });
        assert.equal(result.ok, false, target);
        assert.equal(result.code, 'not-allowed');
      }
    }
    assert.equal(isSensitiveDataPath(path.join(root, 'ruyi-serve-v1-501', 'ordinary.txt')), false);
    assert.ok(sensitiveGlobsForRg('/private/tmp').includes('!/ruyi-serve-v1-[0-9]*/'));
    assert.ok(sensitiveGlobsForRg('/System/Volumes/Data/private/tmp').includes('!/ruyi-serve-v1-[0-9]*/'));
  } finally { await lease.release(); }
});

test('Mac FIFO ownership records fail promptly on both read and write paths', { skip: process.platform !== 'darwin' }, async () => {
  const cp = require('child_process');
  const loader = require.resolve('../lib/server-internals');
  for (const mode of ['read', 'write']) {
    const canonical = await ownership.canonicalRoot(path.join(root, 'fifo-' + mode));
    const endpoint = ownership.legacyEndpointFor(canonical);
    const record = ownership.socketRecordFor(canonical);
    fs.mkdirSync(path.dirname(record), { recursive: true, mode: 0o700 });
    if (mode === 'read') {
      const stale = cp.spawnSync(process.execPath, ['-e',
        "require('net').createServer().listen(process.argv[1],()=>process.exit(0))", endpoint],
      { env: process.env, timeout: 3000, encoding: 'utf8' });
      assert.equal(stale.status, 0, stale.stderr);
    }
    const fifo = cp.spawnSync('/usr/bin/mkfifo', ['-m', '600', record], { env: process.env, timeout: 3000 });
    assert.equal(fifo.status, 0);
    try {
      const child = cp.spawnSync(process.execPath, ['-e', `
        const { ServerOwnership } = require(${JSON.stringify(loader)}).loadServerInternals(['ServerOwnership']);
        ServerOwnership.acquire([${JSON.stringify(canonical)}]).then(async lease => {
          await lease.release(); process.exitCode = 2;
        }, error => { console.log(error.code); process.exitCode = error.code === 'DATA_ROOT_OWNER_UNKNOWN' ? 0 : 1; });
      `], { env: process.env, timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8' });
      assert.equal(child.error, undefined, mode + ': ' + child.error);
      assert.equal(child.status, 0, mode + ': ' + child.stderr);
      assert.match(child.stdout, /DATA_ROOT_OWNER_UNKNOWN/);
      assert.equal(fs.lstatSync(record).isFIFO(), true);
      if (mode === 'read') assert.equal(fs.lstatSync(endpoint).isSocket(), true);
    } finally {
      fs.rmSync(record, { force: true });
      fs.rmSync(endpoint, { force: true });
    }
  }
});

test('Mac socket ownership reads remain bounded when the record grows after stat', { skip: process.platform !== 'darwin' }, async () => {
  const cp = require('child_process');
  const canonical = await ownership.canonicalRoot(path.join(root, 'growing-record'));
  const endpoint = ownership.legacyEndpointFor(canonical);
  const recordFile = ownership.socketRecordFor(canonical);
  fs.mkdirSync(path.dirname(recordFile), { recursive: true, mode: 0o700 });
  const stale = cp.spawnSync(process.execPath, ['-e',
    "require('net').createServer().listen(process.argv[1],()=>process.exit(0))", endpoint],
  { env: process.env, timeout: 3000, encoding: 'utf8' });
  assert.equal(stale.status, 0, stale.stderr);
  const stat = fs.lstatSync(endpoint);
  fs.writeFileSync(recordFile, JSON.stringify({ schema: 1, canonical, endpoint, pid: stale.pid,
    dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }), { mode: 0o600 });
  try {
    const child = cp.spawnSync(process.execPath, ['-e', `
      const fs = require('fs');
      const open = fs.openSync, fstat = fs.fstatSync;
      let recordFd, checks = 0, grew = false;
      fs.openSync = function(file, ...args) {
        const fd = open.call(this, file, ...args);
        if (file === ${JSON.stringify(recordFile)}) recordFd = fd;
        return fd;
      };
      fs.fstatSync = function(fd, ...args) {
        const stat = fstat.call(this, fd, ...args);
        if (fd === recordFd && ++checks === 2) {
          fs.appendFileSync(${JSON.stringify(recordFile)}, ' '.repeat(1024 * 1024)); grew = true;
        }
        return stat;
      };
      const { ServerOwnership } = require(${JSON.stringify(require.resolve('../lib/server-internals'))}).loadServerInternals(['ServerOwnership']);
      ServerOwnership.acquire([${JSON.stringify(canonical)}]).then(async lease => {
        await lease.release(); process.exitCode = 2;
      }, error => { console.log(error.code); process.exitCode = grew && error.code === 'DATA_ROOT_OWNER_UNKNOWN' ? 0 : 1; });
    `], { env: process.env, timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8' });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /DATA_ROOT_OWNER_UNKNOWN/);
    assert.equal(fs.lstatSync(endpoint).ino, stat.ino);
  } finally {
    fs.rmSync(endpoint, { force: true });
    fs.rmSync(recordFile, { force: true });
  }
});

test('Mac APFS Data-volume aliases share one cold-start lock and missing-leaf identity', { skip: process.platform !== 'darwin' }, async () => {
  const directory = path.join(root, 'apfs-identity'); fs.mkdirSync(directory);
  const primary = fs.realpathSync(directory);
  const dataAlias = '/System/Volumes/Data' + primary;
  assert.equal(fs.statSync(primary, { bigint: true }).ino, fs.statSync(dataAlias, { bigint: true }).ino);
  assert.equal(await ownership.canonicalRoot(dataAlias), await ownership.canonicalRoot(primary));
  assert.equal(await ownership.canonicalRoot(path.join(dataAlias, 'missing', 'leaf')),
    await ownership.canonicalRoot(path.join(primary, 'missing', 'leaf')));
  for (const [first, second] of [[primary, dataAlias], [dataAlias, primary]]) {
    const lease = await ownership.acquire([first]);
    try { await assert.rejects(ownership.acquire([second]), { code: 'DATA_ROOT_IN_USE' }); }
    finally { await lease.release(); }
  }
});

test('Mac stored casing and trailing whitespace produce one existing-root lock with legacy aliases', { skip: process.platform !== 'darwin' }, async t => {
  const directory = path.join(root, 'Stored Case \n'); fs.mkdirSync(directory);
  const primary = fs.realpathSync(directory);
  const variant = primary.toUpperCase();
  if (!fs.existsSync(variant)) { t.skip('requires a case-insensitive fixture volume'); return; }
  assert.equal(await ownership.canonicalRoot(variant), primary);
  const dataVariant = '/SYSTEM/VOLUMES/DATA' + variant;
  assert.equal(await ownership.canonicalRoot(dataVariant), primary);
  const lease = await ownership.acquire([dataVariant]);
  try {
    await assert.rejects(ownership.acquire([primary]), { code: 'DATA_ROOT_IN_USE' });
    assert.equal(fs.lstatSync(ownership.legacyEndpointFor(await fs.promises.realpath(dataVariant))).isSocket(), true,
      'the original algorithm socket for the supplied spelling remains reserved');
  } finally { await lease.release(); }
});

test('Mac startup gate covers partially created ancestors and queues unrelated new roots', { skip: process.platform !== 'darwin' }, async t => {
  const base = path.join(root, 'Partial Parent'); fs.mkdirSync(base);
  if (!fs.existsSync(base.toUpperCase())) { t.skip('requires a case-insensitive fixture volume'); return; }
  const directory = path.join(base, 'NewParent', 'Child');
  const alias = path.join(base, 'NEWPARENT', 'CHILD');
  const lease = await ownership.acquire([directory]);
  let second;
  try {
    fs.mkdirSync(path.dirname(directory)); // pause recursive creation before the final component
    let settled = false;
    const attempt = ownership.acquire([alias]).then(value => { settled = true; second = value; return null; },
      error => { settled = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(settled, false, 'the partially created ancestor must not create a new admission gate');
    fs.mkdirSync(directory);
    await lease.releaseStartup();
    const error = await attempt;
    assert.equal(error && error.code, 'DATA_ROOT_IN_USE');
  } finally { if (second) await second.release(); await lease.release(); }

  const firstRoot = path.join(base, 'first-new');
  const otherRoot = path.join(base, 'other-new');
  const first = await ownership.acquire([firstRoot]);
  let other;
  try {
    const pending = ownership.acquire([otherRoot]).then(value => { other = value; return value; });
    fs.mkdirSync(firstRoot);
    await first.releaseStartup();
    await pending;
    fs.mkdirSync(otherRoot);
    await other.releaseStartup();
    assert.notEqual(first.roots[0], other.roots[0], 'different data roots remain independently usable after admission');
  } finally { if (other) await other.release(); await first.release(); }
});
