'use strict';
// Real source functions and the shared close tracker; all children are inert.
// No server import, subprocess, PowerShell, native API, socket or user data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionBlock, sliceBlock, bracedBlock } = require('../lib/source-slice.js');

const sourceDir = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const runtimeSource = fs.readFileSync(path.join(sourceDir, '04-permission-runtime.js'), 'utf8');
const maintenanceSource = fs.readFileSync(path.join(sourceDir, '13ag-work-data-maintenance.js'), 'utf8');
const lifetimeSource = fs.readFileSync(path.join(sourceDir, '13ax-desktop-lifetime.js'), 'utf8');
const killSource = functionBlock(runtimeSource, 'killChildTree');
const environmentSource = bracedBlock(lifetimeSource, 'environment(env, grant)');
assert.ok(killSource.length > 300 && environmentSource.length > 100, 'real source functions were extracted');
const environment = vm.runInNewContext('({' + environmentSource + '}).environment');
const tick = () => new Promise(resolve => setImmediate(resolve));

function inertChild(pid) {
  const child = new EventEmitter();
  Object.assign(child, { pid, exitCode: null, signalCode: null, unrefs: 0 });
  child.unref = () => { child.unrefs++; };
  return child;
}

function closeOwner(source = maintenanceSource) {
  const hooks = {}, events = [];
  const context = {
    WorkDataMaintenanceHooks: hooks,
    workDataMaintenance: { status: () => ({ phase: 'waiting' }) },
    DesktopLifetimeHooks: { canAdmit: () => false, normalCloseRequested: () => true },
    PrivacyLocalDriveProbe: { stopSync: () => events.push('drive') },
    ToolboxHooks: { stopAll: async () => events.push('toolbox') },
    stopKimiModelProbes: () => events.push('probes'),
    stopKimiServer: async () => events.push('kimi'),
    killAllMcpClients: () => events.push('mcp'),
    killAllShellSessions: () => events.push('shell'),
  };
  const ownerSource = sliceBlock(source, '// Completion obligations belong', 'WorkDataMaintenanceHooks.deferStewardWake');
  assert.ok(ownerSource.length > 1500, 'the actual shared tracker and close owner were extracted');
  vm.runInNewContext(ownerSource, context);
  const root = inertChild(100);
  hooks.trackChild(root);
  const ticket = hooks.prepareInfrastructure({ normalClose: true });
  const observed = { done: false, error: null };
  const pending = hooks.closeInfrastructure(ticket).then(
    () => { observed.done = true; },
    error => { observed.error = error; throw error; },
  );
  void pending.catch(() => {});
  return { hooks, events, root, ticket, pending, observed };
}

function killFixture({ owner, desktop = true, platform = 'win32', args = ['-NoProfile', '-EncodedCommand', 'QUJD'], spawnError } = {}) {
  const calls = [], children = [], killedRoots = [], posixRoots = [], commandRoots = [];
  const context = {
    desktopLifetimeBootstrap: desktop ? 'synthetic-consumed-bootstrap' : null,
    process: {
      platform,
      env: { SAFE: 'kept', rUyI_dEsKtOp_CoNtRoL_V1: 'synthetic-reinjection', NODE_OPTIONS: 'unwanted' },
      kill: (...values) => killedRoots.push(values),
    },
    WorkDataMaintenanceHooks: owner?.hooks || {},
    DesktopLifetimeHooks: { environment },
    ownTreeKillCommand(pid) { commandRoots.push(pid); return args; },
    killPosixChildTree: pid => posixRoots.push(pid),
    cp: {
      spawn(...values) {
        calls.push(values);
        if (spawnError) throw spawnError;
        const child = inertChild(200 + children.length);
        children.push(child);
        return child;
      },
    },
  };
  const kill = vm.runInNewContext(killSource + '\nkillChildTree', context);
  return { kill, calls, children, killedRoots, posixRoots, commandRoots, args };
}

const plain = value => JSON.parse(JSON.stringify(value));
function closeInert(owner, fixture) {
  owner?.root.emit('close', 0);
  for (const child of fixture?.children || []) child.emit('close', 0);
}

test('no-grant helper environment removes private control and Node diagnostics without adding authority', () => {
  const input = {
    SAFE: 'kept', rUyI_dEsKtOp_CoNtRoL_V1: 'synthetic', RUYI_DESKTOP_CONTROL_OTHER: 'synthetic',
    NODE_OPTIONS: 'unwanted', node_path: 'unwanted', nOdE_dEbUg: '*', NODE_DEBUG_NATIVE: '*',
  };
  assert.deepEqual(plain(environment(input, null)), { SAFE: 'kept' });
  assert.equal(input.rUyI_dEsKtOp_CoNtRoL_V1, 'synthetic', 'the caller env is not mutated');
});

test('ordinary Windows short/long fire-and-forget and POSIX cleanup keep their legacy behavior', () => {
  const short = killFixture({ desktop: false });
  short.kill(123);
  assert.equal(short.calls[0][0], 'cmd.exe');
  assert.deepEqual(plain(short.calls[0][1]), ['/d', '/s', '/c', '"start "" /b powershell.exe -NoProfile -EncodedCommand QUJD"']);
  assert.deepEqual(plain(short.calls[0][2]), { windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true });
  assert.equal(short.children[0].unrefs, 1);
  const long = killFixture({ desktop: false, args: ['-EncodedCommand', 'A'.repeat(8000)] });
  long.kill(123);
  assert.equal(long.calls[0][0], 'powershell.exe');
  assert.equal(long.calls[0][1], long.args);
  assert.deepEqual(plain(long.calls[0][2]), { windowsHide: true, stdio: 'ignore' });
  assert.equal(long.children[0].unrefs, 1);
  const posix = killFixture({ platform: 'linux' });
  posix.kill(123); posix.kill(0);
  assert.deepEqual(posix.posixRoots, [123]);
  assert.equal(posix.calls.length, 0);
});

test('closing Desktop cleanup tracks the direct original PowerShell, rejects fresh admission and waits for close rather than exit', async t => {
  const owner = closeOwner(), fixture = killFixture({ owner });
  t.after(() => closeInert(owner, fixture));
  await tick();
  assert.deepEqual(owner.events, ['drive', 'toolbox', 'probes', 'kimi', 'mcp', 'shell']);
  assert.throws(() => owner.hooks.admitHelper(), { code: 'work_data.maintenance_busy' });
  fixture.kill(100);
  const helper = fixture.children[0];
  assert.equal(fixture.calls[0][0], 'powershell.exe');
  assert.equal(fixture.calls[0][1], fixture.args, 'use the unchanged owned-tree command');
  assert.deepEqual(fixture.commandRoots, [100]);
  assert.deepEqual(plain(fixture.calls[0][2]), { windowsHide: true, stdio: 'ignore', env: { SAFE: 'kept' } });
  assert.equal(helper.unrefs, 0);
  let helperClosed = false;
  const tracked = owner.hooks.awaitChild(helper).then(() => { helperClosed = true; });
  helper.emit('exit', 0);
  await tick();
  assert.equal(helperClosed, false, 'the actual original child must remain registered until close');
  owner.root.emit('close', 0);
  await tick();
  assert.equal(owner.observed.done, false, 'the same close owner still owns the late helper');
  assert.throws(() => owner.hooks.admitHelper(), { code: 'work_data.maintenance_busy' });
  helper.emit('close', 0);
  await Promise.all([tracked, owner.pending]);
  assert.equal(helperClosed, true);
  assert.equal(owner.observed.done, true);
});

test('a helper registered while the existing target snapshot is pending is drained by the same owner', async t => {
  const owner = closeOwner(), helper = inertChild(201);
  t.after(() => { owner.root.emit('close', 0); helper.emit('close', 0); });
  await tick();
  owner.hooks.trackChild(helper);
  owner.root.emit('close', 0);
  await tick();
  assert.equal(owner.observed.done, false);
  helper.emit('exit', 0);
  await tick();
  assert.equal(owner.observed.done, false);
  helper.emit('close', 0);
  await owner.pending;
  assert.equal(owner.observed.done, true);
});

test('bounded old-source inverse demonstrates why one child snapshot cannot close the late-helper obligation', async () => {
  // Finite negative control: reverse only the new drain loop, keeping the real
  // tracker, admission/failure handling and every other close-owner byte.
  const loop = 'while(workDataChildClosures.size)await Promise.all([...workDataChildClosures.values()].map(row=>row.done));';
  const snapshot = 'await Promise.all([...workDataChildClosures.values()].map(row=>row.done));';
  assert.equal(maintenanceSource.split(loop).length, 2, 'the one bounded inverse site exists');
  const owner = closeOwner(maintenanceSource.replace(loop, snapshot)), helper = inertChild(201);
  await tick();
  owner.hooks.trackChild(helper);
  let helperClosed = false;
  const tracked = owner.hooks.awaitChild(helper).then(() => { helperClosed = true; });
  owner.root.emit('close', 0);
  await owner.pending;
  assert.equal(owner.observed.done, true, 'the old one-snapshot owner already returned');
  assert.equal(helperClosed, false, 'its late tracked helper is still live');
  helper.emit('close', 0);
  await tracked;
});

test('known-PID cleanup error rejects closing and remains uncertain after late close', async t => {
  const owner = closeOwner(), fixture = killFixture({ owner });
  t.after(() => closeInert(owner, fixture));
  await tick();
  fixture.kill(100);
  const helper = fixture.children[0], error = Error('synthetic known-PID helper failure');
  owner.root.emit('close', 0);
  helper.emit('error', error);
  await assert.rejects(owner.pending, value => value === error);
  assert.equal(owner.hooks.helperMayStillRun(), true);
  assert.deepEqual(fixture.killedRoots, [[100, 'SIGKILL']]);
  helper.emit('close', 0);
  assert.equal(owner.hooks.helperMayStillRun(), true, 'late close cannot erase unknown failure');
  assert.throws(() => owner.hooks.resumeInfrastructure(owner.ticket), /infrastructure_uncertain/);
  assert.throws(() => owner.hooks.admitHelper(), { code: 'work_data.maintenance_busy' });
});

test('a proven no-PID helper error settles only that nonexistent helper and preserves the existing target obligation', async t => {
  const owner = closeOwner(), fixture = killFixture({ owner });
  t.after(() => closeInert(owner, fixture));
  await tick();
  fixture.kill(100);
  const helper = fixture.children[0];
  delete helper.pid;
  helper.emit('error', Error('synthetic no launch'));
  await owner.hooks.awaitChild(helper);
  assert.equal(owner.hooks.helperMayStillRun(), false);
  assert.equal(owner.observed.done, false, 'the original target has not closed');
  assert.deepEqual(fixture.killedRoots, [[100, 'SIGKILL']]);
  owner.root.emit('close', 0);
  await owner.pending;
});

test('missing close owner or synchronous Desktop spawn failure never starts untracked cmd fallback', () => {
  const missing = killFixture();
  assert.throws(() => missing.kill(100), /helper_unavailable/);
  assert.equal(missing.calls.length, 0);
  const fixture = killFixture({ owner: { hooks: { trackChild() {} } }, spawnError: Error('synthetic spawn throw') });
  assert.throws(() => fixture.kill(100), /synthetic spawn throw/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0][0], 'powershell.exe');
});
