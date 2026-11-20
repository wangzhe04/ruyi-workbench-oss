'use strict';
// 150 号文 §4 P15/P16 (3.1 phase 4, 4B review v2): a settings save waits (bounded, cancellable) for running turns and
// reports how many are still running; the DPAPI helper reports a blocked host (.NET could not load, policy) as
// helper_blocked, never as a DPAPI decrypt failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { EventEmitter } = require('node:events');
const { functionBlock, constBlock } = require('../lib/source-slice');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');

function whenIdle() {
  const state = { busy: true, turnSettlers: new Set() };
  const context = { turnSettlers: state.turnSettlers, PrivacyCore: { configHooks: { isBusy: () => state.busy } }, setTimeout, Date };
  return { state, privacyWhenIdle: vm.runInNewContext(functionBlock(read('13ab-privacy-api.js'), 'privacyWhenIdle') + '\nprivacyWhenIdle', context) };
}

test('privacyWhenIdle waits for idle, reports the running turns after the deadline and stops when the client leaves', async () => {
  const { state, privacyWhenIdle } = whenIdle();
  state.turnSettlers.add('a'); state.turnSettlers.add('b');
  let started = Date.now();
  await assert.rejects(privacyWhenIdle(async () => 'saved', { waitMs: 300 }), error => error.code === 'privacy.turns_running' && error.turns === 2);
  assert.ok(Date.now() - started >= 280, 'it waited for the deadline');
  started = Date.now(); setTimeout(() => { state.busy = false; }, 200);
  assert.equal(await privacyWhenIdle(async () => 'saved', { waitMs: 3000 }), 'saved');
  assert.ok(Date.now() - started >= 180 && Date.now() - started < 2500, 'it ran as soon as the turns ended');
  state.busy = true; const controller = new AbortController(); setTimeout(() => controller.abort(), 150); started = Date.now();
  await assert.rejects(privacyWhenIdle(async () => 'saved', { waitMs: 5000, signal: controller.signal }), error => error.code === 'privacy.turns_running');
  assert.ok(Date.now() - started < 1500, 'a closed request stops waiting');
  // The event loop stays free while waiting.
  let ticks = 0; const timer = setInterval(() => ticks++, 10);
  await privacyWhenIdle(async () => 'x', { waitMs: 250 }).catch(() => {}); clearInterval(timer);
  assert.ok(ticks >= 5, 'timers ran while waiting');
  // A turn that starts between the idle check and the write (work throws privacy.busy) is waited for again.
  state.busy = false; let calls = 0;
  assert.equal(await privacyWhenIdle(async () => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'privacy.busy' }); return 'ok' + calls; }, { waitMs: 2000 }), 'ok3');
  // Without waitMs (the steward settlement path) the result is unchanged: work runs and privacy.busy surfaces.
  state.busy = true;
  await assert.rejects(privacyWhenIdle(async () => { throw Object.assign(new Error('busy'), { code: 'privacy.busy' }); }), error => error.code === 'privacy.busy');
  // Other failures are never swallowed or retried.
  state.busy = false;
  await assert.rejects(privacyWhenIdle(async () => { throw Object.assign(new Error('x'), { code: 'work_data.locked' }); }, { waitMs: 2000 }), error => error.code === 'work_data.locked');
});

function helper(reply, exitCode) {
  const spawned = [];
  const childProcess = { spawn: () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = () => setImmediate(() => { child.stdout.emit('data', Buffer.from(reply)); child.emit('close', exitCode); });
    child.kill = () => {}; spawned.push(child); return child;
  } };
  const context = { Buffer, TextDecoder, setTimeout, clearTimeout, setImmediate,
    process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    require: name => name === 'node:child_process' ? childProcess : require(name) };
  return { crypto: vm.runInNewContext(constBlock(read('01j-local-crypto.js'), 'LocalSecretCrypto') + '\nLocalSecretCrypto', context), spawned };
}

test('the DPAPI helper reply separates a blocked host from a DPAPI verdict', async () => {
  const input = Buffer.alloc(32, 1), entropy = Buffer.from('fixture');
  const cases = [
    ['{"ok":false,"stage":"host"}', 1, 'unprotect', 'local_crypto.helper_blocked'],
    ['{"ok":false,"stage":"host"}', 1, 'protect', 'local_crypto.helper_blocked'],
    ['{"ok":false,"stage":"dpapi"}', 1, 'unprotect', 'local_crypto.decrypt_failed'],
    ['{"ok":false,"stage":"dpapi"}', 1, 'protect', 'local_crypto.process_failed'],
    ['{"ok":false}', 1, 'unprotect', 'local_crypto.decrypt_failed'],
    ['Program blocked by group policy', 1, 'unprotect', 'local_crypto.process_failed'],
  ];
  for (const [reply, code, op, expected] of cases) {
    const { crypto } = helper(reply, code);
    await assert.rejects(crypto.run(op, input, entropy), error => error.code === expected, reply + ' ' + op);
  }
  const value = Buffer.from('wrapped').toString('base64');
  const { crypto } = helper(JSON.stringify({ ok: true, value }), 0);
  assert.equal((await crypto.run('unprotect', input, entropy)).toString(), 'wrapped');
  // The helper script reports its stage; the stage switches to dpapi only right before ProtectedData is called.
  const source = constBlock(read('01j-local-crypto.js'), 'LocalSecretCrypto');
  assert.ok(source.indexOf("$stage='host'") < source.indexOf("$stage='dpapi'") && source.indexOf("$stage='dpapi'") < source.indexOf('ProtectedData]::Protect('));
});
