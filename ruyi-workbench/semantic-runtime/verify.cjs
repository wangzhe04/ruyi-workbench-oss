'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { modelFingerprint } = require('./protocol.cjs');
const sha256 = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  stream.on('error', reject); stream.on('data', chunk => hash.update(chunk)); stream.on('end', () => resolve(hash.digest('hex')));
});
async function verifyRuntimeAssets(root) {
  const inventoryPath = path.join(__dirname, `runtime-assets.${process.platform}-${process.arch}.lock.json`);
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const expected = new Set(inventory.files.map(file => file.path));
  // Exact inventory prevents adding a nearer nested package that changes Node resolution.
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('RUNTIME_INTEGRITY_FAILED');
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (!entry.isFile() || !expected.delete(relative)) throw new Error('RUNTIME_INTEGRITY_FAILED');
    }
  }
  walk(path.join(root, 'node_modules')); if (expected.size) throw new Error('RUNTIME_INTEGRITY_FAILED');
  for (const file of inventory.files) { const absolute = path.join(root, 'node_modules', file.path); if (fs.statSync(absolute).size !== file.bytes || await sha256(absolute) !== file.sha256) throw new Error('RUNTIME_INTEGRITY_FAILED'); }
  return sha256(inventoryPath);
}
async function verify(root, modelId) {
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'models.lock.json'), 'utf8'));
  const model = lock.models.find(m => m.id === (modelId || lock.defaultModel));
  if (!model || !model.files.length) throw new Error('MODEL_NOT_INSTALLED');
  const modelDir = path.join(root, 'models', model.id);
  for (const file of model.files) {
    if (!/^[\w./-]+$/.test(file.path) || file.path.split('/').includes('..')) throw new Error('INVALID_MODEL_LOCK');
    const absolute = path.join(modelDir, file.path);
    if (fs.statSync(absolute).size !== file.bytes || await sha256(absolute) !== file.sha256) throw new Error('MODEL_INTEGRITY_FAILED');
  }
  const packageLockHash = await sha256(path.join(__dirname, 'package-lock.json'));
  if (await sha256(path.join(root, 'package-lock.json')) !== packageLockHash) throw new Error('RUNTIME_LOCK_MISMATCH');
  const runtimeAssetsHash = await verifyRuntimeAssets(root);
  const implementationHash = crypto.createHash('sha256').update(JSON.stringify({ files: await Promise.all(['worker.cjs', 'protocol.cjs', 'verify.cjs'].map(file => sha256(path.join(__dirname, file)))), runtimeOptions: { disableArena: process.env.RUYI_SEMANTIC_DISABLE_ARENA === '1' } })).digest('hex');
  return { model, modelDir, modelFingerprint: modelFingerprint(model, packageLockHash, runtimeAssetsHash, implementationHash) };
}
if (require.main === module) verify(path.resolve(process.argv[2] || ''), process.argv[3]).then(r => console.log(JSON.stringify({ ok: true, modelId: r.model.id, modelFingerprint: r.modelFingerprint }))).catch(() => { console.error(JSON.stringify({ ok: false, error: { code: 'VERIFICATION_FAILED' } })); process.exitCode = 1; });
module.exports = { verify, verifyRuntimeAssets, sha256 };
