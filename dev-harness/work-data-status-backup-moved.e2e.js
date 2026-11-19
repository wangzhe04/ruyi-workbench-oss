#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// 151 阶段 3B · 150 W2：导出/启用成功后，用户移动、删除或复制备份包，修前 status 永久 503（改名回去仍 503、
// 重启仍 503、再导出 source_uncertain、面板全部禁用）。这件用真 serve（真 13ah/13au/01ae、真 NTFS 改名语义）
// 在一个合成数据根上验：回执与它记下的备份包是测试写进去的合成件（只用于 status 观察与包下载的哈希核对，
// 不是真恢复包，也不解密），之后只经产品 HTTP 观察。
//   B1 包在原处：status 200，lastResult.backupState=present，下载得到原字节。
//   B2 移走：status 仍 200（连读两次），backupState=missing，维护能力不变；下载给稳定码 package_missing（404）。
//   B3 原样改名回去：present，下载恢复。复制件放回：changed，下载拒绝（哈希/身份绑定不变）。删除：missing。
//   B4 重启 serve：包仍不在，status 仍 200（修前重启仍 503）。
//   B5 可再操作：包不在时提交一次真导出被受理（202）并真的走到「准备维护进程」，在交接前取消，回到可用状态。
//      修前同一步在 preparing 处因 source_uncertain 失败。取消发生在 go 之前：冷进程从未触碰数据根。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { releaseEnvironment } = require('./lib/release-checks');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('WORK DATA STATUS BACKUP MOVED'), { ok } = t;
const server = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-status-backup-moved-'));
const base = path.join(root, 'base'), home = path.join(root, 'home'), backups = path.join(root, 'backups'), workspace = path.join(root, 'workspace');
for (const dir of [base, home, backups, workspace]) fs.mkdirSync(dir, { recursive: true });
const children = new Set();

function spawnServe(port) {
  const child = cp.spawn(process.execPath, [server, 'serve', '--port', String(port)], { cwd: path.dirname(server), env: releaseEnvironment(home, base), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.output = (child.output + chunk).slice(-16000); });
  children.add(child); child.closed = new Promise(resolve => { child.once('error', () => resolve(null)); child.once('close', code => { children.delete(child); resolve(code); }); });
  return child;
}
async function stop(child) { if (child && child.exitCode === null && child.signalCode === null) killOwnTree(child); if (child) await child.closed; }
async function request(record, route, { method = 'GET', body, raw = false } = {}) {
  const response = await fetch('http://127.0.0.1:' + record.port + route, { method, headers: { 'x-wcw-token': record.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  if (raw) return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  let value = null; try { value = await response.json(); } catch { value = null; }
  return { status: response.status, value };
}
async function ready(child) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw Error('serve exited: ' + child.output.slice(-2000));
    let record; try { record = JSON.parse(fs.readFileSync(path.join(base, 'runtime.json'), 'utf8')); } catch { record = null; }
    if (record?.pid === child.pid) { try { if ((await request(record, '/health')).value?.ok) return record; } catch { /* not yet */ } }
    await sleep(50);
  }
  throw Error('serve readiness deadline');
}
// The maintenance worker capability binds asynchronously after listen on Windows; wait for the advertised state.
async function settledStatus(record) {
  let last = null;
  for (const end = Date.now() + 20000; Date.now() < end;) {
    last = await request(record, '/api/work-data/status');
    if (last.status === 200 && (process.platform !== 'win32' || last.value?.capabilities?.worker === true)) return last;
    await sleep(100);
  }
  return last;
}

(async () => {
  let serve = null;
  try {
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ configSchema: 14, locale: 'en-US', workDataEncryptionV1: false, permissionMode: 'ask', stewardEnabledV1: false,
      schedulerEnabledV1: false, autoImportClaudeCodeMcp: false, importAgentInstructions: false, includeWorkbenchMcp: false, enableMcpDropIn: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], providers: [], defaultWorkspace: workspace }));
    // A completed export receipt for the plain generation-zero root, bound to a synthetic package outside the data root.
    const id = crypto.randomBytes(24).toString('hex'), bytes = crypto.randomBytes(4096), packageFile = path.join(backups, 'ruyi-work-data-' + id + '.ruyi-backup');
    fs.writeFileSync(packageFile, bytes);
    const stat = fs.statSync(packageFile, { bigint: true }), authority = { generation: 0, id: null, mode: 'plain', sha256: null };
    fs.mkdirSync(path.join(base, '.work-data'));
    fs.writeFileSync(path.join(base, '.work-data', 'maintenance-result-v1.json'), JSON.stringify({ schema: 1, id, operation: 'export', state: 'verified',
      finishedAt: new Date().toISOString(), sourceAuthority: authority, authority,
      backup: { path: packageFile, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, identity: { dev: String(stat.dev), ino: String(stat.ino) } } }));
    serve = spawnServe(await getFreePort('127.0.0.1'));
    let record = await ready(serve);
    const first = await settledStatus(record);
    ok(first.status === 200 && first.value?.lastResult?.id === id && first.value.lastResult.backupState === 'present', 'B1 the receipt is observed with its package present');
    const worker = first.value?.capabilities?.worker === true;
    const saved = await request(record, '/api/work-data/results/' + id + '/package', { raw: true });
    ok(saved.status === 200 && saved.bytes.equals(bytes), 'B1 the package route serves the recorded bytes');

    const moved = packageFile + '.moved'; fs.renameSync(packageFile, moved);
    const afterMove = [await request(record, '/api/work-data/status'), await request(record, '/api/work-data/status')];
    ok(afterMove.every(row => row.status === 200 && row.value?.ok === true), 'B2 status stays 200 after the package is moved (twice in a row)');
    ok(afterMove.every(row => row.value?.lastResult?.id === id && row.value.lastResult.backupState === 'missing' && row.value.lastResultError === undefined), 'B2 the receipt reports backupState=missing instead of failing');
    ok(afterMove.every(row => row.value?.capabilities?.worker === worker && row.value?.maintenance?.phase === 'open'), 'B2 maintenance capability and intake are unchanged');
    const missing = await request(record, '/api/work-data/results/' + id + '/package');
    ok(missing.status === 404 && missing.value?.error?.code === 'work_data_setup.package_missing', 'B2 download names the moved package with a stable code (' + missing.status + ' ' + missing.value?.error?.code + ')');

    fs.renameSync(moved, packageFile);
    const back = await request(record, '/api/work-data/status');
    ok(back.status === 200 && back.value?.lastResult?.backupState === 'present', 'B3 renamed back in place: present again');
    const again = await request(record, '/api/work-data/results/' + id + '/package', { raw: true });
    ok(again.status === 200 && again.bytes.equals(bytes), 'B3 renamed back in place: the same receipt downloads again');
    fs.renameSync(packageFile, moved); fs.copyFileSync(moved, packageFile);
    const copied = await request(record, '/api/work-data/status');
    ok(copied.status === 200 && copied.value?.lastResult?.backupState === 'changed', 'B3 a copy put in place is reported as changed');
    const copiedPackage = await request(record, '/api/work-data/results/' + id + '/package');
    ok(copiedPackage.status === 503 && copiedPackage.value?.error?.code === 'work_data_setup.package_unavailable', 'B3 a copy with a new identity is still refused by the identity-bound download');
    fs.unlinkSync(packageFile); fs.unlinkSync(moved);
    const deleted = await request(record, '/api/work-data/status');
    ok(deleted.status === 200 && deleted.value?.lastResult?.backupState === 'missing', 'B3 deleted: status 200 with backupState=missing');

    await stop(serve); serve = spawnServe(await getFreePort('127.0.0.1')); record = await ready(serve);
    const restarted = await settledStatus(record);
    ok(restarted?.status === 200 && restarted.value?.lastResult?.id === id && restarted.value.lastResult.backupState === 'missing', 'B4 after a restart status is still 200 with the package missing');

    if (process.platform === 'win32' && restarted?.value?.capabilities?.worker === true) {
      const submitted = await request(record, '/api/work-data/jobs', { method: 'POST', body: { operation: 'export', password: 'SYNTHETIC status backup moved only', expectedAuthority: authority, backupDirectory: backups } });
      ok(submitted.status === 202 && /^[a-f0-9]{48}$/.test(submitted.value?.job?.id || ''), 'B5 a new export is accepted while the old package is missing (' + submitted.status + ' ' + (submitted.value?.error?.code || '') + ')');
      const jobId = submitted.value?.job?.id; let state = null, error = null;
      for (const end = Date.now() + 60000; jobId && Date.now() < end;) {
        const job = await request(record, '/api/work-data/jobs/' + jobId); state = job.value?.job?.state; error = job.value?.job?.error;
        if (state !== 'queued' && state !== 'draining') break; await sleep(20);
      }
      ok(state === 'preparing', 'B5 the export reaches the maintenance worker start instead of failing as source_uncertain (state ' + state + ', error ' + error + ')');
      if (state === 'preparing') {
        const cancelled = await request(record, '/api/work-data/jobs/' + jobId + '/cancel', { method: 'POST', body: {} });
        ok(cancelled.status === 200, 'B5 the prepared export is cancelled before go (' + cancelled.status + ' ' + (cancelled.value?.error?.code || '') + ')');
        for (const end = Date.now() + 30000; Date.now() < end;) { state = (await request(record, '/api/work-data/jobs/' + jobId)).value?.job?.state; if (state === 'cancelled' || state === 'failed') break; await sleep(50); }
        // The job reads cancelled as soon as it is refused; its own cleanup (child stop, lease resume) then clears it from status.
        let settled = null;
        for (const end = Date.now() + 30000; Date.now() < end;) { settled = await request(record, '/api/work-data/status'); if (settled.status === 200 && settled.value?.job === null) break; await sleep(50); }
        ok(state === 'cancelled' && settled?.status === 200 && settled.value?.maintenance?.phase === 'open' && settled.value?.job === null, 'B5 the cancelled export returns to an open, usable panel (state ' + state + ', status ' + settled?.status + ' ' + JSON.stringify({ phase: settled?.value?.maintenance?.phase, job: settled?.value?.job?.state ?? null, worker: settled?.value?.capabilities?.worker, error: settled?.value?.error?.code }) + ')');
      }
      ok(fs.readdirSync(backups).length === 0, 'B5 no package or rehearsal was written by the cancelled export');
    } else console.log('SKIP B5 (maintenance worker is Windows-only on a plain serve)');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    for (const child of [...children]) await stop(child);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* the OS temp cleaner owns leftovers */ }
    t.done();
  }
})();
