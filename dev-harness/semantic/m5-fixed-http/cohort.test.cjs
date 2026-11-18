'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { completeSamples, matchIdentity } = require('./controller-policy.cjs');

test('partial keeper append contributes no identity evidence', () => {
  const node = process.execPath;
  const fixture = 'external-bots-group-decisions.e2e.js';
  const events = [{ schema: 1, kind: 'guard-issued-server', parentPid: 22, pid: 33, at: 100 },
    { schema: 1, kind: 'guard-server-close', parentPid: 22, pid: 33, at: 300 }];
  const raw = [
    { schema: 1, sample: 1, at: 200, pid: 33, parentPid: 22, creation: '134000000000000003', exactJob: true, image: node },
    { schema: 1, sample: 1, at: 200, pid: 22, parentPid: 11, creation: '134000000000000002', exactJob: true, image: node }
  ];
  const packed = JSON.stringify({ sample: 1, rows: raw }) + '\n';
  const second = JSON.stringify({ sample: 2, rows: raw.map(r => ({ ...r, sample: 2 })) });
  assert.equal(matchIdentity(events, completeSamples(packed + second.slice(0, -4)), 22, node, 11, fixture), true);
  assert.equal(matchIdentity(events, completeSamples(packed.trimEnd()), 22, node, 11, fixture), false);
  assert.equal(matchIdentity(events, completeSamples(JSON.stringify({ sample: 1, rows: raw.slice(0, 1) }) + '\n'),
    22, node, 11, fixture), false);
  assert.throws(() => completeSamples(packed + '{broken}\n'), SyntaxError);
  assert.throws(() => completeSamples(packed + JSON.stringify({ sample: 1, rows: [] }) + '\n'), /M5_SAMPLE_FRAME/);
});
