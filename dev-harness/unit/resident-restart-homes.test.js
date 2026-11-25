'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { modelHomeIdentity, snapshotRetiredHome, assertRetainedHomes } = require('../lib/resident-restart-homes.cjs');

test('restart evidence rejects changed retained bytes, a replaced directory and a mismatched owner', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ruyi-restart-home-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const token = 'a'.repeat(24), home = path.join(root, token), payload = path.join(home, 'payload');
  const writeOwner = name => fs.writeFileSync(path.join(home, 'OWNER.json'), JSON.stringify({
    owner: 'embeddinggemma2-live-host', token: name, synthetic: false
  }));
  fs.mkdirSync(home);
  writeOwner(token);
  fs.writeFileSync(payload, 'abc');
  const owner = modelHomeIdentity(root, token);
  const records = [snapshotRetiredHome(root, owner)];
  assertRetainedHomes(root, records);
  fs.writeFileSync(payload, 'xyz');
  assert.throws(() => assertRetainedHomes(root, records), /contents must be preserved/);
  fs.writeFileSync(payload, 'abc');
  assertRetainedHomes(root, records);
  fs.renameSync(home, path.join(root, 'original'));
  fs.mkdirSync(home);
  writeOwner(token);
  fs.writeFileSync(payload, 'abc');
  assert.throws(() => assertRetainedHomes(root, records), /must match the original/);
  writeOwner('b'.repeat(24));
  assert.throws(() => modelHomeIdentity(root, token), assert.AssertionError);
});
