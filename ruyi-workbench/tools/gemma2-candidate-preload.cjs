'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Loaded only by the candidate launcher. Keep drive letters and extraction paths
// out of the ZIP. The worker receives the same absolute, hash-pinned contract.
const root = path.resolve(__dirname, '..', '..');
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'portable-lock.json'), 'utf8'));
function resolveMember(relative) {
  const file = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !file.startsWith(root + path.sep)) throw Error('Invalid candidate member');
  return file;
}
for (const key of ['assetsRoot', 'runtimeRoot', 'workerFile']) lock[key] = resolveMember(lock[key]);
for (const binding of [...lock.sourceBindings, ...lock.licenseBindings, lock.node]) binding.file = resolveMember(binding.file);
require(path.join(root, 'semantic-runtime/gemma2-profile-validation.cjs')).validate(lock);
const bytes = Buffer.from(JSON.stringify(lock));
const pin = crypto.createHash('sha256').update(bytes).digest('hex');
const profile = path.join(fs.realpathSync(os.tmpdir()), 'ruyi-gemma2-' + pin);
fs.mkdirSync(profile, {recursive: true, mode: 0o700});
if (fs.realpathSync(profile) !== profile) throw Error('Invalid candidate profile');
const file = path.join(profile, 'asset-lock.json');
if (!fs.existsSync(file)) {
  const staging = path.join(profile, crypto.randomUUID() + '.tmp');
  fs.writeFileSync(staging, bytes, {flag: 'wx', mode: 0o600});
  try { fs.linkSync(staging, file); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { fs.unlinkSync(staging); }
}
if (fs.realpathSync(file) !== file || !fs.readFileSync(file).equals(bytes)) throw Error('Invalid candidate lock');
Object.assign(process.env, {
  RUYI_DISABLE_SEMANTIC: '0', RUYI_SEMANTIC_BACKEND: 'gemma2',
  RUYI_SEMANTIC_GEMMA2_ROOT: profile, RUYI_SEMANTIC_GEMMA2_LOCK_SHA256: pin,
});
