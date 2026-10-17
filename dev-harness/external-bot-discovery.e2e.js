'use strict';
require('./lib/self-isolate-home');
// Owner-initiated Feishu identity discovery over production HTTP: fixed official host only, DPAPI vault,
// disabled inbox connection, read-only verification. Model and platform transport are synthetic.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { FAKE_BOT_ENV } = require('./lib/external-bot-fixtures');
const { CONFIG_SCHEMA } = require('../ruyi-workbench/app/server.js');
const t = createRunner('EXTERNAL BOT DISCOVERY'); const { ok } = t;
const WB = path.resolve(__dirname, '../ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SECRET = 'synthetic-feishu-app-secret-canary';
const APP_ID = 'cli_discovery';
(async () => {
  const isolated = fixtureChildEnv({ perTest: true }), home = isolated.home;
  let server, official, port, apiPort, token = '', connectionId = '', logs = '', requests = [];
  let tenantKey = 'tenant_discovered', rejectToken = false, botOpenId = 'ou_discovered_bot';
  const observed = [];
  const request = async (method, route, body, headers = {}, auth = true) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { 'x-wcw-token': token } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); observed.push(text);
    let json; try { json = JSON.parse(text); } catch { /* non-json */ }
    return { status: response.status, text, json };
  };
  const until = async (fn, label) => { for (let i = 0; i < 1200; i += 1) { const value = await fn(); if (value) return value; await sleep(25); } throw new Error('timeout: ' + label); };
  const errorCode = response => String(response.json?.error?.code || response.json?.code || '');
  const discover = (payload, options = {}) => request('POST', '/api/external-bots/discover', payload, options.headers || {}, options.auth !== false);
  const connections = async () => (await request('GET', '/api/external-bots/connections')).json.connections;
  const setupView = async id => (await request('GET', '/api/external-bots/setup?connectionId=' + encodeURIComponent(id))).json;
  const start = async () => {
    server = cp.spawn(process.execPath, ['--require', path.join(__dirname, 'lib/external-channel-delivery-preload.js'), 'app/server.js', 'serve', '--port', String(port)], {
      cwd: WB, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...isolated.env, ...FAKE_BOT_ENV, RUYI_FAKE_EXTERNAL_API_PORT: String(apiPort), RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home } });
    server.stdout.on('data', chunk => logs += chunk); server.stderr.on('data', chunk => logs += chunk);
    await until(async () => { try { return (await request('GET', '/health', undefined, {}, false)).status === 200; } catch { return false; } }, 'server');
    token = await until(() => { try { const runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')); return runtime.pid === server.pid && runtime.token; } catch { return false; } }, 'runtime token');
  };
  const stop = async () => { if (server) { const child = server; killOwnTree(child); await until(() => child.exitCode !== null || child.signalCode !== null, 'exit'); server = null; } };
  try {
    official = http.createServer(async (req, res) => {
      let raw = ''; for await (const part of req) raw += part;
      requests.push({ method: req.method, host: req.headers.host, path: req.url, authorization: req.headers.authorization || '', body: raw });
      res.setHeader('content-type', 'application/json');
      if (req.url.includes('tenant_access_token')) {
        if (rejectToken) { res.end(JSON.stringify({ code: 10014, msg: 'app secret invalid' })); return; }
        res.end(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 'fake-tenant-token', expire: 7200 })); return;
      }
      if (req.url === '/open-apis/bot/v3/info') { res.end(JSON.stringify({ code: 0, bot: { open_id: botOpenId, app_name: 'Discovered Bot', activate_status: 1 } })); return; }
      if (req.url === '/open-apis/tenant/v2/tenant/query') { res.end(JSON.stringify({ code: 0, tenant: { name: 'Discovered', tenant_key: tenantKey } })); return; }
      res.end('{}');
    });
    await new Promise(resolve => official.listen(0, '127.0.0.1', resolve)); apiPort = official.address().port;
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: CONFIG_SCHEMA, engineMode: 'interactive', stewardEnabledV1: false, schedulerEnabledV1: false,
      autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false }, providers: [] }));
    port = await getFreePort(); await start();

    // R1: authority gates
    ok((await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, create: false }, { auth: false })).status === 403, 'R1 discovery needs the local workbench token');
    ok((await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, create: false }, { headers: { origin: 'https://foreign.invalid' } })).status === 403, 'R2 a foreign origin is rejected even with a valid token');
    ok((await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, create: false, controlConfirmed: true })).status === 400, 'R3 discovery rejects unknown fields instead of accepting authority flags');
    ok((await discover({ op: 'activate', connectionId: 'bot_x' })).status === 400, 'R4 discovery has no activation path of its own');

    // R5: probe without create leaves no trace
    let response = await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, create: false });
    ok(response.status === 200 && response.json.ok === true && response.json.created === 'none'
      && response.json.discovery.tenantId === tenantKey && response.json.discovery.botUserId === botOpenId, 'R5 an owner probe returns the fixed-host tenant key and bot open_id');
    ok((await connections()).length === 0 && !fs.existsSync(path.join(home, 'external-bots', 'state-v1.json')) && !fs.existsSync(path.join(home, 'external-bot-credentials.json')),
      'R6 a probe alone creates neither a connection, a state file nor a credential ledger');
    ok(JSON.stringify(requests.slice(-3).map(row => [row.method, row.host, row.path])) === JSON.stringify([
      ['POST', 'open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal'],
      ['GET', 'open.feishu.cn', '/open-apis/bot/v3/info'],
      ['GET', 'open.feishu.cn', '/open-apis/tenant/v2/tenant/query'],
    ]), 'R7 only the three fixed official requests are made');

    // R8: create stores identity plus secret, but never enables control
    response = await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, label: '鍙戠幇杩炴帴', create: true });
    if (process.platform === 'win32') {
      connectionId = response.json.connectionId;
      ok(response.status === 200 && response.json.created === 'created' && /^bot_[a-f0-9]{32}$/.test(connectionId), 'R8 discovery prepares one generated connection id');
      const row = (await connections()).find(item => item.id === connectionId);
      ok(row && row.enabled === false && row.mode === 'inbox' && row.platform === 'feishu' && row.tenantId === tenantKey && row.botUserId === botOpenId
        && row.label === '鍙戠幇杩炴帴', 'R9 the prepared connection is disabled, inbox-only and carries the discovered identity');
      const view = await setupView(connectionId);
      ok(view.readiness.credentialSources.appSecret.ready === true && view.readiness.ingressReady === false
        && view.readiness.missing.includes('verificationToken') && view.readiness.missing.includes('encryptKey'), 'R10 only the app secret is stored; ingress and reply stay explicitly unready');
    } else {
      ok(response.status === 501 && String(response.json?.code || '').startsWith('external_credentials.'), 'R8 non-Windows refuses to persist a secret and does not fall back to plaintext');
      response = await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, create: false });
      ok(response.json.discovery.botUserId === botOpenId, 'R9 a non-Windows probe still reports the identity without storing it');
    }

    // R11: no secret in any observable surface
    const stateFile = path.join(home, 'external-bots', 'state-v1.json');
    const vaultFile = path.join(home, 'external-bot-credentials.json');
    const surfaces = [logs, ...observed, fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '', fs.existsSync(vaultFile) ? fs.readFileSync(vaultFile, 'utf8') : ''];
    ok(!surfaces.some(text => text.includes(SECRET)), 'R11 the app secret never reaches logs, responses, configuration or the saved ledger');
    ok(!logs.includes('fake-tenant-token'), 'R12 the platform access token is not logged either');

    if (process.platform === 'win32') {
      // R13: one connection per identity
      const again = await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, create: true });
      ok(again.status === 200 && again.json.created === 'reused' && again.json.connectionId === connectionId && (await connections()).length === 1,
        'R13 repeating the same discovery reuses the disabled connection instead of duplicating it');

      // R14: verify agrees, then disagrees when the platform tenant changes
      let verified = await discover({ op: 'verify', connectionId });
      ok(verified.status === 200 && verified.json.matches.tenantId === true && verified.json.matches.botUserId === true, 'R14 verification confirms the stored identity');
      const before = fs.readFileSync(stateFile, 'utf8');
      tenantKey = 'tenant_other';
      verified = await discover({ op: 'verify', connectionId });
      ok(verified.status === 200 && verified.json.matches.tenantId === false && verified.json.matches.botUserId === true, 'R15 a different platform tenant is reported as a mismatch');
      ok(fs.readFileSync(stateFile, 'utf8') === before && (await connections()).find(item => item.id === connectionId).tenantId === 'tenant_discovered',
        'R16 verification never rewrites the immutable connection identity');
      tenantKey = 'tenant_discovered';

      // R17: an enabled connection is left alone
      const row = (await connections()).find(item => item.id === connectionId);
      const { configured, callbackPath, controlRevision, ...fields } = row;
      await request('POST', '/api/external-bots/connections', { op: 'upsert', connection: { ...fields, enabled: true,
        allowedSenderIds: ['ou_person'], allowedConversationIds: ['oc_room'],
        verificationTokenEnv: 'RUYI_BOT_TEST_F_TOKEN', encryptKeyEnv: 'RUYI_BOT_TEST_F_KEY' } });
      const vaultBefore = fs.readFileSync(vaultFile, 'utf8');
      const existing = await discover({ op: 'probe', appId: APP_ID, appSecret: 'synthetic-replacement-secret', create: true });
      ok(existing.status === 200 && existing.json.created === 'existing' && existing.json.connectionId === connectionId
        && (await connections()).length === 1, 'R17 an enabled connection with this identity is reported and left untouched');
      ok(fs.readFileSync(vaultFile, 'utf8') === vaultBefore, 'R18 discovery never replaces credentials on an enabled connection');
      await request('POST', '/api/external-bots/connections', { op: 'disable', id: connectionId });

      // R19: verification needs a stored secret
      const manual = await request('POST', '/api/external-bots/connections', { op: 'upsert', connection: { id: 'bot_manual_feishu', platform: 'feishu',
        appId: 'cli_manual', tenantId: 'tenant_manual', botUserId: 'ou_manual', enabled: false, mode: 'inbox' } });
      ok(manual.status === 200, 'R19 a manual connection without credentials is accepted as disabled');
      const missing = await discover({ op: 'verify', connectionId: 'bot_manual_feishu' });
      ok(missing.status === 409 && errorCode(missing) === 'external_discovery.credentials_missing', 'R20 verification without a stored secret is an explicit refusal');
      ok((await discover({ op: 'verify', connectionId: 'bot_absent' })).status === 404, 'R21 verification of an unknown connection is a 404');
      await request('POST', '/api/external-bots/connections', { op: 'delete', id: 'bot_manual_feishu' });
    }

    // R22: platform rejection keeps its own code; the route allowlist does not collapse it
    rejectToken = true;
    response = await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, create: false });
    ok(response.status === 400 && errorCode(response) === 'external_discovery.credentials_rejected', 'R22 a rejected app secret is the platform fact, not a storage failure');
    rejectToken = false;

    // R23: bounded rate, no unbounded retries
    const codes = [];
    for (let i = 0; i < 16 && !codes.includes('external_discovery.rate_limited'); i += 1) {
      const attempt = await discover({ op: 'probe', appId: APP_ID, appSecret: SECRET, create: false });
      codes.push(attempt.status === 200 ? 'ok' : errorCode(attempt) || String(attempt.status));
    }
    ok(codes.includes('external_discovery.rate_limited'), 'R23 repeated probes are rate limited instead of probing the platform forever');

    // R24: discovery keeps the admin route shape (no query, no non-POST verb)
    const verb = await request('GET', '/api/external-bots/discover');
    ok([403, 405].includes(verb.status) && ['auth.denied', 'external_channel.request_invalid'].includes(errorCode(verb)), 'R24 discovery accepts only POST');
    const withQuery = await request('POST', '/api/external-bots/discover?probe=1', { op: 'probe', appId: APP_ID, appSecret: SECRET, create: false });
    ok(withQuery.status === 400 && errorCode(withQuery) === 'external_channel.request_invalid', 'R25 discovery rejects query parameters like the other setup endpoints');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    await stop();
    if (official) { official.closeAllConnections(); await new Promise(resolve => official.close(resolve)); }
    t.done({ exit: true });
  }
})();
