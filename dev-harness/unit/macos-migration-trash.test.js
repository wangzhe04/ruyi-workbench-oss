'use strict';
require('../lib/self-isolate-home');
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-trash-unit-'));
process.env.RUYI_HOME = path.join(root, 'data'); fs.mkdirSync(process.env.RUYI_HOME);
delete process.env.RUYI_MIGRATION_RECYCLE_STUB_DIR;
const { loadServerInternals } = require('../lib/server-internals');
const S = loadServerInternals(['MigrationTrashHooks', 'migrationSendToRecycleBin', 'migrationTrashTarget', 'migrationRecycle', 'migrationRememberPackages', 'mutateConfig'], { testPlatform: 'darwin', withEval: true });
const target = path.join(root, '旧包 空格😀;$(touch should-not-exist)');
test('Mac Trash uses one literal path argument and requires confirmed native success', async () => {
  fs.mkdirSync(target); const trashedPath = path.join(root, 'moved');
  S.MigrationTrashHooks.helperPath = () => process.execPath;
  S.MigrationTrashHooks.run = async (exe, args, options) => {
    assert.equal(exe, process.execPath); assert.deepEqual(args, [target]); assert.equal(options.shell, undefined);
    fs.renameSync(target, trashedPath);
    return { ok: true, stdout: JSON.stringify({ ok: true, trashedPath }) };
  };
  assert.deepEqual(await S.migrationSendToRecycleBin(target), { via: 'macos-trash', trashedPath });
});
test('missing helper, symbolic target and failed/malformed/timeout results fail closed', async () => {
  fs.mkdirSync(target);
  S.MigrationTrashHooks.helperPath = () => path.join(root, 'missing');
  assert.equal((await S.migrationSendToRecycleBin(target)).error, 'trash-helper-unavailable');
  S.MigrationTrashHooks.helperPath = () => process.execPath;
  const link = path.join(root, 'alias'); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await S.migrationSendToRecycleBin(link)).error, 'invalid-trash-target');
  for (const result of [{ ok: false, timedOut: true, stdout: '{}' }, { ok: true, stdout: 'bad' },
    { ok: true, stdout: JSON.stringify({ ok: true, trashedPath: '/missing' }) }]) {
    S.MigrationTrashHooks.run = async () => result;
    assert.equal((await S.migrationSendToRecycleBin(target)).error, 'recycle-failed');
    assert.equal(fs.statSync(target).isDirectory(), true);
  }
});
test('Mac App logical package maps to the whole bundle; incomplete layouts are refused', () => {
  const bundle = path.join(root, '旧 如意.app'), workbench = path.join(bundle, 'Contents/Resources/workbench');
  fs.mkdirSync(workbench, { recursive: true });
  assert.equal(S.migrationTrashTarget(workbench), null);
  fs.mkdirSync(path.join(bundle, 'Contents/MacOS')); fs.writeFileSync(path.join(bundle, 'Contents/MacOS/RuyiDesktop'), 'fixture');
  fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), 'fixture');
  assert.equal(S.migrationTrashTarget(workbench), fs.realpathSync(bundle));
  assert.equal(S.migrationTrashTarget(target), fs.realpathSync(target));
  const upper = path.join(root, 'Upper.APP'); fs.renameSync(bundle, upper);
  assert.equal(S.migrationTrashTarget(path.join(upper, 'Contents/Resources/workbench')), fs.realpathSync(upper));
  assert.equal(S.migrationTrashTarget(path.join(upper, 'Contents/Resources')), null);
});
test('physical App aliases cannot bypass references or running registry entries', async () => {
  const app = path.join(root, 'Aliased.app'), wb = path.join(app, 'Contents/Resources/workbench');
  fs.mkdirSync(path.join(wb, 'app'), { recursive: true }); fs.mkdirSync(path.join(app, 'Contents/MacOS'));
  fs.writeFileSync(path.join(wb, 'app/server.js'), '// fixture');
  fs.writeFileSync(path.join(wb, 'package.json'), JSON.stringify({ name: 'ruyi-workbench', version: 'fixture' }));
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), 'fixture'); fs.writeFileSync(path.join(app, 'Contents/MacOS/RuyiDesktop'), 'fixture');
  const alias = path.join(root, 'parent-alias'); fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliasWb = path.join(alias, 'Aliased.app/Contents/Resources/workbench');
  fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify({ configSchema: 14, providers: [], includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
    desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [{ id: 'retained', command: path.join(app, 'Contents/MacOS/RuyiDesktop') }] }));
  await S.migrationRememberPackages([wb, aliasWb]);
  let invoked = 0; S.MigrationTrashHooks.run = async () => { invoked++; throw new Error('must not move referenced/running App'); };
  const referenced = await S.migrationRecycle({ root: aliasWb, confirm: aliasWb });
  assert.equal(referenced.error, 'referenced'); assert.equal(invoked, 0); assert.ok(fs.existsSync(app));
  await S.mutateConfig(config => { config.externalMcpServers = []; });
  const regFile = path.join(process.env.RUYI_HOME, 'install-registry.json'), reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  reg.packages.find(p => p.packageRoot === wb).pid = 123456789;
  fs.writeFileSync(regFile, JSON.stringify(reg)); S.__eval('migrationPidAlive = pid => pid === 123456789');
  assert.equal((await S.migrationRecycle({ root: aliasWb, confirm: aliasWb })).error, 'running'); assert.equal(invoked, 0);
  fs.unlinkSync(alias); // remove the test-owned recursive ancestor alias before fixture teardown
});
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
