'use strict';
require('./lib/self-isolate-home');
// Manual whole-App upgrade/rollback drill using two real, different frozen DMGs.
// No auto-updater or compatibility claim for a newer data schema is implied.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { inventory, treeDigest, run } = require('../ruyi-workbench/tools/macos-offline-lib');
const { verifyDistribution, verifyTrialDirectory, attachTrial, detachTrial, installTrial, verifyInstalledApp } = require('../ruyi-workbench/tools/package-macos-trial');
const t = createRunner('MACOS UPGRADE ROLLBACK');
const oldDistribution = process.env.RUYI_UPGRADE_OLD_DISTRIBUTION, newDistribution = process.env.RUYI_UPGRADE_NEW_DISTRIBUTION;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
async function until(fn, timeout = 90000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error('Upgrade drill timed out'); }
(async () => {
  if (process.platform !== 'darwin' || !oldDistribution || !newDistribution) {
    if (process.env.RUYI_UPGRADE_REQUIRED === '1') t.fail('Two real Mac trial distributions are required');
    else console.log('SKIP actual upgrade/rollback requires old and new Mac trial distributions');
    t.done(); return;
  }
  const fixture = fixtureChildEnv({ perTest: true }), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-upgrade-'));
  const children = [], mounts = new Set(), reports = [];
  const digest = p => treeDigest(inventory(p));
  async function host(app, data, name) {
    const report = path.join(scratch, name + '.json');
    const child = cp.spawn(path.join(app, 'Contents/MacOS/RuyiDesktop'), ['--acceptance-report', report, '--acceptance-auto-quit'],
      { cwd: scratch, env: { ...process.env, ...fixture.env, RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: '', PATH: '/usr/bin:/bin',
        RUYI_NODE_PATH: '/missing/external-node', NODE_OPTIONS: '', NODE_PATH: '', PYTHONPATH: '', PYTHONHOME: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child); child.stderr.on('data', () => {});
    await until(() => child.exitCode !== null);
    const result = read(report); reports.push(result);
    if (result.servicePID) await until(() => { try { process.kill(result.servicePID, 0); return false; } catch (e) { return e.code === 'ESRCH'; } });
    return child.exitCode === 0 && result.state === 'ready' && result.page?.configLoaded;
  }
  try {
    const previous = verifyDistribution(oldDistribution), next = verifyDistribution(newDistribution);
    if (previous.variant !== next.variant || previous.appTreeSha256 === next.appTreeSha256) throw new Error('Drill requires different old/new payloads of the same variant');
    t.ok(true, 'old and new image checksums/provenance verify and bind different same-variant builds');
    const applications = path.join(fixture.home, 'Applications', '升级 回退😀'), stage = path.join(fixture.home, 'incoming');
    const mountOld = path.join(scratch, 'mount-old'); attachTrial(path.join(oldDistribution, previous.image), mountOld); mounts.add(mountOld);
    const oldManifest = verifyTrialDirectory(mountOld).manifest, installed = installTrial(mountOld, applications);
    detachTrial(mountOld); mounts.delete(mountOld);
    const workspace = path.join(fixture.home, 'workspace'); fs.mkdirSync(workspace);
    const seed = data => {
      fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
      fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 12, permissionMode: 'default', defaultWorkspace: workspace,
        providers: [], autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, stewardEnabledV1: false, schedulerEnabledV1: false,
        desktopMcp: { enabled: false, autodetect: false } }));
      fs.writeFileSync(path.join(data, 'sessions/retained.txt'), '旧会话中文');
    };
    const oldSmoke = path.join(fixture.home, 'old-smoke'); seed(oldSmoke);
    t.ok(await host(installed, oldSmoke, 'old-before'), 'previous installed App starts after its image is ejected and its service exits cleanly');
    const data = path.join(fixture.home, 'data'), snapshot = path.join(fixture.home, 'backup-before-upgrade'); seed(data);
    run('/usr/bin/ditto', [data, snapshot]); const savedData = digest(snapshot), savedApp = digest(installed);
    t.ok(savedData === digest(data), 'offline complete data snapshot preserves representative legacy config and session bytes');
    const corrupt = path.join(fixture.home, 'corrupt'); fs.mkdirSync(corrupt);
    for (const name of ['distribution.json', 'trial-manifest.json', previous.image + '.sha256']) fs.copyFileSync(path.join(oldDistribution, name), path.join(corrupt, name));
    fs.writeFileSync(path.join(corrupt, previous.image), 'corrupt image');
    let rejected = false; try { verifyDistribution(corrupt); } catch { rejected = true; }
    t.ok(rejected && digest(installed) === savedApp && digest(data) === savedData, 'corrupt distribution is refused before any old App or data changes');
    const partial = path.join(fixture.home, 'incomplete.app'); fs.mkdirSync(partial);
    rejected = false; try { verifyInstalledApp(partial, oldManifest); } catch { rejected = true; }
    t.ok(rejected && digest(installed) === savedApp, 'incomplete staged copy fails integrity checks while the previous App remains usable');
    const mountNew = path.join(scratch, 'mount-new'); attachTrial(path.join(newDistribution, next.image), mountNew); mounts.add(mountNew);
    const newManifest = verifyTrialDirectory(mountNew).manifest, staged = installTrial(mountNew, stage);
    detachTrial(mountNew); mounts.delete(mountNew);
    t.ok(digest(staged) === next.appTreeSha256 && digest(installed) === savedApp, 'complete new App is validated separately while the old installation remains intact');
    const retained = path.join(fixture.home, 'rollback', 'Ruyi.app'); fs.mkdirSync(path.dirname(retained));
    fs.renameSync(installed, retained); fs.renameSync(staged, installed);
    t.ok(digest(retained) === savedApp && digest(installed) === next.appTreeSha256 && digest(data) === savedData,
      'whole-App replacement keeps the previous signed App and leaves business data separate');
    t.ok(await host(installed, data, 'new-after'), 'new installed App initializes the real workbench and releases its service after upgrade');
    t.ok(read(path.join(data, 'config.json')).configSchema === 14 && fs.readFileSync(path.join(data, 'sessions/retained.txt'), 'utf8') === '旧会话中文',
      'new build migrates representative schema12 config and retains the old session bytes');
    fs.writeFileSync(path.join(data, 'after-upgrade.txt'), 'newer business data');
    const newerData = digest(data), newKept = path.join(fixture.home, 'retained-new.app');
    fs.renameSync(installed, newKept); fs.renameSync(retained, installed);
    t.ok(digest(data) === newerData && fs.existsSync(path.join(data, 'after-upgrade.txt')), 'App-only rollback does not silently erase post-upgrade business data');
    const restored = path.join(fixture.home, 'restored-data'); run('/usr/bin/ditto', [snapshot, restored]);
    t.ok(digest(restored) === savedData && digest(data) === newerData, 'rollback restores the selected complete snapshot to a fresh data root and retains newer data');
    t.ok(await host(installed, restored, 'old-restored'), 'retained previous App starts using the restored pre-upgrade data');
    t.ok(digest(snapshot) === savedData && fs.readFileSync(path.join(restored, 'sessions/retained.txt'), 'utf8') === '旧会话中文',
      'backup remains immutable and original session bytes survive the full drill');
    verifyInstalledApp(installed, oldManifest); verifyInstalledApp(newKept, newManifest);
    verifyDistribution(oldDistribution); verifyDistribution(newDistribution);
    t.ok(true, 'both signed App payloads and source distributions remain unchanged after upgrade and rollback');
    fs.writeFileSync(path.join(scratch, 'acceptance.json'), JSON.stringify({ variant: next.variant, previousImageSha256: previous.imageSha256,
      nextImageSha256: next.imageSha256, previousSourceCommit: previous.applicationSourceCommit, nextSourceCommit: next.applicationSourceCommit,
      schemaScope: 'schema12 forward normalization to14; same product version3.0.1 build-to-build rollback with full snapshot',
      snapshotTreeSha256: savedData, reports, failures: t.failures, cleanStandardUser: false }, null, 2));
    console.log('Upgrade rollback evidence: ' + scratch);
  } catch (e) { t.fail(e.stack || String(e)); console.log('Failed upgrade fixture retained: ' + scratch); }
  finally {
    for (const child of children.reverse()) await killOwnTree(child);
    for (const mount of mounts) detachTrial(mount);
    if (!t.failures) fs.rmSync(fixture.home, { recursive: true, force: true });
    t.done();
  }
})();
