'use strict';
// ROOT SERIAL: real DPAPI/NTFS. Enable a data root through the cold-operation host,
// release ownership, then boot the real server and exercise the sealed attachment
// upload/download/range route over HTTP.
const path = require('node:path');
require('./lib/self-isolate-home');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process');
const { releaseEnvironment } = require('./lib/release-checks'), { killOwnTree } = require('./lib/kill-own-tree'), { getFreePort } = require('./free-port');
const t = require('./lib/harness').createRunner('ATTACHMENT HTTP ROUNDTRIP'), { ok } = t;
const names = ['WorkDataColdOperations', 'WorkDataFullSnapshot', 'WorkDataNativeAdapters', 'WorkDataMaintenanceResult', 'WorkDataManifest',
  'WorkDataMigrationHost', 'WorkDataNativePublish', 'WorkDataDisposableNativeTree', 'ServerOwnership', 'LocalSecretCrypto', 'ExternalBotCredentials',
  'MigrationHooks', 'migrationCapsuleCapturePreserved', 'WorkDataKeys', 'WorkDataStore', 'flushWorkbenchLogs', 'paths'];
const WB = path.resolve(__dirname, '../ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  if (process.platform !== 'win32') { console.log('SKIP Windows DPAPI/NTFS attachment http roundtrip'); return; }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-attachment-http-')), base = path.join(root, 'data'),
    home = path.join(root, 'home'), serverHome = path.join(root, 'server-home'), backupDirectory = path.join(root, 'backups');
  const password = 'owned synthetic attachment password';
  let owner = null, child = null, api = null;
  try {
    api = require('./lib/server-internals').loadServerInternals(names);
    await fsp.mkdir(base, { recursive: true });
    await fsp.mkdir(path.join(base, 'sessions'), { recursive: true });
    await fsp.mkdir(backupDirectory, { recursive: true });
    await fsp.writeFile(path.join(base, 'sessions', 'sess_http.json'), '{"id":"sess_http","private":"HTTP ROUNDTRIP PRIVATE"}');
    await fsp.writeFile(path.join(base, 'config.json'), '{"workDataEncryptionV1":false,"configSchema":9}');
    await fsp.mkdir(path.join(base, 'uploads', 'file_0123456789abcdef'), { recursive: true });
    await fsp.writeFile(path.join(base, 'uploads', 'file_0123456789abcdef', 'seed.bin'), Buffer.from('SEED RAW ATTACHMENT'));
    const env = releaseEnvironment(home, base);
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
    Object.assign(process.env, env);
    owner = await api.ServerOwnership.acquire([base]);
    const guard = async work => work();
    const disposable = api.WorkDataDisposableNativeTree.create({ capturePreserved: (...args) => guard(() => api.migrationCapsuleCapturePreserved(...args)) });
    const native = api.WorkDataNativeAdapters.create(), host0 = native.coldOperationHost(() => {}), flush = api.WorkDataNativePublish.createFlush();
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
    await owner.release(); owner = null;

    const serverEnv = releaseEnvironment(serverHome, base);
    const port = await getFreePort();
    child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: serverEnv });
    let baseUrl = '', token = '';
    for (let attempt = 0; attempt < 160 && !token; attempt++) {
      await sleep(250);
      try { const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (response.ok) { token = (await response.json()).token || ''; baseUrl = `http://127.0.0.1:${port}`; } } catch {}
    }
    ok(!!token, 'server bootstrapped on the encrypted generation');
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
    const leaked = [];
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (fs.readFileSync(full).includes(Buffer.from('LIVE SEALED ATTACHMENT'))) leaked.push(full); } };
    const activeNow = await api.WorkDataManifest.create({ base }).readActive();
    walk(path.join(activeNow.root, 'uploads'));
    ok(leaked.length === 0, 'no plaintext attachment bytes under the active uploads root');
  } finally {
    if (child) await killOwnTree(child);
    if (owner) { try { await api.flushWorkbenchLogs({ allowFailure: true }); await owner.release(); } catch {} }
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done({ exit: true }));
