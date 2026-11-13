'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { inventory, treeDigest, sha256 } = require('../../ruyi-workbench/tools/macos-offline-lib');
const { verifyTrialDirectory, verifyDistribution, signatureTarget, installTrial, buildTrial } = require('../../ruyi-workbench/tools/package-macos-trial');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trial-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = path.join(root, 'image'); fs.mkdirSync(path.join(image, 'Ruyi.app'), { recursive: true });
  fs.writeFileSync(path.join(image, 'Ruyi.app/file'), 'payload');
  const guideHashes = {};
  for (const name of ['INSTALL-CN.txt', 'INSTALL-EN.txt']) { fs.writeFileSync(path.join(image, name), name); guideHashes[name] = sha256(path.join(image, name)); }
  fs.symlinkSync('/Applications', path.join(image, 'Applications'));
  const files = inventory(path.join(image, 'Ruyi.app'));
  const packaging = { packagerCommit: 'b'.repeat(40), packagerFingerprint: {}, inputPackageManifestSha256: 'c'.repeat(64), inputAppTreeSha256: 'd'.repeat(64), signatures: {} };
  const manifest = { schemaVersion: 1, app: 'Ruyi.app', variant: 'slim', sourceCommit: 'a'.repeat(40), signing: 'ad-hoc-internal-trial',
    notarized: false, files, treeSha256: treeDigest(files), packaging };
  fs.writeFileSync(path.join(image, 'package-manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(image, 'SHA256SUMS'), sha256(path.join(image, 'package-manifest.json')) + '  package-manifest.json\n');
  const trial = { schemaVersion: 1, channel: 'local-internal-trial', variant: 'slim', signing: manifest.signing, notarized: false,
    developerIdentityVerified: false, applicationSourceCommit: manifest.sourceCommit, ...packaging,
    appTreeSha256: manifest.treeSha256, packageManifestSha256: sha256(path.join(image, 'package-manifest.json')), guideHashes };
  fs.writeFileSync(path.join(image, 'trial-manifest.json'), JSON.stringify(trial));
  return { root, image, trial };
}
test('trial integrity binds guides, payload, policy, provenance and the one explicit Applications shortcut', { skip: process.platform === 'win32' }, t => {
  const { image, trial } = fixture(t);
  assert.equal(verifyTrialDirectory(image).manifest.variant, 'slim');
  fs.writeFileSync(path.join(image, 'INSTALL-CN.txt'), 'changed'); assert.throws(() => verifyTrialDirectory(image), /guide/);
  fs.writeFileSync(path.join(image, 'INSTALL-CN.txt'), 'INSTALL-CN.txt');
  fs.unlinkSync(path.join(image, 'Applications')); fs.symlinkSync('/tmp', path.join(image, 'Applications'));
  assert.throws(() => verifyTrialDirectory(image), /shortcut/); fs.unlinkSync(path.join(image, 'Applications')); fs.symlinkSync('/Applications', path.join(image, 'Applications'));
  fs.writeFileSync(path.join(image, 'extra'), 'extra'); assert.throws(() => verifyTrialDirectory(image), /contents/); fs.unlinkSync(path.join(image, 'extra'));
  fs.writeFileSync(path.join(image, 'trial-manifest.json'), JSON.stringify({ ...trial, packagerCommit: 'e'.repeat(40) }));
  assert.throws(() => verifyTrialDirectory(image), /provenance fields/);
  fs.writeFileSync(path.join(image, 'trial-manifest.json'), JSON.stringify({ ...trial, notarized: true })); assert.throws(() => verifyTrialDirectory(image), /policy/);
});
test('new-location installation refuses existing directories and dangling links without changing them', { skip: process.platform === 'win32' }, t => {
  const { root, image } = fixture(t); const applications = path.join(root, 'Applications'); fs.mkdirSync(applications);
  const destination = path.join(applications, 'Ruyi.app'); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'keep'), 'original');
  assert.throws(() => installTrial(image, applications), /EEXIST/); assert.equal(fs.readFileSync(path.join(destination, 'keep'), 'utf8'), 'original');
  fs.rmSync(destination, { recursive: true }); fs.symlinkSync('missing', destination);
  assert.throws(() => installTrial(image, applications), /EEXIST/); assert.equal(fs.readlinkSync(destination), 'missing');
});
test('resource-bearing code targets resolve to the correct nearest app/framework container', { skip: process.platform === 'win32' }, () => {
  const app = path.resolve('/tmp/Ruyi.app');
  assert.equal(signatureTarget(app, 'Contents/MacOS/RuyiDesktop'), app);
  assert.equal(signatureTarget(app, 'Contents/Resources/Chrome.app/Contents/MacOS/Chrome'), path.join(app, 'Contents/Resources/Chrome.app'));
  assert.equal(signatureTarget(app, 'Contents/Resources/Foo.framework/Versions/1/Foo'), path.join(app, 'Contents/Resources/Foo.framework'));
  assert.equal(signatureTarget(app, 'Contents/Resources/module.so'), path.join(app, 'Contents/Resources/module.so'));
});
test('distribution verification refuses corrupt images, sidecars and provenance before mounting', { skip: process.platform === 'win32' }, t => {
  const { image, trial } = fixture(t); const name = 'trial.dmg'; fs.writeFileSync(path.join(image, name), 'fake image bytes');
  const hash = sha256(path.join(image, name)); const data = { ...trial, image: name, imageSha256: hash, imageBytes: fs.statSync(path.join(image, name)).size };
  fs.writeFileSync(path.join(image, name + '.sha256'), hash + '  ' + name + '\n'); fs.writeFileSync(path.join(image, 'distribution.json'), JSON.stringify(data));
  assert.equal(verifyDistribution(image).image, name);
  fs.appendFileSync(path.join(image, name), 'corrupt'); assert.throws(() => verifyDistribution(image), /checksum/); fs.writeFileSync(path.join(image, name), 'fake image bytes');
  fs.writeFileSync(path.join(image, 'distribution.json'), JSON.stringify({ ...data, packagerCommit: 'f'.repeat(40) })); assert.throws(() => verifyDistribution(image), /provenance/);
  fs.writeFileSync(path.join(image, 'distribution.json'), JSON.stringify({ ...data, image: '../trial.dmg' })); assert.throws(() => verifyDistribution(image), /Invalid distribution/);
});
test('trial build refuses source overlap and cleans its exclusively reserved output on early failure', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, t => {
  const { root, image } = fixture(t); const manifestPath = path.join(image, 'package-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath)); manifest.signing = 'ad-hoc-development'; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => buildTrial({ package: image, output: path.join(image, 'Ruyi.app', 'new') }), /overlap/);
  assert.equal(fs.existsSync(path.join(image, 'Ruyi.app/new')), false);
  const original = fs.mkdtempSync, output = path.join(root, 'output');
  try {
    fs.mkdtempSync = () => { throw new Error('injected temp failure'); };
    assert.throws(() => buildTrial({ package: image, output }), /injected temp failure/);
  } finally { fs.mkdtempSync = original; }
  assert.equal(fs.existsSync(output), false);
});
