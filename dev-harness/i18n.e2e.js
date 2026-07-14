// i18n integration E2E: packaged static catalogs and persisted locale configuration over the real HTTP API.
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-i18n-e2e');
const PORT = 9134;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function request(method, pathname, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const requestHeaders = { ...headers };
    if (data !== null) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = Buffer.byteLength(data);
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: pathname, headers: requestHeaders, timeout: 3000 }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, raw }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (data !== null) req.write(data);
    req.end();
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await request('GET', '/health');
      if (response.status === 200) return;
    } catch { /* server still starting */ }
    await sleep(150);
  }
  throw new Error(`server did not become healthy on :${PORT}`);
}

function kill(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already stopped */ }
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const env = { ...process.env, RUYI_HOME: HOME };
  delete env.WIN_CLAUDE_WORKBENCH_HOME;
  const server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env, windowsHide: true });
  try {
    await waitForHealth();
    const catalog = await request('GET', '/locales/en-US.json');
    assert.strictEqual(catalog.status, 200);
    assert.match(String(catalog.headers['content-type']), /^application\/json/);
    assert.strictEqual(JSON.parse(catalog.raw)['common.save'], 'Save');

    const runtime = await request('GET', '/js/i18n.js');
    assert.strictEqual(runtime.status, 200);
    assert.match(String(runtime.headers['content-type']), /^application\/javascript/);
    assert.match(runtime.raw, /export function t\(/);

    const initial = await request('GET', '/api/status');
    assert.strictEqual(initial.status, 200);
    assert.strictEqual(JSON.parse(initial.raw).config.locale, 'auto');

    const shell = await request('GET', '/');
    const token = shell.raw.match(/name="wcw-token"\s+content="([a-f0-9]+)"/)?.[1];
    assert.ok(token, 'could not obtain UI token');

    const missingToken = await request('POST', '/api/config', {}, { locale: 'en-US' });
    assert.strictEqual(missingToken.status, 403);
    assert.strictEqual(JSON.parse(missingToken.raw).error.code, 'auth.token_invalid');

    const missingPreviewPath = await request('GET', '/api/file/preview', { 'x-wcw-token': token });
    assert.strictEqual(missingPreviewPath.status, 400);
    assert.strictEqual(JSON.parse(missingPreviewPath.raw).error.code, 'file.path_required');

    const missingCheckpoint = await request('GET', '/api/checkpoints/diff', { 'x-wcw-token': token });
    assert.strictEqual(missingCheckpoint.status, 400);
    assert.strictEqual(JSON.parse(missingCheckpoint.raw).error.code, 'session.id_invalid');

    const missingSession = await request('GET', '/api/agent-runs', { 'x-wcw-token': token });
    assert.strictEqual(missingSession.status, 400);
    assert.strictEqual(JSON.parse(missingSession.raw).error.code, 'session.id_required');

    const legacyRoute = await request('GET', '/api/agent-runs/any/events', { 'x-wcw-token': token });
    assert.strictEqual(legacyRoute.status, 400);
    const legacyBody = JSON.parse(legacyRoute.raw);
    assert.strictEqual(legacyBody.error.code, 'api.request_failed');
    assert.strictEqual(typeof legacyBody.error.message, 'string');

    const saveEnglish = await request('POST', '/api/config', { 'x-wcw-token': token }, { locale: 'en-US' });
    assert.strictEqual(saveEnglish.status, 200);
    assert.strictEqual(JSON.parse(saveEnglish.raw).config.locale, 'en-US');
    const persisted = await request('GET', '/api/status');
    assert.strictEqual(JSON.parse(persisted.raw).config.locale, 'en-US');

    const invalid = await request('POST', '/api/config', { 'x-wcw-token': token }, { locale: 'fr-FR' });
    assert.strictEqual(invalid.status, 200);
    assert.strictEqual(JSON.parse(invalid.raw).config.locale, 'auto');
    console.log('I18N E2E: ALL PASS');
  } finally {
    kill(server);
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
})().catch(error => {
  console.error('I18N E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
