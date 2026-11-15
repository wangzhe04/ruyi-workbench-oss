'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
function buildMacTrashHelper(output) {
  if (process.platform !== 'darwin') throw new Error('macOS Trash helper requires the macOS SDK');
  const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!arch) throw new Error('Unsupported macOS architecture');
  output ||= path.resolve(__dirname, '../runtime/macos/ruyi-trash-helper');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = output + '.' + process.pid + '.tmp';
  try {
    const r = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-O2',
      '-mmacosx-version-min=14.0', '-arch', arch, '-framework', 'Foundation',
      path.resolve(__dirname, '../resources/macos-trash-helper.m'), '-o', temporary],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr);
    fs.chmodSync(temporary, 0o755); fs.renameSync(temporary, output);
    return output;
  } finally { fs.rmSync(temporary, { force: true }); }
}
if (require.main === module) {
  try { console.log(buildMacTrashHelper()); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { buildMacTrashHelper };
