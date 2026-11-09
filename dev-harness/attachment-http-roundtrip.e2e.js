'use strict';
// ROOT SERIAL: real DPAPI/NTFS. Enable a data root through the cold-operation host,
// release ownership, then boot the real server and exercise the sealed attachment
// upload/download/range route over HTTP.
const path = require('node:path');
const assert = require('node:assert/strict');
require('./lib/self-isolate-home');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process');
const { releaseEnvironment } = require('./lib/release-checks'), { killOwnTree } = require('./lib/kill-own-tree'), { getFreePort } = require('./free-port');
const t = require('./lib/harness').createRunner('ATTACHMENT HTTP ROUNDTRIP'), { ok } = t;
const names = ['WorkDataColdOperations', 'WorkDataFullSnapshot', 'WorkDataNativeAdapters', 'WorkDataMaintenanceResult', 'WorkDataManifest',
  'WorkDataMigrationHost', 'WorkDataNativePublish', 'WorkDataDisposableNativeTree', 'ServerOwnership', 'LocalSecretCrypto', 'ExternalBotCredentials',
  'MigrationHooks', 'migrationCapsuleCapturePreserved', 'WorkDataKeys', 'WorkDataStore', 'flushWorkbenchLogs', 'paths', 'WorkDataAttachmentRuntime', 'toolImageSessionTag', 'atomicWriteJson'];
const WB = path.resolve(__dirname, '../ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  if (process.platform !== 'win32') { console.log('SKIP Windows DPAPI/NTFS attachment http roundtrip'); return; }
  const temporaryParent = path.resolve(os.tmpdir());
  const root = await fsp.mkdtemp(path.join(temporaryParent, 'ruyi-attachment-http-')), base = path.join(root, 'data'),
    home = path.join(root, 'home'), serverHome = path.join(root, 'server-home'), backupDirectory = path.join(root, 'backups');
  const password = 'owned synthetic attachment password';
  let owner = null, child = null, childClose = null, api = null, activeKeys = null, native = null, passed = false;
  try {
    api = require('./lib/server-internals').loadServerInternals(names);
    await fsp.mkdir(base, { recursive: true });
    await fsp.mkdir(path.join(base, 'sessions'), { recursive: true });
    await fsp.mkdir(backupDirectory, { recursive: true });
    await fsp.writeFile(path.join(base, 'sessions', 'sess_http.json'), '{"id":"sess_http","private":"HTTP ROUNDTRIP PRIVATE","messages":[],"providerHistory":[]}');
    await fsp.writeFile(path.join(base, 'config.json'), '{"workDataEncryptionV1":false,"configSchema":9}');
    await fsp.mkdir(path.join(base, 'uploads', 'file_0123456789abcdef'), { recursive: true });
    await fsp.writeFile(path.join(base, 'uploads', 'file_0123456789abcdef', 'seed.bin'), Buffer.from('SEED RAW ATTACHMENT'));
    const env = releaseEnvironment(home, base);
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
    Object.assign(process.env, env);
    owner = await api.ServerOwnership.acquire([base]);
    const guard = async work => work();
    const disposable = api.WorkDataDisposableNativeTree.create({ capturePreserved: (...args) => guard(() => api.migrationCapsuleCapturePreserved(...args)) });
    native = api.WorkDataNativeAdapters.create();
    const host0 = native.coldOperationHost(() => {}), flush = api.WorkDataNativePublish.createFlush();
    const host = { acquire: roots => api.ServerOwnership.acquire(roots), flush: dirs => guard(() => flush(dirs)),
      helperMayStillRun: () => native.helperMayStillRun(), fullSnapshot: (...args) => host0.fullSnapshot(...args),
      captureRehearsal: (...args) => host0.captureRehearsal(...args), verifyDisposableNativeTree: value => guard(() => disposable(value)),
      migrationFactory: options => host0.migrationFactory(options), progress: () => {}, verifyFresh: async () => true };
    const operation = api.WorkDataColdOperations.create(host);
    const active = await api.WorkDataManifest.create({ base }).readActive();
    const enabled = await guard(() => operation.execute({ id: crypto.randomBytes(24).toString('hex'), base, operation: 'enable', password,
      ownership: owner, assertExclusive: value => value === owner,
      expectedAuthority: { generation: active.generation, id: active.id, mode: active.mode, sha256: active.proof.sha256 },
      paths: { backupDirectory, targetDirectory: null, uploadFile: null, uploadSha256: null } })).catch(error => {
      console.log('ENABLE_ERROR', { code: error.code, message: error.message, cause: error.cause && { code: error.cause.code, message: error.cause.message },
        extra: { helperMayStillRun: error.helperMayStillRun, operationMayHaveExecuted: error.operationMayHaveExecuted } });
      throw error;
    });
    ok(enabled.state === 'published', 'cold enable published an encrypted generation');
    await api.flushWorkbenchLogs({ allowFailure: true });
    const activeRoot = (await api.WorkDataManifest.create({ base }).readActive()).root;
    const activeHeader = JSON.parse(await fsp.readFile(path.join(activeRoot, 'work-data-key-v1.json'), 'utf8'));
    activeKeys = api.WorkDataKeys.create({ protector: api.LocalSecretCrypto, enabled: () => true, store: { read: async () => activeHeader } });
    const otherSession = api.WorkDataStore.createText({ file: () => path.join(activeRoot, 'sessions', 'sess_other.json'),
      purpose: 'session', schema: 2, scopeId: 'sessions', recordId: 'sess_other', keys: activeKeys, enabled: () => true,
      writeJson: api.atomicWriteJson });
    await otherSession.write(JSON.stringify({ id: 'sess_other', messages: [], providerHistory: [] }));
    const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const imageHash = crypto.createHash('sha1').update(pixels).digest('hex').slice(0, 24);
    const toolImageId = session => 'toolimg_' + api.toolImageSessionTag(session) + '_' + imageHash;
    const toolId = toolImageId('sess_http'), retainedId = toolImageId('sess_other');
    const toolRuntime = api.WorkDataAttachmentRuntime.create({ root: path.join(activeRoot, 'uploads'), keys: activeKeys, enabled: () => true, face: 'toolImage' });
    for (const id of [toolId, retainedId]) {
      const sealed = await toolRuntime.seal({ id, kind: 'tool-image', logicalName: 'shot.png', mime: 'image/png', data: pixels });
      assert.equal(sealed.sha256, crypto.createHash('sha256').update(pixels).digest('hex'));
    }
    ok(true, 'tool images for two session tags seal into the tool-image face with real keys');
    activeKeys.clear(); activeKeys = null;
    assert.equal(native.helperMayStillRun(), false);
    await owner.release(); owner = null;

    const serverEnv = releaseEnvironment(serverHome, base);
    const port = await getFreePort();
    child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: WB, windowsHide: true, env: serverEnv, stdio: 'ignore' });
    childClose = new Promise(resolve => child.once('close', resolve));
    let spawnError;
    child.on('error', error => { spawnError = error; });
    const live = () => !spawnError && child.pid > 0 && child.exitCode === null && child.signalCode === null;
    const binding = () => {
      assert.equal(live(), true, 'the owned normal serve is still live');
      const runtime = JSON.parse(fs.readFileSync(path.join(base, 'runtime.json'), 'utf8'));
      assert.equal(runtime.pid, child.pid);
      assert.equal(runtime.host, '127.0.0.1');
      assert.equal(runtime.port, port);
      assert.match(runtime.token, /^[a-f0-9]{32}$/);
      return runtime;
    };
    const baseUrl = `http://127.0.0.1:${port}`;
    let token = '';
    for (let attempt = 0; attempt < 160 && !token; attempt++) {
      await sleep(250);
      assert.equal(live(), true, 'normal serve remains available during startup');
      let runtime;
      try { runtime = binding(); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try {
        const response = await fetch(baseUrl + '/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          redirect: 'error', signal: AbortSignal.timeout(3000) });
        if (response.ok) token = (await response.json()).token || '';
      } catch { /* startup transport may still be unavailable */ }
      if (token) assert.ok(token === runtime.token, 'bootstrap token belongs to this fixture process');
    }
    assert.ok(token === binding().token, 'the acquired token belongs to the running fixture');
    ok(true, 'owned server bootstrapped on the encrypted generation');
    const auth = { 'content-type': 'application/json', 'x-wcw-token': token };
    const upload = await fetch(baseUrl + '/api/upload', { method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'live.bin', mime: 'application/octet-stream', data: Buffer.from('LIVE SEALED ATTACHMENT').toString('base64') }) });
    const uploaded = await upload.json().catch(() => ({}));
    ok(upload.status === 200 && uploaded.file && uploaded.file.sealed === true, 'encrypted upload returns a sealed record');
    const id = uploaded.file.id, url = `${baseUrl}/api/upload/content?id=${encodeURIComponent(id)}&name=live.bin`;
    const whole = await fetch(url, { headers: auth });
    ok(whole.status === 200 && Buffer.from(await whole.arrayBuffer()).toString('utf8') === 'LIVE SEALED ATTACHMENT', 'sealed download returns the original bytes');
    const ranged = await fetch(url, { headers: { ...auth, range: 'bytes=5-10' } });
    ok(ranged.status === 206 && Buffer.from(await ranged.arrayBuffer()).toString('utf8') === 'SEALED', 'sealed range returns 206 with exact bytes');
    const beyond = await fetch(url, { headers: { ...auth, range: 'bytes=999-' } });
    ok(beyond.status === 416 && beyond.headers.get('content-range') === 'bytes */22', 'unsatisfiable sealed range answers 416');
    const toolUrl = id => `${baseUrl}/api/upload/content?id=${encodeURIComponent(id)}&name=shot.png`;
    const toolWhole = await fetch(toolUrl(toolId), { headers: auth });
    ok(toolWhole.status === 200 && toolWhole.headers.get('content-type') === 'image/png'
      && Buffer.from(await toolWhole.arrayBuffer()).equals(pixels), 'sealed tool image is served over HTTP with exact PNG bytes');
    const session = id => fetch(baseUrl + '/api/sessions/' + id, { headers: auth });
    assert.equal((await session('sess_http')).status, 200, 'the deleted session exists on the active generation');
    assert.equal((await session('sess_other')).status, 200, 'the other session exists on the active generation');
    assert.ok(binding().token === token, 'session deletion targets the original fixture process');
    const deleted = await fetch(baseUrl + '/api/sessions/sess_http', { method: 'DELETE', headers: auth, redirect: 'error' });
    ok(deleted.status === 200 && (await deleted.json()).ok === true, 'production HTTP session deletion completes');
    const toolGone = await fetch(toolUrl(toolId), { headers: auth });
    ok(toolGone.status === 404, 'retired tool image is no longer served');
    const retained = await fetch(toolUrl(retainedId), { headers: auth });
    ok(retained.status === 200 && Buffer.from(await retained.arrayBuffer()).equals(pixels), 'another session keeps its identical sealed tool image');
    ok((await session('sess_http')).status === 404 && (await session('sess_other')).status === 200,
      'the deleted session disappears and the other session survives');
    const leaked = [];
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else { const bytes = fs.readFileSync(full); if (bytes.includes(Buffer.from('LIVE SEALED ATTACHMENT')) || bytes.includes(pixels)) leaked.push(full); } } };
    const activeNow = await api.WorkDataManifest.create({ base }).readActive();
    walk(path.join(activeNow.root, 'uploads'));
    ok(leaked.length === 0, 'no plaintext attachment or tool-image bytes under the active uploads root');
    passed = t.failures === 0;
  } finally {
    let stopped = !child;
    if (child) {
      const termination = killOwnTree(child);
      let timer;
      try {
        const closed = await Promise.race([childClose.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
        stopped = closed && !termination.skipped;
      } finally { clearTimeout(timer); }
    }
    activeKeys?.clear();
    const known = !native || native.helperMayStillRun() === false;
    if (owner && known) { await api.flushWorkbenchLogs({ allowFailure: true }); await owner.release(); }
    if (passed && known && stopped) {
      assert.equal(path.dirname(root), temporaryParent);
      assert.ok(path.basename(root).startsWith('ruyi-attachment-http-'));
      await fsp.rm(root, { recursive: true, force: true });
    } else {
      console.error('Retained owned attachment fixture ' + root);
      if (passed) throw new Error('attachment process or native owner closure was unproven');
    }
  }
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done({ exit: true }));
