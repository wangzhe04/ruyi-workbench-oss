// Original, single-message official API adapter. Durable sending/unknown recovery belongs to the caller.
const ExternalChannelDelivery = (() => {
  const transport = require('node:https');
  const id = value => typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const secret = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096;
  const failure = (status, errorCode, extra = {}) => ({ status, messageId: '', errorCode: 'external_delivery.' + errorCode, ...extra });
  function boundedText(text) {
    const suffix = '\n完整答复请在如意查看或继续追问';
    if (text.length <= 1800 && Buffer.byteLength(text) <= 6000) return { text, truncated: false };
    let result = '', bytes = Buffer.byteLength(suffix);
    // Iterate Unicode scalar values; never leave half an emoji or an invalid UTF8 sequence.
    for (const scalar of text) {
      const length = Buffer.byteLength(scalar);
      if (result.length + scalar.length + suffix.length > 1800 || bytes + length > 6000) break;
      result += scalar; bytes += length;
    }
    return { text: result + suffix, truncated: true };
  }
  function retryAfter(value) {
    if (typeof value !== 'string' || !/^[0-9]{1,6}$/.test(value)) return undefined;
    return Math.min(86400000, Number(value) * 1000);
  }
  // Exactly one request, no redirect/auth retry/proxy/baseUrl option. Bodies and errors never escape into logs.
  function post(hostname, path, body, authorization, options) {
    return new Promise(resolve => {
      let done = false, request, response;
      const finish = result => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => { finish({ failure: 'aborted' }); if (request) request.destroy(); if (response) response.destroy(); };
      const timer = setTimeout(() => { finish({ failure: 'timeout' }); if (request) request.destroy(); if (response) response.destroy(); }, options.timeoutMs);
      timer.unref();
      if (options.signal && options.signal.aborted) { abort(); return; }
      if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
      const bytes = Buffer.from(JSON.stringify(body));
      const headers = { 'content-type': 'application/json; charset=utf-8', 'content-length': String(bytes.length) };
      if (authorization) headers.authorization = authorization;
      try {
        // All JSON bytes are ready. No await may separate the host's final
        // identity/policy/cancellation check from creating the message request.
        if (options.assertDispatch) options.assertDispatch(bytes);
        request = transport.request({ protocol: 'https:', hostname, port: 443, path, method: 'POST', headers,
          agent: false, rejectUnauthorized: true, maxHeaderSize: 8192 }, incoming => {
          if (done) { incoming.destroy(); return; }
          response = incoming;
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 65536) { finish({ failure: 'invalid_response' }); response.destroy(); return; }
            chunks.push(chunk);
          });
          response.on('end', () => {
            let payload;
            try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch {}
            finish({ statusCode: response.statusCode, payload, retryAfterMs: retryAfter(response.headers['retry-after']) });
          });
          response.on('error', () => finish({ failure: 'network' }));
          response.on('aborted', () => finish({ failure: 'network' }));
        });
        request.on('error', () => finish({ failure: 'network' }));
        request.end(bytes);
      } catch (error) { finish({ failure: error?.code === 'external_delivery.reply_window_closed' ? 'window_closed' : request ? 'network' : 'predispatch' }); if (request) request.destroy(); }
    });
  }
  function classify(result, tokenPhase) {
    if (result.failure === 'window_closed') return failure('pending', 'reply_window_closed');
    const status = tokenPhase ? 'failed' : 'unknown';
    if (result.failure === 'predispatch') return failure('failed', 'predispatch');
    if (result.failure) return failure(status, (tokenPhase ? 'token_' : '') + result.failure);
    if (result.statusCode === 429) return failure('failed', 'rate_limited', { retryAfterMs: result.retryAfterMs });
    if (result.statusCode >= 400 && result.statusCode < 500) return failure('failed', tokenPhase ? 'token_rejected' : 'rejected');
    if (!(result.statusCode >= 200 && result.statusCode < 300)) return failure(status, tokenPhase ? 'token_unavailable' : 'unconfirmed');
    return null;
  }
  async function sendReply(connection, originalMessage, text, options = {}) {
    if (!object(connection) || !object(originalMessage) || !object(options)) return failure('failed', 'invalid_input');
    const platform = connection.platform;
    const messageSeq = options.messageSeq === undefined ? 1 : options.messageSeq;
    if (!Number.isSafeInteger(messageSeq) || messageSeq < 1 || messageSeq > (originalMessage.conversationType === 'group' ? 5 : 4)) return failure('failed', 'invalid_input');
    if (!['qq', 'feishu'].includes(platform) || !id(connection.appId) || typeof options.attemptId !== 'string'
      || !/^[A-Za-z0-9_-]{1,50}$/.test(options.attemptId)) return failure('failed', 'invalid_config');
    if (!id(originalMessage.messageId) || !id(originalMessage.conversationId) || !id(originalMessage.senderId)
      || !['direct', 'group'].includes(originalMessage.conversationType)) return failure('failed', 'invalid_message');
    const tenantId = connection.tenantId || (platform === 'qq' ? connection.appId : undefined);
    if (!id(tenantId) || tenantId !== originalMessage.tenantId) return failure('failed', 'identity_mismatch');
    if (platform === 'qq' && originalMessage.conversationType === 'direct' && originalMessage.conversationId !== originalMessage.senderId) return failure('failed', 'identity_mismatch');
    const assertWindow = () => {
      if (platform === 'qq' && originalMessage.feedback) {
        const at = Date.parse(originalMessage.feedback.sentAt);
        if (!Number.isFinite(at) || Date.now() >= at + 300000) throw Object.assign(new Error('passive window closed'), { code: 'external_delivery.reply_window_closed' });
      }
    };
    try { assertWindow(); } catch { return failure('pending', 'reply_window_closed'); }
    if (typeof text !== 'string' || !text.trim() || text.length > 1048576
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || Buffer.from(text).toString('utf8') !== text) return failure('failed', 'text_invalid');
    const credential = platform === 'qq' ? connection.botSecret : connection.appSecret;
    if (!secret(credential)) return failure('failed', 'invalid_config');
    const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 60000
      || (options.signal && (typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function'))) return failure('failed', 'invalid_input');
    if (options.signal && options.signal.aborted) return failure('failed', 'aborted');
    // Copy all routing/credential evidence before the token await; callers cannot retarget this request in flight.
    const appId = connection.appId, messageId = originalMessage.messageId, conversationId = originalMessage.conversationId;
    const group = originalMessage.conversationType === 'group';
    const uuid = options.attemptId;
    const deadline = Date.now() + timeoutMs;
    const requestOptions = { timeoutMs, signal: options.signal };
    const hostname = platform === 'qq' ? 'api.bot.qq.com' : 'open.feishu.cn';
    const tokenResult = await post(hostname,
      platform === 'qq' ? '/app/getAppAccessToken' : '/open-apis/auth/v3/tenant_access_token/internal',
      platform === 'qq' ? { appId, clientSecret: credential } : { app_id: appId, app_secret: credential }, null, requestOptions);
    const tokenFailure = classify(tokenResult, true);
    if (tokenFailure) return tokenFailure;
    const payload = tokenResult.payload;
    if (!object(payload) || (platform === 'feishu' && payload.code !== 0)) return failure('failed', 'token_rejected');
    const token = platform === 'qq' ? payload.access_token : payload.tenant_access_token;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) return failure('failed', 'token_invalid');
    // Host preparation runs after authentication and protects the COMPLETE logical
    // reply before any clipping. Auth slots remain fixed official-platform slots.
    let bounded, result, dispatched = false;
    const dispatch = prepared => {
      if (dispatched) throw new Error('duplicate dispatch');
      dispatched = true;
      if (!prepared || typeof prepared.text !== 'string' || (options.prepare && typeof prepared.assertCurrent !== 'function')) throw new Error('invalid preparation');
      bounded = boundedText(prepared.text); text = bounded.text;
      requestOptions.assertDispatch = bytes => {
        assertWindow();
        if (requestOptions.signal?.aborted) throw new Error('cancelled');
        prepared.assertCurrent?.({ text, bytes });
      };
      if (requestOptions.signal?.aborted) return Promise.resolve({ failure: 'predispatch' });
      try { assertWindow(); } catch { return Promise.resolve({ failure: 'window_closed' }); }
      requestOptions.timeoutMs = deadline - Date.now();
      if (requestOptions.timeoutMs <= 0) return Promise.resolve({ failure: 'predispatch' });
      return post(hostname, platform === 'qq'
        ? '/v2/' + (group ? 'groups/' : 'users/') + encodeURIComponent(conversationId) + '/messages'
        : '/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reply',
      platform === 'qq' ? { msg_type: 0, content: text, msg_id: messageId, msg_seq: messageSeq }
        : { msg_type: 'text', content: JSON.stringify({ text }), uuid },
      (platform === 'qq' ? 'QQBot ' : 'Bearer ') + token, requestOptions);
    };
    try { result = options.prepare ? await options.prepare(dispatch) : await dispatch({ text }); }
    catch { return failure('failed', 'predispatch'); }
    const sendFailure = classify(result, false);
    if (sendFailure) return sendFailure;
    if (!object(result.payload)) return failure('unknown', 'invalid_response');
    if (platform === 'feishu' && result.payload.code !== 0) {
      // A missing/ill-typed code is not an explicit platform rejection.
      return Number.isInteger(result.payload.code) ? failure('failed', 'rejected') : failure('unknown', 'invalid_response');
    }
    if (platform === 'qq' && result.payload.code !== undefined) {
      if (!Number.isInteger(result.payload.code)) return failure('unknown', 'invalid_response');
      if (result.payload.code !== 0) return failure('failed', 'rejected');
    }
    const sentId = platform === 'qq' ? result.payload.id : object(result.payload.data) && result.payload.data.message_id;
    if (!id(sentId)) return failure('unknown', 'invalid_response');
    return { status: 'sent', messageId: sentId, errorCode: '', truncated: bounded.truncated };
  }
  return Object.freeze({ sendReply });
})();
