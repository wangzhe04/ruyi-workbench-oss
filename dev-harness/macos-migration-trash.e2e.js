'use strict';
require('./lib/self-isolate-home');
// Moves only this test's disposable old App through the real macOS Trash API, then restores it.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacTrashHelper } = require('../ruyi-workbench/tools/build-macos-trash-helper');
const { inventory, treeDigest, run, sha256 } = require('../ruyi-workbench/tools/macos-offline-lib');
const t = createRunner('MACOS MIGRATION TRASH');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trash-e2e-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
let moved, running;
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP actual Trash requires macOS'); return; }
    const home = path.join(root, 'home'), data = path.join(home, 'data');
    process.env.HOME = process.env.USERPROFILE = home; process.env.RUYI_HOME = data;
    delete process.env.WIN_CLAUDE_WORKBENCH_HOME; delete process.env.RUYI_MIGRATION_RECYCLE_STUB_DIR;
    write(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, providers: [], includeWorkbenchMcp: false,
      autoImportClaudeCodeMcp: false, stewardEnabledV1: false, schedulerEnabledV1: false, desktopMcp: { enabled: false, autodetect: false } }));
    const helper = process.env.RUYI_TRASH_HELPER || buildMacTrashHelper(path.join(root, 'trash-helper'));
    const S = loadServerInternals(['MigrationTrashHooks', 'migrationRecycle', 'migrationRememberPackages', 'migrationCurrentRoot']);
    S.MigrationTrashHooks.helperPath = () => helper;
    const app = path.join(root, '旧 如意😀;$(literal).app'), wb = path.join(app, 'Contents/Resources/workbench');
    write(path.join(wb, 'app/server.js'), '// test-owned old package');
    write(path.join(wb, 'package.json'), JSON.stringify({ name: 'ruyi-workbench', version: 'fixture-old' }));
    write(path.join(app, 'Contents/Info.plist'), 'test-owned marker');
    write(path.join(app, 'Contents/MacOS/RuyiDesktop'), 'test-owned marker');
    write(path.join(app, 'Contents/outside-workbench.txt'), 'retain entire bundle');
    const identity = fs.statSync(app), digest = treeDigest(inventory(app));
    let allowOwnedMove = false;
    const nativeRun = S.MigrationTrashHooks.run;
    S.MigrationTrashHooks.run = async (exe, args, options) => {
      // A future failed negative guard must never send the real repository or user data
      // to Trash. Only the final positive control can move this exact disposable App.
      if (!allowOwnedMove || args.length !== 1 || fs.realpathSync.native(args[0]) !== fs.realpathSync.native(app)) throw new Error('Unowned or unexpected native Trash invocation');
      const result = await nativeRun(exe, args, options);
      try {
        const reply = JSON.parse(result.stdout), stat = fs.statSync(reply.trashedPath);
        if (stat.dev === identity.dev && stat.ino === identity.ino) moved = { path: reply.trashedPath, original: app, identity };
      } catch { /* no confirmed owned Trash result */ }
      return result;
    };
    const current = S.migrationCurrentRoot();
    t.ok((await S.migrationRecycle({ root: wb, confirm: 'wrong' })).error === 'confirm-mismatch', 'exact target confirmation remains required');
    t.ok((await S.migrationRecycle({ root: current, confirm: current })).error === 'current-package', 'current package cannot be discarded');
    t.ok((await S.migrationRecycle({ root, confirm: root })).error === 'contains-data', 'a directory containing business data is protected');
    const alias = path.join(root, 'alias'); fs.symlinkSync(wb, alias);
    t.ok((await S.migrationRecycle({ root: alias, confirm: alias })).error === 'invalid-trash-target', 'symbolic package aliases cannot authorize a move');
    await S.migrationRememberPackages([wb]);
    const registry = path.join(data, 'install-registry.json'), reg = JSON.parse(fs.readFileSync(registry, 'utf8'));
    running = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env }, stdio: 'ignore' });
    await new Promise((resolve, reject) => { running.once('spawn', resolve); running.once('error', reject); });
    const row = reg.packages.find(p => p.packageRoot === wb); row.pid = running.pid; row.lastLaunchedAt = new Date().toISOString();
    fs.writeFileSync(registry, JSON.stringify(reg));
    t.ok((await S.migrationRecycle({ root: wb, confirm: wb })).error === 'running', 'a registered running package is retained');
    await killOwnTree(running); running = null;
    row.pid = 0; fs.writeFileSync(registry, JSON.stringify(reg));
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { old: { command: process.execPath, args: [path.join(wb, 'app/server.js')] } } }));
    t.ok((await S.migrationRecycle({ root: wb, confirm: wb })).error === 'referenced', 'an externally referenced old package is retained');
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { host: { command: path.join(app, 'Contents/MacOS/RuyiDesktop') } } }));
    t.ok((await S.migrationRecycle({ root: wb, confirm: wb })).error === 'referenced', 'a reference to the native host outside workbench also protects the whole App');
    write(path.join(home, '.claude.json'), '{}');
    allowOwnedMove = true;
    const result = await S.migrationRecycle({ root: wb, confirm: wb });
    t.ok(result.ok && result.via === 'macos-trash' && !fs.existsSync(app), 'production migration handler moves the whole owned App through native macOS Trash');
    if (!moved) throw new Error('Native Trash did not return a confirmed destination: ' + JSON.stringify(result));
    const trashed = fs.statSync(moved.path);
    t.ok(trashed.dev === identity.dev && trashed.ino === identity.ino && treeDigest(inventory(moved.path)) === digest,
      'actual Trash contains the same complete directory, including resources outside workbench');
    fs.renameSync(moved.path, app); moved = null;
    t.ok(treeDigest(inventory(app)) === digest, 'the exact test-owned trashed App can be restored without loss');
    t.ok(!JSON.parse(fs.readFileSync(registry, 'utf8')).packages.some(p => p.packageRoot === wb), 'successful disposal removes only its old registry entry');
    let refused = false; try { run(helper, ['/']); } catch { refused = true; }
    t.ok(refused, 'native helper rejects the filesystem root before attempting a move');
    if (process.env.RUYI_TRASH_REPORT) fs.writeFileSync(process.env.RUYI_TRASH_REPORT, JSON.stringify({
      helperSha256: sha256(helper), originalApp: app, originalIdentity: { dev: identity.dev, ino: identity.ino },
      appTreeSha256: digest, nativeResult: result, restored: fs.existsSync(app) && treeDigest(inventory(app)) === digest,
      failures: t.failures, scope: 'production migration handler, native FileManager Trash, test-owned App only; restored before cleanup',
    }, null, 2) + '\n', { flag: 'wx' });
  } catch (e) { t.fail(e.stack || String(e)); console.log('Failed Trash fixture retained: ' + root); }
  finally {
    if (running) await killOwnTree(running);
    if (moved) {
      const stat = fs.statSync(moved.path);
      if (stat.dev === moved.identity.dev && stat.ino === moved.identity.ino && !fs.existsSync(moved.original)) fs.renameSync(moved.path, moved.original);
    }
    if (!t.failures) fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();
