'use strict';
// B3: base-external boot-root preference.
//
// Covers the shared 00-boot codec/validator, one-shot preference resolution (env
// first, target alias/dev-ino/genN checks, bad/BOM/replaced records falling back
// without touching the file), the 13aw store (CAS, alias, stage, single-link,
// identity, exact removal), the migration gate and the 03 guard entry.
//
// Modules are loaded from src/ in one vm scope (the same concatenation order the
// product build uses) so this file runs before `node app/build.js` as well.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const io = require('node:fs/promises');
const p = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const c = require('node:crypto');
const { constBlock, functionBlock, sliceBlock } = require('../lib/source-slice');

const SRC = p.join(__dirname, '../../ruyi-workbench/app/src');
const BOOT_SRC = fs.readFileSync(p.join(SRC, '00-boot.js'), 'utf8');
const PREF_SRC = fs.readFileSync(p.join(SRC, '13aw-work-data-root-preference.js'), 'utf8');
const GUARD_SRC = fs.readFileSync(p.join(SRC, '03-bridge-guard.js'), 'utf8');
const ROUTER_SRC = fs.readFileSync(p.join(SRC, '13-http-router.js'), 'utf8');

// 00-boot + 13aw in one script scope, with an isolated fake process/os so no test
// can read or write the machine's real home, config or result files.
function fakeProcessFor(home, env = {}) {
  const fakeProcess = {
    env: { ...process.env }, platform: process.platform, pid: process.pid, argv: process.argv,
    execPath: process.execPath, pkg: undefined,
    kill: process.kill.bind(process), exit: process.exit.bind(process),
    once: process.once.bind(process), on: process.on.bind(process), cwd: process.cwd.bind(process),
  };
  for (const key of ['RUYI_HOME', 'WIN_CLAUDE_WORKBENCH_HOME']) delete fakeProcess.env[key];
  Object.assign(fakeProcess.env, env);
  fakeProcess.env.USERPROFILE = home;
  fakeProcess.env.HOME = home;
  return fakeProcess;
}
function fakeOsFor(home) {
  const fakeOs = Object.create(os);
  fakeOs.homedir = () => home;
  fakeOs.tmpdir = () => p.join(home, 'Temp');
  return fakeOs;
}
function load(home, env = {}, fsModule = fs) {
  const fakeProcess = fakeProcessFor(home, env);
  const fakeOs = fakeOsFor(home);
  const requireShim = id => id === 'os' ? fakeOs : id === 'fs' ? fsModule : require(id);
  return vm.runInNewContext(
    BOOT_SRC + '\n' + PREF_SRC + '\n;({ resolveDataRootUncached, migrateLegacyDataRoot, dataRootSource, BootRootPreference, WorkDataRootPreference, resetMemo(){ _dataRootMemo = null; } })',
    {
      require: requireShim, Buffer, process: fakeProcess, console,
      TextDecoder, TextEncoder, URL, URLSearchParams, AbortController,
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
      __dirname: SRC, __filename: p.join(SRC, '00-boot.js'), module: { exports: {} },
    },
  );
}

async function fixture(t) {
  const root = await io.mkdtemp(p.join(os.tmpdir(), 'ruyi-boot-pref-unit-'));
  t.after(async () => {
    assert.equal(p.dirname(root), p.resolve(os.tmpdir()));
    assert.ok(p.basename(root).startsWith('ruyi-boot-pref-unit-'));
    await io.rm(root, { recursive: true, force: true });
  });
  const home = p.join(root, 'home');
  const target = p.join(root, 'target');
  await io.mkdir(home);
  await io.mkdir(target);
  return { root, home, target };
}

async function identity(dir) {
  const stat = await io.lstat(dir, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function preference(target, baseIdentity, overrides = {}) {
  return {
    schema: 1, kind: 'restored-boot-root', base: target, baseIdentity: { ...baseIdentity },
    authority: { generation: 0, id: null, mode: 'plain', sha256: null },
    resultId: 'a'.repeat(48), resultSha256: 'b'.repeat(64), createdAt: '2026-10-27T00:00:00.000Z',
    ...overrides,
  };
}

const preferenceFile = home => p.join(home, '.ruyi', 'boot-root-v1.json');
async function writePreference(home, value) {
  await io.mkdir(p.join(home, '.ruyi'), { recursive: true });
  await io.writeFile(preferenceFile(home), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
const defaultNext = home => p.join(home, '.ruyi-workbench');
const legacyRoot = home => p.join(home, '.win-claude-workbench');

test('B3 codec: strict eight keys, UTF-8, 16 KiB bound and frozen decode', async t => {
  const f = await fixture(t), boot = load(f.home), id = await identity(f.target), value = preference(f.target, id);
  assert.equal(boot.BootRootPreference.validate(value), true);
  assert.equal(boot.BootRootPreference.validate({ ...value, extra: 1 }), false);
  for (const key of Object.keys(value)) {
    const copy = { ...value }; delete copy[key];
    assert.equal(boot.BootRootPreference.validate(copy), false, 'missing ' + key);
  }
  assert.equal(boot.BootRootPreference.validate({ ...value, kind: 'other' }), false);
  assert.equal(boot.BootRootPreference.validate({ ...value, base: 'relative' }), false);
  assert.equal(boot.BootRootPreference.validate({ ...value, authority: { generation: 1, id: null, mode: 'plain', sha256: null } }), false);
  const bytes = Buffer.from(JSON.stringify(value));
  const decoded = boot.BootRootPreference.decode(bytes);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.baseIdentity), true);
  assert.equal(boot.BootRootPreference.decode(Buffer.from('\uFEFF' + JSON.stringify(value), 'utf8')), null);
  assert.equal(boot.BootRootPreference.decode(Buffer.from([0x7b, 0xff, 0x7d])), null);
  assert.equal(boot.BootRootPreference.decode(Buffer.alloc(boot.BootRootPreference.LIMIT + 1, 0x20)), null);
  assert.equal(boot.BootRootPreference.LIMIT, 16 * 1024);
});

test('B3 boot root: explicit env wins over a present preference', async t => {
  const f = await fixture(t), id = await identity(f.target), envRoot = p.join(f.root, 'env-root');
  await writePreference(f.home, preference(f.target, id));
  for (const env of [{ RUYI_HOME: envRoot }, { WIN_CLAUDE_WORKBENCH_HOME: envRoot }]) {
    const boot = load(f.home, env);
    assert.equal(boot.resolveDataRootUncached(), envRoot);
    assert.equal(boot.dataRootSource(), 'env');
  }
});

test('B3 boot root: a valid preference selects the target and is used once', async t => {
  const f = await fixture(t), other = p.join(f.root, 'other'), id = await identity(f.target);
  await io.mkdir(other);
  await writePreference(f.home, preference(f.target, id));
  const boot = load(f.home);
  assert.equal(boot.resolveDataRootUncached(), f.target);
  assert.equal(boot.dataRootSource(), 'preference');
  const otherId = await identity(other);
  await writePreference(f.home, preference(other, otherId));
  boot.resetMemo();
  assert.equal(boot.resolveDataRootUncached(), f.target, 'the process must not re-read the preference');
  assert.equal(boot.dataRootSource(), 'preference');
});

test('B3 boot root: bad, BOM, oversized, multi-link and wrong-identity records fall back untouched', async t => {
  const f = await fixture(t), id = await identity(f.target);
  const variants = [
    ['bad-json', '{not json'],
    ['bom', '\uFEFF' + JSON.stringify(preference(f.target, id))],
    ['oversized', Buffer.alloc(16 * 1024 + 1, 0x20)],
    ['wrong-identity', JSON.stringify(preference(f.target, { dev: id.dev, ino: '0' }))],
  ];
  for (const [label, bytes] of variants) {
    const home = p.join(f.root, 'home-' + label);
    await io.mkdir(home);
    await writePreference(home, bytes);
    const before = await io.readFile(preferenceFile(home));
    const boot = load(home);
    assert.equal(boot.resolveDataRootUncached(), defaultNext(home), label);
    assert.equal(boot.dataRootSource(), 'default', label);
    assert.deepEqual(await io.readFile(preferenceFile(home)), before, label + ': the record must not be repaired or deleted');
  }
  const home = p.join(f.root, 'home-hardlink');
  await io.mkdir(home);
  await writePreference(home, preference(f.target, id));
  await io.link(preferenceFile(home), p.join(home, '.ruyi', 'copy.json'));
  const boot = load(home);
  assert.equal(boot.resolveDataRootUncached(), defaultNext(home), 'a multi-link record is not authoritative');
});

test('B3 boot root: one failed read is never retried in the same process', async t => {
  const f = await fixture(t), id = await identity(f.target), home = p.join(f.root, 'home-once');
  await io.mkdir(home);
  await writePreference(home, '{bad');
  const boot = load(home);
  assert.equal(boot.resolveDataRootUncached(), defaultNext(home));
  await writePreference(home, preference(f.target, id));
  boot.resetMemo();
  assert.equal(boot.resolveDataRootUncached(), defaultNext(home), 'a later serve must be a new process to pick up the preference');
  assert.equal(boot.dataRootSource(), 'default');
});

test('B3 boot root: a concurrent replacement between lstat and open is rejected without rewriting', async t => {
  const f = await fixture(t), id = await identity(f.target);
  const other = p.join(f.root, 'other-target');
  await io.mkdir(other);
  const otherId = await identity(other), home = p.join(f.root, 'home-race');
  await io.mkdir(home);
  await writePreference(home, preference(f.target, id));
  const replacement = p.join(home, '.ruyi', 'replacement.json');
  await io.writeFile(replacement, JSON.stringify(preference(other, otherId)));
  const replacementBytes = await io.readFile(replacement);
  let triggered = 0, method = '';
  const wrapper = Object.create(fs);
  wrapper.openSync = function (file, flags, ...rest) {
    if (!triggered && p.resolve(file) === preferenceFile(home) && flags === 'r') {
      triggered += 1;
      try { fs.renameSync(replacement, preferenceFile(home)); method = 'rename'; }
      catch { fs.copyFileSync(replacement, preferenceFile(home)); method = 'copy'; }
    }
    return fs.openSync(file, flags, ...rest);
  };
  const boot = load(home, {}, wrapper);
  assert.equal(triggered, 1, 'the test must swap the record exactly between lstat and open');
  assert.ok(method === 'rename' || method === 'copy');
  assert.equal(boot.resolveDataRootUncached(), defaultNext(home));
  assert.equal(boot.dataRootSource(), 'default');
  assert.deepEqual(await io.readFile(preferenceFile(home)), replacementBytes, 'a failed read must never rewrite the replaced record');
});

test('B3 boot root: an aliased or replaced target is ignored and the file is left alone', async t => {
  const f = await fixture(t), id = await identity(f.target);
  const home = p.join(f.root, 'home-alias');
  await io.mkdir(home);
  const alias = p.join(f.root, 'target-alias');
  const other = p.join(f.root, 'other-target');
  await io.mkdir(other);
  await io.symlink(other, alias, process.platform === 'win32' ? 'junction' : undefined);
  const aliasId = await identity(other);
  await writePreference(home, preference(alias, aliasId));
  const before = await io.readFile(preferenceFile(home));
  const boot = load(home);
  assert.equal(boot.resolveDataRootUncached(), defaultNext(home));
  assert.deepEqual(await io.readFile(preferenceFile(home)), before);

  // A linked <home>/.ruyi must not carry a readable record either: it would bypass
  // the 03 user-home write floor for the preference file.
  const homeLinked = p.join(f.root, 'home-linked'), store = p.join(f.root, 'alias-store');
  await io.mkdir(homeLinked);
  await io.mkdir(store);
  await writePreference(store, preference(f.target, id));
  await io.symlink(p.join(store, '.ruyi'), p.join(homeLinked, '.ruyi'), process.platform === 'win32' ? 'junction' : undefined);
  const bootLinked = load(homeLinked);
  assert.equal(bootLinked.resolveDataRootUncached(), defaultNext(homeLinked), 'a linked .ruyi directory is not authoritative');

  const home2 = p.join(f.root, 'home-replaced');
  await io.mkdir(home2);
  await writePreference(home2, preference(f.target, id));
  await io.rmdir(f.target);
  await io.mkdir(f.target);
  const replaced = await identity(f.target);
  if (replaced.dev !== id.dev || replaced.ino !== id.ino) {
    const boot2 = load(home2);
    assert.equal(boot2.resolveDataRootUncached(), defaultNext(home2), 'a replaced directory must not be selected');
  }
});

test('B3 boot root: genN requires an ordinary single-link active-v1.json; authority is diagnostic', async t => {
  const f = await fixture(t), id = await identity(f.target);
  const generation = { authority: { generation: 1, id: 'c'.repeat(48), mode: 'plain', sha256: 'd'.repeat(64) } };
  const home = p.join(f.root, 'home-gen');
  await io.mkdir(home);
  await writePreference(home, preference(f.target, id, generation));
  const boot = load(home);
  assert.equal(boot.resolveDataRootUncached(), defaultNext(home), 'missing active-v1.json');
  await io.mkdir(p.join(f.target, '.work-data'));
  await io.writeFile(p.join(f.target, '.work-data', 'active-v1.json'), '{}');
  const boot2 = load(home);
  assert.equal(boot2.resolveDataRootUncached(), f.target, 'a plain single-link pointer is enough; authority need not equal the current manifest');
  await io.unlink(p.join(f.target, '.work-data', 'active-v1.json'));
  await io.writeFile(p.join(f.target, '.work-data', 'other.json'), '{}');
  await io.link(p.join(f.target, '.work-data', 'other.json'), p.join(f.target, '.work-data', 'active-v1.json'));
  const boot3 = load(home);
  assert.equal(boot3.resolveDataRootUncached(), defaultNext(home), 'a multi-link active-v1.json is not a generation pointer');
});

test('B3 boot root: TEMP activation alone never selects a serving root; legacy migration is gated by a preference', async t => {
  const f = await fixture(t), id = await identity(f.target);
  const temp = p.join(f.home, 'Temp');
  await io.mkdir(temp);
  await io.mkdir(p.join(temp, 'ruyi-work-data-activation-' + c.createHash('sha256').update(f.target.toLowerCase()).digest('hex')));
  await io.writeFile(p.join(temp, 'ruyi-work-data-activation-' + c.createHash('sha256').update(f.target.toLowerCase()).digest('hex'), 'activation-v1.json'), JSON.stringify({ schema: 1, base: f.target }));
  const boot = load(f.home);
  assert.equal(boot.resolveDataRootUncached(), defaultNext(f.home), 'TEMP activation is not a long-lived preference');

  await io.mkdir(legacyRoot(f.home));
  await io.writeFile(p.join(legacyRoot(f.home), 'config.json'), '{}');
  await writePreference(f.home, preference(f.target, id));
  const gated = load(f.home);
  const gate = gated.migrateLegacyDataRoot();
  assert.equal(gate.moved, false);
  assert.equal(gate.reason, 'boot-root-preference');
  assert.equal(fs.existsSync(legacyRoot(f.home)), true);
  assert.equal(fs.existsSync(defaultNext(f.home)), false, 'a preference must not create the default next root');
});

test('B3 boot root: legacy migration keeps its original behaviour without a preference', async t => {
  const f = await fixture(t);
  await io.mkdir(legacyRoot(f.home));
  await io.writeFile(p.join(legacyRoot(f.home), 'config.json'), '{}');
  const boot = load(f.home);
  assert.equal(boot.dataRootSource(), 'legacy');
  const result = boot.migrateLegacyDataRoot();
  assert.equal(result.moved, true);
  if (result.junction) assert.equal(fs.existsSync(legacyRoot(f.home)), true, 'a junction remains at the old path');
  assert.equal(fs.existsSync(defaultNext(f.home)), true);
});

test('B3 store: create/inspect/write/identical-rewrite/CAS/replace/remove', async t => {
  const f = await fixture(t), id = await identity(f.target), flushCalls = [];
  const flush = async dirs => { flushCalls.push([...dirs]); };
  const owner = load(f.home).WorkDataRootPreference.create({ home: f.home, flush });
  assert.equal((await owner.inspect()).present, false);
  assert.equal(fs.existsSync(p.join(f.home, '.ruyi')), false, 'inspection creates nothing');

  const value = preference(f.target, id);
  const receipt = await owner.write(value);
  assert.equal(flushCalls.length, 2);
  assert.deepEqual(flushCalls[0], [p.join(f.home, '.ruyi'), f.home]);
  assert.deepEqual(await io.readFile(preferenceFile(f.home)), Buffer.from(JSON.stringify(value)));
  assert.equal(p.dirname(receipt.base), p.dirname(f.target));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);

  const found = await owner.inspect();
  assert.equal(found.present, true);
  assert.deepEqual(JSON.parse(JSON.stringify(found.value)), value);
  assert.equal(Object.isFrozen(found.value), true);
  assert.equal(Object.isFrozen(found.receipt), true);
  assert.equal(found.receipt.sha256, receipt.sha256);

  const before = await io.lstat(preferenceFile(f.home), { bigint: true });
  const flushes = flushCalls.length;
  const same = await owner.write(value, receipt);
  assert.equal(same.sha256, receipt.sha256);
  assert.equal(flushCalls.length, flushes, 'identical bytes must not be rewritten');
  assert.equal((await io.lstat(preferenceFile(f.home), { bigint: true })).ino, before.ino);

  const next = { ...value, resultId: 'e'.repeat(48), createdAt: '2026-10-27T00:00:01.000Z' };
  await assert.rejects(owner.write(next), e => e.code === 'work_data_boot_root.record_exists');
  await assert.rejects(owner.write(next, { ...receipt, sha256: 'f'.repeat(64) }), e => e.code === 'work_data_boot_root.record_changed');
  const second = await owner.write(next, receipt);
  assert.notEqual(second.sha256, receipt.sha256);
  await assert.rejects(owner.write(value, receipt), e => e.code === 'work_data_boot_root.record_changed', 'the old receipt is stale');

  // A record whose old target disappeared must remain replaceable by exact CAS: the
  // store is metadata, and boot (not the store) decides target usability.
  const replacement = p.join(f.root, 'replacement');
  await io.mkdir(replacement);
  const replacementId = await identity(replacement);
  await io.rmdir(f.target);
  const moved = { ...next, base: replacement, baseIdentity: { ...replacementId }, resultId: 'f'.repeat(48), createdAt: '2026-10-27T00:00:02.000Z' };
  const third = await owner.write(moved, second);
  assert.notEqual(third.sha256, second.sha256);
  assert.equal((await owner.inspect()).value.base, replacement);

  await assert.rejects(owner.remove({ ...third, sha256: '0'.repeat(64) }), e => e.code === 'work_data_boot_root.record_changed');
  assert.equal(await owner.remove(third), true);
  assert.equal(fs.existsSync(preferenceFile(f.home)), false);
  assert.equal(await owner.remove(third), true);
});

test('B3 store: target alias/identity, stage pending, single link and bad bytes fail closed', async t => {
  const f = await fixture(t), id = await identity(f.target), flush = async () => {};
  const owner = load(f.home).WorkDataRootPreference.create({ home: f.home, flush });
  await assert.rejects(owner.write(preference(f.target, { dev: id.dev, ino: '0' })), e => e.code === 'work_data_boot_root.base_changed');
  await assert.rejects(owner.write(preference(p.join(f.root, 'missing'), id)), e => e.code === 'work_data_boot_root.base_changed');

  const alias = p.join(f.root, 'alias'), other = p.join(f.root, 'other');
  await io.mkdir(other);
  await io.symlink(other, alias, process.platform === 'win32' ? 'junction' : undefined);
  const otherId = await identity(other);
  await assert.rejects(owner.write(preference(alias, otherId)), e => e.code === 'work_data_boot_root.path_alias');

  const value = preference(f.target, id), receipt = await owner.write(value);
  await assert.rejects(owner.remove({ ...receipt, sha256: 'a'.repeat(64) }), e => e.code === 'work_data_boot_root.record_changed');
  const unknownStage = p.join(f.home, '.ruyi', '.boot-root-v1.stage-deadbeef');
  await io.writeFile(unknownStage, '{}');
  for (const call of [() => owner.inspect(), () => owner.write(value, receipt), () => owner.remove(receipt)]) {
    await assert.rejects(call, e => e.code === 'work_data_boot_root.stage_pending');
  }
  assert.equal(await io.readFile(unknownStage, 'utf8'), '{}', 'a pre-existing unknown stage is never cleaned by a failed operation');
  assert.equal(fs.existsSync(unknownStage), true);
  await io.unlink(unknownStage);

  await io.link(preferenceFile(f.home), p.join(f.home, '.ruyi', 'copy.json'));
  await assert.rejects(owner.inspect(), e => e.code === 'work_data_boot_root.record_invalid');
  await io.unlink(p.join(f.home, '.ruyi', 'copy.json'));

  for (const bytes of [Buffer.alloc(16 * 1024 + 1, 0x20), Buffer.from('\uFEFF' + JSON.stringify(value)), Buffer.from([0x7b, 0xff, 0x7d])]) {
    await io.writeFile(preferenceFile(f.home), bytes);
    await assert.rejects(owner.inspect(), e => e.code === 'work_data_boot_root.record_invalid');
  }

  // The record directory itself must not be a junction: writing through it would
  // bypass the 03 user-home write floor for the same logical path.
  const external = p.join(f.root, 'external-store');
  await io.mkdir(p.join(external, '.ruyi'), { recursive: true });
  await io.writeFile(p.join(external, '.ruyi', 'boot-root-v1.json'), JSON.stringify(value));
  await io.rm(p.join(f.home, '.ruyi'), { recursive: true, force: true });
  await io.symlink(p.join(external, '.ruyi'), p.join(f.home, '.ruyi'), process.platform === 'win32' ? 'junction' : undefined);
  await assert.rejects(owner.inspect(), e => e.code === 'work_data_boot_root.path_alias');
});

test('B3 store: a flush failure removes only the call\'s own stage and stays retryable', async t => {
  const f = await fixture(t), id = await identity(f.target);
  const failing = load(f.home).WorkDataRootPreference.create({ home: f.home, flush: async () => { throw new Error('synthetic flush refusal'); } });
  await assert.rejects(failing.write(preference(f.target, id)), e => e.code === 'work_data_boot_root.write_failed');
  assert.deepEqual(await io.readdir(p.join(f.home, '.ruyi')), [], 'the own wx stage must be cleaned after the failed flush');
  assert.equal(fs.existsSync(preferenceFile(f.home)), false);
  const retry = load(f.home).WorkDataRootPreference.create({ home: f.home, flush: async () => {} });
  const receipt = await retry.write(preference(f.target, id));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await retry.inspect()).present, true);
});

test('B3 store: an aliased/redirected home is allowed while <home>/.ruyi stays a real directory', async t => {
  const f = await fixture(t), id = await identity(f.target);
  const realHome = p.join(f.root, 'real-home'), aliasHome = p.join(f.root, 'alias-home');
  await io.mkdir(realHome);
  await io.symlink(realHome, aliasHome, process.platform === 'win32' ? 'junction' : undefined);
  const owner = load(aliasHome).WorkDataRootPreference.create({ home: aliasHome, flush: async () => {} });
  const receipt = await owner.write(preference(f.target, id));
  assert.equal((await owner.inspect()).receipt.sha256, receipt.sha256);
  assert.equal(fs.existsSync(p.join(realHome, '.ruyi', 'boot-root-v1.json')), true);
  const boot = load(aliasHome);
  assert.equal(boot.resolveDataRootUncached(), f.target);
  assert.equal(boot.dataRootSource(), 'preference');
});

test('B3 store: host validation and a missing home refuse rather than inventing a location', async t => {
  const f = await fixture(t), api = load(f.home).WorkDataRootPreference;
  assert.throws(() => api.create({ home: 'relative', flush: async () => {} }), e => e.code === 'work_data_boot_root.host_invalid');
  assert.throws(() => api.create({ home: f.home }), e => e.code === 'work_data_boot_root.host_invalid');
  assert.throws(() => api.create({ home: p.parse(f.home).root, flush: async () => {} }), e => e.code === 'work_data_boot_root.host_invalid');
  const missing = api.create({ home: p.join(f.root, 'absent-home'), flush: async () => {} });
  await assert.rejects(missing.inspect(), e => e.code === 'work_data_boot_root.home_invalid');
});

test('B3 guard: <home>/.ruyi/boot-root-v1.json is a user-home persistence target (autoexec-denied path)', async t => {
  const f = await fixture(t);
  const files = constBlock(GUARD_SRC, 'USER_HOME_PERSISTENCE_FILES');
  const dirs = constBlock(GUARD_SRC, 'USER_HOME_PERSISTENCE_DIRS');
  const cache = constBlock(GUARD_SRC, '_homeRealCache');
  const realpath = sliceBlock(GUARD_SRC, 'function homeRealpathSync', 'const USER_HOME_PERSISTENCE_FILES');
  const targets = sliceBlock(GUARD_SRC, 'function userHomePersistenceTargets', 'function userHomePersistenceHit');
  const hit = functionBlock(GUARD_SRC, 'userHomePersistenceHit');
  const norm = functionBlock(GUARD_SRC, 'normalizeAutoexecPath');
  assert.ok(files.includes("'.ruyi/boot-root-v1.json'"), 'the guard list must contain the preference record');
  assert.ok(dirs.includes("'.ruyi'"), 'the guard dir list must protect the whole preference/stage directory');
  const guard = vm.runInNewContext(`${cache}\n${realpath}\n${files}\n${dirs}\n${targets}\n${hit}\n${norm}\n;({ userHomePersistenceHit })`, {
    fs, os: fakeOsFor(f.home), path: p, process: fakeProcessFor(f.home),
    agentCliHomes: () => ({ home: f.home, claude: p.join(f.home, '.claude'), codex: p.join(f.home, '.codex'), kimi: p.join(f.home, '.kimi-code') }),
  });
  assert.equal(guard.userHomePersistenceHit(preferenceFile(f.home)), true);
  assert.equal(guard.userHomePersistenceHit(preferenceFile(f.home) + '::$DATA'), true);
  assert.equal(guard.userHomePersistenceHit(p.join(f.home, '.ruyi', '.boot-root-v1.stage-deadbeef')), true);
  assert.equal(guard.userHomePersistenceHit(p.join(f.root, 'workspace', '.ruyi', 'boot-root-v1.json')), false);
  assert.equal(guard.userHomePersistenceHit(p.join(f.home, 'other', '.ruyi', 'boot-root-v1.json')), false);
});

function startServerSandbox({ base, legacy, next, source, acquire, migrate }) {
  const sandbox = {
    path: p, fs, process: { env: {}, platform: process.platform, once() {} },
    paths: { data: base }, dataRoot: () => base, dataRootSource: () => source,
    resolveBindHost: () => '127.0.0.1', defaultDataRoots: () => ({ legacy, next }),
    lstatOrNull: value => { try { return fs.lstatSync(value); } catch { return null; } },
    isDirectServeInvocation: () => true,
    ServerOwnership: { acquire: async () => { throw new Error('fallback acquire must not run'); }, canonicalRoot: async value => value },
    WorkDataMaintenanceRuntimeHooks: { acquireServe: acquire },
    WorkDataRootHooks: { bind: async () => {}, ready: () => true },
    migrateLegacyDataRoot: migrate,
    startServerInner: async () => 'served', finishBootCliPathProbes: () => {},
    START_ERROR_KINDS: [], PrivacyCore: { configHooks: {} }, writeStartError: async () => {},
    DATA_ROOT_MIGRATION: null,
  };
  sandbox.start = vm.runInNewContext(functionBlock(ROUTER_SRC, 'startServer') + '\nstartServer;', sandbox);
  return sandbox;
}

test('B3 migration gate: a live preference keeps acquireServe on the base and never calls migration', async t => {
  const f = await fixture(t), id = await identity(f.target);
  await writePreference(f.home, preference(f.target, id));
  const legacy = legacyRoot(f.home), next = defaultNext(f.home);
  await io.mkdir(legacy);
  await io.writeFile(p.join(legacy, 'config.json'), '{"legacy":true}');
  let acquired = null, migrations = 0;
  const sandbox = startServerSandbox({
    base: f.target, legacy, next, source: 'preference',
    acquire: async ({ base, roots }) => { acquired = { base, roots: [...roots] }; return { portable: false }; },
    migrate: () => { migrations += 1; return { moved: false, reason: 'no-legacy' }; },
  });
  assert.equal(await sandbox.start({}), 'served');
  assert.deepEqual(acquired, { base: f.target, roots: [f.target] }, 'only the preference base may join ownership');
  assert.equal(migrations, 0, 'migrateLegacyDataRoot must not be called');
  assert.equal(sandbox.DATA_ROOT_MIGRATION.moved, false);
  assert.equal(sandbox.DATA_ROOT_MIGRATION.reason, 'boot-root-preference');
  assert.equal(fs.existsSync(legacy), true, 'the old default root must not be moved');
  assert.equal(fs.existsSync(next), false, 'the preference must not create the default next root');
  assert.equal(await io.readFile(p.join(legacy, 'config.json'), 'utf8'), '{"legacy":true}');
  const inner = functionBlock(ROUTER_SRC, 'startServerInner');
  assert.ok(inner.includes("'next-exists', 'no-legacy', 'env', 'boot-root-preference'"), 'boot-root-preference belongs to the quiet reason whitelist');
});

test('B3 migration gate: without a preference startServer still owns the default pair and calls migration', async t => {
  const f = await fixture(t);
  const legacy = legacyRoot(f.home), next = defaultNext(f.home);
  await io.mkdir(legacy);
  let acquired = null, migrations = 0;
  const sandbox = startServerSandbox({
    base: next, legacy, next, source: 'default',
    acquire: async ({ base, roots }) => { acquired = { base, roots: [...roots] }; return { portable: false }; },
    migrate: () => { migrations += 1; return { moved: false, reason: 'no-legacy' }; },
  });
  assert.equal(await sandbox.start({}), 'served');
  assert.equal(migrations, 1, 'the original migration gate still runs without a preference');
  assert.equal(acquired.base, next);
  assert.ok(acquired.roots.includes(legacy) && acquired.roots.includes(next), 'legacy and next still join the default ownership roots');
  assert.equal(sandbox.DATA_ROOT_MIGRATION.reason, 'no-legacy');
});
