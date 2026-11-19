'use strict';
// 151 阶段 3F:冷读即重写加密全文索引 state。新起的运行时只做冷读与搜索(prepare/step 发现索引已是最新、没有任何改动)
// 时,sessions/_fulltext-index-v1/state.json 的字节、mtime 与文件身份都不得变化;只有真改动(新建 shard/manifest、
// pause/resume 改变落盘标记)才写。明文档与加密档各跑一遍:加密档重写会换密文字节,明文档重写字节相同但换文件身份与 mtime。
// 冷实例用同一数据目录、同一机器钥匙重新求值模块(fixture 的 directory/master 选项),不复用上一个实例的任何内存状态。
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const make = options => fixture(options);
const sid = 'Sess_Cold_State';
const needle = 'COLD_STATE_UNIQUE_NEEDLE';
const stamp = async file => { const stat = await fs.stat(file, { bigint: true }); return { bytes: await fs.readFile(file), mtimeNs: stat.mtimeNs, ino: stat.ino, size: stat.size }; };
async function ownedSnapshot(root) {
  const out = new Map();
  const walk = async dir => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else out.set(path.relative(root, full), await stamp(full)); } };
  await walk(root); return out;
}
const sameStamp = (actual, expected, label) => {
  assert.deepEqual(actual.bytes, expected.bytes, label + ' bytes unchanged');
  assert.equal(actual.mtimeNs, expected.mtimeNs, label + ' mtime unchanged');
  assert.equal(actual.ino, expected.ino, label + ' file identity unchanged');
};
const changed = (actual, expected) => !actual.bytes.equals(expected.bytes) || actual.mtimeNs !== expected.mtimeNs || actual.ino !== expected.ino;

for (const enabled of [true, false]) test('cold runtime read and search leave fulltext state.json untouched (' + (enabled ? 'encrypted' : 'plain') + ')', async t => {
  const producer = await make({ enabled });
  t.after(() => producer.close());
  await producer.put(sid, [{ id: 'm_cold_state', role: 'user', turnSeq: 1, content: needle + ' original body' }], { head: { title: 'cold state', providerHistoryCount: 0 } });
  await producer.index.prepare({});
  const root = path.join(producer.sessions, '_fulltext-index-v1'), stateFile = path.join(root, 'state.json');
  const built = await ownedSnapshot(root);
  assert.ok(built.has('state.json') && built.size >= 3, 'state, manifest and at least one shard exist after the real build');
  if (enabled) assert.equal(JSON.parse(built.get('state.json').bytes.toString('utf8').split('\n')[0]).workData, 3, 'state is a sealed carrier');

  // Warm instance: a second preparation over an up-to-date index is read-only.
  await producer.index.prepare({});
  assert.ok((await producer.index.search(needle)).results.some(row => row.reference.sessionId === sid));
  sameStamp(await stamp(stateFile), built.get('state.json'), 'warm state.json');

  // Fresh module evaluation, same data root and machine key: the cold instance knows nothing about the disk phase.
  const cold = await make({ enabled, directory: producer.directory, master: producer.master, instanceId: producer.instanceId });
  t.after(() => cold.close());
  cold.catalog.push(sid);
  assert.equal((await cold.index.prepare({}, { incremental: true, threadSearch: true })).done, true);
  await cold.index.prepare({});
  const found = await cold.index.search(needle);
  assert.ok(found.results.some(row => row.reference.sessionId === sid)); assert.equal(found.coverage.complete, true);
  await cold.index.step(1, {});
  assert.equal((await cold.index.coverage({})).phase, 'idle');
  const after = await ownedSnapshot(root);
  assert.deepEqual([...after.keys()].sort(), [...built.keys()].sort(), 'cold read creates and removes no owned file');
  for (const [name, value] of built) sameStamp(after.get(name), value, 'cold ' + name);

  // Control: a real change still persists the marker, and only when its content changes.
  const second = 'Sess_Cold_State_New';
  await cold.put(second, [{ id: 'm_new', role: 'user', turnSeq: 1, content: 'second session body' }], { head: { title: 'new', providerHistoryCount: 0 } });
  const writeJson = cold.host.writeJson, order = [];
  cold.host.writeJson = async (file, ...rest) => { order.push(path.basename(file).replace(/^[0-9a-f]{32}\.\d+\.json$/, 'shard')); return writeJson(file, ...rest); };
  await cold.index.prepare({});
  cold.host.writeJson = writeJson;
  assert.equal(order[0], 'state.json', 'the building marker reaches disk before the first owned mutation');
  assert.equal(order[order.length - 1], 'state.json', 'the idle marker closes the mutating run');
  assert.ok(order.includes('manifest.json') && order.filter(name => name === 'state.json').length === 2, JSON.stringify(order));
  const rebuilt = await stamp(stateFile);
  assert.ok(changed(rebuilt, built.get('state.json')), 'a real build rewrites the state marker');
  await cold.index.pause();
  const paused = await stamp(stateFile);
  assert.ok(changed(paused, rebuilt), 'pause persists a changed phase');
  assert.equal((await cold.restart().restorePause({})).phase, 'paused');
  await cold.index.pause();
  sameStamp(await stamp(stateFile), paused, 'repeated pause');
  await cold.index.resume();
  assert.ok(changed(await stamp(stateFile), paused), 'resume persists idle again');
  assert.equal((await cold.restart().restorePause({})).phase, 'idle');

  // Work-data maintenance rewrites the owned namespace outside this instance; the remembered phase must not survive it.
  await cold.index.pause();
  await fs.rm(stateFile);
  cold.index.setMaintenancePaused(true); cold.index.setMaintenancePaused(false);
  await cold.index.pause();
  assert.equal((await cold.restart().restorePause({})).phase, 'paused', 'a maintenance window forgets the cached phase and rewrites the marker');
});

// 复审 (a):载体与当前策略不符的 state 照修前处理。明文 state 落在加密档:一次没有改动的冷 prepare 要把它重封;
// 密封 state 落在关闭档:冷 prepare 照修前以 work_data_store.downgrade_refused 拒绝,而且不把它改写成明文。
test('a cold plaintext state under encryption is resealed as before', async t => {
  const f = await make({ enabled: true });
  t.after(() => f.close());
  await f.put('Sess_Carrier_A', [{ id: 'm1', role: 'user', turnSeq: 1, content: 'carrier body' }], { head: { title: 'a', providerHistoryCount: 0 } });
  await f.index.prepare({});
  const stateFile = path.join(f.sessions, '_fulltext-index-v1', 'state.json');
  await fs.writeFile(stateFile, JSON.stringify({ schema: 1, phase: 'idle' }));
  await f.restart().prepare({});
  assert.equal(JSON.parse((await fs.readFile(stateFile, 'utf8')).split('\n')[0]).workData, 3, 'plaintext marker is resealed under the encrypted policy');
});
test('a cold sealed state under disabled policy still refuses the downgrade write', async t => {
  const f = await make({ enabled: true });
  t.after(() => f.close());
  await f.put('Sess_Carrier_B', [{ id: 'm1', role: 'user', turnSeq: 1, content: 'carrier body' }], { head: { title: 'b', providerHistoryCount: 0 } });
  await f.index.prepare({});
  const stateFile = path.join(f.sessions, '_fulltext-index-v1', 'state.json'), before = await fs.readFile(stateFile);
  f.enable(false);
  await assert.rejects(() => f.restart().prepare({}), error => error?.code === 'work_data_store.downgrade_refused');
  assert.deepEqual(await fs.readFile(stateFile), before, 'the sealed marker is left untouched');
});

// 复审 (b):清会话目录也是改动 —— 盘上确知 idle 时,purgeMissing 删第一个文件之前必须先落 building;
// invalidate 不在建索引的一发里,照修前不碰 state.json。
test('purgeMissing persists the building marker before the first removal; invalidate never writes state', async t => {
  const f = await make({ enabled: true });
  t.after(() => f.close());
  for (const id of ['Sess_Purge_A', 'Sess_Purge_B']) await f.put(id, [{ id: 'm_' + id, role: 'user', turnSeq: 1, content: 'body of ' + id }], { head: { title: id, providerHistoryCount: 0 } });
  await f.index.prepare({}); await f.index.prepare({});
  f.catalog.splice(f.catalog.indexOf('Sess_Purge_B'), 1);
  const order = [], unlink = fs.unlink, rmdir = fs.rmdir, writeJson = f.host.writeJson;
  const name = file => path.basename(file).replace(/^[0-9a-f]{32}\.\d+\.json$/, 'shard');
  fs.unlink = async (file, ...rest) => { order.push('unlink:' + name(file)); return unlink.call(fs, file, ...rest); };
  fs.rmdir = async (file, ...rest) => { order.push('rmdir:' + name(file)); return rmdir.call(fs, file, ...rest); };
  f.host.writeJson = async (file, ...rest) => { order.push('write:' + name(file)); return writeJson(file, ...rest); };
  try {
    await f.index.prepare({});
    assert.equal(order[0], 'write:state.json', JSON.stringify(order));
    assert.ok(order.indexOf('unlink:manifest.json') > 0 && order.at(-1) === 'write:state.json', JSON.stringify(order));
    order.length = 0;
    await f.index.invalidate('Sess_Purge_A', true);
    assert.ok(order.includes('unlink:manifest.json'), JSON.stringify(order));
    assert.ok(!order.includes('write:state.json'), 'invalidate does not touch the marker: ' + JSON.stringify(order));
  } finally { fs.unlink = unlink; fs.rmdir = rmdir; f.host.writeJson = writeJson; }
});

// 复审 (b):restorePause 在用过的实例上也要更新确知的盘上 phase,否则另一实例落下的 paused 不会被 resume 改回。
test('restorePause on a used instance refreshes the remembered phase', async t => {
  const f = await make({ enabled: true });
  t.after(() => f.close());
  await f.put('Sess_Restore', [{ id: 'm1', role: 'user', turnSeq: 1, content: 'restore body' }], { head: { title: 'r', providerHistoryCount: 0 } });
  await f.index.prepare({}); await f.index.prepare({});
  await f.restart().pause();
  assert.equal((await f.index.restorePause({})).phase, 'paused');
  await f.index.resume();
  assert.equal((await f.restart().restorePause({})).phase, 'idle', 'resume after restorePause rewrites the marker');
});
