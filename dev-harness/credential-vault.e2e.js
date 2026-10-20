'use strict';
require('./lib/self-isolate-home.js');
// Real config migration + Windows DPAPI across fresh processes. Synthetic credentials, no model calls.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
async function worker() {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const task = JSON.parse(Buffer.concat(chunks));
  try {
    const app = require('./lib/server-internals').loadServerInternals(['readConfig', 'mutateConfig', 'PrivacyCore']);
    const hooks = app.PrivacyCore.configHooks;
    let config = await app.readConfig();
    if (task.recoveryCrash) {
      const previous = fs.readFileSync(path.join(process.env.RUYI_HOME, 'config.json'), 'utf8');
      await app.mutateConfig(current => { current.providers[0].apiKey = task.replace; return {}; });
      const journal = await hooks.sealLocal(JSON.stringify({ version: 1, previous }), 'credential-import', 'journal-v1');
      fs.writeFileSync(path.join(process.env.RUYI_HOME, 'credential-import-v1.json'), JSON.stringify(journal));
      process.stdout.write(JSON.stringify({ ok: true, journalWritten: true })); return;
    }
    if (task.cacheTamper) {
      const file = path.join(process.env.RUYI_HOME, 'credential-vault-v1.json'), original = fs.readFileSync(file, 'utf8');
      const cfg = path.join(process.env.RUYI_HOME, 'config.json'), old = new Date(Date.now() - 30000); fs.utimesSync(cfg, old, old);
      await app.readConfig(); await app.readConfig();
      try {
        const state = JSON.parse(original), tag = Buffer.from(state.records[0].envelope.tag, 'base64'); tag[0] ^= 1; state.records[0].envelope.tag = tag.toString('base64');
        fs.writeFileSync(file, JSON.stringify(state)); await app.readConfig();
      } finally { fs.writeFileSync(file, original); }
    }
    if (task.replace) {
      await app.mutateConfig(current => { current.providers[0].apiKey = task.replace; return {}; });
      config = await app.readConfig();
    }
    const provider = config.providers.find(item => item.id === 'fixture');
    process.stdout.write(JSON.stringify({ ok: true, matches: provider?.apiKey === task.expected,
      headersMatch: provider?.extraHeaders?.['x-fixture-secret'] === task.header, encryption: config.credentialEncryptionV1 === true }));
  } catch (error) {
    const code = String(error?.code || 'unknown');
    process.stdout.write(JSON.stringify({ ok: false, code: /^credential_vault\.[a-z_]+$/.test(code) ? code : 'worker_failed' }));
  }
}
async function main() {
  const t = createRunner('CREDENTIAL VAULT');
  if (process.platform !== 'win32') { console.log('SKIP Windows DPAPI fixture; platform is unsupported'); t.done(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-credential-vault-'));
  const data = path.join(root, 'data'), vaultFile = path.join(data, 'credential-vault-v1.json'), configFile = path.join(data, 'config.json');
  fs.mkdirSync(data);
  const secret = 'fixture-vault-' + crypto.randomBytes(16).toString('hex'), header = 'fixture-header-' + crypto.randomBytes(16).toString('hex');
  const replacement = 'fixture-replacement-' + crypto.randomBytes(16).toString('hex');
  const original = { configSchema: 14, credentialEncryptionV1: true, activeProvider: 'fixture',
    providers: [{ id: 'fixture', baseUrl: 'https://example.test/v1', apiKey: secret, model: 'fixture', extraHeaders: { 'x-fixture-secret': header } }],
    enableMcpBridge: false, enableMcpDropIn: false, stewardEnabledV1: false, schedulerEnabledV1: false };
  fs.writeFileSync(configFile, JSON.stringify(original));
  fs.writeFileSync(configFile + '.bak-providers-fixture', JSON.stringify(original));
  fs.writeFileSync(configFile + '.corrupt', '{"apiKey":"' + secret);
  const children = new Set();
  function run(task = {}) {
    return new Promise((resolve, reject) => {
      const home = path.join(root, 'home'); fs.mkdirSync(home, { recursive: true });
      const child = cp.spawn(process.execPath, [__filename, '--worker'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, USERPROFILE: home, HOME: home,
          APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local') } });
      children.add(child); const output = []; let bytes = 0;
      const timer = setTimeout(() => { killOwnTree(child); reject(Error('fixture timeout')); }, 45000);
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) { killOwnTree(child); reject(Error('fixture output limit')); } else output.push(chunk); });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer); children.delete(child);
        if (code !== 0) { reject(Error('fixture process failed')); return; }
        try {
          const value = Buffer.concat(output).toString('utf8');
          if ([secret, header, replacement].some(s => value.includes(s))) throw Error('fixture secret in diagnostics');
          resolve(JSON.parse(value));
        } catch { reject(Error('fixture result invalid')); }
      });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ expected: secret, header, ...task }));
    });
  }
  try {
    const migrated = await run();
    t.ok(migrated.ok && migrated.matches && migrated.headersMatch && migrated.encryption, 'A1 runtime restores synthetic API key and custom authentication header');
    t.ok(fs.existsSync(vaultFile), 'A2 encrypted vault was physically persisted');
    const files = fs.readdirSync(data).filter(name => /^config\.json(?:\.|$)/.test(name) || name === 'credential-vault-v1.json');
    t.ok(files.every(name => { const serialized = fs.readFileSync(path.join(data, name), 'utf8'); return !serialized.includes(secret) && !serialized.includes(header); }), 'A3 main config, old backups, corrupt recovery and vault contain no plaintext fixture credential');
    const disk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    t.ok(disk.credentialRefsV1?.slots.length === 2 && disk.providers[0].apiKey === '', 'A4 configuration has references and empty persistence slots');
    const restarted = await run();
    t.ok(restarted.ok && restarted.matches && restarted.headersMatch, 'A5 fresh Node process unwraps DPAPI master and restores credentials');
    const cached = await run({ cacheTamper: true });
    t.ok(!cached.ok && cached.code === 'credential_vault.decrypt_failed', 'A5b changing the vault invalidates an already-populated runtime config cache');
    const edited = await run({ replace: replacement, expected: replacement });
    t.ok(edited.ok && edited.matches, 'A6 existing mutateConfig writer stores a replacement credential without losing runtime behavior');
    t.ok(!fs.readFileSync(configFile, 'utf8').includes(replacement) && !fs.readFileSync(configFile + '.prev', 'utf8').includes(secret), 'A7 replacement and previous configuration remain encrypted');
    fs.copyFileSync(configFile + '.prev', configFile);
    const recovered = await run(); t.ok(recovered.ok && recovered.matches, 'A8 encrypted previous config restores its original immutable credential revision');
    const before = fs.readFileSync(configFile, 'utf8'), changed = JSON.parse(before); changed.providers[0].baseUrl = 'https://other.test/v1';
    fs.writeFileSync(configFile, JSON.stringify(changed));
    const swapped = await run(); t.ok(!swapped.ok && swapped.code === 'credential_vault.binding_mismatch', 'A9 changing the destination cannot carry the prior credential to a new service');
    fs.writeFileSync(configFile, before);
    const goodVault = fs.readFileSync(vaultFile, 'utf8'), broken = JSON.parse(goodVault);
    const tag = Buffer.from(broken.records[0].envelope.tag, 'base64'); tag[0] ^= 1; broken.records[0].envelope.tag = tag.toString('base64');
    fs.writeFileSync(vaultFile, JSON.stringify(broken));
    const failed = await run(); t.ok(!failed.ok && failed.code === 'credential_vault.decrypt_failed', 'A10 tampered authenticated data fails closed without plaintext fallback');
    t.ok(fs.readFileSync(configFile, 'utf8') === before, 'A11 failed decryption does not rewrite or reset the existing configuration');
    fs.writeFileSync(vaultFile, goodVault);
    const interrupted = await run({ recoveryCrash: true, replace: replacement });
    t.ok(interrupted.ok && interrupted.journalWritten && fs.existsSync(path.join(data, 'credential-import-v1.json')), 'A12 fixture leaves an encrypted interrupted transaction on disk');
    const afterCrash = await run();
    t.ok(afterCrash.ok && afterCrash.matches && !fs.existsSync(path.join(data, 'credential-import-v1.json')), 'A13 fresh process automatically rolls back the unfinished transaction before readConfig returns');
  } catch { t.fail('fixture failed; raw configuration and exception text suppressed'); }
  finally {
    for (const child of children) killOwnTree(child);
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('ruyi-credential-vault-')) throw Error('cleanup scope');
    fs.rmSync(root, { recursive: true, force: true });
  }
  t.done();
}
(process.argv.includes('--worker') ? worker() : main()).catch(() => { console.log('FAIL credential fixture runner'); process.exitCode = 1; });
