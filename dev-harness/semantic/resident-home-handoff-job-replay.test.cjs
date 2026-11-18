'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./prepare-resident-home-handoff-job-replay.cjs');
const repo = path.resolve(__dirname, '../..');

test('handoff fixture uses the production Windows spawn mode without changing IPC or stream ownership', () => {
  const original = fs.readFileSync(path.join(repo, 'output/home-handoff-replay-cold-pipe-sol-r4/server-cold-pipe.cjs'));
  const revised = fixture(original).toString('utf8');
  const clause = ",detached:process.platform==='win32'";
  assert.equal(revised.split(clause).length, 2);
  assert.equal(revised.replace(clause, ''), original.toString('utf8'));
  const product = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/src/13ai-work-data-worker.js'), 'utf8');
  assert.match(product, /detached: process\.platform === 'win32'/);
  assert.throws(() => fixture(Buffer.from('drift')));
});
