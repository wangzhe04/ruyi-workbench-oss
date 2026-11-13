'use strict';
// LaunchServices attributes protected-folder access to the App. Keep development
// runtime inputs in the fixture, rather than depending on Documents TCC grants.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { copyTree } = require('../../ruyi-workbench/tools/macos-offline-lib');
const { buildMacDesktop } = require('../../ruyi-workbench/tools/build-macos-desktop');
const repo = path.resolve(__dirname, '../..');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function prepareMacHost(root) {
  const bundle = fs.realpathSync(process.env.RUYI_DESKTOP_TEST_APP || buildMacDesktop(path.join(root, 'Ruyi.app')));
  const build = JSON.parse(fs.readFileSync(path.join(bundle, 'Contents/Resources/build.json'), 'utf8'));
  for (const file of ['DesktopService.swift', 'MacHostBridge.swift', 'RuyiDesktop.swift', 'main.swift', 'service-lease.cjs']) {
    const relative = 'desktop-macos/' + file;
    if (build.sourceFingerprint?.[relative] !== digest(path.join(repo, 'ruyi-workbench', relative))) {
      throw new Error('App host differs from the current candidate: ' + relative);
    }
  }
  const packaged = path.join(bundle, 'Contents/Resources/workbench');
  const bundled = fs.existsSync(path.join(packaged, 'app/server.js'));
  const workbenchRoot = bundled ? packaged : path.join(root, 'workbench');
  if (!bundled) {
    fs.mkdirSync(workbenchRoot);
    fs.copyFileSync(path.join(repo, 'ruyi-workbench/package.json'), path.join(workbenchRoot, 'package.json'));
    for (const name of ['app', 'desktop-macos', 'resources', 'tools', 'runtime']) {
      copyTree(path.join(repo, 'ruyi-workbench', name), path.join(workbenchRoot, name));
    }
  }
  const server = path.join(workbenchRoot, 'app/server.js');
  const serverSha256 = digest(server);
  if (serverSha256 !== digest(path.join(repo, 'ruyi-workbench/app/server.js'))) {
    throw new Error('App fixture backend differs from the current candidate');
  }
  const result = { bundle, bundled, workbenchRoot: fs.realpathSync(workbenchRoot), serverSha256 };
  fs.writeFileSync(path.join(root, 'runtime-source.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

function prepareMacAcc(root, runtime) {
  const packaged = path.join(runtime.workbenchRoot, 'mcp/ai-computer-control');
  const packagedPython = path.join(packaged, 'runtime/python/bin/python3');
  if (runtime.bundled && fs.existsSync(packagedPython)) {
    return { repo: packaged, python: packagedPython, pythonPath: null };
  }
  const source = path.join(repo, 'mcp/ai-computer-control');
  const staged = path.join(root, 'ai-computer-control');
  fs.mkdirSync(staged);
  copyTree(path.join(source, 'src'), path.join(staged, 'src'));
  // A development venv deliberately has absolute interpreter links. Clone that
  // known local dependency tree verbatim; never change its original configuration.
  const environment = path.join(staged, '.venv');
  fs.cpSync(path.join(source, '.venv'), environment, { recursive: true, verbatimSymlinks: true,
    mode: fs.constants.COPYFILE_FICLONE, force: false, errorOnExist: true });
  const redirects = [];
  for (const version of fs.readdirSync(path.join(environment, 'lib'))) {
    const site = path.join(environment, 'lib', version, 'site-packages');
    if (!fs.existsSync(site)) continue;
    for (const name of fs.readdirSync(site).filter(name => name.endsWith('.pth') || /^__editable__.*_finder\.py$/.test(name))) {
      const file = path.join(site, name), before = fs.readFileSync(file, 'utf8');
      const after = before.replaceAll(path.join(source, 'src'), path.join(staged, 'src'));
      if (after !== before) { fs.writeFileSync(file, after); redirects.push(name); }
    }
  }
  if (process.env.RUYI_ACC_PYTHON && !fs.realpathSync(process.env.RUYI_ACC_PYTHON).startsWith(fs.realpathSync(root) + path.sep)) {
    throw new Error('RUYI_ACC_PYTHON must belong to the isolated App fixture');
  }
  fs.writeFileSync(path.join(root, 'acc-runtime-source.json'), JSON.stringify({ repo: staged, redirects,
    interpreter: fs.realpathSync(path.join(environment, 'bin/python')) }, null, 2) + '\n');
  return { repo: staged, python: process.env.RUYI_ACC_PYTHON || path.join(environment, 'bin/python'),
    pythonPath: path.join(staged, 'src') };
}

module.exports = { prepareMacHost, prepareMacAcc };
