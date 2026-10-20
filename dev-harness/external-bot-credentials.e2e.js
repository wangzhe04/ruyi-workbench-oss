'use strict';
require('./lib/self-isolate-home.js');
// Real Windows DPAPI + physical vault across fresh Node processes, isolated synthetic data only.
// No server/port, platform API, real credential, npm package or user configuration is involved.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { constBlock, functionBlock } = require('./lib/source-slice');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const readSource = name => fs.readFileSync(path.join(__dirname, '../ruyi-workbench/app/src', name), 'utf8');
async function worker() {
  const input = []; for await (const chunk of process.stdin) input.push(chunk);
  const task = JSON.parse(Buffer.concat(input));
  const secretValues = Object.values(task.values || {}).concat(Object.values(task.expected || {}), Object.values(task.env || {}));
  let ipcClean = true, helpers = 0;
  const helperStages = [];
  const spawn = (file, args, options) => {
    helpers++;
    const visible = JSON.stringify([file, args, options.env]);
    if (secretValues.some(secret => typeof secret === 'string' && secret && visible.includes(secret))) ipcClean = false;
    // Only fixed stage labels are reported: never helper output, exception text or credential data.
    const stages = [], started = Date.now(); helperStages.push(stages);
    const marker = stage => `[Console]::Error.WriteLine('DPAPI_STAGE:${stage}')`;
    let script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    for (const [line, stage] of [["try {", 'started'], ["[void][Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')", 'assembly'],
      ['[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)', 'encoding'],
      ['$op = [Console]::In.ReadLine()', 'input'],
      ['$entropy = [Convert]::FromBase64String([Console]::In.ReadLine())', 'decoded'],
      ['[Array]::Clear($bytes,0,$bytes.Length)', 'protected']]) script = script.replace(line, line + '\n  ' + marker(stage));
    const diagnosticArgs = [...args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')];
    const child = cp.spawn(file, diagnosticArgs, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('spawn', () => stages.push({ stage: 'spawned', ms: Date.now() - started }));
    let diagnostic = '';
    child.stderr.on('data', chunk => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
      let newline;
      while ((newline = diagnostic.indexOf('\n')) >= 0) {
        const line = diagnostic.slice(0, newline).trim(); diagnostic = diagnostic.slice(newline + 1);
        const stage = /^DPAPI_STAGE:(started|assembly|encoding|input|decoded|protected)$/.exec(line)?.[1];
        if (stage && stages.length < 16) stages.push({ stage, ms: Date.now() - started });
      }
    });
    if (task.holdHelperInput) {
      // A complete request must be answered without waiting for the parent's stdin handle to close.
      // Reproduce a delayed EOF deterministically, including on machines where normal end() is fast.
      child.stdin.end = input => child.stdin.write(input);
      child.on('close', () => child.stdin.destroy());
    }
    return child;
  };
  const code = constBlock(readSource('01-config.js'), 'DurableJsonStore') + '\n' + functionBlock(readSource('00-boot.js'), 'runKeyedChain')
    + '\n' + readSource('01j-local-crypto.js') + '\n' + readSource('13y-external-bot-credentials.js') + '\nExternalBotCredentials';
  const context = { fs, fsp, path, crypto, Buffer, TextDecoder, setTimeout, clearTimeout, paths: { data: task.data },
    process: { platform: process.platform, env: { ...process.env, ...(task.env || {}) } },
    require: name => { if (name === 'node:path') return path; if (name !== 'node:child_process') throw new Error('unexpected module'); return { spawn }; },
    atomicWriteJson: async (file, value) => {
      const temporary = file + '.fixture-tmp'; await fsp.writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await fsp.rename(temporary, file);
    } };
  const api = vm.runInNewContext(code, context);
  const started = Date.now(); let answer;
  try {
    if (task.op === 'save' || task.op === 'replace' || task.op === 'partial') {
      const status = await api.inspect(task.connection);
      answer = await api.save(task.connection, { set: task.values, remove: task.remove || [], expectedRevision: status.credentialRevision, ...(task.op === 'replace' ? { replaceAll: true } : {}) });
    } else if (task.op === 'match') {
      const snapshot = await api.snapshot(task.connection);
      answer = { matches: Object.entries(task.expected).every(([slot, value]) => snapshot.values[slot] === value),
        credentialRevision: snapshot.credentialRevision, fields: snapshot.fields };
    } else answer = await api.inspect(task.connection);
    process.stdout.write(JSON.stringify({ ok: true, result: answer, elapsedMs: Date.now() - started, helpers, ipcClean, helperStages }));
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, errorCode: error.code || 'fixture.failed', helpers, ipcClean, helperStages })); }
}
async function main() {
  const t = createRunner('EXTERNAL BOT CREDENTIALS'), { ok } = t;
  if (process.platform !== 'win32') { console.log('SKIP Windows DPAPI runtime (env-only behavior is covered in unit tests)'); t.done(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-bot-credentials-'));
  const data = path.join(root, 'data'), children = new Set(), times = [];
  for (const directory of ['data', 'home', 'local', 'roaming']) fs.mkdirSync(path.join(root, directory));
  const vaultFile = path.join(data, 'external-bot-credentials.json');
  const connection = { id: 'bot_fixture', platform: 'feishu', appId: 'cli_fixture', tenantId: 'tenant_fixture', botUserId: 'ou_fixture', enabled: false };
  const values = { verificationToken: 'SYNTHETIC_VERIFY_' + crypto.randomBytes(8).toString('hex'), encryptKey: 'SYNTHETIC_ENCRYPT_' + crypto.randomBytes(8).toString('hex'), appSecret: 'SYNTHETIC_APP_' + crypto.randomBytes(8).toString('hex') };
  async function run(task) {
    return new Promise((resolve, reject) => {
      const childEnv = { ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data,
        USERPROFILE: path.join(root, 'home'), HOME: path.join(root, 'home'), LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming') };
      const child = cp.spawn(process.execPath, [__filename, '--credential-worker'], { env: { ...process.env, ...childEnv }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child); const chunks = []; let size = 0;
      // A save may inspect, protect, and inspect again, each with its own bounded cold helper startup.
      const timer = setTimeout(() => { killOwnTree(child); reject(new Error('credential fixture timed out')); }, 60000);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > 65536) { killOwnTree(child); reject(new Error('credential fixture output exceeded limit')); } else chunks.push(chunk); });
      child.stderr.resume(); child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer); children.delete(child);
        if (code !== 0) { reject(new Error('credential fixture process failed')); return; }
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          if (Object.values(values).some(secret => text.includes(secret))) throw new Error('credential fixture leaked a secret');
          const result = JSON.parse(text); if (result.elapsedMs !== undefined) times.push(result.elapsedMs); resolve(result);
        } catch (error) { reject(error); }
      });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ data, connection, ...task }));
    });
  }
  try {
    let result = await run({ op: 'inspect' });
    ok(result.ok && !fs.existsSync(vaultFile) && result.helpers === 0, 'A1 absent-vault inspection creates nothing and starts no helper');
    result = await run({ op: 'save', values, holdHelperInput: true });
    console.log('DPAPI_DIAG ' + JSON.stringify(result.helperStages));
    ok(result.ok && Object.values(result.result.fields).every(field => field.present && field.ready), 'A2 real DPAPI protects and reads each configured field' + (result.errorCode ? ' (' + result.errorCode + ')' : ''));
    ok(result.ok && result.helpers >= 2, 'A2b framed protect/unprotect complete while helper stdin stays open');
    ok(result.ipcClean && result.helpers > 0, 'A3 no secret appears in helper argv or environment');
    const ciphertext = fs.readFileSync(vaultFile, 'utf8');
    ok(Object.values(values).every(secret => !ciphertext.includes(secret)), 'A4 physical vault contains no plaintext fixture credential');
    const previousRevision = result.result.credentialRevision;
    result = await run({ op: 'match', expected: values });
    ok(result.ok && result.result.matches, 'A5 a fresh Node process decrypts the persisted DPAPI vault');
    ok(result.result.credentialRevision !== previousRevision, 'A6 process restart invalidates old setup revision observations');
    result = await run({ op: 'match', connection: { ...connection, tenantId: 'foreign_tenant' }, expected: values });
    ok(!result.ok && result.errorCode === 'external_credentials.identity_mismatch', 'B1 a different bound tenant cannot reuse saved credentials');
    const selected = { ...connection, appSecretEnv: 'RUYI_BOT_FAKE_APP' };
    result = await run({ op: 'match', connection: selected, expected: { ...values, appSecret: '' } });
    ok(result.ok && result.result.matches && result.result.fields.appSecret.errorCode === 'external_credentials.env_missing', 'B2 missing explicitly selected env never falls back to local ciphertext');
    result = await run({ op: 'match', connection: selected, env: { RUYI_BOT_FAKE_APP: 'SYNTHETIC_ENV_ONLY' }, expected: { ...values, appSecret: 'SYNTHETIC_ENV_ONLY' } });
    ok(result.ok && result.result.matches && result.result.fields.appSecret.source === 'env' && result.ipcClean, 'B3 mixed local/env credentials resolve without forwarding env secrets to helper');
    const damaged = JSON.parse(ciphertext); damaged.records[0].cipher = crypto.randomBytes(96).toString('base64'); fs.writeFileSync(vaultFile, JSON.stringify(damaged));
    result = await run({ op: 'inspect' });
    ok(result.ok && Object.values(result.result.fields).every(field => field.present && !field.ready && field.errorCode === 'external_credentials.decrypt_failed'), 'C1 unreadable ciphertext exposes only presence/revision/error for recovery');
    result = await run({ op: 'match', expected: values });
    ok(!result.ok && result.errorCode === 'external_credentials.decrypt_failed', 'C2 unreadable ciphertext never becomes usable values');
    result = await run({ op: 'partial', values: { appSecret: 'SYNTHETIC_PARTIAL' } });
    ok(!result.ok && result.errorCode === 'external_credentials.decrypt_failed', 'C3 partial update cannot silently discard unreadable credentials');
    result = await run({ op: 'replace', connection: selected, values: { verificationToken: values.verificationToken, encryptKey: values.encryptKey }, remove: ['appSecret'] });
    ok(result.ok && result.result.fields.encryptKey.ready && result.result.fields.appSecret.source === 'env' && !result.result.fields.appSecret.ready, 'C4 explicit complete mixed-source replacement recovers while retaining missing-env failure');
    result = await run({ op: 'match', connection: selected, expected: { ...values, appSecret: '' } });
    ok(result.ok && result.result.matches, 'C5 recovered local values persist across another fresh process');
    fs.writeFileSync(vaultFile, '{');
    result = await run({ op: 'replace', values });
    ok(!result.ok && result.errorCode === 'external_credentials.storage_unavailable' && fs.readFileSync(vaultFile, 'utf8') === '{', 'D1 malformed envelope cannot be overwritten via replacement recovery');
    ok(!fs.readdirSync(data).some(name => name.includes('.corrupt') || name.includes('.tmp')), 'D2 no plaintext staging/recovery or leftover temporary file');
    console.log('DPAPI fixture operation durations (ms, no credential data): ' + times.join(', '));
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const child of children) killOwnTree(child);
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
}
if (process.argv[2] === '--credential-worker') worker().catch(() => { process.stdout.write('{"ok":false,"errorCode":"fixture.failed"}'); process.exitCode = 1; });
else main().catch(error => { console.error(error.message); process.exitCode = 1; });
