'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const diagnostic = require('./resident-home-cold-pipe-diagnostic.cjs');
const createTrace = require('./resident-home-cold-phase-trace.cjs');

test('cold trace uses exclusive independent output, preserves order, and discards contents', () => {
  const tracked = [];
  const proc = Object.assign(new EventEmitter(), { pid: 12, connected: true });
  const socket = new EventEmitter();
  const writer = {
    openSync(target, mode) { assert.equal(target, path.join('public-fixture-output', 'cold-pipe-phases.jsonl')); assert.equal(mode, 'wx'); return 171; },
    writeSync(fd, line) { assert.equal(fd, 171); tracked.push(JSON.parse(line)); },
  };
  const trace = createTrace(writer, path, 'public-fixture-output', proc);
  trace.observe(socket);
  socket.emit('connect');
  socket.emit('data', Buffer.from('opaque protocol body'));
  trace.record('registered');
  proc.connected = false;
  socket.emit('error', Object.assign(Error('opaque secret path'), { code: 'ECONNRESET', stack: 'opaque stack' }));
  socket.emit('close');
  proc.emit('uncaughtExceptionMonitor', Error('opaque failure'));
  proc.emit('exit');
  assert.deepEqual(tracked.map(v => v.phase),
    ['script-enter', 'pipe-connect', 'pipe-data', 'registered', 'pipe-error', 'pipe-close', 'uncaught-exception', 'process-exit']);
  assert.deepEqual(tracked.map(v => v.parentIpcConnected), [true, true, true, true, false, false, false, false]);
  assert.equal(tracked[4].errorClass, 'ECONNRESET');
  assert.equal(tracked[6].errorClass, 'unclassified');
  assert.doesNotMatch(JSON.stringify(tracked), /opaque|protocol body|secret path/);
});

test('trace caps rows and existing/failed evidence does not change socket behavior', () => {
  const proc = new EventEmitter(), socket = new EventEmitter(), writes = [];
  const trace = createTrace({ openSync: () => 3, writeSync: (_fd, line) => writes.push(line) }, path, 'public-output', proc);
  trace.observe(socket);
  for (let i = 0; i < 100; i++) socket.emit('data', 'opaque');
  assert.equal(writes.length, 40);
  const disabled = createTrace({ openSync() { throw Object.assign(Error(), { code: 'EEXIST' }); } }, path, 'public-output', proc);
  assert.doesNotThrow(() => disabled.record('active'));
  assert.doesNotThrow(() => createTrace({ openSync: () => 2, writeSync() { throw Error('disk'); } },
    path, 'public-output', proc).record('active'));
});

test('only finite EOF classification and HRESULT are added to exact frozen C# host', () => {
  const root = path.resolve(__dirname, '../../output/semantic-resident-home-service-candidate-v2');
  const bytes = fs.readFileSync(path.join(root, 'DesktopLifetimeHost.cs'));
  const original = bytes.toString('utf8');
  const derived = diagnostic.host(bytes);
  assert.match(derived, /error is EndOfStreamException\)reason="end_of_stream"/);
  assert.match(derived, /hresult=error is IOException\?\(int\?\)error.HResult:null/);
  assert.equal(derived.replace('else if(error is EndOfStreamException)reason="end_of_stream";\n                ', '')
    .replace('hresult=error is IOException?(int?)error.HResult:null,', ''), original);
  assert.match(diagnostic.probe(fs.readFileSync(path.join(root, 'DesktopLifecycleProbe.cs'))), /"hresult"/);
  assert.throws(() => diagnostic.host(Buffer.from('drift')));
});

test('cold fixture trace observes existing socket; it does not replace methods or alter normal close', () => {
  const root = path.resolve(__dirname, '../../output/semantic-desktop-home-scene-source-v1');
  const bytes = fs.readFileSync(path.join(root, 'server.cjs'));
  const result = diagnostic.fixture(bytes);
  assert.match(result, /coldTrace=role==='cold'\?require\('\.\/cold-phase-trace.cjs'\)/);
  assert.match(result, /const socket=net.createConnection\(name\);coldTrace\?\.observe\(socket\);return socket/);
  const segment = code => code.slice(code.indexOf('async function stop()'), code.indexOf('client=Desktop.create'));
  assert.equal(segment(result), segment(bytes.toString('utf8')));
});
