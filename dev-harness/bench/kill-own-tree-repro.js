'use strict';
// Bounded, owned-process-only Windows diagnostic. Does not enumerate then kill strangers.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { killOwnTree, parseProcessTable, snapshotProcessTable } = require(path.join(__dirname, '..', 'lib', 'kill-own-tree'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalSpawnSync = cp.spawnSync;
const count = Number(process.argv[2] || 8);
assert(process.platform === 'win32');
assert(Number.isInteger(count) && count > 0 && count <= 40);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kill-tree-repro-'));
const reportPath = path.join(directory, 'report.json');
const report = { startedAt: new Date().toISOString(), node: process.version,
  helperSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'lib', 'kill-own-tree.js'))).digest('hex'),
  churn: { enabled: process.argv.includes('--churn'), completed: 0 }, iterations: [], reportPath };
let stopChurn = false;
async function churn() {
  while (!stopChurn) {
    await new Promise(resolve => {
      const child = cp.spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
      child.once('error', resolve);
      child.once('close', resolve);
    });
    report.churn.completed++;
  }
}
function nativeState(identities) {
  const items = identities.map(row => `${row.pid}:${row.created}`).join(',');
  const script = `$ErrorActionPreference='Stop'; foreach($it in '${items}'.Split(',')) { `
    + `$id0,$ft=$it.Split(':'); try { $p=Get-Process -Id ([int]$id0); `
    + `@{pid=[int]$id0;created=$p.StartTime.ToFileTimeUtc().ToString();hasExited=$p.HasExited;waitExit=$p.WaitForExit(0)} | ConvertTo-Json -Compress `
    + `} catch { @{pid=[int]$id0;error=$_.Exception.GetType().Name} | ConvertTo-Json -Compress } }`;
  const result = originalSpawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return { status: result.status, output: result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)), stderr: result.stderr };
}
function cleanupIdentities(identities) {
  // Get-Process is lazy: explicitly pin its native handle before checking StartTime.
  // CIM precision can be lower, so retain the helper's existing <1ms comparison.
  if (!identities.length) return;
  const items = identities.map(row => `${row.pid}:${row.created}`).join(',');
  const script = `foreach($it in '${items}'.Split(',')) { $p=$null; try { `
    + `$id0,$ft=$it.Split(':'); $p=Get-Process -Id ([int]$id0) -ErrorAction Stop; $null=$p.Handle; `
    + `if([math]::Abs($p.StartTime.ToFileTimeUtc()-[int64]$ft)-lt 10000){$p.Kill();$p.WaitForExit(3000)|Out-Null} `
    + `} catch {} finally {if($p){$p.Dispose()}} }`;
  originalSpawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
}
async function run() {
  const churnWorkers = report.churn.enabled ? Array.from({ length: 4 }, churn) : [];
  try {
    for (let index = 0; index < count; index++) {
    const iteration = { index, calls: [] };
    let identities = [];
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);";
    const root = cp.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    try {
      const grandPid = await new Promise((resolve, reject) => {
        let buffer = '';
        const finish = (error, pid) => {
          clearTimeout(timer);
          root.stdout.off('data', onData);
          root.off('error', onError);
          root.off('exit', onExit);
          if (error) reject(error); else resolve(pid);
        };
        const onData = data => { buffer += data; const match = /^([1-9]\d*)\r?\n/.exec(buffer); if (match) finish(null, Number(match[1])); };
        const onError = error => finish(error);
        const onExit = () => finish(new Error('root exited before pid report'));
        const timer = setTimeout(() => finish(new Error('pid timeout')), 10000);
        root.stdout.on('data', onData);
        root.once('error', onError);
        root.once('exit', onExit);
      });
      const before = snapshotProcessTable();
      identities = before.filter(row => row.pid === root.pid || row.pid === grandPid);
      assert.equal(identities.length, 2);
      iteration.before = identities;
      if (!report.churn.enabled) iteration.nativeBefore = nativeState(identities);
      cp.spawnSync = function(command, args, options) {
        const start = performance.now();
        const result = originalSpawnSync(command, args, options);
        const snapshot = args?.at(-1)?.includes('Get-CimInstance Win32_Process');
        iteration.calls.push({ kind: snapshot ? 'snapshot' : command === 'taskkill' ? 'root-kill' : 'verified-kill', durationMs: performance.now() - start, status: result.status, signal: result.signal, error: result.error?.message, stdout: snapshot ? parseProcessTable(result.stdout).filter(row => row.pid === root.pid || row.pid === grandPid) : result.stdout, stderr: result.stderr });
        return result;
      };
      iteration.result = killOwnTree(root);
      cp.spawnSync = originalSpawnSync;
      await sleep(300);
      const after = snapshotProcessTable();
      iteration.after = after.filter(row => identities.some(owned => owned.pid === row.pid));
      iteration.nativeAfter = nativeState(identities);
      iteration.pidAlive = iteration.after.some(row => row.pid === grandPid);
      iteration.sameProcessAlive = iteration.after.some(row => row.pid === grandPid && row.created === identities.find(owned => owned.pid === grandPid).created);
      iteration.exitCode = root.exitCode;
      iteration.signalCode = root.signalCode;
    } catch (error) {
      iteration.error = error.stack;
    } finally {
      cp.spawnSync = originalSpawnSync;
      try {
        if (root.exitCode === null && root.signalCode === null) killOwnTree(root);
        cleanupIdentities(identities);
        const afterCleanup = snapshotProcessTable();
        assert(Array.isArray(afterCleanup), 'cleanup process snapshot failed');
        iteration.cleanupVerified = identities.length === 2 && !afterCleanup.some(row => identities.some(owned => owned.pid === row.pid && owned.created === row.created));
        assert(iteration.cleanupVerified, 'owned fixture identities remain or were not captured');
      } catch (error) {
        iteration.cleanupVerified = false;
        iteration.cleanupError = error.stack;
        process.exitCode = 1;
      }
      if (iteration.error || iteration.sameProcessAlive) process.exitCode = 1;
      report.iterations.push(iteration);
      fs.writeFileSync(reportPath, JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
      console.log(JSON.stringify({ index, pidAlive: iteration.pidAlive, sameProcessAlive: iteration.sameProcessAlive, error: iteration.error, killed: iteration.result?.killed }));
    }
    }
  } finally {
    stopChurn = true;
    await Promise.all(churnWorkers);
    fs.writeFileSync(reportPath, JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  }
  console.log(reportPath);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
