'use strict';
// Real HTTP and normal serve ownership. Default checks missing-runtime refusal
// and a disconnected incomplete prepare request. --full-components additionally
// uses real native processing for preview disconnect, source/policy revocation
// and the actual 60-second ticket TTL, followed by four successive reuses. Each
// ticket is checked immediately; earlier tickets may expire during later jobs.
// No fake processor, clock, owner, worker
// pause or native-timeout claim. The preload only observes HTTP close events.
require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const os = require('node:os'), path = require('node:path'), http = require('node:http');
const cp = require('node:child_process'), crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { releaseEnvironment } = require('./lib/release-checks');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const runner = createRunner('MEDIA IMAGE HTTP LIFECYCLE'), { ok } = runner;
const full = process.argv.includes('--full-components');
const defaultRoot = path.resolve(__dirname, '../ruyi-workbench');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const observer = String.raw`'use strict';
const http = require('node:http');
const emit = http.Server.prototype.emit;
let sequence = 0;
const report = value => { try { if (process.connected) process.send({ fixture: 'media-http-close', ...value }, () => {}); } catch {} };
http.Server.prototype.emit = function(event, ...args) {
  if (event === 'request') {
    const [req, res] = args;
    if (req.url === '/api/media/images/prepare' || /^\/api\/media\/images\/[a-f0-9]{32}\/preview\?/.test(req.url)) {
      const id = ++sequence, route = req.url.split('?')[0], tag = req.headers['x-ruyi-fixture-request'] || '';
      report({ stage: 'request', id, route, tag });
      res.once('close', () => report({ stage: 'close', id, route, tag, requestAborted: req.aborted, responseFinished: res.writableFinished }));
    }
  }
  return Reflect.apply(emit, this, [event, ...args]);
};
`;

function bitmap() {
  const width = 320, height = 192, bytes = Buffer.alloc(54 + width * height * 3);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  for (let index = 54; index < bytes.length; index += 3) { bytes[index] = 208; bytes[index + 1] = 128; bytes[index + 2] = 96; }
  return bytes;
}

async function until(read, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(25); }
  throw Error('Timed out: ' + description);
}

async function main() {
  assert.ok(process.argv.slice(2).every(arg => arg === '--full-components'), 'unknown argument');
  if (full) {
    assert.equal(process.platform, 'win32', 'Windows native components are required');
    assert.ok(path.isAbsolute(process.env.RUYI_MEDIA_LIFECYCLE_ROOT || ''), 'explicit qualification root is required');
    for (const key of ['RUYI_MEDIA_RUNTIME_ROOT', 'RUYI_MEDIA_SOURCES_ROOT']) assert.ok(path.isAbsolute(process.env[key] || ''), key);
    assert.ok(process.env.RUYI_MEDIA_OCR_LANGUAGE, 'explicit OCR language is required');
  }
  const installation = fs.realpathSync(process.env.RUYI_MEDIA_LIFECYCLE_ROOT || defaultRoot);
  const server = path.join(installation, 'app/server.js');
  assert.ok(fs.statSync(server).isFile());
  const serverHash = sha(fs.readFileSync(path.join(defaultRoot, 'app/server.js')));
  assert.equal(sha(fs.readFileSync(server)), serverHash, 'qualification server must equal the current generated workspace service');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-media-http-lifecycle-'));
  const data = path.join(root, 'data'), work = path.join(root, 'workspace'), events = [];
  let child, fake, closePromise, closed = false, exitSeen = false, spawned = false, failure;
  try {
    await fsp.mkdir(data); await fsp.mkdir(work);
    fake = await startFakeProvider({ handler: () => textFrames('Synthetic public image received.') });
    await fsp.writeFile(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14,
      privacyModeV1: 'enhanced', privacyRulesV1: [], privacyTechnicalV1: false, credentialEncryptionV1: true, workDataEncryptionV1: false,
      defaultWorkspace: work, workspaces: [{ path: work, read: true, write: true, execute: false }], permissionMode: 'bypass',
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false, importAgentInstructions: false,
      desktopMcp: { enabled: false, autodetect: false }, schedulerEnabledV1: false, stewardEnabledV1: false,
      activeProvider: 'fixture', providers: [{ id: 'fixture', type: 'openai-compat', baseUrl: fake.url, model: 'fixture', vision: true }] }));
    const preload = path.join(root, 'observe-http-close.cjs');
    await fsp.writeFile(preload, observer);
    const env = releaseEnvironment(path.join(root, 'home'), data);
    Object.assign(env, { RUYI_MEDIA_RESOURCE_PROFILE: 'legacy-full-4987-v1',
      RUYI_MEDIA_RUNTIME_ROOT: full ? process.env.RUYI_MEDIA_RUNTIME_ROOT : path.join(root, 'missing-runtime'),
      RUYI_MEDIA_SOURCES_ROOT: full ? process.env.RUYI_MEDIA_SOURCES_ROOT : path.join(root, 'missing-sources'),
      RUYI_MEDIA_OCR_LANGUAGE: full ? process.env.RUYI_MEDIA_OCR_LANGUAGE : 'en-US' });
    const port = await getFreePort();
    child = cp.fork(server, ['serve', '--port', String(port)], { execPath: process.execPath, execArgv: ['--require', preload],
      cwd: installation, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const log = fs.createWriteStream(path.join(root, 'server.log'));
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    closePromise = new Promise(resolve => child.once('close', code => { closed = true; log.end(); resolve(code); }));
    child.once('spawn', () => { spawned = true; }); child.once('exit', () => { exitSeen = true; });
    child.on('error', error => events.push({ fatal: String(error) }));
    child.on('message', event => { if (event?.fixture === 'media-http-close') events.push(event); });
    async function request(route, { method = 'GET', body, token, timeout = 70000 } = {}) {
      const response = await fetch('http://127.0.0.1:' + port + route, { method, headers: {
        ...(token ? { 'x-wcw-token': token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
      const bytes = Buffer.from(await response.arrayBuffer());
      let json; try { json = JSON.parse(bytes); } catch {}
      return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8'), json };
    }
    await until(async () => {
      if (closed) throw Error('server exited before health');
      try { return (await request('/health', { timeout: 500 })).status === 200; } catch { return false; }
    }, 'normal server health', 45000);
    const runtime = JSON.parse(await fsp.readFile(path.join(data, 'runtime.json'), 'utf8'));
    assert.equal(runtime.pid, child.pid); assert.equal(runtime.port, port);
    const boot = await request('/api/bootstrap', { method: 'POST', body: {} });
    const token = boot.json?.token; assert.ok(token);
    const api = (route, body, method = 'POST') => request(route, { method, body, token });
    const sessionResponse = await api('/api/sessions', { title: 'Public media lifecycle', cwd: work,
      engineRoute: { engine: 'openai', providerId: 'fixture', model: 'fixture' } });
    assert.equal(sessionResponse.status, 200);
    const sessionId = sessionResponse.json.session.id, original = bitmap();
    const upload = async label => {
      const result = await api('/api/upload', { name: label + '.bmp', data: original.toString('base64') });
      assert.equal(result.status, 200); assert.ok(result.json?.file); return result.json.file;
    };
    const prepare = file => api('/api/media/images/prepare', { sessionId, id: file.id, name: file.name });
    const previewPath = issued => '/api/media/images/' + issued.id + '/preview?sessionId=' + encodeURIComponent(sessionId);
    const preview = issued => request(previewPath(issued), { token });
    const prepared = async file => {
      const result = await prepare(file); assert.equal(result.status, 200, result.text);
      assert.ok(result.json?.manifest); return result.json;
    };
    const discard = issued => api('/api/media/images/' + issued.id, undefined, 'DELETE');
    const rejectReference = async (file, issued, expectedCodes) => {
      const result = await preview(issued);
      assert.equal(result.status, 409); assert.ok(expectedCodes.includes(result.json?.error?.code), result.text);
      const count = fake.requests.length;
      const send = await api('/api/chat/stream', { sessionId, cwd: work, message: 'Reject the stale public sample.',
        attachments: [{ ...file, protectedImage: { reference: issued.reference } }] });
      assert.match(send.text, /privacy\.image_/); assert.equal(fake.requests.length, count);
    };

    // A partial body cannot reach source acquisition. Wait for real server-side
    // request admission before closing the client, then observe the real close.
    const beforeCancel = events.length;
    const partial = http.request({ host: '127.0.0.1', port, path: '/api/media/images/prepare', method: 'POST',
      headers: { 'x-wcw-token': token, 'content-type': 'application/json', 'content-length': 1024, 'x-ruyi-fixture-request': 'cancel-prepare' } });
    partial.on('error', () => {});
    partial.on('response', response => response.resume());
    partial.write('{"sessionId":');
    const opened = await until(() => events.slice(beforeCancel).find(event => event.stage === 'request' && event.tag === 'cancel-prepare'), 'incomplete prepare reaches HTTP server');
    partial.destroy();
    const cancellation = await until(() => events.find(event => event.id === opened.id && event.stage === 'close'), 'incomplete prepare socket close');
    assert.equal(cancellation.requestAborted, true); assert.equal(cancellation.responseFinished, false);
    assert.equal(fake.requests.length, 0);
    assert.equal(fs.existsSync(path.join(data, 'media-derived-v1')), false);
    ok(true, 'client cancellation after real HTTP admission leaves no artifact or model POST before source acquisition');

    if (!full) {
      const file = await upload('missing');
      const refused = await prepare(file);
      const expected = process.platform === 'win32' ? 'privacy.image_processor_dependency_failed' : 'privacy.image_processor_platform_unsupported';
      assert.equal(refused.status, 409); assert.equal(refused.json?.error?.code, expected);
      assert.equal(fake.requests.length, 0); assert.equal(fs.existsSync(path.join(data, 'media-derived-v1')), false);
      const raw = await request('/api/upload/content?id=' + file.id + '&name=' + encodeURIComponent(file.name), { token });
      assert.ok(raw.bytes.equals(original));
      ok(true, 'missing native resources refuse preparation over HTTP and preserve the uploaded original');
      return;
    }

    const file = await upload('preview'), issued = await prepared(file), first = await preview(issued);
    assert.equal(first.status, 200); assert.equal(sha(first.bytes), issued.manifest.payloadHash);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const beforePreview = events.length;
    await new Promise((resolve, reject) => {
      const client = http.get({ host: '127.0.0.1', port, path: previewPath(issued), headers: { 'x-wcw-token': token, 'x-ruyi-fixture-request': 'disconnect-preview' } }, response => {
        try { assert.equal(response.statusCode, 200); response.destroy(); client.destroy(); resolve(); } catch (error) { reject(error); }
      });
      client.on('error', reject);
      client.setTimeout(15000, () => client.destroy(Error('preview header timeout')));
    });
    const closedPreview = await until(() => events.slice(beforePreview).find(event => event.stage === 'close' && event.tag === 'disconnect-preview'), 'preview HTTP close');
    // For a small PNG, the server may already have finished writing when client
    // headers arrive. This is a post-header disconnect test, not a mid-body claim.
    const repeated = await preview(issued); assert.equal(repeated.status, 200); assert.ok(repeated.bytes.equals(first.bytes));
    const beforeSend = fake.requests.length;
    await api('/api/chat/stream', { sessionId, cwd: work, message: 'Describe this protected public sample.',
      attachments: [{ ...file, protectedImage: { reference: issued.reference } }] });
    const sent = fake.requests.slice(beforeSend).flatMap(row => [...row.raw.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)]
      .map(match => Buffer.from(match[1], 'base64')));
    assert.equal(sent.length, 1); assert.ok(sent[0].equals(first.bytes));
    assert.equal((await discard(issued)).status, 200);
    ok(true, 'post-header preview disconnect preserves the same authenticated PNG for a later preview and actual model POST');
    console.log('Preview close observation: responseFinished=' + closedPreview.responseFinished);

    const sourceFile = await upload('source-change'), sourceIssued = await prepared(sourceFile);
    const physical = path.join(data, 'uploads', sourceFile.id, sourceFile.name);
    assert.equal(sha(await fsp.readFile(physical)), sha(original));
    const changed = Buffer.from(original); changed[54] ^= 1;
    await fsp.writeFile(physical, changed);
    await rejectReference(sourceFile, sourceIssued, ['privacy.image_source_changed']);
    assert.equal((await discard(sourceIssued)).status, 200);
    ok(true, 'a changed physical upload revokes the prior preview and native Send with zero additional model POSTs');

    const policyFile = await upload('policy-change'), policyIssued = await prepared(policyFile);
    const settings = await api('/api/privacy/settings', { mode: 'strict', technical: false, rules: [] });
    assert.equal(settings.status, 200); assert.equal(settings.json?.ok, true);
    await rejectReference(policyFile, policyIssued, ['privacy.image_expired', 'privacy.policy_changed', 'privacy.image_revoked']);
    ok(true, 'a real privacy-settings change revokes the previously issued HTTP preview and Send reference');

    const ttlFile = await upload('expiry'), ttlIssued = await prepared(ttlFile);
    const valid = await preview(ttlIssued); assert.equal(valid.status, 200);
    const remaining = ttlIssued.manifest.expiresAt - Date.now();
    // 墙钟上界豁免：核对服务器票据的固定产品期限，不是要求机器在限定时间内完成处理。
    assert.ok(Number.isFinite(remaining) && remaining > 0 && remaining <= 60000, 'ticket uses the real product TTL');
    await delay(remaining + 150);
    await rejectReference(ttlFile, ttlIssued, ['privacy.image_expired']);
    ok(true, 'after the actual manifest expiry the prior HTTP preview and Send refuse without a model POST');
    const reused = []; let reuseFailure;
    try {
      for (let index = 0; index < 4; index++) {
        const live = await prepared(ttlFile); reused.push(live);
        const read = await preview(live); assert.equal(read.status, 200); assert.equal(sha(read.bytes), live.manifest.payloadHash);
      }
      for (const live of reused) {
        const read = await preview(live);
        if (read.status === 409) {
          assert.equal(read.json?.error?.code, 'privacy.image_expired');
          assert.ok(Date.now() >= live.manifest.expiresAt, 'an earlier ticket can refuse only after its actual product expiry');
        } else {
          assert.equal(read.status, 200); assert.equal(sha(read.bytes), live.manifest.payloadHash);
        }
      }
      ok(true, 'expiry cleanup permits four successive native preparations with immediate authenticated previews and unchanged ticket deadlines');
    } catch (error) { reuseFailure = error; throw error; }
    finally {
      const cleanups = await Promise.allSettled(reused.map(discard));
      const errors = cleanups.filter(result => result.status === 'rejected').map(result => result.reason);
      for (const result of cleanups) if (result.status === 'fulfilled' && result.value.status !== 200) errors.push(Error(result.value.text));
      if (errors.length) throw new AggregateError([...(reuseFailure ? [reuseFailure] : []), ...errors], 'reused ticket cleanup failed', { cause: reuseFailure || errors[0] });
    }
    assert.equal(fake.errors.length, 0);
    assert.equal(sha(fs.readFileSync(server)), serverHash, 'qualification service bytes stay fixed throughout acceptance');
  } catch (error) { failure = error; throw error; }
  finally {
    const errors = [];
    try {
      if (child && !closed) {
        const cleanup = killOwnTree(child);
        if (cleanup.skipped && cleanup.skipped !== 'root-exited') throw Error('owned server cleanup refused: ' + cleanup.skipped);
      }
    } catch (error) { errors.push(error); }
    try {
      if (child) {
        let timer;
        try { await Promise.race([closePromise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('owned server close timeout')), 15000); })]); }
        finally { clearTimeout(timer); }
        assert.ok(spawned && exitSeen && closed, 'owned normal server has actual spawn, exit and close');
      }
    } catch (error) { errors.push(error); }
    try { await fake?.close(); } catch (error) { errors.push(error); }
    console.log('Synthetic media lifecycle evidence retained at ' + root + (failure ? ' (failure)' : ''));
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'media lifecycle cleanup failed', { cause: failure || errors[0] });
  }
}
main().catch(error => runner.fail(error.stack || String(error))).finally(() => runner.done());
