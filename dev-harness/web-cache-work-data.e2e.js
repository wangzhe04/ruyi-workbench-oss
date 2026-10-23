'use strict';
require('./lib/self-isolate-home');
// Actual guarded loopback fetch -> sealed cache -> continuation/offline fallback, with real DPAPI.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const t = createRunner('WEB CACHE WORK DATA');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-web-cache-data-e2e-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) delete process.env[key];
const api = require('./lib/server-internals').loadServerInternals([
  'webFetch', 'readWebCache', 'writeWebCache', 'webCachePath', 'readConfig', 'writeConfig', 'workDataKeys', 'paths',
]);
const setSwitch = async enabled => { const config = await api.readConfig(); config.workDataEncryptionV1 = enabled; await api.writeConfig(config); };
const isWorkError = error => String(error && error.code || '').startsWith('work_data');
let server;
(async () => {
  await setSwitch(false);
  const plain = { url: 'https://synthetic.invalid/legacy', text: 'synthetic legacy cache', ts: '2026-10-23T00:00:00Z' };
  await api.writeWebCache(plain);
  t.ok(fs.readFileSync(api.webCachePath(plain.url), 'utf8') === JSON.stringify(plain)
    && !fs.existsSync(path.join(api.paths.data, 'work-data-key-v1.json')), 'OFF keeps exact cache bytes and creates no key');
  if (process.platform !== 'win32') { console.log('SKIP encrypted cache requires real Windows DPAPI'); return; }
  await setSwitch(true); await api.workDataKeys.ensure();
  const content = 'Synthetic cached page 多语言😀\n'.repeat(50000);
  const pageChars = (content.indexOf('\n') + 1) * 20;
  let requests = 0;
  server = http.createServer((req, res) => {
    requests++;
    if (req.url.endsWith('/redirect')) { res.writeHead(302, { location: '/synthetic-secret-page' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(content) }); res.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/synthetic-secret-page';
  const first = await api.webFetch({ url, maxChars: pageChars });
  t.ok(first.ok && first.fromCache === false && first.text === content.slice(0, pageChars) && first.nextOffset === pageChars, 'real guarded fetch returns the first page of a large Unicode response');
  const target = api.webCachePath(url); let raw = fs.readFileSync(target, 'utf8');
  t.ok(JSON.parse(raw.split('\n')[0]).workData === 3 && !raw.includes(url) && !raw.includes('Synthetic cached page'), 'the complete fetched cache is encrypted and URL-bound');
  const next = await api.webFetch({ url, offset: first.nextOffset, maxChars: pageChars });
  t.ok(next.ok && next.fromCache === true && next.text === content.slice(pageChars, pageChars * 2) && requests === 1,
    'continuation decrypts the captured full text without another HTTP request');
  const redirected = await api.webFetch({ url: url + '/redirect', maxChars: pageChars });
  t.ok(redirected.ok && (await api.readWebCache(url)).url === url
    && (await api.readWebCache(url + '/redirect')).url === url + '/redirect', 'redirected fetch seals each alias under its own URL binding');
  raw = fs.readFileSync(target, 'utf8');
  const keyFile = path.join(api.paths.data, 'work-data-key-v1.json');
  api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.bak');
  try {
    await assert.rejects(() => api.readWebCache(url), isWorkError);
    const before = requests;
    await assert.rejects(() => api.webFetch({ url, offset: pageChars, maxChars: pageChars }), isWorkError);
    t.ok(requests === before && fs.readFileSync(target, 'utf8') === raw, 'missing keys refuse cached continuation before any refetch or overwrite');
    const freshUrl = url + '/fresh';
    const fresh = await api.webFetch({ url: freshUrl, maxChars: pageChars });
    t.ok(fresh.ok && fresh.fromCache === false && fresh.text === content.slice(0, pageChars)
      && !fs.existsSync(api.webCachePath(freshUrl)), 'a successful fresh fetch survives a cache-save failure without persisting plaintext');
  } finally { fs.renameSync(keyFile + '.bak', keyFile); api.workDataKeys.clear(); }
  await new Promise(resolve => server.close(resolve)); server = null;
  const offline = await api.webFetch({ url, maxChars: pageChars });
  t.ok(offline.ok && offline.fromCache === true && offline.text === content.slice(0, pageChars), 'after the source stops, ordinary offline fallback decrypts the same saved page');
  await setSwitch(false);
  t.ok((await api.readWebCache(url)).text === content, 'disabling the switch retains readable sealed cache data');
  await api.writeWebCache({ url, text: 'must not downgrade' });
  t.ok(fs.readFileSync(target, 'utf8') === raw, 'best-effort writes still refuse an implicit plaintext downgrade');
})().catch(error => t.fail(error && error.stack || String(error))).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  api.workDataKeys.clear();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('ruyi-web-cache-data-e2e-')) throw new Error('unexpected fixture path');
  fs.rmSync(resolved, { recursive: true, force: true });
  t.done();
});
