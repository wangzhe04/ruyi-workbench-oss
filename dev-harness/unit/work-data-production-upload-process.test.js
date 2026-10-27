'use strict';
// Focused regression for dev-harness/lib/work-data-production-upload-process.js.
// The real Windows birth probe is exercised against actually absent PIDs; every
// other case is a pure model. No service is started and no PID is ever killed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ownDescendants, snapshotProcessTable } = require('../lib/kill-own-tree');
const {
  createProcesses, createStrictStop, makeBirthCaptureScript, parseBirthCapture, fixedSpawnCommandLine,
} = require('../lib/work-data-production-upload-process');

const SHA = text => crypto.createHash('sha256').update(text).digest('hex');
const windowsPowerShell = process.platform === 'win32' && (() => {
  const probe = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return !probe.error && probe.status === 0;
})();
const realPowerShellSkip = windowsPowerShell ? false : 'Windows PowerShell is unavailable on this host';
function runBirthScript(script) {
  return cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

// Absent PIDs stay inside [int] and far above the range Windows hands out.
const ABSENT_ROOT = 2000000000, ABSENT_PIDS = Object.freeze([2000000004, 2000000008]);

test('real birth capture expands two absent PIDs into two flat omitted rows, never a nested array', { skip: realPowerShellSkip }, () => {
  const table = snapshotProcessTable();
  assert.ok(Array.isArray(table), 'actual CIM process table available');
  for (const pid of [ABSENT_ROOT, ...ABSENT_PIDS]) assert.equal(table.some(row => row.pid === pid), false, 'PID ' + pid + ' is actually absent');
  const selected = ABSENT_PIDS.map((pid, index) => ({ pid, ppid: ABSENT_ROOT, name: 'absent-' + index + '.exe', cimCreated: '13300000000000000' + (index + 1) }));
  const raw = runBirthScript(makeBirthCaptureScript(selected, ABSENT_ROOT));
  assert.equal(raw.error, undefined);
  assert.equal(raw.status, 0, 'birth capture with two absent non-root rows exits 0');
  assert.equal(String(raw.stderr).trim(), '');
  const value = JSON.parse(raw.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['kind', 'omitted', 'pairs', 'rootPid', 'schema']);
  assert.equal(value.schema, 1);
  assert.equal(value.kind, 'M3_NATIVE_BIRTH_PAIRS_V1');
  assert.equal(value.rootPid, ABSENT_ROOT);
  assert.deepEqual(value.pairs, []);
  assert.equal(value.omitted.length, 2, 'two rows expand to exactly two omitted entries');
  for (const row of value.omitted) {
    assert.equal(Array.isArray(row), false, 'omitted entry is a flat object');
    assert.deepEqual(Object.keys(row).sort(), ['cimCreated', 'pid', 'ppid']);
  }
  assert.deepEqual(value.omitted.map(row => row.pid), [...ABSENT_PIDS]);
  assert.deepEqual(value.omitted.map(row => row.ppid), [ABSENT_ROOT, ABSENT_ROOT]);
  assert.deepEqual(value.omitted.map(row => row.cimCreated), selected.map(row => row.cimCreated));
});

test('real birth capture refuses a missing root with a non-zero exit and no JSON', { skip: realPowerShellSkip }, () => {
  const selected = [
    { pid: ABSENT_ROOT, ppid: 1, name: 'absent-root.exe', cimCreated: '133000000000000010' },
    { pid: ABSENT_PIDS[0], ppid: ABSENT_ROOT, name: 'absent-child.exe', cimCreated: '133000000000000011' },
  ];
  const raw = runBirthScript(makeBirthCaptureScript(selected, ABSENT_ROOT));
  assert.equal(raw.error, undefined);
  assert.notEqual(raw.status, 0, 'missing root is a non-zero exit, never a success payload');
  assert.equal(String(raw.stdout).trim(), '');
  assert.match(String(raw.stderr), /^root absent$/m);
});

const ROOT_PID = 4100, CHILD_PID = 4200, ROOT_PPID = 4000, ROOT_ARGS = Object.freeze(['serve', '--port', '8765']);
const CIM_ROOT = '133000000000000001', CIM_CHILD = '133000000000000002';
const ROOT_EXE = SHA(path.resolve(process.execPath).toLowerCase());
const ROOT_COMMAND = SHA(fixedSpawnCommandLine(process.execPath, [...ROOT_ARGS]));
const SELECTED = Object.freeze([
  Object.freeze({ pid: ROOT_PID, ppid: ROOT_PPID, name: 'node.exe', cimCreated: CIM_ROOT }),
  Object.freeze({ pid: CHILD_PID, ppid: ROOT_PID, name: 'child.exe', cimCreated: CIM_CHILD }),
]);
const rootPair = () => ({ pid: ROOT_PID, ppid: ROOT_PPID, name: 'node.exe', cimCreated: CIM_ROOT, nativeCreated: '133000000000000101', commandLineSha256: ROOT_COMMAND, executablePathSha256: ROOT_EXE });
const childPair = () => ({ pid: CHILD_PID, ppid: ROOT_PID, name: 'child.exe', cimCreated: CIM_CHILD, nativeCreated: '133000000000000102', commandLineSha256: 'c'.repeat(64), executablePathSha256: 'd'.repeat(64) });
function birthCapture({ pairs = [rootPair(), childPair()], omitted = [], ...top } = {}) {
  return Buffer.from(JSON.stringify({ schema: 1, kind: 'M3_NATIVE_BIRTH_PAIRS_V1', rootPid: ROOT_PID, pairs, omitted, ...top }));
}
function parseCapture(raw = birthCapture(), selected = SELECTED) {
  return parseBirthCapture(raw, selected, ROOT_PID, process.execPath, [...ROOT_ARGS]);
}

test('birth capture parsing accepts the exact dual-view shape and refuses nested or duplicated pairs', () => {
  const pairs = parseCapture();
  assert.equal(pairs.length, 2);
  assert.ok(Object.isFrozen(pairs) && pairs.every(Object.isFrozen));
  assert.deepEqual(pairs.map(row => row.pid), [ROOT_PID, CHILD_PID]);
  assert.equal(pairs[0].executablePathSha256, ROOT_EXE);
  assert.equal(pairs[0].commandLineSha256, ROOT_COMMAND);
  assert.throws(() => parseCapture(birthCapture({ pairs: [[rootPair(), childPair()]] })), /birth probe response shape/);
  assert.throws(() => parseCapture(birthCapture({ pairs: [[rootPair()], childPair()] })), /birth pair shape/);
  assert.throws(() => parseCapture(birthCapture({ pairs: [rootPair()], omitted: [[{ pid: CHILD_PID, ppid: ROOT_PID, cimCreated: CIM_CHILD }]] })), /omitted birth shape/);
  assert.throws(() => parseCapture(birthCapture({ pairs: [rootPair()], omitted: [{ pid: 4300, ppid: ROOT_PID, cimCreated: '133000000000000003' }] })), /omitted birth identity invalid/);
  assert.throws(() => parseCapture(birthCapture({ pairs: [rootPair(), rootPair()] })), /birth pair differs from selected original CIM/);
});

test('birth capture parsing refuses tampered CIM/native identity, hashes, schema and extra keys', () => {
  const cimTampered = rootPair(); cimTampered.cimCreated = '133000000000000099';
  const nativeTampered = childPair(); nativeTampered.nativeCreated = '133000000000000199x';
  const longNative = childPair(); longNative.nativeCreated = '1'.repeat(21);
  const upperHash = rootPair(); upperHash.commandLineSha256 = 'A'.repeat(64);
  const shortHash = childPair(); shortHash.executablePathSha256 = 'e'.repeat(63);
  const commandTampered = rootPair(); commandTampered.commandLineSha256 = 'a'.repeat(64);
  const exeTampered = rootPair(); exeTampered.executablePathSha256 = 'b'.repeat(64);
  const cases = [
    ['root CIM creation changed', birthCapture({ pairs: [cimTampered, childPair()] }), /birth pair differs from selected original CIM/],
    ['native creation not a FILETIME', birthCapture({ pairs: [rootPair(), nativeTampered] }), /birth pair differs from selected original CIM/],
    ['native creation exceeds twenty digits', birthCapture({ pairs: [rootPair(), longNative] }), /birth pair differs from selected original CIM/],
    ['uppercase command hash', birthCapture({ pairs: [upperHash, childPair()] }), /birth pair differs from selected original CIM/],
    ['short executable hash', birthCapture({ pairs: [rootPair(), shortHash] }), /birth pair differs from selected original CIM/],
    ['root command differs from real args', birthCapture({ pairs: [commandTampered, childPair()] }), /root command differs from actual ChildProcess args/],
    ['root executable differs from real command', birthCapture({ pairs: [exeTampered, childPair()] }), /root executable differs from actual ChildProcess command/],
    ['schema 2', birthCapture({ schema: 2 }), /birth probe response shape/],
    ['foreign kind', birthCapture({ kind: 'M3_NATIVE_BIRTH_PAIRS_V2' }), /birth probe response shape/],
    ['extra top-level key', birthCapture({ note: 'synthetic' }), /birth probe response shape/],
    ['missing omitted key', (() => { const value = JSON.parse(birthCapture()); delete value.omitted; return Buffer.from(JSON.stringify(value)); })(), /birth probe response shape/],
    ['foreign root pid', birthCapture({ rootPid: ROOT_PID + 4 }), /birth probe response shape/],
    ['pairs is not an array', birthCapture({ pairs: rootPair() }), /birth probe response shape/],
    ['omitted row shape changed', birthCapture({ pairs: [rootPair()], omitted: [{ pid: CHILD_PID, ppid: ROOT_PID, cimCreated: CIM_CHILD, extra: true }] }), /omitted birth shape/],
    ['capture length differs from selection', birthCapture({ pairs: [childPair()], omitted: [] }), /birth probe response shape/],
  ];
  for (const [label, raw, expected] of cases) assert.throws(() => parseCapture(raw), expected, label);
  for (const [label, raw] of [
    ['empty buffer', Buffer.alloc(0)],
    ['not a buffer', JSON.stringify(JSON.parse(birthCapture()))],
    ['oversized buffer', Buffer.alloc(65537, 0x20)],
  ]) assert.throws(() => parseCapture(raw), /birth probe output capacity/, label);
  assert.throws(() => parseCapture(Buffer.from('{')), /birth probe JSON invalid/);
});

test('birth capture parsing never certifies a missing or omitted root', () => {
  assert.throws(() => parseCapture(birthCapture({ pairs: [childPair()], omitted: [] }), [SELECTED[1]]), /original root native birth missing/);
  assert.throws(() => parseCapture(birthCapture({
    pairs: [],
    omitted: [{ pid: ROOT_PID, ppid: ROOT_PPID, cimCreated: CIM_ROOT }, { pid: CHILD_PID, ppid: ROOT_PID, cimCreated: CIM_CHILD }],
  })), /omitted birth identity invalid/);
});

const STOP_ROOT = 5100, STOP_CHILD = 5104, STOP_CONHOST = 5108, STOP_PARENT = 5000;
const STOP_CREATED = Object.freeze({ root: '133000000000010010', child: '133000000000010011', conhost: '133000000000010012', extra: '133000000000010013' });
const processRow = (pid, ppid, created, name) => ({ pid, ppid, created: BigInt(created), name });
function stopTable() {
  return [
    processRow(STOP_ROOT, STOP_PARENT, STOP_CREATED.root, 'ai-node.exe'),
    processRow(STOP_CHILD, STOP_ROOT, STOP_CREATED.child, 'child.exe'),
    processRow(STOP_CONHOST, STOP_ROOT, STOP_CREATED.conhost, 'conhost.exe'),
  ];
}
function stopBirthPairs() {
  return [
    { pid: STOP_ROOT, ppid: STOP_PARENT, name: 'ai-node.exe', cimCreated: STOP_CREATED.root, nativeCreated: '133000000000020010', commandLineSha256: 'a'.repeat(64), executablePathSha256: 'b'.repeat(64) },
    { pid: STOP_CHILD, ppid: STOP_ROOT, name: 'child.exe', cimCreated: STOP_CREATED.child, nativeCreated: '133000000000020011', commandLineSha256: 'c'.repeat(64), executablePathSha256: 'd'.repeat(64) },
  ];
}
const STOP_RECEIPT = 'STOP_REQUESTED ' + STOP_ROOT + '\nSTOP_REQUESTED ' + STOP_CHILD + '\n';
function strictStopFixture({ table = stopTable(), expectedRoot = { pid: STOP_ROOT, created: BigInt(STOP_CREATED.root) }, birthPairs = stopBirthPairs(), runResult = { status: 0, stdout: STOP_RECEIPT, error: null }, unknown = false, platform = 'win32', child = { pid: STOP_ROOT, exitCode: null, signalCode: null } } = {}) {
  const latched = [], runs = [];
  const stop = createStrictStop({
    snapshotProcessTable: () => table,
    ownDescendants,
    latch: error => latched.push(error),
    isUnknown: () => (typeof unknown === 'function' ? unknown() : unknown),
    run: (file, args, options) => { runs.push({ file, args, options }); return (typeof runResult === 'function' ? runResult(file, args, options) : runResult); },
    platform,
  });
  return { child, expectedRoot, birthPairs, latched, runs, call() { return stop(child, { expectedRoot, healthy: () => {}, birthPairs }); } };
}

test('strict stop returns a request-only receipt and keeps CIM/native StartTime exact', () => {
  const fixture = strictStopFixture();
  const result = fixture.call();
  assert.deepEqual(result, {
    killed: [STOP_ROOT, STOP_CHILD],
    sampledRows: [
      { pid: STOP_ROOT, ppid: STOP_PARENT, created: STOP_CREATED.root, name: 'ai-node.exe' },
      { pid: STOP_CHILD, ppid: STOP_ROOT, created: STOP_CREATED.child, name: 'child.exe' },
      { pid: STOP_CONHOST, ppid: STOP_ROOT, created: STOP_CREATED.conhost, name: 'conhost.exe' },
    ],
    strictPreflight: true,
    requestOnly: true,
  });
  assert.deepEqual(Object.keys(result).sort(), ['killed', 'requestOnly', 'sampledRows', 'strictPreflight']);
  assert.equal('closed' in result || 'closeCode' in result || 'deathVerified' in result, false);
  assert.equal(fixture.latched.length, 0);
  assert.equal(fixture.runs.length, 1);
  const [{ file, args }] = fixture.runs;
  assert.equal(file, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const script = args[3];
  assert.equal(typeof script, 'string');
  assert.match(script, /\$r\.CreationDate\.ToFileTimeUtc\(\)\.ToString\(\) -ne \$e\.cimCreated/);
  assert.match(script, /\$q\.StartTime\.ToFileTimeUtc\(\)\.ToString\(\) -ne \$e\.nativeCreated/);
  assert.match(script, /\$q\.StartTime\.ToFileTimeUtc\(\)\.ToString\(\) -ne \$e\.nativeCreated\)\{throw 'exact native birth changed'\}/);
  for (const fallback of ['[math]::Abs', '-lt 10000', 'Stop-Process', 'taskkill']) assert.equal(script.includes(fallback), false, fallback);
});

test('strict stop refuses unknown, wrong root identity, unusable tables and unregistered targets without requesting a stop', () => {
  const changedCim = stopBirthPairs(); changedCim[1].cimCreated = STOP_CREATED.extra;
  const badNative = stopBirthPairs(); badNative[1].nativeCreated = 'native';
  const cases = [
    ['unknown', { unknown: true }, /unknown forbids strict stop/],
    ['not Windows', { platform: 'linux' }, /strict test stop requires Windows/],
    ['already exited child', { child: { pid: STOP_ROOT, exitCode: 0, signalCode: null } }, /strict stop requires live held child/],
    ['CIM sample unavailable', { table: null }, /strict stop CIM unavailable/],
    ['root absent from table', { table: [processRow(STOP_CHILD, STOP_PARENT, STOP_CREATED.child, 'child.exe')] }, /strict stop root creation changed/],
    ['root creation changed', { expectedRoot: { pid: STOP_ROOT, created: BigInt(STOP_CREATED.root) + 1n } }, /strict stop root creation changed/],
    ['root pid changed', { expectedRoot: { pid: STOP_ROOT + 4, created: BigInt(STOP_CREATED.root) } }, /strict stop root creation changed/],
    ['no birth pairs', { birthPairs: [] }, /original native birth pairs required/],
    ['too many birth pairs', { birthPairs: new Array(33).fill(stopBirthPairs()[0]) }, /original native birth pairs required/],
    ['birth pair CIM creation changed', { birthPairs: changedCim }, /unregistered or changed nonconhost target/],
    ['birth pair native creation not exact', { birthPairs: badNative }, /unregistered or changed nonconhost target/],
    ['unregistered extra descendant', { table: stopTable().concat(processRow(9999, STOP_ROOT, STOP_CREATED.extra, 'extra.exe')) }, /unregistered or changed nonconhost target/],
  ];
  for (const [label, options, expected] of cases) {
    const fixture = strictStopFixture(options);
    assert.throws(() => fixture.call(), expected, label);
    assert.equal(fixture.runs.length, 0, label + ' must not start PowerShell');
    assert.ok(fixture.latched.length >= 1, label + ' is latched');
    assert.ok(fixture.latched.every(error => error instanceof Error && expected.test(error.message)), label + ' latches the refusal');
  }
});

test('strict stop treats anomalous PowerShell results as uncertainty and never falls back to a PID kill', () => {
  const cases = [
    ['null result', null, /strict stop preflight or request failed/],
    ['spawn error', { error: Error('spawn failed'), status: null, stdout: '' }, /strict stop preflight or request failed/],
    ['non-zero exit', { status: 1, stdout: STOP_RECEIPT, error: null }, /strict stop preflight or request failed/],
    ['error with status zero', { status: 0, error: Error('timeout'), stdout: '' }, /strict stop preflight or request failed/],
    ['unrecognized output', { status: 0, stdout: 'KILLED ' + STOP_ROOT + '\n', error: null }, /strict stop output invalid/],
    ['foreign pid receipt', { status: 0, stdout: 'STOP_REQUESTED 9999\n', error: null }, /strict stop request receipt invalid/],
    ['root receipt missing', { status: 0, stdout: 'STOP_REQUESTED ' + STOP_CHILD + '\n', error: null }, /strict stop request receipt invalid/],
    ['duplicate receipt', { status: 0, stdout: 'STOP_REQUESTED ' + STOP_ROOT + '\nSTOP_REQUESTED ' + STOP_ROOT + '\n', error: null }, /strict stop request receipt invalid/],
  ];
  for (const [label, runResult, expected] of cases) {
    const fixture = strictStopFixture({ runResult });
    assert.throws(() => fixture.call(), expected, label);
    assert.equal(fixture.runs.length, 1, label + ' sends exactly one stop request');
    assert.ok(fixture.latched.length >= 1, label + ' is latched');
    assert.ok(fixture.latched.every(error => error instanceof Error && expected.test(error.message)), label + ' latches the refusal');
    const script = fixture.runs[0].args[3];
    for (const fallback of ['taskkill', 'Stop-Process', '[math]::Abs']) assert.equal(script.includes(fallback), false, label + ' script has no fallback');
  }
});

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  return child;
}
function cleanupFixture() {
  const state = { unknown: false, records: [], log: [], kills: [], tables: [[processRow(6000, 1, '133000000000030000', 'ai-node.exe')]], verifies: 0 };
  let child;
  const manager = createProcesses({
    record: row => { state.records.push(row); state.log.push(row.kind); },
    writeOutput: () => {},
    latch: error => state.records.push({ kind: 'latched', message: error.message }),
    isUnknown: () => state.unknown,
    killOwnTree: (target, options) => {
      state.kills.push({ target, options }); state.log.push('kill');
      state.tables[0] = [];
      target.exitCode = 0; target.signalCode = null;
      target.emit('exit', 0, null); target.emit('close', 0, null);
      return { killed: [target.pid], sampledRows: [] };
    },
    snapshotProcessTable: () => state.tables[state.tables.length - 1],
    ownDescendants,
    spawn: () => { child = fakeChild(6000); process.nextTick(() => child.emit('spawn')); return child; },
    now: () => 0,
  });
  return {
    state,
    async start() { const handle = manager.start('node', [], {}, 'cleanup-fixture'); await handle.spawned; return { handle, child }; },
    manager,
  };
}

test('cleanupKnown refuses unknown before any snapshot or kill and never certifies it', async () => {
  const early = cleanupFixture();
  const { handle } = await early.start();
  early.state.unknown = true;
  await assert.rejects(early.manager.cleanupKnown(handle, async () => { early.state.verifies++; }), /unknown forbids automatic cleanup/);
  assert.equal(early.state.verifies, 0, 'unknown is checked before verifyHealth');
  assert.equal(early.state.kills.length, 0, 'unknown never calls killOwnTree');
  assert.deepEqual(early.state.log.filter(kind => kind === 'owned-cleanup-request' || kind === 'kill'), [], 'unknown emits no cleanup request or kill');
  assert.equal(early.state.records.some(row => row.kind.startsWith('owned-cleanup')), false);
  const inspected = early.manager.inspect(handle);
  assert.equal(inspected.cleanupRequested, false);
  assert.equal(inspected.cleanupVerified, false);
  assert.equal(inspected.closeSeen, false);

  const late = cleanupFixture();
  const lateHandle = (await late.start()).handle;
  await assert.rejects(late.manager.cleanupKnown(lateHandle, async () => { late.state.verifies++; late.state.unknown = true; }), /unknown forbids automatic cleanup/);
  assert.equal(late.state.verifies, 1, 'the post-verifier gate is what refuses');
  assert.equal(late.state.kills.length, 0, 'unknown after verifyHealth never kills');
  assert.equal(late.state.log.includes('owned-cleanup-request'), false);
  assert.equal(late.manager.inspect(lateHandle).cleanupVerified, false);
});

test('cleanupKnown still requests the exact owned tree once when the observer stays healthy', async () => {
  const fixture = cleanupFixture();
  const { handle, child } = await fixture.start();
  assert.equal(await fixture.manager.cleanupKnown(handle, async () => { fixture.state.verifies++; }), true);
  assert.equal(fixture.state.verifies, 1);
  assert.equal(fixture.state.kills.length, 1);
  assert.equal(fixture.state.kills[0].target, child);
  assert.equal(String(fixture.state.kills[0].options.expectedRoot.created), '133000000000030000');
  assert.ok(fixture.state.log.indexOf('owned-cleanup-request') < fixture.state.log.indexOf('kill'), 'request precedes the kill call');
  assert.ok(fixture.state.log.includes('owned-cleanup-actual-close-and-sampled-absence'));
  const inspected = fixture.manager.inspect(handle);
  assert.equal(inspected.cleanupRequested, true);
  assert.equal(inspected.cleanupVerified, true);
  assert.equal(inspected.closeSeen, true);
});
