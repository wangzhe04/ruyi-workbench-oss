'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function buildMacKeychainHelper({ output, testKeychainPath } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS Keychain helper requires the macOS SDK');
  const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!architecture) throw new Error('Unsupported macOS architecture: ' + process.arch);
  if (testKeychainPath && !output) throw new Error('Test Keychain builds require a separate output path');
  const root = path.resolve(__dirname, '..');
  output = output || path.join(root, 'runtime', 'macos', 'ruyi-keychain-helper');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = output + '.' + process.pid + '.tmp';
  try {
    const result = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations', '-O2',
      '-mmacosx-version-min=14.0', '-arch', architecture, '-framework', 'Foundation', '-framework', 'Security',
      ...(testKeychainPath ? ['-DRUYI_KEYCHAIN_TEST_PATH=' + JSON.stringify(testKeychainPath)] : []),
      path.join(root, 'resources', 'macos-keychain-helper.m'), '-o', temporary],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error ? result.error.message : result.stderr);
    fs.chmodSync(temporary, 0o755); fs.renameSync(temporary, output);
    return output;
  } finally { fs.rmSync(temporary, { force: true }); }
}
if (require.main === module) {
  try { console.log(buildMacKeychainHelper()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildMacKeychainHelper };
