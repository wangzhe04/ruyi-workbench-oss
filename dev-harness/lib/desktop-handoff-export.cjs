'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { read } = require('./work-data-production-upload-core');

async function verifyExportPackage({ url, token, id, backups, data, sourceAuthority, record }) {
  const { proof, backupState, ...saved } = record;
  assert.deepEqual([saved.id, saved.operation, saved.state, backupState], [id, 'export', 'verified', 'present']);
  // prepareScene creates a fresh, unencrypted root for this handoff.
  assert.deepEqual(sourceAuthority, { generation: 0, id: null, mode: 'plain', sha256: null }, 'expected fresh plaintext authority');
  assert.deepEqual(saved.sourceAuthority, sourceAuthority);
  assert.deepEqual(saved.authority, sourceAuthority);
  const name = 'ruyi-work-data-' + id + '.ruyi-backup';
  const file = path.join(backups, name);
  assert.equal(saved.backup.path, file);
  const durable = read(path.join(data, '.work-data', 'maintenance-result-v1.json'));
  assert.deepEqual(JSON.parse(durable.bytes), saved, 'successor reports the durable result for the submitted export');
  assert.deepEqual(proof, { sha256: durable.row.sha256, identity: { dev: durable.row.dev, ino: durable.row.ino } });
  const disk = read(file);
  assert.ok(disk.row.bytes > 0);
  assert.deepEqual(saved.backup, {
    path: file, bytes: disk.row.bytes, sha256: disk.row.sha256, identity: { dev: disk.row.dev, ino: disk.row.ino }
  });

  const response = await fetch(new URL('/api/work-data/results/' + id + '/package', url), {
    headers: { 'x-wcw-token': token }, signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  try {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-length'), String(disk.row.bytes));
    let offset = 0;
    for await (const piece of response.body) {
      const chunk = Buffer.from(piece);
      assert.ok(disk.bytes.subarray(offset, offset + chunk.length).equals(chunk), 'downloaded export differs from the verified disk package');
      offset += chunk.length;
    }
    assert.equal(offset, disk.row.bytes, 'successor served the whole package');
  } finally {
    if (!response.bodyUsed) await response.body?.cancel();
  }
  return { bytes: disk.row.bytes, sha256: disk.row.sha256, recordSha256: durable.row.sha256 };
}

module.exports = { verifyExportPackage };
