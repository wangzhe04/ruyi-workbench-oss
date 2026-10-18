'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const { releaseEnvironment, packageAndCheck } = require('../lib/release-checks');

test('release child paths cannot inherit another installation, CLI home or injected test server', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-release-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inherited = { ...process.env, RUYI_HOME: 'external-data', KIMI_CODE_HOME: 'external-kimi', WCW_DATA_DIR: 'external-acc',
    CLAUDE_CONFIG_DIR: 'external-claude', RUYI_TOOLBOX_HOME: 'external-toolbox', ruyi_toolbox_home: 'external-alias', WCW_CLAUDE_PROJECTS_DIR: 'external-projects',
    HOMEDRIVE: 'Z:', HOMEPATH: '\\external-home', NODE_OPTIONS: '--require=external.js', RUYI_TEST_SERVER_JS: 'external-server.js', node_options: 'another-injection' };
  const env = releaseEnvironment(path.join(root, 'home'), path.join(root, 'data'), inherited);
  const result = cp.execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env, windowsHide: true, encoding: 'utf8' });
  const actual = JSON.parse(result);
  for (const key of ['RUYI_HOME', 'WIN_CLAUDE_WORKBENCH_HOME', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'KIMI_CODE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'RUYI_TOOLBOX_HOME', 'WCW_CLAUDE_PROJECTS_DIR', 'WCW_DATA_DIR', 'ACC_INSTALL_DIR', 'TEMP', 'TMP']) {
    assert.ok(path.resolve(actual[key]).startsWith(root + path.sep), key);
  }
  assert.equal(actual.HOMEDRIVE + actual.HOMEPATH, env.HOME, 'Windows home variables agree with the isolated home');
  for (const key of ['NODE_OPTIONS', 'node_options', 'RUYI_TEST_SERVER_JS', 'PYTHONHOME', 'PYTHONPATH']) assert.equal(actual[key], undefined, key);
  assert.equal(inherited.RUYI_HOME, 'external-data', 'parent environment is unchanged');
});

for (const variant of ['slim', 'full']) test(variant + ': a nonzero packager is rejected even with a complete stage and ZIP', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-release-failed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage'), zip = path.join(root, 'test.zip'); fs.mkdirSync(stage);
  const file = path.join(stage, 'package.json');
  assert.throws(() => packageAndCheck({ stage, zip, keys: ['package.json'], listArchive: () => { throw new Error('Must not inspect stale stage'); },
    invoke: () => cp.execFileSync(process.execPath, ['-e', 'const fs=require("fs");fs.writeFileSync(process.argv[1],"{}");fs.writeFileSync(process.argv[2],"partial");process.exit(1)', file, zip], { windowsHide: true, stdio: 'pipe' }),
  }), /Command failed/);
  assert.ok(fs.existsSync(file) && fs.existsSync(zip), 'fixture actually left both artifacts');
});

test('a zero exit with a populated stage still rejects a missing, unreadable or incomplete ZIP', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-release-zip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}'); const zip = path.join(root, 'test.zip');
  const spec = { invoke: () => {}, stage: root, zip, keys: ['package.json'], listArchive: () => '' };
  assert.throws(() => packageAndCheck(spec), /Missing or empty ZIP/);
  fs.writeFileSync(zip, 'partial');
  assert.throws(() => packageAndCheck({ ...spec, listArchive: () => { throw new Error('invalid archive'); } }), /invalid archive/);
  assert.throws(() => packageAndCheck(spec), /listing is incomplete/);
  const entries = Array.from({ length: 11 }, (_, i) => 'file-' + i).join('\n');
  assert.throws(() => packageAndCheck({ ...spec, listArchive: () => entries }), /Missing ZIP entry: package.json/);
  assert.equal(packageAndCheck({ ...spec, listArchive: () => entries + '\npackage.json' }).entries, 12);
});

test('ZIP must include staged directory contents, ACC payload and bundled Node', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-release-contents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = ['docs', 'mcp/ai-computer-control/install.py', 'runtime/node/node.exe'];
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  for (const file of keys.slice(1)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), 'fixture'); }
  const zip = path.join(root, 'test.zip'); fs.writeFileSync(zip, 'fixture');
  const base = Array.from({ length: 11 }, (_, i) => 'file-' + i).concat('docs/');
  const spec = { invoke: () => {}, stage: root, zip, keys, listArchive: () => base.join('\n') };
  assert.throws(() => packageAndCheck(spec), /Missing ZIP entry: docs/);
  base.push('docs/README.md');
  assert.throws(() => packageAndCheck(spec), /Missing ZIP entry: mcp/);
  base.push(keys[1]);
  assert.throws(() => packageAndCheck(spec), /Missing ZIP entry: runtime/);
  base.push(keys[2]);
  assert.equal(packageAndCheck(spec).files, 3);
});
