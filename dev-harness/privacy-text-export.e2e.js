'use strict';
// Actual generated API, authenticated loopback receiver, synthetic mapping vault.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { createRunner } = require('./lib/harness');
const { CdpClient, waitForTarget } = require('./lib/browser-fixture');
const { findBrowserExecutable } = require('./lib/browser-path');
const { killOwnTree } = require('./lib/kill-own-tree');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');
const { getFreePort } = require('./free-port');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-text-export-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const app = require('./lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'handleApi', 'serveStatic', 'send', 'createSession', 'saveSession', 'loadSession', 'mutateConfig', 'readConfig', 'stewardMemoryPath', 'stewardMutateMemory', 'STEWARD_SESSION_ID'], { withEval: true });
const { vault } = require('./lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = vault.sealLocal; app.PrivacyCore.configHooks.openLocal = vault.openLocal;
const t = createRunner('PRIVACY TEXT EXPORT'), { ok } = t;
let server, base, browser, cdp, browserProfile;
const owned = { async close() {
  if (cdp) cdp.close();
  if (browser) await killOwnTree(browser);
  if (browserProfile) stopRuyiTestBrowsers(browserProfile);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
} };
async function request(body, route = '/api/privacy/export', authenticated = true) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-wcw-token': 'synthetic-export-token' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const bytes = await response.text(); return { status: response.status, value: JSON.parse(bytes), bytes };
}
async function mode(privacyModeV1) {
  await app.mutateConfig(config => Object.assign(config, { privacyModeV1, privacyRulesV1: [], providers: [], credentialEncryptionV1: true, activeProvider: '', stewardEnabledV1: true, schedulerEnabledV1: false, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, externalMcpServers: [], desktopMcp: { enabled: false, autodetect: false } }));
}
async function learn(id, secret) { return app.PrivacyGateway.withPolicy(id, () => app.PrivacyGateway.toolResult({ password: secret })); }
async function consume(response) { return request({ op: 'validate', proof: response.value.proof, hash: response.value.hash }); }
(async () => {
  app.__eval("RUNTIME.token = 'synthetic-export-token'");
  server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://x').pathname;
      if (pathname === '/export-fixture') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><button id="export">Export</button><div id="toastTray"></div>'); }
      else if (pathname.startsWith('/api/')) await app.handleApi(req, res, pathname);
      else app.send(res, await app.serveStatic(pathname, req));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  await mode('enhanced');
  const one = await app.createSession({ title: 'Synthetic export', cwd: root }), two = await app.createSession({ title: 'Second source', cwd: root });
  const secret = 'SyntheticKnownAlpha', second = 'SyntheticKnownBeta';
  const alias = (await learn(one.id, secret)).password; await learn(two.id, second);
  one.title = secret; one.metadata = { [secret]: { value: second } }; one.messages = [{ role: 'user', content: secret + '\n中文 😀' }]; await app.saveSession(one);
  ok((await request({ kind: 'session', sessionId: one.id }, undefined, false)).status === 403, 'export requires local token');
  for (const privacy of ['basic', 'enhanced', 'strict']) {
    await mode(privacy); await learn(one.id, secret);
    for (const format of ['md', 'json', 'html']) {
      const response = await request({ kind: 'session', sessionId: one.id, format });
      ok(response.status === 200 && !response.bytes.includes(secret) && !response.value.filename.includes(secret), `${privacy} ${format}: final content/title/filename inherit known scope protection`);
      const validated = await request({ op: 'validate', proof: response.value.proof, hash: response.value.hash });
      ok(validated.status === 200, `${privacy} ${format}: prepared bytes validate`);
      ok((await request({ op: 'validate', proof: response.value.proof, hash: response.value.hash })).status === 409, `${privacy} ${format}: proof is single-use`);
    }
  }
  await mode('enhanced'); await learn(one.id, secret); await learn(two.id, second);
  const mixed = await request({ kind: 'raw-events', events: [{ seq: 1, line: JSON.stringify({ [secret]: 'public value' }), sourceSessionId: one.id }, { seq: 2, line: second, sourceSessionId: two.id }, { seq: 3, line: 'unverified-private-body' }] });
  ok(!mixed.bytes.includes(secret) && !mixed.bytes.includes(second) && !mixed.bytes.includes('unverified-private-body') && mixed.value.contentWithheld, 'mixed raw sources protect keys/values and explicitly withhold missing provenance');
  await consume(mixed);
  const plainRaw = await request({ kind: 'raw-events', plaintext: true, events: [{ seq: 1, line: alias, sourceSessionId: one.id }] });
  ok(plainRaw.value.content === alias && !plainRaw.bytes.includes(secret), 'plaintext raw copy never resolves client-submitted aliases');
  await consume(plainRaw);
  const plain = await request({ kind: 'session', format: 'md', sessionId: one.id, plaintext: true });
  ok(plain.value.content.includes(secret) && !plain.value.protected, 'explicit session plaintext action copies authoritative original');
  await consume(plain);
  const pending = await request({ kind: 'session', format: 'json', sessionId: one.id });
  one.messages.push({ role: 'user', content: 'changed source' }); await app.saveSession(one);
  ok((await request({ op: 'validate', proof: pending.value.proof, hash: pending.value.hash })).status === 409, 'source change before download rejects stale artifact');
  const microtaskSource = await request({ kind: 'session', sessionId: one.id });
  app.__eval(`globalThis.__exportLoad = loadSession; loadSession = async (...args) => { const value = await globalThis.__exportLoad(...args); if (args[0] === ${JSON.stringify(one.id)}) queueMicrotask(() => queueMicrotask(() => sessionDiskWriteSeq.set(args[0], sessionDiskWriteSeqOf(args[0]) + 1))); return value; };`);
  const microtaskDenied = await consume(microtaskSource);
  app.__eval('loadSession = globalThis.__exportLoad; delete globalThis.__exportLoad;');
  ok(microtaskDenied.status === 409, 'source sequence change between async source check and final send is blocked synchronously');
  const learned = await request({ kind: 'session', format: 'md', sessionId: one.id });
  await learn(one.id, 'new unrelated learning');
  const refreshed = await request({ op: 'validate', proof: learned.value.proof, hash: learned.value.hash });
  ok(refreshed.status === 200 && refreshed.value.proof && refreshed.value.content === learned.value.content, 'unrelated learning transparently prepares same bytes with fresh receipt');
  await consume(refreshed);
  const changing = await request({ kind: 'session', format: 'md', sessionId: one.id }); await mode('off');
  ok((await request({ op: 'validate', proof: changing.value.proof, hash: changing.value.hash })).status === 409, 'policy change before download rejects old proof');
  const off = await request({ kind: 'session', format: 'json', sessionId: one.id });
  ok(off.value.content === JSON.stringify(await app.loadSession(one.id), null, 2), 'off JSON preserves authoritative original exact content');
  await consume(off);
  const offRaw = await request({ kind: 'raw-events', events: [{ seq: 4, line: 'unchanged literal ' + alias }] });
  ok(offRaw.value.content === 'unchanged literal ' + alias, 'off logs preserve original bytes with missing provenance');
  await consume(offRaw);
  one.messages.push({ role: 'assistant', content: alias + ' [[RUYI_PVT:CREDENTIAL:00000000000000000000000000000000]]' }); await app.saveSession(one);
  const oldDisplay = (await request(null, '/api/sessions/' + one.id)).value.session;
  for (const format of ['md', 'json', 'html']) {
    const exported = await request({ kind: 'session', format, sessionId: one.id });
    ok(exported.status === 200 && exported.value.content.includes(secret) && !exported.value.content.includes(alias), `off ${format} preserves prior local display restoration and unavailable placeholders`);
    if (format === 'json') ok(exported.value.content === JSON.stringify(oldDisplay, null, 2), 'off JSON exactly equals existing GET displayed session including unknown-reference placeholder');
    await consume(exported);
  }
  await mode('enhanced'); await learn(one.id, secret); await learn(two.id, second);
  const revocable = await app.createSession({ title: 'Revocable copy', cwd: root });
  const revocableAlias = (await learn(revocable.id, 'revocable-private-copy')).password;
  revocable.messages = [{ role: 'user', content: revocableAlias }]; await app.saveSession(revocable);
  const revocablePlain = await request({ kind: 'session', sessionId: revocable.id, plaintext: true });
  await app.PrivacyGateway.withPolicy(revocable.id, async () => app.PrivacyGateway.active().scope.revoke(revocableAlias));
  ok((await consume(revocablePlain)).status === 409, 'plaintext prepared copy cannot survive source mapping revocation');
  for (const [from, to] of [['off', 'enhanced'], ['enhanced', 'off']]) {
    await mode(from); const config = await app.readConfig();
    app.__eval('globalThis.__exportOriginalRead = readConfig; readConfig = async () => { const value = await globalThis.__exportOriginalRead(); await new Promise(resolve => { globalThis.__exportReadRelease = resolve; }); return value; };');
    const held = request({ kind: 'session', sessionId: one.id });
    for (let i = 0; i < 200 && !globalThis.__exportReadRelease; i++) await new Promise(resolve => setTimeout(resolve, 5));
    if (!globalThis.__exportReadRelease) throw new Error('Export readConfig hold did not start');
    app.PrivacyGateway.configure({ ...config, privacyModeV1: to });
    globalThis.__exportReadRelease();
    const denied = await held;
    app.__eval('readConfig = globalThis.__exportOriginalRead; delete globalThis.__exportOriginalRead; delete globalThis.__exportReadRelease;');
    ok(denied.status === 409 && !denied.bytes.includes(secret), `${from}->${to} during readConfig await emits no artifact bytes`);
  }
  await mode('enhanced');
  const date = new Date().toISOString();
  fs.mkdirSync(path.dirname(app.stewardMemoryPath()), { recursive: true });
  fs.writeFileSync(app.stewardMemoryPath(), JSON.stringify({ schema: 1, entries: [{ id: 'memory-one', kind: 'profile', text: secret + second + alias, sourceQuote: second, sourceSessionId: one.id, mergedFrom: [{ sessionId: two.id, turnSeq: 1 }], state: 'active', confidence: 0.6, createdAt: date, updatedAt: date }, { id: 'memory-legacy', kind: 'profile', text: 'legacy-private-body', state: 'active' }] }));
  const memory = await request(null, '/api/steward/memory/export');
  ok(memory.status === 200 && !memory.bytes.includes(secret) && !memory.bytes.includes(second) && !memory.bytes.includes('legacy-private-body') && memory.bytes.includes('contentWithheld'), 'original memory GET protects merged source values and explicitly withholds unknown origin');
  const plainMemory = await request({ kind: 'memory', plaintext: true });
  ok(plainMemory.status === 200 && plainMemory.value.contentWithheld && !plainMemory.value.content.includes(alias), 'plaintext memory reports cross-source alias omission accurately'); await consume(plainMemory);
  const heldMemory = await request({ kind: 'memory' });
  app.__eval('globalThis.__exportAtomic = atomicWriteJson; atomicWriteJson = async (file, value) => { if (file === stewardMemoryPath()) await new Promise(resolve => { globalThis.__exportWriteRelease = resolve; }); return globalThis.__exportAtomic(file, value); };');
  const write = app.stewardMutateMemory(store => ({ persist: true, result: store.entries.length }));
  for (let i = 0; i < 200 && !globalThis.__exportWriteRelease; i++) await new Promise(resolve => setTimeout(resolve, 5));
  if (!globalThis.__exportWriteRelease) throw new Error('Memory write hold did not start');
  const staleMemory = await consume(heldMemory);
  globalThis.__exportWriteRelease(); await write;
  app.__eval('atomicWriteJson = globalThis.__exportAtomic; delete globalThis.__exportAtomic; delete globalThis.__exportWriteRelease;');
  ok(staleMemory.status === 409, 'held memory writer invalidates prior artifact before disk replacement');
  const pendingMemory = await request({ kind: 'memory' });
  await app.mutateConfig(config => { config.stewardEnabledV1 = false; });
  ok((await request({ kind: 'memory' })).status === 409, 'new memory POST inherits disabled steward gate');
  ok((await consume(pendingMemory)).status === 409, 'disabling steward invalidates an already prepared memory download');
  await app.mutateConfig(config => { config.stewardEnabledV1 = true; });

  const origins = Array.from({ length: 200 }, (_, i) => 'historical-source-' + i);
  const manyEntries = origins.map((id, i) => ({ id: 'many-memory-' + i, kind: 'profile', text: 'ordinary public memory ' + i, sourceSessionId: id, state: 'active', createdAt: date, updatedAt: date }));
  fs.writeFileSync(app.stewardMemoryPath(), JSON.stringify({ schema: 1, entries: manyEntries }));
  let started = performance.now(); const protectedMany = await request({ kind: 'memory' }); const protectedMs = performance.now() - started;
  ok(protectedMany.status === 200 && JSON.parse(protectedMany.value.content).entries.length === 200 && !protectedMany.value.contentWithheld, '200 historical memory sources export across 128-scope LRU without omissions');
  await consume(protectedMany); await mode('off');
  started = performance.now(); const offMany = await request({ kind: 'memory' }); const offMs = performance.now() - started;
  ok(offMany.status === 200 && JSON.parse(offMany.value.content).entries.length === 200, 'same 200-entry off baseline exports');
  await consume(offMany);
  console.log('OBSERVATION memory200 protectedMs=' + protectedMs.toFixed(1) + ' offMs=' + offMs.toFixed(1) + ' uniqueOrigins=201 (single synthetic run; no statistical or actual-memory claim)');

  await mode('enhanced'); await learn(one.id, secret);
  const executable = findBrowserExecutable(); if (!executable) throw new Error('Browser unavailable');
  const debugPort = await getFreePort(), profile = path.join(root, 'browser-profile'), downloadDir = path.join(root, 'downloads');
  fs.mkdirSync(downloadDir);
  browser = require('node:child_process').spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, base + '/export-fixture'], { windowsHide: true, stdio: 'ignore' });
  browserProfile = profile;
  const { target, why } = await waitForTarget(debugPort, base + '/export-fixture', browser); if (!target) throw new Error(why || 'Browser target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.connect(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  for (let i = 0; i < 200; i++) { if (await cdp.evaluate(`location.href === ${JSON.stringify(base + '/export-fixture')} && document.readyState === 'complete'`)) break; await new Promise(resolve => setTimeout(resolve, 25)); }
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  await cdp.evaluate(`(async () => {
    window.exportHttp = []; const realFetch = window.fetch; window.fetch = async (...args) => { const response = await realFetch(...args); window.exportHttp.push({url:String(args[0]),status:response.status}); return response; };
    const net = await import('/js/net.js'); await net.initToken();
    const {state} = await import('/js/state.js'); state.config = {privacyModeV1:'enhanced'}; state.currentSession = {id:${JSON.stringify(one.id)}};
    const {downloadPrivacyExport} = await import('/js/privacy-export.js');
    window.dialogCalls = 0; window.confirm = window.prompt = () => { window.dialogCalls++; throw Error('Unexpected dialog'); };
    window.exportClicks = 0;
    document.getElementById('export').onclick = async () => { window.exportClicks++; window.exportResult = await downloadPrivacyExport({kind:'session',format:'json',sessionId:state.currentSession.id}); window.exportDone = true; };
    document.getElementById('export').click();
  })()`);
  let actual;
  for (let i = 0; i < 400; i++) { actual = await cdp.evaluate('window.exportDone ? ({artifact:window.exportResult,clicks:window.exportClicks,dialogs:window.dialogCalls}) : null'); if (actual && fs.readdirSync(downloadDir).some(name => name.endsWith('.json'))) break; await new Promise(resolve => setTimeout(resolve, 25)); }
  const file = fs.readdirSync(downloadDir).find(name => name.endsWith('.json'));
  if (!file || !actual?.artifact) console.log('BROWSER DIAGNOSTIC ' + JSON.stringify(await cdp.evaluate('({done:window.exportDone,result:!!window.exportResult,http:window.exportHttp,notices:document.body.innerText})')));
  ok(Boolean(file && actual?.artifact) && fs.readFileSync(path.join(downloadDir, file), 'utf8') === actual.artifact.content && file === actual.artifact.filename, 'actual browser file bytes and filename equal the prepared Blob artifact');
  ok(actual?.clicks === 1 && actual?.dialogs === 0 && !actual?.artifact?.content.includes(secret), 'default browser export is one click, protected, with zero dialogs');
  const beforeEdit = fs.readdirSync(downloadDir).length;
  const sameIdEdit = await cdp.evaluate(`(async () => {
    const {state} = await import('/js/state.js'); const {downloadPrivacyExport} = await import('/js/privacy-export.js');
    const priorFetch = window.fetch; window.fetch = async (...args) => { const response = await priorFetch(...args); if (String(args[0]).endsWith('/api/privacy/export') && JSON.parse(args[1]?.body || '{}').op === 'validate') state.currentSession.messages = [{role:'user',content:'edited during validation'}]; return response; };
    return await downloadPrivacyExport({kind:'session',format:'json',sessionId:state.currentSession.id});
  })()`);
  ok(sameIdEdit === null && fs.readdirSync(downloadDir).length === beforeEdit, 'same-id browser source edit during final validation prevents a stale download');
  const boundMemory = await cdp.evaluate(`(async () => {
    const {state} = await import('/js/state.js'); const {api} = await import('/js/net.js');
    const {createStewardSettingsDomain} = await import('/js/steward-settings.js');
    const button = document.createElement('button'); button.id = 'cfgStewardMemoryExportBtn'; document.body.appendChild(button);
    const domain = createStewardSettingsDomain({state,api,t:key=>key});
    const bound = domain.bindStewardSettings(); button.click(); return bound;
  })()`);
  const memoryFile = path.join(downloadDir, 'steward-memory.json');
  for (let i = 0; i < 400 && !fs.existsSync(memoryFile); i++) await new Promise(resolve => setTimeout(resolve, 25));
  ok(boundMemory === true && fs.existsSync(memoryFile) && JSON.parse(fs.readFileSync(memoryFile, 'utf8')).entries.length === 200,
    'actual steward settings memory action lazy-loads the shared exporter and downloads the protected memory copy');
})().catch(error => { console.error(error.stack); t.fail('uncaught export fixture error'); }).finally(async () => {
  await owned.close();
  vault.clear(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); t.done();
});
