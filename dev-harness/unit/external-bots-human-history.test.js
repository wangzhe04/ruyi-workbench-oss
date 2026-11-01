'use strict';
require('../lib/media-artifact-test-guard');
const { test } = require('node:test'), a = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const history = require('../lib/external-bots-source-history');
const fixture = require('../fixtures/external-bots-remote-actions/human-history.json');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13w-external-bots.js'), 'utf8');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
test('typed human changes invert exactly through reviewed C1b to committed B2 without changing historical hashes', () => {
  a.equal(hash(source), fixture.sha256);
  const c1 = history.beforeHumanDecisions(source); a.equal(hash(c1), fixture.baseSha256);
  a.equal(hash(c1), require('../fixtures/external-bots-remote-actions/readonly-history.json').sha256);
  a.equal(hash(history.beforeRemoteActions(source)), require('../fixtures/external-bots-progress/deferred-wake-history.json').sha256);
  let forward = c1; for (const row of fixture.inverseSpans) { a.equal(forward.split(row.after).length, 2); forward = forward.replace(row.after, row.before); }
  a.equal(forward, source);
});
test('human inverse refuses unrelated drift and a corrupted span cannot bypass the old C1/B2 proof', () => {
  for (const changed of [source + '\n', source.replace('externalBotVerifiedIngressTickets = new WeakMap()', 'externalBotVerifiedIngressTickets = new Map()')]) {
    a.notEqual(changed, source); a.equal(history.beforeHumanDecisions(changed), changed);
    a.throws(() => history.retryCoreSource(changed), a.AssertionError);
  }
  const row = fixture.inverseSpans[0], before = row.before;
  try { row.before += '\n// tampered'; a.throws(() => history.beforeHumanDecisions(source), a.AssertionError); }
  finally { row.before = before; }
});
