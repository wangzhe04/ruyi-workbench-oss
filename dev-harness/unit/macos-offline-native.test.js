'use strict';
// Independent P6-01 review regressions: each compiler/process uses only a private fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nativeAudit, run, sha256 } = require('../../ruyi-workbench/tools/macos-offline-lib');

const native = process.platform === 'darwin' && process.arch === 'arm64';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-offline-native-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function compile(source, output, flags = []) {
  return run('/usr/bin/xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=14.0', source, ...flags, '-o', output]);
}
function write(root, name, text) {
  const file = path.join(root, name);
  fs.writeFileSync(file, text);
  return file;
}

test('native closure never borrows an unrelated executable rpath for a reachable dylib', { skip: !native }, t => {
  const root = fixture(t);
  const first = path.join(root, 'A'), second = path.join(root, 'B');
  fs.mkdirSync(first); fs.mkdirSync(path.join(second, 'libs'), { recursive: true });
  const sub = write(root, 'sub.c', 'int sub(void) { return 42; }\n');
  const library = write(root, 'library.c', 'int sub(void); int answer(void) { return sub(); }\n');
  const main = write(root, 'main.c', 'int answer(void); int main(void) { return answer() == 42 ? 0 : 1; }\n');
  const other = write(root, 'other.c', 'int main(void) { return 0; }\n');
  const subBinary = path.join(second, 'libs/libsub.dylib');
  const libraryBinary = path.join(first, 'libanswer.dylib');
  compile(sub, subBinary, ['-dynamiclib', '-install_name', '@rpath/libsub.dylib']);
  compile(library, libraryBinary, ['-dynamiclib', '-install_name', '@loader_path/libanswer.dylib', subBinary]);
  compile(main, path.join(first, 'main'), [libraryBinary]);
  compile(other, path.join(second, 'main'), ['-Wl,-rpath,@loader_path/libs']);
  assert.throws(() => nativeAudit(root), /Unresolved native dependency/);
  // The same bytes are valid when the actual owner supplies its own rpath context.
  compile(main, path.join(first, 'main'), [libraryBinary, '-Wl,-rpath,@loader_path/../B/libs']);
  assert.ok(nativeAudit(root).some(item => item.path === 'A/main'));
  assert.equal(run(path.join(first, 'main'), []), '');
});

test('native closure rejects an absolute rpath into a readable build-machine directory', { skip: !native }, t => {
  const root = fixture(t), payload = path.join(root, 'payload'), outside = path.join(root, 'outside');
  fs.mkdirSync(payload); fs.mkdirSync(outside);
  const library = write(root, 'library.c', 'int sample(void) { return 0; }\n');
  const main = write(root, 'main.c', 'int sample(void); int main(void) { return sample(); }\n');
  const binary = path.join(outside, 'libsample.dylib');
  compile(library, binary, ['-dynamiclib', '-install_name', '@rpath/libsample.dylib']);
  compile(main, path.join(payload, 'main'), [binary, '-Wl,-rpath,' + outside]);
  assert.equal(run(path.join(payload, 'main'), []), '');
  assert.throws(() => nativeAudit(payload), /Unresolved native dependency/);
});

test('native closure canonicalizes system prefixes before exempting an absolute dependency', { skip: !native }, t => {
  const root = fixture(t), payload = path.join(root, 'payload'), outside = path.join(root, 'outside');
  fs.mkdirSync(payload); fs.mkdirSync(outside);
  const library = write(root, 'library.c', 'int sample(void) { return 0; }\n');
  const main = write(root, 'main.c', 'int sample(void); int main(void) { return sample(); }\n');
  const binary = path.join(outside, 'libsample.dylib');
  const disguised = '/usr/lib/../..' + path.join(fs.realpathSync(outside), 'libsample.dylib');
  compile(library, binary, ['-dynamiclib', '-install_name', disguised]);
  compile(main, path.join(payload, 'main'), [binary]);
  assert.equal(run(path.join(payload, 'main'), []), '');
  assert.throws(() => nativeAudit(payload), /Nonportable native dependency|Unresolved native dependency/);
});

test('a timed-out offline build probe prevents its same-group child from writing afterwards', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t), ready = path.join(root, 'ready'), late = path.join(root, 'late');
  const descendant = "const fs = require('node:fs');fs.writeFileSync(process.argv[1], 'ready');"
    + "setTimeout(() => fs.writeFileSync(process.argv[2], 'late'), 1200);";
  const parent = "require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], { stdio: 'ignore' });"
    + 'setTimeout(() => {}, 5000);';
  assert.throws(() => run(process.execPath, ['-e', parent, descendant, ready, late], { timeout: 500 }), /timed out|ETIMEDOUT/);
  assert.ok(fs.existsSync(ready), 'descendant actually started before the timeout');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  assert.equal(fs.existsSync(late), false, 'owned descendant cannot perform delayed writes after failure');
});

test('a nonzero offline build probe also prevents its same-group child from writing afterwards', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t), late = path.join(root, 'late');
  const descendant = "process.stdout.write('ready');"
    + "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'late'), 1000);";
  const parent = "const child = require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: ['ignore', 'pipe', 'ignore'] });"
    + "child.stdout.once('data', () => process.exit(2));";
  assert.throws(() => run(process.execPath, ['-e', parent, descendant, late], { timeout: 3000 }), /failed/);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
  assert.equal(fs.existsSync(late), false, 'ready descendant cannot perform delayed writes after nonzero exit');
});

test('native inspection clones an identical alias after simulated EXDEV and cleans every alias', { skip: !native }, t => {
  const root = fixture(t);
  const source = write(root, 'main.c', 'int main(void) { return 0; }\n');
  const binary = path.join(root, 'helper (arm64)');
  compile(source, binary);
  const before = sha256(binary);
  const originalLink = fs.linkSync, originalCopy = fs.copyFileSync;
  const aliases = [];
  try {
    fs.linkSync = () => { throw Object.assign(new Error('simulated cross-volume link'), { code: 'EXDEV' }); };
    fs.copyFileSync = (from, to, flags) => { aliases.push(to); return originalCopy(from, to, flags); };
    assert.ok(nativeAudit(root).some(item => item.path === 'helper (arm64)'));
  } finally { fs.linkSync = originalLink; fs.copyFileSync = originalCopy; }
  assert.ok(aliases.length > 0, 'the cross-volume copy branch was actually exercised');
  for (const alias of aliases) assert.equal(fs.existsSync(path.dirname(alias)), false, 'private inspection directory is removed');
  assert.equal(sha256(binary), before, 'inspection leaves the original executable unchanged');
});

test('native inspection refuses a corrupt fallback copy and removes its private alias', { skip: !native }, t => {
  const root = fixture(t);
  const source = write(root, 'main.c', 'int main(void) { return 0; }\n');
  const binary = path.join(root, 'helper (arm64)');
  compile(source, binary);
  const before = sha256(binary);
  const originalLink = fs.linkSync, originalCopy = fs.copyFileSync;
  const aliases = [];
  try {
    fs.linkSync = () => { throw Object.assign(new Error('simulated cross-volume link'), { code: 'EXDEV' }); };
    fs.copyFileSync = (from, to, flags) => {
      aliases.push(to); originalCopy(from, to, flags); fs.appendFileSync(to, Buffer.from([0]));
    };
    assert.throws(() => nativeAudit(root), /Native inspection alias differs from payload/);
  } finally { fs.linkSync = originalLink; fs.copyFileSync = originalCopy; }
  assert.ok(aliases.length > 0, 'the deliberately corrupt copy was created');
  for (const alias of aliases) assert.equal(fs.existsSync(path.dirname(alias)), false, 'failed inspection removes its private directory');
  assert.equal(sha256(binary), before, 'copy corruption never changes the source executable');
});
