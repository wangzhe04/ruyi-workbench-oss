'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/03b-privacy-local-drive.js'), 'utf8');
function fixture(options = {}) {
  const children = [], killed = [], timers = [], exitHooks = [];
  const spawn = (executable, args, settings) => {
    const child = new EventEmitter(); child.pid = 9000 + children.length;
    child.exitCode = null; child.signalCode = null;
    child.kill = () => { killed.push(child.pid); if (options.killThrows) throw Error('fixture kill failure'); child.signalCode = 'SIGTERM'; };
    child.ref = () => { child.referenced = true; }; child.unref = () => { child.referenced = false; };
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.write = line => {
      child.writes.push(line);
      if (options.reply) queueMicrotask(() => child.stdout.emit('data', options.reply(line, children.length)));
    };
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy = () => { stream.destroyed = true; if (options.destroyThrows) throw Error('fixture destroy failure'); };
    Object.assign(child, { executable, args, settings, writes: [] }); children.push(child); return child;
  };
  const context = vm.createContext({ require: name => { if (name === 'node:child_process') return { spawn }; if (name === 'node:path') return path; throw Error('Unexpected probe builtin: ' + name); }, process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, once: (event, handler) => { assert.equal(event, 'exit'); exitHooks.push(handler); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, options.shortTimeout && ms === 5000 ? 20 : ms); timers.push({ fn, ms, timer }); return timer; }, clearTimeout });
  const api = vm.runInContext(source + '\nPrivacyLocalDriveProbe', context);
  return { api, children, killed, timers, exitHooks };
}
test('lazy owner: validates all roots before spawn, empty work stays idle, canonical query deduplicates letters', async () => {
  const f = fixture({ reply: line => line.trim().split(',').map(letter => letter + ':Fixed').join('|') + '\r\n' });
  assert.equal(f.children.length, 0);
  for (const roots of [['C:\\secret'], ['\\\\host\\share'], ['C:\\\r\nX'], ['C:/'], Array(27).fill('C:\\'), [null]]) await assert.rejects(f.api.query(roots), /drive_probe_roots/);
  assert.equal((await f.api.query([])).size, 0); assert.equal(f.children.length, 0);
  const result = await f.api.query(['c:\\', 'C:\\', 'D:\\']);
  assert.equal(JSON.stringify([...result]), JSON.stringify([['c:\\', 'Fixed'], ['C:\\', 'Fixed'], ['D:\\', 'Fixed']]));
  assert.equal(f.children[0].writes[0], 'C,D\n');
  assert.equal(f.children[0].executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(f.children[0].settings.windowsHide, true);
  assert.ok(f.children[0].args.includes('-NoProfile')); assert.ok(f.children[0].args.includes('-NonInteractive'));
  f.api.stopSync(); assert.deepEqual(f.killed, [9000]);
});
test('same child serves serialized fresh queries without a permanent DriveType cache; idle and stop clean owned child', async () => {
  let count = 0;
  const f = fixture({ reply: () => 'C:' + (++count === 1 ? 'Fixed' : 'Network') + '\n' });
  const one = f.api.query(['C:\\']), two = f.api.query(['C:\\']);
  assert.equal((await one).get('C:\\'), 'Fixed'); assert.equal((await two).get('C:\\'), 'Network');
  assert.equal(f.children.length, 1); assert.equal(f.children[0].writes.length, 2);
  assert.equal(f.children[0].referenced, false); assert.equal(f.exitHooks.length, 1);
  const idle = f.timers.filter(row => row.ms === 15000).at(-1); idle.fn();
  assert.deepEqual(f.killed, [9000]); f.api.stopSync(); assert.deepEqual(f.killed, [9000]);
});
test('protocol failures, exit, cancellation, timeout and stop reject pending work and retire only the owned child', async () => {
  for (const mode of ['bad', 'extra', 'exit', 'cancel', 'timeout', 'stop', 'stderr']) {
    const f = fixture({ shortTimeout: true });
    const controller = new AbortController();
    const pending = f.api.query(['C:\\'], controller.signal);
    const checked = assert.rejects(pending, /privacy.drive_probe_/);
    if (mode === 'bad') f.children[0].stdout.emit('data', 'C:SomeInventedType\n');
    if (mode === 'extra') f.children[0].stdout.emit('data', 'C:Fixed\nC:Fixed\n');
    if (mode === 'exit') { f.children[0].exitCode = 1; f.children[0].emit('exit', 1); }
    if (mode === 'cancel') controller.abort();
    if (mode === 'stop') f.api.stopSync();
    if (mode === 'stderr') f.children[0].stderr.emit('data', 'private error');
    await checked; assert.deepEqual(f.killed, mode === 'exit' ? [] : [9000], mode);
    assert.equal(f.children[0].stdout.destroyed, true); f.api.stopSync();
  }
});
test('stream/cleanup errors fail closed; retired child late events cannot terminate a new owner', async () => {
  const f = fixture({ killThrows: true, destroyThrows: true });
  const first = assert.rejects(f.api.query(['C:\\']), /drive_probe_read/);
  assert.doesNotThrow(() => f.children[0].stdout.emit('error', Error('fixture read failure'))); await first;
  const second = assert.rejects(f.api.query(['D:\\']), /drive_probe_stopped/);
  assert.equal(f.children.length, 2);
  assert.equal(f.children[1].referenced, true); assert.equal(f.exitHooks.length, 1);
  assert.doesNotThrow(() => { f.children[0].emit('exit', 1); f.children[0].stderr.emit('error', Error('late')); f.children[0].stdout.emit('data', 'C:Fixed\n'); });
  assert.deepEqual(f.killed, [9000]); assert.doesNotThrow(() => f.api.stopSync()); await second;
  assert.deepEqual(f.killed, [9000, 9001]);
});
test('an independent Node process exits after an idle real query without waiting for the 15s idle timer', { skip: process.platform !== 'win32' }, async t => {
  const cp = require('node:child_process');
  const { killOwnTree } = require('../lib/kill-own-tree');
  const input = `const cp=require('node:child_process'),path=require('node:path');\n${source}\nPrivacyLocalDriveProbe.query([path.win32.parse(process.env.SystemRoot).root]).then(result=>console.log('fixed='+[...result.values()][0])).catch(e=>{console.error(e.code);process.exitCode=1});`;
  const started = performance.now();
  const child = cp.spawn(process.execPath, ['-e', input], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) killOwnTree(child); });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { killOwnTree(child); reject(Error('independent query process did not exit')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 0, stderr); assert.match(stdout, /fixed=Fixed/);
  t.diagnostic('Independent query/exit=' + (performance.now() - started).toFixed(1) + 'ms');
});
test('queue is bounded and a cancelled queued job fails the shared child closed', async () => {
  const f = fixture(); const controller = new AbortController();
  const work = Array.from({ length: 8 }, (_, i) => f.api.query(['C:\\'], i === 7 ? controller.signal : undefined));
  const checks = work.map(promise => assert.rejects(promise, /cancelled/));
  await assert.rejects(f.api.query(['C:\\']), /busy/); controller.abort(); await Promise.all(checks);
  assert.deepEqual(f.killed, [9000]);
});
test('real fixed Windows PowerShell reads DriveType only and reuses its child; report cold/hot cost', { skip: process.platform !== 'win32' }, async t => {
  const cp = require('node:child_process');
  const { killOwnTree } = require('../lib/kill-own-tree');
  const children = [];
  const api = vm.runInNewContext(source + '\nPrivacyLocalDriveProbe', { require: name => name === 'node:child_process' ? { spawn: (...args) => { const child = cp.spawn(...args); children.push(child); return child; } } : require(name), process, setTimeout, clearTimeout });
  t.after(() => { api.stopSync(); for (const child of children) if (child.exitCode === null && child.signalCode === null) killOwnTree(child); });
  const root = path.win32.parse(process.env.SystemRoot).root;
  const started = performance.now(); const first = await api.query([root]); const cold = performance.now() - started;
  const warm = performance.now(); const second = await api.query([root]); const hot = performance.now() - warm;
  assert.equal(first.get(root), 'Fixed'); assert.equal(second.get(root), 'Fixed'); assert.equal(children.length, 1);
  t.diagnostic('DriveType cold=' + cold.toFixed(1) + 'ms hot=' + hot.toFixed(1) + 'ms');
  assert.ok(!/\.IsReady|\.VolumeLabel|Get-ChildItem|Get-Content/.test(source));
});
