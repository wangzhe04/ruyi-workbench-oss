'use strict';
// Offline validation/copy of the independently bundled Node runtime and notices.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const names = ['LICENSE', 'SHASUMS256.txt', 'NOTICE.md'];
function verify(nodePath, materialRoot) {
  const lockBytes = fs.readFileSync(path.join(materialRoot, 'provenance.lock.json'));
  const lock = JSON.parse(lockBytes);
  if (lock.schemaVersion !== 1 || lock.version !== 'v24.14.0' || lock.platform !== 'win-x64'
      || !Array.isArray(lock.files) || lock.files.length !== names.length
      || lock.files.some((row, i) => row.file !== names[i])) throw new Error('Invalid Node license material lock');
  const node = fs.readFileSync(nodePath);
  if (node.length !== lock.binary.bytes || sha(node) !== lock.binary.sha256) {
    throw new Error('Node executable differs from the pinned official runtime; prepare matching license materials before packaging');
  }
  for (const row of lock.files) {
    const bytes = fs.readFileSync(path.join(materialRoot, row.file));
    if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) throw new Error('Node license material mismatch: ' + row.file);
  }
  const checksums = fs.readFileSync(path.join(materialRoot, 'SHASUMS256.txt'), 'utf8');
  if (!checksums.split(/\r?\n/).includes(lock.binary.sha256 + '  win-x64/node.exe')
      || !checksums.split(/\r?\n/).includes(lock.archive.sha256 + '  ' + lock.archive.file)) {
    throw new Error('Node binary/archive identity missing from official release checksums');
  }
  return { lock, lockBytes };
}
function copy(nodePath, materialRoot, destination) {
  const original = verify(nodePath, materialRoot);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(nodePath, path.join(destination, 'node.exe'));
  for (const name of [...names, 'provenance.lock.json']) fs.copyFileSync(path.join(materialRoot, name), path.join(destination, name));
  const copied = verify(path.join(destination, 'node.exe'), destination);
  if (!copied.lockBytes.equals(original.lockBytes)) throw new Error('Node license lock changed during copy');
  return { version: copied.lock.version, binarySha256: copied.lock.binary.sha256,
    licenseSha256: copied.lock.files[0].sha256, filesVerified: names.length + 2 };
}
module.exports = { verify, copy };
if (require.main === module) {
  try {
    const [nodePath, materialRoot, destination] = process.argv.slice(2);
    if (!nodePath || !materialRoot) throw new Error('Usage: node node-license-materials.cjs <node.exe> <materials> [destination]');
    const result = destination ? copy(nodePath, materialRoot, destination) : verify(nodePath, materialRoot).lock;
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1; }
}
