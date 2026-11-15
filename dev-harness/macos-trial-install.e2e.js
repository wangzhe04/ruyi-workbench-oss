'use strict';
require('./lib/self-isolate-home');
// Actual DMG -> isolated user Applications -> eject -> native/LaunchServices startup.
// Current UID may be in admin; no sudo, real account creation or security-policy changes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('./lib/kill-own-tree');
const { run, sha256, verifyPackage, inventory, treeDigest } = require('../ruyi-workbench/tools/macos-offline-lib');
const { attachTrial, detachTrial, verifyTrialDirectory, verifyDistribution, installTrial, verifyInstalledApp, signatureTarget } = require('../ruyi-workbench/tools/package-macos-trial');
const t = createRunner('MACOS TRIAL INSTALL'); const { ok } = t;
const distribution = process.env.RUYI_TRIAL_DISTRIBUTION;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
async function until(fn, timeout = 90000) { const end = Date.now() + timeout; while (Date.now() < end) { const r = fn(); if (r) return r; await sleep(100); } throw new Error('Trial install acceptance timed out'); }
(async () => {
  if (process.platform !== 'darwin' || !distribution) {
    if (process.env.RUYI_TRIAL_REQUIRED === '1') t.fail('A real trial DMG is required');
    else console.log('SKIP real DMG install requires macOS and RUYI_TRIAL_DISTRIBUTION');
    t.done(); return;
  }
  const fixture = fixtureChildEnv({ perTest: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trial-install-'));
  const mount = path.join(scratch, 'mount'); let attached = false, lsIdentity;
  const children = [];
  try {
    const metadata = verifyDistribution(distribution);
    const image = path.join(distribution, metadata.image);
    if (!ok(sha256(image) === metadata.imageSha256, 'actual DMG bytes match the distribution checksum')) throw new Error('Corrupt DMG; mount refused');
    run('/usr/bin/hdiutil', ['verify', image]);
    attachTrial(image, mount); attached = true;
    const { trial, manifest } = verifyTrialDirectory(mount);
    if (JSON.stringify(trial) !== JSON.stringify(read(path.join(distribution, 'trial-manifest.json')))) throw new Error('Mounted trial differs from distribution');
    ok(trial.notarized === false && trial.developerIdentityVerified === false && trial.signing === 'ad-hoc-internal-trial', 'image accurately identifies the local/internal trust scope');
    let readOnly = false;
    try { fs.writeFileSync(path.join(mount, 'write-probe'), 'probe'); } catch (error) { readOnly = ['EROFS', 'EACCES', 'EPERM'].includes(error.code); }
    ok(readOnly, 'mounted DMG is actually read-only');
    const app = path.join(mount, 'Ruyi.app');
    const native = read(path.join(app, 'Contents/Resources/workbench/native-dependencies.json'));
    for (const target of new Set(native.map(item => signatureTarget(app, item.path)))) run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
    ok(true, 'every native code object or resource-bearing container verifies after trial sealing');
    const applications = path.join(fixture.home, 'Applications', '试用 安装😀');
    const installed = installTrial(mount, applications);
    ok(treeDigest(inventory(installed)) === manifest.treeSha256, 'normal copy installs complete signed App into an isolated user Applications path');
    let refused = false; try { installTrial(mount, applications); } catch (error) { refused = error.code === 'EEXIST'; }
    ok(refused && treeDigest(inventory(installed)) === manifest.treeSha256, 'existing installation is refused without replacing its bytes');
    for (const name of ['package-manifest.json', 'SHA256SUMS']) fs.copyFileSync(path.join(mount, name), path.join(applications, name));
    detachTrial(mount); attached = false;
    const data = path.join(fixture.home, 'data'), workspace = path.join(fixture.home, 'workspace'); fs.mkdirSync(data); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, defaultWorkspace: workspace,
      stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false,
      enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false }, providers: [] }));
    const marker = path.join(data, 'retained.txt'); fs.writeFileSync(marker, 'keep user data');
    const environment = { ...fixture.env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: '', PATH: '/usr/bin:/bin', RUYI_NODE_PATH: '/missing/node',
      NODE_OPTIONS: '', NODE_PATH: '', PYTHONPATH: '', PYTHONHOME: '' };
    const report = path.join(scratch, 'native.json');
    const nativeHost = cp.spawn(path.join(installed, 'Contents/MacOS/RuyiDesktop'), ['--acceptance-report', report, '--acceptance-auto-quit'],
      { env: { ...process.env, ...environment }, cwd: scratch, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(nativeHost); nativeHost.stderr.on('data', () => {});
    await until(() => nativeHost.exitCode !== null);
    ok(nativeHost.exitCode === 0 && read(report)?.state === 'ready' && read(report)?.page?.configLoaded,
      'installed native App starts with the DMG ejected and no configured external Node');
    const lsReport = path.join(scratch, 'launch-services.json');
    const launcher = cp.spawn('/usr/bin/open', ['-n', '-W', '-a', installed,
      '--env', 'HOME=' + fixture.home, '--env', 'USERPROFILE=' + fixture.home,
      '--env', 'RUYI_HOME=' + data, '--env', 'RUYI_NODE_PATH=/missing/node', '--env', 'PATH=/usr/bin:/bin',
      '--args', '--acceptance-report', lsReport, '--acceptance-auto-quit'],
    { env: { ...process.env, ...fixture.env }, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(launcher); launcher.stderr.on('data', () => {});
    await until(() => {
      const r = read(lsReport);
      if (r?.nativePID && !lsIdentity) lsIdentity = snapshotProcessTable()?.find(row => row.pid === r.nativePID);
      return launcher.exitCode !== null;
    });
    ok(launcher.exitCode === 0 && read(lsReport)?.state === 'ready' && read(lsReport)?.page?.configLoaded,
      'LaunchServices opens the installed App from its actual installation path after eject');
    ok(fs.readFileSync(marker, 'utf8') === 'keep user data', 'relaunch leaves separate user data unchanged');
    verifyInstalledApp(installed, manifest); verifyPackage(applications);
    ok(true, 'installed payload stays unchanged after both actual native entries');
    // Reuse the full real-workbench/Office/browser offline journey, serially, on the installed bytes.
    const journey = cp.spawn(process.execPath, [path.join(__dirname, 'macos-offline-package.e2e.js')], { cwd: scratch,
      env: { ...process.env, ...fixture.env, RUYI_OFFLINE_CANDIDATE: applications, RUYI_OFFLINE_REQUIRED: '1', RUYI_OFFLINE_EXPECT_SIGNING: 'ad-hoc-internal-trial' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(journey); let out = ''; for (const stream of [journey.stdout, journey.stderr]) stream.on('data', chunk => { out += chunk; });
    await until(() => journey.exitCode !== null, 180000);
    fs.writeFileSync(path.join(scratch, 'offline-journey.txt'), out);
    ok(journey.exitCode === 0 && out.includes('MACOS OFFLINE PACKAGE E2E: ALL PASS'), 'installed payload completes the isolated offline workbench journey');
    if (manifest.capabilities.nativeTrash === true) {
      const workbench = path.join(installed, 'Contents/Resources/workbench'), helper = path.join(workbench, 'runtime/macos/ruyi-trash-helper');
      const trashReport = path.join(scratch, 'packaged-trash.json');
      const trash = cp.spawn(process.execPath, [path.join(__dirname, 'macos-migration-trash.e2e.js')], { cwd: scratch,
        env: { ...process.env, ...fixture.env, RUYI_TRASH_HELPER: helper, RUYI_TEST_SERVER_JS: path.join(workbench, 'app/server.js'), RUYI_TRASH_REPORT: trashReport },
        stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(trash); let trashOut = ''; for (const stream of [trash.stdout, trash.stderr]) stream.on('data', chunk => { trashOut += chunk; });
      await until(() => trash.exitCode !== null, 90000);
      fs.writeFileSync(path.join(scratch, 'packaged-trash.txt'), trashOut);
      ok(trash.exitCode === 0 && trashOut.includes('MACOS MIGRATION TRASH E2E: ALL PASS') && read(trashReport)?.helperSha256 === sha256(helper),
        'installed backend and bundled native Trash helper move and restore only the disposable old App');
    }
    verifyInstalledApp(installed, manifest);
    const spctl = cp.spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', installed], { encoding: 'utf8', timeout: 15000 });
    fs.writeFileSync(path.join(scratch, 'gatekeeper-assessment.json'), JSON.stringify({ status: spctl.status, error: spctl.error?.code, stderr: spctl.stderr }));
    console.log('INFO Gatekeeper assessment recorded; actual downloaded-origin approval remains unverified');
    fs.rmSync(installed, { recursive: true });
    ok(fs.readFileSync(marker, 'utf8') === 'keep user data', 'removing only the installed App retains business data');
    fs.writeFileSync(path.join(scratch, 'acceptance.json'), JSON.stringify({ variant: trial.variant, imageSha256: metadata.imageSha256,
      appTreeSha256: manifest.treeSha256, inputSourceCommit: trial.applicationSourceCommit, packagerCommit: trial.packagerCommit,
      uid: process.getuid(), accountScope: 'current-account isolated HOME, not a clean standard user', failures: t.failures,
      downloadedOriginGatekeeperApproval: 'unverified', nativeReport: read(report), launchServicesReport: read(lsReport) }, null, 2));
    console.log('Trial installation evidence: ' + scratch);
  } catch (error) { t.fail(error.stack || String(error)); console.log('Failed trial fixture retained: ' + scratch); }
  finally {
    for (const child of children.reverse()) await killOwnTree(child);
    // LaunchServices re-parents the owned App; only stop a matching observed birth identity.
    if (lsIdentity) {
      const current = snapshotProcessTable()?.find(row => row.pid === lsIdentity.pid && row.created === lsIdentity.created);
      if (current) process.kill(current.pid, 'SIGTERM');
    }
    if (attached) detachTrial(mount);
    if (!t.failures) fs.rmSync(fixture.home, { recursive: true, force: true });
  }
  t.done();
})();
