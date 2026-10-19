'use strict';
require('./lib/self-isolate-home');
// Actual isolated production HTTP routes and disk, synthetic QQ Ed25519 and Feishu AES-CBC callbacks.
// No real account, platform endpoint or model. The preload only injects disk failures/delays.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { createRunner } = require('./lib/harness');
const { FAKE_BOT_ENV, feishuConnection, qqConnection, feishuEvent, feishuWire, qqEvent, qqWire } = require('./lib/external-bot-fixtures');
const { CONFIG_SCHEMA: CURRENT_CONFIG_SCHEMA } = require('../ruyi-workbench/app/server.js');
const runner = createRunner('EXTERNAL BOTS'); const { ok } = runner;
const WB = path.resolve(__dirname, '../ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const isolated = fixtureChildEnv({ perTest: true }); const home = isolated.home;
  const dir = path.join(home, 'external-bots'), stateFile = path.join(dir, 'state-v1.json');
  const failFlag = path.join(home, 'fail-inbox-write'), holdFlag = path.join(home, 'hold-inbox-write'), heldFlag = path.join(home, 'inbox-write-held');
  const preload = path.join(home, 'inbox-faults.cjs');
  fs.writeFileSync(preload, `const fs=require('fs'),p=fs.promises,rename=p.rename; p.rename=async function(from,to){if(String(to).replaceAll('\\\\','/').endsWith('/external-bots/state-v1.json')){if(fs.existsSync(${JSON.stringify(failFlag)}))throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});if(fs.existsSync(${JSON.stringify(holdFlag)})){fs.writeFileSync(${JSON.stringify(heldFlag)},'held');while(fs.existsSync(${JSON.stringify(holdFlag)}))await new Promise(r=>setTimeout(r,10));}}return rename.call(this,from,to);};`);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: CURRENT_CONFIG_SCHEMA, stewardEnabledV1: false, schedulerEnabledV1: false,
    autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [] }));
  let server, token = '', port;
  const raw = async (method, route, bytes, headers = {}, admin = false) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { ...(admin ? { 'x-wcw-token': token } : {}), ...headers },
      ...(bytes === undefined ? {} : { body: bytes }), signal: AbortSignal.timeout(15000) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text };
  };
  const admin = (method, route, body) => raw(method, route, body === undefined ? undefined : JSON.stringify(body), { 'content-type': 'application/json' }, true);
  const until = async fn => { for (let i = 0; i < 200; i++) { const result = await fn(); if (result) return result; await sleep(30); } throw new Error('fixture timeout'); };
  const start = async () => {
    server = cp.spawn(process.execPath, ['--require', preload, 'app/server.js', 'serve', '--port', String(port)], {
      cwd: WB, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...isolated.env, ...FAKE_BOT_ENV, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home },
    });
    await until(async () => { try { return (await raw('GET', '/health')).status === 200; } catch { return false; } });
    token = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token; } catch { return false; } });
  };
  const stop = async () => { if (!server) return; const child = server; killOwnTree(child); await until(() => child.exitCode !== null || child.signalCode !== null); server = null; };
  const callback = (platform, wire, suffix = '') => raw('POST', '/api/external-bots/callback/' + platform + '?connectionId=' + platform + '_test' + suffix, wire.bytes, wire.headers);
  const upsert = connection => admin('POST', '/api/external-bots/connections', { op: 'upsert', connection });
  const inbox = async () => (await admin('GET', '/api/external-bots/inbox')).json;
  const slow = (route, wire) => {
    let complete; const promise = new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { ...wire.headers, 'content-length': wire.bytes.length } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      }); req.on('error', reject); req.write(wire.bytes.subarray(0, 1)); complete = () => req.end(wire.bytes.subarray(1));
    }); return { promise, complete };
  };
  try {
    port = await getFreePort(); await start();
    const defaults = await admin('GET', '/api/external-bots/connections');
    ok(defaults.status === 200 && defaults.json.connections.length === 0 && !fs.existsSync(dir), 'B0 default disabled reads create no external-bot files');
    ok((await callback('qq', qqWire(qqEvent()))).status === 404 && !fs.existsSync(dir), 'B1 unknown callback does not mkdir or write state');
    for (const route of ['/api/external-bots/connections', '/api/external-bots/inbox']) ok((await raw('GET', route)).status === 403, 'B2 management read requires local workbench token ' + route);
    for (const route of ['/api/external-bots/callback/qq/', '/api/external-bots/callback/qq/extra', '/api/external-bots/callback/other']) ok((await raw('POST', route, '{}')).status === 403, 'B3 callback exception is exact ' + route);
    ok((await raw('GET', '/api/external-bots/callback/qq?connectionId=qq_test')).status === 403, 'B4 callback exception is POST only');
    ok((await upsert({ ...qqConnection(), enabled: undefined })).json.connections[0].enabled === false, 'B5 newly configured connection defaults to disabled');
    ok((await callback('qq', qqWire(qqEvent()))).status === 404, 'B6 disabled connection cannot admit even a correctly signed message');
    ok((await upsert(qqConnection())).status === 200 && (await upsert(feishuConnection())).status === 200, 'B7 enable complete scoped synthetic connections');
    const publicConfig = await admin('GET', '/api/external-bots/connections');
    ok(publicConfig.json.connections.every(c => c.configured) && Object.values(FAKE_BOT_ENV).every(value => !publicConfig.text.includes(value) && !fs.readFileSync(stateFile, 'utf8').includes(value)), 'B8 credentials never appear in public configuration or durable state');
    ok((await upsert({ ...qqConnection(), botSecretEnv: 'PATH' })).status === 400 && (await upsert({ ...qqConnection(), botSecret: 'plaintext' })).status === 400, 'B9 unrelated env lookups and plaintext credential fields are rejected');
    for (const suffix of ['&connectionId=qq_test', '&extra=1']) ok((await callback('qq', qqWire(qqEvent()), suffix)).status === 404, 'B10 query accepts one connectionId and nothing else ' + suffix);
    const qChallenge = qqWire({ op: 13, d: { plain_token: 'synthetic-challenge', event_ts: String(Math.floor(Date.now() / 1000)) } }, { signed: false });
    const qProof = await callback('qq', qChallenge);
    const seed = Buffer.from(FAKE_BOT_ENV.RUYI_BOT_TEST_Q_SECRET.repeat(32)).subarray(0, 32);
    const key = crypto.createPrivateKey({ format: 'der', type: 'pkcs8', key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), seed]) });
    ok(qProof.status === 200 && crypto.verify(null, Buffer.from(JSON.parse(qChallenge.bytes).d.event_ts + 'synthetic-challenge'), crypto.createPublicKey(key), Buffer.from(qProof.json.signature, 'hex')), 'B11 QQ bootstrap proof verifies independently and admits no message');
    const fProof = await callback('feishu', feishuWire({ type: 'url_verification', token: FAKE_BOT_ENV.RUYI_BOT_TEST_F_TOKEN, challenge: 'feishu-synthetic' }, { signed: false }));
    ok(fProof.status === 200 && fProof.json.challenge === 'feishu-synthetic' && (await inbox()).items.length === 0, 'B12 encrypted Feishu bootstrap returns only verified challenge');
    const unsigned = qqWire(qqEvent(), { signed: false });
    ok((await callback('qq', unsigned)).status === 401 && (await raw('POST', '/api/external-bots/callback/qq?connectionId=qq_test', unsigned.bytes, unsigned.headers, true)).status === 401, 'B13 workbench token never replaces required platform event signature');
    const forged = qqWire(qqEvent()); forged.headers['x-signature-ed25519'] = '00'.repeat(64);
    ok((await callback('qq', forged)).status === 401 && (await callback('qq', qqWire(qqEvent(), { timestamp: String(Math.floor(Date.now()/1000)-301) }))).status === 401, 'B14 invalid signature and stale timestamp cannot enter inbox');
    for (const patch of [{ senderId: 'foreign' }, { conversationId: 'foreign' }]) ok((await callback('qq', qqWire(qqEvent(patch)))).status === 403, 'B15 both sender and conversation allowlists are required ' + JSON.stringify(patch));
    ok((await callback('qq', qqWire(qqEvent()))).status === 200 && (await callback('feishu', feishuWire(feishuEvent({ group: true })))).status === 200, 'B16 independent signed QQ and encrypted Feishu group events persist through production HTTP');
    ok((await callback('feishu', feishuWire(feishuEvent({ messageId: 'not_mentioned', group: true, mention: false })))).status === 200 && (await inbox()).items.length === 2, 'B17 group messages without an exact mention are ignored');
    ok((await callback('qq', qqWire(qqEvent({ eventId: 'different_delivery' })))).status === 200 && (await inbox()).items.length === 2, 'B18 message id dedupe survives different event delivery ids');
    ok((await callback('qq', qqWire(qqEvent({ text: 'conflicting payload' })))).status === 409, 'B19 same message identity with different content is a conflict');
    const beforeRestart = await inbox(); const first = beforeRestart.items[0];
    ok((await admin('POST', '/api/external-bots/inbox/read', { id: first.id })).json.item.readAt && (await inbox()).items.length === 2, 'B20 read acknowledgement preserves message and permanent dedupe record');
    const page = (await admin('GET', '/api/external-bots/inbox?limit=1')).json;
    ok(page.items.length === 1 && page.nextBefore && (await admin('GET', '/api/external-bots/inbox?limit=1&before=' + page.nextBefore)).json.items[0].id !== page.items[0].id, 'B21 local inbox pagination uses stable item identity');
    await stop(); await start();
    ok((await callback('qq', qqWire(qqEvent({ eventId: 'post_restart' })))).status === 200 && (await inbox()).items.length === 2, 'B22 durable message dedupe survives actual process restart');
    fs.writeFileSync(failFlag, 'fail');
    ok((await callback('qq', qqWire(qqEvent({ messageId: 'write_failure' })))).status === 503 && (await inbox()).items.length === 2, 'B23 disk failure is not acknowledged or cached as a received message');
    fs.unlinkSync(failFlag);
    ok((await callback('qq', qqWire(qqEvent({ messageId: 'write_failure', eventId: 'retry' })))).status === 200 && (await inbox()).items.length === 3, 'B24 provider retry can commit after storage recovers');
    fs.writeFileSync(holdFlag, 'hold'); let settled = false;
    const held = callback('qq', qqWire(qqEvent({ messageId: 'held_write' }))).then(value => { settled = true; return value; });
    await until(() => fs.existsSync(heldFlag));
    ok(!settled && JSON.parse(fs.readFileSync(stateFile, 'utf8')).items.length === 3, 'B25 callback ACK waits for the actual atomic rename');
    const disable = admin('POST', '/api/external-bots/connections', { op: 'disable', id: 'qq_test' });
    fs.unlinkSync(holdFlag); await held; await disable;
    ok((await callback('qq', qqWire(qqEvent({ messageId: 'after_disable' })))).status === 404 && (await inbox()).items.length === 4, 'B26 disable shares the same transaction boundary with an admitted message');
    await upsert(qqConnection());
    const delayed = slow('/api/external-bots/callback/qq?connectionId=qq_test', qqWire(qqEvent({ messageId: 'old_configuration' })));
    await sleep(50); await admin('POST', '/api/external-bots/connections', { op: 'disable', id: 'qq_test' }); delayed.complete();
    ok((await delayed.promise).status === 404 && (await inbox()).items.length === 4, 'B27 a body arriving after disable cannot use an earlier configuration');
    await upsert(qqConnection());
    ok((await upsert({ ...qqConnection(), appId: 'new_app' })).status === 409, 'B28 application identity is immutable within a connection id');
    await admin('POST', '/api/external-bots/connections', { op: 'delete', id: 'qq_test' });
    ok((await upsert(qqConnection())).status === 409 && (await inbox()).items.length === 4, 'B29 deleted connection id is permanently retired without erasing receipts');
    const saved = fs.readFileSync(stateFile); fs.writeFileSync(stateFile, '{"connections":[],"items":[]}');
    ok((await admin('GET', '/api/external-bots/inbox')).status === 503 && (await callback('feishu', feishuWire(feishuEvent({ messageId: 'corrupt_state' })))).status === 503, 'B30 schema-less ledger fails closed for reads and ingestion');
    fs.writeFileSync(stateFile, saved);
    const bad = JSON.parse(saved); bad.items[0].text += 'changed'; fs.writeFileSync(stateFile, JSON.stringify(bad));
    ok((await admin('GET', '/api/external-bots/inbox')).status === 503, 'B31 per-row integrity hash is recomputed, not trusted from parseable state'); fs.writeFileSync(stateFile, saved);
    ok((await raw('POST', '/api/external-bots/callback/feishu?connectionId=feishu_test', Buffer.from([0xff]), { 'content-type':'application/json' })).status === 400
      && (await raw('POST', '/api/external-bots/callback/feishu?connectionId=feishu_test', '[]')).status === 400, 'B32 malformed UTF8 and array roots are not protocol messages');
    // Declare the oversized body but send only its first byte: rejection must precede buffering it.
    const oversized = slow('/api/external-bots/callback/feishu?connectionId=feishu_test', { bytes: Buffer.alloc(65537), headers: {} });
    ok((await oversized.promise).status === 413, 'B33 oversized Content-Length receives 413 before the body is buffered');
    ok((await callback('feishu', feishuWire(feishuEvent({ messageId: 'oversized_text', text: 'x'.repeat(8193) })))).status === 400, 'B34 valid signatures cannot bypass bounded text schema');
    const pendingReads = Array.from({ length: 8 }, () => slow('/api/external-bots/callback/feishu?connectionId=feishu_test', feishuWire(feishuEvent())));
    await sleep(100);
    ok((await callback('feishu', feishuWire(feishuEvent()))).status === 429, 'B35 slow callbacks cannot consume more than the bounded ingress slots');
    const timed = await Promise.all(pendingReads.map(request => request.promise));
    ok(timed.every(response => response.status === 408) && (await callback('feishu', feishuWire(feishuEvent({ messageId: 'after_read_timeout' })))).status === 200, 'B36 body read deadlines close slow requests and release ingress slots');
    ok(!fs.existsSync(path.join(home, 'sessions', 'steward.json')) && !fs.existsSync(path.join(home, 'steward', 'inbox-v1.ndjson')),
      'B37 messages containing command-like URLs never enter steward conversation or automatic inbox');
  } catch (error) { runner.fail(error.stack || String(error)); }
  finally { if (fs.existsSync(holdFlag)) fs.unlinkSync(holdFlag); await stop(); runner.done({ exit: true }); }
})();
