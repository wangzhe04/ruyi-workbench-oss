'use strict';
require('./lib/self-isolate-home.js');
// Real AppKit/WKWebView host and real workbench service, using isolated fixture homes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { buildMacDesktop } = require('../ruyi-workbench/tools/build-macos-desktop');
const t = createRunner('MACOS DESKTOP HOST');
const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-desktop-e2e-'));
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let diagnostic = '';
async function until(fn, timeout = 90000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for native host\n' + diagnostic.slice(-3000));
}
function readReport(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

(async () => {
  try {
    if (process.platform !== 'darwin') {
      console.log('SKIP real AppKit/WKWebView acceptance requires an interactive macOS session');
      return;
    }
    const bundle = process.env.RUYI_DESKTOP_TEST_APP || buildMacDesktop(path.join(root, '如意 测试.app'));
    const binary = path.join(bundle, 'Contents', 'MacOS', 'RuyiDesktop');
    const info = cp.execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
    ok(info === '14.0', 'App declares macOS14 target, subject to actual minimum-system acceptance');
    const documentsUsage = cp.execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :NSDocumentsFolderUsageDescription', path.join(bundle, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
    ok(documentsUsage.includes('工作台程序文件') && documentsUsage.includes('工作区'), 'development App explains Documents access for program files and selected workspaces');
    ok(cp.spawnSync('/usr/bin/codesign', ['--verify', '--strict', bundle]).status === 0, 'development App signature verifies');
    const fixture = fixtureChildEnv({ perTest: true });
    const data = path.join(fixture.home, '工作台 数据😀');
    const workspace = path.join(fixture.home, '工作 区');
    fs.mkdirSync(data); fs.mkdirSync(workspace);
    const schema = require('../ruyi-workbench/app/server').CONFIG_SCHEMA;
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      configSchema: schema, defaultWorkspace: workspace, workspaces: [{ path: workspace }],
      stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false,
      includeWorkbenchMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false },
      externalMcpServers: [], providers: [],
    }));
    const env = { ...fixture.env, RUYI_HOME: data, RUYI_NODE_PATH: process.execPath, PATH: '/usr/bin:/bin' };
    const profileMarker = path.join(fixture.home, 'profile-executed');
    for (const name of ['.profile', '.zprofile', '.zshrc', '.bash_profile']) {
      fs.writeFileSync(path.join(fixture.home, name), 'touch "' + profileMarker + '"\n');
    }
    function launch(name, extra = [], override = {}) {
      const report = path.join(root, name + '.json');
      const child = cp.spawn(binary, ['--acceptance-report', report, ...extra], {
        cwd: root, env: { ...env, ...override }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      child.stdout.on('data', data => { diagnostic = (diagnostic + data).slice(-12000); });
      child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-12000); });
      return { child, report };
    }
    const hash = crypto.createHash('sha256').update(fs.realpathSync(data)).digest('hex');
    const cache = path.join(fixture.home, 'Library', 'Application Support', 'RuyiWorkbench', 'Hosts');
    fs.mkdirSync(cache, { recursive: true });
    const frame = '{{40, 180}, {1000, 700}}';
    fs.writeFileSync(path.join(cache, hash + '.frame'), frame);
    const setup = path.join(root, 'setup.js');
    fs.writeFileSync(setup, `localStorage.setItem('ruyi.p4.acceptance', 'root-A');
const iframe = document.createElement('iframe'); iframe.sandbox = '';
const preview = new Promise(resolve => { iframe.onload = () => resolve(true); setTimeout(() => resolve(false), 3000); });
iframe.srcdoc = '<p>如意 HTML 预览</p>'; document.body.appendChild(iframe);
return { previewLoaded: await preview };`);
    const screenshot = path.join(root, 'workbench.png');
    const first = launch('first', ['--acceptance-close-window', '--acceptance-script', setup, '--acceptance-screenshot', screenshot]);
    const ready = await until(() => {
      const report = readReport(first.report);
      if (report?.state === 'failed') throw new Error(JSON.stringify(report));
      return report?.state === 'ready' && report;
    });
    ok(ready.nativePID === first.child.pid && ready.servicePID > 0, 'native host starts its own service and reports actual process identities');
    ok(ready.page.frame && ready.page.composer && ready.page.configLoaded && ready.page.health,
      'real complete workbench modules initialize in WKWebView and authenticated config loads');
    ok(ready.windowFrame === frame, 'saved non-default native window frame restores before movement events can overwrite it');
    ok(ready.page.additional.previewLoaded && ready.previewNavigations > 0, 'sandboxed srcdoc HTML preview loads in a child frame');
    ok(fs.readFileSync(screenshot).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      'actual WKWebView workbench rendering is retained as a PNG for independent visual acceptance');
    const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8'));
    ok(runtime.pid === ready.servicePID && ready.url === 'http://127.0.0.1:' + runtime.port + '/',
      'host loads only its own service runtime and loopback port');
    const health = await (await fetch(ready.url + 'health')).json();
    ok(health.ok && health.overlayId === runtime.overlayId, 'live health restart identity matches runtime record');
    ok(!fs.existsSync(profileMarker), 'restricted Finder-style PATH never executes login profiles');
    ok(!fs.readFileSync(first.report, 'utf8').includes(runtime.token), 'acceptance report contains no runtime authentication token');
    await until(() => readReport(first.report)?.windowVisible === false);
    ok(alive(ready.servicePID), 'closing the last window leaves the background service running');
    const second = launch('second');
    const duplicate = await until(() => readReport(second.report)?.state === 'existing_host_activated');
    await until(() => second.child.exitCode !== null);
    ok(duplicate && second.child.exitCode === 0 && alive(ready.servicePID), 'second native launch activates existing host without starting or stopping its service');
    await until(() => {
      const report = readReport(first.report);
      return report?.windowVisible && report.activationCount > ready.activationCount;
    });
    ok(readReport(first.report).windowVisible, 'second instance visibly reopens the original closed window');
    first.child.kill('SIGTERM');
    await until(() => first.child.exitCode !== null, 15000);
    await until(() => !alive(ready.servicePID), 15000);
    ok(first.child.exitCode === 0 && !alive(ready.servicePID), 'normal App termination reclaims its service');
    const inspect = path.join(root, 'inspect.js');
    fs.writeFileSync(inspect, "return { marker: localStorage.getItem('ruyi.p4.acceptance') };");
    const third = launch('restart', ['--acceptance-script', inspect]);
    const restarted = await until(() => readReport(third.report)?.state === 'ready' && readReport(third.report));
    ok(restarted.servicePID !== ready.servicePID, 'same data root restarts after native instance lock release');
    ok(restarted.profileIdentifier === ready.profileIdentifier && restarted.page.additional.marker === 'root-A',
      'production persistent WebKit profile restores same-root local storage across App restarts');
    third.child.kill('SIGKILL');
    await until(() => third.child.signalCode !== null);
    await until(() => !alive(restarted.servicePID), 15000);
    ok(!alive(restarted.servicePID), 'service stdin lease closes and normal backend cleanup runs after App SIGKILL');
    const missing = launch('missing', [], { RUYI_NODE_PATH: '/missing/ruyi-node' });
    // An explicit executable selection must fail visibly rather than silently using another runtime.
    const missingResult = await until(() => readReport(missing.report)?.state === 'failed' && readReport(missing.report));
    ok(missingResult.code === 'node_missing', 'missing configured Node produces a native recoverable failure page');
    missing.child.kill('SIGTERM');
    await until(() => missing.child.exitCode !== null, 15000);
    const failedAuto = launch('failed-auto', ['--acceptance-auto-quit'], { RUYI_NODE_PATH: '/missing/ruyi-node' });
    await until(() => failedAuto.child.exitCode !== null, 15000);
    ok(failedAuto.child.exitCode === 0 && readReport(failedAuto.report)?.code === 'node_missing',
      'acceptance auto-quit also exits normally after reporting a startup failure');
    const failedScript = path.join(root, 'failed-script.js');
    fs.writeFileSync(failedScript, "throw new Error('fixture acceptance failure');");
    const scriptFailure = launch('script-failure', ['--acceptance-auto-quit', '--acceptance-script', failedScript]);
    await until(() => scriptFailure.child.exitCode !== null, 15000);
    const scriptReport = readReport(scriptFailure.report);
    ok(scriptFailure.child.exitCode === 0 && scriptReport?.code === 'acceptance_script_failed'
      && scriptReport.detail.includes('fixture acceptance failure') && !alive(scriptReport.servicePID),
      'acceptance script exceptions are reported once and normal shutdown reclaims the service');
    const invalidResultScript = path.join(root, 'invalid-result.js');
    fs.writeFileSync(invalidResultScript, 'return 1n;');
    const invalidResult = launch('invalid-result', ['--acceptance-auto-quit', '--acceptance-script', invalidResultScript]);
    await until(() => invalidResult.child.exitCode !== null, 15000);
    const invalidResultReport = readReport(invalidResult.report);
    ok(invalidResult.child.exitCode === 0 && invalidResultReport?.code === 'acceptance_script_failed'
      && !alive(invalidResultReport.servicePID), 'unserializable acceptance results fail once and reclaim their service');
    const auto = launch('auto', ['--acceptance-auto-quit']);
    await until(() => auto.child.exitCode !== null, 90000);
    const autoReport = readReport(auto.report);
    ok(auto.child.exitCode === 0 && autoReport?.state === 'ready' && !alive(autoReport.servicePID),
      'normal executable entry can complete full-page acceptance and quit cleanly');
    const otherData = path.join(fixture.home, 'other-data');
    fs.mkdirSync(otherData);
    fs.copyFileSync(path.join(data, 'config.json'), path.join(otherData, 'config.json'));
    const other = launch('other', ['--acceptance-auto-quit', '--acceptance-script', inspect], { RUYI_HOME: otherData });
    await until(() => other.child.exitCode !== null);
    const otherReport = readReport(other.report);
    ok(otherReport?.state === 'ready' && otherReport.profileIdentifier !== ready.profileIdentifier
      && otherReport.url === ready.url && otherReport.page.additional.marker === null,
      'different business data roots on the same origin use isolated production WebKit profiles');
    const legacyFixture = fixtureChildEnv({ perTest: true });
    const legacy = path.join(legacyFixture.home, '.win-claude-workbench');
    const next = path.join(legacyFixture.home, '.ruyi-workbench');
    fs.mkdirSync(legacy);
    fs.copyFileSync(path.join(data, 'config.json'), path.join(legacy, 'config.json'));
    fs.writeFileSync(path.join(legacy, 'migration-marker.txt'), 'existing-data');
    const legacyApp = launch('legacy', ['--acceptance-auto-quit'], {
      ...legacyFixture.env, RUYI_HOME: '', WIN_CLAUDE_WORKBENCH_HOME: '', RUYI_NODE_PATH: process.execPath,
    });
    await until(() => legacyApp.child.exitCode !== null);
    ok(readReport(legacyApp.report)?.state === 'ready' && fs.existsSync(path.join(next, 'runtime.json'))
      && fs.readFileSync(path.join(next, 'migration-marker.txt'), 'utf8') === 'existing-data',
      'default native entry preserves direct-serve legacy data migration and empty environment semantics');
    const linkedFixture = fixtureChildEnv({ perTest: true });
    const linkedData = path.join(linkedFixture.home, 'external-data');
    fs.mkdirSync(linkedData);
    fs.copyFileSync(path.join(data, 'config.json'), path.join(linkedData, 'config.json'));
    fs.symlinkSync(linkedData, path.join(linkedFixture.home, '.win-claude-workbench'));
    const linkedEnv = { ...linkedFixture.env, RUYI_HOME: '', WIN_CLAUDE_WORKBENCH_HOME: '', RUYI_NODE_PATH: process.execPath };
    const linked = launch('linked', [], linkedEnv);
    const linkedReady = await until(() => readReport(linked.report)?.state === 'ready' && readReport(linked.report));
    const explicitAlias = launch('linked-alias', [], { ...linkedEnv, RUYI_HOME: linkedData });
    await until(() => explicitAlias.child.exitCode !== null);
    ok(readReport(explicitAlias.report)?.state === 'existing_host_activated' && alive(linkedReady.servicePID)
      && !fs.existsSync(path.join(linkedFixture.home, '.ruyi-workbench')),
      'legacy symlink default and explicit equivalent data root share the same native instance identity');
    linked.child.kill('SIGTERM');
    await until(() => linked.child.exitCode !== null, 15000);
    const relative = launch('relative', ['--acceptance-auto-quit'], {
      RUYI_HOME: path.relative(path.resolve(__dirname, '../ruyi-workbench'), otherData),
    });
    await until(() => relative.child.exitCode !== null);
    ok(readReport(relative.report)?.state === 'ready' && readReport(relative.report).profileIdentifier === otherReport.profileIdentifier,
      'relative data-root environment resolves against the same workbench cwd as direct serve');
    const localBin = path.join(fixture.home, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(localBin, 'node'));
    // A newly ad-hoc-signed App launched by LaunchServices has a different Documents TCC
    // identity from its development terminal. Test the LS lifecycle against an exact isolated
    // program snapshot; real Documents authorization is a separate identity acceptance gate.
    const launchSource = path.join(root, 'launch-source');
    const originalSource = path.resolve(__dirname, '../ruyi-workbench');
    fs.mkdirSync(launchSource);
    const sourceBinding = [];
    function bindSnapshot(directory) {
      for (const item of fs.readdirSync(path.join(originalSource, directory), { withFileTypes: true })) {
        const relative = path.join(directory, item.name);
        if (item.isDirectory()) bindSnapshot(relative);
        else {
          const fingerprint = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
          const sourceSha256 = fingerprint(path.join(originalSource, relative));
          const snapshotSha256 = fingerprint(path.join(launchSource, relative));
          if (sourceSha256 !== snapshotSha256) throw new Error('LaunchServices snapshot differs: ' + relative);
          sourceBinding.push({ relative, sha256: sourceSha256 });
        }
      }
    }
    for (const directory of ['app', 'resources', 'config', 'desktop-macos', 'runtime']) {
      fs.cpSync(path.join(originalSource, directory), path.join(launchSource, directory), { recursive: true });
      bindSnapshot(directory);
    }
    fs.writeFileSync(path.join(root, 'launch-source-binding.json'), JSON.stringify({ originalSource, launchSource, files: sourceBinding }, null, 2));
    ok(sourceBinding.length > 0, 'LaunchServices fixture program snapshot is bound byte-for-byte to current sources outside Documents');
    const launchReport = path.join(root, 'launch-services.json');
    const launcher = cp.spawn('/usr/bin/open', ['-n', '-W', '-a', bundle,
      '--env', 'HOME=' + fixture.home, '--env', 'USERPROFILE=' + fixture.home,
      '--env', 'RUYI_HOME=' + data, '--env', 'RUYI_NODE_PATH=',
      '--env', 'PATH=/usr/bin:/bin', '--args', '--acceptance-report', launchReport, '--acceptance-auto-quit', '--workbench-root', launchSource],
    { env: { ...process.env, ...fixture.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(launcher);
    launcher.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-12000); });
    await until(() => launcher.exitCode !== null);
    const launched = readReport(launchReport);
    ok(launcher.exitCode === 0 && launched?.state === 'ready' && !alive(launched.servicePID),
      'LaunchServices App entry with Finder-style environment loads the workbench and quits without a service leak');

    // Inject replacement and restoration failures after a successful build. The old bundle
    // must remain recoverable even when the file system rejects both rename operations.
    const rollback = path.join(root, 'rollback.app');
    fs.cpSync(bundle, rollback, { recursive: true });
    const originalSpawn = cp.spawnSync;
    const originalRename = fs.renameSync;
    let preserved = '';
    try {
      cp.spawnSync = (command, args, options) => {
        if (command.endsWith('swiftc')) {
          fs.writeFileSync(args.at(-1), 'fixture executable');
          return { status: 0, stdout: '', stderr: '' };
        }
        if (command === '/usr/bin/codesign') return { status: 0, stdout: '', stderr: '' };
        return originalSpawn(command, args, options);
      };
      fs.renameSync = (from, to) => {
        if (to === rollback && path.basename(from) === 'Ruyi.app') throw new Error('injected replacement failure');
        if (to === rollback && path.basename(from) === 'previous.app') { preserved = from; throw new Error('injected restore failure'); }
        return originalRename(from, to);
      };
      try { buildMacDesktop(rollback); } catch (error) {
        ok(error.message.includes('Previous App preserved at'), 'builder reports recovery location after replacement and restoration both fail');
      }
    } finally { cp.spawnSync = originalSpawn; fs.renameSync = originalRename; }
    ok(preserved && fs.existsSync(path.join(preserved, 'Contents', 'MacOS', 'RuyiDesktop')),
      'failed build rollback retains the previous complete App bundle');
    console.log('Native acceptance reports ' + root);
  } catch (error) { t.fail(error.stack || error.message); }
  finally {
    for (const child of children) await killOwnTree(child);
    t.done();
  }
})();
