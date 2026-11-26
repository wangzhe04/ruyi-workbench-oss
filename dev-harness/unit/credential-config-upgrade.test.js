'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { getFreePort } = require('../free-port');
const { killOwnTree } = require('../lib/kill-own-tree');

const app = path.resolve(__dirname, '../../ruyi-workbench/app/server.js');
const setup = { providers: [{ id: 'deepseek', label: 'DeepSeek', type: 'openai-compat',
  apiStyle: 'chat', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-original-key',
  extraHeaders: { 'X-API-Key': 'fixture-header-value' }, model: 'model' }], activeProvider: 'deepseek' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-vault-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const env = { ...require('../lib/fixture-home').fixtureChildEnv(), RUYI_HOME: root, WIN_CLAUDE_WORKBENCH_HOME: root };
  const config = path.join(root, 'config.json');
  const vault = path.join(root, 'credential-vault-v1.json');
  const read = () => JSON.parse(fs.readFileSync(config, 'utf8'));
  const write = data => fs.writeFileSync(config, JSON.stringify(data));
  // Each operation opens the configuration in a fresh process and unlocks the vault again.
  const run = body => cp.execFileSync(process.execPath, ['-e',
    'const srv = require(process.argv[1]); (async () => {' + body + '})().catch(e=>{console.error(e.code || e.message);process.exitCode=1})', app],
    { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { env, config, vault, run, read, write };
}

test('3.0.2 plaintext provider key survives an upgrade and a settings change', t => {
  const f = fixture(t);
  f.write({ ...setup, version: '3.0.2' });
  f.run('await srv.mutateConfig(c => { c.uiMode = "pro"; });');
  assert.equal(f.read().providers[0].apiKey, 'fixture-original-key');
  assert.ok(!fs.existsSync(f.vault));
});

test('3.0.2 vault collision survives a masked settings POST and restart', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  f.write({ ...setup, credentialEncryptionV1: true });
  f.run('await srv.readConfig()');
  const damaged = f.read();
  assert.equal(damaged.providers[0].apiKey, '');
  damaged.version = '3.0.2';
  damaged.providers[0].apiKey = 'fixture-replacement-key';
  damaged.providers[0].extraHeaders = {};
  f.write(damaged);

  const port = await getFreePort();
  const url = 'http://127.0.0.1:' + port;
  const child = cp.spawn(process.execPath, [app, 'serve', '--port', String(port)], { env: f.env, windowsHide: true, stdio: 'ignore' });
  try {
    let html;
    for (let attempt = 0; attempt < 100 && !html; attempt++) {
      assert.equal(child.exitCode, null);
      html = await fetch(url).then(r => r.ok && r.text()).catch(() => null);
      if (!html) await new Promise(resolve => setTimeout(resolve, 100));
    }
    const token = /name="wcw-token"\s+content="([a-f0-9]+)"/.exec(html)?.[1];
    assert.ok(token);
    const headers = { 'x-wcw-token': token, 'content-type': 'application/json' };
    const status = await (await fetch(url + '/api/status', { headers })).json();
    const providers = status.config.providers;
    assert.equal(providers.length, 2);
    assert.ok(providers.every(p => p.apiKey.startsWith('••••')));
    assert.ok(!JSON.stringify(providers).includes('fixture-header-value'));
    const response = await fetch(url + '/api/config', { method: 'POST', headers, body: JSON.stringify({ providers, uiMode: 'pro' }) });
    assert.equal(response.status, 200);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null && !child.signalCode) { killOwnTree(child); await exited; }
  }
  const loaded = JSON.parse(f.run('const c = await srv.readConfig(); console.log(JSON.stringify([c.uiMode,c.providers.map(p=>[p.id,p.apiKey,p.extraHeaders])]))'));
  assert.equal(loaded[0], 'pro');
  assert.equal(loaded[1].length, 2);
  assert.deepEqual(loaded[1][0], ['deepseek', 'fixture-replacement-key', setup.providers[0].extraHeaders]);
  assert.deepEqual(loaded[1][1].slice(1), ['fixture-original-key', setup.providers[0].extraHeaders]);
  for (const file of [f.config, f.config + '.prev', f.vault]) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const secret of ['fixture-original-key', 'fixture-replacement-key', 'fixture-header-value']) assert.ok(!contents.includes(secret));
  }

  // A second process rotates a key between the first process's read and write.
  const rotate = 'require(process.argv[1]).mutateConfig(c => { c.providers[0].apiKey = "fixture-rotated-key"; });';
  const race = 'await srv.mutateConfig(c => { require("node:child_process").execFileSync(process.execPath, ' +
    JSON.stringify(['-e', rotate, app]) + ', {windowsHide:true}); c.uiMode="simple"; });';
  assert.throws(() => f.run(race), /config_changed/);
  assert.equal(f.run('console.log((await srv.readConfig()).providers[0].apiKey)').trim(), 'fixture-rotated-key');

  const healthy = f.read();
  const previous = fs.readFileSync(f.config + '.prev');
  const vault = fs.readFileSync(f.vault);
  const altered = structuredClone(damaged);
  altered.providers[0].baseUrl = 'https://another.invalid/v1';
  f.write(altered);
  assert.throws(() => f.run('await srv.mutateConfig(c => { c.uiMode="simple"; })'), /binding_mismatch/);
  assert.deepEqual(f.read(), altered);
  assert.deepEqual(fs.readFileSync(f.vault), vault);

  f.write(healthy);
  fs.unlinkSync(f.vault);
  assert.throws(() => f.run('await srv.mutateConfig(c => { c.uiMode="simple"; })'), /credential_vault/);
  assert.deepEqual(f.read(), healthy);
  assert.deepEqual(fs.readFileSync(f.config + '.prev'), previous);
  assert.ok(!fs.existsSync(f.vault));
});
