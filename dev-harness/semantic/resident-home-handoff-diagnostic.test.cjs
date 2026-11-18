'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const diagnostic = require('./resident-home-handoff-diagnostic.cjs');
const out = path.resolve(__dirname, '../../output');
const scene = path.join(out, 'semantic-desktop-home-scene-source-v1');
const frozen = fs.readFileSync(path.join(scene, 'server.cjs'));
const corrected = diagnostic.fixture(frozen);

test('active fixture persists source actor role across both permit transfers', async () => {
  const fn = corrected.slice(corrected.indexOf('async function next('), corrected.indexOf('function fail('));
  for (const [source, target, expected] of [
    ['serve', 'cold', 'OBSERVED_RETIRED_TRANSFERRED'],
    ['cold', 'successor', 'TRANSFERRED_WITHOUT_RUNTIME'],
  ]) {
    const nonce = () => ({ toString: () => 'a' });
    const grant = { role: target };
    const row = { role: source };
    const called = [];
    const context = { __filename: 'isolated.js', role: source, events: [], proof: row,
      process: { env: {}, exit: code => called.push(['exit', code]) },
      root: 'isolated', config: { node: 'synthetic.exe' }, crypto: { randomBytes: nonce },
      cp: { spawn: () => {
        const child = new EventEmitter();
        child.pid = 3;
        setImmediate(() => child.emit('message', { phase: 'registered', pid: 3, role: target }));
        return child;
      } },
      client: { issue: async issued => { assert.equal(issued, target); return grant; },
        transfer: async own => assert.equal(own, grant) },
      persist: () => called.push(['persist', row.status]), marker: label => called.push(['marker', label]),
      bounded: promise => promise };
    await vm.runInNewContext(fn + '\nnext("' + target + '")', context);
    assert.equal(row.status, expected);
    assert.deepEqual(called, [['persist', expected], ['marker', 'transferred'], ['exit', 0]]);
  }
});

test('normal-close implementation stays byte-identical in derived fixture', () => {
  const segment = (source, start, stop) => source.slice(source.indexOf(start), source.indexOf(stop));
  assert.equal(segment(corrected, 'async function stop()', 'async function echo()'),
    segment(frozen.toString('utf8'), 'async function stop()', 'async function echo()'));
  assert.equal(segment(corrected, '  server=net.createServer()', '})().catch(fail);'),
    segment(frozen.toString('utf8'), '  server=net.createServer()', '})().catch(fail);'));
});

test('probe preserves bounded diagnostics from unchanged host', () => {
  const original = fs.readFileSync(path.join(out, 'semantic-resident-home-service-candidate-v2/DesktopLifecycleProbe.cs'));
  const probe = diagnostic.probe(original);
  assert.match(probe, /phase=="close-failure-diagnostic"\|\|phase=="node-close-diagnostic"/);
  assert.match(probe, /"stage","reason","name","nativeCode"/);
  assert.doesNotMatch(probe, /"stack"|"message"/);
  assert.throws(() => diagnostic.probe(Buffer.from('drift')));
});
