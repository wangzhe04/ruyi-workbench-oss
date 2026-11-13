'use strict';
// Development build; release packaging must ship the resulting native helper with the runtime.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function buildMacProcessHelper(output) {
  if (process.platform !== 'darwin') throw new Error('macOS process helper requires the macOS SDK');
  const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!architecture) throw new Error('Unsupported macOS architecture: ' + process.arch);
  const root = path.resolve(__dirname, '..');
  output = output || path.join(root, 'runtime', 'macos', 'ruyi-process-helper');
  const directory = path.dirname(output);
  const temporary = output + '.' + process.pid + '.tmp';
  fs.mkdirSync(directory, { recursive: true });
  try {
    const result = cp.spawnSync('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
      '-mmacosx-version-min=14.0', '-arch', architecture,
      path.join(root, 'resources', 'macos-process-helper.c'), '-o', temporary],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error ? result.error.message : result.stderr);
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, output);
    return output;
  } finally { fs.rmSync(temporary, { force: true }); }
}

if (require.main === module) {
  try { console.log(buildMacProcessHelper()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildMacProcessHelper };
