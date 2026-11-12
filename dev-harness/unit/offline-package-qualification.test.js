'use strict';
// Asset-free boundary tests. No real ZIP/package, EXE, server, Python or DPAPI.
require('../lib/media-artifact-test-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { parseArgs, safeRelative, census, validateZipReport, childEnv, plainSession, successfulTurn } = require('../lib/offline-package-qualification.cjs');
const { ownersClosed, retainUnknownOwners } = require('../lib/offline-package-retention.cjs');
const pin = 'a'.repeat(64);
const args = () => ['--stage', path.resolve('synthetic-stage'), '--zip', path.resolve('synthetic.zip'),
  '--output', path.resolve('synthetic-output'), '--expected-server-sha', pin];
function fixture(t) {
  const temp = fs.realpathSync.native(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-package-unit-'));
  t.after(() => { assert.equal(path.dirname(root), temp); assert.match(path.basename(root), /^ruyi-package-unit-/); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
test('manual arguments require explicit absolute artifacts and pin, refuse duplicate/unknown flags, preserve full-media opt-in', () => {
  const options = parseArgs([...args(), '--full-media', '--python', path.resolve('synthetic-python.exe')]);
  assert.equal(options.fullMedia, true); assert.equal(options.expectedServerSha, pin); assert.deepEqual(options.pythonArgs, []);
  assert.equal(parseArgs(args()).fullMedia, false); assert.deepEqual(parseArgs(args()).pythonArgs, ['-3']);
  for (const values of [[], args().slice(0, -1), [...args(), '--full-media', '--full-media'], [...args(), '--unknown'],
    [...args(), '--stage', path.resolve('other')], [...args(), '--python', 'python -c arbitrary'],
    ['--stage', 'relative', ...args().slice(2)], [...args().slice(0, -1), 'not-a-hash']]) assert.throws(() => parseArgs(values));
});
test('Windows archive paths refuse traversal, ADS, drive/UNC, empty components, device names and normalization ambiguity', () => {
  for (const name of ['app/server.js', 'runtime/node/node.exe', '字体/regular.ttf']) assert.equal(safeRelative(name), name);
  for (const name of ['', './file', '../file', '/absolute', 'C:/drive', '\\server\\share', 'a\\b', 'a//b', 'a/../b',
    'x:stream', 'trailing.', 'trailing ', 'nul.txt', 'a/COM1', 'a\nfile']) assert.throws(() => safeRelative(name));
});
test('complete stage census hashes every file and refuses real hardlink aliases', async t => {
  const root = fixture(t); fs.mkdirSync(path.join(root, 'nested')); fs.writeFileSync(path.join(root, 'nested', 'a'), 'synthetic');
  const first = await census(root); assert.equal(first.files.length, 1); assert.deepEqual(first.directories, ['nested']);
  fs.writeFileSync(path.join(root, 'nested', 'a'), 'changed'); assert.notEqual((await census(root)).sha256, first.sha256);
  fs.linkSync(path.join(root, 'nested', 'a'), path.join(root, 'alias'));
  await assert.rejects(census(root), /single-link regular files/);
});
test('archive result cannot wash missing/extra/changed files, directories, duplicate paths or absent CRC EOF', () => {
  const stage = { files: [{ path: 'app/a', bytes: 3, sha256: pin }], directories: ['app'] };
  const result = { status: 'PASS', crcReadToEof: true, files: 1, directories: 1, bytes: 3, entries: 2,
    rows: [{ path: 'app', kind: 'directory' }, { path: 'app/a', kind: 'file', bytes: 3, sha256: pin }] };
  validateZipReport(result, stage);
  for (const change of [r => { r.crcReadToEof = false; }, r => { r.rows[1].sha256 = 'b'.repeat(64); },
    r => { r.rows[1].path = 'app/missing'; }, r => { r.rows.push({ ...r.rows[1] }); r.entries++; },
    r => { r.rows[0].path = '../escape'; }, r => { r.rows[0].kind = 'special'; }, r => { r.files = 0; }]) {
    const altered = structuredClone(result); change(altered); assert.throws(() => validateZipReport(altered, stage));
  }
});
test('child environment isolates profiles and strips global media roots, test preloads and provider secrets', t => {
  const root = fixture(t), previous = Object.fromEntries(['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT', 'RUYI_MEDIA_RESOURCE_PROFILE', 'OPENAI_API_KEY', 'NODE_OPTIONS'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, { RUYI_MEDIA_RUNTIME_ROOT: 'foreign', RUYI_MEDIA_SOURCES_ROOT: 'foreign', RUYI_MEDIA_RESOURCE_PROFILE: 'local-full-v2', OPENAI_API_KEY: 'private', NODE_OPTIONS: '--require foreign' });
  const env = childEnv(path.join(root, 'home'), path.join(root, 'data'), 'nonce');
  for (const key of ['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT', 'RUYI_MEDIA_RESOURCE_PROFILE', 'OPENAI_API_KEY']) assert.equal(env[key], undefined);
  assert.equal(env.NODE_OPTIONS, ''); assert.equal(env.RUYI_HOME, path.join(root, 'data')); assert.equal(env.USERPROFILE, path.join(root, 'home'));
});
test('session comparison keeps full message/provider history at the real JSON boundary without invented optional fields', () => {
  const session = { id: 'sess', title: 'synthetic', turnSeq: 2, messages: [{ role: 'user', content: '中文' }], providerHistory: [{ role: 'tool', content: '{"ok":true}' }] };
  assert.deepEqual(plainSession(session), session); assert.equal(Object.hasOwn(plainSession(session), 'storageVersion'), false);
  assert.notDeepEqual(plainSession({ ...session, messages: [] }), plainSession(session));
});
test('native stream gate requires real successful result and refuses partial/error/aborted traces', () => {
  assert.equal(successfulTurn(Buffer.from('{"type":"result","ok":true}\n')).length, 1);
  for (const value of ['', '{"type":"assistant_delta","text":"pretend success"}\n', '{"type":"result","ok":true,"aborted":true}\n',
    '{"type":"error"}\n{"type":"result","ok":true}\n', 'malformed']) assert.throws(() => successfulTurn(Buffer.from(value)));
});
function heldFacts() {
  const child = new EventEmitter(), facts = { spawn: true, error: null, exit: null, close: null,
    streams: { stdout: { availability: 'original-pipe', end: false, close: false, error: null } } };
  let resolve; const closed = new Promise(value => { resolve = value; });
  return { child, facts, closed, killReceipt: null, finish() {
    facts.exit = { code: 0, signal: null }; facts.close = { code: 0, signal: null };
    Object.assign(facts.streams.stdout, { end: true, close: true }); resolve(facts.close); child.emit('close');
  } };
}
test('late close retains exact original actors and EOF obligation; a pid/exit alone is insufficient', async () => {
  const row = heldFacts(), records = []; let cancelled = false;
  const retained = retainUnknownOwners({ actors: [row], deadline: Date.now() + 1000, stop: async original => { assert.equal(original, row); await original.closed; },
    note: value => records.push(value), schedule: () => 'original-timer', cancel: () => { cancelled = true; }, hardExit: () => assert.fail('unexpected watchdog') });
  assert.equal(retained.actors[0].child, row.child); row.facts.exit = { code: 0, signal: null };
  assert.equal(Boolean(ownersClosed([row])), false); row.finish();
  assert.equal((await retained.promise).status, 'RED_ORIGINAL_FAILURE_RETAINED_ORIGINAL_OWNERS_CLOSED_LATE');
  assert.equal(cancelled, true); assert.equal(records.at(-1).allDescendantKernelExitCertified, false);
});
test('original pending provider startup remains retained until its same close resolves, even if evidence throws', async () => {
  let finish, state = { closeStatus: 'awaiting-startup' }, cancelled = false;
  const close = new Promise(resolve => { finish = resolve; }), provider = { snapshot: () => state, requestClose: () => close };
  const retained = retainUnknownOwners({ actors: [], provider, deadline: Date.now() + 1000, stop: async () => {},
    note: () => { throw Error('synthetic evidence EIO'); }, schedule: () => 1, cancel: () => { cancelled = true; }, hardExit: () => assert.fail('unexpected watchdog') });
  assert.equal(retained.provider, provider); assert.equal(ownersClosed([], provider), false);
  state = { closeStatus: 'closed' }; finish(); await retained.promise;
  assert.equal(cancelled, true); assert.ok(retained.diagnosticErrors.includes('synthetic evidence EIO'));
});
test('absolute retained-owner watchdog records UNKNOWN and exits red without inventing close from numeric pid', async () => {
  const row = heldFacts(); row.facts.pid = 1234;
  let watchdog, exit, last;
  const retained = retainUnknownOwners({ actors: [row], deadline: Date.now() + 1000, stop: async () => row.closed,
    note: value => { last = value; }, schedule: callback => { watchdog = callback; return 1; }, cancel: () => {}, hardExit: code => { exit = code; } });
  watchdog(); assert.equal((await retained.promise).status, 'RED_UNKNOWN_ORIGINAL_OWNER_DEADLINE');
  assert.equal(exit, 1); assert.equal(last.actors[0].knownCleanup, false); assert.equal(row.facts.close, null);
});
