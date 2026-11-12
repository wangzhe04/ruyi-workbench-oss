'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inventory, treeDigest, verifyAssets, verifyPackage, safeChild, nativeAudit, run } = require('../../ruyi-workbench/tools/macos-offline-lib');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-offline-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('payload checks detect byte changes, unexpected files, executable mode changes and missing files', t => {
  const root = fixture(t), app = path.join(root, 'Ruyi.app');
  fs.mkdirSync(app);
  const file = path.join(app, 'launcher');
  fs.writeFileSync(file, 'original'); fs.chmodSync(file, 0o755);
  const files = inventory(app);
  fs.writeFileSync(path.join(root, 'package-manifest.json'), JSON.stringify({ schemaVersion: 1, app: 'Ruyi.app', variant: 'full', files, treeSha256: treeDigest(files) }));
  assert.equal(verifyPackage(root).variant, 'full');
  fs.writeFileSync(file, 'tampered'); assert.throws(() => verifyPackage(root), /integrity/);
  fs.writeFileSync(file, 'original');
  fs.writeFileSync(path.join(app, 'extra'), 'x'); assert.throws(() => verifyPackage(root), /integrity/); fs.unlinkSync(path.join(app, 'extra'));
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o644); assert.throws(() => verifyPackage(root), /integrity/); fs.chmodSync(file, 0o755); }
  fs.unlinkSync(file); assert.throws(() => verifyPackage(root), /integrity/);
});
test('relative internal framework links remain movable; absolute, broken and external links are refused', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t), payload = path.join(root, 'payload'); fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, 'real'), 'x'); fs.symlinkSync('real', path.join(payload, 'link'));
  const before = treeDigest(inventory(payload)); fs.renameSync(payload, path.join(root, '搬移 路径😀'));
  assert.equal(treeDigest(inventory(path.join(root, '搬移 路径😀'))), before);
  fs.symlinkSync('../missing', path.join(root, '搬移 路径😀', 'bad')); assert.throws(() => inventory(path.join(root, '搬移 路径😀')));
  fs.unlinkSync(path.join(root, '搬移 路径😀', 'bad'));
  fs.symlinkSync(path.join(root, '搬移 路径😀', 'real'), path.join(root, '搬移 路径😀', 'bad'));
  assert.throws(() => inventory(path.join(root, '搬移 路径😀')), /Unsafe/);
});
test('an App root replaced with a symlink to an external copy is refused', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t), real = path.join(root, 'external'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'file'), 'x');
  const files = inventory(real);
  fs.writeFileSync(path.join(root, 'package-manifest.json'), JSON.stringify({ schemaVersion: 1, app: 'Ruyi.app', variant: 'full', files, treeSha256: treeDigest(files) }));
  fs.symlinkSync(real, path.join(root, 'Ruyi.app')); assert.throws(() => verifyPackage(root), /real directory/);
});
test('asset lock rejects changed components and missing provenance before building', t => {
  const root = fixture(t); fs.mkdirSync(path.join(root, 'node')); fs.mkdirSync(path.join(root, 'rg'));
  for (const directory of ['node', 'rg']) fs.writeFileSync(path.join(root, directory, 'LICENSE'), 'license');
  const lock = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', components: [['node', 'node'], ['ripgrep', 'rg']].map(([id, directory]) => ({
    id, path: directory, version: '1', treeSha256: treeDigest(inventory(path.join(root, directory))), licenseFiles: ['LICENSE'], sources: [{ url: 'https://example.test/source' }],
  })) };
  assert.ok(verifyAssets(root, lock, 'slim').node);
  fs.writeFileSync(path.join(root, 'rg', 'LICENSE'), 'changed'); assert.throws(() => verifyAssets(root, lock, 'slim'), /hash mismatch/);
  lock.components[0].sources = []; assert.throws(() => verifyAssets(root, lock, 'slim'), /Incomplete/);
});
test('manifest paths cannot escape their payload root', t => {
  const root = fixture(t);
  for (const input of ['/absolute', '../escape', 'a/../../escape', 'a\\b', '', 'a//b']) assert.throws(() => safeChild(root, input));
  assert.equal(safeChild(root, 'a/b'), path.join(root, 'a/b'));
});
test('native audit rejects a real missing loader-relative dylib', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, t => {
  const root = fixture(t); const source = path.join(root, 'library.c'), main = path.join(root, 'main.c');
  fs.writeFileSync(source, 'int sample(void) { return 0; }\n');
  fs.writeFileSync(main, 'int sample(void); int main(void) { return sample(); }\n');
  run('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=14.0', '-dynamiclib', source, '-install_name', '@loader_path/libsample.dylib', '-o', path.join(root, 'libsample.dylib')]);
  run('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=14.0', main, '-L' + root, '-lsample', '-o', path.join(root, 'app')]);
  assert.ok(nativeAudit(root).length >= 2);
  fs.unlinkSync(path.join(root, 'libsample.dylib')); assert.throws(() => nativeAudit(root), /Unresolved/);
});
