'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verify, copy } = require('../../ruyi-workbench/tools/node-license-materials.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-node-notices-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const node = path.join(root, 'input.exe');
  fs.writeFileSync(node, 'test binary identity');
  const binary = { bytes: fs.statSync(node).size, sha256: sha(fs.readFileSync(node)) };
  const archive = { file: 'test.zip', sha256: sha('test archive identity') };
  const contents = {
    LICENSE: 'Complete test license\r\nThird-party notices\r\n',
    'SHASUMS256.txt': `${binary.sha256}  win-x64/node.exe\n${archive.sha256}  ${archive.file}\n`,
    'NOTICE.md': 'Source notice\n',
  };
  const files = Object.entries(contents).map(([file, bytes]) => {
    fs.writeFileSync(path.join(root, file), bytes);
    return { file, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) };
  });
  const lock = { schemaVersion: 1, version: 'v24.14.0', platform: 'win-x64', binary, archive, files };
  fs.writeFileSync(path.join(root, 'provenance.lock.json'), JSON.stringify(lock));
  return { root, node, lock };
}
test('copy retains exact license bytes and validates the copied executable and manifest', t => {
  const f = fixture(t), target = path.join(f.root, 'stage');
  assert.equal(copy(f.node, f.root, target).filesVerified, 5);
  for (const file of ['LICENSE', 'NOTICE.md', 'SHASUMS256.txt', 'provenance.lock.json']) {
    assert.deepEqual(fs.readFileSync(path.join(target, file)), fs.readFileSync(path.join(f.root, file)));
  }
  assert.equal(verify(path.join(target, 'node.exe'), target).lock.binary.sha256, f.lock.binary.sha256);
});
test('a different Node binary fails before a destination is created', t => {
  const f = fixture(t), target = path.join(f.root, 'stage');
  fs.appendFileSync(f.node, 'changed');
  assert.throws(() => copy(f.node, f.root, target), /differs from the pinned official runtime/);
  assert.equal(fs.existsSync(target), false);
});
test('missing, truncated or EOL-normalized original license is rejected', t => {
  const f = fixture(t), license = path.join(f.root, 'LICENSE'), original = fs.readFileSync(license);
  fs.writeFileSync(license, original.toString().replace(/\r\n/g, '\n'));
  assert.throws(() => verify(f.node, f.root), /material mismatch: LICENSE/);
  fs.writeFileSync(license, original.subarray(0, 8));
  assert.throws(() => verify(f.node, f.root), /material mismatch: LICENSE/);
  fs.unlinkSync(license);
  assert.throws(() => verify(f.node, f.root), /ENOENT/);
});
test('self-consistent checksums lacking the binary entry are rejected', t => {
  const f = fixture(t), bytes = `${f.lock.archive.sha256}  ${f.lock.archive.file}\n`;
  fs.writeFileSync(path.join(f.root, 'SHASUMS256.txt'), bytes);
  Object.assign(f.lock.files[1], { bytes: Buffer.byteLength(bytes), sha256: sha(bytes) });
  fs.writeFileSync(path.join(f.root, 'provenance.lock.json'), JSON.stringify(f.lock));
  assert.throws(() => verify(f.node, f.root), /missing from official release checksums/);
});
test('material names cannot traverse out of the pinned notice directory', t => {
  const f = fixture(t);
  f.lock.files[0].file = '../LICENSE';
  fs.writeFileSync(path.join(f.root, 'provenance.lock.json'), JSON.stringify(f.lock));
  assert.throws(() => verify(f.node, f.root), /Invalid Node license material lock/);
});
