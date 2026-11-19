'use strict';
// 151 阶段 3B · 150 W9：交接阶段偶发 uncertain（实测 9 次 1 次）。
//
// 机制（本文件取证并钉住）：GET /api/work-data/status 在 13-http-router 里走 WorkDataSetupHooks.handle，
// 不经维护准入；修前 status 每次都调 workerHooks.readResult —— 一个 13au operation（新 pin、记进 warm.inflight），
// 读回执并整包读取、哈希备份包。交接时 13ah 先 lease.retire()，再经 handoff → exitParent 查 retiredReceipt：
// 只要那一刻还有一个 status 读在 inflight 里，retiredFor('warm') 就给 null → handoff_not_retired → retain → uncertain。
// 面板每 1.5 s、输入框闸门每 3 s 各轮询一次，读一次要回到事件循环若干轮（备份包越大越久），于是偶发。
//
// 形状阶梯（合成对照）：同一套真模块（13ah 设置 + 13ag 维护 + 13au 宿主 + 01ae 回执，内存盘），只改「读回执时每次 IO
// 让出多少」——none（同步返回）/ microtask（await null）/ immediate（setImmediate，回到事件循环）/ fs（真 fs 线程池往返）。
// 探针：多路并发的 status 轮询打满整个交接，交接用 13au 的真 retiredReceipt 判退休。对照组是「旧写法」轮询
// （直接调 source-scoped 的 readResult，修前 status 就是这么读的），实验组是 status 本身。
// 判据：旧写法在回到事件循环的两档必漏（证明探针灵敏、分界线是「有没有回到事件循环」）；status 在所有档 0 漏。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createFixture, tick } = require('../lib/work-data-production-host-fixture');
const { constBlock } = require('../lib/source-slice');

const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const maintenanceSource = constBlock(fs.readFileSync(path.join(sourceRoot, '13ag-work-data-maintenance.js'), 'utf8'), 'WorkDataMaintenance');
const ROUNDS = Number(process.env.RUYI_HANDOFF_STRESS_ROUNDS) > 0 ? Number(process.env.RUYI_HANDOFF_STRESS_ROUNDS) : 20;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rungs = {
  none: async () => {},
  microtask: async () => { await null; },
  immediate: () => new Promise(resolve => setImmediate(resolve)),
  fs: () => fsp.stat(__filename).then(() => undefined),
};

// One complete in-process handoff. Returns the job's terminal observation.
async function handoffRound({ rung, pollers = 8, legacyPollers = 0, settleFirst = false }) {
  const f = createFixture(), warm = await f.warm(), installed = f.factory.installWarm(), host = installed.host;
  // Production order: installWarm, then the router's captureServe installs the captured verified reader.
  await installed.runtime.captureServe(f.captureContext(warm.session, warm.ownership));
  // A current result and its package, so the verified reader really hashes a package (as in production).
  const id = 'd'.repeat(48), bytes = crypto.randomBytes(256 * 1024), control = path.join(f.paths.base, '.work-data');
  f.memory.mkdir(control);
  const file = path.join(f.paths.backup, 'ruyi-work-data-' + id + '.ruyi-backup'); f.memory.put(file, bytes);
  f.memory.put(path.join(control, f.api.result.NAME), JSON.stringify({ schema: 1, id, operation: 'export', state: 'verified',
    finishedAt: '2026-11-19T00:00:00.000Z', sourceAuthority: { ...f.fullAuthority }, authority: { ...f.fullAuthority },
    backup: { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, identity: { dev: '1', ino: String(f.memory.stat(file).ino) } } }));
  // The rung: every data-root/backup IO yields this much before it answers.
  for (const name of ['lstat', 'open', 'readdir', 'realpath']) {
    const original = f.memory.io[name];
    f.memory.io[name] = async (...args) => { await rungs[rung](); return original(...args); };
  }
  // Real 13ag maintenance owner; 13au judges retirement from its live status.
  f.context.__asyncHooks = require('node:async_hooks');
  const Maintenance = vm.runInContext(maintenanceSource.replace("require('node:async_hooks')", '__asyncHooks') + '\nWorkDataMaintenance', f.context);
  const maintenance = Maintenance.create({ owns: () => false, snapshot: () => ({ pending: [], dirty: 0, busy: { turns: 0 } }),
    pause: () => ({}), resume() {}, progress: async () => {}, flush: async () => {}, yield: () => sleep(1) });
  f.bindings.maintenance = maintenance;
  // The worker handle models 13ai/13am at their observable boundary: handoff → exitParent checks the
  // live retirement receipt (13am exitParent calls the same host.retiredReceipt twice) and then exits.
  let exited = false, refused = null, inFlight = 0, crossing = null;
  const handle = { ready: Promise.resolve(), failure: new Promise(() => {}), cancel: async () => {}, commit: async () => {}, assertArmed() {},
    async handoff() {
      await null; crossing = inFlight;
      if (host.retiredReceipt() === null || host.retiredReceipt() === null) { refused = 'work_data_setup.handoff_not_retired'; throw Object.assign(Error(refused), { code: refused }); }
      exited = true; return new Promise(() => {}); // process exit never returns
    } };
  f.workerHooks.start = request => host.withWarmSource(request, async () => handle);
  const infrastructure = { prepareInfrastructure: () => ({}), closeInfrastructure: async () => { await sleep(3); }, resumeInfrastructure() {} };
  const setup = f.api.setup.create({ maintenance, infrastructure, worker: () => f.workerHooks, workerReady: () => true,
    inspect: async () => ({ base: f.paths.base, authority: { ...f.fullAuthority }, configMirror: true }), validateDirectories: async () => {},
    id: () => crypto.randomBytes(24).toString('hex'), now: () => new Date().toISOString(), defer: work => setImmediate(work), respond: (res, body) => { res.body = body; } });
  // The job record itself (GET /api/work-data/jobs/:id), independent of whether status still answers.
  const jobView = async id => { const res = {}; await setup.handle({ method: 'GET' }, res, '/api/work-data/jobs/' + id); return res.body.job; };
  let done = false; const counts = { status: 0, statusErrors: 0, legacy: 0, legacyErrors: 0 };
  // inFlight counts every poll that has started and not yet answered; the handoff samples it at its retirement check.
  const poll = async (work, ok, bad) => { inFlight++; try { await work(); counts[ok]++; } catch { counts[bad]++; } finally { inFlight--; } };
  const statusLoop = async () => { while (!done) { await poll(() => setup.status(), 'status', 'statusErrors'); await new Promise(resolve => setImmediate(resolve)); } };
  const legacyLoop = async () => { while (!done) { await poll(() => f.workerHooks.readResult(), 'legacy', 'legacyErrors'); await new Promise(resolve => setImmediate(resolve)); } };
  const loops = [...Array.from({ length: pollers }, statusLoop), ...Array.from({ length: legacyPollers }, legacyLoop)];
  // settleFirst: every poller has finished its idle-time read before the job (polls during the job only);
  // otherwise the job starts while those first reads are still in flight (the read-before-job straddle).
  if (settleFirst) { for (let index = 0; index < 2000 && counts.status + counts.legacy < pollers + legacyPollers; index++) await sleep(1); } else await sleep(2);
  const view = await setup.submit({ operation: 'export', password: 'synthetic stress password', expectedAuthority: { ...f.fullAuthority }, backupDirectory: f.paths.backup });
  assert.equal(view.state, 'queued');
  for (let index = 0; index < 4000; index++) {
    const state = (await jobView(view.id)).state;
    if (exited || state === 'uncertain' || state === 'failed' || state === 'cancelled') break;
    await sleep(1);
  }
  await sleep(5); done = true; await Promise.all(loops);
  const final = await jobView(view.id);
  return { outcome: exited && final?.state === 'handoff' ? 'handoff' : final?.state || 'unknown', error: final?.error || null, refused,
    retained: f.factory.helperMayStillRun(), counts, crossing };
}

test('W9 shape ladder: the old source-scoped status read leaks across the retirement boundary only when it returns to the event loop; status never does', async () => {
  const table = {};
  for (const rung of Object.keys(rungs)) {
    const legacy = { uncertain: 0, handoff: 0 }, current = { uncertain: 0, handoff: 0 };
    for (let round = 0; round < 4; round++) {
      const control = await handoffRound({ rung, pollers: 0, legacyPollers: 8 });
      legacy[control.outcome === 'uncertain' ? 'uncertain' : 'handoff']++;
      const experiment = await handoffRound({ rung, pollers: 8 });
      current[experiment.outcome === 'uncertain' ? 'uncertain' : 'handoff']++;
      assert.equal(experiment.outcome, 'handoff', rung + ' round ' + round + ': status polling never makes the handoff uncertain (' + JSON.stringify(experiment) + ')');
      assert.equal(experiment.retained, false);
    }
    table[rung] = { legacy, current };
  }
  console.log('# W9 shape ladder (4 rounds per rung, 8 pollers):', JSON.stringify(table));
  // The probe is sensitive: once a read yields to the event loop, the old status read straddles retirement.
  // The immediate rung is reported but not asserted: whether a setImmediate-only read straddles the boundary
  // is probabilistic. The fs rung (a thread-pool round trip per IO) is the asserted control; the parked-IO
  // double-read test in work-data-production-host.test.js is the deterministic proof.
  assert.ok(table.fs.legacy.uncertain > 0, 'control must leak at the fs rung: ' + JSON.stringify(table));
});

test('W9 handoff stress: ' + ROUNDS + ' offline handoffs under 8 concurrent status pollers end in handoff with zero uncertain', async () => {
  const outcomes = { handoff: 0, uncertain: 0, other: 0 }; let polled = 0, crossing = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const result = await handoffRound({ rung: 'fs', pollers: 8, settleFirst: round % 2 === 1 });
    outcomes[result.outcome === 'handoff' ? 'handoff' : result.outcome === 'uncertain' ? 'uncertain' : 'other']++;
    polled += result.counts.status; crossing += result.crossing || 0;
    assert.equal(result.retained, false, 'round ' + round + ' retained the source: ' + JSON.stringify(result));
  }
  console.log('# W9 handoff stress:', JSON.stringify({ rounds: ROUNDS, ...outcomes, statusPolls: polled, pollsInFlightAtRetirementChecks: crossing }));
  assert.deepEqual(outcomes, { handoff: ROUNDS, uncertain: 0, other: 0 });
  assert.ok(polled > ROUNDS * 8, 'the pollers really ran during the handoffs');
  assert.ok(crossing > 0, 'some status polls were in flight exactly at a retirement check');
});
