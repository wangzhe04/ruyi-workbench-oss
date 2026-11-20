#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// 151 阶段 3H（150 §9.2 拍板）：3.1.0 的工作数据加密是实验性功能，「启用加密」默认隐藏。这件在真 serve（真 01-config、
// 真 13ah 准入与 config.json 原文读、真路由错误翻译）上验后端兜底：
//   X1 出厂配置：/api/work-data/status 报 experimentalEncryption:false。
//   X2 开关关着：一次形状完整的启用请求被稳定码 work_data_setup.experimental_disabled（409）拒绝，而且数据根、备份目录、
//      数据根旁边一样都没改（没有演练目录、没有密钥头、没有作业，authority 与 config.json 原样）。
//   X3 开关关着：导出与转明文不受开关影响 —— 它们走到自己的检查（目录不存在 → path_invalid；明文根上转明文 → mode_conflict）。
//   X4 用户经 POST /api/config 打开开关：status 报 true；同一形状的启用请求越过实验闸，停在自己的目录检查上（仍不改任何数据）。
//   X5 只认 JSON 布尔 true：写成字符串 "true" 等于关。
// 只用合成数据根；不真的启用加密（真启用见 work-data-production-maintenance.e2e / work-data-production-enable.browser.e2e）。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { releaseEnvironment } = require('./lib/release-checks');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('WORK DATA ENCRYPTION EXPERIMENTAL'), { ok } = t;
const server = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-wd-experimental-'));
const base = path.join(root, 'base'), home = path.join(root, 'home'), backups = path.join(root, 'backups'), workspace = path.join(root, 'workspace');
for (const dir of [base, home, backups, workspace]) fs.mkdirSync(dir, { recursive: true });
const PASSWORD = 'SYNTHETIC experimental gate password only';

function spawnServe(port) {
  const child = cp.spawn(process.execPath, [server, 'serve', '--port', String(port)], { cwd: path.dirname(server), env: releaseEnvironment(home, base), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.output = (child.output + chunk).slice(-16000); });
  child.closed = new Promise(resolve => { child.once('error', () => resolve(null)); child.once('close', code => resolve(code)); });
  return child;
}
async function stop(child) { if (child && child.exitCode === null && child.signalCode === null) killOwnTree(child); if (child) await child.closed; }
async function request(record, route, { method = 'GET', body } = {}) {
  const response = await fetch('http://127.0.0.1:' + record.port + route, { method, headers: { 'x-wcw-token': record.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  let value = null; try { value = await response.json(); } catch { value = null; }
  return { status: response.status, value };
}
async function ready(child) {
  for (const end = Date.now() + 30000; Date.now() < end;) {
    if (child.exitCode !== null) throw Error('serve exited: ' + child.output.slice(-2000));
    let record; try { record = JSON.parse(fs.readFileSync(path.join(base, 'runtime.json'), 'utf8')); } catch { record = null; }
    if (record?.pid === child.pid) { try { if ((await request(record, '/health')).value?.ok) return record; } catch { /* not yet */ } }
    await sleep(50);
  }
  throw Error('serve readiness deadline');
}
// The maintenance worker capability binds asynchronously after listen on Windows; the gate sits behind it.
async function settledStatus(record) {
  let last = null;
  for (const end = Date.now() + 20000; Date.now() < end;) {
    last = await request(record, '/api/work-data/status');
    if (last.status === 200 && (process.platform !== 'win32' || last.value?.capabilities?.worker === true)) return last;
    await sleep(100);
  }
  return last;
}
// What a started maintenance job would have created: a rehearsal next to the root, a key header, a claim/intent, anything in the backup folder.
function footprint() {
  const hash = file => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
  const list = dir => { try { return fs.readdirSync(dir).sort(); } catch { return null; } };
  const serveTemp = (list(path.join(home, 'Temp')) || []).filter(name => /^(?:ruyi-work-data|\.ruyi-work-data|ruyi-maintenance)/i.test(name));
  return { siblings: list(root), backups: list(backups), workData: list(path.join(base, '.work-data')), keyHeader: fs.existsSync(path.join(base, 'work-data-key-v1.json')),
    config: hash(path.join(base, 'config.json')), serveTemp };
}
// v2（审查 4）：作业经 setImmediate 延后执行，回包后立刻拍的足迹证明不了什么。这里在一段固定的观察窗里反复读状态、反复拍足迹：
// 窗内任何一次看到作业、维护态离开 open、或足迹与提交前不同，都算「改了」。修前（没有实验闸）这一窗里作业已在跑，断言会红。
async function settleUnchanged(record, before, windowMs = 8000) {
  const seen = { job: null, phase: null, changed: null, samples: 0 };
  for (const end = Date.now() + windowMs; Date.now() < end;) {
    const status = await request(record, '/api/work-data/status').catch(() => null);
    seen.samples++;
    if (status?.value?.job && !seen.job) seen.job = status.value.job.state || 'present';
    if (status?.value?.maintenance?.phase && status.value.maintenance.phase !== 'open' && !seen.phase) seen.phase = status.value.maintenance.phase;
    const now = JSON.stringify(footprint());
    if (now !== JSON.stringify(before) && !seen.changed) seen.changed = now;
    await sleep(250);
  }
  return seen;
}

(async () => {
  let serve = null;
  try {
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ configSchema: 14, locale: 'en-US', workDataEncryptionV1: false, permissionMode: 'ask', stewardEnabledV1: false,
      schedulerEnabledV1: false, autoImportClaudeCodeMcp: false, importAgentInstructions: false, includeWorkbenchMcp: false, enableMcpDropIn: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], providers: [], defaultWorkspace: workspace }));
    serve = spawnServe(await getFreePort('127.0.0.1'));
    const record = await ready(serve);
    const first = await settledStatus(record);
    ok(first?.status === 200 && first.value?.experimentalEncryption === false && first.value?.authority?.mode === 'plain', 'X1 factory config: status reports experimentalEncryption:false on a plain root');
    const worker = first?.value?.capabilities?.worker === true;
    if (process.platform === 'win32') ok(worker, 'X1 the maintenance worker is advertised (the experimental gate sits behind it)');
    const authority = first.value.authority, before = footprint();
    const enable = await request(record, '/api/work-data/jobs', { method: 'POST', body: { operation: 'enable', password: PASSWORD, expectedAuthority: authority, backupDirectory: backups } });
    if (worker) ok(enable.status === 409 && enable.value?.error?.code === 'work_data_setup.experimental_disabled', 'X2 switch off: enable is refused with the stable code (' + enable.status + ' ' + enable.value?.error?.code + ')');
    const after = await request(record, '/api/work-data/status');
    const settled = await settleUnchanged(record, before);
    ok(!settled.changed && settled.samples > 3, 'X2 the refusal changed nothing over the settle window: no rehearsal, key header, maintenance record, handoff claim, backup file or config change' + (settled.changed ? ' (now ' + settled.changed + ')' : ''));
    ok(!settled.job && !settled.phase, 'X2 no job appeared and maintenance never left open during the settle window' + (settled.job || settled.phase ? ' (job ' + settled.job + ', phase ' + settled.phase + ')' : ''));
    ok(after.status === 200 && JSON.stringify(after.value?.authority) === JSON.stringify(authority) && after.value?.job === null && after.value?.maintenance?.phase === 'open',
      'X2 authority unchanged, no job, intake still open');
    const missingDir = path.join(root, 'no-such-backup-folder');
    const exported = await request(record, '/api/work-data/jobs', { method: 'POST', body: { operation: 'export', password: PASSWORD, expectedAuthority: authority, backupDirectory: missingDir } });
    if (worker) ok(exported.status === 400 && exported.value?.error?.code === 'work_data_setup.path_invalid', 'X3 switch off: export passes the gate and stops at its own folder check (' + exported.value?.error?.code + ')');
    const disable = await request(record, '/api/work-data/jobs', { method: 'POST', body: { operation: 'disable', password: PASSWORD, expectedAuthority: authority, backupDirectory: backups, confirmPlaintext: true } });
    ok(disable.status === 409 && disable.value?.error?.code === 'work_data_setup.mode_conflict', 'X3 switch off: switching a plain root to plaintext keeps its own mode_conflict, not the experimental code');

    const saved = await request(record, '/api/config', { method: 'POST', body: { workDataEncryptionExperimentalV1: true } });
    ok(saved.status === 200 && saved.value?.config?.workDataEncryptionExperimentalV1 === true, 'X4 the user turns the switch on through the ordinary config route');
    const on = await request(record, '/api/work-data/status');
    ok(on.status === 200 && on.value?.experimentalEncryption === true, 'X4 status now reports experimentalEncryption:true (read back from config.json)');
    const beforeOn = footprint();
    const gated = await request(record, '/api/work-data/jobs', { method: 'POST', body: { operation: 'enable', password: PASSWORD, expectedAuthority: authority, backupDirectory: missingDir } });
    if (worker) ok(gated.status === 400 && gated.value?.error?.code === 'work_data_setup.path_invalid', 'X4 switch on: enable passes the gate and stops at its own folder check (' + gated.value?.error?.code + ')');
    const settledOn = await settleUnchanged(record, beforeOn, 3000);
    ok(!settledOn.changed && !settledOn.job && !settledOn.phase, 'X4 the refused enable changed nothing over the settle window');

    const text = await request(record, '/api/config', { method: 'POST', body: { workDataEncryptionExperimentalV1: 'true' } });
    const off = await request(record, '/api/work-data/status');
    ok(text.status === 200 && text.value?.config?.workDataEncryptionExperimentalV1 === false && off.value?.experimentalEncryption === false, 'X5 a string "true" is normalized to off');
    if (worker) {
      const again = await request(record, '/api/work-data/jobs', { method: 'POST', body: { operation: 'enable', password: PASSWORD, expectedAuthority: authority, backupDirectory: backups } });
      ok(again.status === 409 && again.value?.error?.code === 'work_data_setup.experimental_disabled', 'X5 after normalizing to off, enable is refused again');
    }
  } catch (error) { t.fail('fatal: ' + (error?.stack || error)); }
  finally {
    await stop(serve);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may keep a handle briefly; the temp root is isolated */ }
  }
  t.done({ exit: true });
})();
