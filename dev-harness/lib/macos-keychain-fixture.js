'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const { buildMacKeychainHelper } = require('../../ruyi-workbench/tools/build-macos-keychain-helper');

function createMacKeychainFixture(root) {
  const keychain = path.join(root, 'fixture.keychain'), password = crypto.randomBytes(24).toString('hex');
  const fixture = path.join(root, 'keychain-fixture');
  const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-Wno-deprecated-declarations', '-framework', 'Foundation', '-framework', 'Security',
    path.join(__dirname, '../native/macos-keychain-fixture.m'), '-o', fixture], { encoding: 'utf8', timeout: 30000 });
  if (compiled.error || compiled.status) throw new Error(compiled.error?.message || compiled.stderr);
  const control = op => {
    const result = cp.spawnSync(fixture, [], { input: JSON.stringify({ op, path: keychain, password }), encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) throw new Error('disposable Keychain ' + op + ' failed: ' + result.stdout);
  };
  control('create');
  try {
    control('unlock');
    const helper = buildMacKeychainHelper({ output: path.join(root, 'keychain-helper'), testKeychainPath: keychain });
    const preload = path.join(root, 'keychain-preload.cjs');
    const expected = path.resolve(__dirname, '../../ruyi-workbench/runtime/macos/ruyi-keychain-helper');
    // Existing service e2e can reuse its actual HTTP/startup path while selecting only this disposable Keychain.
    fs.writeFileSync(preload, `const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=function(exe,args,opts){return spawn.call(this,exe===${JSON.stringify(expected)}?${JSON.stringify(helper)}:exe,args,opts)};`);
    return { helper, preload, control, destroy: () => { control('unlock'); control('delete'); } };
  } catch (error) { control('delete'); throw error; }
}
module.exports = { createMacKeychainFixture };
