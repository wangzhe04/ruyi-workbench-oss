'use strict';
require('./lib/self-isolate-home.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS PROCESS CLEANUP');
const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-process-'));
process.env.RUYI_HOME = path.join(root, 'data');
const helper = path.resolve(__dirname, '../ruyi-workbench/runtime/macos/ruyi-process-helper');
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  do { const value = check(); if (value) return value; await sleep(25); } while (Date.now() < deadline);
  throw new Error('condition timed out');
}
function start(script, stdin = 'ignore') {
  const child = cp.spawn(process.execPath, ['-e', script], {
    env: { ...process.env }, stdio: [stdin, 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', data => { child.output = (child.output + data).slice(-16000); });
  child.stderr.on('data', data => { child.output = (child.output + data).slice(-16000); });
  children.push(child);
  return child;
}

(async () => {
  try {
    if (process.platform !== 'darwin') {
      console.log('SKIP macOS libproc cleanup requires macOS');
      return;
    }
    if (!fs.existsSync(helper)) throw new Error('Build helper first: node ruyi-workbench/tools/build-macos-process-helper.js');
    const nativeTest = path.join(root, 'native-process-test');
    const compilation = cp.spawnSync('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
      path.join(__dirname, 'native/macos-process-helper.test.c'), '-o', nativeTest],
    { env: { ...process.env }, encoding: 'utf8', timeout: 60000 });
    if (compilation.error || compilation.status !== 0) throw new Error(compilation.stderr || String(compilation.error));
    const primitives = cp.spawnSync(nativeTest, [], { env: { ...process.env }, encoding: 'utf8', timeout: 5000 });
    ok(!primitives.error && primitives.status === 0 && primitives.stdout.includes('changed creation identity'),
      'native identity checks and interrupted-cleanup state restoration pass');
    const table = snapshotProcessTable();
    const self = table && table.find(row => row.pid === process.pid);
    ok(self && typeof self.created === 'bigint' && self.created > 0n, 'libproc exposes exact microsecond process identities');
    const refusal = cp.spawnSync(helper, ['--terminate-child-tree', String(process.pid)], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env },
    });
    ok(refusal.status === 3 && refusal.stdout.includes('REFUSED'), 'helper refuses the calling process instead of treating an arbitrary PID as ownership');
    const S = loadServerInternals(['guardFileToolPath', 'killChildTree', 'DesktopShell', 'McpStdioClient', 'killPosixChildTree']);
    const handleOnly = start('console.log("ready");setTimeout(()=>process.exit(0),8000)');
    await until(() => handleOnly.output.includes('ready'));
    for (const input of [handleOnly.pid, String(handleOnly.pid), { pid: handleOnly.pid }]) {
      const refused = S.killChildTree(input);
      ok(refused.incomplete && refused.skipped === 'process-handle-required' && refused.killed.length === 0,
        'PID-shaped input cannot authorize Mac process termination');
    }
    const mismatched = S.killPosixChildTree(process.pid, handleOnly);
    ok(mismatched.skipped === 'process-handle-required' && snapshotProcessTable().some(row => row.pid === handleOnly.pid),
      'mismatched PID/handle pair is refused and the original owned process remains alive');
    const accepted = S.killChildTree(handleOnly);
    ok(!accepted.incomplete && accepted.killed.includes(handleOnly.pid), 'original ChildProcess handle still authorizes verified legacy cleanup');
    const originalSpawnSync = cp.spawnSync;
    try {
      for (const report of [
        'EXIT-COUNTS 0 0 0',
        'EXIT-COUNTS 0 0 0\nOBSERVED-TREE 0 0',
        'EXIT-COUNTS 0 0 0\nOBSERVED-TREE 1 0',
        'EXIT-COUNTS 9007199254740993 0 0\nOBSERVED-TREE 9007199254740993 0',
        'KILLED 123\nEXIT-COUNTS 0 1 0\nOBSERVED-TREE 1 1',
      ]) {
        const target = start('console.log("ready");setTimeout(()=>process.exit(0),8000)');
        await until(() => target.output.includes('ready'));
        let calls = 0;
        cp.spawnSync = () => { calls++; return { status: 0, stdout: 'RUYI-PROCESS-V1\n' + report + '\n' }; };
        const result = S.killChildTree(target);
        ok(calls === 1 && result.incomplete === true, 'inconsistent helper exit counts cannot claim complete cleanup');
        await until(() => target.exitCode !== null || target.signalCode !== null);
      }
    } finally { cp.spawnSync = originalSpawnSync; }
    const guard = await S.guardFileToolPath(helper, { effectivePermissionMode: 'bypass', config: {
      permissionMode: 'bypass', allowOutsideWorkspace: true, defaultWorkspace: path.dirname(helper),
    } }, { tool: 'file_write', write: true });
    ok(!guard.ok && guard.code === 'autoexec-denied', 'native helper runtime is protected from model file writes');
    const symlink = path.join(root, 'helper-symlink'); fs.symlinkSync(helper, symlink);
    const hardlink = path.join(root, 'helper-hardlink'); fs.linkSync(helper, hardlink);
    try {
      for (const candidate of ['/System/Volumes/Data' + helper, symlink, hardlink]) {
        const result = await S.guardFileToolPath(candidate, { effectivePermissionMode: 'bypass', config: {
          permissionMode: 'bypass', allowOutsideWorkspace: true, defaultWorkspace: root,
        } }, { tool: 'file_write', write: true });
        ok(!result.ok && result.code === 'autoexec-denied', 'helper alias is write-protected: ' + path.basename(candidate));
      }
    } finally { fs.unlinkSync(hardlink); fs.unlinkSync(symlink); }
    const ordinary = path.join(root, 'ruyi-process-helper'); fs.writeFileSync(ordinary, 'ordinary fixture');
    const ordinaryGuard = await S.guardFileToolPath(ordinary, { effectivePermissionMode: 'bypass', config: {
      permissionMode: 'bypass', allowOutsideWorkspace: true, defaultWorkspace: root,
    } }, { tool: 'file_write', write: true });
    ok(ordinaryGuard.ok, 'same-named ordinary workspace file remains writable');
    const fakePackage = path.join(root, 'fake-package');
    const externalRuntime = path.join(root, 'external-runtime');
    const externalExecutable = path.join(root, 'external-executable');
    fs.mkdirSync(path.join(fakePackage, 'runtime'), { recursive: true });
    fs.mkdirSync(externalRuntime);
    const fakeHelper = path.join(externalRuntime, 'ruyi-process-helper'); fs.writeFileSync(fakeHelper, 'fixture');
    const logicalRuntime = path.join(fakePackage, 'runtime', 'macos'); fs.symlinkSync(externalRuntime, logicalRuntime);
    const relocated = loadServerInternals(['guardFileToolPath'], { withEval: true });
    relocated.__eval('externalRoot = () => ' + JSON.stringify(fakePackage));
    const relocatedContext = { effectivePermissionMode: 'bypass', config: {
      permissionMode: 'bypass', allowOutsideWorkspace: true, defaultWorkspace: root,
    } };
    const relocatedGuard = await relocated.guardFileToolPath(fakeHelper, relocatedContext, { tool: 'file_write', write: true });
    ok(!relocatedGuard.ok && relocatedGuard.code === 'autoexec-denied', 'symlinked runtime directory protects its actual target');
    fs.unlinkSync(logicalRuntime); fs.mkdirSync(logicalRuntime);
    fs.writeFileSync(externalExecutable, 'fixture executable');
    fs.symlinkSync(externalExecutable, path.join(logicalRuntime, 'ruyi-process-helper'));
    const executableGuard = await relocated.guardFileToolPath(externalExecutable, relocatedContext, { tool: 'file_write', write: true });
    ok(!executableGuard.ok && executableGuard.code === 'autoexec-denied', 'symlinked helper protects its single-link external target');

    const originalSync = cp.spawnSync;
    const missingBeat = path.join(root, 'missing-helper-heartbeat');
    // Legacy raw children may already be running when the helper becomes unavailable.
    const interruptedChild = start(`const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(missingBeat)},'x'),15)`);
    try {
      await until(() => fs.existsSync(missingBeat) && fs.statSync(missingBeat).size >= 2);
      cp.spawnSync = function(command, ...args) {
        if (command === helper) return { error: Object.assign(new Error('fixture missing helper'), { code: 'ENOENT' }), status: null, stdout: '' };
        return originalSync.call(this, command, ...args);
      };
      const result = S.killChildTree(interruptedChild);
      await until(() => interruptedChild.exitCode !== null || interruptedChild.signalCode !== null);
      ok(result.incomplete && result.scope === 'direct-child' && result.killed.includes(interruptedChild.pid),
        'missing helper stops the already-owned direct child and reports incomplete descendant cleanup');
      const stoppedAt = fs.statSync(missingBeat).size;
      await sleep(120);
      ok(fs.statSync(missingBeat).size === stoppedAt, 'missing-helper cancellation stops further root writes');
    } finally { cp.spawnSync = originalSync; }

    const innocent = start('console.log(process.pid); setTimeout(()=>process.exit(0),60000); setInterval(()=>{},1000)');
    await until(() => innocent.output.trim());
    for (const mode of ['harness', 'product', 'mcp']) {
      const beat = path.join(root, mode + '-heartbeat');
      const grandScript = `const fs=require('fs');setTimeout(()=>process.exit(0),60000);setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'x'),15);`;
      const middleScript = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandScript)}],{stdio:'ignore',detached:true});console.log(JSON.stringify({middle:process.pid,grandchild:child.pid}));setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000);`;
      const parentScript = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(middleScript)}],{stdio:['ignore','pipe','inherit']});child.stdout.pipe(process.stdout);setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000);`;
      const parent = start(parentScript + (mode === 'mcp' ? "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));" : ''), mode === 'mcp' ? 'pipe' : 'ignore');
      const ids = await until(() => { try { return JSON.parse(parent.output.trim()); } catch { return null; } });
      await until(() => fs.existsSync(beat) && fs.statSync(beat).size >= 2);
      let result;
      if (mode === 'mcp') {
        const client = new S.McpStdioClient({ id: 'cleanup-fixture', command: process.execPath });
        client.child = parent; client.pid = parent.pid;
        result = client.kill();
      } else result = mode === 'product' ? S.killChildTree(parent) : killOwnTree(parent);
      ok([parent.pid, ids.middle, ids.grandchild].every(pid => result.killed.includes(pid)),
        mode + ' cleanup includes parent, child and detached grandchild');
      ok(result.terminated === 3 && result.alreadyExited === 0 && result.unconfirmed === 0 && !result.incomplete,
        mode + ' cleanup confirms all three observed identities have exited');
      await until(() => {
        const current = snapshotProcessTable();
        return current && !current.some(row => [parent.pid, ids.middle, ids.grandchild].includes(row.pid));
      });
      const stoppedAt = fs.statSync(beat).size;
      await sleep(150);
      ok(fs.statSync(beat).size === stoppedAt, mode + ' descendants stop writing after cleanup');
      ok(snapshotProcessTable().some(row => row.pid === innocent.pid), 'unrelated sibling remains alive');
      ok(result.scope === 'observed-tree', 'cleanup scope remains explicit until supervised lifetime registration is integrated');
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const child of children) killOwnTree(child);
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
