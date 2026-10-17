// Owner-initiated identity probe against the fixed official Feishu host. One attempt per request, no
// redirect/proxy/base-URL override, and the app secret is used once and never returned as data.
const ExternalBotDiscovery = (() => {
  const transport = require('node:https');
  const HOST = 'open.feishu.cn';
  // Independent budget: one 8 s call, 15 s for the whole three-call probe, 64 KiB per response body.
  const LIMIT = Object.freeze({ responseBytes: 65536, secretBytes: 4096, requestMs: 8000, totalMs: 15000 });
  const identity = value => typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const failure = suffix => ({ ok: false, errorCode: 'external_discovery.' + suffix });
  // Exactly one request. Bodies, headers and tokens never reach logs; only a stable code escapes.
  function request(pathname, method, body, authorization, timeoutMs) {
    return new Promise(resolve => {
      let done = false, requestStream, incoming;
      const finish = result => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => { finish({ failure: 'timeout' }); if (requestStream) requestStream.destroy(); if (incoming) incoming.destroy(); }, timeoutMs);
      timer.unref();
      const headers = {};
      let bytes = null;
      if (body !== null) { bytes = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json; charset=utf-8'; headers['content-length'] = String(bytes.length); }
      if (authorization) headers.authorization = authorization;
      try {
        requestStream = transport.request({ protocol: 'https:', hostname: HOST, port: 443, path: pathname, method,
          headers, agent: false, rejectUnauthorized: true, maxHeaderSize: 8192 }, response => {
          if (done) { response.destroy(); return; }
          incoming = response;
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > LIMIT.responseBytes) { finish({ failure: 'too_large' }); response.destroy(); return; }
            chunks.push(chunk);
          });
          response.on('end', () => {
            let payload;
            // Fatal UTF-8: a body we cannot decode exactly is not an identity we may adopt.
            try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { /* unparsable */ }
            finish({ statusCode: response.statusCode, payload });
          });
          response.on('error', () => finish({ failure: 'network' }));
          response.on('aborted', () => finish({ failure: 'network' }));
        });
        requestStream.on('error', () => finish({ failure: 'network' }));
        requestStream.end(bytes || undefined);
      } catch { finish({ failure: 'network' }); if (requestStream) requestStream.destroy(); }
    });
  }
  function classify(result, phase) {
    const phased = { token: 'credentials_rejected', bot: 'bot_unavailable', tenant: 'tenant_unavailable' }[phase];
    if (result.failure) return failure(result.failure === 'too_large' ? 'response_invalid' : result.failure);
    if (result.statusCode === 429) return failure('rate_limited');
    if (result.statusCode >= 400 && result.statusCode < 500) return failure(phased);
    if (!(result.statusCode >= 200 && result.statusCode < 300)) return failure(phase === 'token' ? 'unavailable' : phased);
    if (!object(result.payload)) return failure('response_invalid');
    // A missing or ill-typed platform code is not an explicit rejection; both refuse to continue.
    if (result.payload.code !== 0) return failure(Number.isInteger(result.payload.code) ? phased : 'response_invalid');
    return null;
  }
  async function probe(input) {
    if (!object(input) || Object.keys(input).some(key => !['appId', 'appSecret', 'timeoutMs'].includes(key))) return failure('invalid_input');
    const appId = input.appId, appSecret = input.appSecret;
    if (!identity(appId) || typeof appSecret !== 'string' || !appSecret.length || Buffer.byteLength(appSecret) > LIMIT.secretBytes
      || /[\x00-\x1f\x7f]/.test(appSecret) || Buffer.from(appSecret).toString('utf8') !== appSecret) return failure('invalid_input');
    const timeoutMs = input.timeoutMs === undefined ? LIMIT.requestMs : input.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 2000 || timeoutMs > 60000) return failure('invalid_input');
    const deadline = Date.now() + LIMIT.totalMs;
    const budget = () => Math.max(1000, Math.min(timeoutMs, deadline - Date.now()));
    const tokenResult = await request('/open-apis/auth/v3/tenant_access_token/internal', 'POST', { app_id: appId, app_secret: appSecret }, '', budget());
    const tokenFailure = classify(tokenResult, 'token');
    if (tokenFailure) return tokenFailure;
    const token = tokenResult.payload.tenant_access_token;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) return failure('response_invalid');
    const botResult = await request('/open-apis/bot/v3/info', 'GET', null, 'Bearer ' + token, budget());
    const botFailure = classify(botResult, 'bot');
    if (botFailure) return botFailure;
    const bot = botResult.payload.bot;
    if (!object(bot) || !identity(bot.open_id)) return failure('identity_missing');
    const tenantResult = await request('/open-apis/tenant/v2/tenant/query', 'GET', null, 'Bearer ' + token, budget());
    const tenantFailure = classify(tenantResult, 'tenant');
    if (tenantFailure) return tenantFailure;
    const tenant = tenantResult.payload.tenant;
    if (!object(tenant) || !identity(tenant.tenant_key)) return failure('identity_missing');
    return { ok: true, identity: {
      tenantId: tenant.tenant_key,
      botUserId: bot.open_id,
      // Display-only: never used for authentication or routing.
      appName: typeof bot.app_name === 'string' && bot.app_name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(bot.app_name) ? bot.app_name : '',
      activateStatus: Number.isInteger(bot.activate_status) && bot.activate_status >= 0 && bot.activate_status <= 99 ? bot.activate_status : null,
    } };
  }
  return Object.freeze({ probe });
})();
