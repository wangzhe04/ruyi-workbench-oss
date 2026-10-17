'use strict';
// Harness-only interception. Production delivery retains fixed HTTPS hosts and has no endpoint override.
const https = require('node:https');
const http = require('node:http');
function install(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid fake official API port');
  const original = https.request;
  https.request = function fakeOfficialRequest(options, listener) {
    const allowed = options && options.protocol === 'https:' && options.port === 443
      && ((options.method === 'POST'
        && ((options.hostname === 'api.bot.qq.com' && (options.path === '/app/getAppAccessToken' || /^\/v2\/(users|groups)\/[^/?#]+\/messages$/.test(options.path)))
          || (options.hostname === 'open.feishu.cn' && (options.path === '/open-apis/auth/v3/tenant_access_token/internal' || /^\/open-apis\/im\/v1\/messages\/[^/?#]+\/reply$/.test(options.path)))))
        || (options.method === 'GET' && options.hostname === 'open.feishu.cn'
          && (options.path === '/open-apis/bot/v3/info' || options.path === '/open-apis/tenant/v2/tenant/query')));
    if (!allowed) throw new Error('unexpected outgoing request in offline fixture');
    return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port,
      headers: { ...options.headers, host: options.hostname } }, listener);
  };
  return () => { https.request = original; };
}
if (process.env.RUYI_FAKE_EXTERNAL_API_PORT) install(Number(process.env.RUYI_FAKE_EXTERNAL_API_PORT));
module.exports = { install };
