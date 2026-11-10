'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

function buildMacAutomationHelper({ output, testing = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('The automation helper requires macOS and the Apple SDK');
  const architecture = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!architecture) throw new Error('Unsupported macOS architecture');
  if (testing && !output) throw new Error('Test builds require a separate output path');
  const root = path.resolve(__dirname, '..');
  output = output || path.join(root, 'runtime', 'macos', 'ruyi-automation-helper');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = output + '.' + process.pid + '.tmp';
  try {
    const result = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', '-O2',
      '-mmacosx-version-min=14.0', '-arch', architecture, '-framework', 'AppKit', '-framework', 'ApplicationServices',
      '-framework', 'ScreenCaptureKit', '-framework', 'ImageIO', '-framework', 'UniformTypeIdentifiers',
      '-framework', 'Vision', '-framework', 'Carbon',
      ...(testing ? ['-DRUYI_AUTOMATION_TESTING=1'] : []),
      path.join(root, 'resources', 'macos-automation-helper.m'),
      path.join(root, 'resources', 'macos-automation-input.m'),
      path.join(root, 'resources', 'macos-automation-events.m'),
      path.join(root, 'resources', 'macos-automation-ax.m'),
      path.join(root, 'resources', 'macos-automation-ocr.m'),
      path.join(root, 'resources', 'macos-automation-record.m'),
      path.join(root, 'resources', 'macos-automation-session.m'), '-o', temporary],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
    const signed = cp.spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier',
      'org.ruyi.workbench.automation.development', '--timestamp=none', temporary], { encoding: 'utf8', timeout: 10000 });
    if (signed.error || signed.status !== 0) throw new Error(signed.error?.message || signed.stderr);
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, output);
    return output;
  } finally { fs.rmSync(temporary, { force: true }); }
}

if (require.main === module) {
  try { console.log(buildMacAutomationHelper({ output: process.argv[2] })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildMacAutomationHelper };
