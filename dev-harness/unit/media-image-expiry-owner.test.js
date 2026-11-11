'use strict';
// Real ALS maintenance admission, real MediaDerivedStore/WorkDataStore, crypto,
// atomic writer and temporary filesystem. Only decoded pixels and timer delivery
// are synthetic. AsyncResource preserves the actual registration-time ALS state.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), crypto = require('node:crypto'), { AsyncResource } = require('node:async_hooks');
const { constBlock, functionBlock } = require('../lib/source-slice');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const read = file => fs.readFileSync(path.join(sourceRoot, file), 'utf8');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = () => new Promise(resolve => setImmediate(resolve));
async function settled(predicate) { for (let index = 0; index < 200; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('cleanup did not settle'); }

async function fixture(t, { encrypted = false, removeFails = false } = {}) {
  const temp = await fsp.realpath(os.tmpdir()), root = await fsp.mkdtemp(path.join(temp, 'ruyi-media-expiry-owner-'));
  const derived = path.join(root, 'derived'); await fsp.mkdir(derived);
  let time = Date.now(), serial = 0, sourceSerial = 0, allowed = true, failUnlink = removeFails;
  const timers = new Map(), handles = [], cleanupErrors = [], expiryErrors = [], sources = [];
  const shared = loadWorkDataChunks();
  const io = { ...fsp, async unlink(file) {
    if (failUnlink && /^mimg_[a-f0-9]{32}\.json$/.test(path.basename(file))) throw Object.assign(Error('synthetic unlink failure'), { code: 'EACCES' });
    return fsp.unlink(file);
  } };
  const code = ['01i-privacy-rules.js', '01h-privacy-core.js', '13ba-media-image-contract.js', '13bb-media-derived-store.js', '13bd-media-image-service.js']
    .map(read).join('\n') + '\n' + constBlock(read('13ag-work-data-maintenance.js'), 'WorkDataMaintenance');
  const api = vm.runInNewContext(code + ';({MediaImageService,MediaDerivedStore,WorkDataMaintenance});', {
    require: name => name === 'node:fs/promises' ? io : require(name), WorkDataStore: shared.store, Buffer, Headers, process,
    setTimeout(fn, delay) { const handle = { id: ++serial, unref() {} }; timers.set(handle, { due: time + delay, id: serial, fn: AsyncResource.bind(fn) }); return handle; },
    clearTimeout(handle) { timers.delete(handle); },
  });
  const maintenance = api.WorkDataMaintenance.create({ extraAdmission: () => allowed, snapshot: () => ({ pending: [], busy: {}, dirty: 0 }),
    owns: () => false, pause() {}, resume() {}, flush: async () => {}, yield: pause });
  const hostCleanupSource = functionBlock(read('13be-media-image-host.js'), 'expireCleanup');
  const expireCleanup = hostCleanupSource ? vm.runInNewContext(hostCleanupSource + ';expireCleanup;', {
    WorkDataMaintenanceHooks: maintenance, managed: work => maintenance.run('media-image', work),
  }) : work => maintenance.fresh('media-image', work);
  const sessionId = 'sess_expiry_owner', scopeId = hash(sessionId).slice(0, 32), config = { personal: true, rules: [] };
  const policy = { config, hash: hash(JSON.stringify(config)), rulesHash: hash('rules'), revision: 'p1', assert: () => true };
  const snapshot = { hash: hash('processor'), version: 'v1' };
  const processor = { capture: () => snapshot, assert: () => true, start(request) { return {
    promise: Promise.resolve({ width: 12, height: 12, rgba: Buffer.alloc(12 * 12 * 4, 255), sourceHash: request.sourceHash,
      processorHash: snapshot.hash, frames: 1, orientationApplied: true, ocrComplete: true, codesComplete: true,
      transform: { width: 12, height: 12, orientation: 1 }, words: [{ text: 'fixture@example.test', line: 0, box: [1, 1, 5, 5] }], codes: [] }),
    finish: () => ({ closed: true, helperMayStillRun: false, ownershipRetained: false }),
  }; } };
  const service = api.MediaImageService.create({ now: () => time, context: () => ({ scopeId: sessionId }),
    async expireCleanup(work) { try { return await expireCleanup(work); } catch (error) { expiryErrors.push(error); throw error; } },
    storeFor: async ({ authority }) => {
      const store = api.MediaDerivedStore.create({ root: derived, scopeId, authority, now: () => time, enabled: async () => encrypted,
        keys: { snapshot: async () => ({ key: Buffer.alloc(32, 3), instanceId: 'media-expiry-unit', release() {} }) }, writeJson: shared.atomicWriteJson });
      return { put: store.put, read: store.read, async remove(id) {
        try { return await maintenance.run('media-image', () => store.remove(id)); }
        catch (error) { cleanupErrors.push(error); throw error; }
      }, dispose: () => maintenance.run('media-image', () => store.dispose()) };
    } });
  async function lease({ holdClose = false } = {}) {
    const number = ++sourceSerial, file = path.join(root, 'source-' + number + '.bin'), bytes = Buffer.alloc(32, number);
    await fsp.writeFile(file, bytes); const handle = await fsp.open(file, 'r'); handles.push(handle);
    let closed = false, hold = false, releaseActive = null, arrive, resume;
    const entered = new Promise(resolve => { arrive = resolve; }), gate = new Promise(resolve => { resume = resolve; });
    const source = { id: 'file_' + number, name: 'public.png', snapshot: { bytes, hash: hash(bytes), revision: 's' + number, scope: scopeId },
      assert() { assert.equal(closed, false); assert.ok(fs.fstatSync(handle.fd).isFile()); return true; }, async release() {
        releaseActive = maintenance.active();
        bytes.fill(0); arrive(); if (hold) await gate; await handle.close(); closed = true;
      } };
    const owned = { source, closed: () => closed, holdClose: () => { hold = holdClose; }, releaseActive: () => releaseActive, entered, resume }; sources.push(owned); return owned;
  }
  const prepare = async owned => maintenance.run('media-image', () => service.prepare({ sessionId, source: owned.source, policy, processor, recipient: hash('recipient') }));
  t.after(async () => { for (const owned of sources) owned.resume(); for (const handle of handles) await handle.close().catch(() => {});
    assert.equal(path.dirname(await fsp.realpath(root)), temp); assert.match(path.basename(root), /^ruyi-media-expiry-owner-/); await fsp.rm(root, { recursive: true }); });
  return { service, maintenance, lease, prepare, cleanupErrors, expiryErrors, files: () => fsp.readdir(derived), setAllowed: value => { allowed = value; },
    removeWorks: () => { failUnlink = false; }, async expire() {
      const deadline = Math.min(...[...timers.values()].map(value => value.due)); time = deadline;
      const due = [...timers].filter(([, value]) => value.due === deadline).sort((a, b) => a[1].id - b[1].id);
      assert.equal(due.length, 2);
      for (const [handle, value] of due) if (timers.delete(handle)) value.fn();
      await pause();
    } };
}

for (const encrypted of [false, true]) test(`detached expiry owns real ${encrypted ? 'encrypted' : 'plain'} store deletion through source close`, async t => {
  const f = await fixture(t, { encrypted }), owned = await f.lease({ holdClose: true }), issued = await f.prepare(owned); owned.holdClose();
  assert.equal((await f.files()).length, 1); assert.equal(f.maintenance.status().admitted, 0);
  await f.expire(); await owned.entered;
  try {
    assert.deepEqual(f.cleanupErrors.map(error => error.code), []);
    assert.deepEqual(await f.files(), []);
    assert.equal(f.maintenance.status().admitted, 1, 'fresh owner remains live while the real source close is pending');
    assert.equal(owned.releaseActive(), true, 'source close remains inside its actual maintenance admission');
    assert.equal(owned.closed(), false);
  } finally { owned.resume(); }
  await settled(() => owned.closed() && f.maintenance.status().admitted === 0);
  let stale;
  await f.maintenance.run('old-business', async () => { stale = AsyncResource.bind(() => f.maintenance.run('old-business', () => assert.fail('stale business must not enter'))); });
  await assert.rejects(stale(), { code: 'work_data.maintenance_stale_continuation' });
  await assert.rejects(f.service.borrow(issued.id), { code: 'privacy.image_expired' });
  const accepted = [];
  try { for (let index = 0; index < 4; index++) accepted.push(await f.prepare(await f.lease())); }
  finally { for (const value of accepted) await f.maintenance.run('media-image', () => f.service.remove(value.id)); }
});

test('a real derived-store unlink failure remains retained after fresh cleanup admission', async t => {
  const f = await fixture(t, { removeFails: true }), owned = await f.lease(); await f.prepare(owned); await f.expire();
  await settled(() => owned.closed() && f.maintenance.status().admitted === 0);
  assert.deepEqual(f.cleanupErrors.map(error => error.code), ['EACCES']); assert.equal((await f.files()).length, 1);
  f.removeWorks(); const accepted = [];
  try {
    for (let index = 0; index < 3; index++) accepted.push(await f.prepare(await f.lease()));
    await assert.rejects(f.prepare(await f.lease()), { code: 'privacy.image_busy' });
  } finally { for (const value of accepted) await f.maintenance.run('media-image', () => f.service.remove(value.id)); }
});

for (const boundary of ['extraAdmission', 'busy', 'retired']) test(`detached expiry still respects ${boundary} without unlink or source close`, async t => {
  const f = await fixture(t), owned = await f.lease(), issued = await f.prepare(owned);
  let maintenanceLease;
  if (boundary === 'extraAdmission') f.setAllowed(false);
  else {
    maintenanceLease = f.maintenance.begin();
    if (boundary === 'retired') { await maintenanceLease.idle(); maintenanceLease.retire(); }
  }
  await f.expire(); await settled(() => f.expiryErrors.length === 1);
  assert.equal(f.expiryErrors[0].code, 'work_data.maintenance_busy');
  assert.deepEqual(f.cleanupErrors, []); assert.equal((await f.files()).length, 1);
  assert.equal(owned.closed(), false); assert.equal(owned.releaseActive(), null);
  assert.equal(f.maintenance.status().admitted, 0);
  await assert.rejects(f.service.borrow(issued.id), { code: 'privacy.image_expired' });
  if (boundary !== 'retired') {
    if (maintenanceLease) maintenanceLease.resume(); else f.setAllowed(true);
    const accepted = [];
    try {
      for (let index = 0; index < 3; index++) accepted.push(await f.prepare(await f.lease()));
      await assert.rejects(f.prepare(await f.lease()), { code: 'privacy.image_busy' });
    } finally {
      for (const value of accepted) await f.maintenance.run('media-image', () => f.service.remove(value.id));
      await f.maintenance.run('media-image', () => f.service.remove(issued.id));
    }
    assert.equal(owned.closed(), true); assert.deepEqual(await f.files(), []);
  }
});
