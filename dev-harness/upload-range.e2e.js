'use strict';
// Real HTTP: the attachment download route serves full bodies and single byte
// ranges, and refuses unsatisfiable ranges with `bytes */size`.
require('./lib/self-isolate-home');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness'), { releaseEnvironment } = require('./lib/release-checks'),
  { killOwnTree } = require('./lib/kill-own-tree'), { getFreePort } = require('./free-port');
const t = createRunner('UPLOAD RANGE HTTP'), { ok } = t;
const WB = path.resolve(__dirname, '../ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-upload-range-')), workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ configSchema: 9, permissionMode: 'acceptEdits',
    defaultWorkspace: workspace, workspaces: [{ path: workspace, read: true, write: true, execute: false }], workDataEncryptionV1: false, providers: [] }));
  const env = releaseEnvironment(root, path.join(root, 'data'));
  const port = await getFreePort();
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env });
  let base = '', token = '';
  try {
    for (let attempt = 0; attempt < 120 && !token; attempt++) {
      await sleep(250);
      try { const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (response.ok) { token = (await response.json()).token || ''; base = `http://127.0.0.1:${port}`; } } catch {}
    }
    ok(!!token, 'server bootstrapped a UI token');
    const bytes = Buffer.alloc(1000); for (let n = 0; n < bytes.length; n++) bytes[n] = n % 251;
    const upload = await fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token },
      body: JSON.stringify({ name: 'range.bin', data: bytes.toString('base64') }) });
    const uploaded = await upload.json();
    ok(upload.status === 200 && uploaded.file && uploaded.file.id && uploaded.file.name === 'range.bin', 'upload wrote the attachment record');
    const route = `${base}/api/upload/content?id=${encodeURIComponent(uploaded.file.id)}&name=range.bin`;
    const auth = { 'x-wcw-token': token };
    const full = await fetch(route, { headers: auth });
    const fullBytes = Buffer.from(await full.arrayBuffer());
    ok(full.status === 200 && fullBytes.length === 1000 && fullBytes.equals(bytes), 'full download keeps the original bytes');
    ok(full.headers.get('accept-ranges') === 'bytes', 'full download advertises byte ranges');
    const ranged = await fetch(route, { headers: { ...auth, range: 'bytes=10-19' } });
    const rangedBytes = Buffer.from(await ranged.arrayBuffer());
    ok(ranged.status === 206 && ranged.headers.get('content-range') === 'bytes 10-19/1000' && ranged.headers.get('content-length') === '10' && rangedBytes.equals(bytes.subarray(10, 20)), 'explicit range returns 206 with exact bytes and length');
    const emptyUpload = await fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': 'application/json', 'x-wcw-token': token },
      body: JSON.stringify({ name: 'empty.bin', data: '' }) });
    const emptyRecord = await emptyUpload.json();
    const emptyRoute = `${base}/api/upload/content?id=${encodeURIComponent(emptyRecord.file.id)}&name=empty.bin`;
    const empty = await fetch(emptyRoute, { headers: auth });
    ok(empty.status === 200 && empty.headers.get('content-length') === '0', 'empty attachment downloads as a zero-length body');
    const emptyRange = await fetch(emptyRoute, { headers: { ...auth, range: 'bytes=-1' } });
    ok(emptyRange.status === 416 && emptyRange.headers.get('content-range') === 'bytes */0', 'empty attachment answers 416 for any range');
    const upper = await fetch(route, { headers: { ...auth, range: 'Bytes=0-0' } });
    ok(upper.status === 416, 'unknown range units are refused instead of serving the whole body');
    const suffix = await fetch(route, { headers: { ...auth, range: 'bytes=-5' } });
    ok(suffix.status === 206 && Buffer.from(await suffix.arrayBuffer()).equals(bytes.subarray(995)), 'suffix range returns the tail');
    const open = await fetch(route, { headers: { ...auth, range: 'bytes=990-' } });
    ok(open.status === 206 && open.headers.get('content-range') === 'bytes 990-999/1000', 'open-ended range is clamped to the file size');
    const beyond = await fetch(route, { headers: { ...auth, range: 'bytes=2000-' } });
    ok(beyond.status === 416 && beyond.headers.get('content-range') === 'bytes */1000', 'unsatisfiable range answers 416 with bytes */size');
    const invalid = await fetch(route, { headers: { ...auth, range: 'bytes=5-1' } });
    ok(invalid.status === 416, 'reversed range answers 416');
    const noAuth = await fetch(route);
    ok(noAuth.status === 403, 'range requests still require the token');
  } finally {
    await killOwnTree(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done({ exit: true }));
