#!/usr/bin/env node
'use strict';
// P6-02 local/internal trial distribution. No Developer ID, notarization or policy bypass.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sha256, inventory, treeDigest, copyTree, run, safeChild, inside, verifyPackage } = require('./macos-offline-lib');
const guideRoot = path.resolve(__dirname, '../desktop-macos/trial');
const GUIDE_NAMES = ['INSTALL-CN.txt', 'INSTALL-EN.txt'];
const ROOT_NAMES = ['Applications', 'Ruyi.app', 'package-manifest.json', 'SHA256SUMS', 'trial-manifest.json', ...GUIDE_NAMES].sort();
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function canonicalDestination(file) {
  let ancestor = path.resolve(file); const suffix = [];
  while (!exists(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}
function parsePlist(value) { return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: value })); }
function signatureTarget(app, relative) {
  const file = safeChild(app, relative);
  const application = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(file);
  if (application) return application[1];
  const framework = /^(.*\.framework)\//.exec(file);
  if (framework && path.basename(file) === path.basename(framework[1], '.framework')) return framework[1];
  return file;
}
function signTrial(app) {
  const records = JSON.parse(fs.readFileSync(path.join(app, 'Contents/Resources/workbench/native-dependencies.json'), 'utf8'));
  const actual = inventory(app).filter(entry => {
    if (entry.type !== 'file' || entry.bytes < 4) return false;
    const fd = fs.openSync(safeChild(app, entry.path), 'r'), magic = Buffer.alloc(4);
    try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
    return ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'cafebabf'].includes(magic.toString('hex'));
  }).map(entry => entry.path).sort();
  if (!Array.isArray(records) || JSON.stringify(records.map(item => item.path).sort()) !== JSON.stringify(actual)) throw new Error('Native signing inventory differs from actual payload');
  const changes = [];
  const checkedTargets = new Set();
  const repairs = [];
  for (const item of records) {
    const file = safeChild(app, item.path);
    if (!inside(fs.realpathSync(app), fs.realpathSync(file))) throw new Error('Native code escapes App');
    const target = signatureTarget(app, item.path);
    if (target !== app && !checkedTargets.has(target)) {
      try { run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]); }
      catch (error) {
        if (error.message.includes('not signed at all') && target === file) {
          const before = sha256(file);
          run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
          run('/usr/bin/codesign', ['--verify', '--strict', file]);
          changes.push({ path: item.path, beforeSha256: before, afterSha256: sha256(file), action: 'ad-hoc-sign-previously-unsigned' });
        } else {
          if (!target.includes('/playwright_browsers/') || !fs.statSync(target).isDirectory()
            || !error.message.includes('code has no resources but signature indicates they must be present')) throw error;
          repairs.push({ target, beforeTreeSha256: treeDigest(inventory(target)), reason: 'missing-resource-seal' });
        }
      }
      checkedTargets.add(target);
    }
  }
  // Chromium's linker-signed executables may be shipped without App/framework resource seals.
  // Repair only this explicit, hash-bound case, inside-out, before sealing the enclosing Ruyi App.
  repairs.sort((a, b) => b.target.split(path.sep).length - a.target.split(path.sep).length);
  for (const repair of repairs) {
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=identifier,entitlements', repair.target]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', repair.target]);
    changes.push({ path: path.relative(app, repair.target).split(path.sep).join('/'),
      beforeTreeSha256: repair.beforeTreeSha256, afterTreeSha256: treeDigest(inventory(repair.target)), action: 'ad-hoc-rebuild-missing-resource-seal' });
  }
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  // Verify each individual code object or its resource-bearing container after the final seal.
  for (const target of new Set(records.map(item => signatureTarget(app, item.path)))) {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
  }
  return { nativeCount: records.length, changes, signing: 'ad-hoc-internal-trial', notarized: false,
    developerIdentityVerified: false, signedDependencyPolicy: 'preserve-existing-valid-signatures' };
}
function verifyTrialDirectory(directory) {
  const names = fs.readdirSync(directory).sort();
  if (JSON.stringify(names) !== JSON.stringify(ROOT_NAMES)) throw new Error('Unexpected trial image contents');
  const link = path.join(directory, 'Applications');
  if (!fs.lstatSync(link).isSymbolicLink() || fs.readlinkSync(link) !== '/Applications') throw new Error('Invalid Applications shortcut');
  for (const name of [...GUIDE_NAMES, 'package-manifest.json', 'trial-manifest.json', 'SHA256SUMS']) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Trial metadata must be regular files');
  }
  const trial = JSON.parse(fs.readFileSync(path.join(directory, 'trial-manifest.json'), 'utf8'));
  if (trial.schemaVersion !== 1 || trial.channel !== 'local-internal-trial' || trial.notarized !== false
    || trial.signing !== 'ad-hoc-internal-trial' || trial.developerIdentityVerified !== false) throw new Error('Invalid trial policy');
  const packageFile = path.join(directory, 'package-manifest.json');
  if (sha256(packageFile) !== trial.packageManifestSha256) throw new Error('Trial package manifest differs');
  if (fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8') !== sha256(packageFile) + '  package-manifest.json\n') throw new Error('Package checksum differs');
  for (const name of GUIDE_NAMES) if (sha256(path.join(directory, name)) !== trial.guideHashes[name]) throw new Error('Install guide differs');
  const manifest = verifyPackage(directory);
  if (manifest.signing !== trial.signing || manifest.treeSha256 !== trial.appTreeSha256 || manifest.sourceCommit !== trial.applicationSourceCommit
    || manifest.variant !== trial.variant) throw new Error('Trial provenance differs');
  const packaging = manifest.packaging;
  for (const key of ['packagerCommit', 'packagerFingerprint', 'inputPackageManifestSha256', 'inputAppTreeSha256', 'signatures']) {
    if (JSON.stringify(packaging?.[key]) !== JSON.stringify(trial[key])) throw new Error('Trial provenance fields disagree: ' + key);
  }
  return { trial, manifest };
}
function verifyDistribution(directory) {
  for (const name of ['distribution.json', 'trial-manifest.json']) {
    if (!fs.lstatSync(path.join(directory, name)).isFile() || fs.lstatSync(path.join(directory, name)).isSymbolicLink()) throw new Error('Distribution metadata must be regular files');
  }
  const data = JSON.parse(fs.readFileSync(path.join(directory, 'distribution.json'), 'utf8'));
  const { image, imageSha256, imageBytes, ...trial } = data;
  if (typeof image !== 'string' || path.basename(image) !== image || !image.endsWith('.dmg') || !/^[a-f0-9]{64}$/.test(imageSha256)) throw new Error('Invalid distribution image');
  const file = safeChild(directory, image);
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()
    || fs.statSync(file).size !== imageBytes || sha256(file) !== imageSha256) throw new Error('Distribution image checksum differs');
  if (!fs.lstatSync(file + '.sha256').isFile() || fs.lstatSync(file + '.sha256').isSymbolicLink()) throw new Error('Distribution checksum must be a regular file');
  if (fs.readFileSync(file + '.sha256', 'utf8') !== imageSha256 + '  ' + image + '\n') throw new Error('Distribution checksum sidecar differs');
  if (JSON.stringify(trial) !== JSON.stringify(JSON.parse(fs.readFileSync(path.join(directory, 'trial-manifest.json'), 'utf8')))) throw new Error('Distribution provenance disagrees');
  if (trial.channel !== 'local-internal-trial' || trial.notarized !== false || trial.developerIdentityVerified !== false) throw new Error('Invalid distribution trust policy');
  return data;
}
function attachTrial(image, mountpoint) {
  if (exists(mountpoint)) throw new Error('Mountpoint already exists');
  fs.mkdirSync(mountpoint, { mode: 0o700 });
  const reservation = fs.lstatSync(mountpoint);
  try {
    const result = parsePlist(run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, '-plist', image]));
    const entity = result['system-entities']?.find(item => item['mount-point']);
    if (!entity || fs.realpathSync(entity['mount-point']) !== fs.realpathSync(mountpoint)) throw new Error('Unexpected image mountpoint');
    return entity;
  } catch (error) {
    // Reserve the mount namespace before attaching. Mounting changes its filesystem identity;
    // cleanup does not depend on the plist parser that may itself have failed.
    if (exists(mountpoint)) {
      const current = fs.lstatSync(mountpoint);
      if (current.dev !== reservation.dev || current.ino !== reservation.ino) detachTrial(mountpoint);
      const restored = fs.lstatSync(mountpoint);
      if (restored.dev === reservation.dev && restored.ino === reservation.ino) fs.rmdirSync(mountpoint);
    }
    throw error;
  }
}
function detachTrial(mountpoint) { run('/usr/bin/hdiutil', ['detach', mountpoint]); }
function verifyInstalledApp(app, manifest) {
  if (fs.lstatSync(app).isSymbolicLink()) throw new Error('Installed App root must be a real directory');
  if (treeDigest(inventory(app)) !== manifest.treeSha256) throw new Error('Installed App integrity differs');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}
function installTrial(directory, applications) {
  const { manifest } = verifyTrialDirectory(directory);
  fs.mkdirSync(applications, { recursive: true });
  const destination = path.join(applications, 'Ruyi.app');
  // Reserve exclusively, including against dangling symlinks. Copy has normal Finder-style
  // progress semantics; this does not claim an atomic App replacement or support upgrades.
  fs.mkdirSync(destination);
  const identity = fs.lstatSync(destination);
  try {
    run('/usr/bin/ditto', [path.join(directory, 'Ruyi.app'), destination]);
    verifyInstalledApp(destination, manifest);
    return destination;
  } catch (error) {
    const current = fs.lstatSync(destination);
    if (current.dev === identity.dev && current.ino === identity.ino && current.isDirectory()) fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
function buildTrial({ package: source, output }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an arm64 Mac');
  if (!source || !output) throw new Error('Use --package DIR --output NEW_DIR');
  source = fs.realpathSync(source); output = canonicalDestination(output);
  if (inside(source, output) || inside(output, source)) throw new Error('Trial output must not overlap its source candidate');
  const original = verifyPackage(source);
  if (original.signing !== 'ad-hoc-development' || original.notarized !== false) throw new Error('Expected a frozen P6-01 development candidate');
  const inputManifestHash = sha256(path.join(source, 'package-manifest.json'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  const outputIdentity = fs.lstatSync(output);
  let work = '', mount = '';
  let attached = false;
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trial-build-'));
    const imageRoot = path.join(work, 'image');
    mount = path.join(work, 'mount');
    const materials = [__filename, path.join(__dirname, 'macos-offline-lib.js'), ...GUIDE_NAMES.map(name => path.join(guideRoot, name))];
    const fingerprints = Object.fromEntries(materials.map(file => [path.relative(path.resolve(__dirname, '../..'), file), sha256(file)]));
    fs.mkdirSync(imageRoot);
    copyTree(path.join(source, 'Ruyi.app'), path.join(imageRoot, 'Ruyi.app'));
    const signatures = signTrial(path.join(imageRoot, 'Ruyi.app'));
    const files = inventory(path.join(imageRoot, 'Ruyi.app'));
    const wrapperCommit = run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../..') });
    const manifest = { ...original, signing: signatures.signing, files, treeSha256: treeDigest(files),
      packaging: { channel: 'local-internal-trial', packagerCommit: wrapperCommit, packagerFingerprint: fingerprints,
        inputPackageManifestSha256: inputManifestHash, inputAppTreeSha256: original.treeSha256, signatures } };
    writeJson(path.join(imageRoot, 'package-manifest.json'), manifest);
    fs.writeFileSync(path.join(imageRoot, 'SHA256SUMS'), sha256(path.join(imageRoot, 'package-manifest.json')) + '  package-manifest.json\n');
    const guideHashes = {};
    for (const name of GUIDE_NAMES) { fs.copyFileSync(path.join(guideRoot, name), path.join(imageRoot, name)); guideHashes[name] = sha256(path.join(imageRoot, name)); }
    fs.symlinkSync('/Applications', path.join(imageRoot, 'Applications'));
    const trial = { schemaVersion: 1, channel: 'local-internal-trial', variant: original.variant, version: original.version,
      signing: signatures.signing, notarized: false, developerIdentityVerified: false,
      applicationSourceCommit: original.sourceCommit, packagerCommit: wrapperCommit, packagerFingerprint: fingerprints,
      inputPackageManifestSha256: inputManifestHash, inputAppTreeSha256: original.treeSha256,
      appTreeSha256: manifest.treeSha256, packageManifestSha256: sha256(path.join(imageRoot, 'package-manifest.json')), guideHashes, signatures,
      acceptanceScope: 'current-account isolated install; clean standard user and downloaded-origin Gatekeeper approval unverified' };
    writeJson(path.join(imageRoot, 'trial-manifest.json'), trial);
    verifyTrialDirectory(imageRoot);
    const name = 'Ruyi-macos-arm64-' + original.variant + '-internal-trial.dmg';
    const image = path.join(work, name);
    run('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', imageRoot, '-fs', 'HFS+', '-format', 'UDZO',
      '-volname', 'Ruyi ' + original.variant + ' Internal Trial', image], { timeout: 300000 });
    run('/usr/bin/hdiutil', ['verify', image]);
    attachTrial(image, mount); attached = true;
    verifyTrialDirectory(mount);
    detachTrial(mount); attached = false;
    verifyPackage(source);
    if (sha256(path.join(source, 'package-manifest.json')) !== inputManifestHash) throw new Error('Input manifest changed');
    for (const [file, hash] of Object.entries(fingerprints)) if (sha256(path.resolve(__dirname, '../..', file)) !== hash) throw new Error('Trial build source changed');
    fs.copyFileSync(image, path.join(output, name), fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    const imageHash = sha256(path.join(output, name));
    fs.writeFileSync(path.join(output, name + '.sha256'), imageHash + '  ' + name + '\n', { flag: 'wx' });
    writeJson(path.join(output, 'trial-manifest.json'), trial);
    writeJson(path.join(output, 'distribution.json'), { ...trial, image: name, imageSha256: imageHash, imageBytes: fs.statSync(image).size });
    verifyDistribution(output);
    return output;
  } catch (error) {
    const current = fs.lstatSync(output);
    if (current.dev === outputIdentity.dev && current.ino === outputIdentity.ino) fs.rmSync(output, { recursive: true, force: true });
    throw error;
  } finally {
    if (attached) detachTrial(mount);
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.length === 2 && args[0] === '--verify') {
      const data = verifyDistribution(path.resolve(args[1]));
      console.log('Verified ' + data.variant + ' local/internal trial; not notarized');
    } else {
    for (let i = 0; i < args.length; i += 2) {
      if (!['--package', '--output'].includes(args[i]) || !args[i + 1] || options[args[i].slice(2)]) throw new Error('Use --package DIR --output NEW_DIR');
      options[args[i].slice(2)] = args[i + 1];
    }
    console.log(buildTrial(options));
    }
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { buildTrial, verifyTrialDirectory, verifyDistribution, signatureTarget, signTrial, attachTrial, detachTrial, installTrial, verifyInstalledApp };
