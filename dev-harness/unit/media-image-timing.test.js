'use strict';
// No server/native component or timeout budget is simulated here. These tests
// exercise observer isolation and anonymous correlation, not native performance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { functionBlock } = require('../lib/source-slice');
const { CHANNEL, PHASES, routeFor, install } = require('../lib/media-image-timing.cjs');
const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');

for (const name of ['13bc-media-image-processor.js', '13bd-media-image-service.js', '13be-media-image-host.js']) {
  const source = fs.readFileSync(path.join(sourceRoot, name), 'utf8');
  const body = functionBlock(source, 'tracePhase');
  assert.ok(body);
  test(name + ': no listener allocates no event; absent VM observer API remains harmless', () => {
    let allocations = 0, enumerations = 0;
    const trace = vm.runInNewContext(body + ';tracePhase', { phaseObservers: { listenerCount: () => 0,
      rawListeners() { enumerations++; } }, phaseChannel: CHANNEL, Object: { freeze() { allocations++; } } });
    assert.equal(trace('host.source.begin'), undefined);
    assert.equal(allocations, 0); assert.equal(enumerations, 0);
    const absent = vm.runInNewContext(body + ';tracePhase', { phaseObservers: {}, phaseChannel: CHANNEL });
    assert.doesNotThrow(() => absent('host.source.begin'));
  });
  test(name + ': once, sync/async throws and hostile thenables cannot suppress other observers', async () => {
    const emitter = new EventEmitter(), events = [];
    let once = 0;
    emitter.once(CHANNEL, () => { once++; throw Error('synthetic private observer failure'); });
    emitter.on(CHANNEL, () => { throw Error('synthetic private observer failure'); });
    emitter.once(CHANNEL, async () => { throw Error('synthetic rejected once observer'); });
    emitter.on(CHANNEL, async () => { throw Error('synthetic rejected observer'); });
    emitter.on(CHANNEL, () => ({ get then() { throw Error('synthetic then getter'); } }));
    emitter.on(CHANNEL, value => { events.push(value); });
    const trace = vm.runInNewContext(body + ';tracePhase', { phaseObservers: emitter, phaseChannel: CHANNEL });
    assert.equal(trace('host.source.begin'), undefined); assert.equal(trace('host.source.end'), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(once, 1); assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(Object.isFrozen(event), true); assert.deepEqual(Object.keys(event), ['phase']);
      assert.equal(typeof event.phase, 'string'); assert.equal(PHASES.has(event.phase), true);
    }
  });
}

test('Node diagnostics_channel schedules a throwing subscriber outside publish try/catch', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const dc = require('node:diagnostics_channel').channel('synthetic-test');
    dc.subscribe(() => { throw Error('synthetic observer'); });
    process.once('uncaughtException', () => process.stdout.write('scheduled-uncaught'));
    try { dc.publish(Object.freeze({phase:'synthetic'})); process.stdout.write('publish-returned;'); }
    catch { process.stdout.write('caught-in-publish'); }
  `], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'publish-returned;scheduled-uncaught');
});

test('HTTP request ALS correlates overlapping work without IDs, paths, headers or content', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-media-timing-unit-'));
  const file = path.join(root, 'timing.jsonl'), emitter = new EventEmitter(), server = new EventEmitter();
  const prototype = Object.create(EventEmitter.prototype); Object.setPrototypeOf(server, prototype);
  let now = 0n;
  const observer = install({ file, emitter, serverPrototype: prototype, clock: () => now });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const completions = [];
  server.on('request', (req, res) => {
    completions.push((async () => {
      emitter.emit(CHANNEL, Object.freeze({ phase: 'host.source.begin' }));
      if (req.hold) await pending;
      now += 1_000_000n;
      emitter.emit(CHANNEL, Object.freeze({ phase: 'host.source.end' }));
      emitter.emit(CHANNEL, Object.freeze({ phase: 'private-path/private-text' }));
      emitter.emit(CHANNEL, Object.freeze({ phase: 'host.source.end', bytes: 'PRIVATE' }));
      res.emit('finish'); res.emit('close');
    })());
  });
  const response = () => Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
  try {
    server.emit('request', { url: '/api/media/images/prepare?secret=PRIVATE', hold: true, headers: { token: 'PRIVATE' } }, response());
    server.emit('request', { url: '/api/media/images/' + 'a'.repeat(32) + '/preview?sessionId=PRIVATE' }, response());
    release(); await Promise.all(completions); observer.close();
    const raw = fs.readFileSync(file, 'utf8'), rows = raw.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(raw.includes('PRIVATE'), false); assert.equal(raw.includes('a'.repeat(32)), false);
    assert.deepEqual(rows.filter(row => row.event === 'host.source.end').map(row => [row.request, row.route]), [[2, 'preview'], [1, 'prepare']]);
    for (const row of rows) assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0);
    assert.equal(emitter.listenerCount(CHANNEL), 0);
  } finally { observer.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('bounded output and metadata observation failures preserve the actual dispatch and return', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-media-timing-unit-'));
  const prototype = { emit() { return 42; } }, emitter = new EventEmitter();
  const observer = install({ file: path.join(root, 'trace'), emitter, serverPrototype: prototype, limit: 1 });
  try {
    const res = new EventEmitter(); res.statusCode = 409;
    assert.equal(prototype.emit('request', { url: '/api/media/images/prepare' }, res), 42);
    res.emit('finish'); res.emit('close');
    assert.equal(fs.readFileSync(path.join(root, 'trace'), 'utf8').trim().split('\n').length, 1);
    assert.equal(prototype.emit('request', { get url() { throw Error('observation failed'); } }, res), 42);
    assert.equal(routeFor('/api/media/images/' + 'b'.repeat(32) + '/preview?sessionId=PRIVATE'), 'preview');
    assert.equal(routeFor('/api/chat/stream'), null);
  } finally { observer.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
