'use strict';
// Offline official-host HTTP fixtures. Does not load workbench data, use real credentials, or send real messages.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { install } = require('./lib/external-channel-delivery-preload');
const { createRunner } = require('./lib/harness');
const t = createRunner('EXTERNAL CHANNEL DELIVERY');
const { ok } = t;
const source = fs.readFileSync(path.join(__dirname, '../ruyi-workbench/app/src/13x-external-channel-delivery.js'), 'utf8');
const delivery = vm.runInNewContext(source + '\nExternalChannelDelivery', { require, Buffer, TextDecoder, setTimeout, clearTimeout, Date });
const qq = { platform: 'qq', appId: 'fixture-app', botSecret: 'synthetic-qq-secret' };
const feishu = { platform: 'feishu', appId: 'cli_fixture', tenantId: 'tenant-fixture', appSecret: 'synthetic-feishu-secret' };
const message = (platform = 'qq', group = false) => ({ messageId: 'original-message', senderId: 'human',
  tenantId: platform === 'qq' ? qq.appId : feishu.tenantId, conversationId: group ? 'original-group' : 'human', conversationType: group ? 'group' : 'direct' });
const opts = { attemptId: 'outbox-fixed-id', timeoutMs: 5000 };
let server, restore, mode = '', requests = [], onToken, onSend;
(async () => {
  server = http.createServer((req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks));
      requests.push({ host: req.headers.host, path: req.url, headers: req.headers, body });
      const token = req.url.includes('getAppAccessToken') || req.url.includes('tenant_access_token');
      const feishuAPI = req.headers.host === 'open.feishu.cn';
      if (token && onToken) { const hook = onToken; onToken = null; hook(); }
      if (!token && onSend) { const hook = onSend; onSend = null; hook(); }
      if ((mode === 'token-timeout' && token) || (mode === 'send-timeout' && !token)) return;
      if ((mode === 'token-reset' && token) || (mode === 'send-reset' && !token)) { res.destroy(); return; }
      if (mode === 'token-401' && token) { res.writeHead(401); res.end('{}'); return; }
      if (mode === 'token-bad' && token) { res.end('{}'); return; }
      if (!token && /^send-[0-9]+$/.test(mode)) { res.writeHead(Number(mode.slice(5)), { 'retry-after': '3' }); res.end('{}'); return; }
      if (!token && mode === 'send-redirect') { res.writeHead(302, { location: 'https://private.invalid/steal' }); res.end('{}'); return; }
      if (!token && mode === 'send-large') { res.end('x'.repeat(65537)); return; }
      if (!token && mode === 'send-malformed') { res.end('{bad'); return; }
      if (!token && mode === 'send-empty') { res.end('{}'); return; }
      if (!token && mode === 'send-rejected') { res.end(JSON.stringify({ code: 230002, msg: 'must-not-leak-secret' })); return; }
      if (!token && mode === 'send-illtyped-code') { res.end(JSON.stringify({ code: '0', id: 'apparently-sent' })); return; }
      const result = token ? (feishuAPI ? { code: 0, tenant_access_token: 'fake-feishu-token', expire: 7200 } : { access_token: 'fake-qq-token', expires_in: '7200' })
        : (feishuAPI ? { code: 0, data: { message_id: 'sent-feishu' } } : { id: 'sent-qq', timestamp: 'fixture' });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); restore = install(server.address().port);
  let result = await delivery.sendReply(qq, message(), 'hello', opts);
  ok(result.status === 'sent' && result.messageId === 'sent-qq' && result.errorCode === '', 'A1 only explicit QQ success is sent');
  ok(requests[0].host === 'api.bot.qq.com' && requests[0].path === '/app/getAppAccessToken'
    && requests[0].body.appId === qq.appId && requests[0].body.clientSecret === qq.botSecret, 'A2 QQ token fixed official host and credential fields');
  let sent = requests[1];
  ok(sent.path === '/v2/users/human/messages' && sent.body.msg_id === 'original-message' && sent.body.msg_seq === 1 && sent.body.msg_type === 0 && sent.headers.authorization === 'QQBot fake-qq-token', 'A3 QQ C2C passive reply uses original message identity and stable seq');
  result = await delivery.sendReply(qq, message('qq', true), 'group reply', opts);
  ok(result.status === 'sent' && requests.at(-1).path === '/v2/groups/original-group/messages', 'A4 QQ group reply stays in original group');
  result = await delivery.sendReply(feishu, message('feishu'), '你好😀', opts);
  sent = requests.at(-1);
  ok(result.status === 'sent' && result.messageId === 'sent-feishu' && requests.at(-2).body.app_secret === feishu.appSecret && requests.at(-2).host === 'open.feishu.cn', 'A5 Feishu internal tenant token uses appSecret');
  ok(sent.path === '/open-apis/im/v1/messages/original-message/reply' && sent.headers.authorization === 'Bearer fake-feishu-token'
    && sent.body.uuid === opts.attemptId && sent.body.msg_type === 'text' && JSON.parse(sent.body.content).text === '你好😀', 'A6 Feishu replies to original message with stable uuid');
  await delivery.sendReply(feishu, message('feishu', true), 'group reply', opts);
  ok(requests.at(-1).path === '/open-apis/im/v1/messages/original-message/reply', 'A7 Feishu group uses reply API, no arbitrary recipient send');
  const mutable = message('qq', true);
  onToken = () => { mutable.conversationId = 'foreign-group'; mutable.messageId = 'foreign-message'; };
  await delivery.sendReply(qq, mutable, 'snapshot', opts);
  ok(requests.at(-1).path === '/v2/groups/original-group/messages' && requests.at(-1).body.msg_id === 'original-message', 'A8 token await cannot retarget captured identity');
  result = await delivery.sendReply(feishu, message('feishu'), '😀'.repeat(2000), opts);
  const clipped = JSON.parse(requests.at(-1).body.content).text;
  ok(result.truncated === true && clipped.endsWith('完整答复请在如意查看或继续追问') && clipped.length <= 1800 && Buffer.byteLength(clipped) <= 6000
    && !clipped.includes('\ufffd') && Buffer.from(clipped).toString() === clipped, 'A9 long reply clearly marked and Unicode/UTF8 intact');
  const before = requests.length;
  for (const [connection, original, text, options] of [
    [{ ...qq, appId: '' }, message(), 'text', opts], [qq, { ...message(), tenantId: 'foreign' }, 'text', opts],
    [qq, { ...message(), conversationId: 'other-user' }, 'text', opts], [feishu, message('feishu'), 'text', { ...opts, attemptId: 'x'.repeat(51) }],
    [qq, message(), '\ud800', opts], [qq, message(), 'NUL\0', opts], [qq, message(), ' ', opts],
    [{ ...feishu, appSecret: undefined, encryptKey: 'not-app-secret' }, message('feishu'), 'text', opts],
  ]) { result = await delivery.sendReply(connection, original, text, options); ok(result.status === 'failed', 'B invalid input/config rejected before outbound'); }
  ok(requests.length === before, 'B9 invalid inputs make zero HTTP requests');
  for (const [fixture, expected] of [['token-401', 'failed'], ['token-reset', 'failed'], ['token-bad', 'failed'],
    ['send-400', 'failed'], ['send-401', 'failed'], ['send-429', 'failed'], ['send-500', 'unknown'], ['send-redirect', 'unknown'],
    ['send-reset', 'unknown'], ['send-large', 'unknown'], ['send-malformed', 'unknown'], ['send-empty', 'unknown'], ['send-rejected', 'failed']]) {
    mode = fixture; const count = requests.length;
    result = await delivery.sendReply(feishu, message('feishu'), 'once', opts);
    ok(result.status === expected && result.messageId === '' && result.errorCode.startsWith('external_delivery.') && !JSON.stringify(result).includes('must-not-leak'), 'C ' + fixture + ' classified ' + expected);
    ok(requests.length - count === (fixture.startsWith('token-') ? 1 : 2), 'C no automatic retry ' + fixture);
    if (fixture === 'send-429') ok(result.retryAfterMs === 3000, 'C429 bounded Retry-After surfaced without retry');
  }
  mode = 'send-timeout';
  result = await delivery.sendReply(qq, message(), 'timeout', opts);
  ok(result.status === 'unknown' && result.errorCode === 'external_delivery.timeout', 'D1 dispatched reply timeout remains unknown');
  mode = 'send-illtyped-code';
  result = await delivery.sendReply(qq, message(), 'bad response', opts);
  ok(result.status === 'unknown', 'D1b QQ ill-typed code cannot claim delivery despite a message id');
  mode = '';
  const controller = new AbortController(); controller.abort();
  let count = requests.length;
  result = await delivery.sendReply(qq, message(), 'abort before dispatch', { ...opts, signal: controller.signal });
  ok(result.status === 'failed' && requests.length === count, 'D2 pre-abort performs no request');
  const sendAbort = new AbortController(); onSend = () => sendAbort.abort(); count = requests.length;
  result = await delivery.sendReply(qq, message(), 'abort after dispatch', { ...opts, signal: sendAbort.signal });
  ok(result.status === 'unknown' && requests.length === count + 2, 'D3 in-flight abort never claims known failure or retries');
})().catch(error => t.fail(error.stack || String(error))).finally(async () => {
  if (restore) restore();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  t.done();
});
