'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { snapshotProcessTable } = require('./lib/kill-own-tree');
const t = createRunner('MACOS SYNC SUPERVISOR');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-sync-supervisor-'));
const helper = path.resolve(__dirname, '../ruyi-workbench/runtime/macos/ruyi-process-helper');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(deadline, source, extra = {}) {
  const result = cp.spawnSync(helper, ['--supervise-v2-deadline', String(deadline), process.execPath, '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, ...extra,
  });
  const frames = String(result.output?.[3] || '').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...result, frames };
}
function confirmed(frames) {
  const primary = frames.find(f => f.event === 'cleanup');
  const guardian = frames.at(-1);
  return primary?.detail === 1 && primary.value === 0 && guardian?.event === 'guardian-cleanup' && guardian.detail === 1 && guardian.value === 0;
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires native macOS supervisor'); return; }
    const capabilities = cp.spawnSync(helper, ['--capabilities'], { encoding: 'utf8', timeout: 2000 });
    t.ok(JSON.parse(capabilities.stdout).deadline === true, 'helper explicitly advertises native deadline support');
    const natural = run(2000, 'console.log("中文😀");process.stderr.write("diagnostic");process.exit(7)');
    t.ok(natural.status === 7 && natural.stdout.trim() === '中文😀' && natural.stderr === 'diagnostic' && confirmed(natural.frames), 'sync launch preserves stdout/stderr and exit status with confirmed cleanup');
    t.ok(!natural.frames.some(f => f.event === 'deadline'), 'normal completion emits no deadline event');
    const beat = path.join(root, 'heartbeat');
    const ids = path.join(root, 'ids');
    const leaf = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(ids)},process.pid+'\\n');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),10);setTimeout(()=>process.exit(0),10000);`;
    const source = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ids)},process.pid+'\\n');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',detached:true});setTimeout(()=>process.exit(0),10000);`;
    const started = Date.now();
    const timed = run(400, source);
    t.ok(!timed.error && Date.now() - started < 2500 && timed.frames.filter(f => f.event === 'deadline').length === 1 && confirmed(timed.frames), 'native timeout finishes both cleanup layers before the Node safety deadline');
    t.ok(timed.frames.findIndex(f => f.event === 'deadline') < timed.frames.findIndex(f => f.event === 'cleanup'), 'deadline event precedes primary cleanup and final guardian confirmation');
    const size = fs.statSync(beat).size; await sleep(150);
    t.ok(size > 0 && fs.statSync(beat).size === size, 'native deadline stops detached descendant writes while owner Node is blocked');
    const owned = fs.readFileSync(ids, 'utf8').split(/\\n|\n/).filter(Boolean).map(Number);
    const table = snapshotProcessTable();
    t.ok(owned.length === 2 && owned.every(pid => !table.some(row => row.pid === pid)), 'target and observed detached descendant identities have exited');
    const signalled = run(2000, 'process.kill(process.pid,"SIGTERM")');
    t.ok(signalled.signal === 'SIGTERM' && confirmed(signalled.frames) && signalled.frames.some(f => f.event === 'exit' && f.detail === 15), 'natural target signal retains its status and full cleanup reports');
    for (const signal of ['SIGSTOP', 'SIGKILL']) {
      const faultBeat = path.join(root, signal + '-heartbeat');
      const fault = run(200, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(faultBeat)},'x');process.kill(process.ppid,${JSON.stringify(signal)});setInterval(()=>fs.appendFileSync(${JSON.stringify(faultBeat)},'x'),10);setTimeout(()=>process.exit(0),10000);`);
      const size = fs.statSync(faultBeat).size; await sleep(150);
      t.ok(!fault.error && fs.statSync(faultBeat).size === size && fault.frames.at(-1)?.event === 'guardian-cleanup' && fault.frames.at(-1).value === 0, signal + ' primary fault is recovered by guardian and stops target writes');
      t.ok(!confirmed(fault.frames), signal + ' missing primary report cannot claim full protocol confirmation');
    }
    const zero = run(0, 'setTimeout(()=>process.exit(0),100)');
    t.ok(zero.status === 0 && confirmed(zero.frames) && !zero.frames.some(f => f.event === 'deadline'), 'zero native deadline preserves unbounded mode');
    for (const value of ['-1', '1x', '2147483648', '']) {
      const marker = path.join(root, 'must-not-start');
      const invalid = run(value, `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`);
      t.ok(invalid.status === 2 && !fs.existsSync(marker), 'invalid deadline rejects before target execution: ' + JSON.stringify(value));
    }
    const missing = cp.spawnSync(helper, ['--supervise-v2-deadline', '1000', path.join(root, 'missing')], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 3000 });
    const frames = String(missing.output[3]).trim().split('\n').map(line => JSON.parse(line));
    t.ok(missing.status === 127 && frames.some(f => f.event === 'error' && f.value === 2) && confirmed(frames), 'failed target exec still confirms cleanup and reports errno');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); t.done(); }
})();
