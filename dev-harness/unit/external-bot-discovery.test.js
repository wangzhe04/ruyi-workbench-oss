'use strict';
// Offline fixed-official-host fixtures for the identity probe. Never contacts a platform or uses real credentials.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { install } = require('../lib/external-channel-delivery-preload');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src/13z-external-bot-discovery.js'), 'utf8');
const discovery = vm.runInNewContext(SOURCE + '\nExternalBotDiscovery', { require, Buffer, TextDecoder, setTimeout, clearTimeout, Date });
const SECRET = 'synthetic-feishu-app-secret-canary';
const APP_ID = 'cli_fixture';
let server, restore, mode = 'ok', requests = [];

const token = () => ({ code: 0, msg: 'ok', tenant_access_token: 'fake-tenant-token', expire: 7200 });
const bot = () => ({ code: 0, msg: 'ok', bot: { open_id: 'ou_fixture_bot', app_name: 'Fixture Bot', activate_status: 2, ip_white_list: [] } });
const tenant = () => ({ code: 0, msg: 'ok', tenant: { name: 'Fixture', display_id: 'fixture', tenant_key: 'tenant_fixture' } });

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { body = null; }
      requests.push({ method: req.method, host: req.headers.host, path: req.url, authorization: req.headers.authorization || '', body });
      const respond = payload => { res.setHeader('content-type', 'application/json'); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
      const phase = req.url.includes('tenant_access_token') ? 'token' : req.url === '/open-apis/bot/v3/info' ? 'bot' : 'tenant';
      if (mode === 'timeout') return;
      if (mode === phase + '-500') { res.writeHead(500); res.end('{}'); return; }
      if (mode === phase + '-401') { res.writeHead(401); res.end('{}'); return; }
      if (mode === phase + '-429') { res.writeHead(429, { 'retry-after': '3' }); res.end('{}'); return; }
      if (mode === phase + '-malformed') { res.end('{not json'); return; }
      if (mode === phase + '-huge') { res.end('x'.repeat(65537)); return; }
      if (mode === phase + '-rejected') { respond({ code: 10014, msg: 'app secret invalid must-not-leak ' + SECRET }); return; }
      if (mode === phase + '-illtyped') { respond({ code: '0', bot: { open_id: 'ou_illtyped' }, tenant: { tenant_key: 'tenant_illtyped' } }); return; }
      if (mode === 'bot-no-openid' && phase === 'bot') { respond({ code: 0, bot: { app_name: 'No Identity' } }); return; }
      if (mode === 'tenant-no-key' && phase === 'tenant') { respond({ code: 0, tenant: { name: 'No Key' } }); return; }
      if (mode === 'tenant-code' && phase === 'tenant') { respond({ code: 40003, msg: 'permission denied' }); return; }
      respond(phase === 'token' ? token() : phase === 'bot' ? bot() : tenant());
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  restore = install(server.address().port);
});
after(async () => {
  if (restore) restore();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function reset(next = 'ok') {
  mode = next;
  requests = [];
}

test('D1 probe reads the fixed official tenant token, bot info and tenant key', async () => {
  reset();
  const result = await discovery.probe({ appId: APP_ID, appSecret: SECRET });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.identity)), { tenantId: 'tenant_fixture', botUserId: 'ou_fixture_bot', appName: 'Fixture Bot', activateStatus: 2 });
  assert.deepEqual(requests.map(row => [row.method, row.host, row.path]), [
    ['POST', 'open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal'],
    ['GET', 'open.feishu.cn', '/open-apis/bot/v3/info'],
    ['GET', 'open.feishu.cn', '/open-apis/tenant/v2/tenant/query'],
  ]);
  assert.deepEqual(requests[0].body, { app_id: APP_ID, app_secret: SECRET });
  assert.equal(requests[1].authorization, 'Bearer fake-tenant-token');
  assert.equal(requests[2].authorization, 'Bearer fake-tenant-token');
  assert.ok(!JSON.stringify(result).includes(SECRET), 'D1 the secret never returns as data');
});

test('D2 rejected app credentials stop after the token call and leak nothing', async () => {
  reset('token-rejected');
  const result = await discovery.probe({ appId: APP_ID, appSecret: SECRET });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, errorCode: 'external_discovery.credentials_rejected' });
  assert.equal(requests.length, 1);
  assert.ok(!JSON.stringify(result).includes('must-not-leak'));
});

test('D3 a 401 or 429 token is an explicit stable failure', async () => {
  reset('token-401');
  assert.equal((await discovery.probe({ appId: APP_ID, appSecret: SECRET })).errorCode, 'external_discovery.credentials_rejected');
  reset('token-429');
  assert.equal((await discovery.probe({ appId: APP_ID, appSecret: SECRET })).errorCode, 'external_discovery.rate_limited');
});

test('D4 bot and tenant phase failures keep their own codes', async () => {
  reset('bot-500');
  assert.equal((await discovery.probe({ appId: APP_ID, appSecret: SECRET })).errorCode, 'external_discovery.bot_unavailable');
  reset('tenant-500');
  assert.equal((await discovery.probe({ appId: APP_ID, appSecret: SECRET })).errorCode, 'external_discovery.tenant_unavailable');
  reset('tenant-code');
  assert.equal((await discovery.probe({ appId: APP_ID, appSecret: SECRET })).errorCode, 'external_discovery.tenant_unavailable');
});

test('D5 malformed, oversized and ill-typed responses never become an identity', async () => {
  for (const scenario of ['token-malformed', 'bot-malformed', 'tenant-malformed', 'token-huge', 'bot-huge', 'token-illtyped', 'bot-illtyped']) {
    reset(scenario);
    const result = await discovery.probe({ appId: APP_ID, appSecret: SECRET });
    assert.equal(result.ok, false, scenario);
    assert.equal(result.errorCode, 'external_discovery.response_invalid', scenario);
    assert.ok(!JSON.stringify(result).includes('illtyped'), scenario);
  }
});

test('D6 missing bot open_id or tenant key fails closed before any state exists', async () => {
  reset('bot-no-openid');
  assert.equal((await discovery.probe({ appId: APP_ID, appSecret: SECRET })).errorCode, 'external_discovery.identity_missing');
  assert.equal(requests.length, 2, 'D6 no tenant query after a bot identity is missing');
  reset('tenant-no-key');
  assert.equal((await discovery.probe({ appId: APP_ID, appSecret: SECRET })).errorCode, 'external_discovery.identity_missing');
});

test('D7 a silent endpoint times out within its own budget', async () => {
  reset('timeout');
  const started = Date.now();
  const result = await discovery.probe({ appId: APP_ID, appSecret: SECRET, timeoutMs: 2000 });
  assert.equal(result.errorCode, 'external_discovery.timeout');
  assert.ok(Date.now() - started < 4000, 'D7 timeout is bounded');
});

test('D8 invalid input is refused before any outbound request', async () => {
  reset();
  const cases = [
    { appId: '', appSecret: SECRET },
    { appId: 'has space', appSecret: SECRET },
    { appId: APP_ID, appSecret: '' },
    { appId: APP_ID, appSecret: 'line\nbreak' },
    { appId: APP_ID, appSecret: 'x'.repeat(5000) },
    { appId: APP_ID, appSecret: SECRET, extra: true },
    { appId: APP_ID, appSecret: SECRET, timeoutMs: 10 },
  ];
  for (const input of cases) assert.equal((await discovery.probe(input)).errorCode, 'external_discovery.invalid_input', JSON.stringify(input).slice(0, 40));
  assert.equal(requests.length, 0, 'D8 no request for rejected input');
});
