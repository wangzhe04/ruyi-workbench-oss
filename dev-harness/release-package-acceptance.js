#!/usr/bin/env node
'use strict';
// Opt-in Windows release acceptance. Uses actual ZIPs, tag-produced data and isolated homes.
// Does not publish, change the real installation or silently count skipped packaging as success.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');
const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, i, all) => {
  if (i % 2 === 0) { if (!/^--[a-z-]+$/.test(value) || !all[i + 1]) throw new Error('Use --name value pairs'); out.push([value.slice(2), all[i + 1]]); } return out;
}, []));
const ROOT = path.resolve(args.repo || path.join(__dirname, '..'));
const { createRunner } = require('./lib/harness');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('./lib/fake-openai-provider');
const { releaseEnvironment: environment } = require('./lib/release-checks');
const t = createRunner('RELEASE PACKAGE ACCEPTANCE');
const check = (condition, label) => { record(label, { passed: Boolean(condition) }); if (!t.ok(condition, label)) throw new Error(label); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function treeHash(root) {
  const files = [];
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else files.push([path.relative(root, file).replace(/\\/g, '/'), hash(file)]);
  } }
  walk(root); return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const revision = ref => cp.execFileSync('git', ['rev-parse', '--verify', ref + '^{commit}'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
let scratch, fake, targetFile, privacyScenario;
let journeyBarrierPassed = false;
const children = new Set();
const report = { schema: 1, startedAt: new Date().toISOString(), platform: process.platform, node: process.version, complete: false, packages: {}, checks: [] };
function record(label, values = {}) { report.checks.push({ label, ...values }); save(); }
function save() { if (scratch) fs.writeFileSync(path.join(scratch, 'validation.json'), JSON.stringify(report, null, 2) + '\n'); }
function spawn(command, argv, options) {
  const child = cp.spawn(command, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.on('error', error => { child.startError = error; });
  children.add(child); child.once('close', () => children.delete(child)); return child;
}
async function stop(child) {
  if (!child || child.startError || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  killOwnTree(child); await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null && !child.startError) throw new Error('Owned process did not stop: ' + child.pid);
}
async function run(command, argv, options, label, timeout = 180000) {
  const started = Date.now(), child = spawn(command, argv, options); let output = '';
  child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  let timedOut = false, timer;
  const code = await Promise.race([
    new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }),
    new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(null); }, timeout); }),
  ]).finally(() => clearTimeout(timer));
  if (timedOut) await stop(child);
  const logFile = path.join(scratch, label.replace(/[^a-z0-9.-]+/gi, '-') + '.log'); fs.writeFileSync(logFile, output);
  record(label, { passed: code === 0 && !timedOut, exitCode: code, timedOut, ms: Date.now() - started, logSha256: hash(logFile) });
  check(code === 0 && !timedOut, label); return output;
}
async function serve(bundle, data, home, executable = false) {
  const port = await getFreePort(), env = environment(home, data);
  const node = path.join(bundle, 'runtime/node/node.exe');
  const child = spawn(executable ? path.join(bundle, 'Ruyi.exe') : node,
    executable ? ['serve', '--port', String(port)] : [path.join(bundle, 'app/server.js'), 'serve', '--port', String(port)], { cwd: bundle, env });
  let stderr = ''; child.stderr.on('data', data => stderr += data); child.stdout.resume();
  let ready = false;
  for (let i = 0; i < 300 && child.exitCode === null && !child.startError && !ready; i++) {
    try {
      const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8'));
      if (runtime.pid === child.pid && runtime.port === port) {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        const health = await response.json(); ready = response.status === 200 && health.overlayId === runtime.overlayId;
      }
    } catch {}
    if (!ready) await sleep(100);
  }
  if (!ready) fs.writeFileSync(path.join(scratch, 'server-start-error.log'), stderr);
  check(ready, (executable ? 'packaged exe' : 'bundled Node') + ' starts in isolated home');
  let token = '';
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-wcw-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
    if (!response.ok) {
      const code = String(json?.error?.code || '').replace(/[^a-z0-9_.-]/gi, '');
      throw Object.assign(new Error(method + ' ' + route + ': HTTP ' + response.status + (code ? ' ' + code : '')), { httpStatus: response.status, code });
    }
    return json === undefined ? text : json;
  };
  token = (await request('/api/bootstrap', {})).token;
  check(Boolean(token), 'real bootstrap authenticates isolated package');
  const status = await request('/api/status');
  const runtime = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8'));
  check(path.resolve(status.dataRoot) === path.resolve(data) && runtime.pid === child.pid, 'service data root and runtime PID belong to this child');
  return { child, request, port, env, bundle, data, home, executable };
}
// Run the packaged production reader in an isolated Node process. No API exposes decoded credentials.
// The result stays in memory and is never written to the acceptance report or command log.
async function effectiveConfig(server) {
  const script = 'require(process.argv[1]).readConfig().then(value => process.stdout.write(JSON.stringify(value))).catch(() => { process.stderr.write("production config reader failed"); process.exitCode = 1; });';
  const child = spawn(path.join(server.bundle, 'runtime/node/node.exe'), ['-e', script, path.join(server.bundle, 'app/server.js')], { cwd: server.bundle, env: server.env });
  let output = '', bytes = 0, overflow = false, timer;
  child.stdout.on('data', value => { bytes += value.length; if (bytes > 2 * 1024 * 1024) { overflow = true; killOwnTree(child); } else output += value; });
  child.stderr.resume();
  const code = await Promise.race([
    new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }),
    new Promise(resolve => { timer = setTimeout(() => { killOwnTree(child); resolve(null); }, 60000); }),
  ]).finally(() => clearTimeout(timer));
  if (code !== 0 || overflow) throw new Error('Isolated packaged production config reader failed');
  return JSON.parse(output);
}
function config(work) {
  return { confirm: true, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, schedulerEnabledV1: false, stewardEnabledV1: true, stewardThreadBriefV1: false,
    killOnDisconnect: false, permissionMode: 'bypass', defaultWorkspace: work, toolLoadingMode: 'full',
    activeProvider: 'release-fake', providers: [{ id: 'release-fake', label: 'Release fixture', type: 'openai-compat',
      baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model' }] }], legacyReleaseAcceptance: { marker: 'preserve-v301' } };
}
async function conversation(server, work, label) {
  await server.request('/api/config', config(work));
  const created = await server.request('/api/sessions', { title: label, cwd: work, engine: 'openai' });
  const id = created.session.id; targetFile = path.join(work, label + '.txt');
  const stream = await server.request('/api/chat/stream', { sessionId: id, cwd: work, message: 'Write the synthetic acceptance artifact and report its real result.' });
  successfulTurn(stream, label);
  check(fs.readFileSync(targetFile, 'utf8') === 'PACKAGE_ACCEPTANCE_OK\n', label + ': real provider/tool loop writes artifact');
  return { id, artifact: targetFile };
}
function successfulTurn(stream, label) {
  const events = typeof stream === 'string' ? stream.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : [];
  const result = events.findLast(event => event.type === 'result');
  check(result?.ok === true && !result.aborted && !result.error && !events.some(event => event.type === 'error'), label + ': real NDJSON turn finishes successfully');
  check(events.filter(event => event.type === 'assistant_delta').map(event => event.text || '').join('').includes('PACKAGE_ACCEPTANCE_OK'), label + ': synthetic final response is delivered');
}
async function candidatePrivacy(server, data, work, label) {
  const privateFile = path.join(data, 'desktop/EBWebView/Default/Local Storage/release-private.txt');
  const publicFile = path.join(work, 'desktop', label + '-public.txt');
  for (const file of [privateFile, publicFile]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(privateFile, 'RELEASE_PRIVATE_SENTINEL'); fs.writeFileSync(publicFile, 'RELEASE_PUBLIC_SENTINEL');
  const tool = (name, body) => server.request('/api/tools/' + name, body);
  const denied = async (name, body) => {
    try { return (await tool(name, body)).result?.ok === false; }
    catch (error) { if (error.httpStatus === 400) return true; throw error; }
  };
  check(await denied('file_read', { path: privateFile }), label + ': candidate code refuses private WebView reads');
  check(await denied('file_write', { path: privateFile, content: 'overwritten' }) && fs.readFileSync(privateFile, 'utf8') === 'RELEASE_PRIVATE_SENTINEL', label + ': candidate code refuses private WebView writes');
  const search = (await tool('file_search', { root: data, pattern: 'RELEASE_PRIVATE_SENTINEL', includeIgnored: true })).result;
  check(search?.ok === true && !JSON.stringify(search).includes('release-private.txt'), label + ': candidate search excludes private WebView files');
  const ordinary = (await tool('file_read', { path: publicFile })).result;
  check(ordinary?.ok === true && JSON.stringify(ordinary).includes('RELEASE_PUBLIC_SENTINEL'), label + ': ordinary workspace desktop files remain readable');
  const write = (await tool('file_write', { path: publicFile, content: 'RELEASE_PUBLIC_UPDATED' })).result;
  check(write?.ok === true && fs.readFileSync(publicFile, 'utf8') === 'RELEASE_PUBLIC_UPDATED', label + ': ordinary workspace desktop files remain writable');
  const basename = path.basename(publicFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const listed = (await tool('file_list', { root: path.dirname(publicFile), pattern: '^(' + basename + ')$', absolute: true })).result;
  check(listed?.ok === true && !listed.truncated && listed.files.some(file => file.path === publicFile), label + ': packaged nonlinear path-pattern worker lists the exact file');
  // Rust regex rejects lookahead, which forces the real bounded JS worker even
  // when the package contains ripgrep. Do not let the rg fast path mask a failure.
  const jsSearch = (await tool('file_search', { root: path.dirname(publicFile), pattern: 'RELEASE_PUBLIC_(?=UPDATED)UPDATED' })).result;
  check(jsSearch?.ok === true && jsSearch.engine === 'js' && jsSearch.matches.some(match => match.path === publicFile && match.text === 'RELEASE_PUBLIC_UPDATED'),
    label + ': packaged content-search worker succeeds through the actual JS fallback');
  const slowRoot = path.join(work, label + '-bounded-search'); fs.mkdirSync(slowRoot);
  fs.writeFileSync(path.join(slowRoot, 'slow.txt'), 'a'.repeat(40000) + '!');
  const started = Date.now();
  const [slowSearch, healthMs] = await Promise.all([
    tool('file_search', { root: slowRoot, pattern: '(?=a)(a+)+$', regexTimeoutMs: 250 }).then(response => response.result),
    server.request('/health').then(() => Date.now() - started),
  ]);
  check(slowSearch?.ok === true && slowSearch.engine === 'js' && slowSearch.truncated === true && /time budget/.test(slowSearch.patternNote || '') && healthMs < 5000,
    label + ': packaged catastrophic content regex is terminated while HTTP remains responsive');
}
async function candidateVaultAndRules(server, data, work, label) {
  const suffix = crypto.randomBytes(8).toString('hex');
  const auth = 'release-fixture-auth-' + suffix, changedAuth = 'release-rotated-auth-' + suffix;
  const email = 'release-' + suffix + '@example.test', employee = 'EMP-' + String(crypto.randomInt(100000, 1000000));
  const secret = 'release-private-password-' + suffix, patientCode = 'PAT-' + suffix + '\u00a0X', password = 'release-recovery-password-' + suffix;
  const source = path.join(work, label + '-private-source.txt'), destination = path.join(work, label + '-private-restored.txt');
  fs.writeFileSync(source, JSON.stringify({ email, employee, patientCode, password: secret }));
  const rules = [{ id: 'release-employee', kind: 'regex', value: 'EMP-[0-9]{6}', category: 'INTERNAL' }, { id: 'release-patient', kind: 'field', value: '/patientCode', category: 'INTERNAL' }];
  const settings = { mode: 'enhanced', technical: false, rules };
  const provider = { ...config(work).providers[0], apiKey: auth };
  let active = server, created, firstReferences;
  const diskHasNoSecrets = () => ['config.json', 'config.json.prev', 'credential-vault-v1.json'].filter(name => fs.existsSync(path.join(data, name)))
    .every(name => { const value = fs.readFileSync(path.join(data, name), 'utf8'); return ![auth, changedAuth, secret, email, employee, patientCode].some(item => value.includes(item)); });
  const turn = async (message, phase) => {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    const callPrefix = 'release_private_' + crypto.randomBytes(8).toString('hex');
    const scenario = { source, destination, auth, email, employee, patientCode, secret, step: 0, requests: 0, references: null,
      callIds: { partial: callPrefix + '_partial', read: callPrefix + '_read', write: callPrefix + '_write' } };
    privacyScenario = scenario;
    try {
      const stream = await active.request('/api/chat/stream', { sessionId: created.session.id, cwd: work, message });
      successfulTurn(stream, label + ': ' + phase);
      check(scenario.step === 4 && scenario.requests >= 4 && !!scenario.references, label + ': ' + phase + ' completes protected line and complete reads before the real reference/file-write loop');
      check(fs.readFileSync(destination, 'utf8') === email + '\n' + employee + '\n' + patientCode + '\n', label + ': ' + phase + ' restores exact email, worker-regex and field values before file execution');
      return scenario.references;
    } finally { privacyScenario = null; }
  };
  try {
    await active.request('/api/config', { providers: [provider], stewardEnabledV1: false, contextAutoCompactEnabled: false, runtimeOptimizationShadowV1: false, importAgentInstructions: false });
    const initialDisk = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check(initialDisk.credentialEncryptionV1 !== true && !initialDisk.credentialRefsV1 && initialDisk.providers[0].apiKey === auth && !fs.existsSync(path.join(data, 'credential-vault-v1.json')), label + ': default off retains ordinary plaintext credential storage without initializing a vault');
    await active.request('/api/privacy/encryption', { enabled: true });
    const persisted = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check(persisted.credentialEncryptionV1 === true && persisted.credentialRefsV1?.version === 1 && persisted.providers[0].apiKey === '' && diskHasNoSecrets(), label + ': actual runtime migrates synthetic credential into DPAPI-backed encrypted storage');
    const trial = await active.request('/api/privacy/rules/test', { ...settings, sample: JSON.stringify({ email, employee, patientCode, password: secret }) });
    check(![email, employee, patientCode, secret].some(value => trial.protectedSample.includes(value)) && ['release-employee', 'release-patient'].every(id => trial.matches.some(match => match.ruleIds.includes(id))), label + ': packaged worker and field rules scan draft data through the actual API');
    const beforeTyped = hash(path.join(data, 'config.json'));
    let typedDenied = false;
    try { await active.request('/api/privacy/rules/test', { ...settings, sample: '{"diagnosis":true}' }); }
    catch (error) { typedDenied = error.httpStatus === 409 && error.code === 'privacy.typed_sensitive'; }
    check(typedDenied && hash(path.join(data, 'config.json')) === beforeTyped, label + ': packaged builtin personal rules refuse sensitive boolean data without saving');
    const prior = hash(path.join(data, 'config.json'));
    let timedOut = false;
    const started = Date.now();
    const jobs = [active.request('/api/privacy/rules/test', { ...settings, rules: [{ ...rules[0], value: '(a+)+$' }], sample: 'a'.repeat(40000) + '!' }).catch(error => { timedOut = error.code === 'privacy.regex_timeout'; }),
      active.request('/health').then(() => Date.now() - started)];
    const [, healthMs] = await Promise.all(jobs);
    check(timedOut && healthMs < 5000 && hash(path.join(data, 'config.json')) === prior, label + ': catastrophic worker is terminated while packaged HTTP remains responsive and draft test does not save');
    await active.request('/api/privacy/settings', settings);
    created = await active.request('/api/sessions', { title: label + ' privacy', cwd: work, engine: 'openai' });
    firstReferences = await turn('Read the synthetic contact fixture and copy its email and employee code to the requested local artifact.', 'first protected turn');
    const maps = fs.readdirSync(path.join(data, 'privacy-scopes')).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    check(maps.length > 0 && maps.every(name => { const value = fs.readFileSync(path.join(data, 'privacy-scopes', name), 'utf8'); return !!JSON.parse(value).envelope && ![email, employee, patientCode, secret, ...firstReferences].some(item => value.includes(item)); }), label + ': real model mappings persist only as authenticated ciphertext');

    await stop(active.child);
    active = await serve(server.bundle, data, server.home, server.executable);
    const restartedReferences = await turn('Repeat the synthetic contact transfer after the runtime restart.', 'restarted protected turn');
    check(JSON.stringify(restartedReferences) === JSON.stringify(firstReferences), label + ': restarted package unwraps DPAPI and reuses the same encrypted scope references');

    const exported = await active.request('/api/privacy/backup/export', { password });
    check(typeof exported.backup === 'string' && ![auth, secret, email, employee].some(value => exported.backup.includes(value)), label + ': encrypted recovery export contains no synthetic secrets in plaintext');
    const exportedFile = path.join(scratch, label + '-recovery.json'); fs.writeFileSync(exportedFile, exported.backup);
    await active.request('/api/config', { providers: [{ ...provider, apiKey: changedAuth }] });
    const beforeWrong = [hash(path.join(data, 'config.json')), hash(path.join(data, 'credential-vault-v1.json'))];
    let rejected = false;
    try { await active.request('/api/privacy/backup/preview', { backup: exported.backup, password: 'incorrect-fixture-password' }); }
    catch (error) { rejected = error.httpStatus === 409; }
    check(rejected && JSON.stringify(beforeWrong) === JSON.stringify([hash(path.join(data, 'config.json')), hash(path.join(data, 'credential-vault-v1.json'))]), label + ': wrong recovery password is rejected without writing config or vault');
    const preview = await active.request('/api/privacy/backup/preview', { backup: exported.backup, password });
    check(typeof preview.ticket === 'string' && ![auth, changedAuth].some(value => JSON.stringify(preview).includes(value)), label + ': recovery preview exposes a ticket and safe target summary');
    await active.request('/api/privacy/backup/import', { ticket: preview.ticket });
    let replayDenied = false;
    try { await active.request('/api/privacy/backup/import', { ticket: preview.ticket }); } catch (error) { replayDenied = error.httpStatus === 409; }
    check(replayDenied && !fs.existsSync(path.join(data, 'credential-import-v1.json')), label + ': recovery commits once and removes its transaction journal');
    const restoredConfig = await effectiveConfig(active);
    check(restoredConfig.providers.find(item => item.id === provider.id)?.apiKey === auth && diskHasNoSecrets(), label + ': packaged production reader restores the exported exact credential and leaves no plaintext copy');
    await turn('Confirm the recovered credential works and repeat the synthetic transfer.', 'recovered credential turn');
    const { providers: fixtureProviders, activeProvider: fixtureProviderId, ...fixtureControls } = config(work);
    const controls = { ...fixtureControls, stewardEnabledV1: false, importAgentInstructions: false, contextAutoCompactEnabled: false, runtimeOptimizationShadowV1: false };
    const recoverMissingConfig = async (phase, removePrevious) => {
      if (path.dirname(path.resolve(data)) !== scratch) throw new Error('Cold recovery data root is not owned by this acceptance run');
      const vaultBefore = hash(path.join(data, 'credential-vault-v1.json'));
      await stop(active.child);
      fs.unlinkSync(path.join(data, 'config.json'));
      if (removePrevious && fs.existsSync(path.join(data, 'config.json.prev'))) fs.unlinkSync(path.join(data, 'config.json.prev'));
      active = await serve(server.bundle, data, server.home, server.executable);
      const state = await active.request('/api/privacy/status');
      check(state.recoveryRequired === true && state.encryption === removePrevious && hash(path.join(data, 'credential-vault-v1.json')) === vaultBefore,
        label + ': ' + phase + ' keeps the existing vault and exposes the paused recovery UI with the correct storage choice');
      // Keep background fixtures quiet without changing the restored provider credentials
      // or confirming the pending privacy policy. The import itself must recover the key.
      await active.request('/api/config', controls);
      const beforePreview = [hash(path.join(data, 'config.json')), hash(path.join(data, 'credential-vault-v1.json'))];
      const pending = await active.request('/api/privacy/backup/preview', { backup: exported.backup, password });
      check(typeof pending.ticket === 'string' && JSON.stringify(beforePreview) === JSON.stringify([hash(path.join(data, 'config.json')), hash(path.join(data, 'credential-vault-v1.json'))]),
        label + ': ' + phase + ' previews the real recovery package without config or vault writes');
      await active.request('/api/privacy/backup/import', { ticket: pending.ticket });
      const imported = await effectiveConfig(active);
      check(imported.credentialEncryptionV1 === true && imported.providers.find(item => item.id === provider.id)?.apiKey === auth,
        label + ': ' + phase + ' imports the exact exported credential through the packaged recovery transaction');
      const importedState = await active.request('/api/privacy/status');
      check(importedState.recoveryRequired === true, label + ': ' + phase + ' keeps policy confirmation pending after credential recovery');
      await active.request('/api/config', { activeProvider: provider.id });
      await active.request('/api/privacy/settings', settings);
      await turn('Repeat the synthetic transfer after explicit cold recovery confirmation.', phase + ' protected turn');
      check(diskHasNoSecrets(), label + ': ' + phase + ' leaves credentials and backups encrypted');
    };
    await recoverMissingConfig('cold encrypted vault without config or previous file', true);
    await active.request('/api/privacy/settings', { mode: 'off', technical: false, rules: [] });
    await active.request('/api/privacy/encryption', { enabled: false, confirmPlaintext: true });
    await active.request('/api/config', { providers: [{ ...provider, apiKey: changedAuth }] });
    const currentPlainConfig = await effectiveConfig(active);
    await active.request('/api/config', { locale: currentPlainConfig.locale === 'en-US' ? 'zh-CN' : 'en-US' }); // Commit a genuine plaintext .prev after explicit disable.
    const plainPrevious = JSON.parse(fs.readFileSync(path.join(data, 'config.json.prev'), 'utf8'));
    check(plainPrevious.credentialEncryptionV1 === false && !plainPrevious.credentialRefsV1 && plainPrevious.providers.find(item => item.id === provider.id)?.apiKey === changedAuth,
      label + ': explicit disable produces a real plaintext previous-config fixture with a different credential from the backup');
    await recoverMissingConfig('cold confirmed plaintext previous file with retained vault', false);
    record(label + ': encrypted recovery artifact', { passed: true, sha256: hash(exportedFile) });
  } finally {
    privacyScenario = null;
    try { if (active.child.exitCode === null && !active.child.startError) await active.request('/api/privacy/settings', { mode: 'off', technical: false, rules: [] }); }
    finally { if (active !== server) await stop(active.child); }
  }
}
function privateProviderResponse(req) {
  const scenario = privacyScenario;
  if (!scenario) return null;
  const originals = [scenario.email, scenario.employee, scenario.patientCode, scenario.secret, scenario.auth];
  const containsOriginal = (value, depth = 0) => {
    if (depth > 16) return true;
    if (typeof value === 'string') {
      if (originals.some(secret => value.includes(secret))) return true;
      try { return containsOriginal(JSON.parse(value), depth + 1); } catch { return false; }
    }
    return value && typeof value === 'object' ? Object.entries(value).some(([key, row]) => containsOriginal(key, depth + 1) || containsOriginal(row, depth + 1)) : false;
  };
  check(!containsOriginal(req.raw), 'packaged privacy request body contains no random synthetic plaintext, including nested JSON escapes');
  check(req.headers.authorization === 'Bearer ' + scenario.auth, 'packaged runtime authenticates to the intended fixture endpoint with the actual recovered credential');
  scenario.requests++;
  if (req.stream === false) return textFrames('Release auxiliary fixture');
  if (scenario.step++ === 0) return toolCallFrames('file_read', { path: scenario.source, lineOffset: 1 }, scenario.callIds.partial);
  if (scenario.step === 2) {
    const result = JSON.parse(req.messages.filter(message => message.role === 'tool').at(-1)?.content || '{}');
    check(result.ok === true && JSON.stringify(result).includes('[[RUYI_PVT:') && !('non_ascii' in result), 'packaged formatted read succeeds with source-projected references and no diagnostic plaintext copy');
    return toolCallFrames('file_read', { path: scenario.source }, scenario.callIds.read);
  }
  if (scenario.step === 3) {
    const content = req.messages.filter(message => message.role === 'tool').at(-1)?.content || '';
    const result = JSON.parse(content), contact = JSON.parse(result.content);
    const { email, employee, patientCode } = contact;
    check(result.ok === true && !('non_ascii' in result) && /^\[\[RUYI_PVT:EMAIL:[a-f0-9]{32}\]\]$/.test(email) && [employee, patientCode].every(value => /^\[\[RUYI_PVT:INTERNAL:[a-f0-9]{32}\]\]$/.test(value)), 'packaged full read returns builtin, worker-regex and field references without source diagnostic copies');
    scenario.references = [email, employee, patientCode];
    return toolCallFrames('file_write', { path: scenario.destination, content: email + '\n' + employee + '\n' + patientCode + '\n' }, scenario.callIds.write);
  }
  const written = req.messages.filter(message => message.role === 'tool').at(-1);
  check(written?.tool_call_id === scenario.callIds.write && JSON.parse(written.content || '{}').ok === true, 'packaged write returns success for the exact issued tool call before final completion');
  return [...textFrames('PACKAGE_ACCEPTANCE_OK'), usageFrame(8, 4)];
}
async function snapshot(server, data, seeded) {
  const session = (await server.request('/api/sessions/' + seeded.id)).session;
  const disk = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
  const cfg = await effectiveConfig(server);
  const journal = suffix => fs.readFileSync(path.join(data, 'sessions', seeded.id + suffix), 'utf8');
  const readUsage = () => Object.fromEntries((fs.existsSync(path.join(data, 'usage')) ? fs.readdirSync(path.join(data, 'usage')) : []).filter(f => f.endsWith('.jsonl')).sort().map(f => [f, fs.readFileSync(path.join(data, 'usage', f), 'utf8')]));
  let usage;
  for (let i = 0; i < 100; i++) {
    usage = readUsage();
    const rows = Object.values(usage).flatMap(body => body.slice(0, body.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }));
    if (rows.some(row => row.sessionId === seeded.id && row.turnSeq === session.turnSeq)) break;
    if (i === 99) throw new Error('Timed out waiting for committed usage row');
    await sleep(50);
  }
  check(journal('.provider.ndjson').trim().length > 0 && Object.values(usage).some(body => body.trim()), 'old conversation has persisted provider history and usage evidence');
  check(cfg.legacyReleaseAcceptance?.marker === 'preserve-v301' && cfg.permissionMode === 'bypass' && cfg.providers.some(p => p.id === 'release-fake' && p.apiKey === 'k'), 'synthetic configuration and unknown legacy field are actually present');
  if (fs.existsSync(path.join(server.bundle, 'app/src/01k-credential-vault.js'))) {
    if (cfg.credentialEncryptionV1 === true) check(disk.credentialRefsV1?.version === 1 && disk.providers.find(p => p.id === 'release-fake')?.apiKey === '', 'explicitly encrypted upgrade persists references while production reader returns the exact old value');
    else check(!disk.credentialRefsV1 && disk.providers.find(p => p.id === 'release-fake')?.apiKey === 'k', 'default-off upgrade retains the exact old storage semantics until explicit opt-in');
  }
  return { title: session.title, messages: session.messages.map(({ role, content }) => ({ role, content })),
    history: journal('.provider.ndjson'), messagesJournal: journal('.messages.ndjson'), usage, permission: cfg.permissionMode, providerKey: cfg.providers.find(p => p.id === 'release-fake').apiKey,
    legacy: cfg.legacyReleaseAcceptance, memory: fs.readFileSync(path.join(data, 'memory/global/release-upgrade.md'), 'utf8'), artifact: hash(seeded.artifact) };
}
async function extract(zip, variant) {
  const dest = path.join(scratch, variant); fs.mkdirSync(dest);
  const entries = cp.execFileSync('tar.exe', ['-tf', zip], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).split(/\r?\n/).filter(Boolean);
  check(entries.length > 10 && entries.every(name => !/^(?:\/|[a-z]:)|(?:^|\/)\.\.(?:\/|$)/i.test(name.replace(/\\/g, '/'))), variant + ': ZIP entries have safe relative paths');
  check(new Set(entries.map(name => name.toLowerCase())).size === entries.length, variant + ': ZIP has no case-colliding duplicate entries');
  if (variant === 'full') {
    const runtimePrefix = 'mcp/ai-computer-control/python_embed/Lib/site-packages/ai_computer_control/';
    check(!entries.some(name => name.replace(/\\/g, '/').startsWith(runtimePrefix) && /(?:\/__pycache__(?:\/|$)|\.pyc$)/i.test(name)), 'Full actual ZIP excludes stale bytecode from the synchronized ACC runtime');
  }
  await run('tar.exe', ['-xf', zip, '-C', dest], {}, variant + '-extract');
  const files = ['app/server.js', 'app/src/manifest.json', 'app/public/index.html', 'Ruyi.exe', 'RuyiDesktop.exe', 'WebView2Loader.dll', 'runtime/node/node.exe', 'Start-Workbench.cmd', 'package.json'];
  check(files.every(file => fs.existsSync(path.join(dest, file))), variant + ': actual ZIP contains all launch modes');
  check(hash(path.join(dest, 'app/server.js')) === hash(path.join(ROOT, 'ruyi-workbench/app/server.js')), variant + ': generated server matches candidate bytes');
  check(treeHash(path.join(dest, 'app')) === report.sourceAppSha256, variant + ': entire packaged app tree matches candidate bytes');
  const builtExe = path.join(path.resolve(zip).replace(/\.zip$/i, ''), 'Ruyi.exe');
  check(hash(path.join(dest, 'Ruyi.exe')) === hash(builtExe), variant + ': embedded EXE matches this packaging build stage');
  for (const file of ['steward-board.js', 'steward-conversation.js', 'steward-delivery.js', 'steward-settings-receipt.js']) {
    check(hash(path.join(dest, 'app/public/js', file)) === hash(path.join(ROOT, 'ruyi-workbench/app/public/js', file)), variant + ': ' + file + ' matches candidate bytes');
  }
  const version = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version;
  check(version === report.applicationVersion, variant + ': package metadata version matches candidate');
  check(hash(path.join(dest, 'RuyiDesktop.exe')) === hash(path.join(path.resolve(zip).replace(/\.zip$/i, ''), 'RuyiDesktop.exe')), variant + ': desktop EXE matches this packaging stage');
  report.packages[variant] = { zipSha256: hash(zip), zipBytes: fs.statSync(zip).size, entries: entries.length, version,
    exeSha256: hash(path.join(dest, 'Ruyi.exe')), desktopExeSha256: hash(path.join(dest, 'RuyiDesktop.exe')), root: dest }; save();
  return dest;
}
async function journeys(bundle, variant) {
  // Other full-suite runs own test browsers too. An optional fresh barrier lets
  // ZIP/runtime/upgrade checks proceed first while serializing browser cleanup.
  // This delays the same journeys; it never skips or changes their assertions.
  if (args['journey-barrier'] && !journeyBarrierPassed) {
    const marker = path.resolve(args['journey-barrier']), started = Date.now();
    record('waiting-for-browser-journey-barrier', { marker });
    while (true) {
      if (fs.existsSync(marker)) {
        const stat = fs.statSync(marker), value = JSON.parse(fs.readFileSync(marker, 'utf8'));
        check(stat.mtimeMs >= Date.parse(report.startedAt) && value.fullSuiteSettled === true
          && value.serverSha256 === hash(path.join(ROOT, 'ruyi-workbench/app/server.js')), 'fresh full-suite barrier matches this candidate before browser journeys');
        journeyBarrierPassed = true; break;
      }
      if (Date.now() - started > 3600000) throw new Error('Browser journey barrier timed out');
      await sleep(1000);
    }
  }
  const root = path.join(scratch, variant + '-journeys'), harness = path.join(root, 'dev-harness'); fs.mkdirSync(harness, { recursive: true });
  const files = [...new Set(cp.execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'dev-harness'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean))];
  for (const file of files) {
    if (file.startsWith('dev-harness/unit/') || file.includes('/realhist-fixtures/')) continue;
    if (!fs.existsSync(path.join(ROOT, file))) continue; // A tracked deletion is not a candidate fixture.
    const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(ROOT, file), dest);
  }
  fs.symlinkSync(bundle, path.join(root, 'ruyi-workbench'), 'junction');
  const cases = ['steward-read-routing.e2e.js', 'steward-attachments-search.e2e.js', 'steward-delivery.e2e.js',
    'steward-task-decisions.e2e.js', 'steward-settings-scope.e2e.js', 'steward-multistep.e2e.js', 'playbook-reuse.e2e.js',
    'memory-active-scope.e2e.js', 'steward-handoff-recovery.browser.e2e.js', 'steward-delivery.browser.e2e.js', 'surface-hardening-w2.e2e.js',
    'session-stop-execution.e2e.js', 'session-get-etag.e2e.js', 'external-bot-setup.browser.e2e.js', 'live-full-text.browser.e2e.js',
    'privacy-gateway.e2e.js', 'privacy-protocols.e2e.js', 'privacy-channels.e2e.js', 'credential-vault.e2e.js'];
  const env = environment(path.join(root, 'home'), path.join(root, 'data'));
  const runtimeFiles = ['app/server.js', 'app/src/manifest.json'];
  const before = runtimeFiles.map(file => hash(path.join(bundle, file)));
  await run(path.join(bundle, 'runtime/node/node.exe'), [path.join(bundle, 'app/build.js'), '--check'], { cwd: bundle, env }, variant + '-hard-freshness');
  const output = await run(path.join(bundle, 'runtime/node/node.exe'), [path.join(harness, 'run-all.js'), ...cases],
    { cwd: root, env }, variant + '-core-journeys', 1200000);
  check(output.includes('# 汇总: ' + cases.length + ' pass / 0 fail') && !/\b[1-9]\d* flaky\b/.test(output), variant + ': all ' + cases.length + ' packaged core journeys pass without retry');
  const mixedOutput = path.join(root, 'mixed-input-validation');
  await run(path.join(bundle, 'runtime/node/node.exe'), [path.join(harness, 'privacy-31/browser-input-validation.js'), '--output=' + mixedOutput],
    { cwd: root, env }, variant + '-mixed-input-tool-loop', 300000);
  const mixed = JSON.parse(fs.readFileSync(path.join(mixedOutput, 'browser-input-validation.json'), 'utf8'));
  check(mixed.complete === true && mixed.failures.length === 0 && mixed.domSends === 15 && mixed.mixedGroups.length === 2
    && mixed.mixedGroups.every(group => group.entities === 47 && group.providerRequests === 3)
    && mixed.secondGroups.length === 2 && mixed.secondGroups.every(group => group.entities === 69 && group.providerRequests === 4)
    && mixed.thirdGroups.length === 2 && mixed.thirdGroups.every(group => group.entities === 53 && group.providerRequests === 4), variant + ': packaged browser covers all three mixed corpora, including third-generation 27 sensitive cases, 25 public negatives and technical opt-ins through input and actual tool returns');
  check(!output.includes('自动重建') && JSON.stringify(runtimeFiles.map(file => hash(path.join(bundle, file)))) === JSON.stringify(before), variant + ': journeys did not repair the package');
}
async function fullInstall(bundle) {
  const home = path.join(scratch, 'full-install-home'), env = environment(home, path.join(home, 'data'));
  const acc = path.join(bundle, 'mcp/ai-computer-control'), python = path.join(acc, 'python_embed/python.exe');
  const claude = path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'); fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, JSON.stringify({ releaseMarker: 'keep', mcpServers: { unrelated: { command: 'synthetic-unrelated' } } }));
  check(fs.existsSync(python), 'Full has embedded CPython');
  const probe = "import runpy; m=runpy.run_path('install.py'); assert m['verify_offline_payload'](); exec(m['IMPORT_PROBE'])";
  await run(python, ['-I', '-B', '-X', 'utf8', '-c', probe], { cwd: acc, env }, 'full-integrity-and-imports');
  await run(python, ['-I', '-B', '-X', 'utf8', path.join(acc, 'install.py'), '--ensure'], { cwd: acc, env }, 'full-first-ensure', 300000);
  const state = path.join(env.ACC_INSTALL_DIR, 'install-state.json'), before = hash(state);
  const installedPython = path.join(env.ACC_INSTALL_DIR, 'runtime/python/python.exe');
  check(fs.existsSync(installedPython), 'Full installs its own isolated Python runtime');
  const registration = JSON.parse(fs.readFileSync(claude, 'utf8'));
  check(registration.releaseMarker === 'keep' && registration.mcpServers.unrelated.command === 'synthetic-unrelated' && path.resolve(registration.mcpServers['ai-computer-control'].command) === path.resolve(installedPython), 'Full registers installed MCP without losing unrelated local configuration');
  const second = await run(python, ['-I', '-B', '-X', 'utf8', path.join(acc, 'install.py'), '--ensure'], { cwd: acc, env }, 'full-second-ensure', 120000);
  check(/already installed/.test(second) && hash(state) === before, 'Full second ensure is idempotent, not a reinstall');
  const provenance = "import os, ai_computer_control, ai_computer_control.server as s; import winsdk.windows.media.ocr; assert os.path.commonpath([ai_computer_control.__file__, os.environ['ACC_INSTALL_DIR']]) == os.environ['ACC_INSTALL_DIR']; assert len(s.mcp._tool_manager.list_tools()) == 108; print('installed ACC 108 tools and WinSDK OCR imports verified')";
  await run(installedPython, ['-I', '-B', '-X', 'utf8', '-c', provenance], { cwd: scratch, env }, 'full-installed-imports');
  for (const module of ['ai_computer_control.server', 'ai_computer_control']) await installedMcp(installedPython, module, env);
  await run(installedPython, ['-B', '-X', 'utf8', path.join(acc, 'tests/smoke_stdio.py')], { cwd: acc, env }, 'full-real-mcp-stdio', 180000);
  report.fullInstall = { installStateSha256: before, isolated: true, mcpStdioPassed: true, idempotent: true }; save();
}
async function installedMcp(python, module, env) {
  const child = spawn(python, ['-I', '-B', '-X', 'utf8', '-m', module], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', nextId = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); });
  child.stdout.on('data', data => {
    buffer += data.toString('utf8'); let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const msg = JSON.parse(line); if (pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); } } catch {}
    }
  });
  const send = async (method, params, notification = false) => {
    const id = ++nextId;
    const response = notification ? null : new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(module + ': MCP timeout: ' + method)); }, 45000);
      pending.set(id, { resolve: msg => { clearTimeout(timer); if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }) + '\n');
    return response;
  };
  try {
    await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-acceptance', version: '1' } });
    await send('notifications/initialized', {}, true);
    const list = await send('tools/list', {});
    check(list.tools?.length === 108 && list.tools.some(tool => tool.name === 'file_info'), module + ': installed runtime exposes 108 tools over real stdio');
    const file = path.join(scratch, 'mcp-file-info.txt'); fs.writeFileSync(file, 'synthetic MCP evidence');
    const result = await send('tools/call', { name: 'file_info', arguments: { path: file } });
    const info = JSON.parse(result.content.find(item => item.type === 'text').text);
    check(!result.isError && info.exists === true && info.size === fs.statSync(file).size, module + ': real installed tool call returns exact file metadata');
  } finally { child.stdin.end(); await stop(child); fs.writeFileSync(path.join(scratch, module + '-stderr.log'), stderr); }
}
(async () => {
  try {
    if (process.platform !== 'win32') throw new Error('Actual Windows packages require Windows');
    for (const key of ['slim', 'full', 'baseline-ref', 'output']) if (!args[key]) throw new Error('Missing --' + key);
    const output = path.resolve(args.output); if (fs.existsSync(output)) throw new Error('Output must be a new directory'); fs.mkdirSync(output, { recursive: true }); scratch = output;
    report.sourceBaseRevision = revision('HEAD'); report.baseline = { ref: args['baseline-ref'], revision: revision(args['baseline-ref']) };
    report.baseline.tag = 'v3.0.1';
    check(report.baseline.revision === revision('refs/tags/v3.0.1'), 'upgrade baseline resolves to the actual v3.0.1 release tag');
    const diff = cp.execFileSync('git', ['diff', '--binary', 'HEAD', '--', 'ruyi-workbench', 'dev-harness'], { cwd: ROOT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    report.sourceDirty = Boolean(cp.execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim());
    report.sourceDiffSha256 = crypto.createHash('sha256').update(diff).digest('hex');
    report.desktopSourceSha256 = hash(path.join(ROOT, 'ruyi-workbench/desktop/RuyiDesktop.cs'));
    report.acceptanceHarnessSha256 = hash(__filename);
    report.releaseChecksSha256 = hash(path.join(__dirname, 'lib/release-checks.js'));
    report.applicationVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench/package.json'), 'utf8')).version;
    const expectedNativeTools = JSON.parse(fs.readFileSync(path.join(ROOT, 'facts.json'), 'utf8')).nativeTools;
    check(Number.isInteger(expectedNativeTools) && expectedNativeTools > 0, 'candidate tool registry count comes from the generated facts');
    report.sourceAppSha256 = treeHash(path.join(ROOT, 'ruyi-workbench/app')); save();
    fake = await startFakeProvider({ handler(req) { if (privacyScenario) return privateProviderResponse(req); if (!req.messages.some(m => m.role === 'tool')) return toolCallFrames('file_write', { path: targetFile, content: 'PACKAGE_ACCEPTANCE_OK\n' }, 'qa_write'); return [...textFrames('PACKAGE_ACCEPTANCE_OK'), usageFrame(8, 4)]; } });
    const bundles = {};
    for (const variant of ['slim', 'full']) bundles[variant] = await extract(path.resolve(args[variant]), variant);
    check(!fs.existsSync(path.join(bundles.slim, 'mcp/ai-computer-control/python_embed')), 'Slim does not pretend to include Full ACC');
    const oldRoot = path.join(scratch, 'baseline-source'); fs.mkdirSync(oldRoot);
    const archive = path.join(scratch, 'baseline.tar');
    await run('git', ['archive', '--format=tar', '--output=' + archive, args['baseline-ref'], 'ruyi-workbench'], { cwd: ROOT }, 'baseline-archive');
    await run('tar.exe', ['-xf', archive, '-C', oldRoot], {}, 'baseline-extract');
    const oldBundle = path.join(oldRoot, 'ruyi-workbench'); fs.mkdirSync(path.join(oldBundle, 'runtime/node'), { recursive: true });
    fs.copyFileSync(path.join(bundles.slim, 'runtime/node/node.exe'), path.join(oldBundle, 'runtime/node/node.exe'));
    check(JSON.parse(fs.readFileSync(path.join(oldBundle, 'package.json'))).version === '3.0.1', 'upgrade data is produced by actual v3.0.1 tag source');
    const oldData = path.join(scratch, 'baseline-data'), oldHome = path.join(scratch, 'baseline-home'), work = path.join(scratch, 'work'); fs.mkdirSync(work);
    fs.mkdirSync(path.join(oldData, 'memory/global'), { recursive: true });
    fs.writeFileSync(path.join(oldData, 'memory/global/release-upgrade.md'), '---\nname: Release upgrade reference\ndescription: release-upgrade-memory\ntype: preference\ncreatedAt: 2026-10-01T00:00:00.000Z\n---\nPreserve this synthetic old reference.\n');
    const old = await serve(oldBundle, oldData, oldHome); let seeded, before;
    try { seeded = await conversation(old, work, 'old-v301'); before = await snapshot(old, oldData, seeded);
      const memory = (await old.request('/api/tools/workbench_memory_read', { sessionId: seeded.id, id: 'release-upgrade', scope: 'global' })).result;
      check(memory?.ok === true && memory.memory.body.includes('Preserve this synthetic old reference.'), 'old runtime reads the compatible reference');
    } finally { await stop(old.child); }
    const backup = path.join(scratch, 'baseline-backup'); fs.cpSync(oldData, backup, { recursive: true });
    for (const variant of ['slim', 'full']) {
      const bundle = bundles[variant];
      for (const executable of [false, true]) {
        const label = variant + (executable ? '-exe' : '-node'), home = path.join(scratch, label + '-fresh-home'), data = path.join(scratch, label + '-fresh-data');
        check(!fs.existsSync(data), label + ': truly fresh data root');
        const server = await serve(bundle, data, home, executable);
        try { const status = await server.request('/api/status'); check(status.version === report.applicationVersion && path.resolve(status.dataRoot) === data, label + ': actual runtime version/data root correct');
          check(String(await server.request('/')).includes('如意'), label + ': packaged UI is served');
          await conversation(server, work, label);
          const counts = await server.request('/api/tools/workbench_self_status', { section: 'counts' }); check(counts.result?.counts?.nativeTools === expectedNativeTools, label + ': actual runtime has the candidate tool registry');
          await candidatePrivacy(server, data, work, label);
          await candidateVaultAndRules(server, data, work, label);
        } finally { await stop(server.child); }
      }
      const upgraded = path.join(scratch, variant + '-upgrade-data'); fs.cpSync(backup, upgraded, { recursive: true });
      let continued;
      for (let restart = 0; restart < 3; restart++) {
        const current = await serve(bundle, upgraded, path.join(scratch, variant + '-upgrade-home'), true);
        try {
          check(JSON.stringify(await snapshot(current, upgraded, seeded)) === JSON.stringify(continued || before), variant + ': upgrade/restart preserves configuration, conversation, history, usage, memory and artifact');
          if (restart === 1) {
            const memory = (await current.request('/api/tools/workbench_memory_read', { sessionId: seeded.id, id: 'release-upgrade', scope: 'global' })).result;
            check(memory?.ok === true && memory.memory.body.includes('Preserve this synthetic old reference.'), variant + ': upgraded runtime reads the old memory');
            targetFile = seeded.artifact;
            const stream = await current.request('/api/chat/stream', { sessionId: seeded.id, cwd: work, message: 'Continue the original conversation and confirm the artifact.' });
            successfulTurn(stream, variant + ': upgraded old conversation can continue');
            continued = await snapshot(current, upgraded, seeded);
            check(continued.history !== before.history && JSON.stringify(continued.usage) !== JSON.stringify(before.usage), variant + ': continuation persists history and usage');
          }
          if (restart === 2) {
            check(!fs.existsSync(path.join(upgraded, 'credential-vault-v1.json')), variant + ': default-off upgrade and three starts do not initialize encryption');
            await current.request('/api/privacy/encryption', { enabled: true });
            check(JSON.stringify(await snapshot(current, upgraded, seeded)) === JSON.stringify(continued), variant + ': explicit encryption migration preserves all old data and the exact effective credential');
          }
        }
        finally { await stop(current.child); }
      }
      const encryptedRestart = await serve(bundle, upgraded, path.join(scratch, variant + '-upgrade-home'), true);
      try { check(JSON.stringify(await snapshot(encryptedRestart, upgraded, seeded)) === JSON.stringify(continued), variant + ': post-opt-in restart unlocks encrypted old credentials and preserves continuation'); }
      finally { await stop(encryptedRestart.child); }
      await journeys(bundle, variant);
    }
    const restored = path.join(scratch, 'restored-v301-data'); fs.cpSync(backup, restored, { recursive: true });
    const rollback = await serve(oldBundle, restored, path.join(scratch, 'rollback-home'));
    try { check(JSON.stringify(await snapshot(rollback, restored, seeded)) === JSON.stringify(before), 'restore original backup to v3.0.1 preserves all seeded facts'); }
    finally { await stop(rollback.child); }
    await fullInstall(bundles.full);
    check(hash(__filename) === report.acceptanceHarnessSha256 && treeHash(path.join(ROOT, 'ruyi-workbench/app')) === report.sourceAppSha256, 'candidate app and acceptance entry point remain frozen throughout validation');
    report.complete = true;
  } catch (error) { t.fail(error.stack || String(error)); report.error = String(error.message || error); }
  finally {
    for (const child of [...children]) { try { await stop(child); } catch (error) { t.fail(error.message); report.complete = false; } }
    if (fake) await fake.close(); report.finishedAt = new Date().toISOString(); report.failures = t.failures; save();
    if (scratch) console.log('ARTIFACTS ' + scratch); t.done({ exit: true });
  }
})();
