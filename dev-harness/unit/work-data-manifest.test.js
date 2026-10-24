'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), nativeFs = require('node:fs');
const path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const source = nativeFs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/01v-work-data-manifest.js'), 'utf8');
function load(fsOverride = fs, cryptoOverride = require('node:crypto')) {
  return vm.runInNewContext(source + '\nWorkDataManifest;', {
    Buffer, process, require: name => name === 'node:fs/promises' ? fsOverride
      : name === 'node:crypto' ? cryptoOverride : require(name),
  });
}
const manifests = load(), code = suffix => error => error.code === 'work_data_manifest.' + suffix;
const directories = [];
test.after(async () => {
  for (const dir of directories) {
    const resolved = path.resolve(dir), temp = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temp) && path.basename(resolved).startsWith('ruyi-manifest-unit-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
async function fixture(options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ruyi-manifest-unit-')); directories.push(base);
  // This publisher is a synthetic test seam. It proves authority semantics, not
  // Windows write-through durability; the default publisher has a real probe below.
  const publish = options.publish || (async value => { await fs.rename(value.stage, value.target); });
  const api = (options.module || manifests).create({ base, publish });
  return { base, api, active: path.join(base, '.work-data', 'active-v1.json'),
    control: path.join(base, '.work-data'), async prepare(mode = 'encrypted') {
      const expected = await api.readActive(), candidate = await api.prepare({ expected, mode });
      return { expected, candidate };
    } };
}

test('missing manifest is legacy authority; prepare never selects or scans its shadow', async () => {
  const f = await fixture(), before = await f.api.readActive();
  assert.equal(before.root, f.base); assert.equal(before.generation, 0); assert.equal(before.mode, 'plain');
  assert.equal(before.proof.raw, null); assert.ok(Object.isFrozen(before) && Object.isFrozen(before.proof));
  const { candidate } = await f.prepare();
  assert.match(candidate.id, /^[a-f0-9]{48}$/); assert.equal(candidate.generation, 1);
  assert.ok(Object.isFrozen(candidate)); assert.equal((await f.api.readActive()).root, f.base);
  await fs.writeFile(path.join(candidate.root, 'arbitrary-user-data'), Buffer.from([255, 0, 1]));
  assert.equal((await f.api.readActive()).root, f.base);
});

test('commit selects exactly one candidate and preserves old authority roots', async () => {
  const f = await fixture(), first = await f.prepare(), unused = await f.prepare();
  const current = await f.api.commit(first);
  assert.equal(current.root, first.candidate.root); assert.equal(current.generation, 1); assert.equal(current.mode, 'encrypted');
  const second = await f.prepare('plain'), next = await f.api.commit(second);
  assert.equal(next.generation, 2); assert.equal(next.mode, 'plain');
  assert.ok((await fs.stat(current.root)).isDirectory()); assert.ok((await fs.stat(unused.candidate.root)).isDirectory());
  const fresh = manifests.create({ base: f.base, publish: async () => assert.fail('read does not publish') });
  assert.equal((await fresh.readActive()).proof.raw, next.proof.raw);
});

test('malformed, unsupported, oversized, invalid UTF8 and traversal manifests never become legacy', async () => {
  const f = await fixture(); await f.prepare();
  const id = 'a'.repeat(48), good = { schema: 1, generation: 1, id, mode: 'encrypted', activeRoot: 'generations/' + id };
  const variants = ['', 'null', '[]', '{', JSON.stringify({ ...good, schema: 2 }),
    JSON.stringify({ ...good, generation: 0 }), JSON.stringify({ ...good, generation: 1.5 }),
    JSON.stringify({ ...good, mode: 'off' }), JSON.stringify({ ...good, activeRoot: '../escape' }),
    JSON.stringify({ ...good, id: '../escape' }), JSON.stringify({ ...good, id: [id] }),
    JSON.stringify({ ...good, extra: true }), 'x'.repeat(4097), Buffer.from([255, 123])];
  for (const value of variants) {
    await fs.writeFile(f.active, value);
    await assert.rejects(f.api.readActive(), code('invalid'));
    assert.deepEqual(await fs.readFile(f.active), Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
});

test('valid manifest with absent or nondirectory generation fails closed', async () => {
  const f = await fixture(), prepared = await f.prepare(); await f.api.commit(prepared);
  await fs.rmdir(prepared.candidate.root);
  await assert.rejects(f.api.readActive(), code('directory_unavailable'));
  await fs.writeFile(prepared.candidate.root, 'not a directory');
  await assert.rejects(f.api.readActive(), code('directory_invalid'));
});

test('non-ENOENT manifest read failure never returns initial authority', async () => {
  const f = await fixture(), prepared = await f.prepare(); await f.api.commit(prepared);
  const blocked = load(new Proxy(fs, { get(target, key) {
    if (key === 'lstat') return async value => {
      if (value === f.active) throw Object.assign(Error('blocked'), { code: 'EACCES' });
      return target.lstat(value);
    };
    return target[key];
  } })).create({ base: f.base });
  await assert.rejects(blocked.readActive(), code('read_unavailable'));
});

test('proof comparison uses exact bytes even when valid semantics remain identical', async () => {
  const f = await fixture(), first = await f.prepare(); await f.api.commit(first);
  const next = await f.prepare('plain'), original = await fs.readFile(f.active, 'utf8');
  const changed = original.replace('"schema":1', '"schema": 1');
  await fs.writeFile(f.active, changed);
  await assert.rejects(f.api.commit(next), code('conflict'));
  assert.equal(await fs.readFile(f.active, 'utf8'), changed);
  assert.ok((await fs.stat(next.candidate.root)).isDirectory());
});

test('candidate capabilities reject cloned, other-instance and wrong-source selections', async () => {
  const f = await fixture(), prepared = await f.prepare();
  await assert.rejects(f.api.commit({ ...prepared, candidate: { ...prepared.candidate } }), code('candidate_invalid'));
  const fresh = manifests.create({ base: f.base, publish: async () => {} });
  await assert.rejects(fresh.commit(prepared), code('candidate_invalid'));
  const other = await fixture();
  await assert.rejects(other.api.prepare({ expected: prepared.expected, mode: 'encrypted' }), code('expected_invalid'));
  await f.api.commit(prepared);
  await assert.rejects(f.api.commit(prepared), code('candidate_invalid'));
});

test('expected receipt is snapshotted before asynchronous IO', async () => {
  const f = await fixture(), expected = await f.api.readActive();
  const mutable = { ...expected, proof: { ...expected.proof } };
  const pending = f.api.prepare({ expected: mutable, mode: 'plain' });
  mutable.proof.raw = '{}'; mutable.proof.sha256 = 'changed'; mutable.root = 'changed';
  const candidate = await pending;
  assert.equal(candidate.generation, 1); assert.equal(candidate.mode, 'plain');
});

test('unexpected authority change while stage fsync is pending prevents publication', async () => {
  let f, changed = false, publications = 0;
  const altered = load(new Proxy(fs, { get(target, key) {
    if (key === 'open') return async (...args) => {
      const handle = await target.open(...args);
      if (!String(args[0]).includes('.active-v1.stage-')) return handle;
      return new Proxy(handle, { get(value, name) {
        if (name === 'sync') return async () => {
          await value.sync(); changed = true; await fs.writeFile(f.active, '{');
        };
        const member = value[name]; return typeof member === 'function' ? member.bind(value) : member;
      } });
    };
    return target[key];
  } }));
  f = await fixture({ module: altered, publish: async () => { publications++; } });
  const prepared = await f.prepare();
  await assert.rejects(f.api.commit(prepared), code('invalid'));
  assert.equal(changed, true); assert.equal(publications, 0); assert.equal(await fs.readFile(f.active, 'utf8'), '{');
});

test('publication receives a frozen staged manifest after data fsync', async () => {
  let seen;
  const f = await fixture({ publish: async info => {
    assert.ok(Object.isFrozen(info) && Object.isFrozen(info.directories));
    seen = JSON.parse(await fs.readFile(info.stage, 'utf8'));
    await fs.rename(info.stage, info.target);
  } });
  const prepared = await f.prepare(); await f.api.commit(prepared);
  assert.equal(seen.id, prepared.candidate.id); assert.equal(seen.generation, 1);
});

test('publisher failure preserves candidate and stage and reports uncertain commit', async () => {
  const f = await fixture({ publish: async () => { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); } });
  const prepared = await f.prepare();
  await assert.rejects(f.api.commit(prepared), error => code('commit_failed')(error) && error.commitUncertain === true);
  assert.equal((await f.api.readActive()).generation, 0);
  assert.ok((await fs.stat(prepared.candidate.root)).isDirectory());
  assert.equal((await fs.readdir(f.control)).filter(name => name.startsWith('.active-v1.stage-')).length, 1);
});

test('rename followed by failure never rolls back the new durable authority', async () => {
  const f = await fixture({ publish: async info => { await fs.rename(info.stage, info.target); throw Error('flush failed'); } });
  const prepared = await f.prepare();
  await assert.rejects(f.api.commit(prepared), error => error.commitUncertain === true);
  const fresh = manifests.create({ base: f.base });
  assert.equal((await fresh.readActive()).root, prepared.candidate.root);
  assert.equal((await fresh.readActive()).generation, 1);
});

test('frozen errors and primitive publisher throws cannot hide a committed authority', async () => {
  const frozen = Object.freeze(Object.assign(Error('native flush failed'), {
    code: 'work_data_manifest.native_flush_failed', commitUncertain: false,
  }));
  for (const failure of [frozen, null, 'native flush failed', undefined]) {
    const f = await fixture({ publish: async info => { await fs.rename(info.stage, info.target); throw failure; } });
    const prepared = await f.prepare();
    await assert.rejects(f.api.commit(prepared), actual => {
      assert.notEqual(actual, failure); assert.equal(actual.cause, failure);
      assert.equal(actual.commitUncertain, true);
      return actual.code === (failure === frozen ? frozen.code : 'work_data_manifest.commit_failed');
    });
    assert.equal((await f.api.readActive()).generation, 1);
    assert.equal(frozen.commitUncertain, false);
  }
});

test('a publisher that returns without selecting the stage is an uncertain failure', async () => {
  const f = await fixture({ publish: async () => {} }), prepared = await f.prepare();
  await assert.rejects(f.api.commit(prepared), error => code('published_mismatch')(error) && error.commitUncertain === true);
  assert.equal((await f.api.readActive()).generation, 0);
});

test('simultaneous commits cannot overwrite the module-local pending publisher', async () => {
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; }), start = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ publish: async info => { entered(); await wait; await fs.rename(info.stage, info.target); } });
  const first = await f.prepare(), second = await f.prepare(), pending = f.api.commit(first);
  await start; await assert.rejects(f.api.commit(second), code('busy'));
  release(); await pending;
  await assert.rejects(f.api.commit(second), code('conflict'));
});

test('stage RNG failure releases the local commit owner and permits an explicit retry', async () => {
  const crypto = require('node:crypto'); let calls = 0;
  const once = new Proxy(crypto, { get(target, key) {
    if (key === 'randomBytes') return size => {
      if (++calls === 2) throw Error('synthetic RNG unavailable');
      return target.randomBytes(size);
    };
    return target[key];
  } });
  const f = await fixture({ module: load(fs, once) }), prepared = await f.prepare();
  await assert.rejects(f.api.commit(prepared), error => code('commit_failed')(error) && error.commitUncertain === false);
  assert.equal((await f.api.readActive()).generation, 0);
  assert.ok((await fs.stat(prepared.candidate.root)).isDirectory());
  assert.equal((await f.api.commit(prepared)).generation, 1);
});

test('control, generation and parent junctions or symlinks fail closed', async () => {
  const f = await fixture(), external = await fixture(), prepared = await f.prepare();
  await fs.rmdir(prepared.candidate.root);
  await fs.symlink(external.base, prepared.candidate.root, 'junction');
  await assert.rejects(f.api.commit(prepared), code('directory_invalid'));
  await fs.unlink(prepared.candidate.root);
  const alias = path.join(external.base, 'alias'); await fs.symlink(f.base, alias, 'junction');
  await assert.rejects(manifests.create({ base: alias }).readActive(), code('directory_invalid'));
  const f2 = await fixture(); await fs.symlink(external.base, f2.control, 'junction');
  await assert.rejects(f2.api.readActive(), code('directory_invalid'));
});

test('an active manifest path that is a directory is rejected', async () => {
  const f = await fixture(); await f.prepare(); await fs.mkdir(f.active);
  await assert.rejects(f.api.readActive(), code('invalid'));
});

test('a manifest symlink marker is rejected before opening the linked file', async () => {
  const f = await fixture(), prepared = await f.prepare(); await f.api.commit(prepared);
  let opened = 0;
  const blocked = load(new Proxy(fs, { get(target, key) {
    if (key === 'lstat') return async value => {
      const stat = await target.lstat(value);
      return value === f.active ? { ...stat, isFile: () => true, isSymbolicLink: () => true } : stat;
    };
    if (key === 'open') return async (...args) => { opened++; return target.open(...args); };
    return target[key];
  } })).create({ base: f.base });
  await assert.rejects(blocked.readActive(), code('invalid')); assert.equal(opened, 0);
});

test('existing invalid control parent cannot masquerade as a missing manifest', async () => {
  const f = await fixture(); await fs.writeFile(f.control, 'not a directory');
  await assert.rejects(f.api.readActive(), code('directory_invalid'));
});

test('manifest open ENOENT after an existing lstat is a read failure, never fresh install', async () => {
  const f = await fixture(), prepared = await f.prepare(); await f.api.commit(prepared);
  const blocked = load(new Proxy(fs, { get(target, key) {
    if (key === 'open') return async (...args) => {
      if (args[0] === f.active) throw Object.assign(Error('disappeared'), { code: 'ENOENT' });
      return target.open(...args);
    };
    return target[key];
  } })).create({ base: f.base });
  await assert.rejects(blocked.readActive(), code('read_unavailable'));
});

test('default directory durability is real: unsupported fsync never silently switches', async () => {
  const f = await fixture(), api = manifests.create({ base: f.base });
  const expected = await api.readActive(), candidate = await api.prepare({ expected, mode: 'encrypted' });
  let handle, supported = false;
  try { handle = await fs.open(f.control, 'r'); await handle.sync(); supported = true; }
  catch { /* actual platform capability, not a Windows platform-name stub */ }
  finally { await handle?.close(); }
  if (supported) {
    assert.equal((await api.commit({ expected, candidate })).generation, 1);
  } else {
    await assert.rejects(api.commit({ expected, candidate }), error => code('durability_unsupported')(error) && error.commitUncertain === false);
    assert.equal((await api.readActive()).generation, 0);
    assert.ok((await fs.stat(candidate.root)).isDirectory());
  }
});
