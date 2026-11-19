'use strict';
// 150 W6 / 151 stage 3: rewrap the current root's key header from a full recovery package after the
// DPAPI wrapping is lost (reinstall, new machine, administrator password reset). Real generated
// serve and CLI processes, real CurrentUser DPAPI (only for keys created inside this fixture), a real
// full recovery package sealed by the product exporter (WorkDataFullSnapshot.seal) from the fixture.
//
// Journey: new encrypted generation -> serve writes a sealed session and moves a synthetic provider
// key into the credential vault -> export full package -> flip a byte of BOTH DPAPI blobs (machine
// change) -> serve refuses with work_data_key.rewrap_required and rewrap guidance -> wrong password,
// a package of another root, a forged package (right instanceId, wrong master), injected failures
// after the write and after verification, and an argv password are all refused with the header,
// vault and every sealed byte unchanged -> CLI rewrap with the password on stdin -> serve starts and
// reads the original session -> header deleted -> header_missing refusal -> CLI rewrap with
// --password-file -> serve reads the same data again. Passwords are generated per run; the test
// scans every fixture file and every captured output for the password and the masters.
require('./lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { releaseEnvironment } = require('./lib/release-checks');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = require('./lib/harness').createRunner('WORK DATA KEY REWRAP');
const temp = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-key-rewrap-e2e-'));
const base = path.join(root, 'base'), other = path.join(root, 'other'), home = path.join(root, 'home'), outside = path.join(root, 'outside');
const env = releaseEnvironment(home, base);
for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
Object.assign(process.env, env);
const { loadServerInternals } = require('./lib/server-internals');
const api = loadServerInternals(['WorkDataManifest', 'WorkDataKeys', 'LocalSecretCrypto', 'ServerOwnership', 'atomicWriteJson', 'CONFIG_SCHEMA',
  'WorkDataFullSnapshot', 'WorkDataRecovery', 'ExternalBotCredentials', 'VERSION', 'WorkDataKeyRewrap']);
const server = path.resolve(__dirname, '../ruyi-workbench/app/server.js');
const COMMAND = api.WorkDataKeyRewrap.COMMAND;
const PASSWORD = 'synthetic-rewrap-' + crypto.randomBytes(12).toString('hex');
const WRONG = 'synthetic-wrong-' + crypto.randomBytes(12).toString('hex');
const PROVIDER_KEY = 'synthetic-provider-' + crypto.randomBytes(8).toString('hex');
const BOT_SECRET = 'synthetic-bot-' + crypto.randomBytes(8).toString('hex');
const BOT = { id: 'qq-main', platform: 'qq', appId: 'synthetic-app', tenantId: 'synthetic-tenant', enabled: false };
const children = new Set(), outputs = [], spawnedArgs = [], pids = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = async (record, route, body) => {
  const response = await fetch('http://127.0.0.1:' + record.port + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-wcw-token': record.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, value: await response.json() };
};
function spawn(args, { input, extraEnv = {} } = {}) {
  const child = cp.spawn(process.execPath, [server, ...args], { cwd: path.dirname(server), env: { ...releaseEnvironment(home, base), ...extraEnv }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  spawnedArgs.push(child.spawnargs.join(' ')); pids.push(child.pid);
  child.output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { child.output = (child.output + chunk).slice(-24000); });
  if (input === undefined) child.stdin.end(); else child.stdin.end(input);
  children.add(child);
  child.closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { children.delete(child); outputs.push(child.output); resolve(code); }); });
  return child;
}
async function stop(child) { if (child && child.exitCode === null) killOwnTree(child); if (child) await child.closed; }
async function exited(child, ms = 60000) {
  let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('exit_timeout')), ms); });
  try { return await Promise.race([child.closed, timeout]); } finally { clearTimeout(timer); }
}
async function serve() {
  const child = spawn(['serve', '--port', String(await getFreePort())]), end = Date.now() + 45000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw Error('serve_exited: ' + child.output.slice(-2000));
    let record; try { record = JSON.parse(fs.readFileSync(path.join(base, 'runtime.json'), 'utf8')); } catch { /* not yet */ }
    if (record?.pid === child.pid) { try { if ((await request(record, '/health')).value.ok) return { child, record }; } catch { /* not yet */ } }
    await sleep(100);
  }
  throw Error('serve_timeout');
}
const config = () => ({ configSchema: api.CONFIG_SCHEMA, workDataEncryptionV1: true, credentialEncryptionV1: true, permissionMode: 'bypass', stewardEnabledV1: false,
  schedulerEnabledV1: false, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false },
  externalMcpServers: [], activeProvider: 'fake', providers: [{ id: 'fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: PROVIDER_KEY, model: 'fake-model' }], defaultWorkspace: root });
async function encryptedRoot(dir, { bots = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const authority = api.WorkDataManifest.create({ base: dir }), initial = await authority.readActive(), owner = await api.ServerOwnership.acquire([dir]);
  try {
    const candidate = await authority.prepare({ expected: initial, mode: 'encrypted' });
    await api.atomicWriteJson(path.join(candidate.root, 'config.json'), config());
    const keys = api.WorkDataKeys.create({ store: { read: async () => { throw Error('unexpected_key_read'); } }, enabled: () => false, protector: api.LocalSecretCrypto });
    const staged = await keys.stageNew(); staged.lease.release();
    await api.atomicWriteJson(path.join(candidate.root, 'work-data-key-v1.json'), staged.header);
    if (bots) { // A DPAPI-protected external-bot secret: it is lost on a machine change just like the keys.
      const owner = api.ExternalBotCredentials.create({ file: path.join(candidate.root, 'external-bot-credentials.json') });
      await owner.save(BOT, { set: { botSecret: BOT_SECRET }, remove: [], expectedRevision: (await owner.inspect(BOT)).credentialRevision });
    }
    await authority.commit({ expected: initial, candidate });
    return candidate.root;
  } finally { await owner.release(); }
}
async function seal(dir) {
  const owner = await api.ServerOwnership.acquire([dir]);
  try {
    const shot = api.WorkDataFullSnapshot.create({ base: dir, ownership: owner, assertExclusive: async value => value === owner,
      protector: api.LocalSecretCrypto, externalOwner: options => api.ExternalBotCredentials.create(options) });
    return (await shot.seal({ password: PASSWORD, appVersion: api.VERSION, generation: 1 })).serialized;
  } finally { await owner.release(); }
}
// Every byte of the root that matters for recovery. Logs (append-only audit) and the one-shot
// startup notice are the only paths a refused boot or refused CLI may add to.
function bytesIn(dir, skip = name => name === 'logs' || name === 'last-start-error.json' || name === 'runtime.json') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip(entry.name)) continue;
    const full = path.join(dir, entry.name);
    out.push([entry.name, entry.isDirectory() ? bytesIn(full, skip) : crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
  }
  return out;
}
function flipBlob(file) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')), blob = Buffer.from(state.protectedKey, 'base64');
  blob[blob.length - 7] ^= 0x5a; state.protectedKey = blob.toString('base64');
  fs.writeFileSync(file, JSON.stringify(state));
}
function flipBotCipher(file) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')), blob = Buffer.from(state.records[0].cipher, 'base64');
  blob[blob.length - 5] ^= 0x5a; state.records[0].cipher = blob.toString('base64');
  fs.writeFileSync(file, JSON.stringify(state));
}
const lastJson = output => JSON.parse(output.trim().split(/\r?\n/).filter(line => line.startsWith('{')).pop());
// A DPAPI helper that times out under heavy machine load is reported as work_data_key.unlock_unavailable
// before anything is read or written (product-correct, retryable). Retry that one environmental verdict
// a bounded number of times; every other outcome is asserted as is.
async function cli(args, options) {
  for (let attempt = 1; ; attempt++) {
    const child = spawn([COMMAND, ...args], options), code = await exited(child);
    if (code !== 0 && /work_data_key\.unlock_unavailable/.test(child.output) && attempt < 3) { console.log('[retry] DPAPI helper unavailable under load; attempt ' + attempt); continue; }
    return { code, output: child.output };
  }
}
(async () => {
  try {
    if (process.platform !== 'win32') { console.log('SKIP actual Windows DPAPI rewrap'); return; }
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ ...config(), workDataEncryptionV1: false, providers: [] }));
    const generation = await encryptedRoot(base, { bots: true });
    const headerFile = path.join(generation, 'work-data-key-v1.json'), vaultFile = path.join(generation, 'credential-vault-v1.json');
    const botsFile = path.join(generation, 'external-bot-credentials.json');
    const botSecret = async () => (await api.ExternalBotCredentials.create({ file: botsFile }).read(BOT)).botSecret;

    let { child, record } = await serve();
    const created = await request(record, '/api/sessions', { cwd: root, title: 'REWRAP-SYNTHETIC-SESSION' });
    assert.equal(created.status, 200); const sessionId = created.value.session.id;
    assert.equal(JSON.parse(fs.readFileSync(path.join(generation, 'sessions', sessionId + '.json'), 'utf8')).workData, 2);
    await stop(child);
    const vaultState = JSON.parse(fs.readFileSync(vaultFile, 'utf8')), header0 = JSON.parse(fs.readFileSync(headerFile, 'utf8'));
    assert.ok(vaultState.instanceId && vaultState.records.length > 0, 'provider key moved into the DPAPI-wrapped vault');
    t.ok(true, 'A1 encrypted generation serves a sealed session; the provider key lives in the DPAPI-wrapped credential vault');

    const packageFile = path.join(outside, 'full.ruyi-recovery'), otherPackage = path.join(outside, 'other.ruyi-recovery'), forgedPackage = path.join(outside, 'forged.ruyi-recovery');
    const serialized = await seal(base); fs.writeFileSync(packageFile, serialized);
    await encryptedRoot(other); fs.writeFileSync(otherPackage, await seal(other));
    const opened = await api.WorkDataRecovery.open(serialized, PASSWORD), masters = opened.snapshot.keys.map(key => Buffer.from(key.master));
    const workKey = opened.snapshot.keys.find(key => key.purpose === 'work-data' && key.instanceId === header0.instanceId);
    assert.ok(workKey && opened.snapshot.keys.some(key => key.purpose === 'credential' && key.instanceId === vaultState.instanceId));
    assert.ok(opened.snapshot.auxiliaries.some(row => row.type === 'external-bot-credentials'), 'the package carries the portable bot credentials');
    fs.writeFileSync(forgedPackage, await api.WorkDataRecovery.seal({ appVersion: api.VERSION, generation: 1, createdAt: new Date().toISOString(), directories: [], files: [],
      keys: [{ id: workKey.id, purpose: 'work-data', instanceId: workKey.instanceId, protectedKey: workKey.protectedKey, master: crypto.randomBytes(32) }] }, PASSWORD));
    opened.release();
    t.ok(true, 'A2 the product exporter seals a full recovery package carrying this root\'s work-data and credential masters and the portable bot credentials');

    flipBlob(headerFile); flipBlob(vaultFile); flipBotCipher(botsFile);
    await assert.rejects(botSecret(), { code: 'external_credentials.decrypt_failed' });
    const damaged = bytesIn(base), damagedHeader = fs.readFileSync(headerFile), damagedVault = fs.readFileSync(vaultFile), damagedBots = fs.readFileSync(botsFile);
    const refused = spawn(['serve', '--port', String(await getFreePort())]);
    const refusedCode = await exited(refused).catch(error => { console.log('[refusal-output] ' + refused.output.slice(-1500)); throw error; });
    console.log('[refusal-output] ' + refused.output.trim().split(/\r?\n/).slice(-1)[0]);
    assert.equal(refusedCode, 1);
    assert.match(refused.output, /work_data_key\.rewrap_required/); assert.ok(refused.output.includes(COMMAND) && refused.output.includes('--package'));
    assert.match(refused.output, /完整恢复包/);
    const notice = JSON.parse(fs.readFileSync(path.join(generation, 'last-start-error.json'), 'utf8'));
    assert.match(notice.message, /work_data_key\.rewrap_required/); assert.ok(notice.message.includes(COMMAND));
    assert.deepEqual(bytesIn(base), damaged);
    t.ok(true, 'B1 lost DPAPI wrapping refuses serve with work_data_key.rewrap_required, rewrap guidance on stderr and in the startup notice, no data byte changed');

    const unchanged = label => { assert.deepEqual(bytesIn(base), damaged, label); assert.deepEqual(fs.readFileSync(headerFile), damagedHeader); assert.deepEqual(fs.readFileSync(vaultFile), damagedVault); assert.deepEqual(fs.readFileSync(botsFile), damagedBots); };
    let run = await cli(['--package', packageFile], { input: WRONG + '\n' });
    assert.equal(run.code, 1); assert.match(run.output, /work_data_recovery\.authentication/); unchanged('wrong password');
    t.ok(true, 'C1 wrong package password is refused before any write; header, vault and data unchanged');
    run = await cli(['--package', otherPackage], { input: PASSWORD + '\n' });
    assert.equal(run.code, 1); assert.match(run.output, /work_data_key\.rewrap_package_mismatch/); unchanged('other root');
    t.ok(true, 'C2 a package exported from another root is refused as not matching this root; nothing changed');
    run = await cli(['--package', forgedPackage], { input: PASSWORD + '\n' });
    assert.equal(run.code, 1); assert.match(run.output, /work_data_key\.rewrap_package_mismatch/); unchanged('forged master');
    t.ok(true, 'C3 a package with this root\'s instanceId but a different master fails sealed-record authentication; nothing changed');
    for (const point of ['after-write', 'after-verify']) {
      run = await cli(['--package', packageFile], { input: PASSWORD + '\n', extraEnv: { RUYI_TEST_WORK_DATA_REWRAP_FAULT: point } });
      assert.equal(run.code, 1, point); assert.match(run.output, /work_data_key\.rewrap_test_fault/); assert.match(run.output, /已回滚/); unchanged(point);
    }
    t.ok(true, 'C4 injected failures after the first write and after full verification roll the header, vault and bot credentials back to their exact bytes');
    run = await cli(['--package', packageFile, '--password', PASSWORD]);
    assert.equal(run.code, 1); assert.match(run.output, /work_data_key\.rewrap_password_argv_forbidden/); assert.ok(!run.output.includes(PASSWORD)); unchanged('argv password');
    t.ok(true, 'C5 a password on the command line is refused without echoing it; nothing changed');

    run = await cli(['--package', packageFile], { input: PASSWORD + '\n' });
    assert.equal(run.code, 0, run.output);
    const result = lastJson(run.output);
    assert.deepEqual(result, { ok: true, changed: true, workDataKey: 'rewrapped', credentialVault: 'rewrapped', externalBotCredentials: 'rewrapped' });
    assert.ok(run.output.toLowerCase().includes('data root: ' + generation.toLowerCase()), 'the CLI names the data root it acted on');
    assert.equal(await botSecret(), BOT_SECRET, 'bot secret restaged under the current user');
    const header1 = JSON.parse(fs.readFileSync(headerFile, 'utf8'));
    assert.equal(header1.instanceId, header0.instanceId); assert.notEqual(header1.protectedKey, JSON.parse(damagedHeader).protectedKey);
    assert.equal(JSON.parse(fs.readFileSync(vaultFile, 'utf8')).records.length, vaultState.records.length);
    t.ok(true, 'D1 CLI rewrap with the password on stdin replaces only the DPAPI-wrapped header, vault master and bot secrets under the current user and names the data root');
    ({ child, record } = await serve());
    let read = await request(record, '/api/sessions/' + sessionId);
    assert.equal(read.status, 200); assert.equal(read.value.session?.title, 'REWRAP-SYNTHETIC-SESSION');
    await stop(child);
    run = await cli(['--package', packageFile], { input: PASSWORD + '\n' });
    assert.equal(run.code, 0); assert.match(run.output, /"changed":false/);
    t.ok(true, 'D2 serve starts normally and reads the original sealed session; a repeated rewrap is a no-op');

    // Concurrency: the CLI owns the root exactly like serve; it never edits a root someone else owns.
    flipBlob(headerFile); const lockedHeader = fs.readFileSync(headerFile);
    const owner = await api.ServerOwnership.acquire([base]);
    try {
      run = await cli(['--package', packageFile], { input: PASSWORD + '\n' });
      assert.equal(run.code, 1); assert.match(run.output, /work_data_key\.rewrap_root_busy/); assert.deepEqual(fs.readFileSync(headerFile), lockedHeader);
    } finally { await owner.release(); }
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PASSWORD + '\r\n', 'utf16le')]);
    const pair = [spawn([COMMAND, '--package', packageFile], { input: PASSWORD + '\n' }), spawn([COMMAND, '--package', packageFile], { input: utf16 })];
    const codes = await Promise.all(pair.map(item => exited(item)));
    const verdicts = pair.map((item, i) => codes[i] === 0 ? lastJson(item.output) : (/work_data_key\.rewrap_root_busy/.test(item.output) ? 'busy' : 'other:' + item.output.slice(-300)));
    assert.equal(verdicts.filter(v => v?.workDataKey === 'rewrapped').length, 1, JSON.stringify(verdicts));
    assert.ok(verdicts.every(v => v === 'busy' || v?.ok === true), JSON.stringify(verdicts));
    ({ child, record } = await serve());
    read = await request(record, '/api/sessions/' + sessionId); assert.equal(read.value.session?.title, 'REWRAP-SYNTHETIC-SESSION');
    run = await cli(['--package', packageFile], { input: PASSWORD + '\n' });
    assert.equal(run.code, 1); assert.match(run.output, /work_data_key\.rewrap_root_busy/);
    await stop(child);
    console.log('[concurrent-cli] ' + JSON.stringify(verdicts.map(v => typeof v === 'string' ? v : v.workDataKey)));
    t.ok(true, 'G1 a held owner (another CLI) and a running serve refuse the CLI with rewrap_root_busy; two concurrent CLIs (UTF-8 and UTF-16LE-BOM stdin) rewrap exactly once');

    fs.unlinkSync(headerFile);
    const missing = spawn(['serve', '--port', String(await getFreePort())]);
    assert.equal(await exited(missing), 1); assert.match(missing.output, /work_data_key\.header_missing/);
    const passwordFile = path.join(outside, 'password.txt'); fs.writeFileSync(passwordFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PASSWORD + '\r\n')])); // Notepad "UTF-8 with BOM"
    run = await cli(['--package', packageFile, '--password-file', passwordFile]);
    assert.equal(run.code, 0, run.output); assert.match(run.output, /"workDataKey":"rewrapped"/); assert.match(run.output, /Delete the password file/);
    ({ child, record } = await serve());
    read = await request(record, '/api/sessions/' + sessionId);
    assert.equal(read.status, 200); assert.equal(read.value.session?.title, 'REWRAP-SYNTHETIC-SESSION');
    await stop(child);
    t.ok(true, 'E1 a deleted header refuses with header_missing; rewrap with a BOM --password-file derives the instance from sealed records and serve reads the same data');

    const needles = [PASSWORD, WRONG, BOT_SECRET, ...masters.flatMap(master => [master.toString('base64'), master.toString('hex')])];
    const leaks = [];
    const scan = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; } if (full === passwordFile) continue;
      const text = fs.readFileSync(full).toString('latin1'); for (const needle of needles) if (text.includes(needle)) leaks.push(path.relative(root, full)); } };
    scan(base); scan(home);
    for (const text of outputs) for (const needle of needles) if (text.includes(needle)) leaks.push('process-output');
    for (const line of spawnedArgs) for (const needle of needles) if (line.includes(needle) && !line.includes('--password ')) leaks.push('argv');
    assert.deepEqual(leaks, []);
    for (const master of masters) master.fill(0);
    t.ok(true, 'F1 no password, master or bot secret in any data/home file, process output or (except the refused argv case) process argv');
  } catch (error) { t.fail(error?.stack || String(error)); }
  finally {
    for (const child of [...children]) await stop(child);
    console.log('[pids] ' + pids.join(','));
    assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-key-rewrap-e2e-'));
    if (!t.failures) fs.rmSync(root, { recursive: true, force: true }); else console.log('[keep] ' + root);
    t.done();
  }
})();
