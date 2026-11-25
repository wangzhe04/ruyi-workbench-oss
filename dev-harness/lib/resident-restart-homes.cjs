'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  assert.ok(stat.isDirectory() && stat.ino > 0n, 'expected an identifiable directory');
  assert.equal(path.relative(directory, fs.realpathSync.native(directory)), '', 'fixture directory must be direct');
  return { directory, volume: String(stat.dev), id: String(stat.ino) };
}

function modelHomeIdentity(root, home) {
  assert.match(home, /^[a-f0-9]{24}$/);
  const directory = path.join(root, home);
  const identity = directoryIdentity(directory);
  const marker = path.join(directory, 'OWNER.json');
  const markerStat = fs.lstatSync(marker, { bigint: true });
  assert.ok(markerStat.isFile(), 'expected a regular owner marker');
  const bytes = fs.readFileSync(marker);
  const value = JSON.parse(bytes);
  assert.equal(value.owner, 'embeddinggemma2-live-host');
  assert.equal(value.token, home);
  assert.equal(value.synthetic, false);
  return { home, ...identity, ownerId: String(markerStat.ino), ownerSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

// Only called for the private home after the original worker's exit has been proved.
function snapshotRetiredHome(root, identity) {
  assert.deepEqual(modelHomeIdentity(root, identity.home), identity, 'retired directory and owner marker must match the original');
  const rows = [];
  function visit(directory, relative) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), rel = relative + '/' + name;
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isDirectory()) {
        directoryIdentity(file);
        rows.push([rel, 'directory', String(stat.ino)]);
        visit(file, rel);
      } else {
        assert.ok(stat.isFile(), 'retired scene contains an unexpected non-regular file');
        rows.push([rel, 'file', String(stat.ino), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
      }
    }
  }
  visit(path.join(root, identity.home), '');
  return { identity, digest: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}

function assertRetainedHomes(root, snapshots) {
  for (const record of snapshots) {
    assert.deepEqual(snapshotRetiredHome(root, record.identity), record, 'retired model home contents must be preserved');
  }
}

module.exports = { directoryIdentity, modelHomeIdentity, snapshotRetiredHome, assertRetainedHomes };
