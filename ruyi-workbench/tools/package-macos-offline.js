#!/usr/bin/env node
'use strict';
// P6-01: assemble an offline arm64 candidate from a separately prepared, locked asset cache.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sha256, inventory, treeDigest, copyTree, run, verifyAssets, nativeAudit, verifyPackage } = require('./macos-offline-lib');
const { buildMacDesktop } = require('./build-macos-desktop');
const { buildMacProcessHelper } = require('./build-macos-process-helper');
const { buildMacKeychainHelper } = require('./build-macos-keychain-helper');
const { buildMacAutomationHelper } = require('./build-macos-automation-helper');
const root = path.resolve(__dirname, '..');
const repo = path.dirname(root);
const lockFile = path.join(repo, 'MACOS-PORTING/dependencies/macos-offline-arm64.assets.json');

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function buildMacOffline({ assets, output, variant = 'full' }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an arm64 Mac with the Apple SDK and Node24');
  if (!['full', 'slim'].includes(variant) || !assets || !output) throw new Error('Use --assets DIR --output DIR --variant full|slim');
  output = path.resolve(output);
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new candidate directory');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const inputs = verifyAssets(path.resolve(assets), lock, variant);
  run(process.execPath, [path.join(root, 'app/build.js'), '--check']);
  const source = run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repo });
  const sourceFiles = run('/usr/bin/git', ['ls-files', '-z'], { cwd: repo }).split('\0').filter(Boolean);
  // Also bind new implementation files, before their first commit.
  sourceFiles.push(...run('/usr/bin/git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repo }).split('\0').filter(Boolean));
  const sourceFingerprint = Object.fromEntries(sourceFiles.filter(file => (file.startsWith('ruyi-workbench/')
    || file.startsWith('mcp/ai-computer-control/') || file.startsWith('MACOS-PORTING/dependencies/')
    || ['LICENSE', 'THIRD-PARTY-NOTICES.md'].includes(file))
    && fs.statSync(path.join(repo, file)).isFile()).sort().map(file => [file, sha256(path.join(repo, file))]));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.ruyi-offline-'));
  const candidate = path.join(staging, 'candidate');
  const bundle = path.join(candidate, 'Ruyi.app');
  const workbench = path.join(bundle, 'Contents/Resources/workbench');
  const home = path.join(staging, 'home');
  fs.mkdirSync(home);
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'local'), APPDATA: path.join(home, 'roaming'),
    TMPDIR: path.join(staging, 'tmp'), LANG: 'en_US.UTF-8', PYTHONUTF8: '1',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', PYTHONPATH: '', PYTHONHOME: '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
    PIP_NO_INDEX: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_CONFIG_FILE: '/dev/null', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    MPLCONFIGDIR: path.join(home, 'matplotlib') };
  fs.mkdirSync(env.TMPDIR);
  try {
    buildMacDesktop(bundle, { bundled: true });
    fs.mkdirSync(path.join(workbench, 'app'), { recursive: true });
    for (const file of ['server.js']) fs.copyFileSync(path.join(root, 'app', file), path.join(workbench, 'app', file));
    copyTree(path.join(root, 'app/public'), path.join(workbench, 'app/public'));
    for (const directory of ['resources', 'config', 'docs']) copyTree(path.join(root, directory), path.join(workbench, directory));
    fs.mkdirSync(path.join(workbench, 'desktop-macos'));
    fs.copyFileSync(path.join(root, 'desktop-macos/service-lease.cjs'), path.join(workbench, 'desktop-macos/service-lease.cjs'));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(workbench, 'package.json'));
    for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.md']) fs.copyFileSync(path.join(repo, file), path.join(workbench, file));
    fs.mkdirSync(path.join(workbench, 'runtime'), { recursive: true });
    // Keep the upstream Node license (including its vendored dependency notices); omit npm/corepack.
    fs.mkdirSync(path.join(workbench, 'runtime/node/bin'), { recursive: true });
    fs.copyFileSync(path.join(inputs.node.directory, 'bin/node'), path.join(workbench, 'runtime/node/bin/node'));
    fs.chmodSync(path.join(workbench, 'runtime/node/bin/node'), 0o755);
    fs.copyFileSync(path.join(inputs.node.directory, 'LICENSE'), path.join(workbench, 'runtime/node/LICENSE'));
    fs.mkdirSync(path.join(workbench, 'app/vendor-bin'));
    for (const file of ['rg', 'LICENSE-MIT', 'COPYING', 'UNLICENSE']) fs.copyFileSync(path.join(inputs.ripgrep.directory, file), path.join(workbench, 'app/vendor-bin', file));
    fs.chmodSync(path.join(workbench, 'app/vendor-bin/rg'), 0o755);
    fs.mkdirSync(path.join(workbench, 'runtime/macos'));
    buildMacProcessHelper(path.join(workbench, 'runtime/macos/ruyi-process-helper'));
    buildMacKeychainHelper({ output: path.join(workbench, 'runtime/macos/ruyi-keychain-helper') });
    buildMacAutomationHelper({ output: path.join(workbench, 'runtime/macos/ruyi-automation-helper') });
    if (variant === 'full') {
      const acc = path.join(workbench, 'mcp/ai-computer-control');
      const pythonRoot = path.join(acc, 'runtime/python');
      copyTree(inputs.python.directory, pythonRoot);
      const python = path.join(pythonRoot, 'bin/python3');
      const wheels = path.join(acc, 'wheels');
      copyTree(inputs.wheels.directory, wheels);
      const requirementFile = path.join(acc, 'requirements.lock.txt');
      fs.copyFileSync(path.join(repo, lock.requirements), requirementFile);
      if (sha256(requirementFile) !== lock.requirementsSha256) throw new Error('Requirements lock changed');
      const project = path.join(staging, 'acc-source');
      fs.mkdirSync(project);
      fs.copyFileSync(path.join(repo, 'mcp/ai-computer-control/pyproject.toml'), path.join(project, 'pyproject.toml'));
      fs.copyFileSync(path.join(repo, 'mcp/ai-computer-control/LICENSE'), path.join(project, 'LICENSE'));
      copyTree(path.join(repo, 'mcp/ai-computer-control/src'), path.join(project, 'src'));
      // Build a non-editable wheel from the current candidate, with offline build isolation.
      run(python, ['-m', 'pip', 'wheel', '--no-index', '--find-links', wheels, '--no-deps', '--wheel-dir', wheels, project], { env, cwd: staging });
      run(python, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '--require-hashes', '--no-compile', '-r', requirementFile], { env, cwd: staging });
      const accWheel = fs.readdirSync(wheels).find(file => /^ai_computer_control-.*\.whl$/.test(file));
      if (!accWheel) throw new Error('ACC wheel was not built');
      run(python, ['-m', 'pip', 'install', '--no-index', '--find-links', wheels, '--no-deps', '--no-compile',
        'ai-computer-control==' + accWheel.split('-')[1]], { env, cwd: staging });
      run(python, ['-m', 'pip', 'check'], { env, cwd: staging });
      run(python, [path.join(__dirname, 'macos-offline-python.py'), '--runtime', pythonRoot, '--entrypoints'], { env, cwd: staging });
      const browsers = path.join(acc, 'playwright_browsers/chromium-' + lock.chromiumRevision);
      copyTree(inputs.chromium.directory, browsers);
      copyTree(inputs['python-notices'].directory, path.join(pythonRoot, 'third-party-notices'));
      // Collect each wheel's own metadata and license files; keep original notices in site-packages.
      run(python, [path.join(__dirname, 'macos-offline-python.py'), '--runtime', pythonRoot, '--licenses', path.join(workbench, 'python-licenses.json')], { env, cwd: staging });
      // These pages are shipped by the actual bundled browser and require no network.
      const browserEnv = { ...env, PLAYWRIGHT_BROWSERS_PATH: path.join(acc, 'playwright_browsers') };
      run(python, [path.join(__dirname, 'macos-offline-python.py'), '--browser-notices', path.join(workbench, 'browser-notices')], { env: browserEnv, cwd: staging });
    }
    const components = lock.components.filter(component => inputs[component.id]).map(({ directory, ...component }) => component);
    const capabilities = { providerApi: true, cloudApiRequiresNetwork: true, shell: true, ripgrep: true,
      bundledDesktopMcp: variant === 'full', officeFiles: variant === 'full', browserAutomation: variant === 'full',
      desktopAutomationRequiresSystemPermissions: true, officialAgentCliBundled: false, gitBundled: false };
    writeJson(path.join(workbench, 'resources/offline-manifest.json'), { schemaVersion: 1, name: 'Ruyi Mac Offline Candidate',
      version: require('../package.json').version, variant, platform: 'darwin', arch: 'arm64', minimumSystemTarget: '14.0',
      minimumSystemRuntimeVerified: false, signing: 'ad-hoc-development', notarized: false, capabilities, components });
    writeJson(path.join(workbench, 'native-dependencies.json'), nativeAudit(bundle));
    for (const [file, expected] of Object.entries(sourceFingerprint)) {
      if (sha256(path.join(repo, file)) !== expected) throw new Error('Source changed during packaging: ' + file);
    }
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    const files = inventory(bundle);
    writeJson(path.join(candidate, 'package-manifest.json'), { schemaVersion: 1, app: 'Ruyi.app',
      version: require('../package.json').version, variant, platform: 'darwin', arch: 'arm64', sourceCommit: source,
      sourceFingerprint, assetsLockSha256: sha256(lockFile), capabilities, signing: 'ad-hoc-development', notarized: false,
      minimumSystemTarget: '14.0', minimumSystemRuntimeVerified: false, treeSha256: treeDigest(files), files });
    fs.writeFileSync(path.join(candidate, 'SHA256SUMS'), sha256(path.join(candidate, 'package-manifest.json')) + '  package-manifest.json\n');
    fs.writeFileSync(path.join(candidate, 'README.txt'), '如意 Mac 离线候选包 / Ruyi Mac offline candidate\n'
      + 'Variant: ' + variant + '\nApple Silicon arm64. Development signature; not notarized.\n'
      + 'macOS14 is a target, not yet runtime-qualified. No official Agent CLI or Git bundled.\n'
      + 'Copy Ruyi.app to a writable local directory. Data stays in ~/.ruyi-workbench or RUYI_HOME.\n'
      + 'Full includes Python/ACC/Office/Chromium. Slim does not include these dependencies.\n'
      + 'Cloud providers require a network. System permissions are granted separately by the user.\n');
    verifyPackage(candidate);
    fs.renameSync(candidate, output);
    return output;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--verify') {
      const manifest = verifyPackage(path.resolve(args[1]));
      console.log('Verified ' + manifest.variant + ' ' + manifest.treeSha256);
    } else {
      const options = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!['--assets', '--output', '--variant'].includes(args[i]) || !args[i + 1] || options[args[i].slice(2)]) throw new Error('Use --assets DIR --output DIR --variant full|slim');
        options[args[i].slice(2)] = args[i + 1];
      }
      console.log(buildMacOffline(options));
    }
  } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { buildMacOffline };
