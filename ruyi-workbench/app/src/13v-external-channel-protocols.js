// Original protocol implementation from the platform wire specifications, using Node crypto only.
// QQ: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
//     https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
// Feishu: https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
//         https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/encrypt-key-encryption-configuration-case
// No network, environment lookup, persistence, or admission decisions live in this module.
const ExternalChannelProtocols = (() => {
  const WINDOW_MS = 300000;
  const ID_MAX = 128;
  const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code: `external_channel.${code}`, statusCode }); };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const identity = value => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX && /^[\x21-\x7e]+$/.test(value);
  const secret = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 4096;
  const exactKeys = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
  function json(bytes) {
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!object(value)) fail('schema_invalid');
      return value;
    } catch { return fail('invalid_body'); }
  }
  function headerMap(input) {
    if (!object(input)) fail('schema_invalid');
    const result = Object.create(null);
    const pairs = typeof input.entries === 'function' ? [...input.entries()] : Object.entries(input);
    for (const [key, value] of pairs) {
      const name = key.toLowerCase();
      if (Object.hasOwn(result, name) || typeof value !== 'string') fail('schema_invalid');
      result[name] = value;
    }
    return result;
  }
  function seconds(value, nowMs) {
    if (typeof value !== 'string' || !/^[0-9]{1,12}$/.test(value)) fail('timestamp_invalid', 401);
    const ms = Number(value) * 1000;
    if (!Number.isSafeInteger(ms) || Math.abs(nowMs - ms) > WINDOW_MS) fail('timestamp_out_of_window', 401);
    return ms;
  }
  function sameSecret(actual, expected) {
    if (typeof actual !== 'string') return false;
    const a = crypto.createHash('sha256').update(actual, 'utf8').digest();
    const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  }
  function hex(value, bytes) {
    if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[a-fA-F0-9]+$/.test(value)) fail('signature_invalid', 401);
    return Buffer.from(value, 'hex');
  }
  function feishuSignature(headers, raw, key, nowMs, optional) {
    const fields = ['x-lark-request-timestamp', 'x-lark-request-nonce', 'x-lark-signature'];
    if (optional && fields.every(name => !Object.hasOwn(headers, name))) return;
    if (fields.some(name => !Object.hasOwn(headers, name))) fail('signature_missing', 401);
    seconds(headers[fields[0]], nowMs);
    const nonce = headers[fields[1]];
    if (!nonce.length || nonce.length > 512 || /[\r\n\0]/.test(nonce)) fail('signature_invalid', 401);
    const actual = hex(headers[fields[2]], 32);
    const digest = crypto.createHash('sha256').update(headers[fields[0]], 'utf8').update(nonce, 'utf8').update(key, 'utf8').update(raw).digest();
    if (!crypto.timingSafeEqual(actual, digest)) fail('signature_invalid', 401);
  }
  function decryptFeishu(encrypted, key) {
    if (typeof encrypted !== 'string' || encrypted.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encrypted)) fail('decrypt_failed', 401);
    const wire = Buffer.from(encrypted, 'base64');
    if (wire.length < 32 || (wire.length - 16) % 16 !== 0 || wire.toString('base64') !== encrypted) fail('decrypt_failed', 401);
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', crypto.createHash('sha256').update(key, 'utf8').digest(), wire.subarray(0, 16));
      return Buffer.concat([decipher.update(wire.subarray(16)), decipher.final()]);
    } catch { return fail('decrypt_failed', 401); }
  }
  function millisIso(value) {
    if (typeof value !== 'string' || !/^[0-9]{1,16}$/.test(value)) fail('schema_invalid');
    const ms = Number(value);
    if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) fail('schema_invalid');
    return new Date(ms).toISOString();
  }
  function iso(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('schema_invalid');
    return new Date(value).toISOString();
  }
  function textValue(value) {
    if (typeof value !== 'string' || value.length > 8192 || Buffer.byteLength(value, 'utf8') > 32768
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) fail('schema_invalid');
    return value.trim();
  }
  function feishuChallenge(payload, token) {
    if (payload.type !== 'url_verification' || !exactKeys(payload, ['type', 'token', 'challenge'])) fail('schema_invalid');
    if (!sameSecret(payload.token, token)) fail('token_invalid', 401);
    if (typeof payload.challenge !== 'string' || !payload.challenge.length || Buffer.byteLength(payload.challenge, 'utf8') > 512 || /[\0\r\n]/.test(payload.challenge)) fail('schema_invalid');
    return { kind: 'challenge', body: { challenge: payload.challenge } };
  }
  function unsignedFeishuBootstrap(encrypted, connection) {
    try {
      return feishuChallenge(json(decryptFeishu(encrypted, connection.encryptKey)), connection.verificationToken);
    } catch { return fail('bootstrap_invalid', 401); }
  }
  function feishu(connection, headers, raw, nowMs) {
    if (!identity(connection.appId) || !identity(connection.tenantId) || !identity(connection.botUserId)
        || !secret(connection.encryptKey) || !secret(connection.verificationToken)) fail('invalid_config', 503);
    const outer = json(raw);
    const encrypted = Object.hasOwn(outer, 'encrypt');
    let payload;
    // Encrypted bootstrap is a narrowly separate path: no event is ever admitted from it.
    // Present signature headers, including partial sets, must always validate before decryption.
    if (encrypted) {
      if (!exactKeys(outer, ['encrypt'])) fail('schema_invalid');
      feishuSignature(headers, raw, connection.encryptKey, nowMs, true);
      if (['x-lark-request-timestamp', 'x-lark-request-nonce', 'x-lark-signature'].every(name => !Object.hasOwn(headers, name))) {
        return unsignedFeishuBootstrap(outer.encrypt, connection);
      }
      payload = json(decryptFeishu(outer.encrypt, connection.encryptKey));
    } else payload = outer;
    if (payload.type === 'url_verification') {
      if (!encrypted) fail('schema_invalid');
      return feishuChallenge(payload, connection.verificationToken);
    }
    feishuSignature(headers, raw, connection.encryptKey, nowMs, false);
    if (payload.schema !== '2.0' || !object(payload.header)) fail('schema_invalid');
    const h = payload.header;
    if (!sameSecret(h.token, connection.verificationToken)) fail('token_invalid', 401);
    if (h.app_id !== connection.appId || h.tenant_key !== connection.tenantId) fail('identity_mismatch', 403);
    if (!identity(h.event_id) || typeof h.event_type !== 'string') fail('schema_invalid');
    if (h.event_type !== 'im.message.receive_v1') return { kind: 'ignored', reason: 'unsupported_event' };
    if (!object(payload.event) || !object(payload.event.sender) || !object(payload.event.message)) fail('schema_invalid');
    const sender = payload.event.sender, message = payload.event.message;
    // The signed header is authoritative; an absent optional sender tenant never supplies a new tenant.
    if (sender.tenant_key !== undefined && sender.tenant_key !== connection.tenantId) fail('identity_mismatch', 403);
    if (sender.sender_type !== 'user') return { kind: 'ignored', reason: 'non_human_sender' };
    if (!object(sender.sender_id) || !identity(sender.sender_id.open_id) || !identity(message.message_id) || !identity(message.chat_id)) fail('schema_invalid');
    if (sender.sender_id.open_id === connection.botUserId) return { kind: 'ignored', reason: 'non_human_sender' };
    if (!['p2p', 'group'].includes(message.chat_type)) fail('schema_invalid');
    if (message.message_type !== 'text') return { kind: 'ignored', reason: 'unsupported_message_type' };
    if (typeof message.content !== 'string') fail('schema_invalid');
    let content;
    try { content = JSON.parse(message.content); } catch { return fail('schema_invalid'); }
    if (!exactKeys(content, ['text']) || typeof content.text !== 'string') fail('schema_invalid');
    if (message.mentions !== undefined && !Array.isArray(message.mentions)) fail('schema_invalid');
    const mentions = message.mentions || [];
    if (mentions.some(mention => !object(mention) || !object(mention.id))) fail('schema_invalid');
    const ownMentions = mentions.filter(mention => mention.id.open_id === connection.botUserId);
    if (message.chat_type === 'group' && ownMentions.length === 0) return { kind: 'ignored', reason: 'not_mentioned' };
    let text = content.text;
    for (const mention of ownMentions) {
      if (typeof mention.key !== 'string' || !mention.key.length || mention.key.length > 128) fail('schema_invalid');
      text = text.split(mention.key).join('');
    }
    text = textValue(text);
    if (!text) return { kind: 'ignored', reason: 'empty_text' };
    return { kind: 'message', message: { messageId: message.message_id, eventId: h.event_id, tenantId: h.tenant_key,
      conversationId: message.chat_id, senderId: sender.sender_id.open_id, conversationType: message.chat_type === 'p2p' ? 'direct' : 'group',
      text, sentAt: millisIso(message.create_time) } };
  }
  function qqPrivateKey(value) {
    const bytes = Buffer.from(value, 'utf8');
    const seed = Buffer.alloc(32);
    for (let i = 0; i < seed.length; i++) seed[i] = bytes[i % bytes.length];
    return crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  }
  function qqSignature(headers, raw, privateKey, nowMs, optional) {
    const signature = headers['x-signature-ed25519'], timestamp = headers['x-signature-timestamp'];
    if (optional && signature === undefined && timestamp === undefined) return;
    if (signature === undefined || timestamp === undefined) fail('signature_missing', 401);
    seconds(timestamp, nowMs);
    if (!crypto.verify(null, Buffer.concat([Buffer.from(timestamp, 'utf8'), raw]), crypto.createPublicKey(privateKey), hex(signature, 64))) fail('signature_invalid', 401);
  }
  function qq(connection, headers, raw, nowMs) {
    if (!identity(connection.appId) || !secret(connection.botSecret) || (connection.tenantId !== undefined && connection.tenantId !== '' && !identity(connection.tenantId))) fail('invalid_config', 503);
    if (headers['x-bot-appid'] !== connection.appId) fail('identity_mismatch', 403);
    const payload = json(raw), key = qqPrivateKey(connection.botSecret);
    if (payload.op === 13) {
      qqSignature(headers, raw, key, nowMs, true);
      if (!exactKeys(payload, ['op', 'd']) || !exactKeys(payload.d, ['plain_token', 'event_ts'])) fail('schema_invalid');
      const token = payload.d.plain_token, timestamp = payload.d.event_ts;
      // A bootstrap signing oracle must not sign arbitrary JSON callback bodies. Official tokens are opaque alphanumeric strings.
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(token)) fail('schema_invalid');
      seconds(timestamp, nowMs);
      return { kind: 'challenge', body: { plain_token: token,
        signature: crypto.sign(null, Buffer.from(timestamp + token, 'utf8'), key).toString('hex') } };
    }
    qqSignature(headers, raw, key, nowMs, false);
    if (payload.op !== 0 || typeof payload.t !== 'string' || !object(payload.d)) fail('schema_invalid');
    if (!['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(payload.t)) return { kind: 'ignored', reason: 'unsupported_event' };
    if (!identity(payload.id)) fail('schema_invalid');
    const message = payload.d, group = payload.t === 'GROUP_AT_MESSAGE_CREATE';
    if (!object(message.author) || !identity(message.id)) fail('schema_invalid');
    const senderId = group ? message.author.member_openid : message.author.user_openid;
    if (!identity(senderId) || (group && !identity(message.group_openid))) fail('schema_invalid');
    if (message.author.bot === true || (connection.botUserId && senderId === connection.botUserId)) return { kind: 'ignored', reason: 'non_human_sender' };
    if (message.author.bot !== undefined && typeof message.author.bot !== 'boolean') fail('schema_invalid');
    if (message.message_type !== undefined && message.message_type !== 0) return { kind: 'ignored', reason: 'unsupported_message_type' };
    for (const field of ['attachments', 'embeds', 'ark', 'markdown', 'file_info', 'image', 'video', 'audio', 'media']) {
      if (message[field] !== undefined && message[field] !== null && !(Array.isArray(message[field]) && message[field].length === 0)) return { kind: 'ignored', reason: 'unsupported_message_type' };
    }
    if (typeof message.content !== 'string') fail('schema_invalid');
    let text = message.content;
    if (connection.botUserId) text = text.split(`<@${connection.botUserId}>`).join('').split(`<@!${connection.botUserId}>`).join('');
    text = textValue(text);
    if (!text) return { kind: 'ignored', reason: 'empty_text' };
    return { kind: 'message', message: { messageId: message.id, eventId: payload.id, tenantId: connection.tenantId || connection.appId,
      conversationId: group ? message.group_openid : senderId, senderId, conversationType: group ? 'group' : 'direct', text, sentAt: iso(message.timestamp) } };
  }
  function verifyAndNormalize(platform, connection, headers, rawBody, nowMs = Date.now()) {
    if (!object(connection)) fail('invalid_config', 503);
    if (!Buffer.isBuffer(rawBody) || !rawBody.length || rawBody.length > 65536) fail('invalid_body');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('timestamp_invalid', 401);
    const normalized = headerMap(headers);
    if (platform === 'feishu') return feishu(connection, normalized, rawBody, nowMs);
    if (platform === 'qq') return qq(connection, normalized, rawBody, nowMs);
    return fail('platform_unsupported');
  }
  return Object.freeze({ verifyAndNormalize });
})();
